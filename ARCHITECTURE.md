# Blockseq Architecture

Blockseq is a single-user, self-hosted outliner modelled on Logseq. A Rust
server owns the data (SQLite) and serves a plain-JavaScript web UI that is
compiled into the binary. Several browsers can have it open at once. They stay
in sync through autosave, versioned page saves and a live event stream.

```
 Browser (any device)                     Blockseq server
┌───────────────────────────┐          ┌──────────────────────────────────┐
│  web/  (ES modules)       │  HTTPS   │  blockseq (one Rust binary)      │
│  app.js    router, views  │◄────────►│  axum router                     │
│  editor.js outliner       │  Caddy   │   ├─ /api/*   JSON API (api.rs)  │
│  render.js markdown→HTML  │ (reverse │   ├─ /api/events  SSE stream     │
│  api.js    fetch wrapper  │  proxy)  │   └─ /*       embedded web/ files│
└───────────────────────────┘          │  db.rs ── SQLite (blockseq.db)   │
                                       │  md.rs ── Markdown mirror (*.md) │
                                       └──────────────────────────────────┘
```

## Repository layout

| Path | Purpose |
|------|---------|
| `src/main.rs` | Config from env, app state, router, optional password, static files, shutdown |
| `src/api.rs` | HTTP handlers for the JSON API and the server-sent event (SSE) stream; the `Wb` workbook extractor |
| `src/workbooks.rs` | Workbook registry (Main + `workbooks/<name>/`), Markdown mirror per workbook, Logseq graph import, rename (checkpoints and holds the open database while the folder moves; old handles are marked `retired` so they stop writing Markdown under the old name). Main's display name is `main_name` in `config.json` |
| `src/config.rs` | Shared settings in `config.json` (task statuses, wrapped encryption key). `load` errors on a damaged file (falls back to `config.json.bak`), `save` keeps the previous version as `.bak` and writes durably (`write_durable`: unique temp file, fsync, rename, fsync folder). All API changes go through `api::update_config` under the settings lock |
| `src/auth.rs` | Optional password (basic auth) and the wrong-password limit (10 distinct wrong passwords per client per 15 minutes; client address from `X-Forwarded-For` only for `BLOCKSEQ_TRUSTED_PROXIES`) |
| `src/guard.rs` | Outermost middleware: refuses cross-site non-GET requests (`Sec-Fetch-Site`, else `Origin` vs `Host`; `X-Forwarded-Host` only when the TCP peer is in `BLOCKSEQ_TRUSTED_PROXIES`) and host names outside `BLOCKSEQ_HOSTS`; adds the CSP (HTML only), `X-Frame-Options`, `Referrer-Policy`, `nosniff` |
| `src/backup.rs` | Backup zips (`GET /api/export`, `blockseq export`) and restoring them as new workbooks (`POST /api/import`) |
| `src/crypto.rs` | Terminal password reset for encrypted blocks (same formats as `crypto.js`) |
| `src/db.rs` | Schema, all SQL, save transaction with version check, search, backlinks |
| `src/md.rs` | Journal names, link/tag extraction, task detection, Logseq Markdown export and import (`parse_outline`) |
| `src/assets.rs` | Image and PDF uploads: type detection from file bytes, safe names, saving, listing |
| `web/index.html`, `web/app.css` | Page shell and styles (light/dark via `prefers-color-scheme`) |
| `web/js/app.js` | Hash router, views (journals, page, all pages), search box, live updates, unload handling |
| `web/js/editor.js` | `PageEditor` outliner, `[[`/`((` autocomplete, block-ref loading, popup menu |
| `web/js/math.js` | LaTeX → MathML converter (tokenizer + recursive parser; no third-party code). `analyzeTex` adds source positions (`data-s`, `data-k`) and problems with fixes for the builder |
| `web/js/mathhelp.js` | Plain-words explanations per kind of LaTeX construct, the builder's palette and examples |
| `web/js/mathbuilder.js` | Maths builder dialog: palette, code with highlight backdrop, live preview with two-way mapping, problems |
| `web/js/render.js` | Block text → HTML, pasted-outline parser |
| `web/js/api.js` | API client, UUID generator, per-tab client id, page-name cache |
| `web/js/ui.js` | Toast, clipboard fallback, save-status indicator |
| `web/js/dates.js` | Journal page names (`Nov 11th, 2026`) and day numbers |
| `web/js/code.js` | Built-in syntax highlighter, code block decoration (line numbers, copy), live-edit backdrop |
| `web/js/settings.js` | Per-browser preferences (localStorage), setting categories |
| `web/js/history-ui.js` | Page history dialog (versions, preview, restore) and Recently deleted |
| `web/js/dom.js` | `el()` helper shared by the UI modules |
| `web/js/backup-ui.js` | Settings → Backup: download, import, re-encrypting restored blocks |
| `web/js/settings-ui.js` | Settings screen: categories, task-status editor, key-binding editor |
| `web/js/keys.js` | Configurable shortcuts: defaults, matching key events, display |
| `web/js/tasks.js` | Task statuses (loaded from the server): detect, set, cycle, badge |
| `web/js/workbook.js` | Current workbook (per browser) and `?wb=` for API and asset URLs |
| `web/js/pane.js`, `web/js/pdfview.js` | Resizable right-hand pane; PDF viewer in it |
| `web/js/images.js` | Image upload, preview (lightbox), copy/download, editing one image's Markdown |
| `web/js/calendar.js` | Sidebar month calendar for opening/creating journal days |
| `deploy/` | systemd unit and install/upgrade script |

