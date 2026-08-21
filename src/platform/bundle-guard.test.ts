/**
 * `scripts/check-bundle.mjs` must fail every tree that has no installer in it.
 *
 * ## The defect this guard exists for, and why an exit code was not enough
 *
 * `src-tauri/tauri.conf.json` declared `"bundle": { "active": true, "targets":
 * "all" }` while `bundle.icon` listed four PNGs and no `.ico`. The Windows
 * bundler needs an `.ico` in that list, so `pnpm tauri build` compiled the
 * entire Rust release tree, printed `Built application at: …\vela.exe`, and
 * then failed with `Couldn't find a .ico icon`, producing **no installer of
 * either kind**. `cargo build` stayed green the whole time, because
 * `tauri-build` embeds the application icon by a different path.
 * `docs/release-posture.md` §6 is the record of the run.
 *
 * So the guard reads the disk. The interesting question is not whether it can
 * pass a good tree — anything can — but whether it fails the specific bad trees
 * that a slightly weaker guard would pass. Each case below is one of those,
 * and each corresponds to a numbered step in the guard's own header.
 *
 * ## Why `--platform win32` is passed explicitly everywhere
 *
 * `pnpm test` runs on `ubuntu-latest` as well as `windows-latest`. A test of
 * the Windows expectations that only executes on Windows is a test CI mostly
 * does not run, which is how the `test:harness` gap in this repo happened. The
 * synthetic trees are Windows trees on every host.
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
const GUARD = join(REPO_ROOT, 'scripts', 'check-bundle.mjs');

/** OLE2 compound file — what an MSI actually is. */
const MSI_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/**
 * `MZ` — a PE image. An NSIS setup is one. So is `vela.exe`, which is the
 * reason the fixtures below need more than this; see NSIS_SIGNATURE.
 */
const PE_MAGIC = Buffer.from([0x4d, 0x5a]);
/**
 * NSIS's first header: `EF BE AD DE` (0xDEADBEEF little-endian) followed by
 * the ASCII `NullsoftInst` — sixteen bytes, and the guard demands all sixteen.
 * Measured in the real artefact this branch built,
 * `src-tauri/target/release/bundle/nsis/Vela_0.1.0_x64-setup.exe`, 5,444,437
 * bytes: the sixteen-byte sequence occurs exactly once, beginning at offset
 * 52,740. Its two halves are each weaker — `NullsoftInst` alone begins four
 * bytes later at 52,744, `EF BE AD DE` alone occurs twice (first at 9,732).
 * `vela.exe` (18,095,104 bytes) contains neither the sixteen bytes nor the
 * substring `Nullsoft` at all.
 */
const NSIS_SIGNATURE = Buffer.concat([
  Buffer.from([0xef, 0xbe, 0xad, 0xde]),
  Buffer.from('NullsoftInst', 'latin1'),
]);
/**
 * Where the fixtures put it. Any offset inside the file would do — the guard
 * scans rather than seeking — and this is the real one, 52,740, so that the
 * fixture and the artefact it stands for are the same shape. It shipped as
 * 52,744 in round 2, which is where `NullsoftInst` starts and not where the
 * demanded sequence starts; `docs/corrections.md`, round 3, entry 1.
 *
 * WHAT IS AND IS NOT GATED HERE. That the guard reports the offset it actually
 * found is gated — the `--json` test at the bottom of this file writes the
 * sequence at this constant and reads the number back. That this constant
 * *equals the real setup's* offset is NOT gated and cannot be. `pnpm test` runs
 * in two CI jobs, `test-ts` on `ubuntu-latest` and `test-windows` on
 * `windows-latest`, and neither has a `target/release/bundle` to measure: the
 * Linux job cannot produce a Windows setup at all, and the Windows job never
 * bundles — its build steps are `pnpm build`, `cargo build --workspace
 * --locked` and `cargo test --workspace --locked`. The only job that runs
 * `pnpm bundle` is `bundle`, which is a separate job on its own runner and does
 * not run `pnpm test`. And a test that asserts only when an artefact happens to
 * be present is the vacuous pass that step 7 of the guard's own header refuses.
 * (Round 3 justified this with `ubuntu-latest` alone, which named the one job
 * that could not have threatened the argument; `docs/corrections.md`, round 4,
 * entry 4.)
 *
 * So the constant is a hand measurement, re-run at the commit this line ships
 * in and printed in `docs/corrections.md`, round 3, entry 1. Changing it
 * changes nothing a test can see, which is exactly why it is written down
 * twice.
 */
