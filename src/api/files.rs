//! Uploaded files (assets): upload with a free-space reservation, serving
//! with ranges and a per-type policy, listing and deleting; and the helpers
//! that decide whether full server paths are shown.

use std::net::SocketAddr;

use axum::Json;
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use tokio_stream::StreamExt;

use crate::{assets, db};

use super::{ApiError, ApiResult, bad, blocking, client_id, file_body, NameQuery, set_header, Shared, Wb};


/// Stores an uploaded file (raw bytes in the body), streaming it to disk so
/// large videos don't sit in memory. The original file name may be given in
/// `X-Filename`. Returns the path to put in the block text.
pub async fn upload_asset(State(s): Shared, Wb(wb): Wb, headers: HeaderMap, body: Body) -> ApiResult {
    let original = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("file")
        .to_string();
    let dir = wb.assets_dir();
    tokio::fs::create_dir_all(&dir).await?;
    // Hidden temp name: valid_name() rejects it, so it is never served.
    let tmp = dir.join(format!(".upload-{}.part", uuid::Uuid::new_v4()));
    let result = receive_upload(&tmp, body, upload_cap(&headers, s.max_upload)?, &dir).await;
    let head = match result {
        Ok(head) => head,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e);
        }
    };
    let ext = assets::ext_for(&head, &original);
    let stem = assets::safe_stem(&original);
    let placed = {
        let (dir, tmp) = (dir.clone(), tmp.clone());
        tokio::task::spawn_blocking(move || assets::place(&dir, &tmp, &stem, &ext, db::now_ms()))
            .await
            ?
    };
    let name = match placed {
        Ok(name) => name,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e.into());
        }
    };
    wb.forget_usage();
    s.notify(&wb, json!({ "type": "assets", "name": name, "client": client_id(&headers) }));
    Ok(Json(json!({ "name": name, "path": format!("../assets/{name}"), "kind": assets::kind_of(&name) }))
        .into_response())
}

/// The most bytes this request may write: its Content-Length when it sends
/// one (browsers do for files), else the server limit. Space is reserved for
/// this amount, so pasting a small image does not need the full limit free.
pub(crate) fn upload_cap(headers: &HeaderMap, max: u64) -> Result<u64, ApiError> {
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    match declared {
        Some(n) if n > max => Err(too_large(max)),
        Some(n) => Ok(n),
        None => Ok(max),
    }
}

fn too_large(max: u64) -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "too_large", format!("file is larger than {} MB", max / 1024 / 1024))
}

/// Bytes promised to uploads that have not finished writing yet. Counted at
/// each request's cap, so several at once cannot slip past the free-space check.
static UPLOAD_RESERVED: parking_lot::Mutex<u64> = parking_lot::Mutex::new(0);

pub(crate) struct UploadHold(u64);

impl Drop for UploadHold {
    fn drop(&mut self) {
        let mut reserved = UPLOAD_RESERVED.lock();
        *reserved = reserved.saturating_sub(self.0);
    }
}

/// Refuses the upload when the volume could not keep `DISK_RESERVE` free
/// after this request and every other in-flight upload wrote their maximum.
pub(crate) fn hold_upload_space(volume: &std::path::Path, max: u64, why: &'static str) -> Result<UploadHold, ApiError> {
    let free = crate::workbooks::free_bytes(volume).map_err(|e| {
        tracing::error!("could not measure free space: {e}");
        ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "storage", "could not check free space")
    })?;
    let mut reserved = UPLOAD_RESERVED.lock();
    if !crate::workbooks::space_fits(free, *reserved, max, crate::workbooks::DISK_RESERVE) {
        return Err(ApiError::new(StatusCode::INSUFFICIENT_STORAGE, "no_space", why));
    }
    *reserved = reserved.saturating_add(max);
    Ok(UploadHold(max))
}

/// Writes the request body to `tmp`; returns its first bytes (for type
/// detection). Fails if the body is empty or bigger than `max` bytes (see
/// `upload_cap`), or if the volume that holds `volume` could not keep a
/// reserve free.
pub(crate) async fn receive_upload(tmp: &std::path::Path, body: Body, max: u64, volume: &std::path::Path) -> Result<Vec<u8>, ApiError> {
    use tokio::io::AsyncWriteExt;
    let _hold = hold_upload_space(volume, max, "not enough free space for this upload")?;
    let mut file = tokio::fs::File::create(tmp).await?;
    let mut stream = body.into_data_stream();
    let mut head = Vec::with_capacity(16);
    let mut total: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("upload interrupted: {e:#}");
                return Err(bad("upload interrupted"));
            }
        };
        total += chunk.len() as u64;
        if total > max {
            return Err(too_large(max));
        }
        if head.len() < 16 {
            head.extend_from_slice(&chunk[..chunk.len().min(16 - head.len())]);
        }
        file.write_all(&chunk).await?;
    }
    if total == 0 {
        return Err(bad("empty upload"));
    }
    file.sync_all().await?;
    Ok(head)
}

/// Parses a single `Range: bytes=…` header against a file length.
/// None: no usable range (send everything). Some(Err): unsatisfiable.
pub(super) fn parse_range(header: &str, len: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = header.strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None; // multiple ranges: just send the whole file
    }
    let (a, b) = spec.split_once('-')?;
    let range = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            if n == 0 || len == 0 {
                return Some(Err(()));
            }
            (len.saturating_sub(n), len - 1)
        }
        (a, b) => {
            let start: u64 = a.parse().ok()?;
            let end: u64 = if b.is_empty() { len.saturating_sub(1) } else { b.parse().ok()? };
            if start >= len || end < start {
                return Some(Err(()));
            }
            (start, end.min(len - 1))
        }
    };
    Some(Ok(range))
}