## Data model

Everything lives in `BLOCKSEQ_DATA/blockseq.db`, which runs in WAL mode with
foreign keys on.

```
pages                         blocks                          refs
─────────────────────         ─────────────────────────       ──────────────────
id          TEXT PK  ◄──┐     id         TEXT PK (UUID) ◄──   block_id     FK
name        TEXT        └──── page_id    FK, cascade          target_lower TEXT
name_lower  TEXT UNIQUE       parent_id  TEXT (null=top)      target_name  TEXT
journal_day INT (yyyymmdd)    position   INT (doc order)      tag          INT (1=#tag)
version     INT               content    TEXT (raw markdown)
created_at  INT (ms)          collapsed  INT
updated_at  INT (ms)          created_at / updated_at
favorite    INT (0/1)
```

- **Pages are found by lowercase name.** Links are stored by name, not by id,
  so `[[Project X]]` can point at a page that doesn't exist yet. A page row is
  created on its first save. Opening an unknown page just shows an empty editor.
- **Blocks form a tree** through `parent_id`. `position` is the block's index
  in document (pre-order) order across the whole page, so `ORDER BY position`
  returns the outline ready to rebuild.
- **Block ids are UUIDs made in the browser.** They stay the same across
  saves, which keeps `((block refs))` working. Ids from pasted Logseq text
  (`id::` lines) are kept.
- **`refs` is a derived index.** It is rebuilt from block text on every save
  (`md::extract_refs`) and drives backlinks and autocomplete. `target_name`
  keeps the name as first written, so pages that are only linked can be
  suggested with their proper case. `tag` is 1 for `#tag`, `#[[tag]]` and
  `tags::` (from `md::extract_tags`), which gives All pages its Tags column.
- **Favourites** are a `favorite` flag on the page row, so every device sees
  the same list. Starring a page that doesn't exist yet creates its row.
- **Linking creates pages.** When a save links or tags a name that has no
  page, an empty page row (version 0) is created, so it shows in All pages and
  search. `db::prune_orphans` removes such pages again once they have no
  blocks and nothing links to them (not journals, not favourites). It runs
  after every save, block update and delete, and when a workbook opens; the
  server sends a `deleted` event for each page it removes. Empty pages get no Markdown file, and the journals view skips
  journal pages with no blocks.
- **`journal_day`** is set when a page name parses as a journal date. The
  journals view sorts by it.
- **Managed properties.** Some block settings are stored in the block text the
  way Logseq writes them, so the Markdown mirror stays compatible:
  `logseq.order-list-type:: number` (numbered list), `background-color:: red`
  (block colour) and `heading:: true` (auto heading by depth). Fixed headings
  H1–H6 are plain Markdown `#` prefixes. The client strips them into `node.props` when
  loading (`splitProps`) and puts them back when saving (`joinProps`): after
  the first line, or at the end if the block starts with code or a table. They
  never appear in the editor.
