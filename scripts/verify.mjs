#!/usr/bin/env node
/**
 * `pnpm verify` — every gate, with a per-gate verdict.
 *
 *   node scripts/verify.mjs [--gates <file>] [--from <id>] [--list]
 *
 * THE DEFECT THIS REPLACES, MEASURED AT TAG run-start-2026-08-17 (c0feb93)
 *
 * `package.json` held the whole gate chain as one shell string:
 *
 *   pnpm typecheck && pnpm lint:rust && pnpm test && ... && cargo test --workspace --locked
 *
 * Run on the platform Vela ships on, where cargo is not on PATH:
 *
 *   > vela@0.1.0 lint:rust
 *   > cd src-tauri && cargo fmt --all --check && cargo clippy ...
 *   'cargo' is not recognized as an internal or external command,
 *   ELIFECYCLE  Command failed with exit code 1.
 *   VERIFY_EXIT=1
 *
 * `&&` short-circuits, so gates 3 to 10 — every test suite, the frontend build,
 * the secret tripwire, and both cargo gates — did not run. Nothing in that
 * output distinguishes "failed" from "never attempted", and the transcript is
 * two screens long, so the distinction is not one a reader recovers by looking
 * harder.
 *
 * The guard that was supposed to catch this, `src/platform/verify-covers-ci.test.ts`,
 * was green throughout. It asked whether each CI gate's TEXT appears in the
 * expanded `verify` string. It does. Text-reachability is not execution, and
 * the gap between those two questions is precisely where every gate after the
 * second one lived.
 *
 * WHAT THIS RUNNER DOES INSTEAD
 *
 *  - PREFLIGHT. Every tool named in a gate's `needs` is resolved before the run
 *    starts. A missing cargo is then reported once, up front, as a missing
 *    cargo — not as gate 2 failing for reasons the reader must infer from a
 *    nested ELIFECYCLE.
 *  - PER-GATE VERDICT. PASS / FAIL / SKIPPED, each with the child's exit status
 *    read from `spawnSync().status`, never from a shell variable after a pipe.
 *    `cmd | tail; echo $?` reports the status of `tail`; nothing here is a
 *    pipeline, so nothing here can report the wrong process.
 *  - SKIPPED IS PRINTED. It is a third outcome, not the absence of one. A run
 *    that stopped at gate 2 says so on eight further lines.
 *  - THE PHYSICAL TELL. After the tail gate, `scripts/check-rust-tail.mjs` asks
 *    the disk whether `cargo test` compiled the workspace's integration test
 *    binaries during this run. An exit code can be produced without running
 *    anything; those binaries cannot.
 *  - `VERIFY_EXIT=<n>` IS THE LAST LINE OF THE BODY. The harness that runs this
 *    project once reported "completed (exit code 0)" over a log whose body said
 *    `VERIFY_EXIT=1`, because the shell pipeline ended in a reporting command.
 *    Putting the number in the body is what makes the log self-describing when
 *    the wrapper around it is not.
 *
 * WHY STILL STOP AT THE FIRST FAILURE, RATHER THAN RUN EVERYTHING
 *
 * Considered and rejected. Running all ten gates unconditionally would let the
 * report say PASS/FAIL for each with no SKIPPED at all, which is strictly more
 * information. It also spends a full Rust workspace build — the two cargo gates
 * are the overwhelming majority of the wall clock — on a tree that failed
 * `tsc`, and floods the log with cascading failures whose common cause is the
 * first one. The reason the old chain was bad was never that it stopped; it was
 * that stopping was indistinguishable from passing. Naming SKIPPED fixes that
 * without paying for it.
 *
 * `--from <id>` — RESUME, AND WHY IT CANNOT EXIT 0
 *
 * `--from <id>` exists so a developer can resume after fixing gate 2 rather
 * than re-running gate 1. Gates before <id> are reported NOT-RUN, which is a
 * FOURTH outcome and is counted in the summary line and in the exit status: a
 * resumed run whose every executed gate passed exits **3**, and says
 * `INCOMPLETE` on its own line. That is not conservatism, it is the same defect
 * again — the first version excluded NOT-RUN from both, so `--from cargo-test`
 * printed `1 passed, 0 failed, 0 SKIPPED` and `VERIFY_EXIT=0` over nine gates
 * it had never started, and `docs/release-posture.md` §13b quoted such a run as
 * evidence. 3 rather than 1 so that "a gate went red" stays distinguishable
 * from "gates were skipped by --from".
 *
 * `--gates <file>` and `--root <dir>` exist so `verify-runner.test.ts` can
 * drive this file against synthetic gate lists; nothing in the release path
 * passes either.
 *
 * WHAT PREFLIGHT COSTS, STATED PLAINLY
 *
 * Preflight is checked for every gate in the run, not gate by gate as they come
 * up. On a machine with no cargo on PATH that means `pnpm verify` now runs
 * ZERO gates and prints ten BLOCKED lines and `VERIFY_EXIT=2`, where the old
 * `&&` chain at least ran `pnpm typecheck` before dying. That is a deliberate
 * trade and it is a real loss: the tools a run needs are known before the run,
 * and spending fifty seconds of `tsc` to arrive at a toolchain problem that was
 * knowable at second zero is worse than being told at second zero.
 *
 * `--from` does NOT get you round it, and this was measured rather than
 * assumed: `node scripts/verify.mjs --from test` on a cargo-less PATH prints
 * PREFLIGHT FAILED, eight BLOCKED lines and `VERIFY_EXIT=2`, because preflight
 * takes the union of `needs` over every gate from the start index ONWARD and
 * `cargo-build`/`cargo-test` are downstream of `test`. There is deliberately no
 * flag that runs the gates a missing toolchain does not block. A run that
 * quietly drops the cargo gates and reports on the rest is the thing this file
 * was written to stop.
 *
 * READERS: `package.json`'s `verify` script invokes this;
 * `src/platform/verify-runner.test.ts` drives it with synthetic gate files and
 * asserts the PASS/FAIL/SKIPPED semantics and the exit status.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const options = { gatesFile: join(REPO_ROOT, 'scripts', 'gates.json'), from: null, list: false, root: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--list') {
      options.list = true;
      continue;
    }
    const value = argv[i + 1];
    if (flag === '--gates') {
      options.gatesFile = value;
    } else if (flag === '--from') {
      options.from = value;
    } else if (flag === '--root') {
      options.root = value;
    } else {
      process.stderr.write('verify: unknown argument ' + String(flag) + '\n');
      process.exit(2);
    }
    i += 1;
  }
  return options;
}

/**
 * Is `tool` runnable? `spawnSync` with `shell: false` reports ENOENT for a name
 * PATH cannot resolve, which is the question being asked. Deliberately not
 * `where`/`which`: those are themselves programs that can be absent, and on
 * Windows `where` answers about `cmd.exe`'s view rather than the child's.
 */
