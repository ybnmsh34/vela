/**
 * What happened EARLIER IN THIS SESSION, so a command can be graded over the
 * run it is part of rather than over its own six lines.
 *
 * ## The defect this file exists for
 *
 * `gradeInputProvenance` was correct about one command and was quoted as a
 * claim about a run. `input-provenance.mjs`'s `ENTAILS[UNSUBSTITUTED].does`
 * said, in the result of every `--via os` command that graded clean:
 *
 *     "no CDP call on this run did anything a user would have had to do. The
 *      same sequence would drive an app with no CDP attached."
 *
 * Two documented commands at their default flags falsified it:
 *
 *     vela-drive type --via cdp --value x --selector #q   # --focus cdp default
 *     vela-drive type --via os  --value y --selector #q   # --focus require default
 *
 * The first calls `focusStored` — `el.focus()` and `el.scrollIntoView()` — and
 * grades itself honestly at `dev-clicked`. The second then finds
 * `focusStateOf(index).storedIsActive === true`, because focus is still exactly
 * where the first command's CDP call put it. The refusal does not fire. The
 * command reports `substituted: false`, `focusVia: "require"` and
 * `ladderCeiling: "os-input-unsubstituted"` — the strongest grade the harness
 * issues — about a sequence whose precondition CDP manufactured.
 *
 * The class is not "focus". The class is: **a command's grade rests on state,
 * and any earlier command in the session may have manufactured that state over
 * CDP.** Nothing was written down, so nothing could be asked. The field the
 * gate reads, `focusStateOf(index).storedIsActive`, is `Boolean(el) && active
 * === el` in page.mjs — a DOM comparison, which can say where focus is and can
 * never say who put it there.
 *
 * ## What is written down
 *
 * One entry per command that attaches to the session, persisted inside the
 * session file so it lives exactly as long as the window does — `down` removes
 * the session and with it the ledger, because a new `up` is a new run.
 *
 * Each entry is opened by `attach` BEFORE the command does anything, and
 * declared at the end from the same `steps` array the command hands to
 * `gradeInputProvenance`. It is the same array, not a copy of it, so the ledger
 * cannot describe a different command from the one that was graded.
 *
 * An entry that is never declared stays `open`. That is the fail-closed
 * direction and it is deliberate: a command killed halfway through, or a future
 * command that attaches without declaring its steps, leaves a hole in the run,
 * and a hole means later commands cannot be graded above `dev-clicked` and
 * `type --via os --focus require` refuses. Forgetting is not a silent pass.
 *
 * ## What this cannot do — the bounds, stated
 *
 * - It records what THIS HARNESS did. Another CDP client on the same port,
 *   another process sending input, or a human touching the window are all
 *   invisible to it, and `--focus require` would read their focus move as the
 *   application's own. The harness refuses to launch a second `vela.exe` and
 *   proves the port belongs to the session pid on every command, which narrows
 *   this and does not close it.
 * - `movesFocus` is declared per step in `KNOWN_STEPS`, exactly as `kind` is,
 *   and inherits that bound: it is a claim about what a call site can do, not a
 *   derivation from what it did. `cdp.eval` is the case where the declaration
 *   is deliberately the maximum — an arbitrary expression can focus, scroll,
 *   click or type, so it is graded as an act that moves focus whatever it
 *   actually contained.
 * - Steps are pushed before the CDP call they name, so a command that throws
 *   mid-way declares a step that may not have run. That over-declares, which
 *   caps more runs than strictly necessary and never fewer.
 * - Two vela-drive processes running against one session read-modify-write the
 *   same file and can lose an entry. There is no lock. What there IS: the run
 *   is re-read from disk at the moment it is used rather than snapshotted at
 *   attach, so an entry with a higher sequence number than mine shows up as
 *   `concurrent` and caps me. That covers the case where the other process
 *   wrote its entry; it does not cover the case where the two writes raced and
 *   one was lost.
 * - Sequence numbers are consecutive by construction, so an entry CUT OUT OF
 *   THE MIDDLE of the ledger is detectable and is reported as an unreadable
 *   ledger. An entry cut off the END is not detectable and is not claimed to be.
 *   Nothing here defends against editing the session file generally; the
 *   numbering catches the one edit that would turn a capped run into a clean one
 *   without changing anything else.
 *
 * ## The evasion I expect next, and what would be needed for it
 *
 * Every bound above has the same shape: the ledger records what the harness
 * DECLARED, and the DOM is never asked whether that account is complete. The
 * attack that follows from it is a focus move through a channel the ledger
 * cannot see — a raw CDP client on the same port, a hand on the keyboard, or a
 * new call site inside this harness added without a step. `--focus require`
 * would read any of those as "the application's own focus" and let the run
 * grade clean.
 *
 * What would close it: a capture-phase `focusin` counter installed by
 * `BOOTSTRAP` and surviving re-bootstrap, recorded into each ledger entry, so a
 * command can compare the DOM's count of focus changes with the number the run
 * accounts for and refuse on the difference. That is a MEASUREMENT rather than a
 * declaration and it is the right next move. I DID NOT BUILD IT: getting it
 * right means separating focus the application moved itself — which is
 * legitimate, and which a user would also meet — from focus something else
 * moved, and I could not do that correctly in the time I had. Saying it is not
 * doing it.
 */

