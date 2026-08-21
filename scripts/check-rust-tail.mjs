#!/usr/bin/env node
/**
 * Did `cargo test` actually run, or did something merely exit 0?
 *
 *   node scripts/check-rust-tail.mjs [--target-dir <dir>] [--since <epoch-ms>]
 *
 * WHY AN EXIT CODE IS NOT THE ANSWER
 *
 * At tag `run-start-2026-08-17`, `pnpm verify` was one shell string ending in
 * `cargo build --workspace --locked && cargo test --workspace --locked` — the
 * last two of its ten gates, reached across ten `&&` operators, nine of them
 * ahead of `cargo build`. On the platform Vela ships on they were never once
 * executed by anyone running the documented command: cargo is not on PATH here,
 * gate 2 — `pnpm lint:rust` — dies on `'cargo' is not recognized`, and the
 * chain short-circuits. The run reports exit 1 and one ELIFECYCLE line. Nothing
 * says which gates were skipped, and skipped is not passed.
 *
 * `pnpm verify` is now `node scripts/verify.mjs`, which reports SKIPPED apart
 * from PASS and so does say which gates did not run. It still cannot say that
 * one DID: a gate that reports PASS is a child process that exited 0, and this
 * script exists because exiting 0 is not the same as having done the work.
 *
 * So this asks the question an exit code cannot: is the physical output of
 * `cargo test` on disk?
 *
 * THE TELL, AND WHY IT IS THIS ONE AND NOT AN EASIER ONE
 *
 * The tempting tell is "there are executables under `target/debug/deps`". That
 * is wrong here and would pass on a tree where `cargo test` never ran: `cargo
 * build` puts the `vela` binary's own artefact in `deps/` too, so the directory
 * is full of executables after a plain build. Measured, not assumed — see
 * `docs/release-posture.md` for the run this was taken from.
 *
 * What `cargo build` does NOT do is compile the `tests/` directory. Every
 * `tests/<name>.rs` in the workspace is a separate integration-test target,
 * built only by `cargo test` (or `cargo test --no-run` / `cargo build --tests`),
 * and it lands as `deps/<name>-<hash>.exe`. So the tell is per-target and is
 * derived from the tree rather than hardcoded: enumerate the integration test
 * files, demand a binary for each. A test file added to the workspace that
 * never gets built is then a failure here, which "some executables exist" could
 * never notice.
 *
 * FRESHNESS: TWO RULES TRIED, BOTH WRONG, AND WHAT IS LEFT
 *
 * "A binary exists" is satisfied by a binary from last week, so the obvious
 * strengthening is to demand a recent one. Two versions of that were written
 * and both produced FALSE REDS on this repository. Recording them because the
 * reason they failed is the same reason, and it is not obvious:
 *
 *  1. **A wall-clock sentinel.** `verify.mjs` passed the instant the run
 *     started; every binary had to be newer. The first full run came back with
 *     all ten gates green, `cargo test --workspace --locked` exit 0 having
 *     genuinely executed the suite — and all forty targets STALE. Cargo is a
 *     build cache. Nothing had changed, so nothing was relinked, so no mtime
 *     moved. The rule asks "did THIS run produce these binaries?", which is not
 *     a question a correct run has to answer yes to.
 *
 *  2. **The newest source in the workspace.** Every binary had to be at least
 *     as new as the newest `.rs`, `Cargo.toml` or `Cargo.lock`. That looked
 *     like the invariant `cargo test` establishes. It is not the one cargo
 *     uses: cargo fingerprints CONTENT, not modification times. `pnpm tauri
 *     build` rewrote `src-tauri/Cargo.toml` in place — same bytes, new mtime —
 *     and four test binaries that correspond exactly to the current sources
 *     were reported STALE against a file whose content had not changed.
 *
 * The common error: both rules re-derive a decision the build system already
 * makes, using a cruder signal than the build system uses. An mtime comparison
 * cannot be a better answer about "is this artefact current" than cargo's own
 * fingerprint, and where the two disagree the guard is wrong.
 *
 * So the default demand is EXISTENCE PER TARGET, and the age dimension is left
 * to the caller. What closes the "last week's binary" hole is not this file but
 * the structure around it: `verify.mjs` consults the probe only when the
 * `cargo test` gate has just PASSED, and reports `RUST_TAIL=NOT-REACHED` when
 * it has not. The probe answers "did the tail leave its artefacts", the gate
 * ordering answers "did the tail just run", and neither is asked to do the
 * other's job.
 *
 * `--since <epoch-ms>` is kept for a caller who genuinely wants "produced after
 * this instant" — a cold CI runner with no cargo cache, for instance, where the
 * premise holds. Nothing in this repository passes it, and the two paragraphs
 * above are why.
 *
 * WHAT THIS DOES NOT CLAIM. It proves the test binaries were COMPILED, which is
 * what `cargo test --no-run` does. It cannot prove they were executed or that
 * they passed — cargo leaves no artefact for that. The gate's own exit code is
 * what says they passed; this says the gate ran at all. The two together are
 * the claim, and neither alone is.
 *
 * READERS: `scripts/verify.mjs` invokes this after the `cargo-test` gate;
 * `src/platform/rust-tail.test.ts` drives it against synthetic trees;
 * `.github/workflows/ci.yml` runs it in the Rust jobs on both platforms.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const options = { targetDir: null, since: null, root: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--target-dir') {
      options.targetDir = value;
      i += 1;
    } else if (flag === '--since') {
      options.since = Number(value);
      i += 1;
    } else if (flag === '--root') {
      options.root = value;
      i += 1;
    } else {
      process.stderr.write('check-rust-tail: unknown argument ' + String(flag) + '\n');
      process.exit(2);
    }
  }
  if (options.since !== null && !Number.isFinite(options.since)) {
    process.stderr.write('check-rust-tail: --since needs a number of milliseconds\n');
    process.exit(2);
  }
  return options;
}

/**
 * Cargo derives a test target's name from the file stem and then normalises it
 * the way it normalises any crate name: `-` becomes `_`. A test source whose
 * stem is `a-b` is built as `a_b-<hash>.exe`, so comparing raw stems would miss
 * it.
 */
