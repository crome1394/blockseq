# Blockseq Architecture

Blockseq is a single-user, self-hosted outliner modelled on Logseq. A Rust
server owns the data (SQLite) and serves a plain-JavaScript web UI that is
compiled into the binary. Several browsers can have it open at once. They stay
in sync through autosave, versioned page saves and a live event stream.

```
 Browser (any device)                     Blockseq LXC
┌───────────────────────────┐          ┌──────────────────────────────────┐
│  web/  (ES modules)       │  HTTPS   │  blockseq (one Rust binary)      │
│  app.js    router, views  │◄────────►│  axum router                     │
│  editor.js outliner       │  Caddy   │   ├─ /api/*   JSON API (api.rs)  │
│  render.js markdown→HTML  │ (your router│   ├─ /api/events  SSE stream     │
│  api.js    fetch wrapper  │  proxy)  │   └─ /*       embedded web/ files│
└───────────────────────────┘          │  db.rs ── SQLite (blockseq.db)   │
                                       │  md.rs ── Markdown mirror (*.md) │
                                       └──────────────────────────────────┘
```

## Repository layout

| Path | Purpose |
|------|---------|
| `src/main.rs` | Config from env, app state, router, optional password, static files, shutdown, mirror rebuild at startup |
| `src/api.rs` | HTTP handlers for the JSON API and the server-sent event (SSE) stream |
| `src/db.rs` | Schema, all SQL, save transaction with version check, search, backlinks |
| `src/md.rs` | Journal name parsing, link/tag extraction, Logseq Markdown export |
| `web/index.html`, `web/app.css` | Page shell and styles (light/dark via `prefers-color-scheme`) |
| `web/js/app.js` | Hash router, views (journals, page, all pages), search box, live updates, unload handling |
| `web/js/editor.js` | `PageEditor` outliner, `[[`/`((` autocomplete, block-ref loading, popup menu |
| `web/js/render.js` | Block text → HTML, pasted-outline parser |
| `web/js/api.js` | API client, UUID generator, per-tab client id, page-name cache |
| `web/js/ui.js` | Toast, clipboard fallback, save-status indicator |
| `web/js/dates.js` | Journal page names (`Nov 11th, 2026`) and day numbers |
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
journal_day INT (yyyymmdd)    position   INT (doc order)
version     INT               content    TEXT (raw markdown)
created_at  INT (ms)          collapsed  INT
updated_at  INT (ms)          created_at / updated_at
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
  suggested with their proper case.
- **Linking creates pages.** When a save links or tags a name that has no
  page, an empty page row (version 0) is created, so it shows in All pages and
  search. Empty pages get no Markdown file, and the journals view skips
  journal pages with no blocks.
- **`journal_day`** is set when a page name parses as a journal date. The
  journals view sorts by it.
- **Managed properties.** Some block settings are stored in the block text the
  way Logseq writes them, so the Markdown mirror stays compatible. Today that's
  `logseq.order-list-type:: number` for numbered lists; colors and headings
  will use the same mechanism. The client strips them into `node.props` when
  loading (`splitProps`) and puts them back when saving (`joinProps`): after
  the first line, or at the end if the block starts with code or a table. They
  never appear in the editor.
- `PRAGMA user_version = 1` marks the schema version for future migrations.

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
                                          BEGIN
                                          page.version == 7 ?
                                            no  → 409 + current page and blocks
                                            yes → delete page's blocks,
                                                  insert new blocks + refs,
                                                  version = 8
                                          COMMIT → write mirror → broadcast event
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

- **One SQLite connection behind a `std::sync::Mutex`.** All queries are short
  and the app has a single user, so a connection pool would add complexity for
  no gain. Handlers lock, run their queries, and release the lock before any
  `await`.
- **Router** (`main.rs`):

  | Method & path | Handler | Notes |
  |---|---|---|
  | `GET /api/page?name=` | `get_page` | page meta (or null), blocks, backlinks |
  | `PUT /api/page?name=` | `put_page` | save; 200 or 409 |
  | `DELETE /api/page?name=` | `delete_page` | 204 / 404 |
  | `GET /api/pages` | `list_pages` | name, journal day, updated, block count |
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
device ──tailnet──► Tailscale subnet-router LXC ──LAN──┐
device ──LAN───────────────────────────────────────────┤
                                                       ▼
                           Caddy on your router  (TLS, notes.example.com)
                                                       │ http :3030
                                                       ▼
                          Blockseq LXC: systemd service, user `blockseq`
                          /usr/local/bin/blockseq
                          /var/lib/blockseq/{blockseq.db, pages/, journals/}
                          /etc/blockseq.env (BLOCKSEQ_ADDR, BLOCKSEQ_PASSWORD)
```

The systemd unit runs as an unprivileged user with `ProtectSystem=strict`
(read-only system) and can write only to `/var/lib/blockseq`. To upgrade,
rebuild and run `deploy/install.sh` again. It replaces the binary and unit and
keeps your data and env file.

## Known limits and extension points

| Want | Where it would go |
|------|-------------------|
| Page rename | `db.rs`: update `pages.name`/`name_lower`, rewrite `[[old]]` in referencing blocks, rename the mirror file; a new API route |
| Zoom into a block | `PageEditor` option to render from a given node as root; a `#/block/<id>` route |
| Editable linked references | Render backlink blocks with a `PageEditor` scoped to the source page's subtree |
| Queries (`{{query}}`) | A server endpoint over `refs` + `blocks`; rendered in `render.js` |
| Images/attachments | `POST /api/assets` writing into `BLOCKSEQ_DATA/assets/`; served statically |
| Better search | FTS5 virtual table kept in step with `blocks` inside `save_page` |
| Version history | Before replacing blocks in `save_page`, copy the old page into a history table |
| Schema changes | Check `PRAGMA user_version` in `db::open` and run step-by-step migrations |

## Testing

- `cargo test` runs unit tests for journal names, link extraction, Markdown
  export, save and load, version conflicts, backlinks, search and block-order
  checks.
- The UI was checked with scripted headless Chrome (typing, keys,
  autocomplete, paste, two-browser conflict). Those scripts are not in the repo
  yet.
