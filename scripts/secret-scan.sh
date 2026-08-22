#!/usr/bin/env bash
#
# Vela's secret tripwire.
#
# Failing this means credential material reached the tree. It is deliberately
# crude and deliberately cheap: the real guarantee is that keys live only in the
# OS keychain (see `vela-secrets`, and `vela-settings/tests/no_plaintext_on_disk.rs`
# which proves it against a real SQLite file). This is the tripwire behind that.
#
# It lives in a script rather than inline in `.github/workflows/ci.yml` for one
# reason: a tripwire nobody can run is a tripwire nobody tests. `secret-scan.test.sh`
# next to it plants real key shapes in throwaway repositories and proves this
# script catches each one — including under `docs/`.
#
# Usage:
#   scripts/secret-scan.sh [--root <dir>]
#
# Exit 0 = clean, 1 = something matched (and is printed), 2 = usage error.

set -euo pipefail

root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
while [ $# -gt 0 ]; do
  case "$1" in
    --root) root=${2:?--root needs a directory}; shift 2 ;;
    -h|--help) sed -n '3,20p' "$0"; exit 0 ;;
    *) echo "secret-scan: unknown argument \`$1\`" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# What counts as credential material.
#
# Assembled from parts so the script's own text cannot match the pattern it
# carries — `scan_scans_itself_and_stays_clean` in the test file pins that.
# ---------------------------------------------------------------------------
anthropic='sk-ant-''[A-Za-z0-9_-]{20,}'
openai='sk-''[A-Za-z0-9]{32,}'
google='AIza''[A-Za-z0-9_-]{30,}'
pem='-----BEGIN ''[A-Z ]*''PRIVATE KEY-----'
pattern="($anthropic|$openai|$google|$pem)"

# ---------------------------------------------------------------------------
# Exclusions.
#
# THERE ARE NONE, AND THAT IS THE POINT.
#
# This scan used to carry `':!docs/**'`, which exempted the entire documentation
# tree — including `docs/regression-baseline/mock-matrix/`, where the committed
# provider transcripts live. Transcripts are exactly the kind of file a real key
# gets pasted into by accident, so the one directory most likely to leak was the
# one directory never checked. Phase A's security critic read `docs/` by hand and
# found it clean; that verdict expires the moment someone commits again.
#
# If a genuine false positive ever appears, add the **exact file path** here —
# never a glob, never a directory. `exclusions_are_exact_paths_never_globs` in
# the test file fails the build if a `*` shows up in this array, because a glob
# is how the blind spot got here the first time.
excluded_paths=()

exclude_args=()
for path in ${excluded_paths[@]+"${excluded_paths[@]}"}; do
  exclude_args+=(":!$path")
done

status=0

# `-I` skips binary files; `-n` names the line so a hit is actionable.
if git -C "$root" grep -nIE "$pattern" -- . ${exclude_args[@]+"${exclude_args[@]}"}; then
  echo "::error::Possible credential material found in tracked files."
  status=1
fi

if git -C "$root" ls-files | grep -E '(^|/)\.env($|\.)'; then
  echo "::error::A .env file is tracked. Credentials must live in the OS keychain."
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "secret-scan: no credential material found in tracked files (docs/ included)."
fi

exit "$status"
