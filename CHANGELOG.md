# Changelog

All notable changes to Blockseq are listed here, newest first. Each entry ends with the short commit hash it comes from.

## Unreleased

### Added

- **Paired devices.** An app (such as the Android app) pairs once with the password and then uses a token of its own, so the password is not stored on the device. Settings → Security lists paired devices with Revoke. Changing `BLOCKSEQ_PASSWORD` unpairs every device.
- **Strikethrough.** Ctrl+Shift+X strikes through the selection, or the whole first line (status and tags stay outside). The block menu has a Strikethrough item too.

## 0.1.0 (2026-11-12)

The first release (tag `v0.1.0`): everything from `64076f1` (2026-11-11) onwards. Its changes are grouped by theme below; the newest group is first, and the newest change is first inside each section.

Since the last group below: the README became a short overview with the details in [docs/](docs/), screenshots were added (`76ab3fb`), and the unit tests moved into their own files (`30f6dd8`).

Opening an older database upgrades it in place. The current schema is **version 8**.

| Version | What an upgrade adds | Commit |
| --- | --- | --- |
| 8 | Each page stores its block count. | `6417ef4` |
| 7 | Each block stores the rowid of its search-index row, and the index is rebuilt once to fill it. | `8d22396` |
| 6 | History rows store the page id. The index on that column is created during the upgrade, after the column exists. | `3267afc`, `242dc97` |
| 5 | Each kept version stores its block count and word count. | `35d1b87` |
| 4 | Each page stores a word count, and block text is full-text indexed. | `62dea30` |
| 3 | The `page_history` table. Nothing is converted; the table is new. | `319e50b` |
| 2 | Favourites on pages, and tag links marked apart from ordinary links. | `862359e` |

On the move to version 6, history rows whose name matches a page that still exists are attached to that page. Rows left over from deleted pages are grouped one id per name. Copies that already shared a name cannot be split apart.

## Restore into Main, env template, smaller files

### Added

- **Restore into Main.** Import backup can restore into Main instead of as a new workbook. If Main holds anything, it is first saved as `backups/before-restore-<time>.zip` (owner-only, newest 10 kept, listed under Settings → Backup), then its files move to the trash or, if you tick the box, into a workbook you name. A failure at any step leaves Main as it was. Restoring the wrong file is fixed by restoring the right one the same way. (`b0e5d6b`)
- `deploy/blockseq.env.example` lists every setting, commented out with its default, including `BLOCKSEQ_DATA` and `RUST_LOG`. `install.sh` installs it the first time. (`943dd0c`)

### Internal

- The large files are split into modules, with code moved unchanged: `api.rs` → `api/` (`67ba221`), `db.rs` → `db/` (`b28016e`), `editor.js` → `editor.js` plus `secrets.js`, `codeblocks.js`, `blockmenus.js`, `formatbar.js`, `autocomplete.js`, `refs.js`, `menus.js` (`e267f09`), and `app.js` → `app.js` plus `workbooks-ui.js`, `tasks-pane.js`, `allpages.js` (`396c49b`).
- The encryption browser test no longer fails at random under load. (`30868d3`, `cef5e7e`)

## Sign out, stored counts

### Added

- **Sign in and sign out.** With `BLOCKSEQ_PASSWORD` set, browsers sign in on a page and get a session cookie (HttpOnly, SameSite=Lax, Secure behind a trusted HTTPS proxy) that lasts 90 days from last use and survives restarts. **Sign out** is in the header; Settings → Security can also sign out every browser. Changing the password signs every browser out. `sessions.json` holds only hashes. Scripts keep using HTTP basic auth. A browser signed out with unsaved text is sent to the sign-in page and offered that text afterwards. (`b731e77`)

### Changed

- Each page stores its block count (schema 8), so All pages no longer counts every page's blocks on each load. A page that loses blocks to a merge has its word count corrected too. (`6417ef4`)

### Fixed

