/**
 * DEFENCE IN DEPTH AGAINST REASONING MARKUP IN THE ANSWER.
 *
 * The host already separates reasoning from the answer, and it does so across
 * frame boundaries — no single stream frame is guaranteed to contain a whole
 * tag. This module re-does that work on the renderer side anyway, on the answer
 * channel only, for one reason: a `<think>` rendered as literal text in the
 * user's answer is the single most visible way this surface can be wrong, and
 * "the layer below promised" is not a defence a user can see.
 *
 * ## What it guarantees
 *
 * 1. **No opening or closing reasoning tag ever reaches the answer**, however
 *    the stream is chopped up. `<thi` + `nk>` across two frames is one tag.
 * 2. **Nothing is discarded.** Text inside an unterminated block is not
 *    dropped — it is routed to the reasoning channel and the caller is told the
 *    block never closed, so the UI can say so and keep it on screen. Swallowing
 *    the answer is the failure this rule exists to prevent; hiding it in a
 *    collapsed panel with no notice would be the same failure wearing a hat.
 * 3. **A second opening tag inside an open block is not an error.** Hostile
 *    endpoints open reasoning twice and never close it; depth is clamped at
 *    one, so the first `</think>` closes it and the answer resumes.
 * 4. **A tag inside code is content, not markup.** See below.
 *
 * ## Why a scanner and not a `replace`
 *
 * `text.replace(/<think>[\s\S]*?<\/think>/g, '')` is the obvious version and it
 * is wrong three ways: it needs the whole document (so it cannot stream), it
 * leaks a lone `<think>` that never closes, and it cannot see a tag split
 * across two calls. The state here is exactly what those three failures need:
 * whether we are inside a block, and the trailing bytes that might yet turn out
 * to be the front of a tag.
 *
 * ## The backtick rule, and the bug that earned it
 *
 * Rendered against a real answer — one *about* reasoning tags, with
 * `` `<think>` `` in a list item and `` `</think>` `` in a table cell — the
 * first version of this scanner ate the second half of the paragraph and the
 * top of the table, and resumed the answer mid-sentence. It was doing exactly
 * what it was told: those are opening and closing tags. They are also, plainly,
 * quoted code.
 *
 * So the scanner counts backticks and recognises no tag while that count is
 * odd. Parity handles inline spans and fences with the same rule and no extra
 * state — an inline `` ` … ` `` is two toggles, and a fence is three at each
 * end, which is likewise a net toggle. Inside code, a tag is emitted verbatim,
 * because that is what the model wrote.
 *
 * The cost is honest and bounded: an endpoint that emits one unbalanced
 * backtick and then a genuine `<think>` gets that tag rendered as text until
 * the backtick balances. That is a cosmetic leak in a defence-in-depth layer,
 * against a *certain* corruption of every answer that quotes a tag — and the
 * host's own splitter, which is the actual protection, is untouched by either.
 */

/** Openers and closers, longest first so `<thinking>` wins over `<think>`. */
const OPEN_TAGS = ['<thinking>', '<think>'] as const;
const CLOSE_TAGS = ['</thinking>', '</think>'] as const;
const ALL_TAGS: readonly string[] = [...OPEN_TAGS, ...CLOSE_TAGS];

/** The longest a held-back suffix can ever be: one tag, minus its last char. */
const MAX_PENDING = Math.max(...ALL_TAGS.map((tag) => tag.length)) - 1;

export interface GuardState {
  /** Inside a reasoning block: text is routed to the reasoning channel. */
  readonly inside: boolean;
  /**
   * Trailing text held back because it might be the front of a tag. Never
   * longer than {@link MAX_PENDING}; released by the next chunk or by
   * {@link flushGuard}.
   */
  readonly pending: string;
  /**
   * An odd number of backticks has been seen, so the scanner is inside code and
   * recognises no tags. Carried across frames like everything else here.
   */
  readonly inCode: boolean;
}

export const GUARD_START: GuardState = { inside: false, pending: '', inCode: false };

export interface GuardOutput {
  readonly state: GuardState;
  /** Text safe to show as the answer. Contains no reasoning markup. */
  readonly answer: string;
  /** Text that belongs to the subordinate reasoning channel. */
  readonly reasoning: string;
}

/**
 * Feeds one stream frame through the guard.
 *
 * Returns only the text this frame resolved; callers append. Whatever is still
 * ambiguous stays in `state.pending` until the next frame or the flush.
 */
export function guardDelta(state: GuardState, chunk: string): GuardOutput {
  const buffer = state.pending + chunk;
  let inside = state.inside;
  let inCode = state.inCode;
  let answer = '';
  let reasoning = '';
  let run = '';
  let index = 0;
  let pending = '';

  const flush = (): void => {
    if (run === '') return;
    if (inside) reasoning += run;
    else answer += run;
    run = '';
  };

  while (index < buffer.length) {
    const char = buffer[index] ?? '';

    if (char === '`') {
      inCode = !inCode;
      run += char;
      index += 1;
      continue;
    }

    // Every tag starts with `<`, so nothing else needs looking at twice.
    if (!inCode && char === '<') {
      const tag = tagAt(buffer, index);
      if (tag !== null) {
        flush();
        // Clamped depth: an opener while already inside is a no-op rather than
        // a nesting level, so the first closer really closes.
        inside = tag.isOpen;
        index += tag.length;
        continue;
      }
      const rest = buffer.slice(index, index + MAX_PENDING + 1);
      const runsToEnd = index + rest.length === buffer.length;
      if (runsToEnd && rest.length <= MAX_PENDING && ALL_TAGS.some((t) => t.startsWith(rest))) {
        pending = rest;
        break;
      }
    }

    run += char;
    index += 1;
  }

  flush();
  return { state: { inside, pending, inCode }, answer, reasoning };
}

export interface GuardFlush {
  readonly answer: string;
  readonly reasoning: string;
  /** The stream ended with a reasoning block still open. */
  readonly unterminated: boolean;
}

/**
 * Ends the stream. Releases whatever was held back — a trailing `<` that turned
 * out to be punctuation is text, not a tag, and dropping it would be data loss.
 */
export function flushGuard(state: GuardState): GuardFlush {
  return {
    answer: state.inside ? '' : state.pending,
    reasoning: state.inside ? state.pending : '',
    unterminated: state.inside,
  };
}

interface TagHit {
  readonly length: number;
  readonly isOpen: boolean;
}

/** The longest tag starting exactly at `index`, or `null`. */
function tagAt(text: string, index: number): TagHit | null {
  for (const tag of ALL_TAGS) {
    if (text.startsWith(tag, index)) {
      return { length: tag.length, isOpen: (OPEN_TAGS as readonly string[]).includes(tag) };
    }
  }
  return null;
}
