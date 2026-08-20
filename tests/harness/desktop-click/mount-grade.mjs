/**
 * The one predicate that decides whether a renderer mounted, and the loop that
 * waits for it.
 *
 * ## What was wrong, in the bytes
 *
 * `commands.up` in `vela-drive.mjs` used to spin on a single word:
 *
 *     const settleDeadline = Date.now() + 15_000;
 *     let readyState = null;
 *     while (Date.now() < settleDeadline) {
 *       await cdp.evaluate(BOOTSTRAP);
 *       readyState = await cdp.evaluate('document.readyState');
 *       if (readyState === 'complete') break;
 *       await sleep(250);
 *     }
 *
 * and then returned `{ session, build, version, target, ownership, mount,
 * appDataWarning }`. Three separate defects sat in those nine lines:
 *
 * 1. **`readyState` was never returned.** Whether the loop exited on its
 *    condition or on its deadline was unrecoverable from the transcript, so
 *    "it gave up" and "it succeeded immediately" printed identically.
 * 2. **Nothing composed the two halves.** `up`'s exit code was decided solely
 *    by "did the handler throw". It printed a mount report it did not read, so
 *    `up` exited 0 while the report beside it said `rootChildElements: 0`.
 * 3. **`document.readyState === 'complete'` is not a question about Vela.** It
 *    is a question about one word in whatever document the CDP session happens
 *    to be attached to. On this stack `complete` arrives *faster* when the
 *    bundle 404s than when it loads, and `about:blank` is `complete` from the
 *    first sample forever — so waiting longer, or reporting that we gave up
 *    waiting, changes nothing in any of the three ways this instrument was
 *    shown to lie.
 *
 * `commands.mount`'s own verdict was
 * `report.rootPresent && report.rootDescendants > 0 && report.bodyTextChars > 0`
 * — a node-count question. Nothing in it asks **who put the nodes there**, so a
 * static `<div id="root"><p>Starting Vela...</p></div>` served with an empty
 * `<script>` graded as "the renderer mounted". `mountReport()` in `page.mjs`
 * already computed `reactContainerKeyOnRoot` and `hasTauriInternals` in the
 * same object and **nothing anywhere read either of them**.
 *
 * ## What this file does instead
 *
 * The verdict is a composition of named criteria, every one of which must hold,
 * and each of which is reported with the evidence that decided it. Three of
 * them are provenance questions rather than presence questions:
 *
 * - **which document** — the CDP target was accepted because it had navigated,
 *   not because `waitForEndpoint`'s last-resort branch admitted an
 *   `about:blank` near its deadline;
 * - **whose document** — `window.__TAURI_INTERNALS__` is an object, so this is
 *   a Tauri main frame and not a page that merely looks like one;
 * - **who rendered it** — `#root` carries a React root-container key, so the
 *   nodes in it were put there by a React renderer that ran, not by markup.
 *
 * ## The next-level defect this fix carries, stated rather than hidden
 *
 * `renderer-provenance` proves *a* React renderer attached to `#root`. It does
 * **not** prove the intended screen rendered. A React error boundary showing a
 * fallback, or a shell that mounted before its data arrived, passes every
 * criterion here and is a true "the renderer mounted" and a false "Vela's UI is
 * up". `grade.entails` says so in the returned object so no caller can quote
 * the verdict as more than it is, and `firstRootChild` is reported so a reader
 * can see *what* mounted. Closing that gap needs an assertion about specific
 * app content, which belongs to the track making the claim and not to the
 * instrument.
 *
 * And `reactContainerKeyOnRoot` reads a React internal. React 19.2.8 in this
 * tree sets `internalContainerInstanceKey = "__reactContainer$" + randomKey` on
 * the container node. That is read out of the installed react-dom package,
 * which is outside this tree. A future React could rename it, and this grade
 * would then go red on a working app. That is a false red, which is the direction this project can afford —
 * and `criteria` names the one criterion that failed, so it is a legible one.
 */

/** No colour value is defined, read or written anywhere in this file. */

/**
 * `context` is what the host knows that the page cannot report about itself.
 *
 * @typedef {object} MountContext
 * @property {string|null} acceptedBecause  how `waitForEndpoint` came to pick
 *   this target: `'navigated'` or `'blank-fallback-at-deadline'`. `null` when
 *   the caller attached to an existing session and never ran the picker.
 * @property {string|null} targetUrl  the URL the CDP target list reported.
 */

/**
 * The criteria, in the order they are reported. Each `test` returns a boolean
 * and each `evidence` returns the values that decided it — so a failure names
 * itself and carries its own proof, and no criterion can pass on a field that
 * is not shown.
 *
 * Ordered cheapest-question-first only for readability; every one is evaluated
 * every time, because "which one failed" is the useful answer and short-circuit
 * evaluation would throw it away.
 */
