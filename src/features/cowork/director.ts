/**
 * THE SEAM A MID-FLIGHT REDIRECT NEEDS, AND DOES NOT HAVE.
 *
 * An interface with **no host behind it**, and a stub that says so out loud.
 * Nothing in this repo implements {@link TaskDirector} against a real run. Read
 * that sentence before writing anything that depends on this.
 *
 * The stub is not dead code: `use-cowork.ts` calls it on every directive the
 * plan releases, and `ProgressPanel.tsx` renders the answer it gives. That is
 * the point of it. The comment the user wrote goes somewhere, something answers
 * about it, and the answer the user is shown is the true one — `noLiveRun`,
 * "nothing took it" — instead of a green label over a hop that does not exist.
 *
 * ## What is missing, verified against the contract rather than assumed
 *
 * `src/platform/contract-harness.ts` fixes a run's whole input at start:
 * `RunRequest.input` is "the conversation so far, in the shape `chat_send`
 * already takes", and it is handed to `LiveRuns.start` once. The only thing a
 * caller may afterwards do to a live run is named in that file's own words —
 * `RunController` is "the only thing a caller can do to a run in flight", and it
 * has exactly one method, `cancel`. `RunEmit` runs the other way, from the
 * harness outward.
 *
 * So there is **no path from the renderer into a run that has already started**
 * other than ending it. A comment on an upcoming step can therefore be stored,
 * ordered, guarded, released and shown; it cannot presently be put in front of
 * the model without cancelling the run and starting another, which is the
 * "stopping" the feature exists to avoid.
 *
 * ## What is built anyway, and why that is not decoration
 *
 * Everything except the last hop, plus the sentence that names the last hop as
 * missing to the person using it. `src/lib/task-plan.ts` owns when a directive
 * becomes deliverable and refuses the comments nothing would read;
 * `src/state/cowork-store.ts` holds one plan per conversation; `use-cowork.ts`
 * hands every released directive to this seam and writes the answer back onto
 * the plan; `ProgressPanel.tsx` shows each comment's state — will redirect,
 * handing over, redirected, or **never read, and why**. The last of those is the
 * point: with this stub in place, every comment the plan *releases* is answered
 * `noLiveRun` and lands in the "never read" report, which is exactly what is
 * true of this build. A comment on a step the run has not got to yet still
 * reads "will redirect", because that is true too.
 *
 * The alternative was to fold directives into the *next* turn's input, beside
 * the memory preamble in `src/features/conversation/use-conversation.ts`. It was
 * rejected on the merits and the reason is the whole brief: that delivers the
 * comment when the user next presses send, which is **after the run stopped**.
 * It would have looked exactly like a mid-flight redirect, passed a test that
 * asserted the text reached `toMessages`, and not been the feature. Shipping the
 * appearance of steering is worse than shipping the plan and saying which hop is
 * missing.
 *
 * ## What an implementer has to decide, that this interface deliberately does not
 *
 * Two things, and neither is answerable from the renderer:
 *
 *  1. **Where in the turn the directive lands.** A new user message, a system
 *     addendum, or a tool result are three different things to a model and three
 *     different transcripts to a user. `ChatMessageInput` can spell the first;
 *     the other two need the host.
 *  2. **What happens to a directive released while the turn it targets is
 *     already on the wire.** {@link TaskDirector.deliver} answers with
 *     {@link DirectiveDelivery} rather than `void` precisely so that this cannot
 *     be silent — `tooLate` is a real answer and the panel renders it.
 */

import type { DirectiveDelivery } from '@/lib/task-plan';

/**
 * Re-exported, not redeclared. The union lives in `src/lib/task-plan.ts`
 * because `PlanStep` has to carry it and that file imports nothing; two
 * declarations of the same four answers would be two things to keep in step.
 */
export type { DirectiveDelivery };

/**
 * Put a comment in front of a run that has already started.
 *
 * **Not implemented.** See the header for what would have to exist first.
 */
export interface TaskDirector {
  /**
   * @param conversationId the run's conversation — the key `LiveRuns` uses.
   * @param step the 1-based plan step the directive was written against, the
   *   same number `turnStarted.step` carries.
   */
  deliver(conversationId: string, step: number, directive: string): Promise<DirectiveDelivery>;
}

/**
 * The stub this build ships, and it says so.
 *
 * It answers `noLiveRun` unconditionally — not `delivered`, which would be a
 * lie, and not a throw, which would make the panel unusable. A caller that shows
 * the user what came back therefore shows the truth: the comment is held and no
 * run has taken it. `use-cowork.ts` is that caller.
 *
 * `src/features/cowork/director.test.ts` pins that answer, so a future
 * implementation cannot land here by accident without the test that says what it
 * now does.
 */
export function createUnwiredDirector(): TaskDirector {
  return {
    deliver: async () => ({ kind: 'noLiveRun' }) satisfies DirectiveDelivery,
  };
}
