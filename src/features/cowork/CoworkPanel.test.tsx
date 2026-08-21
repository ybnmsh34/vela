/**
 * The cowork dock, driven.
 *
 * `src/lib/task-plan.test.ts` proves the plan algebra. This file proves the
 * three things a user can only get from the rendered surface: that a step's
 * state reaches the accessibility tree and not only the paint, that the comment
 * control is **absent** exactly where a comment could never be read, and that
 * the two host reads this dock introduced actually go out.
 *
 * The panels take controllers, so most of this needs no adapter. The two that
 * read the host are driven through `BrowserAdapter`, which is the same fake the
 * rest of the repo's panes are tested against, with its `invoke` observed so the
 * test can say the command was *sent* rather than inferring it from what was
 * drawn.
 *
 * ## `delay: null`, and why it is not a shortcut
 *
 * `userEvent.setup()` puts a real delay between keystrokes, so most of what
 * this file spends its time on is waiting between characters. Measured on this
 * machine, three runs of this file alone, nothing changed but the setting:
 *
 *  - default delay: `tests 4.95s / 4.98s / 4.85s`, slowest test
 *    `takes the comment and shows that it will redirect` at 768 / 717 / 738 ms;
 *  - `delay: null` as committed: `tests 2.03s / 2.40s / 2.15s`, that same test
 *    at 375 / 296 / 311 ms.
 *
 * CORRECTION, because the wrong numbers are in this project's record. An
 * earlier version of this paragraph — and the message of the commit that made
 * the change, 87d6b25 — said the redirect tests "ran 2.8s and 1.5s in
 * isolation" and that one of them had crossed vitest's 5s default under load
 * and failed as a timeout. Neither is a number this track can produce. The
 * measurement above is the whole of what is true: the setting roughly halves
 * the file, and no test in it has been measured anywhere near the 5s default,
 * with the delay or without it. The timeout is withdrawn rather than softened.
 *
 * The setting is still right, on the grounds that do hold: the events are the
 * same events, dispatched in the same order, through the same `user-event`
 * machinery. Nothing here depends on elapsed time, so there is nothing for the
 * delay to be testing.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import type { CommandName, CommandReq, CommandRes } from '@/platform/contract';
import type { RedirectRefusal } from '@/lib/task-plan';
import { resetCoworkStore, useCoworkStore } from '@/state/cowork-store';
import { resetNavigationStore, useNavigationStore } from '@/state/navigation-store';
import { resetFocusStore } from '@/state/focus-store';

import { CoworkDock } from './CoworkPanel';
import { refusalText } from './ProgressPanel';

/** Records every command that crossed the seam, in order. */
class WatchedHost extends BrowserAdapter {
  readonly sent: CommandName[] = [];

  override async invoke<C extends CommandName>(
    command: C,
    payload: CommandReq<C>,
  ): Promise<CommandRes<C>> {
    this.sent.push(command);
    return super.invoke(command, payload);
  }
}

const CONVERSATION = 'conversation-alpha';

/**
 * Every member of the closed refusal union, named once.
 *
 * A `Record` keyed by the union rather than an array of strings, so that adding
 * a fifth refusal fails the build here instead of quietly leaving the new arm
 * of `refusalText` with no test and whatever sentence someone typed.
 */
const EVERY_REFUSAL: Readonly<Record<RedirectRefusal, true>> = {
  emptyComment: true,
  noSuchStep: true,
  taskHasStopped: true,
  stepIsNotAhead: true,
};
const REFUSALS = Object.keys(EVERY_REFUSAL) as readonly RedirectRefusal[];

function mount(adapter: BrowserAdapter = new BrowserAdapter()) {
  return render(
    <PlatformProvider adapter={adapter}>
      <CoworkDock onClose={() => undefined} runtime={null} projectId={null} />
    </PlatformProvider>,
  );
}

/** Give the selected conversation a plan and put the run on `step`. */
function givePlan(titles: readonly string[], step?: number): void {
  useNavigationStore.getState().select(CONVERSATION);
  useCoworkStore.getState().setPlan(CONVERSATION, titles);
  if (step !== undefined) useCoworkStore.getState().advance(CONVERSATION, step);
}

/**
 * Write a comment on `step` the way a user does — the control, the box, the
 * submit — rather than by calling the store, so the tests that follow are about
 * a comment that actually went through the surface.
 */
