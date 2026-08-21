/**
 * THE CONTRAST AUDIT — every colour role, in both themes, against the ground it
 * is actually painted on.
 *
 * ## Why this file exists
 *
 * `--vela-text-subtle` shipped at `#6f7896` in *both* themes: it was the one
 * colour role never re-authored for dark. Measured on the operator's Windows 11
 * machine it was **4.16:1 in light and 4.43:1 in dark — under AA in both** — and
 * it is the composer's placeholder, which is the first text a new user reads.
 *
 * It was found by inspection. That is the problem this file solves: an audit
 * that finds one role by eye is not an audit, because the roles it did not look
 * at are exactly the ones nobody looked at. Reading the sheet again would have
 * found the same one role. So the check is mechanical, it covers every pair the
 * components actually paint, and — see `every colour role is audited` below —
 * **a colour role that is not in the table fails the suite**.
 *
 * ## The half of that claim that was false
 *
 * This header used to end the paragraph above with "there is no way to add a
 * colour to this app and not audit it". It was false in a way that shipped a
 * defect. The completeness checks quantify over the *vocabulary* —
 * `new Set(PAIRS.map(p => p.fg))` and `new Set(PAIRS.flatMap(p => p.on))` — so an
 * audited foreground on an audited background was never measured **as a pair**.
 * `CanvasPanel`'s diff rows re-grounded `--vela-code-text` (audited, on
 * `--vela-code-bg`) onto `--vela-accent-quiet` and `--vela-danger-bg` (both known
 * grounds, both light in the light theme), and the composition read 1.19:1 and
 * 1.14:1 there. Every ingredient passed and the dish was never tasted.
 *
 * `every rule that paints text on a ground it declares itself is a pair in the
 * table` closes that for every composition a single CSS rule states — the part
 * CSS text can actually prove. What it still cannot reach is a composition
 * assembled across the DOM; the comment on that test says what closing *that*
 * would take, and why it is not this commit.
 *
 * ## What it found on the first run, besides the briefed one
 *
 * - `EndpointForm .save` and `DeleteConversationDialog .confirm` painted
 *   `--vela-night-0` (white) on `--vela-accent` / `--vela-danger`. In dark those
 *   fills are *light* — `#5fe2d6`, `#f2668b` — so the label sat at **1.57:1**
 *   and **2.98:1**. (This line said ~1.4:1 and ~2.5:1 until both were
 *   recomputed from the token sheet; neither token has changed since the first
 *   commit, so those figures were never right. `docs/corrections.md`.)
 *   `--vela-text-on-accent` already existed for exactly this and both files
 *   bypassed it.
 * - `--vela-warning` (amber-600) at 3.20–3.33:1 in light, including warning text
 *   on the warning fill it is paired with.
 * - `--vela-success` at 3.16–3.60:1 and `--vela-danger` at 4.45:1 in light.
 * - `--vela-accent` as *text* (links, the switcher's footer actions) at
 *   3.94–4.49:1 in light.
 * - `--vela-syntax-comment` at 3.74–4.18:1 on the code surface in dark.
 * - `--vela-focus` at 2.59:1 in light — a focus ring under the 3:1 that makes it
 *   a ring rather than a suggestion.
 *
 * ## Method, and its limits
 *
 * The token graph is resolved to sRGB the way the engine resolves it — light
 * declarations first, then the dark block on top — translucent fills are
 * composited over the stack they sit on, and WCAG 2.x relative luminance gives
 * the ratio. That makes every number here a fact about the stylesheet, true in
 * any engine, which is what lets it stand as a gate while the binding visual
 * verdict remains the desktop session's.
 *
 * What it cannot see: what is *actually* stacked on screen. The `on:` chain of
 * each pair is read off the components by a human and is the one hand-made part
 * of this file. A wrong chain is a wrong audit — so each pair carries the file
 * and rule it was read from.
 *
 * Thresholds are WCAG 2.2 AA: 4.5:1 for text (nothing in this UI is "large" —
 * the one 24px step is `--vela-text`, which clears AAA everywhere), 3:1 for
 * non-text things that carry meaning: the focus ring, status dots, the meter's
 * fill against its track.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const TOKENS = readFileSync(join(SRC_ROOT, 'styles', 'tokens.css'), 'utf8');

/* -------------------------------------------------------------------------- */
/* resolving the token graph                                                   */
/* -------------------------------------------------------------------------- */

function declaredIn(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of block.matchAll(/^\s*(--vela-[a-z0-9-]+):\s*([^;]+);/gm)) {
    out.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return out;
}

function blocks(): { light: string; dark: string } {
  const media = TOKENS.indexOf('@media (prefers-color-scheme: dark)');
  const explicit = TOKENS.indexOf(":root[data-theme='dark']");
  expect(media, 'the token sheet was restructured; fix this slice').toBeGreaterThan(0);
  expect(explicit).toBeGreaterThan(media);
  return { light: TOKENS.slice(0, media), dark: TOKENS.slice(explicit) };
}

type Theme = 'light' | 'dark';

function paletteFor(theme: Theme): Map<string, string> {
  const { light, dark } = blocks();
  const palette = declaredIn(light);
  if (theme === 'dark') for (const [name, value] of declaredIn(dark)) palette.set(name, value);
  return palette;
}

function substitute(value: string, palette: Map<string, string>): string {
  let out = value;
  for (let pass = 0; pass < 12 && out.includes('var('); pass += 1) {
    out = out.replace(/var\((--vela-[a-z0-9-]+)\)/gu, (whole, name: string) => palette.get(name) ?? whole);
  }
  return out.trim();
}

/* -------------------------------------------------------------------------- */
/* colour                                                                      */
/* -------------------------------------------------------------------------- */

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Every colour syntax this sheet uses: `#rrggbb` and `rgb(r g b / a%)`. */
function parseColour(css: string): Rgba {
  const text = css.trim();
  const hex = /^#([0-9a-f]{6})$/iu.exec(text);
  if (hex !== null) {
    const digits = hex[1] ?? '';
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+)(%?)\s*)?\)$/iu.exec(text);
  if (rgb !== null) {
    const raw = rgb[4] === undefined ? 1 : Number.parseFloat(rgb[4]);
    return {
      r: Number.parseFloat(rgb[1] ?? '0'),
      g: Number.parseFloat(rgb[2] ?? '0'),
      b: Number.parseFloat(rgb[3] ?? '0'),
      a: rgb[5] === '%' ? raw / 100 : raw,
    };
  }
  throw new Error(`not a colour this audit can read: ${css}`);
}

