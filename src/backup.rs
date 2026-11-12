//! Backups: a whole workbook as one zip file, and restoring such a zip (or a
//! zipped Logseq graph) as a new workbook.
//!
//! A backup holds one moment of the database, the Markdown mirror and assets,
//! plus `config.json`. Those are copied together while saves are held off; the
//! zip is built from that copy, so compression does not mix in a later save.
//! #Encrypted blocks stay encrypted: the zip only
//! has the scrambled text and the *wrapped* key (see config.rs), so it is no
//! more readable than the server itself, and your password or recovery key
//! opens it again after a restore.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::config::{Config, Encryption};

pub const FORMAT: u32 = 1;
pub const MANIFEST: &str = "blockseq-backup.json";
/// Written into a restored workbook when its encrypted blocks use a different
/// key than this server's; the browser re-encrypts them and removes it.
pub const IMPORTED_KEY: &str = "imported-key.json";
const DB_FILE: &str = "blockseq.db";
/// Folders copied into (and restored from) a backup.
const FOLDERS: [&str; 6] = ["pages", "journals", "assets", "logseq", "draws", "whiteboards"];

#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub format: u32,
    pub app_version: String,
    pub workbook: String,
    pub exported_at: String,
}

/// Copies a database into `to` as one self-contained file, safely while the
/// server keeps writing (SQLite `VACUUM INTO`).
pub fn snapshot(conn: &Connection, to: &Path) -> Result<()> {
    let _ = std::fs::remove_file(to);
    conn.execute("VACUUM INTO ?1", [to.to_string_lossy()])
        .context("copying the database")?;
    Ok(())
}

/// Copies `db` using a connection of its own, so the server's writer lock
/// stays free while the file is copied. Opened read-write because `VACUUM INTO`
/// cannot read a WAL database through a read-only connection. The copy does
/// not change the live database. A busy timeout lets a short save finish
/// instead of failing the snapshot.
pub fn snapshot_file(db: &Path, to: &Path) -> Result<()> {
    let conn = Connection::open(db).with_context(|| format!("opening {}", db.display()))?;
    crate::db::set_busy_timeout(&conn)?;
    snapshot(&conn, to)
}

/// Suggested file name, e.g. `blockseq-main-2026-11-11.zip`.
pub fn file_name(workbook: &str) -> String {
    let safe: String = workbook.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    format!("blockseq-{safe}-{}.zip", chrono::Local::now().format("%Y-%m-%d"))
}

/// Already-compressed formats are stored as-is (deflating them only wastes time).
fn method_for(path: &Path) -> CompressionMethod {
    const PACKED: &[&str] = &[
        "jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "mp4", "m4v", "mkv", "webm", "mov", "avi",
        "mp3", "m4a", "aac", "ogg", "opus", "flac", "zip", "gz", "tgz", "xz", "bz2", "7z", "rar", "zst",
        "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub", "jar",
    ];
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if PACKED.contains(&ext.as_str()) { CompressionMethod::Stored } else { CompressionMethod::Deflated }
}

fn options_for(path: &Path, method: CompressionMethod) -> SimpleFileOptions {
    let mut opts = SimpleFileOptions::default().compression_method(method).unix_permissions(0o644);
    if let Ok(meta) = std::fs::metadata(path) {
        opts = opts.large_file(meta.len() >= u64::from(u32::MAX));
        if let Some(t) = meta.modified().ok().and_then(zip_time) {
            opts = opts.last_modified_time(t);
        }
    }
    opts
}

fn zip_time(t: std::time::SystemTime) -> Option<zip::DateTime> {
    use chrono::{Datelike, Timelike};
    let t: chrono::DateTime<chrono::Local> = t.into();
    zip::DateTime::from_date_and_time(
        t.year().try_into().ok()?, u8::try_from(t.month()).ok()?, u8::try_from(t.day()).ok()?,
        u8::try_from(t.hour()).ok()?, u8::try_from(t.minute()).ok()?, u8::try_from(t.second()).ok()?,
    ).ok()
}

