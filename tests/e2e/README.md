# Browser tests

Scripts that drive the real UI in headless Chrome (deno + puppeteer-core)
against a throwaway server. Run them with:

```sh
tests/e2e/run.sh            # default set
tests/e2e/run.sh csp draft  # some of them
```

`run.sh` builds Blockseq, starts it on `127.0.0.1:3939` with an empty
temporary data folder, runs the scripts and stops the server. Each script
prints what it checked (e.g. `plaintext on server: false`); read the output.
Screenshots go to the temporary folder printed at the end.

| Script | Checks |
|---|---|
| encryption | Password setup, recovery key, no plaintext on the server, in the Markdown mirror or on the clipboard; lock, unlock, wrong password |
| slash-encrypted | `/encrypted` creates a label and an encrypted child; asks to unlock when locked |
| review-fixes | Key proof (tampering with the public check is refused), pasted copies don't take blocks from their page, stale task-status changes are refused |
| csp | Security headers; images, PDFs, embeds, maths and code still work under the Content-Security-Policy; cross-site POST refused |
| math-builder | Palette, slots, problems and fixes, hover mapping, editing formulas in place |
| maths-render | LaTeX rendering, calendar week start, timestamps |
| format-bar | Floating bar above/below the block, actions keep the cursor, menus |
| slash-menu | Short `/` menu with groups, keyboard and mouse |
| align | Text alignment, Ctrl+B on an empty line |
| sidebar | Favourites, calendar dots and last-saved time from `/api/sidebar` |
| draft | Edits made while the server is down survive a closed tab and can be restored |
| draft-encrypted | Those drafts never hold #Encrypted plaintext |
| tweet | Embedded X posts resize (needs the internet; not in the default set) |
| backup | Export/import across servers with different passwords (needs three servers on 3941-3943; not in the default set) |

The `draft` scripts stop and restart the test server themselves (only the
one listening on port 3939).
