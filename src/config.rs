//! Server-wide settings shared by every device and workbook, stored in
//! `BLOCKSEQ_DATA/config.json`. Per-device preferences stay in the browser.

use std::path::Path;

use anyhow::{Result, bail};
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Config {
    pub statuses: Vec<Status>,
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
    pub fn load(path: &Path) -> Config {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                tracing::warn!("ignoring {}: {e}", path.display());
                Config::default()
            }),
            Err(_) => Config::default(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
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
