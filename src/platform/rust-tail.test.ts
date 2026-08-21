/**
 * `scripts/check-rust-tail.mjs` must be able to tell a build from a test run.
 *
 * ## The claim under test
 *
 * `pnpm verify` ends with `cargo build --workspace --locked && cargo test
 * --workspace --locked`, and on this machine those two links were never
 * executed by anyone running the documented command: cargo is on no shell's
 * PATH, gate 2 dies, and `&&` short-circuits. An exit code cannot distinguish
 * "the tail passed" from "the tail never started", so the guard asks the disk
 * instead — and the whole guard rests on one factual claim:
 *
 *     `cargo build` does not compile `tests/`; only `cargo test` does.
 *
 * That claim was measured on this workspace rather than assumed, because a
 * guard resting on a false premise is worse than no guard. `cargo clean -p
 * vela-store` removed `durability-f80bb87ad6590b36.{d,exe,pdb}`; `cargo build -p
 * vela-store` then exited 0 having produced NONE of them; `cargo test -p
 * vela-store --no-run` produced `durability-44e26e9e472d07ec.exe` and printed
 * `Executable tests\durability.rs`. The guard read the tree red after the build
 * and green after the test.
 *
 * ## What this file adds
 *
 * The measurement above is a fact about cargo. These are facts about the guard,
 * and they are the ones that rot: each synthetic tree below is a tree the guard
 * must NOT pass, and every one of them passes a weaker guard someone could
 * plausibly have written instead.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Every test in this file starts at least one child process, and this suite has
 * already gone red from load alone. `docs/release-posture.md` §13b records
 * `Test timed out in 5000ms` failures during this branch's runs, in files this
 * branch does not touch, each of those files green when run on its own three
 * times out of three. (No count here on purpose: the list has grown twice
 * already, and a number in a comment is a number that goes stale. §13b holds
 * the current one.) Vitest's default 5s budget is a statement about an idle
 * box; a red from it here would be fabricated by load rather than caused by
 * the code. The number is generous on purpose — it is a ceiling that catches a
 * hang, not an assertion about how long a spawn takes.
 */
const SPAWN_TIMEOUT_MS = 60_000;


const REPO_ROOT = process.cwd();
const GUARD = join(REPO_ROOT, 'scripts', 'check-rust-tail.mjs');
const IS_WINDOWS = process.platform === 'win32';
const EXE = IS_WINDOWS ? '.exe' : '';

