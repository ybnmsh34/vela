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
 * `rootColour` — which deletes every *inherited* colour in the app, leaving only
 * the minority of elements that declare their own — still left it green, because
 * that minority cleared the hundred on its own.
 * `measures every element it reaches, in both themes` replaces that threshold
 * with two totality laws; see it for what each one forbids.
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
 * builds `added`. Four things push back on it:
 *
 * 1. **The shape is the unit, not the state.** A rule applies to an element when
 *    its subject compound's classes are on that element *and* its element type,
 *    if it names one, is that element's; pseudo-classes and attribute
 *    conditions are *ignored*, so `.row:hover`'s ground and
 *    `.diffRow[data-kind='removed']`'s ground are both measured against a plain
 *    rendered `.row` / `.diffRow`. That over-approximates — it measures
 *    compositions this particular render did not paint — which is the safe
 *    direction for a guard, and it is why `:hover`, `:focus-visible`,
 *    `::placeholder` and `data-` variants are covered without a fixture per
 *    state.
 * 2. **Un-reached rules are named, not skipped.** `every rule that paints text
 *    is reached by some fixture` lists every rule that declares a colour — or an
 *    `opacity`, which dims one — that no fixture reached, and compares that list
 *    against `NOT_RENDERED` — an exact set, not a floor. Such a rule added
 *    anywhere in `src/` fails this file until a fixture reaches it or somebody
 *    writes down why it cannot. The debt
 *    is large and it is *enumerated*; before this file it was invisible. What
 *    that list may not be used for is the subject of {@link NOT_RENDERED}'s own
 *    comment: it enumerates what is unreached, and "unreached" once quietly
 *    included four rules the matcher could not see rather than four rules no
 *    fixture mounted.
 * 3. **A selector this file cannot scope is a failure, not a miss.** Every
 *    audited part must name a CSS-module class somewhere, because that hashed
 *    name is the only thing tying a rule to a rendered element;
 *    {@link SelectorPart.anchored} is the third answer, in the shape
 *    `css-model.ts` gave the value reader with `unreadable`. And the sheets this
 *    file does *not* read — the global ones, which no class scopes — are
 *    enumerated in {@link GLOBAL_PAINT} with the guard that reads each, so the
 *    edge of this file's universe is held by an assertion rather than by
 *    `base.css`'s request that nobody put component styles in it.
 * 4. **A property this file does not read is a failure, not a miss.** The two
 *    answers above both presuppose that the paint arrives as a value of
 *    `color`, `background` or `background-color`, and for two rounds those three
 *    names were the whole question. They are not the whole engine: `opacity`
 *    composites the glyphs exactly as an `rgba()` value would,
 *    `-webkit-text-fill-color` overrides `color` for glyph fill, a `filter` or a
 *    `mix-blend-mode` rewrites the pixel after both values are chosen, and a
 *    `--vela-*` custom property re-declared on an *ancestor* changes what every
 *    `var()` below it resolves to. None of those produce a value the reader is
 *    handed, so none of them can be called `unreadable`; "this rule declares no
 *    foreground I can see" collapses back into "this rule declares no
 *    foreground". So `opacity` is **modelled** — see {@link Layer} — and every
 *    other paint-moving property is **reported by name** against
 *    {@link UNMODELLED_PAINT}, while a custom property outside `tokens.css`
 *    fails outright. See {@link MOVES_PAINT} and
 *    {@link customPropertiesOutsideTheTokenSheet}.
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
  declaredBy,
  declaredValue,
  expandVars,
  loadSheets,
  paletteFor,
  parseStylesheet,
  readPaint,
  type Lookup,
  type Paint,
  type Rgba,
  type Rule,
  type Sheet,
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
 * THE EDGE OF THE UNIVERSE THIS FILE MEASURES, HELD BY A GUARD.
 *
 * Everything above is a CSS Module, because a module class is the only thing
 * that ties a rule to a rendered element. A rule in a *global* sheet is scoped
 * by nothing — `dl { background: … }` in `base.css` would paint under half the
 * app — so this file cannot attribute one, and `base.css` saying "Do not add
 * component styles to this file" is prose, which can neither create nor prove
 * an edge.
 *
 * So the edge is enumerated instead: every global rule that declares a `color`
 * or a `background`, with **what reads it**. A new one fails
 * `no global stylesheet paints outside what is already measured` until it is
 * either moved into a module or added here with its reader named.
 */
const GLOBAL_PAINT: ReadonlyMap<string, string> = new Map([
  [
    'src/styles/base.css — body',
    'read by `rootPaint`, which is the ground and the colour every fixture below inherits',
  ],
  [
    'src/styles/base.css — button, input, textarea, select',
    'declares `color: inherit` and no ground, so it introduces no composition',
  ],
  [
    'src/styles/base.css — ::selection',
    "co-declares both halves, so contrast.test.ts's `every rule that paints text on a ground it declares itself is a pair in the table` measures it",
  ],
  [
    'src/styles/base.css — ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner',
    'the scrollbar trough carries no text; --vela-scrollbar-track is exempt with a reason in contrast.test.ts NOT_A_TEXT_GROUND',
  ],
  [
    'src/styles/base.css — ::-webkit-scrollbar-thumb',
    'the thumb carries no text and is audited as a `ui` foreground against every scroller ground in contrast.test.ts',
  ],
  [
    'src/styles/base.css — ::-webkit-scrollbar-thumb:hover',
    'the same thumb, hovered, audited the same way',
  ],
]);

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
  /**
   * The element type this compound names, lower-cased — `dt` in `.fact dt` — or
   * `null` when it names none.
   *
   * Reading it is what closed this file's own version of the defect it was
   * written for. The matcher used to require a CSS-module class on the element
   * itself, so a compound that names only an element type matched nothing, and
   * `HomeSurface.tsx`'s `<dt>Platform</dt>` — unclassed, inside
   * `<div className={styles.fact}>` — was invisible to `.fact dt`. The rule then
   * appeared in {@link NOT_RENDERED} as though no fixture had mounted it.
   */
  readonly tag: string | null;
  readonly classes: readonly string[];
}

interface SelectorPart {
  /** The part as written, for a message that can be found in the sheet. */
  readonly text: string;
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
  /**
   * Whether some compound in this part names a CSS-module class.
   *
   * A class is the only thing that ties a rule in a component's CSS Module to
   * an element that component rendered: the hashed name appears on the DOM node and
   * nowhere else. A part with no class anywhere — `li`, `*`, `#root` — could be
   * on any element in the app or on none, and this matcher has no way to tell
   * which. It answers **no match**, and a "no match" is indistinguishable from
   * "no fixture mounted it".
   *
   * That is the same collapse `css-model.ts` removed on the value side, where a
   * value the reader cannot parse became `unreadable` rather than absent. Here
   * the third answer is this flag: an unanchored part is reported by
   * `no audited rule is scoped to the DOM by something this audit cannot see`
   * instead of being quietly filed under un-rendered.
   */
  readonly anchored: boolean;
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
  // An element type can only be written first in a compound, so anything after
  // a `.`, `:` or `#` is not one. An `#id` is dropped from what is matched on —
  // it is unhashed and this file cannot resolve it against a fixture — and
  // `parseSelector` records it as a condition so that dropping it can widen the
  // match without also winning the cascade.
  const tag = /^([a-z][-\w]*)/u.exec(bare)?.[1]?.toLowerCase() ?? null;
  return { tag, classes: [...bare.matchAll(/\.([-\w]+)/gu)].map((match) => match[1] ?? '') };
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
    // Everything in a selector that this matcher does **not** evaluate, in one
    // list: attribute conditions, pseudo-classes, and `#id`. Collecting them
    // here is what keeps an unevaluated condition out of the base cascade —
    // see {@link SelectorPart.conditional}. `#id` is in the list because
    // `compoundOf` drops it from the compound it matches on while
    // `specificityOf` counts it at 10000: an id-bearing rule is matched against
    // nothing and outranks every class in the file, so in the base cascade it
    // would win and report a colour the engine may never paint. No module sheet
    // in `src/` writes one today — this is the door, closed before anybody uses
    // it.
    const conditions = [
      ...withoutPseudoElement.matchAll(/\[[^\]]*\]|(?<!:):(?!:)[-\w]+(?:\([^)]*\))?|#[-\w]+/gu),
    ]
      .map((match) => match[0])
      .sort();
    const ancestors = siblings ? [] : compounds.slice(0, -1).map(compoundOf);
    const subject = compoundOf(last);
    return [
      {
        text,
        ancestors,
        subject,
        pseudoElement: PSEUDO_ELEMENT.exec(last)?.[0] ?? null,
        conditional: conditions.length > 0,
        state: conditions.join(''),
        specificity: specificityOf(text),
        anchored:
          subject.classes.length > 0 || ancestors.some((one) => one.classes.length > 0),
      },
    ];
  });
}

/** One declaration this audit reads, with the flag the cascade has to rank. */
interface Ranked<T> {
  readonly value: T;
  readonly important: boolean;
}

/**
 * A group opacity, read the way {@link Paint} reads a colour.
 *
 * `null` is the third answer again: `opacity` is a property that moves every
 * painted pixel of an element and of everything inside it, and a value this
 * audit cannot turn into a number must be a named failure rather than a silent
 * `1`. `opacity: var(--something-undeclared)` and `opacity: calc(1 / 3)` both
 * land here.
 */
interface Alpha {
  readonly value: number | null;
  readonly text: string;
}