export const MOUNT_CRITERIA = [
  {
    name: 'target-provenance',
    question: 'was this CDP target picked because it had navigated, or admitted as a blank fallback?',
    test: (report, context) =>
      context.acceptedBecause === null || context.acceptedBecause === 'navigated',
    evidence: (report, context) => ({
      acceptedBecause: context.acceptedBecause,
      targetUrl: context.targetUrl,
      note:
        'waitForEndpoint accepts an about:blank page target once the deadline is within 3s. ' +
        'about:blank reports readyState "complete" on the first sample forever, so every ' +
        'readiness wait over that target is vacuous. null means no picker ran (an attach to a ' +
        'recorded session), which this criterion does not fail on — the document criteria below ' +
        'still apply.',
    }),
  },
  {
    name: 'document-identity',
    question: 'is the document under measurement a real navigated document?',
    test: (report) =>
      typeof report.href === 'string' &&
      report.href.length > 0 &&
      report.href !== 'about:blank' &&
      !report.href.startsWith('chrome-error://') &&
      !report.href.startsWith('about:'),
    evidence: (report) => ({ href: report.href ?? null }),
  },
  {
    name: 'tauri-host',
    question: 'is this a Tauri main frame — the application window — at all?',
    // tauri 2.11.5 (pinned in src-tauri/Cargo.lock) pushes an unconditional
    // main-frame initialization script that defines both `window.isTauri` and
    // `window.__TAURI_INTERNALS__`. Read out of the crate source, which is
    // outside this tree: src/manager/webview.rs, in the function that prepares
    // a webview, with no conditional around the push. The withGlobalTauri
    // false in tauri.conf.json suppresses `window.__TAURI__`, which is a
    // different object and is not consulted here.
    //
    // This is the field that closes RULE U on `hasTauriInternals`: it was
    // computed by `mountReport()` at the tag and read by nothing.
    test: (report) => report.hasTauriInternals === true,
    evidence: (report) => ({
      hasTauriInternals: report.hasTauriInternals ?? null,
      // Read, not merely written: a disagreement between the two markers from
      // the same init script means the script ran partially, and `notes` below
      // surfaces it. The criterion does not gate on `isTauri`, because it is
      // the younger of the two markers and a Tauri downgrade would turn a
      // working app red for the wrong reason.
      isTauri: report.isTauri ?? null,
    }),
  },
  {
    name: 'renderer-provenance',
    question: 'did a React renderer put the contents of #root there?',
    test: (report) =>
      Array.isArray(report.reactContainerKeyOnRoot) && report.reactContainerKeyOnRoot.length > 0,
    evidence: (report) => ({
      reactContainerKeyOnRoot: report.reactContainerKeyOnRoot ?? null,
      scriptSources: report.scriptSources ?? null,
      note:
        'A node count is not provenance. A pre-rendered splash, an error page, or a ' +
        'document.write produces descendants and text with no renderer behind them; only the ' +
        'root-container key React writes onto the container element does not.',
    }),
  },
  {
    name: 'root-present',
    question: 'is there a #root element to mount into?',
    test: (report) => report.rootPresent === true,
    evidence: (report) => ({ rootPresent: report.rootPresent ?? null }),
  },
  {
    name: 'root-populated',
    question: 'did anything end up inside #root?',
    test: (report) => Number(report.rootDescendants) > 0,
    evidence: (report) => ({
      rootDescendants: report.rootDescendants ?? null,
      // The field the audit and the task statement both quote as evidence, and
      // which the pre-fix predicate did not read. Reported beside the one the
      // grade uses so the two can never again be confused for each other.
      rootChildElements: report.rootChildElements ?? null,
      firstRootChild: report.firstRootChild ?? null,
    }),
  },
  {
    name: 'visible-text',
    question: 'does the window show any text?',
    test: (report) => Number(report.bodyTextChars) > 0,
    evidence: (report) => ({
      bodyTextChars: report.bodyTextChars ?? null,
      bodyTextHead: report.bodyTextHead ?? null,
    }),
  },
];

/**
 * Grades one `mountReport()` against every criterion.
 *
 * Returns the same shape whether it passes or fails, so a caller never has to
 * branch on presence to find out why.
 */
export function gradeMount(report, context = {}) {
  const resolved = {
    acceptedBecause: context.acceptedBecause ?? null,
    targetUrl: context.targetUrl ?? null,
  };
  if (report === null || report === undefined || typeof report !== 'object') {
    return {
      mounted: false,
      failed: ['no-report'],
      criteria: [
        {
          name: 'no-report',
          question: 'did the page answer mountReport() at all?',
          pass: false,
          evidence: { report: report ?? null },
        },
      ],
      notes: ['mountReport() returned nothing; the page-side bootstrap did not run.'],
      entails: ENTAILS,
      verdict: 'THE RENDERER DID NOT MOUNT: the page did not answer mountReport() at all',
    };
  }

  const criteria = MOUNT_CRITERIA.map((criterion) => ({
    name: criterion.name,
    question: criterion.question,
    pass: Boolean(criterion.test(report, resolved)),
    evidence: criterion.evidence(report, resolved),
  }));
  const failed = criteria.filter((c) => !c.pass).map((c) => c.name);
  const mounted = failed.length === 0;

  const notes = [];
  if (report.hasTauriInternals === true && report.isTauri === false) {
    notes.push(
      'window.__TAURI_INTERNALS__ is an object but window.isTauri is false. Both come from the ' +
        'same Tauri main-frame init script, so they should agree; a disagreement means the ' +
        'script ran partially or something else defined the object.',
    );
  }
  if (!mounted && report.rootDescendants > 0 && report.bodyTextChars > 0) {
    notes.push(
      'The pre-fix predicate (rootPresent && rootDescendants > 0 && bodyTextChars > 0) would ' +
        'have called this a mount. It fails here on ' +
        `${failed.join(', ')}.`,
    );
  }

  return {
    mounted,
    failed,
    criteria,
    notes,
    entails: ENTAILS,
    verdict: mounted
      ? 'the renderer mounted: a React root is attached to #root in a Tauri main frame, and the window shows text'
      : `THE RENDERER DID NOT MOUNT: ${failed.join(', ')} — see criteria for the evidence that decided each`,
  };
}