const NSIS_SIGNATURE_AT = 52_740;

const VERSION = '0.1.0';
const BIG = 4_000_000;

let scratch: string;
let root: string;
let bundleRoot: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vela-t01-bundle-'));
  root = join(scratch, 'repo');
  bundleRoot = join(root, 'src-tauri', 'target', 'release', 'bundle');
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeConfig(bundle: Record<string, unknown>): void {
  writeFileSync(
    join(root, 'src-tauri', 'tauri.conf.json'),
    JSON.stringify({ productName: 'Vela', version: VERSION, identifier: 'dev.vela.desktop', bundle }),
    'utf8',
  );
}

/**
 * An artefact of `bytes` length whose first bytes are `magic`, optionally
 * carrying `embed.what` at `embed.at`.
 */
function artefact(
  dir: string,
  name: string,
  magic: Buffer,
  bytes = BIG,
  ageMs = 0,
  embed: { what: Buffer; at: number } | null = null,
): void {
  const target = join(bundleRoot, dir);
  mkdirSync(target, { recursive: true });
  const body = Buffer.alloc(bytes);
  magic.copy(body, 0);
  if (embed !== null) embed.what.copy(body, embed.at);
  const path = join(target, name);
  writeFileSync(path, body);
  if (ageMs > 0) {
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(path, when, when);
  }
}

function goodMsi(ageMs = 0): void {
  artefact('msi', 'Vela_' + VERSION + '_x64_en-US.msi', MSI_MAGIC, BIG, ageMs);
}
function goodNsis(ageMs = 0): void {
  artefact('nsis', 'Vela_' + VERSION + '_x64-setup.exe', PE_MAGIC, BIG, ageMs, {
    what: NSIS_SIGNATURE,
    at: NSIS_SIGNATURE_AT,
  });
}

function runGuard(args: readonly string[] = []): { code: number; out: string } {
  const child = spawnSync(
    process.execPath,
    [GUARD, '--root', root, '--platform', 'win32', ...args],
    { encoding: 'utf8', shell: false },
  );
  return { code: child.status ?? -1, out: (child.stdout ?? '') + (child.stderr ?? '') };
}

describe('the guard passes a real bundle tree', { timeout: SPAWN_TIMEOUT_MS }, () => {
  it('both declared Windows targets present, well formed and fresh', () => {
    writeConfig({ active: true, targets: 'all' });
    goodMsi();
    goodNsis();

    const { code, out } = runGuard(['--since', String(Date.now() - 60_000)]);
    expect(out).toMatch(/OK\s+Vela_0\.1\.0_x64_en-US\.msi/u);
    expect(out).toMatch(/OK\s+Vela_0\.1\.0_x64-setup\.exe/u);
    expect(out).toContain('BUNDLE_OK=yes');
    expect(code).toBe(0);
  });
});

