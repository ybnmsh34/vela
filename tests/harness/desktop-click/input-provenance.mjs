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
 * were read by nothing — RULE U. Measured at the graded tag c0feb93,
 * `grep -rn isOsInput` over this directory hit 8 lines in 2 files: one prose
 * line and one table header in README.md, and in vela-drive.mjs one comment
 * plus its five definitions. NOTHING READ IT. Measured again in the tree this
 * comment is committed in: 24 lines in 4 files, all of them prose, definitions
 * or a test name, and still nothing reads it — which is fine now, because
 * `provenance` is the field that is meant to be read.
 *
 * ## What this file does instead
 *
 * A command declares the steps it took by name, gets each resolved out of
 * `KNOWN_STEPS` to `{ name, channel, kind, movesFocus, why }` — plus
 * `userEquivalent` when the kind is `act` — and gets back one composed verdict. The composition is the point: no caller may
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
 * ## The frame this grade is drawn around
 *
 * ONE COMMAND'S STEPS IS THE WRONG FRAME AND THIS FILE SHIPPED IT ONCE.
 * `gradeInputProvenance` used to see only the steps handed to it, while
 * `entails.does` claimed "no CDP call on this run did anything a user would
 * have had to do". A third agent falsified that with two documented commands at
 * their default flags: `type --via cdp` (default `--focus cdp`) focuses the
 * field over CDP and grades itself honestly at `dev-clicked`; `type --via os`
 * (default `--focus require`) then finds the field focused, does not refuse,
 * and grades `os-input-unsubstituted`. The precondition was manufactured over
 * CDP one command earlier, and the remedy had made it worse — before the
 * refusal existed, the CDP focus at least happened inside the graded command.
 *
 * So `prior` is now a required argument and the frame is the RUN. See
 * `run-ledger.mjs` for what is recorded, how, and what it still cannot see. The
 * general shape, worth naming because it will recur: **a guard whose frame is
 * narrower than the claim its output is quoted for.** The frame moved from
 * "delivery" to "this command's steps" to "this session's commands", and the
 * next one out is "this machine" — a hand on the real keyboard, or a second CDP
 * client on the port, is outside every frame here.
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
 *
 * THIS LIST IS NOT CLOSED, and the last round is why the sentence is here. The
 * first version of this header named three bounds and read as a complete
 * disclosure; the defect that mattered was a fourth one it did not name — the
 * frame, above. A reader who takes an enumeration of bounds for an enumeration
 * of ALL bounds has been misled by it, and the honest thing to say is that
 * these are the ones I found.
 */

/** No colour value is defined, read or written anywhere in this file. */

/**
 * Every step any command in this harness takes against the page, with the kind
 * it is graded as, whether it can move DOM focus, and why.
 *
 * A step name not in here is refused rather than graded, so a new CDP call site
 * cannot join a `--via os` path without someone deciding, in this table, what
 * it substitutes for.
 *
 * `userEquivalent` is required on every `act` and forbidden on everything else.
 * It asks: could a user have produced this, themselves, by this route? A user
 * brings a window forward by clicking it, so `os.raise` is one. A user cannot
 * post a `WM_LBUTTONDOWN` straight to a child window they picked by handle, and
 * cannot attach a debugger to the renderer, so `os.postMessage` and every
 * `cdp.*` act are not. **This, not the channel prefix, is what substitutes** —
 * and the difference is not academic: grading on the prefix let a
 * `click --via message` launder focus into a later `type --via os` that then
 * reported `os-input-unsubstituted`, because `os.postMessage` starts with `os.`
 * and no CDP act had occurred. Literally true about CDP; false about the run.
 *
 * `movesFocus` is another column and it is a separate question from `kind`.
 * `kind` decides whether a step caps the run it is in; `movesFocus` decides
 * whether a step can be the reason a LATER command finds its target already
 * focused. `cdp.selectAll` is an act that does not move focus — it selects
 * inside whatever is already focused. `os.raise` moves the foreground window
 * and not `document.activeElement`. Both distinctions are read by
 * `run-ledger.mjs`'s `lastFocusMove`, which is what `type --focus require`
 * asks before believing the focus it finds.
 */
