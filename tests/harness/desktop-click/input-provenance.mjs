/**
 * Which half of a driving command went through the OS, and which half went
 * through CDP — composed into one answer, because the two halves were being
 * reported side by side and read as one.
 *
 * ## What was wrong, in the bytes
 *
 * `commands.click`, `commands.type` and `commands.key` in `vela-drive.mjs` each
 * return a boolean called `isOsInput`. Its value is decided by the route the
 * *keystrokes or button events* took, and by nothing else:
 *
 *     isOsInput: via === 'os',                       // commands.type, commands.key
 *     isOsInput: true,                               // commands.click, the --via os branch
 *
 * That answers "was the delivery OS input?". The question a reader actually
 * asks of it is the ladder's: "could this run have happened against an
 * installed app with no CDP attached?" Those are different questions, and on
 * this harness they have different answers, because CDP is used for more than
 * delivery on both OS paths:
 *
 * - `commands.type --via os` called `window.__velaHarness.focusStored(index)`
 *   before sending anything. `focusStored` in `page.mjs` runs
 *   `el.scrollIntoView(...)` and `el.focus()`. A user cannot do either without
 *   a hand: they click the field, or they tab to it. So the run's precondition
 *   was manufactured over CDP while `isOsInput: true` and the mechanism string
 *   `'... Not CDP. ...'` sat in the same object.
 * - `commands.type --via os --clear` additionally ran
 *   `document.activeElement.select()` over CDP.
 * - `commands.click --via os` calls `window.__velaHarness.pointFor(index)`,
 *   which runs `el.scrollIntoView(...)` on the way to computing the screen
 *   point. When the element was already on screen that call changes nothing;
 *   when it was not, the app was scrolled by the harness and the click that
 *   followed landed on a view the OS input never produced.
 *
 * This is the same shape as the mount defect one level down. There the guard
 * asked "did the string 'complete' come back?" and a reader took it for "is
 * Vela up". Here the guard asks "did the button events go through SendInput?"
 * and a reader takes it for "this is `reaches-user`". In both cases the fields
 * that would have decided the real question existed in the same JSON object and
 * were read by nothing — RULE U. `grep -rn isOsInput` over this tree finds two
 * README table cells, its own definitions, and no reader.
 *
 * ## What this file does instead
 *
 * A command declares the steps it took as `{ name, channel, kind, why }` and
 * gets back one composed verdict. The composition is the point: no caller may
 * quote the delivery channel without the substitutions that made it possible.
 *
 * `kind` is the distinction that carries the whole grade, so it is three
 * values and not two:
 *
 * - `read` — CDP asked the page a question. Reading `document.activeElement`
 *   after typing is how we find out whether the keystrokes arrived; it is a
 *   verification channel and substitutes for nothing. An installed app with no
 *   CDP would need some other way to check, but the *driving* would be
 *   unchanged.
 * - `instrument` — CDP installed harness-owned state the application never
 *   reads: the `BOOTSTRAP` bundle, the node store `resolve` fills, the capture
 *   -phase pointer recorder. It changes what the harness can see, not what the
 *   app does.
 * - `act` — CDP did something a user would have had to do with a hand or an
 *   eye: focus an element, scroll the view, select text, insert text, dispatch
 *   an input event. **This is the only kind that substitutes**, and one of them
 *   is enough to cap the run.
 *
 * ## The next-level defect this fix carries, stated rather than hidden
 *
 * `kind` is declared by the call site, not derived from what CDP actually did.
 * A step added later with the wrong `kind` grades wrong and nothing here can
 * tell. Two mitigations, neither complete: `KNOWN_STEPS` names every step this
 * harness takes together with its kind and the reason, so a new one is a diff
 * in a table a reviewer reads rather than an inline literal; and
 * `gradeInputProvenance` refuses a step whose name is not in that table, so
 * adding a call site without classifying it is a hard error and not a silent
 * pass. What neither can do is stop someone classifying a genuine `act` as a
 * `read`. The honest bound is: this composes correctly over a declaration it
 * cannot verify.
 *
 * A second one, smaller: `pointFor`'s scroll is graded on whether the
 * element's client rect moved, which detects scrolling of any ancestor but
 * would not detect a `scrollIntoView` that moved a *sibling* scroller without
 * moving the target. That is not reachable from `scrollIntoView(el)` on this
 * page, and I did not prove it is unreachable in general.
 *
 * A third, stated so nobody has to find it: **`os.raise` is an act, and it does
 * not cap.** Every OS-route command calls `SetForegroundWindow` on the session
 * window first, which is something a user does by clicking the window or its
 * taskbar button. It is classified `act` on the `os` channel, and only *CDP*
 * acts set `substituted`, so a raise leaves the ceiling at
 * `os-input-unsubstituted`. The argument for that: it goes through a Win32 API
 * rather than through a debugger attached to the renderer, it is the same call
 * a shell makes when you alt-tab, and `os-input.ps1` refuses to send anything
 * if the foreground does not then belong to this session — so it cannot type
 * into somebody else's window. The argument against it, which I am not
 * dismissing: `SetForegroundWindow` is not the system input queue, and a run
 * that needed the harness to raise the window is one notch away from a user who
 * had it in front already. It is visible in `acts` on every result, so a reader
 * who disagrees with the classification can see the step and discount it.
 */

