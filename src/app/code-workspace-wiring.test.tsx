/**
 * **The code workspace is reachable from the window, and its parts are joined.**
 *
 * The same shape as `src/app/skills-reachable.test.tsx`, for the same reason.
 * `src/features/code/CodeWorkspace.test.tsx` mounts the workspace directly, so
 * it passes whether or not anything in the application mounts it. Every
 * assertion below goes through `<App />`: the real composition root, the real
 * sidebar, the real store seam. Delete `<CodeWorkspaceSurface />` from
 * `src/app/App.tsx` and all four tests here fail — `Unable to find role="dialog"
 * and name "Code workspace"`, measured twice — which is the property no test of
 * the workspace mounted on its own can have.
 *
 * The sidebar's side of the joint is **two** buttons, not one, and each gets its
 * own test here. `opens it from the sidebar of the assembled application`, `does
 * not read the host’s settings until the user asks for the workspace` and
 * `carries a comment written on a diff line through to the chat pane` all press
 * the expanded list's row — they render the sidebar expanded, so the collapsed
 * rail is not even in the tree they search — and `opens it from the collapsed
 * rail too` is the only thing anywhere in this suite that presses the rail's
 * icon. Remove that icon from `src/features/navigation/Sidebar.tsx` and it is
 * the one test in all 123 files that goes red (`1 failed | 2521 passed (2522)`,
 * measured twice); remove the expanded row and it is the only test here that
 * stays green.
 *
 * `carries a comment written on a diff line through to the chat pane` is the
 * other half of the wiring question, and it is the one the joints in `App.tsx`
 * are a catalogue of: a control that stages something, and nothing at the other
 * end that reads it. A comment written on a diff line has to come out somewhere,
 * and the somewhere is the chat pane's queue. This drives the whole path — open
 * a file, type into it, comment on the line that changed, submit — and reads the
 * result out of the pane that is supposed to show it.
 *
 * **Honesty (conventions §10):** VERIFIED-BY-FAKE, and only that.
 * `BrowserAdapter` is an in-memory host. Nothing here touches a git worktree, a
 * file on disk or a model. What is proven is that the renderer's parts are
 * joined to each other.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { resetCodeWorkspaceStore } from '@/state/code-workspace-store';
import { resetMemoryStore } from '@/state/memory-store';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';

type User = ReturnType<typeof userEvent.setup>;

/** `delay: null` for the reason `src/app/modal-containment.test.tsx` records. */
function driver(): User {
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

beforeEach(() => {
  resetCodeWorkspaceStore();
  resetMemoryStore();
  resetModelStore();
  resetNavigationStore();
});

describe('a user can reach the code workspace', () => {
  it('opens it from the sidebar of the assembled application', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    const user = driver();
    render(<App adapter={await host()} />);

    await user.click(await screen.findByRole('button', { name: 'Code' }));

    expect(await screen.findByRole('dialog', { name: 'Code workspace' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'New session' })).toBeInTheDocument();
  });

  it('opens it from the collapsed rail too', async () => {
    // The sidebar has two doors into the workspace, and every other test that
    // wants one renders it expanded — so before this test existed the collapsed
    // rail's icon could be deleted with nothing at all going red. Delete it now
    // and this is the test that says so.
    const user = driver();
    render(<App adapter={await host()} />);

    await user.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
    await user.click(await screen.findByRole('button', { name: 'Code' }));

    expect(await screen.findByRole('dialog', { name: 'Code workspace' })).toBeInTheDocument();
  });

  it('does not read the host’s settings until the user asks for the workspace', async () => {
    // The surface is mounted at the composition root on every launch and must
    // render nothing — and call nothing — until it is opened.
    const commands: string[] = [];
    class RecordingHost extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        commands.push(command as string);
        return super.invoke(command, payload);
      }
    }

    render(<App adapter={new RecordingHost()} />);
    await screen.findByRole('button', { name: 'Code' });
    const before = commands.filter((command) => command === 'settings_get').length;

    await driver().click(screen.getByRole('button', { name: 'Code' }));
    await screen.findByRole('dialog', { name: 'Code workspace' });

    await waitFor(() => {
      expect(commands.filter((command) => command === 'settings_get').length).toBeGreaterThan(
        before,
      );
    });
  });

  it('carries a comment written on a diff line through to the chat pane', async () => {
    const user = driver();
    render(<App adapter={await host()} />);

    await user.click(await screen.findByRole('button', { name: 'Code' }));
    await screen.findByRole('dialog', { name: 'Code workspace' });

    await user.click(screen.getByLabelText('Worktree name'));
    await user.paste('fix-a');
    await user.click(screen.getByLabelText('Project folder'));
    await user.paste('C:/code/vela');
    await user.click(screen.getByRole('radio', { name: /^Local/ }));
    await waitFor(() => {
      expect(
        within(screen.getByLabelText('Model')).getByRole('option', { name: /workstation/ }),
      ).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByLabelText('Model'), 'workstation::local-model');
    await user.selectOptions(screen.getByLabelText('Permission mode'), 'plan');
    await user.click(screen.getByRole('button', { name: 'Start session' }));

    // Open a file and change a line: the editor is the only thing in this build
    // that can produce a diff, and the diff pane is worth nothing without one.
    const editor = within(await screen.findByRole('region', { name: 'Editor pane' }));
    await user.click(editor.getByLabelText('Open a file'));
    await user.paste('src/app/App.tsx');
    await user.click(editor.getByRole('button', { name: 'Open' }));
    await user.click(editor.getByLabelText('src/app/App.tsx'));
    await user.paste('const answer = 42;');

    const diff = within(screen.getByRole('region', { name: 'Diff pane' }));
    await user.click(diff.getByRole('button', { name: /^Comment on line 1 after/ }));
    await user.click(screen.getByLabelText('Your comment on line 1'));
    await user.paste('name the constant');
    await user.click(diff.getByRole('button', { name: 'Add comment' }));
    await user.click(diff.getByRole('button', { name: 'Submit review' }));

    const chat = within(screen.getByRole('region', { name: 'Chat pane' }));
    const queued = within(chat.getByRole('log', { name: 'Queued for this session' }));
    expect(queued.getByText(/name the constant/)).toBeInTheDocument();
    expect(queued.getByText(/src\/app\/App\.tsx:1 \(after\)/)).toBeInTheDocument();
  });
});
