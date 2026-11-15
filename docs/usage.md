# Using Blockseq

Keys, formatting, files, tasks, maths, encrypted blocks and workbooks.

## Keyboard

| Key                  | Action                                     |
|----------------------|--------------------------------------------|
| Enter                | New block (splits text at the cursor)      |
| Shift+Enter          | New line inside the block                  |
| Tab / Shift+Tab      | Indent / outdent                           |
| Backspace at start   | Merge with the block above                 |
| Alt+Shift+Up/Down    | Move block among its siblings              |
| Ctrl+Up / Ctrl+Down  | Collapse / expand the block and everything under it |
| Up / Down            | Move between blocks                        |
| Ctrl+Enter           | Next task status (Backlog → … → none)      |
| Ctrl+Shift+X         | Strikethrough (selection, or the whole line) |
| Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) | Undo / redo                   |
| Esc                  | Stop editing (or close the side pane)      |
| ?                    | Shortcut help (when not editing)           |
| t                    | Task list                                  |
| g then e             | Go to the editor (e.g. from the task list) |
| g then l             | Lock / unlock encrypted blocks             |
| Ctrl+B / Ctrl+I      | Bold / italic                              |
| g then j / a / f     | Journals / All pages / Assets              |
| w                    | Switch workbook                            |
| Ctrl+Shift+Enter     | Pick a task status                         |
| Ctrl+\\               | Show / hide the sidebar (or the ☰ button)  |
| `[[` / `((`          | Page / block autocomplete                  |
| `/`                  | Command menu (common commands, then groups; type to search all) |
| Ctrl+K               | Search                                     |

The single-key and `g` shortcuts can be changed in Settings → Keyboard.

**The / menu:** a bare `/` shows a short list: common commands, then groups
(Headings, Admonitions & quote block, Upload & embed, Dates & times, Task
status) that open with **Enter** or **→** (**←** goes back). Typing after the `/`
searches every command, e.g. `/tab` or `/warn`.

**Formatting bar:** while you edit a block, a small bar floats just above it (or
below it when the block is near the top of the window). It has bold, italic,
strikethrough, highlight, inline code, link, page and block references,
headings, and menus for everything else in the / menu (blocks and admonitions,
uploads and video, dates and times), plus task status, the maths builder,
alignment, colour and the block menu. Its menus show each item's / command.
The bar never takes the cursor away; Esc closes an open menu first. Turn it
off in *Settings → Editor → Formatting bar while editing*.

If the bar is in the way, drag it by the ⠿ handle at its left end. It stays
where you drop it, for every block, until you double-click the handle. Or set
*Settings → Editor → Formatting bar placement* to **Attached**: the bar then
sits in the page just above the block you edit and pushes that block down, so
it never covers other rows. Both are kept per device.

**Code blocks:** type ```` ``` ```` (optionally with a language, e.g. ```` ```bash ````) and
press Tab or Enter, or use `/code`. The code editor opens with the cursor inside.
Click any code block to edit it again. Code blocks longer than 20 lines start
folded, showing their first 6 lines and a *Show all N lines* bar. In
*Settings → Editor* you can turn this off, set how long a block must be to fold,
and set how many lines stay visible while folded. Copy always copies the whole block. Blocks with no language get a guessed
one (shown as "Auto-detect" in the language picker); pick "Plain text" for no
colours. In the code editor:

| Key | Action |
|-----|--------|
| Arrow keys | Move around the code |
| Up on the first line / Down on the last | Move to the block above / below |
| Enter | New line, keeping the indentation |
| Tab / Shift+Tab | Indent / outdent the line (or every selected line) |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Esc | Close the editor |

