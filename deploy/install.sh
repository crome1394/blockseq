#!/usr/bin/env bash
# Installs or upgrades Blockseq on a Debian/Ubuntu machine (e.g. a Proxmox LXC).
# Run as root from a folder containing the `blockseq` binary and this
# `deploy/` folder:   sudo ./deploy/install.sh ./blockseq
set -euo pipefail

BIN="${1:-./blockseq}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [[ $EUID -ne 0 ]]; then echo "Run as root." >&2; exit 1; fi
if [[ ! -x "$BIN" ]]; then echo "Binary not found: $BIN" >&2; exit 1; fi

id blockseq &>/dev/null || useradd --system --home /var/lib/blockseq --shell /usr/sbin/nologin blockseq
install -d -o blockseq -g blockseq -m 750 /var/lib/blockseq
install -m 755 "$BIN" /usr/local/bin/blockseq
install -m 644 "$HERE/blockseq.service" /etc/systemd/system/blockseq.service

if [[ ! -f /etc/blockseq.env ]]; then
  cat > /etc/blockseq.env <<'EOF'
# Listen address. 0.0.0.0 = reachable on the LAN and over Tailscale.
BLOCKSEQ_ADDR=0.0.0.0:3030
# Uncomment to require a password (browser login prompt, any username).
#BLOCKSEQ_PASSWORD=change-me
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
