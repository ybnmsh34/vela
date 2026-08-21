/**
 * The evasion that got past the last fix, and the guard that closes its class.
 *
 * A third agent was shown `input-provenance.mjs` and drove straight through it
 * with two documented commands at their default flags:
 *
 *     vela-drive type --via cdp --value x --selector #q
 *     vela-drive type --via os  --value y --selector #q
 *
 * The first focuses the field over CDP (`--focus cdp` is its default) and
 * grades itself honestly at `dev-clicked`. The second finds the field focused,
 * so `--focus require` does not refuse, and reports `substituted: false`,
 * `focusVia: "require"`, `ladderCeiling: "os-input-unsubstituted"` — with
 * `entails.does` reading "no CDP call on this run did anything a user would
 * have had to do. The same sequence would drive an app with no CDP attached."
 * Every clause of that is false for the sequence.
 *
 * The class is not focus. It is: **the guard's frame was one command and the
 * claim's frame was the run.** So the tests below are not only about focus.
 * They cover a non-focus act carried across commands (`click --via os` that
 * scrolled), an act channel that used to be graded by nothing at all (`eval`),
 * and the two ways the run can be unknown rather than clean.
 *
 * What is exercised for real here: the graders, the ledger, and — through
 * jsdom and page.mjs's real BOOTSTRAP — the two focus functions the evasion
 * turns on. What is NOT: the CLI wiring, because vela-drive.mjs runs `main()`
 * at import. The handful of assertions about its source text are labelled where
 * they appear and they prove a byte is present, not that it runs.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CEILINGS, KNOWN_STEPS, REASONS, gradeInputProvenance } from './input-provenance.mjs';
import {
  LEDGER_KEY,
  LEDGER_VERSION,
  declareEntry,
  emptyRun,
  lastFocusMove,
  markUndeclared,
  openEntry,
  priorTo,
} from './run-ledger.mjs';
import { BOOTSTRAP } from './page.mjs';

/**
 * The steps `type --via cdp --insert-text` takes. `cdp.focusStored` is the only
 * step in it that moves focus — `cdp.insertText` enters the editing pipeline of
 * whatever is already focused — so it isolates the focus act from the keystroke
 * one in the tests below.
 */
const TYPE_CDP_INSERT = [
  { name: 'cdp.bootstrap' },
  { name: 'cdp.resolve' },
  { name: 'cdp.focusStored' },
  { name: 'cdp.insertText' },
  { name: 'cdp.readActiveElement' },
];

/** The steps `type --via cdp` takes at its defaults — `--focus cdp` included. */
const TYPE_CDP_DEFAULTS = [
  { name: 'cdp.bootstrap' },
  { name: 'cdp.resolve' },
  { name: 'cdp.focusStored' },
  { name: 'cdp.dispatchKeyEvent' },
  { name: 'cdp.readActiveElement' },
];

/** The steps `type --via os` takes at its defaults — `--focus require` included. */
const TYPE_OS_DEFAULTS = [
  { name: 'cdp.bootstrap' },
  { name: 'cdp.resolve' },
  { name: 'cdp.focusState' },
  { name: 'os.raise' },
  { name: 'os.sendInputKeyboard' },
  { name: 'cdp.readActiveElement' },
];

/** The steps `click --via os` takes when the target was already on screen. */
const CLICK_OS_NO_SCROLL = [
  { name: 'cdp.bootstrap' },
  { name: 'cdp.resolve' },
  { name: 'cdp.describeStored' },
  { name: 'os.raise' },
  { name: 'cdp.digest' },
  { name: 'cdp.pointFor.measure' },
  { name: 'cdp.armPointerRecorder' },
  { name: 'os.sendInputMouse' },
  { name: 'cdp.pointerHit' },
  { name: 'cdp.digest' },
  { name: 'cdp.describeStored' },
];

/** A session whose ledger holds the given commands, in order, all declared. */
function sessionWith(...commands) {
  const session = { pid: 4321, port: 9222 };
  for (const [command, steps] of commands) {
    const seq = openEntry(session, command, '2026-08-21T00:00:00.000Z');
    declareEntry(session, seq, steps);
  }
  return session;
}

/** `priorTo` for the command that would run next against `session`. */
function priorForNext(session) {
  const entries = session[LEDGER_KEY].entries;
  const nextSeq = entries.length === 0 ? 1 : entries[entries.length - 1].seq + 1;
  return priorTo(session, nextSeq);
}

