//! JSON API used by the web UI.
//!
//! Every request works on one workbook, chosen with `?wb=<id>` (default
//! "main"). Change events go to all clients and carry the workbook id.

use std::sync::Arc;

use axum::Json;
use axum::extract::{FromRequestParts, Query, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use crate::config::Config;
use crate::db::{self, Block, SaveOutcome};
use crate::workbooks::{MAIN, Workbook};
use crate::AppState;

mod backups;
mod events;
mod files;
mod settings;

pub use backups::*;
pub use events::*;
pub use files::*;
pub use settings::*;

type Shared = State<Arc<AppState>>;

/// A failure the browser can act on. `code` is a short stable token
/// (`invalid`, `storage`, `error`, …). `message`, when set, is a short phrase
/// written for people. The error chain is logged and is not sent.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: Option<String>,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: Some(message.into()) }
    }

    fn coded(status: StatusCode, code: &'static str) -> Self {
        Self { status, code, message: None }
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!("{e:#}");
        classify(&e)
    }
}

/// Disk full, a locked database, and other failures a later try might survive
/// are `storage` (503). Other database and IO failures are `error` (500).
/// A rejection we wrote ourselves (no IO or database cause) is `invalid`
/// (400), and its text is sent only when it cannot contain a filesystem path.
fn classify(e: &anyhow::Error) -> ApiError {
    if e.chain().any(is_storage) {
        return ApiError::coded(StatusCode::SERVICE_UNAVAILABLE, "storage");
    }
    if e.chain().any(is_internal) {
        return ApiError::coded(StatusCode::INTERNAL_SERVER_ERROR, "error");
    }
    match client_message(&e.to_string()) {
        Some(msg) => ApiError::new(StatusCode::BAD_REQUEST, "invalid", msg),
        None => ApiError::coded(StatusCode::BAD_REQUEST, "invalid"),
    }
}

