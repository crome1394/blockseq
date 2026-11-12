//! Backup zips: download, restore as a new workbook or into Main, the zips
//! saved before a Restore into Main, and the key a restored workbook brings.

use std::sync::Arc;

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use serde::Deserialize;
use serde_json::json;

use crate::{AppState, assets, backup, db};
use crate::workbooks::MAIN;

use super::{ApiError, ApiResult, bad, blocking, hold_upload_space, read_config, read_json, receive_upload, set_header, Shared, update_config, upload_cap, Wb, workbook_json};


/// Streams an open file (maybe already unlinked) from its current position,
/// at most `limit` bytes. Stops when the browser stops reading.
pub(crate) fn file_body(mut file: tokio::fs::File, limit: Option<u64>) -> Body {
    use tokio::io::AsyncReadExt;
    let (tx, rx) = tokio::sync::mpsc::channel::<std::io::Result<Bytes>>(4);
    tokio::spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        let mut left = limit.unwrap_or(u64::MAX);
        while left > 0 {
            let want = usize::try_from(left).unwrap_or(usize::MAX).min(buf.len());
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
    Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx))
}

/// Where an export zip is written: the temp filesystem, not the data folder.
pub(super) fn export_zip_path(id: uuid::Uuid) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("blockseq-export-{id}.zip"))
}

/// Refuses to build a backup that would leave less than `DISK_RESERVE` free
/// on `volume`. `need` is an upper bound on the bytes about to be written.
fn enough_export_space(volume: &std::path::Path, need: u64) -> anyhow::Result<()> {
    let free = match crate::workbooks::free_bytes(volume) {
        Ok(n) => n,
        Err(e) => {
            tracing::error!("could not measure free space: {e}");
            anyhow::bail!("could not check free space");
        }
    };
    if crate::workbooks::space_fits(free, 0, need, crate::workbooks::DISK_RESERVE) {
        Ok(())
    } else {
        anyhow::bail!("not enough free space to build the backup")
    }
}

/// Writes a backup zip of an open workbook to `out`. The database and the
/// files are copied into a temp folder first (the database and Markdown
/// under the writer lock, see `stage_snapshot`); the zip is built from that
/// copy after the lock is released. Refused when either volume would fall
/// below the free-space reserve.
fn zip_workbook(wb: &crate::workbooks::Workbook, config: &std::path::Path, out: &std::path::Path) -> anyhow::Result<()> {
    let temp = std::env::temp_dir();
    let stage = temp.join(format!("blockseq-snap-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        // Room for the staged copy and, after that, for the zip.
        let live = backup::snapshot_bytes(&wb.dir);
        enough_export_space(&temp, live.saturating_mul(2).saturating_add(1024 * 1024))?;
        if let Some(parent) = out.parent() {
            enough_export_space(parent, live.saturating_add(1024 * 1024))?;
        }
        let db_copy = backup::stage_snapshot(&wb.dir, &stage, Some(&wb.db))?;
        let staged = crate::workbooks::tree_bytes(&stage);
        enough_export_space(&temp, staged.saturating_add(1024 * 1024))?;
        backup::write_zip(&wb.id, &stage, &db_copy, config, out)
    })();
    let _ = std::fs::remove_dir_all(&stage);
    result
}

/// Downloads the whole workbook as a backup zip (see backup.rs).
pub async fn export(State(s): Shared, Wb(wb): Wb) -> ApiResult {
    let id = uuid::Uuid::new_v4();
    // On the temp filesystem, not in the data folder. Unlinked once streamed.
    let tmp_zip = export_zip_path(id);
    let config = s.root.join("config.json");
    let (wb2, zip_path) = (wb.clone(), tmp_zip.clone());
    let made = tokio::task::spawn_blocking(move || zip_workbook(&wb2, &config, &zip_path)).await?;
    if let Err(e) = made {
        let _ = std::fs::remove_file(&tmp_zip);
        return Err(e.into());
    }
    let file = tokio::fs::File::open(&tmp_zip).await?;
    let len = file.metadata().await?.len();
    // The open handle keeps the data readable; the name goes away now.
    let _ = tokio::fs::remove_file(&tmp_zip).await;
    let main_name = read_config(&s).await?.main_name.unwrap_or_else(|| "Main".into());
    let label = if wb.id == MAIN { main_name.as_str() } else { wb.id.as_str() };
    let mut res = file_body(file, None).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/zip"));
    h.insert(header::CONTENT_LENGTH, len.into());
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    set_header(h, header::CONTENT_DISPOSITION, &format!("attachment; filename=\"{}\"", backup::file_name(label)));
    Ok(res)
}

