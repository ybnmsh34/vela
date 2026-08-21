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
 * CSS text can actually prove. The part it cannot — an ancestor declaring the
 * ground and a descendant the colour — is not in this file at all any more:
 * `painted-contrast.test.tsx` renders the components and reads the ancestry off
 * the DOM. The comment above `a pair that names a rule is checked against that
 * rule` says what each of the two files can and cannot see.
 *
 * ## What it found on the first run, besides the briefed one
 *
 * - `EndpointForm .save` and `DeleteConversationDialog .confirm` painted
 *   `--vela-night-0` (white) on `--vela-accent` / `--vela-danger`. In dark those
 *   fills are *light* — `#5fe2d6`, `#f2668b` — so the label sat at ~1.4:1 and
 *   ~2.5:1. `--vela-text-on-accent` already existed for exactly this and both
 *   files bypassed it.
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

import { describe, expect, it } from 'vitest';

import {
  composite,
  contrastRatio as contrast,
  declaredBy,
  declaredValue,
  expandVars,
  isPaletteRule,
  loadSheets,
  luminance,
  paletteFor as tokenPalette,
  parseColour,
  parseStylesheet,
  readPaint,
  TOKEN_SHEET,
  tryParseColour,
  type Lookup,
  type Paint,
  type Rgba,
  type Rule,
  type Theme,
} from './css-model';

/**
 * Every stylesheet under `src/`, parsed once.
 *
 * `SHEETS` used to be `*.module.css` plus `base.css`, which left
 * `src/styles/typeface.css` — imported by `base.css`, shipped in the bundle —
 * outside every check in this file, along with any non-module sheet added
 * later. The discovery is now "every `.css` under `src/`", so a new sheet is
 * audited by existing rather than by being remembered.
 */
const SHEETS = loadSheets();
const ALL_RULES: readonly Rule[] = SHEETS.flatMap((sheet) => sheet.rules);

/* -------------------------------------------------------------------------- */
/* resolving the token graph                                                   */
/* -------------------------------------------------------------------------- */

function paletteFor(theme: Theme): Map<string, string> {
  return tokenPalette(theme, SHEETS);
}

function substitute(value: string, palette: Map<string, string>): string {
  return expandVars(value, (name) => palette.get(name)).text;
}

/**
 * The colour a token resolves to, or `null` when the sheet does not define it.
 * Null rather than a throw because an undefined token is a *finding* — CSS drops
 * an unresolvable declaration silently, so it must be reported by name, not hide
 * behind a stack trace. A token that *is* declared but does not name a colour
 * still throws: that is a broken sheet, not a finding this table can word.
 */
