# Blockseq

A self-hosted, Logseq-style outliner. Your notes live on your server (SQLite),
and you use them from any browser on your LAN or tailnet.

- Block outliner: nested bullets, indent and outdent, collapse, move, merge
- Daily journals, `[[page links]]`, `#tags`, `((block refs))`, linked references
- `TODO` / `DONE` checkboxes, Markdown formatting, code blocks, tables,
  numbered lists
- `/` commands, undo/redo, tags at the end of a line shown on the right
- Code blocks with syntax colours, line numbers and a copy button
- Bullet menu with block colours, headings, block links, export; bullet threading
- Autosave, live refresh on other devices, and a prompt if two devices edit
  the same page at once
- Every page is also written as a Logseq-format `.md` file, so your notes are
  never locked inside the database
- One binary with the web UI built in. No Node or external database.

## Run locally

```sh
cargo run --release
# open http://localhost:3030
```

Settings are environment variables:

| Variable            | Default        | Meaning                                         |
|---------------------|----------------|-------------------------------------------------|
| `BLOCKSEQ_ADDR`     | `0.0.0.0:3030` | Listen address                                  |
| `BLOCKSEQ_DATA`     | `./data`       | Database and Markdown mirror                    |
| `BLOCKSEQ_PASSWORD` | unset          | If set, the browser asks for this password      |

## Deploy to a Proxmox LXC

### Container specs

Blockseq needs very little to run (it idles around 10–20 MB of RAM).
Compiling Rust needs much more, so the size depends on where you build.

| Setting | Build on workstation (recommended) | Build inside the LXC |
|---------|------------------------------------|----------------------|
| Template | Debian 12/13 or Ubuntu 22.04+, unprivileged | same |
| CPU     | 1 core                             | 2–4 cores            |
| RAM     | 512 MB, 256–512 MB swap            | 2 GB, 1 GB swap      |
| Disk    | 4 GB                               | 10 GB                |

If you build inside the LXC, you can lower CPU and RAM afterwards.

### Option A: build on your workstation (recommended)

The release binary needs glibc 2.34+, so it runs on Debian 12/13 or
Ubuntu 22.04+ without installing anything else in the container.

```sh
# on your workstation
cargo build --release
scp target/release/blockseq root@<lxc>:/root/
scp -r deploy root@<lxc>:/root/

# in the LXC
cd /root && ./deploy/install.sh ./blockseq
```

### Option B: build inside the LXC

Install Rust with rustup. Don't use `apt install rustc`: Debian's packaged
Rust is too old for this project, which needs Rust 1.85+.

```sh
# in the LXC, as root
apt update && apt install -y build-essential pkg-config curl git rsync
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
source ~/.cargo/env

# on your workstation: copy the source, skipping build output and local data
rsync -av --exclude target --exclude data ~/Projects/blockseq root@<lxc>:/root/

# in the LXC
cd /root/blockseq
cargo build --release
./deploy/install.sh target/release/blockseq
```

### Upgrading

Rebuild, copy the new binary (or rsync the source and rebuild), then run
`install.sh` again. It keeps your data and `/etc/blockseq.env`.

## HTTPS with Caddy on your router

Blockseq works over plain HTTP. Over HTTPS, the browser also allows the
clipboard API and keeps the page in a secure context. If Caddy runs on your
your router firewall (`os-caddy` plugin), let it handle HTTPS and proxy to the LXC:

1. **Free port 443 on your router.** In System → Settings → Administration, move
   the web GUI to another port (e.g. 8443) and turn off the HTTP redirect.
2. **Allow traffic.** Add a firewall rule on LAN allowing TCP 80/443 to
   *This Firewall*.
