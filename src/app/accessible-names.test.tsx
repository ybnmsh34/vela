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
 * it — which is why the *expanded* sidebar's new-conversation button is called
 * `New conversation Control N` below, while the collapsed rail's, which carries
 * no hint, is called `New conversation` — a difference the sweep only sees
 * because it drives both, and one no amount of reading the JSX produces.
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
 * ## What this file checks, and what it does not claim
 *
 * Three questions, off one drive per state. **One name on two elements** (keyed
 * on role — {@link ACCEPTED}); **one name wholly inside another** ({@link
 * ACCEPTED_NESTINGS}); **one name on two different roles** ({@link
 * ACCEPTED_CROSS_ROLE}). Only the first of the three was here in the version of
 * this file that shipped first, and it was one notch narrow twice over: keyed on
 * (role, name) it could not see the `button`/`combobox` pair this product really
 * has, and asking only about equality it could not see that giving each panel's
 * dismiss button a scoped name puts that panel's *opener* inside it.
 *
 * The states below are the ones this sweep drives. They are not every state the
 * product has: nothing here drives a tool call, a canvas diff or an agent run,
 * and a collision that only exists in one of those is not ruled out by a pass
 * here. The list is written out in {@link STATES} so that what was looked at is
 * legible, and so that adding a state is a one-line change rather than a
 * rewrite.
 *
 * The nesting and cross-role checks look only at {@link ACTIONABLE} roles. Which
 * roles those are is a judgement, written down there rather than derived, and it
 * is the reason this file cannot say it compared every pair of names — only
 * every pair between two things a user can operate.
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
 * The roles a driver, a voice-control user or a keyboard user *acts through*.
 *
 * The two checks below this one — nesting, and one name across two roles — are
 * restricted to these. The defect this file guards is a query that names one
 * control and reaches another, and a query only reaches something that can be
 * clicked, typed into or chosen. Headings, landmarks, articles and images are
 * left out on purpose: a heading whose text contains a button's name costs
 * nobody anything, and folding them in would bury the pairs that matter under
 * pairs that do not.
 *
 * `listbox`, `dialog`, `region`, `log`, `list` and `group` are deliberately NOT
 * here. They are containers a query scopes *to* rather than acts *on*. That is
 * a judgement, and it is the reason this file cannot claim to have looked at
 * every pair — only at every pair between two things a user can operate.
 */
const ACTIONABLE: ReadonlySet<string> = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'option',
  'combobox',
  'textbox',
  'searchbox',
  'spinbutton',
  'slider',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
]);

/**
 * One actionable name wholly contained in another, and why that is survivable.
 *
 * ## Why this ledger exists at all
 *
 * `close-collision.test.tsx` asserts non-nesting, but only among close-shaped
 * names — it compares `Close Vela` to `Close the memory panel` and stops there.
 * That is the same defect one level down a second time: a guard that checks the
 * family it was written for and calls the question answered. Playwright's
 * `getByRole(…, { name })` is a **case-insensitive substring** match unless
 * `exact: true` is passed. Measured against the built bundle in Chromium, not
 * assumed: `{ name: 'close' }` matches two controls, `{ name: 'CLOSE THE
 * ENDPOINTS PANEL' }` matches one, and `{ name: 'close', exact: true }` matches
 * none. So every nesting anywhere in the product is a query that can land on
 * the wrong control — not only the ones with `Close` in them.
 *
 * ## The rule for admitting one
 *
 * Which control a substring query lands on is decided by **document order**,
 * which is a layout accident, not a design. So an entry is only allowed here
 * when *either* landing is survivable: the two controls do the same thing to
 * the same object, or the wrong one is a no-op the user can see and undo. A
 * pair that fails that test does not get an entry; it gets renamed. Two did,
 * and both are renamed rather than admitted here:
 *
 *  - `Offer tools` inside `Never offer tools`, two options of one select whose
 *    consequences are opposed — now `Always offer tools`, in
 *    `src/features/models/LocalEndpointSection.tsx`;
 *  - `Remove` inside `Remove shot.png`, where the shorter one deletes a
 *    configured endpoint and does not ask first — now `Remove: <endpoint>`, in
 *    `src/features/models/EndpointsPanel.tsx`, which also ends the duplicate
 *    that stood between two configured rows.
 */
interface AcceptedNesting {
  /** The shorter name — the one a substring query would over-match. */
  readonly inner: string;
  /** The longer name that contains it. */
  readonly outer: string;
  readonly why: string;
}