#[derive(Deserialize)]
pub struct ImportQuery {
    /// The new workbook's name (a restore as a new workbook).
    #[serde(default)]
    name: String,
    /// `main`: restore into Main instead (see `restore_into_main`).
    #[serde(default)]
    into: String,
    /// With `into=main`: keep the current Main as a workbook of this name
    /// instead of moving it to the trash.
    #[serde(default)]
    keep: String,
}

/// Before-restore zips kept in backups/ (the oldest go first).
const BEFORE_RESTORE_KEPT: usize = 10;
const BEFORE_RESTORE_PREFIX: &str = "before-restore-";

/// A before-restore zip's file name, as this server writes them.
fn is_before_restore(name: &str) -> bool {
    name.starts_with(BEFORE_RESTORE_PREFIX)
        && std::path::Path::new(name).extension().is_some_and(|e| e == "zip")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
}

/// Restores an uploaded backup zip (raw body): as the new workbook `name`,
/// or, with `into=main`, as Main.
pub async fn import(State(s): Shared, Query(q): Query<ImportQuery>, headers: HeaderMap, body: Body) -> ApiResult {
    let into_main = q.into == crate::workbooks::MAIN;
    let name = q.name.trim().to_string();
    let keep = q.keep.trim().to_string();
    let folder = s.root.join("workbooks");
    if into_main {
        if !keep.is_empty() && !crate::workbooks::valid_id(&keep) {
            return Err(bad("use letters, digits, spaces, dashes, dots or underscores (not \"main\")"));
        }
        if !keep.is_empty() && folder.join(&keep).exists() {
            return Err(bad(format!("a workbook called {keep} already exists")));
        }
    } else {
        if !crate::workbooks::valid_id(&name) {
            return Err(bad("use letters, digits, spaces, dashes, dots or underscores (not \"main\")"));
        }
        if folder.join(&name).exists() {
            return Err(bad(format!("a workbook called {name} already exists")));
        }
    }
    tokio::fs::create_dir_all(&folder).await?;
    let tmp = folder.join(format!(".upload-{}.zip", uuid::Uuid::new_v4()));
    let result = restore_upload(&s, &tmp, &headers, body, into_main, &name, &keep).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    result
}

