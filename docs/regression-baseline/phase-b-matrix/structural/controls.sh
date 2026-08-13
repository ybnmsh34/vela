#!/usr/bin/env bash
# GATE M Part 1, Phase B, round 3 — the executor's assertion controls.
#
# Every assertion this round rests on is applied where it must NOT hold, by
# re-introducing each defect in `http.rs` and re-running the suites. A control
# that stays green is an assertion that is not measuring anything.
#
# Three defects, and they must be SEPARABLE — the two directions of round 3's
# change are opposite (under-redaction and over-redaction) and a gate that
# cannot tell them apart cannot report which one regressed.
#
#   DEFECT 1  BodyStream::next_chunk hands bytes back unmodified   (FINDING 2)
#   DEFECT 2  map_reqwest_error drops the URL and re-attaches none (round 2's
#             over-redaction, which the regression critic flagged)
#   DEFECT 3  BodyStream::inner made public — the structural claim only
#
# The tree is restored from a backup on every exit path, including a failure.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../../../.."
http="$root/src-tauri/crates/vela-providers/src/http.rs"
out="$here/control-results.txt"
backup="$(mktemp)"

cp "$http" "$backup"
restore() { cp "$backup" "$http"; rm -f "$backup"; }
trap restore EXIT

run() { # run <suite>  -> "N passed; M failed" or "COMPILE ERROR"
  local suite="$1" log
  log="$(cd "$root/src-tauri" && cargo test -q -p vela-providers --test "$suite" 2>&1)"
  printf '%s\n' "$log" | grep -oE '[0-9]+ passed; [0-9]+ failed' | tail -1 \
    || echo "COMPILE ERROR"
}

failing_tests() {
  local suite="$1" log
  log="$(cd "$root/src-tauri" && cargo test -q -p vela-providers --test "$suite" 2>&1)"
  printf '%s\n' "$log" | sed -n '/^failures:$/,/^$/p' | grep -E '^    [a-z_]+' | sed 's/^ */      /'
}

suites=(zz_gate_m_round3_executor_probe streamed_credential_canary finding_two_recipe credential_canary)

: > "$out"
{
  echo "================================================================================"
  echo "GATE M Part 1 (Phase B) round 3 — EXECUTOR ASSERTION CONTROLS"
  echo "================================================================================"
  echo
  echo "Each defect below is re-introduced into src/http.rs and the suites re-run."
  echo "An assertion that cannot go red is not an assertion. A control that PASSES"
  echo "here means the suite FAILED as it was supposed to."
  echo
} >> "$out"

echo "---- BASELINE (the tree as it stands) ------------------------------------" >> "$out"
for suite in "${suites[@]}"; do
  printf '  %-34s %s\n' "$suite" "$(run "$suite")" >> "$out"
done
printf '  %-34s %s\n' "compile probes" "$(bash "$here/probe.sh" >/dev/null 2>&1 && echo 'all rejected' || echo 'A PROBE COMPILED')" >> "$out"
echo >> "$out"

# ---------------------------------------------------------------------------
echo "---- DEFECT 1 — next_chunk hands bytes back unmodified (FINDING 2) -------" >> "$out"
echo "  the round-2 streaming path, restored verbatim: the scrub is skipped" >> "$out"
cp "$backup" "$http"
perl -0pi -e 's/if self\.origin\.scrubber\(\)\.is_empty\(\) \{/if true \{ \/\/ DEFECT 1 re-introduced/' "$http"
grep -q "DEFECT 1 re-introduced" "$http" || echo "  [ERROR] the patch did not apply" >> "$out"
for suite in "${suites[@]}"; do
  result="$(run "$suite")"
  printf '  %-34s %s\n' "$suite" "$result" >> "$out"
  failing_tests "$suite" >> "$out"
done
echo >> "$out"

# ---------------------------------------------------------------------------
echo "---- DEFECT 2 — the endpoint is deleted from transport errors ------------" >> "$out"
echo "  round 2's over-redaction: without_url() and nothing re-attached" >> "$out"
cp "$backup" "$http"
perl -0pi -e 's/    let raw = if origin\.endpoint\(\)\.is_empty\(\) \{\n        reason\n    \} else \{\n        format!\("\{reason\} for url \(\{\}\)", origin\.endpoint\(\)\)\n    \};/    let raw = reason; \/\/ DEFECT 2 re-introduced/' "$http"
grep -q "DEFECT 2 re-introduced" "$http" || echo "  [ERROR] the patch did not apply" >> "$out"
for suite in "${suites[@]}"; do
  result="$(run "$suite")"
  printf '  %-34s %s\n' "$suite" "$result" >> "$out"
  failing_tests "$suite" >> "$out"
done
echo >> "$out"

# ---------------------------------------------------------------------------
echo "---- DEFECT 3 — the sealed stream is unsealed (structural claim only) ----" >> "$out"
echo "  BodyStream::inner made public: a decorator can read around the scrubber" >> "$out"
cp "$backup" "$http"
perl -0pi -e 's/pub struct BodyStream \{\n    inner: Box<dyn ByteStream>,/pub struct BodyStream \{\n    pub inner: Box<dyn ByteStream>, \/\/ DEFECT 3 re-introduced/' "$http"
grep -q "DEFECT 3 re-introduced" "$http" || echo "  [ERROR] the patch did not apply" >> "$out"
if bash "$here/probe.sh" >/dev/null 2>&1; then
  echo "  compile probes                     ALL STILL REJECTED — the probe is blind" >> "$out"
else
  echo "  compile probes                     A PROBE COMPILED — the probe caught it" >> "$out"
fi
awk '/^---- probe/{name=$2} /IT COMPILED/{print "      " name " COMPILED (correctly detected)"} ' \
  "$here/probe-results.txt" >> "$out"
echo >> "$out"

restore
trap - EXIT
echo "---- tree restored -------------------------------------------------------" >> "$out"
for suite in "${suites[@]}"; do
  printf '  %-34s %s\n' "$suite" "$(run "$suite")" >> "$out"
done

cat "$out"
