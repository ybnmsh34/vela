#!/usr/bin/env bash
# GATE M Part 1, Phase B2 — the executor's assertion controls.
#
# Every assertion cases 15–20 and case 07c arm C rest on is applied here to a
# tree in which the thing it protects has been BROKEN, and the resulting reds
# are recorded. An assertion nobody has watched fail is not evidence.
#
# ---------------------------------------------------------------------------
# WHY THIS SCRIPT COPIES THE TREE, AND ITS PREDECESSORS DID NOT
# ---------------------------------------------------------------------------
#
# `../../phase-b-matrix/structural/controls.sh` and `controls-round4.sh` inject
# their defects INTO THE WORKING TREE and restore from a backup on exit. That is
# safe when one session owns the repo. It is not safe here: a concurrent Phase C
# session shares this checkout and this index, and the run has already lost work
# to exactly that (see "Run incidents", 2026-08-13 ~08:0xZ). A `trap restore
# EXIT` does not help if the other session reads the tree, or stages it, during
# the seconds the defect is in place — and it does not help at all if this
# script is killed with SIGKILL.
#
# So B2's injections happen in a COPY under $TMPDIR. The shared tree is only
# ever read. The copy excludes `target/`, `node_modules/` and `.git/` — twelve
# megabytes — and builds into its own `CARGO_TARGET_DIR` so the injections are
# incremental with respect to each other but share nothing with the real build.
#
# ---------------------------------------------------------------------------
# WHAT IS RUN
# ---------------------------------------------------------------------------
#
# The recorder itself, in the copy. Cases 15–20 live in the recorder rather than
# in `tests/`, so the recorder IS their acceptance test, and running it reports
# which CASE went red — which is the attribution a reader needs.
#
# The copy's recorder writes its evidence into the copy's own `docs/` tree,
# because `repo_root()` is derived from `CARGO_MANIFEST_DIR`. Nothing this
# script does can write into the committed evidence.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
out="$here/control-results-b2.txt"
scratch="$(mktemp -d -t vela-b2-controls-XXXXXX)"
export CARGO_TARGET_DIR="$scratch/.target"

cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT

echo "==> copying the tree to $scratch (target/, node_modules/, .git/ excluded)"
tar -C "$root" \
    --exclude=./src-tauri/target \
    --exclude=./node_modules \
    --exclude=./.git \
    --exclude=./dist \
    -cf - . | tar -C "$scratch" -xf -

src="$scratch/src-tauri/crates/vela-providers/src"

# ---------------------------------------------------------------------------
# Machinery
# ---------------------------------------------------------------------------

# run_recorder -> writes the run's SUMMARY to stdout, or "COMPILE ERROR".
run_recorder() {
  local log
  log="$(cd "$scratch/src-tauri" && timeout 900 cargo run -q -p vela-providers \
        --example gate_m_phase_b2 2>&1)"
  if printf '%s' "$log" | grep -q '^error\[\|^error:'; then
    echo "COMPILE ERROR"
    printf '%s\n' "$log" | grep -E '^error' | head -3
    return
  fi
  printf '%s\n' "$log"
}

# red_cases <summary> -> the distinct case names that failed, one per line
red_cases() {
  printf '%s\n' "$1" | grep -oE '/ [0-9]{2}[a-z]?-[a-z0-9-]+ /' | tr -d '/ ' | sort -u
}

# The recorder's OWN controls, as PASS/FAIL lines. Two of B2's injections
# (DEFECT 4 and DEFECT 7 in the first run) moved the gate count by zero, and the
# reason in both cases was that what they break is watched by a CONTROL rather
# than by a gate assertion — and control FAILs are excluded from the gate count
# by design. Reporting only the gate count therefore called two working
# experiments "no effect". This is the second channel.
control_lines() {
  local file="$scratch/docs/regression-baseline/phase-b2-matrix/ASSERTION-CONTROL.txt"
  [ -f "$file" ] && grep -E '→ (PASS|FAIL)$' "$file" || true
}

failure_count() {
  printf '%s\n' "$1" | grep -oE '^failures +[0-9]+' | grep -oE '[0-9]+' | head -1
}

