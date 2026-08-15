#!/usr/bin/env node
/**
 * Re-runs a vitest gate when the RUNNER crashed, and never when a TEST failed.
 *
 *   node scripts/ci-retry-vitest-crash.mjs pnpm test:harness
 *
 * WHAT THIS IS FOR
 *
 * On Windows, `pnpm test:harness` intermittently dies inside vitest's own worker
 * pool. Measured three times over: 5 crashes in 32 consecutive runs here, 1 in
 * 16 on a second machine, and 9 in 64 on a third — about 14%, load-dependent.
 * It looks like this, and the important part is what is MISSING:
 *
 *     ✓ src/record-transcripts.test.ts (3 tests) 578ms
 *     ⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯
 *     Error: Channel closed
 *      ❯ ProcessWorker.send  …/tinypool@1.1.1/dist/index.js:140:41
 *     Serialized Error: { code: 'ERR_IPC_CHANNEL_CLOSED' }
 *     ELIFECYCLE  Command failed with exit code 1.
 *
 * Across 9 crashes in 64 runs, the number of files that printed a result was
 * 10, 8, 7, 7, 7, 7, 8, 7 and 8 of 12. The ten-of-twelve case happened ONCE; the
 * usual shape is 7-8 reporting and FOUR OR FIVE FILES UNVERIFIED, which beyond
 * the two named next also takes in `no-app-import.test.ts`,
 * `parallel-tool-calls.test.ts` and `record-transcripts.test.ts`. In 9 of 9,
 * `capability-matrix.test.ts` and `server.test.ts` — the two heaviest — were
 * among the silent, and in 9 of 9 there was no `Tests N passed` summary line at
 * all. The run does not fail, it *stops*.
 *
 * WHAT IS KNOWN ABOUT THE CAUSE IS LESS THAN THIS FILE FIRST CLAIMED. It said the
 * pool tears a worker down while the main process still has a message queued for
 * it. That is not established, and five pending files is not a teardown race.
 * What IS established: a worker died mid-run and the parent could not talk to it.
 * A byte-identical signature is produced by `process.kill(pid, 'SIGKILL')` on a
 * worker, so this transcript cannot tell a benign teardown from an OOM kill, a
 * native fatal, or a runner eviction — and neither can the parent.
 *
 * Nor is "upstream defect" safe to assert. The crash comes mid-run under load and
 * the files it eats are consistently the heaviest: `server.test.ts` alone drives
 * 9 MiB and 17 MiB bodies through a real socket. That points at resource pressure
 * inside this repo’s own harness at least as much as at vitest. The honest
 * position is that the trigger is unidentified and may well be ours; this wrapper
 * is a stopgap and should be DELETED once it is found, not kept because it works.
 *
 * That distinction is the whole justification for this file. A crashed run is
 * not a red gate that may be waved through — it is a gate that returned NO
 * VERDICT, and the only thing that can produce one is running it again. So this
 * automates exactly the re-run a maintainer would do by hand, and refuses to do
 * anything else:
 *
 *   - It retries ONLY when the transcript shows the pool crash AND shows no sign
 *     that vitest reached a verdict about the tests. That includes the INLINE
 *     failure markers, not just the end-of-run summary — see
 *     {@link reachedAVerdict}, which was blind to them at first and would
 *     therefore retry a run that had already printed a real regression.
 *   - It retries ONCE. Measured, not modelled: 20 wrapped runs of the real gate,
 *     5 of which crashed, 0 false reds. Do NOT estimate the residue by squaring
 *     the ~14% — the paragraph below calls the crash load-correlated, so the
 *     two attempts are not independent and ~2% would be an optimistic floor
 *     rather than a prediction. A third attempt buys silence, not a verdict.
 *   - Every retry prints a `::warning::` annotation, so the crash rate stays
 *     visible in the CI run summary instead of being quietly absorbed. If those
 *     warnings become common, that is the signal to go and find the trigger,
 *     not to raise the attempt count.
 *
 * WHAT THIS CANNOT PROMISE, STATED PLAINLY. A DETERMINISTIC regression cannot be
 * laundered by this wrapper: exiting 0 requires the second attempt to exit 0 too,
 * and a deterministic failure reproduces there and prints its verdict. The class
 * that remains exposed is NON-DETERMINISTIC failure — a test that fails on the
 * first attempt and passes on the second, while the pool also happens to crash.
 * That class is not hypothetical in this suite: the harness binds real TCP on
 * ephemeral ports, and `server.test.ts` drives 9 MiB and 17 MiB bodies through
 * it. It is not independent of the crash either — both are load-correlated. The
 * inline markers close the case where the failure was PRINTED, in both of the
 * shapes vitest prints it in. What they cannot reach is a failure inside one of
 * the four or five files the crash silenced: those print nothing at all, so no
 * transcript can show it. Only the second attempt can, and only if the failure
 * is deterministic.
 *
 * IF YOU ARE A MAINTAINER LOOKING AT THIS BECAUSE THE STEP WENT RED: it fails now
 * only if both attempts crashed, or if vitest reported a failing test. Search the
 * log for `×`, for a `❯` beside a `.test.ts` name, or for a `Tests` line. If any
 * of the three is there, vitest reported on the suite and the failure is real
 * and is about your change. ONLY IF NONE OF THE THREE IS THERE, and you see
 * `ERR_IPC_CHANNEL_CLOSED` twice, you hit the crash twice in a row and a re-run
 * is legitimate. If that stops being rare, find the trigger; do not raise the
 * attempt count.
 *
 * Deliberately NOT applied to `pnpm verify` or to the Linux job. Locally a human
 * sees the crash and re-runs; `verify` must not acquire retry semantics, because
 * a gate that re-runs itself on a developer's machine is how a genuinely flaky
 * test gets normalised. This is a CI-runner concern and it stays in CI.
 */

