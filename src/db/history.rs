//! Page history: earlier versions of each page, kept by policy on save and
//! always before an overwrite, a restore or a deletion.

use std::collections::{HashMap, HashSet};

use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::md;

use super::{Block, get_page, now_ms, PageMeta, save_page_inner, SaveOutcome, Savepoint, word_count};

//
// Before a save replaces a page, the old version is kept when:
// - the newest kept version is more than 10 minutes old (so while you edit,
//   there's a version from at most ~10 minutes back), or
// - the save removes a lot (5+ blocks, or more than 30% and 200+ characters
//   of text), or
// - the caller gives a reason (Keep mine, restore, merge, delete).
// Up to HISTORY_KEEP versions per page, and at most HISTORY_BYTES of their
// stored JSON (oldest dropped first; the newest row is kept even when it
// alone is over that). A version equal to the newest kept one isn't stored
// twice. Rows belong to the page id, so a rename does not pick up history
// left behind by a deleted page of the new name.

const HISTORY_EVERY_MS: i64 = 10 * 60 * 1000;
pub const HISTORY_KEEP: i64 = 100;
/// Stored snapshot JSON kept for one page, in bytes.
const HISTORY_BYTES: i64 = 32 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub version: i64,
    pub saved_at: i64,
    pub reason: String,
    pub blocks: usize,
    pub words: i64,
    /// The stored JSON does not parse. This row is not an empty version.
    pub damaged: bool,
}

#[derive(Debug, Serialize)]
pub struct HistoryVersion {
    pub id: i64,
    pub page_name: String,
    pub version: i64,
    pub saved_at: i64,
    pub reason: String,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Serialize)]
pub struct DeletedPage {
    /// Stable id, so two deleted pages of the same name stay distinct.
    pub page_id: String,
    pub name: String,
    pub deleted_at: i64,
}

fn text_size(blocks: &[Block]) -> usize {
    blocks.iter().map(|b| b.content.len()).sum()
}

pub(super) fn maybe_snapshot(conn: &Connection, page: &PageMeta, old: &[Block], new: &[Block], forced: Option<&str>, now: i64) -> Result<()> {
    if old.iter().all(|b| b.content.trim().is_empty()) {
        return Ok(()); // nothing worth keeping
    }
    let reason = if let Some(r) = forced { r } else {
        let (before, after) = (text_size(old), text_size(new));
        let kept: HashSet<&str> = new.iter().map(|b| b.id.as_str()).collect();
        let removed = old.iter().filter(|b| !kept.contains(b.id.as_str())).count();
        if removed >= 5 || (before > after + 200 && after * 10 < before * 7) {
            "before a large change"
        } else {
            let last: Option<i64> = conn.query_row(
                "SELECT MAX(saved_at) FROM page_history WHERE page_id = ?1",
                [&page.id],
                |r| r.get(0),
            )?;
            match last {
                Some(t) if now - t < HISTORY_EVERY_MS => return Ok(()),
                _ => "autosave",
            }
        }
    };
    snapshot(conn, page, old, reason, now)
}

/// Keeps `blocks` as a version of `page` (unless equal to the newest one).
pub fn snapshot(conn: &Connection, page: &PageMeta, blocks: &[Block], reason: &str, now: i64) -> Result<()> {
    if blocks.iter().all(|b| b.content.trim().is_empty()) {
        return Ok(());
    }
    let json = serde_json::to_string(blocks)?;
    let lower = page.name_lower();
    let newest: Option<String> = conn
        .query_row(
            "SELECT blocks FROM page_history WHERE page_id = ?1 ORDER BY saved_at DESC, id DESC LIMIT 1",
            [&page.id],
            |r| r.get(0),
        )
        .optional()?;
    if newest.as_deref() == Some(json.as_str()) {
        return Ok(());
    }
    let block_count = i64::try_from(blocks.len()).unwrap_or(i64::MAX);
    let words: i64 = blocks.iter().map(|b| word_count(&b.content)).sum();
    conn.execute(
        "INSERT INTO page_history (page_id, page_name, name_lower, version, saved_at, reason, blocks, block_count, word_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![page.id, page.name, lower, page.version, now, reason, json, block_count, words],
    )?;
    trim_history(conn, &page.id)?;
    Ok(())
}

