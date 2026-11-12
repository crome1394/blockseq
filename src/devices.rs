//! Paired devices: apps (such as the Android app) that sign in once with the
//! password and then use a token of their own, so the password is never
//! stored on the device.
//!
//! A device sends `Authorization: Bearer <token>`. Only a hash of each token
//! is kept, in `devices.json` (owner-only). The hash covers the password, so
//! changing `BLOCKSEQ_PASSWORD` unpairs every device, as it signs every
//! browser out. A device can be revoked from Settings → Security.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Devices kept at most; pairing past this is refused.
const MAX_DEVICES: usize = 32;
/// `last_seen` is written to disk at most this often per device.
const TOUCH_EVERY_MS: i64 = 3600 * 1000;
const MAX_NAME_CHARS: usize = 64;

#[derive(Clone, Serialize, Deserialize)]
struct Device {
    id: String,
    name: String,
    created: i64,
    last_seen: i64,
}

/// What the device list shows (never the token or its hash).
#[derive(Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub created: i64,
    pub last_seen: i64,
}

pub struct Devices {
    file: PathBuf,
    /// Hex hash of (password, token) → device.
    map: Mutex<HashMap<String, Device>>,
}

fn hash(password: &str, token: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"blockseq-device\0");
    h.update(password.as_bytes());
    h.update(b"\0");
    h.update(token.as_bytes());
    h.finalize().iter().fold(String::with_capacity(64), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

/// 244 random bits from two v4 UUIDs (the OS random source), as hex, with a
/// prefix so a leaked token is recognisable.
fn new_token() -> String {
    format!("bsq_{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// A device name as typed, trimmed to something sensible to show.
fn clean_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).take(MAX_NAME_CHARS).collect();
    let name = name.trim();
    if name.is_empty() { "Device".into() } else { name.to_string() }
}

impl Devices {
    /// Loads `devices.json` from the data folder. A missing or damaged file
    /// means no devices: each one pairs again, nothing else is lost.
    pub fn load(data_dir: &Path) -> Self {
        let file = data_dir.join("devices.json");
        let map = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Devices { file, map: Mutex::new(map) }
    }

    /// Pairs a new device; returns its id and token (shown to the device once).
    pub fn pair(&self, password: &str, name: &str, now: i64) -> Result<(String, String)> {
        let mut map = self.map.lock();
        if map.len() >= MAX_DEVICES {
            anyhow::bail!("too many paired devices; revoke one in Settings → Security first");
        }
        let token = new_token();
        let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        map.insert(hash(password, &token), Device { id: id.clone(), name: clean_name(name), created: now, last_seen: now });
        Ok((id, token))
    }

    /// The device id when the token is a paired device. The second value
    /// says the file should be written (`last_seen` moved on by an hour).
    pub fn check(&self, password: &str, token: &str, now: i64) -> Option<(String, bool)> {
        let mut map = self.map.lock();
        let d = map.get_mut(&hash(password, token))?;
        let stale = now - d.last_seen >= TOUCH_EVERY_MS;
        d.last_seen = now;
        Some((d.id.clone(), stale))
    }

    pub fn list(&self) -> Vec<DeviceInfo> {
        let mut out: Vec<DeviceInfo> = self
            .map
            .lock()
            .values()
            .map(|d| DeviceInfo { id: d.id.clone(), name: d.name.clone(), created: d.created, last_seen: d.last_seen })
            .collect();
        out.sort_by_key(|d| std::cmp::Reverse(d.last_seen));
        out
    }

    /// Unpairs a device; false when no device has that id.
    pub fn revoke(&self, id: &str) -> bool {
        let mut map = self.map.lock();
        let before = map.len();
        map.retain(|_, d| d.id != id);
        map.len() != before
    }

    /// Writes the devices to disk: temp file (owner-only), fsync, rename.
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

/// The token from `Authorization: Bearer <token>`, if any.
pub fn bearer(headers: &axum::http::HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|t| !t.is_empty() && t.len() <= 128)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_pair_check_revoke_and_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("bq-devices-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let d = Devices::load(&dir);
        let (id, token) = d.pair("pw", "  Pixel 9\n", 1).unwrap();
        assert!(token.starts_with("bsq_"));
        assert_eq!(d.check("pw", &token, 2).map(|c| c.0), Some(id.clone()));
        assert!(d.check("pw", "bsq_wrong", 2).is_none());
        assert_eq!(d.list()[0].name, "Pixel 9");
        d.save().unwrap();
        let text = std::fs::read_to_string(dir.join("devices.json")).unwrap();
        assert!(!text.contains(&token));
        let mode = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(dir.join("devices.json")).unwrap().permissions());
        assert_eq!(mode & 0o777, 0o600);
        let again = Devices::load(&dir);
        assert!(again.check("pw", &token, 3).is_some());
        // A new password unpairs every device.
        assert!(again.check("new", &token, 3).is_none());
        assert!(again.revoke(&id));
        assert!(!again.revoke(&id));
        assert!(again.check("pw", &token, 4).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn pairing_is_capped_and_bearer_is_parsed() {
        let dir = std::env::temp_dir();
        let d = Devices { file: dir.join("unused-devices.json"), map: Mutex::new(HashMap::new()) };
        for i in 0..MAX_DEVICES {
            d.pair("pw", &format!("d{i}"), 0).unwrap();
        }
        assert!(d.pair("pw", "one more", 0).is_err());
        let mut h = axum::http::HeaderMap::new();
        h.insert(axum::http::header::AUTHORIZATION, "Bearer bsq_abc".parse().unwrap());
        assert_eq!(bearer(&h), Some("bsq_abc"));
        h.insert(axum::http::header::AUTHORIZATION, "Basic eDp5".parse().unwrap());
        assert_eq!(bearer(&h), None);
    }
}
