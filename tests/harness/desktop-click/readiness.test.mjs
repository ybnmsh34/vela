/**
 * The three ways this harness reported a mount that never happened.
 *
 * A probe agent constructed all three against the pre-fix bytes and ran them
 * over real CDP against a real Chromium. In every one, `up` exited 0 with
 * `ok: true` while the mount report printed beside it said the renderer was not
 * there — and in every one `document.readyState` was already `"complete"` at
 * the first sample, so the guard's wait iterated zero times and its give-up
 * branch was unreachable. The three `mountFields` objects below are the
 * probe's, transcribed field for field, so these tests fail against the exact
 * observations that were recorded and not against a paraphrase of them.
 *
 * Each case carries a control showing the detector is not vacuous.
 *
 * The DOM half runs `page.mjs`'s real bootstrap source in a bare jsdom window,
 * so `mountReport()` is the shipping function and not a stand-in.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { BOOTSTRAP } from './page.mjs';
import { MOUNT_CRITERIA, describeWait, gradeMount, waitForRenderer } from './mount-grade.mjs';
import { isBlankTarget, pickPage, waitForEndpoint } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * E1 — the substitute document. `waitForEndpoint`'s last-resort branch accepts
 * an `about:blank` page target once the deadline is within 3s, and said nothing
 * about having done so. `about:blank` is `readyState: "complete"` from the
 * first sample and forever, so the documented wait is vacuous over it.
 */
const E1_ABOUT_BLANK = {
  href: 'about:blank',
  title: '',
  readyState: 'complete',
  rootPresent: false,
  rootChildElements: 0,
  rootDescendants: 0,
  bodyTextChars: 0,
  bodyTextHead: '',
  reactContainerKeyOnRoot: [],
  hasTauriInternals: false,
  scriptSources: [],
};

/**
 * E2 — `complete` without a renderer, permanently. Vela's own `index.html`
 * shape with the module bundle returning 404: the document still fires `load`,
 * `readyState` goes `complete` in about 50ms and stays there for the life of
 * the window, and `#root` is present and empty forever. There is nothing left
 * to wait for, so neither waiting longer nor reporting that we gave up waiting
 * can reach this case — which is why the loop now waits on the grade.
 */
const E2_BROKEN_BUNDLE = {
  href: 'http://127.0.0.1:60579/broken.html',
  title: 'Vela',
  readyState: 'complete',
  rootPresent: true,
  rootChildElements: 0,
  rootDescendants: 0,
  bodyTextChars: 0,
  bodyTextHead: '',
  reactContainerKeyOnRoot: [],
  hasTauriInternals: false,
  scriptSources: ['/assets/index-deadbeef.js'],
};

/**
 * E3 — node count is not provenance. The page ran zero lines of JavaScript and
 * the pre-fix predicate printed "the renderer mounted" about it. This is the
 * dangerous direction: E1 and E2 at least print a report a human could read,
 * whereas here the harness's own sentence is wrong.
 */
const E3_STATIC_SPLASH = {
  href: 'http://127.0.0.1:65205/skeleton.html',
  title: 'Vela',
  readyState: 'complete',
  rootPresent: true,
  rootChildElements: 1,
  rootDescendants: 2,
  bodyTextChars: 16,
  bodyTextHead: 'Starting Vela...',
  reactContainerKeyOnRoot: [],
  hasTauriInternals: false,
  scriptSources: [],
};

/** What a real mount looks like: every criterion satisfied. */
const MOUNTED = {
  href: 'http://tauri.localhost/index.html',
  title: 'Vela',
  readyState: 'complete',
  rootPresent: true,
  rootChildElements: 1,
  rootDescendants: 84,
  bodyTextChars: 512,
  bodyTextHead: 'Conversations New chat',
  reactContainerKeyOnRoot: ['__reactContainer$8f3ka1'],
  hasTauriInternals: true,
  isTauri: true,
  firstRootChild: { tag: 'DIV', id: null, className: 'app-shell' },
  scriptSources: ['/assets/index-a1b2c3.js'],
};

/** The predicate `commands.mount` used at the tag, lifted verbatim. */
const preFixPredicate = (report) =>
  report.rootPresent && report.rootDescendants > 0 && report.bodyTextChars > 0;

const NAVIGATED = { acceptedBecause: 'navigated', targetUrl: MOUNTED.href };

