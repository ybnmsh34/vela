/**
 * `scripts/bundle.mjs` must run the disk check even when the bundler failed.
 *
 * ## Why this file exists
 *
 * `bundle.mjs` carried a long header arguing that `pnpm tauri build && check`
 * is the wrong shape, because `&&` merges the two failures the release path
 * most needs to tell apart: a bundler that exits non-zero having produced good
 * installers, and a bundler that exits ZERO having produced none — the second
 * being the `Couldn't find a .ico icon` defect in `docs/release-posture.md` §6.
 *
 * The argument was correct and nothing held it down. Measured: inserting
 *
 *     if (buildExit !== 0) { process.exit(1); }
 *
 * ahead of the disk check — deleting the file's entire stated purpose — changed
 * no verdict in any of the release-path test files, because none of them drove
 * this file at all. RULE T: prose can neither create an edge nor prove one.
 *
 * ## Why this drives the CLI rather than importing the module
 *
 * `bundle.mjs` could have exported its `runBundle` with an injectable `spawn`,
 * and a test could have handed it a recording fake and read the call list. That
 * version was written first and abandoned: `tsc --build` covers `src` with no
 * `allowJs`, so a `.ts` file that imports `scripts/bundle.mjs` as a module fails
 * `pnpm typecheck` — the first gate — before any of it runs. The seam went with
 * it rather than being left in place unread.
 *
 * Nothing is lost. The question is whether the disk check runs after a bundler
 * that failed, and the check's own output in the log answers it: the first test
 * below has the fake bundler exit 1 and then asserts the check's per-artefact
 * lines are present. Under `&&`, or under the mutation above, they are not.
 * Driving the CLI also covers `main()`'s wiring, which a module-level test
 * would have left uncovered.
 *
 * ## Why the bundler is fake and the check is real
 *
 * The real bundler is `pnpm tauri build`: a from-scratch Rust release build with
 * WiX and NSIS, tens of minutes, and the thing under test here is not it. The
 * fake writes installer-shaped files — right magic, right size, right name, and
 * for NSIS the first-header signature `check-bundle.mjs` demands — so the
 * *check* that runs against them is the shipped one, unmocked.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Every test here starts real child processes, and this suite has already gone
 * red from load alone — `Test timed out in 5000ms` failures during this
 * branch's runs, in files it does not touch, each green when run on its own;
 * `docs/release-posture.md` §13b holds the list and the count. Vitest's default
 * 5s budget is a statement about an idle box; a red from it would be fabricated
 * by load. A ceiling that catches a hang, not an assertion about how long a
 * spawn takes.
 */
const SPAWN_TIMEOUT_MS = 60_000;

const REPO_ROOT = process.cwd();
const RUNNER = join(REPO_ROOT, 'scripts', 'bundle.mjs');

const VERSION = '0.1.0';
/** OLE2 compound file — what an MSI actually is. */
const MSI_MAGIC = 'd0cf11e0a1b11ae1';
/** `MZ`. A PE image — which `vela.exe` is too, hence the signature below. */
const PE_MAGIC = '4d5a';
/** NSIS's first header: `EF BE AD DE` + `NullsoftInst`, all sixteen bytes. */
const NSIS_SIGNATURE = 'efbeadde4e756c6c736f6674496e7374';
/**
 * Where the real setup carries it: measured at 52,740 in
 * `src-tauri/target/release/bundle/nsis/Vela_0.1.0_x64-setup.exe`. The offset
 * is immaterial to this file — the guard scans — but it matches
 * `bundle-guard.test.ts`, and 52,744 is the wrong number for this sequence;
 * see `docs/corrections.md`, round 3, entry 1.
 */
const NSIS_SIGNATURE_AT = 52_740;
const BIG = 4_000_000;

let scratch: string;
let root: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vela-t01-bundle-run-'));
  root = join(scratch, 'repo');
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  writeFileSync(
    join(root, 'src-tauri', 'tauri.conf.json'),
    JSON.stringify({
      productName: 'Vela',
      version: VERSION,
      identifier: 'dev.vela.desktop',
      bundle: { active: true, targets: 'all' },
    }),
    'utf8',
  );
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A bundler that exits `code`, having either written both installers into the
 * synthetic tree or written nothing at all. `ageMs` backdates what it writes,
 * which is how the sentinel is tested.
 */
