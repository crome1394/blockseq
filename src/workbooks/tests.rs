use super::*;

#[test]
fn a_failed_move_puts_everything_back() {
    let root = std::env::temp_dir().join(format!("bq-moveback-{}", uuid::Uuid::new_v4()));
    let (from, to) = (root.join("from"), root.join("to"));
    std::fs::create_dir_all(from.join("pages")).unwrap();
    std::fs::write(from.join("blockseq.db"), "db").unwrap();
    std::fs::write(from.join("pages/a.md"), "- a").unwrap();
    std::fs::create_dir_all(to.join("pages")).unwrap(); // in the way
    assert!(move_items(&from, &to, &MAIN_ITEMS).is_err());
    assert_eq!(std::fs::read_to_string(from.join("blockseq.db")).unwrap(), "db");
    assert!(from.join("pages/a.md").is_file());
    assert!(!to.join("blockseq.db").exists());
    std::fs::remove_dir_all(&root).unwrap();
}

/// A backup zip of a workbook holding one page `name` with `text`.
fn backup_of(root: &Path, name: &str, text: &str) -> PathBuf {
    let src = root.join(format!("src-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(src.join("assets")).unwrap();
    std::fs::write(src.join("assets/pic.png"), "png").unwrap();
    {
        let conn = db::open(&src.join(DB_FILE)).unwrap();
        db::save_page(&conn, name, 0, &[block("r1", text)], &[]).unwrap();
    }
    let stage = root.join(format!("stage-{}", uuid::Uuid::new_v4()));
    let db_copy = backup::stage_snapshot(&src, &stage, None).unwrap();
    let zip = root.join(format!("{name}.zip"));
    let config = root.join("backup-config.json");
    crate::config::Config::default().save(&config).unwrap();
    backup::write_zip("src", &stage, &db_copy, &config, &zip).unwrap();
    zip
}

fn page_names(wb: &Workbook) -> Vec<String> {
    db::list_pages(&wb.db.lock()).unwrap().into_iter().map(|p| p.name).collect()
}

#[test]
fn restore_into_main_sets_the_old_main_aside() {
    let root = std::env::temp_dir().join(format!("bq-rmain-{}", uuid::Uuid::new_v4()));
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("config.json"), "{}").unwrap();
    let reg = Registry::new(data.clone());
    let main = reg.get(MAIN, &[]).unwrap().unwrap();
    db::save_page(&main.db.lock(), "Old page", 0, &[block("o1", "old text")], &[]).unwrap();
    drop(main);

    // Kept as a workbook.
    let zip = backup_of(&root, "Restored page", "new text");
    let done = reg.restore_into_main(&zip, None, 1 << 30, Some("Main before")).unwrap();
    assert_eq!(done.set_aside, data.join("workbooks/Main before"));
    let main = reg.get(MAIN, &[]).unwrap().unwrap();
    assert_eq!(page_names(&main), vec!["Restored page"]);
    assert!(main.assets_dir().join("pic.png").is_file());
    let kept = reg.get("Main before", &[]).unwrap().unwrap();
    assert_eq!(page_names(&kept), vec!["Old page"]);
    // Shared files stay.
    assert_eq!(std::fs::read_to_string(data.join("config.json")).unwrap(), "{}");
    drop(main);

    // To the trash this time; restoring the wrong file is undone the same way.
    let zip2 = backup_of(&root, "Second", "again");
    let done = reg.restore_into_main(&zip2, None, 1 << 30, None).unwrap();
    assert!(done.set_aside.starts_with(data.join("workbooks").join(TRASH)));
    let trashed = db::open(&done.set_aside.join(DB_FILE)).unwrap();
    assert_eq!(db::list_pages(&trashed).unwrap()[0].name, "Restored page");
    let main = reg.get(MAIN, &[]).unwrap().unwrap();
    assert_eq!(page_names(&main), vec!["Second"]);
    assert!(!std::fs::read_dir(data.join("workbooks")).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(RESTORING_MAIN)));

    // A bad zip changes nothing.
    let junk = root.join("junk.zip");
    std::fs::write(&junk, "not a zip").unwrap();
    assert!(reg.restore_into_main(&junk, None, 1 << 30, None).is_err());
    assert_eq!(page_names(&reg.get(MAIN, &[]).unwrap().unwrap()), vec!["Second"]);
    // A name that is taken is refused before anything moves.
    assert!(reg.restore_into_main(&zip, None, 1 << 30, Some("Main before")).is_err());
    assert_eq!(page_names(&reg.get(MAIN, &[]).unwrap().unwrap()), vec!["Second"]);
    drop((main, trashed));
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn mirror_files_under_an_old_name_are_set_aside() {
    let dir = std::env::temp_dir().join(format!("bq-stale-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("pages")).unwrap();
    for f in ["my_page.md", "my%5Fpage.md", "notes.md", "Notes.md", "unrelated_file.md", "my_page.txt", ".my_page.md"] {
        std::fs::write(dir.join("pages").join(f), "- x\n").unwrap();
    }
    let names = vec!["my_page".to_string(), "Notes".to_string()];
    // notes.md is left from before the page was renamed to Notes.
    assert_eq!(set_aside_stale_mirror_files(&dir, &names), 2);
    assert!(!dir.join("pages/my_page.md").exists());
    assert!(!dir.join("pages/notes.md").exists());
    assert!(dir.join(STALE_MIRROR).join("my_page.md").exists());
    assert!(dir.join(STALE_MIRROR).join("notes.md").exists());
    // A second stale copy of the same name does not replace the first.
    std::fs::write(dir.join("pages/my_page.md"), "- again\n").unwrap();
    assert_eq!(set_aside_stale_mirror_files(&dir, &names), 1);
    assert!(dir.join(STALE_MIRROR).join("my_page.1.md").exists());
    for kept in ["my%5Fpage.md", "Notes.md", "unrelated_file.md", "my_page.txt", ".my_page.md"] {
        assert!(dir.join("pages").join(kept).exists(), "{kept}");
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

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
fn a_failed_move_keeps_the_same_connections() {
    let root = std::env::temp_dir().join(format!("bq-move-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let reg = Registry::new(root.clone());
    reg.create("Stay").unwrap();
    reg.create("Other").unwrap();
    let stay = reg.get("Stay", &[]).unwrap().unwrap();
    let other = reg.get("Other", &[]).unwrap().unwrap();
    db::save_page(&stay.db.lock(), "Kept", 0, &[block("s1", "still here")], &[]).unwrap();
    // A file where the folder should go. The rename fails after the checkpoint.
    let dst = root.join("workbooks/Taken");
    std::fs::write(&dst, "not a folder").unwrap();
    assert!(reg.move_closed("Stay", &root.join("workbooks/Stay"), &dst).is_err());
    let again = reg.get("Stay", &[]).unwrap().unwrap();
    assert!(std::sync::Arc::ptr_eq(&stay, &again), "the failed move opened a second database");
    assert!(db::get_page(&again.db.lock(), "Kept").unwrap().is_some());
    assert!(std::sync::Arc::ptr_eq(&other, &reg.get("Other", &[]).unwrap().unwrap()));
    // The same open connections can still be checkpointed and the folder renamed.
    assert_eq!(reg.rename("Stay", "Later").unwrap().id, "Later");
    assert!(stay.retired.load(std::sync::atomic::Ordering::SeqCst));
    assert!(reg.get("Stay", &[]).unwrap().is_none());
    let later = reg.get("Later", &[]).unwrap().unwrap();
    assert!(!std::sync::Arc::ptr_eq(&stay, &later));
    assert!(db::get_page(&later.db.lock(), "Kept").unwrap().is_some());
    drop((stay, again, other, later, reg));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn uploads_leave_a_reserve_and_count_together() {
    assert!(space_fits(DISK_RESERVE + 256, 0, 256, DISK_RESERVE));
    assert!(!space_fits(DISK_RESERVE + 255, 0, 256, DISK_RESERVE));
    // The second upload is refused while the first still holds its cap.
    let mut reserved = 0u64;
    let free = DISK_RESERVE + 256;
    assert!(space_fits(free, reserved, 256, DISK_RESERVE));
    reserved += 256;
    assert!(!space_fits(free, reserved, 256, DISK_RESERVE));
    assert!(space_fits(free, reserved, 0, DISK_RESERVE));
    assert!(!space_fits(10, 50, 1, 1));
    assert!(free_bytes(std::env::temp_dir().as_path()).unwrap() > 0);
}

#[test]
fn workbook_paths_stay_inside_the_data_folder() {
    let root = std::env::temp_dir().join(format!("bq-rel-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let reg = Registry::new(root.clone());
    reg.create("Other").unwrap();
    let list = reg.list();
    assert_eq!(list[0].path, ".");
    assert_eq!(list.iter().find(|w| w.id == "Other").unwrap().path, "workbooks/Other");
    assert!(list.iter().all(|w| !w.path.starts_with('/') && !w.path.contains(':')));
    let trash = reg.delete("Other").unwrap();
    let rel = relative_path(&root, &trash);
    assert!(rel.starts_with("workbooks/.trash/"), "{rel}");
    assert!(!rel.starts_with('/'));
    drop(reg);
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

#[test]
fn a_failed_logseq_import_keeps_the_markdown_and_retries() {
    let root = std::env::temp_dir().join(format!("bq-logseq-{}", uuid::Uuid::new_v4()));
    let graph = root.join("workbooks/Graph");
    std::fs::create_dir_all(graph.join("pages")).unwrap();
    let alpha = "- from alpha\n";
    let beta = "title:: Alpha\n- from beta\n";
    std::fs::write(graph.join("pages/Alpha.md"), alpha).unwrap();
    std::fs::write(graph.join("pages/Beta.md"), beta).unwrap();
    // A directory where the partial database should go makes the import fail
    // before any page is written.
    std::fs::create_dir_all(graph.join("blockseq.db.partial")).unwrap();
    let reg = Registry::new(root.clone());
    assert!(reg.get("Graph", &[]).is_err());
    assert!(!graph.join("blockseq.db").exists());
    assert_eq!(std::fs::read_to_string(graph.join("pages/Alpha.md")).unwrap(), alpha);
    assert!(!graph.join("logseq-original").exists());

    std::fs::remove_dir_all(graph.join("blockseq.db.partial")).unwrap();
    let wb = reg.get("Graph", &[]).unwrap().unwrap();
    assert!(graph.join("blockseq.db").is_file());
    assert!(!graph.join("blockseq.db.partial").exists());
    let conn = wb.db.lock();
    let page = db::get_page(&conn, "Alpha").unwrap().unwrap();
    let text: String = db::get_blocks(&conn, &page.id).unwrap().into_iter().map(|b| b.content).collect::<Vec<_>>().join("\n");
    assert!(text.contains("from alpha"), "{text}");
    assert!(text.contains("from beta"), "{text}");
    let kept = db::history(&conn, "Alpha").unwrap();
    assert!(kept.iter().any(|e| e.reason.contains("same name")), "{kept:?}");
    drop(conn);
    assert_eq!(std::fs::read_to_string(graph.join("logseq-original/pages/Alpha.md")).unwrap(), alpha);
    assert_eq!(std::fs::read_to_string(graph.join("logseq-original/pages/Beta.md")).unwrap(), beta);
    drop(wb);
    drop(reg);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_save_that_does_not_stick_fails_the_import() {
    let dir = std::env::temp_dir().join(format!("bq-imp-err-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("pages")).unwrap();
    std::fs::write(dir.join("pages/Hello.md"), "- hello\n").unwrap();
    std::fs::write(dir.join("pages/Second.md"), "- second\n").unwrap();
    let conn = db::open(&dir.join("t.db")).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER fail_second BEFORE INSERT ON pages WHEN NEW.name = 'Second' BEGIN SELECT RAISE(ABORT, 'disk trouble'); END;",
    )
    .unwrap();
    let err = import_logseq(&conn, &dir, &[]).unwrap_err();
    let msg = format!("{err:#}");
    assert!(msg.contains("Second") || msg.contains("disk trouble"), "{msg}");
    drop(conn);
    std::fs::remove_dir_all(dir).unwrap();
}
