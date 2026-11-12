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

/// Every block has exactly one search row, found through its `search_id`.
fn assert_index_in_step(c: &Connection) {
    let blocks: i64 = c.query_row("SELECT count(*) FROM blocks", [], |r| r.get(0)).unwrap();
    let rows: i64 = c.query_row("SELECT count(*) FROM blocks_fts", [], |r| r.get(0)).unwrap();
    let linked: i64 = c
        .query_row(
            "SELECT count(*) FROM blocks b JOIN blocks_fts f ON f.rowid = b.search_id AND f.block_id = b.id",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!((rows, linked), (blocks, blocks));
}

#[test]
fn search_rows_follow_saves_moves_and_deletes() {
    let c = mem();
    let saved = |name: &str, v: i64, blocks: &[Block]| match save_page(&c, name, v, blocks, &[]).unwrap() {
        SaveOutcome::Saved(p) => p.version,
        _ => panic!("not saved"),
    };
    let v = saved("A", 0, &[block("a1", None, "apple"), block("a2", None, "banana")]);
    saved("B", 0, &[block("b1", None, "cherry")]);
    assert_index_in_step(&c);
    saved("A", v, &[block("a1", None, "apricot")]);
    assert_index_in_step(&c);
    assert!(search(&c, "banana", 10).unwrap().blocks.is_empty());
    assert_eq!(search(&c, "apri", 10).unwrap().blocks.len(), 1);
    // Merging moves B's block (same id) onto A.
    rename_page(&c, "B", "A", &[]).unwrap();
    assert_index_in_step(&c);
    let hits = search(&c, "cherry", 10).unwrap().blocks;
    assert_eq!(hits.iter().map(|h| h.page_name.as_str()).collect::<Vec<_>>(), ["A"]);
    delete_page(&c, "A").unwrap();
    assert_index_in_step(&c);
    assert!(search(&c, "cherry", 10).unwrap().blocks.is_empty());
}

#[test]
fn upgrade_to_v7_links_existing_blocks_to_search_rows() {
    let dir = std::env::temp_dir().join(format!("bq-open-v6-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("blockseq.db");
    {
        let c = open(&path).unwrap();
        save_page(&c, "Old", 0, &[block("o1", None, "legacy words"), block("o2", None, "more")], &[]).unwrap();
        // Back to a v6 database: no search ids, rows keyed only by block_id.
        c.execute_batch(
            "UPDATE blocks SET search_id = NULL;
             DELETE FROM blocks_fts;
             INSERT INTO blocks_fts(block_id, content) SELECT id, content FROM blocks;
             PRAGMA user_version = 6;",
        )
        .unwrap();
    }
    let c = open(&path).unwrap();
    assert_index_in_step(&c);
    assert_eq!(search(&c, "legacy", 10).unwrap().blocks.len(), 1);
    let v = get_page(&c, "Old").unwrap().unwrap().version;
    save_page(&c, "Old", v, &[block("o1", None, "fresh")], &[]).unwrap();
    assert_index_in_step(&c);
    assert!(search(&c, "legacy", 10).unwrap().blocks.is_empty());
    drop(c);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Stored block and word counts match the blocks each page holds.
fn assert_counts_in_step(c: &Connection) {
    let wrong: Vec<(String, i64, i64)> = c
        .prepare(
            "SELECT p.name, p.block_count, (SELECT COUNT(*) FROM blocks b WHERE b.page_id = p.id) FROM pages p
             WHERE p.block_count <> (SELECT COUNT(*) FROM blocks b WHERE b.page_id = p.id)",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(wrong.is_empty(), "{wrong:?}");
    for p in list_pages(c).unwrap() {
        let page = get_page(c, &p.name).unwrap().unwrap();
        let words: i64 = get_blocks(c, &page.id).unwrap().iter().map(|b| word_count(&b.content)).sum();
        assert_eq!(p.words, words, "{}", p.name);
    }
}

#[test]
fn page_block_counts_follow_saves_and_merges() {
    let c = mem();
    save_page(&c, "A", 0, &[block("a1", None, "one two"), block("a2", Some("a1"), "three")], &[]).unwrap();
    save_page(&c, "B", 0, &[block("b1", None, "four")], &[]).unwrap();
    assert_counts_in_step(&c);
    let v = get_page(&c, "A").unwrap().unwrap().version;
    save_page(&c, "A", v, &[block("a1", None, "one")], &[]).unwrap();
    assert_counts_in_step(&c);
    rename_page(&c, "B", "A", &[]).unwrap();
    assert_counts_in_step(&c);
    let a = list_pages(&c).unwrap().into_iter().find(|p| p.name == "A").unwrap();
    assert_eq!(a.block_count, 2);
}

#[test]
fn upgrade_to_v8_counts_existing_blocks() {
    let dir = std::env::temp_dir().join(format!("bq-open-v7-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("blockseq.db");
    {
        let c = open(&path).unwrap();
        save_page(&c, "Old", 0, &[block("o1", None, "x"), block("o2", None, "y")], &[]).unwrap();
        c.execute_batch("UPDATE pages SET block_count = 0; PRAGMA user_version = 7;").unwrap();
    }
    let c = open(&path).unwrap();
    assert_counts_in_step(&c);
    assert_eq!(list_pages(&c).unwrap()[0].block_count, 2);
    drop(c);
    let _ = std::fs::remove_dir_all(&dir);
}