import { spawn } from 'node:child_process';

const MAX_ATTEMPTS = 2;

/**
 * vitest colours its output; match against text with the SGR escapes removed.
 *
 * The ESC is written as the escape `\u001B` and never as the raw byte: a
 * literal control character in source is invisible in a diff and does not
 * survive every editor and patch tool between here and the build.
 * `src/platform/control-characters.test.ts` enforces that, and caught this very
 * line the first time it was written.
 */
function plain(text) {
  return text.replace(/\u001B\[[0-9;]*m/gu, '');
}

/**
 * The parent could not talk to a worker. `ERR_IPC_CHANNEL_CLOSED` is what node
 * raises for a send on a dead IPC channel, and tinypool's frame is what places
 * it in the test runner rather than in a child process the harness spawned
 * itself (`cli.test.ts` and the Rust matrix tests both fork real processes).
 *
 * This says the worker is GONE. It does not say why, and it cannot: the same
 * bytes come out of a SIGKILL delivered to a worker by hand. Do not read a
 * benign teardown into it.
 */
function isRunnerCrash(transcript) {
  return (
    transcript.includes('ERR_IPC_CHANNEL_CLOSED') &&
    /tinypool.*ProcessWorker\.send|ProcessWorker\.send.*tinypool/su.test(transcript)
  );
}

/**
 * Any sign that vitest reached a verdict about the tests THEMSELVES. If it did,
 * the run is authoritative and must be reported exactly as it came, crash or no
 * crash: a pool that falls over on top of a real failure must not erase it.
 *
 * THE FIRST VERSION OF THIS FUNCTION LOOKED ONLY AT THE END-OF-RUN FLUSH, and
 * that made it blind in precisely the window it exists to police. vitest prints
 * a failure inline, the moment the file finishes, and prints `Tests N passed`,
 * `Failed Tests N` and `FAIL ` only in the summary at the very end. A crash of
 * the kind this wrapper retries is DEFINED by killing the run before that
 * summary — so a genuine regression that had already been printed was invisible
 * here, the run was retried, and a clean second attempt exited 0 with an
 * annotation claiming the failure was "not a result about this commit". That is
 * the worst thing this file could do, and it was reproduced from real vitest
 * bytes rather than a synthetic transcript.
 *
 * So the inline markers are what actually matter. Two of them, because vitest
 * has two shapes of failure and they do not look alike. A failing TEST:
 *
 *     ❯ t/a-fast-fail.test.ts (2 tests | 1 failed) 10ms
 *       × a genuinely failing test 8ms
 *
 * A failing SUITE — a `beforeAll`/`beforeEach` hook that throws — renders with no
 * `×` anywhere, and its module line counts the tests it never got to as
 * SKIPPED, so `| N failed` never appears either:
 *
 *     ❯ t/a-beforeall.test.ts (1 test | 1 skipped) 3ms
 *       ↓ never runs because the suite failed
 *
 * The only thing common to both is the `❯` pointer on the module line, which
 * vitest uses for a file that did not come out clean. Hence the third pattern.
 * It is deliberately loose: a stack frame naming a test file is also evidence
 * that a failure was reported, and erring towards "a verdict was reached" fails
 * CLOSED — it costs a retry, never a laundered regression. Checked against 99
 * captured transcripts of this suite (19 of them crashed): it fires on none of
 * them, so the retry is not lost in the benign case.
 *
 * The end-of-run patterns are kept too: they cost nothing and they cover a run
 * that dies after the flush has begun.
 */
function reachedAVerdict(transcript) {
  return (
    // Inline, printed as each file finishes. These are the load-bearing ones.
    /^\s*\u00D7\s/mu.test(transcript) ||
    /\(\d+ tests?[^)]*\|\s*\d+ failed\)/u.test(transcript) ||
    /^\s*\u276F\s.*\.test\.tsx?/mu.test(transcript) ||
    // End-of-run summary.
    /^\s*Tests\s+\d+/mu.test(transcript) ||
    /Failed Tests\s+\d+/u.test(transcript) ||
    /^\s*FAIL\s/mu.test(transcript)
  );
}