/** No colour value is defined, read or written anywhere in this file. */

import { KNOWN_STEPS } from './input-provenance.mjs';

/**
 * Bumped when the entry shape changes. A ledger written under a different
 * version is treated as UNKNOWN rather than parsed optimistically, because a
 * misread ledger grades runs clean and that is the failure worth avoiding.
 */
export const LEDGER_VERSION = 1;

/** The session field the ledger lives in. */
export const LEDGER_KEY = 'runLedger';

/**
 * A run in which nothing has happened yet — the state `up` legitimately starts
 * in, and the only honest way for a caller with no session to say "no earlier
 * command". It is NOT a way to opt out of run grading: `known` is true here,
 * which is a positive claim that the run is empty.
 */
export function emptyRun() {
  return { known: true, version: LEDGER_VERSION, entries: [], unaccounted: [], unknownBecause: null };
}

/**
 * Opens an entry for a command about to run. Mutates `session`; the caller
 * persists it. Returns the sequence number, which is how the entry is found
 * again when the command finishes.
 */
export function openEntry(session, command, at = new Date().toISOString()) {
  const ledger = session[LEDGER_KEY];
  if (ledger === undefined || ledger === null || ledger.version !== LEDGER_VERSION) {
    session[LEDGER_KEY] = { version: LEDGER_VERSION, entries: [] };
  }
  const entries = session[LEDGER_KEY].entries;
  const seq = entries.length === 0 ? 1 : entries[entries.length - 1].seq + 1;
  entries.push({ seq, command, at, state: 'open' });
  return seq;
}

/**
 * Declares what the command did. `steps` is the live array the command also
 * hands to `gradeInputProvenance`; only the names are kept, because
 * `KNOWN_STEPS` is the single source of what a name means and a copy of `kind`
 * in the session file would be a second one that could disagree.
 */
export function declareEntry(session, seq, steps) {
  const entry = findEntry(session, seq);
  if (entry === null) return false;
  entry.state = 'declared';
  entry.steps = steps.map((step) => step.name);
  return true;
}

/** Marks an entry attached-but-never-declared. Grades as a hole, not as nothing. */
export function markUndeclared(session, seq) {
  const entry = findEntry(session, seq);
  if (entry === null) return false;
  entry.state = 'undeclared';
  return true;
}

function findEntry(session, seq) {
  const ledger = session?.[LEDGER_KEY];
  if (ledger === undefined || ledger === null || ledger.version !== LEDGER_VERSION) return null;
  return ledger.entries.find((entry) => entry.seq === seq) ?? null;
}

/**
 * Everything the run did before `seq`.
 *
 * `known: false` means there is no ledger to read — a session written before
 * this file existed, or under another version. It is reported rather than
 * silently treated as an empty run: "nothing was recorded" and "nothing
 * happened" are different answers and only one of them supports a clean grade.
 *
 * `unaccounted` lists prior entries that were opened and never declared. They
 * are kept apart from `entries` because they are not steps — they are the
 * absence of steps, and the grade has to say so rather than average them in.
 *
 * @returns {{known: boolean, version: number|null, entries: Array<{seq:number,
 *   command:string, steps:string[]}>, unaccounted: Array<{seq:number, command:string,
 *   state:string}>}}
 */
