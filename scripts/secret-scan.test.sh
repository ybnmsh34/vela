#!/usr/bin/env bash
#
# Tests for `secret-scan.sh` — the tripwire's own tripwire.
#
# A scanner that has never caught anything is indistinguishable from a scanner
# that cannot catch anything. Each case below plants a **real key shape** in a
# throwaway git repository and asserts the scanner's verdict on it. The headline
# case is `docs/`: the scan used to exempt that whole tree, which is where the
# committed mock-provider transcripts live.
#
# No literal key appears in this file. Every shape is assembled at runtime from
# fragments, so the file itself stays clean under the very pattern it is
# testing — `scan_scans_itself_and_stays_clean` proves that rather than assuming
# it.
#
# Usage: scripts/secret-scan.test.sh

set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
scanner="$here/secret-scan.sh"
repo_root=$(cd "$here/.." && pwd)

passed=0
failed=0

pass() { printf 'ok   %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL %s\n     %s\n' "$1" "${2:-}"; failed=$((failed + 1)); }

# Key shapes, assembled so this file never contains one. Lengths are chosen to
# clear the pattern's minimums, exactly as a real key would.
anthropic_key="sk-ant-api03-$(printf 'A%.0s' {1..24})"
openai_key="sk-$(printf 'B%.0s' {1..40})"
google_key="AIza$(printf 'C%.0s' {1..35})"
# Split mid-literal on purpose. Written whole, this line trips the scanner when
# it scans its own repository — which is the correct behaviour, and the reason
# `scan_scans_itself_and_stays_clean` exists. Bash concatenates the adjacent
# strings, so the value below is a complete PEM header at runtime.
pem_block="-----BEGIN RSA ""PRIVATE KEY-----"

# Builds a throwaway repository containing one file, runs the scanner over it,
# and echoes "caught" or "clean".
#
#   verdict_for <relative/path> <file contents>
verdict_for() {
  local relative_path=$1 contents=$2 tmp output rc
  tmp=$(mktemp -d)
  (
    cd "$tmp" || exit 1
    git init -q .
    git config user.email tripwire@vela.test
    git config user.name Tripwire
    mkdir -p "$(dirname "$relative_path")"
    printf '%s\n' "$contents" > "$relative_path"
    git add -A
    git commit -qm 'fixture'
  ) >/dev/null 2>&1

  output=$("$scanner" --root "$tmp" 2>&1)
  rc=$?
  rm -rf "$tmp"

  if [ "$rc" -eq 0 ]; then
    echo "clean"
  else
    echo "caught"
    printf '%s\n' "$output" | sed 's/^/       | /' >&2
  fi
}

expect_caught() {
  local label=$1 path=$2 contents=$3 verdict
  verdict=$(verdict_for "$path" "$contents" 2>/dev/null)
  if [ "$verdict" = "caught" ]; then
    pass "$label"
  else
    fail "$label" "a credential at $path was NOT caught"
  fi
}

expect_clean() {
  local label=$1 path=$2 contents=$3 verdict
  verdict=$(verdict_for "$path" "$contents" 2>/dev/null)
  if [ "$verdict" = "clean" ]; then
    pass "$label"
  else
    fail "$label" "$path was flagged, but it holds no credential"
  fi
}

echo "# the finding this file exists for: docs/ is scanned"

# THE regression. `docs/regression-baseline/mock-matrix/` is where the committed
# provider transcripts live, and it sat inside the old `':!docs/**'` exclusion.
expect_caught "a key in a committed mock transcript is caught" \
  "docs/regression-baseline/mock-matrix/frontier/01-chat-plain-nonstreaming.txt" \
  "> POST /v1/chat/completions
> authorization: Bearer $openai_key
< 200 OK"

expect_caught "a key in ordinary docs prose is caught" \
  "docs/architecture/conventions.md" \
  "Set your key to $anthropic_key and restart."

expect_caught "a key in a docs JSON fixture is caught" \
  "docs/regression-baseline/mock-matrix/frontier/manifest.json" \
  "{\"apiKey\": \"$google_key\"}"

expect_caught "a private key committed under docs/ is caught" \
  "docs/desktop-gate/VERDICTS.md" \
  "$pem_block"

echo
echo "# the shapes it already covered, still covered"

expect_caught "a key in source is caught" \
  "src/platform/contract.ts" \
  "const key = '$openai_key';"

expect_caught "a key in a Rust test is caught" \
  "src-tauri/crates/vela-core/src/credential.rs" \
  "let key = \"$anthropic_key\";"

