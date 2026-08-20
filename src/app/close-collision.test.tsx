/**
 * **No control that dismisses a panel answers to the name that quits Vela.**
 *
 * ## The defect
 *
 * The window is created with `decorations: false`, so `TitleBar` draws the
 * caption controls itself. Its close control carried `aria-label="Close"`, and
 * every panel in the product had a dismiss button whose text was also `Close`.
 * Two controls, one name, and the consequences are not neighbours: one dismisses
 * a dialog, the other ends the process and everything unsaved in it.
 *
 * It is not a hypothetical. `tests/harness/production-bundle/drive-app-root.mjs`
 * and `drive-platform-defaults-executor.mjs` both did
 *
 * ```js
 * const close = page.getByRole('button', { name: 'Close' });
 * if ((await close.count()) > 0) await close.first().click();
 * ```
 *
 * to dismiss the endpoints panel. The title bar is the first element in the
 * shell, so the caption control is **first in document order** and `.first()`
 * selected it. `docs/audit/REPORT.md` records what that looked like from the
 * outside: `CDP Runtime.evaluate timed out after 30000ms`, then
 * `vela processes alive: 0`, with no Rust panic and no Windows Error Reporting
 * entry. Vela never crashed; the harness quit it.
 *
 * ## What is asserted, and why it is not "the names differ"
 *
 * Two properties, because either alone is one notch narrower than the defect.
 *
 * 1. **Consequence.** Every close-shaped control on screen is clicked and the
 *    window seam is watched. Dismissing a panel must not reach
 *    `WindowControls.close`; exactly one control may. This is the property the
 *    incident was about, and it does not care what anything is called.
 *
 * 2. **No name is a substring of another.** Distinct names are not enough.
 *    Playwright's `getByRole(..., { name })` matches a **case-insensitive
 *    substring** unless `exact: true` is passed, so a caption control still
 *    called `Close` would keep matching a query aimed at
 *    `Close the endpoints panel` — and keep winning, because it is first. The
 *    two drivers above now pass the panel's own name *and* `exact: true`; this
 *    assertion is what stops the names from drifting back under them.
 *
 * The state driven is the worst one the product can reach: the endpoints panel
 * is a `region`, not a modal, so it stays on screen while a dialog opens over
 * it. Three close-shaped controls at once, all reachable with the mouse.
 *
 * ## Honesty (conventions §10)
 *
 * **VERIFIED-BY-FAKE**, jsdom, tier `test-bites`. The window seam is a recording
 * double; nothing here closes a real window. Accessible names are computed by
 * `dom-accessibility-api` through Testing Library's own role queries — the same
 * computation `getByRole` uses, not a re-reading of the JSX — but jsdom is not a
 * browser and no screen reader or voice-control engine is involved. What this
 * proves is that the names are distinct, non-nesting, and wired to different
 * consequences. Whether Narrator or Voice Access announce them acceptably is
 * not established here and is not claimed.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import type { PlatformAdapter, Unsubscribe, WindowControls } from '@/platform/adapter';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { NO_CAPABILITIES, type ModelCapabilityReport } from '@/platform/contract';
import { resetMemoryStore } from '@/state/memory-store';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';
import { resetProjectStore } from '@/state/project-store';
import { resetSchedulesStore } from '@/state/schedules-store';
import { resetSkillsStore } from '@/state/skills-store';

/** A window that records what was asked of it and does nothing else. */
class RecordingWindow implements WindowControls {
  readonly calls: string[] = [];

  async minimize(): Promise<void> {
    this.calls.push('minimize');
  }

  async toggleMaximize(): Promise<void> {
    this.calls.push('toggleMaximize');
  }

  async isMaximized(): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {
    this.calls.push('close');
  }

  async onResized(): Promise<Unsubscribe> {
    return () => {};
  }

  countOf(call: string): number {
    return this.calls.filter((name) => name === call).length;
  }
}

function report(): ModelCapabilityReport {
  return {
    providerId: 'workstation',
    modelId: 'local-model',
    capabilities: { ...NO_CAPABILITIES, streaming: true },
    structuredOutput: false,
    toolCallsEmulated: false,
    contextWindowTokens: 128_000,
    maxOutputTokens: null,
    probed: true,
    findings: [],
  };
}

/** The fake host, with the window seam swapped for one that counts. */
async function host(window: RecordingWindow): Promise<PlatformAdapter> {
  const inner = new BrowserAdapter();
  await inner.invoke('settings_put_provider', {
    id: 'workstation',
    displayName: 'The workstation',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelId: 'local-model',
  });
  inner.seedCapabilities(report());
  return {
    kind: inner.kind,
    invoke: inner.invoke.bind(inner),
    listen: inner.listen.bind(inner),
    window,
  };
}

type User = ReturnType<typeof userEvent.setup>;

