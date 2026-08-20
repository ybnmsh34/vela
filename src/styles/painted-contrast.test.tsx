/**
 * THE COMPOSITION NO RULE STATES — measured from the tree the app actually
 * renders, rather than from what one stylesheet rule happens to write down.
 *
 * ## The question this asks, and the one it replaces
 *
 * `contrast.test.ts` asks: *for each CSS rule whose own declarations include
 * both a `color` and a `background`, is that composition in the hand-written
 * table?* That is a question about what a stylesheet states **in one place**.
 * The thing a user sees is a question about the DOM: an ancestor paints the
 * ground, a descendant paints the text, and between them sits the whole of the
 * component tree. Nothing in CSS text contains that edge.
 *
 * The file it supplements says so itself, and names the shape as its own
 * standing proof of the gap: `MessageTurn .errorTitle` is cited by
 * `CanvasPanel.module.css` as the precedent for `--vela-text` on
 * `--vela-danger-bg`, and it is exactly ancestor-declares-ground /
 * descendant-declares-colour. It is audited because a human read the component
 * and wrote the pair down. Delete the line and nothing asked for it back.
 *
 * So this renders components, walks every element that carries text, resolves
 * the colour it inherits and the ground it stands on **through the real
 * ancestry**, and measures. `src/features/skills/SkillsPanel.module.css` is the
 * worked example: `.detail` is a bare flex column, `SkillContents` renders
 * `<pre className={styles.body}>` inside it, and the ground the `<pre>` sits on
 * is whatever the nearest painted ancestor declares — a fact about
 * `SkillsPanel.tsx`, not about `SkillsPanel.module.css`.
 *
 * ## What a rendered-DOM guard gets wrong, and what is done about it
 *
 * **jsdom is not a rendering engine.** It has no cascade worth the name, it
 * does not resolve custom properties (`getComputedStyle(el).color` answers the
 * literal string `var(--x)`), and `vite.config.ts` sets `test.css: false`, so
 * `document.styleSheets.length` is **0** with a fully-classed component mounted.
 * A guard that asked jsdom what colour something is would get `canvastext` on
 * `rgba(0, 0, 0, 0)` for every element in the app and report a uniform pass —
 * measuring nothing, loudly green. That failure is the reason
 * `resolves real colours, not jsdom's defaults` exists below and asserts on
 * **resolved values**, not on element counts.
 *
 * That floor was necessary and it was not sufficient, in the way this repo keeps
 * finding: it asked its question one notch too narrow. It asked whether *more
 * than a hundred* compositions resolved, and it asked it of the **light**
 * reading only — as did every other check in this file. Two things got through,
 * both measured by doing them rather than argued: starving the dark walk to one
 * of twenty-three fixtures left the file green at exit 0, and emptying
 * `rootColour` — what a `base.css body` whose colour stopped resolving would do
 * — deleted every *inherited* colour in the app and still left it green, because
 * the minority of elements that declare their own colour cleared the hundred on
 * their own. `measures every element it reaches, in both themes` replaces that
 * threshold with two totality laws; see it for what each one forbids.
 *
 * Nothing here asks jsdom for a style. It asks jsdom for exactly one thing —
 * **which element is inside which** — and reads every colour itself, from the
 * stylesheet text, with `css-model.ts`. The class names survive `css: false`
 * because Vitest's CSS-module proxy still answers `styles.body` with
 * `_body_<hash>`; `FILE_BY_HASH` turns that suffix back into the sheet it came
 * from, and `the class-name map is intact` fails if that spelling ever changes
 * rather than quietly matching nothing.
 *
 * **A render only produces the states it produces.** This is the frame this
 * guard installs, and it is one notch narrower than "every composition": a
 * fixture that renders a list never renders the empty state, `:hover` is not a
 * state a DOM has, and `[data-kind='removed']` is invisible if the fixture only
 * builds `added`. Two things push back on it:
 *
 * 1. **The class is the unit, not the state.** A rule applies to an element when
 *    its subject compound's classes are on that element; pseudo-classes and
 *    attribute conditions are *ignored*, so `.row:hover`'s ground and
 *    `.diffRow[data-kind='removed']`'s ground are both measured against a plain
 *    rendered `.row` / `.diffRow`. That over-approximates — it measures
 *    compositions this particular render did not paint — which is the safe
 *    direction for a guard, and it is why `:hover`, `:focus-visible`,
 *    `::placeholder` and `data-` variants are covered without a fixture per
 *    state.
 * 2. **Un-rendered rules are named, not skipped.** `every rule that paints text
 *    is reached by some fixture` lists every colour-declaring rule that no
 *    fixture ever mounted, and compares that list against `NOT_RENDERED` — an
 *    exact set, not a floor. A colour rule added anywhere in `src/` fails this
 *    file until a fixture reaches it or somebody writes down why it cannot. The
 *    debt is large and it is *enumerated*; before this file it was invisible.
 *
 * ## Colours are frozen
 *
 * Nothing here introduces a colour value. Every number is a composition of
 * values already in `tokens.css`, resolved by the same code path
 * `contrast.test.ts` uses.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, describe, expect, it } from 'vitest';

import { TitleBar } from '@/app/shell/TitleBar';
import { documentHostDouble } from '@/features/canvas/document-host-double';
import { modelEntries } from '@/features/models/catalogue';
import { ContextMeter } from '@/features/models/ContextMeter';
import { ModelSwitcher } from '@/features/models/ModelSwitcher';
import { DeleteConversationDialog } from '@/features/navigation/DeleteConversationDialog';
import { CanvasSurface } from '@/features/canvas/CanvasSurface';
import { Composer } from '@/features/conversation/Composer';
import { Markdown } from '@/features/conversation/Markdown';
import { ToolCallList } from '@/features/conversation/ToolCallList';
import { LocalEndpointSection } from '@/features/models/LocalEndpointSection';
import { RunHistory } from '@/features/schedules/RunHistory';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { DEFAULT_PROJECT_ID } from '@/platform/contract-project';
import type { ProviderView } from '@/platform/contract';
import { NO_CAPABILITIES } from '@/platform/contract';
import { KeyboardProvider } from '@/platform/KeyboardProvider';
import { PlatformProvider } from '@/platform/PlatformProvider';
import { AttachmentTray } from '@/features/attachments/AttachmentTray';
import { CodeBlock } from '@/features/conversation/CodeBlock';
import { EmptyConversation } from '@/features/conversation/EmptyConversation';
import { ThinkingBlock } from '@/features/conversation/ThinkingBlock';
import { DebugLogSwitch } from '@/features/diagnostics/DebugLogSwitch';
import { MemoryPanel } from '@/features/memory/MemoryPanel';
import { CommandPalette } from '@/features/navigation/CommandPalette';
import { ConversationsProvider } from '@/features/navigation/ConversationsProvider';
import { HomeSurface } from '@/features/navigation/HomeSurface';
import { Sidebar } from '@/features/navigation/Sidebar';
import { ProjectPanel } from '@/features/projects/ProjectPanel';
import { SchedulesPanel } from '@/features/schedules/SchedulesPanel';
import { SkillsPanel } from '@/features/skills/SkillsPanel';
import { resetDebugLogStore } from '@/state/debug-log-store';
import { resetNavigationStore, useNavigationStore } from '@/state/navigation-store';
import { resetProjectStore } from '@/state/project-store';
import { resetSchedulesStore } from '@/state/schedules-store';
import { resetSkillsStore } from '@/state/skills-store';

import {
  composite,
  contrastRatio,
  declaredValue,
  loadSheets,
  readPaint,
  type Lookup,
  type Paint,
  type Rgba,
  type Rule,
  type Theme,
} from './css-model';

/* -------------------------------------------------------------------------- */
/* the sheets, and the class names the renderer actually emits                  */
/* -------------------------------------------------------------------------- */