async fn restore_upload(
    s: &Arc<AppState>,
    tmp: &std::path::Path,
    headers: &HeaderMap,
    body: Body,
    into_main: bool,
    name: &str,
    keep: &str,
) -> ApiResult {
    let folder = s.root.join("workbooks");
    let cap = upload_cap(headers, s.max_upload)?;
    receive_upload(tmp, body, cap, &folder).await?;
    let server_key = read_config(s).await?.encryption;
    // Backups compress well, so allow them to unpack to more than the upload
    // limit. Space is reserved for what the zip says it unpacks to, and the
    // unpack is cut off there, so a zip that understates it fails instead of
    // filling the disk.
    let declared = {
        let zip = tmp.to_path_buf();
        tokio::task::spawn_blocking(move || backup::unpacked_size(&zip)).await?
    };
    let declared = declared.map_err(|e| bad(format!("{e:#}")))?;
    let max_bytes = declared.min(s.max_upload.saturating_mul(4));
    let _unpack = hold_upload_space(&folder, max_bytes, "not enough free space to restore this backup")?;

    if !into_main {
        let (state, zip, wb_name) = (s.clone(), tmp.to_path_buf(), name.to_string());
        let (info, mut report, adopt) =
            tokio::task::spawn_blocking(move || state.workbooks.restore(&wb_name, &zip, server_key.as_ref(), max_bytes)).await??;
        if let Some(key) = adopt {
            report.key = settle_key(s, key, folder.join(name).join(backup::IMPORTED_KEY)).await?;
        }
        tracing::info!("restored workbook {name} from a backup ({} files)", report.files);
        s.notify_all(&json!({ "type": "workbooks" }));
        let dir = s.workbooks.dir_of(&info.id);
        return Ok(Json(json!({ "workbook": workbook_json(&info, dir.as_deref(), s.expose_paths), "report": report })).into_response());
    }

    // Into Main: zip the current Main first when it holds anything, so it
    // can always be brought back, then swap the files.
    let (state, zip, keep_as) = (s.clone(), tmp.to_path_buf(), keep.to_string());
    let (restored, saved_zip) = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let task_words = state.task_words();
        let main = state.workbooks.get(crate::workbooks::MAIN, &task_words)?.ok_or_else(|| anyhow::anyhow!("Main is missing"))?;
        let saved_zip = if main_has_content(&main)? {
            let dir = state.root.join("backups");
            std::os::unix::fs::DirBuilderExt::mode(std::fs::DirBuilder::new().recursive(true), 0o700).create(&dir)?;
            let out = dir.join(format!("{BEFORE_RESTORE_PREFIX}{}.zip", chrono::Local::now().format("%Y-%m-%d-%H%M%S")));
            if let Err(e) = zip_workbook(&main, &state.root.join("config.json"), &out) {
                let _ = std::fs::remove_file(&out);
                return Err(e.context("could not save a backup of the current Main first, so nothing was changed"));
            }
            prune_before_restore(&dir);
            Some(out)
        } else {
            None
        };
        drop(main);
        let keep = (!keep_as.is_empty()).then_some(keep_as.as_str());
        let restored = state.workbooks.restore_into_main(&zip, server_key.as_ref(), max_bytes, keep)?;
        // Open it now, so a problem shows here rather than on the next click.
        state.workbooks.get(crate::workbooks::MAIN, &task_words)?;
        Ok((restored, saved_zip))
    })
    .await??;
    let mut report = restored.report;
    if let Some(key) = restored.adopt {
        report.key = settle_key(s, key, s.root.join(backup::IMPORTED_KEY)).await?;
    }
    let rel = |p: &std::path::Path| crate::workbooks::relative_path(&s.root, p);
    tracing::info!(
        "restored Main from a backup ({} files); the previous Main is in {}{}",
        report.files,
        restored.set_aside.display(),
        saved_zip.as_ref().map(|z| format!(" and {}", z.display())).unwrap_or_default()
    );
    s.notify_all(&json!({ "type": "workbooks" }));
    s.notify_all(&json!({ "type": "resync" }));
    let info = s.workbooks.list().into_iter().next().ok_or_else(|| anyhow::anyhow!("Main is missing"))?;
    Ok(Json(json!({
        "workbook": workbook_json(&info, Some(&s.root), s.expose_paths),
        "report": report,
        "previous": {
            "moved_to": rel(&restored.set_aside),
            "kept": restored.set_aside.parent().is_some_and(|p| p.ends_with("workbooks")),
            "zip": saved_zip.as_deref().map(|z| z.file_name().map(|n| n.to_string_lossy().into_owned())),
        },
    }))
    .into_response())
}

/// Main has blocks or uploaded files.
fn main_has_content(main: &crate::workbooks::Workbook) -> anyhow::Result<bool> {
    let blocks: i64 = main.read().query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))?;
    let files = assets::list(&main.assets_dir()).len();
    Ok(blocks > 0 || files > 0)
}

/// Keeps the newest `BEFORE_RESTORE_KEPT` before-restore zips.
fn prune_before_restore(dir: &std::path::Path) {
    let mut zips: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(is_before_restore))
        .collect();
    // The date in the name sorts in time order.
    zips.sort();
    let extra = zips.len().saturating_sub(BEFORE_RESTORE_KEPT);
    for old in &zips[..extra] {
        if let Err(e) = std::fs::remove_file(old) {
            tracing::warn!("could not remove the old backup {}: {e}", old.display());
        }
    }
}

