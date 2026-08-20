/**
 * **The sweep: every accessible name two controls share, in one ledger.**
 *
 * ## Why this file exists next to `close-collision.test.tsx`
 *
 * That file fixes one pair. This one asks the question the pair was an instance
 * of: *anywhere in this product, do two things answer to the same name?* A guard
 * that only knew about `Close` would be the same defect one level down — it
 * would pass on the day someone gives a second control a name that is already
 * taken, which is exactly how the first one arrived.
 *
 * ## How a name is obtained
 *
 * By rendering, never by reading JSX. An accessible name is *computed*:
 * `aria-label`, `aria-labelledby`, the element's own text, `title` and the
 * `<title>` of an inline SVG all feed it, in that precedence, and a
 * `<kbd class="srOnly">Control N</kbd>` inside a button silently becomes part of
 * it — which is why the sidebar's new-conversation button is called
 * `New conversation Control N` below and not `New conversation`. Nothing short
 * of the real computation gets that right.
 *
 * The computation used here is Testing Library's own. `queryAllByRole`'s `name`
 * option accepts a **matcher function**, and `queryAllByRole` applies it as
 * `matches(computeAccessibleName(element, …), element, name, text => text)` —
 * read out of the shipped `@testing-library/dom` role query, not assumed.
 * Passing a function that records and returns `false` therefore enumerates every
 * name in the tree through the identical code path `getByRole({ name })` uses.
 * `dom-accessibility-api` is not imported here: it is Testing Library's
 * dependency, not this project's, and reaching past a declared dependency to a
 * transitive one is how a suite starts depending on something nobody installed.
 *
 * Elements are kept only if they are also returned by the same query under
 * `hidden: false`, so a control inside an `aria-hidden` subtree is not counted
 * as being on screen.
 *
 * ## The ledger, and why it is a ledger rather than an assertion
 *
 * Some duplicates are correct. A transcript with four assistant answers has four
 * controls called `Copy this reply`, and renaming them `Copy reply 3` would be
 * worse for every user in exchange for nothing. What separates those from the
 * defect is not the count, it is the **consequence**: `Copy this reply` on two
 * turns is the same verb on a different object, and the user is choosing between
 * them by position on purpose. `Close` on the title bar and `Close` in a dialog
 * are *different verbs*, and one of them ends the process.
 *
 * Consequence is not computable, so it is written down. Every entry in
 * {@link ACCEPTED} carries the reason it is allowed. Anything not in the ledger
 * fails, and an entry the sweep no longer observes fails too — a ledger line
 * nothing produces is a claim with no reader, and this repo has been burned by
 * exactly that.
 *
 * ## What this file does not claim
 *
 * The states below are the ones this sweep drives. They are not every state the
 * product has: nothing here opens the command palette over a dialog, drives a
 * tool call, an attachment tray, a canvas diff or an agent run, and a collision
 * that only exists in one of those is not ruled out by a pass here. The list is
 * written out in {@link STATES} so that what was looked at is legible, and so
 * that adding a state is a one-line change rather than a rewrite.
 *
 * **Honesty (conventions §10):** VERIFIED-BY-FAKE, jsdom, tier `test-bites`.
 * `BrowserAdapter` is an in-memory host. Name *computation* is the real one; the
 * announcement is not — no screen reader and no voice-control engine runs here,
 * so nothing below is evidence about what Narrator says or what Voice Access
 * matches.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import { getRoles, queryAllByRole } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { NO_CAPABILITIES, type ModelCapabilityReport } from '@/platform/contract';
import { resetMemoryStore } from '@/state/memory-store';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';
import { resetProjectStore } from '@/state/project-store';
import { resetSchedulesStore } from '@/state/schedules-store';
import { resetSkillsStore, useSkillsStore } from '@/state/skills-store';

interface Named {
  readonly role: string;
  readonly name: string;
}

/**
 * A role and an accessible name, as one comparable string.
 *
 * JSON rather than a separator character: an accessible name is arbitrary user
 * and content text, so any separator picked out of the air can occur inside one
 * — and `src/platform/control-characters.test.ts` refuses the usual escape from
 * that, which is to reach for an unprintable one.
 */
type Key = string;

const keyOf = (role: string, name: string): Key => JSON.stringify([role, name]);

function readable(key: Key): string {
  const [role, name] = JSON.parse(key) as [string, string];
  return `${role} named ${name}`;
}

interface Accepted {
  readonly role: string;
  readonly name: string;
  /** Why two of these may share a name. Consequence, not convenience. */
  readonly why: string;
}

