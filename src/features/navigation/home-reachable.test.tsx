/**
 * **HOME WAS REACHABLE BY DELETING A CONVERSATION, AND BY NOTHING ELSE.**
 *
 * `NavigationSurface` renders `<HomeSurface/>` when
 * `navigation-store.selectedConversationId` is `null`, and the store's `select`
 * is the only way that field changes. Across the whole renderer, at
 * `run-start-2026-08-17`, `select(null)` had exactly **one** call site:
 * `deleteConversation` in `use-conversations.ts`, guarded by
 * `if (selectedId === conversationId)`. Every other caller — `createConversation`,
 * `CommandPalette`, `HomeSurface`'s recent strip, `Sidebar`'s rows — passes an
 * id. So a user reading a conversation could get back to the home screen by
 * destroying that conversation, and could not get back any other way.
 *
 * ## Why the collapsed rail is tested too, and is not an afterthought
 *
 * `sidebarCollapsed` is persisted through `layout-repository` and restored on
 * mount by `use-sidebar-layout.ts`, so a user who collapses the sidebar is in
 * the collapsed rail on every subsequent launch. A Home control that exists only
 * in the expanded branch would be a fix that is off by one branch — the same
 * shape as the defect. The last test asserts the two branches agree, by reading
 * the component's source for the call rather than by trusting that both were
 * remembered.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { KeyboardProvider } from '@/platform/KeyboardProvider';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { resetNavigationStore, useNavigationStore } from '@/state/navigation-store';

import { ConversationsProvider } from './ConversationsProvider';
import { Sidebar } from './Sidebar';

const NOW = new Date(2026, 7, 13, 14, 0, 0).getTime();

const SIDEBAR_SOURCE = readFileSync(
  join(process.cwd(), 'src/features/navigation/Sidebar.tsx'),
  'utf8',
);

function mount(adapter: BrowserAdapter) {
  return render(
    <KeyboardProvider>
      <PlatformProvider adapter={adapter}>
        <ConversationsProvider>
          <Sidebar now={() => NOW} />
        </ConversationsProvider>
      </PlatformProvider>
    </KeyboardProvider>,
  );
}

function host(): BrowserAdapter {
  return new BrowserAdapter({ now: () => NOW });
}

beforeEach(() => {
  resetNavigationStore();
});

describe('the home screen is reachable without destroying anything', () => {
  it('clears the selection from an open conversation', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({ title: 'Star charts' });
    mount(adapter);

    await user.click(await screen.findByRole('button', { name: 'Open Star charts' }));
    expect(useNavigationStore.getState().selectedConversationId).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Home' }));

    // `null` is what `NavigationSurface` renders `<HomeSurface/>` for.
    expect(useNavigationStore.getState().selectedConversationId).toBeNull();
    // And the conversation is still there. That is the half of this the delete
    // path could never satisfy.
    expect(screen.getByRole('button', { name: 'Open Star charts' })).toBeInTheDocument();
  });

  it('offers the same control from the collapsed rail', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({ title: 'Star charts' });
    mount(adapter);

    await user.click(await screen.findByRole('button', { name: 'Open Star charts' }));
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    // The rail, not the expanded head: the conversation rows are gone.
    expect(screen.queryByRole('button', { name: 'Open Star charts' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Home' }));
    expect(useNavigationStore.getState().selectedConversationId).toBeNull();
  });

  it('marks itself as the current location only while nothing is selected', async () => {
    const user = userEvent.setup();
    const adapter = host();
    adapter.seedConversation({ title: 'Star charts' });
    mount(adapter);

    await screen.findByRole('button', { name: 'Open Star charts' });
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

    await user.click(screen.getByRole('button', { name: 'Open Star charts' }));
    expect(screen.getByRole('button', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('names every icon in the collapsed rail to the pointer, not only to a reader', async () => {
    // The rail collapsed is a column of buttons whose only content is a 14px
    // glyph. `aria-label` names each one for assistive technology and names it
    // for nobody else; `title` is the browser's own tooltip and is what
    // `TitleBar.tsx` already uses for the caption buttons it draws itself.
    //
    // Asserted for *every* button in the rail rather than for the ones this
    // track happened to touch: adding a ninth unlabelled glyph is exactly how
    // the rail got to eight.
    const user = userEvent.setup();
    const adapter = host();
    mount(adapter);
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    const rail = screen.getByRole('navigation', { name: 'Primary' });
    const buttons = within(rail).getAllByRole('button');
    expect(buttons.length, 'the collapsed rail, as it stands').toBe(8);

    for (const button of buttons) {
      const name = button.getAttribute('aria-label');
      expect(name, 'an icon-only control with no aria-label').not.toBeNull();
      // No visible text: that is what makes the tooltip the only name a
      // pointer user gets, and what makes its absence a defect.
      expect(button.textContent?.trim(), `${String(name)} has visible text`).toBe('');
      expect(button.getAttribute('title'), `${String(name)} has no tooltip`).toBe(name);
    }
  });

  it('clears the selection from both branches of the component, not one', () => {
    // Read off the source rather than inferred from the two tests above, so a
    // future edit that drops the control from one branch fails here with a
    // count rather than passing whichever branch someone remembered to drive.
    //
    // **Comments are stripped first, and that is not tidiness.** RULE T: prose
    // is not evidence. The first run of this test read 3, because the module
    // header of `Sidebar.tsx` explains the defect and writes `select(null)` in a
    // sentence — a comment was inflating a count that is meant to be about code.
    // Left in, the same sentence would have let one of the two real call sites
    // be deleted without this going red.
    const code = SIDEBAR_SOURCE.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
    const clears = [...code.matchAll(/select\(null\)/gu)];
    expect(
      clears.length,
      'Sidebar must clear the selection from both the expanded head and the collapsed rail',
    ).toBe(2);
  });
});