describe('THE EVASION: a clean command inside a run CDP had already touched', () => {
  it('type --via cdp then type --via os no longer grades os-input-unsubstituted', () => {
    const session = sessionWith(['type', TYPE_CDP_DEFAULTS]);
    const grade = gradeInputProvenance({
      delivery: 'os',
      steps: TYPE_OS_DEFAULTS,
      prior: priorForNext(session),
    });

    // The narrow answer is unchanged and still true: THIS command substituted
    // nothing. That is exactly why it was quotable and exactly why it was
    // wrong to quote — it is kept, one field down, rather than deleted.
    expect(grade.command.substituted).toBe(false);
    expect(grade.command.ceiling).toBe(CEILINGS.UNSUBSTITUTED);

    // The answer a reader is given disagrees, and names the command that capped
    // it rather than only the step.
    expect(grade.substituted).toBe(true);
    expect(grade.ladderCeiling).toBe(CEILINGS.DEV_CLICKED);
    expect(grade.reason).toBe(REASONS.SUBSTITUTED);
    expect(grade.run.priorSubstitutions.map((s) => `${s.command}#${s.seq} ${s.name}`)).toEqual([
      'type#1 cdp.focusStored',
      'type#1 cdp.dispatchKeyEvent',
    ]);
    expect(grade.verdict).toContain('cdp.focusStored (type #1)');
  });

  it('the sentence the evasion falsified is no longer reachable for that sequence', () => {
    const session = sessionWith(['type', TYPE_CDP_DEFAULTS]);
    const capped = gradeInputProvenance({
      delivery: 'os',
      steps: TYPE_OS_DEFAULTS,
      prior: priorForNext(session),
    });
    expect(capped.entails.does).not.toContain('would drive an app with no CDP attached');

    // And where it IS still reachable, it says which frame it is making the
    // claim over, because "this run" was the word doing the damage.
    const clean = gradeInputProvenance({
      delivery: 'os',
      steps: TYPE_OS_DEFAULTS,
      prior: emptyRun(),
    });
    expect(clean.entails.does).toContain('would drive an app with no CDP attached');
    expect(clean.entails.does).toContain('or by any command before it');
  });

  it('CONTROL: a run whose every act went through the OS is still unsubstituted', () => {
    // Without this the fix would be indistinguishable from capping everything.
    const session = sessionWith(['up', [{ name: 'cdp.bootstrap' }, { name: 'cdp.mountReport' }]], [
      'click',
      CLICK_OS_NO_SCROLL,
    ]);
    const grade = gradeInputProvenance({
      delivery: 'os',
      steps: TYPE_OS_DEFAULTS,
      prior: priorForNext(session),
    });
    expect(grade.substituted).toBe(false);
    expect(grade.ladderCeiling).toBe(CEILINGS.UNSUBSTITUTED);
    expect(grade.reason).toBe(REASONS.CLEAN);
    expect(grade.run.priorCommands).toBe(2);
  });
});