export const KNOWN_STEPS = {
  'cdp.bootstrap': {
    kind: 'instrument',
    movesFocus: false,
    why: 'evaluates page.mjs BOOTSTRAP, defining window.__velaHarness. The application never reads it.',
  },
  'cdp.resolve': {
    kind: 'instrument',
    movesFocus: false,
    why: 'runs the query and stores the live nodes on the harness object. Reads the DOM; writes only harness state.',
  },
  'cdp.describeStored': { kind: 'read', movesFocus: false, why: 'describes a stored node. No side effect.' },
  'cdp.digest': {
    kind: 'read',
    movesFocus: false,
    why: 'fingerprints the visible text before and after. No side effect.',
  },
  'cdp.visibleText': {
    kind: 'read',
    movesFocus: false,
    why: 'reads innerText off the selector root and splits it into lines for the `read` command. No side effect.',
  },
  'cdp.mountReport': {
    kind: 'read',
    movesFocus: false,
    why: 'collects the mount evidence mount-grade.mjs grades — root children, script sources, react container key. No side effect.',
  },
  'cdp.screenshot': {
    kind: 'read',
    movesFocus: false,
    why: 'CDP Page.captureScreenshot. Copies pixels out of the compositor and changes nothing in the page.',
  },
  'cdp.focusState': {
    kind: 'read',
    movesFocus: false,
    why: 'reads document.activeElement and compares it with the stored target. Does NOT focus anything.',
  },
  'cdp.readActiveElement': {
    kind: 'read',
    movesFocus: false,
    why: 'reads the focused element and its value afterwards, which is how the harness finds out whether the keystrokes arrived.',
  },
  'cdp.armPointerRecorder': {
    kind: 'instrument',
    movesFocus: false,
    why: 'installs a capture-phase pointer listener at the window so the page reports what the engine hit. The app cannot see it.',
  },
  'cdp.pointerHit': {
    kind: 'read',
    movesFocus: false,
    why: 'reads back what the recorder captured. No side effect.',
  },
  'cdp.focusStored': {
    kind: 'act',
    userEquivalent: false,
    movesFocus: true,
    why: 'calls el.focus() and el.scrollIntoView(). A user reaches a field by clicking or tabbing to it; this is a hand the run did not have.',
  },
  'cdp.selectAll': {
    kind: 'act',
    userEquivalent: false,
    movesFocus: false,
    why: 'calls activeElement.select(). Selecting text is a user action, and the Backspace that follows depends on it — but it selects inside the element that already had focus and does not move focus itself.',
  },
  'cdp.insertText': {
    kind: 'act',
    userEquivalent: false,
    movesFocus: false,
    why: 'CDP Input.insertText. The value enters the editing pipeline of the already-focused element with no key events at all.',
  },
  'cdp.dispatchKeyEvent': {
    kind: 'act',
    userEquivalent: false,
    movesFocus: true,
    why: 'CDP Input.dispatchKeyEvent. The browser input pipeline, not the OS — and a synthesised Tab moves focus exactly as a real one would.',
  },
  'cdp.dispatchMouseEvent': {
    kind: 'act',
    userEquivalent: false,
    movesFocus: true,
    why: 'CDP Input.dispatchMouseEvent. Enters ahead of hit-testing; no OS message exists. A press focuses what it lands on.',
  },
  'cdp.eval': {
    kind: 'act',
    userEquivalent: false,
    movesFocus: true,
    why: 'an arbitrary expression sent by the `eval` command. Nothing here can tell what it contained, so it is graded as the most it could have been: an act that moved focus. Use `read`, `find` or `status` when you want a channel that does not cap the run.',
  },
  'cdp.pointFor.scroll': {
    kind: 'act',
    userEquivalent: false,
    movesFocus: false,
    why: 'pointFor called el.scrollIntoView() AND the element moved, so the harness scrolled the app before aiming at it. Scrolling does not focus.',
  },
  'cdp.pointFor.measure': {
    kind: 'read',
    movesFocus: false,
    why: 'pointFor called el.scrollIntoView() and nothing moved, so it only measured the rect and the topmost element at the point.',
  },
  'os.raise': {
    kind: 'act',
    userEquivalent: true,
    movesFocus: false,
    why: 'SetForegroundWindow on the session window. A user brings a window forward; this does it for them, through the OS rather than through CDP. It changes which window is foreground, not which element inside the document has focus.',
  },
  // ATTEMPTED, then CONFIRMED — the two halves of each OS input step.
  //
  // Every step in this table is pushed BEFORE the call it names, so that a
  // command killed part-way over-declares rather than under-declares. For the
  // ceiling that is the safe direction. For `--focus require` it was the unsafe
  // one, and it was a real hole: a `click --via os` whose SendInput was blocked
  // (another window owns the pixel; the .ps1 sends nothing and says so) still
  // wrote a user-equivalent focus move into the ledger, and a later
  // `type --via os` read that entry as the hand that focused the field —
  // masking whatever CDP act actually had. A declaration is not evidence that
  // anything happened.
  //
  // So the attempt carries `movesFocus: false` and cannot supply focus to
  // anyone, while the `.delivered` step — pushed only once the harness holds
  // the confirmation named in its `why` — is the one `lastFocusMove` accepts.
  // Both stay `userEquivalent: true`: an OS attempt is not a substitution
  // whether or not it landed, and the ceiling reading was never the broken one.
  'os.sendInputMouse': {
    kind: 'act',
    userEquivalent: true,
    movesFocus: false,
    why: 'Win32 SendInput MOUSEEVENTF_LEFTDOWN/LEFTUP was ATTEMPTED. Declared before the call, so it may have delivered nothing — os-input.ps1 sends nothing at all when another process owns the pixel. Not evidence that focus moved; see os.sendInputMouse.delivered.',
  },
  'os.sendInputMouse.delivered': {
    kind: 'act',
    userEquivalent: true,
    movesFocus: true,
    why: 'the page-side pointer recorder captured a pointer event after the SendInput press, which is the evidence os-input.ps1 itself names as the real one — SendInput returning 2 is not. A press focuses what it lands on.',
  },
  'os.sendInputKeyboard': {
    kind: 'act',
    userEquivalent: true,
    movesFocus: false,
    why: 'Win32 SendInput INPUT_KEYBOARD was ATTEMPTED. Declared before the call, so it may have delivered nothing — os-input.ps1 refuses to send when the foreground window is not this session. Not evidence that focus moved; see os.sendInputKeyboard.delivered.',
  },
  'os.sendInputKeyboard.delivered': {
    kind: 'act',
    userEquivalent: true,
    movesFocus: true,
    why: 'os-input.ps1 reported the keystrokes accepted, not blocked, and its keyboard self-test observed its own injected keystroke first. Tab and Shift+Tab move focus, so this is treated as a focus move whatever key it carried.',
  },
  'os.postMessage': {
    kind: 'act',
    userEquivalent: false,
    movesFocus: true,
    why: 'Win32 PostMessage to the WebView2 child window. A real window message, but it never entered the system input queue. A press focuses what it lands on.',
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

/** Why the run landed on the ceiling it did. Selects the `entails` wording. */
export const REASONS = {
  /** Every act in the whole run went through the OS. */
  CLEAN: 'every-act-was-os',
  /** A CDP act happened somewhere in the run — this command or an earlier one. */
  SUBSTITUTED: 'cdp-did-a-users-work',
  /** No CDP act, but the input events themselves did not come from the OS. */
  DELIVERY: 'delivery-was-not-os-input',
  /** The run cannot be established: no ledger, or a command that never declared. */
  UNACCOUNTED: 'earlier-commands-not-accounted-for',
};

/**
 * Composes a command's steps AND everything the run did before it into a single
 * answer.
 *
 * `prior` is required and has no default. That is the fix for the defect the
 * first version of this function shipped: it graded one command's six lines and
 * its `entails` string made a claim about the run, so a CDP act in an earlier
 * command was invisible to the strongest grade the harness issues. There is no
 * way to call this without answering "what happened before"; `emptyRun()` in
 * `run-ledger.mjs` is how you say "nothing did", and that is a positive claim
 * rather than an omission.
 *
 * The report keeps both frames rather than collapsing them, because they are
 * different questions and the reader deserves to see the narrower one too. The
 * top-level `substituted`, `substitutions` and `ladderCeiling` are the RUN
 * answer — the conservative one, and the one the README tells readers to quote.
 * `command.*` is this command alone.
 *
 * @param {object} input
 * @param {'os'|'message'|'cdp'} input.delivery  how the input events themselves were delivered.
 * @param {Array<{name: string, detail?: object}>} input.steps  in the order taken.
 * @param {{known: boolean, entries: Array<{seq:number, command:string, steps:string[]}>,
 *   unaccounted: Array<{seq:number, command:string, state:string}>}} input.prior
 *   what the session recorded before this command. From `priorTo()`.
 * @returns {{delivery: string, substituted: boolean, substitutions: object[], acts: object[],
 *   reads: object[], instruments: object[], steps: object[], command: object, run: object,
 *   reason: string, ladderCeiling: string, verdict: string, entails: object}}
 */
export function gradeInputProvenance({ delivery, steps, prior }) {
  if (delivery !== 'os' && delivery !== 'message' && delivery !== 'cdp') {
    throw new Error(`gradeInputProvenance: delivery must be os, message or cdp, got ${delivery}`);
  }
  if (prior === undefined || prior === null || typeof prior.known !== 'boolean') {
    throw new Error(
      'gradeInputProvenance: `prior` is required — this grade is about a run, not about one ' +
        'command. Pass priorTo(session, seq) from run-ledger.mjs, or emptyRun() to state that ' +
        'nothing ran before this.',
    );
  }
  const resolved = (steps ?? []).map((step) => resolveStep(step.name, step.detail));

  const acts = resolved.filter((s) => s.kind === 'act');
  // An act substitutes when A USER COULD NOT HAVE DONE IT THEMSELVES, not when
  // it happens to be spelled `cdp.`. See KNOWN_STEPS: `os.postMessage` is an
  // `os.` step a user has no route to, and grading on the prefix let it launder.
  const commandSubstitutions = acts.filter((s) => s.userEquivalent === false);
  const commandSubstituted = commandSubstitutions.length > 0;
  const commandCeiling =
    delivery === 'os' && !commandSubstituted ? CEILINGS.UNSUBSTITUTED : CEILINGS.DEV_CLICKED;

  // Everything the earlier commands of this session did that a user would have
  // had to do. Each carries the command and seq it came from, so a capped run
  // names the command that capped it and not merely the step.
  const priorSubstitutions = [];
  for (const entry of prior.entries) {
    for (const name of entry.steps) {
      const step = resolveStep(name);
      if (step.kind === 'act' && step.userEquivalent === false) {
        priorSubstitutions.push({ ...step, command: entry.command, seq: entry.seq });
      }
    }
  }

  const unaccounted = prior.unaccounted ?? [];
  const runKnown = prior.known === true && unaccounted.length === 0;
  const runSubstitutions = [...priorSubstitutions, ...commandSubstitutions];
  // `null`, not `false`, when the run cannot be established. "Nothing was
  // recorded" and "nothing happened" are different answers.
  const runSubstituted = runKnown ? runSubstitutions.length > 0 : null;
  const ladderCeiling =
    delivery === 'os' && runSubstituted === false ? CEILINGS.UNSUBSTITUTED : CEILINGS.DEV_CLICKED;

  const reason = !runKnown
    ? REASONS.UNACCOUNTED
    : runSubstituted
      ? REASONS.SUBSTITUTED
      : delivery === 'os'
        ? REASONS.CLEAN
        : REASONS.DELIVERY;

  return {
    delivery,
    // Run-scoped, deliberately. The narrow answer is one field down, under
    // `command`, and the field a caller reaches for first is the safe one.
    substituted: runSubstituted,
    substitutions: runSubstitutions,
    acts,
    reads: resolved.filter((s) => s.kind === 'read'),
    instruments: resolved.filter((s) => s.kind === 'instrument'),
    steps: resolved,
    command: {
      scope: 'this command only',
      substituted: commandSubstituted,
      substitutions: commandSubstitutions,
      ceiling: commandCeiling,
    },
    run: {
      scope: 'every command recorded against this session, this one included',
      known: runKnown,
      priorCommands: prior.entries.length,
      priorSubstitutions,
      unaccounted,
      ...(prior.known === true ? {} : { unknownBecause: prior.unknownBecause }),
      ...(unaccounted.length === 0
        ? {}
        : {
            unaccountedMeans:
              'commands in this session whose steps cannot be read. `open` and `undeclared` are ' +
              'commands that attached and never said what they did — killed part-way, or a ' +
              'command that does not record its steps. `concurrent` is a command from another ' +
              'vela-drive process that ran DURING this one. Any of them may have done anything, ' +
              'so no run containing one can be graded above dev-clicked.',
          }),
    },
    reason,
    ladderCeiling,
    verdict: VERDICTS[reason](runSubstitutions, delivery, unaccounted),
    entails: ENTAILS[reason],
  };
}

function resolveStep(name, detail) {
  const known = KNOWN_STEPS[name];
  if (known === undefined) {
    // Refusing is the point. A CDP call site added to an OS path without an
    // entry here would otherwise grade as if it had not happened.
    throw new Error(
      `gradeInputProvenance: unknown step "${name}". Add it to KNOWN_STEPS with the kind ` +
        'it substitutes for (read | instrument | act) before using it on a driving path.',
    );
  }
  // The two required-shape checks are here rather than in a test, so a step
  // added without them is a hard error on the driving path and not a silent
  // pass one release later.
  if (known.kind === 'act' && typeof known.userEquivalent !== 'boolean') {
    throw new Error(
      `KNOWN_STEPS["${name}"] is an act and does not declare userEquivalent. Every act must say ` +
        'whether a user could have produced it themselves by this route; that, not the name ' +
        'prefix, is what decides whether it substitutes.',
    );
  }
  if (known.kind !== 'act' && known.userEquivalent !== undefined) {
    throw new Error(
      `KNOWN_STEPS["${name}"] is a ${known.kind} and declares userEquivalent. Only an act can do ` +
        'the work of a user, so only an act answers that question.',
    );
  }
  return {
    name,
    channel: name.startsWith('os.') ? 'os' : 'cdp',
    kind: known.kind,
    movesFocus: known.movesFocus,
    ...(known.kind === 'act' ? { userEquivalent: known.userEquivalent } : {}),
    why: known.why,
    ...(detail === undefined ? {} : { detail }),
  };
}

const VERDICTS = {
  [REASONS.CLEAN]: () =>
    'every acting step went through the OS; CDP was used only to look and to instrument',
  [REASONS.SUBSTITUTED]: (substitutions) =>
    `SOMETHING A USER HAS NO ROUTE TO DID THE WORK OF A USER on this run: ${substitutions
      .map((s) => (s.command === undefined ? s.name : `${s.name} (${s.command} #${s.seq})`))
      .join(', ')}`,
  [REASONS.DELIVERY]: (_substitutions, delivery) =>
    `SOMETHING A USER HAS NO ROUTE TO DID THE WORK OF A USER on this run: delivery was ` +
    `"${delivery}", not OS input`,
  [REASONS.UNACCOUNTED]: (_substitutions, _delivery, unaccounted) =>
    'THIS RUN CANNOT BE GRADED ABOVE dev-clicked: ' +
    (unaccounted.length === 0
      ? 'the session carries no readable run ledger, so what earlier commands did is unknown'
      : `${unaccounted.length} command(s) in this session cannot be accounted for — ${unaccounted
          .map((entry) => `${entry.command} #${entry.seq} (${entry.state})`)
          .join(', ')}`),
};

const ENTAILS = {
  [REASONS.CLEAN]: {
    does:
      'the button or key events entered the system input queue, and nothing recorded against this ' +
      'session — by this command or by any command before it — did the work of a user by a route ' +
      'a user has no access to. The same sequence would drive an app with no CDP attached.',
    doesNot:
      'reach `reaches-user`. That tier also requires an app installed from the produced bundle and ' +
      'launched as a user launches it, and app data resolving where it resolves on a real machine. ' +
      'This harness launches a built binary and knows nothing about an installer, so it can attest ' +
      'the delivery half and not the tier. It also does not entail that the keystrokes landed ' +
      'anywhere useful: read the verification fields for that. And it is a claim about what THIS ' +
      'HARNESS did: a second CDP client on the port, or a hand on the real keyboard, is not in the ' +
      'ledger and cannot be.',
  },
  [REASONS.SUBSTITUTED]: {
    does:
      'the command drove the running app and the app responded. That is real progress and it is ' +
      '`dev-clicked`.',
    doesNot:
      'support any claim above `dev-clicked`, because something in this run did what a user would ' +
      'have had to do with a hand or an eye, by a route a user has no access to — CDP, or a ' +
      'window message posted straight to a child window the harness picked by handle. See ' +
      '`substitutions` for which step and which command, and `why` for what it stood in for. A ' +
      'step from an earlier command counts: the claim is about the sequence, and an app driven ' +
      'only by hand could not have reached this state.',
  },
  [REASONS.DELIVERY]: {
    does:
      'the command drove the running app and the app responded. That is real progress and it is ' +
      '`dev-clicked`.',
    doesNot:
      'support any claim above `dev-clicked`: the input events themselves did not come from the ' +
      'OS, whatever else the run did or did not do.',
  },
  [REASONS.UNACCOUNTED]: {
    does:
      'the command drove the running app and the app responded. That is real progress and it is ' +
      '`dev-clicked`.',
    doesNot:
      'support any claim above `dev-clicked`, and NOT because something was caught doing the ' +
      'work of a user — because the run cannot be established at all. See `run.unknownBecause` or ' +
      '`run.unaccounted`. An unestablished run is graded as a capped one on purpose: the ' +
      'alternative is to read silence as innocence, which is the defect this whole file exists ' +
      'to stop.',
  },
};
