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
        // "#+BEGIN_TIP" and friends are Logseq directives, not tags.
        if !tag.is_empty() && !tag.starts_with('+') {
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
    let mut blocks = blocks;
    // A first block of only "key:: value" lines is the page's properties,
    // which Logseq writes at the top of the file without a dash.
    if let Some(first) = blocks.first() {
        let props_only = first.parent_id.is_none()
            && !first.content.trim().is_empty()
            && !blocks.iter().any(|b| b.parent_id.as_deref() == Some(first.id.as_str()))
            && first.content.lines().all(|l| {
                l.split_once("::").is_some_and(|(k, _)| {
                    !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
                })
            });
        if props_only {
            out.push_str(&first.content);
            out.push_str("\n\n");
            blocks = &blocks[1..];
        }
    }
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

/// True when a block starts with one of the task status words
/// ("TODO Buy milk"), which makes it a task.
pub fn is_task(content: &str, words: &[String]) -> bool {
    let first = content.split(|c: char| c.is_whitespace()).next().unwrap_or("");
    !first.is_empty() && words.iter().any(|w| w == first)
}

/// Page name for a file in a Logseq graph: `pages/foo___bar.md` → "foo/bar",
/// `journals/2026_11_11.md` → "Nov 11th, 2026". `None` for other files.
pub fn page_name_from_file(folder: &str, file_stem: &str) -> Option<String> {
    if folder == "journals" {
        let parts: Vec<&str> = file_stem.split(['_', '-']).collect();
        if let [y, m, d] = parts[..] {
            let (y, m, d): (i64, i64, i64) = (y.parse().ok()?, m.parse().ok()?, d.parse().ok()?);
            chrono::NaiveDate::from_ymd_opt(y as i32, m as u32, d as u32)?;
            return Some(journal_name(y * 10000 + m * 100 + d));
        }
        return None;
    }
    // Undo Logseq's file-name escaping: "___" for "/", %XX for reserved chars.
    let name = file_stem.replace("___", "/");
    let bytes = name.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit()
        {
            let hex = |c: u8| (c as char).to_digit(16).unwrap() as u8;
            out.push(hex(bytes[i + 1]) * 16 + hex(bytes[i + 2]));
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    let name = String::from_utf8(out).ok()?;
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Parses a Logseq Markdown page ("- block" lines, tab or space indented)
/// into blocks in document order. `id::` and `collapsed::` lines become the
/// block's id and collapsed flag; other properties stay in the text. Lines
/// before the first "- " (page properties) become the first block.
pub fn parse_outline(text: &str) -> Vec<Block> {
    struct Open {
        indent: usize,
        id: String,
    }
    let mut blocks: Vec<Block> = Vec::new();
    let mut stack: Vec<Open> = Vec::new();
    let mut content_col = 0usize; // where the current block's text starts
    let mut in_fence = false;
    let mut preamble: Vec<String> = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    let width = |line: &str| -> usize {
        let mut w = 0;
        for c in line.chars() {
            match c {
                '\t' => w += 2,
                ' ' => w += 1,
                _ => break,
            }
        }
        w
    };

    for raw in text.replace("\r\n", "\n").split('\n') {
        let trimmed = raw.trim_start();
        let is_item = !in_fence && (trimmed == "-" || trimmed.starts_with("- "));
        if is_item {
            let indent = width(raw);
            while stack.last().is_some_and(|o| o.indent >= indent) {
                stack.pop();
            }
            let id = uuid::Uuid::new_v4().to_string();
            blocks.push(Block {
                id: id.clone(),
                parent_id: stack.last().map(|o| o.id.clone()),
                content: trimmed.strip_prefix('-').unwrap_or("").trim_start().to_string(),
                collapsed: false,
            });
            stack.push(Open { indent, id });
            content_col = indent + 2;
            in_fence = blocks.last().unwrap().content.trim_start().starts_with("```");
            continue;
        }
        let Some(block) = blocks.last_mut() else {
            if !trimmed.is_empty() {
                preamble.push(trimmed.to_string());
            }
            continue;
        };
        // Continuation line: strip the block's indentation.
        let mut line = raw;
        let mut w = 0;
        while w < content_col {
            match line.chars().next() {
                Some('\t') => { w += 2; line = &line[1..]; }
                Some(' ') => { w += 1; line = &line[1..]; }
                _ => break,
            }
        }
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence {
            let t = line.trim();
            if let Some(v) = t.strip_prefix("id::") {
                let v = v.trim();
                if uuid::Uuid::parse_str(v).is_ok() && seen_ids.insert(v.to_string()) {
                    let old = std::mem::replace(&mut block.id, v.to_string());
                    if let Some(o) = stack.last_mut() { if o.id == old { o.id = v.to_string(); } }
                }
                continue;
            }
            if let Some(v) = t.strip_prefix("collapsed::") {
                block.collapsed = v.trim() == "true";
                continue;
            }
        }
        block.content.push('\n');
        block.content.push_str(line);
    }
    for b in &mut blocks {
        let trimmed = b.content.trim_end().len();
        b.content.truncate(trimmed);
    }
    if !preamble.is_empty() {
        blocks.insert(0, Block {
            id: uuid::Uuid::new_v4().to_string(),
            parent_id: None,
            content: preamble.join("\n"),
            collapsed: false,
        });
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logseq_outline_is_parsed() {
        let text = "title:: Plans\n- One\n\tid:: 6f9619ff-8b86-d011-b42d-00cf4fc964ff\n\t- Child\n\t  second line\n\t  collapsed:: true\n\t\t- Grandchild\n- ```bash\n  - not a block\n  ```\n- Two";
        let b = parse_outline(text);
        let c: Vec<&str> = b.iter().map(|b| b.content.as_str()).collect();
        assert_eq!(c, ["title:: Plans", "One", "Child\nsecond line", "Grandchild", "```bash\n- not a block\n```", "Two"]);
        assert_eq!(b[1].id, "6f9619ff-8b86-d011-b42d-00cf4fc964ff");
        assert_eq!(b[2].parent_id.as_deref(), Some("6f9619ff-8b86-d011-b42d-00cf4fc964ff"));
        assert_eq!(b[3].parent_id.as_deref(), Some(b[2].id.as_str()));
        assert!(b[2].collapsed);
        assert_eq!(b[4].parent_id, None);
    }

    #[test]
    fn logseq_file_names() {
        assert_eq!(page_name_from_file("pages", "foo___bar").as_deref(), Some("foo/bar"));
        assert_eq!(page_name_from_file("pages", "a%3Ab").as_deref(), Some("a:b"));
        assert_eq!(page_name_from_file("pages", "50%é").as_deref(), Some("50%é"));
        assert_eq!(page_name_from_file("journals", "2026_11_11").as_deref(), Some("Nov 11th, 2026"));
        assert_eq!(page_name_from_file("journals", "notes"), None);
        assert!(is_task("TODO buy milk", &["TODO".into()]));
        assert!(!is_task("TODOS", &["TODO".into()]));
    }

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
        assert!(extract_refs("#+BEGIN_TIP\nhello\n#+END_TIP").is_empty());
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
