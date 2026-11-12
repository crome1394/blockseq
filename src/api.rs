//! JSON API used by the web UI.
//!
//! Every request works on one workbook, chosen with `?wb=<id>` (default
//! "main"). Change events go to all clients and carry the workbook id.

use std::convert::Infallible;
use std::sync::Arc;

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use tokio_stream::Stream;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

use crate::{assets, backup};
use crate::config::Config;
use crate::db::{self, Block, SaveOutcome};
use crate::workbooks::{MAIN, Workbook};
use crate::AppState;

type Shared = State<Arc<AppState>>;

pub struct ApiError(StatusCode, String);

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!("{e:#}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

type ApiResult = Result<Response, ApiError>;

/// Changes config.json: one change at a time (the settings lock is held
/// throughout), always starting from the file on disk, and refusing to touch
/// a damaged file. `f` may reject the change with any ApiError.
fn update_config<T>(s: &AppState, f: impl FnOnce(&mut Config) -> Result<T, ApiError>) -> Result<T, ApiError> {
    let mut cached = s.config.write();
    let path = s.config_path();
    let mut cfg = Config::load(&path)?;
    let out = f(&mut cfg)?;
    cfg.save(&path)?;
    *cached = cfg;
    Ok(out)
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

fn client_id(headers: &HeaderMap) -> String {
    headers.get("x-client-id").and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

/// Removes pages left empty and unlinked by a change, and tells open tabs.
fn prune(s: &AppState, wb: &Workbook, client: &str) {
    let removed = {
        let conn = wb.db.lock();
        match db::prune_orphans(&conn) {
            Ok(r) => {
                r.iter().for_each(|page| wb.remove_mirror(page));
                r
            }
            Err(e) => return tracing::warn!("pruning empty pages: {e:#}"),
        }
    };
    for page in removed {
        s.notify(wb, json!({ "type": "deleted", "name": page.name, "client": client }));
    }
}

/// The workbook a request is for, from `?wb=` (opened on first use).
pub struct Wb(pub Arc<Workbook>);

#[derive(Deserialize)]
struct WbParam {
    wb: Option<String>,
}

impl FromRequestParts<Arc<AppState>> for Wb {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, s: &Arc<AppState>) -> Result<Self, ApiError> {
        let id = Query::<WbParam>::from_request_parts(parts, s)
            .await
            .ok()
            .and_then(|q| q.0.wb)
            .filter(|w| !w.is_empty())
            .unwrap_or_else(|| MAIN.to_string());
        let state = s.clone();
        let words = s.task_words();
        let lookup = id.clone();
        let wb = tokio::task::spawn_blocking(move || state.workbooks.get(&lookup, &words))
            .await
            .map_err(|e| anyhow::anyhow!(e))??;
        wb.map(Wb).ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("no workbook called {id}")))
    }
}

#[derive(Deserialize)]
pub struct NameQuery {
    name: String,
}

pub async fn get_page(Wb(wb): Wb, Query(q): Query<NameQuery>) -> ApiResult {
    let conn = wb.db.lock();
    let page = db::get_page(&conn, &q.name)?;
    let blocks = match &page {
        Some(p) => db::get_blocks(&conn, &p.id)?,
        None => vec![],
    };
    let backlinks = db::backlinks(&conn, &q.name)?;
    let name = page.as_ref().map(|p| p.name.clone()).unwrap_or(q.name.trim().to_string());
    Ok(Json(json!({ "name": name, "page": page, "blocks": blocks, "backlinks": backlinks }))
        .into_response())
}

#[derive(Deserialize)]
pub struct SaveBody {
    base_version: i64,
    blocks: Vec<Block>,
}