async function commentOn(
  user: ReturnType<typeof userEvent.setup>,
  step: number,
  text: string,
): Promise<void> {
  const row = screen.getByTestId(`cowork-step-${step}`);
  await user.click(within(row).getByRole('button', { name: /^Comment on this step/ }));
  await user.type(
    screen.getByRole('textbox', { name: new RegExp(`Comment on step ${step}`) }),
    text,
  );
  await user.click(screen.getByRole('button', { name: 'Redirect from here' }));
}

const PLAN = ['Read the brief', 'Draft the migration', 'Run the suite', 'Write it up'];

beforeEach(() => {
  resetCoworkStore();
  resetNavigationStore();
  resetFocusStore();
});

describe('the progress panel', () => {
  it('numbers every step and says how many are done', async () => {
    givePlan(PLAN, 2);
    mount();

    expect(screen.getByTestId('cowork-progress-summary')).toHaveTextContent('1 of 4 steps done');
    for (const [index, title] of PLAN.entries()) {
      expect(screen.getByTestId(`cowork-step-${index + 1}`)).toHaveTextContent(title);
    }
  });

  it('puts each step’s state in the accessibility tree, not only in the paint', async () => {
    givePlan(PLAN, 2);
    mount();

    // A screen reader has to be able to tell these apart. Colour and a tick
    // glyph cannot do that on their own, which is why the state is also a word.
    expect(screen.getByTestId('cowork-step-1')).toHaveTextContent(/Step 1, done/);
    expect(screen.getByTestId('cowork-step-2')).toHaveTextContent(/Step 2, current/);
    expect(screen.getByTestId('cowork-step-3')).toHaveTextContent(/Step 3, upcoming/);
  });

  it('marks the running step with aria-current, and only that one', async () => {
    givePlan(PLAN, 2);
    mount();

    expect(screen.getByTestId('cowork-step-2')).toHaveAttribute('aria-current', 'step');
    for (const n of [1, 3, 4]) {
      expect(screen.getByTestId(`cowork-step-${n}`)).not.toHaveAttribute('aria-current');
    }
  });
});

