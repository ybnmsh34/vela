/**
 * The window controls, as the user meets them.
 *
 * ## What is being held here
 *
 * The app is created with `decorations: false`, so this title bar *is* the
 * window's title bar. Until this landed there was no in-window way to minimise,
 * maximise or close: Alt+F4 and the taskbar still worked, which is why nobody
 * noticed.
 *
 * ## The assertion that carries the weight
 *
 * "The icon flips when you click it" is not the property. `toggle-maximize` can
 * be refused — a window manager that will not maximise, a size constraint, a
 * host that failed — and an implementation that flips a local boolean on click
 * passes that test while showing a *restore* icon over a window that is not
 * maximised. So the fake here can honour or refuse the toggle independently of
 * being asked, and the control is required to end up wherever the window
 * actually is. The quantity under test is the window's state, never the click.
 *
 * ## What this file cannot see, said plainly
 *
 * This is jsdom. It proves the seam is called and the DOM is right. It proves
 * nothing about whether Windows actually minimises the window, whether the drag
 * region drags, or whether the hit targets land where WebView2 puts them. That
 * verdict belongs to the desktop session on real WebView2.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { PlatformAdapter, Unsubscribe, WindowControls } from '@/platform/adapter';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';

import { TitleBar } from './TitleBar';

/**
 * A window whose real state this test owns.
 *
 * `honourToggle` is the knob that matters: with it off, `toggleMaximize()`
 * resolves and changes nothing, which is exactly what a refused toggle looks
 * like from the renderer.
 */
class FakeWindow implements WindowControls {
  maximized: boolean;
  honourToggle = true;
  readonly calls: string[] = [];
  readonly #resized = new Set<() => void>();

  constructor(maximized = false) {
    this.maximized = maximized;
  }

  async minimize(): Promise<void> {
    this.calls.push('minimize');
  }

  async toggleMaximize(): Promise<void> {
    this.calls.push('toggleMaximize');
    // Deliberately silent: no resize event. The control must be correct because
    // it re-read the window, not because an event happened to arrive.
    if (this.honourToggle) this.maximized = !this.maximized;
  }

  async isMaximized(): Promise<boolean> {
    this.calls.push('isMaximized');
    return this.maximized;
  }

  async close(): Promise<void> {
    this.calls.push('close');
  }

  async onResized(handler: () => void): Promise<Unsubscribe> {
    this.#resized.add(handler);
    return () => {
      this.#resized.delete(handler);
    };
  }