pub async fn put_page(
    State(s): Shared,
    Wb(wb): Wb,
    Query(q): Query<NameQuery>,
    headers: HeaderMap,
    Json(body): Json<SaveBody>,
) -> ApiResult {
    let words = s.task_words();
    let outcome = {
        // The Markdown file is written under the same lock as the database,
        // so two quick saves can't leave the older text in the file.
        let conn = wb.db.lock();
        let outcome = db::save_page(&conn, &q.name, body.base_version, &body.blocks, &words)
            .map_err(|e| bad(format!("{e:#}")))?;
        if let SaveOutcome::Saved(page) = &outcome {
            wb.write_mirror(page, &body.blocks);
        }
        outcome
    };
    match outcome {
        SaveOutcome::Saved(page) => {
            s.notify(&wb, json!({
                "type": "page", "name": page.name, "version": page.version, "client": client_id(&headers)
            }));
            prune(&s, &wb, &client_id(&headers));
            Ok(Json(json!({ "page": page })).into_response())
        }
        SaveOutcome::Conflict(page, blocks) => Ok((
            StatusCode::CONFLICT,
            Json(json!({ "page": page, "blocks": blocks })),
        )
            .into_response()),
        SaveOutcome::ForeignIds(ids) => Ok((
            StatusCode::CONFLICT,
            Json(json!({ "error": "some blocks belong to another page", "foreign_ids": ids })),
        )
            .into_response()),
    }
}