describe('a comment on an upcoming step redirects the task', () => {
  it('takes the comment and shows that it will redirect', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    mount();

    const step3 = screen.getByTestId('cowork-step-3');
    await user.click(within(step3).getByRole('button', { name: /^Comment on this step/ }));
    await user.type(
      screen.getByRole('textbox', { name: /Comment on step 3/ }),
      'use the staging database instead',
    );
    await user.click(screen.getByRole('button', { name: 'Redirect from here' }));

    const directive = await screen.findByTestId('cowork-directive-3');
    expect(directive).toHaveTextContent('use the staging database instead');
    // Written and waiting. The plan has not arrived at step 3, so nothing has
    // been handed anywhere and nothing may claim it has.
    expect(directive).toHaveAttribute('data-directive-state', 'pending');
    expect(directive).toHaveTextContent('Will redirect');
  });

  /**
   * ARRIVAL IS NOT DELIVERY, AND THE PANEL MAY NOT SAY IT IS.
   *
   * `advance` here is the store's, called directly, which is the plan arriving
   * with nobody having been asked to take the comment — the shape a late replay
   * or a test fixture produces. The row must say the comment is on its way and
   * nothing more. An earlier build printed "Redirected" at this point, over a
   * hop that had not been attempted and, in this build, does not exist.
   * `use-cowork.test.tsx` drives the other half: the hop being attempted, and
   * the answer coming back.
   */
  it('says the comment is being handed over, not that it was delivered', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    mount();

    const step3 = screen.getByTestId('cowork-step-3');
    await user.click(within(step3).getByRole('button', { name: /^Comment on this step/ }));
    await user.type(screen.getByRole('textbox', { name: /Comment on step 3/ }), 'mind the index');
    await user.click(screen.getByRole('button', { name: 'Redirect from here' }));

    useCoworkStore.getState().advance(CONVERSATION, 3);

    await waitFor(() => {
      expect(screen.getByTestId('cowork-directive-3')).toHaveAttribute(
        'data-directive-state',
        'handingOver',
      );
    });
    const directive = screen.getByTestId('cowork-directive-3');
    expect(directive).toHaveTextContent('Handing over');
    expect(directive).not.toHaveTextContent('Redirected');
  });

  it('reports delivery only once something answers that a run took it', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    mount();

    const step3 = screen.getByTestId('cowork-step-3');
    await user.click(within(step3).getByRole('button', { name: /^Comment on this step/ }));
    await user.type(screen.getByRole('textbox', { name: /Comment on step 3/ }), 'mind the index');
    await user.click(screen.getByRole('button', { name: 'Redirect from here' }));

    useCoworkStore.getState().advance(CONVERSATION, 3);
    // The answer, which in this build only a substituted director can give.
    useCoworkStore.getState().recordDelivery(CONVERSATION, 3, { kind: 'delivered' });

    await waitFor(() => {
      expect(screen.getByTestId('cowork-directive-3')).toHaveTextContent('Redirected');
    });
    expect(screen.getByTestId('cowork-directive-3')).toHaveAttribute(
      'data-directive-state',
      'delivered',
    );
    // And a delivered comment is not in the never-read report.
    expect(screen.queryByTestId('cowork-lost-directives')).toBeNull();
  });

  it('names a comment nothing took, even though the task is still running', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    mount();

    const step3 = screen.getByTestId('cowork-step-3');
    await user.click(within(step3).getByRole('button', { name: /^Comment on this step/ }));
    await user.type(screen.getByRole('textbox', { name: /Comment on step 3/ }), 'mind the index');
    await user.click(screen.getByRole('button', { name: 'Redirect from here' }));

    useCoworkStore.getState().advance(CONVERSATION, 3);
    useCoworkStore.getState().recordDelivery(CONVERSATION, 3, { kind: 'noLiveRun' });

    // The stopped-task report would have kept quiet here; this is the case a
    // plan that treats arrival as delivery cannot report at all.
    expect(await screen.findByTestId('cowork-lost-directives')).toHaveTextContent(
      /One comment was never read/,
    );
    expect(screen.getByTestId('cowork-directive-3')).toHaveTextContent(
      'Never read — no run took it',
    );
  });

  /**
   * THE BOUNDARY. `n >= currentStep` would offer this control on step 2, store
   * the comment, render it — and nothing would ever read it, because the plan
   * releases on arrival and never arrives at the step it is on.
   */
  it('offers no comment control on the step that is running, or behind it', async () => {
    givePlan(PLAN, 2);
    mount();

    for (const n of [1, 2]) {
      const row = screen.getByTestId(`cowork-step-${n}`);
      expect(within(row).queryByRole('button', { name: /^Comment on this step/ })).toBeNull();
    }
    for (const n of [3, 4]) {
      const row = screen.getByTestId(`cowork-step-${n}`);
      expect(within(row).getByRole('button', { name: /^Comment on this step/ })).toBeVisible();
    }
  });

  /**
   * THE RACE THE REFUSAL PATH EXISTS FOR, with the sentence it must not say.
   *
   * The comment box is open on step 3 and the run dies while it is open. The
   * control is gone from every other row, but this form is still on screen, so
   * the submit has to be answered — and answered with something true. For a
   * round the answer was "The run has already reached this step" about a step
   * the run never reached, which is a false claim about the user's own task at
   * the moment they are trying to work out what happened to it.
   */
  it('tells a user whose task died that it died, not that the run passed the step', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    mount();

    const step3 = screen.getByTestId('cowork-step-3');
    await user.click(within(step3).getByRole('button', { name: /^Comment on this step/ }));
    await user.type(screen.getByRole('textbox', { name: /Comment on step 3/ }), 'use staging');

    useCoworkStore.getState().stopTask(CONVERSATION);
    await user.click(screen.getByRole('button', { name: 'Redirect from here' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/This task has stopped/);
    expect(alert).not.toHaveTextContent(/already reached/);
  });

  /**
   * THE PATTERN THE BRIEF SINGLES OUT: duplicate accessible names on controls
   * with different consequences. With the run on step 1 of 4 there are three
   * comment buttons on screen, and for a round they were all called "Comment on
   * this step" — one name, three different steps. The visible text is unchanged
   * and the step travels with it, so the accessible name still *contains* the
   * label a speech-control user would say.
   */
  it('gives each comment button a name that says which step it acts on', async () => {
    givePlan(PLAN, 1);
    mount();

    const buttons = screen.getAllByRole('button', { name: /^Comment on this step/ });
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Comment on this step — step 2: Draft the migration',
      'Comment on this step — step 3: Run the suite',
      'Comment on this step — step 4: Write it up',
    ]);
    expect(new Set(buttons.map((button) => button.textContent)).size).toBe(buttons.length);
  });

  it('refuses a blank comment in words rather than storing nothing', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    mount();

    const step3 = screen.getByTestId('cowork-step-3');
    await user.click(within(step3).getByRole('button', { name: /^Comment on this step/ }));
    await user.click(screen.getByRole('button', { name: 'Redirect from here' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Write something first/);
    expect(screen.queryByTestId('cowork-directive-3')).toBeNull();
  });

  it('says so when a comment was never read, instead of leaving it looking like the rest', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    mount();

    const step4 = screen.getByTestId('cowork-step-4');
    await user.click(within(step4).getByRole('button', { name: /^Comment on this step/ }));
    await user.type(screen.getByRole('textbox', { name: /Comment on step 4/ }), 'and the caveat');
    await user.click(screen.getByRole('button', { name: 'Redirect from here' }));

    // The run dies at step 2. Step 4 never arrives.
    useCoworkStore.getState().stopTask(CONVERSATION);

    expect(await screen.findByTestId('cowork-lost-directives')).toHaveTextContent(
      /One comment was never read/,
    );
    expect(screen.getByTestId('cowork-directive-4')).toHaveTextContent(
      'Never read — the task stopped before this step',
    );
  });

  /**
   * THE THREE LABELS THIS BUILD CANNOT REACH, PINNED ANYWAY.
   *
   * The director this build ships answers `noLiveRun` and only that, so
   * `delivered`, `tooLate` and `refused` are arms of `directiveView` that exist
   * to guard the implementation that replaces the stub, and for a round two of
   * them were guarded by a comment rather than by an assertion. Measured against
   * the tree this commit ships: changing the `tooLate` arm to
   * `{ progress: 'delivered', label: 'Redirected' }` gives EXIT=1 with exactly
   * one red, this test, and nothing else in the cowork scope moves; the same
   * change to the `refused` arm fails exactly the test below it. Both
   * reproduced twice. `recordDelivery` is the store's, called directly,
   * because a substituted director is the only other way to reach these and the
   * question here is what the panel PRINTS, not who said it.
   */
  it('says the run had passed the step when that is the answer, not that it was redirected', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    mount();

    await commentOn(user, 3, 'mind the index');
    useCoworkStore.getState().advance(CONVERSATION, 3);
    useCoworkStore.getState().recordDelivery(CONVERSATION, 3, { kind: 'tooLate' });

    await waitFor(() => {
      expect(screen.getByTestId('cowork-directive-3')).toHaveTextContent(
        'Never read — the run had passed this step',
      );
    });
    const directive = screen.getByTestId('cowork-directive-3');
    expect(directive).toHaveAttribute('data-directive-state', 'notRead');
    expect(directive).not.toHaveTextContent('Redirected');
    // Too late is not delivered, so it is in the never-read report as well as
    // on the row. A label that said otherwise would also have to empty this.
    expect(await screen.findByTestId('cowork-lost-directives')).toHaveTextContent(
      /One comment was never read/,
    );
  });

  it('prints the host’s own words when a run refused the comment', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    mount();

    await commentOn(user, 3, 'mind the index');
    useCoworkStore.getState().advance(CONVERSATION, 3);
    useCoworkStore.getState().recordDelivery(CONVERSATION, 3, {
      kind: 'refused',
      reason: 'the turn was already on the wire',
    });

    await waitFor(() => {
      expect(screen.getByTestId('cowork-directive-3')).toHaveTextContent(
        'Never read — the turn was already on the wire',
      );
    });
    const directive = screen.getByTestId('cowork-directive-3');
    // Verbatim, because `src/lib/task-plan.ts` says the reason is the host's and
    // is rendered as given; a paraphrase here would be Vela inventing a cause.
    expect(directive).toHaveAttribute('data-directive-state', 'notRead');
    expect(directive).not.toHaveTextContent('Redirected');
  });

  /**
   * THE CASE THAT LOOKS LIKE IT SHOULD SAY "NEVER READ" AND MUST NOT.
   *
   * The run arrived at step 3, which released the comment, and then the task
   * stopped before anything answered. `Never read — the task stopped before
   * this step` is the sentence a stopped task usually earns, and here it would
   * be false twice over: the run reached this step, and nothing has yet said
   * what became of the comment. So the row keeps saying "Handing over" and the
   * never-read report keeps quiet, which is what `undelivered` in
   * `src/lib/task-plan.ts` also does with a released-and-unanswered directive.
   * Reordering the two checks in `directiveView` is what this pins.
   */
  it('keeps saying handing over on a stopped task, because waiting is not lost', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    mount();

    await commentOn(user, 3, 'mind the index');
    useCoworkStore.getState().advance(CONVERSATION, 3);
    useCoworkStore.getState().stopTask(CONVERSATION);

    await waitFor(() => {
      expect(screen.getByTestId('cowork-directive-3')).toHaveAttribute(
        'data-directive-state',
        'handingOver',
      );
    });
    const directive = screen.getByTestId('cowork-directive-3');
    expect(directive).toHaveTextContent('Handing over');
    expect(directive).not.toHaveTextContent('stopped before this step');
    expect(directive).not.toHaveTextContent('Redirected');
    expect(screen.queryByTestId('cowork-lost-directives')).toBeNull();
  });

  /**
   * THE OTHER HALF OF THE RACE. The stopped-task test above covers the run
   * dying under an open comment box; this is the run *arriving* under one. Here
   * "the run has already reached this step" is the true sentence — it is the
   * one case in which it is — and the task has not stopped, so the other
   * refusal would be the false one.
   */
  it('tells a user whose run reached the step while the box was open exactly that', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    mount();

    const step3 = screen.getByTestId('cowork-step-3');
    await user.click(within(step3).getByRole('button', { name: /^Comment on this step/ }));
    await user.type(screen.getByRole('textbox', { name: /Comment on step 3/ }), 'use staging');

    useCoworkStore.getState().advance(CONVERSATION, 3);
    await user.click(screen.getByRole('button', { name: 'Redirect from here' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/The run has already reached this step/);
    expect(alert).not.toHaveTextContent(/stopped/);
    expect(screen.queryByTestId('cowork-directive-3')).toBeNull();
  });
});

