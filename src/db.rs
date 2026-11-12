//! SQLite storage. Pages hold an ordered tree of blocks; every save replaces a
//! page's blocks in one transaction and bumps the page version, which is how
//! edits from two devices are detected.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result, bail};
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
    updated_at  INTEGER NOT NULL,
    favorite    INTEGER NOT NULL DEFAULT 0
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
    target_name  TEXT NOT NULL,
    tag          INTEGER NOT NULL DEFAULT 0  -- 0 [[link]], 1 #tag / tags::, 2 task status (implied #task)
);
CREATE INDEX IF NOT EXISTS refs_target ON refs(target_lower);
CREATE INDEX IF NOT EXISTS refs_block ON refs(block_id);

-- Earlier versions of pages (see "page history" below). Keyed by name, not
-- page id, so the history of a deleted page stays and can bring it back.
CREATE TABLE IF NOT EXISTS page_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    page_name  TEXT NOT NULL,
    name_lower TEXT NOT NULL,
    version    INTEGER NOT NULL,
    saved_at   INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    blocks     TEXT NOT NULL   -- JSON array of blocks, as stored (ciphertext for #Encrypted)
);
CREATE INDEX IF NOT EXISTS page_history_page ON page_history(name_lower, saved_at);
"#;

/// Current schema version, stored in `PRAGMA user_version`.
pub const SCHEMA_VERSION: i64 = 3;

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
    pub favorite: bool,
}

#[derive(Debug, Serialize)]
pub struct PageSummary {
    pub name: String,
    pub journal_day: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub block_count: i64,
    pub favorite: bool,
    /// Tags used in the page's blocks, sorted by name.
    pub tags: Vec<String>,
    /// Words in the page's blocks (property lines and encrypted text left out).
    pub words: i64,
}

/// Counts words in block text: tokens with at least one letter or digit,
/// skipping `key:: value` property lines (ids, colours, encrypted text).
pub fn word_count(content: &str) -> i64 {
    content
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            !t.split_once(":: ").is_some_and(|(k, _)| !k.is_empty() && !k.contains(' '))
        })
        .flat_map(|l| l.split_whitespace())
        .filter(|w| w.chars().any(|c| c.is_alphanumeric()))
        .count() as i64
}

/// Pages with #Encrypted blocks whose children are still stored as plain
/// text (tagged before a password existed, or while locked).
pub fn encryption_pending(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT p.name FROM refs r
         JOIN blocks b ON b.id = r.block_id
         JOIN pages p ON p.id = b.page_id
         WHERE r.target_lower = 'encrypted'
           AND b.content NOT LIKE '%encrypted:: v1:%'
           AND EXISTS (SELECT 1 FROM blocks c WHERE c.parent_id = b.id)",
    )?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Pages with an encrypted block in them (for re-encrypting with a new key).
pub fn sealed_pages(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT p.name FROM blocks b JOIN pages p ON p.id = b.page_id
         WHERE b.content LIKE '%encrypted:: v1:%'",
    )?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
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
    /// Some block ids already belong to other pages (e.g. a pasted copy).
    /// Nothing was saved; the client gives those blocks new ids.
    ForeignIds(Vec<String>),
}

/// SQLite's quick integrity check: "ok", or what is wrong.
pub fn quick_check(conn: &Connection) -> String {
    match conn.query_row("PRAGMA quick_check(5)", [], |r| r.get::<_, String>(0)) {
        Ok(s) => s,
        Err(e) => format!("check failed to run: {e}"),
    }
}

/// Housekeeping before exit: refresh query statistics and fold the WAL file
/// back into the database, so the files on disk are complete on their own.
pub fn tidy(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(())
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
    migrate(&conn)?;
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

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names.iter().any(|n| n == column))
}

/// Upgrades databases made by older versions. Each step runs once.
fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    if version < 2 {
        migrate_v2(conn)?;
    }
    // v3: the page_history table (created by SCHEMA above; nothing to convert).
    conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
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

/// Deletes pages that only existed because something linked or tagged them:
/// no blocks, nothing links to them any more, not a journal, not starred.
/// Runs after saves and when a workbook opens, so removing the "#" from a
/// tag removes the empty tag page too. Returns the deleted pages.
pub fn prune_orphans(conn: &Connection) -> Result<Vec<PageMeta>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {PAGE_COLS} FROM pages p
         WHERE p.journal_day IS NULL AND p.favorite = 0
           AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.page_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM refs r WHERE r.target_lower = p.name_lower)"
    ))?;
    let orphans = stmt.query_map([], page_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    for p in &orphans {
        conn.execute("DELETE FROM pages WHERE id = ?1", [&p.id])?;
    }
    Ok(orphans)
}

