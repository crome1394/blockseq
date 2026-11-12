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
# A test passes when the script exits cleanly, prints no page errors, and
# prints every line listed in expect/<name>.txt (fixed text, anywhere).
failed=()
for t in "${TESTS[@]}"; do
  echo "== $t"
  out="$DIR/$t.out"
  ok=1
  if ! deno run -A "tests/e2e/$t.ts" "$DIR" >"$out" 2>&1; then ok=0; fi
  grep -v '^Warning' "$out"
  if grep -q 'PAGEERROR' "$out"; then ok=0; echo "!! page error"; fi
  if [[ -f "tests/e2e/expect/$t.txt" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      if ! grep -qF -- "$line" "$out"; then ok=0; echo "!! missing: $line"; fi
    done <"tests/e2e/expect/$t.txt"
  fi
  if [[ $ok -eq 1 ]]; then echo "-- $t passed"; else echo "-- $t FAILED"; failed+=("$t"); fi
done
echo
echo "Screenshots, outputs and server log: $DIR"
if [[ ${#failed[@]} -gt 0 ]]; then
  echo "FAILED: ${failed[*]}"
  exit 1
fi
echo "All ${#TESTS[@]} browser tests passed."