/**
 * THE REFUSAL VOCABULARY, ALL FOUR OF IT.
 *
 * `refusalText` is the only thing that turns a `RedirectRefusal` into a
 * sentence a user reads. THREE of its four arms are already driven through the
 * button by the tests above, which is what proves the wiring — `emptyComment`
 * by opening the box and submitting it empty, needing no race at all, and
 * `taskHasStopped` and `stepIsNotAhead` through the race this file's own
 * header describes. `refusalText`'s docblock in `ProgressPanel.tsx` says the
 * same three; an earlier version of this paragraph said two, and disagreed
 * with the function it is about.
 *
 * `noSuchStep` is the one arm no press reaches in this build: it needs a plan
 * that loses a step while its comment box is open, and nothing here does that.
 * Measured, all four arms, by giving one of them another arm's sentence and
 * running this whole file:
 *
 *  - `emptyComment` swapped: `Tests  2 failed | 24 passed (26)` — the
 *    blank-comment test that presses the button, and the one below;
 *  - `taskHasStopped` and `stepIsNotAhead` swapped for each other:
 *    `Tests  3 failed | 23 passed (26)` — both of their tests, and the one
 *    below;
 *  - `noSuchStep` swapped: `Tests  1 failed | 25 passed (26)` — the one below,
 *    and nothing else in the file. With this file excluded the same mutation is
 *    SILENT across the rest of the suite: `122 passed (122)` files,
 *    `2479 passed (2479)` tests, EXIT=0.
 *
 * That last line is what this block is for, and `noSuchStep` is the only
 * sentence of the four that needs it.
 */