fn is_storage(err: &(dyn std::error::Error + 'static)) -> bool {
    if let Some(sql) = err.downcast_ref::<rusqlite::Error>()
        && matches!(
            sql.sqlite_error_code(),
            Some(
                rusqlite::ffi::ErrorCode::DiskFull
                    | rusqlite::ffi::ErrorCode::DatabaseBusy
                    | rusqlite::ffi::ErrorCode::DatabaseLocked
                    | rusqlite::ffi::ErrorCode::SystemIoFailure
                    | rusqlite::ffi::ErrorCode::ReadOnly
            )
        )
    {
        return true;
    }
    if let Some(io) = err.downcast_ref::<std::io::Error>()
        && (io.kind() == std::io::ErrorKind::StorageFull || io.raw_os_error() == Some(28))
    {
        return true;
    }
    let text = err.to_string().to_ascii_lowercase();
    text.contains("disk full")
        || text.contains("disk is full")
        || text.contains("no space left")
        || text.contains("database is locked")
        || text.contains("sqlite_busy")
}

fn is_internal(err: &(dyn std::error::Error + 'static)) -> bool {
    err.downcast_ref::<rusqlite::Error>().is_some()
        || err.downcast_ref::<std::io::Error>().is_some()
        || err.downcast_ref::<serde_json::Error>().is_some()
        || err.downcast_ref::<tokio::task::JoinError>().is_some()
}

/// A phrase safe to show: one short line, with no path separator.
fn client_message(msg: &str) -> Option<String> {
    let msg = msg.trim();
    if msg.is_empty() || msg.len() > 200 || msg.contains('/') || msg.contains('\\') || msg.contains('\n') {
        None
    } else {
        Some(msg.to_string())
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        anyhow::Error::from(e).into()
    }
}

impl From<tokio::task::JoinError> for ApiError {
    fn from(e: tokio::task::JoinError) -> Self {
        anyhow::Error::from(e).into()
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self {
        anyhow::Error::from(e).into()
    }
}

/// Sets a header whose value comes from data (a file name, a length); an
/// unusable value is skipped rather than failing the response.
fn set_header(h: &mut HeaderMap, name: header::HeaderName, value: &str) {
    if let Ok(v) = HeaderValue::from_str(value) {
        h.insert(name, v);
    } else { tracing::warn!("left out the {name} header: unusable value") }
}

/// The data folder's path, so error messages sent to browsers can say "the
/// data folder" instead of revealing where the server keeps things. The full
/// message is still logged.
pub static DATA_ROOT: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();

pub fn set_data_root(root: &std::path::Path) {
    let mut forms = vec![root.display().to_string()];
    if let Ok(abs) = std::path::absolute(root) {
        forms.push(abs.display().to_string());
    }
    if let Ok(real) = root.canonicalize() {
        forms.push(real.display().to_string());
    }
    forms.retain(|f| f.len() > 1);
    forms.sort_by_key(|f| std::cmp::Reverse(f.len())); // longest first
    let _ = DATA_ROOT.set(forms);
}

fn redact(msg: &str) -> String {
    let mut out = msg.to_string();
    for root in DATA_ROOT.get().into_iter().flatten() {
        out = out.replace(root.as_str(), "the data folder");
    }
    out
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = match &self.message {
            Some(m) => json!({ "error": self.code, "message": redact(m) }),
            None => json!({ "error": self.code }),
        };
        (self.status, Json(body)).into_response()
    }
}

type ApiResult = Result<Response, ApiError>;

/// Runs blocking work (SQLite, files) on Tokio's blocking thread pool, so a
/// slow query or disk never stalls the threads serving other requests.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, ApiError> + Send + 'static) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f).await?
}

/// Changes config.json: one change at a time (the settings lock is held
/// throughout), always starting from the file on disk, and refusing to touch
/// a damaged file. `f` may reject the change with any `ApiError`.
async fn update_config<T: Send + 'static>(
    s: &Arc<AppState>,
    f: impl FnOnce(&mut Config) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let s = s.clone();
    blocking(move || {
        let mut cached = s.config.write();
        let path = s.config_path();
        let mut cfg = Config::load(&path)?;
        let out = f(&mut cfg)?;
        cfg.save(&path)?;
        *cached = cfg;
        Ok(out)
    })
    .await
}

/// config.json as it is on disk, read on the blocking pool.
async fn read_config(s: &Arc<AppState>) -> Result<Config, ApiError> {
    let s = s.clone();
    blocking(move || Ok(s.read_config()?)).await
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "invalid", msg)
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
                for page in &r {
                    wb.remove_mirror(page);
                }
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
            ??;
        wb.map(Wb).ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, "not_found", format!("no workbook called {id}"))
        })
    }
}

#[derive(Deserialize)]
pub struct NameQuery {
    name: String,
}

pub async fn get_page(Wb(wb): Wb, Query(q): Query<NameQuery>) -> ApiResult {
    blocking(move || {
        let conn = wb.read();
        let page = db::get_page(&conn, &q.name)?;
        let blocks = match &page {
            Some(p) => db::get_blocks(&conn, &p.id)?,
            None => vec![],
        };
        let backlinks = db::backlinks(&conn, &q.name)?;
        let name = page.as_ref().map(|p| p.name.clone()).unwrap_or(q.name.trim().to_string());
        Ok(Json(json!({ "name": name, "page": page, "blocks": blocks, "backlinks": backlinks })).into_response())
    })
    .await
}

#[derive(Deserialize)]
pub struct SaveBody {
    base_version: i64,
    blocks: Vec<Block>,
    /// Set by "Keep mine" after a conflict: the other device's version is
    /// kept in the page history before it is replaced.
    #[serde(default)]
    overwrite: bool,
}

