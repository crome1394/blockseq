//! SQLite storage. Pages hold an ordered tree of blocks; every save replaces a
//! page's blocks in one transaction and bumps the page version, which is how
//! edits from two devices are detected.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::md;

mod history;
mod migrate;
mod query;

pub use history::*;
pub use query::*;
use migrate::migrate;
#[cfg(test)]
use migrate::DAMAGED_BLOCK_COUNT;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS pages (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    name_lower  TEXT NOT NULL UNIQUE,
    journal_day INTEGER,
    version     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    favorite    INTEGER NOT NULL DEFAULT 0,
    words       INTEGER NOT NULL DEFAULT 0,
    block_count INTEGER NOT NULL DEFAULT 0
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
    updated_at INTEGER NOT NULL,
    search_id  INTEGER  -- rowid of this block's row in blocks_fts
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

-- Earlier versions of pages (see "page history" below). Keyed by page id,
-- which does not change when the page is renamed. A deleted page keeps that
-- id, so a new page that reuses the name does not inherit the history.
CREATE TABLE IF NOT EXISTS page_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id     TEXT NOT NULL,
    page_name   TEXT NOT NULL,
    name_lower  TEXT NOT NULL,
    version     INTEGER NOT NULL,
    saved_at    INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    blocks      TEXT NOT NULL,  -- JSON array of blocks, as stored (ciphertext for #Encrypted)
    block_count INTEGER NOT NULL DEFAULT 0,
    word_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS page_history_page ON page_history(name_lower, saved_at);
-- page_history_id is created in migrate_v6, after an older table gains page_id.
-- Creating it here fails open: the existing table has no such column yet.

-- Block text for search. unicode61 folds case and accents, so a query for
-- "e" matches "É" without scanning every block on each keystroke.
-- block_id cannot be indexed in FTS5, so each block stores the rowid of its
-- search row (blocks.search_id) and rows are deleted by that rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
    block_id UNINDEXED,
    content,
    tokenize = 'unicode61 remove_diacritics 2'
);
"#;

/// Current schema version, stored in `PRAGMA user_version`.
pub const SCHEMA_VERSION: i64 = 8;

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
    let words = content
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            !t.split_once(":: ").is_some_and(|(k, _)| !k.is_empty() && !k.contains(' '))
        })
        .flat_map(str::split_whitespace)
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .count();
    i64::try_from(words).unwrap_or(i64::MAX)
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
    /// The page is gone and the client still holds an older version, so this
    /// save would undo a delete or a rename. Nothing was written.
    Deleted,
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

/// How long a connection waits when another one holds the write lock.
pub const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Every connection to a database file waits out a short lock instead of
/// failing at once. In-memory connections used by tests do not need this.
pub fn set_busy_timeout(conn: &Connection) -> Result<()> {
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(())
}

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    set_busy_timeout(&conn)?;
    // synchronous is per connection, not stored in the file. FULL makes a
    // commit wait until the WAL is on disk, so a power cut cannot drop the
    // last save. NORMAL could. A process crash still rolls an open savepoint
    // back either way. Readers do not set this; they do not commit.
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;",
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

/// A second connection for reads. WAL lets it run beside a save, so a search
/// does not queue behind the writer. `query_only` keeps it from migrating or
/// writing. The writer must already have opened the file (so the WAL index exists).
pub fn open_read(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    set_busy_timeout(&conn)?;
    conn.pragma_update(None, "query_only", true)?;
    Ok(conn)
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

/// A note title. Long enough for a real name, and short enough that one save
/// cannot store a title of unbounded length.
const MAX_PAGE_NAME_CHARS: usize = 300;

/// One page as the JSON that is stored and copied into history. The request
/// body may be 100 MB; a single page is capped well under that.
const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;

/// Shared by save and rename. The name is already trimmed. A journal date is
/// allowed here: a journal is saved under that name. Rename rejects dates,
/// and renaming a journal, on its own.
fn reject_page_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.starts_with('#')
        || name.contains("[[")
        || name.contains("]]")
        || name.chars().any(char::is_control)
    {
        bail!("names can't be empty, start with #, or contain [[ ]] or control characters");
    }
    if name.chars().count() > MAX_PAGE_NAME_CHARS {
        bail!("page names can be at most {MAX_PAGE_NAME_CHARS} characters");
    }
    Ok(())
}

fn reject_page_size(blocks: &[Block]) -> Result<()> {
    // A serialize error is refused as too large. Chaining the JSON error
    // would turn the response into a message-less 500.
    let Ok(bytes) = serde_json::to_vec(blocks) else {
        bail!("this page is too large to save");
    };
    if bytes.len() > MAX_PAGE_BYTES {
        bail!("this page is too large to save");
    }
    Ok(())
}

fn rename_page_inner(conn: &Connection, from: &str, to: &str, task_words: &[String]) -> Result<RenameOutcome> {
    let to = to.trim();
    reject_page_name(to)?;
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
            let SaveOutcome::Saved(saved) =
                save_page_inner(conn, &target.name, target.version, &blocks, task_words, true, Some(&format!("before {} was merged in", old.name)))?
            else {
                bail!("{} changed during the rename", target.name)
            };
            if old.favorite {
                set_favorite(conn, &target.name, true)?;
            }
            conn.execute("DELETE FROM pages WHERE id = ?1", [&old.id])?;
            // The source page's history joins the page it was merged into.
            // Rows that only share a name (a deleted page) stay where they are.
            conn.execute(
                "UPDATE page_history SET page_id = ?1, page_name = ?2, name_lower = ?3 WHERE page_id = ?4",
                params![saved.id, saved.name, saved.name_lower(), old.id],
            )?;
            trim_history(conn, &saved.id)?;
            merged = true;
            changed.push((saved.clone(), blocks));
            saved
        }
        _ => {
            conn.execute(
                "UPDATE pages SET name = ?1, name_lower = ?2, version = version + 1, updated_at = ?3 WHERE id = ?4",
                params![to, to.to_lowercase(), now, old.id],
            )?;
            let page = get_page(conn, to)?.context("the renamed page disappeared")?;
            // Only this page's rows follow the rename.
            conn.execute(
                "UPDATE page_history SET page_name = ?1, name_lower = ?2 WHERE page_id = ?3",
                params![page.name, page.name_lower(), page.id],
            )?;
            page
        }
    };
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

