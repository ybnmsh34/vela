/**
 * The keyboard cannot leave a modal dialog.
 *
 * ## Why this is a separate file from the focus tests next to it
 *
 * `src/app/focus-ownership.test.tsx` asks where the keyboard goes when an
 * overlay *closes*. This asks where it can go while one is **open**, which is a
 * different promise made by a different attribute and was kept by nothing.
 *
 * Both dialogs declared `aria-modal="true"` — a statement to assistive
 * technology that everything outside the dialog is unreachable — and neither
 * enforced it. There was no Tab handling anywhere in either component. Tab off
 * the last control landed in the application behind, Shift+Tab off the first
 * landed there too, and a screen-reader user was told the background was inert
 * on the way in and then walked straight into it.
 *
 * ## What is asserted, and what deliberately is not
 *
 * Not that the attribute is present. The attribute is the *claim under audit*;
 * asserting it would be asserting the defect. What is asserted is reachability:
 * the real focusable set of the application behind the dialog is measured from
 * the DOM, shown to be non-trivial, and then shown to be unreachable by walking
 * Tab in both directions and checking after every press.
 *
 * The focusable set is computed here with its own selector rather than by asking
 * the trap what it thinks a tab stop is. A test that took the implementation's
 * word for what is focusable would agree with it however wrong it was.
 *
 * **Honesty (conventions §10):** VERIFIED-BY-FAKE. jsdom is not a browser
 * engine, and `@testing-library/user-event` computes its own Tab destination
 * rather than asking one. What is proven is that the dialogs' own key handling
 * runs, refuses the press, and moves the keyboard where it says — and that the
 * elements it refuses to hand the keyboard to are really there and really
 * focusable. A real engine's Tab order is not exercised here; see the report.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { NO_CAPABILITIES, type ModelCapabilityReport } from '@/platform/contract';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';

type User = ReturnType<typeof userEvent.setup>;

/**
 * ## Why every `userEvent.setup` here passes `delay: null`
 *
 * `userEvent`'s default `delay: 0` yields to the event loop once per simulated
 * input step, and on this box a `setTimeout(0)` turn costs a full Windows
 * scheduler tick — measured at 14.3-15.1ms, idle or loaded. These tests press
 * Tab twelve times and click several more, so the default charges a tick per
 * press for nothing: what is asserted is *where the keyboard lands*, never how
 * long it took to get there.
 *
 * Measured here, against the real `App`: twelve `user.tab()` cost 520ms idle and
 * 959 / 2859 / 3154ms under three concurrent full `vitest` runs; the same twelve
 * with `delay: null` cost 182ms idle and 527 / 1189 / 1523ms. The two trapping
 * tests below failed 5 of 6 full-suite runs under that load before this change,
 * both by exceeding the 5000ms default.
 */

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

async function openConversation(user: User): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
  await screen.findByRole('region', { name: 'Conversation' });
}

/**
 * What a browser stops on. Deliberately broad and deliberately naive — it is a
 * description of HTML, not of Vela, so it cannot drift with the trap.
 */
const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, [tabindex]';

/** The focusable set of the application *behind* `dialog`, from the live DOM. */
function behind(dialog: Element): readonly HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      !dialog.contains(element) && !element.hasAttribute('disabled') && element.tabIndex >= 0,
  );
}

/** Enough of an element to name it in a failure without printing the tree. */
function name(element: Element | null): string {
  if (element === null) return 'nothing';
  if (element === document.body) return '<body>';
  const label = element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40);
  return `<${element.tagName.toLowerCase()}> ${label ?? ''}`.trim();
}

/**
 * Press Tab `presses` times, checking after *every* press rather than at the
 * end: a trap that leaks on the first press and is rescued by a later wrap is
 * still a leak, and only a per-press check can tell the two apart.
 */
async function walkTab(
  user: User,
  dialog: Element,
  presses: number,
  shift = false,
): Promise<void> {
  for (let press = 1; press <= presses; press += 1) {
    await user.tab({ shift });
    expect(
      dialog.contains(document.activeElement),
      `${shift ? 'Shift+Tab' : 'Tab'} #${press} left the dialog: the keyboard is on ${name(
        document.activeElement,
      )}, which aria-modal says is unreachable`,
    ).toBe(true);
  }
}

beforeEach(() => {
  resetModelStore();
  resetNavigationStore();
});

