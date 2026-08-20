/**
 * THE SEAM A MID-FLIGHT REDIRECT NEEDS, AND DOES NOT HAVE.
 *
 * This file is a **frozen interface with no host behind it**, declared here so
 * that the panel above it can be built and so that whoever adds the capability
 * has something to implement rather than a design to re-invent. Nothing in this
 * repo implements {@link TaskDirector} against a real run. Read that sentence
 * before writing anything that depends on this.
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
 * ordered, guarded and shown; it cannot presently be put in front of the model
 * without cancelling the run and starting another, which is the "stopping" the
 * feature exists to avoid.
 *
 * ## What is built anyway, and why that is not decoration
 *
 * Everything except the last hop. `src/lib/task-plan.ts` owns when a directive
 * becomes deliverable and refuses the comments nothing would read;
 * `src/state/cowork-store.ts` holds one plan per conversation;
 * `ProgressPanel.tsx` shows each comment's state — pending, delivered, or
 * **never read**. The last of those is the point: a directive the run never took
 * is rendered as such rather than sitting in the list looking like the ones that
 * landed.
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
 *  2. **What happens to a directive accepted while the turn it targets is
 *     already on the wire.** {@link TaskDirector.deliver} answers with
 *     {@link DirectiveDelivery} rather than `void` precisely so that this cannot
 *     be silent — `tooLate` is a real answer and the panel renders it.
 */

/** What became of one directive handed to a run. */
export type DirectiveDelivery =
  /** The run took it and the model will see it on the step it was written for. */
  | { readonly kind: 'delivered' }
  /**
   * The run had already moved past the step. Not an error and not a success: the
   * user's words exist and the model did not get them, and a caller that treated
   * this as either would be wrong in a way the user cannot see.
   */
  | { readonly kind: 'tooLate' }
  /** No run is live for that conversation. The directive stays pending. */
  | { readonly kind: 'noLiveRun' }
  /** The run refused it. `reason` is the host's, rendered verbatim. */
  | { readonly kind: 'refused'; readonly reason: string };

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
 * run has taken it.
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
