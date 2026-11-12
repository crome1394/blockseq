# Deploying Blockseq

Running it on a server, putting HTTPS in front, and the settings.

## Install

Blockseq runs well in a small LXC container, a VM or any Debian/Ubuntu machine.
Tested in a Debian LXC container on Proxmox VE; any Linux with systemd works
the same way.

### Container specs

Blockseq needs very little to run (it idles around 10–20 MB of RAM).
Compiling Rust needs much more, so the size depends on where you build.

| Setting | Build on workstation (recommended) | Build on the server |
|---------|------------------------------------|----------------------|
| OS      | Debian 12/13 or Ubuntu 22.04+ (an unprivileged LXC is fine) | same |
| CPU     | 1 core                             | 2–4 cores            |
| RAM     | 512 MB, 256–512 MB swap            | 2 GB, 1 GB swap      |
| Disk    | 4 GB plus your notes and files     | 10 GB plus your notes and files |

If you build on the server, you can lower CPU and RAM afterwards.

### Option A: build on your workstation (recommended)

The release binary needs glibc 2.34+, so it runs on Debian 12/13 or
Ubuntu 22.04+ without installing anything else.

```sh
# on your workstation
cargo build --release
scp target/release/blockseq root@<server>:/root/
scp -r deploy root@<server>:/root/

# on the server
cd /root && ./deploy/install.sh ./blockseq
```

### Option B: build on the server

Install Rust with rustup. Don't use `apt install rustc`: Debian's packaged
Rust is too old for this project, which needs Rust 1.88+.

```sh
# on the server, as root
apt update && apt install -y build-essential pkg-config curl git rsync
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
source ~/.cargo/env

# on your workstation: copy the source, skipping build output and local data
rsync -av --delete --exclude target --exclude data path/to/blockseq root@<server>:/root/

# on the server
cd /root/blockseq
cargo build --release
./deploy/install.sh target/release/blockseq
```

`install.sh` creates a `blockseq` system user, keeps data in
`/var/lib/blockseq`, installs a hardened systemd unit and writes
`/etc/blockseq.env` (only the first time) from `deploy/blockseq.env.example`,
which lists every setting, commented out, with its default; compare an older
env file against it to see settings added since. Check it with
`systemctl status blockseq` and `curl -s http://127.0.0.1:3030/api/health`.

### Upgrading

Rebuild, copy the new binary (or rsync the source and rebuild), then run
`install.sh` again. It first backs up every workbook to
`/var/backups/blockseq/pre-upgrade-<date>/` (the last 10 are kept), then
replaces the binary and keeps your data and `/etc/blockseq.env`. After the
restart it waits up to a minute for `/api/health` to answer and fails, naming
that backup, if the new version does not come up healthy.

## HTTPS with Caddy