expect_caught "a tracked .env file is caught even when empty" \
  ".env.local" \
  ""

echo
echo "# no false positives, or the tripwire gets muted"

expect_clean "prose that merely contains 'sk-' is not a credential" \
  "docs/vela-feature-spec.md" \
  "Subagent handling: the pre-spawn task-description check runs first."

expect_clean "a placeholder that is not key-shaped is left alone" \
  "docs/architecture/conventions.md" \
  "Store the value under <providerId>/primary. Never a literal like sk-REPLACE-ME."

# Retitled in round 5. This plants a file and asserts clean, so it never
# checked an EMPTY repository — and since this file's own
# `a_repository_with_no_tracked_files_is_refused` proves the scanner exits 2 on
# one, the old label stated a property the scanner contradicts.
expect_clean "a repository with one harmless file is clean" \
  "README.md" \
  "# Vela"

echo
echo "# a scan that could not look must not report clean"

# THE DEFECT THIS SECTION EXISTS FOR. Both checks in the scanner used to be
# `if <git ...>; then`, which asks "did git report a match?" rather than "did
# git run, and report no match?". `if` cannot separate those, so every failure
# mode of git — a directory that is not a repository, a corrupt index, a
# missing object — took the else branch and printed the all-clear:
#
#     $ mkdir /tmp/notarepo && scripts/secret-scan.sh --root /tmp/notarepo
#     fatal: not a git repository (or any of the parent directories): .git
#     fatal: not a git repository (or any of the parent directories): .git
#     secret-scan: no credential material found in tracked files (docs/ included).
#     exit 0
#
# A tripwire whose report of "clean" also covers "I never looked" is the one
# failure a tripwire cannot have. Exit 2 is used rather than 1 so that "the scan
# broke" stays distinguishable from "a secret was found".

not_a_repo=$(mktemp -d)
"$scanner" --root "$not_a_repo" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 2 ]; then
  pass "a_directory_that_is_not_a_repository_is_refused: exit 2, not a clean 0"
else
  fail "a_directory_that_is_not_a_repository_is_refused"     "the scanner exited $rc on a directory git cannot read. Anything but 2 means a broken scan is being reported as a verdict."
fi
rm -rf "$not_a_repo"

empty_repo=$(mktemp -d)
git -C "$empty_repo" init -q .
"$scanner" --root "$empty_repo" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 2 ]; then
  pass "a_repository_with_no_tracked_files_is_refused: exit 2, not a clean 0"
else
  fail "a_repository_with_no_tracked_files_is_refused"     "the scanner exited $rc on a repository with nothing in it. Zero files satisfies every assertion this scanner makes, which is a vacuous pass."
fi
rm -rf "$empty_repo"

# The control for both. A real repository with one harmless file must still come
# back clean and exit 0 — a scanner that refused everything would pass the two
# checks above while being useless.
control_repo=$(mktemp -d)
(
  cd "$control_repo" || exit 1
  git init -q .
  git config user.email tripwire@vela.test
  git config user.name Tripwire
  printf '# nothing to see
' > README.md
  git add -A
  git commit -qm fixture
) >/dev/null 2>&1
"$scanner" --root "$control_repo" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
  pass "a_real_repository_still_passes: the refusals above are about broken scans, not about everything"
else
  fail "a_real_repository_still_passes" "the scanner exited $rc on a clean one-file repository"
fi
rm -rf "$control_repo"

echo
echo "# the scanner and this test are themselves in scope"

# The old workflow excluded `.github/workflows/ci.yml` because it held the
# pattern inline. Now nothing is excluded, so both these files have to survive
# their own scan. If either ever fails here, the fix is to split the offending
# literal — never to add an exclusion.
if out=$("$scanner" --root "$repo_root" 2>&1); then
  pass "scan_scans_itself_and_stays_clean: the real tree passes with no exclusions"
else
  fail "scan_scans_itself_and_stays_clean" "$out"
fi

if grep -qE '^excluded_paths=\(\)$' "$scanner"; then
  pass "exclusions_are_exact_paths_never_globs: the exclusion list is empty"
elif grep -A20 '^excluded_paths=(' "$scanner" | sed -n '/^excluded_paths=(/,/^)/p' | grep -q '\*'; then
  fail "exclusions_are_exact_paths_never_globs" \
    "a glob appeared in excluded_paths; that is how the docs/ blind spot got here"
else
  pass "exclusions_are_exact_paths_never_globs: no glob in excluded_paths"
fi

echo
printf '%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