/**
 * Generous, and deliberately not a claim about how long anything takes. Each of
 * these renders the whole application and drives four clicks through it;
 * measured on an idle box they finish in one to two seconds. Vitest's 5s default
 * is not enough on this machine under parallel load — `canvas-wiring`,
 * `schedules-wiring` and `staged-attachment-payload` were all observed timing
 * out at 5000ms in the same full-suite run that this file did, having passed in
 * the run before it. A guard that reddens because the box was busy is a guard
 * that gets skipped.
 */
const BUDGET_MS = 30_000;

/**
 * `delay: null` for the reason `src/app/modal-containment.test.tsx` records: the
 * default yields once per simulated input step and a `setTimeout(0)` turn costs
 * a full Windows scheduler tick. Nothing here asserts how long a click took.
 */
const driver = (): User => userEvent.setup({ delay: null });

/**
 * Every control on screen whose accessible name mentions closing, with the name
 * Testing Library itself computed for it.
 *
 * The regex is deliberately loose — `/close/iu`, not the names this file
 * expects. A test that asked for the names it wanted would pass while a fourth
 * control called `Close` sat next to them.
 */
function closeShapedControls(): { element: HTMLElement; name: string }[] {
  const found: { element: HTMLElement; name: string }[] = [];
  screen.queryAllByRole('button', {
    name: (accessibleName: string, element: Element) => {
      if (/close/iu.test(accessibleName)) {
        found.push({ element: element as HTMLElement, name: accessibleName });
      }
      return false;
    },
  });
  return found;
}

/**
 * Drives the app into the state that holds the most close-shaped controls at
 * once: the endpoints panel (a `region`, so it does not go away) with the memory
 * dialog opened on top of it, under the title bar that is always there.
 */
async function threeWayState(user: User, window: RecordingWindow): Promise<void> {
  render(<App adapter={await host(window)} />);
  await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
  await screen.findByRole('region', { name: 'Conversation' });

  // The model switcher's trigger is named after whatever is selected, so it is
  // reached by its popup relationship rather than by a label that moves.
  const switcher = document.querySelector<HTMLElement>('[aria-haspopup="listbox"]');
  if (switcher === null) throw new Error('no model switcher on screen');
  await user.click(switcher);
  await user.click(await screen.findByRole('button', { name: 'Manage endpoints…' }));
  await screen.findByRole('region', { name: 'Endpoints' });

  await user.click(screen.getByRole('button', { name: 'Memory' }));
  await screen.findByRole('dialog', { name: 'Memory' });
}

beforeEach(() => {
  resetMemoryStore();
  resetModelStore();
  resetNavigationStore();
  resetProjectStore();
  resetSchedulesStore();
  resetSkillsStore();
});

describe('the name that quits Vela belongs to nothing else', () => {
  it(
    'gives every close-shaped control a name no other one contains',
    async () => {
      const window = new RecordingWindow();
      await threeWayState(driver(), window);

      const names = closeShapedControls().map((control) => control.name);
      // Three, and the count is asserted so that a control quietly losing its
      // name — an empty accessible name matches nothing — reads as a failure
      // rather than as a smaller, tidier-looking set.
      expect(names).toHaveLength(3);
      expect(new Set(names).size, `two controls share a name: ${names.join(' | ')}`).toBe(3);

      for (const outer of names) {
        for (const inner of names) {
          if (outer === inner) continue;
          expect(
            outer.toLowerCase().includes(inner.toLowerCase()),
            `"${inner}" is a substring of "${outer}", so a substring query for the ` +
              `first matches the second — which is how the harness quit the app`,
          ).toBe(false);
        }
      }
    },
    BUDGET_MS,
  );

  it(
    'reaches the window seam from exactly one of them',
    async () => {
      const user = driver();
      const window = new RecordingWindow();
      await threeWayState(user, window);

      // Dismiss the dialog by its own name. Nothing may reach the window.
      await user.click(screen.getByRole('button', { name: 'Close the memory panel' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Memory' })).toBeNull();
      });
      expect(window.countOf('close'), 'dismissing the memory panel quit Vela').toBe(0);

      // Dismiss the panel by its own name. Still nothing.
      await user.click(screen.getByRole('button', { name: 'Close the endpoints panel' }));
      await waitFor(() => {
        expect(screen.queryByRole('region', { name: 'Endpoints' })).toBeNull();
      });
      expect(window.countOf('close'), 'dismissing the endpoints panel quit Vela').toBe(0);

      // And the one control that is supposed to still does.
      await user.click(screen.getByRole('button', { name: 'Close Vela' }));
      expect(window.countOf('close')).toBe(1);
    },
    BUDGET_MS,
  );

  it(
    'answers nothing at all to the bare name the two used to share',
    async () => {
      const window = new RecordingWindow();
      await threeWayState(driver(), window);

      // Exact-match queries — Testing Library's default for a string — are what
      // the rest of this suite uses. After the fix `Close` names nothing, so a
      // stale query fails loudly instead of quietly selecting the app-quit
      // control, which is the failure mode that cost a run.
      expect(screen.queryAllByRole('button', { name: 'Close' })).toHaveLength(0);
    },
    BUDGET_MS,
  );
});
