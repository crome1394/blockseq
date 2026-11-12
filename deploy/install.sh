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
# Password to use Blockseq. Browsers get a sign-in page (with sign out);
# scripts use HTTP basic auth (any username). Recommended.
#BLOCKSEQ_PASSWORD=
# Host names Blockseq answers to (IP addresses and localhost always work).
# Blocks "DNS rebinding" tricks from other websites. Example:
#BLOCKSEQ_HOSTS=blockseq.example.com
# Reverse proxy (e.g. Caddy) addresses: lets the wrong-password
# limit see each real client instead of the proxy. Example:
#BLOCKSEQ_TRUSTED_PROXIES=10.0.0.1
#BLOCKSEQ_MAX_UPLOAD_MB=256
# Set to 1 to show full server paths in the browser (Assets, workbooks).
# Leave unset to show paths relative to the data folder.
#BLOCKSEQ_EXPOSE_PATHS=1
EOF
  chmod 640 /etc/blockseq.env
fi

systemctl daemon-reload
systemctl enable blockseq >/dev/null
systemctl restart blockseq

# Wait for the new process to answer. It upgrades the main workbook's database
# before it starts listening, so a healthy answer means the upgrade went
# through. A process that dies right after the restart fails the install here
# instead of looking fine.
ADDR="$(sed -n 's/^[[:space:]]*BLOCKSEQ_ADDR=//p' /etc/blockseq.env | tail -n 1 | tr -d '"'"'"' ')"
ADDR="${ADDR:-127.0.0.1:3030}"
PORT="${ADDR##*:}"
HOST="${ADDR%:*}"
case "$HOST" in 0.0.0.0|"[::]"|"") HOST=127.0.0.1 ;; esac
URL="http://$HOST:$PORT/api/health"
HEALTH=""
for _ in $(seq 60); do
  if HEALTH="$(curl -sf --max-time 5 "$URL")"; then break; fi
  HEALTH=""
  systemctl is-failed --quiet blockseq && break
  sleep 1
done
systemctl --no-pager --lines=5 status blockseq || true
echo
if [[ -z "$HEALTH" ]]; then
  echo "Blockseq did not report healthy at $URL after the restart." >&2
  echo "See: journalctl -u blockseq -n 50" >&2
  if [[ -n "${STAMP:-}" ]]; then
    echo "The backup taken before this upgrade is in $BACKUPS/pre-upgrade-$STAMP" >&2
  fi
  exit 1
fi
echo "Blockseq is running and healthy: $HEALTH"
echo "Data lives in /var/lib/blockseq; settings in /etc/blockseq.env."
