//! JSON API used by the web UI.
//!
//! Every request works on one workbook, chosen with `?wb=<id>` (default
//! "main"). Change events go to all clients and carry the workbook id.

use std::convert::Infallible;
use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
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

use crate::assets;
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

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

fn client_id(headers: &HeaderMap) -> String {
    headers.get("x-client-id").and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

/// Removes pages left empty and unlinked by a change, and tells open tabs.
fn prune(s: &AppState, wb: &Workbook, client: &str) {
    let removed = match db::prune_orphans(&wb.db.lock().unwrap()) {
        Ok(r) => r,
        Err(e) => return tracing::warn!("pruning empty pages: {e:#}"),
    };
    for page in removed {
        wb.remove_mirror(&page);
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
    let conn = wb.db.lock().unwrap();
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
        let mut conn = wb.db.lock().unwrap();
        db::save_page(&mut conn, &q.name, body.base_version, &body.blocks, &words)
            .map_err(|e| bad(format!("{e:#}")))?
    };
    match outcome {
        SaveOutcome::Saved(page) => {
            wb.write_mirror(&page, &body.blocks);
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
    }
}

pub async fn delete_page(
    State(s): Shared,
    Wb(wb): Wb,
    Query(q): Query<NameQuery>,
    headers: HeaderMap,
) -> ApiResult {
    let deleted = db::delete_page(&wb.db.lock().unwrap(), &q.name)?;
    let Some(page) = deleted else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    wb.remove_mirror(&page);
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
    let conn = wb.db.lock().unwrap();
    db::ensure_page(&conn, name, db::now_ms())?;
    Ok(Json(json!({ "page": db::get_page(&conn, name)? })).into_response())
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
    db::set_favorite(&wb.db.lock().unwrap(), name, q.on)?;
    s.notify(&wb, json!({ "type": "favorite", "name": name, "client": client_id(&headers) }));
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn list_pages(Wb(wb): Wb) -> ApiResult {
    let pages = db::list_pages(&wb.db.lock().unwrap())?;
    Ok(Json(pages).into_response())
}

pub async fn names(Wb(wb): Wb) -> ApiResult {
    let names = db::all_names(&wb.db.lock().unwrap())?;
    Ok(Json(names).into_response())
}

#[derive(Deserialize)]
pub struct JournalQuery {
    before: Option<i64>,
    limit: Option<i64>,
}

pub async fn journals(Wb(wb): Wb, Query(q): Query<JournalQuery>) -> ApiResult {
    let limit = q.limit.unwrap_or(10).clamp(1, 100);
    let pages = db::journals(&wb.db.lock().unwrap(), q.before, limit)?;
    Ok(Json(pages).into_response())
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    limit: Option<i64>,
}

pub async fn search(Wb(wb): Wb, Query(q): Query<SearchQuery>) -> ApiResult {
    let limit = q.limit.unwrap_or(30).clamp(1, 200);
    let results = db::search(&wb.db.lock().unwrap(), &q.q, limit)?;
    Ok(Json(results).into_response())
}

#[derive(Deserialize)]
pub struct IdQuery {
    id: String,
}

pub async fn get_block(Wb(wb): Wb, Query(q): Query<IdQuery>) -> ApiResult {
    match db::get_block(&wb.db.lock().unwrap(), &q.id)? {
        Some(b) => Ok(Json(b).into_response()),
        None => Ok(StatusCode::NOT_FOUND.into_response()),
    }
}

#[derive(Deserialize)]
pub struct BlockBody {
    content: String,
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
    let saved = db::update_block(&mut wb.db.lock().unwrap(), &q.id, &body.content, &words)?;
    let Some((page, blocks)) = saved else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    wb.write_mirror(&page, &blocks);
    s.notify(&wb, json!({
        "type": "page", "name": page.name, "version": page.version, "client": client_id(&headers)
    }));
    prune(&s, &wb, &client_id(&headers));
    Ok(Json(json!({ "page": page })).into_response())
}

/// Every block with a task status (the client filters open / finished).
pub async fn tasks(Wb(wb): Wb) -> ApiResult {
    Ok(Json(db::tasks(&wb.db.lock().unwrap())?).into_response())
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

/// Stores an uploaded image or PDF (raw bytes in the body). The original file
/// name may be given in `X-Filename`. Returns the path to put in the block text.
pub async fn upload_asset(State(s): Shared, Wb(wb): Wb, headers: HeaderMap, body: Bytes) -> ApiResult {
    if body.is_empty() {
        return Err(bad("empty upload"));
    }
    let original = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("file")
        .to_string();
    let dir = wb.assets_dir();
    let name = tokio::task::spawn_blocking(move || assets::save(&dir, &body, &original, db::now_ms()))
        .await
        .map_err(|e| anyhow::anyhow!(e))?
        .map_err(|e| ApiError(StatusCode::UNSUPPORTED_MEDIA_TYPE, format!("{e:#}")))?;
    s.notify(&wb, json!({ "type": "assets", "name": name, "client": client_id(&headers) }));
    Ok(Json(json!({ "name": name, "path": format!("../assets/{name}") })).into_response())
}

/// Serves an uploaded file. Names never change, so browsers may cache forever.
pub async fn get_asset(Wb(wb): Wb, Path(name): Path<String>) -> Response {
    if !assets::valid_name(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(bytes) = tokio::fs::read(wb.assets_dir().join(&name)).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = mime_guess::from_path(&name).first_or_octet_stream();
    let mut headers = vec![
        (header::CONTENT_TYPE, mime.as_ref().to_string()),
        (header::CACHE_CONTROL, "private, max-age=31536000, immutable".to_string()),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
        (header::CONTENT_DISPOSITION, format!("inline; filename=\"{name}\"")),
    ];
    // Images never need scripts or other resources. PDFs are shown by the
    // browser's own viewer, which a strict policy would block.
    if mime.type_() == mime_guess::mime::IMAGE {
        headers.push((header::CONTENT_SECURITY_POLICY, "default-src 'none'".to_string()));
    }
    let mut res = bytes.into_response();
    for (k, v) in headers {
        res.headers_mut().insert(k, v.parse().unwrap());
    }
    res
}

/// Files in the workbook's assets folder, newest first, with the pages that
/// mention each one.
pub async fn list_assets(Wb(wb): Wb) -> ApiResult {
    let usage = db::asset_usage(&wb.db.lock().unwrap())?;
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
    Ok(Json(s.workbooks.list()).into_response())
}

pub async fn create_workbook(State(s): Shared, Query(q): Query<NameQuery>) -> ApiResult {
    let info = s.workbooks.create(&q.name).map_err(|e| bad(format!("{e:#}")))?;
    s.notify_all(json!({ "type": "workbooks" }));
    Ok(Json(info).into_response())
}

pub async fn get_config(State(s): Shared) -> ApiResult {
    Ok(Json(s.config.read().unwrap().clone()).into_response())
}

/// Saves the shared settings (task statuses) and recomputes which blocks are
/// tasks in every open workbook.
pub async fn put_config(State(s): Shared, Json(cfg): Json<Config>) -> ApiResult {
    cfg.validate().map_err(|e| bad(format!("{e:#}")))?;
    cfg.save(&s.root.join("config.json"))?;
    let words = cfg.task_words();
    *s.config.write().unwrap() = cfg;
    let state = s.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        for wb in state.workbooks.open_workbooks() {
            db::refresh_task_refs(&wb.db.lock().unwrap(), &words)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| anyhow::anyhow!(e))??;
    s.notify_all(json!({ "type": "config" }));
    Ok(StatusCode::NO_CONTENT.into_response())
}
