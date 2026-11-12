//! Browser sign-in sessions, so a browser can sign out.
//!
//! HTTP basic auth has no logout: a browser keeps resending the password
//! until it is closed. Browsers therefore sign in on `/login` and get a
//! random session cookie instead; scripts and other non-browser clients keep
//! using basic auth.
//!
//! Only a hash of each token is kept, in `sessions.json` (owner-only), so the
//! file cannot be turned back into a cookie. The hash also covers the
//! password: changing `BLOCKSEQ_PASSWORD` signs every browser out. A session
//! ends after `IDLE` without use, on sign-out, or on "sign out everywhere".

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const COOKIE: &str = "blockseq_session";
/// A session not used for this long ends.
pub const IDLE_MS: i64 = 90 * 24 * 3600 * 1000;
/// Sessions kept at most; signing in past this ends the least recently used.
const MAX_SESSIONS: usize = 64;
/// `last_seen` is written to disk at most this often per session.
const TOUCH_EVERY_MS: i64 = 24 * 3600 * 1000;

#[derive(Clone, Serialize, Deserialize)]
struct Session {
    created: i64,
    last_seen: i64,
}

pub struct Sessions {
    file: PathBuf,
    /// Hex hash of (password, token) → session.
    map: Mutex<HashMap<String, Session>>,
}

fn hash(password: &str, token: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"blockseq-session\0");
    h.update(password.as_bytes());
    h.update(b"\0");
    h.update(token.as_bytes());
    h.finalize().iter().fold(String::with_capacity(64), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

/// 244 random bits from two v4 UUIDs (the OS random source), as hex.
fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

impl Sessions {
    /// Loads `sessions.json` from the data folder. A missing or damaged file
    /// means no sessions: every browser signs in again, nothing else is lost.
    pub fn load(data_dir: &Path, now: i64) -> Self {
        let file = data_dir.join("sessions.json");
        let mut map: HashMap<String, Session> = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        map.retain(|_, s| now - s.last_seen < IDLE_MS);
        Sessions { file, map: Mutex::new(map) }
    }

    /// Starts a session and returns its token (the cookie value).
    pub fn create(&self, password: &str, now: i64) -> String {
        let token = new_token();
        let mut map = self.map.lock();
        map.retain(|_, s| now - s.last_seen < IDLE_MS);
        while map.len() >= MAX_SESSIONS {
            let oldest = map.iter().min_by_key(|(_, s)| s.last_seen).map(|(k, _)| k.clone());
            match oldest {
                Some(k) => map.remove(&k),
                None => break,
            };
        }
        map.insert(hash(password, &token), Session { created: now, last_seen: now });
        token
    }

    /// True when the token is a live session. The second value says the
    /// file should be written (its `last_seen` moved on by a day or more).
    pub fn check(&self, password: &str, token: &str, now: i64) -> (bool, bool) {
        let key = hash(password, token);
        let mut map = self.map.lock();
        match map.get_mut(&key) {
            Some(s) if now - s.last_seen < IDLE_MS => {
                let stale = now - s.last_seen >= TOUCH_EVERY_MS;
                s.last_seen = now;
                (true, stale)
            }
            Some(_) => {
                map.remove(&key);
                (false, true)
            }
            None => (false, false),
        }
    }

    pub fn end(&self, password: &str, token: &str) {
        self.map.lock().remove(&hash(password, token));
    }

    pub fn end_all(&self) {
        self.map.lock().clear();
    }

    /// Writes the sessions to disk: temp file (owner-only), fsync, rename.
    pub fn save(&self) -> Result<()> {
        let json = serde_json::to_string(&*self.map.lock())?;
        let tmp = self.file.with_extension("json.tmp");
        {
            use std::io::Write;
            let mut f = std::os::unix::fs::OpenOptionsExt::mode(
                std::fs::OpenOptions::new().write(true).create(true).truncate(true),
                0o600,
            )
            .open(&tmp)
            .with_context(|| format!("writing {}", tmp.display()))?;
            f.write_all(json.as_bytes())?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &self.file).with_context(|| format!("replacing {}", self.file.display()))?;
        Ok(())
    }
}

/// The session token from a Cookie header, if any.
pub fn token_from(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get_all(axum::http::header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v.to_string())
        .filter(|v| !v.is_empty() && v.len() <= 128)
}

/// The Set-Cookie value for a new session, or (with `token` None) one that
/// clears it. `secure` when the browser reached us over HTTPS.
pub fn cookie(token: Option<&str>, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    match token {
        Some(t) => format!("{COOKIE}={t}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{secure}", IDLE_MS / 1000),
        None => format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("bq-sessions-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sessions_survive_a_restart_and_end_on_sign_out() {
        let dir = temp();
        let s = Sessions::load(&dir, 0);
        let t = s.create("pw", 0);
        assert!(s.check("pw", &t, 1).0);
        assert!(!s.check("pw", "nope", 1).0);
        s.save().unwrap();
        let text = std::fs::read_to_string(dir.join("sessions.json")).unwrap();
        assert!(!text.contains(&t), "the file must not hold the token");
        let mode = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(dir.join("sessions.json")).unwrap().permissions());
        assert_eq!(mode & 0o777, 0o600);
        let again = Sessions::load(&dir, 2);
        assert!(again.check("pw", &t, 3).0);
        // A new password signs everyone out.
        assert!(!again.check("new pw", &t, 3).0);
        again.end("pw", &t);
        assert!(!again.check("pw", &t, 4).0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn idle_sessions_end_and_the_count_is_capped() {
        let dir = temp();
        let s = Sessions::load(&dir, 0);
        let t = s.create("pw", 0);
        assert!(!s.check("pw", &t, IDLE_MS + 1).0);
        let first = s.create("pw", 10);
        for i in 0..MAX_SESSIONS {
            s.create("pw", 20 + i64::try_from(i).unwrap());
        }
        assert!(!s.check("pw", &first, 1000).0, "the least recently used one goes");
        s.end_all();
        assert!(s.map.lock().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cookie_parsing() {
        let mut h = axum::http::HeaderMap::new();
        h.insert(axum::http::header::COOKIE, "a=1; blockseq_session=abc; b=2".parse().unwrap());
        assert_eq!(token_from(&h).as_deref(), Some("abc"));
        assert!(cookie(Some("x"), true).contains("HttpOnly; SameSite=Lax"));
        assert!(cookie(Some("x"), true).ends_with("; Secure"));
        assert!(cookie(None, false).contains("Max-Age=0"));
    }
}