describe('the guard fails the trees a weaker one would pass', { timeout: SPAWN_TIMEOUT_MS }, () => {
  it('step 1: nothing at all, which is what the .ico defect produced', () => {
    writeConfig({ active: true, targets: 'all' });
    const { code, out } = runGuard();
    expect(out).toMatch(/NO-DIR/u);
    expect(out).toContain('BUNDLE_OK=no');
    expect(code).toBe(1);
  });

  it('step 2: a zero-byte file with the right name', () => {
    writeConfig({ active: true, targets: 'all' });
    artefact('msi', 'Vela_' + VERSION + '_x64_en-US.msi', Buffer.alloc(0), 0);
    goodNsis();

    const { code, out } = runGuard();
    expect(out).toMatch(/TRUNCATED\s+Vela_0\.1\.0_x64_en-US\.msi/u);
    expect(code).toBe(1);
  });

  it('step 3: a large file with the right name that is not an installer', () => {
    // The size floor is satisfied and the name is perfect. Only the first eight
    // bytes say it is a log file rather than an OLE2 compound document.
    writeConfig({ active: true, targets: 'all' });
    artefact('msi', 'Vela_' + VERSION + '_x64_en-US.msi', Buffer.from('failed to '), BIG);
    goodNsis();

    const { code, out } = runGuard();
    expect(out).toMatch(/NOT-A-MSI/u);
    expect(out).toContain('expected d0cf11e0a1b11ae1');
    expect(code).toBe(1);
  });

  it('step 3b: the APPLICATION binary, in the installer’s place, under the installer’s name', () => {
    // This is the case the previous version of the guard passed, and it is not
    // a hypothetical: `target/release/vela.exe` copied to
    // `bundle/nsis/Vela_0.1.0_x64-setup.exe` produced
    //   OK  Vela_0.1.0_x64-setup.exe  18095104 bytes, NSIS setup (PE image)
    //   BUNDLE_OK=yes   exit 0
    // because the whole of step 3 for this target was "are the first two bytes
    // MZ", and the application is a PE image too. A build that produced
    // `vela.exe` and no installer is the exact defect §6 records; a guard that
    // accepts `vela.exe` AS the installer is one rename away from it.
    //
    // The fixture is a PE image of installer-like size with a perfect name and
    // a fresh mtime, differing from `goodNsis()` in one respect only: it does
    // not carry NSIS's first header.
    writeConfig({ active: true, targets: 'all' });
    goodMsi();
    artefact('nsis', 'Vela_' + VERSION + '_x64-setup.exe', PE_MAGIC, BIG);

    const { code, out } = runGuard(['--since', String(Date.now() - 60_000)]);
    expect(out).toMatch(/APP-NOT-INSTALLER\s+Vela_0\.1\.0_x64-setup\.exe/u);
    expect(out).toContain('NullsoftInst');
    expect(out).toMatch(/no acceptable installer for: nsis/u);
    expect(out).toContain('BUNDLE_OK=no');
    expect(code).toBe(1);
  });

  it('step 3b control: the same file plus NSIS’s first header is accepted', () => {
    // Without this, "the guard rejects a PE image" would be satisfied by a
    // guard that rejects every PE image, including real setups. The two
    // fixtures differ by sixteen bytes at offset 52,740 — NSIS_SIGNATURE at
    // NSIS_SIGNATURE_AT — and by nothing else.
    writeConfig({ active: true, targets: 'all' });
    goodMsi();
    goodNsis();

    const { code, out } = runGuard(['--since', String(Date.now() - 60_000)]);
    expect(out).toMatch(/OK\s+Vela_0\.1\.0_x64-setup\.exe/u);
    expect(out).toContain('BUNDLE_OK=yes');
    expect(code).toBe(0);
  });

  it('step 4: last week’s installers, which satisfy every check above', () => {
    writeConfig({ active: true, targets: 'all' });
    goodMsi(48 * 60 * 60 * 1000);
    goodNsis(48 * 60 * 60 * 1000);

    const stale = runGuard(['--since', String(Date.now() - 60_000)]);
    expect(stale.out).toMatch(/STALE/u);
    expect(stale.code).toBe(1);

    // The control: the same tree with no freshness demand is accepted, so the
    // assertion above is about staleness and not about the guard refusing
    // everything.
    const any = runGuard();
    expect(any.out).toContain('BUNDLE_OK=yes');
    expect(any.code).toBe(0);
    // Two child processes on a box that is often also compiling Rust. The
    // default 5s budget is not a statement about this test; it is a statement
    // about an unloaded machine, and a red from it would be fabricated.
  });

  it('step 5: an installer left over from an older version', () => {
    writeConfig({ active: true, targets: 'all' });
    artefact('msi', 'Vela_0.0.9_x64_en-US.msi', MSI_MAGIC);
    goodNsis();

    const { code, out } = runGuard();
    expect(out).toMatch(/WRONG-VERSION/u);
    expect(code).toBe(1);
  });

  it('step 6: one of the two declared targets silently stopped building', () => {
    // "An installer exists" is true here. It is not the question: `targets:
    // "all"` on Windows promises both, and a user who wanted the MSI has none.
    writeConfig({ active: true, targets: 'all' });
    goodNsis();

    const { code, out } = runGuard();
    expect(out).toMatch(/NO-DIR.*msi/u);
    expect(out).toMatch(/no acceptable installer for: msi/u);
    expect(code).toBe(1);
  });

  it('step 7a: bundling switched off is refused, not treated as nothing to check', () => {
    writeConfig({ active: false, targets: 'all' });
    const { code, out } = runGuard();
    expect(out).toMatch(/REFUSED/u);
    expect(out).toMatch(/bundle\.active/u);
    expect(code).toBe(1);
  });

  it('step 7b: a target list that names no Windows installer is refused', () => {
    // The vacuous pass. An expectation set of size zero is satisfied by every
    // tree in existence, including one with no bundler output at all.
    writeConfig({ active: true, targets: ['deb', 'appimage'] });
    const { code, out } = runGuard();
    expect(out).toMatch(/REFUSED/u);
    expect(out).toMatch(/empty expectation set/u);
    expect(code).toBe(1);
  });

  it('step 7c: an unknown platform is a question, not a green tick', () => {
    writeConfig({ active: true, targets: 'all' });
    goodMsi();
    goodNsis();
    const child = spawnSync(
      process.execPath,
      [GUARD, '--root', root, '--platform', 'plan9'],
      { encoding: 'utf8', shell: false },
    );
    const out = (child.stdout ?? '') + (child.stderr ?? '');
    expect(out).toMatch(/has not been taught what platform "plan9" produces/u);
    expect(child.status).toBe(1);
  });
});

