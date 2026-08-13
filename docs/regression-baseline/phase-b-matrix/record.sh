#!/usr/bin/env bash
# GATE M Part 1, Phase B — regenerate every transcript in this directory.
#
# Drives Vela's own provider stack against all four capability-matrix profiles,
# each started as a real OS process on a loopback port the OS chooses. Overwrites
# the transcripts in place; because the mock servers are deterministic, `git diff`
# over this directory is itself a regression test — with one documented exception:
# wall-clock lines and the ephemeral ports in the recorded URLs differ every run.
#
# Needs Node 22+ on PATH. The recorder starts and stops its own servers.
#
# Exits non-zero if any gate assertion fails.
set -euo pipefail
cd "$(dirname "$0")/../../../src-tauri"
exec cargo run -q -p vela-providers --example gate_m_phase_b