/// Every regular file under `dir` (no symlinks, no hidden or temp files).
fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name.ends_with(".tmp") {
            continue;
        }
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            walk(&entry.path(), out);
        } else if kind.is_file() {
            out.push(entry.path());
        }
    }
}

const README: &str = "Blockseq backup
===============

blockseq.db           the workbook's database (the source of truth)
pages/, journals/     every page as Logseq Markdown (also opens in Logseq)
assets/               uploaded images and files
config.json           task statuses and the locked key for #Encrypted blocks
blockseq-backup.json  what this is and when it was made

To restore: Blockseq > Settings > Backup > Import backup. It becomes a new
workbook; nothing existing is changed.

#Encrypted blocks are still encrypted in this file. After a restore, unlock
them with the password (or recovery key) you used when the backup was made.
";

/// Copies the database and the mirrored folders into `stage` as one moment.
/// Returns the database file inside `stage`.
///
/// Pass the live writer and hold its lock until this returns, so a save cannot
/// change the database or the Markdown between the two copies. With `writer`
/// left unset (the command-line export, which has no workbook lock), a write
/// transaction is held across both copies instead. The caller zips `stage`
/// after releasing the lock. The file copy is not fsynced.
pub fn stage_snapshot(dir: &Path, stage: &Path, writer: Option<&Connection>) -> Result<PathBuf> {
    std::fs::create_dir_all(stage)?;
    let db_copy = stage.join(DB_FILE);
    match writer {
        Some(conn) => snapshot(conn, &db_copy)?,
        // Hold the write transaction across the file copy too. VACUUM INTO
        // cannot run inside it; the online backup can.
        None => {
            // One connection holds the write lock so a save waits. A second
            // copies the database: the backup API refuses the connection that
            // owns the transaction, and VACUUM INTO cannot run inside one.
            let hold = Connection::open(dir.join(DB_FILE)).with_context(|| format!("opening {}", dir.display()))?;
            crate::db::set_busy_timeout(&hold)?;
            hold.execute_batch("BEGIN IMMEDIATE")?;
            let src = Connection::open(dir.join(DB_FILE)).with_context(|| format!("opening {}", dir.display()))?;
            crate::db::set_busy_timeout(&src)?;
            src.backup("main", &db_copy, rusqlite::backup::NO_PROGRESS).context("copying the database")?;
            copy_mirror(dir, stage)?;
            hold.execute_batch("COMMIT")?;
            return Ok(db_copy);
        }
    }
    copy_mirror(dir, stage)?;
    Ok(db_copy)
}

/// Copies pages, journals, assets and the other mirrored folders. Hidden and
/// temp files are left out, the same way the zip walks them.
fn copy_mirror(dir: &Path, stage: &Path) -> Result<()> {
    for folder in FOLDERS {
        let mut files = Vec::new();
        walk(&dir.join(folder), &mut files);
        for path in files {
            let rel = path.strip_prefix(dir).with_context(|| format!("copying {}", path.display()))?;
            let to = stage.join(rel);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&path, &to).with_context(|| format!("copying {}", path.display()))?;
        }
    }
    let imported = dir.join(IMPORTED_KEY);
    if imported.is_file() {
        std::fs::copy(&imported, stage.join(IMPORTED_KEY))?;
    }
    Ok(())
}

