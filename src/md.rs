//! Text helpers: journal page names, link extraction and the Logseq-style
//! Markdown mirror that is written next to the database.

use std::collections::BTreeMap;

use crate::db::Block;

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn ordinal(day: u32) -> &'static str {
    match (day % 10, day % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    }
}

#[cfg(test)]
/// Formats a day (yyyymmdd) the way Logseq names journal pages: "Nov 11th, 2026".
pub fn journal_name(day: i64) -> String {
    let (y, m, d) = (day / 10000, (day / 100) % 100, (day % 100) as u32);
    format!("{} {}{}, {}", MONTHS[(m - 1) as usize], d, ordinal(d), y)
}

/// Parses a journal page name ("Nov 11th, 2026") into yyyymmdd.
pub fn parse_journal_name(name: &str) -> Option<i64> {
    let (month, rest) = name.trim().split_once(' ')?;
    let m = MONTHS.iter().position(|x| x.eq_ignore_ascii_case(month))? as i64 + 1;
    let (day_part, year) = rest.split_once(", ")?;
    let digits: String = day_part.chars().take_while(|c| c.is_ascii_digit()).collect();
    let d: u32 = digits.parse().ok()?;
    if day_part[digits.len()..] != *ordinal(d) {
        return None;
    }
    let y: i32 = year.trim().parse().ok()?;
    chrono::NaiveDate::from_ymd_opt(y, m as u32, d)?;
    Some(y as i64 * 10000 + m * 100 + d as i64)
}

/// Returns every page a block links to (`[[page]]`, `#[[page]]`, `#tag`,
/// `tags:: a, b`), keyed by lowercase name, with the name as first written.
pub fn extract_refs(content: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    scan_refs(content, |name, _| {
        out.entry(name.to_lowercase()).or_insert_with(|| name.to_string());
    });
    out
}

/// Lowercase names used as tags (`#tag`, `#[[tag]]`, `tags::`) rather than
/// plain `[[links]]`.
pub fn extract_tags(content: &str) -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    scan_refs(content, |name, tag| {
        if tag {
            out.insert(name.to_lowercase());
        }
    });
    out
}

/// Calls `add(name, is_tag)` for every link or tag in a block.
fn scan_refs(content: &str, mut add: impl FnMut(&str, bool)) {
    // Ignore anything inside inline code or code fences.
    let mut text = String::with_capacity(content.len());
    for (i, part) in content.split('`').enumerate() {
        if i % 2 == 0 {
            text.push_str(part);
        }
        text.push(' ');
    }

    let mut rest = text.as_str();
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        match after.find("]]") {
            Some(end) => {
                let name = after[..end].trim();
                if !name.is_empty() && !name.contains('\n') {
                    add(name, rest[..start].ends_with('#'));
                }
                rest = &after[end + 2..];
            }
            None => break,
        }
    }

    let chars: Vec<char> = text.chars().collect();
    for i in 0..chars.len() {
        if chars[i] != '#' || (i > 0 && !chars[i - 1].is_whitespace() && chars[i - 1] != '(') {
            continue;
        }
        let tag: String = chars[i + 1..]
            .iter()
            .take_while(|c| !c.is_whitespace() && !",.!?;:()[]\"'`#".contains(**c))
            .collect();
        if !tag.is_empty() {
            add(&tag, true);
        }
    }

    for line in text.lines() {
        if let Some(v) = line.trim_start().strip_prefix("tags::") {
            for t in v.split(',') {
                let t = t.trim().trim_start_matches('#');
                let t = t.trim_start_matches("[[").trim_end_matches("]]").trim();
                if !t.is_empty() {
                    add(t, true);
                }
            }
        }
    }
}

/// Renders blocks (pre-order, with parent ids) as a Logseq Markdown file.
pub fn page_to_markdown(blocks: &[Block]) -> String {
    let mut depth = std::collections::HashMap::<&str, usize>::new();
    let mut out = String::new();
    for b in blocks {
        let d = b
            .parent_id
            .as_deref()
            .and_then(|p| depth.get(p))
            .map(|d| d + 1)
            .unwrap_or(0);
        depth.insert(&b.id, d);
        let indent = "\t".repeat(d);
        let mut lines = b.content.split('\n');
        match lines.next() {
            Some(first) if !first.is_empty() => out.push_str(&format!("{indent}- {first}\n")),
            _ => out.push_str(&format!("{indent}-\n")),
        }
        for line in lines {
            out.push_str(&format!("{indent}  {line}\n"));
        }
        if b.collapsed {
            out.push_str(&format!("{indent}  collapsed:: true\n"));
        }
    }
    out
}

/// File name used for the Markdown mirror, following Logseq's conventions.
pub fn mirror_path(name: &str, journal_day: Option<i64>) -> String {
    if let Some(day) = journal_day {
        return format!(
            "journals/{:04}_{:02}_{:02}.md",
            day / 10000,
            (day / 100) % 100,
            day % 100
        );
    }
    let mut file = String::new();
    for c in name.chars() {
        match c {
            '/' => file.push_str("___"),
            '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*' => {
                file.push_str(&format!("%{:02X}", c as u32))
            }
            c if c.is_control() => {}
            c => file.push(c),
        }
    }
    if file.starts_with('.') {
        file.replace_range(0..1, "%2E");
    }
    format!("pages/{file}.md")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_names_round_trip() {
        for day in [20261111, 20260101, 20260302, 20260323, 20261212, 20260231] {
            let name = journal_name(day);
            if day == 20260231 {
                assert_eq!(parse_journal_name(&name), None);
            } else {
                assert_eq!(parse_journal_name(&name), Some(day), "{name}");
            }
        }
        assert_eq!(journal_name(20261111), "Nov 11th, 2026");
        assert_eq!(journal_name(20260122), "Jan 22nd, 2026");
        assert_eq!(parse_journal_name("Nov 11st, 2026"), None);
        assert_eq!(parse_journal_name("Project ideas"), None);
    }

    #[test]
    fn refs_are_extracted() {
        let refs = extract_refs("Met [[Alice Smith]] about #rust and #[[Big Plans]]. `[[not a ref]]`\ntags:: work, [[home]]");
        let names: Vec<&str> = refs.values().map(String::as_str).collect();
        assert_eq!(names, ["Alice Smith", "Big Plans", "home", "rust", "work"]);
        assert!(extract_refs("# Heading and a#b").is_empty());
        let tags: Vec<String> = extract_tags("Met [[Alice Smith]] about #rust and #[[Big Plans]]\ntags:: work").into_iter().collect();
        assert_eq!(tags, ["big plans", "rust", "work"]);
    }

    #[test]
    fn markdown_export() {
        let b = |id: &str, parent: Option<&str>, content: &str, collapsed| Block {
            id: id.into(),
            parent_id: parent.map(String::from),
            content: content.into(),
            collapsed,
        };
        let md = page_to_markdown(&[
            b("a", None, "one", false),
            b("b", Some("a"), "two\nmore", true),
            b("c", Some("b"), "", false),
            b("d", None, "three", false),
        ]);
        assert_eq!(
            md,
            "- one\n\t- two\n\t  more\n\t  collapsed:: true\n\t\t-\n- three\n"
        );
        assert_eq!(mirror_path("a/b: c", None), "pages/a___b%3A c.md");
        assert_eq!(mirror_path("x", Some(20261111)), "journals/2026_11_11.md");
    }
}
