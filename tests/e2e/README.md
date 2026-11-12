# Browser tests

Scripts that drive the real UI in headless Chrome (deno + puppeteer-core)
against a throwaway server. Run them with:

```sh
tests/e2e/run.sh            # default set
tests/e2e/run.sh csp draft  # some of them
```

`run.sh` builds Blockseq, starts it on `127.0.0.1:3939` with an empty
temporary data folder, runs the scripts and stops the server. Each script
prints what it checked (e.g. `plaintext on server: false`). A test passes
when it exits cleanly, prints no page errors, and prints every line in
`expect/<name>.txt` (fixed text); `run.sh` exits non-zero and names what is
missing otherwise. When you change what a script prints, update its expect
file. Screenshots and each test's output go to the temporary folder printed
at the end.

| Script | Checks |
|---|---|
| encryption | Password setup, recovery key, no plaintext on the server, in the Markdown mirror or on the clipboard; lock, unlock, wrong password |
| slash-encrypted | `/encrypted` creates a label and an encrypted child; asks to unlock when locked |
| review-fixes | Key proof (tampering with the public check is refused), pasted copies don't take blocks from their page, stale task-status changes are refused |
| workbooks | Workbook folders shown, delete with typed confirmation (to `.trash`), Main protected |
| history | Page history: view and restore versions, bring back a deleted page, Keep mine keeps the other version |
| logseq-macros | `{{embed}}` of pages and blocks, query/macro chips, self-embed stops |
| tasks-keys | Task list by keyboard: t, arrows, Space / s for status, Enter to edit, g e |
| tasks-cycle | Cycling from the task list: stable order, a task without status stays a few seconds, Done shown with Show completed |
| task-no-self-conflict | Changing a status in the task list updates the open editor (no conflict with itself) |
| csp | Security headers; images, PDFs, embeds, maths and code still work under the Content-Security-Policy; cross-site POST refused |
| math-builder | Palette, slots, problems and fixes, hover mapping, editing formulas in place |
| maths-render | LaTeX rendering, calendar week start, timestamps |
| format-bar | Floating bar above/below the block, actions keep the cursor, menus |
| slash-menu | Short `/` menu with groups, keyboard and mouse |
| align | Text alignment, Ctrl+B on an empty line |
| sidebar | Favourites, calendar dots and last-saved time from `/api/sidebar` |
| draft | Edits made while the server is down survive a closed tab and can be restored |
| draft-encrypted | Those drafts never hold #Encrypted plaintext |
| firefox | The main features in Firefox (runs when Firefox is installed; FIREFOX=/path) |
| tweet | Embedded X posts resize (needs the internet; not in the default set) |
| backup | Export/import across servers with different passwords (needs three servers on 3941-3943; not in the default set) |

The `draft` scripts stop and restart the test server themselves (only the
one listening on port 3939).