function writeFakeBundler(
  code: number,
  produces: 'installers' | 'nothing',
  ageMs = 0,
): string {
  const name = 'fake-bundler.mjs';
  const write =
    "import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';\n" +
    "import { join } from 'node:path';\n" +
    "const bundle = join(process.cwd(), 'src-tauri', 'target', 'release', 'bundle');\n" +
    'const write = (dir, file, magicHex, signatureAt) => {\n' +
    '  mkdirSync(join(bundle, dir), { recursive: true });\n' +
    '  const body = Buffer.alloc(' + String(BIG) + ');\n' +
    "  Buffer.from(magicHex, 'hex').copy(body, 0);\n" +
    "  if (signatureAt !== null) Buffer.from('" + NSIS_SIGNATURE + "', 'hex').copy(body, signatureAt);\n" +
    '  const path = join(bundle, dir, file);\n' +
    '  writeFileSync(path, body);\n' +
    '  if (' + String(ageMs) + ' > 0) {\n' +
    '    const when = (Date.now() - ' + String(ageMs) + ') / 1000;\n' +
    '    utimesSync(path, when, when);\n' +
    '  }\n' +
    '};\n';
  const body =
    (produces === 'installers'
      ? write +
        "write('msi', 'Vela_" + VERSION + "_x64_en-US.msi', '" + MSI_MAGIC + "', null);\n" +
        "write('nsis', 'Vela_" + VERSION + "_x64-setup.exe', '" + PE_MAGIC + "', " +
        String(NSIS_SIGNATURE_AT) + ");\n"
      : "console.log('Built application at: vela.exe');\n") +
    'process.exit(' + String(code) + ');\n';
  writeFileSync(join(root, name), body, 'utf8');
  return name;
}

/**
 * `--platform win32` explicitly: `pnpm test` runs on `ubuntu-latest` as well as
 * `windows-latest`, and a Windows-only test of the Windows release path is one
 * CI mostly does not run.
 */
function runCli(bundlerFile: string): { code: number; out: string } {
  const child = spawnSync(
    process.execPath,
    [RUNNER, '--bundler', 'node ' + bundlerFile, '--root', root, '--platform', 'win32'],
    { encoding: 'utf8', shell: false, cwd: REPO_ROOT },
  );
  return { code: child.status ?? -1, out: (child.stdout ?? '') + (child.stderr ?? '') };
}

describe('the disk check is not behind the bundler’s exit code', { timeout: SPAWN_TIMEOUT_MS }, () => {
  it('the bundler FAILS and the check still runs', () => {
    // The load-bearing test in this file. `BUNDLER_EXIT=1` and then the check's
    // own per-artefact lines: under `&&`, or under the mutation in the header,
    // everything after the first assertion is absent from the log.
    const bundler = writeFakeBundler(1, 'installers');
    const { code, out } = runCli(bundler);

    expect(out).toContain('BUNDLER_EXIT=1');
    expect(
      out,
      'the bundler exited 1, and the disk check must have run anyway — that is ' +
        'this script’s entire argument for not being `build && check`',
    ).toMatch(/OK\s+Vela_0\.1\.0_x64_en-US\.msi/u);
    expect(out).toMatch(/OK\s+Vela_0\.1\.0_x64-setup\.exe/u);
    expect(out).toContain('BUNDLE_OK=yes');
    expect(
      out,
      'and the log must say WHICH of the two failures this was',
    ).toContain('is not the "green build, no installer" defect');
    expect(out).toContain('BUNDLE_EXIT=1');
    expect(code).toBe(1);
  });

  it('the bundler exits 0 having produced nothing, and the disk catches it', () => {
    // The .ico defect in miniature: a green bundler and an empty bundle tree.
    const bundler = writeFakeBundler(0, 'nothing');
    const { code, out } = runCli(bundler);

    expect(out).toContain('BUNDLER_EXIT=0');
    expect(out).toMatch(/NO-DIR/u);
    expect(out).toContain('BUNDLE_OK=no');
    expect(out).toContain('THE BUNDLER EXITED 0 AND PRODUCED NO USABLE INSTALLER');
    expect(out).toContain('BUNDLE_EXIT=1');
    expect(code).toBe(1);
  });

  it('the control: a bundler that works produces a green run', () => {
    // Without this, both reds above are satisfied by a script that always fails.
    const bundler = writeFakeBundler(0, 'installers');
    const { code, out } = runCli(bundler);

    expect(out).toContain('BUNDLER_EXIT=0');
    expect(out).toContain('BUNDLE_OK=yes');
    expect(out).toContain('BUNDLE_EXIT=0');
    expect(out).not.toContain('NO USABLE INSTALLER');
    expect(code).toBe(0);
  });
});

