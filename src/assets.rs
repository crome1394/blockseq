//! Uploaded images and PDFs, stored as files in the workbook's `assets/`.
//!
//! Blocks reference them the way Logseq does: `![image](../assets/name.png)`.
//! That path is relative to the Markdown mirror's `pages/` folder, so the
//! mirror shows images too.

use std::path::Path;

use anyhow::{Result, bail};

/// Works out the image type from the file's first bytes. The browser's claimed
/// content type is ignored, so only real images are stored. SVG is refused
/// because it can carry scripts.
pub fn image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && matches!(&bytes[8..12], b"avif" | b"avis") {
        Some("avif")
    } else {
        None
    }
}

/// File type from the first bytes: an image type, or "pdf".
pub fn file_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"%PDF-") { Some("pdf") } else { image_ext(bytes) }
}

/// A safe file-name stem from the uploaded file's name ("Screenshot 1.png" →
/// "`Screenshot_1`"), or "file" if nothing usable is left.
pub fn safe_stem(original: &str) -> String {
    let stem = Path::new(original)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let cleaned: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let cleaned: String = cleaned.trim_matches('_').chars().take(40).collect();
    if cleaned.is_empty() { "file".into() } else { cleaned }
}

/// True for names this module could have created: no paths, no hidden files.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && !name.starts_with('.')
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif"];
const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "webm", "mkv", "mov", "ogv"];
const AUDIO_EXTS: &[&str] = &["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac"];
const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "log", "json", "yaml", "yml", "toml", "ini", "conf", "cfg", "sh", "py",
    "rs", "go", "c", "h", "cpp", "java", "sql", "env",
];

fn ext_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((_, e)) => e.to_ascii_lowercase(),
        None => String::new(),
    }
}

/// What kind of file a stored name is: "image", "pdf", "video", "audio",
/// "text" or "other". Decides how blocks show it.
pub fn kind_of(name: &str) -> &'static str {
    let ext = ext_of(name);
    let e = ext.as_str();
    if IMAGE_EXTS.contains(&e) {
        "image"
    } else if e == "pdf" {
        "pdf"
    } else if VIDEO_EXTS.contains(&e) {
        "video"
    } else if AUDIO_EXTS.contains(&e) {
        "audio"
    } else if TEXT_EXTS.contains(&e) {
        "text"
    } else {
        "other"
    }
}

/// Extension to store an upload under. Images and PDFs are recognised from
/// their bytes; other files keep their own (cleaned) extension. A file that
/// claims to be an image or PDF but isn't one is stored as ".bin".
pub fn ext_for(head: &[u8], original: &str) -> String {
    if let Some(e) = file_ext(head) {
        return e.to_string();
    }
    let ext: String = ext_of(original).chars().filter(char::is_ascii_alphanumeric).take(10).collect();
    if ext.is_empty() || IMAGE_EXTS.contains(&ext.as_str()) || ext == "pdf" {
        "bin".into()
    } else {
        ext
    }
}

/// How to serve a stored file: content type, whether the browser may show it
/// (otherwise it is a download), and an optional Content-Security-Policy.
/// Only types that can't run scripts on Blockseq's address are shown; HTML,
/// SVG and anything unknown are always downloads.
pub fn serve_policy(name: &str) -> (String, bool, Option<&'static str>) {
    let mime = mime_guess::from_path(name).first_or_octet_stream().essence_str().to_string();
    match kind_of(name) {
        "image" => (mime, true, Some("default-src 'none'")),
        "pdf" => ("application/pdf".into(), true, None),
        "video" | "audio" => (mime, true, None),
        "text" => ("text/plain; charset=utf-8".into(), true, Some("sandbox")),
        _ => ("application/octet-stream".into(), false, Some("sandbox")),
    }
}

