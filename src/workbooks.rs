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
    /// Reads run here, beside `db`, so a long query does not block a save.
    reads: Mutex<Connection>,
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
/// Bytes in the files under `dir`. An upper bound on a zip of that tree.
pub fn tree_bytes(dir: &Path) -> u64 {
    dir_size(dir)
}

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
    /// The workbook's folder, relative to the data directory. Main is `.`.
    pub path: String,
}

/// Where deleted workbooks go (inside workbooks/, hidden: never listed).
pub const TRASH: &str = ".trash";

/// What belongs to the Main workbook in the data folder. Everything else
/// there (workbooks/, config.json, sessions.json, backups/) is shared and
/// stays when Main is replaced by a restore.
const MAIN_ITEMS: [&str; 11] = [
    "blockseq.db",
    "blockseq.db-wal",
    "blockseq.db-shm",
    "pages",
    "journals",
    "assets",
    "logseq",
    "draws",
    "whiteboards",
    crate::backup::IMPORTED_KEY,
    STALE_MIRROR,
];

/// Folder in workbooks/ that holds a half-finished Restore into Main. Never
/// removed automatically: if one is left after a crash, the log says so.
const RESTORING_MAIN: &str = ".restoring-main-";

/// Moves the listed items that exist in `from` into `to` (same filesystem,
/// so each move is a rename). If one fails, the ones already moved go back
/// and the error is returned. An item already in `to` is an error, never
/// replaced. Returns the names moved.
fn move_items(from: &Path, to: &Path, names: &[&str]) -> Result<Vec<String>> {
    std::fs::create_dir_all(to).with_context(|| format!("creating {}", to.display()))?;
    let mut moved: Vec<String> = Vec::new();
    let result = (|| -> Result<()> {
        for name in names {
            let src = from.join(name);
            if std::fs::symlink_metadata(&src).is_err() {
                continue;
            }
            let dst = to.join(name);
            if std::fs::symlink_metadata(&dst).is_ok() {
                bail!("{} is in the way", dst.display());
            }
            std::fs::rename(&src, &dst).with_context(|| format!("moving {}", src.display()))?;
            moved.push((*name).to_string());
        }
        Ok(())
    })();
    if let Err(e) = result {
        put_back(to, from, &moved);
        return Err(e);
    }
    Ok(moved)
}

/// Undoes `move_items` (best effort; anything that cannot move back is logged).
fn put_back(moved_to: &Path, home: &Path, names: &[String]) {
    for name in names.iter().rev() {
        if let Err(e) = std::fs::rename(moved_to.join(name), home.join(name)) {
            tracing::error!("could not move {name} back from {}: {e}. Move it back by hand.", moved_to.display());
        }
    }
}

/// What a Restore into Main did with the Main it replaced.
pub struct MainRestore {
    pub report: backup::ImportReport,
    pub adopt: Option<crate::config::Encryption>,
    /// Where the old Main's files went: a workbook folder or the trash.
    pub set_aside: PathBuf,
}

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
                    "workbooks" | "backups" if self.id == MAIN => {}
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

    /// The read connection. Held only for the query that uses it.
    pub fn read(&self) -> parking_lot::MutexGuard<'_, Connection> {
        self.reads.lock()
    }

    pub fn assets_dir(&self) -> PathBuf {
        self.dir.join("assets")
    }

    /// Writes the page as a Logseq Markdown file. SQLite is the source of
    /// truth, so a failure is only logged. The write is not fsynced: if power
    /// is lost, the next startup rebuilds every mirror from the database.
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
    /// The writer lock is taken one page at a time, so a save is not stuck
    /// behind the whole graph.
    pub fn rebuild_mirror(&self) -> Result<usize> {
        let names: Vec<String> = {
            let conn = self.db.lock();
            db::list_pages(&conn)?.into_iter().map(|p| p.name).collect()
        };
        let mut n = 0;
        for name in &names {
            if self.is_retired() {
                break;
            }
            let conn = self.db.lock();
            if let Some(page) = db::get_page(&conn, name)? {
                let blocks = db::get_blocks(&conn, &page.id)?;
                self.write_mirror(&page, &blocks);
                n += 1;
            }
        }
        if !self.is_retired() {
            // Under the lock, with the names as they are now, so a rename
            // cannot write a file between the listing and the check.
            let conn = self.db.lock();
            let names: Vec<String> = db::list_pages(&conn)?.into_iter().map(|p| p.name).collect();
            let moved = set_aside_stale_mirror_files(&self.dir, &names);
            if moved > 0 {
                tracing::info!("moved {moved} Markdown file(s) left under an older file name to {STALE_MIRROR}/");
            }
        }
        Ok(n)
    }
}

