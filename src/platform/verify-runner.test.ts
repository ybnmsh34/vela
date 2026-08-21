/**
 * `scripts/verify.mjs` must be able to say SKIPPED.
 *
 * ## What this exists to hold down
 *
 * `pnpm verify` was one `&&` chain in `package.json`. On the platform Vela
 * ships on it died inside gate 2 — `'cargo' is not recognized` — and gates 3
 * through 10 never started. The transcript said `ELIFECYCLE Command failed with
 * exit code 1` and nothing else, so a reader could not tell an unrun gate from
 * a passed one, and `verify-covers-ci.test.ts` was green because it asked
 * whether the gate's TEXT was in the chain.
 *
 * Text is not execution. This file asserts the part that is:
 *
 *  - a gate after a failure reports SKIPPED, which is a third outcome and not
 *    the absence of one, and
 *  - IT ACTUALLY DOES NOT RUN. That is the load-bearing assertion here. A
 *    runner that printed SKIPPED while still executing the command, or that
 *    printed PASS for something it never started, would satisfy every
 *    string-shaped check anyone could write. So each synthetic gate leaves a
 *    file behind when it runs, and the test reads the directory.
 *
 * ## Why synthetic gates rather than the real ones
 *
 * The real chain builds a Rust workspace and takes tens of minutes, and its
 * outcome depends on the tree. These gates are `node -e` one-liners with
 * chosen exit codes, so the runner's own behaviour is what is under test and
 * nothing else is. The real gate list is asserted separately, by
 * `verify-covers-ci.test.ts`, against `.github/workflows/`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Every test in this file starts at least one child process, and this machine
 * runs seventeen agents and a Rust workspace build at the same time. Vitest's
 * default 5s budget is a statement about an idle box; a red from it here would
 * be fabricated by load rather than caused by the code, and this project has
 * been burned by exactly that. The number is generous on purpose — it is a
 * ceiling that catches a hang, not an assertion about how long a spawn takes.
 */
const SPAWN_TIMEOUT_MS = 60_000;


// `process.cwd()`, as every other guard in this directory does: vitest runs
// under jsdom here and `import.meta.url` is not a file URL in that environment.
const REPO_ROOT = process.cwd();
const RUNNER = join(REPO_ROOT, 'scripts', 'verify.mjs');

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vela-t01-verify-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A gate that stamps a file named after itself and then exits with `code`.
 * The stamp is the evidence that the gate ran; its absence is the evidence
 * that it did not.
 */
function gate(id: string, code: number, needs: readonly string[] = []): Record<string, unknown> {
  const stamp = join(scratch, 'ran-' + id).replace(/\\/gu, '\\\\');
  return {
    id,
    command:
      'node -e "require(' +
      "'fs'" +
      ').writeFileSync(' +
      "'" +
      stamp +
      "'" +
      ", '');process.exit(" +
      String(code) +
      ')"',
    cwd: '.',
    needs: [...needs],
    tail: false,
  };
}

function writeGates(
  gates: ReadonlyArray<Record<string, unknown>>,
  tailProbe?: string,
): string {
  const path = join(scratch, 'gates.json');
  const body: Record<string, unknown> = { gates };
  if (tailProbe !== undefined) body.tailProbe = tailProbe;
  writeFileSync(path, JSON.stringify(body), 'utf8');
  return path;
}

function runVerify(gatesPath: string, args: readonly string[] = []): { code: number; out: string } {
  const child = spawnSync(
    process.execPath,
    [RUNNER, '--gates', gatesPath, '--root', REPO_ROOT, ...args],
    { encoding: 'utf8', shell: false },
  );
  return { code: child.status ?? -1, out: (child.stdout ?? '') + (child.stderr ?? '') };
}

/**
 * A stand-in for `scripts/check-rust-tail.mjs`: a real script file, invoked the
 * way the real probe is. Writing it to disk rather than using `node -e` is not
 * fussiness — `node -e "..." --root <path>` makes node try to parse `--root` as
 * one of ITS options and die with `bad option: --root`, which is exit 9. The
 * first version of these tests used that form, and the "probe went red" case
 * passed on node's argument error rather than on the probe's verdict. The
 * "probe went green" case is what exposed it, which is the whole reason a
 * positive control is written alongside a negative one.
 */
function writeProbe(exitCode: number): string {
  const path = join(scratch, 'probe.mjs');
  writeFileSync(path, 'process.exit(' + String(exitCode) + ');' + String.fromCharCode(10), 'utf8');
  return 'node ' + path;
}

/** Which gates left a stamp behind, i.e. which ones actually executed. */
function ranGates(): string[] {
  return readdirSync(scratch)
    .filter((name) => name.startsWith('ran-'))
    .map((name) => name.slice('ran-'.length))
    .sort();
}

