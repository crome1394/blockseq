//! Workbooks: separate collections of pages, each in its own folder with its
//! own database, Markdown mirror and assets.
//!
//! - "main" is the data directory itself (where Blockseq always kept data).
//! - Every other workbook is a folder in `BLOCKSEQ_DATA/workbooks/`.
//! - A Logseq graph folder copied there (pages/, journals/, assets/) is
//!   imported the first time it is opened. Its original Markdown files are
//!   copied to `logseq-original/` first, because the mirror then rewrites them.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use parking_lot::Mutex;

use anyhow::{Context, Result, bail};
use rusqlite::Connection;
use serde::Serialize;

use crate::{backup, db, md};

pub const MAIN: &str = "main";
const DB_FILE: &str = "blockseq.db";

pub struct Workbook {
    pub id: String,
    pub dir: PathBuf,
    pub db: Mutex<Connection>,
    /// Set when the workbook's folder was renamed: requests still holding
    /// this handle keep using the database (same file), but must not write
    /// Markdown under the old folder name.
    pub retired: std::sync::atomic::AtomicBool,
    /// Result of SQLite's quick integrity check when the workbook opened
    /// ("ok" when healthy). Shown by /api/health.
    pub integrity: String,
    /// Disk usage, measured at most every `USAGE_TTL` (see `usage`).
    usage_cache: Mutex<Option<(std::time::Instant, Usage)>>,
}

/// Space a workbook takes on disk, in bytes.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Usage {
    /// blockseq.db with its write-ahead log (includes the page history).
    pub database: u64,
    /// Uploaded files (assets/).
    pub files: u64,
    /// Everything else: the Markdown copies, Logseq folders, settings.
    pub other: u64,
    pub total: u64,
}

const USAGE_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// Total size of the files under `dir`. Symlinked files count (their
/// target's size); symlinked folders inside aren't followed, so a link back
/// up the tree can't loop.
fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map_or(0, |m| m.len()),
            Ok(t) if t.is_symlink() => std::fs::metadata(e.path()).ok().filter(std::fs::Metadata::is_file).map_or(0, |m| m.len()),
            _ => 0,
        })
        .sum()
}

#[derive(Debug, Serialize)]
pub struct WorkbookInfo {
    pub id: String,
    pub name: String,
    /// "blockseq" (ready), "logseq" (will be imported on open) or "empty".
    pub kind: &'static str,
    /// The workbook's folder on the server.
    pub path: String,
}

/// Where deleted workbooks go (inside workbooks/, hidden: never listed).
pub const TRASH: &str = ".trash";

impl Workbook {
    /// How much space the workbook uses. Main's folder holds the other
    /// workbooks (workbooks/), which aren't counted. Cached for a little
    /// while: walking a big assets folder after every save would be waste.
    pub fn usage(&self) -> Usage {
        // (Main's folder is the data folder, which also holds workbooks/.)
        let mut cache = self.usage_cache.lock();
        if let Some((at, u)) = *cache
            && at.elapsed() < USAGE_TTL
        {
            return u;
        }
        let mut u = Usage::default();
        for entry in std::fs::read_dir(&self.dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            // Follows a symlinked top-level folder (e.g. assets/ kept on a NAS).
            let Ok(kind) = std::fs::metadata(&path).map(|m| m.file_type()) else { continue };
            if kind.is_dir() {
                match name.as_str() {
                    "workbooks" if self.id == MAIN => {}
                    "assets" => u.files += dir_size(&path),
                    _ => u.other += dir_size(&path),
                }
            } else if kind.is_file() {
                let size = entry.metadata().map_or(0, |m| m.len());
                if name.starts_with(DB_FILE) { u.database += size } else { u.other += size }
            }
        }
        u.total = u.database + u.files + u.other;
        *cache = Some((std::time::Instant::now(), u));
        u
    }

    /// Measure again next time (after an upload or a deletion).
    pub fn forget_usage(&self) {
        *self.usage_cache.lock() = None;
    }