/// Hidden folder in the workbook for Markdown files set aside by
/// [`set_aside_stale_mirror_files`]. Backups and Logseq skip it.
pub const STALE_MIRROR: &str = ".old-mirror-files";

/// Moves files in `pages/` that hold a page under a file name this version no
/// longer uses into [`STALE_MIRROR`], so a page never has two Markdown files.
/// Older versions kept `_` and `%` as they are and dropped control
/// characters; `my_page.md` is now `my%5Fpage.md`. Only a file whose name
/// decodes to an existing page, and is not that page's current file, is
/// moved; anything else in the folder is left alone. Nothing is deleted: the
/// database holds the page, and the old file stays there to look at.
/// Returns how many files were moved.
fn set_aside_stale_mirror_files(dir: &Path, names: &[String]) -> usize {
    let current: HashMap<String, String> = names
        .iter()
        .map(|n| (n.to_lowercase(), md::mirror_path(n, None)))
        .collect();
    let Ok(entries) = std::fs::read_dir(dir.join("pages")) else { return 0 };
    let mut moved = 0;
    for entry in entries.flatten() {
        let file = entry.file_name();
        let Some(file) = file.to_str() else { continue };
        let Some(stem) = file.strip_suffix(".md") else { continue };
        if file.starts_with('.') || !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let Some(name) = md::page_name_from_file("pages", stem) else { continue };
        let Some(expected) = current.get(&name.to_lowercase()) else { continue };
        if *expected == format!("pages/{file}") {
            continue;
        }
        let aside = dir.join(STALE_MIRROR);
        if std::fs::create_dir_all(&aside).is_err() {
            return moved;
        }
        // Never replace a file set aside earlier.
        let mut to = aside.join(file);
        for i in 1.. {
            if !to.exists() {
                break;
            }
            to = aside.join(format!("{stem}.{i}.md"));
        }
        if std::fs::rename(entry.path(), &to).is_ok() {
            moved += 1;
        }
    }
    moved
}

/// Temp file, then rename. Not fsynced, unlike `config.json`. A crash can
/// leave the mirror behind the database; startup `rebuild_mirror` rewrites
/// it from SQLite, which is the recovery path.
fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Kept free on a volume so uploads, a restore and a backup cannot fill it.
pub const DISK_RESERVE: u64 = 256 * 1024 * 1024;

/// Bytes still available to this process on the volume that holds `path`.
pub fn free_bytes(path: &Path) -> std::io::Result<u64> {
    let bytes = std::os::unix::ffi::OsStrExt::as_bytes(path.as_os_str());
    let c = std::ffi::CString::new(bytes).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path contains a nul")
    })?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a nul-terminated path, and `st` is a writable statvfs buffer.
    let rc = unsafe { libc::statvfs(c.as_ptr(), &raw mut st) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // On this target both fields are already `u64` (filesystem block size and
    // blocks available to this user).
    Ok(st.f_frsize.saturating_mul(st.f_bavail))
}

/// `free` can accept `need` more bytes, after `reserved` already promised to
/// other uploads, and still leave `reserve` unused.
pub fn space_fits(free: u64, reserved: u64, need: u64, reserve: u64) -> bool {
    free.saturating_sub(reserved) >= reserve.saturating_add(need)
}

