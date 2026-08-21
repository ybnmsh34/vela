#!/usr/bin/env node
/**
 * Build the installers, then ask the disk whether they exist.
 *
 *   node scripts/bundle.mjs [--bundler <command>] [--root <dir>]
 *                           [--platform <name>] [--print-plan]
 *
 * WHY THE BUILD AND THE CHECK ARE IN ONE FILE
 *
 * The check needs a sentinel taken BEFORE the bundler starts, or "the artefact
 * is there" is satisfied by an artefact from last week. Only the thing that
 * launches the bundler can take that sentinel honestly, so the two belong
 * together. `pnpm bundle:check` still exists for checking a tree someone else
 * built; it just cannot rule out staleness on its own, and says so by having no
 * `--since` unless a caller supplies one.
 *
 * WHY THE CHECK RUNS EVEN WHEN THE BUNDLER FAILS
 *
 * `x && y` would skip it. The two failure modes this file exists to separate
 * are exactly the two that `&&` merges:
 *
 *   - the bundler exits non-zero having produced perfectly good installers
 *     (a post-bundle step failed, e.g. signing on a machine with no cert), and
 *   - the bundler exits ZERO having produced none at all — which is what
 *     happened on this tree, with `Couldn't find a .ico icon`. See
 *     `docs/release-posture.md` section 6 and the header of
 *     `scripts/check-bundle.mjs`.
 *
 * So both facts are measured and both are reported. The exit status is the OR
 * of them, because either one alone means you cannot ship, but the log says
 * which.
 *
 * WHY THE FILE IS SHAPED LIKE THIS, AND NOT AS A `main()` FULL OF LOGIC
 *
 * It shipped that way and the argument above was held up by nothing: no test
 * drove this file. Inserting `if (buildExit !== 0) { process.exit(1); }` ahead
 * of the disk check — which deletes this file's entire stated reason for
 * existing — changed no verdict in any of the release-path test files. It now
 * turns `src/platform/bundle-runner.test.ts` red, reproduced twice; the other
 * four release-path files were measured green under the same mutation, so the
 * red belongs to the file written for it. A paragraph that says "the check runs
 * even when the bundler fails" is prose; it can neither create nor prove that
 * edge.
 *
 * So the flags below exist: enough of a seam that
 * `src/platform/bundle-runner.test.ts` can run this file, as a program, against
 * a synthetic tree with a fake bundler — one that exits 1 after writing good
 * installers, one that exits 0 after writing none, one control that works, and
 * one that writes installers dated two days ago. Under the mutation above, the
 * first of those goes red twice: the check's own lines are simply not in the
 * log.
 *
 * An injectable `spawn` was written first and removed. It let a test read the
 * call list directly, which was nicer, but it was reachable only by importing
 * this module from a `.ts` test — and `tsc --build` covers `src` with no
 * `allowJs`, so that import fails `pnpm typecheck`, the first gate. A seam no
 * test can reach is a seam nothing reads.
 *
 * THE FLAGS ARE TEST SEAMS, AND THE RELEASE PATH PASSES NONE OF THEM
 *
 * `--bundler` defaults to `pnpm tauri build`; `--root` to this repository;
 * `--platform` to whatever `check-bundle.mjs` decides for itself;
 * `--print-plan` resolves those three, prints them and starts nothing, which is
 * how a test asks what the defaults are without paying for a from-scratch Tauri
 * release build. `pnpm bundle` — the script CI runs and the one in
 * `package.json` — passes no arguments at all, and a test asserts that too. The
 * previous version instead appended `process.argv.slice(2)` verbatim to the
 * command string it handed a shell; that pass-through had no caller and is
 * gone.
 *
 * READERS: `package.json` exposes this as `pnpm bundle`;
 * `.github/workflows/ci.yml` runs it in the `bundle` job;
 * `src/platform/bundle-runner.test.ts` drives this CLI and reads the
 * `BUNDLER_EXIT=` and `BUNDLE_EXIT=` lines below, the `bundle:` plan line, and
 * `check-bundle.mjs`'s own output underneath them.
 */

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The bundler this drives when nobody says otherwise. */
const DEFAULT_BUNDLER = 'pnpm tauri build';