- Live updates start a new stream after an error response (a proxy's 502 while Blockseq restarts) closed the old one; the status no longer stays on "Reconnecting…" until a reload. (`17c35f7`)
- A local draft whose tab was just left is offered once that tab's lock is released, instead of on the next page load. (`8a05333`)

## Hardening

### Security

- Backup zips are created readable by the owner only (0600), also when a same-day file is overwritten, and the temporary staging copy is 0700. They were 0644 and 0755, so on the command line (root, shared `/tmp`) any local user could read every note and the wrapped key. (`e008712`)
- Listening beyond localhost without `BLOCKSEQ_PASSWORD` logs a warning: `BLOCKSEQ_HOSTS` stops DNS rebinding but not someone who reaches the port by IP address. (`bff0240`)

### Fixed

- Each tab keeps its own local draft, so two tabs of one page can no longer overwrite or delete each other's unsent copy. Opening a page offers the newest copy that never reached the server and skips copies whose tab is still open (Web Locks). A draft that cannot be stored (storage full or blocked) shows a warning instead of failing silently. (`691544f`)
- Markdown files left under an older file name (`my_page.md`, now `my%5Fpage.md`) are moved to the workbook's hidden `.old-mirror-files/` folder after the startup rebuild, so a page has one file and backups do not carry stale text. Nothing is deleted. (`6ab2ebf`, `fa45039`)
- A tab pushed off by the 32-stream live-update cap shows "live updates paused" and reconnects when it is shown again, instead of reconnecting at once and pushing another tab off. (`076052a`)
- `install.sh` waits for `/api/health` after the restart and fails, naming the pre-upgrade backup, when the new version does not come up healthy. (`3b38123`)

### Internal

- Saving and sync moved out of `editor.js` into `sync.js` (autosave, conflicts, keepalive) and `drafts.js` (local drafts), unchanged. (`45d79b1`)
- The `csp` browser test checks that a real PDF renders in the sandboxed preview (checked by hand in Chrome and Firefox). New browser tests: `draft-tabs`, `live-cap`. (`024bff6`, `691544f`, `076052a`)

## Performance and free space

### Fixed

- Backups copy `assets/` after releasing the write lock. Before, the Download backup button and `blockseq export` (which `install.sh` runs before upgrades) held it for the whole asset copy, so saves stalled, and failed with 503 after 5 seconds through the CLI. The database and Markdown are still copied as one moment. (`55341cd`)
- An upload reserves its own size (its Content-Length), not the whole `BLOCKSEQ_MAX_UPLOAD_MB`, so a small paste no longer needs the full limit free. An upload whose declared size is over the limit is refused at once. A restore reserves what the zip says it unpacks to, capped at 4× the limit, and the unpack stops at that size. (`eebd474`)
- Saves no longer slow down as the workbook grows. The search index was cleaned with one full scan per block on every save (about 0.5 s for an 80-block page at 50,000 blocks); rows are now deleted by a rowid each block stores, about 1 ms for the same save. (`8d22396`)

## Cleanup

### Security

- A key-derivation count above 600,000 rounds is refused. That is the count a password already uses. `PUT /api/encryption` rejects a higher count, the terminal password reset stops before running one, and the browser stops before unlocking. The recovery wrap stays at 100,000 rounds. (`c84e658`)

### Changed

- Set `BLOCKSEQ_EXPOSE_PATHS=1` to show full server paths in the browser. Asset lists, workbook entries, the trash location, sidebar usage, and a restored workbook then include an `absolute` field, including through a reverse proxy. The relative `path` stays. Without the flag, a full asset path is still sent only to a browser on this machine with no proxy headers. A fresh `/etc/blockseq.env` documents the flag and leaves it unset. An existing env file is not rewritten. (`b8d4cf3`)

### Internal

- Clippy warnings under the project's own lint settings are cleared. The free-space check still uses `libc` `statvfs`. (`5a425ac`)

## Limits, safety, and repairs

Work from the code review on 2026-11-12. Several of these change what a save, an upload, a backup, or another program calling the API can do.

### Security

- A process keeps at most 32 live-update connections. Opening another ends the oldest tab's stream. A tab that falls behind still receives a reload notice. (`3369903`)
- PDF previews stay in the page, and the file is sent with a sandbox content-security policy so an old viewer cannot treat it as a script on this site. (`4ba1ecb`)
- Listening on anything other than this machine now requires `BLOCKSEQ_PASSWORD` or `BLOCKSEQ_HOSTS`. A fresh install bound to a LAN address no longer starts as an open notes database. The default address remains `127.0.0.1`. (`ff25a77`)
- `X-Forwarded-Host` is trusted only when the connection comes from an address in `BLOCKSEQ_TRUSTED_PROXIES`. Otherwise the browser's own `Origin` is compared with `Host`. A request with no peer address is treated as untrusted. (`76eabe6`)
- When the wrong-password list is full, the oldest client is forgotten. The list no longer clears itself and lets every client try again. The check compares a fixed-length hash of the password. (`6203972`)
- The value returned by the encryption status request can only attach a proof that this browser holds the key. It can no longer replace the stored wrapped key. Setups that have no proof yet gain one on the next password change, including before the notes are unlocked. (`9de4c31`)
- A page name that is empty, starts with `#`, contains `[[` or `]]`, or contains a control character is rejected on save as well as on rename. A journal date is still a valid page name. The Markdown mirror encodes underscores, percent signs, and control characters, so two different titles cannot write one file. (`3493315`)

### Changed

- **Breaking for very large notes.** A page name can be at most 300 characters. One page's stored JSON can be at most 4 MB. History for one page keeps at most 100 versions and 32 MB of snapshots; the oldest copies are dropped first, and the newest copy is kept even when it alone is larger than that. (`56b363c`)
- **Breaking for clients that read absolute paths.** Sidebar disk usage, the asset list, the workbook list, and delete responses now use paths relative to the data folder. Main is `.`. Other workbooks are `workbooks/<id>`. An asset is `assets/<file>`. The absolute path is included only for a browser on this machine with no reverse-proxy headers, so the copy button there still works. (`9492b47`)
- **Breaking if `BLOCKSEQ_MAX_UPLOAD_MB` is unset.** The default upload cap is 256 MB (it was 2048). An upload is refused when free space, after every upload already in progress has reserved its cap, would fall below a 256 MB reserve. Restoring a backup also reserves room for the unpacked files. The editor says "The server does not have enough free space for that." (`1c003e8`)
- **Breaking for a program that parsed only free-text errors.** Failed requests include a short stable code (`invalid`, `storage`, `error`, and `no_space` when the disk reserve would be used up). A short phrase is included only when it cannot contain a file path. The editor retries a save after a network failure or a 503, and leaves other failures until the next edit. A version conflict shows the two copies again. `/api/health` answers `ok` or `error` and keeps the detailed check in the log. (`642ac09`)
- A backup zip is built under the temporary directory, then removed as streaming starts. The download is refused, with "not enough free space to build the backup", when the temp volume could not keep a 256 MB reserve after the staged files and the zip. A save that happens while the zip is compressed is not included: the database and the files are copied together first. (`0fe6945`, `78e413b`)
- Page history follows the page id (schema 6). Renaming a page moves only that page's versions. A deleted page keeps its id, so a new page of the same name starts with an empty history, and restoring the deleted page brings that id back. (`3267afc`)
- The history list reads the stored block and word counts (schema 5) instead of opening every snapshot. Opening one version still loads its text. Older databases fill the counts once during the upgrade. (`35d1b87`)
- Search, the page list, rebuilding the Markdown mirror, and export no longer scan every block on the writer connection. Block text is full-text indexed and each page stores its word count (schema 4). The mirror is rewritten one page at a time after the workbook is open. (`62dea30`)

### Fixed

- A kept version whose stored text does not parse is marked damaged in the history list. It is not offered as an empty page, and Restore stays disabled. Databases already upgraded by an earlier build are detected when the list is opened. (`6e698b8`)
- An existing database from before schema 6 opens again. Startup was creating an index on `page_id` before that column existed, and the service exited. (`242dc97`)
- Closing or renaming a workbook no longer makes every other workbook wait while the database is checkpointed and the folder is moved. A locked database is waited out instead of failing immediately. If the move fails, the same open connections are kept. (`ec399d9`)
- A task-status change is kept once `config.json` is on disk. If rebuilding the task index fails, that failure is logged, and the other open tabs are still told about the new statuses. (`99ba27e`)
- Closing a tab writes the latest text into the browser draft before anything else is sent. A last-moment save is sent only when the body is at most 64 KB, including while another save is in flight. The draft is offered whenever it differs from the server copy. (`f9b309c`)
- Another tab's status change or workbook rename is applied even when the live-update message has no page name. A full reload also refreshes task statuses and the workbook list. (`959a842`)
- Saving a page that another device deleted or renamed no longer creates it again. The editor can leave it deleted or choose Keep mine, which still brings the text back. (`1f2456a`)
- A Logseq import is written to a partial database and renamed into place only after every page has been saved. A failed import leaves the Markdown in place so the next open tries again. A second file for the same page is appended. (`e302a4c`)
- Adopting a restored backup's encryption key writes that key aside before the upload is deleted. If saving settings fails, the zip and the key file both remain. (`157ffe3`)
- A save waits up to five seconds if the database is locked, and the commit is not reported until it is on disk. A power cut cannot drop the last save. The Markdown mirror is still written without its own flush; startup rebuilds it from the database. (`583176f`)

## Tasks, the header, and everyday editing

### Added

- The header shows how much disk space the open workbook uses. The tooltip splits that into the database (including page history), uploaded files, and Markdown copies. Main's figure does not include the other workbooks stored beside it. A top-level folder that is a shortcut to another disk, such as `assets/`, is measured; shortcuts nested further down are not. (`dadf16d`, `cc515eb`)
- The conflict bar can show a line-by-line difference between this browser's text and the server's: lines only on the server, lines only here, and long unchanged stretches folded. Encrypted text is shown as a lock. Keep mine and Use their version are available from that view. (`08fb642`)
- The task list can be driven from the keyboard. `t` opens it. Arrow keys or `j` / `k` move, Space or Ctrl+Enter cycles the status, `s` or Ctrl+Shift+Enter opens the picker, Enter opens the task in the editor, and Esc closes the list. `g e` returns to the last edited block. `g l` locks or unlocks encrypted blocks, the same as the padlock. (`b0870c9`, `c58b1bd`)
- The asset list gained a server-path column and a copy button, with names and paths wrapping onto more than one line. A later change limits the absolute path to a direct connection on this machine; other clients see the workbook-relative path. (`1011e81`, `9492b47`)
- A favourite in the sidebar has a small × that removes the star and leaves the page in place. (`c1cc750`)

### Changed

- Save status, the task list, the padlock, Settings, and help sit in a header across the top. On a phone the header shows the status without the time. The format bar stays below it. (`50f874d`)
- The task list order stays put when a status changes: journals newest first, then other pages by name. A task you just changed remains in the list for a few seconds, even if it no longer matches the filter, so Space can keep cycling. Keyboard focus moves to the task that takes its place when it leaves. (`62a1b90`)
- Today's date on the calendar is a filled circle. The journal you are reading has a ring. (`ac08862`)
- `BLOCKSEQ_TRUSTED_PROXIES` accepts an address copied with its port (`10.0.0.1:24223`). The port is ignored. Unusable entries are logged, and startup logs whether a password is set, which host names are allowed, and which proxies are trusted. (`ecac12c`)
- `reset-encryption-password` and `export` use `/var/lib/blockseq` when that folder already holds a workbook and `./data` does not, and they say which folder they used. (`1e4d7ba`)

### Fixed

- Changing a task's status while that page is open in the same tab no longer makes the page look as if another device had edited it. (`61c46cc`)

### Removed

- "+ New workbook" is no longer on the sidebar. Create, rename, import, and delete are in the workbook menu. (`70ca538`)

## Page history

### Added

- The server keeps earlier copies of a page (schema 3, later attached to the page id in schema 6). A copy is kept when the previous one is more than 10 minutes old, when a save removes a lot of text, and always before Keep mine, a restore, a merge, or a deletion. Identical copies are not stored twice. Up to 100 copies are kept; a later change also limits them by size. Encrypted blocks stay ciphertext. Restoring keeps the version you replace, and blocks whose ids now belong to another page receive new ids. (`319e50b`)
- Every page menu has History…, with a read-only preview and Restore this version. All pages has Recently deleted… for pages that can be brought back. The delete confirmation says how. Keep mine tells the server to keep the other device's version first. (`6bb1a67`)

## Encryption and backups

### Added

- A block tagged `#Encrypted` encrypts its children in the browser (AES-256-GCM). The server, the database, the Markdown mirror, and clipboard copies hold only ciphertext. One random key is wrapped by the password and by a recovery key shown once. Settings can set or change the password, recover with the recovery key, and auto-lock after idle time. Locking saves first, then drops the readable text and the undo stack. `blockseq reset-encryption-password` sets a new password from the recovery key in the terminal. (`df19fab`)
- Blocks tagged `#Encrypted` before a password existed are encrypted when the password is set or unlocked, and again before locking. The All pages table gained a sortable Words column. Encrypted text and property lines are not counted. (`c2f15f9`)
- `/encrypted` turns the current block into the encrypted label, opens a child for the secret, and asks you to unlock first when the notes are locked. (`2f4f7ff`)
- Settings can download the open workbook as a zip (database, Markdown, files, and the wrapped key). `blockseq export` can do the same for cron, including every workbook. Importing a backup or a zipped Logseq graph creates a new workbook and does not overwrite one. Encrypted blocks stay encrypted; if this server's password is different, the browser asks for the backup's password once and re-encrypts them. (`bf02c8b`)
- Workbooks can be renamed. Main gets a display name; other workbooks rename their folder, and other open tabs follow. The menu can open, rename, import, or create. Pasted links to X or Twitter posts become embeds. The status line shows the time of the last save in this workbook. (`5a2e363`)
- A workbook can be deleted by typing its name. The folder moves to `workbooks/.trash/<name> <date time>/` and can be put back by hand. Main cannot be deleted. Other devices that had it open switch to Main. (`b6836ed`)
- The workbook menu's buttons have icons. (`6d027a7`)

### Security

- A damaged `config.json` is an error. It is not replaced with defaults, which would drop the wrapped encryption key. The last good copy is kept as `config.json.bak` and used if the current file cannot be read. Writes are flushed and replaced into place, and changes go through one locked read-modify-write. Password changes need a proof of holding the key; only a hash of that proof is stored. (`4d2e83b`)
- Writes from another website are refused. Optional `BLOCKSEQ_HOSTS` serves only those names, plus IP addresses and localhost, which blocks a page that rebinds this machine's name onto itself. The app page sends a content-security policy (its own scripts, and embeds limited to the video and post hosts), and refuses to be framed by other sites. (`f7494dc`)
- Ten different wrong passwords in 15 minutes lock that client out until the window ends. Repeating the same wrong password counts once. Requests with no password do not count. Set `BLOCKSEQ_TRUSTED_PROXIES` so the limit sees the browser address your proxy forwards. (`6c2ef42`)
- Error text sent to the browser says "the data folder" instead of the real path. The full message stays in the log. (`5d68650`)

### Changed

- Pasted or cut blocks keep the ids of the page they came from. A save that would take those blocks away is refused, and the editor gives the copies new ids after a short wait for the source page to finish saving. Renaming a page is all-or-nothing. A task-status change is applied only if the block still has the text the list expected. The Markdown mirror is written under the same lock as the database. A panic can no longer leave a workbook locked until restart. (`4d2e83b`)

## Files, journals, and appearance

### Added

- Any file can be attached. Images and PDFs are recognised from their contents; other files keep their extension. Video and audio play in the page, text opens in the side pane, and anything else is a chip that downloads. HTML, SVG, and unknown types always download with a sandbox policy. Playback can seek. Pasting a YouTube or Vimeo link embeds the player. The first upload cap was 2048 MB; the default is now 256 MB unless `BLOCKSEQ_MAX_UPLOAD_MB` is set. (`493642e`, `1c003e8`)
- Images and PDFs on a line by themselves sit side by side and shrink to fit. The image viewer steps through that row with arrows or the arrow keys. (`b4decda`, `63e5178`)
- PDFs can be a link, an inline preview, or the side-pane viewer. The Assets page lists files, the pages that use them, and can open, download, or delete them. (`1b1ff40`)
- Images can be pasted, dropped, or inserted with `/image`, and stored in the workbook's `assets/` folder. Clicking one opens a full-size view with align, copy, open, download, and delete. (`0da9890`)
- Code blocks have a small editor: line numbers, a language picker, copy, auto-indent, and undo. Typing a fence and then Tab or Enter creates one. Long lines can wrap, and a block with no language gets a guess. (`0da9890`, `324f668`)
- Long code blocks start folded. Settings choose the length and how many lines stay visible. Comments are yellow, with an option to make them grey, and Lua is highlighted. ``double backtick`` inline code has its own copy button, and tags inside it are not counted. (`fec5e6c`, `96c4817`, `921e4a5`, `c440315`)
- LaTeX between `\(..\)`, `\[..\]`, `$..$`, or `$$..$$` renders as MathML. `/math` or clicking a formula opens a builder with a symbol palette, a live preview, and one-click fixes for common mistakes. (`7c9b996`, `1bd7b78`)
- The block menu can add a journal timestamp. `/timestamp` and `/time` do the same. (`7c9b996`)
- More than one workbook: Main, plus folders under `workbooks/`. Switching, creating, and opening are in the app. A Logseq graph that is still Markdown files is imported the first time that folder is opened, and the original files are left in place. The newer database-based Logseq cannot be imported. (`1b1ff40`)
- Task statuses are shared settings: coloured badges, Ctrl+Enter to cycle, a picker, and a task list in the side pane. Giving a block a status adds `#task`. (`1b1ff40`)
- Admonitions (`#+BEGIN_TIP` and the other kinds), quote blocks, and ordinary quotes. Images can be shown at a few sizes. Settings are grouped, shortcuts can be changed, and `?` lists them. (`1b1ff40`)
- Select several blocks with Esc, Shift and the arrow keys, drag, or Shift+click, then copy, cut, paste, delete, or set a status. Copies are outlines. Ctrl+B and Ctrl+I wrap the selection or the whole line. On an empty line they insert the marks with the caret inside. Typing `#` suggests tags. (`368af82`, `f2d733b`)
- The block menu sets left, centre, or right alignment, stored on the block and applied while editing. (`f2d733b`)
- A format bar sits by the block you are editing: marks, links, headings, admonitions, uploads, dates, status, maths, alignment, and colour. It can be turned off. The `/` menu shows a short list and groups; typing still searches every command. (`0089ae9`)
- Pages and tags can be renamed. Every link and tag in the workbook is rewritten, except inside code. Renaming onto a page that already exists merges the two. Journals and the task page cannot be renamed. (`efae12e`)
- Settings changes are a draft until Apply. Undo throws them away or reverts the last Apply. Closing with unapplied changes asks first. A search box finds settings, shortcuts, and statuses. (`efae12e`)
- Twelve themes, a full-width layout, favourite pages in the sidebar, and a colour per tag. A button or Ctrl+\\ hides the sidebar. Journals can be created, opened, and deleted from the sidebar. Favourites are stored on the server. All pages is a sortable table of name, tags, created, and updated (schema 2). (`862359e`)
- All pages can show pages, journals, starred pages, or everything. The choice is remembered in the browser. (`63e5178`)
- The sidebar calendar marks days that have a journal. Choosing a day opens that journal and creates it if needed. The header stays still between months because the grid is always six weeks. Weekday letters are red, and the week can start on a chosen day. (`0da9890`, `de073c4`, `7c9b996`)
- Logseq `{{embed [[page]]}}` and `{{embed ((id))}}` render in place, read-only, with a link to the source. Nesting stops at two levels. `{{query …}}` and other macros show as a labelled chip, and the source text is left as written. (`d10fc8e`)
- Each save stores what it is about to send in this browser, after sealing encrypted blocks, and removes that draft once the server has it. If the tab dies while the server is unreachable, the next open offers to restore or discard it. Drafts older than 30 days are dropped. A later change offers the draft whenever it differs from the server, and writes it before the tab finishes closing. (`51936bf`, `f9b309c`)

### Changed

- An empty page that has no blocks and nothing linking to it is removed after a save, a block update, a delete, and when a workbook opens. Journals and favourites are kept. Taking the `#` off a tag removes the empty tag page. (`38100c8`)
- Leading spaces or tabs indent the displayed block the same way as the editor. A tab is four spaces wide. (`4c2a56f`)

### Fixed

- The in-block code editor is as tall as its text, and the scrollbar no longer sits on the line numbers. (`324f668`)

## The first version

### Added

- A self-hosted outliner: journal pages, `[[links]]`, `#tags`, `((block references))`, backlinks, search, and TODO/DONE. A save sends the whole page and carries a version, so two devices editing at once are asked which copy to keep. Other open tabs hear about changes over a live stream. Every page is also written as a Logseq-format Markdown file; the database remains the copy that is read back. Undo and redo, slash commands, numbered lists, tables, and tags shown at the right of a line are included. A systemd unit and `install.sh` can install it on a Debian or Ubuntu server, including an LXC. (`64076f1`)
- The bullet menu (click or right-click) sets a block colour, a heading, copy, cut, delete, a numbered list, and expand or collapse. Bullet lines draw from the block you are editing up through its parents. Code blocks have syntax colours, line numbers, and a copy button. A link can point at one block. Settings are stored in the browser. (`2a78db6`)

## Running the server

### Added

- Startup deletes temporary files left by an interrupted upload, export, import, or settings save. Each workbook is checked when it opens. `GET /api/health` needs no password and returns whether settings and databases are readable, without returning notes. Shutdown waits for a save in progress, then folds each database so the file stands on its own. (`777b67f`)
- `install.sh` exports every workbook to `/var/backups/blockseq/pre-upgrade-*` before replacing the binary, and keeps the last 10 of those backups. The systemd unit is tightened (private devices, no extra privileges, a memory and syscall sandbox). `/etc/blockseq.env` documents `BLOCKSEQ_HOSTS` and recommends a password. (`da0b30e`)

### Performance

- The sidebar refresh reads journal days, favourites, and the last change time from indexes. It no longer walks every block after each save. (`7df1f38`)
- Database and file work runs on a blocking pool, so one slow disk does not stall every other request. Opening or importing one workbook blocks only that workbook. (`cde9387`, `b9008d0`)

### Fixed

- A response header built from a file name is left out when the value cannot be sent, instead of failing the whole response. (`f4ac3ff`)

## Documentation, tests, and internal cleanup

These do not change how the app behaves. They are grouped so the history stays complete.

- Documentation: keyboard shortcuts `g e`, `g l`, and Ctrl+B / Ctrl+I; the README's install and Caddy notes, Logseq credit, and the limit of Logseq import to Markdown graphs; example addresses that are not a real network; the Rust 1.88 requirement; architecture notes for auth, the blocking pool, workbook delete, and the review fixes. (`d55dc16`, `dfcac95`, `c089141`, `053ab96`, `e66b39d`, `79bd56d`)
- The project stays buildable on the declared Rust 1.88. Pedantic Clippy is on. Unused helpers and CSS were removed. The browser UI uses one shared DOM helper. (`1f71ef0`, `169dbb8`, `e776190`, `459cf22`, `f4ac3ff`)
- Browser tests live in `tests/e2e`, with an expected-output check and a Firefox pass when Firefox is installed. A server test checks that one workbook cannot see another's pages, files, or backup. (`600a7ac`, `bd57c92`, `c544758`, `d2648aa`)