describe('the mount grade asks a provenance question, not a node-count question', () => {
  it('CONTROL: a real mount passes every criterion', () => {
    const grade = gradeMount(MOUNTED, NAVIGATED);
    expect(grade.failed).toEqual([]);
    expect(grade.mounted).toBe(true);
    expect(grade.verdict).toContain('the renderer mounted');
  });

  it('CONTROL: every criterion is decidable — each one can be made to fail on its own', () => {
    // Without this, a criterion that is always true would look like a passing
    // guard. Each mutation breaks exactly one field and must fail exactly the
    // criterion that reads it.
    const breakOne = {
      'target-provenance': [MOUNTED, { ...NAVIGATED, acceptedBecause: 'blank-fallback-at-deadline' }],
      'document-identity': [{ ...MOUNTED, href: 'about:blank' }, NAVIGATED],
      'tauri-host': [{ ...MOUNTED, hasTauriInternals: false }, NAVIGATED],
      'renderer-provenance': [{ ...MOUNTED, reactContainerKeyOnRoot: [] }, NAVIGATED],
      'root-present': [{ ...MOUNTED, rootPresent: false }, NAVIGATED],
      'root-populated': [{ ...MOUNTED, rootDescendants: 0 }, NAVIGATED],
      'visible-text': [{ ...MOUNTED, bodyTextChars: 0 }, NAVIGATED],
    };
    expect(Object.keys(breakOne).sort()).toEqual(MOUNT_CRITERIA.map((c) => c.name).sort());
    for (const [name, [report, context]] of Object.entries(breakOne)) {
      expect(gradeMount(report, context).failed, `breaking ${name}`).toEqual([name]);
    }
  });

  it('E1: refuses the about:blank the target picker admitted as a fallback', () => {
    const grade = gradeMount(E1_ABOUT_BLANK, {
      acceptedBecause: 'blank-fallback-at-deadline',
      targetUrl: 'about:blank',
    });
    expect(grade.mounted).toBe(false);
    expect(grade.failed).toContain('target-provenance');
    expect(grade.failed).toContain('document-identity');
  });

  it('E1: refuses it on the document alone, even when the picker is not consulted', () => {
    // `mount` and `status` attach to a recorded session and never run the
    // picker, so `acceptedBecause` is null there. The document criteria must
    // carry the case on their own.
    const grade = gradeMount(E1_ABOUT_BLANK, { acceptedBecause: null, targetUrl: 'about:blank' });
    expect(grade.mounted).toBe(false);
    expect(grade.failed).not.toContain('target-provenance');
    expect(grade.failed).toContain('document-identity');
  });

  it('E2: refuses a document whose bundle 404d, which reaches "complete" faster than a working one', () => {
    const grade = gradeMount(E2_BROKEN_BUNDLE, {
      acceptedBecause: 'navigated',
      targetUrl: E2_BROKEN_BUNDLE.href,
    });
    expect(grade.mounted).toBe(false);
    expect(grade.failed).toContain('renderer-provenance');
    // The report says readyState is already `complete`: the pre-fix wait was
    // satisfied, which is exactly why waiting harder cannot reach this case.
    expect(E2_BROKEN_BUNDLE.readyState).toBe('complete');
  });

  it('E3: refuses a static splash — the case the pre-fix predicate called a mount', () => {
    const context = { acceptedBecause: 'navigated', targetUrl: E3_STATIC_SPLASH.href };
    // The predicate at the tag said yes. That is the whole defect.
    expect(preFixPredicate(E3_STATIC_SPLASH)).toBe(true);
    const grade = gradeMount(E3_STATIC_SPLASH, context);
    expect(grade.mounted).toBe(false);
    expect(grade.failed).toEqual(['tauri-host', 'renderer-provenance']);
    expect(grade.verdict).toContain('THE RENDERER DID NOT MOUNT');
    // And it says so out loud rather than leaving a reader to notice.
    expect(grade.notes.join(' ')).toContain('The pre-fix predicate');
  });

  it('reads reactContainerKeyOnRoot and hasTauriInternals — both had no reader at the tag', () => {
    // RULE U. `grep -rn 'reactContainerKeyOnRoot|hasTauriInternals'` over the
    // tag hit only their own definitions in page.mjs. The evidence of a reader
    // is that changing the field changes the verdict.
    expect(gradeMount({ ...MOUNTED, reactContainerKeyOnRoot: [] }, NAVIGATED).mounted).toBe(false);
    expect(gradeMount({ ...MOUNTED, hasTauriInternals: false }, NAVIGATED).mounted).toBe(false);
    // ...and each one's evidence is carried into the verdict object, not left
    // beside it in an unrelated field.
    const criteria = Object.fromEntries(
      gradeMount(MOUNTED, NAVIGATED).criteria.map((c) => [c.name, c.evidence]),
    );
    expect(criteria['renderer-provenance'].reactContainerKeyOnRoot).toEqual(['__reactContainer$8f3ka1']);
    expect(criteria['tauri-host'].hasTauriInternals).toBe(true);
  });

  it('says what a pass does NOT entail, so the sentence cannot be over-quoted', () => {
    // The next-level defect this fix carries: "a React renderer mounted" is not
    // "the intended screen rendered". An error-boundary fallback passes.
    const errorBoundary = {
      ...MOUNTED,
      rootDescendants: 3,
      bodyTextChars: 31,
      bodyTextHead: 'Something went wrong. Reload.',
      firstRootChild: { tag: 'DIV', id: null, className: 'error-boundary' },
    };
    const grade = gradeMount(errorBoundary, NAVIGATED);
    expect(grade.mounted).toBe(true);
    expect(grade.entails.doesNot).toContain('the intended screen rendered');
    // And a reader can see WHAT mounted, not only how much.
    const populated = grade.criteria.find((c) => c.name === 'root-populated');
    expect(populated.evidence.firstRootChild).toEqual({
      tag: 'DIV',
      id: null,
      className: 'error-boundary',
    });
  });

  it('reports the two Tauri markers disagreeing instead of silently ignoring one', () => {
    const grade = gradeMount({ ...MOUNTED, isTauri: false }, NAVIGATED);
    expect(grade.notes.join(' ')).toContain('window.isTauri is false');
  });

  it('answers rather than throws when the page reports nothing at all', () => {
    const grade = gradeMount(null, NAVIGATED);
    expect(grade.mounted).toBe(false);
    expect(grade.failed).toEqual(['no-report']);
  });
});