describe('the guard reads the real repository configuration', { timeout: SPAWN_TIMEOUT_MS }, () => {
  it('this tree declares both Windows installers', () => {
    // Not a synthetic tree: the shipped `tauri.conf.json`. If someone narrows
    // `targets` or flips `active`, the release path changes and this says so.
    // It deliberately asserts the EXPECTATION, not the artefacts — a developer
    // who has not run `pnpm bundle` has no `target/release/bundle` and that is
    // not a failing repository.
    const child = spawnSync(
      process.execPath,
      [GUARD, '--platform', 'win32', '--json'],
      { encoding: 'utf8', shell: false, cwd: REPO_ROOT },
    );
    const parsed = JSON.parse(child.stdout ?? '{}') as { expected?: string[]; version?: string };
    expect(parsed.expected).toEqual(['msi', 'nsis']);
    expect(parsed.version).toBe(VERSION);
  });
});

/**
 * The two NUMBERS in a `--json` row, and the tests that read them.
 *
 * A row carries `target`, `file`, `path`, `verdict` and `detail`, all strings,
 * plus exactly two numeric fields: `bytes` on every row, and `signatureAt` on a
 * row whose target demands an installer signature and where one was found. The
 * strings are the ones the human output path prints — `verdict`, `file ?? path`
 * and `detail` — so a wrong one is wrong where somebody reads it. A number is
 * not: `signatureAt` shipped in round 2 written and read by nothing, and the
 * offset it was documented at was wrong by four bytes, and both survived a full
 * green run. So each number gets a test that reads it back out of the document
 * and compares it against a value the fixture chose.
 *
 * The block is named for what these two tests check and not for a property of
 * the whole document. It was named `the --json document has a reader for
 * every field it carries` in round 3, which was a claim the block did not
 * check and which was not true of the tree it sat in; `docs/corrections.md`,
 * round 4, entry 1.
 */