/**
 * What a `mounted: true` does and does not license. Carried in every grade so
 * the sentence cannot be quoted without it.
 */
const ENTAILS = {
  does:
    'a React renderer ran in a Tauri main frame and owns #root, and the window shows text. ' +
    'The document is a navigated one, not about:blank, and the CDP target was not admitted by ' +
    "the picker's blank fallback.",
  doesNot:
    'that the intended screen rendered. An error-boundary fallback, or a shell mounted before ' +
    'its data arrived, satisfies every criterion. Assert on specific application content to ' +
    'claim more than "a renderer mounted".',
};

/**
 * Polls until the grade passes, or until the deadline — and **says which**.
 *
 * This is the change that makes the give-up branch reachable. Waiting on
 * `readyState === 'complete'` could not fail on any of the three constructions
 * that fooled this instrument, because all three reach `complete` on the first
 * sample; the loop iterated zero times and the deadline branch was dead code.
 * Waiting on the grade instead means the deadline branch is what fires on
 * exactly those three, and it fires carrying the full report and the named
 * failing criteria.
 *
 * **Absence stays a reported answer, not a timeout.** The original loop
 * deliberately did not wait for `#root` to have children so that "the renderer
 * did not mount" could be reported rather than thrown. That property is kept:
 * on deadline this resolves normally with `exitedBy: 'deadline'`, the last
 * report, and the grade. Deciding what to do about it is the caller's.
 *
 * Dependencies are injected so this is testable without a browser: `evaluate`
 * is `cdp.evaluate`, `sleep` and `now` are the clock.
 *
 * @returns {Promise<{report: object|null, grade: object, readyStateAtExit: string|null,
 *   exitedBy: 'condition'|'deadline', polls: number, waitedMs: number, timeoutMs: number,
 *   pollMs: number, gradeHistory: string[][]}>}
 */
export async function waitForRenderer({
  evaluate,
  bootstrap,
  context = {},
  timeoutMs = 15_000,
  pollMs = 250,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}) {
  const started = now();
  const deadline = started + timeoutMs;
  let report = null;
  let grade = gradeMount(null, context);
  let polls = 0;
  // Every distinct set of failing criteria seen, in order. A mount that goes
  // `root-populated` → passing looks different from one that never moved, and
  // the difference is the whole content of "was it latency?".
  const gradeHistory = [];

  for (;;) {
    polls++;
    if (bootstrap !== undefined) await evaluate(bootstrap);
    report = await evaluate('window.__velaHarness.mountReport()');
    grade = gradeMount(report, context);
    const signature = grade.mounted ? [] : grade.failed;
    const last = gradeHistory[gradeHistory.length - 1];
    if (last === undefined || last.join(',') !== signature.join(',')) gradeHistory.push(signature);
    if (grade.mounted) {
      return {
        report,
        grade,
        readyStateAtExit: report?.readyState ?? null,
        exitedBy: 'condition',
        polls,
        waitedMs: now() - started,
        timeoutMs,
        pollMs,
        gradeHistory,
      };
    }
    if (now() + pollMs >= deadline) break;
    await sleep(pollMs);
  }

  return {
    report,
    grade,
    readyStateAtExit: report?.readyState ?? null,
    exitedBy: 'deadline',
    polls,
    waitedMs: now() - started,
    timeoutMs,
    pollMs,
    gradeHistory,
  };
}

/**
 * The sentence `up` prints about its own wait. Separate from the grade because
 * "we stopped waiting" and "what we saw" are different facts, and the pre-fix
 * `up` reported neither.
 */
export function describeWait(readiness) {
  if (readiness.exitedBy === 'condition') {
    return (
      `the renderer graded as mounted after ${readiness.polls} poll(s) in ${readiness.waitedMs}ms ` +
      `(readyState "${readiness.readyStateAtExit}")`
    );
  }
  return (
    `GAVE UP WAITING after ${readiness.polls} poll(s) over ${readiness.waitedMs}ms of a ` +
    `${readiness.timeoutMs}ms budget. readyState at exit was "${readiness.readyStateAtExit}". ` +
    `Still failing: ${readiness.grade.failed.join(', ') || '(nothing — this is a bug in the loop)'}. ` +
    'Note that readyState reaching "complete" is not evidence of anything here: about:blank and a ' +
    'document whose module bundle 404s both reach it immediately and stay there.'
  );
}
