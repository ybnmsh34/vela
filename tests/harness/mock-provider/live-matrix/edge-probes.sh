#!/usr/bin/env bash
# =============================================================================
# Edge probes — the things the per-case transcripts do not reach.
#
# record.sh walks the declared capability matrix. This script attacks the parts
# of the surface nobody declared: oversized bodies, aborted clients, concurrent
# streams, ignored sampling parameters, wrong content types. It is where the
# defects were actually found.
#
# Output: docs/regression-baseline/mock-matrix/EDGE-PROBES.txt
# Exit:   0 always — this script REPORTS, it does not judge. Read the file.
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
OUT="$REPO/docs/regression-baseline/mock-matrix/EDGE-PROBES.txt"
CLI="$REPO/tests/harness/mock-provider/src/cli.ts"
WORK="$(mktemp -d)"
PIDS=""
cleanup() { for pid in $PIDS; do kill "$pid" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

start() {
  node "$CLI" --profile "$1" --port "$2" >"$WORK/$1.log" 2>&1 &
  PIDS="$PIDS $!"
  local tries=0
  until curl -sS --noproxy '*' -o /dev/null "http://127.0.0.1:$2/health" 2>/dev/null; do
    tries=$((tries + 1)); [ "$tries" -gt 50 ] && { echo "server $1 never came up" >&2; exit 2; }
    sleep 0.1
  done
}

start hostile     8201
start small-local 8202
H=http://127.0.0.1:8201
S=http://127.0.0.1:8202

exec >"$OUT" 2>&1

cat <<EOF
================================================================================
GATE M Part 1 — EDGE PROBES (undeclared surface)
  recorded : $(date -u +%Y-%m-%dT%H:%M:%SZ)
  by       : tests/harness/mock-provider/live-matrix/edge-probes.sh
--------------------------------------------------------------------------------
These probes go outside the declared capability matrix. The endpoints are the
same deterministic fakes; nothing here is evidence about any real model.
================================================================================
EOF

echo
echo "### PROBE 1 — a request body larger than the server's 8 MiB cap"
echo "The server declares a MAX_BODY_BYTES guard that is supposed to answer 413"
echo "with code invalid_json. This is what a client actually observes."
python3 -c "
import json,sys
sys.stdout.write(json.dumps({'messages':[{'role':'user','content':'x'*(9*1024*1024)}]}))" >"$WORK/huge.json"
echo
echo "\$ curl -sS -H 'Expect:' --data-binary @9.4MB.json $H/v1/chat/completions"
: >"$WORK/huge.out"   # so "0 bytes written" is a measurement, not a missing file
curl -sS --noproxy '*' --max-time 60 -H 'Expect:' -H 'content-type: application/json' \
  -o "$WORK/huge.out" -w 'http_code=%{http_code}\n' --data-binary "@$WORK/huge.json" \
  "$H/v1/chat/completions"
echo "curl exit code = $?   (56 = 'Recv failure: Connection reset by peer')"
echo "response bytes = $(wc -c <"$WORK/huge.out" 2>/dev/null || echo 0)"
echo "response body  = $(cat "$WORK/huge.out" 2>/dev/null)"
echo
echo "\$ curl -sS $H/health          # did the server survive?"
curl -sS --noproxy '*' --max-time 10 -w '\nhttp_code=%{http_code}\n' "$H/health"
echo
echo "--- the same request one byte class smaller (7 MiB, under the cap) ---"
python3 -c "
import json,sys
sys.stdout.write(json.dumps({'messages':[{'role':'user','content':'x'*(7*1024*1024)}]}))" >"$WORK/big.json"
curl -sS --noproxy '*' --max-time 60 -H 'Expect:' -H 'content-type: application/json' \
  -o "$WORK/big.out" -w 'http_code=%{http_code}\n' --data-binary "@$WORK/big.json" \
  "$H/v1/chat/completions"
echo "curl exit code = $?"
cat "$WORK/big.out"
echo
echo "--- the server's own stdout/stderr for the whole probe ---"
cat "$WORK/hostile.log"
echo "--- end of server output ---"
echo
echo "FINDING: over the cap there is NO HTTP RESPONSE AT ALL — the socket is reset."
echo "The 413 branch is unreachable: readBody() calls request.destroy() in the same"
echo "turn it rejects, so the error response cannot be written. Under the cap the"
echo "same request is answered properly. The server survives either way, and logs"
echo "nothing, so the failure is silent on both ends."

echo
echo "### PROBE 2 — 30 concurrent streaming requests"
CONCURRENT=""
for _ in $(seq 1 30); do
  curl -sS --noproxy '*' --max-time 30 -o /dev/null -w '%{http_code} ' \
    -H 'content-type: application/json' \
    -d '{"messages":[{"role":"user","content":"hi"}],"stream":true}' \
    "$H/v1/chat/completions" &
  CONCURRENT="$CONCURRENT $!"
done
# Wait on the probe requests only — a bare `wait` would also wait for the
# server processes, which never exit.
for pid in $CONCURRENT; do wait "$pid"; done
echo
curl -sS --noproxy '*' -o /dev/null -w 'health after concurrency = %{http_code}\n' "$H/health"
echo "FINDING: none. Every request answered; the server stayed up."

echo
echo "### PROBE 3 — client disconnects in the middle of a stream"
curl -sS --noproxy '*' --max-time 0.05 -o /dev/null \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"stream":true}' "$H/v1/chat/completions"
echo "curl exit code = $?"
sleep 0.5
curl -sS --noproxy '*' -o /dev/null -w 'health after abort = %{http_code}\n' "$H/health"
echo "FINDING: none. writeStream() checks for a destroyed response between frames."

echo
echo "### PROBE 4 — sampling parameters nobody implements"
echo "\$ ... -d '{\"messages\":[…],\"n\":3,\"temperature\":0.9,\"stop\":[\"STOP\"],\"top_p\":0.1,\"seed\":42}'"
curl -sS --noproxy '*' --max-time 20 -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"n":3,"temperature":0.9,"stop":["STOP"],"top_p":0.1,"seed":42}' \
  "$S/v1/chat/completions"
echo
echo "FINDING: n=3 returns ONE choice and nothing says so. temperature, top_p, stop"
echo "and seed are accepted and discarded. Silent, like every real endpoint that"
echo "does not implement them — a consumer cannot detect it from the response."

echo
echo "### PROBE 5 — tools offered with tool_choice:\"none\" on a no-tools endpoint"
curl -sS --noproxy '*' --max-time 20 -H 'content-type: application/json' \
  -w '\nhttp_code=%{http_code}\n' \
  -d '{"messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"t","parameters":{"type":"object"}}}],"tool_choice":"none"}' \
  "$S/v1/chat/completions"
echo "FINDING: refused, even though the caller explicitly asked for no tool use and"
echo "the turn could have been answered as plain prose. Over-rejection: a consumer"
echo "that always attaches its tool catalogue is locked out of this endpoint even"
echo "for turns where it wants none of them."

echo
echo "### PROBE 6 — a body sent with the wrong content type"
curl -sS --noproxy '*' --max-time 20 -o /dev/null -w 'content-type: text/plain -> http_code=%{http_code}\n' \
  -H 'content-type: text/plain' \
  -d '{"messages":[{"role":"user","content":"hi"}]}' "$S/v1/chat/completions"
echo "FINDING: the content type is not validated at all. Benign here, but it means"
echo "these transcripts prove nothing about content-type negotiation."