The top-right toolbar has the language picker, Copy, and **Edit as text**, which
edits the whole block including the ```` ``` ```` lines. Use that to add text or a tag
around the code.
Inside a table, Enter adds a row; Enter on an empty row ends the table.
Enter on an empty numbered item ends the list.

Click or right-click a bullet for the block menu: colours, headings (H1–H6, or
auto-sized by depth), text alignment (left / centre / right, stored as a
`text-align:: center` property, which Logseq shows as a plain property), add timestamp (`[[Nov 11th, 2026]] 14:32`, at the cursor
while editing, otherwise at the end of the first line before any tags; also
`/timestamp`, and `/time` for just the time), copy block ref, copy block URL (opens the page scrolled to
that block), copy/export as Markdown or plain text, cut, delete, number list,
and expand/collapse all.

**Images:** paste a screenshot, drag an image onto a block, or use `/image`.
PNG, JPEG, GIF, WebP and AVIF are accepted (checked by file content, not name).
Click an image for a full-size preview. Its ⋮ button offers align
left/center/right, size (fit, original, half, quarter, very small), copy image,
open in new tab, download, and delete. Put two or more images (or PDFs) on the
same line to show them side by side; they shrink together to fit the window.
Clicking one of them opens a viewer with ‹ › arrows (or ← / →) that step
through the images on that line.

**PDFs:** drag a PDF onto a block, paste it, or use `/pdf`. Its ⋮ menu switches
between a link and a full inline preview, and offers open in the side pane, open
in a new tab, download, and remove. Clicking the PDF's name opens it in the side
pane. Files go in the workbook's `assets/` folder.

**Other files:** drop, paste or `/file` any file. Videos (mp4, webm, mkv, mov)
and audio (mp3, m4a, ogg, wav, flac) get a player in the block; put two videos
on one line to show them side by side. Text files (txt, md, csv, json, logs…)
show as a chip that opens in the side pane. Anything else (.doc, .xlsx, .zip…)
shows as a chip that downloads. Every file goes in the workbook's `assets/`
folder. Whether a video plays depends on the browser: mp4 (H.264) and webm
play everywhere; mkv plays in Chrome/Edge when its codecs are supported.
For safety, HTML, SVG and unknown file types are always downloaded rather than
shown, so a file can't run code on your Blockseq address.

**YouTube / Vimeo:** paste a video link on its own and it becomes an embedded
player (stored as `{{video URL}}`, as in Logseq; `&t=42s` start times are kept).
`/video` inserts the same thing. Videos are loaded from youtube-nocookie.com.

**X / Twitter posts:** paste a post link (x.com or twitter.com) on its own and it
becomes an embedded post, stored as `{{tweet URL}}` like Logseq (tracking bits
such as `?s=20` are dropped). It is X's own embed page in a frame, matching the
light or dark theme, with an "Open on X" link under it. An embed shows that one
post (and what it replies to); to keep a whole thread, paste each post you want.

**Assets** (sidebar) lists every file in the workbook's `assets/` folder, with
its path on the server (copy button next to it) and
a thumbnail, size, date and the pages that use it, and buttons to open,
download or delete. *Only unused* finds files no block links to any more.

**Task list by keyboard:** **t** opens the task list with the keyboard in it
(or moves there if it's already open). **↑ ↓** (or **j k**) move, **Space**
(or Ctrl+Enter) sets the next status, **s** (or Ctrl+Shift+Enter) picks one,
**Enter** opens the task with the cursor in it, **g e** goes back to the editor
(a task you change stays in the list for a few seconds even if it no longer
matches, e.g. with no status, so you can keep cycling; the list order never
changes when a status does)
and **Esc** closes the list. **g l** locks or unlocks encrypted blocks.

**Task statuses:** use `/` and the status name, or press **Ctrl+Enter** to step
through the statuses (**Ctrl+Shift+Enter** opens a picker). Click a status badge
to change it. Setting a status adds `#task` to the end of the line (shown on the
right); removing the status removes it. Finished statuses (Done, Cancelled) are
struck out. A block you type as `TODO …` by hand also counts as a task. Define your own statuses (word, label, colour, finished or not) in
*Settings → Tasks*; they are shared by all devices.

**Task list:** the ☑ icon at the top right (or **t**) opens the open tasks in
the side pane, grouped by page. Tick *Show completed* to include finished ones.
Click a task to jump to it, or its badge to change its status.

**Maths (LaTeX):** `\[ … \]` or `$$ … $$` for a centred formula (it may span
several lines), `\( … \)` or `$ … $` inside a sentence. Example:
`\[\text{Percentage Change} = \frac{\text{New Value} - \text{Old Value}}{\text{Old Value}} \times 100\]`.
It is drawn by the browser's built-in MathML, converted by Blockseq's own
`math.js`: fractions, roots, sub/superscripts, Greek letters, operators and
arrows, `\text`, `\sum`/`\int`/`\lim` with limits, `\left…\right`,
accents, `\mathbb` and friends, and `matrix`/`pmatrix`/`bmatrix`/`cases`/
`aligned` environments. Unknown commands show in red. A single `$` needs text
right inside it, so prices like "$5 and $10" stay plain text.