pub async fn delete_page(
    State(s): Shared,
    Wb(wb): Wb,
    Query(q): Query<NameQuery>,
    headers: HeaderMap,
) -> ApiResult {
    let deleted = {
        let conn = wb.db.lock();
        let deleted = db::delete_page(&conn, &q.name)?;
        if let Some(page) = &deleted {
            wb.remove_mirror(page);
        }
        deleted
    };
    let Some(page) = deleted else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    s.notify(&wb, json!({ "type": "deleted", "name": page.name, "client": client_id(&headers) }));
    prune(&s, &wb, &client_id(&headers));
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Creates an empty page if it doesn't exist (used by the calendar to create
/// a journal day). Returns the page either way.
pub async fn ensure_page(Wb(wb): Wb, Query(q): Query<NameQuery>) -> ApiResult {
    let name = q.name.trim();
    if name.is_empty() {
        return Err(bad("page name is empty"));
    }
    let conn = wb.db.lock();
    db::ensure_page(&conn, name, db::now_ms())?;
    Ok(Json(json!({ "page": db::get_page(&conn, name)? })).into_response())
}

#[derive(Deserialize)]
pub struct RenameQuery {
    name: String,
    to: String,
}

/// Renames a page or tag, rewriting every link and tag to it (merging into
/// an existing page of the new name).
pub async fn rename_page(
    State(s): Shared,
    Wb(wb): Wb,
    Query(q): Query<RenameQuery>,
    headers: HeaderMap,
) -> ApiResult {
    let words = s.task_words();
    let client = client_id(&headers);
    let out = {
        let conn = wb.db.lock();
        let out = db::rename_page(&conn, &q.name, &q.to, &words).map_err(|e| bad(format!("{e:#}")))?;
        wb.remove_mirror(&out.old);
        let blocks = db::get_blocks(&conn, &out.page.id)?;
        wb.write_mirror(&out.page, &blocks);
        for (page, blocks) in &out.changed {
            wb.write_mirror(page, blocks);
        }
        out
    };
    s.notify(&wb, json!({ "type": "deleted", "name": out.old.name, "client": "" }));
    for (page, _) in &out.changed {
        s.notify(&wb, json!({ "type": "page", "name": page.name, "version": page.version, "client": "" }));
    }
    s.notify(&wb, json!({ "type": "page", "name": out.page.name, "version": out.page.version, "client": "" }));
    prune(&s, &wb, &client);
    let updated = out.changed.iter().filter(|(p, _)| p.id != out.page.id).count();
    Ok(Json(json!({ "page": out.page, "merged": out.merged, "updated_pages": updated })).into_response())
}

#[derive(Deserialize)]
pub struct FavoriteQuery {
    name: String,
    on: bool,
}

/// Marks or unmarks a page as a favourite. Favourites live on the server so
/// every computer shows the same list.
pub async fn set_favorite(
    State(s): Shared,
    Wb(wb): Wb,
    Query(q): Query<FavoriteQuery>,
    headers: HeaderMap,
) -> ApiResult {
    let name = q.name.trim();
    if name.is_empty() {
        return Err(bad("page name is empty"));
    }
    db::set_favorite(&wb.db.lock(), name, q.on)?;
    s.notify(&wb, json!({ "type": "favorite", "name": name, "client": client_id(&headers) }));
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn list_pages(Wb(wb): Wb) -> ApiResult {
    let pages = db::list_pages(&wb.db.lock())?;
    Ok(Json(pages).into_response())
}

pub async fn names(Wb(wb): Wb) -> ApiResult {
    let names = db::all_names(&wb.db.lock())?;
    Ok(Json(names).into_response())
}

#[derive(Deserialize)]
pub struct JournalQuery {
    before: Option<i64>,
    limit: Option<i64>,
}

pub async fn journals(Wb(wb): Wb, Query(q): Query<JournalQuery>) -> ApiResult {
    let limit = q.limit.unwrap_or(10).clamp(1, 100);
    let pages = db::journals(&wb.db.lock(), q.before, limit)?;
    Ok(Json(pages).into_response())
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    limit: Option<i64>,
}

pub async fn search(Wb(wb): Wb, Query(q): Query<SearchQuery>) -> ApiResult {
    let limit = q.limit.unwrap_or(30).clamp(1, 200);
    let results = db::search(&wb.db.lock(), &q.q, limit)?;
    Ok(Json(results).into_response())
}

#[derive(Deserialize)]
pub struct IdQuery {
    id: String,
}

pub async fn get_block(Wb(wb): Wb, Query(q): Query<IdQuery>) -> ApiResult {
    match db::get_block(&wb.db.lock(), &q.id)? {
        Some(b) => Ok(Json(b).into_response()),
        None => Ok(StatusCode::NOT_FOUND.into_response()),
    }
}

#[derive(Deserialize)]
pub struct BlockBody {
    content: String,
    /// The text the client last saw; the change is refused (409) if the
    /// block has changed since.
    expected: Option<String>,
}

/// Changes one block's text, e.g. a status change from the task list.
pub async fn put_block(
    State(s): Shared,
    Wb(wb): Wb,
    Query(q): Query<IdQuery>,
    headers: HeaderMap,
    Json(body): Json<BlockBody>,
) -> ApiResult {
    let words = s.task_words();
    let page = {
        let conn = wb.db.lock();
        match db::update_block(&conn, &q.id, &body.content, body.expected.as_deref(), &words)? {
            db::UpdateOutcome::Missing => return Ok(StatusCode::NOT_FOUND.into_response()),
            db::UpdateOutcome::Changed(current) => {
                return Ok((StatusCode::CONFLICT, Json(json!({ "error": "the block changed elsewhere", "current": current }))).into_response());
            }
            db::UpdateOutcome::Saved(page, blocks) => {
                wb.write_mirror(&page, &blocks);
                page
            }
        }
    };
    s.notify(&wb, json!({
        "type": "page", "name": page.name, "version": page.version, "client": client_id(&headers)
    }));
    prune(&s, &wb, &client_id(&headers));
    Ok(Json(json!({ "page": page })).into_response())
}

/// Every block with a task status (the client filters open / finished).
/// Pages whose #Encrypted blocks still need encrypting (done by the browser).
pub async fn encryption_pending(Wb(wb): Wb) -> ApiResult {
    Ok(Json(db::encryption_pending(&wb.db.lock())?).into_response())
}

pub async fn tasks(Wb(wb): Wb) -> ApiResult {
    Ok(Json(db::tasks(&wb.db.lock())?).into_response())
}

/// Server-sent events: tells other open tabs/devices when something changes.
pub async fn events(State(s): Shared) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    // A client that fell behind is told to reload everything it shows.
    let stream = BroadcastStream::new(s.events.subscribe()).map(|msg| {
        let data = msg.unwrap_or_else(|_| r#"{"type":"resync"}"#.to_string());
        Ok(Event::default().data(data))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ---- assets -------------------------------------------------------------------

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
    tokio::fs::create_dir_all(&dir).await.map_err(|e| anyhow::anyhow!(e))?;
    // Hidden temp name: valid_name() rejects it, so it is never served.
    let tmp = dir.join(format!(".upload-{}.part", uuid::Uuid::new_v4()));
    let result = receive_upload(&tmp, body, s.max_upload).await;
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
            .map_err(|e| anyhow::anyhow!(e))?
    };
    let name = match placed {
        Ok(name) => name,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e.into());
        }
    };
    s.notify(&wb, json!({ "type": "assets", "name": name, "client": client_id(&headers) }));
    Ok(Json(json!({ "name": name, "path": format!("../assets/{name}"), "kind": assets::kind_of(&name) }))
        .into_response())
}

/// Writes the request body to `tmp`; returns its first bytes (for type
/// detection). Fails if the body is empty or bigger than `max` bytes.
async fn receive_upload(tmp: &std::path::Path, body: Body, max: u64) -> Result<Vec<u8>, ApiError> {
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(tmp).await.map_err(|e| anyhow::anyhow!(e))?;
    let mut stream = body.into_data_stream();
    let mut head = Vec::with_capacity(16);
    let mut total: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| bad(format!("upload interrupted: {e}")))?;
        total += chunk.len() as u64;
        if total > max {
            return Err(ApiError(
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("file is larger than {} MB", max / 1024 / 1024),
            ));
        }
        if head.len() < 16 {
            head.extend_from_slice(&chunk[..chunk.len().min(16 - head.len())]);
        }
        file.write_all(&chunk).await.map_err(|e| anyhow::anyhow!(e))?;
    }
    if total == 0 {
        return Err(bad("empty upload"));
    }
    file.sync_all().await.map_err(|e| anyhow::anyhow!(e))?;
    Ok(head)
}