const SHEETS = loadSheets();
const MODULE_RULES: readonly Rule[] = SHEETS.flatMap((sheet) =>
  sheet.name.endsWith('.module.css') ? sheet.rules : [],
);

/**
 * Which sheet a hashed class name came from.
 *
 * Vitest's CSS-module proxy answers any key with `_<key>_<hash>`, where the hash
 * is per file — so asking each module for one key that does not exist is enough
 * to learn its hash. It has to be a key that does not exist: the proxy answers
 * for real and imaginary keys alike, which is also why the class names this file
 * audits are read from the CSS text and never from the proxy.
 */
const SENTINEL = 'velaContrastAuditProbe';
const HASHED = /^_(.+)_([a-z0-9]+)$/u;

const MODULES = import.meta.glob('/src/**/*.module.css', { eager: true }) as Record<
  string,
  { readonly default: Record<string, string> }
>;

const FILE_BY_HASH = new Map<string, string>();
for (const [path, module] of Object.entries(MODULES)) {
  const probe = module.default[SENTINEL] ?? '';
  const hash = HASHED.exec(probe)?.[2];
  if (hash === undefined) continue;
  FILE_BY_HASH.set(hash, path.replace(/^\//u, ''));
}

/** A class name as the DOM carries it, split back into sheet and local name. */
function localClass(token: string): { file: string; name: string } | null {
  const parsed = HASHED.exec(token);
  const file = FILE_BY_HASH.get(parsed?.[2] ?? '');
  if (parsed === undefined || parsed === null || file === undefined) return null;
  return { file, name: parsed[1] ?? '' };
}

/* -------------------------------------------------------------------------- */
/* selectors, read far enough to know what a rule applies to                    */
/* -------------------------------------------------------------------------- */

interface Compound {
  readonly classes: readonly string[];
}

interface SelectorPart {
  /** Ancestor compounds, outermost first. Empty when the part cannot constrain. */
  readonly ancestors: readonly Compound[];
  readonly subject: Compound;
  /** `::placeholder`, `::after`, … — what the rule paints instead of the element. */
  readonly pseudoElement: string | null;
  /**
   * True when the part names a state rather than a shape: a pseudo-class or an
   * attribute condition. Those are the parts whose conditions are deliberately
   * *not* evaluated — a `:hover` ground and a `[data-kind='removed']` ground are
   * measured against a plainly rendered element — so they are kept apart from
   * the ones that always apply, which have to cascade against each other.
   */
  readonly conditional: boolean;
  /**
   * The state itself — every pseudo-class and attribute condition in the part,
   * so that two rules describing the *same* state cascade against each other
   * instead of both being reported. `.button:hover` and `.subtle:hover` are one
   * state and the later one wins; `.button[data-outcome='copied']` is another
   * state entirely and stands on its own.
   */
  readonly state: string;
  /** `a·10000 + b·100 + c`, enough to order this repo's selectors. */
  readonly specificity: number;
}

/** Splits on `character` at depth zero, ignoring `[…]` and `(…)`. */
function splitTop(text: string, isBreak: (character: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '[' || character === '(') depth += 1;
    else if (character === ']' || character === ')') depth -= 1;
    if (depth === 0 && isBreak(character)) {
      out.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  out.push(current);
  return out.filter((part) => part.trim() !== '');
}

const PSEUDO_ELEMENT =
  /::([-\w]+)|:(before|after|first-line|first-letter|marker|placeholder|selection)\b/u;

function compoundOf(text: string): Compound {
  // Attribute selectors and functional pseudos are dropped rather than read: an
  // ignored condition widens what a rule is measured against, which is the
  // direction that cannot hide a composition.
  const bare = text.replace(/\[[^\]]*\]/gu, '').replace(/\([^()]*\)/gu, '');
  return { classes: [...bare.matchAll(/\.([-\w]+)/gu)].map((match) => match[1] ?? '') };
}

function specificityOf(text: string): number {
  const count = (pattern: RegExp): number => [...text.matchAll(pattern)].length;
  const ids = count(/#[-\w]+/gu);
  const attributes = count(/\[[^\]]*\]/gu);
  const classes = count(/(?<![:\w-])\.[-\w]+/gu);
  const pseudoClasses = count(/(?<!:):(?!:)[-\w]+/gu);
  const elements = count(/(?:^|[\s>+~])[a-z][-\w]*/gu) + count(/::[-\w]+/gu);
  return ids * 10_000 + (attributes + classes + pseudoClasses) * 100 + elements;
}

function parseSelector(selector: string): readonly SelectorPart[] {
  return splitTop(selector, (character) => character === ',').flatMap((part) => {
    const text = part.trim();
    const compounds = splitTop(text, (character) => /[\s>+~]/u.test(character));
    const last = compounds[compounds.length - 1];
    if (last === undefined) return [];
    // A sibling combinator names a relationship this file does not model, so the
    // ancestor half of the selector is dropped instead of being evaluated wrongly.
    const siblings = /[+~]/u.test(text);
    const withoutPseudoElement = text.replace(PSEUDO_ELEMENT, '');
    const conditions = [
      ...withoutPseudoElement.matchAll(/\[[^\]]*\]|(?<!:):(?!:)[-\w]+(?:\([^)]*\))?/gu),
    ]
      .map((match) => match[0])
      .sort();
    return [
      {
        ancestors: siblings ? [] : compounds.slice(0, -1).map(compoundOf),
        subject: compoundOf(last),
        pseudoElement: PSEUDO_ELEMENT.exec(last)?.[0] ?? null,
        conditional: conditions.length > 0,
        state: conditions.join(''),
        specificity: specificityOf(text),
      },
    ];
  });
}

interface Prepared {
  readonly rule: Rule;
  readonly parts: readonly SelectorPart[];
  readonly foreground: Paint | undefined;
  readonly ground: Paint | undefined;
  /** Source order across the whole audit, the cascade's last tie-break. */
  readonly order: number;
}

function lookupFor(rule: Rule, palette: Map<string, string>): Lookup {
  const locals = new Map<string, string>();
  for (const { property, value } of rule.declarations) {
    if (property.startsWith('--')) locals.set(property, value);
  }
  return (name) => locals.get(name) ?? palette.get(name);
}