const ACCEPTED_NESTINGS: readonly AcceptedNesting[] = [
  {
    inner: 'Memory',
    outer: 'Close the memory panel',
    why: 'Opener and dismisser of one panel. A substring query for "Memory" that lands on the dismiss button closes the thing it was trying to open — visible, reversible in one click, and it cannot quit Vela or destroy anything. This nesting did not exist before this branch: the dismiss button used to be called "Close", which collided with the control that quits the application instead. That trade is the point.',
  },
  {
    inner: 'Skills',
    outer: 'Close the skills panel',
    why: 'As "Memory" / "Close the memory panel".',
  },
  {
    inner: 'Schedules',
    outer: 'Close the schedules panel',
    why: 'As "Memory" / "Close the memory panel".',
  },
  {
    inner: 'Projects',
    outer: 'Close the projects panel',
    why: 'As "Memory" / "Close the memory panel".',
  },
  {
    inner: 'Search conversations',
    outer: 'Search conversations Control K',
    why: 'Produced by the expanded sidebar with the palette open: the palette’s own combobox carries the bare name, and the sidebar button that opens it carries the same words plus its shortcut, because a srOnly <kbd>Control K</kbd> inside a button lands inside the button’s name. One opens the search field, the other is the search field. Nothing is chosen, sent or destroyed by landing on either.',
  },
  {
    inner: 'Name',
    outer: 'Rename New conversation',
    why: 'Produced by the endpoint edit form, which leaves the sidebar live behind it: textbox "Name" is the endpoint form’s own field, button "Rename New conversation" is the row action beside a conversation. Landing on the button opens an inline rename the user can see and escape; landing on the field types into a form that changes nothing until Save. Neither sends, deletes nor quits.',
  },
  {
    inner: 'Address',
    outer: 'Let the address decide',
    why: 'Produced by the endpoint edit form: textbox "Address" is the field, option "Let the address decide" is the local endpoint section’s tool-policy default further down the same panel. Landing on the option selects the value that select already holds.',
  },
  {
    inner: 'Tools',
    outer: 'Always offer tools',
    why: 'The tool-policy select and one of its options. The select cannot be confused for a choice inside it: opening a list and picking from it are steps of one act, and every option in the list says its whole policy out loud.',
  },
  {
    inner: 'Tools',
    outer: 'Never offer tools',
    why: 'As "Tools" / "Always offer tools".',
  },
  {
    inner: 'Delete',
    outer: 'Delete New conversation',
    why: 'The confirmation dialog\'s Delete, and the sidebar row action that opened it. Both name the same conversation and only one of them destroys anything: getting it wrong re-opens a confirmation that is already up. The dialog is the guard, not the name.',
  },
  {
    inner: 'New conversation',
    outer: 'New conversation Action',
    why: 'The collapsed sidebar\'s plus button, and the command bar row that does the identical thing — the palette draws a kind badge reading "Action" and it lands inside the row\'s name. Same verb, same object, no object to get wrong.',
  },
  {
    inner: 'Memory',
    outer: 'In-memory fake',
    why: 'Produced by the endpoint edit form: button "Memory" in the sidebar, and option "In-memory fake" — the one wire protocol BrowserAdapter advertises, in the form’s protocol select. The longer name exists only under the fake host, which is worth saying out loud: this containment is an artefact of what this suite runs against, not a fact about the shipping protocol list.',
  },
  {
    inner: 'Memory',
    outer: 'Memory: Same note',
    why: 'The sidebar\'s memory button and the editable field of one entry inside the panel it opens. Landing on the field types into a note the user is looking at; landing on the button re-opens the panel that is already open.',
  },
  {
    inner: 'Daily',
    outer: 'Runs: Daily digest',
    why: 'Produced by the schedules dialog: option "Daily" is one of CADENCE_LABELS in the create form, and the row belongs to a schedule the user happened to title "Daily digest". The option changes nothing until the form is submitted, and this row control opens a history panel.',
  },
  {
    inner: 'Daily',
    outer: 'Delete: Daily digest',
    why: 'As "Daily" / "Runs: Daily digest". Destructive, but the schedule is re-creatable from what is on screen and the name states which one.',
  },
  {
    inner: 'Daily',
    outer: 'Enabled: Daily digest',
    why: 'As "Daily" / "Runs: Daily digest". Reversible in one press.',
  },
  {
    inner: 'On this machine',
    outer: 'Record what endpoints send back, to a file on this machine',
    why: 'Produced by the endpoint edit form: option "On this machine" is one of three endpoint kinds in the form, and checkbox "Record what endpoints send back, to a file on this machine" is the debug-log switch further down the same panel. This is the least comfortable entry here — the wrong landing turns a log on rather than choosing a kind — and it is admitted because a checkbox states its new value where it stands, the sentence it carries names the whole consequence, and DebugLogSwitch is off again every time Vela starts.',
  },
];