/// The restored workbook's wrapped key (already in `key_file`): adopt it
/// when this server has none, drop the file when it is the same key, keep it
/// for re-encrypting when it differs.
async fn settle_key(s: &Arc<AppState>, key: crate::config::Encryption, key_file: std::path::PathBuf) -> Result<backup::KeyOutcome, ApiError> {
    let key_path = key_file.clone();
    // The wrap is already in imported-key.json. Store it in the server
    // settings before deleting the upload. A failure here leaves both.
    let outcome = update_config(s, move |cfg| {
        Ok(match &cfg.encryption {
            // A password was set while the upload ran: treat the key as different.
            Some(now) if now.check != key.check => {
                let text = serde_json::to_string_pretty(&key)?;
                crate::config::write_durable(&key_path, text.as_bytes())?;
                backup::KeyOutcome::Different
            }
            Some(_) => backup::KeyOutcome::Same,
            None => {
                cfg.encryption = Some(key);
                backup::KeyOutcome::Adopted
            }
        })
    })
    .await?;
    // The browser treats imported-key.json as a foreign key and would
    // re-encrypt. Remove it once the server itself holds that key.
    if matches!(outcome, backup::KeyOutcome::Adopted | backup::KeyOutcome::Same)
        && let Err(e) = tokio::fs::remove_file(&key_file).await
        && e.kind() != std::io::ErrorKind::NotFound
    {
        return Err(e.into());
    }
    if outcome == backup::KeyOutcome::Adopted {
        s.notify_all(&json!({ "type": "encryption" }));
    }
    Ok(outcome)
}

/// Before-restore zips in backups/, newest first.
pub async fn list_backups(State(s): Shared) -> ApiResult {
    let dir = s.root.join("backups");
    blocking(move || {
        let mut out: Vec<serde_json::Value> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_str()?.to_string();
                let meta = e.metadata().ok()?;
                (is_before_restore(&name) && meta.is_file()).then(|| {
                    json!({ "name": name, "size": meta.len() })
                })
            })
            .collect();
        out.sort_by(|a, b| b["name"].as_str().cmp(&a["name"].as_str()));
        Ok(Json(out).into_response())
    })
    .await
}

/// Downloads one before-restore zip.
pub async fn get_backup(State(s): Shared, axum::extract::Path(name): axum::extract::Path<String>) -> ApiResult {
    if !is_before_restore(&name) {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found", "no such backup"));
    }
    let path = s.root.join("backups").join(&name);
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "not_found", "no such backup"))?;
    let len = file.metadata().await?.len();
    let mut res = file_body(file, None).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/zip"));
    h.insert(header::CONTENT_LENGTH, len.into());
    set_header(h, header::CONTENT_DISPOSITION, &format!("attachment; filename=\"{name}\""));
    Ok(res)
}

/// Pages holding encrypted blocks (the browser re-encrypts them after an import).
pub async fn sealed_pages(Wb(wb): Wb) -> ApiResult {
    read_json(wb, db::sealed_pages).await
}

/// The key a restored workbook's encrypted blocks use, when it differs from
/// this server's (still wrapped: only a password or recovery key opens it).
pub async fn get_imported_key(Wb(wb): Wb) -> ApiResult {
    blocking(move || {
        let key: Option<crate::config::Encryption> = std::fs::read_to_string(wb.dir.join(backup::IMPORTED_KEY))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
        Ok(Json(json!({ "encryption": key })).into_response())
    })
    .await
}

/// Called once every block was re-encrypted. Kept under a hidden name rather
/// than deleted, in case something was missed.
pub async fn done_imported_key(Wb(wb): Wb) -> ApiResult {
    blocking(move || {
        let path = wb.dir.join(backup::IMPORTED_KEY);
        if path.exists() {
            std::fs::rename(&path, wb.dir.join(format!(".{}.old", backup::IMPORTED_KEY)))?;
        }
        Ok(StatusCode::NO_CONTENT.into_response())
    })
    .await
}