record() { printf '%s\n' "$*" >>"$out"; }

: >"$out"
record "GATE M Part 1 (Phase B2) — EXECUTOR ASSERTION CONTROLS"
record "================================================================================"
record ""
record "Seven defects, injected ONE AT A TIME into a COPY of the tree under \$TMPDIR, with"
record "the recorder re-run after each. The shared working tree is never modified — a"
record "concurrent session owns it, and this run has already lost work to a script that"
record "assumed otherwise."
record ""
record "Each block names the defect, the assertion it is aimed at, what was expected, and"
record "what was observed. A defect that turns nothing red is reported as such: it means"
record "the assertion above it is not protecting what it claims to."
record ""

# ---------------------------------------------------------------------------
# The baseline. Without it, a red below could be a red the copy already had.
# ---------------------------------------------------------------------------
echo "==> baseline (no defect)"
baseline="$(run_recorder)"
baseline_failures="$(failure_count "$baseline")"
record "--------------------------------------------------------------------------------"
record "BASELINE — the copy, unmodified"
record "--------------------------------------------------------------------------------"
record "  gate failures: ${baseline_failures:-?}"
record "  red cases:"
red_cases "$baseline" | sed 's/^/    /' >>"$out"
record ""
record "  This is the tree as committed. FINDING 4 (case 16) is red here and is red in"
record "  every block below; a reader attributing a defect to an injection must subtract"
record "  this line first."
record ""
baseline_controls="$scratch/.baseline-controls.txt"
control_lines >"$baseline_controls"
record "  recorder control lines captured for comparison: $(wc -l <"$baseline_controls")"
record ""

# ---------------------------------------------------------------------------
# experiment <n> <title> <aim> <expected> <sed-script> <file>
# ---------------------------------------------------------------------------
experiment() {
  local n="$1" title="$2" aim="$3" expected="$4" script="$5" file="$6"
  echo "==> DEFECT $n — $title"
  cp "$file" "$file.bak"
  perl -0pi -e "$script" "$file"
  if cmp -s "$file" "$file.bak"; then
    record "--------------------------------------------------------------------------------"
    record "DEFECT $n — $title"
    record "--------------------------------------------------------------------------------"
    record "  *** THE INJECTION DID NOT APPLY *** — the anchor text has moved. Reported"
    record "  rather than silently skipped: an experiment that did not run must not be"
    record "  counted as one that produced no effect."
    record ""
    mv "$file.bak" "$file"
    return
  fi
  local summary failures
  summary="$(run_recorder)"
  failures="$(failure_count "$summary")"
  record "--------------------------------------------------------------------------------"
  record "DEFECT $n — $title"
  record "--------------------------------------------------------------------------------"
  record "  AIM        $aim"
  record "  EXPECTED   $expected"
  record "  OBSERVED   gate failures: ${failures:-COMPILE ERROR} (baseline ${baseline_failures:-?})"
  record "  red cases:"
  red_cases "$summary" | sed 's/^/    /' >>"$out"
  local flipped
  # `grep -v 'wall clock'` because two control lines carry a measured duration
  # that differs every run. Leaving them in would put four lines of scheduling
  # noise in front of every real flip, which is how a real flip gets skipped.
  flipped="$(control_lines | diff "$baseline_controls" - | grep -E '^[<>]' \
             | grep -v 'wall clock' || true)"
  if [ -n "$flipped" ]; then
    record "  recorder CONTROL lines that changed:"
    printf '%s\n' "$flipped" | sed 's/^/    /' >>"$out"
  else
    record "  recorder CONTROL lines that changed: none"
  fi
  if [ "${failures:-0}" -le "${baseline_failures:-0}" ] 2>/dev/null && [ -z "$flipped" ]; then
    record ""
    record "  NOTE: this injection moved NEITHER the gate count NOR any control line. Either"
    record "  the assertion it targets is not load-bearing, or the defect is not the defect"
    record "  it looks like. Reported as a gap rather than dropped."
  fi
  record ""
  mv "$file.bak" "$file"
}

