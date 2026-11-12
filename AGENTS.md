# AGENTS.md

Guidance for AI coding agents (and people) working on Blockseq. Read
[README.md](README.md) for what the app does and how it is deployed, and
[ARCHITECTURE.md](ARCHITECTURE.md) for how it works inside. This file covers
how to work on it.

## What this is

A self-hosted, single-user, Logseq-style outliner. A Rust (axum + SQLite)
server stores notes and serves a plain-JavaScript web UI that is embedded in the
binary. The owner uses it from several computers on a LAN / tailnet, alongside
Logseq, so **data safety and Logseq file compatibility matter more than
features**.

## Layout

- `src/` Rust server: `main.rs` (startup, router), `api/` (handlers),
  `db/` (all SQL, schema, migrations), `md.rs` (Markdown import/export,
  link and tag parsing), `workbooks.rs` (workbook folders, Logseq import),
  `assets.rs` (uploads), `config.rs` (shared settings), `backup.rs`
  (backup zips, restore), `crypto.rs` (terminal password reset), `guard.rs`
  (cross-site / host checks, security headers), `auth.rs` (password and
  guess limit).
- `tests/e2e/` browser tests and their runner.
- `web/` UI: `index.html`, `app.css`, and ES modules in `web/js/`. No build
  step, no bundler, no npm.
- `deploy/` systemd unit and install script for the Proxmox LXC.

## Build, run, test

```sh
cargo build                        # debug build; reads web/ from disk
BLOCKSEQ_DATA=/tmp/bq BLOCKSEQ_ADDR=127.0.0.1:3939 ./target/debug/blockseq
cargo test                         # unit tests (db, md, assets, config, ...)
tests/e2e/run.sh                   # browser tests on a throwaway server
cargo build --release              # release build embeds web/ in the binary
```

- With a **debug** build, UI changes only need a browser refresh. A
  **release** build must be rebuilt after any change in `web/`.
- Always use a throwaway `BLOCKSEQ_DATA` directory for testing, never the
  owner's real data.
- Run `cargo test`, `cargo clippy --all-targets` (pedantic lints are on, see
  `[lints.clippy]` in Cargo.toml) and `tests/e2e/run.sh`; finish with no
  warnings and all tests passing.
- UI changes should be checked in a real browser. Headless Chrome via
  `deno` + `npm:puppeteer-core` works well. The live-update stream (SSE)
  keeps a connection open, so wait for selectors, not `networkidle`.

## Rules

**Data safety**
- The SQLite database is the source of truth; the `.md` files are a mirror.
- Schema changes go in `db::migrate` as a new step, with `SCHEMA_VERSION`
  bumped. They must upgrade existing databases in place without losing data.
  Never drop or rewrite user content in a migration.
