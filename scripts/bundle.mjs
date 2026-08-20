#!/usr/bin/env node
/**
 * Build the installers, then ask the disk whether they exist.
 *
 *   node scripts/bundle.mjs [-- <extra args for `tauri build`>]
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
 * READERS: `package.json` exposes this as `pnpm bundle`. Its stdout is the
 * evidence quoted in `docs/release-posture.md`.
 */

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function main() {
  const extra = process.argv.slice(2);
  const command = ['pnpm', 'tauri', 'build', ...extra].join(' ');

  // Taken before the child starts. Everything the check calls "fresh" is
  // measured against this instant and nothing else.
  const sentinelMs = Date.now();
  process.stdout.write('bundle: sentinel ' + new Date(sentinelMs).toISOString() + '\n');
  process.stdout.write('bundle: ' + command + '\n\n');

  const build = spawnSync(command, { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
  // A signalled child has a null status; that is not a success.
  const buildExit = build.error !== undefined ? 1 : (build.status ?? 1);
  process.stdout.write('\nBUNDLER_EXIT=' + String(buildExit) + '\n');

  process.stdout.write('\n=== the disk, not the exit code ===\n');
  const check = spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts', 'check-bundle.mjs'), '--since', String(sentinelMs)],
    { cwd: REPO_ROOT, stdio: 'inherit', shell: false },
  );
  const checkExit = check.error !== undefined ? 1 : (check.status ?? 1);

  if (buildExit !== 0 && checkExit === 0) {
    process.stdout.write(
      '\nbundle: the bundler exited ' + String(buildExit) +
        ' but every declared installer is on disk, fresh and well formed.\n' +
        'Something after the bundling step failed. This is still a failure, but it\n' +
        'is not the "green build, no installer" defect.\n',
    );
  }
  if (buildExit === 0 && checkExit !== 0) {
    process.stdout.write(
      '\nbundle: THE BUNDLER EXITED 0 AND PRODUCED NO USABLE INSTALLER.\n' +
        'This is the exact shape of the .ico defect in docs/release-posture.md section 6,\n' +
        'and it is the reason this project does not accept an exit code as evidence.\n',
    );
  }

  const exitCode = buildExit !== 0 || checkExit !== 0 ? 1 : 0;
  process.stdout.write('BUNDLE_EXIT=' + String(exitCode) + '\n');
  process.exit(exitCode);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main();
