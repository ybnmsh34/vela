/**
 * The code workspace: the session gate, the pane system, and the keyboard.
 *
 * These are written against the assembled workspace rather than against the
 * store, because every one of them is a claim about what a *user* can do. The
 * layout arithmetic is proven separately and exhaustively in
 * `src/lib/pane-layout.test.ts`; what is here is the wiring — that pressing this
 * reaches that.
 *
 * ## What these cannot show
 *
 * jsdom lays nothing out. `getBoundingClientRect` is all zeros, so a pointer
 * drag has to be handed a container size for its arithmetic to mean anything,
 * and it is: the one drag test substitutes a width and asserts the layout moved
 * by the fraction that implies. That makes the arithmetic real and leaves one
 * thing unproven — that a real WebView2 pointer emits this sequence of events.
 * The keyboard path needs no substitution at all.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { paneOrder } from '@/lib/pane-layout';
import {
  resetCodeWorkspaceStore,
  useCodeWorkspaceStore,
  type PaneKind,
} from '@/state/code-workspace-store';
import { resetFocusStore } from '@/state/focus-store';

import { CodeWorkspace } from './CodeWorkspace';

/**
 * `delay: null` for the reason `src/app/modal-containment.test.tsx` records:
 * `userEvent`'s default yields once per simulated input step and a
 * `setTimeout(0)` turn costs a full Windows scheduler tick whether the box is
 * idle or loaded. Nothing here asserts how long a click took — and this file
 * drives enough of them that its default-delay form took thirty seconds of the
 * suite's wall clock, which is enough parallel load to push the source-scanning
 * guards in `src/platform/` past their five-second per-test budget.
 */
function driver(): ReturnType<typeof userEvent.setup> {
  return userEvent.setup({ delay: null });
}

async function host(): Promise<BrowserAdapter> {
  const adapter = new BrowserAdapter();
  await adapter.invoke('settings_put_provider', {
    id: 'workstation',
    displayName: 'The workstation',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelId: 'local-model',
  });
  return adapter;
}

function mount(adapter: BrowserAdapter) {
  return render(
    <PlatformProvider adapter={adapter}>
      <CodeWorkspace onClose={() => undefined} />
    </PlatformProvider>,
  );
}

/** Fill in the four choices and press Start. */
async function startSession(
  user: ReturnType<typeof userEvent.setup>,
  worktree: string,
): Promise<void> {
  await user.click(screen.getByLabelText('Worktree name'));
  await user.paste(worktree);
  await user.click(screen.getByLabelText('Project folder'));
  await user.paste('C:/code/vela');
  await user.click(screen.getByRole('radio', { name: /^Local/ }));
  await waitFor(() => {
    expect(
      within(screen.getByLabelText('Model')).getByRole('option', { name: /workstation/ }),
    ).toBeInTheDocument();
  });
  await user.selectOptions(screen.getByLabelText('Model'), 'workstation::local-model');
  await user.selectOptions(screen.getByLabelText('Permission mode'), 'acceptEdits');
  await user.click(screen.getByRole('button', { name: 'Start session' }));
}

function layout(): readonly PaneKind[] {
  return paneOrder(useCodeWorkspaceStore.getState().layout);
}

