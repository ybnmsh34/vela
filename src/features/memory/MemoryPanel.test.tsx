/**
 * The memory pane: transparency, and what it must never claim.
 *
 * The reference's lesson worth copying is that memory the user can *read and
 * correct* beats memory that is merely accurate — a wrong remembered fact
 * silently steers every later answer, and a user who cannot see it cannot fix
 * it. So these tests are about what the pane shows and what it lets the user
 * do, not about the store beneath it.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { MEMORY_CONTENT_MAX_CHARS } from '@/platform/contract';
import { resetMemoryStore } from '@/state/memory-store';

import { MemoryPanel } from './MemoryPanel';

function mount(adapter: BrowserAdapter) {
  return render(
    <PlatformProvider adapter={adapter}>
      <MemoryPanel onClose={() => undefined} />
    </PlatformProvider>,
  );
}

beforeEach(() => {
  resetMemoryStore();
});

describe('the memory pane', () => {
  it('says nothing is remembered rather than showing an empty box', async () => {
    mount(new BrowserAdapter());
    expect(await screen.findByText('Nothing is remembered yet.')).toBeInTheDocument();
  });

  it('writes what the user typed and shows it back, editable', async () => {
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await user.click(await screen.findByRole('textbox', { name: 'Remember something' }));
    await user.paste('answers should be terse');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Category' }),
      'commsPrefs',
    );
    await user.click(screen.getByRole('button', { name: 'Remember this' }));

    // Editable in place, not read-only text: the correction path is the whole
    // point of a transparent memory.
    const row = await screen.findByRole('textbox', { name: 'Memory: answers should be terse' });
    expect(row).toHaveValue('answers should be terse');
    // Asked of the row, not the document: the same words are also an option in
    // the category picker above it.
    expect(
      within(screen.getByRole('listitem')).getByText('Communication preferences'),
    ).toBeInTheDocument();
  });

  it('forgets an entry when asked, and says so', async () => {
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await user.click(await screen.findByRole('textbox', { name: 'Remember something' }));
    await user.paste('uses pnpm');
    await user.click(screen.getByRole('button', { name: 'Remember this' }));
    await screen.findByRole('textbox', { name: 'Memory: uses pnpm' });

    await user.click(screen.getByRole('button', { name: 'Forget: uses pnpm' }));
    expect(await screen.findByText('Nothing is remembered yet.')).toBeInTheDocument();
  });

  it('pins an entry, and reports the pin as a pressed state rather than a colour', async () => {
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await user.click(await screen.findByRole('textbox', { name: 'Remember something' }));
    await user.paste('uses pnpm');
    await user.click(screen.getByRole('button', { name: 'Remember this' }));
    await screen.findByRole('textbox', { name: 'Memory: uses pnpm' });

    await user.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pinned' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });

  it('refuses to save an over-long entry and says what the limit is', async () => {
    // Refused in the pane rather than at the host, so the sentence the user
    // reads names the limit instead of saying the row would not insert.
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    const box = await screen.findByRole('textbox', { name: 'Remember something' });
    await user.click(box);
    await user.paste('x'.repeat(MEMORY_CONTENT_MAX_CHARS + 1));

    expect(screen.getByRole('button', { name: 'Remember this' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      String(MEMORY_CONTENT_MAX_CHARS),
    );
  });

  it('reports a memory it could not read instead of drawing it as empty', async () => {
    // An empty memory and an unreadable one look identical on screen, and one
    // of them is a lie.
    class BrokenHost extends BrowserAdapter {
      override async invoke(command: never, payload: never): Promise<never> {
        if ((command as string) === 'memory_list') throw new Error('index unavailable');
        return super.invoke(command, payload);
      }
    }
    mount(new BrokenHost() as BrowserAdapter);

    expect(await screen.findByRole('status')).toHaveTextContent(/Memory unavailable/u);
    expect(screen.queryByText('Nothing is remembered yet.')).not.toBeInTheDocument();
  });

  it('says out loud that nothing is captured automatically', async () => {
    // The pane is the only writer. A user must not be left assuming their
    // conversations are being mined for facts, because they are not — and if
    // that ever changes, this sentence and this test change with it.
    mount(new BrowserAdapter());
    expect(
      await screen.findByText(/Nothing is added automatically from your conversations/u),
    ).toBeInTheDocument();
  });
});