    fn is_retired(&self) -> bool {
        self.retired.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn assets_dir(&self) -> PathBuf {
        self.dir.join("assets")
    }

    /// Writes the page as a Logseq Markdown file. This is a readable backup;
    /// the database stays the source of truth, so failures are only logged.
    pub fn write_mirror(&self, page: &db::PageMeta, blocks: &[db::Block]) {
        if self.is_retired() {
            return;
        }
        let path = self.dir.join(md::mirror_path(&page.name, page.journal_day));
        // Like Logseq, a page with no text gets no file.
        if blocks.iter().all(|b| b.content.trim().is_empty()) {
            let _ = std::fs::remove_file(&path);
            return;
        }
        if let Err(e) = write_atomic(&path, &md::page_to_markdown(blocks)) {
            tracing::warn!("could not write {}: {e:#}", path.display());
        }
    }

    pub fn remove_mirror(&self, page: &db::PageMeta) {
        if self.is_retired() {
            return;
        }
        let _ = std::fs::remove_file(self.dir.join(md::mirror_path(&page.name, page.journal_day)));
    }

    /// Rewrites every Markdown mirror file from the database.
    pub fn rebuild_mirror(&self) -> Result<usize> {
        let conn = self.db.lock();
        let pages = db::list_pages(&conn)?;
        for summary in &pages {
            if let Some(page) = db::get_page(&conn, &summary.name)? {
                let blocks = db::get_blocks(&conn, &page.id)?;
                self.write_mirror(&page, &blocks);
            }
        }
        Ok(pages.len())
    }
}

fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// A folder as shown in the workbook list (absolute when possible).
fn shown(dir: &Path) -> String {
    std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf()).display().to_string()
}

/// Folder names allowed for workbooks: letters, digits, spaces, `-_.`,
/// not starting with a dot or space, and not "main".
pub fn valid_id(id: &str) -> bool {
    let id_ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
        && !id.starts_with(['.', ' '])
        && !id.ends_with(['.', ' ']);
    id_ok && !id.eq_ignore_ascii_case(MAIN)
}

pub struct Registry {
    root: PathBuf,
    open: Mutex<HashMap<String, std::sync::Arc<Workbook>>>,
    /// One gate per workbook id: opening (maybe importing) a workbook, or
    /// moving its folder, holds only that workbook's gate, so requests for
    /// other workbooks never wait behind a slow import.
    gates: Mutex<HashMap<String, std::sync::Arc<Mutex<()>>>>,
}

impl Registry {
    pub fn new(root: PathBuf) -> Registry {
        Registry { root, open: Mutex::new(HashMap::new()), gates: Mutex::new(HashMap::new()) }
    }

    fn gate(&self, id: &str) -> std::sync::Arc<Mutex<()>> {
        self.gates.lock().entry(id.to_string()).or_default().clone()
    }

    pub fn dir_of(&self, id: &str) -> Option<PathBuf> {
        if id == MAIN {
            Some(self.root.clone())
        } else if valid_id(id) {
            Some(self.root.join("workbooks").join(id))
        } else {
            None
        }
    }

