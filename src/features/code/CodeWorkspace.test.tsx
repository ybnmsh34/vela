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
 * idle or loaded. Nothing here asserts how long a click took, and this file and
 * its sibling drive enough of them for the default to show up in the clock. Run
 * as a pair, their `tests` time measures 31.10s, 14.89s and 18.46s with
 * `delay: null` (three runs, the first cold) against 82.64s and 49.56s with a
 * plain `userEvent.setup()` (two runs), same machine, same session.
 *
 * What that costs any *other* file is not measured. Every test in this repo has
 * a five-second per-test budget and a contended full run does cross it — one
 * run here went `4 failed | 2518 passed (2522)`, all four `Test timed out in
 * 5000ms`, and the next run of the same tree was clean — but no measurement
 * here attributes a specific crossing to this file's delay setting.
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

function mount(adapter: BrowserAdapter, onClose: () => void = () => undefined) {
  return render(
    <PlatformProvider adapter={adapter}>
      <CodeWorkspace onClose={onClose} />
    </PlatformProvider>,
  );
}

/**
 * Fill in all five choices and press Start.
 *
 * Five, not the spec's four: this build adds the worktree name, and
 * `isComplete` in `src/state/code-workspace-store.ts` refuses a draft missing
 * any of them — which `refuses a half-filled form and says which half` measures
 * with the worktree alone filled in.
 */
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

  it('opens the panes once all five choices are made', async () => {
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

    // The session line carries four of the five choices — worktree, folder,
    // environment, permission mode — and this reads all four back off it. The
    // model is the fifth and it is on no line, so it is read back off the
    // session itself. That last pair of assertions is the only place in the
    // code workspace's own tests where the pair is read back out of a session
    // this form built. Every other occurrence of the pair in this workspace's
    // test files is an object-literal property being written into a fixture,
    // four of them: the provider registered on the host in `host()` here and
    // the identical one in `src/app/code-workspace-wiring.test.tsx`, and the
    // provider/model pair the session seed passes to `startSession` in
    // `DiffPane.test.tsx`. So the Model select was driven and its result checked
    // by nothing. (Elsewhere under `src/` the pair is read back out of plenty of
    // things that are neither a seed nor a session: catalogue entries in
    // `src/features/models/catalogue.test.ts`, a reply record in
    // `src/features/conversation/use-conversation-record.test.tsx`. This is a
    // claim about this workspace's tests, not about the tree.)
    const line = screen.getByTestId('code-session-line');
    expect(line).toHaveTextContent('fix-a');
    expect(line).toHaveTextContent('C:/code/vela');
    expect(line).toHaveTextContent('local');
    expect(line).toHaveTextContent('acceptEdits');
    expect(useCodeWorkspaceStore.getState().sessions[0]?.permissionMode).toBe('acceptEdits');
    expect(useCodeWorkspaceStore.getState().sessions[0]?.providerId).toBe('workstation');
    expect(useCodeWorkspaceStore.getState().sessions[0]?.modelId).toBe('local-model');
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

describe('Escape, with a menu open', () => {
  /**
   * The disclosure's own header argues that a disclosure claims Tab and Escape
   * and nothing more — so Escape has to actually close it. It did not: the key
   * handler sat on the list, which is a *sibling* of the trigger button, and
   * after clicking Move the keyboard is on the trigger. The key bubbled past the
   * list to the workspace's own Escape handler and closed the whole surface,
   * leaving the menu open behind it.
   */
  it('closes a pane’s move disclosure and leaves the workspace open', async () => {
    const user = driver();
    let closes = 0;
    mount(await host(), () => {
      closes += 1;
    });
    await startSession(user, 'fix-a');

    const trigger = screen.getByRole('button', { name: 'Move Diff pane' });
    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'Move into the column on the left' })).toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);

    await user.keyboard('{Escape}');

    expect(
      screen.queryByRole('button', { name: 'Move into the column on the left' }),
    ).not.toBeInTheDocument();
    expect(closes).toBe(0);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes the Views menu and leaves the workspace open', async () => {
    const user = driver();
    let closes = 0;
    mount(await host(), () => {
      closes += 1;
    });
    await startSession(user, 'fix-a');

    const trigger = screen.getByRole('button', { name: 'Views' });
    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'Reset layout' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('button', { name: 'Reset layout' })).not.toBeInTheDocument();
    expect(closes).toBe(0);
    expect(document.activeElement).toBe(trigger);
  });

  it('still closes the workspace when no menu is open', async () => {
    // The other half: swallowing Escape whenever a header is focused would take
    // away the exit the surface is supposed to have.
    const user = driver();
    let closes = 0;
    mount(await host(), () => {
      closes += 1;
    });
    await startSession(user, 'fix-a');

    await user.click(screen.getByRole('button', { name: 'Move Diff pane' }));
    await user.keyboard('{Escape}');
    await user.keyboard('{Escape}');

    expect(closes).toBe(1);
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

  it('announces a maximum the edge can actually be dragged to', async () => {
    // `aria-valuemax` was `100 - floor`, computed from the per-member floor —
    // but how far an *edge* can move is set by the pair it divides, and only
    // `shiftPair` in `src/lib/pane-layout.ts` knows that. The announced 92 was a
    // number the control could not reach; End stops at 58. Same shape as the
    // defect this track's diff work fixed: a value computed from an input that
    // cannot answer the question.
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    const [first] = screen.getAllByRole('separator');
    const announced = Number((first as HTMLElement).getAttribute('aria-valuemax'));

    (first as HTMLElement).focus();
    await user.keyboard('{End}');

    const reached = Math.round(
      (useCodeWorkspaceStore.getState().layout.columns[0]?.weight ?? 0) * 100,
    );
    expect(announced).toBe(reached);
  });

  it('announces a minimum the edge can actually be dragged to', async () => {
    const user = driver();
    mount(await host());
    await startSession(user, 'fix-a');

    const [first] = screen.getAllByRole('separator');
    const announced = Number((first as HTMLElement).getAttribute('aria-valuemin'));

    (first as HTMLElement).focus();
    await user.keyboard('{Home}');

    const reached = Math.round(
      (useCodeWorkspaceStore.getState().layout.columns[0]?.weight ?? 0) * 100,
    );
    expect(announced).toBe(reached);
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
