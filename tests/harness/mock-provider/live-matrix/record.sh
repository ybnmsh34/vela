#!/usr/bin/env bash
# =============================================================================
# GATE M Part 1 — live capability-matrix recorder.
#
# Starts the mock provider as a REAL, SEPARATE PROCESS in each of the four
# capability profiles, drives it with an INDEPENDENT HTTP CLIENT (curl, plus
# the node:http probes in consumer-probes.mjs — never the harness's own
# src/client.ts), and writes verbatim request/response transcripts to
#
#     docs/regression-baseline/mock-matrix/<profile>/<case>.txt
#
# Each transcript ends with machine-checked ASSERTIONS: what the profile
# specifies, what actually came back, PASS or FAIL. A profile that cannot do
# something must say so explicitly; silence is a FAIL.
#
# THE OUTPUT IS NOT EVIDENCE ABOUT ANY REAL MODEL. The server is a
# deterministic fake. See docs/architecture/conventions.md §10 (VERIFIED-BY-FAKE).
#
# Usage:  bash tests/harness/mock-provider/live-matrix/record.sh
# Exit:   0 if every assertion passed, 1 otherwise.
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
OUT="$REPO/docs/regression-baseline/mock-matrix"
CLI="$REPO/tests/harness/mock-provider/src/cli.ts"
PROBES="$HERE/consumer-probes.mjs"
SSE="$HERE/reassemble-sse.py"
WORK="$(mktemp -d)"
LEDGER="$WORK/verdicts.tsv"
: >"$LEDGER"

CURL=(curl -sS --noproxy '*' --max-time 30)

cleanup() {
  for pid in ${SERVER_PIDS:-}; do kill "$pid" 2>/dev/null; done
  rm -rf "$WORK"
}
trap cleanup EXIT
SERVER_PIDS=""

# --- request bodies, written once so the exact bytes are recorded ------------
ASK='{"messages":[{"role":"user","content":"what is the weather in Berlin"}]}'
TOOL='{"type":"function","function":{"name":"get_weather","description":"Look up the weather.","parameters":{"type":"object","properties":{"city":{"type":"string"},"unit":{"enum":["celsius","fahrenheit"]}},"required":["city"]}}}'
printf '%s' "$ASK" >"$WORK/plain.json"
printf '{"messages":[{"role":"user","content":"what is the weather in Berlin"}],"stream":true,"stream_options":{"include_usage":true}}' >"$WORK/plain-stream.json"
printf '{"messages":[{"role":"user","content":"what is the weather in Berlin"}],"tools":[%s]}' "$TOOL" >"$WORK/tools.json"
printf '{"messages":[{"role":"user","content":"what is the weather in Berlin"}],"tools":[%s],"tool_choice":"required"}' "$TOOL" >"$WORK/tools-required.json"
printf '{"messages":[{"role":"user","content":"what is the weather in Berlin"}],"tools":[%s],"stream":true}' "$TOOL" >"$WORK/tools-stream.json"
printf '%s' '{"messages":[{"role":"user","content":[{"type":"text","text":"what is in this image"},{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="}}]}]}' >"$WORK/vision.json"
printf '%s' '{"messages":[{"role":"user","content":"what is the weather in Berlin"}],"response_format":{"type":"json_schema","json_schema":{"name":"weather_answer","schema":{"type":"object","properties":{"city":{"type":"string"},"celsius":{"type":"integer"}},"required":["city","celsius"]}}}}' >"$WORK/structured.json"