    fn kind(dir: &Path) -> &'static str {
        if dir.join(DB_FILE).exists() {
            "blockseq"
        } else if dir.join("pages").is_dir() || dir.join("journals").is_dir() {
            "logseq"
        } else {
            "empty"
        }
    }

    /// Main first, then every folder in workbooks/, sorted by name.
    pub fn list(&self) -> Vec<WorkbookInfo> {
        let mut out = vec![WorkbookInfo { id: MAIN.into(), name: "Main".into(), kind: "blockseq", path: shown(&self.root) }];
        let mut others: Vec<WorkbookInfo> = std::fs::read_dir(self.root.join("workbooks"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_dir())
            .filter_map(|e| {
                let id = e.file_name().to_str()?.to_string();
                valid_id(&id).then(|| WorkbookInfo { name: id.clone(), kind: Self::kind(&e.path()), path: shown(&e.path()), id })
            })
            .collect();
        others.sort_by_key(|w| w.name.to_lowercase());
        out.extend(others);
        out
    }

    /// Creates an empty workbook folder.
    pub fn create(&self, name: &str) -> Result<WorkbookInfo> {
        let name = name.trim();
        if !valid_id(name) {
            bail!("use letters, digits, spaces, dashes, dots or underscores (not \"main\")");
        }
        let dir = self.root.join("workbooks").join(name);
        if dir.exists() {
            bail!("a workbook called {name} already exists");
        }
        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        Ok(WorkbookInfo { id: name.into(), name: name.into(), kind: "empty", path: shown(&dir) })
    }

    /// Renames a workbook's folder (not Main). An open workbook is closed
    /// first: its database is checkpointed and held while the folder moves,
    /// and it reopens under the new name on next use.
    pub fn rename(&self, from: &str, to: &str) -> Result<WorkbookInfo> {
        let to = to.trim();
        if !valid_id(from) {
            bail!("no workbook called {from}");
        }
        if !valid_id(to) {
            bail!("use letters, digits, spaces, dashes, dots or underscores (not \"main\")");
        }
        let src = self.root.join("workbooks").join(from);
        let dst = self.root.join("workbooks").join(to);
        if !src.is_dir() {
            bail!("no workbook called {from}");
        }
        if from != to && dst.exists() {
            bail!("a workbook called {to} already exists");
        }
        self.move_closed(from, &src, &dst)?;
        Ok(WorkbookInfo { id: to.into(), name: to.into(), kind: Self::kind(&dst), path: shown(&dst) })
    }

    /// Deletes a workbook (not Main) by moving its folder to
    /// workbooks/.trash/<name> <date time>/, so it can still be recovered
    /// by moving it back. Returns where it went.
    pub fn delete(&self, id: &str) -> Result<PathBuf> {
        if !valid_id(id) {
            bail!("the Main workbook can't be deleted");
        }
        let src = self.root.join("workbooks").join(id);
        if !src.is_dir() {
            bail!("no workbook called {id}");
        }
        let trash = self.root.join("workbooks").join(TRASH);
        std::fs::create_dir_all(&trash)?;
        let dst = trash.join(format!("{id} {}", chrono::Local::now().format("%Y-%m-%d %H%M%S")));
        self.move_closed(id, &src, &dst)?;
        Ok(dst)
    }

    /// Moves a workbook's folder, closing the open workbook first: its
    /// database is checkpointed and held while the folder moves, and old
    /// handles are retired. On failure the workbook stays open as it was.
    fn move_closed(&self, id: &str, src: &Path, dst: &Path) -> Result<()> {
        // Not while the workbook is being opened.
        let gate = self.gate(id);
        let _moving = gate.lock();
        let mut open = self.open.lock();
        let wb = open.remove(id);
        let result = {
            let guard = wb.as_ref().map(|w| w.db.lock());
            if let Some(conn) = &guard {
                let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
            }
            let r = std::fs::rename(src, dst).with_context(|| format!("moving {}", src.display()));
            if r.is_ok()
                && let Some(w) = &wb {
                    w.retired.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            r
        };
        if result.is_err()
            && let Some(w) = wb {
                open.insert(id.to_string(), w);
            }
        result
    }

    /// Restores a backup zip (or a zipped Logseq graph) as a new workbook.
    /// It is unpacked into a hidden folder first and only renamed into place
    /// once complete, so a failed import leaves nothing behind.
    pub fn restore(
        &self,
        name: &str,
        zip: &Path,
        server_key: Option<&crate::config::Encryption>,
        max_bytes: u64,
    ) -> Result<(WorkbookInfo, backup::ImportReport, Option<crate::config::Encryption>)> {
        let name = name.trim();
        if !valid_id(name) {
            bail!("use letters, digits, spaces, dashes, dots or underscores (not \"main\")");
        }
        let dir = self.root.join("workbooks").join(name);
        if dir.exists() {
            bail!("a workbook called {name} already exists");
        }
        let tmp = self.root.join("workbooks").join(format!(".import-{}", uuid::Uuid::new_v4()));
        let result = backup::import_zip(zip, &tmp, server_key, max_bytes).and_then(|r| {
            std::fs::rename(&tmp, &dir).with_context(|| format!("creating {}", dir.display()))?;
            Ok(r)
        });
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&tmp);
        }
        let (report, adopt) = result?;
        let info = WorkbookInfo { id: name.into(), name: name.into(), kind: Self::kind(&dir), path: shown(&dir) };
        Ok((info, report, adopt))
    }

    /// Returns an open workbook, opening (and if needed importing) it first.
    /// Blocking: call from `spawn_blocking`.
    pub fn get(&self, id: &str, task_words: &[String]) -> Result<Option<std::sync::Arc<Workbook>>> {
        if let Some(wb) = self.open.lock().get(id) {
            return Ok(Some(wb.clone()));
        }
        // Only this workbook waits while it opens; someone else may have
        // opened it while we waited for the gate.
        let gate = self.gate(id);
        let _opening = gate.lock();
        if let Some(wb) = self.open.lock().get(id) {
            return Ok(Some(wb.clone()));
        }
        let Some(dir) = self.dir_of(id) else { return Ok(None) };
        if !dir.is_dir() {
            return Ok(None);
        }
        let import = Self::kind(&dir) == "logseq";
        let conn = db::open(&dir.join(DB_FILE)).with_context(|| format!("opening workbook {id}"))?;
        let integrity = db::quick_check(&conn);
        if integrity == "ok" {
            tracing::info!("workbook {id}: database check ok");
        } else {
            tracing::error!("workbook {id}: DATABASE CHECK FAILED: {integrity}. Restore blockseq.db from a backup.");
        }
        db::refresh_task_refs(&conn, task_words)?;
        let pruned = db::prune_orphans(&conn)?.len();
        if pruned > 0 {
            tracing::info!("workbook {id}: removed {pruned} empty, unlinked pages");
        }
        let wb = std::sync::Arc::new(Workbook { id: id.to_string(), dir, db: Mutex::new(conn), retired: std::sync::atomic::AtomicBool::default(), integrity, usage_cache: Mutex::new(None) });
        if import {
            let report = import_logseq(&wb, task_words)?;
            tracing::info!("workbook {id}: imported Logseq graph ({report})");
        }
        let count = wb.rebuild_mirror()?;
        tracing::info!("workbook {id}: {count} pages in {}", wb.dir.display());
        self.open.lock().insert(id.to_string(), wb.clone());
        Ok(Some(wb))
    }

    /// Workbooks that are currently open (for settings changes).
    pub fn open_workbooks(&self) -> Vec<std::sync::Arc<Workbook>> {
        self.open.lock().values().cloned().collect()
    }
}