describe('the runner distinguishes skipped from passed', { timeout: SPAWN_TIMEOUT_MS }, () => {
  it('reports PASS, FAIL and SKIPPED, and only the SKIPPED ones did not run', () => {
    const gatesPath = writeGates([gate('one', 0), gate('two', 3), gate('three', 0), gate('four', 0)]);
    const { code, out } = runVerify(gatesPath);

    expect(out, 'the passing first gate must be reported as passing').toMatch(/^one\s+PASS\s+0/mu);
    expect(out, 'the failing gate must carry its real exit status, not a generic 1').toMatch(
      /^two\s+FAIL\s+3/mu,
    );
    // The whole point. Two lines that say the gate was never attempted.
    expect(out, 'gate three never started and must say so').toMatch(/^three\s+SKIPPED\s+-/mu);
    expect(out, 'gate four never started and must say so').toMatch(/^four\s+SKIPPED\s+-/mu);

    // ...and the words are true. This is what a string-shaped guard cannot ask.
    expect(
      ranGates(),
      'a gate reported SKIPPED must not have executed. If "three" or "four" is in ' +
        'this list the report is decoration rather than a measurement.',
    ).toEqual(['one', 'two']);

    expect(out, 'the count must name skipped gates rather than folding them into failures').toMatch(
      /2 SKIPPED \(skipped is not passed\)/u,
    );
    // The failing gate's own status, propagated, and written into the log body.
    expect(out).toContain('VERIFY_EXIT=3');
    expect(code).toBe(3);
  });

  it('a clean run reports every gate passed and exits 0', () => {
    const gatesPath = writeGates([gate('one', 0), gate('two', 0)]);
    const { code, out } = runVerify(gatesPath);

    expect(out).toMatch(/^one\s+PASS\s+0/mu);
    expect(out).toMatch(/^two\s+PASS\s+0/mu);
    expect(out).toMatch(/0 SKIPPED/u);
    expect(out).toContain('VERIFY_EXIT=0');
    expect(ranGates()).toEqual(['one', 'two']);
    expect(code).toBe(0);
  });

  it('the last line of the body carries the exit status', () => {
    // The harness that runs this project once reported "completed (exit code 0)"
    // over a log whose body said VERIFY_EXIT=1, because the shell pipeline ended
    // in a reporting command. A log that states its own verdict survives that.
    const gatesPath = writeGates([gate('one', 7)]);
    const { out } = runVerify(gatesPath);
    const lines = out.trimEnd().split(/\r?\n/u);
    expect(lines[lines.length - 1]).toBe('VERIFY_EXIT=7');
  });
});

describe('a resumed run is not a clean run', { timeout: SPAWN_TIMEOUT_MS }, () => {
  // `--from <id>` skips the gates before <id>. The first version reported those
  // as NOT-RUN in the table and then excluded them from the summary counts AND
  // from the exit code, so `--from` on the real ten-gate list printed
  //
  //     1 passed, 0 failed, 0 SKIPPED (skipped is not passed)
  //     VERIFY_EXIT=0
  //
  // over nine gates it never started — the same "did not run reads as passed"
  // this runner replaced the `&&` chain to remove, reintroduced by the resume
  // flag. `docs/release-posture.md` §13b quoted exactly such a run as evidence
  // that the full chain was green. It was not.

  it('gates before --from are NOT-RUN, are counted, and do not exit 0', () => {
    const gatesPath = writeGates([gate('one', 0), gate('two', 0), gate('three', 0)]);
    const { code, out } = runVerify(gatesPath, ['--from', 'three']);

    expect(out).toMatch(/^one\s+NOT-RUN\s+-/mu);
    expect(out).toMatch(/^two\s+NOT-RUN\s+-/mu);
    expect(out).toMatch(/^three\s+PASS\s+0/mu);

    // The measurement behind the words: the two NOT-RUN gates left no stamp.
    expect(ranGates(), 'a gate reported NOT-RUN must not have executed').toEqual(['three']);

    expect(
      out,
      'the summary must name the gates that did not run. A count of passes that ' +
        'omits them is the false green.',
    ).toMatch(/1 passed, 0 failed, 0 SKIPPED \(skipped is not passed\), 2 NOT-RUN/u);
    expect(out).toMatch(/INCOMPLETE: 2 of 3 gates were not run/u);
    expect(
      out,
      'every gate that ran passed, and the run still must not exit 0 — it did ' +
        'not certify the tree',
    ).toContain('VERIFY_EXIT=3');
    expect(code).toBe(3);
  });

  it('the control: the same three gates without --from exit 0', () => {
    // Without this, "a resumed run exits 3" would be satisfied by a runner that
    // never exits 0 at all.
    const gatesPath = writeGates([gate('one', 0), gate('two', 0), gate('three', 0)]);
    const { code, out } = runVerify(gatesPath);
    expect(out).toMatch(/0 SKIPPED \(skipped is not passed\), 0 NOT-RUN/u);
    expect(out).not.toMatch(/INCOMPLETE/u);
    expect(out).toContain('VERIFY_EXIT=0');
    expect(ranGates()).toEqual(['one', 'three', 'two']);
    expect(code).toBe(0);
  });

  it('a real failure in a resumed run still reports the failure, not the resume', () => {
    // 3 is "incomplete"; a red gate keeps its own status, so the two stay
    // distinguishable in a log.
    const gatesPath = writeGates([gate('one', 0), gate('two', 6)]);
    const { code, out } = runVerify(gatesPath, ['--from', 'two']);
    expect(out).toMatch(/^one\s+NOT-RUN\s+-/mu);
    expect(out).toMatch(/^two\s+FAIL\s+6/mu);
    expect(out).toContain('VERIFY_EXIT=6');
    expect(code).toBe(6);
  });

  it('--from naming no gate is refused rather than silently running everything', () => {
    const gatesPath = writeGates([gate('one', 0)]);
    const { code, out } = runVerify(gatesPath, ['--from', 'no-such-gate']);
    expect(out).toMatch(/no gate named no-such-gate/u);
    expect(code).toBe(2);
    expect(ranGates()).toEqual([]);
  });
});

