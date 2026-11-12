//! Schema upgrades. `PRAGMA user_version` holds the version; `migrate` runs
//! each missing step once, in order, when a database opens.

use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{Connection, params};

use crate::md;

use super::{Block, Savepoint, SCHEMA_VERSION, word_count};

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names.iter().any(|n| n == column))
}

/// Upgrades databases made by older versions. Each step runs once.
pub(super) fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    if version < 2 {
        migrate_v2(conn)?;
    }
    // v3: the page_history table (created by SCHEMA above; nothing to convert).
    if version < 4 {
        migrate_v4(conn)?;
    }
    if version < 5 {
        migrate_v5(conn)?;
    }
    if version < 6 {
        migrate_v6(conn)?;
    }
    if version < 7 {
        migrate_v7(conn)?;
    }
    if version < 8 {
        migrate_v8(conn)?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
    Ok(())
}

/// v8: each page stores its block count, so All pages does not count every
/// page's blocks on each load.
fn migrate_v8(conn: &Connection) -> Result<()> {
    if !has_column(conn, "pages", "block_count")? {
        conn.execute_batch("ALTER TABLE pages ADD COLUMN block_count INTEGER NOT NULL DEFAULT 0")?;
    }
    conn.execute_batch("UPDATE pages SET block_count = (SELECT COUNT(*) FROM blocks WHERE page_id = pages.id)")?;
    Ok(())
}

/// v7: each block remembers the rowid of its search row, so a save deletes
/// search rows directly instead of scanning the whole index. The index is
/// rebuilt once to fill the new column.
fn migrate_v7(conn: &Connection) -> Result<()> {
    let sp = Savepoint::begin(conn, "migrate_v7")?;
    if !has_column(conn, "blocks", "search_id")? {
        conn.execute_batch("ALTER TABLE blocks ADD COLUMN search_id INTEGER")?;
    }
    conn.execute_batch("DELETE FROM blocks_fts")?;
    let rows: Vec<(String, String)> = conn
        .prepare("SELECT id, content FROM blocks")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut ins = conn.prepare("INSERT INTO blocks_fts(block_id, content) VALUES (?1, ?2)")?;
    let mut set = conn.prepare("UPDATE blocks SET search_id = ?1 WHERE id = ?2")?;
    for (id, content) in &rows {
        ins.execute(params![id, content])?;
        set.execute(params![conn.last_insert_rowid(), id])?;
    }
    drop((ins, set));
    sp.commit()?;
    Ok(())
}

/// v6: history follows the page id. Rows that already share a name cannot be
/// split apart; a live page of that name takes them, and each leftover name
/// gets one id of its own.
fn migrate_v6(conn: &Connection) -> Result<()> {
    if !has_column(conn, "page_history", "page_id")? {
        conn.execute_batch("ALTER TABLE page_history ADD COLUMN page_id TEXT NOT NULL DEFAULT ''")?;
    }
    conn.execute(
        "UPDATE page_history SET page_id = (
            SELECT id FROM pages WHERE pages.name_lower = page_history.name_lower
         )
         WHERE page_id = ''
           AND name_lower IN (SELECT name_lower FROM pages)",
        [],
    )?;
    let names: Vec<String> = conn
        .prepare("SELECT DISTINCT name_lower FROM page_history WHERE page_id = ''")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut set = conn.prepare("UPDATE page_history SET page_id = ?1 WHERE name_lower = ?2 AND page_id = ''")?;
    for name in names {
        set.execute(params![uuid::Uuid::new_v4().to_string(), name])?;
    }
    conn.execute_batch("CREATE INDEX IF NOT EXISTS page_history_id ON page_history(page_id, saved_at)")?;
    Ok(())
}

/// `block_count` for a kept version whose JSON does not parse. Zero would
/// look like a real empty page. The list flags these rows.
pub(super) const DAMAGED_BLOCK_COUNT: i64 = -2;

/// v5: block and word counts on each kept version, so the history list does
/// not parse every snapshot.
fn migrate_v5(conn: &Connection) -> Result<()> {
    if !has_column(conn, "page_history", "block_count")? {
        conn.execute_batch("ALTER TABLE page_history ADD COLUMN block_count INTEGER NOT NULL DEFAULT -1")?;
    }
    if !has_column(conn, "page_history", "word_count")? {
        conn.execute_batch("ALTER TABLE page_history ADD COLUMN word_count INTEGER NOT NULL DEFAULT 0")?;
    }
    // -1 marks rows from before this column existed.
    let rows: Vec<(i64, String)> = conn
        .prepare("SELECT id, blocks FROM page_history WHERE block_count < 0")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut set = conn.prepare("UPDATE page_history SET block_count = ?1, word_count = ?2 WHERE id = ?3")?;
    for (id, json) in rows {
        match serde_json::from_str::<Vec<Block>>(&json) {
            Ok(blocks) => {
                let words: i64 = blocks.iter().map(|b| word_count(&b.content)).sum();
                let n = i64::try_from(blocks.len()).unwrap_or(i64::MAX);
                set.execute(params![n, words, id])?;
            }
            Err(_) => {
                set.execute(params![DAMAGED_BLOCK_COUNT, 0_i64, id])?;
            }
        }
    }
    Ok(())
}

/// v4: a word count on each page, and a full-text index of block text.
fn migrate_v4(conn: &Connection) -> Result<()> {
    if !has_column(conn, "pages", "words")? {
        conn.execute_batch("ALTER TABLE pages ADD COLUMN words INTEGER NOT NULL DEFAULT 0")?;
    }
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
            block_id UNINDEXED,
            content,
            tokenize = 'unicode61 remove_diacritics 2'
        )",
    )?;
    // One pass over the blocks that already exist. Saves after this keep both in step.
    let rows: Vec<(String, String)> = conn
        .prepare("SELECT page_id, content FROM blocks")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut words: HashMap<String, i64> = HashMap::new();
    for (page, content) in &rows {
        *words.entry(page.clone()).or_default() += word_count(content);
    }
    let mut set = conn.prepare("UPDATE pages SET words = ?1 WHERE id = ?2")?;
    for (page, n) in words {
        set.execute(params![n, page])?;
    }
    let already: i64 = conn.query_row("SELECT count(*) FROM blocks_fts", [], |r| r.get(0))?;
    if already == 0 {
        let mut ins = conn.prepare("INSERT INTO blocks_fts(block_id, content) SELECT id, content FROM blocks")?;
        ins.execute([])?;
    }
    Ok(())
}

/// v2: favourite pages, and tags told apart from plain links.
fn migrate_v2(conn: &Connection) -> Result<()> {
    if !has_column(conn, "pages", "favorite")? {
        conn.execute_batch("ALTER TABLE pages ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0")?;
    }
    if !has_column(conn, "refs", "tag")? {
        conn.execute_batch("ALTER TABLE refs ADD COLUMN tag INTEGER NOT NULL DEFAULT 0")?;
    }
    // Work out which existing refs are tags from the block text.
    {
        let mut blocks = conn.prepare("SELECT id, content FROM blocks")?;
        let rows = blocks
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut set = conn.prepare("UPDATE refs SET tag = 1 WHERE block_id = ?1 AND target_lower = ?2")?;
        for (id, content) in rows {
            for lower in md::extract_tags(&content) {
                set.execute(params![id, lower])?;
            }
        }
    }
    Ok(())
}