describe('the readiness loop exits by condition or by deadline, and says which', () => {
  /**
   * A fake `evaluate` that returns a scripted sequence of mount reports. The
   * bootstrap evaluation is answered too, because `waitForRenderer` runs it on
   * every poll exactly as `commands.up` did.
   */
  function evaluator(reports) {
    let index = 0;
    return async (expression) => {
      if (!String(expression).includes('mountReport')) return 'bootstrap-ok';
      const report = reports[Math.min(index, reports.length - 1)];
      index++;
      return report;
    };
  }

  /** A clock that advances only when the loop sleeps, so tests are instant. */
  function fakeClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms) => { t += ms; } };
  }

  it('exits by condition, reporting the poll it exited on', async () => {
    const clock = fakeClock();
    const result = await waitForRenderer({
      evaluate: evaluator([E2_BROKEN_BUNDLE, E2_BROKEN_BUNDLE, MOUNTED]),
      bootstrap: 'BOOTSTRAP',
      context: NAVIGATED,
      timeoutMs: 15_000,
      ...clock,
    });
    expect(result.exitedBy).toBe('condition');
    expect(result.polls).toBe(3);
    expect(result.grade.mounted).toBe(true);
    // The genuine cold-start case: the failure set changed over time. One entry
    // would mean nothing ever moved.
    expect(result.gradeHistory.length).toBeGreaterThan(1);
  });

  it('E1/E2/E3: exits by DEADLINE and says so — the branch that was unreachable before', async () => {
    // This is the assertion the pre-fix guard could not have passed. All three
    // constructions report readyState "complete", so a loop waiting on that
    // word broke on poll #1 having waited 0ms and never reached its give-up
    // branch at all. Waiting on the grade makes the branch fire.
    for (const [name, report] of [
      ['E1', E1_ABOUT_BLANK],
      ['E2', E2_BROKEN_BUNDLE],
      ['E3', E3_STATIC_SPLASH],
    ]) {
      const clock = fakeClock();
      const result = await waitForRenderer({
        evaluate: evaluator([report]),
        bootstrap: 'BOOTSTRAP',
        context: NAVIGATED,
        timeoutMs: 2000,
        pollMs: 250,
        ...clock,
      });
      expect(result.readyStateAtExit, name).toBe('complete');
      expect(result.exitedBy, name).toBe('deadline');
      expect(result.polls, name).toBeGreaterThan(1);
      expect(result.waitedMs, name).toBeGreaterThan(0);
      expect(result.grade.mounted, name).toBe(false);
      // Nothing ever changed: one entry in the history is the shape of "this is
      // not latency", which is what the audit's cold-start diagnosis assumed.
      expect(result.gradeHistory.length, name).toBe(1);
      expect(describeWait(result), name).toContain('GAVE UP WAITING');
      expect(describeWait(result), name).toContain('readyState at exit was "complete"');
    }
  });

  it('the wait summary never claims success on a deadline exit', async () => {
    const clock = fakeClock();
    const result = await waitForRenderer({
      evaluate: evaluator([E3_STATIC_SPLASH]),
      bootstrap: 'BOOTSTRAP',
      context: NAVIGATED,
      timeoutMs: 1000,
      ...clock,
    });
    expect(describeWait(result)).not.toContain('graded as mounted');
    expect(result.readyStateAtExit).not.toBeNull();
  });

  it('CONTROL: readyState alone would have passed all three', async () => {
    // The narrow question the pre-fix guard asked, run over the same reports.
    // It answers yes every time, on the first sample, for all three.
    for (const report of [E1_ABOUT_BLANK, E2_BROKEN_BUNDLE, E3_STATIC_SPLASH]) {
      expect(report.readyState === 'complete').toBe(true);
    }
  });
});

