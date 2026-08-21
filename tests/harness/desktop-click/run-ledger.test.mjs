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
 * What is exercised for real here: the graders; the ledger; the two focus
 * functions the evasion turns on, through jsdom and page.mjs's real BOOTSTRAP;
 * and `vela-drive.mjs`'s own `runContext`, against real files on disk, which
 * became possible when that file stopped running `main()` at import and got
 * an entry-point guard instead.
 *
 * What is still NOT exercised: anything inside `commands.*`. Those need a live
 * window, a CDP socket and a real `SendInput`, and this suite has none of the
 * three — the reason is the socket, not the import, which now works. The
 * handful of assertions about that file's source text are labelled where they
 * appear and they prove a byte is present, not that it runs.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT } from './cdp.mjs';
import { CEILINGS, KNOWN_STEPS, REASONS, gradeInputProvenance } from './input-provenance.mjs';
import {
  FOCUS_REFUSALS,
  LEDGER_KEY,
  LEDGER_VERSION,
  declareEntry,
  emptyRun,
  focusRequireRefusal,
  lastFocusMove,
  markUndeclared,
  notMyLedger,
  openEntry,
  priorTo,
  startRun,
  unknownRun,
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
  { name: 'os.sendInputKeyboard.delivered' },
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
  { name: 'os.sendInputMouse.delivered' },
];

/**
 * A session whose ledger holds the given commands, in order, all declared.
 *
 * `startRun` first, because that is what the CLI does: `up` builds the session
 * object and calls `startRun` on it, and every later command calls `openEntry`
 * on the session it read back from disk. A fixture that skipped `startRun`
 * would model a session no `up` can produce, and would come back
 * `known: false` — which is this round's fix, not a fixture detail.
 */