pub async fn put_page(
    State(s): Shared,
    Wb(wb): Wb,
    Query(q): Query<NameQuery>,
    headers: HeaderMap,
    Json(body): Json<SaveBody>,
) -> ApiResult {
    let client = client_id(&headers);
    blocking(move || {
        let words = s.task_words();
        let outcome = {
            // The Markdown file is written under the same lock as the
            // database, so two quick saves can't leave the older text in it.
            let conn = wb.db.lock();
            let outcome = if body.overwrite {
                db::save_page_noting(&conn, &q.name, body.base_version, &body.blocks, &words, "replaced by Keep mine")
            } else {
                db::save_page(&conn, &q.name, body.base_version, &body.blocks, &words)
            }
            ?;
            if let SaveOutcome::Saved(page) = &outcome {
                wb.write_mirror(page, &body.blocks);
            }
            outcome
        };
        Ok(match outcome {
            SaveOutcome::Saved(page) => {
                s.notify(&wb, json!({ "type": "page", "name": page.name, "version": page.version, "client": client }));
                prune(&s, &wb, &client);
                Json(json!({ "page": page })).into_response()
            }
            SaveOutcome::Conflict(page, blocks) => (
                StatusCode::CONFLICT,
                Json(json!({ "error": "conflict", "page": page, "blocks": blocks })),
            )
                .into_response(),
            SaveOutcome::ForeignIds(ids) => (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "conflict",
                    "message": "some blocks belong to another page",
                    "foreign_ids": ids,
                })),
            )
                .into_response(),
            SaveOutcome::Deleted => (
                StatusCode::CONFLICT,
                Json(json!({ "error": "conflict", "deleted": true, "page": null, "blocks": [] })),
            )
                .into_response(),
        })
    })
    .await
}

pub async fn delete_page(
    State(s): Shared,
    Wb(wb): Wb,
    Query(q): Query<NameQuery>,
    headers: HeaderMap,
) -> ApiResult {
    let client = client_id(&headers);
    blocking(move || {
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
        s.notify(&wb, json!({ "type": "deleted", "name": page.name, "client": client }));
        prune(&s, &wb, &client);
        Ok(StatusCode::NO_CONTENT.into_response())
    })
    .await
}

/// Creates an empty page if it doesn't exist (used by the calendar to create
/// a journal day). Returns the page either way.
pub async fn ensure_page(Wb(wb): Wb, Query(q): Query<NameQuery>) -> ApiResult {
    let name = q.name.trim().to_string();
    if name.is_empty() {
        return Err(bad("page name is empty"));
    }
    blocking(move || {
        let conn = wb.db.lock();
        db::ensure_page(&conn, &name, db::now_ms())?;
        Ok(Json(json!({ "page": db::get_page(&conn, &name)? })).into_response())
    })
    .await
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
    let client = client_id(&headers);
    blocking(move || {
        let words = s.task_words();
        let out = {
            let conn = wb.db.lock();
            let out = db::rename_page(&conn, &q.name, &q.to, &words)?;
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
    })
    .await
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
    let name = q.name.trim().to_string();
    if name.is_empty() {
        return Err(bad("page name is empty"));
    }
    let client = client_id(&headers);
    blocking(move || {
        db::set_favorite(&wb.db.lock(), &name, q.on)?;
        s.notify(&wb, json!({ "type": "favorite", "name": name, "client": client }));
        Ok(StatusCode::NO_CONTENT.into_response())
    })
    .await
}

/// Runs `f` on the workbook's database (on the blocking thread pool) and
/// returns its result as JSON.
async fn read_json<T: serde::Serialize + Send + 'static>(
    wb: Arc<Workbook>,
    f: impl FnOnce(&rusqlite::Connection) -> anyhow::Result<T> + Send + 'static,
) -> ApiResult {
    blocking(move || Ok(Json(f(&wb.read())?).into_response())).await
}

pub async fn list_pages(Wb(wb): Wb) -> ApiResult {
    read_json(wb, db::list_pages).await
}

