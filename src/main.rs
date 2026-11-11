//! Blockseq: a self-hosted, Logseq-style outliner.
//!
//! Configuration (environment variables):
//!   BLOCKSEQ_ADDR      listen address            (default 0.0.0.0:3030)
//!   BLOCKSEQ_DATA      data directory            (default ./data); holds the
//!                      "Main" workbook (database, Markdown mirror, assets/),
//!                      other workbooks in workbooks/<name>/, and config.json
//!   BLOCKSEQ_PASSWORD  require this password via HTTP basic auth (optional)
//!   BLOCKSEQ_MAX_UPLOAD_MB  largest file upload in MB (default 2048)

mod api;
mod assets;
mod config;
mod db;
mod md;
mod workbooks;

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use axum::Router;
use axum::extract::{Request, State};
use axum::http::{StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use tokio::sync::broadcast;

#[derive(rust_embed::Embed)]
#[folder = "web/"]
struct Assets;

pub struct AppState {
    pub root: PathBuf,
    pub workbooks: workbooks::Registry,
    pub config: RwLock<config::Config>,
    pub events: broadcast::Sender<String>,
    pub password: Option<String>,
    /// Largest upload accepted, in bytes (BLOCKSEQ_MAX_UPLOAD_MB).
    pub max_upload: u64,
}

impl AppState {
    /// Tells every open tab about a change in a workbook.
    pub fn notify(&self, wb: &workbooks::Workbook, mut event: serde_json::Value) {
        event["wb"] = serde_json::Value::String(wb.id.clone());
        self.notify_all(event);
    }

    pub fn notify_all(&self, event: serde_json::Value) {
        // No receivers just means no other tab is open.
        let _ = self.events.send(event.to_string());
    }

    pub fn task_words(&self) -> Vec<String> {
        self.config.read().unwrap().task_words()
    }
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
    let max_upload_mb: u64 = std::env::var("BLOCKSEQ_MAX_UPLOAD_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(2048);

    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("creating {}", data_dir.display()))?;
    let config = config::Config::load(&data_dir.join("config.json"));
    let state = Arc::new(AppState {
        root: data_dir.clone(),
        workbooks: workbooks::Registry::new(data_dir.clone()),
        config: RwLock::new(config),
        events: broadcast::channel(256).0,
        password,
        max_upload: max_upload_mb * 1024 * 1024,
    });
    // Open Main now, so a broken database is reported at startup.
    state
        .workbooks
        .get(workbooks::MAIN, &state.task_words())
        .context("opening the Main workbook")?;

    let api = Router::new()
        .route(
            "/page",
            get(api::get_page).put(api::put_page).delete(api::delete_page),
        )
        .route("/page/ensure", post(api::ensure_page))
        .route("/page/favorite", post(api::set_favorite))
        .route("/page/rename", post(api::rename_page))
        .route("/pages", get(api::list_pages))
        .route("/names", get(api::names))
        .route("/journals", get(api::journals))
        .route("/search", get(api::search))
        .route("/block", get(api::get_block).put(api::put_block))
        .route("/tasks", get(api::tasks))
        .route("/assets", get(api::list_assets).post(api::upload_asset).delete(api::delete_asset))
        .route("/workbooks", get(api::list_workbooks).post(api::create_workbook))
        .route("/config", get(api::get_config).put(api::put_config))
        .route("/events", get(api::events));

    let app = Router::new()
        .nest("/api", api)
        .route("/assets/{name}", get(api::get_asset))
        .fallback(static_file)
        .layer(axum::extract::DefaultBodyLimit::max(100 * 1024 * 1024))
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