describe('a modal dialog holds the keyboard it says it holds', () => {
  it('does not let Tab out of the command bar in either direction', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App adapter={await host()} />);
    await openConversation(user);

    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');

    // The control for the whole assertion: if the application behind the dialog
    // had no focusable elements, staying inside would prove nothing at all. It
    // measured fourteen here — window chrome, the sidebar, the row controls, the
    // resize separator, the model switcher, the composer and its send button.
    // The floor is written loose because the number is a property of the app on
    // screen, and this test is about the dialog.
    const reachableIfUntrapped = behind(dialog);
    expect(
      reachableIfUntrapped.length,
      'nothing focusable behind the dialog — this test would pass vacuously',
    ).toBeGreaterThan(8);

    await walkTab(user, dialog, 6);
    await walkTab(user, dialog, 6, true);

    expect(reachableIfUntrapped).not.toContain(document.activeElement);
  });

  it('wraps the command bar onto its own single stop rather than off it', async () => {
    // The palette is the one-focusable-child case in the running product: the
    // result rows are `option`s inside a `listbox`, so the text field is the
    // only tab stop there is. Wrapping to "the next one" has to mean itself.
    const user = userEvent.setup({ delay: null });
    render(<App adapter={await host()} />);
    await openConversation(user);

    await user.keyboard('{Control>}k{/Control}');
    const field = await screen.findByRole('combobox');
    expect(field).toHaveFocus();

    await user.tab();
    expect(field).toHaveFocus();
    await user.tab({ shift: true });
    expect(field).toHaveFocus();
  });

  it('wraps Tab from the delete dialog’s last control back onto its first', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App adapter={await host()} />);
    await openConversation(user);

    await user.click(screen.getByRole('button', { name: 'Delete New conversation' }));
    const dialog = await screen.findByRole('alertdialog');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    expect(cancel).toHaveFocus();

    await user.tab();
    expect(confirm).toHaveFocus();
    // Off the end of the dialog, which is where the leak was.
    await user.tab();
    expect(cancel).toHaveFocus();
  });

  it('wraps Shift+Tab from the delete dialog’s first control onto its last', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App adapter={await host()} />);
    await openConversation(user);

    await user.click(screen.getByRole('button', { name: 'Delete New conversation' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toHaveFocus();
  });

  it('does not let Tab out of the delete dialog into the list it is asking about', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App adapter={await host()} />);
    await openConversation(user);

    await user.click(screen.getByRole('button', { name: 'Delete New conversation' }));
    const dialog = await screen.findByRole('alertdialog');

    const reachableIfUntrapped = behind(dialog);
    expect(
      reachableIfUntrapped.length,
      'nothing focusable behind the dialog — this test would pass vacuously',
    ).toBeGreaterThan(8);

    await walkTab(user, dialog, 6);
    await walkTab(user, dialog, 6, true);

    expect(reachableIfUntrapped).not.toContain(document.activeElement);
  });

  it('does not let Tab out of the endpoint-removal dialog into the panel behind it', async () => {
    // The third surface driven in this file, out of the seven that render
    // through `ModalSurface` — driven for the same property rather than assumed
    // to inherit it. The background here is a different one from the two above:
    // the endpoints panel, its rows, the local-endpoint form and the debug
    // switch. So the non-vacuity floor is measured against that screen rather
    // than carried over.
    const user = userEvent.setup({ delay: null });
    render(<App adapter={await host()} />);
    await openConversation(user);

    await user.click(screen.getByRole('button', { name: /The workstation/u }));
    await user.click(await screen.findByRole('button', { name: 'Manage endpoints…' }));
    const panel = await screen.findByRole('region', { name: 'Endpoints' });
    await user.click(within(panel).getByRole('button', { name: 'Remove: The workstation' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Remove this endpoint?' });
    const reachableIfUntrapped = behind(dialog);
    expect(
      reachableIfUntrapped.length,
      'nothing focusable behind the dialog — this test would pass vacuously',
    ).toBeGreaterThan(8);

    await walkTab(user, dialog, 6);
    await walkTab(user, dialog, 6, true);

    expect(reachableIfUntrapped).not.toContain(document.activeElement);
  });
});

describe('containing the keyboard did not cost the giving of it back', () => {
  // The half of the FAIL that was already closed. These are here so the trap
  // cannot be built on top of the restore by breaking it.

  it('still returns the keyboard to the composer when Escape closes the command bar', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App adapter={await host()} />);
    await openConversation(user);

    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus();
  });

  it('still returns the keyboard when the command bar is dismissed by a click outside', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App adapter={await host()} />);
    await openConversation(user);

    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    const scrim = dialog.parentElement;
    expect(scrim).not.toBeNull();

    await user.click(scrim as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    expect(document.activeElement, 'focus was dropped to <body>').not.toBe(document.body);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus();
  });

  it('still returns the keyboard to the row when the delete dialog is cancelled by a click', async () => {
    const user = userEvent.setup({ delay: null });
    render(<App adapter={await host()} />);
    await openConversation(user);

    const row = screen.getByRole('button', { name: 'Open New conversation' });
    row.focus();
    await user.keyboard('{Delete}');
    const dialog = await screen.findByRole('alertdialog');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    expect(document.activeElement, 'focus was dropped to <body>').not.toBe(document.body);
    expect(screen.getByRole('button', { name: 'Open New conversation' })).toHaveFocus();
  });
});