/// Picks a free name "{stem}_{ms}_{i}.{ext}" and moves `tmp` there.
/// Creating the name with `create_new` first means names never collide.
pub fn place(dir: &Path, tmp: &Path, stem: &str, ext: &str, now_ms: i64) -> Result<String> {
    for i in 0..1000 {
        let name = format!("{stem}_{now_ms}_{i}.{ext}");
        let path = dir.join(&name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => {
                std::fs::rename(tmp, &path)?;
                return Ok(name);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
    }
    bail!("could not pick a file name")
}

pub struct AssetInfo {
    pub name: String,
    pub size: u64,
    pub modified: i64,
    pub kind: &'static str,
}

/// Lists the files in an assets folder, newest first.
/// A folder that can't be read lists as empty.
pub fn list(dir: &Path) -> Vec<AssetInfo> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Some(name) = entry.file_name().to_str().map(String::from) else { continue };
        if !meta.is_file() || !valid_name(&name) {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        out.push(AssetInfo { kind: kind_of(&name), name, size: meta.len(), modified });
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.modified));
    out
}

/// Saves an upload held in memory and returns its file name (tests and
/// small files; the API streams uploads to disk instead).
#[cfg(test)]
pub fn save(dir: &Path, bytes: &[u8], original_name: &str, now_ms: i64) -> Result<String> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".upload-{}.part", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, bytes)?;
    place(dir, &tmp, &safe_stem(original_name), &ext_for(bytes, original_name), now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_images_by_content() {
        assert_eq!(image_ext(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(image_ext(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(image_ext(b"GIF89a..."), Some("gif"));
        assert_eq!(image_ext(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(image_ext(b"<svg xmlns=...>"), None);
        assert_eq!(image_ext(b"<html>"), None);
    }

    #[test]
    fn names_are_safe() {
        assert_eq!(safe_stem("Screenshot 2026-11-11 at 10.00.png"), "Screenshot_2026-11-11_at_10_00");
        assert_eq!(safe_stem("../../etc/passwd"), "passwd");
        assert_eq!(safe_stem(""), "file");
        assert_eq!(safe_stem("日本.png"), "file");
        assert!(valid_name("image_1_0.png"));
        assert!(!valid_name("../blockseq.db"));
        assert!(!valid_name(".hidden"));
        assert!(!valid_name("a/b.png"));
    }

    #[test]
    fn saves_without_collisions() {
        let dir = std::env::temp_dir().join(format!("blockseq-test-{}", std::process::id()));
        let png = b"\x89PNG\r\n\x1a\nxx";
        let a = save(&dir, png, "shot.png", 42).unwrap();
        let b = save(&dir, png, "shot.png", 42).unwrap();
        assert_eq!((a.as_str(), b.as_str()), ("shot_42_0.png", "shot_42_1.png"));
        // Claims to be a PNG but isn't one: stored as .bin.
        assert_eq!(save(&dir, b"not an image", "x.png", 42).unwrap(), "x_42_0.bin");
        assert_eq!(save(&dir, b"hello", "notes.TXT", 42).unwrap(), "notes_42_0.txt");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn files_are_served_safely() {
        assert_eq!(kind_of("a.MP4"), "video");
        assert_eq!(kind_of("a.flac"), "audio");
        assert_eq!(kind_of("a.docx"), "other");
        assert_eq!(ext_for(b"%PDF-1.4", "x"), "pdf");
        assert_eq!(ext_for(b"PK..", "Report.DOCX"), "docx");
        assert_eq!(ext_for(b"<svg>", "evil.svg"), "svg");
        let (ct, inline, _) = serve_policy("evil.svg");
        assert_eq!((ct.as_str(), inline), ("application/octet-stream", false));
        let (ct, inline, _) = serve_policy("page.html");
        assert_eq!((ct.as_str(), inline), ("application/octet-stream", false));
        let (ct, inline, csp) = serve_policy("notes.txt");
        assert_eq!((ct.as_str(), inline, csp), ("text/plain; charset=utf-8", true, Some("sandbox")));
        assert!(serve_policy("clip.mp4").1);
    }
}