/// Our own temp files always have lowercase extensions.
fn has_ext(name: &str, ext: &str) -> bool {
    Path::new(name).extension().is_some_and(|e| e == ext)
}

/// Removes temporary files left by an upload, export, import or settings
/// save that was cut short (crash, power cut, restart). Only called at
/// startup, when nothing can still be using them. Returns how many.
pub fn clean_temp(root: &Path) -> usize {
    let mut removed = 0;
    let mut remove = |path: &Path| {
        let ok = if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
        match ok {
            Ok(()) => removed += 1,
            Err(e) => tracing::warn!("could not remove {}: {e}", path.display()),
        }
    };
    let entries = |dir: &Path| -> Vec<(PathBuf, String)> {
        std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| (e.path(), e.file_name().to_string_lossy().into_owned()))
            .collect()
    };
    // Data folder: exports in progress, settings temp files.
    for (path, name) in entries(root) {
        if name.starts_with(".export-") || (name.starts_with(".config.json.") && has_ext(&name, "tmp")) || name == "config.json.tmp" {
            remove(&path);
        }
    }
    // workbooks/: uploaded backups and half-unpacked imports.
    for (path, name) in entries(&root.join("workbooks")) {
        if name.starts_with(".upload-") || name.starts_with(".import-") {
            remove(&path);
        }
    }
    // Every workbook: partial uploads and Markdown temp files.
    let mut dirs = vec![root.to_path_buf()];
    dirs.extend(entries(&root.join("workbooks")).into_iter().filter(|(p, n)| p.is_dir() && !n.starts_with('.')).map(|(p, _)| p));
    for dir in dirs {
        for (path, name) in entries(&dir.join("assets")) {
            if name.starts_with(".upload-") && has_ext(&name, "part") {
                remove(&path);
            }
        }
        for folder in ["pages", "journals"] {
            for (path, name) in entries(&dir.join(folder)) {
                if has_ext(&name, "tmp") && name.ends_with(".md.tmp") {
                    remove(&path);
                }
            }
        }
        for (path, name) in entries(&dir) {
            if name.starts_with(&format!(".{}.", crate::backup::IMPORTED_KEY)) && has_ext(&name, "tmp") {
                remove(&path);
            }
        }
    }
    removed
}