describe('the class, not the instance', () => {
  it('a NON-focus CDP act carried from an earlier command caps the run too', () => {
    // `click --via os` whose target was off screen scrolls the app over CDP to
    // compute the point. That has nothing to do with focus, and before the run
    // frame existed the next command reported itself unsubstituted anyway.
    const scrolled = CLICK_OS_NO_SCROLL.map((step) =>
      step.name === 'cdp.pointFor.measure' ? { name: 'cdp.pointFor.scroll' } : step,
    );
    const session = sessionWith(['click', scrolled]);
    const grade = gradeInputProvenance({
      delivery: 'os',
      steps: TYPE_OS_DEFAULTS,
      prior: priorForNext(session),
    });
    expect(grade.ladderCeiling).toBe(CEILINGS.DEV_CLICKED);
    expect(grade.run.priorSubstitutions.map((s) => s.name)).toEqual(['cdp.pointFor.scroll']);
    // ...and the focus gate would NOT have caught this one: a scroll does not
    // move focus. The two guards cover different halves and neither is the other.
    expect(lastFocusMove(priorForNext(session))).toMatchObject({ channel: 'os' });
  });

  it('A HOLE I FOUND IN MY OWN FIX: click --via message cannot launder focus', () => {
    // Making the frame the run created this one. `os.postMessage` is spelled
    // `os.`, so under "a CDP act substitutes" a `click --via message` left focus
    // behind that the next `type --via os` reported as unsubstituted — no CDP
    // act had occurred anywhere in the run, and the sentence about CDP was
    // literally true while the sentence about the sequence was false. The grade
    // now turns on whether a USER could have produced the step.
    const messageClick = [
      { name: 'cdp.bootstrap' },
      { name: 'cdp.resolve' },
      { name: 'os.raise' },
      { name: 'cdp.pointFor.measure' },
      { name: 'os.postMessage' },
      { name: 'cdp.pointerHit' },
    ];
    const session = sessionWith(['click', messageClick]);
    const grade = gradeInputProvenance({
      delivery: 'os',
      steps: TYPE_OS_DEFAULTS,
      prior: priorForNext(session),
    });
    expect(grade.ladderCeiling).toBe(CEILINGS.DEV_CLICKED);
    expect(grade.run.priorSubstitutions.map((s) => s.name)).toEqual(['os.postMessage']);

    // And the focus gate refuses on the same ground: `userEquivalent`, not the
    // `os.` prefix, is what it reads.
    const origin = lastFocusMove(priorForNext(session));
    expect(origin).toMatchObject({ name: 'os.postMessage', channel: 'os', userEquivalent: false });

    // CONTROL: the same click through SendInput launders nothing because there
    // is nothing to launder — it is what a user does.
    const real = sessionWith([
      'click',
      messageClick.map((s) => (s.name === 'os.postMessage' ? { name: 'os.sendInputMouse' } : s)),
    ]);
    expect(lastFocusMove(priorForNext(real))).toMatchObject({
      name: 'os.sendInputMouse',
      userEquivalent: true,
    });
    expect(
      gradeInputProvenance({ delivery: 'os', steps: TYPE_OS_DEFAULTS, prior: priorForNext(real) })
        .ladderCeiling,
    ).toBe(CEILINGS.UNSUBSTITUTED);
  });

  it('eval is an act now, so the channel that was graded by nothing caps the run', () => {
    const session = sessionWith(['eval', [{ name: 'cdp.bootstrap' }, { name: 'cdp.eval' }]]);
    const grade = gradeInputProvenance({
      delivery: 'os',
      steps: TYPE_OS_DEFAULTS,
      prior: priorForNext(session),
    });
    expect(KNOWN_STEPS['cdp.eval'].kind).toBe('act');
    expect(KNOWN_STEPS['cdp.eval'].movesFocus).toBe(true);
    expect(grade.ladderCeiling).toBe(CEILINGS.DEV_CLICKED);
    expect(grade.run.priorSubstitutions.map((s) => s.name)).toEqual(['cdp.eval']);
    // And it is treated as a focus move, so `--focus require` refuses after it:
    // an arbitrary expression cannot be shown to have done less.
    expect(lastFocusMove(priorForNext(session))).toMatchObject({
      name: 'cdp.eval',
      channel: 'cdp',
      command: 'eval',
    });
  });

  it('a command that attached and never declared is a hole, graded as one', () => {
    const session = { pid: 1, port: 9222 };
    const seq = openEntry(session, 'click', '2026-08-21T00:00:00.000Z');
    markUndeclared(session, seq);
    const prior = priorTo(session, seq + 1);
    expect(prior.known).toBe(true);
    expect(prior.unaccounted).toEqual([{ seq: 1, command: 'click', state: 'undeclared' }]);

    const grade = gradeInputProvenance({ delivery: 'os', steps: TYPE_OS_DEFAULTS, prior });
    expect(grade.ladderCeiling).toBe(CEILINGS.DEV_CLICKED);
    expect(grade.reason).toBe(REASONS.UNACCOUNTED);
    // `null`, not `false`. "Not recorded" and "did not happen" are different
    // answers and collapsing them is how silence reads as innocence.
    expect(grade.substituted).toBeNull();
    expect(grade.entails.doesNot).toContain('because the run cannot be established');
  });

  it('an entry left open by a killed command is the same hole', () => {
    const session = { pid: 1, port: 9222 };
    openEntry(session, 'type', '2026-08-21T00:00:00.000Z');
    const prior = priorTo(session, 2);
    expect(prior.unaccounted).toEqual([{ seq: 1, command: 'type', state: 'open' }]);
    expect(
      gradeInputProvenance({ delivery: 'os', steps: TYPE_OS_DEFAULTS, prior }).ladderCeiling,
    ).toBe(CEILINGS.DEV_CLICKED);
  });

  it('a session with no ledger this build can read is unknown, not empty', () => {
    expect(priorTo({ pid: 1 }, 1)).toMatchObject({ known: false, version: null });
    expect(priorTo({ pid: 1, [LEDGER_KEY]: { version: LEDGER_VERSION + 1, entries: [] } }, 1)).toMatchObject({
      known: false,
      version: LEDGER_VERSION + 1,
    });
    const grade = gradeInputProvenance({
      delivery: 'os',
      steps: TYPE_OS_DEFAULTS,
      prior: priorTo({ pid: 1 }, 1),
    });
    expect(grade.ladderCeiling).toBe(CEILINGS.DEV_CLICKED);
    expect(grade.run.unknownBecause).toContain('carries no run ledger');
    // The version case says which version it found, rather than reporting the
    // same sentence for two different situations.
    expect(
      priorTo({ pid: 1, [LEDGER_KEY]: { version: 99, entries: [] } }, 1).unknownBecause,
    ).toContain('version 99');
  });

  it('a ledger with an entry cut out of the middle is unknown, not shorter', () => {
    // Removing the entry that recorded a CDP act is the obvious way to make a
    // capped run look clean. Sequence numbers are consecutive by construction,
    // so a gap is not a state this code can reach — it is an edit.
    const session = sessionWith(
      ['type', TYPE_CDP_DEFAULTS],
      ['key', [{ name: 'cdp.bootstrap' }, { name: 'os.raise' }, { name: 'os.sendInputKeyboard' }]],
    );
    expect(priorForNext(session).known).toBe(true);

    session[LEDGER_KEY].entries.splice(0, 1); // cut the CDP command out
    const tampered = priorTo(session, 3);
    expect(tampered.known).toBe(false);
    expect(tampered.unknownBecause).toContain('not consecutive');
    expect(
      gradeInputProvenance({ delivery: 'os', steps: TYPE_OS_DEFAULTS, prior: tampered })
        .ladderCeiling,
    ).toBe(CEILINGS.DEV_CLICKED);

    // Stated rather than implied: cutting the TAIL leaves 1..n intact and this
    // check cannot see it. Numbering catches a hole, not a truncation.
    const truncated = sessionWith(['type', TYPE_CDP_DEFAULTS], ['read', [{ name: 'cdp.bootstrap' }]]);
    truncated[LEDGER_KEY].entries.pop();
    expect(priorTo(truncated, 3).known).toBe(true);
  });

  it('a command from another process that ran DURING this one is a hole too', () => {
    // `attach` snapshots nothing: the run is re-read from disk at the moment it
    // is used, so an entry with a higher sequence number than mine is visible —
    // and a command that ran while mine was running is exactly as unaccountable
    // as one that never declared.
    const session = sessionWith(
      ['type', TYPE_OS_DEFAULTS],
      ['eval', [{ name: 'cdp.bootstrap' }, { name: 'cdp.eval' }]],
    );
    const mine = priorTo(session, 1); // I am #1; #2 appeared while I ran
    expect(mine.unaccounted).toEqual([{ seq: 2, command: 'eval', state: 'concurrent' }]);
    const grade = gradeInputProvenance({ delivery: 'os', steps: TYPE_OS_DEFAULTS, prior: mine });
    expect(grade.ladderCeiling).toBe(CEILINGS.DEV_CLICKED);
    expect(grade.reason).toBe(REASONS.UNACCOUNTED);
    expect(grade.verdict).toContain('eval #2 (concurrent)');
  });

  it('CONTROL: every clause of the run grade is decidable — each one alone flips it', () => {
    // The negative-assertion check. A clause rewritten to a constant stops
    // being able to fail, and this is the test that notices.
    const clean = { delivery: 'os', steps: TYPE_OS_DEFAULTS, prior: emptyRun() };
    expect(gradeInputProvenance(clean).ladderCeiling).toBe(CEILINGS.UNSUBSTITUTED);

    const flips = {
      'a CDP act in this command': {
        ...clean,
        steps: [...TYPE_OS_DEFAULTS, { name: 'cdp.focusStored' }],
      },
      'a CDP act in an earlier command': {
        ...clean,
        prior: priorForNext(sessionWith(['type', TYPE_CDP_DEFAULTS])),
      },
      'an earlier command that never declared': {
        ...clean,
        prior: { known: true, entries: [], unaccounted: [{ seq: 1, command: 'x', state: 'open' }] },
      },
      'no readable ledger at all': {
        ...clean,
        prior: { known: false, entries: [], unaccounted: [] },
      },
      'a delivery that was not OS input': { ...clean, delivery: 'cdp' },
    };
    for (const [label, input] of Object.entries(flips)) {
      expect(gradeInputProvenance(input).ladderCeiling, label).toBe(CEILINGS.DEV_CLICKED);
    }
    // Each flip must also give its OWN reason, or one clause could be standing
    // in for another and the table above would not notice.
    expect(new Set(Object.values(flips).map((i) => gradeInputProvenance(i).reason)).size).toBe(3);
  });
});

