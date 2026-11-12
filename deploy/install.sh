#!/usr/bin/env bash
# Installs or upgrades Blockseq on a Debian/Ubuntu machine (e.g. a Proxmox LXC).
# Run as root from a folder containing the `blockseq` binary and this
# `deploy/` folder:   sudo ./deploy/install.sh ./blockseq
set -euo pipefail

BIN="${1:-./blockseq}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [[ $EUID -ne 0 ]]; then echo "Run as root." >&2; exit 1; fi
if [[ ! -x "$BIN" ]]; then echo "Binary not found: $BIN" >&2; exit 1; fi

# Before an upgrade, back up every workbook (database, Markdown, assets,
# config.json with the wrapped encryption key). The new binary reads the data
# read-only, so this is safe while the old version is still running. The last
# 10 of these backups are kept.
if [[ -f /var/lib/blockseq/blockseq.db ]]; then
  BACKUPS=/var/backups/blockseq
  STAMP="$(date +%Y%m%d-%H%M%S)"
  install -d -m 700 "$BACKUPS"
  echo "Backing up before the upgrade: $BACKUPS/pre-upgrade-$STAMP"
  BLOCKSEQ_DATA=/var/lib/blockseq "$BIN" export --all --out "$BACKUPS/pre-upgrade-$STAMP"
  ls -1dt "$BACKUPS"/pre-upgrade-* 2>/dev/null | tail -n +11 | xargs -r rm -rf --
fi

id blockseq &>/dev/null || useradd --system --home /var/lib/blockseq --shell /usr/sbin/nologin blockseq
install -d -o blockseq -g blockseq -m 750 /var/lib/blockseq
install -m 755 "$BIN" /usr/local/bin/blockseq
install -m 644 "$HERE/blockseq.service" /etc/systemd/system/blockseq.service

if [[ ! -f /etc/blockseq.env ]]; then
  cat > /etc/blockseq.env <<'EOF'
# Listen address. Leave this on localhost and reach Blockseq through a TLS
# proxy on this machine (Caddy). Do not publish port 3030. The server refuses
# a non-local address when neither BLOCKSEQ_PASSWORD nor BLOCKSEQ_HOSTS is set.
BLOCKSEQ_ADDR=127.0.0.1:3030
# Optional password for this local port (browser login prompt, any username).
# The password people type belongs on the TLS proxy. This does not make it
# safe to listen beyond localhost.
#BLOCKSEQ_PASSWORD=
# Host names Blockseq answers to (IP addresses and localhost always work).
# Blocks "DNS rebinding" tricks from other websites. Example:
#BLOCKSEQ_HOSTS=blockseq.example.com
# Reverse proxy (e.g. Caddy) addresses: lets the wrong-password
# limit see each real client instead of the proxy. Example:
#BLOCKSEQ_TRUSTED_PROXIES=10.0.0.1
#BLOCKSEQ_MAX_UPLOAD_MB=256
EOF
  chmod 640 /etc/blockseq.env
fi

systemctl daemon-reload
systemctl enable blockseq >/dev/null
systemctl restart blockseq
sleep 1
systemctl --no-pager --lines=5 status blockseq
echo
echo "Blockseq is running. Data lives in /var/lib/blockseq; settings in /etc/blockseq.env."
echo "Health check: curl -s http://127.0.0.1:3030/api/health"
