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
 * ## Why the comment control is absent rather than disabled on a passed step
 *
 * A disabled control says "not now"; an absent one says "not here". A step the
 * run is on or has passed can never take a comment again — `advanceTo` in
 * `src/lib/task-plan.ts` delivers on arrival, and the plan does not arrive
 * twice — so "not now" would be a promise nothing can keep. The refusal path is
 * still built and still rendered, because a plan can advance between the render
 * that drew the button and the click that presses it.
 */

import type { PlanStep, RedirectRefusal } from '@/lib/task-plan';

import styles from './CoworkPanel.module.css';
import { useCommentDraft, type CoworkController } from './use-cowork';

/** Vela's words for each refusal. The vocabulary is closed; the wording is ours. */
function refusalText(refusal: RedirectRefusal): string {
  switch (refusal) {
    case 'emptyComment':
      return 'Write something first — a blank comment would not redirect anything.';
    case 'noSuchStep':
      return 'That step is no longer in the plan.';
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
          {lost.length === 1
            ? 'One comment was never read: the task stopped before reaching its step.'
            : `${lost.length} comments were never read: the task stopped before reaching their steps.`}
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
        {step.directive !== null && (
          <p
            className={`${styles.directive} ${
              !step.directiveDelivered && cowork.plan.state === 'stopped' ? styles.directiveLost : ''
            }`}
            data-testid={`cowork-directive-${step.n}`}
            data-delivered={step.directiveDelivered ? 'yes' : 'no'}
          >
            <span className={styles.directiveLabel}>
              {step.directiveDelivered
                ? 'Redirected'
                : cowork.plan.state === 'stopped'
                  ? 'Never read'
                  : 'Will redirect'}
            </span>
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

