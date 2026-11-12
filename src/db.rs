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
    words       INTEGER NOT NULL DEFAULT 0
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
CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
    block_id UNINDEXED,
    content,
    tokenize = 'unicode61 remove_diacritics 2'
);
"#;

/// Current schema version, stored in `PRAGMA user_version`.
pub const SCHEMA_VERSION: i64 = 6;

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
    if version < 4 {
        migrate_v4(conn)?;
    }
    if version < 5 {
        migrate_v5(conn)?;
    }
    if version < 6 {
        migrate_v6(conn)?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
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
const DAMAGED_BLOCK_COUNT: i64 = -2;

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

    tx.execute("DELETE FROM blocks WHERE page_id = ?1", [&page.id])?;
    // Drop search rows for the blocks this save replaces, including ones that
    // moved here from another page (their id is reused).
    {
        let mut del_fts = tx.prepare("DELETE FROM blocks_fts WHERE block_id = ?1")?;
        for id in old.keys() {
            del_fts.execute([id])?;
        }
        for b in blocks {
            del_fts.execute([&b.id])?;
        }
    }
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
            insert.execute(params![
                b.id, page.id, b.parent_id, pos, b.content, b.collapsed, created, updated
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
            insert_fts.execute(params![b.id, b.content])?;
        }
    }

    // Linking or tagging a page creates it, like Logseq.
    for name in linked.values() {
        ensure_page(tx, name, now)?;
    }

    let version = page.version + 1;
    let words: i64 = blocks.iter().map(|b| word_count(&b.content)).sum();
    tx.execute(
        "UPDATE pages SET version = ?1, updated_at = ?2, words = ?3 WHERE id = ?4",
        params![version, now, words, page.id],
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
        conn.execute(
            "DELETE FROM blocks_fts WHERE block_id IN (SELECT id FROM blocks WHERE page_id = ?1)",
            [&p.id],
        )?;
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

fn maybe_snapshot(conn: &Connection, page: &PageMeta, old: &[Block], new: &[Block], forced: Option<&str>, now: i64) -> Result<()> {
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

fn trim_history(conn: &Connection, page_id: &str) -> Result<()> {
    trim_history_to(conn, page_id, HISTORY_KEEP, HISTORY_BYTES)
}

fn trim_history_to(conn: &Connection, page_id: &str, keep_rows: i64, keep_bytes: i64) -> Result<()> {
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
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, p.journal_day, p.created_at, p.updated_at,
                (SELECT COUNT(*) FROM blocks b WHERE b.page_id = p.id), p.favorite, p.words
         FROM pages p ORDER BY p.updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        let id: String = r.get(0)?;
        Ok(PageSummary {
            words: r.get(7)?,
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

/// What the sidebar needs after every save. Cheap (indexes only). Word counts
/// live on the page row, so the all-pages list does not read every block.
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

    // Every word must appear as a token (any order). The index folds case and
    // accents. A prefix matches, so "hel" finds "hello"; a fragment in the
    // middle of a word does not.
    let blocks = match fts_query(q) {
        None => vec![],
        Some(match_q) => {
            let mut stmt = conn.prepare(
                "SELECT b.id, b.content, p.name FROM blocks_fts f
                 JOIN blocks b ON b.id = f.block_id
                 JOIN pages p ON p.id = b.page_id
                 WHERE f.content MATCH ?1
                 ORDER BY b.updated_at DESC LIMIT ?2",
            )?;
            stmt.query_map(params![match_q, limit], |r| {
                Ok(BlockHit { id: r.get(0)?, content: r.get(1)?, page_name: r.get(2)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        }
    };
    Ok(SearchResults { pages, blocks })
}

/// FTS5 query: each word as a quoted prefix, combined with AND.
/// Letters and digits only, so the query cannot change the match syntax.
fn fts_query(q: &str) -> Option<String> {
    let parts: Vec<String> = q
        .split_whitespace()
        .filter_map(|w| {
            let bare: String = w.chars().filter(|c| c.is_alphanumeric()).collect();
            if bare.is_empty() { None } else { Some(format!("\"{bare}\"*")) }
        })
        .collect();
    if parts.is_empty() { None } else { Some(parts.join(" AND ")) }
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
    fn writer_waits_and_syncs_in_full() {
        let dir = std::env::temp_dir().join(format!("bq-sync-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let conn = open(&path).unwrap();
        let sync: i64 = conn.query_row("PRAGMA synchronous", [], |r| r.get(0)).unwrap();
        let busy: i64 = conn.query_row("PRAGMA busy_timeout", [], |r| r.get(0)).unwrap();
        assert_eq!((sync, busy), (2, 5000)); // 2 is FULL
        drop(conn);
        let read = open_read(&path).unwrap();
        let busy: i64 = read.query_row("PRAGMA busy_timeout", [], |r| r.get(0)).unwrap();
        assert_eq!(busy, 5000);
        drop(read);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_uses_the_rename_name_rules_except_journal_dates() {
        let c = mem();
        for name in ["", "  ", "#tag", "see [[x]]", "a]]b", "has\nnewline", "has\u{7f}del"] {
            assert!(save_page(&c, name, 0, &[block("a", None, "x")], &[]).is_err(), "{name:?}");
        }
        assert!(matches!(
            save_page(&c, "Nov 11th, 2026", 0, &[block("j", None, "today")], &[]).unwrap(),
            SaveOutcome::Saved(_)
        ));
        save_page(&c, "Notes", 0, &[block("n", None, "x")], &[]).unwrap();
        assert!(rename_page(&c, "Notes", "Nov 12th, 2026", &[]).is_err());
        assert!(rename_page(&c, "Notes", "#nope", &[]).is_err());
        assert!(rename_page(&c, "Notes", "Fine name", &[]).is_ok());
    }

    #[test]
    fn words_are_counted() {
        assert_eq!(word_count("Hello there, world! - 42"), 4);
        assert_eq!(word_count("Title #tag\nencrypted:: v1:abc:def\nid:: 123"), 2);
        assert_eq!(word_count("```bash\nsudo pacman -S wayvnc\n```"), 5);
    }

    #[test]
    fn pages_rename_and_merge() {
        let c = mem();
        save_page(&c, "Notes", 0, &[block("a", None, "Server #emby and [[Emby]]")], &[]).unwrap();
        // "Emby" exists (version 0) because Notes links to it.
        assert!(matches!(save_page(&c, "Emby", 0, &[block("e", None, "About emby")], &[]).unwrap(), SaveOutcome::Saved(_)));
        let out = rename_page(&c, "emby", "Emby Server", &[]).unwrap();
        assert!(!out.merged);
        assert_eq!(out.page.name, "Emby Server");
        let notes = get_page(&c, "Notes").unwrap().unwrap();
        assert_eq!(get_blocks(&c, &notes.id).unwrap()[0].content, "Server #[[Emby Server]] and [[Emby Server]]");
        assert!(get_page(&c, "Emby").unwrap().is_none());
        assert_eq!(backlinks(&c, "Emby Server").unwrap().len(), 1);
        // Merge into an existing page.
        save_page(&c, "Media", 0, &[block("m", None, "Media page")], &[]).unwrap();
        let out = rename_page(&c, "Emby Server", "media", &[]).unwrap();
        assert!(out.merged);
        let media = get_page(&c, "Media").unwrap().unwrap();
        let contents: Vec<String> = get_blocks(&c, &media.id).unwrap().into_iter().map(|b| b.content).collect();
        assert_eq!(contents, ["Media page", "About emby"]);
        assert_eq!(get_blocks(&c, &notes.id).unwrap()[0].content, "Server #Media and [[Media]]");
        assert!(rename_page(&c, "Notes", "Nov 11th, 2026", &[]).is_err());
    }

    #[test]
    fn unlinked_empty_pages_are_pruned() {
        let c = mem();
        save_page(&c, "Notes", 0, &[block("a", None, "Order #US330423987 for [[Kept]]")], &[]).unwrap();
        set_favorite(&c, "Starred", true).unwrap();
        ensure_page(&c, "Nov 11th, 2026", now_ms()).unwrap();
        assert!(get_page(&c, "US330423987").unwrap().is_some());
        assert!(prune_orphans(&c).unwrap().is_empty());
        // The "#" is removed: the tag page is empty and unlinked, so it goes.
        save_page(&c, "Notes", 1, &[block("a", None, "Order US330423987 for [[Kept]]")], &[]).unwrap();
        let gone: Vec<String> = prune_orphans(&c).unwrap().into_iter().map(|p| p.name).collect();
        assert_eq!(gone, ["US330423987"]);
        for kept in ["Kept", "Starred", "Notes", "Nov 11th, 2026"] {
            assert!(get_page(&c, kept).unwrap().is_some(), "{kept}");
        }
    }

    #[test]
    fn save_load_and_conflict() {
        let c = mem();
        let blocks = vec![block("a", None, "hello [[World]]"), block("b", Some("a"), "child")];
        let SaveOutcome::Saved(p) = save_page(&c, "Test", 0, &blocks, &[]).unwrap() else {
            panic!("expected save")
        };
        assert_eq!(p.version, 1);
        assert_eq!(get_blocks(&c, &p.id).unwrap(), blocks);

        // A second device still holding version 0 gets a conflict.
        match save_page(&c, "test", 0, &[block("x", None, "stale")], &[]).unwrap() {
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

        let SaveOutcome::Saved(p) = save_page(&c, "Test", 1, &blocks[..1], &[]).unwrap() else {
            panic!()
        };
        assert_eq!(p.version, 2);
        assert_eq!(get_blocks(&c, &p.id).unwrap().len(), 1);

        let found = search(&c, "WORLD hello", 10).unwrap();
        assert_eq!(found.blocks.len(), 1);
        assert_eq!(search(&c, "tes", 10).unwrap().pages, vec!["Test".to_string()]);

        delete_page(&c, "test").unwrap();
        assert!(get_page(&c, "Test").unwrap().is_none());
        // A tab that still has the old version must not recreate the page.
        assert!(matches!(save_page(&c, "Test", 2, &[block("a", None, "still typing")], &[]).unwrap(), SaveOutcome::Deleted));
        assert!(get_page(&c, "Test").unwrap().is_none());
        // Keep mine (a noted save) is allowed to bring it back.
        assert!(matches!(
            save_page_noting(&c, "Test", 2, &[block("a", None, "still typing")], &[], "replaced by Keep mine").unwrap(),
            SaveOutcome::Saved(_)
        ));
        delete_page(&c, "Test").unwrap();
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
        assert_eq!(history(&c, "P").unwrap()[0].words, 8 * word_count("a line of text"));
    }

    #[test]
    fn an_older_database_file_opens() {
        let dir = std::env::temp_dir().join(format!("bq-open-v5-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("blockseq.db");
        // A v5 file: page_history has no page_id. open() applies SCHEMA before migrating.
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE pages (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, name_lower TEXT NOT NULL UNIQUE,
                journal_day INTEGER, version INTEGER NOT NULL, created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
                words INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE blocks (
                id TEXT PRIMARY KEY, page_id TEXT NOT NULL, parent_id TEXT, position INTEGER NOT NULL,
                content TEXT NOT NULL, collapsed INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
             );
             CREATE TABLE refs (
                block_id TEXT NOT NULL, target_lower TEXT NOT NULL, target_name TEXT NOT NULL,
                tag INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE page_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                page_name TEXT NOT NULL, name_lower TEXT NOT NULL, version INTEGER NOT NULL,
                saved_at INTEGER NOT NULL, reason TEXT NOT NULL, blocks TEXT NOT NULL,
                block_count INTEGER NOT NULL DEFAULT 0, word_count INTEGER NOT NULL DEFAULT 0
             );
             INSERT INTO pages (id, name, name_lower, version, created_at, updated_at)
                VALUES ('live', 'Notes', 'notes', 2, 1, 1);
             INSERT INTO page_history (page_name, name_lower, version, saved_at, reason, blocks, block_count, word_count)
                VALUES ('Notes', 'notes', 1, 1, 'autosave', '[]', 0, 0),
                       ('Old', 'old', 1, 2, 'before deleting', '[]', 0, 0);
             PRAGMA user_version = 5;",
        )
        .unwrap();
        drop(conn);

        let conn = open(&path).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let live: String = conn
            .query_row("SELECT page_id FROM page_history WHERE name_lower = 'notes'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(live, "live");
        let old: String = conn
            .query_row("SELECT page_id FROM page_history WHERE name_lower = 'old'", [], |r| r.get(0))
            .unwrap();
        assert!(!old.is_empty() && old != "live");
        let indexed: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'page_history_id'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(indexed, 1);
        drop(conn);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn older_history_rows_get_counts() {
        let c = mem();
        // A database from before the counts were stored.
        c.execute_batch(
            "CREATE TABLE page_history_old AS
               SELECT id, page_name, name_lower, version, saved_at, reason, blocks FROM page_history;
             DROP TABLE page_history;
             ALTER TABLE page_history_old RENAME TO page_history;
             PRAGMA user_version = 4",
        )
        .unwrap();
        let json = serde_json::to_string(&[block("a", None, "hello there")]).unwrap();
        c.execute(
            "INSERT INTO page_history (id, page_name, name_lower, version, saved_at, reason, blocks)
             VALUES (1, 'P', 'p', 1, 1, 'autosave', ?1)",
            [json],
        )
        .unwrap();
        migrate(&c).unwrap();
        let h = history(&c, "P").unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].blocks, 1);
        assert_eq!(h[0].words, 2);
        assert!(!h[0].damaged);
        let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn a_damaged_history_row_is_flagged() {
        let c = mem();
        save_page(&c, "P", 0, &[block("a", None, "kept")], &[]).unwrap();
        let page = get_page(&c, "P").unwrap().unwrap();
        // Already migrated: a failed parse was stored as zero blocks, and the
        // JSON is still the unreadable text.
        c.execute(
            "INSERT INTO page_history (page_id, page_name, name_lower, version, saved_at, reason, blocks, block_count, word_count)
             VALUES (?1, 'P', 'p', 1, 1, 'autosave', ?2, 0, 0)",
            params![page.id, "{not json"],
        )
        .unwrap();
        c.execute(
            "INSERT INTO page_history (page_id, page_name, name_lower, version, saved_at, reason, blocks, block_count, word_count)
             VALUES (?1, 'P', 'p', 1, 2, 'autosave', '[]', 0, 0)",
            [page.id],
        )
        .unwrap();
        let h = history(&c, "P").unwrap();
        let damaged = h.iter().find(|e| e.reason == "autosave" && e.saved_at == 1).unwrap();
        assert!(damaged.damaged);
        assert_eq!(damaged.blocks, 0);
        assert!(history_version(&c, damaged.id).is_err());
        let empty = h.iter().find(|e| e.saved_at == 2).unwrap();
        assert!(!empty.damaged);
        assert_eq!(empty.blocks, 0);

        // The migration itself must not turn a bad snapshot into a zero count.
        c.execute_batch(
            "CREATE TABLE page_history_old AS
               SELECT id, page_name, name_lower, version, saved_at, reason, blocks FROM page_history;
             DROP TABLE page_history;
             ALTER TABLE page_history_old RENAME TO page_history;
             PRAGMA user_version = 4",
        )
        .unwrap();
        migrate(&c).unwrap();
        let count: i64 = c
            .query_row("SELECT block_count FROM page_history WHERE saved_at = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, DAMAGED_BLOCK_COUNT);
        let again = history(&c, "P").unwrap();
        assert!(again.iter().any(|e| e.saved_at == 1 && e.damaged));
        assert!(again.iter().any(|e| e.saved_at == 2 && !e.damaged));
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
    fn rename_onto_a_deleted_name_keeps_its_own_history() {
        let c = mem();
        save_page(&c, "Old name", 0, &[block("a", None, "original")], &[]).unwrap();
        let old = get_page(&c, "Old name").unwrap().unwrap();
        save_page_noting(&c, "Old name", old.version, &[block("a", None, "original edited")], &[], "replaced by Keep mine").unwrap();
        delete_page(&c, "Old name").unwrap();
        let deleted = deleted_pages(&c).unwrap();
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].page_id, old.id);

        save_page(&c, "Fresh", 0, &[block("b", None, "fresh")], &[]).unwrap();
        let fresh = get_page(&c, "Fresh").unwrap().unwrap();
        save_page_noting(&c, "Fresh", fresh.version, &[block("b", None, "fresh edited")], &[], "replaced by Keep mine").unwrap();
        rename_page(&c, "Fresh", "Old name", &[]).unwrap();

        let live = history(&c, "Old name").unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(history_version(&c, live[0].id).unwrap().unwrap().blocks[0].content, "fresh");
        let still = deleted_pages(&c).unwrap();
        assert_eq!(still.len(), 1);
        assert_eq!(still[0].page_id, old.id);
        let original = history_of(&c, &old.id)
            .unwrap()
            .into_iter()
            .find(|e| history_version(&c, e.id).unwrap().unwrap().blocks[0].content == "original")
            .unwrap();
        // The name is taken by a different page, so the deleted one stays deleted.
        assert!(restore_version(&c, original.id, &[]).is_err());
        assert_eq!(get_page(&c, "Old name").unwrap().unwrap().id, fresh.id);

        rename_page(&c, "Old name", "Moved aside", &[]).unwrap();
        let (page, blocks) = restore_version(&c, original.id, &[]).unwrap().unwrap();
        assert_eq!(page.id, old.id);
        assert_eq!(page.name, "Old name");
        assert_eq!(blocks[0].content, "original");
        assert!(deleted_pages(&c).unwrap().iter().all(|d| d.page_id != old.id));

        // A new page of a deleted name starts with an empty history of its own.
        save_page(&c, "Retired", 0, &[block("r", None, "retired text")], &[]).unwrap();
        let retired = get_page(&c, "Retired").unwrap().unwrap();
        save_page_noting(&c, "Retired", retired.version, &[block("r", None, "retired text 2")], &[], "replaced by Keep mine").unwrap();
        delete_page(&c, "Retired").unwrap();
        save_page(&c, "Retired", 0, &[block("n", None, "brand new")], &[]).unwrap();
        assert!(history(&c, "Retired").unwrap().is_empty());
        assert!(deleted_pages(&c).unwrap().iter().any(|d| d.page_id == retired.id));
    }

    #[test]
    fn page_names_and_pages_have_a_size_limit() {
        let c = mem();
        let ok_name = "n".repeat(MAX_PAGE_NAME_CHARS);
        assert!(matches!(save_page(&c, &ok_name, 0, &[block("a", None, "x")], &[]).unwrap(), SaveOutcome::Saved(_)));
        let too_long = "n".repeat(MAX_PAGE_NAME_CHARS + 1);
        let Err(err) = save_page(&c, &too_long, 0, &[block("b", None, "x")], &[]) else {
            panic!("a too-long name was saved");
        };
        assert!(err.to_string().contains("300"));
        assert!(rename_page(&c, &ok_name, &too_long, &[]).is_err());
        assert!(matches!(save_page(&c, "Nov 11th, 2026", 0, &[block("j", None, "today")], &[]).unwrap(), SaveOutcome::Saved(_)));

        let huge = "x".repeat(MAX_PAGE_BYTES);
        let Err(err) = save_page(&c, "Big", 0, &[block("c", None, &huge)], &[]) else {
            panic!("an oversized page was saved");
        };
        assert!(err.to_string().contains("too large"));
        assert!(get_page(&c, "Big").unwrap().is_none());
        assert!(matches!(save_page(&c, "Ok", 0, &[block("d", None, "hello")], &[]).unwrap(), SaveOutcome::Saved(_)));
    }

    #[test]
    fn history_is_capped_by_bytes_as_well_as_rows() {
        let c = mem();
        let insert = |at: i64, body: &str| {
            c.execute(
                "INSERT INTO page_history (page_id, page_name, name_lower, version, saved_at, reason, blocks, block_count, word_count)
                 VALUES ('p', 'P', 'p', 1, ?1, 'autosave', ?2, 1, 1)",
                params![at, body],
            )
            .unwrap();
        };
        let saved_ats = || -> Vec<i64> {
            let mut stmt = c.prepare("SELECT saved_at FROM page_history WHERE page_id = 'p' ORDER BY saved_at DESC").unwrap();
            stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
        };
        insert(1, &"a".repeat(40));
        insert(2, &"b".repeat(40));
        insert(3, &"c".repeat(40));
        insert(4, &"d".repeat(10));
        // Newest first: 10 + 40 + 40 = 90, and the next 40 would pass it.
        trim_history_to(&c, "p", 100, 90).unwrap();
        assert_eq!(saved_ats(), vec![4, 3, 2]);
        trim_history_to(&c, "p", 2, 10_000).unwrap();
        assert_eq!(saved_ats(), vec![4, 3]);
        // The newest row stays even when it alone is over the budget.
        trim_history_to(&c, "p", 100, 5).unwrap();
        assert_eq!(saved_ats(), vec![4]);
    }

    #[test]
    fn rejects_bad_order() {
        let c = mem();
        let bad = vec![block("b", Some("a"), ""), block("a", None, "")];
        assert!(save_page(&c, "X", 0, &bad, &[]).is_err());
    }

    #[test]
    fn journal_pages_are_detected() {
        let c = mem();
        save_page(&c, "Nov 11th, 2026", 0, &[block("a", None, "x")], &[]).unwrap();
        save_page(&c, "Nov 9th, 2026", 0, &[block("b", None, "y")], &[]).unwrap();
        save_page(&c, "Not a journal", 0, &[block("c", None, "z")], &[]).unwrap();
        let j = journals(&c, None, 10).unwrap();
        assert_eq!(j.len(), 2);
        assert_eq!(j[0].page.journal_day, Some(20261111));
        assert_eq!(journals(&c, Some(20261111), 10).unwrap().len(), 1);
    }
}
