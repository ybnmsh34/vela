/**
 * The next-level defect, and its guard.
 *
 * The mount fix one level up replaced a guard that asked "did the string
 * 'complete' come back?" with one that asks who put the nodes in `#root`. This
 * file is about the same shape of question on the *driving* side: the harness
 * reported `isOsInput: true` for runs in which CDP had done a user's work.
 *
 * Two constructions, both from the bytes rather than from a story:
 *
 * - `commands.type --via os` called `window.__velaHarness.focusStored(index)`
 *   before sending anything, and `focusStored` runs `el.scrollIntoView(...)`
 *   and `el.focus()`.
 * - `commands.click --via os` calls `window.__velaHarness.pointFor(index)`,
 *   which runs `el.scrollIntoView(...)`.
 *
 * In both, `isOsInput: true` sat in the same object as the substitution, and
 * `grep -rn isOsInput` over this directory at the graded tag c0feb93 hit 8
 * lines in 2 files — README prose, a README table header, one comment and five
 * definitions — and no reader at all.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { BOOTSTRAP } from './page.mjs';
import { CEILINGS, KNOWN_STEPS, REASONS, gradeInputProvenance } from './input-provenance.mjs';
import { emptyRun, lastFocusMove, priorTo } from './run-ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, 'vela-drive.mjs'), 'utf8');

/** The steps `type --via os` takes on the pre-fix path, in order. */
const TYPE_OS_WITH_CDP_FOCUS = [
  { name: 'cdp.bootstrap' },
  { name: 'cdp.resolve' },
  { name: 'cdp.focusStored' },
  { name: 'os.raise' },
  { name: 'os.sendInputKeyboard' },
  { name: 'os.sendInputKeyboard.delivered' },
  { name: 'cdp.readActiveElement' },
];

/** The same command once focus is a precondition it proves rather than creates. */
const TYPE_OS_FOCUS_REQUIRED = [
  { name: 'cdp.bootstrap' },
  { name: 'cdp.resolve' },
  { name: 'cdp.focusState' },
  { name: 'os.raise' },
  { name: 'os.sendInputKeyboard' },
  { name: 'os.sendInputKeyboard.delivered' },
  { name: 'cdp.readActiveElement' },
];