function sessionWith(...commands) {
  const session = { pid: 4321, port: 9222 };
  startRun(session);
  for (const [command, steps] of commands) {
    const seq = openEntry(session, command);
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
      [
        ...messageClick.map((s) => (s.name === 'os.postMessage' ? { name: 'os.sendInputMouse' } : s)),
        // The confirmation `click --via os` pushes once the page-side pointer
        // recorder has seen the press. The attempt alone cannot supply focus.
        { name: 'os.sendInputMouse.delivered' },
      ],
    ]);
    expect(lastFocusMove(priorForNext(real))).toMatchObject({
      name: 'os.sendInputMouse.delivered',
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
    startRun(session);
    const seq = openEntry(session, 'click');
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
    startRun(session);
    openEntry(session, 'type');
    const prior = priorTo(session, 2);
    expect(prior.unaccounted).toEqual([{ seq: 1, command: 'type', state: 'open' }]);
    expect(
      gradeInputProvenance({ delivery: 'os', steps: TYPE_OS_DEFAULTS, prior }).ladderCeiling,
    ).toBe(CEILINGS.DEV_CLICKED);
  });

  it('priorTo alone: a session with no ledger this build can read is unknown, not empty', () => {
    // A property of `priorTo` called directly, and NOTHING MORE — which is
    // exactly what the round-2 version of this test proved while carrying a
    // name that read as a claim about a run. The run claim is the test below,
    // and it needed a code change, not a rename.
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

  describe('THE SECOND EVASION: the fix carried the defect it was closing, one level down', () => {
    // Found by a fresh agent against round 2, twice, deterministically. The
    // ledger closed the round-1 hole for any run that starts under this build —
    // and `attach` calls `openEntry` BEFORE anything reads the ledger, and
    // `openEntry` replaced a ledger it could not read with an empty one. So the
    // two branches above were unreachable from the CLI: the evidence that the
    // run was unaccountable was destroyed and replaced with a positive claim
    // that the run was empty. A live window whose session.json predated the
    // ledger, or any future LEDGER_VERSION bump, graded `substituted: false`,
    // `ladderCeiling: "os-input-unsubstituted"`, `reason: "every-act-was-os"`.
    //
    // These three reproduce vela-drive's own call order — attach: openEntry
    // then write; runContext: read then priorTo — so they are a claim about a
    // RUN and not about a function. The order they mirror is pinned by a
    // source-text assertion in "the CLI wiring" below.
    const attachThenGrade = (session, command) => {
      const seq = openEntry(session, command); // what `attach` does, first
      const prior = priorTo(session, seq); // what `runContext` does, later
      return {
        prior,
        grade: gradeInputProvenance({ delivery: 'os', steps: TYPE_OS_DEFAULTS, prior }),
        refusal: focusRequireRefusal(prior, lastFocusMove(prior)),
      };
    };

    it('EV-A: a session whose ledger predates this build stays unknown through attach', () => {
      // The round-1 build wrote no `runLedger` key at all.
      const session = { pid: 4321, port: 9222 };
      const { prior, grade, refusal } = attachThenGrade(session, 'type');
      expect(prior.known).toBe(false);
      expect(prior.unknownBecause).toContain('carried no run ledger when this command attached');
      expect(grade.ladderCeiling).toBe(CEILINGS.DEV_CLICKED);
      expect(grade.reason).toBe(REASONS.UNACCOUNTED);
      expect(grade.substituted).toBeNull();
      // The sentence the evasion made this run print. It must not be reachable.
      expect(grade.entails.does ?? '').not.toContain('would drive an app with no CDP attached');
      expect(refusal.clause).toBe(FOCUS_REFUSALS.RUN_NOT_ESTABLISHED);
    });

    it('EV-B: a ledger at another version stays unknown through attach', () => {
      const session = {
        pid: 4321,
        port: 9222,
        [LEDGER_KEY]: { version: LEDGER_VERSION + 1, entries: [{ seq: 1, command: 'up' }] },
      };
      const { prior, grade, refusal } = attachThenGrade(session, 'type');
      expect(prior.known).toBe(false);
      expect(prior.unknownBecause).toContain(`was version ${LEDGER_VERSION + 1}`);
      expect(grade.ladderCeiling).toBe(CEILINGS.DEV_CLICKED);
      expect(refusal.clause).toBe(FOCUS_REFUSALS.RUN_NOT_ESTABLISHED);
    });

    it('the reset cannot be washed out by running more accountable commands', () => {
      // The reason `priorUnknownBecause` is sticky. Three clean OS commands
      // after the gap do not make the gap accountable, and the ledger they
      // append to still refuses.
      const session = { pid: 4321, port: 9222 };
      for (const command of ['type', 'click', 'key']) {
        const seq = openEntry(session, command);
        declareEntry(session, seq, CLICK_OS_NO_SCROLL);
      }
      expect(session[LEDGER_KEY].entries).toHaveLength(3);
      expect(priorForNext(session).known).toBe(false);
      expect(focusRequireRefusal(priorForNext(session), null).clause).toBe(
        FOCUS_REFUSALS.RUN_NOT_ESTABLISHED,
      );
    });

    it('CONTROL: the same sequence under a run `up` started grades clean', () => {
      // Isolates the cause. Identical steps, identical order — the only
      // difference is that `startRun` was called, which is what `up` does and
      // what the round-2 `openEntry` did silently for everyone.
      const session = { pid: 4321, port: 9222 };
      startRun(session);
      const { prior, grade, refusal } = attachThenGrade(session, 'type');
      expect(prior.known).toBe(true);
      expect(grade.ladderCeiling).toBe(CEILINGS.UNSUBSTITUTED);
      expect(grade.substituted).toBe(false);
      expect(refusal).toBeNull();
    });

    it('a version-2 ledger that will not say is not a ledger that said no', () => {
      // `priorUnknownBecause` missing from a current-version ledger is an edit
      // or a truncation, not a clean run. Strict `!== null`, deliberately.
      const session = {
        pid: 4321,
        port: 9222,
        [LEDGER_KEY]: { version: LEDGER_VERSION, entries: [{ seq: 1, command: 'up', state: 'declared', steps: [] }] },
      };
      const prior = priorTo(session, 2);
      expect(prior.known).toBe(false);
      expect(prior.unknownBecause).toContain('will not say');
    });
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

  it('THE FIFTH MEMBER: a declared entry with its steps key gone is unknown, not silent', () => {
    // The critic's construction, executed. `priorTo` used to read `steps` with
    // `?? []`, so deleting one key from one `declared` entry made the command
    // that took a CDP act read as a command that did nothing — every other
    // check in the function passed, and the run graded clean. That is the
    // file's own rule ("nothing may substitute a default for evidence it
    // failed to read") broken in the function that states it.
    const session = sessionWith(
      ['type', TYPE_CDP_DEFAULTS],
      ['read', [{ name: 'cdp.bootstrap' }, { name: 'cdp.visibleText' }]],
    );
    // The run is capped BEFORE the edit, because entry #1 took a CDP act.
    const before = priorForNext(session);
    expect(before.known).toBe(true);
    expect(
      gradeInputProvenance({ delivery: 'os', steps: TYPE_OS_DEFAULTS, prior: before })
        .ladderCeiling,
    ).toBe(CEILINGS.DEV_CLICKED);

    // One key deleted, nothing else touched: state stays `declared`, the
    // sequence stays consecutive, the version and `priorUnknownBecause` are
    // untouched, and `notMyLedger` has no quarrel with it.
    delete session[LEDGER_KEY].entries[0].steps;
    expect(session[LEDGER_KEY].entries[0].state).toBe('declared');
    expect(session[LEDGER_KEY].entries.map((e) => e.seq)).toEqual([1, 2]);

    const after = priorTo(session, 3);
    expect(after.known).toBe(false);
    expect(after.unknownBecause).toContain('carries no list of steps');
    expect(after.unknownBecause).toContain('#1');
    expect(
      gradeInputProvenance({ delivery: 'os', steps: TYPE_OS_DEFAULTS, prior: after })
        .ladderCeiling,
    ).toBe(CEILINGS.DEV_CLICKED);

    // `null` is the same edit written the other way, and must land the same.
    const nulled = sessionWith(['type', TYPE_CDP_DEFAULTS], ['read', [{ name: 'cdp.bootstrap' }]]);
    nulled[LEDGER_KEY].entries[0].steps = null;
    expect(priorTo(nulled, 3).unknownBecause).toContain('carries no list of steps');

    // CONTROL, and the reason this is a refusal rather than a coercion: an
    // entry that genuinely declared NOTHING carries `[]`, which is evidence
    // and reads as evidence. A command killed before its first push declares
    // exactly this, so the refusal must not fire on it.
    const emptyDeclared = sessionWith(['type', TYPE_CDP_DEFAULTS], ['status', []]);
    expect(emptyDeclared[LEDGER_KEY].entries[1].steps).toEqual([]);
    const still = priorTo(emptyDeclared, 3);
    expect(still.known).toBe(true);
    expect(still.entries).toContainEqual({ seq: 2, command: 'status', steps: [] });
  });

  it('THE FIFTH MEMBER, other half: a ledger with no entries list is unknown, not empty', () => {
    // `ledger.entries ?? []` was the same default one level up: a
    // current-version ledger with the key deleted read as a run that had run
    // nothing at all, which is the strongest possible reading of the least
    // evidence.
    const session = sessionWith(['type', TYPE_CDP_DEFAULTS]);
    delete session[LEDGER_KEY].entries;
    const graded = priorTo(session, 2);
    expect(graded.known).toBe(false);
    expect(graded.unknownBecause).toContain('no readable list of entries');
    expect(
      gradeInputProvenance({ delivery: 'os', steps: TYPE_OS_DEFAULTS, prior: graded })
        .ladderCeiling,
    ).toBe(CEILINGS.DEV_CLICKED);

    // CONTROL: a genuinely empty run — `up` and nothing since — is `[]`, is
    // known, and still grades clean. The refusal is about the key being
    // absent, not about the list being short.
    const fresh = { pid: 4321, port: 9222 };
    startRun(fresh);
    expect(fresh[LEDGER_KEY].entries).toEqual([]);
    const clean = priorTo(fresh, 1);
    expect(clean.known).toBe(true);
    expect(
      gradeInputProvenance({ delivery: 'os', steps: TYPE_OS_DEFAULTS, prior: clean }).ladderCeiling,
    ).toBe(CEILINGS.UNSUBSTITUTED);
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
      [
        'key',
        [
          { name: 'cdp.bootstrap' },
          { name: 'os.raise' },
          { name: 'os.sendInputKeyboard' },
          { name: 'os.sendInputKeyboard.delivered' },
        ],
      ],
    );
    expect(lastFocusMove(priorForNext(session))).toMatchObject({
      name: 'os.sendInputKeyboard.delivered',
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
    expect(canSupplyFocus).toEqual([
      'os.sendInputMouse.delivered',
      'os.sendInputKeyboard.delivered',
    ]);
    // And the near miss the README calls out by name: an `os.` step that moves
    // focus and still cannot supply it.
    expect(KNOWN_STEPS['os.postMessage']).toMatchObject({ movesFocus: true, userEquivalent: false });
    // The other near miss, new this round, and the reason the two above are
    // spelled `.delivered`: the ATTEMPT is user-equivalent and still cannot
    // supply focus, because it is declared before the call it names and a
    // declaration is not evidence that anything happened.
    expect(KNOWN_STEPS['os.sendInputMouse']).toMatchObject({
      movesFocus: false,
      userEquivalent: true,
    });
    expect(KNOWN_STEPS['os.sendInputKeyboard']).toMatchObject({
      movesFocus: false,
      userEquivalent: true,
    });
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
    startRun(session);
    const seq = openEntry(session, 'type');
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

describe('the --focus require gate, every clause of it, executed', () => {
  // WHY THIS EXISTS. A mutation disabled the whole gate — the refusal the
  // README devotes its longest paragraph to — by prefixing its condition with
  // `false &&`, and the whole suite as it then stood — 117 tests — stayed green,
  // twice. Nothing covered it, not
  // even a byte-presence assertion, because the gate was inline in
  // `commands.type` and reaching it needs a live window, a CDP socket and a
  // real SendInput.
  //
  // The decision is now `focusRequireRefusal` in run-ledger.mjs, a pure
  // function of (run, focus origin). Each clause below is disabled on its own
  // by a mutation and reddens on its own here. What these do NOT prove is that
  // `commands.type` calls it — that is one `if`, pinned by source text in the
  // last describe of this file, and source text proves a byte and not a run.
  const cleanRun = () => priorForNext(sessionWith(['up', [{ name: 'cdp.bootstrap' }]]));

  it('CONTROL: a run that never moved focus is not refused', () => {
    // Not vacuous: the gate has to let something through, and this is the case
    // the README describes — focus is where the application itself put it,
    // which is what a user finds on launch.
    const prior = cleanRun();
    expect(lastFocusMove(prior)).toBeNull();
    expect(focusRequireRefusal(prior, null)).toBeNull();
  });

  it('CONTROL: a run whose focus came from a delivered OS act is not refused', () => {
    const session = sessionWith([
      'click',
      [{ name: 'os.sendInputMouse' }, { name: 'os.sendInputMouse.delivered' }],
    ]);
    const prior = priorForNext(session);
    expect(focusRequireRefusal(prior, lastFocusMove(prior))).toBeNull();
  });

  it('clause 1: a run that cannot be established is refused, and says why', () => {
    const prior = unknownRun(null, 'THE REASON THE RUN COULD NOT BE READ.');
    const refusal = focusRequireRefusal(prior, null);
    expect(refusal.clause).toBe(FOCUS_REFUSALS.RUN_NOT_ESTABLISHED);
    // The run's own sentence is carried through rather than replaced by a
    // generic one, because the four ways a run can be unreadable want four
    // different things done about them.
    expect(refusal.message).toContain('THE REASON THE RUN COULD NOT BE READ.');
    expect(refusal.message).toContain('--focus cdp');
  });

  it('clause 2: an unaccounted command is refused, and is named', () => {
    const session = sessionWith(['up', [{ name: 'cdp.bootstrap' }]]);
    markUndeclared(session, openEntry(session, 'eval'));
    const prior = priorForNext(session);
    const refusal = focusRequireRefusal(prior, lastFocusMove(prior));
    expect(refusal.clause).toBe(FOCUS_REFUSALS.COMMANDS_NOT_ACCOUNTED_FOR);
    expect(refusal.message).toContain('eval #2 (undeclared)');
    // Reached even though nothing in the run moved focus at all — the hole is
    // the ground, not the focus origin.
    expect(lastFocusMove(prior)).toBeNull();
  });

  it('clause 3: focus from an act a user has no route to is refused, and is named', () => {
    const session = sessionWith(['type', TYPE_CDP_DEFAULTS]);
    const prior = priorForNext(session);
    const refusal = focusRequireRefusal(prior, lastFocusMove(prior));
    expect(refusal.clause).toBe(FOCUS_REFUSALS.FOCUS_NOT_USER_EQUIVALENT);
    expect(refusal.message).toContain('`cdp.dispatchKeyEvent` in `type` #1');
    expect(refusal.message).toContain('Input.dispatchKeyEvent');
  });

  it('THE HOLE THIS ROUND: an OS click that delivered nothing cannot supply focus', () => {
    // `os.sendInputMouse` is pushed BEFORE the SendInput call, so a click that
    // delivered nothing — os-input.ps1 sends nothing at all when another
    // process owns the pixel — still wrote a user-equivalent focus move into
    // the ledger. That entry then satisfied this gate AND masked the CDP act
    // that had really focused the field. Both halves are asserted here.
    const laundered = sessionWith(
      ['type', TYPE_CDP_DEFAULTS], // cdp.focusStored really put focus there
      ['click', [{ name: 'cdp.resolve' }, { name: 'os.sendInputMouse' }]], // delivered nothing
    );
    const prior = priorForNext(laundered);
    const origin = lastFocusMove(prior);
    expect(origin.name).toBe('cdp.dispatchKeyEvent'); // NOT the undelivered click
    expect(focusRequireRefusal(prior, origin).clause).toBe(
      FOCUS_REFUSALS.FOCUS_NOT_USER_EQUIVALENT,
    );

    // CONTROL: the same click WITH its confirmation supplies focus, so the
    // refusal above is about delivery and not about clicks.
    const delivered = sessionWith(
      ['type', TYPE_CDP_DEFAULTS],
      [
        'click',
        [
          { name: 'cdp.resolve' },
          { name: 'os.sendInputMouse' },
          { name: 'os.sendInputMouse.delivered' },
        ],
      ],
    );
    const deliveredPrior = priorForNext(delivered);
    expect(lastFocusMove(deliveredPrior).name).toBe('os.sendInputMouse.delivered');
    expect(focusRequireRefusal(deliveredPrior, lastFocusMove(deliveredPrior))).toBeNull();
  });

  it('every clause in FOCUS_REFUSALS is producible, and nothing else is', () => {
    // RULE U for `clause`: this is its reader, along with the `refusedBy` field
    // `commands.type` puts in the refusal payload. A clause added to the
    // vocabulary and never returned, or returned and never listed, fails here.
    const unaccounted = sessionWith(['up', [{ name: 'cdp.bootstrap' }]]);
    markUndeclared(unaccounted, openEntry(unaccounted, 'eval'));
    const cdpFocus = priorForNext(sessionWith(['type', TYPE_CDP_DEFAULTS]));
    const produced = [
      focusRequireRefusal(unknownRun(null, 'why'), null),
      focusRequireRefusal(priorForNext(unaccounted), null),
      focusRequireRefusal(cdpFocus, lastFocusMove(cdpFocus)),
    ].map((refusal) => refusal.clause);
    expect(new Set(produced)).toEqual(new Set(Object.values(FOCUS_REFUSALS)));
  });
});

describe('runContext: the second member of the class, executed against real files', () => {
  // This block is why vela-drive.mjs no longer runs `main()` at import. Every
  // assertion about the CLI in this file used to be a regex over its own
  // source; these run its code.
  let INTERNALS;
  let root;
  let sessionFile;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'vela-drive-runcontext-'));
    process.env.VELA_HARNESS_ROOT = root;
    // Dynamic, and after the env var: HARNESS_ROOT is read once at module load.
    const loaded = await import('./vela-drive.mjs');
    INTERNALS = loaded.INTERNALS;
    sessionFile = join(root, 'session.json');
  });

  afterAll(() => {
    delete process.env.VELA_HARNESS_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  /** The session a command holds in memory since `attach` — always readable. */
  const inMemory = () =>
    sessionWith(['up', [{ name: 'cdp.bootstrap' }]], ['type', TYPE_CDP_DEFAULTS]);

  it('CONTROL: when the file agrees, the run is read from the FILE', () => {
    const onDisk = sessionWith(['up', [{ name: 'cdp.bootstrap' }]]);
    // #2 is this command's own entry, still `open` — what `attach` leaves
    // behind. #3 is a second vela-drive process opening one while this command
    // runs; reading the file is the only way to see it, and seeing it is the
    // point.
    const mine = openEntry(onDisk, 'type');
    openEntry(onDisk, 'click');
    writeFileSync(sessionFile, JSON.stringify(onDisk), 'utf8');
    const prior = INTERNALS.runContext({ pid: 4321 }, mine);
    expect(prior.known).toBe(true);
    expect(prior.unaccounted).toEqual([{ seq: 3, command: 'click', state: 'concurrent' }]);
  });

  it('a ledger this command is not in is unknown, however well-formed it is', () => {
    // The lost write this file's bounds admit, and the ledger transplant they
    // do not mention: both leave a ledger that is current-version, consecutive,
    // stamped clean — and missing the entry `attach` wrote a moment ago.
    const transplanted = sessionWith(
      ['up', [{ name: 'cdp.bootstrap' }]],
      ['click', CLICK_OS_NO_SCROLL],
    );
    expect(priorTo(transplanted, 3).known).toBe(true); // well-formed by every earlier check
    writeFileSync(sessionFile, JSON.stringify(transplanted), 'utf8');
    const prior = INTERNALS.runContext({ pid: 4321 }, 3);
    expect(prior.known).toBe(false);
    expect(prior.unknownBecause).toContain('no longer contains entry #3');
    expect(focusRequireRefusal(prior, null).clause).toBe(FOCUS_REFUSALS.RUN_NOT_ESTABLISHED);
  });

  it("a ledger that declared this command's entry for it is unknown", () => {
    const meddled = sessionWith(['up', [{ name: 'cdp.bootstrap' }]]);
    const mine = openEntry(meddled, 'type');
    declareEntry(meddled, mine, [{ name: 'cdp.bootstrap' }]); // not mine to declare yet
    writeFileSync(sessionFile, JSON.stringify(meddled), 'utf8');
    const prior = INTERNALS.runContext({ pid: 4321 }, mine);
    expect(prior.known).toBe(false);
    expect(prior.unknownBecause).toContain('as `declared`');
  });

  it('an unreadable session file is unknown, NOT the copy held since attach', () => {
    writeFileSync(sessionFile, '{ this is not json', 'utf8');
    const held = inMemory();
    const prior = INTERNALS.runContext(held, 3);
    // The old code returned `priorTo(held, 3)` here — known, and one command
    // short of the truth, because an in-memory copy cannot contain a command
    // that ran alongside this one.
    expect(priorTo(held, 3).known).toBe(true);
    expect(prior.known).toBe(false);
    expect(prior.unknownBecause).toContain('could not be read');
    expect(focusRequireRefusal(prior, null).clause).toBe(FOCUS_REFUSALS.RUN_NOT_ESTABLISHED);
  });

  it('notMyLedger is a pure predicate, and says null when the entry is mine', () => {
    // RULE U for `state` on the command's own entry, and the reader
    // `runContext` calls. `null` is the only answer that lets a grade proceed.
    const session = sessionWith(['up', [{ name: 'cdp.bootstrap' }]]);
    const mine = openEntry(session, 'type');
    expect(notMyLedger(session, mine)).toBeNull();
    expect(notMyLedger(session, mine + 1)).toContain(`no longer contains entry #${mine + 1}`);
    expect(notMyLedger(session, 1)).toContain('as `declared`');
    expect(notMyLedger({}, 1)).toContain('no longer contains entry #1');
  });

  it('a missing session file is unknown, not an empty run', () => {
    rmSync(sessionFile, { force: true });
    const prior = INTERNALS.runContext(inMemory(), 3);
    expect(prior.known).toBe(false);
    expect(prior.unknownBecause).toContain('no session file');
  });

  it('a session file that now belongs to another window is unknown', () => {
    const other = sessionWith(['up', [{ name: 'cdp.bootstrap' }]]);
    other.pid = 999;
    writeFileSync(sessionFile, JSON.stringify(other), 'utf8');
    const prior = INTERNALS.runContext({ pid: 4321 }, 2);
    expect(prior.known).toBe(false);
    expect(prior.unknownBecause).toContain('now records pid 999');
  });

  it('readSessionOutcome says WHICH way it failed, which is why it exists', () => {
    rmSync(sessionFile, { force: true });
    expect(INTERNALS.readSessionOutcome()).toMatchObject({ session: null });
    expect(INTERNALS.readSessionOutcome().why).toContain('no session file');
    writeFileSync(sessionFile, 'nope', 'utf8');
    expect(INTERNALS.readSessionOutcome().why).toContain('could not be read');
    writeFileSync(sessionFile, JSON.stringify({ pid: 7 }), 'utf8');
    expect(INTERNALS.readSessionOutcome()).toEqual({ session: { pid: 7 }, why: null });
  });

  it('sessionForReport keeps the ledger out of every payload a command prints', () => {
    const session = sessionWith(['type', TYPE_CDP_DEFAULTS]);
    expect(session[LEDGER_KEY]).toBeDefined();
    const reported = INTERNALS.sessionForReport(session);
    expect(reported[LEDGER_KEY]).toBeUndefined();
    expect(reported.pid).toBe(4321);
    expect(INTERNALS.sessionForReport(null)).toBeNull();
  });
});

describe('the entry-point guard', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'vela-drive.mjs');

  it('the CLI still runs, and dispatches, when it is the entry point', () => {
    // The guard that made the block above possible is also the one thing that
    // could silently turn the whole harness into a no-op, and until this round
    // nothing in the suite ran vela-drive.mjs at all. Both of these reach
    // `main` and neither touches a session, a window or PowerShell.
    const help = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8' });
    expect(help.status).toBe(EXIT.OK);
    expect(help.stderr).toContain('vela-drive — launch Vela');

    const unknown = spawnSync(process.execPath, [cli, 'no-such-command'], { encoding: 'utf8' });
    expect(unknown.status).toBe(EXIT.USAGE);
    expect(unknown.stderr).toContain('unknown command "no-such-command"');
  });

  it('importing it does not run a command', () => {
    // The other half: if importing ran `main()`, the block above would have
    // executed an arbitrary command with vitest's own argv.
    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(cli).href)});` +
          " console.log('IMPORTED_ONLY');",
      ],
      { encoding: 'utf8' },
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('IMPORTED_ONLY');
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

  it('THE ONE if THE GATE STILL HANGS ON: commands.type calls it and throws on it', () => {
    // The critic deleted the whole gate and the suite did not notice. Its
    // clauses are executable now (see "the --focus require gate, every clause of
    // it, executed"), and this is the byte the sibling wiring assertions above
    // already had and it did not: that the decision is reached at all.
    const typeBody = text.slice(
      text.indexOf('commands.type = async'),
      text.indexOf('commands.key = async'),
    );
    expect(typeBody.length).toBeGreaterThan(200);
    expect(typeBody).toContain('const refusal = focusRequireRefusal(prior, focusOrigin);');
    expect(typeBody).toContain('if (refusal !== null) {');
    expect(typeBody).toContain('throw new HarnessError(EXIT.FAILED, refusal.message, {');
    expect(typeBody).toContain('refusedBy: refusal.clause,');
    // Reached before anything is typed: the refusal has to happen before the
    // SendInput call, not after it.
    expect(typeBody.indexOf('focusRequireRefusal')).toBeLessThan(typeBody.indexOf('osKeyboard('));
    // And exactly one call site, so there is no second copy of the decision to
    // drift away from this one.
    expect([...text.matchAll(/focusRequireRefusal\(/g)]).toHaveLength(1);
  });

  it('startRun is called once, by `up`, on the session `up` just built', () => {
    // `startRun` is the only thing allowed to claim a run has no history, and
    // the round-2 defect was `openEntry` making that claim for everybody.
    expect([...text.matchAll(/startRun\(/g)]).toHaveLength(1);
    // Bounded by the NEXT `commands.` definition, not by a named one: the
    // command list is not in the order the file defines it, and a slice that
    // ran past `up` would let this test pass on bytes from another command.
    const upStart = text.indexOf('commands.up = async');
    const upBody = text.slice(upStart, text.indexOf('\ncommands.', upStart + 1));
    expect(upBody).toContain('startRun(session);');
    expect(upBody.indexOf('startRun(session);')).toBeLessThan(
      upBody.indexOf("openEntry(session, 'up')"),
    );
    // ...and the object it is called on is the one `up` constructed a few
    // statements earlier, not one read back from disk. `up` does call
    // `readSession` — once, near the top, to decide whether it may launch at
    // all — and that call is nowhere near this one.
    const built = upBody.indexOf('const session = {');
    expect(built).toBeLessThan(upBody.indexOf('startRun(session);'));
    expect(upBody.slice(built)).not.toContain('readSession(');
  });

  it('each `.delivered` step is pushed only after the thing that confirms it', () => {
    // The attempt is declared before the call; the confirmation must not be, or
    // the split does nothing. Two push sites for the keyboard (type and key),
    // one for the mouse.
    expect([...text.matchAll(/'os\.sendInputKeyboard\.delivered'/g)]).toHaveLength(2);
    expect([...text.matchAll(/'os\.sendInputMouse\.delivered'/g)]).toHaveLength(1);
    // The mouse confirmation reads the page-side recorder's answer.
    expect(text).toContain(
      "if (via === 'os' && hit.landed === true) steps.push({ name: 'os.sendInputMouse.delivered' });",
    );
    expect(text.indexOf('const hit = await cdp.evaluate')).toBeLessThan(
      text.indexOf("steps.push({ name: 'os.sendInputMouse.delivered' })"),
    );
    // Each keyboard confirmation sits after its own `os.blocked || !os.delivered`
    // refusal, so a route that delivered nothing never reaches it.
    const blocks = text.split("steps.push({ name: 'os.sendInputKeyboard.delivered' });");
    expect(blocks).toHaveLength(3);
    for (const before of blocks.slice(0, 2)) {
      expect(before.lastIndexOf('if (os.blocked || !os.delivered) {')).toBeGreaterThan(
        before.lastIndexOf("{ name: 'os.sendInputKeyboard'"),
      );
    }
  });

  it('runContext refuses to answer rather than falling back to what it holds', () => {
    // Covered by execution in "runContext: the second member of the class"; this
    // pins that the two refusals are the ones in the shipped source, since that
    // block imports this file rather than reading it.
    const runContextBody = text.slice(
      text.indexOf('function runContext('),
      text.indexOf('// -----', text.indexOf('function runContext(')),
    );
    // Three refusals: cannot read the file, the file is another window's, and
    // the ledger is not the one this command wrote into.
    expect([...runContextBody.matchAll(/unknownRun\(/g)]).toHaveLength(3);
    expect(runContextBody).toContain('readSessionOutcome()');
    expect(runContextBody).toContain('notMyLedger(fresh.session, seq)');
    // The fallback that was the defect, in the bytes it had.
    expect(runContextBody).not.toContain('? fresh : session, seq)');
    expect(runContextBody).toContain('return priorTo(fresh.session, seq);');
  });

  it('attach opens the entry before it touches the page, and nothing else reads the ledger raw', () => {
    // FOUND BY MUTATION: deleting `openEntry` from `attach` left the whole
    // suite green.
    //
    // Why this replacement is a byte-presence assertion and not an execution:
    // `attach` connects a CDP socket to a live window and re-picks a target
    // from it, so there is no way to enter its body without a running Vela,
    // which this suite does not have. It is NOT because the module cannot be
    // loaded — it can, and this file does it, in the describe block named
    // "runContext: the second member of the class, executed against real
    // files", which is why vela-drive.mjs's entry-point guard exists. Any
    // function reachable without a socket belongs in that block instead of
    // here. What this one pins:
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