/// Parses a single `Range: bytes=…` header against a file length.
/// None: no usable range (send everything). Some(Err): unsatisfiable.
fn parse_range(header: &str, len: u64) -> Option<Result<(u64, u64), ()>> {
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
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
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

    let (tx, rx) = tokio::sync::mpsc::channel::<std::io::Result<Bytes>>(4);
    tokio::spawn(async move {
        let mut file = match tokio::fs::File::open(&path).await {
            Ok(f) => f,
            Err(e) => return drop(tx.send(Err(e)).await),
        };
        if let Err(e) = file.seek(std::io::SeekFrom::Start(start)).await {
            return drop(tx.send(Err(e)).await);
        }
        let mut left = count;
        let mut buf = vec![0u8; 64 * 1024];
        while left > 0 {
            let want = buf.len().min(left as usize);
            match file.read(&mut buf[..want]).await {
                Ok(0) => break,
                Ok(n) => {
                    left -= n as u64;
                    if tx.send(Ok(Bytes::copy_from_slice(&buf[..n]))).await.is_err() {
                        break; // the browser stopped reading
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e)).await;
                    break;
                }
            }
        }
    });

    let (ctype, inline, csp) = assets::serve_policy(&name);
    let disposition = format!("{}; filename=\"{name}\"", if inline { "inline" } else { "attachment" });
    let mut res = Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)).into_response();
    *res.status_mut() = status;
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, ctype.parse().unwrap());
    h.insert(header::CONTENT_LENGTH, count.into());
    h.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    h.insert(header::CACHE_CONTROL, "private, max-age=31536000, immutable".parse().unwrap());
    h.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    h.insert(header::CONTENT_DISPOSITION, disposition.parse().unwrap());
    if let Some(csp) = csp {
        h.insert(header::CONTENT_SECURITY_POLICY, csp.parse().unwrap());
    }
    if status == StatusCode::PARTIAL_CONTENT {
        h.insert(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}").parse().unwrap());
    }
    res
}