function resolve(token: string, palette: Map<string, string>): Rgba | null {
  const expansion = expandVars(`var(${token})`, (name) => palette.get(name));
  if (expansion.unresolved.length > 0) return null;
  return parseColour(expansion.text);
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

/**
 * What one rule paints, read as **values** rather than matched as text.
 *
 * The pair of regexes this replaces —
 *
 *     DECLARES_COLOUR = /(?:^|[^-\w])color:\s*var\((--vela-[a-z0-9-]+)\)/u
 *     DECLARES_GROUND = /(?:^|[^-\w])background(?:-color)?:\s*[^;]*var\((--vela-[a-z0-9-]+)\)/u
 *
 * were the guard's eyes, and both were narrower than the question. The capture
 * in `DECLARES_GROUND` demands `)` immediately after the token name, so
 * `background: var(--vela-accent-quiet, transparent)` — which paints exactly
 * `--vela-accent-quiet` — read as *no ground at all*, and the rule was skipped
 * rather than reported. Spelling the same thing through a local custom property
 * did the same. And because the block cutter left a nested `@supports (…)`
 * **prelude** loose in its parent's body, `DECLARES_GROUND` could match the
 * condition and credit a rule with a ground it does not declare — a green
 * measurement of a composition that exists nowhere.
 *
 * `readPaint` expands `var()` with its fallbacks, follows custom properties, and
 * has an `unreadable` arm; `parseStylesheet` knows the difference between a
 * prelude and a declaration. `no colour or background declaration is unreadable
 * to this audit` is what turns that `unreadable` arm into a failure, so a value
 * the reader cannot parse can no longer leave through the same door as a value
 * that is not there.
 */
interface Painted {
  readonly rule: Rule;
  readonly foreground: Paint | undefined;
  readonly ground: Paint | undefined;
}

/** The custom properties one rule can see: its own, then `:root`'s. */
function lookupFor(rule: Rule, palette: Map<string, string>): Lookup {
  const locals = new Map<string, string>();
  for (const { property, value } of rule.declarations) {
    if (property.startsWith('--')) locals.set(property, value);
  }
  return (name) => locals.get(name) ?? palette.get(name);
}

function paintedBy(rule: Rule, palette: Map<string, string>): Painted {
  const lookup = lookupFor(rule, palette);
  const colour = declaredValue(rule, 'color');
  const ground = declaredValue(rule, 'background', 'background-color');
  return {
    rule,
    foreground: colour === undefined ? undefined : readPaint(colour, lookup),
    ground: ground === undefined ? undefined : readPaint(ground, lookup),
  };
}

const LIGHT_PALETTE = paletteFor('light');
const PAINTED: readonly Painted[] = ALL_RULES.map((rule) => paintedBy(rule, LIGHT_PALETTE));

const at = (rule: Rule): string =>
  `${rule.file} — ${rule.selector === '' ? rule.conditions.join(' ') : rule.selector}`;

/**
 * Every `--vela-*` role a stylesheet asks for on one side of the paint, with the
 * first sheet that asks for it.
 *
 * The role is the *first* `--vela-*` property the expansion enters, so a rule
 * that reaches a role through a local alias is credited with the role rather
 * than with the alias.
 */
function rolesUsedAs(side: 'foreground' | 'ground'): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of PAINTED) {
    const paint = entry[side];
    if (paint === undefined || paint.kind !== 'colour' || paint.token === null) continue;
    if (!found.has(paint.token)) found.set(paint.token, entry.rule.file);
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
  it('no colour or background declaration is unreadable to this audit', () => {
    // THE DOOR THE EVASIONS WENT THROUGH, NAILED SHUT.
    //
    // Every check below asks "which role does this rule paint". The old reader
    // had two answers — a token, or nothing — and "nothing" meant both *this
    // rule declares no ground* and *this rule declares a ground I cannot read*.
    // Collapsing those two is what let `var(--vela-x, transparent)` and a local
    // alias walk past a guard that had the value in front of it.
    //
    // `readPaint` has a third answer, and this is where it lands. A value it
    // cannot resolve to a colour, a keyword or a role is a failure quoting the
    // value — never a skip.
    const unreadable = PAINTED.flatMap((entry) =>
      (['foreground', 'ground'] as const).flatMap((side) => {
        const paint = entry[side];
        return paint === undefined || paint.kind !== 'unreadable'
          ? []
          : [`${at(entry.rule)} — ${side} \`${paint.text}\`: ${paint.why}`];
      }),
    );
    expect(
      unreadable,
      'teach css-model.ts to read this value, or write it in a form it reads',
    ).toEqual([]);
  });

  it('every token used as a text colour appears in the table', () => {
    // This is what stops the next `--vela-text-subtle`. A colour role that no
    // pair mentions is a role nobody checked, and it fails here by name.
    const audited = new Set(PAIRS.map((pair) => pair.fg));
    const missing = [...rolesUsedAs('foreground')]
      .filter(([token]) => !audited.has(token))
      .map(([token, file]) => `${token} — first used in ${file}`);
    expect(missing, 'add a pair for each, naming the ground it is painted on').toEqual([]);
  });

  it('every token used as a background is audited or explicitly exempt', () => {
    const grounds = new Set(PAIRS.flatMap((pair) => pair.on));
    const missing = [...rolesUsedAs('ground')]
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
    const missing = PAINTED.flatMap(({ rule, foreground, ground }) => {
      if (foreground?.kind !== 'colour' || ground?.kind !== 'colour') return [];
      if (foreground.token === null || ground.token === null) return [];
      return measured.has(`${foreground.token} on ${ground.token}`)
        ? []
        : [`${rule.file} — ${rule.selector} — ${foreground.token} on ${ground.token}`];
    });
    expect(missing, 'add a pair naming this rule, or its composition is unmeasured').toEqual([]);
  });

  /*
   * WHERE THE OTHER HALF OF THE QUESTION LIVES.
   *
   * A composition assembled across the DOM — an ancestor declares the
   * `background`, a descendant declares only the `color` — is invisible to every
   * check in *this* file, because the ancestry lives in the TSX and not in the
   * CSS. The defect above had exactly that shape before the fix: `.diffBody`
   * painted the text, `.diffRow[data-kind=added]` painted the ground, and no
   * single rule held both. The assertion above catches it now only because the
   * fix co-declares.
   *
   * The clearest illustration is inside this very table. `MessageTurn
   * .errorTitle` — which `CanvasPanel.module.css` cites as the precedent for
   * --vela-text on --vela-danger-bg — is itself that shape: `.error` declares the
   * background, `.errorTitle` declares the colour, two rules, no co-declaration.
   * It is in this table only because a human read the component and wrote the
   * pair down. Delete that line and nothing *here* asks for it back.
   *
   * `src/styles/painted-contrast.test.tsx` is what asks for it back. It renders
   * the components, walks every element that carries text, and resolves the
   * colour it inherits and the ground it stands on through the real ancestry —
   * so it measures the compositions no rule states, including that one. What it
   * cannot do is measure a component no fixture mounts, and the rules no fixture
   * reaches are listed there by name rather than left silent.
   *
   * The two files answer different halves and neither subsumes the other. This
   * one reads every rule in every sheet and needs no render, so it sees states
   * and components a fixture never reaches; that one sees the DOM edge this one
   * cannot represent. A composition is only certainly measured when one of them
   * can see it, which is why the un-rendered list over there is the honest
   * statement of what is still unmeasured today.
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

    const known = new Set(SHEETS.map(({ name }) => name));
    const wrong = bound.flatMap((pair) => {
      const rule = pair.rule;
      if (rule === undefined) return [];
      if (!known.has(rule.file)) return [`${rule.file} — no such stylesheet`];
      const block = ALL_RULES.find(
        (candidate) => candidate.file === rule.file && candidate.selector === rule.selector,
      );
      if (block === undefined) return [`${rule.file} — no rule \`${rule.selector}\``];
      const paint = paintedBy(block, LIGHT_PALETTE);
      const foreground = paint.foreground?.kind === 'colour' ? paint.foreground.token : undefined;
      const ground = paint.ground?.kind === 'colour' ? paint.ground.token : undefined;
      const say = (detail: string): string => `${rule.file} \`${rule.selector}\` — ${detail}`;
      if (foreground === undefined || foreground === null) {
        return [
          say(
            `declares no colour of its own, so it inherits one and this pair does not describe it; the table claims ${pair.fg}`,
          ),
        ];
      }
      if (ground === undefined || ground === null) {
        return [say(`declares no background; the table claims ${pair.on[0] ?? ''}`)];
      }
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
    //
    // Asked of the resolved role rather than of the line, so that reaching a
    // ramp step through a local alias is the same finding as naming it.
    const raw = PAINTED.flatMap(({ rule, foreground }) =>
      foreground?.kind === 'colour' &&
      foreground.token !== null &&
      /^--vela-(?:night|signal|amber|rose|mint)-/u.test(foreground.token)
        ? [`${at(rule)} — color: ${foreground.token}`]
        : [],
    );
    expect(raw, 'use a semantic role: --vela-text-*, --vela-text-on-*, --vela-syntax-*').toEqual([]);
  });

  it('the completeness scan can actually see the stylesheets', () => {
    // Both guards above pass trivially if the scan finds nothing.
    expect(SHEETS.length).toBeGreaterThan(20);
    expect(SHEETS.map(({ name }) => name)).toContain('src/styles/typeface.css');
    const colours = rolesUsedAs('foreground');
    expect(colours.size).toBeGreaterThan(10);
    expect(colours.has('--vela-text')).toBe(true);
    expect(rolesUsedAs('ground').size).toBeGreaterThan(10);
    // `border-color` must not be mistaken for `color`, or every border token
    // would be demanded as a text role and the exemption list would rot.
    expect(colours.has('--vela-border')).toBe(false);

    // The composition guard is only a guard if the parser finds rules, finds
    // rules that co-declare, and reads real selectors rather than whitespace. A
    // parser that quietly returned [] would pass it vacuously — which is the
    // same shape of defect the guard itself exists to close.
    expect(ALL_RULES.length).toBeGreaterThan(400);
    expect(
      PAINTED.filter(({ foreground, ground }) => foreground !== undefined && ground !== undefined)
        .length,
    ).toBeGreaterThan(40);
    expect(ALL_RULES.some(({ selector }) => selector === ".diffRow[data-kind='added']")).toBe(true);

    // CONSERVATION — the floor that notices a *partial* drop, rewritten so that
    // it is a law rather than a coincidence.
    //
    // The expectations above detect a parser that has gone blind altogether.
    // They cannot detect one that quietly loses a subset, and that is not
    // hypothetical: an earlier splitter swallowed every rule containing a nested
    // block and all of them stayed green.
    //
    // The count this replaces tallied the SAME regex over two texts — the whole
    // sheet, and the concatenated rule bodies. That is not conservation of
    // declarations, it is conservation of greedy-match counts, and the two
    // differ: `EVERY_GROUND`'s `[^;]*` can run past a nested at-rule prelude in
    // one text and stop at a `;` that only exists in the other, so the law could
    // fail on legal input while nothing had been lost. A law that can be wrong
    // on legal input is not a law.
    //
    // So the second oracle is now structurally independent of the parser: count
    // the DECLARATION LINES. Every `color:` / `background:` / `background-color:`
    // in this repo's sheets is written at the head of its own line — 476 of
    // them as this was written, and none written any other way — so a line
    // scan sees each exactly once and knows nothing about braces, preludes or
    // `var()`. If the parser drops one, or invents one out of a prelude, the two
    // numbers part. If the house style ever stops holding, this fails loudly
    // rather than drifting: that is the intended failure.
    const PAINT_LINE = /^[\t ]*(?:color|background|background-color)[\t ]*:/u;
    const byLine = SHEETS.reduce(
      (sum, { text }) =>
        sum +
        text
          .replace(/\/\*[\s\S]*?\*\//gu, '')
          .split('\n')
          .filter((line) => PAINT_LINE.test(line)).length,
      0,
    );
    const byParser = ALL_RULES.reduce(
      (sum, rule) =>
        sum +
        rule.declarations.filter(({ property }) =>
          ['color', 'background', 'background-color'].includes(property),
        ).length,
      0,
    );
    expect(byParser, 'the parser and a plain line scan disagree about how many paint declarations exist').toBe(
      byLine,
    );
    expect(byLine).toBeGreaterThan(400);
  });
});

/* -------------------------------------------------------------------------- */
/* the reader itself                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The three constructions that walked past the regexes, as inputs.
 *
 * These are the anti-vacuity floor for the repair. Every assertion in the two
 * describes above is of the form "the set of findings is empty", and the whole
 * failure this file exists to close is a reader that finds nothing because it
 * cannot see. Asserting on real stylesheets can only ever say "nothing is wrong
 * today"; these say "the reader still reads", by handing it text whose right
 * answer is known and non-empty.
 */
describe('the reader is not fooled by the shapes that fooled its regexes', () => {
  // The roles these fixtures are written in, resolved from `tokens.css` itself
  // rather than from a local table of values. The table it replaces was three
  // colour values written into `src/` by hand, one of which — checked afterwards
  // — matched no token in the sheet at all; and a fixture whose ground is not a
  // ground the product paints is a fixture that goes on passing after the
  // palette moves out from under it.
  const ROLE = LIGHT_PALETTE;
  const read = (css: string): Painted[] =>
    parseStylesheet('probe.css', css).map((rule) => paintedBy(rule, ROLE));
  const ground = (entry: Painted | undefined): string | null | undefined =>
    entry?.ground?.kind === 'colour' ? entry.ground.token : (entry?.ground?.kind ?? undefined);

  it('is written in roles the token sheet still declares', () => {
    // Without this the fixtures degrade quietly: rename a token and every read
    // below answers `unreadable`, which several of these tests would still
    // report as "not a ground", and they would stop testing the shapes they
    // were written for while staying green.
    for (const token of ['--vela-accent-quiet', '--vela-code-bg', '--vela-code-text']) {
      expect(ROLE.get(token), `${token} is no longer declared`).toBeDefined();
    }
  });

  it('prefers a declared custom property to the fallback beside it', () => {
    // THE NAME OF THIS TEST WAS WRONG FOR A ROUND, and a measurer caught it by
    // reading what the input does rather than what the name says. It was called
    // `reads a ground written through a var() fallback` and cited `expandVars`'s
    // "the fallback is used when — and only when — the custom property has no
    // declaration" — but `--vela-accent-quiet` **is** declared, so the reader
    // takes the declared branch and the fallback is never evaluated. Deleting
    // the whole `else if (fallback !== null)` arm left `npx vitest run
    // src/styles` at 6 files / 137 tests, exit 0; only `tsc` objected, and only
    // because `fallback` became an unused local.
    //
    // The input is unchanged and it is a real test — of the *other* half of that
    // sentence, which is the half it always tested. The half it named is below.
    const [rule] = read(
      `.body { color: var(--vela-code-text); background: var(--vela-accent-quiet, transparent); }`,
    );
    expect(ground(rule)).toBe('--vela-accent-quiet');
  });

  it('reads a ground written through a var() fallback', () => {
    // And now the half nothing fed: a token with **no** declaration, whose
    // fallback is what the engine paints.
    const [rule] = read(
      `.body { color: var(--vela-code-text); background: var(--vela-nowhere, var(--vela-accent-quiet)); }`,
    );
    expect(ground(rule)).toBe('--vela-accent-quiet');
    // And the fallback is not a licence to invent: an undeclared token with no
    // fallback is still named rather than skipped.
    const [bare] = read(`.body { background: var(--vela-nowhere); }`);
    expect(bare?.ground?.kind).toBe('unreadable');
  });

  it('reads a ground written through a local custom property', () => {
    const [rule] = read(
      `.body { --skill-body-bg: var(--vela-accent-quiet); color: var(--vela-code-text); background: var(--skill-body-bg); }`,
    );
    expect(ground(rule)).toBe('--vela-accent-quiet');
  });

  it('never reads a ground out of an @supports condition', () => {
    // The forged reading, in the placement that made it silent: at the END of
    // the rule, where the old cutter left the prelude loose in the parent body
    // and the greedy `[^;]*` had nothing after it to run into.
    const [parent, nested] = read(
      `.body { color: var(--vela-code-text); @supports (background: var(--vela-code-bg)) { scrollbar-gutter: stable; } }`,
    );
    expect(parent?.rule.selector).toBe('.body');
    expect(parent?.ground, 'an @supports condition is not a declaration').toBeUndefined();
    expect(nested?.rule.selector, 'a nested at-rule keeps its parent selector').toBe('.body');
    expect(nested?.ground).toBeUndefined();
    // And in the middle, which is where the old reader produced a false RED.
    const [middle] = read(
      `.body { color: var(--vela-code-text); @supports (background: var(--vela-code-bg)) { scrollbar-gutter: stable; } background: var(--vela-accent-quiet); }`,
    );
    expect(ground(middle)).toBe('--vela-accent-quiet');
  });

  it('keeps a `;` inside an attribute selector out of the selector it emits', () => {
    const [rule] = read(`.row[data-label='a;b'] { color: var(--vela-code-text); }`);
    expect(rule?.rule.selector).toBe(`.row[data-label='a;b']`);
  });

  it('does not lose the rest of the file to a brace inside a string', () => {
    const rules = read(
      `.a { content: '}'; color: var(--vela-code-text); }\n.b { background: var(--vela-code-bg); }`,
    );
    expect(rules.map((entry) => entry.rule.selector)).toEqual(['.a', '.b']);
  });

  it('emits a rule that also contains a nested block, and the nested one too', () => {
    const rules = read(
      `.row { color: var(--vela-code-text); background: var(--vela-code-bg); &:hover { background: var(--vela-accent-quiet); } }`,
    );
    expect(rules.map((entry) => entry.rule.selector)).toEqual(['.row', '.row:hover']);
    expect(ground(rules[0])).toBe('--vela-code-bg');
    expect(ground(rules[1])).toBe('--vela-accent-quiet');
  });

  it('calls a value it cannot resolve unreadable rather than absent', () => {
    const [rule] = read(`.body { background: var(--nowhere); color: linear-gradient(red, blue); }`);
    expect(rule?.ground?.kind).toBe('unreadable');
    expect(rule?.foreground?.kind).toBe('unreadable');
  });

  /**
   * EVERY STRUCTURAL POSITION `css-model.ts` READS, ENUMERATED.
   *
   * RULE W, on the model rather than on the markup scan. A measurer deleted
   * eight branches of this file one at a time and each left `npx tsc --build
   * --force` at 0 and `npx vitest run src/styles` at 6 files / 137 tests, exit
   * 0: the string-literal span skip, the `(…)`/`[…]` span skip, the
   * within-rule importance guard in `declaredBy`, the token-sheet half of
   * `isPaletteRule`, the three-digit hex expansion, the `no declaration for …`
   * arm of `readPaint`, the `var()` fallback arm, and the opaque short circuit
   * in `composite`. Every one of them is an invariant this file's prose states
   * and nothing fed an input to.
   *
   * The positions are listed, each assertion carries its position as its own
   * message, and the list of positions actually reached is compared against the
   * list at the end — so a branch that stopped being read names itself, and a
   * branch added without a case is a mismatch rather than a silence.
   */
  const MODEL_POSITIONS: readonly string[] = [
    'parseStylesheet — a string literal is an opaque span',
    'parseStylesheet — a (…) or […] group is an opaque span',
    'skipGroup — a string inside a group is opaque too',
    'declaredBy — an !important is not displaced by a later normal declaration',
    'declaredBy — otherwise the later declaration wins',
    'isPaletteRule — the token-sheet half',
    'isPaletteRule — the `:root` half',
    'tryParseColour — the three-digit hex expansion',
    'readPaint — a custom property with no declaration is named, not skipped',
    'expandVars — the declaration is preferred to the fallback',
    'expandVars — the fallback is taken when there is no declaration',
    'composite — an opaque colour is handed back rather than recomposed',
  ];

  it('every structural position the model reads is one an input reaches', () => {
    const reached: string[] = [];
    const at = (position: string): string => {
      reached.push(position);
      return position;
    };
    const colour = (entry: Painted | undefined): string | null | undefined =>
      entry?.foreground?.kind === 'colour' ? entry.foreground.token : entry?.foreground?.kind;
    const lookup: Lookup = (name) => ROLE.get(name);
    const asRule = (file: string, selector: string): Rule => ({
      file,
      selector,
      conditions: [],
      declarations: [],
    });

    // A `}` inside a string used to close the block it stood in. The existing
    // test for this asserted only the *selectors* that came back, and both of
    // them still come back — the rest of the file is not lost, only the
    // declaration the string sat beside. So the assertion is on the paint.
    const [quoted] = read(`.a { content: '}'; color: var(--vela-code-text); }`);
    expect(quoted?.rule.selector).toBe('.a');
    expect(colour(quoted), at(MODEL_POSITIONS[0] ?? '')).toBe('--vela-code-text');

    // A `;` inside a `url()` is the reachable form of the group skip, and the
    // one the docblock's attribute-selector example is not: a `;` inside a
    // *quoted* attribute value is already covered by the string skip above, so
    // the two arms cover for each other there and neither is load-bearing.
    // Unquoted, inside parentheses, only this arm answers.
    const [group] = read(
      `.a { background: url(data:image/svg+xml;utf8,x); color: var(--vela-code-text); }`,
    );
    expect(declaredValue(group?.rule ?? asRule('', ''), 'background'), at(MODEL_POSITIONS[1] ?? '')).toBe(
      'url(data:image/svg+xml;utf8,x)',
    );

    // `skipGroup` calls `skipString` itself, which is a third span skip and a
    // separate branch. Only a closing delimiter *inside* a quoted string inside
    // a group can tell it apart; synthetic, and stated as such.
    const [nested] = read(`.a { background: url("a);b.png"); color: var(--vela-code-text); }`);
    expect(declaredValue(nested?.rule ?? asRule('', ''), 'background'), at(MODEL_POSITIONS[2] ?? '')).toBe(
      'url("a);b.png")',
    );

    // Importance, within one rule. No rule in the tree writes `!important`
    // twice on one property, so nothing fed this until now; `never lets
    // specificity outrank an !important the engine obeys` covers the
    // between-rule half and cannot see this one.
    const [important] = read(
      `.a { color: var(--vela-code-text) !important; color: var(--vela-code-bg); }`,
    );
    expect(declaredBy(important?.rule ?? asRule('', ''), 'color'), at(MODEL_POSITIONS[3] ?? '')).toEqual(
      { value: 'var(--vela-code-text)', important: true },
    );
    const [later] = read(`.a { color: var(--vela-code-bg); color: var(--vela-code-text); }`);
    expect(declaredValue(later?.rule ?? asRule('', ''), 'color'), at(MODEL_POSITIONS[4] ?? '')).toBe(
      'var(--vela-code-text)',
    );

    // "A boundary drawn twice is a boundary in two places. This is the one
    // place." Both halves of that one place, and the token-sheet half was the
    // one nothing pinned: `the palette’s boundary and this prohibition’s
    // boundary are the same one` plants its rule in a sheet named TOKEN_SHEET,
    // so it never distinguishes the file test from the selector test.
    expect(isPaletteRule(asRule(TOKEN_SHEET, ':root'))).toBe(true);
    expect(isPaletteRule(asRule('src/styles/base.css', ':root')), at(MODEL_POSITIONS[5] ?? '')).toBe(
      false,
    );
    expect(isPaletteRule(asRule(TOKEN_SHEET, 'pre')), at(MODEL_POSITIONS[6] ?? '')).toBe(false);

    // The three-digit hex, as a **relation** rather than as a value: the short
    // form is the long form with every digit doubled, which is the whole of
    // what the branch does. The digits are built rather than written because
    // this branch's colour-fidelity check counts the unique six-digit hex
    // literals under `src/` and requires the set to be the one at
    // `run-start-2026-08-17` — writing either spelling out would add a colour to
    // the tree by that check's own definition, whatever it happened to be.
    const hexPosition = at(MODEL_POSITIONS[7] ?? '');
    for (const digit of ['0', '8', 'f']) {
      expect(tryParseColour(`#${digit.repeat(3)}`), `${hexPosition} (${digit})`).toEqual(
        tryParseColour(`#${digit.repeat(6)}`),
      );
    }

    // The unreadable arm's *message*, not only its kind. Deleting the arm left
    // the value still coming back `unreadable` through the not-a-colour arm —
    // so the safety property survived and the diagnosis did not.
    expect(readPaint('var(--nowhere)', () => undefined), at(MODEL_POSITIONS[8] ?? '')).toEqual({
      kind: 'unreadable',
      text: 'var(--nowhere)',
      why: 'no declaration for --nowhere',
    });

    // Both halves of "the fallback is used when — and only when — the custom
    // property has no declaration", as two inputs.
    const declared = readPaint('var(--vela-code-bg, transparent)', lookup);
    expect(declared.kind === 'colour' ? declared.token : declared.kind, at(MODEL_POSITIONS[9] ?? '')).toBe(
      '--vela-code-bg',
    );
    const fell = readPaint('var(--vela-nowhere, var(--vela-code-bg))', lookup);
    expect(fell.kind === 'colour' ? fell.token : fell.kind, at(MODEL_POSITIONS[10] ?? '')).toBe(
      '--vela-code-bg',
    );

    // The opaque short circuit. At `a <= 1` the mix is algebraically identical,
    // so the only observable effects are that the colour comes back *as itself*
    // and that an out-of-range alpha — which `rgba(…, 2)` would produce — never
    // extrapolates past the colour it was handed.
    // Both colours are read out of the palette rather than typed, for the
    // reason above and because a fixture whose colours are not colours the
    // product paints is a fixture that goes on passing after the palette moves.
    const opaque = parseColour(substitute('var(--vela-code-bg)', ROLE));
    const under = parseColour(substitute('var(--vela-code-text)', ROLE));
    expect(opaque.a, 'a palette colour is opaque').toBe(1);
    expect(composite(opaque, under), at(MODEL_POSITIONS[11] ?? '')).toBe(opaque);
    const over = { ...opaque, a: 2 };
    expect(composite(over, under)).toEqual(over);
    // Non-vacuous: the two are different colours, so "handed back" is a claim
    // about which one came back.
    expect(opaque).not.toEqual(under);

    expect(reached, 'a structural position lost its input, or gained one without being named').toEqual(
      MODEL_POSITIONS,
    );
  });
});