/** No colour value is defined, read or written anywhere in this file. */

/**
 * Every step any driving command in this harness takes, with the kind it is
 * graded as and why.
 *
 * A step name not in here is refused rather than graded, so a new CDP call site
 * cannot join a `--via os` path without someone deciding, in this table, what
 * it substitutes for.
 */
export const KNOWN_STEPS = {
  'cdp.bootstrap': {
    kind: 'instrument',
    why: 'evaluates page.mjs BOOTSTRAP, defining window.__velaHarness. The application never reads it.',
  },
  'cdp.resolve': {
    kind: 'instrument',
    why: 'runs the query and stores the live nodes on the harness object. Reads the DOM; writes only harness state.',
  },
  'cdp.describeStored': { kind: 'read', why: 'describes a stored node. No side effect.' },
  'cdp.digest': { kind: 'read', why: 'fingerprints the visible text before and after. No side effect.' },
  'cdp.focusState': {
    kind: 'read',
    why: 'reads document.activeElement and compares it with the stored target. Does NOT focus anything.',
  },
  'cdp.readActiveElement': {
    kind: 'read',
    why: 'reads the focused element and its value afterwards, which is how the harness finds out whether the keystrokes arrived.',
  },
  'cdp.armPointerRecorder': {
    kind: 'instrument',
    why: 'installs a capture-phase pointer listener at the window so the page reports what the engine hit. The app cannot see it.',
  },
  'cdp.pointerHit': { kind: 'read', why: 'reads back what the recorder captured. No side effect.' },
  'cdp.focusStored': {
    kind: 'act',
    why: 'calls el.focus() and el.scrollIntoView(). A user reaches a field by clicking or tabbing to it; this is a hand the run did not have.',
  },
  'cdp.selectAll': {
    kind: 'act',
    why: 'calls activeElement.select(). Selecting text is a user action, and the Backspace that follows depends on it.',
  },
  'cdp.insertText': {
    kind: 'act',
    why: 'CDP Input.insertText. The value enters the editing pipeline with no key events at all.',
  },
  'cdp.dispatchKeyEvent': { kind: 'act', why: 'CDP Input.dispatchKeyEvent. The browser input pipeline, not the OS.' },
  'cdp.dispatchMouseEvent': {
    kind: 'act',
    why: 'CDP Input.dispatchMouseEvent. Enters ahead of hit-testing; no OS message exists.',
  },
  'cdp.pointFor.scroll': {
    kind: 'act',
    why: 'pointFor called el.scrollIntoView() AND the element moved, so the harness scrolled the app before aiming at it.',
  },
  'cdp.pointFor.measure': {
    kind: 'read',
    why: 'pointFor called el.scrollIntoView() and nothing moved, so it only measured the rect and the topmost element at the point.',
  },
  'os.raise': {
    kind: 'act',
    why: 'SetForegroundWindow on the session window. A user brings a window forward; this does it for them, through the OS rather than through CDP.',
  },
  'os.sendInputMouse': { kind: 'act', why: 'Win32 SendInput MOUSEEVENTF_LEFTDOWN/LEFTUP in the system input queue.' },
  'os.sendInputKeyboard': { kind: 'act', why: 'Win32 SendInput INPUT_KEYBOARD in the system input queue.' },
  'os.postMessage': {
    kind: 'act',
    why: 'Win32 PostMessage to the WebView2 child window. A real window message, but it never entered the system input queue.',
  },
};

