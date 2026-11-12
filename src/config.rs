//! Server-wide settings shared by every device and workbook, stored in
//! `BLOCKSEQ_DATA/config.json`. Per-device preferences stay in the browser.

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// A task status, written at the start of a block ("TODO Buy milk").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Status {
    /// The word in the text: uppercase letters, digits and dashes.
    pub word: String,
    /// What the badge shows.
    pub label: String,
    /// Badge colour name (gray, blue, amber, purple, green, red, teal, pink).
    pub color: String,
    /// Finished (done or cancelled): struck out and hidden from open tasks.
    #[serde(default)]
    pub done: bool,
}

/// The key for #Encrypted blocks. The real key is random and never stored;
/// only copies of it encrypted ("wrapped") with your password and with your
/// recovery key are kept. All binary values are standard base64.
/// See crypto.rs (server) and web/js/crypto.js (browser): both must agree.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Encryption {
    pub version: u32,
    /// PBKDF2-SHA256 salt and rounds for the password.
    pub salt: String,
    pub iterations: u32,
    /// The key, AES-256-GCM encrypted with the password-derived key.
    pub pw_iv: String,
    pub pw_data: String,
    /// The same key, encrypted with the recovery-key-derived key.
    pub rk_salt: String,
    pub rk_iterations: u32,
    pub rk_iv: String,
    pub rk_data: String,
    /// SHA-256 of the key (with a prefix). Public: identifies the key (e.g.
    /// "is this backup's key the same as ours?").
    pub check: String,
    /// SHA-256 of the key's *proof* (see crypto.rs `key_proof`). Changing the
    /// password requires sending the proof itself, which only someone who
    /// can unlock the key can compute. Missing in setups made before it
    /// existed; the browser adds it on the next unlock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Config {
    pub statuses: Vec<Status>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption: Option<Encryption>,
    /// Display name of the Main workbook (its folder is the data folder
    /// itself, so it is renamed by name only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_name: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        let s = |word: &str, label: &str, color: &str, done| Status {
            word: word.into(),
            label: label.into(),
            color: color.into(),
            done,
        };
        Config {
            encryption: None,
            main_name: None,
            statuses: vec![
                s("BACKLOG", "Backlog", "gray", false),
                s("TODO", "Todo", "blue", false),
                s("DOING", "Doing", "amber", false),
                s("IN-REVIEW", "In Review", "purple", false),
                s("DONE", "Done", "green", true),
                s("CANCELED", "Cancelled", "red", true),
            ],
        }
    }
}

impl Config {
    /// Reads config.json. A missing file means a new install (defaults). A
    /// file that can't be read or parsed is an error and is never quietly
    /// replaced: it holds the wrapped key for #Encrypted blocks. If the file
    /// is damaged or missing but `config.json.bak` (the previous good
    /// version) is fine, that is used instead.
    pub fn load(path: &Path) -> Result<Config> {
        let bak = backup_path(path);
        match read(path) {
            Ok(Some(cfg)) => Ok(cfg),
            Ok(None) => match read(&bak) {
                Ok(Some(cfg)) => {
                    tracing::warn!("{} is missing; using {}", path.display(), bak.display());
                    Ok(cfg)
                }
                Ok(None) => Ok(Config::default()),
                Err(e) => Err(e),
            },
            Err(e) => match read(&bak) {
                Ok(Some(cfg)) => {
                    tracing::error!("{e:#}; using the previous version in {}", bak.display());
                    Ok(cfg)
                }
                _ => Err(e.context(format!(
                    "{} is damaged and there is no usable {}. Restore it from a backup; it holds the key for #Encrypted blocks",
                    path.display(),
                    bak.display()
                ))),
            },
        }
    }

    /// Writes config.json without ever leaving a half-written file: the
    /// current good version is kept as config.json.bak, and the new one is
    /// written to a temporary file, flushed to disk and renamed into place.
    pub fn save(&self, path: &Path) -> Result<()> {
        let text = serde_json::to_string_pretty(self)?;
        if matches!(read(path), Ok(Some(_))) {
            write_durable(&backup_path(path), &std::fs::read(path)?)?;
        }
        write_durable(path, text.as_bytes())
    }

    pub fn validate(&self) -> Result<()> {
        if self.statuses.is_empty() || self.statuses.len() > 20 {
            bail!("between 1 and 20 statuses are needed");
        }
        let mut seen = std::collections::HashSet::new();
        for s in &self.statuses {
            let ok = !s.word.is_empty()
                && s.word.len() <= 24
                && s.word.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-')
                && s.word.chars().next().is_some_and(|c| c.is_ascii_uppercase());
            if !ok {
                bail!("status word {:?} must be UPPERCASE letters, digits or dashes", s.word);
            }
            if !seen.insert(&s.word) {
                bail!("status word {} is listed twice", s.word);
            }
            if s.label.trim().is_empty() || s.label.len() > 40 {
                bail!("status {} needs a short label", s.word);
            }
        }
        Ok(())
    }

    pub fn task_words(&self) -> Vec<String> {
        self.statuses.iter().map(|s| s.word.clone()).collect()
    }
}

/// `config.json.bak` next to `config.json`.
pub fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(std::ffi::OsStr::to_os_string).unwrap_or_default();
    name.push(".bak");
    path.with_file_name(name)
}

/// None if the file doesn't exist; an error if it can't be read or parsed.
fn read(path: &Path) -> Result<Option<Config>> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .with_context(|| format!("{} can't be read as settings", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// Writes a file so a crash or power cut leaves either the old or the new
/// contents, never a mix: unique temp file, fsync, rename, fsync the folder.
pub fn write_durable(path: &Path, bytes: &[u8]) -> Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let written = (|| -> Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.with_context(|| format!("writing {}", path.display()))?;
    if let Some(dir) = path.parent()
        && let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all(); // best effort: makes the rename itself durable
        }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bq-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_is_defaults() {
        let dir = temp_dir();
        assert_eq!(Config::load(&dir.join("config.json")).unwrap(), Config::default());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn damaged_file_is_an_error_not_defaults() {
        let dir = temp_dir();
        let path = dir.join("config.json");
        std::fs::write(&path, "{\"statuses\": [").unwrap();
        assert!(Config::load(&path).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn previous_version_is_kept_and_used() {
        let dir = temp_dir();
        let path = dir.join("config.json");
        let first = Config { main_name: Some("First".into()), ..Config::default() };
        first.save(&path).unwrap();
        let mut second = first.clone();
        second.main_name = Some("Second".into());
        second.save(&path).unwrap();
        assert_eq!(Config::load(&backup_path(&path)).unwrap().main_name.as_deref(), Some("First"));
        // A damaged config.json falls back to the previous good version.
        std::fs::write(&path, "garbage").unwrap();
        assert_eq!(Config::load(&path).unwrap().main_name.as_deref(), Some("First"));
        // And saving never backs up a damaged file over the good backup.
        let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
        assert!(leftovers.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