Blockseq speaks plain HTTP. Put a reverse proxy such as [Caddy](https://caddyserver.com)
in front for HTTPS; encrypted blocks need it (browsers only allow the
encryption API on secure pages). Caddy can run on the same machine or anywhere
that reaches it (a separate container, a router or firewall with a Caddy
package).

A minimal `Caddyfile`, with Caddy on the same machine as Blockseq:

```
notes.example.com {
    reverse_proxy 127.0.0.1:3030
}
```

- Leave Blockseq on `127.0.0.1:3030`. Do not publish port 3030. Set
  `BLOCKSEQ_PASSWORD` so Blockseq asks for it: you get a sign-in page, sign
  out, and a limit on guessing. (A `basic_auth` on Caddy works too, but a
  browser cannot sign out of it.) With `BLOCKSEQ_TRUSTED_PROXIES` set, the
  sign-in cookie is marked Secure when Caddy says the browser used HTTPS.
- Caddy passes Blockseq's live-update stream (server-sent events) through
  without buffering.
- **Certificates.** For a name reachable from the internet, Caddy gets a
  certificate automatically. For a name that only exists inside your network,
  use the DNS-01 challenge with your DNS provider's Caddy module (Let's Encrypt
  can't reach a private host over HTTP), or Caddy's own internal CA
  (`tls internal`) if your devices trust it.
- **DNS.** Point the name at Caddy (a local DNS override, or a public record).
- **Tell Blockseq about the proxy** in `/etc/blockseq.env`, then
  `systemctl restart blockseq`:

  ```
  BLOCKSEQ_HOSTS=notes.example.com
  BLOCKSEQ_TRUSTED_PROXIES=<Caddy's IP address as Blockseq sees it>
  ```

  To find Caddy's address, open the site through Caddy and run
  `ss -tn state established '( sport = :3030 )'` on the Blockseq server; it's
  the address in the right-hand column (without the port).
- **Restrict who can reach it.** Port 3030 stays on localhost, so Caddy is
  the only door. Put the login on Caddy. Inside your network you can also
  limit the site to your subnets with Caddy's `remote_ip` matcher.

**Over a VPN (e.g. Tailscale or WireGuard):** devices on the VPN reach Caddy
like any other client once the VPN routes to its network and resolves the
name. With Tailscale you can also skip Caddy: `tailscale serve --bg 3030` on
the Blockseq machine gives you `https://<machine>.<tailnet>.ts.net`. (An
unprivileged LXC needs the TUN device for that; add
`lxc.cgroup2.devices.allow: c 10:200 rwm` and
`lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file` to
`/etc/pve/lxc/<CTID>.conf`.)

**Built-in protections.** With a password set, each client may try at most 10
different wrong passwords per 15 minutes, then it is refused until that time
is up (repeating the same typo counts once; locked yourself out? wait, or
restart the service). Blockseq refuses changes coming from other websites (a
page you visit can't edit your notes through your browser), sends a
Content-Security-Policy and no-framing headers, and with `BLOCKSEQ_HOSTS` set
only answers to the names you list. `GET /api/health` reports `ok` or `error`
for the settings file and each database (no password needed; it shows no
notes and no file paths), e.g. for Uptime Kuma.

## Settings

Settings are environment variables; on a server they go in `/etc/blockseq.env`. [`deploy/blockseq.env.example`](../deploy/blockseq.env.example) lists every one with its default.

| Variable            | Default        | Meaning                                         |
|---------------------|----------------|-------------------------------------------------|
| `BLOCKSEQ_ADDR`     | `127.0.0.1:3030` | Listen address. Leave this on localhost and do not publish port 3030. A non-local address is refused unless `BLOCKSEQ_PASSWORD` or `BLOCKSEQ_HOSTS` is set, and logs a warning without a password (anyone who reaches the port by IP address gets in) |
| `BLOCKSEQ_DATA`     | `./data`       | Where the workbooks are stored                  |
| `BLOCKSEQ_PASSWORD` | unset          | The password to use Blockseq. Browsers sign in on a page and stay signed in for 90 days after they were last used; **Sign out** is in the header, and Settings → Security can sign out every browser. Scripts send it with HTTP basic auth (any username). Changing it signs every browser out |
| `BLOCKSEQ_MAX_UPLOAD_MB` | `256`      | Largest file you can upload, in MB              |
| `BLOCKSEQ_EXPOSE_PATHS` | unset      | Set to `1` to show full server paths in the browser (Assets, workbooks, the usage tooltip). Unset keeps paths relative to the data folder. A browser on this machine, with no proxy headers, still sees an asset's full path |
| `BLOCKSEQ_HOSTS`    | unset          | Host names to answer to, comma-separated (IP addresses and localhost always work). Blocks "DNS rebinding" by other websites; set it to your HTTPS name, e.g. `notes.example.com` |
| `BLOCKSEQ_TRUSTED_PROXIES` | unset   | Your reverse proxy's IP address(es), comma-separated; the wrong-password limit then sees each real client instead of the proxy |

On start, the log shows how these were read, e.g.
`password: on · host names: notes.example.com · trusted proxies: 10.0.0.1 · server paths: relative`.