describe('the runner refuses what it cannot gate', { timeout: SPAWN_TIMEOUT_MS }, () => {
  it('an empty gate list is refused rather than passed vacuously', () => {
    const gatesPath = join(scratch, 'empty.json');
    writeFileSync(gatesPath, JSON.stringify({ gates: [] }), 'utf8');
    const { code, out } = runVerify(gatesPath);
    expect(code).not.toBe(0);
    expect(out).toMatch(/declares no gates/u);
  });

  it('a gate whose tool is not on PATH blocks the run instead of failing it', () => {
    // The real case: cargo is on no shell's PATH on this machine, so gate 2 of
    // ten died and eight gates behind it were silently not run. Reporting that
    // as "gate 2 failed" buries the fact that nothing after it was attempted.
    const gatesPath = writeGates([
      gate('one', 0, ['vela-no-such-tool-e3f1']),
      gate('two', 0),
    ]);
    const { code, out } = runVerify(gatesPath);

    expect(out).toMatch(/PREFLIGHT FAILED/u);
    expect(out).toContain('vela-no-such-tool-e3f1');
    expect(out).toMatch(/^\s+BLOCKED\s+one/mu);
    expect(out).toMatch(/^\s+BLOCKED\s+two/mu);
    expect(out).toContain('VERIFY_EXIT=2');
    expect(code).toBe(2);
    expect(
      ranGates(),
      'preflight failed, so no gate should have been started at all',
    ).toEqual([]);
  });

  it('a tool that IS on PATH does not block the run', () => {
    // The control. A preflight that refuses everything would pass the test
    // above while making the runner useless, so it is shown saying yes too.
    const gatesPath = writeGates([gate('one', 0, ['node'])]);
    const { code, out } = runVerify(gatesPath);
    expect(out).not.toMatch(/PREFLIGHT FAILED/u);
    expect(code).toBe(0);
    expect(existsSync(join(scratch, 'ran-one'))).toBe(true);
  });
});

describe('the physical tell is a separate verdict from the gate', { timeout: SPAWN_TIMEOUT_MS }, () => {
  // The reason `verify` exists in this shape. `cargo test --workspace --locked`
  // reporting 0 is what the old chain took as proof the Rust tail ran, and an
  // exit status can be produced without running anything. So after the gate
  // marked `tail` passes, the runner asks the disk — and a NO from the disk has
  // to be able to fail a run in which every gate said PASS. If it could not,
  // the probe would be decoration.

  it('a passing tail gate plus a passing probe reports CONFIRMED', () => {
    const gatesPath = writeGates(
      [{ ...gate('one', 0), tail: true }],
      writeProbe(0),
    );
    const { code, out } = runVerify(gatesPath);
    expect(out).toContain('RUST_TAIL=CONFIRMED');
    expect(out).toContain('VERIFY_EXIT=0');
    expect(code).toBe(0);
  });

  it('every gate green and the probe red still fails the run', () => {
    const gatesPath = writeGates(
      [{ ...gate('one', 0), tail: true }],
      writeProbe(1),
    );
    const { code, out } = runVerify(gatesPath);
    expect(out, 'the gate itself passed and must be reported as passing').toMatch(/^one\s+PASS\s+0/mu);
    expect(
      out,
      'the disk said the tail left no artefact, so the run must fail even though ' +
        'no gate did. A green exit here would be the exact false pass this runner ' +
        'was written to remove.',
    ).toContain('RUST_TAIL=NOT-CONFIRMED');
    expect(out).toContain('VERIFY_EXIT=1');
    expect(code).toBe(1);
  });

  it('a tail gate that never ran reports NOT-REACHED, not CONFIRMED', () => {
    // The probe must not be consulted about a gate that was skipped, and its
    // silence must not read as a pass.
    const gatesPath = writeGates(
      [gate('one', 4), { ...gate('two', 0), tail: true }],
      writeProbe(0),
    );
    const { code, out } = runVerify(gatesPath);
    expect(out).toMatch(/^two\s+SKIPPED\s+-/mu);
    expect(out).toContain('RUST_TAIL=NOT-REACHED');
    expect(code).toBe(4);
  });
});