banner() { # $1 profile $2 display $3 case $4 url
  cat <<EOF
================================================================================
GATE M Part 1 — LIVE mock-matrix transcript
  profile   : $1  ($2)
  case      : $3
  endpoint  : $4   (a separate \`node cli.ts --profile $1\` process)
  client    : curl $(curl --version | head -1 | cut -d' ' -f2) and node:http probes — NOT the harness's own client
  recorded  : $(date -u +%Y-%m-%dT%H:%M:%SZ) by tests/harness/mock-provider/live-matrix/record.sh
--------------------------------------------------------------------------------
THIS IS A MOCK. Nothing below was produced by a language model; every byte is a
deterministic function of the request. Any claim resting on it is
VERIFIED-BY-FAKE (docs/architecture/conventions.md §10). The real llama.cpp
endpoint (GATE M Part 2) is unreachable from this container.
================================================================================
EOF
}

# capture <file> <label> <method> <url-path> [body-file]
# Appends a full exchange: the exact request bytes, the raw response headers,
# and the response body verbatim.
capture() {
  local file="$1" label="$2" method="$3" path="$4" bodyfile="${5:-}"
  local url="$BASE$path"
  local trace="$WORK/trace" hdr="$WORK/hdr" body="$WORK/body" code

  if [ -n "$bodyfile" ]; then
    code=$("${CURL[@]}" --trace-ascii "$trace" -D "$hdr" -o "$body" -w '%{http_code}' \
      -X "$method" -H 'content-type: application/json' --data-binary "@$bodyfile" "$url")
  else
    code=$("${CURL[@]}" --trace-ascii "$trace" -D "$hdr" -o "$body" -w '%{http_code}' \
      -X "$method" "$url")
  fi

  {
    echo
    echo "### $label"
    echo
    echo "\$ curl -sS -X $method${bodyfile:+ -H 'content-type: application/json' --data-binary @request.json} $url"
    echo
    echo "--- request, exactly as sent (curl --trace-ascii, send side) ---"
    if [ -n "$bodyfile" ] && [ "$(wc -c <"$bodyfile")" -gt 4096 ]; then
      sed -n '/=> Send header/,/=> Send data/p' "$trace"
      echo "0000: <request body elided: $(wc -c <"$bodyfile") bytes; see the case notes above for its exact composition>"
    else
      sed -n '/=> Send header/,/<= Recv header/p' "$trace" | sed '$d'
    fi
    echo
    echo "--- response status and headers, verbatim ---"
    cat "$hdr"
    echo "--- response body, verbatim ($(wc -c <"$body") bytes) ---"
    cat "$body"
    echo
    echo "--- end of body ---"
  } >>"$file"

  LAST_CODE="$code"
  cp "$body" "$WORK/last-body"
  cp "$hdr" "$WORK/last-hdr"
}

probe() { # <file> <probe-name>
  {
    echo
    echo "### naive-consumer probe: $2"
    echo "\$ node tests/harness/mock-provider/live-matrix/consumer-probes.mjs --url $BASE --probe $2"
    echo
    node "$PROBES" --url "$BASE" --probe "$2" 2>&1
  } >>"$1"
}

start_assertions() { printf '\n--------------------------------------------------------------------------------\nASSERTIONS — profile specification vs observed behaviour\n--------------------------------------------------------------------------------\n' >>"$1"; }

# assert <file> <expectation text> <shell condition...>
assert() {
  local file="$1" expect="$2"; shift 2
  local verdict
  if "$@"; then verdict=PASS; else verdict=FAIL; fi
  printf '%-5s %s\n' "$verdict" "$expect" >>"$file"
  printf '%s\t%s\t%s\t%s\n' "$verdict" "$PROFILE" "$(basename "$file" .txt)" "$expect" >>"$LEDGER"
}

code_is()  { [ "$LAST_CODE" = "$1" ]; }
body_has() { grep -qF -- "$1" "$WORK/last-body"; }
body_lacks() { ! grep -qF -- "$1" "$WORK/last-body"; }
hdr_has()  { grep -qiF -- "$1" "$WORK/last-hdr"; }
file_has() { grep -qF -- "$2" "$1"; }
file_lacks() { ! grep -qF -- "$2" "$1"; }

# =============================================================================

record_profile() { # $1 name $2 port $3 context-window
  PROFILE="$1"; local port="$2" ctx="$3"
  BASE="http://127.0.0.1:$port"
  local dir="$OUT/$PROFILE"
  mkdir -p "$dir"

  node "$CLI" --profile "$PROFILE" --port "$port" >"$WORK/$PROFILE.startup" 2>&1 &
  local server_pid=$!
  SERVER_PIDS="$SERVER_PIDS $server_pid"
  local tries=0
  until "${CURL[@]}" -o /dev/null "$BASE/health" 2>/dev/null; do
    tries=$((tries + 1)); [ "$tries" -gt 50 ] && { echo "server $PROFILE never came up" >&2; return 1; }
    sleep 0.1
  done
  local display; display=$(sed -n 's/.*profile *[a-z-]*  *(\(.*\))$/\1/p' <"$WORK/$PROFILE.startup" | head -1)

  # -- 00: the server itself ---------------------------------------------------
  local f="$dir/00-server-and-capabilities.txt"
  banner "$PROFILE" "$display" "00-server-and-capabilities" "$BASE" >"$f"
  {
    echo
    echo "The mock provider was started as its own OS process:"
    echo "  \$ node tests/harness/mock-provider/src/cli.ts --profile $PROFILE --port $port"
    echo
    echo "--- that process's own stdout, verbatim ---"
    cat "$WORK/$PROFILE.startup"
    echo "--- end of stdout ---"
  } >>"$f"
  capture "$f" "liveness probe" GET /health
  capture "$f" "server properties (advertised context window)" GET /props
  local props_ctx; props_ctx=$(jq -r '.default_generation_settings.n_ctx' <"$WORK/last-body")
  capture "$f" "model listing" GET /v1/models
  local listed_model; listed_model=$(jq -r '.data[0].id' <"$WORK/last-body")
  capture "$f" "wrong method on a GET-only route" POST /health "$WORK/plain.json"
  local method_code="$LAST_CODE"
  capture "$f" "browser CORS preflight" OPTIONS /v1/chat/completions
  local options_code="$LAST_CODE"; cp "$WORK/last-hdr" "$WORK/options-hdr"

  start_assertions "$f"
  assert "$f" "/health answers 200 while the process is up" test -n "$listed_model"
  assert "$f" "/props advertises exactly the profile's context window ($ctx); observed $props_ctx" test "$props_ctx" = "$ctx"
  assert "$f" "/v1/models lists exactly this endpoint's model; observed '$listed_model'" test "$listed_model" != "null"
  assert "$f" "a wrong method is refused with 405, not a crash; observed $method_code" test "$method_code" = 405
  assert "$f" "OPTIONS preflight is answered (not hung); observed $options_code" test -n "$options_code"
  assert "$f" "LIMITATION, recorded not asserted: no Access-Control-Allow-Origin — a browser-hosted renderer cannot call this endpoint directly" \
    bash -c '! grep -qi "access-control-allow-origin" "'"$WORK"'/options-hdr"'

  # -- 01: plain chat, non-streaming ------------------------------------------
  f="$dir/01-chat-plain-nonstreaming.txt"
  banner "$PROFILE" "$display" "01-chat-plain-nonstreaming" "$BASE" >"$f"
  capture "$f" "a plain chat completion, non-streaming" POST /v1/chat/completions "$WORK/plain.json"
  local plain_code="$LAST_CODE"
  cp "$WORK/last-body" "$WORK/plain-body"
  local finish; finish=$(jq -r '.choices[0].finish_reason' <"$WORK/plain-body")
  local usage_ok; usage_ok=$(jq -r '.usage.total_tokens == (.usage.prompt_tokens + .usage.completion_tokens)' <"$WORK/plain-body")
  start_assertions "$f"
  assert "$f" "a plain question is answered with 200; observed $plain_code" test "$plain_code" = 200
  assert "$f" "finish_reason is one of stop|length|tool_calls; observed '$finish'" bash -c "case '$finish' in stop|length|tool_calls) exit 0;; *) exit 1;; esac"
  assert "$f" "usage totals are self-consistent" test "$usage_ok" = true
  assert "$f" "the response carries a model id" bash -c "jq -e '.model | type == \"string\"' '$WORK/plain-body' >/dev/null"

  # -- 02: plain chat, streaming ----------------------------------------------
  f="$dir/02-chat-plain-streaming.txt"
  banner "$PROFILE" "$display" "02-chat-plain-streaming" "$BASE" >"$f"
  capture "$f" "the same question, streamed, with stream_options.include_usage" POST /v1/chat/completions "$WORK/plain-stream.json"
  local stream_code="$LAST_CODE"
  cp "$WORK/last-body" "$WORK/stream-body"
  python3 "$SSE" text "$WORK/stream-body" >"$WORK/streamed-text"
  python3 "$SSE" frags "$WORK/stream-body" >"$WORK/frags.txt"
  jq -rj '.choices[0].message.content // ""' <"$WORK/plain-body" >"$WORK/nonstream-text"
  {
    echo
    echo "--- stream statistics (tolerant reassembly; see reassemble-sse.py) ---"
    python3 "$SSE" stats "$WORK/stream-body"
    echo
    echo "--- reassembled from the stream by concatenating every choices[0].delta.content ---"
    echo "(unparseable frames skipped, which is itself a decision a consumer has to make)"
    cat "$WORK/streamed-text"; echo
    echo "--- the same field from the non-streamed response above ---"
    cat "$WORK/nonstream-text"; echo
  } >>"$f"
  start_assertions "$f"
  assert "$f" "streaming answers 200; observed $stream_code" test "$stream_code" = 200
  assert "$f" "content-type is text/event-stream" hdr_has "text/event-stream"
  assert "$f" "the stream terminates — the body ends and the socket closes" test -s "$WORK/stream-body"
  assert "$f" "streamed text is identical to the non-streamed text" cmp -s "$WORK/streamed-text" "$WORK/nonstream-text"

  # -- 03: tool calling -------------------------------------------------------
  f="$dir/03-tool-calling.txt"
  banner "$PROFILE" "$display" "03-tool-calling" "$BASE" >"$f"
  capture "$f" "one tool offered, non-streaming" POST /v1/chat/completions "$WORK/tools.json"
  local tools_code="$LAST_CODE"; cp "$WORK/last-body" "$WORK/tools-body"
  capture "$f" "the same, with tool_choice: \"required\"" POST /v1/chat/completions "$WORK/tools-required.json"
  local required_code="$LAST_CODE"; cp "$WORK/last-body" "$WORK/required-body"
  capture "$f" "one tool offered, streamed" POST /v1/chat/completions "$WORK/tools-stream.json"
  probe "$f" index-keyed-tool-accumulator
  start_assertions "$f"
  case "$PROFILE" in
    frontier|mid-local)
      assert "$f" "tools are supported: 200 and a tool_calls turn; observed $tools_code" test "$tools_code" = 200
      assert "$f" "exactly one tool call is returned" bash -c "test \$(jq '.choices[0].message.tool_calls | length' '$WORK/tools-body') -eq 1"
      assert "$f" "its arguments parse as JSON" bash -c "jq -e '.choices[0].message.tool_calls[0].function.arguments | fromjson' '$WORK/tools-body' >/dev/null"
      assert "$f" "it carries an id and type=function" bash -c "jq -e '.choices[0].message.tool_calls[0] | (.id | startswith(\"call_\")) and (.type == \"function\")' '$WORK/tools-body' >/dev/null"
      assert "$f" "finish_reason is tool_calls" bash -c "test \"\$(jq -r '.choices[0].finish_reason' '$WORK/tools-body')\" = tool_calls"
      assert "$f" "tool_choice:required is honoured, not ignored" bash -c "test \$(jq '.choices[0].message.tool_calls | length' '$WORK/required-body') -ge 1"
      ;;
    small-local)
      assert "$f" "EXPLICIT DEGRADATION: tools are refused with 400, not silently dropped; observed $tools_code" test "$tools_code" = 400
      assert "$f" "the refusal carries the machine-readable code tools_not_supported" bash -c "grep -qF tools_not_supported '$WORK/tools-body'"
      assert "$f" "tool_choice:required is refused the same way; observed $required_code" test "$required_code" = 400
      assert "$f" "no tool_calls field is invented in the refusal" bash -c "! grep -qF tool_calls '$WORK/tools-body'"
      ;;
    hostile)
      assert "$f" "tools are accepted with 200 and answered with BROKEN calls; observed $tools_code" test "$tools_code" = 200
      assert "$f" "two tool calls arrive" bash -c "test \$(jq '.choices[0].message.tool_calls | length' '$WORK/tools-body') -eq 2"
      assert "$f" "call #1 arguments are truncated and DO NOT parse" bash -c "! jq -e '.choices[0].message.tool_calls[0].function.arguments | fromjson' '$WORK/tools-body' >/dev/null 2>&1"
      assert "$f" "call #2 has no id at all" bash -c "jq -e '.choices[0].message.tool_calls[1] | has(\"id\") | not' '$WORK/tools-body' >/dev/null"
      assert "$f" "call #2 has a misspelled discriminator (type=funktion)" bash -c "test \"\$(jq -r '.choices[0].message.tool_calls[1].type' '$WORK/tools-body')\" = funktion"
      assert "$f" "the naive index-keyed accumulator loses the function name (recorded above)" file_has "$f" "name=MISSING"
      ;;
  esac

  # -- 04: vision -------------------------------------------------------------
  f="$dir/04-vision-image-input.txt"
  banner "$PROFILE" "$display" "04-vision-image-input" "$BASE" >"$f"
  capture "$f" "a message containing an image_url content part" POST /v1/chat/completions "$WORK/vision.json"
  local vision_code="$LAST_CODE"; cp "$WORK/last-body" "$WORK/vision-body"
  start_assertions "$f"
  if [ "$PROFILE" = frontier ]; then
    assert "$f" "vision is supported: 200; observed $vision_code" test "$vision_code" = 200
    assert "$f" "the image is charged for in prompt_tokens (>85)" bash -c "test \$(jq '.usage.prompt_tokens' '$WORK/vision-body') -gt 85"
  else
    assert "$f" "EXPLICIT DEGRADATION: image input is refused with 400; observed $vision_code" test "$vision_code" = 400
    assert "$f" "the refusal carries the code vision_not_supported" bash -c "grep -qF vision_not_supported '$WORK/vision-body'"
    assert "$f" "the refusal names the failing parameter (messages)" bash -c "test \"\$(jq -r '.error.param' '$WORK/vision-body')\" = messages"
    assert "$f" "no answer text is fabricated alongside the refusal" bash -c "! grep -qF '\"choices\"' '$WORK/vision-body'"
  fi

  # -- 05: structured output --------------------------------------------------
  f="$dir/05-structured-output.txt"
  banner "$PROFILE" "$display" "05-structured-output" "$BASE" >"$f"
  capture "$f" "response_format: json_schema" POST /v1/chat/completions "$WORK/structured.json"
  local so_code="$LAST_CODE"; cp "$WORK/last-body" "$WORK/so-body"
  jq -r '.choices[0].message.content // ""' <"$WORK/so-body" >"$WORK/so-content" 2>/dev/null || : >"$WORK/so-content"
  probe "$f" structured-output-trust
  start_assertions "$f"
  if [ "$PROFILE" = frontier ]; then
    assert "$f" "json_schema is honoured: 200; observed $so_code" test "$so_code" = 200
    assert "$f" "the content parses as JSON" bash -c "jq -e . '$WORK/so-content' >/dev/null"
    assert "$f" "the parsed object has exactly the schema's keys" bash -c "test \"\$(jq -c 'keys' '$WORK/so-content')\" = '[\"celsius\",\"city\"]'"
  else
    assert "$f" "the request is NOT rejected — the field is accepted; observed $so_code" test "$so_code" = 200
    assert "$f" "SILENT DEGRADATION (the dangerous one): the content is prose, not JSON" bash -c "! jq -e . '$WORK/so-content' >/dev/null 2>&1"
    assert "$f" "and nothing in the response says the schema was ignored" bash -c "! grep -qiF 'response_format' '$WORK/so-body'"
  fi

  # -- 06: context overflow ---------------------------------------------------
  f="$dir/06-context-overflow.txt"
  banner "$PROFILE" "$display" "06-context-overflow" "$BASE" >"$f"
  python3 -c "
import json,sys
n=$ctx*4+64
sys.stdout.write(json.dumps({'messages':[{'role':'user','content':'x'*n}]}))
" >"$WORK/overflow.json"
  {
    echo
    echo "The prompt is a single user message of $(( ctx * 4 + 64 )) 'x' characters —"
    echo "just over this profile's advertised $ctx-token window at the harness's fixed"
    echo "4-chars-per-token estimate. The request body is elided below at $(wc -c <"$WORK/overflow.json") bytes."
  } >>"$f"
  capture "$f" "a prompt deliberately larger than the context window" POST /v1/chat/completions "$WORK/overflow.json"
  local of_code="$LAST_CODE"; cp "$WORK/last-body" "$WORK/of-body"
  # A prompt that fits: half the window.
  python3 -c "
import json,sys
sys.stdout.write(json.dumps({'messages':[{'role':'user','content':'x'*($ctx*2)}]}))
" >"$WORK/fits.json"
  capture "$f" "a prompt at half the window, for contrast" POST /v1/chat/completions "$WORK/fits.json"
  local fits_code="$LAST_CODE"
  start_assertions "$f"
  assert "$f" "EXPLICIT DEGRADATION: overflow is refused with 400, not truncated silently; observed $of_code" test "$of_code" = 400
  assert "$f" "the refusal carries the code context_length_exceeded" bash -c "grep -qF context_length_exceeded '$WORK/of-body'"
  assert "$f" "the message states the real limit ($ctx) and what was asked for" bash -c "grep -qF '$ctx' '$WORK/of-body'"
  assert "$f" "no partial answer is returned alongside the refusal" bash -c "! grep -qF '\"choices\"' '$WORK/of-body'"
  assert "$f" "a prompt inside the window still succeeds; observed $fits_code" test "$fits_code" = 200
  assert "$f" "the endpoint keeps serving after the overflow (no crash)" \
    bash -c "curl -sS --noproxy '*' --max-time 10 -o /dev/null -w '%{http_code}' '$BASE/health' | grep -q 200"

  # -- 07: reasoning ----------------------------------------------------------
  f="$dir/07-reasoning-think-blocks.txt"
  banner "$PROFILE" "$display" "07-reasoning-think-blocks" "$BASE" >"$f"
  {
    echo
    echo "Where this profile puts its reasoning, and what a consumer sees if it"
    echo "trusts the obvious approaches. The non-streaming and streamed bodies for"
    echo "the same question are in 01- and 02-; this case isolates the reasoning."
  } >>"$f"
  capture "$f" "plain question, non-streaming — looking at where reasoning lands" POST /v1/chat/completions "$WORK/plain.json"
  cp "$WORK/last-body" "$WORK/reason-body"
  jq -r '.choices[0].message.content // ""' <"$WORK/reason-body" >"$WORK/reason-content"
  jq -r '.choices[0].message.reasoning_content // "(field absent)"' <"$WORK/reason-body" >"$WORK/reason-field"
  {
    echo
    echo "--- choices[0].message.reasoning_content ---"
    cat "$WORK/reason-field"
    echo "--- choices[0].message.content ---"
    cat "$WORK/reason-content"; echo
    echo "--- every streamed content fragment, one per line, in order (| marks the edges) ---"
    cat "$WORK/frags.txt"
  } >>"$f"
  probe "$f" frame-local-think-stripper
  start_assertions "$f"
  case "$PROFILE" in
    frontier)
      assert "$f" "reasoning arrives in its own reasoning_content field" bash -c "! grep -qF '(field absent)' '$WORK/reason-field'"
      assert "$f" "the answer text contains no <think> markup" bash -c "! grep -qF '<think' '$WORK/reason-content'"
      ;;
    mid-local)
      assert "$f" "there is NO reasoning_content field — reasoning is inline" bash -c "grep -qF '(field absent)' '$WORK/reason-field'"
      assert "$f" "the answer text carries an opened <think> block" bash -c "grep -qF '<think>' '$WORK/reason-content'"
      assert "$f" "the block is closed in the non-streamed body" bash -c "grep -qF '</think>' '$WORK/reason-content'"
      assert "$f" "HAZARD: no single streamed fragment contains the closing </think>" bash -c "! grep -qF '</think>' '$WORK/frags.txt'"
      assert "$f" "consequently a frame-local stripper leaks reasoning to the user (recorded above)" file_has "$f" "VERDICT                     LEAK."
      ;;
    small-local)
      assert "$f" "no reasoning_content field" bash -c "grep -qF '(field absent)' '$WORK/reason-field'"
      assert "$f" "no <think> markup anywhere in the answer" bash -c "! grep -qF '<think' '$WORK/reason-content'"
      assert "$f" "nothing leaks through a frame-local stripper" file_has "$f" "nothing leaked"
      ;;
    hostile)
      assert "$f" "no reasoning_content field" bash -c "grep -qF '(field absent)' '$WORK/reason-field'"
      assert "$f" "<think> is opened" bash -c "grep -qF '<think>' '$WORK/reason-content'"
      assert "$f" "…and NEVER closed" bash -c "! grep -qF '</think>' '$WORK/reason-content'"
      assert "$f" "a second <think> is opened inside the first" bash -c "test \$(grep -oF '<think>' '$WORK/reason-content' | wc -l) -ge 2"
      assert "$f" "junk/control tokens are interleaved into it" bash -c "grep -qE '▒▒|<\\|im_start\\|>|</s>|ЖЖЖ|\\[UNK\\]' '$WORK/reason-content'"
      assert "$f" "a frame-local stripper leaks all of it to the user (recorded above)" file_has "$f" "VERDICT                     LEAK."
      ;;
  esac

  # -- 08: stream termination -------------------------------------------------
  f="$dir/08-stream-termination-and-hangs.txt"
  banner "$PROFILE" "$display" "08-stream-termination-and-hangs" "$BASE" >"$f"
  {
    echo
    echo "The termination contract. Three naive consumers, each with a 5-second"
    echo "budget: one that finalises on [DONE], one that waits for the usage frame"
    echo "it asked for, and one that assumes every data: payload is JSON."
    echo
    echo "--- the last 6 frames of the streamed body, verbatim ---"
    tail -c 1200 "$WORK/stream-body"
    echo "--- end ---"
  } >>"$f"
  probe "$f" wait-for-done
  probe "$f" wait-for-usage
  probe "$f" strict-json-frames
  start_assertions "$f"
  if [ "$PROFILE" = hostile ]; then
    assert "$f" "DOCUMENTED HAZARD: no [DONE] sentinel — a consumer that waits for it HANGS" file_has "$f" "HANG. No [DONE]"
    assert "$f" "DOCUMENTED HAZARD: include_usage accepted, usage never sent — waiting for it HANGS" file_has "$f" "HANG. include_usage"
    assert "$f" "DOCUMENTED HAZARD: unparseable frames kill a strict consumer mid-answer" file_has "$f" "DATA LOSS."
    assert "$f" "the transport still terminates: curl completed and the body ended" test -s "$WORK/stream-body"
  elif [ "$PROFILE" = small-local ]; then
    assert "$f" "[DONE] is sent, so a sentinel-driven consumer terminates" file_has "$f" "terminated on the [DONE] sentinel."
    assert "$f" "DOCUMENTED HAZARD: include_usage accepted, usage never sent — waiting for it HANGS" file_has "$f" "HANG. include_usage"
    assert "$f" "every frame is parseable — a strict consumer loses nothing" file_has "$f" "every frame parsed; nothing lost."
  else
    assert "$f" "[DONE] is sent, so a sentinel-driven consumer terminates" file_has "$f" "terminated on the [DONE] sentinel."
    assert "$f" "the usage frame arrives when include_usage was requested" file_has "$f" "usage frame arrived as requested."
    assert "$f" "every frame is parseable — a strict consumer loses nothing" file_has "$f" "every frame parsed; nothing lost."
  fi

  # -- 09: no-credential is a first-class state -------------------------------
  f="$dir/09-no-credential-endpoint.txt"
  banner "$PROFILE" "$display" "09-no-credential-endpoint" "$BASE" >"$f"
  {
    echo
    echo "Vela's binding rule: many local endpoints have no auth at all, so \"no API"
    echo "key\" must be a VALID, FIRST-CLASS state — never an error. The other half of"
    echo "the rule is that Vela must then send NO Authorization header, rather than an"
    echo "empty one. This case exercises both halves against the live endpoint."
  } >>"$f"
  capture "$f" "no Authorization header at all — the normal local case" POST /v1/chat/completions "$WORK/plain.json"
  local noauth_code="$LAST_CODE"
  {
    echo
    echo "### an EMPTY bearer token, the mistake this endpoint makes loud"
    echo "\$ curl -sS -H 'Authorization: Bearer' -X POST --data-binary @request.json $BASE/v1/chat/completions"
    echo
    echo "--- response status and headers, verbatim ---"
  } >>"$f"
  local empty_code
  empty_code=$("${CURL[@]}" -D "$WORK/last-hdr" -o "$WORK/last-body" -w '%{http_code}' \
    -H 'Authorization: Bearer' -H 'content-type: application/json' \
    --data-binary "@$WORK/plain.json" "$BASE/v1/chat/completions")
  { cat "$WORK/last-hdr"; echo "--- response body, verbatim ---"; cat "$WORK/last-body"; echo; } >>"$f"
  start_assertions "$f"
  assert "$f" "no credential is NOT an error: the request succeeds; observed $noauth_code" test "$noauth_code" = 200
  assert "$f" "an empty Authorization header is refused loudly with 401; observed $empty_code" test "$empty_code" = 401
  assert "$f" "…with the code empty_authorization_header" body_has "empty_authorization_header"

  kill "$server_pid" 2>/dev/null
  wait "$server_pid" 2>/dev/null
}

# =============================================================================

command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
mkdir -p "$OUT"
record_profile frontier    8101 200000
record_profile mid-local   8102 32768
record_profile small-local 8103 8192
record_profile hostile     8104 4096

fails=$(grep -c '^FAIL' "$LEDGER" || true)
total=$(wc -l <"$LEDGER")
cp "$LEDGER" "$OUT/verdicts.tsv"
echo
echo "assertions: $total, failures: $fails"
echo "ledger: $OUT/verdicts.tsv"
[ "$fails" = 0 ]