/// Copies a folder's files (not subfolders) into `to`.
fn copy_files(from: &Path, to: &Path) -> Result<()> {
    if !from.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)?.flatten() {
        if entry.path().is_file() {
            std::fs::copy(entry.path(), to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

/// Imports the Markdown pages and journals of a Logseq graph folder.
fn import_logseq(wb: &Workbook, task_words: &[String]) -> Result<String> {
    // Keep the originals: the mirror rewrites pages/ and journals/ afterwards.
    let backup = wb.dir.join("logseq-original");
    if !backup.exists() {
        copy_files(&wb.dir.join("pages"), &backup.join("pages"))?;
        copy_files(&wb.dir.join("journals"), &backup.join("journals"))?;
        copy_files(&wb.dir.join("logseq"), &backup.join("logseq"))?;
    }
    let conn = wb.db.lock();
    let (mut pages, mut skipped) = (0, 0);
    let mut seen_ids: HashSet<String> = HashSet::new();
    for folder in ["pages", "journals"] {
        let Ok(entries) = std::fs::read_dir(wb.dir.join(folder)) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            let is_md = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md"));
            let name = md::page_name_from_file(folder, &stem);
            let (true, Some(mut name), Ok(text)) = (is_md, name, std::fs::read_to_string(&path)) else {
                skipped += 1;
                continue;
            };
            let mut blocks = md::parse_outline(&text);
            if blocks.is_empty() {
                continue;
            }
            // A "title::" page property overrides the file name.
            if let Some(t) = blocks[0].content.lines().find_map(|l| l.trim().strip_prefix("title::"))
                && !t.trim().is_empty() && folder == "pages" {
                    name = t.trim().to_string();
                }
            // Block ids must be unique across the workbook.
            let mut renamed: HashMap<String, String> = HashMap::new();
            for b in &mut blocks {
                if let Some(p) = &b.parent_id
                    && let Some(new) = renamed.get(p) {
                        b.parent_id = Some(new.clone());
                    }
                if !seen_ids.insert(b.id.clone()) {
                    let new = uuid::Uuid::new_v4().to_string();
                    renamed.insert(b.id.clone(), new.clone());
                    seen_ids.insert(new.clone());
                    b.id = new;
                }
            }
            let version = db::get_page(&conn, &name)?.map_or(0, |p| p.version);
            db::save_page(&conn, &name, version, &blocks, task_words)
                .with_context(|| format!("importing {}", path.display()))?;
            pages += 1;
        }
    }
    // Favourites from logseq/config.edn: `:favorites ["a" "b"]`.
    let mut favorites = 0;
    if let Ok(edn) = std::fs::read_to_string(wb.dir.join("logseq").join("config.edn"))
        && let Some(start) = edn.find(":favorites") {
            let rest = &edn[start..];
            if let (Some(open), Some(close)) = (rest.find('['), rest.find(']'))
                && open < close {
                    for name in rest[open + 1..close].split('"').skip(1).step_by(2) {
                        if !name.trim().is_empty() {
                            db::set_favorite(&conn, name.trim(), true)?;
                            favorites += 1;
                        }
                    }
                }
        }
    Ok(format!("{pages} pages, {favorites} favorites, {skipped} files skipped"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(id: &str, content: &str) -> db::Block {
        db::Block { id: id.into(), parent_id: None, content: content.into(), collapsed: false }
    }

    #[test]
    fn workbooks_are_separate() {
        let root = std::env::temp_dir().join(format!("bq-iso-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let reg = Registry::new(root.clone());
        reg.create("Other").unwrap();
        let main = reg.get(MAIN, &[]).unwrap().unwrap();
        let other = reg.get("Other", &[]).unwrap().unwrap();
        let save = |wb: &Workbook, name: &str, b: db::Block| {
            let blocks = vec![b];
            let conn = wb.db.lock();
            let db::SaveOutcome::Saved(page) = db::save_page(&conn, name, 0, &blocks, &[]).unwrap() else { panic!("not saved") };
            wb.write_mirror(&page, &blocks);
        };
        save(&main, "Main page", block("m1", "only in main"));
        save(&other, "Other page", block("o1", "only in other"));
        // The same block id may exist in both: separate databases.
        save(&other, "Copy", block("m1", "copied from main"));
        std::fs::create_dir_all(other.assets_dir()).unwrap();
        std::fs::write(other.assets_dir().join("pic.png"), "x").unwrap();

        let names = |wb: &Workbook| db::list_pages(&wb.db.lock()).unwrap().into_iter().map(|p| p.name).collect::<Vec<_>>();
        assert_eq!(names(&main), vec!["Main page"]);
        let mut o = names(&other);
        o.sort();
        assert_eq!(o, vec!["Copy", "Other page"]);
        assert!(db::search(&main.db.lock(), "only in other", 10).unwrap().blocks.is_empty());
        assert!(other.dir.starts_with(root.join("workbooks")));
        assert!(!main.assets_dir().join("pic.png").exists());
        assert!(!root.join("pages").join("Other page.md").exists());

        // Main's backup leaves the other workbooks out.
        let snap = root.join("snap.db");
        crate::backup::snapshot(&main.db.lock(), &snap).unwrap();
        let zip_path = root.join("main.zip");
        crate::backup::write_zip(MAIN, &main.dir, &snap, &root.join("config.json"), &zip_path).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();
        let entries: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().unwrap().to_string()).collect();
        assert!(entries.iter().any(|n| n == "pages/Main page.md"));
        assert!(!entries.iter().any(|n| n.contains("workbooks/") || n.contains("Other page") || n.contains("pic.png")), "{entries:?}");
        drop((main, other, reg));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_slow_open_does_not_block_other_workbooks() {
        let root = std::env::temp_dir().join(format!("bq-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let reg = std::sync::Arc::new(Registry::new(root.clone()));
        reg.create("Slow").unwrap();
        reg.get(MAIN, &[]).unwrap();
        // Hold Slow's gate as if it were importing a big graph.
        let gate = reg.gate("Slow");
        let held = gate.lock();
        let r2 = reg.clone();
        let other = std::thread::spawn(move || r2.get(MAIN, &[]).unwrap().is_some());
        assert!(other.join().unwrap(), "Main was blocked by Slow's open");
        drop(held);
        assert!(reg.get("Slow", &[]).unwrap().is_some());
        drop(reg);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn usage_counts_this_workbook_only() {
        let root = std::env::temp_dir().join(format!("bq-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("assets")).unwrap();
        let reg = Registry::new(root.clone());
        let main = reg.get(MAIN, &[]).unwrap().unwrap();
        std::fs::write(root.join("assets/a.bin"), vec![0u8; 1000]).unwrap();
        reg.create("Other").unwrap();
        std::fs::write(root.join("workbooks/Other/big.bin"), vec![0u8; 50_000]).unwrap();
        let u = main.usage();
        assert_eq!(u.files, 1000);
        assert!(u.database > 0);
        assert_eq!(u.other, 0, "other workbooks counted: {u:?}");
        // Cached until forgotten.
        std::fs::write(root.join("assets/b.bin"), vec![0u8; 500]).unwrap();
        assert_eq!(main.usage().files, 1000);
        main.forget_usage();
        assert_eq!(main.usage().files, 1500);
        // A symlinked assets folder (e.g. kept elsewhere) is measured too.
        #[cfg(unix)]
        {
            let elsewhere = root.join("elsewhere");
            std::fs::create_dir_all(&elsewhere).unwrap();
            std::fs::write(elsewhere.join("c.bin"), vec![0u8; 700]).unwrap();
            std::fs::rename(root.join("assets"), root.join("old-assets")).unwrap();
            std::os::unix::fs::symlink(&elsewhere, root.join("assets")).unwrap();
            main.forget_usage();
            assert_eq!(main.usage().files, 700);
        }
        drop((main, reg));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deleting_moves_the_workbook_to_the_trash() {
        let root = std::env::temp_dir().join(format!("bq-del-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let reg = Registry::new(root.clone());
        reg.create("Gone").unwrap();
        let wb = reg.get("Gone", &[]).unwrap().unwrap();
        db::save_page(&wb.db.lock(), "Kept in trash", 0, &[block("g1", "still here")], &[]).unwrap();
        assert!(reg.delete(MAIN).is_err());
        let trash = reg.delete("Gone").unwrap();
        assert!(!root.join("workbooks/Gone").exists());
        assert!(trash.join("blockseq.db").exists());
        assert!(reg.list().iter().all(|w| w.id != "Gone" && !w.id.starts_with('.')));
        assert!(reg.get("Gone", &[]).unwrap().is_none());
        // The trash survives the startup clean-up.
        clean_temp(&root);
        assert!(trash.join("blockseq.db").exists());
        drop((wb, reg));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn leftover_temp_files_are_removed_and_nothing_else() {
        let root = std::env::temp_dir().join(format!("bq-clean-{}", uuid::Uuid::new_v4()));
        let make = |p: &str| {
            let path = root.join(p);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x").unwrap();
        };
        for p in [".export-1.zip", ".config.json.abc.tmp", "workbooks/.upload-1.zip", "assets/.upload-1.part",
                  "pages/Note.md.tmp", "workbooks/Home/assets/.upload-2.part"] {
            make(p);
        }
        std::fs::create_dir_all(root.join("workbooks/.import-x/pages")).unwrap();
        for p in ["config.json", "blockseq.db", "assets/photo.png", "pages/Note.md", "workbooks/Home/blockseq.db", "workbooks/Home/assets/a.png"] {
            make(p);
        }
        assert_eq!(clean_temp(&root), 7);
        for p in ["config.json", "blockseq.db", "assets/photo.png", "pages/Note.md", "workbooks/Home/blockseq.db", "workbooks/Home/assets/a.png"] {
            assert!(root.join(p).exists(), "{p} was removed");
        }
        assert!(!root.join("workbooks/.import-x").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