export function priorTo(session, seq) {
  const unknown = (version, why) => ({
    known: false,
    version,
    entries: [],
    unaccounted: [],
    unknownBecause: why,
  });
  const ledger = session?.[LEDGER_KEY];
  if (ledger === undefined || ledger === null) {
    return unknown(
      null,
      'the session carries no run ledger, so what earlier commands did is not recorded. Run ' +
        '`down` then `up` to start a run this build can grade.',
    );
  }
  if (ledger.version !== LEDGER_VERSION) {
    return unknown(
      ledger.version ?? null,
      `the session's run ledger is version ${ledger.version ?? 'unknown'} and this build reads ` +
        `version ${LEDGER_VERSION}. A ledger read optimistically under the wrong shape grades ` +
        'runs clean, which is the failure worth avoiding. Run `down` then `up`.',
    );
  }
  const all = ledger.entries ?? [];
  // Entries are appended with consecutive sequence numbers, so a gap is not a
  // state this code can produce — it is a ledger that has been edited. Cutting
  // an entry out of the middle is exactly how a run with a CDP act in it would
  // be made to look clean, and it is the one form of tampering the numbering
  // can detect. Removing the TAIL cannot be detected here, and is not claimed to be.
  for (let i = 0; i < all.length; i++) {
    if (all[i].seq !== i + 1) {
      return unknown(
        ledger.version,
        `the run ledger's sequence numbers are not consecutive (entry ${i + 1} of ${all.length} ` +
          `is #${all[i].seq}), so an entry has been removed from the middle of it. Run \`down\` ` +
          'then `up`.',
      );
    }
  }
  const before = all.filter((entry) => entry.seq < seq);
  return {
    known: true,
    version: ledger.version,
    unknownBecause: null,
    entries: before
      .filter((entry) => entry.state === 'declared')
      .map((entry) => ({ seq: entry.seq, command: entry.command, steps: entry.steps ?? [] })),
    // Two different holes, reported as one because the grade does the same
    // thing with both: an earlier command that never said what it did, and a
    // command that ran DURING this one, from another vela-drive process. From
    // here the second is exactly as unaccountable as the first.
    unaccounted: [
      ...before
        .filter((entry) => entry.state !== 'declared')
        .map((entry) => ({ seq: entry.seq, command: entry.command, state: entry.state })),
      ...all
        .filter((entry) => entry.seq > seq)
        .map((entry) => ({ seq: entry.seq, command: entry.command, state: 'concurrent' })),
    ],
  };
}

/**
 * The last recorded step that could have moved DOM focus, or `null` when the
 * run has not moved it at all — in which case focus is wherever the application
 * itself put it, which is what a user finds on launch too.
 *
 * This is what turns `--focus require` from "focus is here" into "focus arrived
 * by something a user could have done, or by nobody". It is still not a proof
 * of causation: it names
 * the last recorded step that COULD have been the one, not the one that was. A
 * CDP act that moved focus followed by an OS act that moved it again leaves
 * `os` here, and the run ceiling — not this function — is what catches that
 * sequence.
 *
 * @returns {{name:string, channel:'os'|'cdp', command:string, seq:number, why:string}|null}
 */
export function lastFocusMove(prior) {
  if (prior.known !== true) return null;
  for (let i = prior.entries.length - 1; i >= 0; i--) {
    const entry = prior.entries[i];
    for (let j = entry.steps.length - 1; j >= 0; j--) {
      const name = entry.steps[j];
      const known = KNOWN_STEPS[name];
      if (known === undefined) {
        throw new Error(
          `lastFocusMove: the ledger records step "${name}", which is not in KNOWN_STEPS. ` +
            'A session written by a build that knew a step this one does not cannot be graded.',
        );
      }
      if (known.movesFocus) {
        return {
          name,
          channel: name.startsWith('os.') ? 'os' : 'cdp',
          // The field the gate actually tests. `channel` is descriptive —
          // `os.postMessage` is an `os.` step a user has no route to, and
          // testing the prefix would let a `click --via message` stand in for a
          // hand. See KNOWN_STEPS.
          userEquivalent: known.userEquivalent,
          command: entry.command,
          seq: entry.seq,
          why: known.why,
        };
      }
    }
  }
  return null;
}