interface Prepared {
  readonly rule: Rule;
  readonly parts: readonly SelectorPart[];
  readonly foreground: Ranked<Paint> | undefined;
  readonly ground: Ranked<Paint> | undefined;
  /** `opacity`, which dims this rule's element and everything inside it. */
  readonly opacity: Ranked<Alpha> | undefined;
  /** `content`, which decides whether a `::before`/`::after` paints glyphs. */
  readonly content: Ranked<string> | undefined;
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

/**
 * A rule inside an at-rule is a **state**, never a competitor.
 *
 * `@media print { .fact dd { color: … } }` is later in source order than the
 * `.fact dd` above it and has identical specificity, so a cascade that ignored
 * the condition would hand this file the print colour and never mention the one
 * on screen — a paint the engine does not use, reported as the paint it does.
 * Folding the conditions into {@link SelectorPart.state} instead puts the rule
 * in a cascade of its own, exactly as `:hover` is: it is measured *as well*,
 * and it displaces nothing. That over-approximates, which is the direction that
 * cannot hide a composition.
 *
 * No module rule under a condition declares a paint today, so nothing this
 * repository currently measures moves — observed, not a bound.
 */
function partsOf(rule: Rule): readonly SelectorPart[] {
  const parts = parseSelector(rule.selector);
  if (rule.conditions.length === 0) return parts;
  const under = rule.conditions.join(' ');
  return parts.map((part) => ({
    ...part,
    conditional: true,
    state: `${part.state} under ${under}`,
  }));
}

/**
 * `opacity`, read to a number.
 *
 * A percentage is the same value in this property's other spelling, and a number
 * outside 0..1 is clamped, which is what the engine does with it. Anything
 * else — a `calc()`, a custom property with no declaration — comes back with a
 * `null` value and is reported by name, never rounded up to `1`.
 */
function readAlpha(value: string, lookup: Lookup): Alpha {
  const expansion = expandVars(value, lookup);
  const text = expansion.text.trim();
  if (expansion.unresolved.length > 0) return { value: null, text: value };
  const percent = /^([\d.]+)%$/u.exec(text);
  const number = /^([\d.]+)$/u.exec(text);
  const raw =
    percent !== null
      ? Number.parseFloat(percent[1] ?? '') / 100
      : number !== null
        ? Number.parseFloat(number[1] ?? '')
        : Number.NaN;
  if (!Number.isFinite(raw)) return { value: null, text: value };
  return { value: Math.min(1, Math.max(0, raw)), text: value };
}

function prepare(rules: readonly Rule[], palette: Map<string, string>): readonly Prepared[] {
  return rules.map((rule, order) => {
    const lookup = lookupFor(rule, palette);
    const colour = declaredBy(rule, 'color');
    const ground = declaredBy(rule, 'background', 'background-color');
    const alpha = declaredBy(rule, 'opacity');
    const content = declaredBy(rule, 'content');
    return {
      rule,
      order,
      parts: partsOf(rule),
      foreground:
        colour === undefined
          ? undefined
          : { value: readPaint(colour.value, lookup), important: colour.important },
      ground:
        ground === undefined
          ? undefined
          : { value: readPaint(ground.value, lookup), important: ground.important },
      opacity:
        alpha === undefined
          ? undefined
          : { value: readAlpha(alpha.value, lookup), important: alpha.important },
      content:
        content === undefined
          ? undefined
          : { value: expandVars(content.value, lookup).text.trim(), important: content.important },
    };
  });
}

/* -------------------------------------------------------------------------- */
/* matching a rule to a rendered element                                       */
/* -------------------------------------------------------------------------- */

const classCache = new WeakMap<Element, Map<string, Set<string>>>();

function classesByFile(element: Element): Map<string, Set<string>> {
  const cached = classCache.get(element);
  if (cached !== undefined) return cached;
  const found = new Map<string, Set<string>>();
  for (const token of Array.from(element.classList)) {
    const local = localClass(token);
    if (local === null) continue;
    const set = found.get(local.file) ?? new Set<string>();
    set.add(local.name);
    found.set(local.file, set);
  }
  classCache.set(element, found);
  return found;
}

const NO_CLASSES: ReadonlySet<string> = new Set<string>();

/**
 * Whether one compound of a selector describes this element.
 *
 * The class test is scoped to the rule's own sheet, which is what keeps
 * `.fact` in one module from matching `.fact` in another: the DOM carries the
 * hashed spelling and `classesByFile` maps it back to the file that emitted it.
 * The element-type test needs no such scoping — but it is only ever asked
 * inside a part that some class already anchors (see {@link SelectorPart.anchored}).
 */
function compoundMatches(compound: Compound, element: Element, file: string): boolean {
  if (compound.tag !== null && element.tagName.toLowerCase() !== compound.tag) return false;
  if (compound.classes.length === 0) return true;
  const own = classesByFile(element).get(file) ?? NO_CLASSES;
  return compound.classes.every((name) => own.has(name));
}

/** The parts of a rule's selector that reach this element, if any. */
function matchingParts(prepared: Prepared, element: Element): readonly SelectorPart[] {
  const own = classesByFile(element).get(prepared.rule.file);
  return prepared.parts.filter((part) => {
    if (!part.anchored) return false;
    // The whole cost of this file is here, so the cheap rejection comes first:
    // a part whose subject names a class cannot reach an element carrying none
    // of this sheet's classes. A part whose subject names no class has to walk
    // instead.
    //
    // Measured over the module sheets as this was written: 618 rules, 670
    // selector parts, of which **44** have a subject naming no class. Thirteen
    // of those 44 are `@keyframes` stops — the five distinct texts `0%`, `30%`,
    // `50%`, `60%` and `100%`, which `partsOf` emits into the same 670 and
    // which `anchored` rejects before this loop ever walks them. The other 31
    // are anchored by a class on an ancestor and do walk, and 27 of those 31
    // name an element type. Two of the 27 are `.fact dt` and `.fact dd`, the
    // composition that got past the previous matcher.
    //
    // The number this sentence used to give was 31 for the whole 44, which is
    // the count *after* the `anchored` filter above — a different proposition
    // about the same 670, and wrong. Observed and open: a sheet can add or
    // remove one at any time.
    if (part.subject.classes.length > 0 && own === undefined) return false;
    if (!compoundMatches(part.subject, element, prepared.rule.file)) return false;
    let index = part.ancestors.length - 1;
    let node = element.parentElement;
    while (index >= 0 && node !== null) {
      const compound = part.ancestors[index];
      if (compound !== undefined && compoundMatches(compound, node, prepared.rule.file)) {
        index -= 1;
      }
      node = node.parentElement;
    }
    return index < 0;
  });
}

/**
 * Every selector part in an audited rule that nothing scopes to the DOM.
 *
 * Empty today, and the assertion that reads it says so exactly rather than as a
 * floor. See {@link SelectorPart.anchored} for why an unanchored part is a
 * third answer and not a "no".
 */
function unanchoredParts(rules: readonly Rule[]): readonly string[] {
  return rules.flatMap((rule) => {
    const paints =
      declaredValue(rule, 'color') !== undefined ||
      declaredValue(rule, 'background', 'background-color') !== undefined;
    if (!paints) return [];
    return partsOf(rule)
      .filter((part) => !part.anchored)
      .map((part) => `${rule.file} — ${rule.selector} — \`${part.text}\` names no CSS-module class`);
  });
}

/* -------------------------------------------------------------------------- */
/* the third answer, at the property level                                      */
/* -------------------------------------------------------------------------- */

/**
 * THE PROPERTIES THAT MOVE A PAINTED PIXEL.
 *
 * Two rounds of this file narrowed onto three property names — `color`,
 * `background`, `background-color` — and then spent their effort on *which
 * element* the cascade reaches. Nothing asked **which property paints**, and
 * that is a door of exactly the shape the two repairs before it closed. A paint
 * declared in a fourth property never becomes a value, so `readPaint`'s
 * `unreadable` arm has nothing to be about: "this rule declares no foreground I
 * can see" collapses back into "this rule declares no foreground", which is the
 * original defect wearing a property name instead of a value.
 *
 * So this is the third answer one level up. Every property below changes the
 * pixel a glyph or its ground is painted in, and each one is either **modelled**
 * or **reported by name**:
 *
 * - `opacity` is modelled — see {@link Layer} — for every rule the cascade can
 *   reach. It is still reported inside `@keyframes`, where the value is a
 *   function of time and this audit measures a still frame.
 * - everything else is reported, and the report is compared against
 *   {@link UNMODELLED_PAINT}, which is the only way to be exempt and names a
 *   reason per declaration.
 *
 * A `-webkit-text-fill-color`, a `filter`, a `mix-blend-mode` or a
 * `background-image` added anywhere under `src/` fails this file until somebody
 * either teaches it the property or writes down why that declaration cannot hide
 * a sub-AA composition.
 */
const MOVES_PAINT: readonly string[] = [
  'opacity',
  'filter',
  'backdrop-filter',
  'mix-blend-mode',
  'background-blend-mode',
  'background-image',
  'background-clip',
  '-webkit-background-clip',
  '-webkit-text-fill-color',
  '-webkit-text-stroke',
  '-webkit-text-stroke-color',
  'text-shadow',
  'color-scheme',
  'forced-color-adjust',
  'visibility',
];

const IN_KEYFRAMES = (rule: Rule): boolean =>
  rule.conditions.some((condition) => condition.startsWith('@keyframes'));

/** `file — selector — property`, the key {@link UNMODELLED_PAINT} is written in. */
function paintMovers(sheets: readonly Sheet[]): readonly string[] {
  const found: string[] = [];
  for (const sheet of sheets) {
    for (const rule of sheet.rules) {
      const where =
        rule.conditions.length === 0
          ? rule.selector
          : `${rule.conditions.join(' ')} — ${rule.selector}`;
      for (const declaration of rule.declarations) {
        if (!MOVES_PAINT.includes(declaration.property)) continue;
        // The one modelled property, on the one kind of rule the cascade reaches.
        if (declaration.property === 'opacity' && !IN_KEYFRAMES(rule)) continue;
        found.push(`${rule.file} — ${where} — ${declaration.property}`);
      }
    }
  }
  return [...new Set(found)].sort();
}

/**
 * Every declaration of a paint-moving property this file does not model, with
 * why it cannot hide a composition.
 *
 * Same contract as {@link GLOBAL_PAINT} and as `contrast.test.ts`'s
 * `NOT_A_TEXT_GROUND`: this list is the only way to be exempt, and every entry
 * is a claim a reviewer can check against the component. An entry whose reason
 * is empty fails alongside a declaration that has no entry at all.
 */
const UNMODELLED_PAINT: ReadonlyMap<string, string> = new Map([
  [
    'src/features/conversation/Markdown.module.css — @keyframes caret — 0%, 50% — opacity',
    "the streaming caret: `.paragraph[data-last='true']::after` with `content: ''`, a filled box carrying no glyphs",
  ],
  [
    'src/features/conversation/Markdown.module.css — @keyframes caret — 50.01%, 100% — opacity',
    'the other half of the same caret blink',
  ],
  [
    'src/features/conversation/MessageTurn.module.css — @keyframes bounce — 0%, 60%, 100% — opacity',
    'the waiting dots: `MessageTurn.tsx` renders three empty `<span>` children inside `.dots`, each sized by `--vela-dot` and filled with `currentcolor`; no glyphs',
  ],
  [
    'src/features/conversation/MessageTurn.module.css — @keyframes bounce — 30% — opacity',
    'the other stop of the same bounce',
  ],
  [
    'src/features/conversation/ThinkingBlock.module.css — @keyframes pulse — 0%, 100% — opacity',
    'the thinking dot: `ThinkingBlock.tsx` renders `.pulse` as an empty `<span aria-hidden>` filled with --vela-accent; no glyphs',
  ],
  [
    'src/features/conversation/ThinkingBlock.module.css — @keyframes pulse — 50% — opacity',
    'the other stop of the same pulse',
  ],
  [
    'src/features/conversation/ToolCallList.module.css — @keyframes pulse — 0%, 100% — opacity',
    'the running-tool dot: `ToolCallList.tsx` renders `.pulse` as an empty `<span aria-hidden>` filled with `currentcolor`; no glyphs',
  ],
  [
    'src/features/conversation/ToolCallList.module.css — @keyframes pulse — 50% — opacity',
    'the other stop of the same pulse',
  ],
  [
    'src/features/navigation/DeleteConversationDialog.module.css — .confirm:hover — filter',
    'a `brightness()` over the whole button, so the label and the fill it sits on move together; the composition this audit measures is the base state, which is the one the pointer is not on',
  ],
  [
    'src/styles/base.css — ::-webkit-scrollbar-thumb — background-clip',
    'the scrollbar thumb carries no text; the thumb itself is audited as a foreground in contrast.test.ts',
  ],
  [
    'src/styles/base.css — ::-webkit-scrollbar-thumb:hover — background-clip',
    'the same thumb, hovered',
  ],
  [
    "src/styles/tokens.css — :root — color-scheme",
    'the document-level scheme, which supplies a colour only where nothing else does: `base.css body` declares an explicit colour and ground — read by `rootPaint` — and `base.css button, input, textarea, select` declares `color: inherit`; both rules are entries in GLOBAL_PAINT',
  ],
  [
    "src/styles/tokens.css — :root[data-theme='dark'] — color-scheme",
    'the same declaration under an explicit theme choice',
  ],
  [
    "src/styles/tokens.css — @media (prefers-color-scheme: dark) — :root:not([data-theme='light']) — color-scheme",
    'the same declaration under the system preference',
  ],
]);

/**
 * Every custom property declared outside the token sheet.
 *
 * Empty today, and this is the door {@link lookupFor} leaves open. That function
 * resolves a `var()` against **the declaring rule's own custom properties plus
 * `:root`'s** — which closed round one's escape (`--panel-bg: var(--vela-x);
 * background: var(--panel-bg);` in one rule) and left the identical blindness
 * one scope up. A custom property is inherited: an *ancestor* rule can declare
 * `--vela-code-bg: var(--vela-bg)` and every `background: var(--vela-code-bg)`
 * below it resolves to something else, while this audit goes on reporting the
 * global value with full confidence. That is a confident wrong answer, which is
 * worse than silence, and it costs one line in a rule that declares no paint at
 * all and so enters no painting set.
 *
 * Modelling custom-property inheritance is a second cascade. Forbidding the
 * shape is one assertion, and it is the honest one while nothing needs it: no
 * sheet under `src/` outside `tokens.css` declares a custom property today. A
 * *new* name declared on an ancestor and read by a descendant already fails
 * loudly — `readPaint` returns `unreadable` because the descendant's lookup has
 * no declaration for it — so the only shape this adds is **re-pointing a name
 * the palette already answers**.
 */
function customPropertiesOutsideTheTokenSheet(sheets: readonly Sheet[]): readonly string[] {
  const found: string[] = [];
  for (const sheet of sheets) {
    if (sheet.name === 'src/styles/tokens.css') continue;
    for (const rule of sheet.rules) {
      for (const declaration of rule.declarations) {
        if (!declaration.property.startsWith('--')) continue;
        found.push(`${rule.file} — ${rule.selector} — ${declaration.property}`);
      }
    }
  }
  return [...new Set(found)].sort();
}

/** One rule reaching one element, with what the cascade needs to order it. */
interface Hit {
  readonly prepared: Prepared;
  readonly conditional: boolean;
  /**
   * `::after`, `::placeholder`, … — the pseudo-element this hit paints, by
   * name, or `null` when it paints the element itself.
   *
   * It was a boolean, and the name is what the boolean could not carry: a
   * pseudo-element has a box of its own, so its `background` is a ground of its
   * own and two different pseudo-elements on one element are two different
   * cascades. See {@link Audit.pseudoPairs}.
   */
  readonly pseudoElement: string | null;
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
        pseudoElement: part.pseudoElement,
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
  read: (hit: Hit) => Ranked<T> | undefined,
): T | undefined {
  const candidates = hits.filter(
    (hit) => read(hit) !== undefined && (!hit.conditional || hit.state === state),
  );
  // IMPORTANCE FIRST, AND IT IS NOT A REFINEMENT OF SPECIFICITY.
  //
  // `!important` beats every normal author declaration whatever its
  // specificity, so it is a separate, higher key — not a tie-break. Sorting by
  // specificity alone made this file answer with the higher-specificity normal
  // declaration and name a colour the engine never paints: `.body { color: X
  // !important }` really does beat `.detail .body { color: Y }`, and the audit
  // reported Y. `css-model.ts` used to strip the word before this function
  // could see it, which is the same "no" that meant "I cannot tell" one axis
  // over.
  const weight = (hit: Hit): number => (read(hit)?.important === true ? 1 : 0);
  const winner = [...candidates]
    .sort((a, b) => {
      if (weight(a) !== weight(b)) return weight(a) - weight(b);
      return a.specificity === b.specificity
        ? a.prepared.order - b.prepared.order
        : a.specificity - b.specificity;
    })
    .at(-1);
  return winner === undefined ? undefined : read(winner)?.value;
}

/* -------------------------------------------------------------------------- */
/* what the element stands on, and what colour it is painted in                */
/* -------------------------------------------------------------------------- */

/** A {@link Paint} that resolved to an actual colour. */
type Solid = Extract<Paint, { readonly kind: 'colour' }>;

/**
 * A ground, as painted — and the two extra numbers a group `opacity` needs.
 *
 * `opacity` is not a colour and it is not a state: it renders an element and
 * everything inside it into a buffer and composites that buffer over what is
 * behind at `alpha`. So text inside the group and the ground inside the group
 * are **both** mixed toward the same backdrop, and neither of them is what its
 * own declaration says. Reading only `color` and `background` reports the
 * undimmed pair with full confidence — which is how `--vela-text-muted` on
 * `--vela-surface-raised`, a genuine 7.23:1, is painted at 2.82:1 by one extra
 * word in the same rule.
 *
 * `alpha` is the group's opacity and `outside` is the pixel the group
 * composites over, so a caller can reconstruct both painted pixels:
 *
 * - the ground is `rgba`, which is already `composite(declared × alpha, outside)`;
 * - the text is `composite(colour × alpha, outside)` — see {@link paintedOn}.
 *
 * When `alpha` is 1 there is no group, `outside` is `rgba`, and both reduce to
 * what this file did before: the text painted straight onto the ground.
 */
interface Layer {
  readonly rgba: Rgba;
  /** The role chain, nearest first, for the failure message. */
  readonly label: string;
  /** The `opacity` of the group this ground is inside; 1 when there is none. */
  readonly alpha: number;
  /** The painted pixel that group composites over; `rgba` when `alpha` is 1. */
  readonly outside: Rgba;
}

/** A ground nothing dims. */
const undimmed = (rgba: Rgba, label: string): Layer => ({ rgba, label, alpha: 1, outside: rgba });

const fade = (rgba: Rgba, alpha: number): Rgba => ({ ...rgba, a: rgba.a * alpha });

/** What a text colour becomes once the group it is painted in is composited. */
function paintedOn(colour: Rgba, ground: Layer): Rgba {
  return ground.alpha >= 1
    ? composite(colour, ground.rgba)
    : composite(fade(colour, ground.alpha), ground.outside);
}

const ROOT = 'src/styles/base.css';

/**
 * The `body` rule's own colour and ground, read from `base.css` rather than
 * asserted in a comment: every fixture's root inherits them unless it says
 * otherwise, so a change to that rule must move these numbers.
 */
function rootPaint(palette: Map<string, string>): { colour: Solid; ground: Solid } {
  const sheet = SHEETS.find(({ name }) => name === ROOT);
  const body = sheet?.rules.find(({ selector }) => selector === 'body');
  if (body === undefined) throw new Error(`${ROOT} no longer has a \`body\` rule to read`);
  const lookup = lookupFor(body, palette);
  const colour = declaredValue(body, 'color');
  const ground = declaredValue(body, 'background', 'background-color');
  if (colour === undefined || ground === undefined) {
    throw new Error(`${ROOT} \`body\` no longer declares both a colour and a ground`);
  }
  const painted = { colour: readPaint(colour, lookup), ground: readPaint(ground, lookup) };
  // Not a fallback. The ground under every fixture used to default to opaque
  // black here and the root colour to nothing at all, so a `body` rule whose
  // paint stopped resolving would have this file measure the whole app against
  // a colour no sheet declares — and report ratios for it. Failing names the
  // half that stopped resolving instead, and it is the reason no colour value
  // is written anywhere in this file.
  if (painted.colour.kind !== 'colour' || painted.ground.kind !== 'colour') {
    throw new Error(
      `${ROOT} \`body\` no longer resolves: colour is ${painted.colour.kind}, ground is ${painted.ground.kind}`,
    );
  }
  return { colour: painted.colour, ground: painted.ground };
}

class Audit {
  private readonly grounds = new Map<Element, readonly Layer[]>();
  private readonly colours = new Map<Element, readonly Layer[]>();
  readonly reached = new Set<string>();
  readonly unreadable: string[] = [];
  readonly unknownClasses = new Set<string>();
  /**
   * Compositions this file declines to compute, by name.
   *
   * The group-opacity arithmetic in {@link Layer} is exact for one group: a
   * dimmed element, and text either on its own ground or on the ground above
   * it. Nest a second `opacity` inside the first and the buffers stack, and the
   * one-multiplication form stops being the right answer. That is reported here
   * rather than computed wrongly, which is this file's whole method.
   */
  readonly unmodelled: string[] = [];
  /** Set by the walk so a failure names the fixture it came from. */
  where = '';

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
      // `opacity` counts as paint here for the same reason it counts in the
      // census that reads this set: a rule that dims text is a rule that
      // changes what the text is painted in.
      if (
        hit.prepared.foreground !== undefined ||
        hit.prepared.ground !== undefined ||
        hit.prepared.opacity !== undefined
      ) {
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

  /** The `opacity` this element declares in one of its states, as a number. */
  private ownAlpha(element: Element, state: string): number {
    const found = inState(this.hitsFor(element), state, (hit) =>
      hit.pseudoElement !== null || hit.prepared.opacity === undefined
        ? undefined
        : hit.prepared.opacity,
    );
    if (found === undefined) return 1;
    if (found.value === null) {
      this.unreadable.push(`opacity \`${found.text}\` is not a number this audit can read`);
      return 1;
    }
    return found.value;
  }

  /**
   * The ground layer an element hands to its own text, given the ground above.
   *
   * This is where a group starts. An element that declares `opacity` below 1
   * opens one: everything it and its descendants paint is composited over the
   * pixel that was already there, which is `under.rgba`. An element that
   * declares none stays in whatever group it was already in and passes both
   * numbers through unchanged.
   */
  private dim(element: Element, state: string, under: Layer): { alpha: number; outside: Rgba } {
    const own = this.ownAlpha(element, state);
    if (own >= 1) return { alpha: under.alpha, outside: under.outside };
    if (under.alpha >= 1) return { alpha: own, outside: under.rgba };
    this.unmodelled.push(
      `${this.where} — <${element.tagName.toLowerCase()}> is at opacity ${own} inside a group ` +
        `already at opacity ${under.alpha}; this audit models one group, not two`,
    );
    return { alpha: own * under.alpha, outside: under.outside };
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
      if (hit.conditional && hit.pseudoElement === null) states.add(hit.state);
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
      if (hit.pseudoElement !== null) return undefined;
      const found = hit.prepared.ground;
      if (found !== undefined) this.note(hit, found.value);
      return found;
    });
    return above.map((under) => {
      const { alpha, outside } = this.dim(element, state, under);
      // Named only where the group *starts*. A descendant inherits the group
      // rather than opening a second one, and appending the suffix again at
      // every level made the label read `at opacity 0.75 at opacity 0.75`.
      const dimmed = alpha >= 1 || alpha === under.alpha ? '' : ` at opacity ${alpha}`;
      // `transparent`, `none` and `currentcolor` paint nothing a text ground can
      // be read off — the dot fills that use `currentcolor` carry no text — so
      // what is behind them shows through unchanged. A group opacity is not like
      // that: an element with no ground of its own still dims its own text.
      if (paint === undefined || paint.kind !== 'colour') {
        return { rgba: under.rgba, label: `${under.label}${dimmed}`, alpha, outside };
      }
      const rgba = composite(fade(paint.rgba, alpha), outside);
      const role = paint.token ?? 'a literal colour';
      const label =
        paint.rgba.a >= 1 && alpha >= 1 ? role : `${role} over ${under.label}${dimmed}`;
      return { rgba, label, alpha, outside: alpha >= 1 ? rgba : outside };
    });
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
      if (hit.pseudoElement !== null) return undefined;
      const found = hit.prepared.foreground;
      if (found !== undefined) this.note(hit, found.value);
      return found;
    });
    // `inherit` and `currentcolor` are whatever the parent already resolved to.
    if (paint === undefined || paint.kind !== 'colour') return this.coloursFor(element.parentElement);
    return [undimmed(paint.rgba, paint.token ?? 'a literal colour')];
  }

  /**
   * WHAT A PSEUDO-ELEMENT PAINTS, **AND WHAT IT PAINTS IT ON**.
   *
   * The half that was missing is the ground. A `::before`/`::after` has a box of
   * its own, so a `background` on it is that box's ground and not the element's
   * — {@link Audit.groundIn} is right to refuse it — and the reader this
   * replaces then measured the pseudo's *colour* against the **element's**
   * ground and read the pseudo's own ground nowhere. A pseudo that declares a
   * ground and no colour therefore produced no reading at all: it takes the
   * element's inherited text colour and paints it on its own fill, and both
   * halves were written in the sheet.
   *
   * `content` is what decides whether there are glyphs to measure. `::after`
   * with `content: ''` is a caret or a rail — this repo has two, both filled
   * with `--vela-accent`, neither carrying a character — and pairing the
   * inherited text colour with their fill would manufacture a composition
   * nothing paints. See {@link paintsGlyphs}.
   */
  pseudoPairs(element: Element, elementState: string): readonly { colour: Layer; ground: Layer }[] {
    const pseudo = this.hitsFor(element).filter((hit) => hit.pseudoElement !== null);
    const out: { colour: Layer; ground: Layer }[] = [];
    for (const name of new Set(pseudo.map((hit) => hit.pseudoElement ?? ''))) {
      const mine = pseudo.filter((hit) => hit.pseudoElement === name);
      const states = new Set<string>(['']);
      for (const hit of mine) if (hit.conditional) states.add(hit.state);
      for (const state of states) {
        const content = inState(mine, state, (hit) => hit.prepared.content);
        if (!paintsGlyphs(name, content)) continue;
        const paint = inState(mine, state, (hit) => {
          const found = hit.prepared.foreground;
          if (found !== undefined) this.note(hit, found.value);
          return found;
        });
        const fill = inState(mine, state, (hit) => {
          const found = hit.prepared.ground;
          if (found !== undefined) this.note(hit, found.value);
          return found;
        });
        for (const under of this.groundIn(element, elementState)) {
          // The pseudo-element sits inside its originating element's box, so
          // whatever dims the element dims it by exactly as much.
          const ground: Layer =
            fill === undefined || fill.kind !== 'colour'
              ? under
              : {
                  rgba: composite(fade(fill.rgba, under.alpha), under.outside),
                  label:
                    fill.rgba.a >= 1 && under.alpha >= 1
                      ? `${fill.token ?? 'a literal colour'} (${name})`
                      : `${fill.token ?? 'a literal colour'} (${name}) over ${under.label}`,
                  alpha: under.alpha,
                  outside: under.outside,
                };
          const colours =
            paint !== undefined && paint.kind === 'colour'
              ? [undimmed(paint.rgba, `${paint.token ?? 'a literal colour'} (${name})`)]
              : this.colourIn(element, elementState);
          for (const colour of colours) out.push({ colour, ground });
        }
      }
    }
    return out;
  }

  /** Records that a rule was mounted, whether or not it paints anything. */
  noteReach(element: Element): void {
    this.hitsFor(element);
  }
}