**Maths builder:** `/math` (or clicking any drawn formula) opens a builder that
writes LaTeX and teaches it as you go:

- A palette (structures, operators, relations, Greek, layouts, letters). Each
  button shows the LaTeX it inserts; empty `{}` slots are filled in order with
  Tab. Select some code first and it goes into the first slot (select `a+b`,
  click the fraction: `\frac{a+b}{}`).
- A live preview. Point at any part of the drawn formula to highlight the code
  that made it and get a plain-words explanation; moving the cursor in the
  code highlights the matching part of the drawing. "In this formula" lists
  each construct used, with its explanation.
- Mistakes explained, with one-click fixes: misspelt commands (`\alpah` → did
  you mean `\alpha`?), unbalanced braces, `\left` without `\right`,
  unclosed or mismatched environments, a missing argument, `x^10` (only the 1
  is raised), `e^ix`, `*` for multiplication, `%` (starts a comment), and `&`
  outside a table.
- Centred or in-a-sentence, and a few example formulas to start from.
  `/math` with the cursor inside a formula edits it. Editing keeps the
  delimiters the formula already used. Ctrl+Enter inserts.

**Logseq embeds and macros:** `{{embed [[Page]]}}` shows that page's blocks
and `{{embed ((block id))}}` that block, read-only, with a link to the source
(edit them on their own page). Queries (`{{query …}}`) and other Logseq
macros aren't run; they show as a labelled chip and their text is kept as
written, so Logseq still sees them. Logseq whiteboards aren't supported (a
graph's `whiteboards/` folder is kept in backups but not shown).

**Admonitions:** `/tip`, `/note`, `/important`, `/caution`, `/warning` and
`/pinned` insert a box like Logseq's (stored as `#+BEGIN_TIP … #+END_TIP`).
Enter adds a line inside the box.

**Quotes:** `> text` is a quote line. Put `#quote` on a block (or `/quote block`)
to show it and all its children as a quotation.

**Selecting blocks:** press **Esc** while editing to select that block, then
**Shift+↑/↓** to add blocks (or **Shift+↑/↓** on the first/last line of a block).
You can also drag from one block into another, or Shift+click. With blocks
selected: **Ctrl+C** copies them (with their children) as a Logseq-style
outline, **Ctrl+X** cuts, **Backspace** deletes, **Ctrl+V** pastes after them,
**Ctrl+B / Ctrl+I** formats them, **Ctrl+Enter** changes their status, **Enter**
edits, **Esc** clears. Copied blocks paste back as blocks, in Blockseq or
Logseq.

**Inline code:** `` `text` `` is inline code. Double backticks, ` ``text`` `, add a copy
button next to it.

**Bold and italic:** **Ctrl+B** / **Ctrl+I** wrap the selected text, or the whole
line when nothing is selected (status words and trailing tags stay outside).
On a line with no text yet they insert `****` (or `**`) with the cursor in the
middle, so you can type bold straight away. Press again to undo it.

**Encrypted blocks:** type `/encrypted` (or tag a block `#Encrypted`) and everything nested under it
is encrypted in your browser (AES-256-GCM) before it is saved. The tagged block's
own text stays readable as a label; the server, the database, the Markdown files
and backups only hold scrambled text. Locked blocks show "🔒 Encrypted. Click to
unlock"; one password unlocks every encrypted block in every workbook, and they
lock again after 15 idle minutes (change it in *Settings → Security*), when the
tab closes, or with the 🔓 Lock button. The 🔒/🔓 button at the top right
(next to ?) locks or unlocks them from anywhere. Copying an encrypted block
copies it encrypted. `/encrypted` turns the current block into the label ("Encrypted" if it
was empty), opens a child block for the secret, and asks you to unlock first if
needed. Blocks tagged before a password existed (or while locked)
are still plain text, and say so; they are encrypted as soon as you set the
password or unlock, including on pages you don't have open.

- **Set the password** in *Settings → Security*. You are shown a **recovery key**
  once: save it in a password manager or print it. Without the password *or* the
  recovery key, encrypted blocks cannot be read by anyone, including the server.
- **Change it** in *Settings → Security* (needs the current password).
- The server refuses a key-derivation count above the 600,000 rounds a
  password uses, so a crafted setting cannot stall unlocking or a reset.