describe('the target picker says how it came to pick a target', () => {
  it('classifies a blank target as blank', () => {
    expect(isBlankTarget({ url: 'about:blank' })).toBe(true);
    expect(isBlankTarget({ url: '' })).toBe(true);
    expect(isBlankTarget(undefined)).toBe(true);
    expect(isBlankTarget({ url: 'http://tauri.localhost/index.html' })).toBe(false);
  });

  it('still prefers a navigated page target over a blank one', () => {
    const targets = [
      { type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://a' },
      { type: 'page', url: 'http://tauri.localhost/', webSocketDebuggerUrl: 'ws://b' },
    ];
    expect(pickPage(targets).url).toBe('http://tauri.localhost/');
  });

  it('reports acceptedBecause "navigated" when the target had navigated', async () => {
    const endpoint = await withFetch(
      [{ type: 'page', url: 'http://tauri.localhost/', webSocketDebuggerUrl: 'ws://b' }],
      () => waitForEndpoint(9999, { timeoutMs: 5000 }),
    );
    expect(endpoint.acceptedBecause).toBe('navigated');
    expect(gradeMount(MOUNTED, { acceptedBecause: endpoint.acceptedBecause }).mounted).toBe(true);
  });

  it('reports the blank fallback instead of staying silent about it', async () => {
    // The branch that produced E1. It is kept — reporting a blank document is
    // better than throwing "no page target" — but it may no longer be silent.
    const endpoint = await withFetch(
      [{ type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://a' }],
      () => waitForEndpoint(9999, { timeoutMs: 3200 }),
    );
    expect(endpoint.acceptedBecause).toBe('blank-fallback-at-deadline');
    expect(endpoint.acceptedBecauseMeans).toContain('about:blank');
    // And that value alone fails the grade, whatever the document says.
    expect(gradeMount(MOUNTED, { acceptedBecause: endpoint.acceptedBecause }).failed).toEqual([
      'target-provenance',
    ]);
  });
});

/** Runs `body` with `globalThis.fetch` answering the CDP HTTP endpoints. */
async function withFetch(targets, body) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/json/version') ? { Browser: 'fake/1.0' } : targets,
  });
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
}

/**
 * These are SOURCE assertions, and they are weaker than the behavioural ones
 * above: they read bytes, they do not run `commands.up`. Running it needs a
 * built binary and a launched Vela, which this track may not do. They are here
 * because the specific thing they pin — that `up`'s exit code is decided by the
 * grade rather than by "did the handler throw" — is a one-line link between two
 * pieces that ARE tested behaviourally, and a silent revert of that one line
 * would otherwise leave every test above green.
 *
 * RULE T applies to them as much as to a comment: they can prove the byte is
 * present and cannot prove it runs.
 */