/**
 * The duplicates this product is allowed to have, each with the reason.
 *
 * Every one of these is *the same verb on a different object*, or is not a
 * control at all. None of them can quit the application, delete something the
 * user did not point at, or send anything.
 */
const ACCEPTED: readonly Accepted[] = [
  {
    role: 'img',
    name: 'Vela',
    why: 'The wordmark, drawn twice — once in the title bar, once on the surface below. Not a control; clicking either does nothing.',
  },
  {
    role: 'article',
    name: 'Your message',
    why: 'One per user turn. A landmark, not a control, and the transcript is read in order.',
  },
  {
    role: 'article',
    name: 'Model reply',
    why: 'One per assistant turn. Same reasoning as "Your message".',
  },
  {
    role: 'list',
    name: 'What Vela had to change for this model',
    why: 'One per assistant turn that was degraded. A list of notes; nothing in it acts.',
  },
  {
    role: 'button',
    name: 'Copy this reply',
    why: 'One per assistant turn. Same verb, different reply; a numbered variant would be worse for every user and protects nobody.',
  },
  {
    role: 'button',
    name: 'Copy js code',
    why: 'One per fenced block of that language. Same verb, different block; the name already carries the only distinction a user would want.',
  },
  {
    role: 'button',
    name: 'Open New conversation',
    why: 'Two conversations really are both called "New conversation" until one is renamed. Same verb, different row. Distinguishing them means changing what a conversation is called, which is a product decision and not this guard’s to make.',
  },
  {
    role: 'button',
    name: 'Rename New conversation',
    why: 'As "Open New conversation": the ambiguity is in the titles, not in the control.',
  },
  {
    role: 'button',
    name: 'Delete New conversation',
    why: 'As "Open New conversation". Destructive, but it asks first — the delete dialog names the conversation and defaults the keyboard to Cancel.',
  },
  {
    role: 'button',
    name: 'Edit',
    why: 'One per configured endpoint. Same verb, different row; opens a form that names the endpoint it is editing.',
  },
  {
    role: 'button',
    name: 'Remove',
    why: 'One per configured endpoint. Same verb, different row. Destructive and NOT confirmed — recorded as a real weakness in the track report, not fixed here.',
  },
  {
    role: 'button',
    name: 'Pin',
    why: 'One per memory entry. Same verb, different entry, and reversible.',
  },
  {
    role: 'button',
    name: 'Forget: Same note',
    why: 'Two memory entries with identical text. The name already carries everything that distinguishes them, which is nothing.',
  },
  {
    role: 'textbox',
    name: 'Memory: Same note',
    why: 'The editable field behind the same two entries. Same reasoning.',
  },
  {
    role: 'button',
    name: 'Runs: Daily digest',
    why: 'One per schedule; two schedules may share a title. Opens a history panel, changes nothing.',
  },
  {
    role: 'button',
    name: 'Delete: Daily digest',
    why: 'One per schedule with that title. Same verb, different row; a schedule is re-creatable from what is on screen.',
  },
  {
    role: 'switch',
    name: 'Enabled: Daily digest',
    why: 'One per schedule with that title. Reversible in one press.',
  },
  {
    role: 'heading',
    name: 'Daily digest',
    why: 'The row headings of two identically titled schedules. Headings are not controls.',
  },
];

const ACCEPTED_KEYS = new Set<Key>(ACCEPTED.map((entry) => keyOf(entry.role, entry.name)));

/**
 * Every visible element that has a role and a non-empty accessible name.
 *
 * `getRoles` supplies the roles actually present, so this does not have to carry
 * a list of ARIA roles that would go stale.
 */
function namedElements(container: HTMLElement): Named[] {
  const found: Named[] = [];
  for (const role of Object.keys(getRoles(container))) {
    const visible = new Set<Element>(queryAllByRole(container, role, { hidden: false }));
    queryAllByRole(container, role, {
      name: (accessibleName: string, element: Element) => {
        if (accessibleName !== '' && visible.has(element)) {
          found.push({ role, name: accessibleName });
        }
        return false;
      },
    });
  }
  return found;
}

