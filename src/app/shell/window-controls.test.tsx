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

import { join } from 'node:path';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { PlatformAdapter, Unsubscribe, WindowControls } from '@/platform/adapter';
import { BrowserAdapter } from '@/platform/browser-adapter';
import type { CapabilitySurface } from '@/platform/capability-surface';
import {
  capabilitiesInFile,
  permissionsReaching,
  readCapabilitySurface,
  resolveLoaded,
} from '@/platform/capability-surface';
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
  /**
   * Read once, and read *inside* the assertions rather than while the file is
   * being collected. A capability tree the reader refuses — a registration
   * naming nothing, two files claiming one identifier, a TOML file nothing here
   * can parse — has to fail a named assertion below. A collection error is a
   * real failure too, but it arrives attributed to the file rather than to the
   * guard, which is the difference between a message somebody acts on and a
   * message somebody reruns.
   */
  let cached: CapabilitySurface | undefined;
  const surface = (): CapabilitySurface => (cached ??= readCapabilitySurface(process.cwd()));
  const grantedToMain = (): readonly string[] => permissionsReaching(surface().loaded, 'main');

  /**
   * **Every capability file the build loads, by name.**
   *
   * This list, {@link REGISTERED_CAPABILITIES} and {@link GRANTED_PERMISSIONS}
   * are three lists over one derivation, and they are separate because they fail
   * for three different reasons: a file appearing or disappearing, a
   * registration changing, and the permissions themselves moving.
   *
   * The previous version of this block read `src-tauri/capabilities/main.json`
   * by name. The build does not: it globs the directory and selects from what it
   * found. A second capability file granting the main window
   * `core:window:allow-set-always-on-top` and `core:window:allow-hide`,
   * registered in `src-tauri/tauri.conf.json`, left this file and
   * `src/platform/project-host-parity.test.ts` both green at 39 of 39 — the
   * exact-set assertion below was exact about the contents of one file out of a
   * directory nothing enumerated.
   */
  const CAPABILITY_FILES = ['main.json'];

  /**
   * **Every capability identifier the build ends up with, in load order.**
   *
   * Not filenames: the loader keys a capability by its own `identifier` field,
   * so `main.json` could declare itself anything. This is the identifier list,
   * and {@link CAPABILITY_FILES} above is the file list, and needing to edit
   * both is the point — a capability renamed in place moves one of them.
   *
   * The registration is what makes an on-disk file live. An entry naming an
   * identifier that no file declares is a build failure, not a silent nothing;
   * a file no entry names is loaded by nobody and grants nothing, which is dead
   * weight and is reported below rather than tolerated.
   */
  const REGISTERED_CAPABILITIES = ['main'];

  /**
   * The whole grant, entry by entry, with the caller that needs each one.
   *
   * **This list is the assertion, it is an exact set rather than a shape, and it
   * is compared against the union over every capability the build loads** —
   * `src/platform/capability-surface.ts` derives that union from the directory
   * listing and from `app.security.capabilities`, the way tauri-utils 2.9.3
   * does, rather than from a path typed here.
   *
   * Two earlier versions of this block were narrower than the thing they
   * described. The first asked only that the five window permissions the title
   * bar calls were present, and `project-host-parity.test.ts` asks only that
   * every entry is prefixed `core:event:` or `core:window:`; both are satisfied
   * by a grant strictly wider than this one, and
   * `core:window:allow-set-always-on-top`, `core:window:allow-set-position`,
   * `core:window:allow-hide` and `core:event:allow-emit-to` were added together
   * to `main.json` and neither test moved. The second — the exact set — closed
   * that and left the level above it open: the same four permissions arrive just
   * as easily in a second file. A window permission is not harmless because it
   * is a window permission. `allow-hide` alone would let the renderer hide the
   * only window this app has, and `src-tauri/tauri.conf.json` declares one
   * window and no tray icon, so nothing would be left to bring it back.
   *
   * **What the three lists now force, exactly.** Any change that widens what the
   * main window may call through the capability system fails one of the four
   * assertions below: a permission added to an existing capability file, a
   * permission added by a new capability file, a capability written inline into
   * `src-tauri/tauri.conf.json` with no file at all, a file registered or
   * unregistered, or a capability renamed. Each can still be done — by editing
   * the list it moves, in the same commit, which is the review this block exists
   * to force.
   *
   * **What they do not force, said plainly.** These lists say nothing about
   * whether a permission is *needed*; that argument is the prose beside each
   * entry and a reader has to do it. They cover the capability system only —
   * every command in `src-tauri/src/ipc/mod.rs` reaches the renderer through the
   * IPC allowlist instead, which is a different mechanism with different guards.
   * And the derivation is a *copy* of the loader's resolution rules read out of
   * the pinned sources, not a reading of a built binary: if a future tauri
   * changes how `app.security.capabilities` resolves, this reader is what goes
   * stale, and the version it was read from is written down in its header.
   *
   * This file owns the union rather than `src/platform/project-host-parity.test.ts`
   * because this is the file that can say *why* each entry is granted: the
   * callers are the seam in `src/platform/tauri-adapter.ts` and the drag region
   * in `src/app/shell/TitleBar.tsx`, both of which are under test here. That
   * other file keeps its prefix check — now over the same union — which is not
   * this assertion said twice: it fails on any plugin-namespaced permission
   * (`fs:`, `dialog:`, `shell:`, `http:` and anything else that is not `core:`)
   * without anyone having to update a list, so it still bites in a commit that
   * edits these lists too.
   */
  const GRANTED_PERMISSIONS = [
    // Every host push the renderer consumes — `chat:event` and `sandbox:event`,
    // the two named in `src/platform/adapter.ts` — through `listen` in
    // `tauri-adapter.ts`, plus the window's own `onResized` subscription.
    'core:event:default',
    // The drag region in `TitleBar.tsx`. Tauri's injected script turns a
    // mousedown over `data-tauri-drag-region` into `"start_dragging"`.
    'core:window:allow-start-dragging',
    // The three title-bar buttons, plus the state read the maximise button
    // needs so its icon reflects the window rather than the click.
    'core:window:allow-minimize',
    'core:window:allow-toggle-maximize',
    'core:window:allow-is-maximized',
    'core:window:allow-close',
  ];

  it('loads these capability files and no others', () => {
    expect(surface().files).toEqual([...CAPABILITY_FILES].sort());
    // A file the loader's glob skips is not a grant, but it is also not nothing:
    // it is a capability somebody wrote that never takes effect. Reported here
    // rather than dropped, because "it is in the directory" is what its author
    // will believe.
    expect(surface().ignoredFiles).toEqual([]);
  });

  it('registers every capability it ships, and ships every capability it registers', () => {
    expect(surface().loaded.map((capability) => capability.identifier)).toEqual(
      REGISTERED_CAPABILITIES,
    );
    // The other direction. `readCapabilitySurface` throws on a registration
    // naming an identifier no file declares — the build does too — so the case
    // left is a file nobody registered, which loads nothing and grants nothing.
    expect([...surface().onDisk].map((capability) => capability.identifier).sort()).toEqual(
      [...REGISTERED_CAPABILITIES].sort(),
    );
  });

  it('points every loaded capability at the one window this app has', () => {
    // This is what makes "the union below is what the main window holds" a
    // statement rather than an approximation. `src-tauri/tauri.conf.json`
    // declares exactly one window, labelled `main`; a capability aimed anywhere
    // else grants nothing to anybody, and a glob is read wide by the derivation
    // rather than matched, so both cases have to be excluded by hand here.
    for (const capability of surface().loaded) {
      expect(capability.windows, capability.source).toEqual(['main']);
      expect(capability.webviews, capability.source).toEqual([]);
    }
  });

  it('grants these permissions to the main window and nothing else', () => {
    expect(grantedToMain()).toEqual([...GRANTED_PERMISSIONS].sort());
  });

  it('read a real grant, not an empty one', () => {
    // The control. A capability file that lost its `permissions` key, a
    // registration that selected nothing, or a `process.cwd()` that is not the
    // repository root must not turn the comparison above into two empty lists
    // agreeing. The reader throws rather than returning empty on the last of
    // those; the first two are held here.
    //
    // No count is pinned on purpose: a number would be a second copy of the
    // list's length and would fail on every deliberate widening, which is the
    // one case the exact set above is meant to let through under review.
    expect(GRANTED_PERMISSIONS.length).toBeGreaterThan(0);
    expect(grantedToMain().length).toBeGreaterThan(0);
    expect(surface().loaded.length).toBeGreaterThan(0);

    // And the five the title bar actually calls, pinned by name rather than by
    // membership of the list above, so that deleting one from both still fails.
    for (const permission of [
      'core:window:allow-minimize',
      'core:window:allow-toggle-maximize',
      'core:window:allow-is-maximized',
      'core:window:allow-close',
      'core:window:allow-start-dragging',
    ]) {
      expect(grantedToMain()).toContain(permission);
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
    //
    // Kept even though the exact set above already excludes these two: this one
    // is absolute. Adding `core:window:allow-internal-toggle-maximize` to both a
    // capability file and `GRANTED_PERMISSIONS` keeps the set comparison green
    // and still fails here, which is the point — these two are not a matter of
    // review, they are a matter of the renderer already owning the gesture.
    expect(grantedToMain()).not.toContain('core:window:allow-internal-toggle-maximize');
    expect(grantedToMain()).not.toContain('core:window:default');
  });
});

