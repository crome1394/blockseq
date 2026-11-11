//! Blockseq: a self-hosted, Logseq-style outliner.
//!
//! Configuration (environment variables):
//!   BLOCKSEQ_ADDR      listen address            (default 0.0.0.0:3030)
//!   BLOCKSEQ_DATA      data directory            (default ./data)
//!   BLOCKSEQ_PASSWORD  require this password via HTTP basic auth (optional)

mod api;
mod db;
mod md;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use axum::Router;
use axum::extract::{Request, State};
use axum::http::{StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use base64::Engine;
use rusqlite::Connection;
use tokio::sync::broadcast;

#[derive(rust_embed::Embed)]
#[folder = "web/"]
struct Assets;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub data_dir: PathBuf,
    pub events: broadcast::Sender<String>,
    pub password: Option<String>,
}

impl AppState {
    pub fn notify(&self, event: serde_json::Value) {
        // No receivers just means no other tab is open.
        let _ = self.events.send(event.to_string());
    }

    /// Writes the page as a Logseq Markdown file. This is a readable backup;
    /// the database stays the source of truth, so failures are only logged.
    pub fn write_mirror(&self, page: &db::PageMeta, blocks: &[db::Block]) {
        let path = self.data_dir.join(md::mirror_path(&page.name, page.journal_day));
        // Like Logseq, a page with no text gets no file.
        if blocks.iter().all(|b| b.content.trim().is_empty()) {
            let _ = std::fs::remove_file(&path);
            return;
        }
        if let Err(e) = write_atomic(&path, &md::page_to_markdown(blocks)) {
            tracing::warn!("could not write {}: {e:#}", path.display());
        }
    }

    pub fn remove_mirror(&self, page: &db::PageMeta) {
        let path = self.data_dir.join(md::mirror_path(&page.name, page.journal_day));
        let _ = std::fs::remove_file(path);
    }
}

fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Rewrites every Markdown mirror file from the database.
fn rebuild_mirror(state: &AppState) -> Result<usize> {
    let conn = state.db.lock().unwrap();
    let pages = db::list_pages(&conn)?;
    for summary in &pages {
        if let Some(page) = db::get_page(&conn, &summary.name)? {
            let blocks = db::get_blocks(&conn, &page.id)?;
            state.write_mirror(&page, &blocks);
        }
    }
    Ok(pages.len())
}

async fn require_password(State(s): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let Some(expected) = &s.password else {
        return next.run(req).await;
    };
    let ok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Basic "))
        .and_then(|b64| base64::engine::general_purpose::STANDARD.decode(b64).ok())
        .and_then(|raw| String::from_utf8(raw).ok())
        .is_some_and(|creds| {
            let pass = creds.split_once(':').map(|(_, p)| p).unwrap_or("");
            constant_time_eq(pass.as_bytes(), expected.as_bytes())
        });
    if ok {
        next.run(req).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Basic realm=\"Blockseq\"")],
            "Password required",
        )
            .into_response()
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn static_file(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    match Assets::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                [
                    (header::CONTENT_TYPE, mime.as_ref().to_string()),
                    (header::CACHE_CONTROL, "no-cache".to_string()),
                ],
                file.data,
            )
                .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    tokio::select! {
        _ = ctrl_c => {},
        _ = term.recv() => {},
    }
    tracing::info!("shutting down");
    // Open live-update streams never finish on their own, so don't wait on
    // them for long. Every save is already committed, so exiting is safe.
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        std::process::exit(0);
    });
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "blockseq=info".into()),
        )
        .init();

    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("blockseq {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    let addr = std::env::var("BLOCKSEQ_ADDR").unwrap_or_else(|_| "0.0.0.0:3030".into());
    let data_dir = PathBuf::from(std::env::var("BLOCKSEQ_DATA").unwrap_or_else(|_| "data".into()));
    let password = std::env::var("BLOCKSEQ_PASSWORD").ok().filter(|p| !p.is_empty());

    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("creating {}", data_dir.display()))?;
    let conn = db::open(&data_dir.join("blockseq.db")).context("opening database")?;

    let state = Arc::new(AppState {
        db: Mutex::new(conn),
        data_dir: data_dir.clone(),
        events: broadcast::channel(256).0,
        password,
    });
    let count = rebuild_mirror(&state)?;
    tracing::info!("{count} pages, Markdown mirror in {}", data_dir.display());

    let api = Router::new()
        .route(
            "/page",
            get(api::get_page).put(api::put_page).delete(api::delete_page),
        )
        .route("/pages", get(api::list_pages))
        .route("/names", get(api::names))
        .route("/journals", get(api::journals))
        .route("/search", get(api::search))
        .route("/block", get(api::get_block))
        .route("/events", get(api::events));

    let app = Router::new()
        .nest("/api", api)
        .fallback(static_file)
        .layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), require_password))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("binding {addr}"))?;
    tracing::info!(
        "Blockseq listening on http://{addr}{}",
        if state.password.is_some() { " (password required)" } else { "" }
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}