/// Serves an uploaded file. Names never change, so browsers may cache
/// forever. Supports range requests, so videos can seek, and streams the
/// file instead of loading it into memory.
pub async fn get_asset(Wb(wb): Wb, Path(name): Path<String>, headers: HeaderMap) -> Response {
    use tokio::io::AsyncSeekExt;
    if !assets::valid_name(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = wb.assets_dir().join(&name);
    let Ok(meta) = tokio::fs::metadata(&path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !meta.is_file() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let len = meta.len();
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| parse_range(v, len));
    let (status, start, end) = match range {
        Some(Ok((a, b))) => (StatusCode::PARTIAL_CONTENT, a, b),
        Some(Err(())) => {
            return (StatusCode::RANGE_NOT_SATISFIABLE, [(header::CONTENT_RANGE, format!("bytes */{len}"))])
                .into_response();
        }
        None => (StatusCode::OK, 0, len.saturating_sub(1)),
    };
    let count = if len == 0 { 0 } else { end - start + 1 };
    let Ok(mut file) = tokio::fs::File::open(&path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let (ctype, inline, csp) = assets::serve_policy(&name);
    let disposition = format!("{}; filename=\"{name}\"", if inline { "inline" } else { "attachment" });
    let mut res = file_body(file, Some(count)).into_response();
    *res.status_mut() = status;
    let h = res.headers_mut();
    set_header(h, header::CONTENT_TYPE, &ctype);
    h.insert(header::CONTENT_LENGTH, count.into());
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000, immutable"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    set_header(h, header::CONTENT_DISPOSITION, &disposition);
    if let Some(csp) = csp {
        h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(csp));
    }
    if status == StatusCode::PARTIAL_CONTENT {
        set_header(h, header::CONTENT_RANGE, &format!("bytes {start}-{end}/{len}"));
    }
    res
}

/// True for a browser on this machine, with no reverse proxy in front.
pub(super) fn local_admin(peer: std::net::IpAddr, headers: &HeaderMap) -> bool {
    peer.is_loopback()
        && headers.get("x-forwarded-for").is_none()
        && headers.get("x-forwarded-host").is_none()
        && headers.get("forwarded").is_none()
}

/// Absolute paths are included for that direct connection, and for every
/// client when the operator set `BLOCKSEQ_EXPOSE_PATHS`. A reverse proxy
/// never looks like the direct connection, so the flag is what reaches a
/// browser that comes in through Caddy on another machine.
pub(super) fn reveal_paths(expose: bool, peer: std::net::IpAddr, headers: &HeaderMap) -> bool {
    expose || local_admin(peer, headers)
}

pub(crate) fn absolute_display(path: &std::path::Path) -> String {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()).display().to_string()
}

/// `path` stays relative to the data folder. `absolute` is added only when
/// the operator opted in with `BLOCKSEQ_EXPOSE_PATHS`.
pub(crate) fn workbook_json(info: &crate::workbooks::WorkbookInfo, dir: Option<&std::path::Path>, expose: bool) -> serde_json::Value {
    let mut body = json!({
        "id": info.id,
        "name": info.name,
        "kind": info.kind,
        "path": info.path,
    });
    if expose
        && let Some(dir) = dir
    {
        body["absolute"] = json!(absolute_display(dir));
    }
    body
}

/// Files in the workbook's assets folder, newest first, with the pages that
/// mention each one. `path` is relative to the workbook. `absolute` is set
/// for a direct localhost connection, and for every client when
/// `BLOCKSEQ_EXPOSE_PATHS` is set, so the copy button can paste a real path.
pub async fn list_assets(
    State(s): Shared,
    Wb(wb): Wb,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult {
    let show = reveal_paths(s.expose_paths, peer.ip(), &headers);
    let dir = if show { Some(std::path::absolute(wb.assets_dir()).unwrap_or_else(|_| wb.assets_dir())) } else { None };
    let (usage, list) = blocking(move || Ok((db::asset_usage(&wb.read())?, assets::list(&wb.assets_dir())))).await?;
    let out: Vec<_> = list
        .into_iter()
        .map(|a| {
            let needle = format!("assets/{}", a.name);
            let mut pages: Vec<&str> = usage
                .iter()
                .filter(|(_, content)| content.contains(&needle))
                .map(|(page, _)| page.as_str())
                .collect();
            pages.sort_unstable();
            pages.dedup();
            let mut item = json!({
                "name": a.name,
                "path": format!("assets/{}", a.name),
                "size": a.size,
                "modified": a.modified,
                "kind": a.kind,
                "pages": pages,
            });
            if let Some(dir) = &dir {
                item["absolute"] = json!(dir.join(&a.name).display().to_string());
            }
            item
        })
        .collect();
    Ok(Json(out).into_response())
}

pub async fn delete_asset(
    State(s): Shared,
    Wb(wb): Wb,
    Query(q): Query<NameQuery>,
    headers: HeaderMap,
) -> ApiResult {
    if !assets::valid_name(&q.name) {
        return Err(bad("invalid file name"));
    }
    match tokio::fs::remove_file(wb.assets_dir().join(&q.name)).await {
        Ok(()) => {
            wb.forget_usage();
            s.notify(&wb, json!({ "type": "assets", "name": q.name, "client": client_id(&headers) }));
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        Err(_) => Ok(StatusCode::NOT_FOUND.into_response()),
    }
}