let scratch: string;
let root: string;
let deps: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vela-t01-tail-'));
  root = join(scratch, 'repo');
  deps = join(root, 'src-tauri', 'target', 'debug', 'deps');
  mkdirSync(deps, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** An integration test source file, i.e. a target cargo would build. */
function testSource(crate: string | null, name: string): void {
  const dir =
    crate === null
      ? join(root, 'src-tauri', 'tests')
      : join(root, 'src-tauri', 'crates', crate, 'tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name + '.rs'), '#[test] fn t() {}\n', 'utf8');
}

/** A file in `deps/`, with a size and optionally an mtime in the past. */
function depsFile(name: string, bytes = 4096, ageMs = 0): string {
  const path = join(deps, name);
  writeFileSync(path, Buffer.alloc(bytes));
  if (ageMs > 0) {
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(path, when, when);
  }
  return path;
}

function runGuard(args: readonly string[] = []): { code: number; out: string } {
  const child = spawnSync(process.execPath, [GUARD, '--root', root, ...args], {
    encoding: 'utf8',
    shell: false,
  });
  return { code: child.status ?? -1, out: (child.stdout ?? '') + (child.stderr ?? '') };
}

describe('the guard passes a tree where cargo test really ran', { timeout: SPAWN_TIMEOUT_MS }, () => {
  it('a binary for every integration target, in the package and in a crate', () => {
    testSource(null, 'alpha');
    testSource('vela-thing', 'beta');
    depsFile('alpha-1111111111111111' + EXE);
    depsFile('beta-2222222222222222' + EXE);

    const { code, out } = runGuard();
    expect(out).toMatch(/BUILT\s+alpha/u);
    expect(out).toMatch(/BUILT\s+beta/u);
    expect(out).toContain('RUST_TAIL_RAN=yes');
    expect(code).toBe(0);
  });
});

describe('the guard fails the trees a weaker one would pass', { timeout: SPAWN_TIMEOUT_MS }, () => {
  it('a deps directory full of executables, and no test binary among them', () => {
    // THE CASE THE OBVIOUS GUARD GETS WRONG. After `cargo build` the deps
    // directory is full of `.exe` files — the application binary's own
    // artefacts. "There are executables in deps/" is therefore satisfied by a
    // tree where `cargo test` never ran, which is the exact question being
    // asked. Reproduced on the real workspace with `cargo clean -p vela-store`
    // followed by `cargo build -p vela-store`.
    testSource(null, 'alpha');
    depsFile('vela-aaaaaaaaaaaaaaaa' + EXE, 16_000_000);
    depsFile('vela_lib-bbbbbbbbbbbbbbbb.rlib', 8_000_000);
    depsFile('serde-cccccccccccccccc.rlib', 900_000);

    const { code, out } = runGuard();
    expect(out).toMatch(/MISSING\s+alpha/u);
    expect(out).toContain('RUST_TAIL_RAN=no');
    expect(code).toBe(1);
  });

  it('the .d and .pdb siblings do not answer for the binary', () => {
    // Cargo leaves `alpha-<hash>.d` next to the executable. A prefix match
    // would accept it and report a test binary that is a dependency-list text
    // file.
    testSource(null, 'alpha');
    depsFile('alpha-1111111111111111.d');
    depsFile('alpha-1111111111111111.pdb');

    const { code, out } = runGuard();
    expect(out).toMatch(/MISSING\s+alpha/u);
    expect(code).toBe(1);
  });

  it('one target of several missing fails the whole run', () => {
    testSource(null, 'alpha');
    testSource(null, 'gamma');
    depsFile('alpha-1111111111111111' + EXE);

    const { code, out } = runGuard();
    expect(out).toMatch(/BUILT\s+alpha/u);
    expect(out).toMatch(/MISSING\s+gamma/u);
    expect(code).toBe(1);
  });

  it('an explicit --since is honoured, and is the only thing that demands an age', () => {
    // BOTH HALVES ARE THE POINT, and the second is a regression test for a
    // defect this guard shipped with twice.
    //
    // A caller passing `--since` asserts "these binaries were produced after
    // this instant", which holds on a cold machine with no cargo cache. The
    // first half checks that demand is enforced.
    //
    // The second half checks there is NO age demand by default. Two default
    // rules were tried and both produced false reds on the real repository: a
    // wall-clock sentinel (cargo recompiled nothing, so no mtime moved, and all
    // forty targets were called stale after a run that genuinely passed), and a
    // newest-source comparison (`pnpm tauri build` rewrote `Cargo.toml` to the
    // same bytes with a new mtime, and four correct binaries were called
    // stale). Cargo fingerprints content; an mtime rule cannot second-guess it.
    // See the header of `scripts/check-rust-tail.mjs`.
    testSource(null, 'alpha');
    depsFile('alpha-1111111111111111' + EXE, 4096, 48 * 60 * 60 * 1000);

    const demanded = runGuard(['--since', String(Date.now() - 60_000)]);
    expect(demanded.out).toMatch(/STALE\s+alpha/u);
    expect(demanded.out).toContain('RUST_TAIL_RAN=no');
    expect(demanded.code).toBe(1);

    const byDefault = runGuard();
    expect(
      byDefault.out,
      'a two-day-old binary must pass by default. Demanding an age here is how ' +
        'this guard twice reported a correct tree as stale.',
    ).toMatch(/BUILT\s+alpha/u);
    expect(byDefault.code).toBe(0);
  });

  it('touching a manifest without changing it does not make a binary stale', () => {
    // The exact shape of the second false red: `pnpm tauri build` rewrites
    // `src-tauri/Cargo.toml` in place — same bytes, new mtime. Every test
    // binary in the workspace is then older than a manifest nothing changed,
    // and a newest-source rule calls the whole tree stale.
    testSource(null, 'alpha');
    depsFile('alpha-1111111111111111' + EXE, 4096, 60 * 60 * 1000);
    writeFileSync(join(root, 'src-tauri', 'Cargo.toml'), '[workspace]\n', 'utf8');

    const { code, out } = runGuard();
    expect(out).toMatch(/BUILT\s+alpha/u);
    expect(code).toBe(0);
  });

  it('a tree with no integration targets is refused, not passed vacuously', () => {
    // The failure a guard is likeliest to ship with: point the enumeration at
    // the wrong place, get an empty expectation set, and satisfy it trivially.
    const { code, out } = runGuard();
    expect(out).toContain('RUST_TAIL_RAN=no');
    expect(out).toMatch(/no integration test targets were found/u);
    expect(code).toBe(1);
  });

  it('a hyphenated source file is looked for under the name cargo gives it', () => {
    // Cargo builds a test source whose stem is `a-b` into a binary named
    // `a_b-<hash>.exe`. Comparing raw stems would report a permanent false
    // MISSING and train readers to ignore it.
    testSource(null, 'a-b');
    depsFile('a_b-3333333333333333' + EXE);

    const { code, out } = runGuard();
    expect(out).toMatch(/BUILT\s+a_b/u);
    expect(code).toBe(0);
  });
});