/// Writes the backup zip of the workbook folder `dir` to `out`.
/// `db_copy` is a snapshot made with [`snapshot`]; `config` is config.json.
/// `dir` should be a [`stage_snapshot`] copy when a save might still be running.
pub fn write_zip(workbook: &str, dir: &Path, db_copy: &Path, config: &Path, out: &Path) -> Result<()> {
    let file = std::fs::File::create(out).with_context(|| format!("creating {}", out.display()))?;
    let mut zip = ZipWriter::new(std::io::BufWriter::new(file));
    let mut text = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).unix_permissions(0o644);
    if let Some(now) = zip_time(std::time::SystemTime::now()) {
        text = text.last_modified_time(now);
    }

    let manifest = Manifest {
        format: FORMAT,
        app_version: env!("CARGO_PKG_VERSION").into(),
        workbook: workbook.into(),
        exported_at: chrono::Local::now().to_rfc3339(),
    };
    zip.start_file(MANIFEST, text)?;
    zip.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
    zip.start_file("README.txt", text)?;
    zip.write_all(README.as_bytes())?;
    // Re-serialised so only known settings go in (and it is valid JSON).
    zip.start_file("config.json", text)?;
    // Never back up defaults in place of a damaged file: that would drop the key.
    zip.write_all(serde_json::to_string_pretty(&Config::load(config)?)?.as_bytes())?;
    // A restored workbook whose key was never merged keeps carrying it.
    let imported = dir.join(IMPORTED_KEY);
    if imported.is_file() {
        zip.start_file(IMPORTED_KEY, text)?;
        zip.write_all(&std::fs::read(&imported)?)?;
    }

    zip.start_file(DB_FILE, options_for(db_copy, CompressionMethod::Deflated))?;
    std::io::copy(&mut std::fs::File::open(db_copy)?, &mut zip)?;

    for folder in FOLDERS {
        let mut files = Vec::new();
        walk(&dir.join(folder), &mut files);
        files.sort();
        for path in files {
            let rel = path.strip_prefix(dir)?;
            let name: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
            zip.start_file(name.join("/"), options_for(&path, method_for(&path)))?;
            std::io::copy(&mut std::fs::File::open(&path)?, &mut zip)
                .with_context(|| format!("adding {}", path.display()))?;
        }
    }
    zip.finish()?.flush()?;
    Ok(())
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum KeyOutcome {
    /// No encrypted blocks, or the backup had no password.
    None,
    /// Same key as this server: nothing to do.
    Same,
    /// This server had no password; it now uses the backup's.
    Adopted,
    /// Different key: the browser must re-encrypt (see `IMPORTED_KEY`).
    Different,
}

#[derive(Debug, Serialize)]
pub struct ImportReport {
    /// "blockseq" (a backup) or "logseq" (a zipped graph).
    pub kind: &'static str,
    pub files: usize,
    pub key: KeyOutcome,
    pub exported_at: Option<String>,
}

/// Where a zip entry goes in the new workbook, or None to skip it.
/// Strips `prefix` (a single wrapping folder) and keeps only known paths.
fn target_of(name: &Path, prefix: Option<&str>) -> Option<PathBuf> {
    let mut parts: Vec<String> = Vec::new();
    for c in name.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_str()?.to_string()),
            _ => return None,
        }
    }
    if let Some(p) = prefix {
        if parts.first().map(String::as_str) != Some(p) {
            return None;
        }
        parts.remove(0);
    }
    let first = parts.first()?.as_str();
    let keep = match parts.len() {
        1 => first == DB_FILE || first == IMPORTED_KEY,
        _ => FOLDERS.contains(&first),
    };
    let hidden = parts.iter().any(|p| p.starts_with('.') || p.is_empty());
    (keep && !hidden).then(|| parts.iter().collect())
}

/// The entry names as paths (only well-formed ones).
fn names<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>) -> Vec<Option<PathBuf>> {
    (0..zip.len()).map(|i| zip.by_index(i).ok().and_then(|f| f.enclosed_name())).collect()
}

/// A zip made by zipping a folder has everything inside one top folder.
fn wrapping_folder(names: &[Option<PathBuf>]) -> Option<String> {
    let is_root_item = |p: &Path| {
        let first = p.components().next().and_then(|c| c.as_os_str().to_str()).unwrap_or("");
        first == DB_FILE || first == MANIFEST || FOLDERS.contains(&first)
    };
    if names.iter().flatten().any(|p| is_root_item(p)) {
        return None;
    }
    let mut tops = names.iter().flatten().filter_map(|p| p.components().next()).map(|c| c.as_os_str().to_string_lossy().into_owned());
    let first = tops.next()?;
    tops.all(|t| t == first).then_some(first)
}