experiment 1 \
  "the FINDING 3 quarantine removed from the answer channel" \
  "cases 14 and 15 — 'a call recovered from a never-closed <think> is NOT executable'" \
  "cases 14, 15 and 20 go red — 20 because its second-bound arm salvages a call out of \
deliberation and so depends on the same quarantine" \
  's/let \(visible, quarantined\) = if self\.emulated \{/let (visible, quarantined) = if false {/' \
  "$src/answer.rs"

experiment 2 \
  "CANDIDATE FIX for FINDING 4 — extract_json stops scavenging a loose object" \
  "case 16 — 'the rejected value is not handed back as a conforming structured answer'" \
  "case 16 goes GREEN. This is a POSITIVE control: it is the only block here that is \
not a defect, and it exists to show the finding's cause is where the report says it is — \
and to show what the naive fix costs elsewhere" \
  's/    \/\/ The first balanced object in the text\./    return None; \/\/ INJECTED: the scavenging fallback, removed.\n    \/\/ The first balanced object in the text./' \
  "$src/structured.rs"

experiment 3 \
  "the raw-argument bound raised from 400 to 40000 characters" \
  "case 20 — 'the deliberate carry is BOUNDED'" \
  "case 20 goes red on the arms whose payload exceeds 401 characters" \
  's/const MAX_RAW_ARGUMENTS: usize = 400;/const MAX_RAW_ARGUMENTS: usize = 40000;/' \
  "$src/tool_accum.rs"

experiment 4 \
  "the salvaged-call bound raised the same way, in the other place it lives" \
  "case 20 — the same assertion, reached through answer.rs rather than tool_accum.rs" \
  "case 20 goes red; injected separately from DEFECT 3 because two bounds in two files \
is exactly the shape that let round 4's percent-encoding fix cover one binding of three" \
  's/    let mut out: String = raw\.chars\(\)\.take\(400\)\.collect\(\);/    let mut out: String = raw.chars().take(400000).collect();/' \
  "$src/answer.rs"

experiment 5 \
  "malformed frames counted but never reported" \
  "case 17 — 'the stream really did carry junk', the PREMISE of the whole case" \
  "case 17's premise assertion goes red, and case 08's with it. A premise nobody can \
watch fail is not a premise" \
  's/        if self\.malformed_frames > 0 \{\n            degradations\.push\(Degradation::MalformedFramesSkipped \{/        if false \&\& self.malformed_frames > 0 {\n            degradations.push(Degradation::MalformedFramesSkipped {/g' \
  "$src/stream.rs"

experiment 6 \
  "a cancelled turn becomes failable-over" \
  "case 19 — 'THE SECOND CANDIDATE WAS NEVER CONTACTED'" \
  "case 19 goes red — and the router arm is the one that matters, because that is \
where the user's stop would have STARTED a turn on a second endpoint" \
  's/            \| ProviderError::Cancelled => false,/            => false,\n            ProviderError::Cancelled => true,/' \
  "$src/error.rs"

experiment 7 \
  "the closed-vocabulary audit given the 'looks like an identifier' exemption" \
  "case 18 — 'NO ENDPOINT-DERIVED TEXT ON ANY ERROR SURFACE'" \
  "control 15's BARE IDENTIFIER line flips from FAIL to PASS — the audit goes blind to \
exactly the leak diagnostic.rs's comment says this exemption would wave through. The gate \
count does NOT move, because B2 carries no endpoint text for the audit to miss; the \
control is the only place this is visible, which is why the control channel exists" \
  's/            if allowed\.iter\(\)\.any\(\|candidate\| candidate == text\) \{/            if text.chars().all(|c| c.is_ascii_alphanumeric()) {\n                return;\n            }\n            if allowed.iter().any(|candidate| candidate == text) {/' \
  "$src/diagnostic.rs"

record "================================================================================"
record "Reproduce:  bash docs/regression-baseline/phase-b2-matrix/structural/controls-b2.sh"
record "The shared working tree is read, never written. Everything happens in \$TMPDIR."
record "================================================================================"

echo "==> wrote $out"