describe('the union above is derived, and the derivation can fail', () => {
  /**
   * Controls over `src/platform/capability-surface.ts` itself, on fabricated
   * input rather than on the tree — the assertions above are only worth what the
   * reader under them is worth, and every one of these is a way the reader could
   * have quietly returned a smaller set than the build loads.
   */
  const capabilityFile = (identifier: string, permissions: readonly string[]): string =>
    JSON.stringify({ identifier, windows: ['main'], permissions });

  it('reads a second file as a second capability, not as a replacement', () => {
    const onDisk = [
      ...capabilitiesInFile(capabilityFile('main', ['core:event:default']), 'a.json'),
      ...capabilitiesInFile(capabilityFile('probe', ['core:window:allow-hide']), 'b.json'),
    ];
    expect(permissionsReaching(resolveLoaded(onDisk, ['main', 'probe']), 'main')).toEqual([
      'core:event:default',
      'core:window:allow-hide',
    ]);
  });

  it('counts a capability written inline in the config, which has no file at all', () => {
    const onDisk = capabilitiesInFile(capabilityFile('main', ['core:event:default']), 'a.json');
    const inline = { identifier: 'inline', windows: ['main'], permissions: ['shell:allow-open'] };
    expect(permissionsReaching(resolveLoaded(onDisk, ['main', inline]), 'main')).toEqual([
      'core:event:default',
      'shell:allow-open',
    ]);
  });

  it('loads the whole directory when the config selects nothing, which is the widening', () => {
    // The branch that reads as "none" and means "all". Deleting
    // `app.security.capabilities`, or emptying it, does not switch the app off —
    // it hands the app every file in the directory.
    const onDisk = [
      ...capabilitiesInFile(capabilityFile('main', ['core:event:default']), 'a.json'),
      ...capabilitiesInFile(capabilityFile('probe', ['core:window:allow-hide']), 'b.json'),
    ];
    for (const registration of [null, []]) {
      expect(permissionsReaching(resolveLoaded(onDisk, registration), 'main')).toEqual([
        'core:event:default',
        'core:window:allow-hide',
      ]);
    }
  });

  it('throws on a registration naming a capability that does not exist', () => {
    const onDisk = capabilitiesInFile(capabilityFile('main', ['core:event:default']), 'a.json');
    expect(() => resolveLoaded(onDisk, ['main', 'absent'])).toThrow(/not found/);
  });

  it('throws on two capabilities claiming one identifier, as the build does', () => {
    const onDisk = [
      ...capabilitiesInFile(capabilityFile('main', ['core:event:default']), 'a.json'),
      ...capabilitiesInFile(capabilityFile('main', ['core:window:allow-hide']), 'b.json'),
    ];
    expect(() => resolveLoaded(onDisk, ['main'])).toThrow(/identifier/);
  });

  it('reads all three file shapes, so a list is not read as one capability', () => {
    const one = { identifier: 'one', windows: ['main'], permissions: ['core:event:default'] };
    const two = { identifier: 'two', windows: ['main'], permissions: ['core:window:allow-hide'] };
    expect(capabilitiesInFile(JSON.stringify(one), 'x.json')).toHaveLength(1);
    expect(capabilitiesInFile(JSON.stringify([one, two]), 'x.json')).toHaveLength(2);
    expect(capabilitiesInFile(JSON.stringify({ capabilities: [one, two] }), 'x.json')).toHaveLength(
      2,
    );
  });

  it('reads a scoped permission entry by its identifier, not as an unreadable object', () => {
    const scoped = JSON.stringify({
      identifier: 'scoped',
      windows: ['main'],
      permissions: [{ identifier: 'fs:allow-write-text-file', allow: [{ path: '$HOME/test.txt' }] }],
    });
    expect(permissionsReaching(capabilitiesInFile(scoped, 'x.json'), 'main')).toEqual([
      'fs:allow-write-text-file',
    ]);
  });

  it('errs wide on a glob and on a label that is not this window', () => {
    const glob = JSON.stringify({
      identifier: 'glob',
      windows: ['admin-*'],
      permissions: ['core:window:allow-hide'],
    });
    const elsewhere = JSON.stringify({
      identifier: 'elsewhere',
      windows: ['other'],
      permissions: ['core:window:allow-hide'],
    });
    // A glob is counted against `main` whether or not it reaches it, so the
    // reader over-reports rather than missing a grant.
    expect(permissionsReaching(capabilitiesInFile(glob, 'x.json'), 'main')).toEqual([
      'core:window:allow-hide',
    ]);
    // A literal label that is not this window reaches nothing — which is why the
    // block above pins the window list of every loaded capability by hand.
    expect(permissionsReaching(capabilitiesInFile(elsewhere, 'x.json'), 'main')).toEqual([]);
  });

  it('throws rather than returning nothing when the root is wrong', () => {
    expect(() => readCapabilitySurface(join(process.cwd(), 'no-such-directory'))).toThrow();
  });
});