- **Migrations.** `PRAGMA user_version` holds the schema version. `db::migrate`
  runs at startup and upgrades older databases step by step. v2 added
  `pages.favorite` and `refs.tag`, and marks existing tag refs by re-reading
  every block's text.

### Markdown mirror

After every successful save the server writes the page as a Logseq-format file
(`pages/<name>.md` or `journals/YYYY_MM_DD.md`, tab-indented, with
`collapsed:: true` where needed). Writes go to a temp file and are then renamed
into place. The mirror is rebuilt for all pages at startup and removed when a
page is deleted. **SQLite is the source of truth**: the mirror is a readable
backup and an escape hatch, and it is never read back.

## Saving and sync

The unit of saving is the **whole page**. The client sends every block of the
page along with the version it started from, and the server replaces that
page's blocks in one transaction.

```
Browser                                   Server (db::save_page)
───────                                   ──────────────────────
edit → markDirty() ─ 600 ms debounce ─►   PUT /api/page?name=X
                                          { base_version: 7, blocks: [...] }
                                          SAVEPOINT (rolls back on any error)
                                          page.version == 7 ?
                                            no  → 409 + current page and blocks
                                          any block id on another page?
                                            yes → 409 + foreign_ids
                                          delete page's blocks,
                                          insert new blocks + refs,
                                          version = 8
                                          RELEASE → write mirror (same lock)
                                          → broadcast event
version = 8, dirty = false  ◄──────────   200 { page }
```

Why whole-page saves with a version check instead of per-block operations or
CRDTs (conflict-free merge structures):

- One user, usually writing on one device at a time. Real conflicts are rare,
  so detecting them is enough. Merging them automatically isn't needed.
- It is very simple to get right. Each save is atomic, the server checks the
  block list (unique ids, parents before children), and there is no history of
  operations to replay.
- The cost is bandwidth proportional to page size, which is negligible for
  notes.

### Client save loop (`PageEditor.save`)

- `changeSeq` counts edits, so typing during an in-flight save keeps the
  editor dirty and triggers another save.
- If the network fails, the editor is marked `offline` and retries every
  4 seconds. Nothing is lost while the tab stays open.
- On **409**, autosave pauses and a banner offers *Use their version* (load the
  server copy) or *Keep mine* (adopt the server's version number and save
  again, overwriting).