beforeEach(() => {
  resetCodeWorkspaceStore();
  resetFocusStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the session gate', () => {
  it('shows no panes until a session has been configured', async () => {
    mount(await host());

    expect(screen.getByRole('form', { name: 'New session' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Chat pane' })).not.toBeInTheDocument();
  });

  it('refuses a half-filled form and says which half', async () => {
    const user = driver();
    mount(await host());

    await user.click(screen.getByLabelText('Worktree name'));
    await user.paste('fix-a');
    await user.click(screen.getByRole('button', { name: 'Start session' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Fill in every field above before starting the session.',
    );
    expect(useCodeWorkspaceStore.getState().sessions).toHaveLength(0);
  });

  it('opens the panes once all four choices are made', async () => {
    const user = driver();
    mount(await host());

    await startSession(user, 'fix-a');

    expect(await screen.findByRole('region', { name: 'Chat pane' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Diff pane' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Editor pane' })).toBeInTheDocument();
  });

  it('records the permission mode on the session and shows it', async () => {
    const user = driver();
    mount(await host());

    await startSession(user, 'fix-a');

    // All four choices, read back off the session line. Three of them were
    // rendered and asserted by nothing, which is how a field becomes decoration.
    const line = screen.getByTestId('code-session-line');
    expect(line).toHaveTextContent('fix-a');
    expect(line).toHaveTextContent('C:/code/vela');
    expect(line).toHaveTextContent('local');
    expect(line).toHaveTextContent('acceptEdits');
    expect(useCodeWorkspaceStore.getState().sessions[0]?.permissionMode).toBe('acceptEdits');
  });
});

describe('worktree isolation', () => {
  it('refuses a second session on a worktree a session already has', async () => {
    const user = driver();
    mount(await host());

    await startSession(user, 'fix-a');
    await user.selectOptions(screen.getByLabelText('Session'), '');
    await startSession(user, 'fix-a');

    expect(screen.getByRole('alert')).toHaveTextContent(
      'A session already has that worktree. Isolation means one session per worktree.',
    );
    expect(useCodeWorkspaceStore.getState().sessions).toHaveLength(1);
  });

  it('refuses one that differs only by case, because that is one directory here', async () => {
    // NTFS and APFS fold case. Two sessions on `Fix-A` and `fix-a` are two
    // sessions on one directory, which is the state worktree isolation exists to
    // prevent — and it would only be caught on Linux, where it is not a problem.
    const user = driver();
    mount(await host());

    await startSession(user, 'Fix-A');
    await user.selectOptions(screen.getByLabelText('Session'), '');
    await startSession(user, 'fix-a');

    expect(screen.getByRole('alert')).toHaveTextContent('A session already has that worktree.');
    expect(useCodeWorkspaceStore.getState().sessions).toHaveLength(1);
  });

  it('keeps one session’s files out of another’s', async () => {
    const user = driver();
    mount(await host());

    await startSession(user, 'fix-a');
    const editor = within(screen.getByRole('region', { name: 'Editor pane' }));
    await user.click(editor.getByLabelText('Open a file'));
    await user.paste('src/only-in-a.ts');
    await user.click(editor.getByRole('button', { name: 'Open' }));
    expect(editor.getByRole('button', { name: /only-in-a/ })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Session'), '');
    await startSession(user, 'fix-b');

    const other = within(screen.getByRole('region', { name: 'Editor pane' }));
    expect(other.queryByText('src/only-in-a.ts')).not.toBeInTheDocument();
  });
});

describe('the review round and the composer share one queue', () => {
  it('does not let a typed message throw away a review that was never sent', async () => {
    // The reason `queueMessage` and `submitComments` are two actions rather than
    // one. They differ in what they *consume*: a review round empties the pending
    // comments, a typed message must not. Folding them together is the tidier
    // shape and it silently discards a reviewer's work.
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    const editor = within(screen.getByRole('region', { name: 'Editor pane' }));
    await user.click(editor.getByLabelText('Open a file'));
    await user.paste('src/a.ts');
    await user.click(editor.getByRole('button', { name: 'Open' }));
    await user.click(editor.getByLabelText('src/a.ts'));
    await user.paste('let total = 0;');

    const diff = within(screen.getByRole('region', { name: 'Diff pane' }));
    await user.click(diff.getByRole('button', { name: /^Comment on line 1 after/ }));
    await user.click(screen.getByLabelText('Your comment on line 1'));
    await user.paste('const, surely');
    await user.click(diff.getByRole('button', { name: 'Add comment' }));

    const chat = within(screen.getByRole('region', { name: 'Chat pane' }));
    await user.click(chat.getByLabelText('Message'));
    await user.paste('actually, hold on');
    await user.click(chat.getByRole('button', { name: 'Send' }));

    const work = useCodeWorkspaceStore.getState().work['fix-a'];
    expect(work?.queue).toEqual(['actually, hold on']);
    expect(work?.comments).toHaveLength(1);
    expect(diff.getByRole('button', { name: 'Submit review' })).toBeEnabled();
  });
});

describe('the pane system', () => {
  it('closes a pane from its own header and reopens it from Views', async () => {
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    await user.click(screen.getByRole('button', { name: 'Close Diff pane' }));
    expect(layout()).toEqual(['chat', 'editor']);

    await user.click(screen.getByRole('button', { name: 'Views' }));
    await user.click(screen.getByRole('button', { name: 'Diff' }));
    expect(layout()).toEqual(['chat', 'editor', 'diff']);
  });

  it('moves a pane into another column from the keyboard, without a drag', async () => {
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    await user.click(screen.getByRole('button', { name: 'Move Diff pane' }));
    await user.click(screen.getByRole('button', { name: 'Move into the column on the left' }));

    const columns = useCodeWorkspaceStore.getState().layout.columns;
    expect(columns.map((column) => column.slots.map((slot) => slot.pane))).toEqual([
      ['chat'],
      ['editor', 'diff'],
    ]);
  });

  it('moves a pane by dragging its header onto another pane’s', async () => {
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    const diffHead = screen.getByRole('heading', { name: 'Diff' }).parentElement;
    const chatHead = screen.getByRole('heading', { name: 'Chat' }).parentElement;
    expect(diffHead).not.toBeNull();
    expect(chatHead).not.toBeNull();

    // `fireEvent`-level drag: jsdom implements no `DataTransfer`, which is why
    // `PaneFrame` reads none — the dragged pane is state the grid already holds.
    fireEvent.dragStart(diffHead as HTMLElement);
    fireEvent.dragOver(chatHead as HTMLElement);
    fireEvent.drop(chatHead as HTMLElement);

    const columns = useCodeWorkspaceStore.getState().layout.columns;
    expect(columns.map((column) => column.slots.map((slot) => slot.pane))).toEqual([
      ['diff', 'chat'],
      ['editor'],
    ]);
  });

  it('says so, rather than rendering nothing, when every pane is closed', async () => {
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    for (const name of ['Close Chat pane', 'Close Editor pane', 'Close Diff pane']) {
      await user.click(screen.getByRole('button', { name }));
    }

    expect(screen.getByText(/Every pane is closed/)).toBeInTheDocument();
  });
});

describe('the splitter between two panes', () => {
  it('is focusable and reports where it is', async () => {
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    const [first] = screen.getAllByRole('separator');
    expect(first).toHaveAttribute('aria-orientation', 'vertical');
    expect(first).toHaveAttribute('aria-valuenow', '33');
    (first as HTMLElement).focus();
    expect(document.activeElement).toBe(first);
  });

  it('moves on the arrow keys, which is the only way a keyboard can resize', async () => {
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    const [first] = screen.getAllByRole('separator');
    (first as HTMLElement).focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');

    const weights = useCodeWorkspaceStore.getState().layout.columns.map((c) => c.weight);
    expect(weights[0]).toBeCloseTo(1 / 3 + 0.04, 10);
    expect(weights[1]).toBeCloseTo(1 / 3 - 0.04, 10);
    expect(weights.reduce((total, weight) => total + weight, 0)).toBeCloseTo(1, 10);
  });

  it('stops at the floor rather than letting a pane vanish', async () => {
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    const [first] = screen.getAllByRole('separator');
    (first as HTMLElement).focus();
    await user.keyboard('{End}');

    const weights = useCodeWorkspaceStore.getState().layout.columns.map((c) => c.weight);
    expect(weights[1]).toBeGreaterThan(0);
    expect(weights.reduce((total, weight) => total + weight, 0)).toBeCloseTo(1, 10);
  });

  it('moves by the fraction of the workspace the pointer travelled', async () => {
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    const [first] = screen.getAllByRole('separator');
    // jsdom lays nothing out, so the container's width is substituted. Without
    // this the divisor is zero and the drag is refused, which is the guard in
    // `Splitter.handlePointerDown` rather than a broken test.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1000,
      height: 800,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 800,
      toJSON: () => ({}),
    });

    // jsdom has no `PointerEvent` — `fireEvent.pointerDown` therefore falls back
    // to a bare `Event`, whose constructor ignores `clientX`, and the splitter
    // receives `undefined - undefined`. Its `Number.isFinite` guard then declines
    // the drag, which is the guard working and the test measuring nothing. A
    // `MouseEvent` carrying the pointer event's *name* is what the browser's
    // `PointerEvent` is a subclass of, and it carries the coordinates.
    const pointer = (type: string, clientX: number): MouseEvent => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 0 });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      return event;
    };
    fireEvent(first as HTMLElement, pointer('pointerdown', 300));
    fireEvent(first as HTMLElement, pointer('pointermove', 400));
    fireEvent(first as HTMLElement, pointer('pointerup', 400));

    // 100px of 1000 is a tenth of the workspace.
    const weights = useCodeWorkspaceStore.getState().layout.columns.map((c) => c.weight);
    expect(weights[0]).toBeCloseTo(1 / 3 + 0.1, 10);
  });
});

describe('the keyboard', () => {
  it('walks pane focus with F6 rather than through every control in each pane', async () => {
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    await user.keyboard('{F6}');
    expect(useCodeWorkspaceStore.getState().focusedPane).toBe('chat');
    await user.keyboard('{F6}');
    expect(useCodeWorkspaceStore.getState().focusedPane).toBe('editor');
    await user.keyboard('{Shift>}{F6}{/Shift}');
    expect(useCodeWorkspaceStore.getState().focusedPane).toBe('chat');
  });

  it('walks backwards from nowhere to the last pane, not the second-to-last', async () => {
    // `(-1 - 1 + n) % n` is `n - 2`. The modular form is the obvious way to
    // write this and it is wrong exactly once, on the first Shift+F6 of a
    // session.
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    await user.keyboard('{Shift>}{F6}{/Shift}');
    expect(useCodeWorkspaceStore.getState().focusedPane).toBe('diff');
  });

  it('closes the focused pane on Ctrl+\\', async () => {
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    await user.keyboard('{F6}{F6}');
    expect(useCodeWorkspaceStore.getState().focusedPane).toBe('editor');
    await user.keyboard('{Control>}\\{/Control}');

    expect(layout()).toEqual(['chat', 'diff']);
  });

  it('hands pane focus on rather than leaving it naming a pane that is gone', async () => {
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    await user.keyboard('{F6}');
    await user.keyboard('{Control>}\\{/Control}');

    const focused = useCodeWorkspaceStore.getState().focusedPane;
    expect(focused).not.toBe('chat');
    expect(layout()).toContain(focused);
  });

  it('does not guess which pane to close when the user has not been in one', async () => {
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    await user.keyboard('{Control>}\\{/Control}');
    expect(layout()).toEqual(['chat', 'editor', 'diff']);
  });

  it('puts every pane region in visual order, so Tab and F6 agree', async () => {
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    const regions = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('data-pane'))
      .filter((pane): pane is string => pane !== null);
    expect(regions).toEqual([...layout()]);
  });
});
