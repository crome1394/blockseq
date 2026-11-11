//! SQLite storage. Pages hold an ordered tree of blocks; every save replaces a
//! page's blocks in one transaction and bumps the page version, which is how
//! edits from two devices are detected.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::md;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS pages (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    name_lower  TEXT NOT NULL UNIQUE,
    journal_day INTEGER,
    version     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_journal ON pages(journal_day);

CREATE TABLE IF NOT EXISTS blocks (
    id         TEXT PRIMARY KEY,
    page_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    parent_id  TEXT,
    position   INTEGER NOT NULL,
    content    TEXT NOT NULL,
    collapsed  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS blocks_page ON blocks(page_id, position);

-- Which page names each block links to. Targets are lowercase names, so a
-- link can point at a page that does not exist yet.
CREATE TABLE IF NOT EXISTS refs (
    block_id     TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    target_lower TEXT NOT NULL,
    target_name  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refs_target ON refs(target_lower);
CREATE INDEX IF NOT EXISTS refs_block ON refs(block_id);

PRAGMA user_version = 1;
"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Block {
    pub id: String,
    pub parent_id: Option<String>,
    pub content: String,
    #[serde(default)]
    pub collapsed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageMeta {
    pub id: String,
    pub name: String,
    pub journal_day: Option<i64>,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct PageSummary {
    pub name: String,
    pub journal_day: Option<i64>,
    pub updated_at: i64,
    pub block_count: i64,
}

#[derive(Debug, Serialize)]
pub struct JournalPage {
    pub page: PageMeta,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Serialize)]
pub struct BlockHit {
    pub id: String,
    pub content: String,
    pub page_name: String,
}

#[derive(Debug, Serialize)]
pub struct Backlinks {
    pub page_name: String,
    pub blocks: Vec<BlockHit>,
}

#[derive(Debug, Serialize)]
pub struct SearchResults {
    pub pages: Vec<String>,
    pub blocks: Vec<BlockHit>,
}

pub enum SaveOutcome {
    Saved(PageMeta),
    /// The page changed since the client loaded it. Holds the current state.
    Conflict(PageMeta, Vec<Block>),
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;",
    )?;
    conn.execute_batch(SCHEMA)?;
    // Pages that are linked or tagged but have no row yet (older databases).
    let missing: Vec<String> = conn
        .prepare("SELECT MIN(target_name) FROM refs WHERE target_lower NOT IN (SELECT name_lower FROM pages) GROUP BY target_lower")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for name in missing {
        ensure_page(&conn, &name, now_ms())?;
    }
    Ok(conn)
}

/// Creates an empty page row for a linked or tagged name, if none exists.
/// Its version stays 0, so the first real save from a browser still works.
fn ensure_page(conn: &Connection, name: &str, now: i64) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO pages (id, name, name_lower, journal_day, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
        params![
            uuid::Uuid::new_v4().to_string(),
            name,
            name.to_lowercase(),
            md::parse_journal_name(name),
            now
        ],
    )?;
    Ok(())
}