function prepare(rules: readonly Rule[], palette: Map<string, string>): readonly Prepared[] {
  return rules.map((rule, order) => {
    const lookup = lookupFor(rule, palette);
    const colour = declaredValue(rule, 'color');
    const ground = declaredValue(rule, 'background', 'background-color');
    return {
      rule,
      order,
      parts: parseSelector(rule.selector),
      foreground: colour === undefined ? undefined : readPaint(colour, lookup),
      ground: ground === undefined ? undefined : readPaint(ground, lookup),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* matching a rule to a rendered element                                       */
/* -------------------------------------------------------------------------- */

function classesByFile(element: Element): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const token of Array.from(element.classList)) {
    const local = localClass(token);
    if (local === null) continue;
    const set = found.get(local.file) ?? new Set<string>();
    set.add(local.name);
    found.set(local.file, set);
  }
  return found;
}

/** The parts of a rule's selector that reach this element, if any. */
function matchingParts(prepared: Prepared, element: Element): readonly SelectorPart[] {
  const own = classesByFile(element).get(prepared.rule.file);
  if (own === undefined) return [];
  return prepared.parts.filter((part) => {
    if (part.subject.classes.length === 0 && part.ancestors.length === 0) return false;
    if (!part.subject.classes.every((name) => own.has(name))) return false;
    let index = part.ancestors.length - 1;
    let node = element.parentElement;
    while (index >= 0 && node !== null) {
      const theirs = classesByFile(node).get(prepared.rule.file);
      const compound = part.ancestors[index];
      if (
        compound !== undefined &&
        theirs !== undefined &&
        compound.classes.every((name) => theirs.has(name))
      ) {
        index -= 1;
      }
      node = node.parentElement;
    }
    return index < 0;
  });
}

/** One rule reaching one element, with what the cascade needs to order it. */
interface Hit {
  readonly prepared: Prepared;
  readonly conditional: boolean;
  readonly pseudoElement: boolean;
  readonly state: string;
  readonly specificity: number;
}

/**
 * One hit per matching *part*, not per rule.
 *
 * A rule whose selector lists several states — `.subtle[data-outcome='copied'],
 * .subtle[data-outcome='failed']` — takes part in both of those cascades, and
 * collapsing it to one hit put it in only one of them: the other state went on
 * being decided by the rule this one was written to override.
 */
function hitsOn(prepared: readonly Prepared[], element: Element): readonly Hit[] {
  const found: Hit[] = [];
  const seen = new Set<string>();
  for (const candidate of prepared) {
    for (const part of matchingParts(candidate, element)) {
      const key = `${candidate.order}|${part.state}|${part.pseudoElement ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        prepared: candidate,
        conditional: part.conditional,
        pseudoElement: part.pseudoElement !== null,
        state: part.state,
        specificity: part.specificity,
      });
    }
  }
  return found;
}

/**
 * The values one property can take on one element.
 *
 * The unconditional rules that reach an element are a real cascade and only one
 * of them wins — `CopyButton` puts `.button` and `.subtle` on the same node, and
 * reading both grounds would have this file report `--vela-code-text` on
 * `--vela-surface`, a composition the engine never paints. The conditional ones
 * are states, so each is an extra value rather than a competitor: that is how
 * `:hover`, `:focus-visible` and `[data-…]` are covered without a fixture that
 * reaches them.
 */
function inState<T>(
  hits: readonly Hit[],
  state: string,
  read: (hit: Hit) => T | undefined,
): T | undefined {
  const candidates = hits.filter(
    (hit) => read(hit) !== undefined && (!hit.conditional || hit.state === state),
  );
  const winner = [...candidates]
    .sort((a, b) =>
      a.specificity === b.specificity
        ? a.prepared.order - b.prepared.order
        : a.specificity - b.specificity,
    )
    .at(-1);
  return winner === undefined ? undefined : read(winner);
}

/* -------------------------------------------------------------------------- */
/* what the element stands on, and what colour it is painted in                */
/* -------------------------------------------------------------------------- */

interface Layer {
  readonly rgba: Rgba;
  /** The role chain, nearest first, for the failure message. */
  readonly label: string;
}

const ROOT = 'src/styles/base.css';

/**
 * The `body` rule's own colour and ground, read from `base.css` rather than
 * asserted in a comment: every fixture's root inherits them unless it says
 * otherwise, so a change to that rule must move these numbers.
 */
function rootPaint(palette: Map<string, string>): { colour: Paint; ground: Paint } {
  const sheet = SHEETS.find(({ name }) => name === ROOT);
  const body = sheet?.rules.find(({ selector }) => selector === 'body');
  if (body === undefined) throw new Error(`${ROOT} no longer has a \`body\` rule to read`);
  const lookup = lookupFor(body, palette);
  const colour = declaredValue(body, 'color');
  const ground = declaredValue(body, 'background', 'background-color');
  if (colour === undefined || ground === undefined) {
    throw new Error(`${ROOT} \`body\` no longer declares both a colour and a ground`);
  }
  return { colour: readPaint(colour, lookup), ground: readPaint(ground, lookup) };
}

class Audit {
  private readonly grounds = new Map<Element, readonly Layer[]>();
  private readonly colours = new Map<Element, readonly Layer[]>();
  readonly reached = new Set<string>();
  readonly unreadable: string[] = [];
  readonly unknownClasses = new Set<string>();

  constructor(
    private readonly prepared: readonly Prepared[],
    private readonly beneath: readonly Layer[],
    private readonly rootColour: readonly Layer[],
  ) {}

  private readonly hits = new Map<Element, readonly Hit[]>();

  private hitsFor(element: Element): readonly Hit[] {
    const cached = this.hits.get(element);
    if (cached !== undefined) return cached;
    for (const token of Array.from(element.classList)) {
      if (localClass(token) === null) this.unknownClasses.add(token);
    }
    const found = hitsOn(this.prepared, element);
    for (const hit of found) {
      if (hit.prepared.foreground !== undefined || hit.prepared.ground !== undefined) {
        this.reached.add(`${hit.prepared.rule.file} — ${hit.prepared.rule.selector}`);
      }
    }
    this.hits.set(element, found);
    return found;
  }

  private note(hit: Hit, paint: Paint): void {
    if (paint.kind === 'unreadable') {
      this.unreadable.push(
        `${hit.prepared.rule.file} \`${hit.prepared.rule.selector}\` — ${paint.why}`,
      );
    }
  }

  /**
   * The states this element has rules for: the base, plus each named state.
   *
   * Colour and ground have to be resolved **together, per state**, or the audit
   * crosses them. `Composer .send` is the worked example: the base is
   * `--vela-text-on-accent` on `--vela-accent`, `:disabled` is
   * `--vela-text-subtle` on `--vela-bg-inset`, and reading the two sides
   * independently manufactures `--vela-text-subtle` on `--vela-accent` at
   * 1.10:1 — a composition the engine never paints and a red this file would
   * have been wrong to raise. Crossing states across *different* elements is
   * fine and deliberate: an ancestor really can be hovered while its child
   * paints its own colour.
   */
  statesOn(element: Element): readonly string[] {
    const states = new Set<string>(['']);
    for (const hit of this.hitsFor(element)) {
      if (hit.conditional && !hit.pseudoElement) states.add(hit.state);
    }
    return [...states];
  }

  /** Every ground an element's box can present to a child, over all its states. */
  groundsFor(element: Element | null): readonly Layer[] {
    if (element === null || element === document.body) return this.beneath;
    const cached = this.grounds.get(element);
    if (cached !== undefined) return cached;
    const resolved = dedupe(
      this.statesOn(element).flatMap((state) => [...this.groundIn(element, state)]),
    );
    this.grounds.set(element, resolved);
    return resolved;
  }

  /** The ground this element's own text stands on, in one of its states. */
  groundIn(element: Element, state: string): readonly Layer[] {
    const above = this.groundsFor(element.parentElement);
    const paint = inState(this.hitsFor(element), state, (hit) => {
      // A pseudo-element's fill is not the element's own ground.
      if (hit.pseudoElement) return undefined;
      const found = hit.prepared.ground;
      if (found !== undefined) this.note(hit, found);
      return found;
    });
    // `transparent`, `none` and `currentcolor` paint nothing a text ground can be
    // read off — the dot fills that use `currentcolor` carry no text — so what is
    // behind them shows through unchanged.
    if (paint === undefined || paint.kind !== 'colour') return above;
    if (paint.rgba.a >= 1) return [{ rgba: paint.rgba, label: paint.token ?? 'a literal colour' }];
    return above.map((under) => ({
      rgba: composite(paint.rgba, under.rgba),
      label: `${paint.token ?? 'a literal colour'} over ${under.label}`,
    }));
  }

  /** Every colour this element's text can take, over all its states. */
  coloursFor(element: Element | null): readonly Layer[] {
    if (element === null || element === document.body) return this.rootColour;
    const cached = this.colours.get(element);
    if (cached !== undefined) return cached;
    const resolved = dedupe(
      this.statesOn(element).flatMap((state) => [...this.colourIn(element, state)]),
    );
    this.colours.set(element, resolved);
    return resolved;
  }

  /** The colour this element's text takes in one of its states. */
  colourIn(element: Element, state: string): readonly Layer[] {
    const paint = inState(this.hitsFor(element), state, (hit) => {
      if (hit.pseudoElement) return undefined;
      const found = hit.prepared.foreground;
      if (found !== undefined) this.note(hit, found);
      return found;
    });
    // `inherit` and `currentcolor` are whatever the parent already resolved to.
    if (paint === undefined || paint.kind !== 'colour') return this.coloursFor(element.parentElement);
    return [{ rgba: paint.rgba, label: paint.token ?? 'a literal colour' }];
  }

  /** What a `::placeholder` or `::after` paints, if the element has one. */
  pseudoColours(element: Element): readonly Layer[] {
    const out: Layer[] = [];
    for (const hit of this.hitsFor(element)) {
      if (!hit.pseudoElement) continue;
      const paint = hit.prepared.foreground;
      if (paint === undefined) continue;
      this.note(hit, paint);
      if (paint.kind !== 'colour') continue;
      out.push({ rgba: paint.rgba, label: paint.token ?? 'a literal colour' });
    }
    return dedupe(out);
  }

  /** Records that a rule was mounted, whether or not it paints anything. */
  noteReach(element: Element): void {
    this.hitsFor(element);
  }
}

function dedupe(layers: readonly Layer[]): readonly Layer[] {
  const seen = new Map<string, Layer>();
  for (const layer of layers) seen.set(layer.label, layer);
  return [...seen.values()];
}

/* -------------------------------------------------------------------------- */
/* the fixtures                                                                */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly name: string;
  /**
   * The ground under the fixture's root, nearest first, ending in an opaque
   * role — the place in the app this component is mounted. Omitted means
   * `base.css body`, which is where a full-window surface sits.
   */
  readonly beneath?: readonly string[];
  readonly mount: () => Promise<void>;
}

const nothing = (): void => undefined;

/** One loopback endpoint, shaped like `LocalEndpointSection.test.tsx`'s. */
const LOCAL_PROVIDER: ProviderView = {
  id: 'study-box',
  displayName: 'The workstation in the study',
  kind: 'local',
  protocol: 'someProtocolTheHostNamed',
  baseUrl: 'http://127.0.0.1:8080/v1',
  modelId: null,
  authMode: { type: 'none' },
  authRequirement: 'notRequired',
  auth: { type: 'none' },
  credentialPresent: false,
  credentialCheck: 'satisfiedWithoutCredential',
  credentialFieldLabel: null,
  usable: true,
  security: {
    level: 'none',
    scope: 'loopback',
    leavesDevice: false,
    trafficIsPlaintext: false,
    credentialSentInPlaintext: false,
    credentialInQueryString: false,
    endpointIsUnauthenticated: false,
    concerns: [],
  },
};

/** Waits for the fixture to have drawn something, and says which one did not. */
let mounting = '';
async function painted(): Promise<void> {
  await waitFor(() =>
    expect(document.body.textContent, `${mounting} rendered nothing`).not.toBe(''),
  );
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'SkillsPanel — the list, including a directory that is not a skill',
    mount: async () => {
      resetSkillsStore();
      render(
        <PlatformProvider adapter={new BrowserAdapter()}>
          <SkillsPanel onClose={nothing} />
        </PlatformProvider>,
      );
      await screen.findByRole('button', { name: /half-written/u });
    },
  },
  {
    // THE WORKED EXAMPLE. `.detail` is a bare flex column with no ground of its
    // own and `<pre className={styles.body}>` is inside it, so what the
    // instructions are painted on is a fact about `SkillsPanel.tsx`. Reaching it
    // costs a click, and the click is the point: the list fixture above never
    // mounts `.body` at all.
    name: 'SkillsPanel — one skill open, its instructions on screen',
    mount: async () => {
      resetSkillsStore();
      render(
        <PlatformProvider adapter={new BrowserAdapter()}>
          <SkillsPanel onClose={nothing} />
        </PlatformProvider>,
      );
      const row = await screen.findByRole('button', { name: /commit-messages/u });
      await userEvent.click(row);
      await screen.findByText(/← All skills/u);
      await painted();
    },
  },
  {
    name: 'SchedulesPanel',
    mount: async () => {
      resetSchedulesStore();
      render(
        <PlatformProvider adapter={new BrowserAdapter()}>
          <SchedulesPanel onClose={nothing} />
        </PlatformProvider>,
      );
      await painted();
    },
  },
  {
    name: 'ProjectPanel',
    mount: async () => {
      resetProjectStore();
      render(
        <PlatformProvider adapter={new BrowserAdapter()}>
          <ProjectPanel onClose={nothing} />
        </PlatformProvider>,
      );
      await painted();
    },
  },
  {
    name: 'DebugLogSwitch',
    mount: async () => {
      resetDebugLogStore();
      render(
        <PlatformProvider adapter={new BrowserAdapter()}>
          <DebugLogSwitch />
        </PlatformProvider>,
      );
      await painted();
    },
  },
  {
    name: 'CommandPalette',
    mount: async () => {
      resetNavigationStore();
      const adapter = new BrowserAdapter();
      adapter.seedConversation({ title: 'Star charts' });
      render(
        <PlatformProvider adapter={adapter}>
          <ConversationsProvider>
            <CommandPalette debounceMs={0} />
          </ConversationsProvider>
        </PlatformProvider>,
      );
      // Closed until asked for, and a closed palette paints nothing.
      act(() => {
        useNavigationStore.getState().openPalette('switcher');
      });
      await painted();
    },
  },
  {
    name: 'Sidebar — with conversations in it',
    beneath: ['--vela-chrome'],
    mount: async () => {
      resetNavigationStore();
      const adapter = new BrowserAdapter();
      adapter.seedConversation({ title: 'Star charts' });
      render(
        <KeyboardProvider>
          <PlatformProvider adapter={adapter}>
            <ConversationsProvider>
              <Sidebar />
            </ConversationsProvider>
          </PlatformProvider>
        </KeyboardProvider>,
      );
      await screen.findByText('Star charts');
    },
  },
  {
    name: 'HomeSurface',
    mount: async () => {
      resetNavigationStore();
      const adapter = new BrowserAdapter();
      adapter.seedConversation({ title: 'Star charts' });
      render(
        <KeyboardProvider>
          <PlatformProvider adapter={adapter}>
            <ConversationsProvider>
              <HomeSurface secretBackend="memory-fake" />
            </ConversationsProvider>
          </PlatformProvider>
        </KeyboardProvider>,
      );
      await screen.findByText('Star charts');
    },
  },
  {
    name: 'MemoryPanel',
    mount: async () => {
      render(
        <PlatformProvider adapter={new BrowserAdapter()}>
          <MemoryPanel onClose={nothing} />
        </PlatformProvider>,
      );
      await screen.findByRole('textbox', { name: 'Remember something' });
    },
  },
  {
    name: 'EmptyConversation',
    mount: async () => {
      render(
        <PlatformProvider adapter={new BrowserAdapter()}>
          <EmptyConversation
            capabilities={{ ...NO_CAPABILITIES, streaming: true, reasoning: true }}
            modelLabel="a model"
          />
        </PlatformProvider>,
      );
      await painted();
    },
  },
  {
    name: 'CodeBlock — an open code block',
    mount: async () => {
      render(<CodeBlock language="ts" text={"const a = 1; // note\n'text'"} open />);
      await painted();
    },
  },
  {
    name: 'ThinkingBlock — reasoning, still streaming',
    mount: async () => {
      render(<ThinkingBlock text={'thinking about it'} phase="streaming" id="t1" />);
      await painted();
    },
  },
  {
    name: 'ToolCallList — a batch with one call the reader could not parse',
    mount: async () => {
      render(
        <ToolCallList
          outcomes={[
            {
              status: 'ok',
              callId: 'call_1',
              name: 'get_weather',
              arguments: { city: 'alpha' },
              emulated: true,
            },
            {
              status: 'malformed',
              index: 1,
              callId: null,
              name: 'get_time',
              rawArguments: '{"timezone":"',
              reason: 'unknownDiscriminator',
            },
          ]}
          progress={[]}
        />,
      );
      await userEvent.click(await screen.findByRole('button', { name: /get_weather/u }));
      await painted();
    },
  },
  {
    name: 'Markdown — an answer with every block this renderer draws',
    mount: async () => {
      render(
        <Markdown
          source={
            '# One\n\n## Two\n\n##### Five\n\nA [link](https://example.invalid) and `inline`.\n\n' +
            '> quoted\n\n- item\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
          }
        />,
      );
      await painted();
    },
  },
  {
    name: 'Composer — the field, its hint and its send control',
    mount: async () => {
      render(
        <Composer
          capabilities={NO_CAPABILITIES}
          streaming={false}
          blockedReason={null}
          onSend={nothing}
          onCancel={nothing}
        />,
      );
      await painted();
    },
  },
  {
    name: 'CanvasSurface — an artifact in an answer, awaiting approval',
    mount: async () => {
      render(
        <CanvasSurface
          assistantTexts={[
            'Here it is.\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>\n```\n',
          ]}
          projectId={DEFAULT_PROJECT_ID}
          sandbox={documentHostDouble()}
        >
          <div>transcript</div>
        </CanvasSurface>,
      );
      await screen.findByRole('group', { name: 'Approve this artifact' });
    },
  },
  {
    name: 'LocalEndpointSection — one endpoint on the loopback',
    mount: async () => {
      render(
        <PlatformProvider adapter={new BrowserAdapter()}>
          <LocalEndpointSection providers={[LOCAL_PROVIDER]} />
        </PlatformProvider>,
      );
      await painted();
    },
  },
  {
    name: 'RunHistory — one successful run and one that failed',
    mount: async () => {
      const started = Date.UTC(2026, 7, 16, 9, 0);
      const unreached = (name: string) => (): never => {
        throw new Error(`RunHistory called ${name}, which it has no business calling`);
      };
      render(
        <PlatformProvider adapter={new BrowserAdapter()}>
          <RunHistory
            scheduleId="sched_1"
            title="morning digest"
            repository={{
              list: unreached('list'),
              create: unreached('create'),
              setEnabled: unreached('setEnabled'),
              remove: unreached('remove'),
              listRuns: async () => [
                {
                  id: 'run_1',
                  scheduleId: 'sched_1',
                  status: 'success',
                  trigger: 'schedule',
                  startedAtMs: started,
                  finishedAtMs: started + 1_200,
                  durationMs: 1_200,
                  conversationId: 'conv_1',
                  error: null,
                },
                {
                  id: 'run_2',
                  scheduleId: 'sched_1',
                  status: 'failed',
                  trigger: 'manual',
                  startedAtMs: started + 60_000,
                  finishedAtMs: started + 61_000,
                  durationMs: 1_000,
                  conversationId: null,
                  error: 'the endpoint refused the request',
                },
              ],
            }}
          />
        </PlatformProvider>,
      );
      await screen.findByRole('table');
    },
  },
  {
    name: 'TitleBar — the wordmark, the context and the caption buttons',
    beneath: ['--vela-chrome'],
    mount: async () => {
      render(
        <PlatformProvider adapter={new BrowserAdapter()}>
          <TitleBar context="Untitled workspace" />
        </PlatformProvider>,
      );
      await painted();
    },
  },
  {
    name: 'ModelSwitcher — the list open, one endpoint blocked',
    mount: async () => {
      render(
        <ModelSwitcher
          entries={modelEntries([
            LOCAL_PROVIDER,
            { ...LOCAL_PROVIDER, id: 'blocked', displayName: 'Needs a key', usable: false },
          ])}
          selection={{
            providerId: 'study-box',
            modelId: 'some-model',
            providerLabel: 'The workstation in the study',
            modelLabel: 'some-model',
          }}
          hasHistory={false}
          onSelect={nothing}
        />,
      );
      await userEvent.click(await screen.findByRole('button'));
      await painted();
    },
  },
  {
    name: 'DeleteConversationDialog',
    mount: async () => {
      render(
        <DeleteConversationDialog
          conversation={{
            id: 'conv_1',
            title: 'Star charts',
            createdAtMs: 0,
            updatedAtMs: 0,
            lastMessageAtMs: null,
            messageCount: 2,
            titleIsPlaceholder: false,
          }}
          onCancel={nothing}
          onConfirm={nothing}
        />,
      );
      await painted();
    },
  },
  {
    name: 'ContextMeter — a reported window, and one that was not reported',
    beneath: ['--vela-chrome'],
    mount: async () => {
      render(
        <>
          <ContextMeter windowTokens={4096} texts={['hello there']} />
          <ContextMeter windowTokens={null} texts={['hello']} />
        </>,
      );
      await painted();
    },
  },
  {
    name: 'AttachmentTray — one staged file and a refusal',
    mount: async () => {
      render(
        <AttachmentTray
          attachments={[
            {
              id: 'a1',
              name: 'notes.md',
              kind: 'text',
              mimeType: 'text/markdown',
              size: 2048,
              previewUrl: null,
              file: new File(['notes'], 'notes.md', { type: 'text/markdown' }),
            },
          ]}
          refused={[{ name: 'huge.png', reason: 'noVision' }]}
          onRemove={nothing}
          onDismissRefusals={nothing}
        />,
      );
      await painted();
    },
  },
];

/* -------------------------------------------------------------------------- */
/* the audit                                                                   */
/* -------------------------------------------------------------------------- */

const THRESHOLD = 4.5;

/**
 * THE DEBT, ENUMERATED.
 *
 * Every rule that declares a `color` and that no fixture above ever mounted.
 * These are not exemptions and none of them is safe: each one is a composition
 * this file does not measure, sitting in the tree exactly as it sat there
 * before this file existed. The difference is that it is now *written down*,
 * and that the assertion below compares the live list to this one **exactly**.
 * Add a colour rule anywhere under `src/` and this file goes red until either a
 * fixture reaches it or somebody adds the line and says why not.
 *
 * The way to shrink it is a fixture, not an edit here. 276 rules paint text and
 * 164 of them are reached at the time of writing — observed, and open in both
 * directions: a fixture that renders one more state moves both numbers, and
 * nothing here forces either bound.
 */
const NOT_RENDERED: readonly string[] = [
  'src/app/shell/AppShell.module.css — .statusBar',
  'src/features/attachments/AttachmentControls.module.css — .button',
  'src/features/attachments/AttachmentControls.module.css — .button:hover',
  'src/features/attachments/AttachmentDropZone.module.css — .overlayHint',
  'src/features/attachments/AttachmentDropZone.module.css — .overlayText',
  'src/features/canvas/CanvasPanel.module.css — .code',
  'src/features/canvas/CanvasPanel.module.css — .diffBody',
  'src/features/canvas/CanvasPanel.module.css — .diffLead',
  "src/features/canvas/CanvasPanel.module.css — .diffRow[data-kind='added']",
  "src/features/canvas/CanvasPanel.module.css — .diffRow[data-kind='removed']",
  'src/features/canvas/CanvasPanel.module.css — .scripts',
  'src/features/canvas/CanvasPanel.module.css — .version',
  "src/features/canvas/CanvasPanel.module.css — .version[aria-pressed='true']",
  'src/features/canvas/CanvasSurface.module.css — .chip',
  'src/features/canvas/CanvasSurface.module.css — .chip:hover',
  'src/features/canvas/DocumentPreview.module.css — .diagnostics li',
  "src/features/canvas/DocumentPreview.module.css — .diagnostics li[data-severity='error']",
  "src/features/canvas/DocumentPreview.module.css — .diagnostics li[data-severity='warning']",
  'src/features/canvas/DocumentPreview.module.css — .diagnosticsLead',
  'src/features/canvas/DocumentPreview.module.css — .grant dd',
  'src/features/canvas/DocumentPreview.module.css — .grant dt',
  'src/features/canvas/DocumentPreview.module.css — .notice',
  'src/features/conversation/Composer.module.css — .iconButton',
  'src/features/conversation/Composer.module.css — .iconButton:hover',
  "src/features/conversation/Composer.module.css — .iconButton[aria-pressed='true']",
  'src/features/conversation/Composer.module.css — .stop',
  'src/features/conversation/Composer.module.css — .stop:hover',
  'src/features/conversation/EmptyConversation.module.css — .note',
  'src/features/conversation/MessageTurn.module.css — .awaiting',
  'src/features/conversation/MessageTurn.module.css — .errorDetail',
  'src/features/conversation/MessageTurn.module.css — .errorTitle',
  'src/features/conversation/MessageTurn.module.css — .errorTrace',
  'src/features/conversation/MessageTurn.module.css — .noAnswer',
  'src/features/conversation/MessageTurn.module.css — .retry',
  'src/features/conversation/MessageTurn.module.css — .retry:hover',
  'src/features/conversation/MessageTurn.module.css — .usage',
  'src/features/conversation/MessageTurn.module.css — .userText',
  'src/features/conversation/ThinkingBlock.module.css — .notice',
  'src/features/conversation/ToolCallList.module.css — .preview',
  'src/features/conversation/ToolCallList.module.css — .static',
  'src/features/conversation/TurnNotices.module.css — .noteDetail',
  'src/features/conversation/TurnNotices.module.css — .noteTitle',
  'src/features/diagnostics/DebugLogSwitch.module.css — .error',
  'src/features/memory/MemoryPanel.module.css — .category',
  'src/features/memory/MemoryPanel.module.css — .error',
  'src/features/memory/MemoryPanel.module.css — .forget:hover',
  'src/features/memory/MemoryPanel.module.css — .pin, .forget',
  'src/features/memory/MemoryPanel.module.css — .pinned',
  'src/features/models/CapabilitySummary.module.css — .badge',
  'src/features/models/CapabilitySummary.module.css — .detail',
  'src/features/models/CapabilitySummary.module.css — .failure',
  'src/features/models/CapabilitySummary.module.css — .floor',
  'src/features/models/CapabilitySummary.module.css — .heading',
  'src/features/models/CapabilitySummary.module.css — .label',
  'src/features/models/CapabilitySummary.module.css — .probe',
  'src/features/models/CapabilitySummary.module.css — .probe:disabled',
  'src/features/models/ContextMeter.module.css — .over .warning',
  'src/features/models/ContextMeter.module.css — .warning',
  'src/features/models/EndpointForm.module.css — .cancel',
  'src/features/models/EndpointForm.module.css — .checkbox',
  'src/features/models/EndpointForm.module.css — .error',
  'src/features/models/EndpointForm.module.css — .hint',
  'src/features/models/EndpointForm.module.css — .input',
  'src/features/models/EndpointForm.module.css — .label',
  'src/features/models/EndpointForm.module.css — .optional',
  'src/features/models/EndpointForm.module.css — .save',
  'src/features/models/EndpointsPanel.module.css — .close, .add',
  'src/features/models/EndpointsPanel.module.css — .credentialState',
  'src/features/models/EndpointsPanel.module.css — .error',
  'src/features/models/EndpointsPanel.module.css — .heading',
  'src/features/models/EndpointsPanel.module.css — .muted, .backend',
  'src/features/models/EndpointsPanel.module.css — .rowButton, .rowDanger',
  'src/features/models/EndpointsPanel.module.css — .rowDanger',
  'src/features/models/EndpointsPanel.module.css — .rowModel',
  'src/features/models/EndpointsPanel.module.css — .rowName',
  'src/features/models/EndpointsPanel.module.css — .rowUrl',
  'src/features/models/LocalEndpointSection.module.css — .checkbox',
  'src/features/models/LocalEndpointSection.module.css — .error',
  'src/features/models/LocalEndpointSection.module.css — .reportLine',
  'src/features/models/LocalEndpointSection.module.css — .secondary',
  'src/features/models/ModelBar.module.css — .limits',
  'src/features/models/ModelBar.module.css — .limitsActive',
  'src/features/models/ModelBar.module.css — .noticeDismiss',
  'src/features/models/ModelBar.module.css — .noticeText',
  'src/features/models/ModelSwitcher.module.css — .check',
  'src/features/models/ModelSwitcher.module.css — .empty',
  'src/features/models/ModelSwitcher.module.css — .footerAction',
  'src/features/models/ModelSwitcher.module.css — .optionActive',
  'src/features/models/SecurityNotice.module.css — .level',
  'src/features/models/SecurityNotice.module.css — .list',
  'src/features/navigation/CommandPalette.module.css — .footnote',
  'src/features/navigation/CommandPalette.module.css — .mark',
  'src/features/navigation/ConversationRow.module.css — .renameInput',
  'src/features/navigation/ConversationRow.module.css — .selected .main',
  'src/features/navigation/HomeSurface.module.css — .fact dd',
  'src/features/navigation/HomeSurface.module.css — .fact dt',
  'src/features/navigation/NavigationSurface.module.css — .placeholder',
  'src/features/navigation/Sidebar.module.css — .error',
  'src/features/navigation/Sidebar.module.css — .note',
  'src/features/projects/ProjectPanel.module.css — .error',
  'src/features/schedules/RunHistory.module.css — .error',
  'src/features/schedules/RunHistory.module.css — .note',
  'src/features/schedules/SchedulesPanel.module.css — .action, .delete',
  'src/features/schedules/SchedulesPanel.module.css — .delete:hover',
  'src/features/schedules/SchedulesPanel.module.css — .error',
  'src/features/schedules/SchedulesPanel.module.css — .rowMeta',
  'src/features/schedules/SchedulesPanel.module.css — .rowPrompt',
  'src/features/schedules/SchedulesPanel.module.css — .switch',
  'src/features/schedules/SchedulesPanel.module.css — .switchOn',
  'src/features/skills/SkillsPanel.module.css — .error',
  'src/features/skills/SkillsPanel.module.css — .resourceName',
  'src/features/skills/SkillsPanel.module.css — .rowDirectory',
];

/**
 * The shape of one fixture's walk: how many text-carrying elements it found and
 * how many states it visited on them.
 *
 * Both numbers are **palette-independent by construction** — `paintsText` reads
 * the DOM and nothing else, and `statesOn` reads selectors and nothing else. No
 * colour value can move either. That is what makes comparing the two themes'
 * walks a law rather than an observation (RULE Q): the readings differ only in
 * the `Map` handed to `readPaint`, so a difference in the *walk* means one of
 * them stopped early.
 */
interface Walked {
  readonly fixture: string;
  readonly elements: number;
  readonly states: number;
}

interface Reading {
  readonly failures: readonly string[];
  readonly measured: number;
  readonly reached: ReadonlySet<string>;
  readonly unreadable: readonly string[];
  readonly unknownClasses: ReadonlySet<string>;
  /** Per fixture, in fixture order — see {@link Walked}. */
  readonly walk: readonly Walked[];
  /**
   * Every `(fixture, element, state)` the walk reached that yielded **no
   * composition at all**. Not a count and not a floor: a totality property. An
   * element whose colour resolves to nothing measures nothing, contributes no
   * `failures`, and is indistinguishable from an element that passed.
   */
  readonly blank: readonly string[];
  /** One named composition, kept so the floors can assert on a resolved value. */
  readonly sample: { readonly ratio: number; readonly ground: string; readonly colour: string } | null;
}

function paintsText(element: Element): boolean {
  if (element.hasAttribute('hidden')) return false;
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') return true;
  return Array.from(element.childNodes).some(
    (node) => node.nodeType === node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
  );
}

async function readTheApp(theme: Theme): Promise<Reading> {
  const { paletteFor } = await import('./css-model');
  const palette = paletteFor(theme, SHEETS);
  const prepared = prepare(MODULE_RULES, palette);
  const root = rootPaint(palette);
  const failures: string[] = [];
  const reached = new Set<string>();
  const unreadable: string[] = [];
  const unknownClasses = new Set<string>();
  const walk: Walked[] = [];
  const blank: string[] = [];
  let measured = 0;
  let sample: Reading['sample'] = null;

  for (const fixture of FIXTURES) {
    const beneath: readonly Layer[] =
      fixture.beneath === undefined
        ? [
            {
              rgba: root.ground.kind === 'colour' ? root.ground.rgba : { r: 0, g: 0, b: 0, a: 1 },
              label: (root.ground.kind === 'colour' ? root.ground.token : null) ?? 'base.css body',
            },
          ]
        : fixture.beneath.map((token) => {
            const paint = readPaint(`var(${token})`, (name) => palette.get(name));
            if (paint.kind !== 'colour') throw new Error(`${fixture.name}: ${token} is not a colour`);
            return { rgba: paint.rgba, label: token };
          });
    const rootColour: readonly Layer[] =
      root.colour.kind === 'colour'
        ? [{ rgba: root.colour.rgba, label: root.colour.token ?? 'base.css body' }]
        : [];

    mounting = fixture.name;
    await fixture.mount();
    const audit = new Audit(prepared, beneath, rootColour);
    let elements = 0;
    let states = 0;
    for (const element of Array.from(document.body.querySelectorAll('*'))) {
      audit.noteReach(element);
      if (!paintsText(element)) continue;
      elements += 1;
      const pairs: { colour: Layer; ground: Layer }[] = [];
      for (const state of audit.statesOn(element)) {
        states += 1;
        const before = pairs.length;
        for (const ground of audit.groundIn(element, state)) {
          for (const colour of audit.colourIn(element, state)) pairs.push({ colour, ground });
          // A `::placeholder` or `::after` is painted on the element's own
          // ground, in its own colour.
          for (const colour of audit.pseudoColours(element)) pairs.push({ colour, ground });
        }
        // THE TOTALITY FLOOR. An element the walk reached but measured nothing
        // on is not a pass — it is an absence wearing a pass's clothes. The way
        // this whole file goes quietly vacuous is a colour chain that resolves
        // to nothing: `coloursFor` bottoms out at `base.css body`, and if that
        // ever stops resolving, every element that *inherits* its colour yields
        // zero pairs, contributes zero `failures`, and reads as green.
        if (pairs.length === before) {
          blank.push(
            `${fixture.name} — <${element.tagName.toLowerCase()}>` +
              `${state === '' ? '' : ` in state \`${state}\``} measured nothing`,
          );
        }
      }
      for (const { colour, ground } of pairs) {
        measured += 1;
        const ratio = contrastRatio(composite(colour.rgba, ground.rgba), ground.rgba);
        if (sample === null && colour.label === '--vela-text-muted') {
          sample = { ratio, ground: ground.label, colour: colour.label };
        }
        if (ratio + 0.005 < THRESHOLD) {
          failures.push(
            `${ratio.toFixed(2)}:1 (needs ${THRESHOLD.toFixed(1)}) in ${theme} — ` +
              `${colour.label} on ${ground.label} — <${element.tagName.toLowerCase()}> in ${fixture.name}`,
          );
        }
      }
    }
    walk.push({ fixture: fixture.name, elements, states });
    for (const name of audit.reached) reached.add(name);
    unreadable.push(...audit.unreadable);
    for (const name of audit.unknownClasses) unknownClasses.add(name);
    cleanup();
  }

  return {
    failures: [...new Set(failures)].sort(),
    measured,
    reached,
    unreadable: [...new Set(unreadable)].sort(),
    unknownClasses,
    walk,
    blank: [...new Set(blank)].sort(),
    sample,
  };
}

const readings = new Map<Theme, Promise<Reading>>();
function reading(theme: Theme): Promise<Reading> {
  const existing = readings.get(theme);
  if (existing !== undefined) return existing;
  const started = readTheApp(theme);
  readings.set(theme, started);
  return started;
}

afterAll(() => {
  cleanup();
});

/**
 * A budget, not a bound (RULE Q).
 *
 * One reading mounts every fixture in {@link FIXTURES}; on an idle box the two
 * take a few seconds each, which is comfortably inside Vitest's 5 s default and
 * not comfortably enough. Under load they run over it, and the failure that
 * produces is not merely noisy — it is *misdirecting*. Vitest does not cancel
 * the timed-out body, so the light reading goes on mounting and calling
 * `cleanup()` while the dark one renders into the same jsdom document; the
 * readings interleave, fixtures come up empty, and the loudest red is
 * `every rule that paints text is reached by some fixture` reporting a dozen
 * extra unreached rules. Its own message then advises the reader to *add the
 * line to `NOT_RENDERED`* — that is, to answer a timing failure by permanently
 * shrinking the audit. Observed twice while this file was being graded.
 *
 * So the budget is stated, generously, in one place. If a reading ever really
 * does hang, it still fails — just not by quietly teaching someone to delete
 * coverage.
 */
const READING_BUDGET_MS = 120_000;

describe('every composition the rendered tree assembles clears WCAG AA', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(
      `holds in ${theme}`,
      async () => {
        const result = await reading(theme);
        expect(result.unreadable, 'a paint value the audit could not read').toEqual([]);
        expect(
          result.failures,
          `${result.failures.length} rendered compositions are below AA in ${theme}`,
        ).toEqual([]);
      },
      READING_BUDGET_MS,
    );
  }

  it(
    'measures every element it reaches, in both themes',
    async () => {
      // THE FLOOR THE OTHER FLOORS NEEDED.
      //
      // Every anti-vacuity check in this file used to read `light` and only
      // `light`: `measured > 100`, the `NOT_RENDERED` comparison, the
      // `unknownClasses` check, `reached.size > 20`. The dark reading was held
      // up by one thing — that its sample existed and differed from light's —
      // and a single `--vela-text-muted` element in the first fixture satisfies
      // that. Cutting the dark walk from 23 fixtures to 1 left this file green
      // at exit 0, measured by doing it.
      //
      // Two laws replace the one floor, and neither is a number anybody chose:
      //
      // 1. `blank` — no element the walk reached may measure nothing. Emptying
      //    `rootColour` (what a `base.css body` whose colour stopped resolving
      //    would do) deletes every *inherited* colour in the app, and the old
      //    floor stayed green because the minority of elements that declare
      //    their own colour still cleared 100.
      // 2. `walk` — the two themes must walk identically. The walk is
      //    palette-independent by construction (see {@link Walked}), so this is
      //    forced by mechanism rather than observed: the readings differ only
      //    in a `Map` of colour values. Any short reading, in either theme,
      //    from any cause, breaks it.
      const light = await reading('light');
      const dark = await reading('dark');

      expect(light.blank, 'reached in light and measured nothing').toEqual([]);
      expect(dark.blank, 'reached in dark and measured nothing').toEqual([]);
      expect(dark.walk, 'the two themes did not walk the same tree').toEqual(light.walk);

      // and the light-only checks, said of both.
      expect(dark.unknownClasses, 'a rendered class this audit cannot attribute').toEqual(
        new Set(),
      );
      expect([...dark.reached].sort(), 'the dark reading reached other rules').toEqual(
        [...light.reached].sort(),
      );
    },
    READING_BUDGET_MS,
  );

  it('resolves real colours, not jsdom’s defaults', async () => {
    // THE ANTI-VACUITY FLOOR, asserted on resolved values.
    //
    // The way this guard fails silently is not by finding no elements — it is by
    // resolving every colour to the same constant, which is exactly what asking
    // jsdom would do: `canvastext` on `rgba(0, 0, 0, 0)` for every element in
    // the app, a uniform 21:1, green forever. So the floor is a *number*: a
    // named composition, resolved through the ancestry, at a ratio the palette
    // fixes.
    const light = await reading('light');
    const dark = await reading('dark');
    expect(light.measured).toBeGreaterThan(100);
    expect(light.sample).not.toBeNull();
    expect(dark.sample).not.toBeNull();
    expect(light.sample?.colour).toBe('--vela-text-muted');
    // The two themes must not agree: a resolver that had stopped resolving would
    // hand both the same value.
    expect(light.sample?.ratio).not.toBe(dark.sample?.ratio);
    expect(light.sample?.ratio).toBeGreaterThan(THRESHOLD);
    // And no label may be an unresolved `var()` string.
    expect(light.failures.some((line) => line.includes('var('))).toBe(false);
  }, READING_BUDGET_MS);

  it('every rule that paints text is reached by some fixture', async () => {
    const light = await reading('light');
    const painting = [
      ...new Set(
        MODULE_RULES.filter((rule) => declaredValue(rule, 'color') !== undefined).map(
          (rule) => `${rule.file} — ${rule.selector}`,
        ),
      ),
    ];
    const unreached = painting.filter((name) => !light.reached.has(name)).sort();
    expect(
      unreached,
      'reach it with a fixture, or add the line to NOT_RENDERED and say why it cannot be',
    ).toEqual(NOT_RENDERED);
    expect(
      painting.length - unreached.length,
      'the fixtures have stopped reaching rules',
    ).toBeGreaterThan(120);
  }, READING_BUDGET_MS);

  it('the class-name map is intact', async () => {
    // If Vitest's class-name spelling changes, every `applies()` returns false,
    // every element resolves to the root colour on the root ground, and the two
    // assertions above pass while measuring nothing real.
    expect(FILE_BY_HASH.size).toBe(Object.keys(MODULES).length);
    expect(new Set(FILE_BY_HASH.values()).size).toBe(FILE_BY_HASH.size);
    const skills = MODULES['/src/features/skills/SkillsPanel.module.css']?.default['body'] ?? '';
    expect(skills).toMatch(HASHED);
    expect(localClass(skills)).toEqual({
      file: 'src/features/skills/SkillsPanel.module.css',
      name: 'body',
    });
    const light = await reading('light');
    expect(light.unknownClasses, 'a rendered class this audit cannot attribute').toEqual(new Set());
    expect(light.reached.size).toBeGreaterThan(20);
  }, READING_BUDGET_MS);
});