/// Files in the workbook's assets folder, newest first, with the pages that
/// mention each one.
pub async fn list_assets(Wb(wb): Wb) -> ApiResult {
    let usage = db::asset_usage(&wb.db.lock())?;
    let dir = wb.assets_dir();
    let list = tokio::task::spawn_blocking(move || assets::list(&dir))
        .await
        .map_err(|e| anyhow::anyhow!(e))??;
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
            json!({ "name": a.name, "size": a.size, "modified": a.modified, "kind": a.kind, "pages": pages })
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
            s.notify(&wb, json!({ "type": "assets", "name": q.name, "client": client_id(&headers) }));
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        Err(_) => Ok(StatusCode::NOT_FOUND.into_response()),
    }
}

// ---- workbooks and shared settings --------------------------------------------

pub async fn list_workbooks(State(s): Shared) -> ApiResult {
    let mut list = s.workbooks.list();
    if let Some(name) = s.read_config()?.main_name {
        list[0].name = name;
    }
    Ok(Json(list).into_response())
}

#[derive(Deserialize)]
pub struct RenameWorkbook {
    id: String,
    to: String,
}

/// Renames a workbook: its folder, or for Main its display name.
pub async fn rename_workbook(State(s): Shared, Query(q): Query<RenameWorkbook>) -> ApiResult {
    let to = q.to.trim().to_string();
    let info = if q.id == MAIN {
        if to.is_empty() || to.chars().count() > 64 || to.chars().any(char::is_control) {
            return Err(bad("use 1 to 64 characters"));
        }
        update_config(&s, |cfg| {
            cfg.main_name = (to != "Main").then(|| to.clone());
            Ok(())
        })?;
        crate::workbooks::WorkbookInfo { id: MAIN.into(), name: to.clone(), kind: "blockseq" }
    } else {
        let state = s.clone();
        let (from, dest) = (q.id.clone(), to.clone());
        tokio::task::spawn_blocking(move || state.workbooks.rename(&from, &dest))
            .await
            .map_err(|e| anyhow::anyhow!(e))?
            .map_err(|e| bad(format!("{e:#}")))?
    };
    tracing::info!("renamed workbook {} to {}", q.id, info.name);
    s.notify_all(json!({ "type": "workbooks", "renamed": { "from": q.id, "to": info.id } }));
    Ok(Json(info).into_response())
}

pub async fn create_workbook(State(s): Shared, Query(q): Query<NameQuery>) -> ApiResult {
    let info = s.workbooks.create(&q.name).map_err(|e| bad(format!("{e:#}")))?;
    s.notify_all(json!({ "type": "workbooks" }));
    Ok(Json(info).into_response())
}

pub async fn get_config(State(s): Shared) -> ApiResult {
    let statuses = s.config.read().statuses.clone();
    Ok(Json(json!({ "statuses": statuses })).into_response())
}

#[derive(Deserialize)]
pub struct StatusesBody {
    statuses: Vec<crate::config::Status>,
}

/// The wrapped key for #Encrypted blocks (useless without the password).
pub async fn get_encryption(State(s): Shared) -> ApiResult {
    // Read from disk: the terminal reset command may have changed it.
    let cfg = s.read_config()?;
    Ok(Json(json!({ "encryption": cfg.encryption })).into_response())
}

#[derive(Deserialize)]
pub struct EncryptionBody {
    encryption: crate::config::Encryption,
    /// Proof of holding the current key (see crypto.rs `key_proof`).
    proof: Option<String>,
    /// Older clients/setups: the key check, accepted only while the stored
    /// setup has no proof_hash yet (to add one).
    check: Option<String>,
}

