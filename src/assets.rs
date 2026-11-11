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

/// A safe file-name stem from the uploaded file's name ("Screenshot 1.png" →
/// "Screenshot_1"), or "image" if nothing usable is left.
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
    if cleaned.is_empty() { "image".into() } else { cleaned }
}

/// True for names this module could have created: no paths, no hidden files.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && !name.starts_with('.')
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// File type from the first bytes: an image type, or "pdf".
pub fn file_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"%PDF-") { Some("pdf") } else { image_ext(bytes) }
}

pub struct AssetInfo {
    pub name: String,
    pub size: u64,
    pub modified: i64,
    /// "image", "pdf" or "other".
    pub kind: &'static str,
}

/// Lists the files in an assets folder, newest first.
pub fn list(dir: &Path) -> Result<Vec<AssetInfo>> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(out) };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Some(name) = entry.file_name().to_str().map(String::from) else { continue };
        if !meta.is_file() || !valid_name(&name) {
            continue;
        }
        let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        let kind = match ext.as_str() {
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" => "image",
            "pdf" => "pdf",
            _ => "other",
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(AssetInfo { name, size: meta.len(), modified, kind });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

/// Saves an upload and returns its file name, e.g. "image_1762870000000_0.png".
pub fn save(dir: &Path, bytes: &[u8], original_name: &str, now_ms: i64) -> Result<String> {
    let Some(ext) = file_ext(bytes) else {
        bail!("not a supported file (PNG, JPEG, GIF, WebP, AVIF or PDF)");
    };
    std::fs::create_dir_all(dir)?;
    let stem = safe_stem(original_name);
    for i in 0..1000 {
        let name = format!("{stem}_{now_ms}_{i}.{ext}");
        let path = dir.join(&name);
        // create_new fails if the file exists, so names never collide.
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(bytes)?;
                file.sync_all()?;
                return Ok(name);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    bail!("could not pick a file name")
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
        assert_eq!(safe_stem(""), "image");
        assert_eq!(safe_stem("日本.png"), "image");
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
        assert!(save(&dir, b"not an image", "x.png", 42).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
