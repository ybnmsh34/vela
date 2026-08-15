#!/usr/bin/env node
/**
 * Runs one of this repo's `scripts/*.sh` gates from an npm script, on every
 * platform Vela is developed on.
 *
 *   node scripts/run-bash.mjs scripts/check-transcripts.sh [args...]
 *
 * WHY THIS FILE EXISTS
 *
 * `pnpm verify` chains nine gates with `&&`, and two of them are shell scripts
 * that `package.json` used to invoke by bare relative path —
 * `./scripts/check-transcripts.sh` and `./scripts/secret-scan.sh`. pnpm runs
 * script bodies through the platform shell, which on Windows is `cmd.exe`, and
 * cmd has no idea what a leading `./` means:
 *
 *   > pnpm run test:transcripts
 *   '.' is not recognized as an internal or external command,
 *   operable program or batch file.
 *   ELIFECYCLE  Command failed with exit code 1.
 *
 * Because `&&` short-circuits, that exit 1 also meant `cargo build --workspace
 * --locked` and `cargo test --workspace --locked` — the last two links in the
 * chain — were never once executed by anyone running the documented command on
 * the platform Vela ships on.
 *
 * WHY NOT `script-shell=bash` IN `.npmrc`, AND WHY NOT `bash scripts/x.sh`
 *
 * Both are the obvious fix and both are wrong here, for the same reason:
 * **on Windows, `bash` is not Git Bash.** Measured on a developer machine with
 * a stock Git for Windows install:
 *
 *   C:\> where bash
 *   C:\Windows\System32\bash.exe                     <- the WSL launcher
 *   C:\Users\...\AppData\Local\Microsoft\WindowsApps\bash.exe
 *
 *   C:\> where sh
 *   INFO: Could not find files for the given pattern(s).
 *
 * `C:\Windows\System32\bash.exe` starts a WSL distribution. A gate run through
 * it executes in a different operating system, against `/mnt/c/...`, with a
 * different PATH — `git` is there, `node` is not — and a different
 * `core.autocrlf`. `check-transcripts.sh` would fail on a missing `node`, and
 * `secret-scan.sh` would scan a checkout whose line endings it reads
 * differently from the one being committed. Neither failure would name WSL, and
 * a *pass* from that environment would be worse: it would be a green tick for
 * work no Windows build ever did. Git Bash is not on PATH at all on that
 * machine (`bash.exe` lives in `C:\Program Files\Git\bin`, and only
 * `C:\Program Files\Git\cmd` and `...\Git\mingw64\bin` are on PATH), so naming
 * `bash` cannot reach it.
 *
 * `.npmrc` also has no platform conditional, so a `script-shell` line would
 * impose one shell on Linux, macOS and Windows alike; and it would change the
 * shell for *every* script in `package.json`, not the two that need it.
 *
 * So this launcher names the shell instead of hoping PATH does. On Windows it
 * derives Git Bash from the Git installation already being used by the very
 * scripts it launches — both of them shell out to `git` — and it will refuse a
 * `bash` under the Windows system directory rather than silently hand a gate to
 * WSL.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * A `bash` under `%SystemRoot%` is the WSL launcher, never Git Bash. Running a
 * gate there runs it in another operating system; see the header comment.
 */
function isWindowsSystemBash(candidate) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const prefix = normalize(systemRoot).toLowerCase().replace(/[\\/]+$/u, '') + sep;
  return normalize(candidate).toLowerCase().startsWith(prefix);
}

/**
 * Where Git for Windows keeps `bash.exe`, relative to its install root. Both
 * layouts ship in current releases; `bin` is the POSIX-facing one.
 */
const BASH_UNDER_GIT_ROOT = [join('bin', 'bash.exe'), join('usr', 'bin', 'bash.exe')];

/**
 * Walk up from a path inside the Git installation until a directory holding
 * `bash.exe` turns up. `git --exec-path` reports
 * `C:/Program Files/Git/mingw64/libexec/git-core`, four levels below the root
 * that actually holds `bin/bash.exe`.
 */
function gitBashFrom(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    for (const relative of BASH_UNDER_GIT_ROOT) {
      const candidate = join(dir, relative);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findWindowsBash() {
  // An explicit override wins, so a machine with an unusual layout has a way
  // out that is not "edit this file". It does NOT win over the WSL check below:
  // no real Git Bash lives under %SystemRoot%, so the only thing that rule can
  // reject is the launcher that would silently run the gate in Linux.
  const override = process.env.VELA_BASH;
  if (override !== undefined && override !== '' && existsSync(override)) {
    if (!isWindowsSystemBash(override)) return override;
    process.stderr.write(
      `run-bash: refusing VELA_BASH=${override} — that is the WSL launcher, not Git Bash.\n`,
    );
    return null;
  }

  const roots = [];

  // Git's own report of where it lives. These scripts all shell out to `git`,
  // so if this fails the gate could not have run anyway.
  try {
    roots.push(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim());
  } catch {
    // Fall through to the fixed locations below.
  }

  // Set by Git Bash itself, so a nested invocation resolves for free.
  for (const variable of ['EXEPATH', 'GIT_INSTALL_ROOT']) {
    const value = process.env[variable];
    if (value !== undefined && value !== '') roots.push(value);
  }

  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA ?? '';
  roots.push(join(programFiles, 'Git'));
  roots.push(join(programFilesX86, 'Git'));
  if (localAppData !== '') roots.push(join(localAppData, 'Programs', 'Git'));

  for (const root of roots) {
    if (root === '') continue;
    const found = gitBashFrom(root);
    if (found !== null && !isWindowsSystemBash(found)) return found;
  }
  return null;
}

function resolveBash() {
  if (process.platform !== 'win32') return 'bash';

  const found = findWindowsBash();
  if (found !== null) return found;

  process.stderr.write(
    'run-bash: could not find Git Bash.\n' +
      '\n' +
      'This gate is a bash script and Windows has no bash of its own. The\n' +
      '`bash.exe` in %SystemRoot%\\System32 is the WSL launcher, which would run\n' +
      'the gate inside a Linux distribution against /mnt/c — a different PATH,\n' +
      'a different node, and a different checkout — so it is refused on purpose.\n' +
      '\n' +
      'Install Git for Windows (which ships Git Bash), or point VELA_BASH at a\n' +
      'bash.exe to use:\n' +
      '\n' +
      '    set VELA_BASH=C:\\Program Files\\Git\\bin\\bash.exe\n',
  );
  process.exit(1);
}

const [script, ...forwarded] = process.argv.slice(2);

if (script === undefined) {
  process.stderr.write('usage: node scripts/run-bash.mjs <script.sh> [args...]\n');
  process.exit(2);
}

const result = spawnSync(resolveBash(), [script, ...forwarded], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  // The scripts are POSIX; on Windows they still need Windows PATH to find
  // node, pnpm and cargo, which Git Bash provides by inheriting it.
  env: process.env,
});

if (result.error !== undefined) {
  process.stderr.write(`run-bash: could not start ${script}: ${result.error.message}\n`);
  process.exit(1);
}
// A signalled child has a null status; report it as a failure rather than a 0.
process.exit(result.status ?? 1);
