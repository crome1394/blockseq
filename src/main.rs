//! Blockseq: a self-hosted, Logseq-style outliner.
//!
//! Configuration (environment variables):
//!   BLOCKSEQ_ADDR      listen address            (default 0.0.0.0:3030)
//!   BLOCKSEQ_DATA      data directory            (default ./data); holds the
//!                      "Main" workbook (database, Markdown mirror, assets/),
//!                      other workbooks in workbooks/<name>/, and config.json
//!   BLOCKSEQ_PASSWORD  require this password via HTTP basic auth (optional)
//!   BLOCKSEQ_MAX_UPLOAD_MB  largest file upload in MB (default 2048)
//!   BLOCKSEQ_TRUSTED_PROXIES  reverse proxy addresses whose X-Forwarded-For
//!                      is used for the wrong-password limit (optional)
//!   BLOCKSEQ_HOSTS     host names to serve, comma-separated (optional; IP
//!                      addresses and localhost always work). Protects
//!                      against DNS rebinding when no password is set.

mod api;
mod auth;
mod assets;
mod backup;
mod config;
mod crypto;
mod db;
mod guard;
mod md;
mod workbooks;

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;

use anyhow::{Context, Result};
use axum::Router;
use axum::http::{StatusCode, Uri, header};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
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
    /// Host names served (BLOCKSEQ_HOSTS); empty = any.
    pub allowed_hosts: Vec<String>,
    /// Reverse proxies whose X-Forwarded-For is believed (BLOCKSEQ_TRUSTED_PROXIES).
    pub trusted_proxies: Vec<std::net::IpAddr>,
    /// Wrong-password limit per client.
    pub limiter: auth::Limiter,
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
        self.config.read().task_words()
    }

    pub fn config_path(&self) -> PathBuf {
        self.root.join("config.json")
    }

    /// The shared settings as they are on disk (the terminal password reset
    /// may have changed them). Errors if config.json is damaged.
    pub fn read_config(&self) -> Result<config::Config> {
        config::Config::load(&self.config_path())
    }
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

async fn shutdown_signal(state: Arc<AppState>) {
    let ctrl_c = tokio::signal::ctrl_c();
    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(mut term) => {
            tokio::select! {
                _ = ctrl_c => {},
                _ = term.recv() => {},
            }
        }
        // Without a SIGTERM handler systemd's stop still ends the process;
        // only the tidy-up below is skipped.
        Err(e) => {
            tracing::warn!("no SIGTERM handler: {e}");
            let _ = ctrl_c.await;
        }
    }
    tracing::info!("shutting down");
    // Each workbook's lock waits for a save in progress; then the database
    // files are tidied so they are complete on their own (handy for backups).
    let tidy = tokio::task::spawn_blocking(move || {
        for wb in state.workbooks.open_workbooks() {
            if let Err(e) = db::tidy(&wb.db.lock()) {
                tracing::warn!("workbook {}: {e:#}", wb.id);
            }
        }
    });
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), tidy).await;
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

    let data_env = std::env::var("BLOCKSEQ_DATA").unwrap_or_else(|_| "data".into());
    if std::env::args().nth(1).as_deref() == Some("reset-encryption-password") {
        if let Err(e) = crypto::reset_command(std::path::Path::new(&data_env)) {
            eprintln!("error: {e:#}");
            std::process::exit(1);
        }
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("export") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        if let Err(e) = backup::export_command(std::path::Path::new(&data_env), &args) {
            eprintln!("error: {e:#}");
            std::process::exit(1);
        }
        return Ok(());
    }

    let addr = std::env::var("BLOCKSEQ_ADDR").unwrap_or_else(|_| "0.0.0.0:3030".into());
    let data_dir = PathBuf::from(std::env::var("BLOCKSEQ_DATA").unwrap_or_else(|_| "data".into()));
    let password = std::env::var("BLOCKSEQ_PASSWORD").ok().filter(|p| !p.is_empty());
    let max_upload_mb: u64 = std::env::var("BLOCKSEQ_MAX_UPLOAD_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(2048);

    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("creating {}", data_dir.display()))?;
    let cleaned = workbooks::clean_temp(&data_dir);
    if cleaned > 0 {
        tracing::info!("removed {cleaned} temporary files left by an interrupted upload, export or import");
    }
    let config = config::Config::load(&data_dir.join("config.json")).context("reading the shared settings")?;
    let state = Arc::new(AppState {
        root: data_dir.clone(),
        workbooks: workbooks::Registry::new(data_dir.clone()),
        config: RwLock::new(config),
        events: broadcast::channel(256).0,
        password,
        max_upload: max_upload_mb * 1024 * 1024,
        allowed_hosts: guard::parse_hosts(&std::env::var("BLOCKSEQ_HOSTS").unwrap_or_default()),
        trusted_proxies: auth::parse_proxies(&std::env::var("BLOCKSEQ_TRUSTED_PROXIES").unwrap_or_default()),
        limiter: auth::Limiter::default(),
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
        .route("/sidebar", get(api::sidebar))
        .route("/journals", get(api::journals))
        .route("/search", get(api::search))
        .route("/block", get(api::get_block).put(api::put_block))
        .route("/tasks", get(api::tasks))
        .route("/assets", get(api::list_assets).post(api::upload_asset).delete(api::delete_asset))
        .route("/workbooks", get(api::list_workbooks).post(api::create_workbook).delete(api::delete_workbook))
        .route("/workbooks/rename", post(api::rename_workbook))
        .route("/config", get(api::get_config).put(api::put_config))
        .route("/encryption", get(api::get_encryption).put(api::put_encryption))
        .route("/encryption/pending", get(api::encryption_pending))
        .route("/encryption/sealed", get(api::sealed_pages))
        .route("/encryption/imported", get(api::get_imported_key).delete(api::done_imported_key))
        .route("/export", get(api::export))
        .route("/import", post(api::import))
        .route("/events", get(api::events))
        .route("/health", get(api::health));

    let app = Router::new()
        .nest("/api", api)
        .route("/assets/{name}", get(api::get_asset))
        .fallback(static_file)
        .layer(axum::extract::DefaultBodyLimit::max(100 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), auth::require_password))
        // Outermost: refuse cross-site writes and unknown host names first.
        .layer(middleware::from_fn_with_state(state.clone(), guard::check))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("binding {addr}"))?;
    tracing::info!(
        "Blockseq listening on http://{addr}{}",
        if state.password.is_some() { " (password required)" } else { "" }
    );
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(shutdown_signal(state.clone()))
        .await?;
    Ok(())
}