/**
 * The pseudo-elements whose glyphs exist only because `content` says so.
 *
 * `::before` and `::after` are not generated at all without a `content`
 * declaration, and `content: ''` generates a box with no characters in it.
 * Every other pseudo-element in this repo's vocabulary — `::placeholder`,
 * `::marker`, `::selection`, `::first-line`, `::first-letter` — decorates text
 * the element already has.
 */
const GENERATED = new Set(['::before', '::after', ':before', ':after']);

function paintsGlyphs(pseudoElement: string, content: string | undefined): boolean {
  if (!GENERATED.has(pseudoElement)) return true;
  if (content === undefined) return false;
  const text = content.trim().toLowerCase();
  return text !== "''" && text !== '""' && text !== 'none' && text !== '';
}

function dedupe(layers: readonly Layer[]): readonly Layer[] {
  const seen = new Map<string, Layer>();
  for (const layer of layers) seen.set(`${layer.label}|${layer.alpha}`, layer);
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
 * Every rule that declares a `color` and that no fixture above **reached**.
 * These are not exemptions and none of them is safe: each one is a composition
 * this file does not measure, sitting in the tree exactly as it sat there
 * before this file existed. The difference is that it is now *written down*,
 * and that the assertion below compares the live list to this one **exactly**.
 * Add a colour rule anywhere under `src/` and this file goes red until either a
 * fixture reaches it or somebody adds the line and says why not.
 *
 * **Unreached is not the same as un-mounted, and this list does not tell them
 * apart.** A rule lands here either because no fixture mounts that component,
 * or because a fixture mounts it in a shape or a state no part of its selector
 * matched. The comment that used to sit here claimed the first — "no fixture
 * above ever mounted" — of a list that contained four rules a fixture was
 * mounting all along: `HomeSurface.module.css .fact dt`/`.fact dd` and
 * `DocumentPreview.module.css .grant dt`/`.grant dd` paint `<dt>` and `<dd>`
 * elements that `HomeSurface.tsx` and `DocumentPreview.tsx` really render, and
 * they were absent only because the matcher then required a CSS-module class on
 * the element itself. That is how a blind spot becomes accepted debt: it is
 * written down as something else. Those four are gone from this list now
 * because {@link Compound.tag} matches them, not because anything about the
 * components changed.
 *
 * A *third* cause — a selector this file cannot scope to the DOM at all — is
 * deliberately kept out of this list: it is reported by
 * `no audited rule is scoped to the DOM by something this audit cannot see`
 * instead. See {@link SelectorPart.anchored}.
 *
 * One class of composition in this list is measured anyway, without a fixture:
 * where a sheet writes the ancestry down itself — a ground on `.a`, a colour on
 * `.a .b` — `measures the ancestor-ground compositions a sheet writes down,
 * mounted or not` reads it straight out of the CSS. Four of the entries here
 * are covered that way: the three `.diagnostics li` rules and `.selected .main`.
 * Everything else in this list is unmeasured.
 *
 * **What counts as painting text widened when `opacity` did.** The census that
 * reads this list quantifies over every module rule that declares a `color`
 * *or* an `opacity` outside `@keyframes`, because a rule that dims text changes
 * what the text is painted in — see {@link Layer}. Five of the entries below
 * are dimming rules with no `color` of their own; four belong to components
 * (`MessageTurn`, `EndpointForm`) whose every colour rule is already here, and
 * the fifth, `SchedulesPanel .rowOff`, is the off-state of a row the fixture
 * mounts only in its on-state. Before that widening they were unmeasured
 * *and* unlisted, which is the worse of the two.
 *
 * The way to shrink it is a fixture, not an edit here. Measured over the module
 * sheets as this was written: 618 rules, of which 276 declare a colour, 291
 * declare a colour or a non-keyframe opacity, and 178 of those 291 are reached —
 * observed, and open in both directions: a fixture that renders one more state
 * moves every one of those numbers, and nothing here forces any bound.
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
  'src/features/canvas/DocumentPreview.module.css — .notice',
  'src/features/conversation/Composer.module.css — .iconButton',
  'src/features/conversation/Composer.module.css — .iconButton:hover',
  "src/features/conversation/Composer.module.css — .iconButton[aria-pressed='true']",
  'src/features/conversation/Composer.module.css — .stop',
  'src/features/conversation/Composer.module.css — .stop:hover',
  'src/features/conversation/EmptyConversation.module.css — .note',
  'src/features/conversation/MessageTurn.module.css — .awaiting',
  'src/features/conversation/MessageTurn.module.css — .dots span',
  'src/features/conversation/MessageTurn.module.css — .errorDetail',
  'src/features/conversation/MessageTurn.module.css — .errorTitle',
  'src/features/conversation/MessageTurn.module.css — .errorTrace',
  'src/features/conversation/MessageTurn.module.css — .footer',
  'src/features/conversation/MessageTurn.module.css — .noAnswer',
  'src/features/conversation/MessageTurn.module.css — .retry',
  'src/features/conversation/MessageTurn.module.css — .retry:hover',
  'src/features/conversation/MessageTurn.module.css — .turn:hover .footer, .turn:focus-within .footer',
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
  'src/features/models/EndpointForm.module.css — .save:disabled',
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
  'src/features/schedules/SchedulesPanel.module.css — .rowOff',
  'src/features/schedules/SchedulesPanel.module.css — .rowPrompt',
  'src/features/schedules/SchedulesPanel.module.css — .switch',
  'src/features/schedules/SchedulesPanel.module.css — .switchOn',
  'src/features/skills/SkillsPanel.module.css — .error',
  'src/features/skills/SkillsPanel.module.css — .resourceName',
  'src/features/skills/SkillsPanel.module.css — .rowDirectory',
];

