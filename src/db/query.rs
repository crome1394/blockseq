//! Reads for lists and lookups: All pages, the sidebar, page names,
//! journals, backlinks, search and single blocks.

use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::{Backlinks, BlockHit, get_blocks, JournalPage, PAGE_COLS, page_from_row, PageSummary, SearchResults};

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
                p.block_count, p.favorite, p.words
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
