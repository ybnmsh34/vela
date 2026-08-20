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
 * `userEvent.setup()` puts a real delay between keystrokes, so typing a
 * sentence into the comment box costs seconds. Measured here: the redirect
 * tests ran 2.8s and 1.5s in isolation, and under a full-suite run on a loaded
 * box one of them crossed vitest's 5s default and failed as a timeout — a red
 * that says nothing about the code. `delay: null` removes the wait and keeps
 * everything that matters: the events are the same events, dispatched in the
 * same order, through the same `user-event` machinery. Nothing here depends on
 * elapsed time, so there is nothing for the delay to be testing.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import type { CommandName, CommandReq, CommandRes } from '@/platform/contract';
import { resetCoworkStore, useCoworkStore } from '@/state/cowork-store';
import { resetNavigationStore, useNavigationStore } from '@/state/navigation-store';
import { resetFocusStore } from '@/state/focus-store';

import { CoworkDock } from './CoworkPanel';

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
    await user.click(within(step3).getByRole('button', { name: 'Comment on this step' }));
    await user.type(
      screen.getByRole('textbox', { name: /Comment on step 3/ }),
      'use the staging database instead',
    );
    await user.click(screen.getByRole('button', { name: 'Redirect from here' }));

    const directive = await screen.findByTestId('cowork-directive-3');
    expect(directive).toHaveTextContent('use the staging database instead');
    // Not yet delivered — the plan has not arrived at step 3.
    expect(directive).toHaveAttribute('data-delivered', 'no');
    expect(directive).toHaveTextContent('Will redirect');
  });

  it('reports the comment as delivered once the plan reaches that step', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    mount();

    const step3 = screen.getByTestId('cowork-step-3');
    await user.click(within(step3).getByRole('button', { name: 'Comment on this step' }));
    await user.type(screen.getByRole('textbox', { name: /Comment on step 3/ }), 'mind the index');
    await user.click(screen.getByRole('button', { name: 'Redirect from here' }));

    // The run gets there. This is the read: `advanceTo` hands the directive out
    // and marks it delivered.
    useCoworkStore.getState().advance(CONVERSATION, 3);

    await waitFor(() => {
      expect(screen.getByTestId('cowork-directive-3')).toHaveAttribute('data-delivered', 'yes');
    });
    expect(screen.getByTestId('cowork-directive-3')).toHaveTextContent('Redirected');
  });

  /**
   * THE BOUNDARY. `n >= currentStep` would offer this control on step 2, store
   * the comment, render it — and nothing would ever read it, because the plan
   * delivers on arrival and never arrives at the step it is on.
   */
  it('offers no comment control on the step that is running, or behind it', async () => {
    givePlan(PLAN, 2);
    mount();

    for (const n of [1, 2]) {
      const row = screen.getByTestId(`cowork-step-${n}`);
      expect(within(row).queryByRole('button', { name: 'Comment on this step' })).toBeNull();
    }
    for (const n of [3, 4]) {
      const row = screen.getByTestId(`cowork-step-${n}`);
      expect(within(row).getByRole('button', { name: 'Comment on this step' })).toBeVisible();
    }
  });

  it('refuses a blank comment in words rather than storing nothing', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    mount();

    const step3 = screen.getByTestId('cowork-step-3');
    await user.click(within(step3).getByRole('button', { name: 'Comment on this step' }));
    await user.click(screen.getByRole('button', { name: 'Redirect from here' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Write something first/);
    expect(screen.queryByTestId('cowork-directive-3')).toBeNull();
  });

  it('says so when a comment was never read, instead of leaving it looking like the rest', async () => {
    const user = userEvent.setup({ delay: null });
    givePlan(PLAN, 2);
    mount();

    const step4 = screen.getByTestId('cowork-step-4');
    await user.click(within(step4).getByRole('button', { name: 'Comment on this step' }));
    await user.type(screen.getByRole('textbox', { name: /Comment on step 4/ }), 'and the caveat');
    await user.click(screen.getByRole('button', { name: 'Redirect from here' }));

    // The run dies at step 2. Step 4 never arrives.
    useCoworkStore.getState().stopTask(CONVERSATION);

    expect(await screen.findByTestId('cowork-lost-directives')).toHaveTextContent(
      /One comment was never read/,
    );
    expect(screen.getByTestId('cowork-directive-4')).toHaveTextContent('Never read');
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