/**
 * Every `(fixture, element, state)` the walk found at `opacity: 0`.
 *
 * An element at zero opacity displays nothing, so there is no composition to
 * measure — and measuring one anyway would report a ground against itself at
 * 1:1 and red three rules whose whole purpose is to be revealed by a hover or a
 * focus. But "measured nothing" is also what a matcher that stopped matching
 * produces, so the set is written down instead of skipped, exactly as
 * {@link NOT_RENDERED} is.
 *
 * Empty as measured: no text-carrying element any fixture mounts is inside a
 * group at zero opacity. The three declarations of `opacity: 0` under `src/` —
 * `MessageTurn .footer`, `ConversationRow .actions` and `Sidebar .handle::after`
 * — are reveal-on-engagement wrappers, and each has a `:hover` rule setting it
 * back to `1`, which is a state this audit measures. Written as an exact set
 * and not a floor, so the first element that *does* go quiet this way is named
 * here rather than counted as a pass. `an element at opacity 0 has no
 * composition to measure` is the unit test that proves the arm is live.
 */
const NOT_PAINTED: readonly string[] = [];

/**
 * Sub-AA compositions on a control in its `:disabled` state.
 *
 * WCAG 2.2 SC 1.4.3 exempts "text ... that is part of an inactive user interface
 * component" from the 4.5:1 minimum, and every one of these is a button dimmed
 * by `opacity` in its `:disabled` state — the four `.save:disabled` rules,
 * `ProjectPanel .secondary:disabled` and `LocalEndpointSection .primary:disabled`.
 * The exemption is an *exact set* and not a rule: a new sub-AA disabled
 * composition fails this file until somebody adds the line, which is the
 * difference between an exemption and a hole. It is
 * also the reason the dimming is modelled rather than ignored — the same
 * `opacity` on a control that is *not* disabled is a ship-blocker and is
 * reported as one.
 */