/** The (role, name) pairs held by more than one element right now. */
function collisions(container: HTMLElement): Map<Key, number> {
  const counts = new Map<Key, number>();
  for (const item of namedElements(container)) {
    const key = keyOf(item.role, item.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of [...counts]) if (count < 2) counts.delete(key);
  return counts;
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

async function host(endpoints = 1): Promise<BrowserAdapter> {
  const adapter = new BrowserAdapter();
  await adapter.invoke('settings_put_provider', {
    id: 'workstation',
    displayName: 'The workstation',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelId: 'local-model',
  });
  if (endpoints > 1) {
    await adapter.invoke('settings_put_provider', {
      id: 'laptop',
      displayName: 'The laptop',
      kind: 'local',
      baseUrl: 'http://127.0.0.1:8081/v1',
      modelId: 'other-model',
    });
  }
  adapter.seedCapabilities(report());
  return adapter;
}

type User = ReturnType<typeof userEvent.setup>;

/** `delay: null` for the reason `src/app/modal-containment.test.tsx` records. */
const driver = (): User => userEvent.setup({ delay: null });

async function openConversation(user: User): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
  await screen.findByRole('region', { name: 'Conversation' });
}

/** Send one message and wait for the fake host to echo it back as an answer. */
async function say(user: User, text: string, articles: number): Promise<void> {
  await user.click(screen.getByRole('textbox', { name: 'Message' }));
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => {
    expect(within(screen.getByRole('log')).getAllByRole('article')).toHaveLength(articles);
  });
  await waitFor(() => {
    expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false');
  });
}

/** Opens the endpoints panel the way a user with no endpoint chosen is sent. */
async function openEndpoints(user: User): Promise<void> {
  const switcher = document.querySelector<HTMLElement>('[aria-haspopup="listbox"]');
  if (switcher === null) throw new Error('no model switcher on screen');
  await user.click(switcher);
  await user.click(await screen.findByRole('button', { name: 'Manage endpoints…' }));
  await screen.findByRole('region', { name: 'Endpoints' });
}

interface State {
  readonly id: string;
  readonly drive: (user: User) => Promise<void>;
}

/**
 * The states this sweep looks at. Each one renders the assembled `<App />`
 * against the fake host and drives it with clicks, except where a modal makes a
 * click impossible — noted where that happens.
 */
const STATES: readonly State[] = [
  {
    id: 'the launch screen',
    drive: async () => {
      render(<App adapter={await host()} />);
      await screen.findByRole('button', { name: 'Skills' });
    },
  },
  {
    id: 'the memory dialog',
    drive: async (user) => {
      render(<App adapter={await host()} />);
      await user.click(await screen.findByRole('button', { name: 'Memory' }));
      await screen.findByRole('dialog', { name: 'Memory' });
    },
  },
  {
    id: 'the skills dialog',
    drive: async (user) => {
      render(<App adapter={await host()} />);
      await user.click(await screen.findByRole('button', { name: 'Skills' }));
      await screen.findByRole('dialog', { name: 'Skills' });
    },
  },
  {
    id: 'the schedules dialog',
    drive: async (user) => {
      render(<App adapter={await host()} />);
      await user.click(await screen.findByRole('button', { name: 'Schedules' }));
      await screen.findByRole('dialog', { name: 'Schedules' });
    },
  },
  {
    id: 'the projects dialog',
    drive: async (user) => {
      render(<App adapter={await host()} />);
      await user.click(await screen.findByRole('button', { name: 'Projects' }));
      await screen.findByRole('dialog', { name: 'Projects' });
    },
  },
  {
    id: 'the command bar',
    drive: async (user) => {
      render(<App adapter={await host()} />);
      await user.click(await screen.findByRole('button', { name: /Search everything/u }));
      await screen.findByRole('dialog', { name: 'Command bar' });
    },
  },
  {
    id: 'the command bar with the sidebar collapsed',
    drive: async (user) => {
      render(<App adapter={await host()} />);
      await user.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
      await user.click(await screen.findByRole('button', { name: 'Search conversations' }));
      await screen.findByRole('dialog', { name: 'Command bar' });
    },
  },
  {
    id: 'the endpoints panel',
    drive: async (user) => {
      render(<App adapter={await host()} />);
      await openConversation(user);
      await openEndpoints(user);
    },
  },
  {
    id: 'the endpoints panel with two endpoints in it',
    drive: async (user) => {
      render(<App adapter={await host(2)} />);
      await openConversation(user);
      await openEndpoints(user);
    },
  },
  {
    id: 'the endpoints panel under the memory dialog',
    drive: async (user) => {
      render(<App adapter={await host()} />);
      await openConversation(user);
      await openEndpoints(user);
      // The endpoints panel is a region, not a modal, so the sidebar is still
      // live behind it and this click is the one a user makes.
      await user.click(screen.getByRole('button', { name: 'Memory' }));
      await screen.findByRole('dialog', { name: 'Memory' });
    },
  },
  {
    id: 'two dialogs at once',
    drive: async (user) => {
      render(<App adapter={await host()} />);
      await user.click(await screen.findByRole('button', { name: 'Memory' }));
      await screen.findByRole('dialog', { name: 'Memory' });
      // Not clickable: the sidebar is behind a modal. The store is the seam the
      // sidebar would use, and nothing in the product forbids the second pane
      // being opened while the first is up — which is the point of driving it.
      useSkillsStore.getState().setOpen(true);
      await waitFor(() => {
        expect(screen.getAllByRole('dialog')).toHaveLength(2);
      });
    },
  },
  {
    id: 'a transcript of two answered turns, each carrying code',
    drive: async (user) => {
      render(<App adapter={await host()} />);
      await openConversation(user);
      await say(user, 'one\n\n```js\nlet a = 1;\n```\n', 2);
      await say(user, 'two\n\n```js\nlet b = 2;\n```\n', 4);
    },
  },
  {
    id: 'two conversations that are both still called New conversation',
    drive: async (user) => {
      render(<App adapter={await host()} />);
      await openConversation(user);
      await user.click(screen.getByRole('button', { name: 'New conversation Control N' }));
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: 'Open New conversation' })).toHaveLength(2);
      });
    },
  },
  {
    id: 'two memory entries with identical text',
    drive: async (user) => {
      const adapter = new BrowserAdapter();
      for (const category of ['other', 'techPrefs'] as const) {
        await adapter.invoke('memory_add', {
          scope: { kind: 'global' },
          category,
          content: 'Same note',
        });
      }
      render(<App adapter={adapter} />);
      await user.click(await screen.findByRole('button', { name: 'Memory' }));
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: 'Forget: Same note' })).toHaveLength(2);
      });
    },
  },
  {
    id: 'two schedules with identical titles',
    drive: async (user) => {
      const adapter = new BrowserAdapter();
      for (const prompt of ['go', 'go again']) {
        await adapter.invoke('schedules_create', {
          title: 'Daily digest',
          prompt,
          cadence: 'daily',
          firstRunAtMs: 1_760_000_000_000,
        });
      }
      render(<App adapter={adapter} />);
      await user.click(await screen.findByRole('button', { name: 'Schedules' }));
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: 'Delete: Daily digest' })).toHaveLength(2);
      });
    },
  },
];