/// Every block with a task status: journals newest first, then other pages
/// by name. The order doesn't depend on when a page last changed, so
/// changing a task's status never moves it in the task list.
pub fn tasks(conn: &Connection) -> Result<Vec<TaskHit>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.content, p.name, p.journal_day FROM refs r
         JOIN blocks b ON b.id = r.block_id
         JOIN pages p ON p.id = b.page_id
         WHERE r.target_lower = ?1 AND (r.tag = 2 OR r.tag = 1)
         GROUP BY b.id
         ORDER BY p.journal_day DESC NULLS LAST, p.name_lower, b.position",
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
        if let Some(p) = &b.parent_id
            && !seen.contains(p.as_str()) {
                bail!("block {} appears before its parent", b.id);
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

/// Like `save_page`, but always keeps the replaced version in the history,
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
    reject_page_name(name)?;
    reject_page_size(blocks)?;
    let sp = Savepoint::begin(conn, "save_page")?;
    let tx = conn;
    let now = now_ms();

    let page = match get_page(tx, name)? {
        Some(p) if p.version != base_version => {
            let current = get_blocks(tx, &p.id)?;
            return Ok(SaveOutcome::Conflict(p, current));
        }
        Some(p) => p,
        // A client that already had a version is looking at a page that was
        // deleted or renamed. Recreating it here would undo that. A new page
        // (base_version 0) and an explicit Keep mine (a history reason) still
        // create the row.
        None if base_version != 0 && history_reason.is_none() => {
            return Ok(SaveOutcome::Deleted);
        }
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

    // Drop search rows for the blocks this save replaces, including ones that
    // move here from another page (their id is reused). Each is found by the
    // rowid its block stores, so the index is never scanned.
    tx.execute(
        "DELETE FROM blocks_fts WHERE rowid IN (SELECT search_id FROM blocks WHERE page_id = ?1)",
        [&page.id],
    )?;
    // Pages that lose a block to this one (a merge) get their counts redone below.
    let mut losing: HashSet<String> = HashSet::new();
    {
        let mut from = tx.prepare("SELECT page_id FROM blocks WHERE id = ?1 AND page_id <> ?2")?;
        let mut del_moved = tx.prepare(
            "DELETE FROM blocks_fts WHERE rowid = (SELECT search_id FROM blocks WHERE id = ?1 AND page_id <> ?2)",
        )?;
        for b in blocks {
            if let Some(other) = from.query_row(params![b.id, page.id], |r| r.get::<_, String>(0)).optional()? {
                losing.insert(other);
                del_moved.execute(params![b.id, page.id])?;
            }
        }
    }
    tx.execute("DELETE FROM blocks WHERE page_id = ?1", [&page.id])?;
    let mut linked: HashMap<String, String> = HashMap::new();
    {
        let mut insert = tx.prepare(
            "INSERT OR REPLACE INTO blocks
               (id, page_id, parent_id, position, content, collapsed, created_at, updated_at, search_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        let mut clear_refs = tx.prepare("DELETE FROM refs WHERE block_id = ?1")?;
        let mut insert_ref = tx.prepare(
            "INSERT INTO refs (block_id, target_lower, target_name, tag) VALUES (?1, ?2, ?3, ?4)",
        )?;
        let mut insert_fts = tx.prepare("INSERT INTO blocks_fts(block_id, content) VALUES (?1, ?2)")?;
        for (pos, b) in blocks.iter().enumerate() {
            let pos = i64::try_from(pos)?;
            let (created, updated) = match old.get(&b.id) {
                Some((content, c, u)) if *content == b.content => (*c, *u),
                Some((_, c, _)) => (*c, now),
                None => (now, now),
            };
            // A block id may have lived on another page before (moved text).
            clear_refs.execute([&b.id])?;
            insert_fts.execute(params![b.id, b.content])?;
            let search_id = tx.last_insert_rowid();
            insert.execute(params![
                b.id, page.id, b.parent_id, pos, b.content, b.collapsed, created, updated, search_id
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
        ensure_page(tx, name, now)?;
    }

    let version = page.version + 1;
    let words: i64 = blocks.iter().map(|b| word_count(&b.content)).sum();
    tx.execute(
        "UPDATE pages SET version = ?1, updated_at = ?2, words = ?3, block_count = ?4 WHERE id = ?5",
        params![version, now, words, i64::try_from(blocks.len())?, page.id],
    )?;
    for other in &losing {
        let left: Vec<String> = tx
            .prepare("SELECT content FROM blocks WHERE page_id = ?1")?
            .query_map([other], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let words: i64 = left.iter().map(|c| word_count(c)).sum();
        tx.execute(
            "UPDATE pages SET words = ?1, block_count = ?2 WHERE id = ?3",
            params![words, i64::try_from(left.len())?, other],
        )?;
    }
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
        conn.execute(
            "DELETE FROM blocks_fts WHERE rowid IN (SELECT search_id FROM blocks WHERE page_id = ?1)",
            [&p.id],
        )?;
        conn.execute("DELETE FROM pages WHERE id = ?1", [&p.id])?;
    }
    sp.commit()?;
    Ok(page)
}

#[cfg(test)]
mod tests;