fn read_entry<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut s = String::new();
    f.by_ref().take(1 << 20).read_to_string(&mut s).ok()?;
    Some(s)
}

/// Extracts the zip at `src` into the new, not yet existing folder `dest`.
/// `server_key` is this server's encryption setup; when the backup's differs,
/// the backup's is kept in `dest/IMPORTED_KEY`. When this server has no key,
/// that file is written as well and the key is also returned so the caller
/// can store it in `config.json` before deleting the upload. Returns the
/// report and, for `KeyOutcome::Adopted`, the key setup the server should
/// start using.
/// `max_bytes` caps the unpacked size.
pub fn import_zip(src: &Path, dest: &Path, server_key: Option<&Encryption>, max_bytes: u64) -> Result<(ImportReport, Option<Encryption>)> {
    let file = std::fs::File::open(src)?;
    let mut zip = ZipArchive::new(std::io::BufReader::new(file)).context("that file is not a zip")?;
    let all = names(&mut zip);
    let prefix = wrapping_folder(&all);
    let pre = |n: &str| match &prefix { Some(p) => format!("{p}/{n}"), None => n.to_string() };

    let manifest: Option<Manifest> = read_entry(&mut zip, &pre(MANIFEST)).and_then(|s| serde_json::from_str(&s).ok());
    if let Some(m) = &manifest
        && m.format > FORMAT {
            bail!("this backup was made by a newer version of Blockseq ({})", m.app_version);
        }
    let targets: Vec<Option<PathBuf>> = all.iter().map(|n| n.as_deref().and_then(|n| target_of(n, prefix.as_deref()))).collect();
    let has_db = targets.iter().flatten().any(|t| t == Path::new(DB_FILE));
    let has_pages = targets.iter().flatten().any(|t| t.starts_with("pages") || t.starts_with("journals"));
    if !has_db && !has_pages {
        bail!("this zip has no Blockseq backup or Logseq graph in it");
    }

    // The key: the restored workbook's own imported key wins over config.json.
    let backup_key: Option<Encryption> = read_entry(&mut zip, &pre(IMPORTED_KEY))
        .and_then(|s| serde_json::from_str(&s).ok())
        .or_else(|| read_entry(&mut zip, &pre("config.json")).and_then(|s| serde_json::from_str::<Config>(&s).ok()).and_then(|c| c.encryption));

    std::fs::create_dir_all(dest)?;
    let mut total: u64 = 0;
    let mut files = 0;
    for (i, target) in targets.iter().enumerate() {
        let Some(rel) = target else { continue };
        let mut entry = zip.by_index(i)?;
        if entry.is_dir() || entry.is_symlink() || rel == Path::new(IMPORTED_KEY) {
            continue;
        }
        let out = dest.join(rel);
        if let Some(dir) = out.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut w = std::fs::File::create(&out).with_context(|| format!("writing {}", out.display()))?;
        let left = max_bytes.saturating_sub(total);
        let n = std::io::copy(&mut entry.by_ref().take(left + 1), &mut w)?;
        total += n;
        if total > max_bytes {
            bail!("the backup unpacks to more than {} MB", max_bytes / 1024 / 1024);
        }
        files += 1;
    }

    let mut adopt = None;
    let key = if has_db {
        check_db(&dest.join(DB_FILE))?;
        let sealed = has_sealed_blocks(&dest.join(DB_FILE))?;
        match (&backup_key, server_key) {
            (Some(_), _) if !sealed => KeyOutcome::None,
            (None, _) => KeyOutcome::None,
            (Some(b), Some(s)) if b.check == s.check => KeyOutcome::Same,
            (Some(b), None) => {
                // On disk before we return, so a crash after the upload zip is
                // gone still leaves the wrap next to the ciphertext.
                let text = serde_json::to_string_pretty(b)?;
                crate::config::write_durable(&dest.join(IMPORTED_KEY), text.as_bytes())?;
                adopt = Some(b.clone());
                KeyOutcome::Adopted
            }
            (Some(b), Some(_)) => {
                std::fs::write(dest.join(IMPORTED_KEY), serde_json::to_string_pretty(b)?)?;
                KeyOutcome::Different
            }
        }
    } else {
        KeyOutcome::None
    };
    let report = ImportReport {
        kind: if has_db { "blockseq" } else { "logseq" },
        files,
        key,
        exported_at: manifest.map(|m| m.exported_at),
    };
    Ok((report, adopt))
}