/// A folder relative to the data directory, with `/` separators. Main is `.`.
/// An absolute path is not returned: the data directory stays off the API.
pub fn relative_path(root: &Path, dir: &Path) -> String {
    let Ok(rel) = dir.strip_prefix(root) else { return ".".into() };
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    if parts.is_empty() { ".".into() } else { parts.join("/") }
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
        let mut out = vec![WorkbookInfo { id: MAIN.into(), name: "Main".into(), kind: "blockseq", path: relative_path(&self.root, &self.root) }];
        let mut others: Vec<WorkbookInfo> = std::fs::read_dir(self.root.join("workbooks"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_dir())
            .filter_map(|e| {
                let id = e.file_name().to_str()?.to_string();
                valid_id(&id).then(|| WorkbookInfo { name: id.clone(), kind: Self::kind(&e.path()), path: relative_path(&self.root, &e.path()), id })
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
        Ok(WorkbookInfo { id: name.into(), name: name.into(), kind: "empty", path: relative_path(&self.root, &dir) })
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
        Ok(WorkbookInfo { id: to.into(), name: to.into(), kind: Self::kind(&dst), path: relative_path(&self.root, &dst) })
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
    /// handles are retired. The registry map is released before that work,
    /// so other workbooks keep opening. On failure this workbook stays open
    /// on the same connections.
    fn move_closed(&self, id: &str, src: &Path, dst: &Path) -> Result<()> {
        // Not while the workbook is being opened, and not opened again until
        // this returns. Only this id waits.
        let gate = self.gate(id);
        let _moving = gate.lock();
        let wb = self.open.lock().remove(id);
        let result = (|| -> Result<()> {
            // The read connection is the other handle on this file. Take it
            // first so a query finishes, and make both wait out a lock
            // instead of failing at once.
            let read = wb.as_ref().map(|w| w.read());
            let write = wb.as_ref().map(|w| w.db.lock());
            if let Some(conn) = &read {
                db::set_busy_timeout(conn)?;
            }
            if let Some(conn) = &write {
                db::set_busy_timeout(conn)?;
                conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
            }
            std::fs::rename(src, dst).with_context(|| format!("moving {}", src.display()))
        })();
        if result.is_ok()
            && let Some(w) = &wb
        {
            w.retired.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        if result.is_err()
            && let Some(w) = wb
        {
            self.open.lock().insert(id.to_string(), w);
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
        let info = WorkbookInfo { id: name.into(), name: name.into(), kind: Self::kind(&dir), path: relative_path(&self.root, &dir) };
        Ok((info, report, adopt))
    }

    /// Restores a backup zip as Main. The zip is unpacked and checked in a
    /// hidden folder first. Then Main is closed and its files move (rename,
    /// nothing copied) into workbooks/`keep_as`, or into the trash when
    /// `keep_as` is None, and the restored files move into the data folder.
    /// If a step fails, every file moved so far goes back and Main stays as
    /// it was. Shared files (config.json, workbooks/, ...) are not touched.
    /// The caller zips a Main that has content beforehand.
    pub fn restore_into_main(
        &self,
        zip: &Path,
        server_key: Option<&crate::config::Encryption>,
        max_bytes: u64,
        keep_as: Option<&str>,
    ) -> Result<MainRestore> {
        let folder = self.root.join("workbooks");
        let final_dir = match keep_as.map(str::trim) {
            Some(name) => {
                if !valid_id(name) {
                    bail!("use letters, digits, spaces, dashes, dots or underscores (not \"main\")");
                }
                let dir = folder.join(name);
                if dir.exists() {
                    bail!("a workbook called {name} already exists");
                }
                dir
            }
            None => folder.join(TRASH).join(format!("Main {}", chrono::Local::now().format("%Y-%m-%d %H%M%S"))),
        };
        let work = folder.join(format!("{RESTORING_MAIN}{}", uuid::Uuid::new_v4()));
        let incoming = work.join("incoming");
        let aside = work.join("old-main");
        let unpacked = backup::import_zip(zip, &incoming, server_key, max_bytes);
        let (report, adopt) = match unpacked {
            Ok(v) => v,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&work);
                return Err(e);
            }
        };

        // Close Main: nothing opens it until this returns, a running query
        // or save finishes first, and the database is checkpointed so the
        // file moves whole.
        let gate = self.gate(MAIN);
        let _moving = gate.lock();
        let wb = self.open.lock().remove(MAIN);
        let swapped = (|| -> Result<()> {
            let read = wb.as_ref().map(|w| w.read());
            let write = wb.as_ref().map(|w| w.db.lock());
            if let Some(conn) = &read {
                db::set_busy_timeout(conn)?;
            }
            if let Some(conn) = &write {
                db::set_busy_timeout(conn)?;
                conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
            }
            let old = move_items(&self.root, &aside, &MAIN_ITEMS)?;
            if let Err(e) = move_items(&incoming, &self.root, &MAIN_ITEMS) {
                put_back(&aside, &self.root, &old);
                return Err(e);
            }
            Ok(())
        })();
        match swapped {
            Ok(()) => {
                if let Some(w) = &wb {
                    w.retired.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            }
            Err(e) => {
                if let Some(w) = wb {
                    self.open.lock().insert(MAIN.to_string(), w);
                }
                let _ = std::fs::remove_dir_all(&incoming);
                let _ = std::fs::remove_dir(&work);
                return Err(e.context("restoring into Main (Main was left as it was)"));
            }
        }
        // The restore is done. Put the old files where they were asked to go;
        // if that last move fails they stay in the hidden folder, intact.
        if let Some(parent) = final_dir.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let set_aside = match std::fs::rename(&aside, &final_dir) {
            Ok(()) => final_dir,
            Err(e) => {
                tracing::error!("the previous Main is in {} (could not move it to {}: {e})", aside.display(), final_dir.display());
                aside
            }
        };
        // Only files a backup carries but Main does not use are left here.
        let _ = std::fs::remove_dir_all(&incoming);
        let _ = std::fs::remove_dir(&work);
        Ok(MainRestore { report, adopt, set_aside })
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
        let opening = gate.lock();
        if let Some(wb) = self.open.lock().get(id) {
            return Ok(Some(wb.clone()));
        }
        let Some(dir) = self.dir_of(id) else { return Ok(None) };
        if !dir.is_dir() {
            return Ok(None);
        }
        let import = Self::kind(&dir) == "logseq";
        let db_path = dir.join(DB_FILE);
        // A Logseq graph is imported into a partial file and renamed into
        // place only after every page is saved. Creating blockseq.db first
        // would make the next open skip the import and rewrite the Markdown.
        let conn = if import {
            let (conn, report) = open_imported(&dir, &db_path, task_words)
                .with_context(|| format!("importing Logseq graph {id}"))?;
            tracing::info!("workbook {id}: imported Logseq graph ({report})");
            conn
        } else {
            db::open(&db_path).with_context(|| format!("opening workbook {id}"))?
        };
        let reads = db::open_read(&db_path).with_context(|| format!("opening workbook {id} for reading"))?;
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
        let wb = std::sync::Arc::new(Workbook {
            id: id.to_string(),
            dir,
            db: Mutex::new(conn),
            reads: Mutex::new(reads),
            retired: std::sync::atomic::AtomicBool::default(),
            integrity,
            usage_cache: Mutex::new(None),
        });
        // Publish before the mirror rewrite so other requests are not stuck
        // on this gate for the whole graph. The lock is dropped first.
        self.open.lock().insert(id.to_string(), wb.clone());
        drop(opening);
        let count = wb.rebuild_mirror()?;
        tracing::info!("workbook {id}: {count} pages in {}", wb.dir.display());
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
        } else if name.starts_with(RESTORING_MAIN) {
            // A Restore into Main was cut short. Its files are kept: they may
            // be the previous Main.
            tracing::error!(
                "{} is left from an interrupted Restore into Main. old-main/ in it holds the previous Main; check Main and move files back by hand if needed.",
                path.display()
            );
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

/// Removes a SQLite file and the WAL/SHM names SQLite would use beside it.
fn remove_sqlite_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    remove_sidecars(path);
}

fn remove_sidecars(path: &Path) {
    let Some(dir) = path.parent() else { return };
    for suffix in ["-wal", "-shm"] {
        let mut name = path.file_name().unwrap_or_default().to_os_string();
        name.push(suffix);
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/// Imports a Logseq graph into `db_path`. The database is built as
/// `blockseq.db.partial` and renamed into place only after every file is
/// saved. On any error the partial file is removed and `db_path` is not
/// created, so the next open still sees a Logseq graph and tries again.
fn open_imported(dir: &Path, db_path: &Path, task_words: &[String]) -> Result<(Connection, String)> {
    let partial = db_path.with_file_name(format!("{DB_FILE}.partial"));
    remove_sqlite_files(&partial);
    let conn = match db::open(&partial) {
        Ok(conn) => conn,
        Err(e) => {
            remove_sqlite_files(&partial);
            return Err(e).context("creating the import database");
        }
    };
    let report = match import_logseq(&conn, dir, task_words) {
        Ok(report) => report,
        Err(e) => {
            drop(conn);
            remove_sqlite_files(&partial);
            return Err(e);
        }
    };
    if let Err(e) = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)") {
        drop(conn);
        remove_sqlite_files(&partial);
        return Err(e).context("finishing the Logseq import");
    }
    drop(conn);
    if let Ok(file) = std::fs::File::open(&partial) {
        let _ = file.sync_all();
    }
    remove_sidecars(&partial);
    if let Err(e) = std::fs::rename(&partial, db_path) {
        remove_sqlite_files(&partial);
        return Err(e).with_context(|| format!("finishing the import into {}", db_path.display()));
    }
    if let Some(parent) = db_path.parent()
        && let Ok(folder) = std::fs::File::open(parent)
    {
        let _ = folder.sync_all();
    }
    let conn = db::open(db_path).context("opening the imported workbook")?;
    Ok((conn, report))
}

/// A save during import counts only when the page was actually written.
fn require_saved(outcome: &db::SaveOutcome, path: &Path) -> Result<()> {
    match outcome {
        db::SaveOutcome::Saved(_) => Ok(()),
        db::SaveOutcome::Conflict(_, _) => bail!("{} was not imported: it conflicted with a page already saved", path.display()),
        db::SaveOutcome::ForeignIds(_) => bail!("{} was not imported: its blocks belong to another page", path.display()),
        db::SaveOutcome::Deleted => bail!("{} was not imported: that page was deleted during the import", path.display()),
    }
}

/// Imports the Markdown pages and journals of a Logseq graph folder.
fn import_logseq(conn: &Connection, dir: &Path, task_words: &[String]) -> Result<String> {
    // Keep the originals: the mirror rewrites pages/ and journals/ afterwards.
    // On a retry the copy is already there, and must not be replaced with the
    // mirror's version of the files.
    let backup = dir.join("logseq-original");
    if !backup.exists() {
        copy_files(&dir.join("pages"), &backup.join("pages"))?;
        copy_files(&dir.join("journals"), &backup.join("journals"))?;
        copy_files(&dir.join("logseq"), &backup.join("logseq"))?;
    }
    let (mut pages, mut skipped, mut merged) = (0, 0, 0);
    let mut seen_ids: HashSet<String> = HashSet::new();
    for folder in ["pages", "journals"] {
        let Ok(entries) = std::fs::read_dir(dir.join(folder)) else { continue };
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
            let existing = db::get_page(conn, &name)?;
            let outcome = if let Some(page) = &existing {
                let prior = db::get_blocks(conn, &page.id)?;
                if prior.iter().any(|b| !b.content.trim().is_empty()) {
                    // A second file for the same page is appended. Replacing
                    // it would drop the first file, often with no history.
                    let mut combined = prior;
                    combined.extend(blocks);
                    merged += 1;
                    db::save_page_noting(conn, &name, page.version, &combined, task_words, "before a Logseq file with the same name was merged")?
                } else {
                    db::save_page(conn, &name, page.version, &blocks, task_words)?
                }
            } else {
                db::save_page(conn, &name, 0, &blocks, task_words)?
            };
            require_saved(&outcome, &path).with_context(|| format!("importing {}", path.display()))?;
            pages += 1;
        }
    }
    // Favourites from logseq/config.edn: `:favorites ["a" "b"]`.
    let mut favorites = 0;
    if let Ok(edn) = std::fs::read_to_string(dir.join("logseq").join("config.edn"))
        && let Some(start) = edn.find(":favorites") {
            let rest = &edn[start..];
            if let (Some(open), Some(close)) = (rest.find('['), rest.find(']'))
                && open < close {
                    for name in rest[open + 1..close].split('"').skip(1).step_by(2) {
                        if !name.trim().is_empty() {
                            db::set_favorite(conn, name.trim(), true)?;
                            favorites += 1;
                        }
                    }
                }
        }
    let mut report = format!("{pages} pages, {favorites} favorites, {skipped} files skipped");
    if merged > 0 {
        use std::fmt::Write as _;
        let _ = write!(report, ", {merged} files merged into a page of the same name");
    }
    Ok(report)
}

#[cfg(test)]
mod tests;