/** Source-over compositing, which is what a translucent fill does to its ground. */
function composite(top: Rgba, under: Rgba): Rgba {
  if (top.a >= 1) return top;
  const mix = (x: number, y: number): number => x * top.a + y * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

/** WCAG 2.x relative luminance. */
function luminance({ r, g, b }: Rgba): number {
  const channel = (value: number): number => {
    const x = value / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

/**
 * The colour a token resolves to, or `null` when the sheet does not define it.
 * Null rather than a throw because an undefined token is a *finding* — CSS drops
 * an unresolvable declaration silently, so it must be reported by name, not hide
 * behind a stack trace.
 */
function resolve(token: string, palette: Map<string, string>): Rgba | null {
  const value = substitute(`var(${token})`, palette);
  if (value.includes('var(')) return null;
  return parseColour(value);
}

/**
 * The colour a `on:` chain actually resolves to. The chain is written
 * nearest-first, so `['--vela-row-selected', '--vela-chrome']` is a selected row
 * in the sidebar; each translucent layer is composited onto what is under it.
 */
function groundColour(chain: readonly string[], palette: Map<string, string>): Rgba | null {
  let colour = resolve(chain[chain.length - 1] ?? '', palette);
  if (colour === null) return null;
  expect(colour.a, `the bottom of a ground chain must be opaque: ${chain.join(' over ')}`).toBe(1);
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    const layer = resolve(chain[index] ?? '', palette);
    if (layer === null) return null;
    colour = composite(layer, colour);
  }
  return colour;
}

/* -------------------------------------------------------------------------- */
/* the table                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `text` is body text at any size this app uses — 4.5:1.
 * `ui`   is a non-text thing that carries meaning — 3:1 (WCAG 1.4.11).
 */
type Kind = 'text' | 'ui';

/**
 * The rule a pair claims to describe, named exactly enough to be checked.
 *
 * `where` is prose for a human; this is the same claim made to the machine. When
 * a rule states a whole composition itself — it declares both the `color` and
 * the `background` — the pair may bind to it, and `a pair that names a rule is
 * checked against that rule` then asserts the stylesheet still says what the
 * table says it says. Without that binding the table is a description of the
 * CSS, and a description does not fail when the CSS changes underneath it.
 */
interface RuleRef {
  /** Repo-relative, forward slashes. */
  readonly file: string;
  /** The selector exactly as it is written, whitespace collapsed. */
  readonly selector: string;
}

interface Pair {
  readonly fg: string;
  /** Nearest ground first, ending in an opaque one. */
  readonly on: readonly string[];
  readonly kind: Kind;
  /** The file and rule this was read from, so a wrong chain is traceable. */
  readonly where: string;
  readonly rule?: RuleRef | undefined;
}

const T = (fg: string, on: readonly string[], where: string, rule?: RuleRef): Pair => ({
  fg,
  on,
  kind: 'text',
  where,
  rule,
});
const U = (fg: string, on: readonly string[], where: string, rule?: RuleRef): Pair => ({
  fg,
  on,
  kind: 'ui',
  where,
  rule,
});

const CANVAS_PANEL = 'src/features/canvas/CanvasPanel.module.css';
const REMOVE_ENDPOINT_DIALOG = 'src/features/models/RemoveEndpointDialog.module.css';

const BG = ['--vela-bg'] as const;
const SURFACE = ['--vela-surface'] as const;
const RAISED = ['--vela-surface-raised'] as const;
const CHROME = ['--vela-chrome'] as const;
const INSET = ['--vela-bg-inset'] as const;

const PAIRS: readonly Pair[] = [
  /* ---- shell ------------------------------------------------------------- */
  T('--vela-text-subtle', CHROME, 'AppShell .statusBar'),
  U('--vela-text-subtle', CHROME, 'AppShell .dot — the idle status dot'),
  U('--vela-success', CHROME, 'AppShell .dotOk'),
  U('--vela-warning', CHROME, 'AppShell .dotWarn'),
  T('--vela-text', CHROME, 'TitleBar .wordmark'),
  T('--vela-text-subtle', CHROME, 'TitleBar .context'),
  U('--vela-accent', ['--vela-accent-quiet'], 'TitleBar .mark — the Vela glyph'),
  T('--vela-text-muted', SURFACE, 'TitleBar .action'),
  T('--vela-text', SURFACE, 'TitleBar .action:hover'),
  U('--vela-text-muted', CHROME, 'TitleBar .captionButton — the minimise/maximise/close glyphs'),
  U('--vela-text', ['--vela-row-hover', '--vela-chrome'], 'TitleBar .captionButton:hover'),
  U('--vela-text-on-danger', ['--vela-danger'], 'TitleBar .closeButton:hover'),

  /* ---- attachments ------------------------------------------------------- */
  T('--vela-text-muted', SURFACE, 'AttachmentControls .button'),
  T('--vela-text', ['--vela-row-hover', '--vela-surface'], 'AttachmentControls .button:hover'),
  T('--vela-accent-hover', ['--vela-accent-quiet'], 'AttachmentDropZone .overlayText'),
  T('--vela-text-muted', ['--vela-accent-quiet'], 'AttachmentDropZone .overlayHint'),
  T('--vela-text-subtle', INSET, 'AttachmentTray .glyph — the extension label'),
  T('--vela-text', SURFACE, 'AttachmentTray .name'),
  T('--vela-text-subtle', SURFACE, 'AttachmentTray .size'),
  T('--vela-text-muted', SURFACE, 'AttachmentTray .remove'),
  T('--vela-text', ['--vela-row-hover', '--vela-surface'], 'AttachmentTray .remove:hover'),
  T('--vela-warning', ['--vela-warning-bg'], 'AttachmentTray .refusalList'),
  T('--vela-warning', ['--vela-warning-bg'], 'AttachmentTray .dismiss'),

  /* ---- canvas ------------------------------------------------------------ */
  T('--vela-text', SURFACE, 'CanvasPanel .title'),
  T('--vela-text-subtle', SURFACE, 'CanvasPanel .close / .diffLead'),
  T('--vela-text', ['--vela-row-hover', '--vela-surface'], 'CanvasPanel .close:hover'),
  T('--vela-text-muted', INSET, 'CanvasPanel .tab / .version — on the view bar'),
  T('--vela-text-subtle', INSET, 'CanvasPanel .tab:disabled — diff, before a second version exists'),
  T('--vela-accent', ['--vela-accent-quiet'], 'CanvasPanel .tab[aria-selected=true]', {
    file: CANVAS_PANEL,
    selector: ".tab[aria-selected='true']",
  }),
  T('--vela-accent', INSET, 'CanvasPanel .version[aria-pressed=true]'),
  T('--vela-text-muted', SURFACE, 'CanvasPanel .scripts'),
  T('--vela-code-text', ['--vela-code-bg'], 'CanvasPanel .code / .diffBody — and an unchanged diff row'),
  /* The two the vocabulary check could not ask for. A tinted row re-grounds from
     the code palette to the page palette, so it must take the page's text role:
     --vela-code-text is one fixed value in both themes and only ever suits a
     ground that is also fixed, which --vela-code-bg is and these two are not. */
  T('--vela-text', ['--vela-accent-quiet'], 'CanvasPanel .diffRow[data-kind=added]', {
    file: CANVAS_PANEL,
    selector: ".diffRow[data-kind='added']",
  }),
  T('--vela-text', ['--vela-danger-bg'], 'CanvasPanel .diffRow[data-kind=removed]', {
    file: CANVAS_PANEL,
    selector: ".diffRow[data-kind='removed']",
  }),
  U('--vela-focus', INSET, 'CanvasPanel .tab / .version :focus-visible, on the view bar'),
  U('--vela-focus', SURFACE, 'CanvasPanel .close:focus-visible'),

  /* ---- code -------------------------------------------------------------- */
  T('--vela-syntax-comment', ['--vela-code-surface'], 'CodeBlock .language / .pending'),
  T('--vela-code-text', ['--vela-code-bg'], 'CodeBlock .pre'),
  T('--vela-syntax-comment', ['--vela-code-bg'], 'CodeBlock .comment'),
  T('--vela-syntax-string', ['--vela-code-bg'], 'CodeBlock .string'),
  T('--vela-syntax-number', ['--vela-code-bg'], 'CodeBlock .number'),
  T('--vela-syntax-keyword', ['--vela-code-bg'], 'CodeBlock .keyword'),
  T('--vela-syntax-punct', ['--vela-code-bg'], 'CodeBlock .punct'),
  T('--vela-syntax-comment', ['--vela-code-surface'], 'CopyButton .subtle — on a code bar'),
  T('--vela-code-text', ['--vela-code-surface'], 'CopyButton .subtle:hover'),

  /* ---- composer ---------------------------------------------------------- */
  T('--vela-text', RAISED, 'Composer .input'),
  T('--vela-text-subtle', RAISED, 'Composer .input::placeholder — the briefed defect'),
  T('--vela-text-on-accent', ['--vela-accent'], 'Composer .send'),
  T('--vela-text-on-accent', ['--vela-accent-hover'], 'Composer .send:hover'),
  T('--vela-text-subtle', INSET, 'Composer .send:disabled'),
  T('--vela-text', SURFACE, 'Composer .stop'),
  T('--vela-danger', SURFACE, 'Composer .stop:hover'),
  T('--vela-text-muted', RAISED, 'Composer .iconButton — inside the field'),
  T('--vela-text', INSET, 'Composer .iconButton:hover'),
  T('--vela-text-subtle', BG, 'Composer .hint'),
  T('--vela-text-subtle', INSET, 'Composer .hint kbd'),

  /* ---- conversation ------------------------------------------------------ */
  U('--vela-accent', ['--vela-accent-quiet'], 'EmptyConversation .mark'),
  T('--vela-text', BG, 'EmptyConversation .title'),
  T('--vela-text-muted', BG, 'EmptyConversation .lede'),
  T('--vela-text-subtle', BG, 'EmptyConversation .capability / .tick / .note'),
  T('--vela-accent', BG, 'EmptyConversation .tick — an available capability'),
  T('--vela-text', BG, 'Markdown .prose — the answer'),
  T('--vela-text', ['--vela-turn-user-bg'], 'Markdown .prose inside a user turn'),
  T('--vela-text-muted', BG, 'Markdown .heading[data-level=5|6] / .quote'),
  T('--vela-text-subtle', BG, 'Markdown .item::marker'),
  T('--vela-text', INSET, 'Markdown .inlineCode / .table th'),
  T('--vela-accent', BG, 'Markdown .link'),
  U('--vela-accent', BG, 'Markdown streaming caret'),
  T('--vela-text', ['--vela-turn-user-bg'], 'MessageTurn .userText'),
  T('--vela-text-subtle', BG, 'MessageTurn .awaiting / .usage'),
  T('--vela-text-muted', BG, 'MessageTurn .noAnswer'),
  T('--vela-text', ['--vela-danger-bg'], 'MessageTurn .errorTitle'),
  T('--vela-text', ['--vela-notice-bg'], 'MessageTurn .errorTitle — stopped'),
  T('--vela-text-muted', ['--vela-danger-bg'], 'MessageTurn .errorDetail'),
  T('--vela-text-muted', ['--vela-notice-bg'], 'MessageTurn .errorDetail — stopped'),
  T('--vela-text-subtle', ['--vela-danger-bg'], 'MessageTurn .errorTrace'),
  T('--vela-text-subtle', ['--vela-notice-bg'], 'MessageTurn .errorTrace — stopped'),
  T('--vela-text', SURFACE, 'MessageTurn .retry'),
  T('--vela-accent', SURFACE, 'MessageTurn .retry:hover'),
  T('--vela-thinking-text', ['--vela-thinking-bg'], 'ThinkingBlock .toggle / .body'),
  T('--vela-text', ['--vela-thinking-bg'], 'ThinkingBlock .toggle:hover'),
  U('--vela-accent', ['--vela-thinking-bg'], 'ThinkingBlock .pulse'),
  T('--vela-text-subtle', ['--vela-thinking-bg'], 'ThinkingBlock .peek'),
  T('--vela-warning', ['--vela-thinking-bg'], 'ThinkingBlock .notice'),
  T('--vela-text-subtle', BG, 'ToolCallList .summary'),
  T('--vela-text-muted', ['--vela-notice-bg'], 'ToolCallList .emulation'),
  T('--vela-text', ['--vela-notice-bg'], 'ToolCallList .emulationTag'),
  T('--vela-text-muted', SURFACE, 'ToolCallList .toggle / .static / .state / .problem / .reveal'),
  T('--vela-text', SURFACE, 'ToolCallList .name'),
  T('--vela-accent', SURFACE, 'ToolCallList .state[arriving|running]'),
  T('--vela-success', SURFACE, 'ToolCallList .state[succeeded]'),
  T('--vela-danger', SURFACE, 'ToolCallList .state[failed]'),
  T('--vela-warning', SURFACE, 'ToolCallList .state[unreadable]'),
  T('--vela-text-subtle', SURFACE, 'ToolCallList .tag / .preview / .label / .callId'),
  T('--vela-text-muted', INSET, 'ToolCallList .block'),
  T('--vela-text-muted', ['--vela-danger-bg'], 'ToolCallList .block[data-error]'),
  T('--vela-text', ['--vela-notice-bg'], 'TurnNotices .noteTitle'),
  T('--vela-text', ['--vela-warning-bg'], 'TurnNotices .noteTitle — warning tone'),
  T('--vela-text-muted', ['--vela-notice-bg'], 'TurnNotices .noteDetail'),
  T('--vela-text-muted', ['--vela-warning-bg'], 'TurnNotices .noteDetail — warning tone'),

  /* ---- diagnostics and models -------------------------------------------- */
  T('--vela-text', SURFACE, 'DebugLogSwitch .heading / .label'),
  T('--vela-text-muted', SURFACE, 'DebugLogSwitch .explanation / .path'),
  T('--vela-danger', SURFACE, 'DebugLogSwitch .error'),
  T('--vela-text', SURFACE, 'CapabilitySummary .heading / .probe / .badge'),
  T('--vela-text-muted', SURFACE, 'CapabilitySummary .probe:disabled / .label / .detail'),
  T('--vela-text-muted', ['--vela-notice-bg'], 'CapabilitySummary .floor'),
  T('--vela-warning', ['--vela-warning-bg'], 'CapabilitySummary .failure'),
  U('--vela-accent', ['--vela-border'], 'ContextMeter .fill against its track'),
  U('--vela-warning', ['--vela-border'], 'ContextMeter .tight .fill'),
  U('--vela-danger', ['--vela-border'], 'ContextMeter .over .fill'),
  T('--vela-text-muted', CHROME, 'ContextMeter .readout / .unknown, on the model bar'),
  T('--vela-warning', CHROME, 'ContextMeter .warning'),
  T('--vela-danger', CHROME, 'ContextMeter .over .warning'),
  T('--vela-text', SURFACE, 'EndpointForm .label / .input / .checkbox / .cancel'),
  T('--vela-text-subtle', SURFACE, 'EndpointForm .optional'),
  T('--vela-text-muted', SURFACE, 'EndpointForm .hint'),
  T('--vela-danger', ['--vela-danger-bg'], 'EndpointForm .error'),
  T('--vela-text-on-accent', ['--vela-accent'], 'EndpointForm .save'),
  T('--vela-text-on-accent', ['--vela-accent-hover'], 'EndpointForm .save:hover'),
  T('--vela-text', SURFACE, 'EndpointsPanel .heading / .close / .add / .rowName / .rowButton'),
  T('--vela-text-muted', SURFACE, 'EndpointsPanel .muted / .backend / .rowUrl / .credentialState'),
  T('--vela-text-subtle', SURFACE, 'EndpointsPanel .rowModel'),
  T('--vela-danger', SURFACE, 'EndpointsPanel .rowDanger'),
  T('--vela-danger', ['--vela-danger-bg'], 'EndpointsPanel .error'),
  /* The endpoint-removal dialog. Every composition here is one the delete
     dialog already declares, so the ratio assertions were green before these
     lines existed; the three that co-declare a colour and a ground are bound to
     their rules so that stripping one reddens this file by name. */
  T('--vela-text', RAISED, 'RemoveEndpointDialog .dialog / .name / .identifier', {
    file: REMOVE_ENDPOINT_DIALOG,
    selector: '.dialog',
  }),
  T('--vela-text-muted', RAISED, 'RemoveEndpointDialog .body'),
  T('--vela-text', SURFACE, 'RemoveEndpointDialog .cancel', {
    file: REMOVE_ENDPOINT_DIALOG,
    selector: '.cancel',
  }),
  T('--vela-text', INSET, 'RemoveEndpointDialog .cancel:hover'),
  T('--vela-text-on-danger', ['--vela-danger'], 'RemoveEndpointDialog .confirm', {
    file: REMOVE_ENDPOINT_DIALOG,
    selector: '.confirm',
  }),
  U('--vela-focus', RAISED, 'RemoveEndpointDialog .cancel / .confirm :focus-visible'),
  T('--vela-text-muted', CHROME, 'ModelBar .limits'),
  T('--vela-text-muted', ['--vela-row-hover', '--vela-chrome'], 'ModelBar .limits:hover'),
  T('--vela-warning', CHROME, 'ModelBar .limitsActive'),
  T('--vela-text', ['--vela-notice-bg'], 'ModelBar .noticeText'),
  T('--vela-text', SURFACE, 'ModelBar .noticeDismiss'),
  T('--vela-text', SURFACE, 'ModelSwitcher .trigger'),
  T('--vela-text', ['--vela-row-hover', '--vela-surface'], 'ModelSwitcher .trigger:hover'),
  T('--vela-text-muted', RAISED, 'ModelSwitcher .empty / .option:disabled / .optionProvider'),
  T('--vela-text', RAISED, 'ModelSwitcher .option'),
  T('--vela-text', ['--vela-row-hover', '--vela-surface-raised'], 'ModelSwitcher .option:hover'),
  T('--vela-row-selected-text', ['--vela-row-selected', '--vela-surface-raised'], 'ModelSwitcher .optionActive'),
  T('--vela-warning', ['--vela-warning-bg'], 'ModelSwitcher .optionBlocked'),
  U('--vela-accent', RAISED, 'ModelSwitcher .check'),
  T('--vela-accent', INSET, 'ModelSwitcher .footerAction'),
  T('--vela-accent', ['--vela-row-hover', '--vela-bg-inset'], 'ModelSwitcher .footerAction:hover'),
  T('--vela-text-muted', ['--vela-notice-bg'], 'SecurityNotice .level'),
  T('--vela-text', ['--vela-notice-bg'], 'SecurityNotice .list'),
  T('--vela-text-muted', ['--vela-warning-bg'], 'SecurityNotice .elevated .level'),
  T('--vela-text', ['--vela-warning-bg'], 'SecurityNotice .elevated .list'),
  T('--vela-text-muted', ['--vela-danger-bg'], 'SecurityNotice .high .level'),
  T('--vela-text', ['--vela-danger-bg'], 'SecurityNotice .high .list'),

  /* ---- navigation -------------------------------------------------------- */
  T('--vela-text-subtle', RAISED, 'CommandPalette .field / .input::placeholder / .rowKind / .footnote'),
  T('--vela-text', RAISED, 'CommandPalette .input / .rowTitle'),
  T('--vela-row-selected-text', ['--vela-row-selected', '--vela-surface-raised'], 'CommandPalette .active .rowTitle'),
  T('--vela-text-muted', ['--vela-row-selected', '--vela-surface-raised'], 'CommandPalette .active .rowKind'),
  T('--vela-text', ['--vela-accent-quiet'], 'CommandPalette .mark — inherits the row colour'),
  T('--vela-text', CHROME, 'ConversationRow .main'),
  T('--vela-text', ['--vela-row-hover', '--vela-chrome'], 'ConversationRow .main, hovered'),
  T('--vela-row-selected-text', ['--vela-row-selected', '--vela-chrome'], 'ConversationRow .selected .main'),
  T('--vela-text-subtle', CHROME, 'ConversationRow .meta / .action'),
  T('--vela-text-subtle', ['--vela-row-hover', '--vela-chrome'], 'ConversationRow .meta, hovered'),
  T('--vela-text-subtle', ['--vela-row-selected', '--vela-chrome'], 'ConversationRow .meta, selected'),
  T('--vela-text', SURFACE, 'ConversationRow .action:hover / .renaming'),
  T('--vela-text', BG, 'ConversationRow .renameInput'),
  T('--vela-text', RAISED, 'DeleteConversationDialog .dialog / .name'),
  T('--vela-text-muted', RAISED, 'DeleteConversationDialog .body'),
  T('--vela-text', SURFACE, 'DeleteConversationDialog .cancel'),
  T('--vela-text', INSET, 'DeleteConversationDialog .cancel:hover'),
  T('--vela-text-on-danger', ['--vela-danger'], 'DeleteConversationDialog .confirm'),
  U('--vela-accent', ['--vela-accent-quiet'], 'HomeSurface .mark'),
  T('--vela-text', BG, 'HomeSurface .title / .recentItem'),
  T('--vela-text-muted', BG, 'HomeSurface .lede'),
  T('--vela-text-on-accent', ['--vela-accent'], 'HomeSurface .primary'),
  T('--vela-text-on-accent', ['--vela-accent-hover'], 'HomeSurface .primary:hover'),
  T('--vela-text', SURFACE, 'HomeSurface .secondary / .pointHeading'),
  T('--vela-text', INSET, 'HomeSurface .secondary:hover'),
  T('--vela-text-subtle', ['--vela-row-hover', '--vela-bg'], 'HomeSurface .kbd'),
  T('--vela-text-muted', SURFACE, 'HomeSurface .pointBody'),
  T('--vela-text-subtle', BG, 'HomeSurface .recentHeading / .recentMeta / .fact dt'),
  T('--vela-text-subtle', ['--vela-row-hover', '--vela-bg'], 'HomeSurface .recentMeta, hovered'),
  T('--vela-text-muted', BG, 'HomeSurface .fact dd'),
  T('--vela-text-subtle', BG, 'NavigationSurface .placeholder'),
  T('--vela-text-on-accent', ['--vela-accent'], 'Sidebar .newButton'),
  T('--vela-text-on-accent', ['--vela-accent-hover'], 'Sidebar .newButton:hover'),
  T('--vela-text-muted', SURFACE, 'Sidebar .searchButton'),
  T('--vela-text-muted', ['--vela-row-hover', '--vela-surface'], 'Sidebar .kbd'),
  T('--vela-text-muted', CHROME, 'Sidebar .iconButton'),
  T('--vela-text', SURFACE, 'Sidebar .iconButton:hover'),
  T('--vela-text-subtle', CHROME, 'Sidebar .groupLabel / .note'),
  T('--vela-danger', ['--vela-row-hover', '--vela-chrome'], 'Sidebar .error'),
  U('--vela-accent', CHROME, 'Sidebar .handle::after — the drag affordance'),

  /* ---- global ------------------------------------------------------------ */
  T('--vela-text', BG, 'base.css body'),
  T('--vela-text', ['--vela-accent-quiet'], 'base.css ::selection'),
  U('--vela-focus', BG, 'base.css :focus-visible, on the page'),
  U('--vela-focus', SURFACE, 'base.css :focus-visible, on a card'),
  U('--vela-focus', RAISED, 'base.css :focus-visible, in a popover'),
  U('--vela-focus', CHROME, 'base.css :focus-visible, in the chrome'),
  U('--vela-focus', INSET, 'base.css :focus-visible, in an inset well'),
  U('--vela-focus', ['--vela-code-bg'], 'base.css :focus-visible, on a code block'),
  U('--vela-scrollbar-thumb', BG, 'base.css ::-webkit-scrollbar-thumb, on the page'),
  U('--vela-scrollbar-thumb', CHROME, 'base.css ::-webkit-scrollbar-thumb, in the sidebar'),
  U('--vela-scrollbar-thumb', RAISED, 'base.css ::-webkit-scrollbar-thumb, in a popover'),
  U('--vela-scrollbar-thumb-hover', BG, 'base.css ::-webkit-scrollbar-thumb:hover'),
];

const THRESHOLD: Record<Kind, number> = { text: 4.5, ui: 3 };

/* -------------------------------------------------------------------------- */
/* the audit                                                                   */
/* -------------------------------------------------------------------------- */

describe('every colour Vela paints clears WCAG AA, in both themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`holds in ${theme}`, () => {
      const palette = paletteFor(theme);
      const failures = PAIRS.flatMap((pair) => {
        const ground = groundColour(pair.on, palette);
        const declared = resolve(pair.fg, palette);
        if (ground === null || declared === null) {
          return [`undefined token — ${pair.fg} on ${pair.on.join(' over ')} — ${pair.where}`];
        }
        const foreground = composite(declared, ground);
        const ratio = contrast(foreground, ground);
        const needed = THRESHOLD[pair.kind];
        return ratio + 0.005 < needed
          ? [
              `${ratio.toFixed(2)}:1 (needs ${needed.toFixed(1)}) — ${pair.fg} on ${pair.on.join(' over ')} — ${pair.where}`,
            ]
          : [];
      });
      expect(failures, `${failures.length} colour pairs are below AA in ${theme}`).toEqual([]);
    });
  }

  it('reads real colours, not var() strings', () => {
    // The control. A resolver that stopped substituting would compare two
    // identical unresolved strings, throw, or — worse — return a constant, and
    // every assertion above would pass while measuring nothing.
    const light = paletteFor('light');
    const dark = paletteFor('dark');
    expect(substitute('var(--vela-bg)', light)).toMatch(/^#[0-9a-f]{6}$/iu);
    expect(substitute('var(--vela-bg)', dark)).not.toBe(substitute('var(--vela-bg)', light));

    expect(contrast(parseColour('#000000'), parseColour('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrast(parseColour('#ffffff'), parseColour('#ffffff'))).toBeCloseTo(1, 5);
    // sRGB, not a naive channel average: #777 on white is 4.48, famously just
    // under AA, and a linear-luminance mistake puts it at 4.9.
    expect(contrast(parseColour('#777777'), parseColour('#ffffff'))).toBeCloseTo(4.48, 2);
    // Compositing actually composites.
    expect(composite(parseColour('rgb(255 255 255 / 50%)'), parseColour('#000000')).r).toBeCloseTo(
      127.5,
      5,
    );
    expect(groundColour(['--vela-row-hover', '--vela-chrome'], light)).not.toEqual(
      groundColour(['--vela-chrome'], light),
    );
  });

  it('has a table big enough to be an audit', () => {
    expect(PAIRS.length).toBeGreaterThan(120);
    // Every pair must name where it was read from, or it cannot be checked by a
    // human against the component it claims to describe.
    expect(PAIRS.filter((pair) => pair.where.length < 8)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* completeness — the half that makes it an audit rather than a sample          */
/* -------------------------------------------------------------------------- */

function stylesheets(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...stylesheets(path));
    else if (entry.name.endsWith('.module.css')) found.push(path);
  }
  return found;
}

const SHEETS = [...stylesheets(SRC_ROOT), join(SRC_ROOT, 'styles', 'base.css')].map((path) => ({
  name: relative(REPO_ROOT, path),
  text: readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, ''),
}));

/**
 * Every declaration block in a stylesheet, lifted out of any `@media` or
 * `@supports` wrapper it sits inside. `SHEETS.text` has already had its comments
 * stripped, so a rule quoted in prose cannot be mistaken for one that ships.
 *
 * A rule that *contains* a nested block still has declarations of its own, and
 * they are emitted before the scan descends into it. The first version of this
 * function recursed instead of emitting, so a rule shaped like
 *
 *     .row { color: …; background: …; &:hover { … } }
 *
 * disappeared from every check built on it — which is this branch's own defect
 * one level down: an assertion satisfied by an ambient property, here "no
 * stylesheet happens to nest yet". Nothing in `src` nests today and all six
 * `@media` blocks are at column 0, so the drop was latent; native nesting is
 * baseline in the engines Vela ships against, so it would not have stayed
 * latent, and a guard that goes silently blind is worse than one that never
 * claimed to see. `the completeness scan can actually see the stylesheets`
 * carries the conservation check that notices a *partial* drop; the count floors
 * cannot, because they detect total blindness.
 */
function declarationBlocks(text: string): readonly { selector: string; body: string }[] {
  const found: { selector: string; body: string }[] = [];
  /**
   * A block's own declarations: what is left once nested blocks are removed,
   * innermost first so that arbitrary depth collapses. The nested *selectors*
   * survive as loose text, which is harmless — a selector cannot match
   * `color:` or `background:`.
   */
  const ownDeclarations = (body: string): string => {
    let out = body;
    for (let pass = 0; pass < 12 && out.includes('{'); pass += 1) {
      out = out.replace(/\{[^{}]*\}/gu, '');
    }
    return out;
  };
  const scan = (from: number, to: number): void => {
    let depth = 0;
    let open = from;
    let selectorFrom = from;
    for (let index = from; index < to; index += 1) {
      const character = text[index];
      if (character === '{') {
        if (depth === 0) open = index;
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          const body = text.slice(open + 1, index);
          // Anything ending in a semicolon before the brace is a statement, not
          // part of the selector. Without this, base.css's first rule carries its
          // `@import` lines inside `selector` and no RuleRef could bind to it.
          const preamble = text.slice(selectorFrom, open);
          const own = ownDeclarations(body);
          if (own.trim() !== '') {
            found.push({
              selector: preamble
                .slice(preamble.lastIndexOf(';') + 1)
                .trim()
                .replace(/\s+/gu, ' '),
              body: own,
            });
          }
          if (body.includes('{')) scan(open + 1, index);
          selectorFrom = index + 1;
        }
      }
    }
  };
  scan(0, text.length);
  return found;
}

/**
 * The one `color` / `background` token a single rule declares, if it declares
 * one. Both are anchored on a character that is neither a word character nor a
 * hyphen, so that `border-color:` is not a `color:` and a custom property whose
 * name ends in `-background` is not a ground.
 */
const DECLARES_COLOUR = /(?:^|[^-\w])color:\s*var\((--vela-[a-z0-9-]+)\)/u;
const DECLARES_GROUND = /(?:^|[^-\w])background(?:-color)?:\s*[^;]*var\((--vela-[a-z0-9-]+)\)/u;
/** The same two, global, for counting every declaration rather than the first. */
const EVERY_COLOUR = /(?:^|[^-\w])color:\s*var\(--vela-[a-z0-9-]+\)/gu;
const EVERY_GROUND = /(?:^|[^-\w])background(?:-color)?:\s*[^;]*var\(--vela-[a-z0-9-]+\)/gu;

/** Every token a stylesheet uses in `property: var(--vela-…)`. */
function tokensUsedAs(property: RegExp): Map<string, string> {
  const found = new Map<string, string>();
  for (const { name, text } of SHEETS) {
    for (const match of text.matchAll(property)) {
      for (const token of (match[0] ?? '').matchAll(/var\((--vela-[a-z0-9-]+)\)/gu)) {
        if (!found.has(token[1] ?? '')) found.set(token[1] ?? '', name);
      }
    }
  }
  return found;
}

/**
 * Grounds that carry no text and no meaning, with the reason each one is out of
 * scope. This list is the *only* way to be exempt, it is short, and every entry
 * is a claim a reviewer can check — which is the difference between an
 * exemption and an omission.
 */
const NOT_A_TEXT_GROUND: Record<string, string> = {
  '--vela-border': 'a hairline separator; surfaces.test.ts proves each surface is visible without it',
  '--vela-scrim': 'a dimming layer over the whole app; nothing is painted on it but the dialog',
  '--vela-warning': 'a meter fill and a status dot, audited as `ui` against their own grounds',
  '--vela-danger': 'a meter fill and a destructive button, both audited as foregrounds',
  '--vela-success': 'a status dot, audited as `ui` against the chrome',
  '--vela-text-subtle': 'the idle status dot, audited as `ui` against the chrome',
  '--vela-accent': 'a meter fill, a caret and the drag handle, all audited as `ui`',
  '--vela-accent-hover': 'the hover state of accent-filled buttons, audited as a ground above',
  '--vela-scrollbar-track': 'transparent by design — the thumb is audited against what is behind it',
  '--vela-scrollbar-thumb': 'the thumb itself, audited as a foreground against every scroller ground',
  '--vela-scrollbar-thumb-hover': 'the same thumb, hovered',
};

describe('every colour role is audited', () => {
  it('every token used as a text colour appears in the table', () => {
    // This is what stops the next `--vela-text-subtle`. A colour role that no
    // pair mentions is a role nobody checked, and it fails here by name.
    const audited = new Set(PAIRS.map((pair) => pair.fg));
    const missing = [...tokensUsedAs(/(?:^|[^-\w])color:\s*var\(--vela-[a-z0-9-]+\)/gmu)]
      .filter(([token]) => !audited.has(token))
      .map(([token, file]) => `${token} — first used in ${file}`);
    expect(missing, 'add a pair for each, naming the ground it is painted on').toEqual([]);
  });

  it('every token used as a background is audited or explicitly exempt', () => {
    const grounds = new Set(PAIRS.flatMap((pair) => pair.on));
    const missing = [...tokensUsedAs(/background(?:-color)?:\s*[^;]*var\(--vela-[a-z0-9-]+\)/gmu)]
      .filter(([token]) => !grounds.has(token) && NOT_A_TEXT_GROUND[token] === undefined)
      .map(([token, file]) => `${token} — first used in ${file}`);
    expect(missing, 'audit the text on it, or exempt it with a reason in NOT_A_TEXT_GROUND').toEqual(
      [],
    );
  });

  it('every rule that paints text on a ground it declares itself is a pair in the table', () => {
    // THE PAIR-VERSUS-TOKEN HOLE, as far as CSS text can close it.
    //
    // The two assertions above quantify over the vocabulary: they ask whether a
    // token appears *somewhere* as a foreground, and whether it appears
    // *somewhere* as a ground. Neither asks whether this foreground on this
    // ground was ever measured. That is how --vela-code-text — audited, on
    // --vela-code-bg — came to be painted on --vela-accent-quiet at 1.19:1 with
    // every ingredient green.
    //
    // A rule that declares both `color` and `background` states a whole
    // composition in one place, so it can be checked knowing nothing about the
    // DOM. That is what this does, and it is why the repair to CanvasPanel's
    // diff rows sets `color` on the same rule as `background` instead of leaving
    // it to inheritance: a composition that is written down is a composition
    // that gets measured.
    const measured = new Set(PAIRS.map((pair) => `${pair.fg} on ${pair.on[0] ?? ''}`));
    const missing = SHEETS.flatMap(({ name, text }) =>
      declarationBlocks(text).flatMap(({ selector, body }) => {
        const foreground = DECLARES_COLOUR.exec(body)?.[1];
        const ground = DECLARES_GROUND.exec(body)?.[1];
        if (foreground === undefined || ground === undefined) return [];
        return measured.has(`${foreground} on ${ground}`)
          ? []
          : [`${name} — ${selector} — ${foreground} on ${ground}`];
      }),
    );
    expect(missing, 'add a pair naming this rule, or its composition is unmeasured').toEqual([]);
  });

  /*
   * WHAT THIS STILL DOES NOT CLOSE, and what closing it would take.
   *
   * A composition assembled across the DOM — an ancestor declares the `color`, a
   * descendant re-declares only the `background` — is invisible to every check in
   * this file, because the ancestry lives in the TSX and not in the CSS. The
   * defect above had exactly that shape before the fix: `.diffBody` painted the
   * text, `.diffRow[data-kind=added]` painted the ground, and no single rule held
   * both. The assertion above would not have caught it. It catches it now only
   * because the fix co-declares.
   *
   * The clearest illustration is inside this very table. `MessageTurn
   * .errorTitle` — which `CanvasPanel.module.css` cites as the precedent for
   * --vela-text on --vela-danger-bg — is itself that shape: `.error` declares the
   * background, `.errorTitle` declares the colour, two rules, no co-declaration.
   * It is audited only because a human read the component and wrote the pair
   * down. Delete that line and nothing in this file asks for it back. The
   * precedent for the fix is also the standing proof of the gap.
   *
   * Two routes reach the general case, and both are larger than a contrast fix:
   *
   * 1. PER-COMPONENT COMPLETENESS. Demand that each stylesheet's own use of a
   *    token be audited by a pair whose `where` names that component, rather than
   *    the token merely appearing somewhere in this table. Measured against the
   *    tree as it stands, that asks for 44 new foreground entries and 58 new
   *    ground entries across 22 of 41 stylesheets; nine components — CanvasPanel
   *    before this commit, CanvasSurface, DocumentPreview, MemoryPanel,
   *    ProjectPanel, SchedulesPanel, SkillsPanel, LocalEndpointSection,
   *    RunHistory — have no pair at all today. It also needs a per-component
   *    exemption list, because NOT_A_TEXT_GROUND is global and several of those
   *    "gaps" are the meter fills and status dots it already excuses. Worth
   *    doing. Not a contrast fix, and not safe to land inside one.
   *
   * 2. STATIC JSX ANCESTRY. `CanvasPanel.tsx` literally contains
   *    `<pre className={styles.diffBody}>` wrapping
   *    `<span className={styles.diffRow}>`, so the true ground chain is derivable
   *    from source without a browser. This is the only route that yields the real
   *    chain — the thing the header calls the one hand-made part of this file —
   *    but a JSX nesting analyser that stays correct across 40 components is its
   *    own piece of work, and a guard that rots is worse than a guard that is
   *    honest about its reach.
   */

  it('a pair that names a rule is checked against that rule', () => {
    // The other direction of the guard above, and the one that makes a revert of
    // the stylesheet redden the suite. The assertion above walks CSS → table:
    // every rule that co-declares must be a pair. This walks table → CSS: every
    // pair that names a rule must find that rule still declaring both halves of
    // the composition it claims.
    //
    // Without it, the two diff-row pairs are only a *description*. Delete the
    // `color` from .diffRow[data-kind='added'] and the ratio assertions stay
    // green — they measure --vela-text on --vela-accent-quiet, which is a fact
    // about the palette and stays true whether or not any rule paints it. This
    // is what fails instead, by name.
    const bound = PAIRS.filter((pair) => pair.rule !== undefined);
    expect(bound.length, 'the table has stopped binding to any rule at all').toBeGreaterThan(2);

    const sheetsByName = new Map(
      SHEETS.map(({ name, text }) => [name.replace(/\\/gu, '/'), text] as const),
    );
    const wrong = bound.flatMap((pair) => {
      const rule = pair.rule;
      if (rule === undefined) return [];
      const text = sheetsByName.get(rule.file);
      if (text === undefined) return [`${rule.file} — no such stylesheet`];
      const block = declarationBlocks(text).find(({ selector }) => selector === rule.selector);
      if (block === undefined) return [`${rule.file} — no rule \`${rule.selector}\``];
      const foreground = DECLARES_COLOUR.exec(block.body)?.[1];
      const ground = DECLARES_GROUND.exec(block.body)?.[1];
      const say = (detail: string): string => `${rule.file} \`${rule.selector}\` — ${detail}`;
      if (foreground === undefined) {
        return [
          say(
            `declares no colour of its own, so it inherits one and this pair does not describe it; the table claims ${pair.fg}`,
          ),
        ];
      }
      if (ground === undefined) return [say(`declares no background; the table claims ${pair.on[0] ?? ''}`)];
      const problems: string[] = [];
      if (foreground !== pair.fg) problems.push(say(`paints ${foreground}, the table claims ${pair.fg}`));
      if (ground !== (pair.on[0] ?? '')) {
        problems.push(say(`is grounded on ${ground}, the table claims ${pair.on[0] ?? ''}`));
      }
      return problems;
    });
    expect(wrong, 'the stylesheet and the table have parted company').toEqual([]);
  });

  it('a foreground that does not change with the theme is never crossed by its ground', () => {
    // The defect's class, stated as a property rather than as a ratio.
    // --vela-code-text is one fixed value in both themes, which is only ever
    // right because --vela-code-bg is dark in both. Pair a fixed foreground with
    // a ground that is light in one theme and dark in the other and it is
    // legible in at most one of them.
    //
    // Its reach, stated honestly: on THIS palette it never catches anything the
    // ratio assertions would miss. Enumerate all 41 theme-fixed foregrounds
    // against all 36 theme-turning grounds and there are 898 crossings, of which
    // not one has both ratios clearing 4.5:1 — the best is 4.37:1. So today this
    // is a second and better-worded witness to a failure the measurement also
    // sees, not an extra catch. It earns its place by being a property of the
    // pairing rather than of the current values: it goes on holding, and goes on
    // saying why, across a palette change that could quietly make the ratios
    // pass.
    //
    // Text only. --vela-scrollbar-thumb is deliberately night-400 in both themes
    // and is deliberately crossed by --vela-bg, --vela-chrome and
    // --vela-surface-raised; it is a control rather than text, it is audited at
    // 3:1 against all three, and tokens.css says why it is one value.
    const light = paletteFor('light');
    const dark = paletteFor('dark');
    const side = (foreground: Rgba, ground: Rgba): number =>
      Math.sign(luminance(composite(foreground, ground)) - luminance(ground));
    const crossed = PAIRS.filter((pair) => pair.kind === 'text').flatMap((pair) => {
      const fgLight = resolve(pair.fg, light);
      const fgDark = resolve(pair.fg, dark);
      const groundLight = groundColour(pair.on, light);
      const groundDark = groundColour(pair.on, dark);
      if (fgLight === null || fgDark === null || groundLight === null || groundDark === null) {
        return [];
      }
      const fixed =
        fgLight.r === fgDark.r &&
        fgLight.g === fgDark.g &&
        fgLight.b === fgDark.b &&
        fgLight.a === fgDark.a;
      if (!fixed) return [];
      return side(fgLight, groundLight) === side(fgDark, groundDark)
        ? []
        : [`${pair.fg} is fixed across themes but ${pair.on.join(' over ')} crosses it — ${pair.where}`];
    });
    expect(crossed, 'give the row a foreground that turns over with its ground').toEqual([]);
  });

  it('no component paints a ramp step as a text colour', () => {
    // `--vela-night-0` was the `color` of two filled buttons. A ramp step has no
    // theme — it is the same white in dark mode, where those fills are light —
    // so it can only ever be right in one of the two themes. Text colours are
    // semantic roles; the ramp is what those roles are built out of.
    const raw = SHEETS.flatMap(({ name, text }) =>
      text
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => /(?:^|[^-\w])color:\s*var\(--vela-(?:night|signal|amber|rose|mint)-/u.test(line))
        .map(({ line, number }) => `${name}:${number} — ${line}`),
    );
    expect(raw, 'use a semantic role: --vela-text-*, --vela-text-on-*, --vela-syntax-*').toEqual([]);
  });

  it('the completeness scan can actually see the stylesheets', () => {
    // Both guards above pass trivially if the scan finds nothing.
    expect(SHEETS.length).toBeGreaterThan(20);
    const colours = tokensUsedAs(/(?:^|[^-\w])color:\s*var\(--vela-[a-z0-9-]+\)/gmu);
    expect(colours.size).toBeGreaterThan(10);
    expect(colours.has('--vela-text')).toBe(true);
    expect(tokensUsedAs(/background(?:-color)?:\s*[^;]*var\(--vela-[a-z0-9-]+\)/gmu).size).toBeGreaterThan(10);
    // `border-color` must not be mistaken for `color`, or every border token
    // would be demanded as a text role and the exemption list would rot.
    expect(
      [...tokensUsedAs(/(?:^|[^-\w])color:\s*var\(--vela-[a-z0-9-]+\)/gmu)].some(
        ([token]) => token === '--vela-border',
      ),
    ).toBe(false);

    // The composition guard is only a guard if the rule splitter finds rules,
    // finds rules that co-declare, and reads real selectors rather than
    // whitespace. A splitter that quietly returned [] would pass it vacuously —
    // which is the same shape of defect the guard itself exists to close.
    const rules = SHEETS.flatMap(({ text }) => declarationBlocks(text));
    expect(rules.length).toBeGreaterThan(400);
    expect(
      rules.filter(({ body }) => DECLARES_COLOUR.test(body) && DECLARES_GROUND.test(body)).length,
    ).toBeGreaterThan(40);
    expect(rules.some(({ selector }) => selector === ".diffRow[data-kind='added']")).toBe(true);

    // CONSERVATION — the floor that notices a *partial* drop.
    //
    // The three expectations above detect a splitter that has gone blind
    // altogether. They cannot detect one that quietly loses a subset, and that
    // is not hypothetical: the first version of `declarationBlocks` swallowed
    // every rule containing a nested block, and all three stayed green. So count
    // instead. Every `color:`/`background:` token declaration in the sheets must
    // land in exactly one emitted block — parent declarations in the parent,
    // nested ones in the child, none in both and none nowhere.
    const tally = (chunks: readonly string[], pattern: RegExp): number =>
      chunks.reduce((sum, chunk) => sum + [...chunk.matchAll(pattern)].length, 0);
    const inSheets = SHEETS.map(({ text }) => text);
    const inBlocks = rules.map(({ body }) => body);
    expect(
      tally(inBlocks, EVERY_COLOUR),
      'the rule splitter is losing colour declarations',
    ).toBe(tally(inSheets, EVERY_COLOUR));
    expect(
      tally(inBlocks, EVERY_GROUND),
      'the rule splitter is losing background declarations',
    ).toBe(tally(inSheets, EVERY_GROUND));
  });
});
