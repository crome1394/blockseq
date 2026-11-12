#!/usr/bin/env bash
# Browser tests: starts a throwaway Blockseq on 127.0.0.1:3939 with an empty
# temporary data folder (never your real notes), runs the scripts, stops it.
#
#   tests/e2e/run.sh                 # the default set
#   tests/e2e/run.sh csp draft       # just these
#
# Needs deno and Chrome (CHROME=/path/to/chrome if it isn't
# /usr/bin/google-chrome-stable). Each script prints what it checked; read
# the output (screenshots land in the temporary folder printed at the end).
# Not in the default set: tweet (needs the internet) and backup (needs three
# servers on ports 3941-3943, see the top of backup.ts).
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT=3939
if ss -ltn | grep -q ":$PORT "; then
  echo "Port $PORT is already in use; stop that server first." >&2
  exit 1
fi
cargo build -q
DIR="$(mktemp -d -t blockseq-e2e-XXXXXX)"
mkdir -p "$DIR/data"
export BLOCKSEQ_BIN="$PWD/target/debug/blockseq"

stop() {
  local pid
  pid="$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | cut -d= -f2 || true)"
  if [[ -n "$pid" ]]; then kill "$pid" || true; fi
}
trap stop EXIT

(BLOCKSEQ_DATA="$DIR/data" BLOCKSEQ_ADDR="127.0.0.1:$PORT" nohup "$BLOCKSEQ_BIN" >"$DIR/server.log" 2>&1 &)
for _ in $(seq 40); do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break
  sleep 0.25
done

TESTS=("$@")
if [[ ${#TESTS[@]} -eq 0 ]]; then
  # Order matters a little: encryption sets the password the others use.
  TESTS=(encryption slash-encrypted review-fixes csp workbooks history math-builder maths-render format-bar slash-menu align sidebar draft draft-encrypted)
fi
failed=0
for t in "${TESTS[@]}"; do
  echo "== $t"
  if ! deno run -A "tests/e2e/$t.ts" "$DIR" 2>&1 | grep -v '^Warning'; then
    echo "!! $t failed"
    failed=1
  fi
done
echo
echo "Screenshots and server log: $DIR"
exit $failed