pub(super) fn trim_history(conn: &Connection, page_id: &str) -> Result<()> {
    trim_history_to(conn, page_id, HISTORY_KEEP, HISTORY_BYTES)
}

pub(super) fn trim_history_to(conn: &Connection, page_id: &str, keep_rows: i64, keep_bytes: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM page_history WHERE page_id = ?1 AND id NOT IN
           (SELECT id FROM page_history WHERE page_id = ?1 ORDER BY saved_at DESC, id DESC LIMIT ?2)",
        params![page_id, keep_rows],
    )?;
    let rows: Vec<(i64, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT id, length(CAST(blocks AS BLOB)) FROM page_history
             WHERE page_id = ?1 ORDER BY saved_at DESC, id DESC",
        )?;
        stmt.query_map([page_id], |r| Ok((r.get(0)?, r.get::<_, i64>(1)?.max(0))))?
            .collect::<rusqlite::Result<_>>()?
    };
    let mut total: i64 = 0;
    let mut keep: i64 = 0;
    for (i, &(_, bytes)) in rows.iter().enumerate() {
        // Always keep the newest row. Older ones stop when the byte budget is full.
        if i > 0 && total.saturating_add(bytes) > keep_bytes {
            break;
        }
        total = total.saturating_add(bytes);
        keep += 1;
    }
    if keep < i64::try_from(rows.len()).unwrap_or(i64::MAX) {
        conn.execute(
            "DELETE FROM page_history WHERE page_id = ?1 AND id NOT IN
               (SELECT id FROM page_history WHERE page_id = ?1 ORDER BY saved_at DESC, id DESC LIMIT ?2)",
            params![page_id, keep],
        )?;
    }
    Ok(())
}