const nestingKey = (inner: string, outer: string): Key => JSON.stringify([inner, outer]);

const ACCEPTED_NESTING_KEYS = new Set<Key>(
  ACCEPTED_NESTINGS.map((entry) => nestingKey(entry.inner, entry.outer)),
);

/**
 * One name, two different actionable roles, on screen at once.
 *
 * {@link ACCEPTED} is keyed on `(role, name)`, so a `button` and a `combobox`
 * that share a name are structurally invisible to it — and one such pair really
 * is in this product. Testing Library queries always carry a role, so this
 * class is not what bit the harness; a Playwright `getByLabel` or a voice
 * command carries no role at all, which is why it is checked rather than
 * ignored.
 */
interface AcceptedCrossRole {
  readonly name: string;
  /** The roles, sorted, that answer to it. */
  readonly roles: readonly string[];
  readonly why: string;
}

const ACCEPTED_CROSS_ROLE: readonly AcceptedCrossRole[] = [
  {
    name: 'Search conversations',
    roles: ['button', 'combobox'],
    why: 'The collapsed sidebar\'s search button and the search field of the palette it opens. Same verb, one after the other: pressing the button while the palette is already up leaves the palette up. Neither can send, delete or quit.',
  },
];

const crossRoleKey = (name: string, roles: readonly string[]): Key =>
  JSON.stringify([name, [...roles].sort()]);

const ACCEPTED_CROSS_ROLE_KEYS = new Set<Key>(
  ACCEPTED_CROSS_ROLE.map((entry) => crossRoleKey(entry.name, entry.roles)),
);

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

/** The distinct accessible names of everything actionable on screen right now. */
function actionableNames(container: HTMLElement): string[] {
  return [
    ...new Set(
      namedElements(container)
        .filter((item) => ACTIONABLE.has(item.role))
        .map((item) => item.name),
    ),
  ];
}

/**
 * Every ordered pair of actionable names where the first is contained in the
 * second, compared case-insensitively because Playwright's non-exact match is.
 */
function nestings(container: HTMLElement): { inner: string; outer: string }[] {
  const names = actionableNames(container);
  const found: { inner: string; outer: string }[] = [];
  for (const outer of names) {
    for (const inner of names) {
      if (outer === inner) continue;
      if (outer.toLowerCase().includes(inner.toLowerCase())) found.push({ inner, outer });
    }
  }
  return found;
}

/** Names held by elements of two or more *different* actionable roles. */
function crossRoleNames(container: HTMLElement): Map<string, string[]> {
  const byName = new Map<string, Set<string>>();
  for (const item of namedElements(container)) {
    if (!ACTIONABLE.has(item.role)) continue;
    const roles = byName.get(item.name) ?? new Set<string>();
    roles.add(item.role);
    byName.set(item.name, roles);
  }
  const shared = new Map<string, string[]>();
  for (const [name, roles] of byName) if (roles.size > 1) shared.set(name, [...roles].sort());
  return shared;
}

function report(vision: boolean): ModelCapabilityReport {
  return {
    providerId: 'workstation',
    modelId: 'local-model',
    capabilities: { ...NO_CAPABILITIES, streaming: true, vision },
    structuredOutput: false,
    toolCallsEmulated: false,
    contextWindowTokens: 128_000,
    maxOutputTokens: null,
    probed: true,
    findings: [],
  };
}

