//! Workbooks (list, create, rename, delete) and the settings every device
//! shares: task statuses and the wrapped encryption key.

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Deserialize;
use serde_json::json;

use crate::db;
use crate::workbooks::MAIN;

use super::{absolute_display, ApiError, ApiResult, bad, blocking, NameQuery, read_config, Shared, update_config, workbook_json};


pub async fn list_workbooks(State(s): Shared) -> ApiResult {
    let main_name = read_config(&s).await?.main_name;
    let state = s.clone();
    let mut list = blocking(move || Ok(state.workbooks.list())).await?;
    if let (Some(name), Some(first)) = (main_name, list.first_mut()) {
        first.name = name;
    }
    let expose = s.expose_paths;
    let out: Vec<_> = list
        .iter()
        .map(|info| {
            let dir = s.workbooks.dir_of(&info.id);
            workbook_json(info, dir.as_deref(), expose)
        })
        .collect();
    Ok(Json(out).into_response())
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
        let name = to.clone();
        update_config(&s, move |cfg| {
            cfg.main_name = (name != "Main").then_some(name);
            Ok(())
        })
        .await?;
        let path = s.workbooks.list().into_iter().next().map(|w| w.path).unwrap_or_default();
        crate::workbooks::WorkbookInfo { id: MAIN.into(), name: to.clone(), kind: "blockseq", path }
    } else {
        let state = s.clone();
        let (from, dest) = (q.id.clone(), to.clone());
        tokio::task::spawn_blocking(move || state.workbooks.rename(&from, &dest)).await??
    };
    tracing::info!("renamed workbook {} to {}", q.id, info.name);
    s.notify_all(&json!({ "type": "workbooks", "renamed": { "from": q.id, "to": info.id } }));
    let dir = s.workbooks.dir_of(&info.id);
    Ok(Json(workbook_json(&info, dir.as_deref(), s.expose_paths)).into_response())
}

#[derive(Deserialize)]
pub struct IdOnly {
    id: String,
}

/// Deletes a workbook (not Main): its folder moves to workbooks/.trash/.
pub async fn delete_workbook(State(s): Shared, Query(q): Query<IdOnly>) -> ApiResult {
    let state = s.clone();
    let id = q.id.clone();
    let root = s.root.clone();
    let trash = tokio::task::spawn_blocking(move || state.workbooks.delete(&id)).await??;
    let rel = crate::workbooks::relative_path(&root, &trash);
    tracing::info!("deleted workbook {}: moved to {}", q.id, trash.display());
    s.notify_all(&json!({ "type": "workbooks", "deleted": q.id }));
    // `trash` stays relative to the data folder. `absolute` is the real
    // folder, and only when the operator opted in.
    let shown = if rel == "." { "workbooks/.trash".to_string() } else { rel };
    let mut body = json!({ "trash": shown });
    if s.expose_paths {
        body["absolute"] = json!(absolute_display(&trash));
    }
    Ok(Json(body).into_response())
}

pub async fn create_workbook(State(s): Shared, Query(q): Query<NameQuery>) -> ApiResult {
    let state = s.clone();
    let info = blocking(move || Ok(state.workbooks.create(&q.name)?)).await?;
    s.notify_all(&json!({ "type": "workbooks" }));
    let dir = s.workbooks.dir_of(&info.id);
    Ok(Json(workbook_json(&info, dir.as_deref(), s.expose_paths)).into_response())
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
    let cfg = read_config(&s).await?;
    Ok(Json(json!({ "encryption": cfg.encryption })).into_response())
}

#[derive(Deserialize)]
pub struct EncryptionBody {
    encryption: crate::config::Encryption,
    /// Proof of holding the current key (see crypto.rs `key_proof`).
    proof: Option<String>,
    /// Older clients/setups: the key check, accepted only while the stored
    /// setup has no `proof_hash` yet (to add one).
    check: Option<String>,
}

/// Sets up or changes the encryption password. Once a password exists, only
/// someone who can unlock the current key may replace its wrapped copies,
/// and the key itself can't change (that would make every block unreadable).
pub async fn put_encryption(State(s): Shared, Json(body): Json<EncryptionBody>) -> ApiResult {
    use crate::crypto::{iterations_accepted, proof_hash, same_secret};
    let e = &body.encryption;
    if e.version != 1 || !iterations_accepted(e.iterations, e.rk_iterations) {
        return Err(bad("unsupported encryption settings"));
    }
    update_config(&s, move |cfg| {
        if let Some(existing) = &cfg.encryption {
            let forbidden = || {
                ApiError::new(StatusCode::FORBIDDEN, "forbidden", "unlock with the current password first")
            };
            if body.encryption.check != existing.check {
                return Err(forbidden());
            }
            if let Some(stored) = &existing.proof_hash {
                let given = body.proof.as_deref().map(proof_hash).unwrap_or_default();
                if !same_secret(&given, stored) || body.encryption.proof_hash.as_ref() != Some(stored) {
                    return Err(forbidden());
                }
            } else {
                // Setups from before proof_hash: `check` is public (GET returns
                // it), so it may only attach a proof. The wraps stay as they
                // are; changing them needs the proof, once one is stored.
                if !same_secret(body.check.as_deref().unwrap_or_default(), &existing.check) {
                    return Err(forbidden());
                }
                if body.encryption.proof_hash.is_none()
                    || body.encryption.salt != existing.salt
                    || body.encryption.iterations != existing.iterations
                    || body.encryption.pw_iv != existing.pw_iv
                    || body.encryption.pw_data != existing.pw_data
                    || body.encryption.rk_salt != existing.rk_salt
                    || body.encryption.rk_iterations != existing.rk_iterations
                    || body.encryption.rk_iv != existing.rk_iv
                    || body.encryption.rk_data != existing.rk_data
                {
                    return Err(forbidden());
                }
            }
        } else if body.encryption.proof_hash.is_none() {
            return Err(bad("a new password needs a key proof (reload Blockseq and try again)"));
        }
        cfg.encryption = Some(body.encryption);
        Ok(())
    })
    .await?;
    s.notify_all(&json!({ "type": "encryption" }));
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Saves the shared settings (task statuses) and recomputes which blocks are
/// tasks in every open workbook.
pub async fn put_config(State(s): Shared, Json(body): Json<StatusesBody>) -> ApiResult {
    // Change only the statuses; keep everything else in the file as it is.
    let words = update_config(&s, move |cfg| {
        cfg.statuses = body.statuses;
        cfg.validate()?;
        Ok(cfg.task_words())
    })
    .await?;
    // The file is already durable. A failure while rebuilding the task index
    // must not look like the save failed, or other tabs never hear about it.
    let state = s.clone();
    let recompute = tokio::task::spawn_blocking(move || {
        for wb in state.workbooks.open_workbooks() {
            if let Err(e) = db::refresh_task_refs(&wb.db.lock(), &words) {
                tracing::error!("task statuses were saved, but {} could not be updated: {e:#}", wb.id);
            }
        }
    })
    .await;
    s.notify_all(&json!({ "type": "config" }));
    if let Err(e) = recompute {
        tracing::error!("task statuses were saved; recomputing tasks failed: {e}");
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}