describe('what each refusal is allowed to say', () => {
  it('gives every refusal its own sentence, and neither of the two confusable ones borrows the other’s reason', () => {
    expect(refusalText('emptyComment')).toBe(
      'Write something first — a blank comment would not redirect anything.',
    );
    expect(refusalText('noSuchStep')).toBe('That step is no longer in the plan.');
    expect(refusalText('taskHasStopped')).toBe(
      'This task has stopped, so nothing will arrive at this step to read a comment.',
    );
    expect(refusalText('stepIsNotAhead')).toBe(
      'The run has already reached this step, so a comment here would never be read.',
    );

    const all = REFUSALS.map((refusal) => refusalText(refusal));
    expect(new Set(all).size).toBe(all.length);
    // The two that are easiest to confuse are the two a user is likeliest to
    // meet, and telling someone the run "already reached" a step of a task that
    // died before it is a false sentence about their own task.
    expect(refusalText('taskHasStopped')).not.toMatch(/already reached/);
    expect(refusalText('stepIsNotAhead')).not.toMatch(/stopped/);
  });
});

describe('parallel tasks', () => {
  it('lists every task and marks the open one with aria-current', async () => {
    givePlan(PLAN, 2);
    useCoworkStore.getState().setPlan('conversation-beta', ['Something else']);
    mount();

    const mine = screen.getByTestId(`cowork-task-${CONVERSATION}`);
    const other = screen.getByTestId('cowork-task-conversation-beta');
    // The same attribute and value the sidebar's own conversation rows carry, so
    // the two switchers cannot describe the selection differently.
    expect(mine).toHaveAttribute('aria-current', 'page');
    expect(other).not.toHaveAttribute('aria-current');
  });

  it('switches the window’s conversation through the same action the sidebar uses', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    useCoworkStore.getState().setPlan('conversation-beta', ['Something else']);
    mount();

    await user.click(screen.getByTestId('cowork-task-conversation-beta'));
    // One piece of state, not two: switching a task here is switching the
    // conversation, or the dock and the sidebar could disagree about what is open.
    expect(useNavigationStore.getState().selectedConversationId).toBe('conversation-beta');
  });

  it('keeps each task’s plan separate', async () => {
    givePlan(PLAN, 2);
    useCoworkStore.getState().setPlan('conversation-beta', ['Something else']);
    useCoworkStore.getState().advance('conversation-beta', 1);

    const plans = useCoworkStore.getState().plans;
    expect(plans[CONVERSATION]?.currentStep).toBe(2);
    expect(plans['conversation-beta']?.currentStep).toBe(1);
  });
});

