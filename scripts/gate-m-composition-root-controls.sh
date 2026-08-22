#!/usr/bin/env bash
#
# GATE M — assertion controls for `src-tauri/tests/gate_m_assembled_app.rs`.
#
# A green test file says nothing until its assertions have been watched failing.
# This script breaks the composition root, one joint at a time, and records
# which assertions go red.
#
# ---------------------------------------------------------------------------
# THE DEFECT IS NEVER PUT IN THE SHARED TREE
# ---------------------------------------------------------------------------
#
# Every mutation happens in a DETACHED `git worktree` under $TMPDIR, with its
# own CARGO_TARGET_DIR. /home/user/vela is only ever read. A concurrent session
# shares this checkout, and a `trap restore EXIT` is no help to it during the
# seconds a defect is in place — nor any help at all under SIGKILL.
#
# Usage: scripts/gate-m-composition-root-controls.sh [output-file]

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$REPO/docs/regression-baseline/gate-m-composition-root/ASSERTION-CONTROL.txt}"
WORK="${TMPDIR:-/tmp}/vela-gate-m-controls"
export CARGO_TARGET_DIR="${TMPDIR:-/tmp}/vela-gate-m-controls-target"

rm -rf "$WORK"
git -C "$REPO" worktree remove --force "$WORK" >/dev/null 2>&1
git -C "$REPO" worktree add --detach "$WORK" HEAD >/dev/null 2>&1 || {
  echo "could not create the scratch worktree" >&2
  exit 1
}
SHA="$(git -C "$WORK" rev-parse --short HEAD)"

cleanup() {
  git -C "$REPO" worktree remove --force "$WORK" >/dev/null 2>&1
}
trap cleanup EXIT

mkdir -p "$(dirname "$OUT")"
{
  echo "GATE M — ASSERTION CONTROLS for the assembled application"
  echo "========================================================="
  echo
  echo "Each control breaks ONE joint of the composition root and records which"
  echo "assertions of tests/gate_m_assembled_app.rs go red. An assertion that"
  echo "stays green under the defect it claims to detect is not evidence."
  echo
  echo "worktree : $WORK  (detached at $SHA)"
  echo "target   : $CARGO_TARGET_DIR"
  echo "The shared checkout at $REPO is only read."
  echo
} > "$OUT"

# Runs the gate test in the worktree and prints its per-test verdicts.
run_gate() {
  ( cd "$WORK/src-tauri" \
      && cargo test --offline --test gate_m_assembled_app -- --test-threads=1 2>&1 ) \
    | grep -E "^test [a-z_]+ \.\.\.|^error(\[|:)|^test result:" \
    | sed 's/^/    /'
}

restore() {
  git -C "$WORK" reset -q --hard HEAD
  git -C "$WORK" clean -qfd
}

control() {
  local id="$1" title="$2"
  shift 2
  {
    echo
    echo "=== $id — $title ==="
  } >> "$OUT"
  "$@" >> "$OUT" 2>&1
  run_gate >> "$OUT"
  restore
}

# --------------------------------------------------------------------------
# C0 — the baseline. Everything green before anything is broken.
# --------------------------------------------------------------------------
{
  echo "=== C0 — BASELINE: the unmodified tree ==="
} >> "$OUT"
run_gate >> "$OUT"

# --------------------------------------------------------------------------
# C1 — startup never fills the provider set from the database.
#      The exact pre-fix `run()`.
# --------------------------------------------------------------------------
c1() {
  echo "    edit: delete the sync_from_settings call from run()'s setup"
  python3 - "$WORK" <<'PY'
import re, sys, pathlib
p = pathlib.Path(sys.argv[1]) / "src-tauri/src/lib.rs"
s = p.read_text()
start = s.index("            let report = app")
end = s.index("            }\n", s.index("for (id, error) in &report.failed")) + len("            }\n")
p.write_text(s[:start] + "            let _ = &store;\n" + s[end:])
PY
}
control C1 "startup never syncs the provider set from settings" c1

# --------------------------------------------------------------------------
# C2 — configuring an endpoint writes the row but builds no provider.
#      The exact pre-fix `settings_put_provider`.
# --------------------------------------------------------------------------
c2() {
  echo "    edit: settings::put_provider stops installing into the ProviderHost"
  python3 - "$WORK" <<'PY'
import sys, pathlib, re
p = pathlib.Path(sys.argv[1]) / "src-tauri/src/ipc/settings.rs"
s = p.read_text()
s = s.replace("    providers.install(&config)?;\n", "    let _ = providers;\n", 1)
p.write_text(s)
PY
}
control C2 "a configured endpoint is written but never built" c2

# --------------------------------------------------------------------------
# C3 — the debug-log handle is never managed, so the switch has no caller.
# --------------------------------------------------------------------------
c3() {
  echo "    edit: drop the DebugLogHandle from run()'s setup"
  python3 - "$WORK" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]) / "src-tauri/src/lib.rs"
s = p.read_text()
start = s.index("            app.manage(ipc::diagnostics::DebugLogHandle::under_data_dir(")
end = s.index("            ));\n", start) + len("            ));\n")
p.write_text(s[:start] + s[end:])
PY
}
control C3 "the debug-log switch is left with no caller in the app" c3

# --------------------------------------------------------------------------
# C4 — the IPC contract narrows back: no image, no tool catalogue on the wire.
# --------------------------------------------------------------------------
c4() {
  echo "    edit: build_request drops tools and non-text parts, as before the wave"
  python3 - "$WORK" <<'PY'
import sys, pathlib, re
p = pathlib.Path(sys.argv[1]) / "src-tauri/src/ipc/chat.rs"
s = p.read_text()
s = s.replace(".with_tools(validated_tools(&req.tools)?)", ".with_tools(Vec::new())", 1)
s = s.replace("    let extra = to_provider_parts(&message.parts, whose)?;", "    let _ = whose;\n    let extra: Vec<ContentPart> = Vec::new();", 1)
p.write_text(s)
PY
}
control C4 "the chat IPC can no longer carry an image or a tool" c4

# --------------------------------------------------------------------------
# C5 — the system of record goes back to memory, so nothing outlives a restart.
# --------------------------------------------------------------------------
c5() {
  echo "    edit: store_host::open returns an in-memory database"
  python3 - "$WORK" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]) / "src-tauri/src/store_host.rs"
s = p.read_text()
s = s.replace("    let location = database_location(app)?;", "    let location = DatabaseLocation::InMemory;\n    let _ = database_location(app)?;", 1)
p.write_text(s)
PY
}
control C5 "the transcript is kept in memory instead of on disk" c5

# --------------------------------------------------------------------------
# C6 — a command is dropped from the handler list, so the renderer loses it.
# --------------------------------------------------------------------------
c6() {
  echo "    edit: remove app_info from generate_handler!"
  python3 - "$WORK" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]) / "src-tauri/src/lib.rs"
s = p.read_text()
s = s.replace("            ipc::app::app_info,\n", "", 1)
p.write_text(s)
PY
}
control C6 "a command is missing from the invoke handler" c6

{
  echo
  echo "=== the scratch worktree, after every control ==="
  git -C "$WORK" status --short
  echo "(nothing above this line means clean)"
} >> "$OUT"

echo "wrote $OUT"