describe('the provenance grade composes delivery with what CDP did for it', () => {
  it('THE DEFECT: an OS delivery whose focus came from CDP is not unsubstituted', () => {
    const grade = gradeInputProvenance({
      delivery: 'os',
      steps: TYPE_OS_WITH_CDP_FOCUS,
      prior: emptyRun(),
    });
    // The narrow field still says what it always said, and is still true.
    expect(grade.delivery).toBe('os');
    // The composed one disagrees, which is the whole point.
    expect(grade.substituted).toBe(true);
    expect(grade.substitutions.map((s) => s.name)).toEqual(['cdp.focusStored']);
    expect(grade.ladderCeiling).toBe(CEILINGS.DEV_CLICKED);
    expect(grade.verdict).toContain('DID THE WORK OF A USER');
    expect(grade.verdict).toContain('cdp.focusStored');
  });

  it('CONTROL: the same delivery with focus proved rather than performed is unsubstituted', () => {
    const grade = gradeInputProvenance({
      delivery: 'os',
      steps: TYPE_OS_FOCUS_REQUIRED,
      prior: emptyRun(),
    });
    expect(grade.substituted).toBe(false);
    expect(grade.substitutions).toEqual([]);
    expect(grade.ladderCeiling).toBe(CEILINGS.UNSUBSTITUTED);
    // Reads and instruments are still reported; they simply do not cap.
    expect(grade.reads.map((s) => s.name)).toContain('cdp.readActiveElement');
    expect(grade.instruments.map((s) => s.name)).toContain('cdp.bootstrap');
  });

  it('a CDP `select()` for --clear caps the run, which is why the OS route uses Ctrl+A', () => {
    const grade = gradeInputProvenance({
      delivery: 'os',
      steps: [...TYPE_OS_FOCUS_REQUIRED, { name: 'cdp.selectAll' }],
      prior: emptyRun(),
    });
    expect(grade.ladderCeiling).toBe(CEILINGS.DEV_CLICKED);
    expect(grade.substitutions.map((s) => s.name)).toEqual(['cdp.selectAll']);
  });

  it('click: a scroll performed to compute the point caps the run; a measurement does not', () => {
    const base = [
      { name: 'cdp.bootstrap' },
      { name: 'cdp.resolve' },
      { name: 'cdp.describeStored' },
      { name: 'os.raise' },
      { name: 'cdp.digest' },
      { name: 'cdp.armPointerRecorder' },
      { name: 'os.sendInputMouse' },
      { name: 'cdp.pointerHit' },
      { name: 'os.sendInputMouse.delivered' },
    ];
    const measured = gradeInputProvenance({
      delivery: 'os',
      steps: [...base, { name: 'cdp.pointFor.measure', detail: { scrolled: false } }],
      prior: emptyRun(),
    });
    const scrolled = gradeInputProvenance({
      delivery: 'os',
      steps: [...base, { name: 'cdp.pointFor.scroll', detail: { scrolled: true, scrollDelta: { dx: 0, dy: -320 } } }],
      prior: emptyRun(),
    });
    expect(measured.ladderCeiling).toBe(CEILINGS.UNSUBSTITUTED);
    expect(scrolled.ladderCeiling).toBe(CEILINGS.DEV_CLICKED);
    // The detail that decided it travels with the step, so a reader is never
    // asked to take the classification on trust.
    expect(scrolled.substitutions[0].detail.scrollDelta).toEqual({ dx: 0, dy: -320 });
  });

  it('an act substitutes on whether a USER could have done it, not on the name prefix', () => {
    // `os.postMessage` is spelled `os.` and a user has no route to it: nobody
    // posts a WM_LBUTTONDOWN to a child window they looked up by handle.
    // Grading on the prefix let a `click --via message` leave focus behind that
    // a later `type --via os` then reported as unsubstituted.
    const messageClick = [
      { name: 'cdp.bootstrap' },
      { name: 'cdp.resolve' },
      { name: 'os.raise' },
      { name: 'cdp.pointFor.measure' },
      { name: 'os.postMessage' },
      { name: 'cdp.pointerHit' },
    ];
    const grade = gradeInputProvenance({
      delivery: 'os',
      steps: messageClick,
      prior: emptyRun(),
    });
    expect(grade.substitutions.map((s) => s.name)).toEqual(['os.postMessage']);
    expect(grade.ladderCeiling).toBe(CEILINGS.DEV_CLICKED);
    // ...and `os.raise` is in the same command, on the same prefix, and does
    // NOT substitute — a user does bring a window forward. So the new column is
    // discriminating between two `os.` acts and not just re-spelling `cdp`.
    expect(grade.acts.map((s) => s.name)).toContain('os.raise');
    expect(grade.acts.find((s) => s.name === 'os.raise').userEquivalent).toBe(true);
  });

  it('refuses a step table entry whose act does not answer the user question', () => {
    // Enforced in the grader, not in a test, so a step added without it is a
    // hard error on the driving path.
    const original = KNOWN_STEPS['cdp.focusStored'].userEquivalent;
    delete KNOWN_STEPS['cdp.focusStored'].userEquivalent;
    try {
      expect(() =>
        gradeInputProvenance({
          delivery: 'os',
          steps: [{ name: 'cdp.focusStored' }],
          prior: emptyRun(),
        }),
      ).toThrow(/does not declare userEquivalent/);
    } finally {
      KNOWN_STEPS['cdp.focusStored'].userEquivalent = original;
    }

    KNOWN_STEPS['cdp.digest'].userEquivalent = true;
    try {
      expect(() =>
        gradeInputProvenance({ delivery: 'os', steps: [{ name: 'cdp.digest' }], prior: emptyRun() }),
      ).toThrow(/is a read and declares userEquivalent/);
    } finally {
      delete KNOWN_STEPS['cdp.digest'].userEquivalent;
    }
  });

  it('a CDP or message delivery is capped whatever else the run did', () => {
    for (const delivery of ['cdp', 'message']) {
      const grade = gradeInputProvenance({
        delivery,
        steps: [{ name: 'cdp.bootstrap' }],
        prior: emptyRun(),
      });
      expect(grade.substituted, delivery).toBe(false);
      expect(grade.ladderCeiling, delivery).toBe(CEILINGS.DEV_CLICKED);
      expect(grade.verdict, delivery).toContain(`delivery was "${delivery}"`);
    }
  });

  it('refuses an unclassified step instead of grading as if it had not happened', () => {
    // The mitigation for this fix's own next-level defect: `kind` is declared,
    // not derived, so a new CDP call site must be classified in KNOWN_STEPS
    // before it can appear on a driving path.
    expect(() =>
      gradeInputProvenance({
        delivery: 'os',
        steps: [{ name: 'cdp.somethingNew' }],
        prior: emptyRun(),
      }),
    ).toThrow(/unknown step "cdp\.somethingNew"/);
  });

  it('refuses a delivery channel it does not know', () => {
    expect(() => gradeInputProvenance({ delivery: 'magic', steps: [], prior: emptyRun() })).toThrow(
      /delivery must be/,
    );
  });

  it('refuses to grade at all without being told what the run did before', () => {
    // The frame is the run. A caller that cannot say what happened earlier
    // cannot be given an answer about the run, and the old signature let every
    // caller skip the question by not asking it.
    expect(() =>
      gradeInputProvenance({ delivery: 'os', steps: TYPE_OS_FOCUS_REQUIRED }),
    ).toThrow(/`prior` is required/);
    expect(() =>
      gradeInputProvenance({ delivery: 'os', steps: TYPE_OS_FOCUS_REQUIRED, prior: {} }),
    ).toThrow(/`prior` is required/);
  });

  it('never claims the reaches-user tier in a field a caller could paste', () => {
    // The value is deliberately not a ladder tier. The tier also needs an
    // installed bundle, which this harness cannot attest.
    const grade = gradeInputProvenance({
      delivery: 'os',
      steps: TYPE_OS_FOCUS_REQUIRED,
      prior: emptyRun(),
    });
    expect(grade.ladderCeiling).not.toContain('reaches-user');
    expect(grade.entails.doesNot).toContain('reaches-user');
    expect(grade.entails.doesNot).toContain('installer');
  });

  it('every known step declares a channel consistent with its name', () => {
    for (const [name, entry] of Object.entries(KNOWN_STEPS)) {
      expect(['read', 'instrument', 'act'], name).toContain(entry.kind);
      expect(entry.why.length, name).toBeGreaterThan(20);
      // `movesFocus` decides whether a step can be the reason a LATER command
      // finds its target focused, so an entry without one is not a hole that
      // reads as false — it is a step the ledger cannot reason about.
      expect(typeof entry.movesFocus, name).toBe('boolean');
      if (entry.kind === 'act') expect(typeof entry.userEquivalent, name).toBe('boolean');
      else expect(entry.userEquivalent, name).toBeUndefined();
    }
    const graded = gradeInputProvenance({
      delivery: 'os',
      steps: Object.keys(KNOWN_STEPS).map((name) => ({ name })),
      prior: emptyRun(),
    });
    for (const step of graded.steps) {
      expect(step.channel, step.name).toBe(step.name.startsWith('os.') ? 'os' : 'cdp');
    }
  });
});

