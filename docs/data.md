# Your data and backups

What is stored where, how it is kept safe, and how to back up and restore.

## Where it lives

`/var/lib/blockseq/` (or `./data` locally) contains:

- `config.json` holds settings shared by all devices (task statuses, the
  locked encryption key, Main's name). It is written safely (never half-written)
  and the previous version is kept as `config.json.bak`. If `config.json` is
  ever damaged, Blockseq uses the `.bak` copy, or refuses to start rather than
  start with empty settings (which would lose the encryption key). Back up
  both, along with your recovery key.
- `workbooks/<name>/` holds every workbook except Main, each with the same
  layout as below; `workbooks/.trash/` holds deleted ones.
- The rest of the folder is the **Main** workbook:
- `blockseq.db` is the SQLite database and the source of truth (including the
  page history).
- `pages/*.md` and `journals/*.md` are Markdown copies of every page, in the
  same outline format Logseq's Markdown graphs use, rewritten on every save
  and on every start. They are a readable copy, not an input: **edits made to
  these files are overwritten**.
- `assets/` holds pasted and uploaded files, linked from blocks as
  `![name](../assets/name.png)`. Removing an image from a block keeps the
  file, so undo still works; the Assets page shows which files are unused.

**Coming from Logseq?** The simplest way is to copy your notes across (paste
works: pasted outlines keep their structure). Blockseq can also import a
Logseq graph stored as Markdown files (a folder with `pages/` and
`journals/`): copy the folder into `workbooks/`, or zip it and use *Import
backup…*, and it is imported the first time you open it (the original files
are kept in `logseq-original/`). Newer Logseq versions that keep the graph in
a database instead of Markdown files (the "DB version") can't be imported.

### Keeping data safe over time

- **Page history.** Earlier versions of every page are kept: while you edit,
  one every 10 minutes, and always before a big removal, a "Keep mine" in a
  conflict, a restore, a merge or a deletion (up to 100 per page). Open a
  page's **⋯ → History…** to preview a version and **Restore** it; the version
  it replaces is kept too, so a restore can be undone. Deleted pages can be
  brought back from **All pages → Recently deleted…**. Encrypted blocks stay
  encrypted in the history.
- **Saves are checked.** Each save carries the page version it started from;
  a page changed on another device shows a conflict instead of being
  overwritten, and **Show differences** compares their version with yours
  line by line before you choose. Status changes from the task list are
  refused if the task changed meanwhile. Pasting copied blocks never takes
  them away from the page they came from (the copies get new ids). Renaming a
  page or tag is all or nothing.
- **Unsaved changes survive a crash.** While the server can't be reached, the
  browser keeps a copy of your unsaved changes (encrypted blocks stay
  encrypted). If the tab or browser dies, the page offers to restore them the
  next time you open it.
- **Startup checks.** Each workbook's database gets a quick integrity check
  when it opens (the detail is in the log; `/api/health` says `ok` or
  `error`), and temporary files left by an interrupted upload, export or
  import are removed. On shutdown the database files are tidied so they're
  complete on their own.
- **Upgrades back up first** (see [Upgrading](deploy.md#upgrading)).

### Backup and restore

**Settings → Backup → Download backup** saves the workbook you're in as one
`.zip`: a consistent copy of `blockseq.db` (safe while Blockseq is running),
every page and journal as Markdown, all assets, and `config.json`.

**#Encrypted blocks stay encrypted** in the zip. It contains only the
scrambled text plus the *locked* copies of the key from `config.json`, so a
leaked backup reveals no more than the server does, and after a restore your
password (or recovery key) opens the blocks again. Keep the recovery key
somewhere other than next to your backups.

**Import backup…** (Settings → Backup, or the workbook menu) restores a zip
as a **new** workbook; nothing that exists is changed or overwritten.

Or restore it **into Main**, e.g. on a rebuilt server. Nothing is lost
either way:

- If Main holds anything, it is first saved as a zip in
  `/var/lib/blockseq/backups/` (the last 10 are kept; Settings → Backup lists
  them for download, and Import backup restores one).
- Then Main's files move to the trash (`workbooks/.trash/Main <date>`), or,
  if you tick the box, into a workbook you name.
- If anything fails along the way, Main is left as it was. Restored the
  wrong file? Restore the right one into Main the same way.

For encrypted blocks:

- Same server (same password): they just work.
- A server with no password yet: it starts using the backup's password.
- A server with a different password: you're asked for the backup's old
  password (or its recovery key) once, and the browser re-encrypts those
  blocks with your current password. Until then they show "Encrypted with a
  different password"; click that to do it later.

**Automatic backups** from the server, e.g. a nightly cron job that keeps a
zip of every workbook (works while Blockseq is running). Point `--out` at a
NAS or other machine if you can, so a backup survives losing the server:

```sh
blockseq export --all --out /mnt/backups/blockseq
# or one workbook:  blockseq export "Home Lab" --out /mnt/backups/blockseq
```

A nightly job that keeps 30 days, written as a file in `/etc/cron.d/`:

```sh
cat > /etc/cron.d/blockseq-backup <<'EOF'
15 3 * * * root /usr/local/bin/blockseq export --all --out /mnt/backups/blockseq && find /mnt/backups/blockseq -name 'blockseq-*.zip' -mtime +30 -delete
EOF
```

- It runs at 03:15 as root. Use the full path: cron does not read `.bashrc`.
- Old zips are removed only after a successful export (`&&`), so a failed
  night never deletes the backups you have.
- Each day gets its own file (`blockseq-main-2026-11-12.zip`); a second run
  the same day replaces that day's zip.
- The zips are readable by root only (`-rw-------`). A NAS job that collects
  them as another user cannot read them; run it as root or change the
  permissions after the export.
- Now and then, restore one with **Import backup** as a new workbook to prove
  it works, then delete that workbook.

On the server, the commands find `/var/lib/blockseq` themselves; elsewhere
set `BLOCKSEQ_DATA`. Container or VM snapshots are a good second layer.

Treat backup zips (and `/var/backups/blockseq`) like the data folder itself:
they hold every note in plain text except `#Encrypted` blocks, plus the
locked copy of the encryption key. Keep them somewhere only you can read.