async function host(endpoints = 1, vision = false): Promise<BrowserAdapter> {
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
  adapter.seedCapabilities(report(vision));
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
    id: 'the command bar over the memory dialog',
    drive: async (user) => {
      render(<App adapter={await host()} />);
      await user.click(await screen.findByRole('button', { name: 'Memory' }));
      await screen.findByRole('dialog', { name: 'Memory' });
      // The sidebar is behind a modal, so the palette is opened the only way it
      // can be from here: the global Control+K that
      // `use-navigation-shortcuts.ts` binds on `window`.
      await user.keyboard('{Control>}k{/Control}');
      await screen.findByRole('dialog', { name: 'Command bar' });
    },
  },
  {
    id: 'the endpoint edit form',
    drive: async (user) => {
      render(<App adapter={await host()} />);
      await openConversation(user);
      await openEndpoints(user);
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await screen.findByRole('textbox', { name: 'Address' });
    },
  },
  {
    id: 'the delete-conversation confirmation over the sidebar',
    drive: async (user) => {
      render(<App adapter={await host()} />);
      await openConversation(user);
      await user.click(screen.getByRole('button', { name: 'Delete New conversation' }));
      await screen.findByRole('alertdialog');
    },
  },
  {
    id: 'a staged image under the endpoints panel',
    drive: async (user) => {
      render(<App adapter={await host(1, true)} />);
      await openConversation(user);
      // A one-pixel PNG: enough for the tray to stage and name it, and the
      // picker is the shipping affordance rather than a store poke.
      await user.upload(
        await screen.findByTestId('attachment-picker-with-images'),
        new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' }),
      );
      await screen.findByTestId('attachment-tray');
      await openEndpoints(user);
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
const observedNestings = new Set<Key>();
const observedCrossRole = new Set<Key>();

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
      `holds no unrecorded duplicate, nesting or cross-role name in ${state.id}`,
      async () => {
        await state.drive(driver());

        // Three checks off one drive, and `expect.soft` so a state reports all
        // three at once. Driving three times instead would triple the slowest
        // part of this file for nothing.
        const found = collisions(document.body);
        const unrecorded: string[] = [];
        for (const [key, count] of found) {
          observed.add(key);
          if (!ACCEPTED_KEYS.has(key)) {
            unrecorded.push(`${readable(key)} ×${String(count)}`);
          }
        }

        expect.soft(
          unrecorded,
          `In ${state.id}, ${String(unrecorded.length)} name(s) are held by more than one ` +
            `element and are not in the ledger. Either give one of them its own name, or add ` +
            `it to ACCEPTED with the reason the consequences are the same:\n  ` +
            unrecorded.join('\n  '),
        ).toEqual([]);

        const unrecordedNestings: string[] = [];
        for (const { inner, outer } of nestings(document.body)) {
          const key = nestingKey(inner, outer);
          observedNestings.add(key);
          if (!ACCEPTED_NESTING_KEYS.has(key)) {
            unrecordedNestings.push(`"${inner}" is inside "${outer}"`);
          }
        }

        expect.soft(
          unrecordedNestings,
          `In ${state.id}, ${String(unrecordedNestings.length)} actionable name(s) contain ` +
            `another one, so a non-exact query for the shorter also matches the longer and ` +
            `document order decides which is clicked. Either rename one, or add it to ` +
            `ACCEPTED_NESTINGS with the reason both landings are survivable:\n  ` +
            unrecordedNestings.join('\n  '),
        ).toEqual([]);

        const unrecordedCrossRole: string[] = [];
        for (const [name, roles] of crossRoleNames(document.body)) {
          const key = crossRoleKey(name, roles);
          observedCrossRole.add(key);
          if (!ACCEPTED_CROSS_ROLE_KEYS.has(key)) {
            unrecordedCrossRole.push(`"${name}" is held by ${roles.join(' and ')}`);
          }
        }

        expect.soft(
          unrecordedCrossRole,
          `In ${state.id}, ${String(unrecordedCrossRole.length)} name(s) are held by two ` +
            `different actionable roles, which the (role, name) ledger above cannot see. ` +
            `Either rename one, or add it to ACCEPTED_CROSS_ROLE with the reason:\n  ` +
            unrecordedCrossRole.join('\n  '),
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

  it('has no accepted nesting that nothing produces', () => {
    // Same rule as above, applied to the nesting ledger. It matters more here:
    // a nesting entry is a *permission*, and one whose pair no longer appears
    // is a permission nobody can see the shape of.
    const stale = ACCEPTED_NESTINGS.filter(
      (entry) => !observedNestings.has(nestingKey(entry.inner, entry.outer)),
    ).map((entry) => `"${entry.inner}" inside "${entry.outer}"`);
    expect(
      stale,
      `${String(stale.length)} accepted nestings were not observed by any state above. ` +
        `Delete them, or add the state that produces them:\n  ` + stale.join('\n  '),
    ).toEqual([]);
  });

  it('has no accepted cross-role name that nothing produces', () => {
    const stale = ACCEPTED_CROSS_ROLE.filter(
      (entry) => !observedCrossRole.has(crossRoleKey(entry.name, entry.roles)),
    ).map((entry) => `"${entry.name}" as ${[...entry.roles].sort().join(' and ')}`);
    expect(
      stale,
      `${String(stale.length)} accepted cross-role names were not observed by any state ` +
        `above. Delete them, or add the state that produces them:\n  ` + stale.join('\n  '),
    ).toEqual([]);
  });
});
