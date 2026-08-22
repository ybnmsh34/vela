#!/usr/bin/env bash
# GATE M Part 1, Phase B, round 4 — the executor's assertion controls.
#
# Round 3's `controls.sh` covers the three defects round 3's change was about.
# Round 4 changed two more things, in two more places, and this script applies
# the same rule to them: every assertion the round rests on is applied where it
# must NOT hold, by re-introducing the defect and re-running the suites.
#
# The four defects must be SEPARABLE from each other and from round 3's, or the
# gate cannot report which direction regressed:
#
#   DEFECT 4  the redirect policy removed — `reqwest`'s defaults restored, which
#             is the tree the round-3 security critic failed
#   DEFECT 5  BARRIER ONE: `scrub_bytes` stops resolving escapes, so the byte
#             scrub is byte-literal again (round 3's tree)
#   DEFECT 6  BARRIER TWO: `decode_json` stops scrubbing the decoded value
#   DEFECT 7  `authority_of` compares host and scheme but NOT port — the
#             plausible weakening of the redirect check, and the one a reviewer
#             would be least likely to notice
#
# DEFECT 5 and DEFECT 6 are the two halves of round 4's redaction change and are
# injected separately on purpose: 8e3d3ef records a session in which BOTH were
# disabled at once and a probe still passed, which is how a third, undesigned
# defence was discovered. One at a time is the only way to attribute anything.
#
# The tree is restored from a backup on every exit path, including a failure.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../../../.."
http="$root/src-tauri/crates/vela-providers/src/http.rs"
redact="$root/src-tauri/crates/vela-providers/src/redact.rs"
out="$here/control-results-round4.txt"
http_backup="$(mktemp)"
redact_backup="$(mktemp)"

cp "$http" "$http_backup"
cp "$redact" "$redact_backup"
restore() {
  cp "$http_backup" "$http"
  cp "$redact_backup" "$redact"
  rm -f "$http_backup" "$redact_backup"
}
trap restore EXIT

run() { # run <suite> -> "N passed; M failed", or COMPILE ERROR
  local suite="$1" log
  log="$(cd "$root/src-tauri" && cargo test -q -p vela-providers --test "$suite" -- --include-ignored 2>&1)"
  printf '%s\n' "$log" | grep -oE '[0-9]+ passed; [0-9]+ failed' | tail -1 \
    || echo "COMPILE ERROR"
}

failing_tests() {
  local suite="$1" log
  log="$(cd "$root/src-tauri" && cargo test -q -p vela-providers --test "$suite" -- --include-ignored 2>&1)"
  printf '%s\n' "$log" | sed -n '/^failures:$/,/^$/p' | grep -E '^    [a-z_]+' | sed 's/^ */      /'
}

# Round 4's two surfaces, plus one suite from round 3 so the DISJOINTNESS of the
# injections is visible rather than asserted.
suites=(
  wire_redirect_egress
  encoded_credential_canary
  zz_gate_m_round4_executor_probe
  zz_integration_round4_probe
  streamed_credential_canary
)

: > "$out"
{
  echo "================================================================================"
  echo "GATE M Part 1 (Phase B) round 4 — EXECUTOR ASSERTION CONTROLS"
  echo "================================================================================"
  echo
  echo "Each defect below is re-introduced into the shipping source and the suites"
  echo "re-run. An assertion that cannot go red is not an assertion. A suite that goes"
  echo "RED here is the control PASSING."
  echo
  echo "Run with --include-ignored, so the executor probe's known-red matrix test —"
  echo "which carries round 4's open finding — is counted rather than skipped."
  echo
} >> "$out"

echo "---- BASELINE (the tree as it stands) ------------------------------------" >> "$out"
for suite in "${suites[@]}"; do
  printf '  %-34s %s\n' "$suite" "$(run "$suite")" >> "$out"
done
{
  echo
  echo "  NOTE: zz_gate_m_round4_executor_probe is EXPECTED to be red at baseline."
  echo "  Its matrix test carries round 4's open finding — see RESULTS.md §5. Every"
  echo "  other suite is green at baseline, and the deltas below are read against"
  echo "  that."
  echo
} >> "$out"