function targetName(fileStem) {
  return fileStem.replace(/-/gu, '_');
}

/**
 * A source path as a reader of this repository would type it: relative to the
 * root the guard was pointed at, with forward slashes on every platform, so the
 * same MISSING row reads the same way on Windows and on a CI runner.
 */
function repoRelative(root, path) {
  return relative(root, path).replace(/\\/gu, '/');
}

/** Every `tests/*.rs` in the workspace: the host package and every crate. */
function integrationTestTargets(root) {
  const srcTauri = join(root, 'src-tauri');
  const roots = [srcTauri];
  const cratesDir = join(srcTauri, 'crates');
  if (existsSync(cratesDir)) {
    for (const entry of readdirSync(cratesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(cratesDir, entry.name));
    }
  }

  const targets = [];
  for (const crateRoot of roots) {
    const testsDir = join(crateRoot, 'tests');
    if (!existsSync(testsDir)) continue;
    for (const entry of readdirSync(testsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.rs')) continue;
      targets.push({
        source: join(testsDir, entry.name),
        name: targetName(entry.name.slice(0, -3)),
      });
    }
  }
  return targets.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The compiled binary for one integration-test target, if `cargo test` built
 * it. Cargo suffixes a metadata hash and, on Windows, `.exe`; it also leaves
 * `.d` and `.pdb` siblings, which are not the binary and must not answer for
 * it. `foo-<hash>.d` exists after a plain `cargo build --tests`-less run in
 * some cargo versions, so accepting any `foo-*` file would reintroduce exactly
 * the false pass this guard exists to prevent.
 */
function binaryFor(depsDir, name, isWindows) {
  if (!existsSync(depsDir)) return null;
  const suffix = isWindows ? '.exe' : '';
  const prefix = name + '-';
  const found = [];
  for (const entry of readdirSync(depsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = entry.name;
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    if (suffix === '') {
      if (rest.includes('.')) continue;
    } else {
      if (!rest.endsWith(suffix)) continue;
      if (rest.slice(0, -suffix.length).includes('.')) continue;
    }
    const stat = statSync(join(depsDir, file));
    // Two fields, both read below: `mtimeMs` by the sort here and by the
    // `--since` comparison in `checkRustTail`, `size` by the BUILT detail
    // string. The full path was on this object too until round 5 and nothing
    // ever read it; `docs/corrections.md`, round 5, entry 1.
    found.push({ mtimeMs: stat.mtimeMs, size: stat.size });
  }
  if (found.length === 0) return null;
  // Several metadata hashes can coexist across feature sets; the newest is the
  // one this run produced, and `--since` is what decides whether that is recent
  // enough. Taking the newest and then testing it is deliberate: taking the
  // oldest would fail a tree that is merely untidy.
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0];
}

function checkRustTail({ root, targetDir, since, platform = process.platform }) {
  const resolvedTarget = targetDir ?? join(root, 'src-tauri', 'target');
  const depsDir = join(resolvedTarget, 'debug', 'deps');
  const isWindows = platform === 'win32';
  const targets = integrationTestTargets(root);

  // An explicit `--since` is a stricter demand a caller made on purpose. There
  // is deliberately no default age rule; two were tried and both produced false
  // reds, for the reason set out in this file's header.
  const explicit = since !== null && since !== undefined;
  const thresholdMs = explicit ? since : 0;
  const thresholdWhy = explicit
    ? 'the --since sentinel this caller supplied'
    : 'no age is demanded; see this header on why an mtime rule cannot answer ' +
      'that, and verify.mjs on what does';

  // THREE FIELDS, AND NO FOURTH. Every row carries exactly `name`, `verdict`
  // and `detail`, and `main` below prints all three of them. Rows used to carry
  // `source` and, on two of the three shapes, the whole `binary` object; no
  // exported reader, no `--json` mode and no test ever consumed either, so the
  // enumeration's provenance was being recorded where nobody could see it. The
  // fix is not to delete the provenance but to print it: a MISSING row now
  // names the file the expectation was derived from, which is the one row shape
  // where a reader has to go looking for it. `docs/corrections.md`, round 5,
  // entry 1.
  const rows = targets.map((target) => {
    const binary = binaryFor(depsDir, target.name, isWindows);
    if (binary === null) {
      return {
        name: target.name,
        verdict: 'MISSING',
        detail: 'no test binary in deps/ for ' + repoRelative(root, target.source),
      };
    }
    if (thresholdMs > 0 && binary.mtimeMs < thresholdMs) {
      return {
        name: target.name,
        verdict: 'STALE',
        detail:
          'built ' +
          new Date(binary.mtimeMs).toISOString() +
          ', older than ' +
          new Date(thresholdMs).toISOString(),
      };
    }
    return {
      name: target.name,
      verdict: 'BUILT',
      detail: String(binary.size) + ' bytes',
    };
  });

  return {
    depsDir,
    rows,
    thresholdMs,
    thresholdWhy,
    // The verdict, and the only place it is computed. `main` branches on this
    // field; it used to re-derive the same answer from a `bad.length > 0` of
    // its own while this one was read by nothing, which is a guard with two
    // verdicts that are free to disagree. `bad` still exists below, but only to
    // count rows for the failure message. `docs/corrections.md`, round 5,
    // entry 1.
    ok: rows.length > 0 && rows.every((row) => row.verdict === 'BUILT'),
  };
}

/** Says what the age demand is AND where it came from, so a STALE row is actionable. */
function thresholdLabel(result) {
  if (result.thresholdMs === 0) return '(nothing: ' + result.thresholdWhy + ')';
  return new Date(result.thresholdMs).toISOString() + ' - ' + result.thresholdWhy;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = checkRustTail(options);

  process.stdout.write('check-rust-tail: deps directory ' + result.depsDir + '\n');
  process.stdout.write('check-rust-tail: age demand: ' + thresholdLabel(result) + '\n');
  for (const row of result.rows) {
    process.stdout.write('  ' + row.verdict.padEnd(8) + ' ' + row.name.padEnd(34) + ' ' + row.detail + '\n');
  }

  if (result.rows.length === 0) {
    // An empty expectation set passes every check ever written against it. This
    // is the failure a guard is likeliest to ship with, so it is named and it
    // fails closed.
    process.stderr.write(
      'check-rust-tail: FAILED - no integration test targets were found under\n' +
        'src-tauri/tests or src-tauri/crates/*/tests. Either the workspace layout\n' +
        'moved or this guard is looking in the wrong place; an empty expectation\n' +
        'set is not a pass.\n',
    );
    process.stdout.write('RUST_TAIL_RAN=no\n');
    process.exit(1);
  }

  if (!result.ok) {
    const bad = result.rows.filter((row) => row.verdict !== 'BUILT');
    process.stderr.write(
      'check-rust-tail: FAILED - ' +
        String(bad.length) +
        ' of ' +
        String(result.rows.length) +
        ' integration test targets are not BUILT; see the rows above.\n' +
        '`cargo build` does not compile tests/; only `cargo test` does. The Rust tail\n' +
        'of this run did not execute, whatever the exit codes said.\n',
    );
    process.stdout.write('RUST_TAIL_RAN=no\n');
    process.exit(1);
  }

  process.stdout.write(
    'check-rust-tail: all ' +
      String(result.rows.length) +
      ' integration test targets have a compiled binary.\n',
  );
  process.stdout.write('RUST_TAIL_RAN=yes\n');
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main();