- Saves use optimistic versioning (`base_version`, HTTP 409 on conflict).
  Keep it: two devices editing the same page must never silently overwrite
  each other. Anything else that changes blocks must check what it expects
  too (e.g. `update_block`'s `expected` text).
- A save must never take blocks from another page: keep the `foreign_ids`
  check in `save_page` (only the page merge may pass `allow_moves`).
- Changes spanning several pages go in one `Savepoint` (all or nothing).
- `config.json` holds the wrapped encryption key: change it only through
  `api::update_config` / `Config::save`, and never fall back to defaults when
  it can't be read.
- Write the Markdown mirror while holding the workbook's database lock.
- Anything that replaces or deletes page content must leave the old version
  in `page_history` (save_page does it by policy; pass a reason with
  `save_page_noting` / `snapshot` for explicit overwrites).
- Workbooks are separate: never read or write another workbook's folder or
  database from a request for one workbook. Deleting moves to
  `workbooks/.trash/`; never erase a workbook outright.
- Do database and file work in handlers through `blocking(...)` (never on the
  async threads directly).
- Never delete user files (pages, assets, workbook folders) without an
  explicit user action and a confirmation in the UI.
- Imports never overwrite: a restored backup always becomes a new workbook.
  Backups must keep encrypted blocks encrypted and include the wrapped key.
- Validate every name that becomes a path (`workbooks::valid_id`,
  `assets::valid_name`). No path traversal.

**Encrypted blocks**
- Plaintext of `#Encrypted` children must never be sent to the server, written
  to `localStorage` (local drafts store the sealed `forSave` payload only), or
  put on the clipboard. Keep `flatten({ forSave: true })`,
  `sealSecrets` and the `subtreeMarkdown` rule intact, and test that the
  server's copy contains no plaintext after any change to saving or copying.
- Password changes must prove possession of the key (`proof`, checked
  against `proof_hash`); the public `check` alone must never authorize a
  change once a proof hash exists.
- Do not weaken the key derivation (PBKDF2-SHA256, 600k rounds for passwords)
  or change the formats without a version bump; `web/js/crypto.js` and
  `src/crypto.rs` must stay byte-compatible. Reject a count above 600,000
  (`crypto::iterations_accepted`, and `derive` before it runs). Do not run a
  stored count that exceeds it.
- Use WebCrypto and the RustCrypto crates (`aes-gcm`, `pbkdf2`, `sha2`) only;
  never hand-roll cryptography.

**Logseq compatibility**
- Block text stays Logseq-flavoured Markdown. Things Blockseq manages
  (numbered lists, colours, headings, image alignment/size, PDF view,
  admonitions) are stored the way Logseq writes them, e.g.
  `logseq.order-list-type:: number`, `{:align "center"}`, `#+BEGIN_TIP`.
- The Markdown mirror must stay readable by Logseq (`pages/`, `journals/`,
  `assets/`, `___` for `/` in file names, tab-indented `- ` bullets).

**Code style**
- No new runtime dependencies without a strong reason. In particular, no
  third-party JavaScript: the syntax highlighter, Markdown renderer and editor
  are written in-house on purpose. Rust crates must be permissively licensed
  (MIT / Apache-2.0 / BSD / similar), compatible with the MIT license.
- Shared browser helpers live in small modules (e.g. `dom.js`'s `el()`);
  import them rather than copying.
- No inline scripts or `on…=` attributes: the Content-Security-Policy only
  allows Blockseq's own script files. New embeds need their host added to
  `frame-src` in `guard.rs`.
- The UI must work over plain HTTP on a LAN address: `crypto.randomUUID`
  and `navigator.clipboard` are not available there, so use the fallbacks in
  `api.js` (`uuid()`) and `ui.js` (`copyText`).
- Keep the UI usable at phone width and in every theme (colours come from
  CSS variables; test light and dark).
- Comments explain *why*, briefly. Match the surrounding style.
- Per-device preferences live in `localStorage` (`settings.js`); settings
  every device must share (task statuses) live on the server (`config.json`).

**Docs**
- Update README.md (user-facing behaviour) and ARCHITECTURE.md (internals)
  in the same change as the code.

## Provenance (clean room)

Blockseq is an independent implementation. It must not contain code, styles,
icons or other assets copied or translated from Logseq (which is AGPL-3.0) or
from any project whose license is incompatible with MIT.

- Build from observed behaviour, screenshots, and the publicly documented
  file format (Markdown outlines, `key:: value` properties, journal file
  names, `config.edn` favourites). Do not read Logseq's source to implement a
  feature.
- If you are unsure where an idea or snippet came from, write it fresh.

## Deployment notes

- Production runs on a Proxmox LXC as the `blockseq` system user, with data in
  `/var/lib/blockseq` (Main workbook; other workbooks in `workbooks/<name>/`).
- Changes that touch the schema run their migration on first start. Tell the
  owner to back up `blockseq.db` before deploying such a change.
- Do not run deploy commands, SSH into the server, or push to remotes unless
  the owner asks.