describe('lastFocusMove: every value in the movesFocus column is load-bearing', () => {
  it('each step that declares movesFocus true is found, and each false one is not', () => {
    // Reads the whole column rather than a sample, so a value changed by hand
    // in KNOWN_STEPS cannot pass unnoticed. RULE U: this is `movesFocus`'s
    // reader, and the `--focus require` gate is its consumer.
    for (const [name, entry] of Object.entries(KNOWN_STEPS)) {
      const prior = priorForNext(sessionWith(['probe', [{ name }]]));
      const found = lastFocusMove(prior);
      if (entry.movesFocus) {
        expect(found, name).toMatchObject({ name, command: 'probe', seq: 1 });
        expect(found.channel, name).toBe(name.startsWith('os.') ? 'os' : 'cdp');
      } else {
        expect(found, name).toBeNull();
      }
    }
  });

  it('the LAST one wins, across commands as well as within one', () => {
    const session = sessionWith(
      ['type', TYPE_CDP_DEFAULTS], // ends cdp.focusStored / cdp.dispatchKeyEvent
      ['key', [{ name: 'cdp.bootstrap' }, { name: 'os.raise' }, { name: 'os.sendInputKeyboard' }]],
    );
    expect(lastFocusMove(priorForNext(session))).toMatchObject({
      name: 'os.sendInputKeyboard',
      channel: 'os',
      command: 'key',
      seq: 2,
    });
    // A raise does not count as a focus move, so it cannot mask the CDP one
    // behind it. Drop the keyboard step and the CDP act is what is found.
    const raiseOnly = sessionWith(
      ['type', TYPE_CDP_DEFAULTS],
      ['click', [{ name: 'cdp.bootstrap' }, { name: 'os.raise' }]],
    );
    expect(lastFocusMove(priorForNext(raiseOnly))).toMatchObject({
      name: 'cdp.dispatchKeyEvent',
      channel: 'cdp',
      command: 'type',
    });
  });

  it('PINS THE README: exactly two steps can supply focus for --focus require', () => {
    // The README names them. A step table that grew a third one, or lost one of
    // these, would leave that sentence false — which is the failure mode this
    // round was graded on. Measured here rather than read there.
    const canSupplyFocus = Object.entries(KNOWN_STEPS)
      .filter(([, entry]) => entry.movesFocus && entry.userEquivalent === true)
      .map(([name]) => name);
    expect(canSupplyFocus).toEqual(['os.sendInputMouse', 'os.sendInputKeyboard']);
    // And the near miss the README calls out by name: an `os.` step that moves
    // focus and still cannot supply it.
    expect(KNOWN_STEPS['os.postMessage']).toMatchObject({ movesFocus: true, userEquivalent: false });
    // ...and the one that is user-equivalent but cannot supply focus, because
    // it moves the window and not document.activeElement.
    expect(KNOWN_STEPS['os.raise']).toMatchObject({ movesFocus: false, userEquivalent: true });
  });

  it('returns null on an unknown run rather than guessing', () => {
    expect(lastFocusMove({ known: false, entries: [], unaccounted: [] })).toBeNull();
    expect(lastFocusMove(emptyRun())).toBeNull();
  });

  it('refuses a ledger naming a step this build does not know', () => {
    const session = { pid: 1 };
    const seq = openEntry(session, 'type', '2026-08-21T00:00:00.000Z');
    declareEntry(session, seq, [{ name: 'cdp.fromTheFuture' }]);
    expect(() => lastFocusMove(priorTo(session, seq + 1))).toThrow(/cdp\.fromTheFuture/);
  });
});

