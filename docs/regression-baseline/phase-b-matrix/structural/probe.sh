#!/usr/bin/env bash
# GATE M Part 1, Phase B, round 3 — the executor's compile-time structural probe.
#
# Round 3 claims that an unscrubbed body read is "not expressible". A claim of
# that shape is only worth anything if someone who did not write the fix tries
# to express it anyway. Each probe-NN-*.rs beside this script is one attempt.
#
# Every probe is compiled as a real example against the real crate. A probe that
# COMPILES is a gate failure: it means the bypass it describes is writable.
#
# Output: probe-results.txt beside this script. Exits non-zero if any probe
# compiled or if any probe failed for a reason other than the one it predicts.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
crate="$here/../../../../src-tauri/crates/vela-providers"
examples="$crate/examples"
out="$here/probe-results.txt"

# ONE HATCH PER FILE. They were bundled until the controls run, where unsealing
# `BodyStream::inner` left the bundle still failing on the other two hatches and
# the probe reported "rejected" against a tree that had the hole. A probe that
# cannot fail for one reason at a time is not measuring one thing.
declare -A expect=(
  [probe-01-round2-shape]="E0308"
  [probe-02-declare-scrubber]="E0407"
  [probe-03-private-field]="E0616"
  [probe-04-into-inner]="E0599"
  [probe-05-body-is-not-a-raw-stream]="E0277"
)

: > "$out"
{
  echo "================================================================================"
  echo "GATE M Part 1 (Phase B) round 3 — compile-time structural probes"
  echo "================================================================================"
  echo
  echo "CLAIM     A body that reads bytes without the scrubber is not expressible."
  echo "METHOD    Each probe is compiled as a real example against vela-providers."
  echo "VERDICT   A probe that COMPILES is a gate failure."
  echo
} >> "$out"

status=0
for probe in probe-01-round2-shape probe-02-declare-scrubber probe-03-private-field \
             probe-04-into-inner probe-05-body-is-not-a-raw-stream; do
  cp "$here/$probe.rs" "$examples/zz_probe_tmp.rs"
  log="$(cd "$crate/../.." && cargo build -q --example zz_probe_tmp -p vela-providers 2>&1)"
  built=$?
  rm -f "$examples/zz_probe_tmp.rs"

  {
    echo "---- $probe ----------------------------------------------------"
    sed -n '2,12p' "$here/$probe.rs" | sed 's|^// *||;s|^//$||'
    echo
  } >> "$out"

  if [ $built -eq 0 ]; then
    echo "  [FAIL] IT COMPILED — this bypass is writable." >> "$out"
    status=1
  else
    codes="$(printf '%s\n' "$log" | grep -oE 'error\[E[0-9]+\]' | sort -u | tr '\n' ' ')"
    echo "  [PASS] rejected by the compiler" >> "$out"
    echo "  codes observed: ${codes:-none}" >> "$out"
    echo "  expected among: ${expect[$probe]}" >> "$out"
    matched=0
    for want in ${expect[$probe]}; do
      case "$codes" in *"error[$want]"*) matched=1 ;; esac
    done
    if [ $matched -eq 0 ]; then
      echo "  [FAIL] rejected, but not for the predicted reason — read the log" >> "$out"
      status=1
    fi
    echo "  verbatim:" >> "$out"
    printf '%s\n' "$log" | grep -E '^(error|  -->|  = help|  = note|warning: unused)' \
      | head -24 | sed 's/^/    /' >> "$out"
  fi
  echo >> "$out"
done

if [ $status -eq 0 ]; then
  echo "ALL PROBES REJECTED. The bypass is not expressible." >> "$out"
else
  echo "AT LEAST ONE PROBE COMPILED OR MISFIRED — GATE FAILURE." >> "$out"
fi
cat "$out"
exit $status