/// Sets up or changes the encryption password. Once a password exists, only
/// someone who can unlock the current key may replace its wrapped copies,
/// and the key itself can't change (that would make every block unreadable).
pub async fn put_encryption(State(s): Shared, Json(body): Json<EncryptionBody>) -> ApiResult {
    use crate::crypto::{proof_hash, same_secret};
    let e = &body.encryption;
    if e.version != 1 || e.iterations < 100_000 || e.rk_iterations < 10_000 {
        return Err(bad("unsupported encryption settings"));
    }
    update_config(&s, |cfg| {
        if let Some(existing) = &cfg.encryption {
            let forbidden = || ApiError(StatusCode::FORBIDDEN, "unlock with the current password first".into());
            if body.encryption.check != existing.check {
                return Err(forbidden());
            }
            match &existing.proof_hash {
                Some(stored) => {
                    let given = body.proof.as_deref().map(proof_hash).unwrap_or_default();
                    if !same_secret(&given, stored) || body.encryption.proof_hash.as_ref() != Some(stored) {
                        return Err(forbidden());
                    }
                }
                // Setups from before proof_hash: the (public) check is all
                // there is, once, to add the proof_hash.
                None => {
                    if !same_secret(body.check.as_deref().unwrap_or_default(), &existing.check) {
                        return Err(forbidden());
                    }
                }
            }
        } else if body.encryption.proof_hash.is_none() {
            return Err(bad("a new password needs a key proof (reload Blockseq and try again)"));
        }
        cfg.encryption = Some(body.encryption.clone());
        Ok(())
    })?;
    s.notify_all(json!({ "type": "encryption" }));
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Saves the shared settings (task statuses) and recomputes which blocks are
/// tasks in every open workbook.
pub async fn put_config(State(s): Shared, Json(body): Json<StatusesBody>) -> ApiResult {
    // Change only the statuses; keep everything else in the file as it is.
    let words = update_config(&s, |cfg| {
        cfg.statuses = body.statuses;
        cfg.validate().map_err(|e| bad(format!("{e:#}")))?;
        Ok(cfg.task_words())
    })?;
    let state = s.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        for wb in state.workbooks.open_workbooks() {
            db::refresh_task_refs(&wb.db.lock(), &words)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| anyhow::anyhow!(e))??;
    s.notify_all(json!({ "type": "config" }));
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---- backup ---------------------------------------------------------------------

/// Streams a file that is already open (and maybe already unlinked).
fn file_body(mut file: tokio::fs::File) -> Body {
    use tokio::io::AsyncReadExt;
    let (tx, rx) = tokio::sync::mpsc::channel::<std::io::Result<Bytes>>(4);
    tokio::spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match file.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(Ok(Bytes::copy_from_slice(&buf[..n]))).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e)).await;
                    break;
                }
            }
        }
    });
    Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx))
}

/// Downloads the whole workbook as a backup zip (see backup.rs).
pub async fn export(State(s): Shared, Wb(wb): Wb) -> ApiResult {
    let id = uuid::Uuid::new_v4();
    // Hidden names in the data folder: never listed, served or backed up.
    let tmp_db = s.root.join(format!(".export-{id}.db"));
    let tmp_zip = s.root.join(format!(".export-{id}.zip"));
    let config = s.root.join("config.json");
    let (wb2, zip_path) = (wb.clone(), tmp_zip.clone());
    let made = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        // Hold the database only for the snapshot, not while zipping assets.
        let snap = backup::snapshot(&wb2.db.lock(), &tmp_db);
        let result = snap.and_then(|_| backup::write_zip(&wb2.id, &wb2.dir, &tmp_db, &config, &zip_path));
        let _ = std::fs::remove_file(&tmp_db);
        result
    })
    .await
    .map_err(|e| anyhow::anyhow!(e))?;
    if let Err(e) = made {
        let _ = std::fs::remove_file(&tmp_zip);
        return Err(e.into());
    }
    let file = tokio::fs::File::open(&tmp_zip).await.map_err(|e| anyhow::anyhow!(e))?;
    let len = file.metadata().await.map_err(|e| anyhow::anyhow!(e))?.len();
    // The open handle keeps the data readable; the name goes away now.
    let _ = tokio::fs::remove_file(&tmp_zip).await;
    let main_name = s.read_config()?.main_name.unwrap_or_else(|| "Main".into());
    let label = if wb.id == MAIN { main_name.as_str() } else { wb.id.as_str() };
    let mut res = file_body(file).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, "application/zip".parse().unwrap());
    h.insert(header::CONTENT_LENGTH, len.into());
    h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    h.insert(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{}\"", backup::file_name(label)).parse().unwrap(),
    );
    Ok(res)
}