describe('every number the --json row carries is read back here', { timeout: SPAWN_TIMEOUT_MS }, () => {
  it('the --json row says WHERE the NSIS signature was found', () => {
    // `signatureAt` shipped in round 2 written and read by nothing, which is
    // the same unread-write shape this branch had already been failed for once.
    // It is not deleted because it is the one field that can distinguish "the
    // sequence is somewhere in this file" from "the sequence is at the offset a
    // real setup puts it at": every other assertion in this file is satisfied
    // by a `findBytes` that returns any non-negative number.
    //
    // Asserted against the synthetic tree and not the repository's own bundle
    // directory, on purpose. `this tree declares both Windows installers`, the
    // one test here that points the guard at the real repository, asks the
    // real `tauri.conf.json` for the EXPECTATION only, because a developer who
    // has not run `pnpm bundle` has no `target/release/bundle` and that is not
    // a failing repository. Here the fixture writes the sequence itself, so the
    // offset is known without anything having been built.
    writeConfig({ active: true, targets: 'all' });
    goodMsi();
    goodNsis();

    const child = spawnSync(
      process.execPath,
      [GUARD, '--root', root, '--platform', 'win32', '--json'],
      { encoding: 'utf8', shell: false },
    );
    const parsed = JSON.parse(child.stdout ?? '{}') as {
      ok?: boolean;
      rows?: { target: string; verdict: string; signatureAt?: number }[];
    };

    const nsis = (parsed.rows ?? []).find((row) => row.target === 'nsis');
    expect(nsis?.verdict).toBe('OK');
    expect(
      nsis?.signatureAt,
      'the guard reported the NSIS signature at a different offset than the one ' +
        'the fixture wrote it at, so it is not reporting the position it found',
    ).toBe(NSIS_SIGNATURE_AT);

    // The MSI row has no signature demand at all, so it must not acquire the
    // field — otherwise this assertion would pass on a guard that stamps every
    // row with a constant.
    const msi = (parsed.rows ?? []).find((row) => row.target === 'msi');
    expect(msi?.verdict).toBe('OK');
    expect(msi).not.toHaveProperty('signatureAt');

    expect(parsed.ok).toBe(true);
    expect(child.status).toBe(0);
  });

  it('the --json row on a TRUNCATED verdict says how big the file it rejected was', () => {
    // `bytes` is what makes TRUNCATED actionable rather than merely negative.
    // The verdict says the file is below the floor; the number says whether a
    // caller is looking at a 1 KB stub or at a 250 KB partial write, both of
    // which are under the msi floor and both of which read TRUNCATED. Without
    // a reader it is a write nothing consumes, which is the shape this branch
    // has already been failed for once.
    //
    // Both rows are asserted, and the two sizes differ, so a guard that
    // stamped every row with one constant -- or that reported the floor it
    // compared against instead of the size it measured -- fails here. RUNT is
    // well under the msi floor of 262,144 bytes and still carries perfect
    // OLE2 magic and a perfect name, so size is the only thing wrong with it.
    const RUNT = 1_024;
    writeConfig({ active: true, targets: 'all' });
    artefact('msi', 'Vela_' + VERSION + '_x64_en-US.msi', MSI_MAGIC, RUNT);
    goodNsis();

    const child = spawnSync(
      process.execPath,
      [GUARD, '--root', root, '--platform', 'win32', '--json'],
      { encoding: 'utf8', shell: false },
    );
    const parsed = JSON.parse(child.stdout ?? '{}') as {
      ok?: boolean;
      rows?: { target: string; verdict: string; bytes?: number }[];
    };

    const msi = (parsed.rows ?? []).find((row) => row.target === 'msi');
    expect(msi?.verdict).toBe('TRUNCATED');
    expect(
      msi?.bytes,
      'the guard reported a size other than the one the fixture wrote, so the ' +
        'row is not carrying the size of the file it actually rejected',
    ).toBe(RUNT);

    const nsis = (parsed.rows ?? []).find((row) => row.target === 'nsis');
    expect(nsis?.verdict).toBe('OK');
    expect(nsis?.bytes).toBe(BIG);

    expect(parsed.ok).toBe(false);
    expect(child.status).toBe(1);
  });
});
