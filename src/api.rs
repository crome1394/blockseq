//! JSON API used by the web UI.

use std::convert::Infallible;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use tokio_stream::Stream;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

use crate::AppState;
use crate::db::{self, Block, SaveOutcome};

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

#[derive(Deserialize)]
pub struct NameQuery {
    name: String,
}

pub async fn get_page(State(s): Shared, Query(q): Query<NameQuery>) -> ApiResult {
    let conn = s.db.lock().unwrap();
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
    Query(q): Query<NameQuery>,
    headers: HeaderMap,
    Json(body): Json<SaveBody>,
) -> ApiResult {
    let client = headers
        .get("x-client-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let outcome = {
        let mut conn = s.db.lock().unwrap();
        db::save_page(&mut conn, &q.name, body.base_version, &body.blocks)
            .map_err(|e| ApiError(StatusCode::BAD_REQUEST, format!("{e:#}")))?
    };
    match outcome {
        SaveOutcome::Saved(page) => {
            s.write_mirror(&page, &body.blocks);
            s.notify(json!({
                "type": "page", "name": page.name, "version": page.version, "client": client
            }));
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
    Query(q): Query<NameQuery>,
    headers: HeaderMap,
) -> ApiResult {
    let deleted = db::delete_page(&s.db.lock().unwrap(), &q.name)?;
    let Some(page) = deleted else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    s.remove_mirror(&page);
    let client = headers.get("x-client-id").and_then(|v| v.to_str().ok()).unwrap_or("");
    s.notify(json!({ "type": "deleted", "name": page.name, "client": client }));
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn list_pages(State(s): Shared) -> ApiResult {
    let pages = db::list_pages(&s.db.lock().unwrap())?;
    Ok(Json(pages).into_response())
}

pub async fn names(State(s): Shared) -> ApiResult {
    let names = db::all_names(&s.db.lock().unwrap())?;
    Ok(Json(names).into_response())
}

#[derive(Deserialize)]
pub struct JournalQuery {
    before: Option<i64>,
    limit: Option<i64>,
}

pub async fn journals(State(s): Shared, Query(q): Query<JournalQuery>) -> ApiResult {
    let limit = q.limit.unwrap_or(10).clamp(1, 100);
    let pages = db::journals(&s.db.lock().unwrap(), q.before, limit)?;
    Ok(Json(pages).into_response())
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    limit: Option<i64>,
}

pub async fn search(State(s): Shared, Query(q): Query<SearchQuery>) -> ApiResult {
    let limit = q.limit.unwrap_or(30).clamp(1, 200);
    let results = db::search(&s.db.lock().unwrap(), &q.q, limit)?;
    Ok(Json(results).into_response())
}

#[derive(Deserialize)]
pub struct IdQuery {
    id: String,
}

pub async fn get_block(State(s): Shared, Query(q): Query<IdQuery>) -> ApiResult {
    match db::get_block(&s.db.lock().unwrap(), &q.id)? {
        Some(b) => Ok(Json(b).into_response()),
        None => Ok(StatusCode::NOT_FOUND.into_response()),
    }
}

/// Server-sent events: tells other open tabs/devices when a page changes.
pub async fn events(State(s): Shared) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    // A client that fell behind is told to reload everything it shows.
    let stream = BroadcastStream::new(s.events.subscribe()).map(|msg| {
        let data = msg.unwrap_or_else(|_| r#"{"type":"resync"}"#.to_string());
        Ok(Event::default().data(data))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}