/**
 * What every state saw, accumulated so the ledger can be checked for lines
 * nothing produces. `it` bodies in one file run in order, and the coverage check
 * is the last one.
 */
const observed = new Set<Key>();

/**
 * Generous, and deliberately not a claim about how long anything takes. These
 * render the whole application; measured idle they finish in well under a
 * second each, and this box fabricates timeouts under parallel load (see
 * `src/app/modal-containment.test.tsx`).
 */
const BUDGET_MS = 30_000;

beforeEach(() => {
  resetMemoryStore();
  resetModelStore();
  resetNavigationStore();
  resetProjectStore();
  resetSchedulesStore();
  resetSkillsStore();
});

describe('no two things on screen answer to the same name, unless the ledger says why', () => {
  for (const state of STATES) {
    it(
      `holds no unrecorded duplicate name in ${state.id}`,
      async () => {
        await state.drive(driver());

        const found = collisions(document.body);
        const unrecorded: string[] = [];
        for (const [key, count] of found) {
          observed.add(key);
          if (!ACCEPTED_KEYS.has(key)) {
            unrecorded.push(`${readable(key)} ×${String(count)}`);
          }
        }

        expect(
          unrecorded,
          `In ${state.id}, ${String(unrecorded.length)} name(s) are held by more than one ` +
            `element and are not in the ledger. Either give one of them its own name, or add ` +
            `it to ACCEPTED with the reason the consequences are the same:\n  ` +
            unrecorded.join('\n  '),
        ).toEqual([]);
      },
      BUDGET_MS,
    );
  }

  it('has no ledger entry that nothing produces', () => {
    // RULE U applied to this file's own data: an accepted duplicate that the
    // sweep never sees is a permission granted to nobody, and the next reader
    // has no way to tell whether it is stale or whether the state that produced
    // it stopped being driven.
    const stale = ACCEPTED.filter((entry) => !observed.has(keyOf(entry.role, entry.name))).map(
      (entry) => `${entry.role} named ${entry.name}`,
    );
    expect(
      stale,
      `${String(stale.length)} ledger entries were not observed by any state above. ` +
        `Delete them, or add the state that produces them:\n  ` + stale.join('\n  '),
    ).toEqual([]);
  });
});