describe('up composes the two halves rather than printing them side by side', () => {
  const source = readFileSync(join(HERE, 'vela-drive.mjs'), 'utf8');
  const upSource = source.slice(
    source.indexOf('commands.up = async'),
    source.indexOf('commands.status = async'),
  );

  it('has a body to read', () => {
    expect(upSource.length).toBeGreaterThan(500);
  });

  it('no longer loops on the word "complete"', () => {
    // Comment lines are stripped first: the replacement carries a comment
    // quoting the old condition so the next reader knows what was removed and
    // why, and a scan that matched it would forbid explaining the defect.
    const code = upSource
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toContain("readyState === 'complete'");
    expect(code).not.toContain('const settleDeadline');
  });

  it('waits on the grade, through the same function the tests above drive', () => {
    expect(upSource).toContain('waitForRenderer(');
    expect(upSource).toContain('readiness.grade.mounted');
  });

  it('fails the exit code on the grade, instead of on "did the handler throw"', () => {
    expect(upSource).toMatch(/if \(!readiness\.grade\.mounted\) \{\s*throw new HarnessError\(/);
  });

  it('returns the loop exit condition, which was a local variable before', () => {
    for (const field of ['exitedBy', 'readyStateAtExit', 'polls', 'waitedMs', 'gradeHistory']) {
      expect(upSource, field).toContain(field);
    }
    expect(upSource).toContain('acceptedBecause');
  });

  it('mount and status grade with the same predicate, so they cannot disagree', () => {
    const rest = source.slice(source.indexOf('commands.status = async'));
    const mountAndStatus = rest.slice(0, rest.indexOf('commands.read = async'));
    expect(mountAndStatus.match(/gradeMount\(/g) ?? []).toHaveLength(2);
    expect(mountAndStatus).not.toContain('report.rootPresent && report.rootDescendants > 0');
  });
});

describe('mountReport() itself, run as the shipping source in jsdom', () => {
  function install() {
    new Function(`return ${BOOTSTRAP}`)();
    return window.__velaHarness;
  }

  beforeEach(() => {
    delete window.__TAURI_INTERNALS__;
    delete window.isTauri;
    document.body.innerHTML = '';
    // jsdom implements no layout and therefore no `innerText` at all — it is
    // `undefined`, not empty — so `bodyTextChars` would be 0 for every fixture
    // and `visible-text` would fail on a mounted app for a reason that has
    // nothing to do with the app. In a real engine `innerText` is what a user
    // can see and `textContent` is not, which is why `mountReport` asks for the
    // former; here `textContent` is the closest thing available.
    //
    // This substitution weakens exactly one criterion in exactly this file. It
    // is why the `visible-text` criterion is also covered above by the
    // transcribed reports, where the character counts are the probe's real
    // measurements from a real Chromium.
    if (!('innerText' in window.HTMLElement.prototype)) {
      Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() {
          return this.textContent;
        },
      });
    }
  });

  it('E3 from the DOM up: a static splash with no JavaScript does not grade as mounted', () => {
    // The construction, not a transcription of it: markup only, nothing ran.
    document.body.innerHTML =
      '<div id="root"><div class="boot-splash"><p>Starting Vela...</p></div></div>';
    const report = install().mountReport();

    expect(report.rootDescendants).toBeGreaterThan(0);
    expect(report.bodyTextChars).toBeGreaterThan(0);
    expect(preFixPredicate(report)).toBe(true); // what the tag's verdict said

    const grade = gradeMount(report, { acceptedBecause: 'navigated', targetUrl: 'http://x/' });
    expect(grade.mounted).toBe(false);
    expect(grade.failed).toContain('renderer-provenance');
    expect(grade.failed).toContain('tauri-host');
  });

  it('CONTROL: the same DOM with a React container key and Tauri present does grade as mounted', () => {
    // The provenance markers are what changes, and nothing else. React 19.2.8
    // in this tree writes `internalContainerInstanceKey = "__reactContainer$" +
    // randomKey` onto the container node; Tauri 2.11.5 defines both markers in
    // an unconditional main-frame init script.
    document.body.innerHTML =
      '<div id="root"><div class="app-shell"><p>Starting Vela...</p></div></div>';
    document.getElementById('root')['__reactContainer$r4nd0m'] = {};
    window.__TAURI_INTERNALS__ = { plugins: {} };
    window.isTauri = true;

    const report = install().mountReport();
    expect(report.reactContainerKeyOnRoot).toEqual(['__reactContainer$r4nd0m']);
    expect(report.hasTauriInternals).toBe(true);
    expect(report.isTauri).toBe(true);
    expect(report.firstRootChild).toMatchObject({ tag: 'DIV', className: 'app-shell' });

    // jsdom's location is not about:blank under the vitest jsdom environment,
    // so `document-identity` is decided by the real href here.
    const grade = gradeMount(report, { acceptedBecause: 'navigated', targetUrl: report.href });
    expect(grade.failed).toEqual([]);
    expect(grade.mounted).toBe(true);
  });

  it('E2 from the DOM up: #root present and empty, with a bundle that never ran', () => {
    document.body.innerHTML =
      '<div id="root"></div><script src="/assets/index-deadbeef.js"></script>';
    const report = install().mountReport();
    expect(report.rootPresent).toBe(true);
    expect(report.rootChildElements).toBe(0);
    expect(report.scriptSources).toEqual(['/assets/index-deadbeef.js']);
    expect(gradeMount(report, { acceptedBecause: 'navigated' }).mounted).toBe(false);
  });
});