pub struct RenameOutcome {
    /// The page under its new name.
    pub page: PageMeta,
    /// The page as it was, so its old Markdown file can be removed.
    pub old: PageMeta,
    /// True when it was merged into an existing page of that name.
    pub merged: bool,
    /// Every page whose blocks were rewritten, with its blocks (for the mirror).
    pub changed: Vec<(PageMeta, Vec<Block>)>,
}

/// Renames a page (or tag) and rewrites every link and tag to it. If another
/// page already has the new name, the two are merged: this page's blocks are
/// added after that page's blocks.
pub fn rename_page(conn: &Connection, from: &str, to: &str, task_words: &[String]) -> Result<RenameOutcome> {
    // All or nothing: a failure part-way leaves every page as it was.
    let sp = Savepoint::begin(conn, "rename_page")?;
    let out = rename_page_inner(conn, from, to, task_words)?;
    sp.commit()?;
    Ok(out)
}

fn rename_page_inner(conn: &Connection, from: &str, to: &str, task_words: &[String]) -> Result<RenameOutcome> {
    let to = to.trim();
    if to.is_empty() || to.contains('\n') || to.contains("[[") || to.contains("]]") || to.starts_with('#') {
        bail!("names can't be empty, start with # or contain [[ ]]");
    }
    if md::parse_journal_name(to).is_some() {
        bail!("that name is a journal date");
    }
    let Some(old) = get_page(conn, from)? else { bail!("no page called {from}") };
    if old.journal_day.is_some() {
        bail!("journals can't be renamed");
    }
    if old.name_lower() == TASK_PAGE {
        bail!("the task page is used by task statuses and can't be renamed");
    }
    let now = now_ms();
    let mut merged = false;
    let mut changed = Vec::new();
    let page = match get_page(conn, to)? {
        Some(target) if target.id != old.id => {
            // Merge: move this page's blocks to the end of the other page.
            let mut blocks = get_blocks(conn, &target.id)?;
            blocks.extend(get_blocks(conn, &old.id)?);
            snapshot(conn, &old, &get_blocks(conn, &old.id)?, &format!("before it was merged into {}", target.name), now)?;
            let saved = match save_page_inner(conn, &target.name, target.version, &blocks, task_words, true, Some(&format!("before {} was merged in", old.name)))? {
                SaveOutcome::Saved(p) => p,
                _ => bail!("{} changed during the rename", target.name),
            };
            if old.favorite {
                set_favorite(conn, &target.name, true)?;
            }
            conn.execute("DELETE FROM pages WHERE id = ?1", [&old.id])?;
            merged = true;
            changed.push((saved.clone(), blocks));
            saved
        }
        _ => {
            conn.execute(
                "UPDATE pages SET name = ?1, name_lower = ?2, version = version + 1, updated_at = ?3 WHERE id = ?4",
                params![to, to.to_lowercase(), now, old.id],
            )?;
            get_page(conn, to)?.context("the renamed page disappeared")?
        }
    };
    // The page's history follows it to the new name.
    conn.execute(
        "UPDATE page_history SET page_name = ?1, name_lower = ?2 WHERE name_lower = ?3",
        params![page.name, page.name_lower(), old.name_lower()],
    )?;
    // Rewrite links and tags everywhere they appear.
    let pages: Vec<String> = conn
        .prepare(
            "SELECT DISTINCT p.name FROM refs r JOIN blocks b ON b.id = r.block_id
             JOIN pages p ON p.id = b.page_id WHERE r.target_lower = ?1",
        )?
        .query_map([old.name_lower()], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for name in pages {
        let Some(p) = get_page(conn, &name)? else { continue };
        let mut blocks = get_blocks(conn, &p.id)?;
        let mut any = false;
        for b in &mut blocks {
            // Links use the surviving page's spelling (matters when merging).
            if let Some(c) = md::rename_refs(&b.content, &old.name, &page.name) {
                b.content = c;
                any = true;
            }
        }
        if any {
            let SaveOutcome::Saved(saved) = save_page(conn, &p.name, p.version, &blocks, task_words)? else {
                bail!("{} couldn't be updated; nothing was renamed", p.name);
            };
            changed.retain(|(c, _)| c.id != saved.id);
            changed.push((saved, blocks));
        }
    }
    let page = get_page(conn, &page.name)?.unwrap_or(page);
    Ok(RenameOutcome { page, old, merged, changed })
}

/// Page that every task links to.
pub const TASK_PAGE: &str = "task";

/// Recomputes the implied "task" links from the current status words (they
/// can change in Settings). Runs when a workbook opens and after a change.
pub fn refresh_task_refs(conn: &Connection, words: &[String]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM refs WHERE tag = 2", [])?;
    let rows: Vec<(String, String)> = tx
        .prepare("SELECT id, content FROM blocks")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut any = false;
    {
        let mut ins = tx.prepare(
            "INSERT INTO refs (block_id, target_lower, target_name, tag)
             SELECT ?1, ?2, ?2, 2 WHERE NOT EXISTS
               (SELECT 1 FROM refs WHERE block_id = ?1 AND target_lower = ?2)",
        )?;
        for (id, content) in rows {
            if md::is_task(&content, words) {
                ins.execute(params![id, TASK_PAGE])?;
                any = true;
            }
        }
    }
    if any {
        ensure_page(&tx, TASK_PAGE, now_ms())?;
    }
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct TaskHit {
    pub id: String,
    pub content: String,
    pub page_name: String,
    pub journal_day: Option<i64>,
}

/// Every block with a task status, newest pages first.
pub fn tasks(conn: &Connection) -> Result<Vec<TaskHit>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.content, p.name, p.journal_day FROM refs r
         JOIN blocks b ON b.id = r.block_id
         JOIN pages p ON p.id = b.page_id
         WHERE r.target_lower = ?1 AND (r.tag = 2 OR r.tag = 1)
         GROUP BY b.id
         ORDER BY p.journal_day DESC NULLS LAST, p.updated_at DESC, b.position",
    )?;
    let rows = stmt.query_map([TASK_PAGE], |r| {
        Ok(TaskHit { id: r.get(0)?, content: r.get(1)?, page_name: r.get(2)?, journal_day: r.get(3)? })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Changes one block's text (used by the task list). Saves the whole page so
/// versions, refs and timestamps stay consistent. Returns the saved page and
/// its blocks, or None if the block doesn't exist.
pub enum UpdateOutcome {
    Missing,
    /// The block's text isn't what the caller expected (changed elsewhere).
    Changed(String),
    Saved(PageMeta, Vec<Block>),
}

/// Changes one block's text. With `expected`, only if the block still has
/// that text, so an old view (e.g. the task list) can't undo newer edits.
pub fn update_block(
    conn: &Connection,
    id: &str,
    content: &str,
    expected: Option<&str>,
    task_words: &[String],
) -> Result<UpdateOutcome> {
    let found: Option<(String, String)> = conn
        .query_row(
            "SELECT p.name, b.content FROM blocks b JOIN pages p ON p.id = b.page_id WHERE b.id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((name, current)) = found else { return Ok(UpdateOutcome::Missing) };
    if expected.is_some_and(|e| e != current) {
        return Ok(UpdateOutcome::Changed(current));
    }
    let page = get_page(conn, &name)?.context("the block's page disappeared")?;
    let mut blocks = get_blocks(conn, &page.id)?;
    for b in &mut blocks {
        if b.id == id {
            b.content = content.to_string();
        }
    }
    match save_page(conn, &name, page.version, &blocks, task_words)? {
        SaveOutcome::Saved(meta) => Ok(UpdateOutcome::Saved(meta, blocks)),
        _ => bail!("page changed while updating"),
    }
}

/// Pages whose blocks mention each asset file name.
pub fn asset_usage(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT p.name, b.content FROM blocks b JOIN pages p ON p.id = b.page_id
         WHERE b.content LIKE '%assets/%'",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Marks or unmarks a page as a favourite, creating the page if needed.
pub fn set_favorite(conn: &Connection, name: &str, on: bool) -> Result<()> {
    ensure_page(conn, name, now_ms())?;
    conn.execute(
        "UPDATE pages SET favorite = ?1 WHERE name_lower = ?2",
        params![on, name.trim().to_lowercase()],
    )?;
    Ok(())
}

/// Creates an empty page row for a linked or tagged name, if none exists.
/// Its version stays 0, so the first real save from a browser still works.
pub fn ensure_page(conn: &Connection, name: &str, now: i64) -> Result<()> {
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

impl PageMeta {
    pub fn name_lower(&self) -> String {
        self.name.to_lowercase()
    }
}

fn page_from_row(r: &rusqlite::Row) -> rusqlite::Result<PageMeta> {
    Ok(PageMeta {
        id: r.get(0)?,
        name: r.get(1)?,
        journal_day: r.get(2)?,
        version: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        favorite: r.get(6)?,
    })
}

const PAGE_COLS: &str = "id, name, journal_day, version, created_at, updated_at, favorite";

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

/// A SAVEPOINT that rolls back unless committed, also on an early return,
/// an error or a panic, so a half-done change can never stay behind (or
/// leave the connection stuck inside an open transaction). Savepoints nest,
/// so a rename can wrap several page saves in one all-or-nothing change.
struct Savepoint<'a> {
    conn: &'a Connection,
    name: &'static str,
    open: bool,
}

impl<'a> Savepoint<'a> {
    fn begin(conn: &'a Connection, name: &'static str) -> Result<Self> {
        conn.execute_batch(&format!("SAVEPOINT {name}"))?;
        Ok(Savepoint { conn, name, open: true })
    }

    fn commit(mut self) -> Result<()> {
        self.conn.execute_batch(&format!("RELEASE {}", self.name))?;
        self.open = false;
        Ok(())
    }
}

impl Drop for Savepoint<'_> {
    fn drop(&mut self) {
        if self.open {
            let _ = self.conn.execute_batch(&format!("ROLLBACK TO {0}; RELEASE {0}", self.name));
        }
    }
}

/// Replaces a page's blocks, creating the page if needed.
pub fn save_page(
    conn: &Connection,
    name: &str,
    base_version: i64,
    blocks: &[Block],
    task_words: &[String],
) -> Result<SaveOutcome> {
    save_page_inner(conn, name, base_version, blocks, task_words, false, None)
}

/// Like save_page, but always keeps the replaced version in the history,
/// with `reason` (e.g. "replaced by Keep mine").
pub fn save_page_noting(
    conn: &Connection,
    name: &str,
    base_version: i64,
    blocks: &[Block],
    task_words: &[String],
    reason: &str,
) -> Result<SaveOutcome> {
    save_page_inner(conn, name, base_version, blocks, task_words, false, Some(reason))
}

/// `allow_moves`: block ids that belong to another page are moved here
/// (used when merging pages). Otherwise such ids are refused, so pasting a
/// copy can never take blocks away from the page they came from.
fn save_page_inner(
    conn: &Connection,
    name: &str,
    base_version: i64,
    blocks: &[Block],
    task_words: &[String],
    allow_moves: bool,
    history_reason: Option<&str>,
) -> Result<SaveOutcome> {
    validate_blocks(blocks)?;
    let name = name.trim();
    if name.is_empty() {
        bail!("page name is empty");
    }
    let sp = Savepoint::begin(conn, "save_page")?;
    let tx = conn;
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
                favorite: false,
            };
            tx.execute(
                "INSERT INTO pages (id, name, name_lower, journal_day, version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
                params![p.id, p.name, p.name.to_lowercase(), p.journal_day, now],
            )?;
            p
        }
    };

    if !allow_moves {
        let mut elsewhere = tx.prepare("SELECT 1 FROM blocks WHERE id = ?1 AND page_id <> ?2")?;
        let mut foreign = Vec::new();
        for b in blocks {
            if elsewhere.exists(params![b.id, page.id])? {
                foreign.push(b.id.clone());
            }
        }
        if !foreign.is_empty() {
            return Ok(SaveOutcome::ForeignIds(foreign)); // rolls back
        }
    }

    // Keep the version being replaced, when the history policy says so.
    let previous = get_blocks(tx, &page.id)?;
    maybe_snapshot(tx, &page, &previous, blocks, history_reason, now)?;

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
        let mut insert_ref = tx.prepare(
            "INSERT INTO refs (block_id, target_lower, target_name, tag) VALUES (?1, ?2, ?3, ?4)",
        )?;
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
            let tags = md::extract_tags(&b.content);
            let refs = md::extract_refs(&b.content);
            // A block with a status is a task: it links to "task" without
            // the text having to say #task.
            if md::is_task(&b.content, task_words) && !refs.contains_key(TASK_PAGE) {
                insert_ref.execute(params![b.id, TASK_PAGE, TASK_PAGE, 2])?;
                linked.entry(TASK_PAGE.to_string()).or_insert(TASK_PAGE.to_string());
            }
            for (lower, name) in refs {
                insert_ref.execute(params![b.id, lower, name, tags.contains(&lower)])?;
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
    sp.commit()?;
    Ok(SaveOutcome::Saved(PageMeta {
        version,
        updated_at: now,
        ..page
    }))
}

/// Deletes a page; its last version stays in the history, so it can be
/// restored from All pages → Recently deleted.
pub fn delete_page(conn: &Connection, name: &str) -> Result<Option<PageMeta>> {
    let sp = Savepoint::begin(conn, "delete_page")?;
    let page = get_page(conn, name)?;
    if let Some(p) = &page {
        snapshot(conn, p, &get_blocks(conn, &p.id)?, "before it was deleted", now_ms())?;
        conn.execute("DELETE FROM pages WHERE id = ?1", [&p.id])?;
    }
    sp.commit()?;
    Ok(page)
}

// ---- page history ------------------------------------------------------------
//
// Before a save replaces a page, the old version is kept when:
// - the newest kept version is more than 10 minutes old (so while you edit,
//   there's a version from at most ~10 minutes back), or
// - the save removes a lot (5+ blocks, or more than 30% and 200+ characters
//   of text), or
// - the caller gives a reason (Keep mine, restore, merge, delete).
// Up to HISTORY_KEEP versions per page; a version equal to the newest kept
// one isn't stored twice.

const HISTORY_EVERY_MS: i64 = 10 * 60 * 1000;
pub const HISTORY_KEEP: i64 = 100;

#[derive(Debug, Serialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub version: i64,
    pub saved_at: i64,
    pub reason: String,
    pub blocks: usize,
    pub words: i64,
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
    pub name: String,
    pub deleted_at: i64,
}

fn text_size(blocks: &[Block]) -> usize {
    blocks.iter().map(|b| b.content.len()).sum()
}

fn maybe_snapshot(conn: &Connection, page: &PageMeta, old: &[Block], new: &[Block], forced: Option<&str>, now: i64) -> Result<()> {
    if old.iter().all(|b| b.content.trim().is_empty()) {
        return Ok(()); // nothing worth keeping
    }
    let reason = match forced {
        Some(r) => r,
        None => {
            let (before, after) = (text_size(old), text_size(new));
            let kept: HashSet<&str> = new.iter().map(|b| b.id.as_str()).collect();
            let removed = old.iter().filter(|b| !kept.contains(b.id.as_str())).count();
            if removed >= 5 || (before > after + 200 && after * 10 < before * 7) {
                "before a large change"
            } else {
                let last: Option<i64> = conn.query_row(
                    "SELECT MAX(saved_at) FROM page_history WHERE name_lower = ?1",
                    [page.name_lower()],
                    |r| r.get(0),
                )?;
                match last {
                    Some(t) if now - t < HISTORY_EVERY_MS => return Ok(()),
                    _ => "autosave",
                }
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
            "SELECT blocks FROM page_history WHERE name_lower = ?1 ORDER BY saved_at DESC, id DESC LIMIT 1",
            [&lower],
            |r| r.get(0),
        )
        .optional()?;
    if newest.as_deref() == Some(json.as_str()) {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO page_history (page_name, name_lower, version, saved_at, reason, blocks) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![page.name, lower, page.version, now, reason, json],
    )?;
    conn.execute(
        "DELETE FROM page_history WHERE name_lower = ?1 AND id NOT IN
           (SELECT id FROM page_history WHERE name_lower = ?1 ORDER BY saved_at DESC, id DESC LIMIT ?2)",
        params![lower, HISTORY_KEEP],
    )?;
    Ok(())
}

/// Kept versions of a page, newest first.
pub fn history(conn: &Connection, name: &str) -> Result<Vec<HistoryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, version, saved_at, reason, blocks FROM page_history WHERE name_lower = ?1 ORDER BY saved_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([name.trim().to_lowercase()], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, version, saved_at, reason, json) = row?;
        let blocks: Vec<Block> = serde_json::from_str(&json).unwrap_or_default();
        let words = blocks.iter().map(|b| word_count(&b.content)).sum();
        out.push(HistoryEntry { id, version, saved_at, reason, blocks: blocks.len(), words });
    }
    Ok(out)
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
        "SELECT page_name, MAX(saved_at) FROM page_history
         WHERE name_lower NOT IN (SELECT name_lower FROM pages)
         GROUP BY name_lower ORDER BY MAX(saved_at) DESC LIMIT 500",
    )?;
    let rows = stmt.query_map([], |r| Ok(DeletedPage { name: r.get(0)?, deleted_at: r.get(1)? }))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Makes a kept version the page's current content (recreating the page if
/// it was deleted). The version it replaces is kept first. Blocks whose ids
/// now belong to another page get new ids, so nothing is taken from there.
pub fn restore_version(conn: &Connection, id: i64, task_words: &[String]) -> Result<Option<(PageMeta, Vec<Block>)>> {
    let Some(h) = history_version(conn, id)? else { return Ok(None) };
    let sp = Savepoint::begin(conn, "restore_version")?;
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

pub fn list_pages(conn: &Connection) -> Result<Vec<PageSummary>> {
    // Tags per page: one row per (page, tag), spelled as first written.
    let mut tags: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT b.page_id, MIN(r.target_name) FROM refs r
             JOIN blocks b ON b.id = r.block_id
             WHERE r.tag = 1
             GROUP BY b.page_id, r.target_lower
             ORDER BY r.target_lower",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (page, tag) = row?;
            tags.entry(page).or_default().push(tag);
        }
    }
    let mut words: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT page_id, content FROM blocks")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (page, content) = row?;
            *words.entry(page).or_default() += word_count(&content);
        }
    }
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, p.journal_day, p.created_at, p.updated_at,
                (SELECT COUNT(*) FROM blocks b WHERE b.page_id = p.id), p.favorite
         FROM pages p ORDER BY p.updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        let id: String = r.get(0)?;
        Ok(PageSummary {
            words: words.get(&id).copied().unwrap_or(0),
            tags: tags.remove(&id).unwrap_or_default(),
            name: r.get(1)?,
            journal_day: r.get(2)?,
            created_at: r.get(3)?,
            updated_at: r.get(4)?,
            block_count: r.get(5)?,
            favorite: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[derive(Debug, Serialize)]
pub struct Sidebar {
    /// yyyymmdd of journal days that have blocks (calendar dots).
    pub journal_days: Vec<i64>,
    /// Starred page names.
    pub favorites: Vec<String>,
    /// When anything in the workbook last changed (ms).
    pub newest: i64,
}

/// What the sidebar needs after every save. Cheap (indexes only), unlike
/// list_pages, which reads every block to count words.
pub fn sidebar(conn: &Connection) -> Result<Sidebar> {
    let journal_days = conn
        .prepare("SELECT journal_day FROM pages p WHERE journal_day IS NOT NULL AND EXISTS (SELECT 1 FROM blocks b WHERE b.page_id = p.id)")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let favorites = conn
        .prepare("SELECT name FROM pages WHERE favorite = 1 ORDER BY name_lower")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let newest = conn.query_row("SELECT COALESCE(MAX(updated_at), 0) FROM pages", [], |r| r.get(0))?;
    Ok(Sidebar { journal_days, favorites, newest })
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
    fn words_are_counted() {
        assert_eq!(word_count("Hello there, world! - 42"), 4);
        assert_eq!(word_count("Title #tag\nencrypted:: v1:abc:def\nid:: 123"), 2);
        assert_eq!(word_count("```bash\nsudo pacman -S wayvnc\n```"), 5);
    }

    #[test]
    fn pages_rename_and_merge() {
        let mut c = mem();
        save_page(&mut c, "Notes", 0, &[block("a", None, "Server #emby and [[Emby]]")], &[]).unwrap();
        // "Emby" exists (version 0) because Notes links to it.
        assert!(matches!(save_page(&mut c, "Emby", 0, &[block("e", None, "About emby")], &[]).unwrap(), SaveOutcome::Saved(_)));
        let out = rename_page(&mut c, "emby", "Emby Server", &[]).unwrap();
        assert!(!out.merged);
        assert_eq!(out.page.name, "Emby Server");
        let notes = get_page(&c, "Notes").unwrap().unwrap();
        assert_eq!(get_blocks(&c, &notes.id).unwrap()[0].content, "Server #[[Emby Server]] and [[Emby Server]]");
        assert!(get_page(&c, "Emby").unwrap().is_none());
        assert_eq!(backlinks(&c, "Emby Server").unwrap().len(), 1);
        // Merge into an existing page.
        save_page(&mut c, "Media", 0, &[block("m", None, "Media page")], &[]).unwrap();
        let out = rename_page(&mut c, "Emby Server", "media", &[]).unwrap();
        assert!(out.merged);
        let media = get_page(&c, "Media").unwrap().unwrap();
        let contents: Vec<String> = get_blocks(&c, &media.id).unwrap().into_iter().map(|b| b.content).collect();
        assert_eq!(contents, ["Media page", "About emby"]);
        assert_eq!(get_blocks(&c, &notes.id).unwrap()[0].content, "Server #Media and [[Media]]");
        assert!(rename_page(&mut c, "Notes", "Nov 11th, 2026", &[]).is_err());
    }

    #[test]
    fn unlinked_empty_pages_are_pruned() {
        let mut c = mem();
        save_page(&mut c, "Notes", 0, &[block("a", None, "Order #US330423987 for [[Kept]]")], &[]).unwrap();
        set_favorite(&c, "Starred", true).unwrap();
        ensure_page(&c, "Nov 11th, 2026", now_ms()).unwrap();
        assert!(get_page(&c, "US330423987").unwrap().is_some());
        assert!(prune_orphans(&c).unwrap().is_empty());
        // The "#" is removed: the tag page is empty and unlinked, so it goes.
        save_page(&mut c, "Notes", 1, &[block("a", None, "Order US330423987 for [[Kept]]")], &[]).unwrap();
        let gone: Vec<String> = prune_orphans(&c).unwrap().into_iter().map(|p| p.name).collect();
        assert_eq!(gone, ["US330423987"]);
        for kept in ["Kept", "Starred", "Notes", "Nov 11th, 2026"] {
            assert!(get_page(&c, kept).unwrap().is_some(), "{kept}");
        }
    }

    #[test]
    fn save_load_and_conflict() {
        let mut c = mem();
        let blocks = vec![block("a", None, "hello [[World]]"), block("b", Some("a"), "child")];
        let SaveOutcome::Saved(p) = save_page(&mut c, "Test", 0, &blocks, &[]).unwrap() else {
            panic!("expected save")
        };
        assert_eq!(p.version, 1);
        assert_eq!(get_blocks(&c, &p.id).unwrap(), blocks);

        // A second device still holding version 0 gets a conflict.
        match save_page(&mut c, "test", 0, &[block("x", None, "stale")], &[]).unwrap() {
            SaveOutcome::Conflict(p, current) => {
                assert_eq!(p.version, 1);
                assert_eq!(current, blocks);
            }
            _ => panic!("expected conflict"),
        }

        assert_eq!(all_names(&c).unwrap(), vec!["Test".to_string(), "World".to_string()]);
        // The linked page now exists, empty, at version 0.
        let world = get_page(&c, "world").unwrap().expect("linked page created");
        assert_eq!((world.name.as_str(), world.version), ("World", 0));
        let bl = backlinks(&c, "world").unwrap();
        assert_eq!(bl.len(), 1);
        assert_eq!(bl[0].page_name, "Test");

        let SaveOutcome::Saved(p) = save_page(&mut c, "Test", 1, &blocks[..1], &[]).unwrap() else {
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
    fn blocks_of_another_page_are_not_taken() {
        let c = mem();
        let a = vec![block("x", None, "parent block"), block("y", Some("x"), "child")];
        save_page(&c, "A", 0, &a, &[]).unwrap();
        // A pasted copy reusing "x" on another page is refused, and nothing
        // of that save is kept (not even the new page).
        match save_page(&c, "B", 0, &[block("x", None, "pasted copy")], &[]).unwrap() {
            SaveOutcome::ForeignIds(ids) => assert_eq!(ids, vec!["x".to_string()]),
            _ => panic!("expected foreign ids"),
        }
        assert!(get_page(&c, "B").unwrap().is_none());
        let page_a = get_page(&c, "A").unwrap().unwrap();
        assert_eq!(get_blocks(&c, &page_a.id).unwrap(), a);
        // With new ids it saves.
        assert!(matches!(save_page(&c, "B", 0, &[block("x2", None, "pasted copy")], &[]).unwrap(), SaveOutcome::Saved(_)));
    }

    #[test]
    fn block_update_checks_the_text_it_expects() {
        let c = mem();
        save_page(&c, "A", 0, &[block("t", None, "TODO buy milk")], &[]).unwrap();
        assert!(matches!(update_block(&c, "t", "DONE buy bread", Some("TODO buy bread"), &[]).unwrap(), UpdateOutcome::Changed(cur) if cur == "TODO buy milk"));
        assert!(matches!(update_block(&c, "t", "DONE buy milk", Some("TODO buy milk"), &[]).unwrap(), UpdateOutcome::Saved(..)));
        assert!(matches!(update_block(&c, "nope", "x", None, &[]).unwrap(), UpdateOutcome::Missing));
    }

    #[test]
    fn a_failed_save_inside_a_rename_rolls_everything_back() {
        let c = mem();
        save_page(&c, "Old", 0, &[block("o", None, "old page")], &[]).unwrap();
        save_page(&c, "Linker", 0, &[block("l", None, "see [[Old]]")], &[]).unwrap();
        // Simulate a failure after the rename started: a trigger rejects the
        // rewrite of Linker.
        c.execute_batch("CREATE TRIGGER no_linker BEFORE INSERT ON blocks WHEN NEW.id = 'l' BEGIN SELECT RAISE(ABORT, 'disk trouble'); END;").unwrap();
        assert!(rename_page(&c, "Old", "New", &[]).is_err());
        assert!(get_page(&c, "Old").unwrap().is_some());
        assert!(get_page(&c, "New").unwrap().is_none());
        let linker = get_page(&c, "Linker").unwrap().unwrap();
        assert_eq!(get_blocks(&c, &linker.id).unwrap()[0].content, "see [[Old]]");
        // The connection is usable afterwards (no transaction left open).
        c.execute_batch("DROP TRIGGER no_linker").unwrap();
        assert!(rename_page(&c, "Old", "New", &[]).is_ok());
    }

    #[test]
    fn history_keeps_older_versions() {
        let c = mem();
        let v = |t: &str| vec![block("a", None, t)];
        let save = |text: &str| {
            let version = get_page(&c, "P").unwrap().map_or(0, |p| p.version);
            assert!(matches!(save_page(&c, "P", version, &v(text), &[]).unwrap(), SaveOutcome::Saved(_)));
        };
        save("one");
        assert!(history(&c, "P").unwrap().is_empty()); // a new page has nothing to keep
        save("two"); // first save over existing text: kept ("one")
        save("three"); // within 10 minutes: not kept
        let h = history(&c, "P").unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(history_version(&c, h[0].id).unwrap().unwrap().blocks[0].content, "one");
        // Ten minutes later the next save keeps a version again.
        c.execute("UPDATE page_history SET saved_at = saved_at - 11 * 60 * 1000", []).unwrap();
        save("four");
        assert_eq!(history(&c, "P").unwrap().len(), 2);

        // A large removal is always kept.
        let many: Vec<Block> = (0..8).map(|i| block(&format!("m{i}"), None, "a line of text")).collect();
        let version = get_page(&c, "P").unwrap().unwrap().version;
        save_page(&c, "P", version, &many, &[]).unwrap();
        let version = get_page(&c, "P").unwrap().unwrap().version;
        save_page(&c, "P", version, &[block("m0", None, "a line of text")], &[]).unwrap();
        assert_eq!(history(&c, "P").unwrap()[0].reason, "before a large change");
        assert_eq!(history(&c, "P").unwrap()[0].blocks, 8);
    }

    #[test]
    fn deleted_pages_can_be_restored() {
        let c = mem();
        save_page(&c, "Gone", 0, &[block("g", None, "important note")], &[]).unwrap();
        save_page(&c, "Other", 0, &[block("o", None, "x")], &[]).unwrap();
        delete_page(&c, "Gone").unwrap();
        assert!(get_page(&c, "Gone").unwrap().is_none());
        let deleted = deleted_pages(&c).unwrap();
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].name, "Gone");
        let id = history(&c, "Gone").unwrap()[0].id;
        // Meanwhile its block id was reused on another page: restoring
        // gives it a new id instead of taking it from there.
        let other = get_page(&c, "Other").unwrap().unwrap();
        save_page(&c, "Other", other.version, &[block("o", None, "x"), block("g", None, "moved here")], &[]).unwrap();
        let (page, blocks) = restore_version(&c, id, &[]).unwrap().unwrap();
        assert_eq!(page.name, "Gone");
        assert_eq!(blocks[0].content, "important note");
        assert_ne!(blocks[0].id, "g");
        let other = get_page(&c, "Other").unwrap().unwrap();
        assert_eq!(get_blocks(&c, &other.id).unwrap().len(), 2);
        assert!(deleted_pages(&c).unwrap().is_empty());
    }

    #[test]
    fn restoring_keeps_the_replaced_version_and_history_follows_renames() {
        let c = mem();
        save_page(&c, "Doc", 0, &[block("d", None, "first draft")], &[]).unwrap();
        save_page_noting(&c, "Doc", 1, &[block("d", None, "second draft")], &[], "replaced by Keep mine").unwrap();
        let h = history(&c, "Doc").unwrap();
        assert_eq!((h.len(), h[0].reason.as_str()), (1, "replaced by Keep mine"));
        let (_, blocks) = restore_version(&c, h[0].id, &[]).unwrap().unwrap();
        assert_eq!(blocks[0].content, "first draft");
        let h = history(&c, "Doc").unwrap();
        assert!(h[0].reason.starts_with("before restoring"));
        assert_eq!(history_version(&c, h[0].id).unwrap().unwrap().blocks[0].content, "second draft");
        rename_page(&c, "Doc", "Renamed doc", &[]).unwrap();
        assert!(history(&c, "Doc").unwrap().is_empty());
        assert_eq!(history(&c, "Renamed doc").unwrap().len(), h.len());
    }

    #[test]
    fn rejects_bad_order() {
        let mut c = mem();
        let bad = vec![block("b", Some("a"), ""), block("a", None, "")];
        assert!(save_page(&mut c, "X", 0, &bad, &[]).is_err());
    }

    #[test]
    fn journal_pages_are_detected() {
        let mut c = mem();
        save_page(&mut c, "Nov 11th, 2026", 0, &[block("a", None, "x")], &[]).unwrap();
        save_page(&mut c, "Nov 9th, 2026", 0, &[block("b", None, "y")], &[]).unwrap();
        save_page(&mut c, "Not a journal", 0, &[block("c", None, "z")], &[]).unwrap();
        let j = journals(&c, None, 10).unwrap();
        assert_eq!(j.len(), 2);
        assert_eq!(j[0].page.journal_day, Some(20261111));
        assert_eq!(journals(&c, Some(20261111), 10).unwrap().len(), 1);
    }
}