const INACTIVE: readonly string[] = [
  '2.30:1 (needs 4.5) in light — --vela-text-on-accent on --vela-accent over --vela-surface-raised at opacity 0.5 — <button> in MemoryPanel',
  '2.30:1 (needs 4.5) in light — --vela-text-on-accent on --vela-accent over --vela-surface-raised at opacity 0.5 — <button> in ProjectPanel',
  '2.30:1 (needs 4.5) in light — --vela-text-on-accent on --vela-accent over --vela-surface-raised at opacity 0.5 — <button> in SchedulesPanel',
  '3.43:1 (needs 4.5) in light — --vela-text-on-accent on --vela-accent over --vela-surface at opacity 0.7 — <button> in LocalEndpointSection — one endpoint on the loopback',
  '3.46:1 (needs 4.5) in light — --vela-text on --vela-surface-raised at opacity 0.5 — <button> in ProjectPanel',
  '4.01:1 (needs 4.5) in dark — --vela-text-on-accent on --vela-accent over --vela-surface-raised at opacity 0.5 — <button> in MemoryPanel',
  '4.01:1 (needs 4.5) in dark — --vela-text-on-accent on --vela-accent over --vela-surface-raised at opacity 0.5 — <button> in ProjectPanel',
  '4.01:1 (needs 4.5) in dark — --vela-text-on-accent on --vela-accent over --vela-surface-raised at opacity 0.5 — <button> in SchedulesPanel',
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
  /** See {@link Audit.unmodelled}. */
  readonly unmodelled: readonly string[];
  /**
   * `(fixture, element, state)` triples that paint nothing because the group
   * they are in is at `opacity: 0`. Compared against {@link NOT_PAINTED}.
   */
  readonly notPainted: readonly string[];
  /** Sub-AA compositions on a control in its `:disabled` state — see {@link INACTIVE}. */
  readonly inactive: readonly string[];
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

/**
 * Whether a state describes a control the user cannot activate.
 *
 * WCAG 2.2 SC 1.4.3 exempts "text ... that is part of an inactive user interface
 * component" from the 4.5:1 minimum, so a composition measured in a `:disabled`
 * state is routed to {@link INACTIVE} rather than to the failures.
 *
 * `:not(...)` is stripped first, and that is not pedantry. Five module sheets
 * write a `:hover:not(:disabled)` rule — `Composer .send`,
 * `CapabilitySummary .probe`, `EndpointForm .save`,
 * `LocalEndpointSection .primary` and `ModelSwitcher .option` — and
 * {@link SelectorPart.state} keeps the whole condition, so the state string for
 * one of those *contains* `:disabled` while describing a control that is
 * emphatically enabled. A plain substring test would have exempted it, which is
 * an exemption widening itself by accident.
 */
function inactiveState(state: string): boolean {
  return state.replace(/:not\([^)]*\)/gu, '').includes(':disabled');
}