/// Calendar days, favourites, last change, and the workbook's disk usage.
pub async fn sidebar(State(s): Shared, Wb(wb): Wb) -> ApiResult {
    let expose = s.expose_paths;
    blocking(move || {
        let side = db::sidebar(&wb.read())?;
        let mut usage = serde_json::to_value(wb.usage())?;
        // Relative to the data folder. Main is the folder itself.
        let folder = if wb.id == MAIN { ".".to_string() } else { format!("workbooks/{}", wb.id) };
        usage["folder"] = json!(folder);
        if expose {
            usage["absolute"] = json!(absolute_display(&wb.dir));
        }
        Ok(Json(json!({
            "journal_days": side.journal_days,
            "favorites": side.favorites,
            "newest": side.newest,
            "usage": usage,
        }))
        .into_response())
    })
    .await
}

pub async fn names(Wb(wb): Wb) -> ApiResult {
    read_json(wb, db::all_names).await
}

#[derive(Deserialize)]
pub struct JournalQuery {
    before: Option<i64>,
    limit: Option<i64>,
}

pub async fn journals(Wb(wb): Wb, Query(q): Query<JournalQuery>) -> ApiResult {
    let limit = q.limit.unwrap_or(10).clamp(1, 100);
    read_json(wb, move |c| db::journals(c, q.before, limit)).await
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    limit: Option<i64>,
}

pub async fn search(Wb(wb): Wb, Query(q): Query<SearchQuery>) -> ApiResult {
    let limit = q.limit.unwrap_or(30).clamp(1, 200);
    read_json(wb, move |c| db::search(c, &q.q, limit)).await
}

#[derive(Deserialize)]
pub struct IdQuery {
    id: String,
}

pub async fn get_block(Wb(wb): Wb, Query(q): Query<IdQuery>) -> ApiResult {
    blocking(move || {
        Ok(match db::get_block(&wb.read(), &q.id)? {
            Some(b) => Json(b).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        })
    })
    .await
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
    let client = client_id(&headers);
    blocking(move || {
        let words = s.task_words();
        let page = {
            let conn = wb.db.lock();
            match db::update_block(&conn, &q.id, &body.content, body.expected.as_deref(), &words)? {
                db::UpdateOutcome::Missing => return Ok(StatusCode::NOT_FOUND.into_response()),
                db::UpdateOutcome::Changed(current) => {
                    return Ok((
                        StatusCode::CONFLICT,
                        Json(json!({
                            "error": "conflict",
                            "message": "the block changed elsewhere",
                            "current": current,
                        })),
                    )
                        .into_response());
                }
                db::UpdateOutcome::Saved(page, blocks) => {
                    wb.write_mirror(&page, &blocks);
                    page
                }
            }
        };
        s.notify(&wb, json!({ "type": "page", "name": page.name, "version": page.version, "client": client }));
        prune(&s, &wb, &client);
        Ok(Json(json!({ "page": page })).into_response())
    })
    .await
}

/// Pages whose #Encrypted blocks still need encrypting (done by the browser).
pub async fn encryption_pending(Wb(wb): Wb) -> ApiResult {
    read_json(wb, db::encryption_pending).await
}

/// Every block with a task status (the client filters open / finished).
pub async fn tasks(Wb(wb): Wb) -> ApiResult {
    read_json(wb, db::tasks).await
}

#[derive(Deserialize)]
pub struct HistoryId {
    id: i64,
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    name: String,
    /// Page id. Set for a deleted page, so two of the same name stay apart.
    #[serde(default)]
    page: Option<String>,
}

/// Kept versions of a page, newest first. `page` selects one page id;
/// without it, the live page of that name (or deleted pages of that name).
pub async fn history(Wb(wb): Wb, Query(q): Query<HistoryQuery>) -> ApiResult {
    read_json(wb, move |c| match q.page.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => db::history_of(c, id),
        None => db::history(c, &q.name),
    })
    .await
}

pub async fn history_version(Wb(wb): Wb, Query(q): Query<HistoryId>) -> ApiResult {
    blocking(move || {
        Ok(match db::history_version(&wb.read(), q.id)? {
            Some(v) => Json(v).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        })
    })
    .await
}