describe('page.mjs is why the ledger is needed: the DOM cannot answer the question', () => {
  function install() {
    new Function(`return ${BOOTSTRAP}`)();
    return window.__velaHarness;
  }

  it('THE EVASION, executed: focusStateOf says yes to focus CDP put there', () => {
    document.body.innerHTML = '<input id="q" />';
    Object.defineProperty(window.Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value() {},
    });
    const api = install();
    api.resolve({ selector: '#q', includeHidden: true });

    // Command 1 — `type --via cdp` at its defaults. Its act, performed.
    expect(api.focusStored(0)).toBe(true);
    const session = sessionWith(['type', TYPE_CDP_DEFAULTS]);

    // Command 2 — `type --via os --focus require`. The predicate that used to
    // be the whole gate says the target is focused, so the refusal it drives
    // does NOT fire. That is the evasion, and it is still true here: the fix is
    // not that this went away, it is that it stopped being the only question.
    expect(api.focusStateOf(0).storedIsActive).toBe(true);

    // The question the DOM cannot answer, answered by the ledger.
    const origin = lastFocusMove(priorForNext(session));
    expect(origin).toMatchObject({
      name: 'cdp.dispatchKeyEvent',
      channel: 'cdp',
      command: 'type',
      seq: 1,
    });

    // Same construction with `--insert-text`, where the keystroke dispatch is
    // gone and `focusStored` is the only step left that moves focus. It is the
    // narrower reproduction: the focus act alone is what the gate must catch.
    const insertRun = lastFocusMove(priorForNext(sessionWith(['type', TYPE_CDP_INSERT])));
    expect(insertRun).toMatchObject({ name: 'cdp.focusStored', channel: 'cdp', command: 'type' });
    expect(insertRun.why).toContain('el.focus()');
  });
});