function paintsText(element: Element): boolean {
  if (element.hasAttribute('hidden')) return false;
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') return true;
  return Array.from(element.childNodes).some(
    (node) => node.nodeType === node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
  );
}

async function readTheApp(theme: Theme): Promise<Reading> {
  const palette = paletteFor(theme, SHEETS);
  const prepared = prepare(MODULE_RULES, palette);
  const root = rootPaint(palette);
  const failures: string[] = [];
  const reached = new Set<string>();
  const unreadable: string[] = [];
  const unknownClasses = new Set<string>();
  const walk: Walked[] = [];
  const blank: string[] = [];
  const unmodelled: string[] = [];
  const notPainted: string[] = [];
  const inactive: string[] = [];
  let measured = 0;
  let sample: Reading['sample'] = null;

  for (const fixture of FIXTURES) {
    const beneath: readonly Layer[] =
      fixture.beneath === undefined
        ? [undimmed(root.ground.rgba, root.ground.token ?? 'base.css body')]
        : fixture.beneath.map((token) => {
            const paint = readPaint(`var(${token})`, (name) => palette.get(name));
            if (paint.kind !== 'colour') throw new Error(`${fixture.name}: ${token} is not a colour`);
            return undimmed(paint.rgba, token);
          });
    const rootColour: readonly Layer[] = [
      undimmed(root.colour.rgba, root.colour.token ?? 'base.css body'),
    ];

    mounting = fixture.name;
    await fixture.mount();
    const audit = new Audit(prepared, beneath, rootColour);
    audit.where = fixture.name;
    let elements = 0;
    let states = 0;
    for (const element of Array.from(document.body.querySelectorAll('*'))) {
      audit.noteReach(element);
      if (!paintsText(element)) continue;
      elements += 1;
      const pairs: { colour: Layer; ground: Layer; state: string }[] = [];
      for (const state of audit.statesOn(element)) {
        states += 1;
        const before = pairs.length;
        let invisible = false;
        for (const ground of audit.groundIn(element, state)) {
          // AN ELEMENT AT `opacity: 0` DISPLAYS NOTHING.
          //
          // There is no composition to measure, and measuring one anyway would
          // report the ground against itself at 1:1 — a red on three rules that
          // exist precisely so a hover or focus state can reveal them. It is
          // recorded by name instead of skipped: see {@link NOT_PAINTED}.
          if (ground.alpha <= 0) {
            invisible = true;
            notPainted.push(
              `${fixture.name} — <${element.tagName.toLowerCase()}>` +
                `${state === '' ? '' : ` in state \`${state}\``} is at opacity 0`,
            );
            continue;
          }
          for (const colour of audit.colourIn(element, state)) pairs.push({ colour, ground, state });
        }
        // A `::placeholder`, `::marker` or `::after` paints its own colour — or
        // the one it inherits — on its own ground.
        for (const pair of audit.pseudoPairs(element, state)) {
          if (pair.ground.alpha > 0) pairs.push({ ...pair, state });
        }
        // THE TOTALITY FLOOR. An element the walk reached but measured nothing
        // on is not a pass — it is an absence wearing a pass's clothes. The way
        // this whole file goes quietly vacuous is a colour chain that resolves
        // to nothing: `coloursFor` bottoms out at `rootColour`, and every
        // element that *inherits* its colour then yields zero pairs,
        // contributes zero `failures`, and reads as green. `rootPaint` refuses
        // to hand back a `base.css body` that stopped resolving, so that is one
        // route closed at the source; this catches the rest, wherever a chain
        // comes back empty.
        if (pairs.length === before && !invisible) {
          blank.push(
            `${fixture.name} — <${element.tagName.toLowerCase()}>` +
              `${state === '' ? '' : ` in state \`${state}\``} measured nothing`,
          );
        }
      }
      for (const { colour, ground, state } of pairs) {
        measured += 1;
        const ratio = contrastRatio(paintedOn(colour.rgba, ground), ground.rgba);
        if (sample === null && colour.label === '--vela-text-muted') {
          sample = { ratio, ground: ground.label, colour: colour.label };
        }
        if (ratio + 0.005 < THRESHOLD) {
          const line =
            `${ratio.toFixed(2)}:1 (needs ${THRESHOLD.toFixed(1)}) in ${theme} — ` +
            `${colour.label} on ${ground.label} — <${element.tagName.toLowerCase()}> in ${fixture.name}`;
          // See {@link inactiveState}: WCAG exempts an inactive control, and
          // the exemption is routed to a list rather than dropped.
          if (inactiveState(state)) inactive.push(line);
          else failures.push(line);
        }
      }
    }
    walk.push({ fixture: fixture.name, elements, states });
    for (const name of audit.reached) reached.add(name);
    unreadable.push(...audit.unreadable);
    unmodelled.push(...audit.unmodelled);
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
    unmodelled: [...new Set(unmodelled)].sort(),
    notPainted: [...new Set(notPainted)].sort(),
    inactive: [...new Set(inactive)].sort(),
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
      //    `rootColour` deletes every *inherited* colour in the app, and the
      //    old floor stayed green because the minority of elements that declare
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
      // The two lists the group-opacity model is allowed to hand back instead
      // of a ratio, both exact sets rather than floors.
      expect(light.unmodelled, 'a composition this audit declined to compute').toEqual([]);
      expect(dark.unmodelled, 'a composition this audit declined to compute').toEqual([]);
      expect(light.notPainted, 'an element at opacity 0').toEqual(NOT_PAINTED);
      expect(dark.notPainted, 'an element at opacity 0').toEqual(NOT_PAINTED);
      expect(
        [...light.inactive, ...dark.inactive].sort(),
        'a sub-AA composition on a disabled control — see INACTIVE',
      ).toEqual([...INACTIVE].sort());

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
    // A rule that DIMS text paints text. `opacity` is modelled now, and a
    // dimming rule no fixture reaches is unmeasured in exactly the way a
    // colour rule no fixture reaches is — so the census quantifies over both,
    // and the debt is enumerated in NOT_RENDERED rather than being invisible
    // because the rule happens to declare no `color`. Keyframe stops are not
    // selectors and no cascade reaches them; they are accounted for in
    // UNMODELLED_PAINT instead.
    const painting = [
      ...new Set(
        MODULE_RULES.filter(
          (rule) =>
            declaredValue(rule, 'color') !== undefined ||
            (declaredValue(rule, 'opacity') !== undefined && !IN_KEYFRAMES(rule)),
        ).map((rule) => `${rule.file} — ${rule.selector}`),
      ),
    ];
    const unreached = painting.filter((name) => !light.reached.has(name)).sort();
    expect(
      unreached,
      'reach it with a fixture. Add a line to NOT_RENDERED only when no fixture can mount it — ' +
        'never to answer a reading that timed out, and never because a rule you can see on screen ' +
        'was not matched: that is a hole in the matcher, and it belongs in ' +
        '`no audited rule is scoped to the DOM by something this audit cannot see`',
    ).toEqual(NOT_RENDERED);
    expect(
      painting.length - unreached.length,
      'the fixtures have stopped reaching rules',
    ).toBeGreaterThan(120);
  }, READING_BUDGET_MS);

  it('measures the ancestor-ground compositions a sheet writes down, mounted or not', () => {
    // THE SLIVER OF THE DOM EDGE THAT CSS TEXT ALONE CAN PROVE.
    //
    // Everything else in this file needs a fixture, so the 108 rules in
    // NOT_RENDERED are unmeasured: a ground on `.a` and a colour on `.a .b`, in
    // a component nothing mounts, is invisible here and invisible to
    // contrast.test.ts (which can only read a composition a *single* rule
    // states). But when the descendant selector is written as a descendant of
    // the grounding selector, the two rules state the ancestry between them —
    // no DOM required — and that is measurable without mounting anything.
    //
    // It is a sliver and not the edge: `SkillsPanel`'s worked example —
    // `.detail` grounds and `.body` paints, with the nesting living in the TSX
    // — is exactly the shape this cannot see, which is why the fixtures exist.
    // What it adds is the whole of the un-mounted debt for the nested case,
    // including the three `.diagnostics li` rules that no fixture reaches.
    const failures: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      const prepared = prepare(MODULE_RULES, paletteFor(theme, SHEETS));
      for (const ground of prepared) {
        const paint = ground.ground?.value;
        if (paint === undefined || paint.kind !== 'colour' || paint.rgba.a < 1) continue;
        for (const outer of ground.parts) {
          // Only a plain, unconditional class ground: a `:hover` or
          // `[data-…]` ground is a state, and pairing it with a descendant's
          // base colour would manufacture a composition nothing paints.
          if (outer.conditional || outer.ancestors.length > 0) continue;
          if (outer.subject.classes.length === 0 || outer.pseudoElement !== null) continue;
          for (const text of prepared) {
            if (text.rule.file !== ground.rule.file) continue;
            const colour = text.foreground?.value;
            if (colour === undefined || colour.kind !== 'colour') continue;
            // A descendant that grounds itself stands on its own ground, and
            // contrast.test.ts already measures a rule that declares both.
            const own = text.ground?.value;
            if (own !== undefined && own.kind === 'colour' && own.rgba.a >= 1) continue;
            for (const inner of text.parts) {
              const nested = inner.ancestors.some((one) =>
                outer.subject.classes.every((name) => one.classes.includes(name)),
              );
              if (!nested) continue;
              const ratio = contrastRatio(composite(colour.rgba, paint.rgba), paint.rgba);
              if (ratio + 0.005 >= THRESHOLD) continue;
              failures.push(
                `${ratio.toFixed(2)}:1 (needs ${THRESHOLD.toFixed(1)}) in ${theme} — ` +
                  `${colour.token ?? 'a literal colour'} on ${paint.token ?? 'a literal colour'} — ` +
                  `${text.rule.file} \`${ground.rule.selector}\` grounds \`${text.rule.selector}\``,
              );
            }
          }
        }
      }
    }
    expect([...new Set(failures)].sort(), 'a sheet states this ancestry itself').toEqual([]);
  });

  it('no audited rule is scoped to the DOM by something this audit cannot see', () => {
    // THE THIRD ANSWER, ON THE SELECTOR SIDE.
    //
    // `css-model.ts` gave the *value* reader a third answer — `unreadable`,
    // rather than "no ground here" — because every escape it was written for
    // was a reader saying nothing for something it could not parse. The matcher
    // had the identical collapse one level up and it was live: a part naming no
    // CSS-module class returns no match, and no match is what a rule no fixture
    // mounted also returns. The rule then lands in NOT_RENDERED, where the next
    // reader is told it is un-rendered debt.
    //
    // This is the arm that keeps those apart. It is empty today; if a module
    // sheet ever paints through `*`, `#root` or a bare element type, that shows
    // up here by name instead of in NOT_RENDERED as a lie.
    expect(
      unanchoredParts(MODULE_RULES),
      'scope it with a module class, or this audit cannot tell what it paints from what it never mounted',
    ).toEqual([]);
  });

  it('no audited rule paints through a property this audit does not model', () => {
    // THE THIRD ANSWER, ON THE PROPERTY SIDE.
    //
    // `css-model.ts` gave the *value* reader a third answer and
    // `no audited rule is scoped to the DOM by something this audit cannot see`
    // gave the *selector* matcher one. Both of them presuppose that the paint
    // arrives as a value of a property this file reads, and for two rounds that
    // was three names. A `-webkit-text-fill-color` overrides `color` for glyph
    // fill in the WebView2 this app ships in; an `opacity` beside a `color`
    // composites the glyphs the same way an `rgba()` value would, which
    // `composite()` models when it is spelled inside the value and could not
    // see when it was spelled as a property; a `filter` or a `mix-blend-mode`
    // rewrites the pixel after both values are chosen. None of them produced a
    // value the reader was handed, so none of them could be called unreadable.
    //
    // See MOVES_PAINT for the list and UNMODELLED_PAINT for the exemptions.
    expect(
      paintMovers(SHEETS),
      'model this property, or name in UNMODELLED_PAINT why this declaration cannot hide a composition',
    ).toEqual([...UNMODELLED_PAINT.keys()].sort());
    expect(
      [...UNMODELLED_PAINT].filter(([, why]) => why.trim() === '').map(([key]) => key),
      'say why this declaration is out of reach, or it is exempt rather than accounted for',
    ).toEqual([]);
  });

  it('no stylesheet outside the token sheet declares a custom property', () => {
    // THE ANCESTOR THAT RE-POINTS A ROLE.
    //
    // See customPropertiesOutsideTheTokenSheet. One line in a rule that declares
    // no paint — `.detail { --vela-code-bg: var(--vela-bg); }` — moves what
    // every `background: var(--vela-code-bg)` underneath it resolves to, and
    // `lookupFor` answers with the palette's value at full confidence because a
    // custom property declared on an *ancestor* is not merely unresolved here,
    // it is invisible.
    expect(
      customPropertiesOutsideTheTokenSheet(SHEETS),
      'declare it in tokens.css, or this audit resolves every var() below it to the wrong value',
    ).toEqual([]);
  });

  it('no global stylesheet paints outside what is already measured', () => {
    // See GLOBAL_PAINT. This file's universe is the module sheets; the reason
    // that is not a hole is that the global sheets are small, enumerated, and
    // each entry names the guard that reads it.
    const painting = SHEETS.flatMap((sheet) =>
      sheet.name.endsWith('.module.css')
        ? []
        : sheet.rules
            .filter(
              (rule) =>
                declaredValue(rule, 'color') !== undefined ||
                declaredValue(rule, 'background', 'background-color') !== undefined,
            )
            .map((rule) => `${rule.file} — ${rule.selector}`),
    );
    expect(
      [...new Set(painting)].sort(),
      'move it into a CSS Module where this file can attribute it, or name what measures it in GLOBAL_PAINT',
    ).toEqual([...GLOBAL_PAINT.keys()].sort());
    // An entry with no reader named is an exemption, not an accounting.
    expect(
      [...GLOBAL_PAINT].filter(([, reader]) => reader.trim() === '').map(([rule]) => rule),
      'say what reads this rule, or it is exempt rather than measured',
    ).toEqual([]);
  });

  it('the class-name map is intact', async () => {
    // If Vitest's class-name spelling changes, `localClass` stops recognising
    // the hashed name, `classesByFile` comes back empty for every element, and
    // `compoundMatches` then answers false for every compound that names a
    // class. Every element resolves to the root colour on the root ground and
    // the two assertions above pass while measuring nothing real. (`unknownClasses`
    // would also fill up, and is asserted empty below — but only for classes the
    // DOM still carries, so it is a second net and not the same one.)
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

/* -------------------------------------------------------------------------- */
/* the matcher itself                                                          */
/* -------------------------------------------------------------------------- */

/**
 * THE SHAPES THAT GOT PAST THIS FILE, AS INPUTS.
 *
 * Every assertion in the describe above is of the form "the set of findings is
 * empty" over the real stylesheets, and that is precisely the shape that goes
 * quiet when the matcher stops matching: a composition it cannot see produces
 * no finding, which is what a composition that is fine also produces. Asserting
 * on `src/` can only ever say "nothing is wrong today". These say "the matcher
 * still matches", by handing it a tree and a sheet whose right answer is known,
 * non-empty, and — for the first one — below AA.
 *
 * The first case is not hypothetical. It is the evasion that was walked through
 * this file while it was being graded: two tokens already in `tokens.css`, no
 * colour value introduced, an unclassed `<dt>` that `HomeSurface.tsx` really
 * renders inside `<div className={styles.fact}>`, and both guards green.
 */
describe('the matcher is not fooled by the shapes that fooled it', () => {
  const FILE = 'src/features/navigation/HomeSurface.module.css';
  const PALETTE = paletteFor('light', SHEETS);

  /** The class name the renderer emits for `styles.<name>` in {@link FILE}. */
  const hashed = (name: string): string => MODULES[`/${FILE}`]?.default[name] ?? '';

  const layer = (token: string): Layer => {
    const paint = readPaint(`var(${token})`, (name) => PALETTE.get(name));
    if (paint.kind !== 'colour') throw new Error(`${token} is not a colour`);
    return undimmed(paint.rgba, token);
  };

  /**
   * A `<div class={styles.fact}>` with one child of the given type, inside an
   * unclassed wrapper — the shape a component really mounts in, and the reason
   * a selector with an ancestor above `.fact` has something to match.
   */
  function tree(childTag: string, childClass?: string): Element {
    const outer = document.createElement('div');
    const parent = document.createElement('div');
    parent.className = hashed('fact');
    const child = document.createElement(childTag);
    if (childClass !== undefined) child.className = hashed(childClass);
    parent.appendChild(child);
    outer.appendChild(parent);
    return child;
  }

  function auditOf(css: string): Audit {
    return new Audit(prepare(parseStylesheet(FILE, css), PALETTE), [layer('--vela-bg')], [
      layer('--vela-text'),
    ]);
  }

  it('measures a ground and a colour that meet only on an unclassed element', () => {
    // THE EVASION, DEAD. `.fact` grounds the box, `.fact dt` paints the text,
    // and the `<dt>` between them carries no class at all — so the matcher that
    // required one answered "no rule reaches this element" and the composition
    // was measured nowhere.
    const dt = tree('dt');
    const audit = auditOf(
      `.fact { background: var(--vela-accent-quiet); } .fact dt { color: var(--vela-code-text); }`,
    );
    const ground = audit.groundIn(dt, '');
    const colour = audit.colourIn(dt, '');
    expect(ground.map((one) => one.label)).toEqual(['--vela-accent-quiet']);
    expect(colour.map((one) => one.label)).toEqual(['--vela-code-text']);
    const [only] = ground;
    const [text] = colour;
    if (only === undefined || text === undefined) throw new Error('nothing to measure');
    // The number is asserted rather than written in a comment: this is the
    // ship-blocker ratio the whole track exists for, and if it ever stops being
    // one this test should say so rather than a sentence beside it.
    expect(contrastRatio(composite(text.rgba, only.rgba), only.rgba)).toBeCloseTo(1.19, 2);
  });

  it('does not match an element type the rule did not name', () => {
    // The other half of reading the element type, and the direction the old
    // matcher was wrong in: with the class requirement satisfied by *any* class
    // from the sheet, `.fact dt` reached a classed `<dd>` as readily as a `<dt>`,
    // because an empty list of subject classes is satisfied by everything.
    const dd = tree('dd', 'fact');
    const audit = auditOf(`.fact dt { color: var(--vela-code-text); }`);
    expect(audit.colourIn(dd, '').map((one) => one.label)).toEqual(['--vela-text']);
  });

  it('never lets a rule under an at-rule displace the one that paints on screen', () => {
    // `@media print` is later in source order and identical in specificity, so a
    // cascade that ignored the condition would report the print colour — a
    // paint the engine never uses — and the one on screen would go unmeasured.
    const dd = tree('dd');
    const audit = auditOf(
      `.fact dd { color: var(--vela-danger); }` +
        ` @media print { .fact dd { color: var(--vela-text); } }`,
    );
    expect(audit.colourIn(dd, '').map((one) => one.label)).toEqual(['--vela-danger']);
    // and it is measured as a state of its own rather than dropped.
    expect(audit.coloursFor(dd).map((one) => one.label).sort()).toEqual([
      '--vela-danger',
      '--vela-text',
    ]);
  });

  it('never lets an id it cannot evaluate win the cascade', () => {
    // CSS Modules hash class names and leave ids alone, so an id in a module
    // sheet is a global selector this file cannot resolve against a fixture —
    // and it outranks every class in the file. Treating it as a state rather
    // than as a competitor is the same move the at-rule above gets, and the
    // same one `[data-…]` and `:hover` have always had.
    const dd = tree('dd');
    const audit = auditOf(
      `#nowhere .fact dd { color: var(--vela-text); } .fact dd { color: var(--vela-danger); }`,
    );
    expect(audit.colourIn(dd, '').map((one) => one.label)).toEqual(['--vela-danger']);
    expect(audit.coloursFor(dd).map((one) => one.label).sort()).toEqual([
      '--vela-danger',
      '--vela-text',
    ]);
  });

  it('reports a selector it cannot scope instead of matching nothing', () => {
    // A bare element selector in a module sheet is not a rule that paints
    // nothing — it is a rule this file cannot attribute to any element, and the
    // two answers were the same answer.
    const found = unanchoredParts(parseStylesheet(FILE, `li { color: var(--vela-danger); }`));
    expect(found).toEqual([`${FILE} — li — \`li\` names no CSS-module class`]);
    expect(unanchoredParts(parseStylesheet(FILE, `.fact li { color: var(--vela-danger); }`))).toEqual(
      [],
    );
  });

  it('never lets specificity outrank an !important the engine obeys', () => {
    // `!important` beats every normal author declaration whatever its
    // specificity. `css-model.ts` used to drop the word in `toDeclaration`, so
    // the cascade here ordered on specificity alone and answered with the
    // *loser*: the composition it then reported was one the engine does not
    // paint, which is worse than reporting nothing. The important rule is
    // written first so that source order cannot be what saves it.
    const dd = tree('dd', 'fact');
    const audit = auditOf(
      `.fact { color: var(--vela-danger) !important; } .fact .fact { color: var(--vela-code-text); }`,
    );
    expect(audit.colourIn(dd, '').map((one) => one.label)).toEqual(['--vela-danger']);
    // and with the word removed, specificity decides — so the test above is
    // measuring importance and not something else about these two selectors.
    const plain = auditOf(
      `.fact { color: var(--vela-danger); } .fact .fact { color: var(--vela-code-text); }`,
    );
    expect(plain.colourIn(tree('dd', 'fact'), '').map((one) => one.label)).toEqual([
      '--vela-code-text',
    ]);
  });

  it('dims the text when the translucency is spelled as a property', () => {
    // `composite()` has always modelled translucency spelled *inside* a colour
    // value — an `rgba()` ground over what is behind it. The identical operation
    // spelled as `opacity` beside the colour was invisible, because no value
    // ever reached the reader: `declaredValue(rule, 'color')` returns the opaque
    // token and `opacity` was not a property either guard had heard of. One word
    // added to a rule that already passes takes a 4.5-clearing pair below the
    // bar, with every token it names still measuring fine on its own.
    const dt = tree('dt');
    const audit = auditOf(
      `.fact { background: var(--vela-surface-raised); }` +
        ` .fact dt { color: var(--vela-text-muted); opacity: 0.6; }`,
    );
    const [ground] = audit.groundIn(dt, '');
    const [colour] = audit.colourIn(dt, '');
    if (ground === undefined || colour === undefined) throw new Error('nothing to measure');
    expect(ground.alpha).toBe(0.6);
    expect(ground.label).toBe('--vela-surface-raised at opacity 0.6');
    // What the engine paints, and what reading the two declarations alone says.
    expect(contrastRatio(paintedOn(colour.rgba, ground), ground.rgba)).toBeCloseTo(2.82, 2);
    expect(contrastRatio(composite(colour.rgba, ground.rgba), ground.rgba)).toBeCloseTo(7.23, 2);
  });

  it('an element at opacity 0 has no composition to measure', () => {
    // The arm {@link NOT_PAINTED} accounts for. Measuring this one anyway would
    // report the ground against itself at 1:1 and red every reveal-on-hover
    // wrapper in the app.
    const dt = tree('dt');
    const audit = auditOf(
      `.fact { background: var(--vela-surface-raised); } .fact dt { opacity: 0; }`,
    );
    expect(audit.groundIn(dt, '').map((one) => one.alpha)).toEqual([0]);
  });

  it('measures a pseudo-element against the ground the pseudo-element declares', () => {
    // The reader this replaced — `pseudoColours`, deleted in this change and
    // present in the tree round 2 was graded on — was added so a
    // pseudo-element's *colour* would stop being invisible, and it measured that
    // colour against the **element's** ground. A `::after` that declares a
    // ground and no colour was then read by nobody: `groundIn` refuses a
    // pseudo's fill (correctly — it is not the element's ground) and the pseudo
    // reader returned early on a rule with no `color`. Both halves are in the
    // sheet: the pseudo inherits the `<h3>`'s text colour and paints it on its
    // own fill.
    const h3 = tree('h3');
    const audit = auditOf(
      `.fact { background: var(--vela-surface-raised); }` +
        ` .fact h3::after { content: ' preview'; background: var(--vela-text-subtle); }`,
    );
    const pairs = audit.pseudoPairs(h3, '');
    expect(pairs.map((pair) => `${pair.colour.label} on ${pair.ground.label}`)).toEqual([
      '--vela-text on --vela-text-subtle (::after)',
    ]);
    const [pair] = pairs;
    if (pair === undefined) throw new Error('nothing to measure');
    expect(contrastRatio(paintedOn(pair.colour.rgba, pair.ground), pair.ground.rgba)).toBeCloseTo(
      3.05,
      2,
    );
    // A `::after` with no characters in it is a rail or a caret, and pairing the
    // inherited text colour with its fill would be a composition nothing paints.
    const empty = auditOf(
      `.fact { background: var(--vela-surface-raised); }` +
        ` .fact h3::after { content: ''; background: var(--vela-accent); }`,
    );
    expect(empty.pseudoPairs(tree('h3'), '')).toEqual([]);
  });

  it('reports a paint declared in a property it does not model', () => {
    // THE THIRD ANSWER AT THE PROPERTY LEVEL, as an input rather than as
    // "nothing is wrong today". `-webkit-text-fill-color` overrides `color` for
    // glyph fill in a Chromium WebView, and it produced no value at all for the
    // reader to call unreadable.
    const sheet = (css: string): Sheet => ({
      name: FILE,
      text: css,
      rules: parseStylesheet(FILE, css),
    });
    expect(
      paintMovers([
        sheet(
          `.body { color: var(--vela-code-text); -webkit-text-fill-color: var(--vela-danger); }`,
        ),
      ]),
    ).toEqual([`${FILE} — .body — -webkit-text-fill-color`]);
    // `opacity` is the one that is modelled instead of reported — but only where
    // the cascade can reach it. Inside `@keyframes` the value is a function of
    // time and this audit reads a still frame.
    expect(paintMovers([sheet(`.body { opacity: 0.6; }`)])).toEqual([]);
    expect(paintMovers([sheet(`@keyframes fade { 50% { opacity: 0.6; } }`)])).toEqual([
      `${FILE} — @keyframes fade — 50% — opacity`,
    ]);
  });

  it('does not read `:not(:disabled)` as a disabled control', () => {
    // The WCAG exemption in {@link inactiveState} is the one place this file
    // deliberately declines to fail on a sub-AA number, so its predicate is the
    // one place an exemption could widen itself by accident.
    expect(inactiveState(':disabled')).toBe(true);
    expect(inactiveState("[data-outcome='copied']:disabled")).toBe(true);
    expect(inactiveState(':hover:not(:disabled)')).toBe(false);
    expect(inactiveState(':hover')).toBe(false);
    expect(inactiveState('')).toBe(false);
  });

  it('reports a custom property declared where an ancestor could re-point a role', () => {
    // `lookupFor` reads the declaring rule's own custom properties and the
    // `:root` palette, and nothing between. A `--vela-*` name re-pointed by an
    // ancestor is therefore not unresolved — it is invisible, and the palette's
    // value is returned with full confidence for a `var()` the engine resolves
    // to something else.
    const sheet = (css: string): Sheet => ({
      name: FILE,
      text: css,
      rules: parseStylesheet(FILE, css),
    });
    expect(
      customPropertiesOutsideTheTokenSheet([sheet(`.detail { --vela-code-bg: var(--vela-bg); }`)]),
    ).toEqual([`${FILE} — .detail — --vela-code-bg`]);
    // A *new* local name is a different shape and was closed a round ago: the
    // rule that declares it can see it, and a rule below cannot, which
    // `readPaint` reports as unreadable rather than as absent.
    expect(customPropertiesOutsideTheTokenSheet([sheet(`.detail { color: var(--vela-text); }`)])).toEqual(
      [],
    );
  });
});
