/**
 * Sidebar width persistence — the part of the feature that has to survive a
 * restart, so it is the part most worth an explicit test.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { resetNavigationStore, useNavigationStore } from '@/state/navigation-store';

import { useSidebarLayout } from './use-sidebar-layout';

function Harness() {
  useSidebarLayout(0);
  const width = useNavigationStore((state) => state.sidebarWidth);
  const collapsed = useNavigationStore((state) => state.sidebarCollapsed);
  const setSidebarWidth = useNavigationStore((state) => state.setSidebarWidth);
  const toggleSidebar = useNavigationStore((state) => state.toggleSidebar);

  return (
    <div>
      <span data-testid="width">{width}</span>
      <span data-testid="collapsed">{String(collapsed)}</span>
      <button
        type="button"
        onClick={() => {
          setSidebarWidth(360);
        }}
      >
        widen
      </button>
      <button type="button" onClick={toggleSidebar}>
        collapse
      </button>
    </div>
  );
}

function mount(adapter: BrowserAdapter) {
  return render(
    <PlatformProvider adapter={adapter}>
      <Harness />
    </PlatformProvider>,
  );
}

beforeEach(() => {
  resetNavigationStore();
});

describe('sidebar layout persistence', () => {
  it('adopts the width the host has stored', async () => {
    const adapter = new BrowserAdapter();
    await adapter.invoke('ui_set_layout', { sidebarWidth: 340, sidebarCollapsed: true });
    mount(adapter);

    await waitFor(() => {
      expect(screen.getByTestId('width')).toHaveTextContent('340');
    });
    expect(screen.getByTestId('collapsed')).toHaveTextContent('true');
  });

  it('writes a new width back so it survives a restart', async () => {
    const user = userEvent.setup();
    const adapter = new BrowserAdapter();
    mount(adapter);

    await waitFor(() => {
      expect(screen.getByTestId('width')).toHaveTextContent('280');
    });
    await user.click(screen.getByRole('button', { name: 'widen' }));

    await waitFor(async () => {
      await expect(adapter.invoke('ui_get_layout', {})).resolves.toMatchObject({
        sidebarWidth: 360,
      });
    });
  });

  it('keeps the width while collapsed, so expanding restores what the user chose', async () => {
    const user = userEvent.setup();
    const adapter = new BrowserAdapter();
    mount(adapter);

    await waitFor(() => {
      expect(screen.getByTestId('width')).toHaveTextContent('280');
    });
    await user.click(screen.getByRole('button', { name: 'widen' }));
    await user.click(screen.getByRole('button', { name: 'collapse' }));

    await waitFor(async () => {
      await expect(adapter.invoke('ui_get_layout', {})).resolves.toEqual({
        sidebarWidth: 360,
        sidebarCollapsed: true,
      });
    });
  });

  it('does not overwrite the stored layout with a default before it has loaded', async () => {
    // A slow host must not lose the user's width to the local default that was
    // showing while the read was in flight.
    const adapter = new BrowserAdapter({ latencyMs: 20 });
    await adapter.invoke('ui_set_layout', { sidebarWidth: 420, sidebarCollapsed: false });
    mount(adapter);

    await waitFor(() => {
      expect(screen.getByTestId('width')).toHaveTextContent('420');
    });
    await expect(adapter.invoke('ui_get_layout', {})).resolves.toMatchObject({
      sidebarWidth: 420,
    });
  });

  it('draws a window even when the layout cannot be read', async () => {
    class FailingAdapter extends BrowserAdapter {
      override async invoke(): Promise<never> {
        throw new Error('store is unreachable');
      }
    }
    mount(new FailingAdapter());

    // A layout we cannot read is not a reason to fail to draw a window.
    expect(screen.getByTestId('width')).toHaveTextContent('280');
  });
});