  /** The window manager moved the window with nobody clicking: Win+Up, a snap. */
  outsideTheApp(maximized: boolean): void {
    this.maximized = maximized;
    for (const handler of [...this.#resized]) handler();
  }

  countOf(call: string): number {
    return this.calls.filter((name) => name === call).length;
  }
}

function renderTitleBar(fake: FakeWindow) {
  const inner = new BrowserAdapter();
  const adapter: PlatformAdapter = {
    kind: inner.kind,
    invoke: inner.invoke.bind(inner),
    listen: inner.listen.bind(inner),
    window: fake,
  };
  return render(
    <PlatformProvider adapter={adapter}>
      <TitleBar context="Untitled workspace" />
    </PlatformProvider>,
  );
}

function dragRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>('[data-tauri-drag-region]');
  if (region === null) throw new Error('the title bar has no drag region');
  return region;
}

describe('the title bar carries the window controls', () => {
  it('renders minimise, maximise and close, in Windows order, at the right', async () => {
    const fake = new FakeWindow();
    renderTitleBar(fake);

    const bar = screen.getByRole('banner');
    const names = within(bar)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'));

    // Windows order, and the window controls last — the corner of the window.
    expect(names).toEqual(['Theme: system', 'Minimise', 'Maximise', 'Close']);
    await waitFor(() => expect(fake.countOf('isMaximized')).toBeGreaterThan(0));
  });

  it('minimises and closes through the seam, once per click', async () => {
    const user = userEvent.setup();
    const fake = new FakeWindow();
    renderTitleBar(fake);

    await user.click(screen.getByRole('button', { name: 'Minimise' }));
    expect(fake.countOf('minimize')).toBe(1);
    expect(fake.countOf('close')).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(fake.countOf('close')).toBe(1);
    expect(fake.countOf('minimize')).toBe(1);
  });
});

describe('the maximise control reports the window, not the click', () => {
  it('offers restore when the app opens onto a window that is already maximised', async () => {
    const fake = new FakeWindow(true);
    renderTitleBar(fake);

    // No interaction at all. A control that only learns the state by being
    // clicked shows "Maximise" over a maximised window from the first frame.
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Maximise' })).toBeNull();
  });

  it('becomes restore when the toggle took', async () => {
    const user = userEvent.setup();
    const fake = new FakeWindow(false);
    renderTitleBar(fake);

    await user.click(await screen.findByRole('button', { name: 'Maximise' }));

    expect(fake.maximized).toBe(true);
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('goes back to maximise when restore took', async () => {
    const user = userEvent.setup();
    const fake = new FakeWindow(true);
    renderTitleBar(fake);

    await user.click(await screen.findByRole('button', { name: 'Restore' }));

    expect(fake.maximized).toBe(false);
    expect(await screen.findByRole('button', { name: 'Maximise' })).toBeInTheDocument();
  });

  it('does not lie when the window manager refuses the toggle', async () => {
    const user = userEvent.setup();
    const fake = new FakeWindow(false);
    fake.honourToggle = false;
    renderTitleBar(fake);

    const before = fake.countOf('isMaximized');
    await user.click(await screen.findByRole('button', { name: 'Maximise' }));

    // It asked, and it asked again afterwards rather than assuming.
    expect(fake.countOf('toggleMaximize')).toBe(1);
    await waitFor(() => expect(fake.countOf('isMaximized')).toBeGreaterThan(before));

    // The window did not move, so neither does the control.
    expect(fake.maximized).toBe(false);
    expect(screen.getByRole('button', { name: 'Maximise' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('follows the window when it is maximised from outside the app', async () => {
    const fake = new FakeWindow(false);
    renderTitleBar(fake);
    expect(await screen.findByRole('button', { name: 'Maximise' })).toBeInTheDocument();

    act(() => {
      fake.outsideTheApp(true);
    });

    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(fake.countOf('toggleMaximize')).toBe(0);
  });
});

describe('the drag region', () => {
  it('keeps its bare drag attribute and holds no control', () => {
    const fake = new FakeWindow();
    renderTitleBar(fake);

    // Bare, not "deep": Tauri's drag script treats `''` and `'true'` as "only a
    // direct click on this element drags", `'deep'` as "anything in the subtree
    // drags", and `'false'` as "nothing here drags". Bare is what keeps a
    // control placed inside the bar from becoming a drag handle by accident.
    // React renders a valueless JSX `data-` attribute as `"true"`.
    expect(['', 'true']).toContain(dragRegion().getAttribute('data-tauri-drag-region'));

    for (const button of within(screen.getByRole('banner')).getAllByRole('button')) {
      expect(
        button.closest('[data-tauri-drag-region]'),
        `${button.getAttribute('aria-label') ?? '?'} is inside the drag region and will not receive clicks`,
      ).toBeNull();
    }
  });

  it('toggles maximise on a double click, exactly once', async () => {
    const user = userEvent.setup();
    const fake = new FakeWindow(false);
    renderTitleBar(fake);
    await screen.findByRole('button', { name: 'Maximise' });

    await user.dblClick(dragRegion());

    // Once. A `dblclick` handler *and* Tauri's own detail-2 `mousedown` handler
    // both firing is a toggle followed by a toggle back: a gesture that looks
    // dead while doing two things.
    expect(fake.countOf('toggleMaximize')).toBe(1);
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('leaves a single click alone, so the window can still be dragged', async () => {
    const user = userEvent.setup();
    const fake = new FakeWindow(false);
    renderTitleBar(fake);
    await screen.findByRole('button', { name: 'Maximise' });

    await user.click(dragRegion());

    expect(fake.countOf('toggleMaximize')).toBe(0);
  });

  it('keeps the double-click gesture away from the framework, so it cannot fire twice', async () => {
    const user = userEvent.setup();
    const fake = new FakeWindow(false);
    renderTitleBar(fake);
    await screen.findByRole('button', { name: 'Maximise' });

    // Tauri injects its own `mousedown` listener on `document`, and on a
    // detail-2 press over a drag region it invokes
    // `"internal_toggle_maximize"`. This stands in for it: the second press
    // must not reach the document, or the window is toggled twice.
    const reachedDocument: number[] = [];
    const spy = (event: MouseEvent): void => {
      reachedDocument.push(event.detail);
    };
    document.addEventListener('mousedown', spy);
    try {
      await user.dblClick(dragRegion());
    } finally {
      document.removeEventListener('mousedown', spy);
    }

    expect(reachedDocument).toContain(1);
    expect(reachedDocument).not.toContain(2);
  });
});

describe('close is not reachable by accident', () => {
  it('is last in the tab order and holds no focus at mount', async () => {
    const user = userEvent.setup();
    const fake = new FakeWindow();
    renderTitleBar(fake);

    expect(document.activeElement).toBe(document.body);

    const reached: (string | null)[] = [];
    for (let step = 0; step < 4; step += 1) {
      await user.tab();
      reached.push(document.activeElement?.getAttribute('aria-label') ?? null);
    }

    expect(reached).toEqual(['Theme: system', 'Minimise', 'Maximise', 'Close']);
  });

  it('needs a real click: a press that slides off does nothing', async () => {
    const user = userEvent.setup();
    const fake = new FakeWindow();
    renderTitleBar(fake);
    const close = screen.getByRole('button', { name: 'Close' });

    // Press on the button, release somewhere else. A control wired to
    // `mousedown` — which is what the drag region's double click uses — would
    // have shut the app down here.
    await user.pointer([
      { keys: '[MouseLeft>]', target: close },
      { target: dragRegion() },
      { keys: '[/MouseLeft]' },
    ]);

    expect(fake.countOf('close')).toBe(0);
  });
});

describe('the capability grant matches the wire that was run', () => {
  const capabilities = JSON.parse(
    readFileSync(join(process.cwd(), 'src-tauri', 'capabilities', 'main.json'), 'utf8'),
  ) as { permissions: string[] };

  it('grants exactly the window commands the title bar calls', () => {
    for (const permission of [
      'core:window:allow-minimize',
      'core:window:allow-toggle-maximize',
      'core:window:allow-is-maximized',
      'core:window:allow-close',
      'core:window:allow-start-dragging',
    ]) {
      expect(capabilities.permissions).toContain(permission);
    }
  });

  it('withholds internal-toggle-maximize, because the renderer owns that gesture', () => {
    // Tauri's injected drag script invokes `"internal_toggle_maximize"` on a
    // detail-2 mousedown over a drag region. This app handles that gesture
    // itself, through the seam, so it can be tested and so the icon is re-read
    // from the window afterwards. Granting this permission as well would put
    // two toggles on one double click — and the second one would arrive with no
    // state re-read behind it. If a future capability edit adds it, delete the
    // renderer's handler in the same commit.
    expect(capabilities.permissions).not.toContain('core:window:allow-internal-toggle-maximize');
    expect(capabilities.permissions).not.toContain('core:window:default');
  });
});