fn page_from_row(r: &rusqlite::Row) -> rusqlite::Result<PageMeta> {
    Ok(PageMeta {
        id: r.get(0)?,
        name: r.get(1)?,
        journal_day: r.get(2)?,
        version: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

const PAGE_COLS: &str = "id, name, journal_day, version, created_at, updated_at";

pub fn get_page(conn: &Connection, name: &str) -> Result<Option<PageMeta>> {
    Ok(conn
        .query_row(
            &format!("SELECT {PAGE_COLS} FROM pages WHERE name_lower = ?1"),
            [name.trim().to_lowercase()],
            page_from_row,
        )
        .optional()?)
}

pub fn get_blocks(conn: &Connection, page_id: &str) -> Result<Vec<Block>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, parent_id, content, collapsed FROM blocks WHERE page_id = ?1 ORDER BY position",
    )?;
    let rows = stmt.query_map([page_id], |r| {
        Ok(Block {
            id: r.get(0)?,
            parent_id: r.get(1)?,
            content: r.get(2)?,
            collapsed: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Blocks must be in document order (pre-order) and every parent must appear
/// before its children.
pub fn validate_blocks(blocks: &[Block]) -> Result<()> {
    let mut seen = HashSet::new();
    for b in blocks {
        if b.id.is_empty() || b.id.len() > 64 {
            bail!("invalid block id");
        }
        if let Some(p) = &b.parent_id {
            if !seen.contains(p.as_str()) {
                bail!("block {} appears before its parent", b.id);
            }
        }
        if !seen.insert(b.id.as_str()) {
            bail!("duplicate block id {}", b.id);
        }
    }
    Ok(())
}

/// Replaces a page's blocks, creating the page if needed.
pub fn save_page(
    conn: &mut Connection,
    name: &str,
    base_version: i64,
    blocks: &[Block],
) -> Result<SaveOutcome> {
    validate_blocks(blocks)?;
    let name = name.trim();
    if name.is_empty() {
        bail!("page name is empty");
    }
    let tx = conn.transaction()?;
    let now = now_ms();

    let page = match get_page(&tx, name)? {
        Some(p) if p.version != base_version => {
            let current = get_blocks(&tx, &p.id)?;
            return Ok(SaveOutcome::Conflict(p, current));
        }
        Some(p) => p,
        // Missing page: either new, or deleted on another device. Either way
        // the user's typing wins and the page is (re)created.
        None => {
            let p = PageMeta {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.to_string(),
                journal_day: md::parse_journal_name(name),
                version: 0,
                created_at: now,
                updated_at: now,
            };
            tx.execute(
                "INSERT INTO pages (id, name, name_lower, journal_day, version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
                params![p.id, p.name, p.name.to_lowercase(), p.journal_day, now],
            )?;
            p
        }
    };

    // Keep timestamps of blocks whose text did not change.
    let mut old: HashMap<String, (String, i64, i64)> = HashMap::new();
    {
        let mut stmt = tx.prepare(
            "SELECT id, content, created_at, updated_at FROM blocks WHERE page_id = ?1",
        )?;
        let rows = stmt.query_map([&page.id], |r| {
            Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?)))
        })?;
        for row in rows {
            let (id, v) = row?;
            old.insert(id, v);
        }
    }

    tx.execute("DELETE FROM blocks WHERE page_id = ?1", [&page.id])?;
    let mut linked: HashMap<String, String> = HashMap::new();
    {
        let mut insert = tx.prepare(
            "INSERT OR REPLACE INTO blocks
               (id, page_id, parent_id, position, content, collapsed, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        let mut clear_refs = tx.prepare("DELETE FROM refs WHERE block_id = ?1")?;
        let mut insert_ref = tx.prepare("INSERT INTO refs (block_id, target_lower, target_name) VALUES (?1, ?2, ?3)")?;
        for (pos, b) in blocks.iter().enumerate() {
            let (created, updated) = match old.get(&b.id) {
                Some((content, c, u)) if *content == b.content => (*c, *u),
                Some((_, c, _)) => (*c, now),
                None => (now, now),
            };
            // A block id may have lived on another page before (moved text).
            clear_refs.execute([&b.id])?;
            insert.execute(params![
                b.id, page.id, b.parent_id, pos as i64, b.content, b.collapsed, created, updated
            ])?;
            for (lower, name) in md::extract_refs(&b.content) {
                insert_ref.execute(params![b.id, lower, name])?;
                linked.entry(lower).or_insert(name);
            }
        }
    }

    // Linking or tagging a page creates it, like Logseq.
    for name in linked.values() {
        ensure_page(&tx, name, now)?;
    }

    let version = page.version + 1;
    tx.execute(
        "UPDATE pages SET version = ?1, updated_at = ?2 WHERE id = ?3",
        params![version, now, page.id],
    )?;
    tx.commit()?;
    Ok(SaveOutcome::Saved(PageMeta {
        version,
        updated_at: now,
        ..page
    }))
}

pub fn delete_page(conn: &Connection, name: &str) -> Result<Option<PageMeta>> {
    let page = get_page(conn, name)?;
    if let Some(p) = &page {
        conn.execute("DELETE FROM pages WHERE id = ?1", [&p.id])?;
    }
    Ok(page)
}

pub fn list_pages(conn: &Connection) -> Result<Vec<PageSummary>> {
    let mut stmt = conn.prepare(
        "SELECT p.name, p.journal_day, p.updated_at,
                (SELECT COUNT(*) FROM blocks b WHERE b.page_id = p.id)
         FROM pages p ORDER BY p.updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PageSummary {
            name: r.get(0)?,
            journal_day: r.get(1)?,
            updated_at: r.get(2)?,
            block_count: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Every page name plus every linked or tagged name, for autocomplete.
pub fn all_names(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT name FROM pages
         UNION ALL
         SELECT MIN(target_name) FROM refs
         WHERE target_lower NOT IN (SELECT name_lower FROM pages)
         GROUP BY target_lower",
    )?;
    let names = stmt
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(names)
}

/// Journal pages before `before` (yyyymmdd, exclusive), newest first.
pub fn journals(conn: &Connection, before: Option<i64>, limit: i64) -> Result<Vec<JournalPage>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PAGE_COLS} FROM pages
         WHERE journal_day IS NOT NULL AND journal_day < ?1
           AND EXISTS (SELECT 1 FROM blocks b WHERE b.page_id = pages.id)
         ORDER BY journal_day DESC LIMIT ?2"
    ))?;
    let pages = stmt
        .query_map(params![before.unwrap_or(i64::MAX), limit], page_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    pages
        .into_iter()
        .map(|page| {
            let blocks = get_blocks(conn, &page.id)?;
            Ok(JournalPage { page, blocks })
        })
        .collect()
}

pub fn backlinks(conn: &Connection, name: &str) -> Result<Vec<Backlinks>> {
    let lower = name.trim().to_lowercase();
    let mut stmt = conn.prepare(
        "SELECT DISTINCT b.id, b.content, p.name, p.journal_day, p.updated_at, b.position
         FROM refs r
         JOIN blocks b ON b.id = r.block_id
         JOIN pages p ON p.id = b.page_id
         WHERE r.target_lower = ?1 AND p.name_lower != ?1
         ORDER BY p.journal_day DESC NULLS LAST, p.updated_at DESC, b.position",
    )?;
    let rows = stmt.query_map([&lower], |r| {
        Ok(BlockHit {
            id: r.get(0)?,
            content: r.get(1)?,
            page_name: r.get(2)?,
        })
    })?;
    let mut out: Vec<Backlinks> = Vec::new();
    for hit in rows {
        let hit = hit?;
        match out.last_mut() {
            Some(g) if g.page_name == hit.page_name => g.blocks.push(hit),
            _ => out.push(Backlinks {
                page_name: hit.page_name.clone(),
                blocks: vec![hit],
            }),
        }
    }
    Ok(out)
}

fn like_pattern(q: &str) -> String {
    let escaped = q
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

pub fn search(conn: &Connection, q: &str, limit: i64) -> Result<SearchResults> {
    let q = q.trim();
    if q.is_empty() {
        return Ok(SearchResults { pages: vec![], blocks: vec![] });
    }
    let pat = like_pattern(&q.to_lowercase());
    let mut stmt = conn.prepare(
        "SELECT name FROM pages WHERE name_lower LIKE ?1 ESCAPE '\\'
         ORDER BY (name_lower = ?2) DESC, length(name), updated_at DESC LIMIT ?3",
    )?;
    let pages = stmt
        .query_map(params![pat, q.to_lowercase(), limit], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;

    // Every word must appear somewhere in the block (any order).
    let words: Vec<String> = q.split_whitespace().map(|w| like_pattern(&w.to_lowercase())).collect();
    let cond = (1..=words.len())
        .map(|i| format!("lower(b.content) LIKE ?{i} ESCAPE '\\'"))
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!(
        "SELECT b.id, b.content, p.name FROM blocks b JOIN pages p ON p.id = b.page_id
         WHERE {cond} ORDER BY b.updated_at DESC LIMIT {limit}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let blocks = stmt
        .query_map(rusqlite::params_from_iter(words.iter()), |r| {
            Ok(BlockHit {
                id: r.get(0)?,
                content: r.get(1)?,
                page_name: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(SearchResults { pages, blocks })
}

pub fn get_block(conn: &Connection, id: &str) -> Result<Option<BlockHit>> {
    Ok(conn
        .query_row(
            "SELECT b.id, b.content, p.name FROM blocks b JOIN pages p ON p.id = b.page_id WHERE b.id = ?1",
            [id],
            |r| {
                Ok(BlockHit {
                    id: r.get(0)?,
                    content: r.get(1)?,
                    page_name: r.get(2)?,
                })
            },
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    fn block(id: &str, parent: Option<&str>, content: &str) -> Block {
        Block {
            id: id.into(),
            parent_id: parent.map(String::from),
            content: content.into(),
            collapsed: false,
        }
    }

    #[test]
    fn save_load_and_conflict() {
        let mut c = mem();
        let blocks = vec![block("a", None, "hello [[World]]"), block("b", Some("a"), "child")];
        let SaveOutcome::Saved(p) = save_page(&mut c, "Test", 0, &blocks).unwrap() else {
            panic!("expected save")
        };
        assert_eq!(p.version, 1);
        assert_eq!(get_blocks(&c, &p.id).unwrap(), blocks);

        // A second device still holding version 0 gets a conflict.
        match save_page(&mut c, "test", 0, &[block("x", None, "stale")]).unwrap() {
            SaveOutcome::Conflict(p, current) => {
                assert_eq!(p.version, 1);
                assert_eq!(current, blocks);
            }
            SaveOutcome::Saved(_) => panic!("expected conflict"),
        }

        assert_eq!(all_names(&c).unwrap(), vec!["Test".to_string(), "World".to_string()]);
        // The linked page now exists, empty, at version 0.
        let world = get_page(&c, "world").unwrap().expect("linked page created");
        assert_eq!((world.name.as_str(), world.version), ("World", 0));
        let bl = backlinks(&c, "world").unwrap();
        assert_eq!(bl.len(), 1);
        assert_eq!(bl[0].page_name, "Test");

        let SaveOutcome::Saved(p) = save_page(&mut c, "Test", 1, &blocks[..1]).unwrap() else {
            panic!()
        };
        assert_eq!(p.version, 2);
        assert_eq!(get_blocks(&c, &p.id).unwrap().len(), 1);

        let found = search(&c, "WORLD hello", 10).unwrap();
        assert_eq!(found.blocks.len(), 1);
        assert_eq!(search(&c, "tes", 10).unwrap().pages, vec!["Test".to_string()]);

        delete_page(&c, "test").unwrap();
        assert!(get_page(&c, "Test").unwrap().is_none());
        assert!(backlinks(&c, "world").unwrap().is_empty());
    }

    #[test]
    fn rejects_bad_order() {
        let mut c = mem();
        let bad = vec![block("b", Some("a"), ""), block("a", None, "")];
        assert!(save_page(&mut c, "X", 0, &bad).is_err());
    }

    #[test]
    fn journal_pages_are_detected() {
        let mut c = mem();
        save_page(&mut c, "Nov 11th, 2026", 0, &[block("a", None, "x")]).unwrap();
        save_page(&mut c, "Nov 9th, 2026", 0, &[block("b", None, "y")]).unwrap();
        save_page(&mut c, "Not a journal", 0, &[block("c", None, "z")]).unwrap();
        let j = journals(&c, None, 10).unwrap();
        assert_eq!(j.len(), 2);
        assert_eq!(j[0].page.journal_day, Some(20261111));
        assert_eq!(journals(&c, Some(20261111), 10).unwrap().len(), 1);
    }
}
