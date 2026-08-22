/**
 * Character → key-event mapping for the desktop click harness.
 *
 * ## The defect this file exists to close
 *
 * `keySpecFor` used to derive the Windows virtual-key code from the character
 * itself: `keyCode: name.toUpperCase().charCodeAt(0)`. ASCII and the Windows
 * VK space agree only on `0`–`9` (0x30–0x39) and `A`–`Z` (0x41–0x5A). Every
 * other printable character therefore shipped a virtual-key code belonging to a
 * *different physical key*, and the entire ASCII punctuation run `!` through `/`
 * (33–47) lands exactly on the VK navigation/editing block:
 *
 *     33 '!' → VK_PRIOR    38 '&' → VK_UP      43 '+' → VK_EXECUTE
 *     34 '"' → VK_NEXT     39 '\'' → VK_RIGHT  44 ',' → VK_SNAPSHOT
 *     35 '#' → VK_END      40 '(' → VK_DOWN    45 '-' → VK_INSERT
 *     36 '$' → VK_HOME     41 ')' → VK_SELECT  46 '.' → VK_DELETE
 *     37 '%' → VK_LEFT     42 '*' → VK_PRINT   47 '/' → VK_HELP
 *
 * Chromium's `EditingBehavior::InterpretKeyEvent` looks an editing command up by
 * `windowsKeyCode`, executes it on the keydown, and — when a command runs — the
 * keydown counts as handled, so the character event that would have inserted the
 * text never fires. A `.` therefore forward-deleted instead of typing a period:
 * `Local llama.cpp` arrived as `Local llamacpp` and `127.0.0.1:8033` as
 * `127001:8033`. Both were observed against a real window; `keys.test.mjs`
 * reproduces both byte-for-byte from this table.
 *
 * ## What is here instead
 *
 * The US layout, written out as physical keys. A spec is looked up, never
 * computed, so a character that is not on the layout cannot be given a plausible
 * wrong answer — `keySpecFor` throws and names `--insert-text`, which puts text
 * in a field without synthesising key events at all. Silence is the one failure
 * mode this instrument cannot afford: it is the only source of `reaches-user`
 * evidence on this project, and a corrupted keystroke makes a working form look
 * broken and a broken form look like a typo.
 */

import { EXIT, HarnessError } from './cdp.mjs';

/**
 * Keys addressed by name. `Input.dispatchKeyEvent` needs `text` for anything
 * that should produce input — Enter is `"\r"`, not `"\n"` and not omitted —
 * which has cost this project time before, so the mapping is a table rather
 * than a guess.
 */
export const NAMED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8, text: '\b' },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

/**
 * The US layout as physical keys: `[code, windowsVirtualKeyCode, unshifted,
 * shifted]`. The VK codes for the OEM keys are the documented constants
 * (`VK_OEM_1` = 0xBA … `VK_OEM_7` = 0xDE) — they are not derivable from the
 * character, which is the whole point of writing them down.
 *
 * Every printable ASCII character (0x20–0x7E) appears exactly once as either an
 * unshifted or a shifted legend; `keys.test.mjs` asserts that coverage rather
 * than trusting this comment.
 */
const US_LAYOUT = [
  ['Space', 32, ' ', null],
  ['Backquote', 192, '`', '~'], // VK_OEM_3
  ['Digit1', 49, '1', '!'],
  ['Digit2', 50, '2', '@'],
  ['Digit3', 51, '3', '#'],
  ['Digit4', 52, '4', '$'],
  ['Digit5', 53, '5', '%'],
  ['Digit6', 54, '6', '^'],
  ['Digit7', 55, '7', '&'],
  ['Digit8', 56, '8', '*'],
  ['Digit9', 57, '9', '('],
  ['Digit0', 48, '0', ')'],
  ['Minus', 189, '-', '_'], // VK_OEM_MINUS
  ['Equal', 187, '=', '+'], // VK_OEM_PLUS
  ['BracketLeft', 219, '[', '{'], // VK_OEM_4
  ['BracketRight', 221, ']', '}'], // VK_OEM_6
  ['Backslash', 220, '\\', '|'], // VK_OEM_5
  ['Semicolon', 186, ';', ':'], // VK_OEM_1
  ['Quote', 222, "'", '"'], // VK_OEM_7
  ['Comma', 188, ',', '<'], // VK_OEM_COMMA
  ['Period', 190, '.', '>'], // VK_OEM_PERIOD
  ['Slash', 191, '/', '?'], // VK_OEM_2
];

for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(0x61 + i);
  const upper = String.fromCharCode(0x41 + i);
  US_LAYOUT.push([`Key${upper}`, 0x41 + i, lower, upper]);
}

/** @type {Map<string, {key: string, code: string, keyCode: number, text: string, shiftKey: boolean}>} */
const CHARACTER_KEYS = new Map();
for (const [code, keyCode, plain, shifted] of US_LAYOUT) {
  CHARACTER_KEYS.set(plain, { key: plain, code, keyCode, text: plain, shiftKey: false });
  if (shifted !== null) {
    CHARACTER_KEYS.set(shifted, { key: shifted, code, keyCode, text: shifted, shiftKey: true });
  }
}

/** Every character this harness can press, sorted. Used by the coverage guard. */
export function typeableCharacters() {
  return [...CHARACTER_KEYS.keys()].sort();
}

/** Readable form of a character for an error message: `"é" (U+00E9)`. */
function describeCharacter(character) {
  const point = character.codePointAt(0) ?? 0;
  return `"${character}" (U+${point.toString(16).toUpperCase().padStart(4, '0')})`;
}

/**
 * The characters in `text` that have no key on the layout, in order of first
 * appearance. Callers use this to refuse the whole string before touching the
 * window: a half-typed field is worse evidence than an untouched one.
 */
export function unmappableCharacters(text) {
  const bad = [];
  for (const character of text) {
    if (!CHARACTER_KEYS.has(character) && !bad.includes(character)) bad.push(character);
  }
  return bad;
}

/**
 * The key spec for a named key (`Enter`) or a single character (`.`).
 *
 * Throws rather than inventing a virtual-key code. `hasOwnProperty` matters:
 * plain member access answered `NAMED_KEYS['constructor']` with a function,
 * whose `.key`, `.code` and `.keyCode` are all `undefined`.
 */
export function keySpecFor(name) {
  if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, name)) return NAMED_KEYS[name];
  if ([...String(name)].length === 1) {
    const spec = CHARACTER_KEYS.get(name);
    if (spec) return spec;
    throw new HarnessError(
      EXIT.USAGE,
      `no US-layout key produces ${describeCharacter(name)}, and this harness will not guess a ` +
        'virtual-key code for it — a wrong one runs an editing command instead of typing. Use ' +
        '`type --insert-text`, which inserts the string without synthesising key events.',
      { character: name, codePoint: name.codePointAt(0) ?? null },
    );
  }
  throw new HarnessError(
    EXIT.USAGE,
    `unknown key "${name}". Known: ${Object.keys(NAMED_KEYS).join(', ')}, or a single character ` +
      'on the US layout.',
  );
}