3. **Add a domain.** In Services → Caddy Web Server → Reverse Proxy → Domains,
   add `blockseq.example.com`. For a name that only exists inside your network,
   get the certificate with the **DNS-01 challenge** (set up your DNS
   provider in Caddy's General Settings). Let's Encrypt can't reach a LAN-only
   host over HTTP.
4. **Add a handler** for that domain with upstream = the LXC's IP, port `3030`.
   No extra options are needed: Caddy passes Blockseq's live-update stream
   (server-sent events) through without buffering.
5. **Point the name at your router.** In Services → Unbound DNS → Overrides,
   resolve `blockseq.example.com` to your router's LAN IP.
6. Optional: use a Caddy access list to limit the domain to your LAN and
   tailnet subnets.

**Using it over Tailscale:** a Tailscale subnet router on the LAN (e.g. a
separate LXC) lets tailnet devices reach Caddy. The Blockseq LXC itself doesn't
need Tailscale.

- Make sure the subnet router advertises the LAN subnet that your router is on,
  and that the route is approved in the Tailscale admin console.
- Add split DNS: in the admin console, go to DNS → Nameservers → Add nameserver →
  Custom, enter your router's LAN IP, and restrict it to your domain. Tailnet
  devices then resolve `blockseq.example.com` through Unbound.
- No extra your router rules are needed. By default, the subnet router translates
  tailnet traffic to its own LAN IP, so the LAN rules and access lists above
  already cover it. That only changes if you started the router with
  `--snat-subnet-routes=false`.

**Lock down the direct port.** Anyone on your LAN can still reach
`http://<lxc>:3030` directly. To force everything through Caddy, allow
port 3030 only from your router's IP (Proxmox firewall on the container), and/or
set `BLOCKSEQ_PASSWORD`.

**Without your router:** if the LXC is on your tailnet, `tailscale serve --bg 3030`
gives you `https://<lxc-name>.<tailnet>.ts.net` instead. An unprivileged LXC
needs the TUN device for that. Add this to `/etc/pve/lxc/<CTID>.conf` on the
Proxmox host:

```
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
```

## Your data

`/var/lib/blockseq/` (or `./data` locally) contains:

- `blockseq.db` is the SQLite database and the source of truth.
- `pages/*.md` and `journals/*.md` are Logseq-format copies, rewritten on every
  save. You can point Logseq at this folder (read-only) to compare the two apps.

Back up the whole folder, or let Proxmox back up the container. To copy
the database while Blockseq is running, use `sqlite3 blockseq.db ".backup copy.db"`.

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
| Ctrl+Enter           | Cycle TODO → DONE → none                   |
| Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) | Undo / redo                   |
| Esc                  | Stop editing                               |
| `[[` / `((`          | Page / block autocomplete                  |
| `/`                  | Command menu (link, code, table, TODO, headings, numbered list, dates) |
| Ctrl+K               | Search                                     |

Type ```` ``` ```` (optionally with a language, e.g. ```` ```bash ````) and press Tab or Enter to create
a code block with the cursor inside. In a code block, Enter adds a new line and Tab indents.
Inside a table, Enter adds a row; Enter on an empty row ends the table.
Enter on an empty numbered item ends the list.

Click or right-click a bullet for the block menu: colours, headings (H1–H6, or
auto-sized by depth), copy block ref, copy block URL (opens the page scrolled to
that block), copy/export as Markdown or plain text, cut, delete, number list,
and expand/collapse all.

**Settings** (bottom of the sidebar) are saved per browser:
bullet threading on/off, and syntax colours while editing code blocks.

Code highlighting is built in, with no third-party library. It covers bash/shell,
ini/conf/toml/systemd, YAML, JSON, Python, JavaScript/TypeScript, Rust, Go,
C-family (C, C++, C#, Java, Kotlin, Swift, PHP), SQL, HTML/XML, CSS, Dockerfile
and diff. Other languages get basic colouring of comments, strings and numbers.
Pasting a Logseq outline (`- item` lines) creates the matching blocks and keeps
their `id::` values, so block refs carry over.

## How it works

See [ARCHITECTURE.md](ARCHITECTURE.md) for the data model, how saving and
sync work, the API, and where future features would go.

## Not done yet

Page rename, zooming into a block, editing inside linked references,
unlinked references, queries, image uploads and full-text ranking.