# ---------------------------------------------------------------------------
echo "---- DEFECT 4 — the redirect policy removed ------------------------------" >> "$out"
echo "  reqwest's defaults restored: Policy::limited(10) and referer: true." >> "$out"
echo "  This is the tree the round-3 security critic failed." >> "$out"
cp "$http_backup" "$http"
perl -0pi -e 's/\.redirect\(redirect_policy\(\)\)/.redirect(reqwest::redirect::Policy::limited(10)) \/\/ DEFECT 4 re-introduced/' "$http"
perl -0pi -e 's/\.referer\(false\)/.referer(true)/' "$http"
if grep -q "DEFECT 4 re-introduced" "$http"; then
  for suite in "${suites[@]}"; do
    printf '  %-34s %s\n' "$suite" "$(run "$suite")" >> "$out"
    failing_tests "$suite" >> "$out"
  done
else
  echo "  [ERROR] the patch did not apply" >> "$out"
fi
echo >> "$out"

# ---------------------------------------------------------------------------
echo "---- DEFECT 5 — BARRIER ONE: the byte scrub is byte-literal again --------" >> "$out"
echo "  scrub_bytes stops resolving escape spans; round 3's tree, exactly." >> "$out"
cp "$http_backup" "$http"
cp "$redact_backup" "$redact"
perl -0pi -e 's/        self\.replace_encoded\(out\)\n    \}/        out \/\/ DEFECT 5 re-introduced\n    }/' "$redact"
if grep -q "DEFECT 5 re-introduced" "$redact"; then
  for suite in "${suites[@]}"; do
    printf '  %-34s %s\n' "$suite" "$(run "$suite")" >> "$out"
    failing_tests "$suite" >> "$out"
  done
else
  echo "  [ERROR] the patch did not apply" >> "$out"
fi
echo >> "$out"

# ---------------------------------------------------------------------------
echo "---- DEFECT 6 — BARRIER TWO: the decoded value is not scrubbed -----------" >> "$out"
echo "  decode_json stops calling scrub_value, so anything that survived the" >> "$out"
echo "  byte scrub is handed onward as the decoder reassembled it." >> "$out"
cp "$redact_backup" "$redact"
perl -0pi -e 's/        self\.scrub_value\(&mut value\);/        \/\/ DEFECT 6 re-introduced: scrub_value removed/' "$redact"
if grep -q "DEFECT 6 re-introduced" "$redact"; then
  for suite in "${suites[@]}"; do
    printf '  %-34s %s\n' "$suite" "$(run "$suite")" >> "$out"
    failing_tests "$suite" >> "$out"
  done
else
  echo "  [ERROR] the patch did not apply" >> "$out"
fi
echo >> "$out"

# ---------------------------------------------------------------------------
echo "---- DEFECT 7 — authority_of forgets the port ----------------------------" >> "$out"
echo "  scheme and host still compared, port dropped. A redirect to a DIFFERENT" >> "$out"
echo "  SERVICE on the same host is then 'same authority' and is followed." >> "$out"
cp "$redact_backup" "$redact"
cp "$http_backup" "$http"
perl -0pi -e 's/    match \(url\.host_str\(\), url\.port_or_known_default\(\)\) \{/    \/\/ DEFECT 7 re-introduced: the port is dropped\n    match (url.host_str(), None::<u16>) {/' "$http"
if grep -q "DEFECT 7 re-introduced" "$http"; then
  for suite in "${suites[@]}"; do
    printf '  %-34s %s\n' "$suite" "$(run "$suite")" >> "$out"
    failing_tests "$suite" >> "$out"
  done
else
  echo "  [ERROR] the patch did not apply" >> "$out"
fi
echo >> "$out"

restore
trap - EXIT
echo "---- tree restored -------------------------------------------------------" >> "$out"
for suite in "${suites[@]}"; do
  printf '  %-34s %s\n' "$suite" "$(run "$suite")" >> "$out"
done

cat "$out"