describe('the sentinel is taken before the bundler starts', { timeout: SPAWN_TIMEOUT_MS }, () => {
  it('installers that predate this run are STALE even though the bundler wrote them', () => {
    // Why the sentinel and the build are in one file at all. The bundler here
    // exits 0 and both artefacts are present, well formed and correctly named —
    // they are simply dated two days ago, which is what a run that skipped
    // bundling and left last week's output behind looks like on disk.
    //
    // What this test does and does not hold down, measured on this tree by
    // mutating `bundle.mjs` and running this file twice per mutation:
    //
    //   - demanding no age at all (deleting `'--since', String(sentinelMs)`
    //     from the check's argv): THIS test goes red, `1 failed | 5 passed
    //     (6)`, the log reading `BUNDLER_EXIT=0` / `BUNDLE_EXIT=0`. That is the
    //     mutation this test is for.
    //   - moving `const sentinelMs = Date.now()` to after the spawn: this test
    //     stays GREEN — the artefacts are backdated two days, so they are stale
    //     against a post-build sentinel too. What goes red instead is the pair
    //     of good-bundler cases above, `2 failed | 4 passed (6)`, because a
    //     sentinel taken after the bundler wrote is later than the mtimes the
    //     bundler just produced and the fresh installers are called STALE.
    //
    // So a post-build sentinel is caught by this file, but by those two tests
    // and not by this one: it is a false-red machine rather than a false-green
    // one. The claim in round 2 that "a sentinel taken after the build ...
    // passes this tree" was wrong in the direction that matters and is
    // withdrawn; `docs/corrections.md`, round 3, entry 2.
    const bundler = writeFakeBundler(0, 'installers', 48 * 60 * 60 * 1000);
    const { code, out } = runCli(bundler);

    expect(out).toContain('BUNDLER_EXIT=0');
    expect(out).toMatch(/STALE/u);
    expect(out).toContain('BUNDLE_OK=no');
    expect(out).toContain('BUNDLE_EXIT=1');
    expect(code).toBe(1);
  });
});

describe('the flags are test seams and the release path passes none of them', () => {
  it('`pnpm bundle` runs this script with no arguments at all', () => {
    // `--bundler`, `--root` and `--platform` exist so the tests above can drive
    // a real CLI against a synthetic tree. If the shipped script ever started
    // passing one of them, the thing CI runs and the thing measured here would
    // be different programs, and this file would be testing a configuration
    // nobody uses.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.bundle).toBe('node scripts/bundle.mjs');
  });

  it('the default bundler is the real one', { timeout: SPAWN_TIMEOUT_MS }, () => {
    // Asked of the running program rather than of its source text. `--print-plan`
    // resolves the options and starts nothing, which is the only way to ask this
    // question without paying for a from-scratch Tauri release build.
    const child = spawnSync(process.execPath, [RUNNER, '--print-plan'], {
      encoding: 'utf8',
      shell: false,
      cwd: REPO_ROOT,
    });
    const plan = JSON.parse(child.stdout ?? '{}') as { bundler?: string; platform?: string | null };
    expect(plan.bundler).toBe('pnpm tauri build');
    expect(plan.platform).toBeNull();
    expect(child.status).toBe(0);
  });
});