/// Restores an uploaded backup zip (raw body) as the new workbook `name`.
pub async fn import(State(s): Shared, Query(q): Query<NameQuery>, body: Body) -> ApiResult {
    let name = q.name.trim().to_string();
    if !crate::workbooks::valid_id(&name) {
        return Err(bad("use letters, digits, spaces, dashes, dots or underscores (not \"main\")"));
    }
    let folder = s.root.join("workbooks");
    if folder.join(&name).exists() {
        return Err(bad(format!("a workbook called {name} already exists")));
    }
    tokio::fs::create_dir_all(&folder).await.map_err(|e| anyhow::anyhow!(e))?;
    let tmp = folder.join(format!(".upload-{}.zip", uuid::Uuid::new_v4()));
    if let Err(e) = receive_upload(&tmp, body, s.max_upload).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    let server_key = s.read_config()?.encryption;
    // Backups compress well, so allow them to unpack to more than the upload limit.
    let max_bytes = s.max_upload.saturating_mul(4);
    let (state, zip, wb_name) = (s.clone(), tmp.clone(), name.clone());
    let result = tokio::task::spawn_blocking(move || state.workbooks.restore(&wb_name, &zip, server_key.as_ref(), max_bytes))
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    let _ = tokio::fs::remove_file(&tmp).await;
    let (info, mut report, adopt) = result.map_err(|e| bad(format!("{e:#}")))?;
    if let Some(key) = adopt {
        let key_file = folder.join(&name).join(backup::IMPORTED_KEY);
        let outcome = update_config(&s, |cfg| {
            Ok(match &cfg.encryption {
                // A password was set while the upload ran: treat the key as different.
                Some(now) if now.check != key.check => {
                    let text = serde_json::to_string_pretty(&key).map_err(|e| anyhow::anyhow!(e))?;
                    crate::config::write_durable(&key_file, text.as_bytes())?;
                    backup::KeyOutcome::Different
                }
                Some(_) => backup::KeyOutcome::Same,
                None => {
                    cfg.encryption = Some(key.clone());
                    backup::KeyOutcome::Adopted
                }
            })
        })?;
        if outcome == backup::KeyOutcome::Adopted {
            s.notify_all(json!({ "type": "encryption" }));
        }
        report.key = outcome;
    }
    tracing::info!("restored workbook {name} from a backup ({} files)", report.files);
    s.notify_all(json!({ "type": "workbooks" }));
    Ok(Json(json!({ "workbook": info, "report": report })).into_response())
}

/// Pages holding encrypted blocks (the browser re-encrypts them after an import).
pub async fn sealed_pages(Wb(wb): Wb) -> ApiResult {
    Ok(Json(db::sealed_pages(&wb.db.lock())?).into_response())
}

/// The key a restored workbook's encrypted blocks use, when it differs from
/// this server's (still wrapped: only a password or recovery key opens it).
pub async fn get_imported_key(Wb(wb): Wb) -> ApiResult {
    let key: Option<crate::config::Encryption> = std::fs::read_to_string(wb.dir.join(backup::IMPORTED_KEY))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    Ok(Json(json!({ "encryption": key })).into_response())
}

/// Called once every block was re-encrypted. Kept under a hidden name rather
/// than deleted, in case something was missed.
pub async fn done_imported_key(Wb(wb): Wb) -> ApiResult {
    let path = wb.dir.join(backup::IMPORTED_KEY);
    if path.exists() {
        std::fs::rename(&path, wb.dir.join(format!(".{}.old", backup::IMPORTED_KEY))).map_err(|e| anyhow::anyhow!(e))?;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}
