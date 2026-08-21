/**
 * PROGRESS — the numbered plan, and the comment that steers it.
 *
 * Checks behind completed steps, the current step marked, steps ahead plain, and
 * a comment box on every step the run has not reached.
 *
 * ## Three things carry each step's state, not one
 *
 * Colour, a glyph, and a word. A user who cannot separate two hues still sees a
 * tick against a done step and reads "current" in the accessible name of the one
 * that is running. `aria-current="step"` is on the running row — the value is
 * `step` rather than `page`, because WAI-ARIA has a token for exactly this and
 * the sidebar's conversation rows already own `page` for the other meaning.
 *
 * ## What a comment's label is allowed to say
 *
 * Four states, and only one of them claims a model saw anything. `Will redirect`
 * is written and waiting. `Handing over` is released by `advanceTo` with no
 * answer back yet. `Redirected` requires a {@link DirectiveDelivery} of kind
 * `delivered` — nothing else earns that word. Everything else is `Never read`,
 * with the reason on the same line.
 *
 * An earlier draft printed `Redirected` the instant the plan arrived at the
 * step, which is before anything has been asked to take the comment and, in this
 * build, before a hop exists that could. `src/features/cowork/director.ts` sets
 * out why. With the stub director this build ships, every comment the plan
 * releases reaches `Never read — no run took it`, and that is the true report.
 *
 * ## Why the comment control is absent rather than disabled on a passed step
 *
 * A disabled control says "not now"; an absent one says "not here". A step the
 * run is on or has passed can never take a comment again — `advanceTo` in
 * `src/lib/task-plan.ts` releases on arrival, and the plan does not arrive
 * twice — so "not now" would be a promise nothing can keep. The refusal path is
 * still built and still rendered, because a plan can advance between the render
 * that drew the button and the click that presses it.
 */

import type {
  DirectiveDelivery,
  PlanStep,
  RedirectRefusal,
  TaskState,
} from '@/lib/task-plan';

import styles from './CoworkPanel.module.css';
import { useCommentDraft, type CoworkController } from './use-cowork';

/** Vela's words for each refusal. The vocabulary is closed; the wording is ours. */
function refusalText(refusal: RedirectRefusal): string {
  switch (refusal) {
    case 'emptyComment':
      return 'Write something first — a blank comment would not redirect anything.';
    case 'noSuchStep':
      return 'That step is no longer in the plan.';
    case 'taskHasStopped':
      return 'This task has stopped, so nothing will arrive at this step to read a comment.';
    case 'stepIsNotAhead':
      return 'The run has already reached this step, so a comment here would never be read.';
    default: {
      // The union is closed; this arm exists so that widening it fails the build
      // rather than falling through to a blank message.
      const exhaustive: never = refusal;
      return exhaustive;
    }
  }
}

/**
 * How far a comment got, in four words the panel is allowed to print.
 *
 * `notRead` is one state and several reasons, which is why the reason travels
 * with it: "never read" on its own would leave a user to guess between a run
 * that stopped early and a hop that refused, and those call for different next
 * actions.
 */
type DirectiveProgress = 'pending' | 'handingOver' | 'delivered' | 'notRead';