fn load_history(conn: &Connection, filter: &str, param: &str) -> Result<Vec<HistoryEntry>> {
    // Healthy rows store a positive block_count, taken when the version was
    // saved, so their JSON stays unread. A non-positive count is either a
    // real empty snapshot or damage (a failed parse used to be stored as 0).
    // Only those rows are parsed, and a failed parse is flagged.
    let mut stmt = conn.prepare(&format!(
        "SELECT id, version, saved_at, reason, block_count, word_count,
                CASE WHEN block_count > 0 THEN NULL ELSE blocks END
         FROM page_history WHERE {filter} ORDER BY saved_at DESC, id DESC"
    ))?;
    let rows = stmt.query_map([param], |r| {
        let count: i64 = r.get(4)?;
        let stored_words: i64 = r.get(5)?;
        let json: Option<String> = r.get(6)?;
        let (blocks, words, damaged) = match json {
            None => (usize::try_from(count).unwrap_or(0), stored_words, false),
            Some(json) => match serde_json::from_str::<Vec<Block>>(&json) {
                Ok(parsed) => {
                    let words = parsed.iter().map(|b| word_count(&b.content)).sum();
                    (parsed.len(), words, false)
                }
                Err(_) => (0, 0, true),
            },
        };
        Ok(HistoryEntry {
            id: r.get(0)?,
            version: r.get(1)?,
            saved_at: r.get(2)?,
            reason: r.get(3)?,
            blocks,
            words,
            damaged,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Kept versions of the live page with this name, newest first. When no live
/// page has the name, these are the versions left by deleted pages of that name.
pub fn history(conn: &Connection, name: &str) -> Result<Vec<HistoryEntry>> {
    if let Some(page) = get_page(conn, name)? {
        return history_of(conn, &page.id);
    }
    load_history(conn, "name_lower = ?1 AND page_id NOT IN (SELECT id FROM pages)", &name.trim().to_lowercase())
}

/// Kept versions of one page id, including a page that has been deleted.
pub fn history_of(conn: &Connection, page_id: &str) -> Result<Vec<HistoryEntry>> {
    load_history(conn, "page_id = ?1", page_id)
}

pub fn history_version(conn: &Connection, id: i64) -> Result<Option<HistoryVersion>> {
    let row = conn
        .query_row(
            "SELECT id, page_name, version, saved_at, reason, blocks FROM page_history WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get::<_, String>(5)?)),
        )
        .optional()?;
    let Some((id, page_name, version, saved_at, reason, json)) = row else { return Ok(None) };
    let blocks = serde_json::from_str(&json).context("a kept version is damaged")?;
    Ok(Some(HistoryVersion { id, page_name, version, saved_at, reason, blocks }))
}

/// Pages that were deleted but have kept versions, most recent first.
pub fn deleted_pages(conn: &Connection) -> Result<Vec<DeletedPage>> {
    let mut stmt = conn.prepare(
        "SELECT page_id, page_name, MAX(saved_at) FROM page_history
         WHERE page_id NOT IN (SELECT id FROM pages)
         GROUP BY page_id ORDER BY MAX(saved_at) DESC LIMIT 500",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(DeletedPage { page_id: r.get(0)?, name: r.get(1)?, deleted_at: r.get(2)? })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Makes a kept version the page's current content (recreating the page if
/// it was deleted). The version it replaces is kept first. Blocks whose ids
/// now belong to another page get new ids, so nothing is taken from there.
pub fn restore_version(conn: &Connection, id: i64, task_words: &[String]) -> Result<Option<(PageMeta, Vec<Block>)>> {
    let Some(h) = history_version(conn, id)? else { return Ok(None) };
    let page_id: String = conn.query_row("SELECT page_id FROM page_history WHERE id = ?1", [id], |r| r.get(0))?;
    if page_id.is_empty() {
        bail!("this version has no page");
    }
    let sp = Savepoint::begin(conn, "restore_version")?;
    let by_name = get_page(conn, &h.page_name)?;
    // A new page that reused the name is a different page. Restoring must
    // not overwrite it. The deleted page comes back once that name is free.
    if by_name.as_ref().is_some_and(|p| p.id != page_id) {
        bail!("another page already has this name");
    }
    if by_name.is_none() {
        let id_taken = conn.prepare("SELECT 1 FROM pages WHERE id = ?1")?.exists([&page_id])?;
        if id_taken {
            bail!("this version belongs to a page that still exists under another name");
        }
        // Recreate the row under the same id so its history stays attached.
        let now = now_ms();
        conn.execute(
            "INSERT INTO pages (id, name, name_lower, journal_day, version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
            params![page_id, h.page_name, h.page_name.to_lowercase(), md::parse_journal_name(&h.page_name), now],
        )?;
    }
    let current = get_page(conn, &h.page_name)?;
    let (base, current_id) = current.as_ref().map_or((0, String::new()), |p| (p.version, p.id.clone()));
    let mut renamed: HashMap<String, String> = HashMap::new();
    {
        let mut elsewhere = conn.prepare("SELECT 1 FROM blocks WHERE id = ?1 AND page_id <> ?2")?;
        for b in &h.blocks {
            if elsewhere.exists(params![b.id, current_id])? {
                renamed.insert(b.id.clone(), uuid::Uuid::new_v4().to_string());
            }
        }
    }
    let blocks: Vec<Block> = h
        .blocks
        .into_iter()
        .map(|mut b| {
            if let Some(n) = renamed.get(&b.id) {
                b.id = n.clone();
            }
            if let Some(n) = b.parent_id.as_ref().and_then(|p| renamed.get(p)) {
                b.parent_id = Some(n.clone());
            }
            b
        })
        .collect();
    let reason = format!("before restoring the version from {}", chrono::DateTime::from_timestamp_millis(h.saved_at)
        .map(|t| t.with_timezone(&chrono::Local).format("%b %-d, %Y %H:%M").to_string())
        .unwrap_or_default());
    match save_page_inner(conn, &h.page_name, base, &blocks, task_words, false, Some(&reason))? {
        SaveOutcome::Saved(page) => {
            sp.commit()?;
            Ok(Some((page, blocks)))
        }
        _ => bail!("the page changed while restoring; try again"),
    }
}