function toolIsResolvable(tool) {
  const probe = spawnSync(tool, ['--version'], { stdio: 'ignore', shell: false });
  return probe.error === undefined || probe.error.code !== 'ENOENT';
}

function loadGates(gatesFile) {
  const parsed = JSON.parse(readFileSync(gatesFile, 'utf8'));
  const gates = parsed.gates;
  if (!Array.isArray(gates) || gates.length === 0) {
    throw new Error(gatesFile + ' declares no gates. An empty gate list passes vacuously, so it is refused.');
  }
  // The probe is data rather than a hardcoded path so `verify-covers-ci.test.ts`
  // can assert that the same command CI runs as a step is reachable locally.
  return { gates, tailProbe: parsed.tailProbe ?? 'node scripts/check-rust-tail.mjs' };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { gates, tailProbe } = loadGates(options.gatesFile);

  if (options.list) {
    for (const gate of gates) process.stdout.write(gate.id + '\n');
    process.exit(0);
  }

  let startIndex = 0;
  if (options.from !== null) {
    startIndex = gates.findIndex((gate) => gate.id === options.from);
    if (startIndex < 0) {
      process.stderr.write('verify: no gate named ' + String(options.from) + '\n');
      process.exit(2);
    }
  }

  const runStartMs = Date.now();

  // ----- preflight -------------------------------------------------------
  const needed = [...new Set(gates.slice(startIndex).flatMap((gate) => gate.needs ?? []))].sort();
  const unresolvable = needed.filter((tool) => !toolIsResolvable(tool));
  if (unresolvable.length > 0) {
    process.stderr.write(
      '\nverify: PREFLIGHT FAILED. These gates cannot run because a tool they need\n' +
        'is not on PATH: ' +
        unresolvable.join(', ') +
        '\n\n' +
        'This is reported here rather than as a gate failure because a gate that\n' +
        'cannot start has not been failed, and every gate behind it would be\n' +
        'SKIPPED rather than passed. On this project cargo lives at\n' +
        '  C:\\Users\\User\\.cargo\\bin\\cargo.exe\n' +
        'and is on no shell PATH by default. Prepend it and re-run:\n' +
        '  $env:PATH = "C:\\Users\\User\\.cargo\\bin;$env:PATH"\n\n',
    );
    for (const gate of gates.slice(startIndex)) {
      process.stdout.write('  BLOCKED  ' + gate.id + '\n');
    }
    process.stdout.write('VERIFY_EXIT=2\n');
    process.exit(2);
  }

  // ----- the gates -------------------------------------------------------
  const results = [];
  let stopped = false;

  for (let i = 0; i < gates.length; i += 1) {
    const gate = gates[i];
    if (i < startIndex) {
      results.push({ id: gate.id, status: 'NOT-RUN', code: null, ms: 0 });
      continue;
    }
    if (stopped) {
      results.push({ id: gate.id, status: 'SKIPPED', code: null, ms: 0 });
      continue;
    }

    process.stdout.write('\n=== gate ' + String(i + 1) + '/' + String(gates.length) + ': ' + gate.id + ' — ' + gate.command + '\n');
    const startedAt = Date.now();
    // `shell: true` because `pnpm` is a shim on Windows and the commands are
    // literal lines from `scripts/gates.json` — repository text, never caller
    // input. `stdio: 'inherit'` so nothing is buffered and no pipeline stands
    // between this process and the child's exit status.
    const child = spawnSync(gate.command, {
      cwd: join(options.root, gate.cwd ?? '.'),
      stdio: 'inherit',
      shell: true,
    });
    const ms = Date.now() - startedAt;

    // A signalled child has a null status. Reporting that as 0 is the exact
    // class of mistake this file exists to remove, so it becomes a failure.
    const code = child.error !== undefined ? 1 : (child.status ?? 1);
    const status = code === 0 ? 'PASS' : 'FAIL';
    results.push({ id: gate.id, status, code, ms });
    if (status === 'FAIL') stopped = true;
  }

  // ----- the physical tell ----------------------------------------------
  const tailGate = gates.find((gate) => gate.tail === true);
  let tailVerdict = null;
  if (tailGate !== undefined) {
    const tailResult = results.find((row) => row.id === tailGate.id);
    if (tailResult !== undefined && tailResult.status === 'PASS') {
      process.stdout.write('\n=== physical tell: did the Rust tail actually compile the test targets?\n');
      // Deliberately NOT a shell string with the arguments concatenated on.
      // That version was written first and was wrong in a way the tests caught:
      // building `<probe> --root "<path>" --since <ms>` and handing it to a
      // shell puts the repository root — a path that can contain spaces — inside
      // quotes the shell then has to re-split, and it lets the probe's own
      // argument parser see a command line assembled by string concatenation.
      // Splitting the declared probe into argv and appending the flags as
      // separate elements removes both. `tailProbe` is repository text from
      // gates.json, never caller input, so a naive whitespace split is safe and
      // is what keeps the declared command and the executed command the same
      // thing.
      //
      // `--since runStartMs` is deliberately NOT passed, and this is the second
      // thing the first real run corrected. It was passed at first, and the run
      // came back with every gate green, `cargo test --workspace --locked`
      // exit 0, and all forty test targets reported STALE — because cargo is a
      // build cache and a run that recompiles nothing moves no mtime.
      //
      // WHAT THE PROBE DEMANDS INSTEAD, STATED AS IT IS AND NOT AS IT WAS
      // PLANNED. Nothing about age. Given no `--since` it demands EXISTENCE
      // PER TARGET and prints, on its second line, `age demand: (nothing: no
      // age is demanded ...)`. A replacement rule — every binary at least as
      // new as the newest source in the workspace — was written next and
      // abandoned for producing false reds of its own; the header of
      // `scripts/check-rust-tail.mjs` records both attempts and why an mtime
      // comparison cannot settle a question cargo answers by content
      // fingerprint. So the "last week's binary" hole is closed HERE, by
      // ordering, not there: this block runs only when the `cargo test` gate
      // has just PASSED in this process, and reports `RUST_TAIL=NOT-REACHED`
      // when it has not. The probe answers "did the tail leave its artefacts";
      // the gate answers "did the tail just run"; neither is asked to do the
      // other's job.
      const [head, ...rest] = tailProbe.split(/\s+/u).filter((token) => token !== '');
      const executable = head === 'node' ? process.execPath : head;
      const probe = spawnSync(
        executable,
        [...rest, '--root', options.root],
        { cwd: options.root, stdio: 'inherit', shell: false },
      );
      tailVerdict = (probe.status ?? 1) === 0 ? 'CONFIRMED' : 'NOT-CONFIRMED';
    } else {
      tailVerdict = 'NOT-REACHED';
    }
  }

  // ----- the report ------------------------------------------------------
  process.stdout.write('\n' + '='.repeat(72) + '\n');
  process.stdout.write('GATE                       STATUS    EXIT   SECONDS\n');
  for (const row of results) {
    process.stdout.write(
      row.id.padEnd(26) + ' ' +
        row.status.padEnd(9) + ' ' +
        (row.code === null ? '-' : String(row.code)).padStart(4) + '   ' +
        (row.ms / 1000).toFixed(1).padStart(7) + '\n',
    );
  }
  if (tailVerdict !== null) {
    process.stdout.write('\nRUST_TAIL=' + tailVerdict + '\n');
  }

  const failed = results.filter((row) => row.status === 'FAIL');
  const skipped = results.filter((row) => row.status === 'SKIPPED');
  // NOT-RUN is what `--from` leaves behind, and it is counted here for the same
  // reason SKIPPED is. The first version of this summary counted PASS, FAIL and
  // SKIPPED only, so `--from cargo-test` on the ten-gate list printed
  // "1 passed, 0 failed, 0 SKIPPED" and VERIFY_EXIT=0 over nine gates that were
  // never started. That is exactly the false green this whole runner exists to
  // remove, reintroduced by the resume flag — a status written into `results`
  // and then read by nothing. It is read here, and by `exitCode` below.
  const notRun = results.filter((row) => row.status === 'NOT-RUN');
  process.stdout.write(
    '\n' + String(results.filter((r) => r.status === 'PASS').length) + ' passed, ' +
      String(failed.length) + ' failed, ' +
      String(skipped.length) + ' SKIPPED (skipped is not passed), ' +
      String(notRun.length) + ' NOT-RUN (not-run is not passed either)\n',
  );

  let exitCode = 0;
  if (failed.length > 0) exitCode = failed[0].code;
  else if (tailVerdict === 'NOT-CONFIRMED') exitCode = 1;
  else if (notRun.length > 0) {
    // A distinct code, because this run is not a failure and is not a pass: it
    // is INCOMPLETE, and the one thing it must not be able to do is look like a
    // clean verify in a log. 3 rather than 1 so that a reader (or a CI step)
    // can tell "a gate went red" from "gates were skipped by --from".
    exitCode = 3;
    process.stdout.write(
      '\nINCOMPLETE: ' + String(notRun.length) + ' of ' + String(results.length) +
        ' gates were not run, because --from ' + String(options.from) + ' started at gate ' +
        String(startIndex + 1) + '. Every gate above ran and passed; this run does\n' +
        'not certify the tree, and does not claim to. Re-run without --from for that.\n',
    );
  }

  // Last line of the BODY, on purpose. A wrapper that ends in a reporting
  // command reports the reporting command; the log has to be able to say what
  // happened without the wrapper's help.
  process.stdout.write('VERIFY_EXIT=' + String(exitCode) + '\n');
  process.exit(exitCode);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main();