describe('the project panel', () => {
  it('sends project_layout — the command that had no renderer caller', async () => {
    const user = userEvent.setup({ delay: null });
    const host = new WatchedHost();
    const { projects } = await host.invoke('project_list', {});
    const project = projects[0];
    expect(project).toBeDefined();
    if (project === undefined) return;

    render(
      <PlatformProvider adapter={host}>
        <CoworkDock onClose={() => undefined} runtime={null} projectId={project.id} />
      </PlatformProvider>,
    );

    await user.click(screen.getByRole('tab', { name: 'Project' }));
    await waitFor(() => {
      expect(host.sent).toContain('project_layout');
    });
  });

  it('shows where the working directory is and whether the host reached it', async () => {
    const user = userEvent.setup({ delay: null });
    const host = new BrowserAdapter();
    const { projects } = await host.invoke('project_list', {});
    const project = projects[0];
    expect(project).toBeDefined();
    if (project === undefined) return;

    render(
      <PlatformProvider adapter={host}>
        <CoworkDock onClose={() => undefined} runtime={null} projectId={project.id} />
      </PlatformProvider>,
    );

    await user.click(screen.getByRole('tab', { name: 'Project' }));
    const row = await screen.findByTestId('cowork-working-directory');
    // The browser fake has no working directory bound, and reports `none` — an
    // ordinary, complete state that must not be drawn as a failure.
    expect(row).toHaveAttribute('data-kind', 'none');
    expect(screen.getByTestId('cowork-workspace')).toBeVisible();
  });
});

describe('the context panel', () => {
  it('sends mcp_list_tools — the command whose door nothing imported', async () => {
    const host = new WatchedHost();
    render(
      <PlatformProvider adapter={host}>
        <CoworkDock onClose={() => undefined} runtime={null} projectId={null} />
      </PlatformProvider>,
    );

    // Read on open rather than on tab, so the summary is ready when the user
    // gets there. `mcp_list_tools` is the read the dock exists to make reachable.
    await waitFor(() => {
      expect(host.sent).toContain('mcp_list_tools');
    });
  });

  it('reports how many servers connected and how many tools a run could be offered', async () => {
    const user = userEvent.setup({ delay: null });
    mount();

    await user.click(screen.getByRole('tab', { name: 'Context' }));
    expect(await screen.findByTestId('cowork-context-summary')).toHaveTextContent(
      /\d+ of \d+ servers connected · \d+ tools a run could be offered/,
    );
  });
});

describe('the dock’s keyboard', () => {
  it('moves between panels with the arrow keys, carrying focus with the selection', async () => {
    const user = userEvent.setup({ delay: null });
    mount();

    const progress = screen.getByRole('tab', { name: 'Progress' });
    progress.focus();
    await user.keyboard('{ArrowRight}');

    const project = screen.getByRole('tab', { name: 'Project' });
    expect(project).toHaveAttribute('aria-selected', 'true');
    expect(project).toHaveFocus();
    // A roving tabindex, so one Tab enters the tablist and one leaves it.
    expect(progress).toHaveAttribute('tabindex', '-1');
    expect(project).toHaveAttribute('tabindex', '0');
  });

  it('wraps at both ends rather than dead-ending', async () => {
    const user = userEvent.setup({ delay: null });
    mount();

    screen.getByRole('tab', { name: 'Progress' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Context' })).toHaveAttribute('aria-selected', 'true');
  });
});