describe('the CLI wiring — source text only, which proves a byte and not a run', () => {
  const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'vela-drive.mjs'), 'utf8');

  it('every attach call site names its command and hands over a live steps array', () => {
    const calls = [...text.matchAll(/await attach\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args, args).toMatch(/^session, '[a-z]+', steps$/);
    }
  });

  it('eval declares cdp.eval, and main seals the entry in a finally', () => {
    expect(text).toContain("steps.push({ name: 'cdp.eval' });");
    expect(text).toMatch(/\} finally \{[\s\S]*closeLedgerEntry\(\);/);
  });

  it('every gradeInputProvenance call site passes the run', () => {
    const calls = [...text.matchAll(/gradeInputProvenance\(\{([^}]*)\}/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args, args).toContain('prior');
  });

  it('attach opens the entry before it touches the page, and nothing else reads the ledger raw', () => {
    // FOUND BY MUTATION, and the reason this weak test exists at all: deleting
    // `openEntry` from `attach` left the whole suite green, because
    // vela-drive.mjs runs `main()` at import and cannot be loaded by a test. So
    // this is a byte-presence assertion and nothing more. What it pins:
    const attachBody = text.slice(
      text.indexOf('async function attach('),
      text.indexOf('function runContext('),
    );
    expect(attachBody.length).toBeGreaterThan(200);
    expect(attachBody).toContain('const seq = openEntry(session, command);');
    expect(attachBody).toContain('ATTACHED = { pid: session.pid, seq, steps };');
    // ...opened before the first CDP call, so a command killed mid-way leaves a
    // hole rather than nothing.
    expect(attachBody.indexOf('openEntry(session, command)')).toBeLessThan(
      attachBody.indexOf('CdpSession.connect'),
    );
    // `priorTo` is reachable only through `runContext`, which re-reads from
    // disk. A command holding a snapshot from attach time would not see a
    // concurrent command, which is the same mistake one frame smaller.
    const priorToCalls = [...text.matchAll(/priorTo\(/g)].length;
    expect(priorToCalls, 'priorTo should be called once, inside runContext').toBe(1);
    const runContextBody = text.slice(
      text.indexOf('function runContext('),
      text.indexOf('// -----', text.indexOf('function runContext(')),
    );
    expect(runContextBody).toContain('readSession()');
    expect(runContextBody).toContain('priorTo(');
  });
});
