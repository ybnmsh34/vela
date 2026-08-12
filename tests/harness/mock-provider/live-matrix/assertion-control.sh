#!/usr/bin/env bash
# =============================================================================
# The control experiment for record.sh.
#
# A ledger of 169 PASSes is worthless unless a FAIL is reachable. This script
# deliberately points each profile's checks at the WRONG server and records
# that they fail, then re-runs the same check against the right server and
# records that it passes. Same helper functions, same greps, same shapes as
# record.sh — only the expectation is mismatched.
#
# Output: docs/regression-baseline/mock-matrix/ASSERTION-CONTROL.txt
# Exit:   0 when every mismatched check FAILED and every matched check PASSED
#         (i.e. the assertions discriminate); 1 otherwise.
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
OUT="$REPO/docs/regression-baseline/mock-matrix/ASSERTION-CONTROL.txt"
CLI="$REPO/tests/harness/mock-provider/src/cli.ts"
WORK="$(mktemp -d)"
CURL=(curl -sS --noproxy '*' --max-time 30)
PIDS=""

cleanup() { for pid in $PIDS; do kill "$pid" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

start() { # $1 profile $2 port
  node "$CLI" --profile "$1" --port "$2" >"$WORK/$1.startup" 2>&1 &
  PIDS="$PIDS $!"
  local tries=0
  until "${CURL[@]}" -o /dev/null "http://127.0.0.1:$2/health" 2>/dev/null; do
    tries=$((tries + 1)); [ "$tries" -gt 50 ] && { echo "server $1 never came up" >&2; exit 2; }
    sleep 0.1
  done
}

ASK='{"messages":[{"role":"user","content":"what is the weather in Berlin"}]}'
TOOLS='{"messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}]}'
IMAGE='{"messages":[{"role":"user","content":[{"type":"text","text":"what is in this image"},{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="}}]}]}'

post() { # $1 url $2 body -> prints status, body in $WORK/body
  "${CURL[@]}" -o "$WORK/body" -w '%{http_code}' -H 'content-type: application/json' \
    --data-binary "$2" "$1/v1/chat/completions"
}

BAD=0
check() { # $1 want(PASS|FAIL) $2 description $3.. condition
  local want="$1" what="$2"; shift 2
  local got; if "$@"; then got=PASS; else got=FAIL; fi
  local ok; if [ "$got" = "$want" ]; then ok="control ok"; else ok="CONTROL BROKEN"; BAD=1; fi
  printf '%-5s (expected %-4s) %-14s %s\n' "$got" "$want" "$ok" "$what" >>"$OUT"
}

start frontier    8191
start small-local 8193
start hostile     8194
F=http://127.0.0.1:8191
S=http://127.0.0.1:8193
H=http://127.0.0.1:8194

{
  echo "================================================================================"
  echo "GATE M Part 1 — ASSERTION CONTROL (does a FAIL actually happen?)"
  echo "  recorded : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "  by       : tests/harness/mock-provider/live-matrix/assertion-control.sh"
  echo "--------------------------------------------------------------------------------"
  echo "Each line applies one of record.sh's checks to a server that does NOT satisfy it"
  echo "and records the result. 'expected FAIL' lines prove the check discriminates;"
  echo "'expected PASS' lines are the same check against the right server."
  echo "================================================================================"
  echo
} >"$OUT"

code=$(post "$S" "$TOOLS")
check FAIL "small-local's 'tools refused with 400' check, applied to frontier (got $(post "$F" "$TOOLS"))" \
  bash -c "[ \"$(post "$F" "$TOOLS")\" = 400 ]"
check PASS "the same check against small-local itself (got $code)" test "$code" = 400

code=$(post "$S" "$IMAGE")
check FAIL "frontier's 'vision accepted with 200' check, applied to small-local (got $code)" test "$code" = 200
check PASS "the same check against frontier (got $(post "$F" "$IMAGE"))" \
  bash -c "[ \"$(post "$F" "$IMAGE")\" = 200 ]"

"${CURL[@]}" -o "$WORK/f.sse" -H 'content-type: application/json' \
  --data-binary "{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":true}" "$F/v1/chat/completions"
"${CURL[@]}" -o "$WORK/h.sse" -H 'content-type: application/json' \
  --data-binary "{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":true}" "$H/v1/chat/completions"
check FAIL "hostile's 'no [DONE] sentinel' check, applied to frontier's stream" \
  bash -c "! grep -qF 'data: [DONE]' '$WORK/f.sse'"
check PASS "the same check against hostile's stream" \
  bash -c "! grep -qF 'data: [DONE]' '$WORK/h.sse'"

check FAIL "hostile's 'unparseable frames present' check, applied to frontier's stream" \
  bash -c "grep -qF 'data: not-json-at-all' '$WORK/f.sse'"
check PASS "the same check against hostile's stream" \
  bash -c "grep -qF 'data: not-json-at-all' '$WORK/h.sse'"

post "$F" "$ASK" >/dev/null
check FAIL "mid-local's 'answer carries <think>' check, applied to frontier" \
  bash -c "grep -qF '<think>' '$WORK/body'"
post "$H" "$ASK" >/dev/null
check PASS "the same check against hostile" bash -c "grep -qF '<think>' '$WORK/body'"

check FAIL "a string that appears in no transcript (sanity floor)" \
  bash -c "grep -qF 'THIS-STRING-EXISTS-NOWHERE' '$WORK/body'"

{
  echo
  if [ "$BAD" = 0 ]; then
    echo "CONTROL RESULT: every mismatched check FAILED and every matched check PASSED."
    echo "The assertions in record.sh discriminate; a PASS there is a real PASS."
  else
    echo "CONTROL RESULT: BROKEN — at least one check did not behave as the control expected."
    echo "Treat every verdict in this directory as unproven until this is fixed."
  fi
} >>"$OUT"

cat "$OUT"
exit "$BAD"