/** The ceilings, most capable last. Named so nobody can paste a ladder tier out of a field. */
export const CEILINGS = {
  /** CDP did something a user would have had to do. Nothing above dev-clicked is available from this run. */
  DEV_CLICKED: 'dev-clicked',
  /**
   * Every acting step went through the OS. CDP was used only to look and to
   * instrument. This is the *delivery half* of `reaches-user` and not the tier:
   * the other half is an installed bundle, which this harness cannot attest.
   */
  UNSUBSTITUTED: 'os-input-unsubstituted',
};

/**
 * Composes one command's steps into a single answer.
 *
 * @param {object} input
 * @param {'os'|'message'|'cdp'} input.delivery  how the input events themselves were delivered.
 * @param {Array<{name: string, detail?: object}>} input.steps  in the order taken.
 * @returns {{delivery: string, substituted: boolean, substitutions: object[], acts: object[],
 *   reads: object[], instruments: object[], steps: object[], ladderCeiling: string,
 *   verdict: string, entails: object}}
 */
export function gradeInputProvenance({ delivery, steps }) {
  if (delivery !== 'os' && delivery !== 'message' && delivery !== 'cdp') {
    throw new Error(`gradeInputProvenance: delivery must be os, message or cdp, got ${delivery}`);
  }
  const resolved = (steps ?? []).map((step) => {
    const known = KNOWN_STEPS[step.name];
    if (known === undefined) {
      // Refusing is the point. A CDP call site added to an OS path without an
      // entry here would otherwise grade as if it had not happened.
      throw new Error(
        `gradeInputProvenance: unknown step "${step.name}". Add it to KNOWN_STEPS with the kind ` +
          'it substitutes for (read | instrument | act) before using it on a driving path.',
      );
    }
    return {
      name: step.name,
      channel: step.name.startsWith('os.') ? 'os' : 'cdp',
      kind: known.kind,
      why: known.why,
      ...(step.detail === undefined ? {} : { detail: step.detail }),
    };
  });

  const acts = resolved.filter((s) => s.kind === 'act');
  const substitutions = acts.filter((s) => s.channel === 'cdp');
  const substituted = substitutions.length > 0;
  const ladderCeiling =
    delivery === 'os' && !substituted ? CEILINGS.UNSUBSTITUTED : CEILINGS.DEV_CLICKED;

  return {
    delivery,
    substituted,
    substitutions,
    acts,
    reads: resolved.filter((s) => s.kind === 'read'),
    instruments: resolved.filter((s) => s.kind === 'instrument'),
    steps: resolved,
    ladderCeiling,
    verdict:
      ladderCeiling === CEILINGS.UNSUBSTITUTED
        ? 'every acting step went through the OS; CDP was used only to look and to instrument'
        : `CDP DID THE WORK OF A USER on this run: ${
            substituted ? substitutions.map((s) => s.name).join(', ') : `delivery was "${delivery}", not OS input`
          }`,
    entails: ENTAILS[ladderCeiling],
  };
}

const ENTAILS = {
  [CEILINGS.UNSUBSTITUTED]: {
    does:
      'the button or key events entered the system input queue, and no CDP call on this run did ' +
      'anything a user would have had to do. The same sequence would drive an app with no CDP ' +
      'attached.',
    doesNot:
      'reach `reaches-user`. That tier also requires an app installed from the produced bundle and ' +
      'launched as a user launches it, and app data resolving where it resolves on a real machine. ' +
      'This harness launches a built binary and knows nothing about an installer, so it can attest ' +
      'the delivery half and not the tier. It also does not entail that the keystrokes landed ' +
      'anywhere useful: read the verification fields for that.',
  },
  [CEILINGS.DEV_CLICKED]: {
    does:
      'the command drove the running app and the app responded. That is real progress and it is ' +
      '`dev-clicked`.',
    doesNot:
      'support any claim above `dev-clicked`, because CDP did something on this run that a user ' +
      'would have had to do with a hand or an eye. See `substitutions` for which step, and `why` ' +
      'for what it stood in for.',
  },
};
