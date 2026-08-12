#!/usr/bin/env bash
#
# The mock-matrix transcripts are reproducible.
#
# The harness is deterministic by design — fixed seed, injected clock — so
# regenerating the transcripts must produce byte-identical files. A diff means
# provider or harness behaviour actually moved, and the committed GATE M
# evidence no longer describes the code that is in the tree.
#
# This exists as a script rather than inline in `.github/workflows/ci.yml` for
# the same reason `secret-scan.sh` does: a check that only runs in CI is a check
# builders discover by breaking. `pnpm verify` runs it locally, and CI runs the
# same file.
#
# Exit 0 = transcripts unchanged, 1 = they moved (the diffstat is printed).

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

evidence='docs/regression-baseline/mock-matrix'

node tests/harness/mock-provider/src/record-transcripts.ts

if git diff --quiet -- "$evidence"; then
  echo "check-transcripts: $evidence is byte-identical after regeneration."
  exit 0
fi

echo "check-transcripts: FAILED — the mock-matrix transcripts changed." >&2
echo "Provider or harness behaviour moved. Review the diff; if the new behaviour" >&2
echo "is correct, commit the regenerated evidence with it." >&2
git --no-pager diff --stat -- "$evidence" >&2
exit 1