function runOnce(command, args) {
  return new Promise((resolve) => {
    // `shell: true` because the command is a pnpm script and pnpm is a shim on
    // Windows. The arguments are literal text from `.github/workflows/ci.yml`,
    // never anything a caller supplies.
    const child = spawn(command, args, { shell: true });
    let transcript = '';

    const tee = (chunk, sink) => {
      transcript += chunk.toString();
      sink.write(chunk);
    };
    child.stdout.on('data', (chunk) => {
      tee(chunk, process.stdout);
    });
    child.stderr.on('data', (chunk) => {
      tee(chunk, process.stderr);
    });

    child.on('error', (error) => {
      process.stderr.write(`ci-retry: could not start ${command}: ${error.message}\n`);
      resolve({ code: 1, transcript });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, transcript: plain(transcript) });
    });
  });
}

const [command, ...args] = process.argv.slice(2);

if (command === undefined) {
  process.stderr.write('usage: node scripts/ci-retry-vitest-crash.mjs <command> [args...]\n');
  process.exit(2);
}

let last = { code: 1, transcript: '' };

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  last = await runOnce(command, args);

  if (last.code === 0) process.exit(0);

  const crashed = isRunnerCrash(last.transcript) && !reachedAVerdict(last.transcript);
  if (!crashed) {
    // A real failure, or a failure this wrapper does not recognise. Either way
    // it belongs to the change under test, not to the pool.
    process.exit(last.code);
  }

  if (attempt < MAX_ATTEMPTS) {
    // This string is the ONLY part of this file most people will ever read, so
    // it must not claim more than the file itself does. It used to end "This is
    // an upstream vitest defect, not a result about this commit" while the
    // header two screens up said `upstream defect` is not safe to assert. Both
    // halves were unfounded: the trigger is unidentified and may be pressure
    // from this repo's own harness, in which case a commit that makes the
    // harness heavier IS implicated. Say what is known and stop.
    process.stdout.write(
      `::warning title=vitest worker died; re-running for a verdict::` +
        `Attempt ${String(attempt)} of ${String(MAX_ATTEMPTS)} lost a test worker ` +
        `(ERR_IPC_CHANNEL_CLOSED inside tinypool) and printed no test summary, so ` +
        `it reached no verdict on the suite. Re-running to get one. The cause is ` +
        `not identified: it may be the runner, and it may be load from this ` +
        `suite. See scripts/ci-retry-vitest-crash.mjs.\n`,
    );
  }
}

process.stderr.write(
  `\nci-retry: ${String(MAX_ATTEMPTS)} attempts, every one of them killed by the ` +
    `vitest worker-pool crash (ERR_IPC_CHANNEL_CLOSED) before any test summary ` +
    `was printed. No verdict was produced, so this is reported as a failure ` +
    `rather than guessed at. Re-run the job. If it happens a third time, the ` +
    `crash has stopped being rare and the trigger needs finding rather than ` +
    `retrying; it is not established whose it is. See the header of this file.\n`,
);
process.exit(last.code);
