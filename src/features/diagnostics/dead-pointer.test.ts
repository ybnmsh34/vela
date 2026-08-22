/**
 * A pointer must not outlive the thing it points at.
 *
 * ## The defect
 *
 * Vela deliberately stopped carrying endpoint-supplied text in the errors it
 * renders, and replaced it with a correlation id into a local, opt-in debug
 * log. `MessageTurn.tsx` prints that id as `trace 0000000000000002` on every
 * failed turn.
 *
 * `vela_providers::debuglog::enable` was called **nowhere outside tests**. No
 * Tauri command, no setting, no UI affordance. The log could not be turned on
 * by anything the shipping application contained, so the id pointed into a file
 * that was never written — and a reference to nothing is worse than no
 * reference at all, because it reads to a user as something they failed to
 * find rather than something that does not exist.
 *
 * ## Why the guard is structural
 *
 * Nothing *behavioural* was broken. Every unit test of the error surface
 * passed, every unit test of the debug log passed, and the two were never
 * connected — which is the shape of every defect in this wave. A behavioural
 * test cannot catch "these two correct things do not know about each other";
 * only reading the tree can, so the tree is read.
 *
 * This file imports nothing but the contract and the filesystem on purpose: it
 * has to be runnable against a tree in which the diagnostics feature does not
 * exist, which is exactly the tree it is evidence about.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { COMMAND_ALLOWLIST } from '@/platform/contract';

const REPO_ROOT = process.cwd();

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

describe('the trace pointer has something to point at', () => {
  it('is printed only by a component that knows whether the log is recording', () => {
    const turn = read('src/features/conversation/MessageTurn.tsx');
    // Anchor: if the id stops being printed here this guard has moved, not
    // passed. It must fail loudly rather than quietly become vacuous.
    expect(turn, 'this guard is anchored on the component that prints the id').toContain('trace ');
    expect(
      turn.includes('useDebugLogStore'),
      'MessageTurn prints a `trace` id, which is a reference into the local ' +
        'debug log. It must read whether that log is recording, or it is once ' +
        'again pointing the user at a file that does not exist.',
    ).toBe(true);
  });

  it('can be switched on from the renderer, in both directions', () => {
    // Reading the flag without being able to set it is the same defect wearing
    // the other shoe: the pointer would be permanently hidden rather than
    // permanently dangling, and the log would still be unreachable.
    expect(COMMAND_ALLOWLIST).toContain('diagnostics_debug_log_get');
    expect(COMMAND_ALLOWLIST).toContain('diagnostics_debug_log_set');
  });

  it('has a caller for debuglog::enable in the shipping host, not only in tests', () => {
    // The finding's own sentence, made checkable. `#[cfg(test)]` is cut off
    // first, so a test-only caller cannot satisfy it — that is precisely the
    // state this guard exists to reject.
    const source = read('src-tauri/src/ipc/diagnostics.rs');
    const production = source.split('#[cfg(test)]')[0] ?? '';
    expect(
      production,
      'no shipping code in the host turns the debug log on, so the trace id ' +
        'rendered on every failed turn points into a file nothing can create',
    ).toContain('debuglog::enable(');
    expect(production).toContain('debuglog::disable()');
  });

  it('offers the switch somewhere a user can reach it', () => {
    // A command with no affordance is the same dead end one layer down.
    expect(read('src/features/models/EndpointsPanel.tsx')).toContain('DebugLogSwitch');
  });
});
