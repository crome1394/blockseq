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
use std::sync::Mutex;

use anyhow::{Context, Result, bail};
use rusqlite::Connection;
use serde::Serialize;

use crate::{db, md};

pub const MAIN: &str = "main";
const DB_FILE: &str = "blockseq.db";

pub struct Workbook {
    pub id: String,
    pub dir: PathBuf,
    pub db: Mutex<Connection>,
}

#[derive(Debug, Serialize)]
pub struct WorkbookInfo {
    pub id: String,
    pub name: String,
    /// "blockseq" (ready), "logseq" (will be imported on open) or "empty".
    pub kind: &'static str,
}

impl Workbook {
    pub fn assets_dir(&self) -> PathBuf {
        self.dir.join("assets")
    }

    /// Writes the page as a Logseq Markdown file. This is a readable backup;
    /// the database stays the source of truth, so failures are only logged.
    pub fn write_mirror(&self, page: &db::PageMeta, blocks: &[db::Block]) {
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
        let _ = std::fs::remove_file(self.dir.join(md::mirror_path(&page.name, page.journal_day)));
    }

    /// Rewrites every Markdown mirror file from the database.
    pub fn rebuild_mirror(&self) -> Result<usize> {
        let conn = self.db.lock().unwrap();
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
}

impl Registry {
    pub fn new(root: PathBuf) -> Registry {
        Registry { root, open: Mutex::new(HashMap::new()) }
    }

    fn dir_of(&self, id: &str) -> Option<PathBuf> {
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
        let mut out = vec![WorkbookInfo { id: MAIN.into(), name: "Main".into(), kind: "blockseq" }];
        let mut others: Vec<WorkbookInfo> = std::fs::read_dir(self.root.join("workbooks"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_dir())
            .filter_map(|e| {
                let id = e.file_name().to_str()?.to_string();
                valid_id(&id).then(|| WorkbookInfo { name: id.clone(), kind: Self::kind(&e.path()), id })
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
        Ok(WorkbookInfo { id: name.into(), name: name.into(), kind: "empty" })
    }

    /// Returns an open workbook, opening (and if needed importing) it first.
    /// Blocking: call from spawn_blocking.
    pub fn get(&self, id: &str, task_words: &[String]) -> Result<Option<std::sync::Arc<Workbook>>> {
        let mut open = self.open.lock().unwrap();
        if let Some(wb) = open.get(id) {
            return Ok(Some(wb.clone()));
        }
        let Some(dir) = self.dir_of(id) else { return Ok(None) };
        if !dir.is_dir() {
            return Ok(None);
        }
        let import = Self::kind(&dir) == "logseq";
        let conn = db::open(&dir.join(DB_FILE)).with_context(|| format!("opening workbook {id}"))?;
        db::refresh_task_refs(&conn, task_words)?;
        let pruned = db::prune_orphans(&conn)?.len();
        if pruned > 0 {
            tracing::info!("workbook {id}: removed {pruned} empty, unlinked pages");
        }
        let wb = std::sync::Arc::new(Workbook { id: id.to_string(), dir, db: Mutex::new(conn) });
        if import {
            let report = import_logseq(&wb, task_words)?;
            tracing::info!("workbook {id}: imported Logseq graph ({report})");
        }
        let count = wb.rebuild_mirror()?;
        tracing::info!("workbook {id}: {count} pages in {}", wb.dir.display());
        open.insert(id.to_string(), wb.clone());
        Ok(Some(wb))
    }

    /// Workbooks that are currently open (for settings changes).
    pub fn open_workbooks(&self) -> Vec<std::sync::Arc<Workbook>> {
        self.open.lock().unwrap().values().cloned().collect()
    }
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
    let mut conn = wb.db.lock().unwrap();
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
            if let Some(t) = blocks[0].content.lines().find_map(|l| l.trim().strip_prefix("title::")) {
                if !t.trim().is_empty() && folder == "pages" {
                    name = t.trim().to_string();
                }
            }
            // Block ids must be unique across the workbook.
            let mut renamed: HashMap<String, String> = HashMap::new();
            for b in &mut blocks {
                if let Some(p) = &b.parent_id {
                    if let Some(new) = renamed.get(p) {
                        b.parent_id = Some(new.clone());
                    }
                }
                if !seen_ids.insert(b.id.clone()) {
                    let new = uuid::Uuid::new_v4().to_string();
                    renamed.insert(b.id.clone(), new.clone());
                    seen_ids.insert(new.clone());
                    b.id = new;
                }
            }
            let version = db::get_page(&conn, &name)?.map(|p| p.version).unwrap_or(0);
            db::save_page(&mut conn, &name, version, &blocks, task_words)
                .with_context(|| format!("importing {}", path.display()))?;
            pages += 1;
        }
    }
    // Favourites from logseq/config.edn: `:favorites ["a" "b"]`.
    let mut favorites = 0;
    if let Ok(edn) = std::fs::read_to_string(wb.dir.join("logseq").join("config.edn")) {
        if let Some(start) = edn.find(":favorites") {
            let rest = &edn[start..];
            if let (Some(open), Some(close)) = (rest.find('['), rest.find(']')) {
                if open < close {
                    for name in rest[open + 1..close].split('"').skip(1).step_by(2) {
                        if !name.trim().is_empty() {
                            db::set_favorite(&conn, name.trim(), true)?;
                            favorites += 1;
                        }
                    }
                }
            }
        }
    }
    Ok(format!("{pages} pages, {favorites} favorites, {skipped} files skipped"))
}