/// Deleted pages that can be restored from their history.
pub async fn deleted_pages(Wb(wb): Wb) -> ApiResult {
    read_json(wb, db::deleted_pages).await
}

/// Makes a kept version the page's content again (keeping the replaced one).
pub async fn restore_version(State(s): Shared, Wb(wb): Wb, Query(q): Query<HistoryId>) -> ApiResult {
    blocking(move || {
        let words = s.task_words();
        let restored = {
            let conn = wb.db.lock();
            let restored = db::restore_version(&conn, q.id, &words)?;
            if let Some((page, blocks)) = &restored {
                wb.write_mirror(page, blocks);
            }
            restored
        };
        let Some((page, _)) = restored else {
            return Ok(StatusCode::NOT_FOUND.into_response());
        };
        s.notify(&wb, json!({ "type": "page", "name": page.name, "version": page.version, "client": "" }));
        Ok(Json(json!({ "page": page })).into_response())
    })
    .await
}

/// For monitoring (no password needed; shows no notes and no filesystem
/// paths): the server runs, config.json reads, and each open workbook's
/// database answers and passed its startup check. Each of those is `ok` or
/// `error`. 503 if anything is wrong. The real text is logged.
pub async fn health(State(s): Shared) -> Response {
    match tokio::task::spawn_blocking(move || health_report(&s)).await {
        Ok(res) => res,
        Err(e) => {
            tracing::error!("health check: {e:#}");
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}

fn health_flag(ok: bool) -> &'static str {
    if ok { "ok" } else { "error" }
}

fn health_report(s: &AppState) -> Response {
    let config_ok = match s.read_config() {
        Ok(_) => true,
        Err(e) => {
            tracing::error!("health: config: {e:#}");
            false
        }
    };
    let mut ok = config_ok;
    let workbooks: Vec<_> = s
        .workbooks
        .open_workbooks()
        .iter()
        .map(|wb| {
            let answers = wb.read().query_row("SELECT 1", [], |r| r.get::<_, i64>(0)).is_ok();
            let integrity_ok = wb.integrity == "ok";
            if !answers {
                tracing::error!("health: workbook {} database is not answering", wb.id);
            }
            if !integrity_ok {
                tracing::error!("health: workbook {} integrity: {}", wb.id, wb.integrity);
            }
            ok &= answers && integrity_ok;
            json!({
                "id": wb.id,
                "database": health_flag(answers),
                "integrity": health_flag(integrity_ok),
            })
        })
        .collect();
    let status = if ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    (
        status,
        Json(json!({
            "ok": ok,
            "version": env!("CARGO_PKG_VERSION"),
            "config": health_flag(config_ok),
            "workbooks": workbooks,
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_cap_follows_content_length() {
        let mb = 1024 * 1024;
        let mut h = HeaderMap::new();
        assert_eq!(upload_cap(&h, 2048 * mb).unwrap(), 2048 * mb); // chunked: the limit
        h.insert(header::CONTENT_LENGTH, "51200".parse().unwrap());
        assert_eq!(upload_cap(&h, 2048 * mb).unwrap(), 51200);
        h.insert(header::CONTENT_LENGTH, (3 * mb).to_string().parse().unwrap());
        assert_eq!(upload_cap(&h, 2 * mb).unwrap_err().status, StatusCode::PAYLOAD_TOO_LARGE);
    }
    
    

    #[test]
    fn error_messages_hide_the_data_folder() {
        let root = std::env::temp_dir().join("bq-redact-test");
        set_data_root(&root);
        let msg = format!("writing {}/workbooks/X/pages/a.md: disk full", root.display());
        assert_eq!(redact(&msg), "writing the data folder/workbooks/X/pages/a.md: disk full");
        let err = ApiError::new(StatusCode::BAD_REQUEST, "invalid", msg);
        let shown = match &err.message {
            Some(m) => json!({ "error": err.code, "message": redact(m) }),
            None => json!({ "error": err.code }),
        };
        assert_eq!(shown["error"], "invalid");
        assert_eq!(shown["message"], "writing the data folder/workbooks/X/pages/a.md: disk full");
    }

    fn sql_err(code: i32, message: &str) -> anyhow::Error {
        rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(code), Some(message.into())).into()
    }

    #[test]
    fn failures_become_stable_codes() {
        let full = classify(&sql_err(rusqlite::ffi::SQLITE_FULL, "database or disk is full"));
        assert_eq!(full.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(full.code, "storage");
        assert!(full.message.is_none());

        let busy = classify(&sql_err(rusqlite::ffi::SQLITE_BUSY, "database is locked"));
        assert_eq!(busy.code, "storage");

        let constraint = classify(&sql_err(rusqlite::ffi::SQLITE_CONSTRAINT, "UNIQUE constraint failed: pages.name"));
        assert_eq!(constraint.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(constraint.code, "error");
        assert!(constraint.message.is_none());

        let io = classify(&anyhow::Error::from(std::io::Error::from_raw_os_error(28)));
        assert_eq!(io.code, "storage");

        let rejected = classify(&anyhow::anyhow!("page name is empty"));
        assert_eq!(rejected.status, StatusCode::BAD_REQUEST);
        assert_eq!(rejected.code, "invalid");
        assert_eq!(rejected.message.as_deref(), Some("page name is empty"));

        let path = classify(&anyhow::anyhow!("writing /var/lib/blockseq/pages/a.md failed"));
        assert_eq!(path.code, "invalid");
        assert!(path.message.is_none());

        let locked = classify(&anyhow::anyhow!("sqlite_busy"));
        assert_eq!(locked.code, "storage");
    }

    #[test]
    fn export_zip_stays_out_of_the_data_folder() {
        let path = export_zip_path(uuid::Uuid::nil());
        assert!(path.starts_with(std::env::temp_dir()));
        assert_eq!(path.file_name().and_then(|s| s.to_str()), Some("blockseq-export-00000000-0000-0000-0000-000000000000.zip"));
        assert_ne!(std::path::Path::new("/var/lib/blockseq").join(path.file_name().unwrap()), path);
    }

    #[test]
    fn absolute_paths_only_for_a_direct_localhost_connection() {
        let mut headers = HeaderMap::new();
        assert!(local_admin("127.0.0.1".parse().unwrap(), &headers));
        assert!(local_admin("::1".parse().unwrap(), &headers));
        assert!(!local_admin("10.0.0.5".parse().unwrap(), &headers));
        headers.insert("x-forwarded-for", "127.0.0.1".parse().unwrap());
        assert!(!local_admin("127.0.0.1".parse().unwrap(), &headers));
        headers.remove("x-forwarded-for");
        headers.insert("x-forwarded-host", "notes.example.com".parse().unwrap());
        assert!(!local_admin("127.0.0.1".parse().unwrap(), &headers));
        // The opt-in ignores the proxy headers. Without it, a forwarded
        // connection still sees no absolute path.
        assert!(reveal_paths(true, "10.0.0.5".parse().unwrap(), &headers));
        assert!(!reveal_paths(false, "127.0.0.1".parse().unwrap(), &headers));
        assert!(reveal_paths(false, "127.0.0.1".parse().unwrap(), &HeaderMap::new()));
    }

    #[test]
    fn byte_ranges() {
        assert_eq!(parse_range("bytes=0-9", 100), Some(Ok((0, 9))));
        assert_eq!(parse_range("bytes=90-", 100), Some(Ok((90, 99))));
        assert_eq!(parse_range("bytes=-10", 100), Some(Ok((90, 99))));
        assert_eq!(parse_range("bytes=50-500", 100), Some(Ok((50, 99))));
        assert_eq!(parse_range("bytes=100-", 100), Some(Err(())));
        assert_eq!(parse_range("bytes=9-3", 100), Some(Err(())));
        assert_eq!(parse_range("bytes=0-1,5-6", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
        assert_eq!(parse_range("bytes=-0", 100), Some(Err(())));
    }
}
