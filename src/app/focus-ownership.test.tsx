/**
 * Who owns the keyboard.
 *
 * ## Why this file exists
 *
 * A Phase C interaction critic found four reproducible moments where Vela drops
 * focus to `<body>`: Escape out of the command bar, confirming a delete,
 * committing an F2 rename, and dismissing the model switcher by choosing a
 * model. From `<body>` the keyboard is nowhere — Tab restarts at the top of the
 * document, which measured **eleven** presses to get back to the composer after
 * the command bar closed. A chat application that loses the keyboard after
 * every dialog is unusable without a mouse.
 *
 * That verdict is **PROVISIONAL** — Linux WebKitGTK is not Windows WebView2 —
 * but `document.activeElement` after a click is not an engine opinion. It is a
 * fact about the DOM, and it is the same fact in jsdom, WebKitGTK and WebView2.
 * So it is treated as real and asserted here.
 *
 * ## The shape of the defect, which is the shape of the whole wave
 *
 * Every one of these overlays is *correct on its own*. `DeleteConversationDialog`
 * even captured `document.activeElement` on open and restored it on close — and
 * still dropped focus, because the element it so carefully remembered is the
 * conversation row it was asking permission to destroy. Each component minded
 * its own focus. Nobody owned focus.
 *
 * ## What is asserted
 *
 * Never `<body>`, and then something stronger: *which* element. "Not body" alone
 * would pass if focus landed on the window's first button, which is a different
 * bug wearing the same green tick.
 *
 * **Honesty (conventions §10):** VERIFIED-BY-FAKE. `BrowserAdapter` is an
 * in-memory host and jsdom is not a browser engine. What is proven is that the
 * app's own focus wiring runs and lands where it says.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { NO_CAPABILITIES, type ModelCapabilityReport } from '@/platform/contract';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';

function report(): ModelCapabilityReport {
  return {
    providerId: 'workstation',
    modelId: 'local-model',
    capabilities: { ...NO_CAPABILITIES, streaming: true },
    structuredOutput: false,
    toolCallsEmulated: false,
    contextWindowTokens: 8_192,
    maxOutputTokens: null,
    probed: true,
    findings: [],
  };
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
  adapter.seedCapabilities(report());
  return adapter;
}

async function openConversation(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
  await screen.findByRole('region', { name: 'Conversation' });
}

function composer(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Message' });
}

function row(title = 'New conversation'): HTMLElement {
  return screen.getByRole('button', { name: `Open ${title}` });
}

/**
 * The assertion the whole file is about, in one place so a failure names the
 * defect rather than an element id.
 *
 * `document.body` is the DOM's null island. Focus there is not "focus on the
 * page" — it is the state Tab measures eleven presses out of.
 */
function expectKeyboardIsSomewhere(): void {
  expect(
    document.activeElement,
    'focus was dropped to <body>: from here Tab restarts at the top of the document',
  ).not.toBe(document.body);
  expect(document.activeElement, 'focus was dropped entirely').not.toBeNull();
}

beforeEach(() => {
  resetModelStore();
  resetNavigationStore();
});

describe('focus has an owner: no overlay may drop the keyboard on the floor', () => {
  it('returns the keyboard to the composer when the command bar is dismissed', async () => {
    // The measured worst case: eleven Tab presses back to the composer.
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await openConversation(user);

    await user.keyboard('{Control>}k{/Control}');
    const field = await screen.findByRole('combobox');
    expect(field).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('combobox')).toBeNull();
    });

    expectKeyboardIsSomewhere();
    expect(composer()).toHaveFocus();
  });

  it('returns the keyboard to the composer after a conversation is deleted', async () => {
    // The dialog restored focus to the row it had just destroyed, which is the
    // same as restoring nothing. Deleting the open conversation also closes it,
    // so the deliberate destination is the home screen's primary action — the
    // one thing there is to do next.
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await openConversation(user);

    await user.click(screen.getByRole('button', { name: 'Delete New conversation' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Open New conversation' })).toBeNull();
    });

    expectKeyboardIsSomewhere();
    expect(await screen.findByRole('button', { name: 'Start a conversation' })).toHaveFocus();
  });

  it('keeps the keyboard on the conversation row after a delete is cancelled', async () => {
    // The control for the case above: cancelling destroys nothing, so the row
    // the dialog was asked about is still there and is where focus belongs.
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await openConversation(user);

    row().focus();
    await user.keyboard('{Delete}');
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    expectKeyboardIsSomewhere();
    expect(row()).toHaveFocus();
  });

  it('returns the keyboard to the row after an F2 rename is committed', async () => {
    // Renaming from the keyboard and then losing the keyboard means the arrow
    // keys that walk the list are gone, one rename in.
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await openConversation(user);

    row().focus();
    await user.keyboard('{F2}');
    const field = await screen.findByRole('textbox', { name: 'Rename New conversation' });
    expect(field).toHaveFocus();

    await user.clear(field);
    await user.type(field, 'Star charts');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: /^Rename/u })).toBeNull();
    });

    expectKeyboardIsSomewhere();
    await waitFor(() => {
      expect(row('Star charts')).toHaveFocus();
    });
  });

  it('returns the keyboard to the row when an F2 rename is abandoned', async () => {
    // Escape is the other exit, and it must not be the one that costs the
    // keyboard — abandoning an edit is the *safe* action.
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await openConversation(user);

    row().focus();
    await user.keyboard('{F2}');
    await screen.findByRole('textbox', { name: 'Rename New conversation' });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: /^Rename/u })).toBeNull();
    });

    expectKeyboardIsSomewhere();
    expect(row()).toHaveFocus();
  });

  it('returns the keyboard to the switcher trigger when a model is chosen', async () => {
    // The popover unmounts under the option the user just activated. Nothing
    // else was ever going to hold the keyboard.
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await openConversation(user);

    const trigger = screen.getByRole('button', { name: /The workstation/u });
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: /local-model/u }));

    await waitFor(() => {
      expect(screen.queryByRole('option')).toBeNull();
    });

    expectKeyboardIsSomewhere();
    expect(screen.getByRole('button', { name: /The workstation/u })).toHaveFocus();
  });

  it('moves the keyboard into the endpoints panel, and back out again', async () => {
    // The same defect on the way *in*: "Manage endpoints…" unmounts itself, so
    // the surface it opens has to take the keyboard rather than assume it.
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await openConversation(user);

    await user.click(screen.getByRole('button', { name: /The workstation/u }));
    await user.click(await screen.findByRole('button', { name: 'Manage endpoints…' }));

    const panel = await screen.findByRole('region', { name: 'Endpoints' });
    expectKeyboardIsSomewhere();
    expect(panel.contains(document.activeElement)).toBe(true);

    await user.click(within(panel).getByRole('button', { name: 'Close the endpoints panel' }));
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Endpoints' })).toBeNull();
    });

    expectKeyboardIsSomewhere();
    expect(composer()).toHaveFocus();
  });
});