/// Refuses databases that are damaged or from a newer Blockseq.
fn check_db(path: &Path) -> Result<()> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).context("the backup's database won't open")?;
    crate::db::set_busy_timeout(&conn)?;
    let ok: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).context("the backup's database is damaged")?;
    if ok != "ok" {
        bail!("the backup's database is damaged ({ok})");
    }
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version > crate::db::SCHEMA_VERSION {
        bail!("this backup was made by a newer version of Blockseq");
    }
    Ok(())
}

fn has_sealed_blocks(path: &Path) -> Result<bool> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    crate::db::set_busy_timeout(&conn)?;
    Ok(conn.query_row("SELECT EXISTS (SELECT 1 FROM blocks WHERE content LIKE '%encrypted:: v1:%')", [], |r| r.get(0))?)
}

/// `blockseq export [WORKBOOK | --all] [--out DIR]`: writes backup zips
/// without stopping the server (handy from cron).
pub fn export_command(data_dir: &Path, args: &[String]) -> Result<()> {
    let mut out_dir = PathBuf::from(".");
    let mut which: Vec<String> = Vec::new();
    let mut all = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--all" => all = true,
            "--out" | "-o" => out_dir = PathBuf::from(it.next().context("--out needs a folder")?),
            "-h" | "--help" => {
                eprintln!("usage: blockseq export [WORKBOOK... | --all] [--out DIR]");
                return Ok(());
            }
            w => which.push(w.to_string()),
        }
    }
    let registry = crate::workbooks::Registry::new(data_dir.to_path_buf());
    if all {
        which = registry.list().into_iter().filter(|w| w.kind == "blockseq").map(|w| w.id).collect();
    } else if which.is_empty() {
        which.push(crate::workbooks::MAIN.into());
    }
    std::fs::create_dir_all(&out_dir)?;
    for id in which {
        let dir = registry.dir_of(&id).filter(|d| d.join(DB_FILE).is_file())
            .with_context(|| format!("no workbook called {id}"))?;
        let out = out_dir.join(file_name(&id));
        let stage = std::env::temp_dir().join(format!("blockseq-snap-{}", uuid::Uuid::new_v4()));
        let result = (|| {
            let db_copy = stage_snapshot(&dir, &stage, None)?;
            write_zip(&id, &stage, &db_copy, &data_dir.join("config.json"), &out)
        })();
        let _ = std::fs::remove_dir_all(&stage);
        result?;
        let size = std::fs::metadata(&out).map_or(0, |m| m.len());
        eprintln!("{id}: {} ({:.1} MB)", out.display(), size as f64 / 1_048_576.0);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_are_confined() {
        let t = |s: &str, p: Option<&str>| target_of(Path::new(s), p);
        assert_eq!(t("blockseq.db", None), Some(PathBuf::from("blockseq.db")));
        assert_eq!(t("pages/a.md", None), Some(PathBuf::from("pages/a.md")));
        assert_eq!(t("graph/pages/a.md", Some("graph")), Some(PathBuf::from("pages/a.md")));
        assert_eq!(t("config.json", None), None);
        assert_eq!(t("workbooks/x/blockseq.db", None), None);
        assert_eq!(t("pages/.hidden", None), None);
        assert_eq!(t("../pages/a.md", None), None);
        assert_eq!(t("/pages/a.md", None), None);
        assert_eq!(t("pages", None), None);
    }

    #[test]
    fn round_trip() -> Result<()> {
        let tmp = std::env::temp_dir().join(format!("bq-backup-{}", uuid::Uuid::new_v4()));
        let src = tmp.join("src");
        std::fs::create_dir_all(src.join("pages"))?;
        std::fs::create_dir_all(src.join("assets"))?;
        std::fs::write(src.join("pages/Hello.md"), "- hi\n")?;
        std::fs::write(src.join("assets/pic.png"), [1u8, 2, 3])?;
        std::fs::write(src.join("assets/.upload-tmp"), "x")?;
        let conn = crate::db::open(&src.join(DB_FILE))?;
        conn.execute_batch("INSERT INTO pages (id, name, name_lower, created_at, updated_at, version) VALUES ('p', 'Hello', 'hello', 0, 0, 1)").ok();
        let cfg = Config { encryption: None, ..Config::default() };
        cfg.save(&tmp.join("config.json"))?;
        let copy = tmp.join("copy.db");
        // The writer stays open, as it does during an export.
        snapshot_file(&src.join(DB_FILE), &copy)?;
        let zip = tmp.join("b.zip");
        write_zip("src", &src, &copy, &tmp.join("config.json"), &zip)?;

        let dest = tmp.join("dest");
        let (report, adopt) = import_zip(&zip, &dest, None, 1 << 30)?;
        assert_eq!(report.kind, "blockseq");
        assert_eq!(report.key, KeyOutcome::None);
        assert!(adopt.is_none());
        assert_eq!(std::fs::read(dest.join("assets/pic.png"))?, [1, 2, 3]);
        assert!(dest.join("pages/Hello.md").is_file());
        assert!(dest.join(DB_FILE).is_file());
        assert!(!dest.join("assets/.upload-tmp").exists());
        assert!(!dest.join("config.json").exists());
        // Too small a limit is refused.
        assert!(import_zip(&zip, &tmp.join("dest2"), None, 2).is_err());
        std::fs::remove_dir_all(&tmp)?;
        Ok(())
    }

    #[test]
    fn the_zip_keeps_the_staged_moment() -> Result<()> {
        let tmp = std::env::temp_dir().join(format!("bq-stage-{}", uuid::Uuid::new_v4()));
        let src = tmp.join("src");
        std::fs::create_dir_all(src.join("pages"))?;
        std::fs::create_dir_all(src.join("assets"))?;
        std::fs::write(src.join("pages/Hello.md"), "- first\n")?;
        std::fs::write(src.join("assets/pic.png"), [1u8, 2, 3])?;
        std::fs::write(src.join("assets/.upload-x.part"), "nope")?;
        let conn = crate::db::open(&src.join(DB_FILE))?;
        let block = crate::db::Block { id: "a".into(), parent_id: None, content: "first".into(), collapsed: false };
        crate::db::save_page(&conn, "Hello", 0, &[block], &[])?;
        let stage = tmp.join("stage");
        let db_copy = stage_snapshot(&src, &stage, Some(&conn))?;
        // A save after the copy must not appear in a zip of that copy.
        std::fs::write(src.join("pages/Hello.md"), "- second\n")?;
        std::fs::write(src.join("assets/pic.png"), [9u8, 9, 9])?;
        std::fs::write(src.join("pages/Later.md"), "- later\n")?;
        let page = crate::db::get_page(&conn, "Hello")?.unwrap();
        let later = crate::db::Block { id: "a".into(), parent_id: None, content: "second".into(), collapsed: false };
        crate::db::save_page(&conn, "Hello", page.version, &[later], &[])?;
        let cfg = Config { encryption: None, ..Config::default() };
        cfg.save(&tmp.join("config.json"))?;
        let zip = tmp.join("b.zip");
        write_zip("src", &stage, &db_copy, &tmp.join("config.json"), &zip)?;
        let dest = tmp.join("dest");
        import_zip(&zip, &dest, None, 1 << 30)?;
        assert_eq!(std::fs::read_to_string(dest.join("pages/Hello.md"))?, "- first\n");
        assert_eq!(std::fs::read(dest.join("assets/pic.png"))?, [1, 2, 3]);
        assert!(!dest.join("pages/Later.md").exists());
        assert!(!dest.join("assets/.upload-x.part").exists());
        let saved = crate::db::open(&dest.join(DB_FILE))?;
        let restored = crate::db::get_page(&saved, "Hello")?.unwrap();
        assert_eq!(crate::db::get_blocks(&saved, &restored.id)?[0].content, "first");

        // The command-line path (no live writer) stages the same way.
        let stage2 = tmp.join("stage2");
        let db_copy2 = stage_snapshot(&src, &stage2, None)?;
        let zip2 = tmp.join("b2.zip");
        write_zip("src", &stage2, &db_copy2, &tmp.join("config.json"), &zip2)?;
        let dest2 = tmp.join("dest-now");
        import_zip(&zip2, &dest2, None, 1 << 30)?;
        assert_eq!(std::fs::read_to_string(dest2.join("pages/Hello.md"))?, "- second\n");
        drop((conn, saved));
        std::fs::remove_dir_all(&tmp)?;
        Ok(())
    }

    fn sample_key(check: &str) -> Encryption {
        Encryption {
            version: 1,
            salt: "s".into(),
            iterations: 1,
            pw_iv: "i".into(),
            pw_data: "d".into(),
            rk_salt: "rs".into(),
            rk_iterations: 1,
            rk_iv: "ri".into(),
            rk_data: "rd".into(),
            check: check.into(),
            proof_hash: None,
        }
    }

    #[test]
    fn an_adopted_key_is_written_before_the_caller_can_delete_the_zip() -> Result<()> {
        let tmp = std::env::temp_dir().join(format!("bq-adopt-{}", uuid::Uuid::new_v4()));
        let src = tmp.join("src");
        std::fs::create_dir_all(&src)?;
        let conn = crate::db::open(&src.join(DB_FILE))?;
        let block = crate::db::Block {
            id: "b".into(),
            parent_id: None,
            content: "encrypted:: v1:aa:bb".into(),
            collapsed: false,
        };
        crate::db::save_page(&conn, "Secret", 0, &[block], &[])?;
        let key = sample_key("check-value");
        let cfg = Config { encryption: Some(key.clone()), ..Config::default() };
        cfg.save(&tmp.join("config.json"))?;
        let copy = tmp.join("copy.db");
        snapshot_file(&src.join(DB_FILE), &copy)?;
        let zip = tmp.join("b.zip");
        write_zip("src", &src, &copy, &tmp.join("config.json"), &zip)?;

        let dest = tmp.join("dest");
        let (report, adopt) = import_zip(&zip, &dest, None, 1 << 30)?;
        assert_eq!(report.key, KeyOutcome::Adopted);
        assert_eq!(adopt.unwrap().check, key.check);
        let stored: Encryption = serde_json::from_str(&std::fs::read_to_string(dest.join(IMPORTED_KEY))?)?;
        assert_eq!(stored, key);

        let dest_same = tmp.join("dest-same");
        let (report, adopt) = import_zip(&zip, &dest_same, Some(&key), 1 << 30)?;
        assert_eq!(report.key, KeyOutcome::Same);
        assert!(adopt.is_none());
        assert!(!dest_same.join(IMPORTED_KEY).exists());

        let dest_other = tmp.join("dest-other");
        let (report, adopt) = import_zip(&zip, &dest_other, Some(&sample_key("other")), 1 << 30)?;
        assert_eq!(report.key, KeyOutcome::Different);
        assert!(adopt.is_none());
        assert!(dest_other.join(IMPORTED_KEY).is_file());
        std::fs::remove_dir_all(&tmp)?;
        Ok(())
    }
}