- **Forgot it?** Use *Forgot password…* in Settings with the recovery key, or on
  the server:

  ```sh
  ssh -t blockseq 'BLOCKSEQ_DATA=/var/lib/blockseq blockseq reset-encryption-password'
  # (on the server itself, plain `blockseq reset-encryption-password` finds
  # /var/lib/blockseq on its own)
  ```

  It asks for the recovery key and a new password (typing is hidden). Existing
  blocks stay readable. `-t` gives the command a terminal so it can ask
  questions; running it as root is fine, it keeps `config.json` owned by the
  service user.
- Encryption needs **HTTPS** (your Caddy address): browsers only offer it on
  secure pages. Over plain `http://` encrypted blocks stay locked.
- Text inside encrypted blocks is not searchable, and links or tags inside it
  don't create pages. Logseq shows encrypted blocks as scrambled text.

**Renaming pages and tags:** open the page (click a tag to get to its page),
then ⋯ → *Rename…*. Every `#tag`, `#[[tag]]`, `[[link]]` and `tags::` entry in
the workbook is rewritten to the new name. If a page with the new name already
exists, the two are merged (the other page's blocks first). Journals and the
*task* page can't be renamed.

**Tags:** typing `#` suggests existing tags as you type, with *New tag …* first.
Enter puts the chosen tag at the end of the line (shown on the right);
**Ctrl+Enter** keeps it where you typed it. A tag or link page that is empty
and no longer used anywhere is removed automatically (journals and starred
pages are always kept).

**Help:** press **?** (when you're not typing in a block; Esc stops editing) for
the list of shortcuts. Change them in *Settings → Keyboard*. *Copy image*
needs HTTPS (your Caddy address), because browsers block image clipboard
access on plain HTTP.

**Calendar** (bottom of the sidebar): dots mark days with journal entries.
Click a day to open its journal; if none exists, it's created. ‹ › change month,
and clicking the month name returns to today. Hidden on narrow (phone) screens.

**Workbooks:** the box under the Blockseq name shows the workbook you're in;
click it (or press **w**) to switch, or to create, rename, delete or import
one (*New workbook…*, *Rename…*, *Delete…*, *Import backup…*). Each
workbook has its own pages, journals, favorites and assets; task statuses are
shared. Each browser remembers which workbook it was on.

**Journals:** delete a journal from its ⋯ menu (next to the title on the
Journals page, or top right when it's open); this removes it and its Markdown
file from the server. The calendar opens or creates any day.

**Favorites:** click ☆ next to a page title to star it. Starred pages are listed
in the sidebar. They are stored on the server, so every computer shows the same list.

**All pages** is a table of favorite star, page name, tags, word count, created
and updated time (encrypted text isn't counted). Click a star to (un)favorite, or a column heading to sort. The filter
box matches names and tags, and the buttons next to it show Pages (no
journals), Journals, Starred or All. Each browser remembers the last choice.

**Settings** (⚙ in the header), by category:
- *Appearance:* theme (Automatic, Light, Dark, Sepia, Solarized Light/Dark,
  Catppuccin Latte/Mocha, Nord, Gruvbox, Dracula, Tokyo Night), full window
  width, a colour per tag
- *Editor:* open links in a new tab, bullet threading (and showing it all the
  time), syntax colours while editing code, wrapping long code lines, folding
  long code blocks (when to fold, and how many lines to show)
- *Sidebar:* favorites
- *Tasks:* the status list (shared by all devices)
- *Keyboard:* change any global shortcut

Changes in Settings take effect when you click **Apply**. **Undo changes**
throws away what you haven't applied; after an Apply, **Undo last apply** puts
the previous settings back. The search box at the top finds any option,
shortcut or the task statuses. Everything except task statuses is saved per
browser.

Code highlighting is built in, with no third-party library. It covers bash/shell,
ini/conf/toml/systemd, YAML, JSON, Python, JavaScript/TypeScript, Rust, Go,
C-family (C, C++, C#, Java, Kotlin, Swift, PHP), SQL, HTML/XML, CSS, Dockerfile,
diff and Lua. Comments are yellow (*Settings → Editor → Comment colour* can make
them grey). Other languages get basic colouring of comments, strings and numbers.
Pasting a Logseq outline (`- item` lines) creates the matching blocks and keeps
their `id::` values, so block refs carry over.