- On **409 with `foreign_ids`** (pasted blocks whose ids belong to another
  page), the editor waits up to three saves while another editor in the tab is
  still saving (a cut and paste whose source page hasn't saved yet), then
  gives those blocks new ids (`renewIds`) and saves again. `save_page` refuses
  such ids unless called with `allow_moves` (only the page-merge in
  `rename_page` does), so a pasted copy can never take blocks from another
  page.
- **Page history** (`db.rs` "page history", schema v3 `page_history`, keyed
  by `name_lower` so deleted pages keep theirs; renames move it). Inside the
  save's savepoint, `maybe_snapshot` keeps the replaced blocks (JSON, as
  stored: ciphertext for #Encrypted) if the newest kept version is >10 min
  old, the save removes 5+ blocks or >30%/200+ chars, or a reason is given
  (`save_page_noting`: Keep mine via `overwrite: true`; restore; merge;
  `delete_page`). Identical consecutive versions are skipped; 100 per page.
  `restore_version` saves a kept version through `save_page_inner` (keeping
  the replaced one) after giving blocks whose ids now live elsewhere new ids.
- **Local drafts.** Each attempt first stores the payload (`flatten({forSave})`,
  after `sealSecrets`, so ciphertext only) in `localStorage` under
  `blockseq.draft:<wb>:<page>`, removed once saved. `load()` offers a draft
  older than 5 s that differs from the server copy (*Restore them* replaces the
  page and saves). Drafts expire after 30 days.
- On unload with unsaved changes, the client sends a final `fetch` with
  `keepalive` and the browser shows its leave-page warning.
- Before switching views, the router waits up to 3 seconds for pending saves,
  so the next view doesn't load a stale copy.

### Live updates (`/api/events`)

- After a save or delete, the server broadcasts
  `{type, name, version, client}` on a `tokio::sync::broadcast` channel. Each
  open `EventSource` receives it.
- Each tab sends a random `X-Client-Id` with its saves and ignores events
  tagged with its own id.
- What an editor does with someone else's change (`remoteChanged`):
  - not dirty and not editing → reload now
  - editing → reload when editing stops
  - dirty → do nothing; its next save gets a 409 and shows the conflict banner
- The page view also refreshes its backlinks after any change.
- **Missed events** are covered three ways. A receiver that falls behind gets
  a `resync` event. A reconnected `EventSource` triggers a full resync. So does
  the tab becoming visible again (e.g. after a laptop sleeps). A resync reloads
  every clean editor.

## Server details

- **Workbooks.** `workbooks::Registry` maps a workbook id to an open
  `Workbook { dir, db }`. `main` is `BLOCKSEQ_DATA` itself (so older installs
  keep working unchanged); any other id is a folder in `BLOCKSEQ_DATA/workbooks/`
  whose name passes `valid_id` (no slashes or leading dots, so no path
  traversal). Workbooks open lazily on first request (in `spawn_blocking`) and
  stay open. Every API handler takes the `Wb` extractor, which reads `?wb=`
  (default `main`), so the same handlers serve every workbook. Assets are
  served from `/assets/<name>?wb=<id>`. Events carry `"wb"` and clients ignore
  events for other workbooks.
- **Logseq import.** A workbook folder with `pages/` or `journals/` but no
  `blockseq.db` is imported when it opens: originals are copied to
  `logseq-original/`, each `.md` file is parsed by `md::parse_outline` (tab or
  space indentation, `id::` and `collapsed::` lines, code fences kept intact,
  page properties as the first block), names come from file names (`___` → `/`,
  `%XX` decoded, `2026_11_11` → journal, `title::` wins) and block ids are made
  unique across the workbook. `:favorites` in `logseq/config.edn` become
  favourites. Then the mirror rewrites the files in Blockseq's format.
- **Tasks.** `config.json` lists the status words. A block whose first word is
  one gets a `refs` row to `task` with `tag = 2` (implied, not in the text), so
  the *task* page shows every task and `GET /api/tasks` can list them. When
  the statuses change, `refresh_task_refs` recomputes these rows in every open
  workbook; workbooks opened later do it on open.
- **One SQLite connection per workbook behind a `std::sync::Mutex`.** All queries are short
  and the app has a single user, so a connection pool would add complexity for
  no gain. Handlers lock, run their queries, and release the lock before any
  `await`.
- **Router** (`main.rs`):

  | Method & path | Handler | Notes |
  |---|---|---|
  | `GET /api/page?name=` | `get_page` | page meta (or null), blocks, backlinks |
  | `PUT /api/page?name=` | `put_page` | save; 200 or 409 |
  | `DELETE /api/page?name=` | `delete_page` | 204 / 404 |
  | `POST /api/page/ensure?name=` | `ensure_page` | create an empty page if missing (calendar) |
  | `POST /api/assets` | `upload_asset` | raw bytes of any file, streamed to disk (cap `BLOCKSEQ_MAX_UPLOAD_MB`); `X-Filename` optional; returns path and kind |
  | `GET /api/assets` | `list_assets` | files with size, date, kind and the pages that mention them |
  | `DELETE /api/assets?name=` | `delete_asset` | removes the file |
  | `GET /assets/<name>` | `get_asset` | streamed, `Range` support (video seeking), cached forever, `nosniff`; `assets::serve_policy` decides type and inline vs download (HTML/SVG/unknown always download, with `sandbox` CSP) |
  | `PUT /api/block?id=` | `put_block` | change one block's text (task list status changes); saves the page |
  | `GET /api/tasks` | `tasks` | every block linked to `task` |
  | `GET/POST /api/workbooks` | `list_workbooks` / `create_workbook` | not workbook-scoped |
  | `GET/PUT /api/config` | `get_config` / `put_config` | task statuses; event `config` |
  | `GET/PUT /api/encryption` | `get_encryption` / `put_encryption` | wrapped key for #Encrypted blocks; PUT needs the current check |
  | `GET /api/encryption/pending` | `encryption_pending` | pages with #Encrypted blocks whose children are still plain; the browser encrypts them after unlock |
  | `POST /api/page/favorite?name=&on=` | `set_favorite` | star / unstar, event `favorite` |
  | `POST /api/page/rename?name=&to=` | `rename_page` | rename or merge; rewrites links/tags everywhere (`md::rename_refs`, code left alone) |
  | `GET /api/pages` | `list_pages` | name, journal day, created, updated, block count, favorite, tags |
  | `GET /api/names` | `names` | page names plus linked-only names |
  | `GET /api/journals?before=&limit=` | `journals` | newest first, with blocks |
  | `GET /api/search?q=&limit=` | `search` | pages by name, blocks containing all words |
  | `GET /api/block?id=` | `get_block` | content and page name, for `((refs))` |
  | `GET /api/events` | `events` | SSE, 15 s keep-alive |
  | `GET /*` | `static_file` | embedded `web/`, `Cache-Control: no-cache` |

  Page names go in a query parameter rather than the path, so names containing
  `/` (Logseq namespaces) work.
- **Password (optional).** If `BLOCKSEQ_PASSWORD` is set, a middleware
  requires HTTP basic auth on every route (any username, constant-time
  comparison). Browsers cache the credentials, so `EventSource` works as well.
- **Static files** are embedded with `rust-embed`. Debug builds read `web/`
  from disk, so UI edits only need a browser refresh. Release builds bake the
  files in.
- **Shutdown.** On SIGTERM or Ctrl-C the server stops accepting connections and
  exits after 2 seconds. SSE streams never finish on their own, and every save
  is already committed.
- **Search** uses `LIKE` matching on lowercased text: every word must appear,
  newest blocks first. This is fine for a personal notes database. SQLite FTS5
  (its full-text search module) is the upgrade path if ranking or speed matters.

## Client details

- **Workbook switching** disposes the editors, waits for pending saves, then
  changes `workbook.js`'s id (stored per browser), clears caches and reloads
  the journals. Every request carries `?wb=`.
- **Rendering additions.** Status words become coloured badges (`tasks.js`;
  colours are a hue per status combined with the theme's `--tag-s/--tag-l`).
  `#+BEGIN_<KIND> … #+END_<KIND>` becomes an admonition box (`renderBody`).
  `![x](../assets/f.pdf)` renders as a PDF link or, with `{:view "preview"}`,
  an inline `<iframe>`; images take `{:size "half"}` etc., applied once the image
  loads (a capture-phase `load` listener in `app.js`). A `#quote` tag adds
  `.quote-block` to the block element so its children sit inside the quote.
- **Shortcuts.** `keys.js` holds the bindings (defaults + overrides in settings).
  The global handler in `app.js` supports single keys (only outside text
  fields), modifier combos and two-key sequences (`g j`). The editor checks
  `cycleStatus` / `statusPicker` itself.
- **Files and embeds.** `render.fileKind()` mirrors `assets::kind_of()`.
  `![x](../assets/f)` shows images, PDFs, `<video>` / `<audio>` players, or a
  file chip; `[x](../assets/f)` (how non-media uploads are written) is always a
  chip. `{{video URL}}` becomes a youtube-nocookie / Vimeo iframe or a
  `<video>`. Pasting a lone YouTube/Vimeo URL writes the macro.
- **Encrypted blocks** (`crypto.js`, `secure-ui.js`, `PageEditor`
  `sealSecrets`/`openSecrets`). A random 256-bit AES-GCM key encrypts every
  block; `config.json` holds only that key wrapped twice (password via
  PBKDF2-SHA256 600k rounds, recovery key via PBKDF2 100k) plus a SHA-256 check.
  For a block tagged `#Encrypted`, its children are serialised as an outline
  (with ids) and encrypted into the hidden `encrypted:: v1:<iv>:<ciphertext>`
  property; `flatten({forSave})` leaves the children out, so plaintext never
  reaches the server. `node.unsealed` marks children decrypted in memory.
  Locking saves first (`beforeLock`, still with the key), then drops the
  children and undo history (`afterLock`). Copies of open encrypted blocks
  carry the ciphertext, not the children. `PUT /api/encryption` only accepts a
  new wrapping from a client that sends the current check. The terminal
  command (`src/crypto.rs`, `blockseq reset-encryption-password`) unwraps the
  key with the recovery key and re-wraps it with a new password; its formats
  must match `crypto.js`.
- **Backups** (`src/backup.rs`, `backup-ui.js`). Export takes a `VACUUM INTO`
  snapshot while holding the workbook's connection, then zips it with
  `pages/`, `journals/`, `assets/`, `logseq/` (no hidden or temp files),
  `config.json` and a `blockseq-backup.json` manifest (`format: 1`) into a
  hidden temp file that is unlinked once opened and streamed. Media and
  archives are stored, the rest deflated. Import streams the upload to disk,
  unpacks only known paths (via `enclosed_name`, so no traversal; a single
  wrapping folder is stripped) into `workbooks/.import-<uuid>/`, caps the
  unpacked size at 4× the upload limit, checks the database (`quick_check`,
  `user_version` not newer) and only then renames the folder into place. Key
  handling compares the backup's `encryption.check` with the server's: same →
  nothing; server has none → adopted into `config.json`; different → the
  backup's wrapping is saved as `imported-key.json` in the workbook. The
  browser then opens that old key with the old password or recovery key
  (`keyFromSetup`), rewrites every `encrypted:: v1:` blob, including ones
  nested inside other blobs (`rekeyText`), on the pages from
  `/api/encryption/sealed`, saves with the normal version check, and finally
  `DELETE /api/encryption/imported` renames the file to a hidden `.old` copy.
- **Block selection** (`PageEditor.sel = {anchor, focus}`) is a range of
  visible blocks; `selectedRoots()` drops blocks whose parent is also
  selected, so children always travel with their parent. One editor holds a
  selection at a time (`selectedEditor`). Page-wide `copy` / `cut` / `paste`
  listeners use `ClipboardEvent.clipboardData`, which works on plain HTTP
  (unlike `navigator.clipboard`). Copies are Logseq-style outlines
  (`subtreeMarkdown`); cut includes `id::` lines so references survive a move.
- **Tags typed with `#`** reuse the autocomplete popup (`kind: 'tag'`).
  Accepting moves the tag to the end of the first line unless Ctrl is held.
  Setting a task status writes `#task` the same way (`tasks.withStatus`).
- **Side pane** (`pane.js`) is a fixed right-hand panel. While it is open the
  body gets `padding-right: var(--pane-w)` so pages re-centre beside it.

- **Settings and themes** (`settings.js`). Settings live in `localStorage`, so
  each device has its own. `app.js applySettings()` turns them into classes or
  attributes on `<html>` (`data-theme`, `wide`, `code-wrap`, `tag-colors`,
  `no-favorites`, `sidebar-hidden`) and CSS does the rest. Each theme is one
  `:root[data-theme="…"]` block of colour variables in `app.css`. Without a
  theme, the light colours apply, plus the dark set under
  `prefers-color-scheme: dark`. A small inline script in `index.html` applies the
  theme and sidebar state before first paint.
- **Tag colours.** `render.tagHue(name)` hashes the tag name to one of 12
  hues and sets `--tag-h` on the tag link. Each theme supplies `--tag-s` and
  `--tag-l`, so the colours fit light and dark themes.
- **Always-on threading.** `updateThread` adds a faint `.thread-line.dim` elbow
  for every child block (measured first, then added, so the browser lays out
  the page once). A `ResizeObserver` on the outline redraws the lines when
  images load or blocks collapse.

- **No build step.** Native ES modules, no frameworks and no npm. The browser
  loads `js/app.js` directly.
- **Routing** uses the URL hash: `#/journals` (default), `#/page/<name>`,
  `#/all`. The server never needs a catch-all route.
- **`PageEditor`** holds one page as a tree of
  `{id, content, collapsed, children, parent}`:
  - Structural edits (Enter, Tab, Backspace merge, move, paste, collapse)
    change the tree, re-render the outline and put the cursor back with
    `edit(node, caret)`.
  - Typing only updates `node.content`. There is no re-render per keystroke.
  - Only one block is editable at a time. Its rendered HTML is swapped for an
    auto-growing `<textarea>`, and swapped back on blur.
  - The journals view creates one `PageEditor` per day. A shared `editors` set
    tracks every live editor. It drives the status indicator, routes live
    events, and lets `((refs))` resolve against unsaved local blocks first.
- **Undo/redo**: each `PageEditor` keeps stacks of whole-page snapshots (200
  max) in memory. Structural edits call `beginOp()`, which takes a snapshot
  first. Typing takes one at the start of each burst of keystrokes (bursts end
  after 1 second idle). Undoing restores the snapshot, puts the cursor back,
  and autosaves like any other edit. History resets when the page reloads from
  the server.
- **Slash commands** share the autocomplete popup with `[[` and `((`. A `/`
  at the start of a line or after a space opens it, unless the cursor is in a
  code block.
- **Code blocks** (`code.js`): each language is an ordered list of
  `[class, sticky regex]` rules tried at each position, and the first match
  wins. Words are consumed whole, so keywords never match inside identifiers.
  Code with no language uses `guessLang()` (simple line-pattern heuristics,
  falling back to the generic rules); `text`/`plain` turns colours off.
  `decorateCode` runs after rendering: `htmlLines()` splits the highlighted
  HTML into lines (closing and reopening a span that crosses a newline) and
  each line becomes a grid row `number | code`, so numbers stay beside their
  line when the *wrap* setting (`html.code-wrap`) wraps long lines. Without
  wrap the grid scrolls sideways and the numbers are `position: sticky`. While editing, code blocks use a
  monospace textarea. With the *live* setting on, the textarea's text is
  transparent over a `<pre>` backdrop showing the same text highlighted. Both
  share identical font, padding and wrapping rules, so the caret lines up.
- **Code editor** (`CodeEditor` in `code.js`): clicking a rendered code
  block, or creating one, replaces that `<pre>` with an editor for **only the
  code inside that fence**. It has a line-number gutter, a current-line band,
  a highlighted mirror (one div per line) and a transparent textarea laid
  exactly over it, and a language
  `<select>`, Copy and "Edit as text". `render.findFences()` finds fences in
  the raw text in the same order the renderer numbers them (`data-fence`), so
  `PageEditor.codeChanged()` can splice the new code (or language) back into
  the block text. A block that is only a code fence (`isPureCode`) always
  opens in the code editor. "Edit as text" sets `rawId` to use the plain
  textarea instead. Undo snapshots record which fence was open and the
  cursor, so undo/redo reopen the code editor in place. The mirror is in
  normal flow and sets the editor's size (as wide as the longest line, or the
  editor's width when wrapping); the textarea is absolutely positioned over
  it and never scrolls itself. This avoids measuring the textarea, which
  gives wrong results before the editor is on the page. Without wrap the
  `.ce-main` box scrolls sideways and `followCaret()` keeps the cursor in
  view; with wrap the gutter numbers copy each mirror line's height.
- **Bullet threading** (`updateThread`): on every edit, for each ancestor link
  an absolutely positioned `.thread-line` is added to the parent's
  `.children` box. It runs from the top of the box down to the child's bullet,
  with a rounded corner. It is recalculated on edit, stop-edit, resize and
  settings changes.
- **Images**: pasting, dropping or `/image` uploads each file (`images.js`)
  and inserts `![alt](../assets/<name>)` on its own line. The server picks the
  extension from the file's magic bytes (PNG/JPEG/GIF/WebP/AVIF; SVG is refused
  because it can carry scripts), never overwrites a file, and serves names that
  pass a strict whitelist. Alignment is stored in Logseq's image-metadata
  syntax: `{:align "center"}`. The renderer numbers images within a block
  (`data-index`), and the ⋮ menu uses that number to find and rewrite the
  right image in the block text. Removing an image from a block doesn't delete
  the file, which keeps undo working.
- **Calendar**: `calendar.js` marks days that have non-empty journal pages
  (from `/api/pages`) and refreshes on change events. Picking a day calls
  `/api/page/ensure` for that journal name, then navigates to it.
- **Block links**: `#/page/<name>?b=<block id>` opens a page with that block
  revealed (parents expanded), scrolled into view and briefly highlighted.
  Block refs, search results and linked references all use it.
- **Rendering** (`render.js`): HTML is escaped first, then one combined regex
  turns inline syntax into tags: code, images, links, `[[page]]`, `#tag`,
  `((ref))`, bold, italic, strike, highlight and URLs. Lines are handled
  separately (headings, quotes, `key:: value` properties), as are code fences
  and the TODO/DONE marker. Pipe tables (an optional `| --- |` second row makes
  a header, with `:` for alignment) become `<table>`. Tags at the end of the
  first line are moved into a right-hand `.block-tags` column. Only `http(s)`, `mailto` and relative URLs are
  allowed in links and images.
- **Plain-HTTP safe.** `crypto.randomUUID` and `navigator.clipboard` need a
  secure context, so the code builds UUIDs from `crypto.getRandomValues` and
  falls back to `execCommand('copy')`. Everything works over plain
  `http://<lxc>:3030` as well as through Caddy.

## Deployment

```
device ──VPN (e.g. Tailscale)──┐
device ──LAN───────────────────┤
                               ▼
                 Caddy (TLS, e.g. notes.example.com), anywhere on the network
                               │ http :3030
                               ▼
                 Blockseq server/LXC: systemd service, user `blockseq`
                 /usr/local/bin/blockseq
                 /var/lib/blockseq/{blockseq.db, pages/, journals/, assets/, workbooks/}
                 /etc/blockseq.env (BLOCKSEQ_ADDR, _PASSWORD, _HOSTS, _TRUSTED_PROXIES)
```

The systemd unit runs as an unprivileged user with `ProtectSystem=strict`
(read-only system), can write only to `/var/lib/blockseq`, and has no devices,
capabilities, kernel tunables or extra address families (see the unit file).
To upgrade, rebuild and run `deploy/install.sh` again: it first exports every
workbook to `/var/backups/blockseq/pre-upgrade-*` with the new binary
(read-only), then replaces the binary and unit and keeps your data and env
file.

At startup `workbooks::clean_temp` removes leftovers of interrupted work
(`.export-*`, `.upload-*`, `.import-*`, `*.md.tmp`, settings temp files);
each workbook runs `PRAGMA quick_check` when it opens (`Workbook.integrity`,
reported by `GET /api/health`). Shutdown locks each workbook (waiting for a
save in progress) and runs `PRAGMA optimize` and `wal_checkpoint(TRUNCATE)`
before the forced exit. Locks are `parking_lot` (no poisoning: a panic can't
jam a workbook). `rename_page` and `save_page` use a `Savepoint` guard that
rolls back unless committed, so a rename is all or nothing.

Handlers do their database and file work on Tokio's blocking pool
(`api::blocking`, `read_json`, async `update_config` / `read_config`). The
workbook registry has one gate per workbook id for opening and moving
folders, so a slow open (a big Logseq import) only delays that workbook.
Deleting a workbook moves its folder to `workbooks/.trash/<name> <date>/`
(hidden from the list, skipped by the startup clean-up); Main can't be
deleted. Error messages sent to browsers replace the data folder's path with
"the data folder" (`api::redact`); logs keep the full text.

## Known limits and extension points

| Want | Where it would go |
|------|-------------------|
| Zoom into a block | `PageEditor` option to render from a given node as root; a `#/block/<id>` route |
| Editable linked references | Render backlink blocks with a `PageEditor` scoped to the source page's subtree |
| Queries (`{{query}}`) | A server endpoint over `refs` + `blocks`; rendered in `render.js` |
| Free image resizing | Sizes are presets today (`:size` in the `{...}` image metadata); a drag handle in `.img-box` could store a width |
| Bulk unused-file cleanup | The Assets page already filters unused files (`asset_usage`); a "delete all unused" action would go there |
| Better search | FTS5 virtual table kept in step with `blocks` inside `save_page` |
| Diffs in page history | `page_history` keeps whole versions; the conflict diff (`diffLines` in editor.js) could compare two of them |
| Schema changes | Add a step to `db::migrate` and bump `SCHEMA_VERSION` |

## Testing

- `cargo test` runs unit tests for journal names, link extraction, Markdown
  export, save and load, version conflicts, backlinks, search and block-order
  checks.
- `tests/e2e/run.sh` runs the browser tests (deno + puppeteer-core, headless
  Chrome) against a throwaway server; see `tests/e2e/README.md`.