function parseArgs(argv) {
  const options = { bundler: DEFAULT_BUNDLER, root: REPO_ROOT, platform: null, printPlan: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--print-plan') {
      // Resolve the options, print them, start nothing. The defaults are the
      // release path, and the only other way to ask what they are is to run a
      // from-scratch Tauri release build.
      options.printPlan = true;
      continue;
    }
    const value = argv[i + 1];
    if (flag === '--bundler') {
      options.bundler = value;
    } else if (flag === '--root') {
      options.root = value;
    } else if (flag === '--platform') {
      options.platform = value;
    } else {
      process.stderr.write('bundle: unknown argument ' + String(flag) + '\n');
      process.exit(2);
    }
    i += 1;
  }
  return options;
}

/** What a `spawnSync` result means as an exit status. A signalled child is not a success. */
function exitStatusOf(result) {
  return result.error !== undefined && result.error !== null ? 1 : (result.status ?? 1);
}

/**
 * The report. Every line of it goes to stdout — the log body — because that is
 * where `BUNDLER_EXIT=` and `BUNDLE_EXIT=` have to be readable from, by a
 * person and by `src/platform/bundle-runner.test.ts`.
 */
function write(text) {
  process.stdout.write(text);
}

/**
 * Drive the bundler, then the disk check, and report both.
 *
 * Returns `{ buildExit, checkExit, exitCode, sentinelMs }`.
 */
function runBundle({ bundler = DEFAULT_BUNDLER, root = REPO_ROOT, platform = null } = {}) {
  // Taken before the child starts. Everything the check calls "fresh" is
  // measured against this instant and nothing else.
  const sentinelMs = Date.now();
  write('bundle: sentinel ' + new Date(sentinelMs).toISOString() + '\n');
  write('bundle: ' + bundler + '\n\n');

  const build = spawnSync(bundler, { cwd: root, stdio: 'inherit', shell: true });
  const buildExit = exitStatusOf(build);
  write('\nBUNDLER_EXIT=' + String(buildExit) + '\n');

  // No `if` above this line, on purpose. See the header.
  write('\n=== the disk, not the exit code ===\n');
  const checkArgs = [
    join(REPO_ROOT, 'scripts', 'check-bundle.mjs'),
    '--since', String(sentinelMs),
    '--root', root,
  ];
  if (platform !== null) checkArgs.push('--platform', platform);
  const check = spawnSync(process.execPath, checkArgs, { cwd: root, stdio: 'inherit', shell: false });
  const checkExit = exitStatusOf(check);

  if (buildExit !== 0 && checkExit === 0) {
    write(
      '\nbundle: the bundler exited ' + String(buildExit) +
        ' but every declared installer is on disk, fresh and well formed.\n' +
        'Something after the bundling step failed. This is still a failure, but it\n' +
        'is not the "green build, no installer" defect.\n',
    );
  }
  if (buildExit === 0 && checkExit !== 0) {
    write(
      '\nbundle: THE BUNDLER EXITED 0 AND PRODUCED NO USABLE INSTALLER.\n' +
        'This is the exact shape of the .ico defect in docs/release-posture.md section 6,\n' +
        'and it is the reason this project does not accept an exit code as evidence.\n',
    );
  }

  const exitCode = buildExit !== 0 || checkExit !== 0 ? 1 : 0;
  write('BUNDLE_EXIT=' + String(exitCode) + '\n');
  return { buildExit, checkExit, exitCode, sentinelMs };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  if (options.printPlan) {
    process.stdout.write(JSON.stringify({ bundler: options.bundler, root: options.root, platform: options.platform }, null, 2) + '\n');
    process.exit(0);
  }
  process.exit(runBundle(options).exitCode);
}
