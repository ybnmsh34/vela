#!/usr/bin/env bash
#
# GATE M — the debug log's file and directory modes, measured FROM A SHELL.
#
#   scripts/gate-m-debug-log-modes.sh [output-file]
#
# ## What this measures that the unit tests do not
#
# `vela-providers/src/debuglog.rs` and `src-tauri/src/ipc/diagnostics.rs` both
# assert `0600` / `0700` from inside the process that created the file, reading
# the mode with the same `std::fs` the code under test used. That is a good
# assertion and a poor measurement. It shares a process, a umask and a standard
# library with the thing it is checking, and it cannot see a mode that is
# correct at creation and widened a moment later.
#
# This runs the switch through the **real `diagnostics_debug_log_set` command in
# the assembled app** (`debug_log_evidence_driver`, which is `#[ignore]`d
# precisely so it is only ever run from here), then closes the process and asks
# `stat` — the same tool a user would reach for.
#
# Two cases, because they fail differently:
#
#   CLEAN  a data home with nothing in it. Proves the modes are chosen, not
#          inherited from a permissive umask that happened to be right.
#   LOOSE  a `diagnostics/` directory at 0755 holding a log at 0644 with a line
#          already in it — an earlier run, or a build from before this rule.
#          Proves the modes are *tightened* rather than accepted, and that the
#          existing contents survive the tightening. A "fix" that achieved 0600
#          by deleting the user's log would be a worse bug than the one it
#          closed, and only this case can see it.
#
# The umask is set to 0022 deliberately: it is the ordinary default, and it is
# the one under which `create_dir_all` would produce 0755 and `File::create`
# 0644. Running under a tight umask would let a wrong implementation pass.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-}"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

umask 0022

app_id="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['identifier'])" \
  "$repo_root/src-tauri/tauri.conf.json")"

report=()
failures=0

say() {
  printf '%s\n' "$*"
  report+=("$*")
}

check() {
  local claim="$1" actual="$2" wanted="$3"
  if [[ "$actual" == "$wanted" ]]; then
    say "PASS  $claim  (got $actual)"
  else
    say "FAIL  $claim  (wanted $wanted, got $actual)"
    failures=$((failures + 1))
  fi
}

drive() {
  local home="$1"
  (
    cd "$repo_root/src-tauri"
    VELA_GATE_DEBUG_LOG_HOME="$home" \
      cargo test --quiet --test gate_m_assembled_app -- \
      --ignored --exact --nocapture debug_log_evidence_driver
  )
}

say "umask                 $(umask)"
say "identifier            $app_id"
say ""

# ---------------------------------------------------------------------------
# CLEAN — nothing exists before the switch is thrown
# ---------------------------------------------------------------------------

clean_home="$scratch/clean"
mkdir -p "$clean_home"
say "== CLEAN — a data home with nothing in it =="
drive "$clean_home" > "$scratch/clean.log" 2>&1 || {
  say "FAIL  the evidence driver did not complete; see below"
  tail -40 "$scratch/clean.log" | while IFS= read -r line; do say "      $line"; done
  failures=$((failures + 1))
}

clean_dir="$clean_home/$app_id/diagnostics"
clean_log="$clean_dir/exchanges.jsonl"
say "directory             $clean_dir"
say "log                   $clean_log"
check "the diagnostics directory is 0700" "$(stat -c '%a' "$clean_dir" 2>/dev/null || echo missing)" "700"
check "the debug log is 0600" "$(stat -c '%a' "$clean_log" 2>/dev/null || echo missing)" "600"
say "ls -ld                $(ls -ld "$clean_dir" 2>/dev/null | awk '{print $1}')"
say "ls -l                 $(ls -l "$clean_log" 2>/dev/null | awk '{print $1}')"
say "lines recorded        $(wc -l < "$clean_log" 2>/dev/null || echo 0)"
say ""

# ---------------------------------------------------------------------------
# LOOSE — a world-readable directory and log are already there
# ---------------------------------------------------------------------------

loose_home="$scratch/loose"
loose_dir="$loose_home/$app_id/diagnostics"
loose_log="$loose_dir/exchanges.jsonl"
mkdir -p "$loose_dir"
chmod 0755 "$loose_dir"
printf '{"note":"a line from an earlier run"}\n' > "$loose_log"
chmod 0644 "$loose_log"

say "== LOOSE — 0755 directory holding a 0644 log with a line already in it =="
say "before: directory     $(stat -c '%a' "$loose_dir")"
say "before: log           $(stat -c '%a' "$loose_log")"
drive "$loose_home" > "$scratch/loose.log" 2>&1 || {
  say "FAIL  the evidence driver did not complete; see below"
  tail -40 "$scratch/loose.log" | while IFS= read -r line; do say "      $line"; done
  failures=$((failures + 1))
}
check "the pre-existing directory is tightened to 0700" "$(stat -c '%a' "$loose_dir" 2>/dev/null || echo missing)" "700"
check "the pre-existing log is tightened to 0600" "$(stat -c '%a' "$loose_log" 2>/dev/null || echo missing)" "600"
if grep -q 'a line from an earlier run' "$loose_log"; then
  say "PASS  the line that was already in the log is still in it"
else
  say "FAIL  tightening the log destroyed its contents"
  failures=$((failures + 1))
fi
say "lines recorded        $(wc -l < "$loose_log" 2>/dev/null || echo 0)"
say ""

# ---------------------------------------------------------------------------
# CONTROL — the measurement can fail
# ---------------------------------------------------------------------------
#
# A mode check that cannot come back wrong proves nothing about the app. This
# widens a copy of the real log and re-reads it through the identical `stat`
# call, so the reader is shown failing on a file that is genuinely loose.

control_log="$scratch/control-exchanges.jsonl"
cp "$clean_log" "$control_log"
chmod 0644 "$control_log"
say "== CONTROL — the same reader, on a deliberately loose copy =="
control_mode="$(stat -c '%a' "$control_log")"
if [[ "$control_mode" == "600" ]]; then
  say "FAIL  the mode reader cannot distinguish 0644 from 0600 — every result above is void"
  failures=$((failures + 1))
else
  say "PASS  the reader reports $control_mode on a 0644 copy, so 600 above is a measurement"
fi

say ""
say "failures              $failures"

if [[ -n "$out" ]]; then
  printf '%s\n' "${report[@]}" > "$out"
fi

exit $((failures == 0 ? 0 : 1))