describe('the driving commands feed the grade the steps they really took', () => {
  function bodyOf(command, next) {
    const start = source.indexOf(`commands.${command} = async`);
    const end = source.indexOf(`commands.${next} = async`);
    expect(start, command).toBeGreaterThan(-1);
    expect(end, command).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('type refuses to focus over CDP on the OS route by default', () => {
    const body = bodyOf('type', 'key');
    expect(body).toContain("flags.focus ?? (via === 'os' ? 'require' : 'cdp')");
    expect(body).toContain("cdp.focusState");
    expect(body).toContain('storedIsActive');
    // And the escape hatch exists, and records itself.
    expect(body).toContain("cdp.focusStored");
  });

  it('type no longer runs a CDP select() on the OS route', () => {
    const body = bodyOf('type', 'key');
    const osBranch = body.slice(body.indexOf("if (via === 'os') {"), body.indexOf('} else if (cleared)'));
    // Comment lines are stripped first. The replacement carries a comment
    // naming what it replaced and why, and a scan that matched it would forbid
    // explaining the defect. Same reason readiness.test.mjs strips them.
    const code = osBranch
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join(' ');
    expect(code).not.toContain('.select()');
    expect(code).toContain('MODIFIER_BITS.ctrl');
    // ...and the CDP route still has it, so the assertion above is about the
    // OS branch and not about the string having left the file.
    expect(body).toContain('activeElement.select()');
  });

  it('every driving command grades its own provenance', () => {
    for (const [command, next] of [['click', 'type'], ['type', 'key'], ['key', 'eval']]) {
      expect(bodyOf(command, next), command).toContain('gradeInputProvenance(');
    }
  });

  it('click classifies pointFor by whether it MOVED anything, not by whether it was called', () => {
    const body = bodyOf('click', 'type');
    // Declared at the worse name before the call, downgraded on the measured
    // answer afterwards — so an evaluate that throws mid-way cannot drop a
    // scroll that really happened out of the ledger.
    expect(body).toContain("const pointStep = { name: 'cdp.pointFor.scroll'");
    expect(body).toContain("if (point?.scrolled !== true) pointStep.name = 'cdp.pointFor.measure';");
    expect(body.indexOf('steps.push(pointStep)')).toBeLessThan(
      body.indexOf('window.__velaHarness.pointFor('),
    );
  });

  it('isOsInput survives but is documented as narrow, so it cannot be quoted as the answer', () => {
    expect(source).toContain('NARROW ON PURPOSE');
    expect(source).toMatch(/provenance\.ladderCeiling/);
  });
});

describe('page.mjs: the read half of focus, and the measured scroll', () => {
  function install() {
    new Function(`return ${BOOTSTRAP}`)();
    return window.__velaHarness;
  }

  /** Every scrollIntoView call any harness function made during a test. */
  let scrollCalls = [];

  beforeEach(() => {
    document.body.innerHTML = '';
    scrollCalls = [];
    // jsdom implements no layout and therefore no scrollIntoView at all -- it
    // is undefined, not a no-op -- so page.mjs's real source throws here where
    // a real engine would scroll. The stub is a SUBSTITUTION and it is the
    // reason the assertions below are about which functions CALL it rather
    // than about how far anything moved. What moves a real view is not
    // measurable in this environment and no test in this file claims it is.
    Object.defineProperty(window.Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value(options) {
        scrollCalls.push({ tag: this.tagName, options });
      },
    });
    // Same story: jsdom has no hit-testing, so pointFor's topmostAtPoint probe
    // has nothing to answer with. Returning null is what a real engine returns
    // for a point outside the viewport, and nothing in this file asserts on it.
    if (typeof document.elementFromPoint !== 'function') {
      document.elementFromPoint = () => null;
    }
  });

  it('focusStateOf reports where focus is WITHOUT putting it there', () => {
    document.body.innerHTML = '<input id="a" /><input id="b" />';
    const api = install();
    api.resolve({ selector: '#a', includeHidden: true });
    const before = document.activeElement;

    const state = api.focusStateOf(0);
    expect(state.storedFound).toBe(true);
    expect(state.storedIsActive).toBe(false);
    // The read did not move focus, and did not scroll. Those two absences are
    // the property that makes it a read rather than an act.
    expect(document.activeElement).toBe(before);
    expect(scrollCalls).toEqual([]);

    document.getElementById('a').focus();
    const after = api.focusStateOf(0);
    expect(after.storedIsActive).toBe(true);
    expect(after.active).toMatchObject({ tag: 'INPUT', id: 'a', editable: true });
  });

  it('CONTROL: focusStored DOES move focus — which is why it is graded as an act', () => {
    document.body.innerHTML = '<input id="a" />';
    const api = install();
    api.resolve({ selector: '#a', includeHidden: true });
    expect(api.focusStateOf(0).storedIsActive).toBe(false);
    expect(api.focusStored(0)).toBe(true);
    expect(api.focusStateOf(0).storedIsActive).toBe(true);
    // Both halves of the act, observed: it scrolled and it moved focus.
    expect(scrollCalls).toHaveLength(1);
    expect(KNOWN_STEPS['cdp.focusStored'].kind).toBe('act');
    expect(KNOWN_STEPS['cdp.focusState'].kind).toBe('read');
  });

  it('focusStateOf answers rather than throwing when the index is not stored', () => {
    install();
    const state = window.__velaHarness.focusStateOf(99);
    expect(state.storedFound).toBe(false);
    expect(state.storedIsActive).toBe(false);
  });

  it('pointFor reports scrolled:false when the rect did not move', () => {
    // The stub scrolls nothing and jsdom's rects are all zero, so this is
    // exactly the "nothing moved" case and is all the assertion claims. That
    // the field goes TRUE when an ancestor really scrolls is NOT shown here and
    // I could not show it in jsdom; the click path's handling of that case is
    // covered above at the grade level, where the step name is the input.
    document.body.innerHTML = '<button id="b">go</button>';
    const api = install();
    api.resolve({ selector: '#b', includeHidden: true });
    const point = api.pointFor(0);
    expect(scrollCalls).toHaveLength(1); // it did call it
    expect(point.scrolled).toBe(false); // and nothing moved, so it only measured
    expect(point.scrollDelta).toEqual({ dx: 0, dy: 0 });
  });

  it('pointFor reports scrolled:true when the rect DID move', () => {
    // Drives the measurement rather than the environment: the stub moves the
    // element's reported rect, which is what a real scroll does to it. This is
    // the assertion that would go red if `scrolled` were hard-coded false, and
    // the one the jsdom test above cannot make.
    document.body.innerHTML = '<button id="b">go</button>';
    const api = install();
    api.resolve({ selector: '#b', includeHidden: true });
    const element = document.getElementById('b');
    let top = 900;
    element.getBoundingClientRect = () => ({ x: 0, y: top, left: 0, top, width: 40, height: 20 });
    Object.defineProperty(element, 'scrollIntoView', {
      configurable: true,
      value() {
        scrollCalls.push({ tag: this.tagName });
        top = 300;
      },
    });
    const point = api.pointFor(0);
    expect(point.scrolled).toBe(true);
    expect(point.scrollDelta).toEqual({ dx: 0, dy: -600 });
  });
});