function directiveView(
  step: PlanStep,
  taskState: TaskState,
): { readonly progress: DirectiveProgress; readonly label: string } {
  const outcome: DirectiveDelivery | null = step.directiveOutcome;
  if (outcome !== null) {
    switch (outcome.kind) {
      case 'delivered':
        return { progress: 'delivered', label: 'Redirected' };
      case 'tooLate':
        return { progress: 'notRead', label: 'Never read — the run had passed this step' };
      case 'noLiveRun':
        return { progress: 'notRead', label: 'Never read — no run took it' };
      case 'refused':
        return { progress: 'notRead', label: `Never read — ${outcome.reason}` };
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }
  if (step.directiveReleased) return { progress: 'handingOver', label: 'Handing over' };
  if (taskState === 'stopped') {
    return { progress: 'notRead', label: 'Never read — the task stopped before this step' };
  }
  return { progress: 'pending', label: 'Will redirect' };
}

interface ProgressPanelProps {
  readonly cowork: CoworkController;
}

export function ProgressPanel({ cowork }: ProgressPanelProps) {
  const draft = useCommentDraft();
  const { plan, lost } = cowork;

  if (plan.steps.length === 0) {
    return (
      <p className={styles.note} data-testid="cowork-no-plan">
        This task has no plan yet. A plan is a numbered list of steps; the run
        checks them off as it works, and a comment on a step it has not reached
        yet redirects it when it gets there.
      </p>
    );
  }

  return (
    <>
      <p className={styles.intro} data-testid="cowork-progress-summary">
        {`${cowork.completed} of ${cowork.total} steps done`}
        {plan.state === 'stopped' ? ' · task stopped' : ''}
        {plan.state === 'idle' ? ' · not started' : ''}
      </p>

      <ol className={styles.steps}>
        {plan.steps.map((step) => (
          <StepRow
            key={step.n}
            step={step}
            cowork={cowork}
            draft={draft}
          />
        ))}
      </ol>

      {lost.length > 0 && (
        <p className={styles.error} role="status" data-testid="cowork-lost-directives">
          {/* No cause is named here, because there is more than one and they are
              not interchangeable. Each step's own label carries its reason. */}
          {lost.length === 1
            ? 'One comment was never read by the run.'
            : `${lost.length} comments were never read by the run.`}
        </p>
      )}
    </>
  );
}

function StepRow({
  step,
  cowork,
  draft,
}: {
  readonly step: PlanStep;
  readonly cowork: CoworkController;
  readonly draft: ReturnType<typeof useCommentDraft>;
}) {
  const state = cowork.stateOfStep(step.n);
  const canRedirect = cowork.canRedirect(step.n);
  const editing = draft.openFor === step.n;

  // The word a screen reader gets, so the row's state is never carried by the
  // marker glyph alone.
  const stateWord = state === 'done' ? 'done' : state === 'current' ? 'current' : 'upcoming';

  // Appended to each control's visible text rather than replacing it with an
  // `aria-label`, so the accessible name still *contains* what is painted on the
  // button — and so that three "Comment on this step" buttons in one panel are
  // three different names rather than one repeated three times.
  const which = ` — step ${step.n}: ${step.title}`;

  const rowClass = [
    styles.step,
    state === 'current' ? styles.stepCurrent : '',
    state === 'ahead' ? styles.stepAhead : '',
  ]
    .filter((name) => name !== '')
    .join(' ');

  const markerClass = [
    styles.marker,
    state === 'done' ? styles.markerDone : '',
    state === 'current' ? styles.markerCurrent : '',
  ]
    .filter((name) => name !== '')
    .join(' ');

  const directive = step.directive === null ? null : directiveView(step, cowork.plan.state);

  return (
    <li
      className={rowClass}
      data-testid={`cowork-step-${step.n}`}
      data-state={state}
      {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}
    >
      <span className={markerClass} aria-hidden="true">
        {state === 'done' ? <CheckIcon /> : step.n}
      </span>
      <span className={styles.stepTitle}>
        {/* The number and the state word travel with the title so the accessible
            name of the row is "Step 2, current, Draft the migration" rather than
            a bare title whose position and status are conveyed by paint. */}
        <span className={styles.srOnly}>{`Step ${step.n}, ${stateWord}: `}</span>
        {step.title}
      </span>

      <div className={styles.stepBody}>
        {step.directive !== null && directive !== null && (
          <p
            className={`${styles.directive} ${
              directive.progress === 'notRead' ? styles.directiveLost : ''
            }`}
            data-testid={`cowork-directive-${step.n}`}
            data-directive-state={directive.progress}
          >
            <span className={styles.directiveLabel}>{directive.label}</span>
            {step.directive}
          </p>
        )}

        {canRedirect && !editing && (
          <span className={styles.commentActions}>
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                draft.open(step.n);
              }}
            >
              {step.directive === null ? 'Comment on this step' : 'Replace comment'}
              <span className={styles.srOnly}>{which}</span>
            </button>
            {step.directive !== null && (
              <button
                type="button"
                className={styles.button}
                onClick={() => {
                  cowork.uncomment(step.n);
                }}
              >
                Remove comment
                <span className={styles.srOnly}>{which}</span>
              </button>
            )}
          </span>
        )}

        {editing && (
          <form
            className={styles.commentForm}
            onSubmit={(event) => {
              event.preventDefault();
              const refusal = cowork.comment(step.n, draft.draft);
              if (refusal === null) draft.close();
              else draft.setRefusal(refusal);
            }}
          >
            <textarea
              className={styles.commentInput}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the user just
              // pressed the control that opens this box; anywhere else is wrong.
              autoFocus
              aria-label={`Comment on step ${step.n}: ${step.title}`}
              value={draft.draft}
              onChange={(event) => {
                draft.setDraft(event.target.value);
                draft.setRefusal(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  // Stopped, or the dialog above closes with it — the user is
                  // cancelling a comment, not the panel.
                  event.stopPropagation();
                  draft.close();
                }
              }}
            />
            {draft.refusal !== null && (
              <p className={styles.error} role="alert">
                {refusalText(draft.refusal)}
              </p>
            )}
            <span className={styles.commentActions}>
              <button type="submit" className={`${styles.button} ${styles.buttonPrimary}`}>
                Redirect from here
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => {
                  draft.close();
                }}
              >
                Cancel
              </button>
            </span>
          </form>
        )}
      </div>
    </li>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
      <path
        d="M3.4 8.4 6.4 11.4 12.6 5.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
