/**
 * The two text rules the navigation surface shares with the host.
 *
 * These are **mirrors**, not originals. `src-tauri/src/ipc/store.rs` is the
 * specification; this file exists because `BrowserAdapter` has to answer
 * `store_autotitle_conversation` and `store_search` the same way the real host
 * does, or every headless test and screenshot is testing a different product.
 * `tests/parity/navigation.json` is read by both languages and fails whichever
 * one moved.
 *
 * Pure functions only — no adapter, no React, no DOM.
 */

/** Mirrors `UNTITLED_TITLE` in `src-tauri/src/ipc/store.rs`. */
export const UNTITLED_TITLE = 'New conversation';

/** Mirrors `MAX_TITLE_CHARS`. Counted in code points, as Rust counts `char`s. */
export const MAX_TITLE_CHARS = 48;

/** Mirrors `MIN_WORD_BOUNDARY`. */
const MIN_WORD_BOUNDARY = 24;

/** Mirrors `TRAILING_NOISE`. */
const TRAILING_NOISE = new Set([
  ' ',
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  '-',
  '–',
  '—',
  '…',
]);

/** Characters that can open a markdown line without being part of its subject. */
const LEAD_IN_MARKERS = new Set(['#', '>', '-', '*', '+', ' ']);

export function isPlaceholderTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed === '' || trimmed === UNTITLED_TITLE;
}

/**
 * Reduces a message to something that reads as a name in a narrow list.
 *
 * Returns `null` when there is nothing nameable. `null` means "leave the
 * placeholder alone", never "store an empty title".
 */
export function deriveTitle(text: string): string | null {
  const line = splitLines(text)
    .map(stripMarkdownLeadIn)
    // A fence tells you the language, not the subject.
    .find((candidate) => candidate !== '' && !candidate.startsWith('```'));
  if (line === undefined) return null;

  const collapsed = collapseWhitespace(line);
  if (collapsed === '') return null;
  return truncateTitle(collapsed);
}

/**
 * Mirrors Rust's `str::lines`, which splits on `\n` alone and drops one
 * trailing `\r`. `String.prototype.split('\n')` matches it except for the
 * carriage return, which is handled here.
 */
function splitLines(text: string): string[] {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function stripMarkdownLeadIn(line: string): string {
  const trimmed = line.trim();
  let markerLength = 0;
  while (markerLength < trimmed.length && LEAD_IN_MARKERS.has(trimmed[markerLength] as string)) {
    markerLength += 1;
  }
  if (markerLength > 0) {
    const rest = trimmed.slice(markerLength).trim();
    // A lead-in is separated from its text by a space (`## Why`, `- item`), or
    // it is the whole line (`---`, a rule, which leaves nothing and correctly
    // disqualifies the line). Without that test `-5 degrees` becomes
    // `5 degrees` and `*emphasis* here` loses its first character.
    if (trimmed[markerLength - 1] === ' ' || rest === '') return rest;
  }

  // `1. ` / `12) ` — an ordered-list marker, and nothing else numeric.
  let digits = 0;
  while (digits < trimmed.length && trimmed[digits] !== undefined && /^[0-9]$/.test(trimmed[digits] as string)) {
    digits += 1;
  }
  if (digits > 0) {
    const remainder = trimmed.slice(digits);
    if (remainder.startsWith('. ') || remainder.startsWith(') ')) {
      return remainder.slice(2).trimStart();
    }
  }
  return trimmed;
}

/** Mirrors `split_whitespace().join(" ")`. */
function collapseWhitespace(text: string): string {
  return text.split(/\s+/u).filter((part) => part !== '').join(' ');
}

function truncateTitle(text: string): string {
  // Spread-iteration walks code points, which is what Rust's `chars()` does.
  // `text.length` would count UTF-16 units and cut an emoji in half.
  const points = [...text];
  if (points.length <= MAX_TITLE_CHARS) return text;

  const head = points.slice(0, MAX_TITLE_CHARS).join('');
  const boundary = head.lastIndexOf(' ');
  const cut =
    boundary >= 0 && [...head.slice(0, boundary)].length >= MIN_WORD_BOUNDARY
      ? head.slice(0, boundary)
      : head;

  const trimmed = trimTrailingNoise(cut);
  const stem = trimmed === '' ? head : trimmed;
  return `${stem}…`;
}

function trimTrailingNoise(text: string): string {
  const points = [...text];
  let end = points.length;
  while (end > 0 && TRAILING_NOISE.has(points[end - 1] as string)) {
    end -= 1;
  }
  return points.slice(0, end).join('');
}

/**
 * The alphanumeric runs in a string, lowercased — what the host feeds to FTS5
 * and, in `BrowserAdapter`, what stands in for the index's tokeniser.
 *
 * Exported so the fake tokenises the query and the text it searches the same
 * way. `ftsQuery` is built from this, so the shared fixture pins both.
 */
export function searchTerms(raw: string): string[] {
  return raw
    .split(/[^\p{Alphabetic}\p{N}]+/u)
    .filter((term) => term !== '')
    .map((term) => term.toLowerCase());
}

/**
 * Rewrites what the user typed into an FTS5 expression.
 *
 * Returns `null` when nothing survives — punctuation alone is not a content
 * search. Mirrors `fts_query` in the host; the split is on the Unicode
 * Alphabetic and Number properties because that is what Rust's
 * `char::is_alphanumeric` tests.
 */
export function ftsQuery(raw: string): string | null {
  const terms = searchTerms(raw);
  if (terms.length === 0) return null;

  return terms
    .map((term, index) => (index === terms.length - 1 ? `"${term}"*` : `"${term}"`))
    .join(' AND ');
}
