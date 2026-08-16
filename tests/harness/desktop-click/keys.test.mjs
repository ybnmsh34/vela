/**
 * The harness could not type an IP address.
 *
 * `keySpecFor` derived the Windows virtual-key code from the character:
 * `keyCode: name.toUpperCase().charCodeAt(0)`. ASCII and the Windows VK space
 * agree only on `0`–`9` and `A`–`Z`. `.` is 46, which is `VK_DELETE`; Chromium
 * looks an editing command up by `windowsKeyCode`, runs `DeleteForward` on the
 * keydown, and — because the keydown counted as handled — never fires the
 * character event that would have inserted the period. Two strings observed
 * against a real window: `Local llama.cpp` arrived as `Local llamacpp`, and
 * `127.0.0.1:8033` as `127001:8033`.
 *
 * This matters beyond one character. This harness is the only instrument on
 * this project that can produce `reaches-user` evidence, so a corrupted
 * keystroke manufactures false evidence in *both* directions: a field holding
 * `127001:8033` makes a working form look broken, and a caret command that eats
 * the next character makes a broken form look like a typo.
 *
 * ## What each group here actually bites on
 *
 * 1. **Table** — pure-function assertions on `keySpecFor`. No DOM, no browser,
 *    no model. These are the ones that go red on the mapping itself.
 * 2. **Round trip** — the three strings, driven through a *model* of Chromium's
 *    keydown → editing-command → character pipeline into a real jsdom `<input>`,
 *    asserting on `input.value` afterwards. The model is not Chromium and does
 *    not claim to be; its calibration is that, driven by the *old* mapping, it
 *    reproduces both field-observed corruptions byte-for-byte from nothing but
 *    the VK table. That reproduction is a CONTROL below, and it is a control
 *    rather than a regression test because it carries its own copy of the old
 *    mapping and therefore cannot go red when the fix is reverted.
 * 3. **Route** — source guards on `vela-drive.mjs`, because `Input.insertText`
 *    and the pre-flight refusal are CDP calls that no test here can execute.
 *    They go red on `vela-drive.mjs`, not on `keys.mjs`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { NAMED_KEYS, keySpecFor, typeableCharacters, unmappableCharacters } from './keys.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every printable ASCII character, 0x20–0x7E. */
const PRINTABLE = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i));

/**
 * Windows virtual-key codes in the ASCII-printable range that belong to a
 * *non-character* key. Anything in `!`…`/` (33–47) lands in here, which is why
 * the defect was never about `.` alone.
 */
const NON_CHARACTER_VK = {
  8: 'VK_BACK',
  9: 'VK_TAB',
  13: 'VK_RETURN',
  27: 'VK_ESCAPE',
  33: 'VK_PRIOR (PageUp)',
  34: 'VK_NEXT (PageDown)',
  35: 'VK_END',
  36: 'VK_HOME',
  37: 'VK_LEFT',
  38: 'VK_UP',
  39: 'VK_RIGHT',
  40: 'VK_DOWN',
  41: 'VK_SELECT',
  42: 'VK_PRINT',
  43: 'VK_EXECUTE',
  44: 'VK_SNAPSHOT (PrintScreen)',
  45: 'VK_INSERT',
  46: 'VK_DELETE',
  47: 'VK_HELP',
};

// ---------------------------------------------------------------------------
// 1. the table
// ---------------------------------------------------------------------------

describe('the character → virtual-key table', () => {
  /**
   * The reported defect, named exactly. `VK_OEM_PERIOD` is 0xBE; 46 is
   * `VK_DELETE` and is what `'.'.charCodeAt(0)` answers.
   */
  it('gives "." VK_OEM_PERIOD (190), not VK_DELETE (46)', () => {
    expect(keySpecFor('.')).toEqual({
      key: '.',
      code: 'Period',
      keyCode: 190,
      text: '.',
      shiftKey: false,
    });
    expect(keySpecFor('.').keyCode).not.toBe(NAMED_KEYS.Delete.keyCode);
  });

  /**
   * The general form. Every character whose code point falls in 33–47 used to
   * press a navigation or editing key; `:` `;` `<` `=` `>` `?` `@` `[` `\` `]`
   * `^` `_` `` ` `` `{` `|` `}` `~` used to press virtual-key codes that are
   * unassigned on Windows.
   */
  it('gives no printable character the virtual-key code of a non-character key', () => {
    const offenders = PRINTABLE.filter((character) => {
      const { keyCode } = keySpecFor(character);
      // Space really is VK_SPACE (32), which is a character key.
      return character !== ' ' && NON_CHARACTER_VK[keyCode] !== undefined;
    }).map((character) => `${JSON.stringify(character)} → ${NON_CHARACTER_VK[keySpecFor(character).keyCode]}`);

    expect(
      offenders,
      'a character carrying a navigation/editing virtual-key code runs that command on keydown ' +
        'instead of typing, and Chromium then suppresses the character event',
    ).toEqual([]);
  });

  /** `code` is the physical key. `Digit.` and `Digit@` are not codes at all. */
  it('gives every printable character a real KeyboardEvent code', () => {
    const legal = new Set([
      'Space',
      'Backquote',
      'Minus',
      'Equal',
      'BracketLeft',
      'BracketRight',
      'Backslash',
      'Semicolon',
      'Quote',
      'Comma',
      'Period',
      'Slash',
      ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
      ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(0x41 + i)}`),
    ]);
    const wrong = PRINTABLE.map((character) => [character, keySpecFor(character).code]).filter(
      ([, code]) => !legal.has(code),
    );
    expect(wrong).toEqual([]);
  });

  /**
   * A shifted legend is not reachable without shift, and a handler reading
   * `event.shiftKey` on `@` or `:` used to see `false`.
   */
  it('sets shiftKey exactly on the shifted legends', () => {
    const shifted = PRINTABLE.filter((character) => keySpecFor(character).shiftKey).join('');
    expect(shifted).toBe('!"#$%&()*+:<>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ^_{|}~');
    // ...and the unshifted half is everything else, with nothing left over.
    const plain = PRINTABLE.filter((character) => !keySpecFor(character).shiftKey).join('');
    expect(plain).toBe(" ',-./0123456789;=[\\]`abcdefghijklmnopqrstuvwxyz");
    expect(shifted.length + plain.length).toBe(95);
  });

  it('covers every printable ASCII character exactly once, and nothing else', () => {
    expect(typeableCharacters()).toEqual([...PRINTABLE].sort());
    expect(typeableCharacters()).toHaveLength(95);
  });

  /** Two characters on one key must differ only by shift. */
  it('maps each (virtual-key code, shift) pair to one character', () => {
    const seen = new Map();
    const collisions = [];
    for (const character of PRINTABLE) {
      const spec = keySpecFor(character);
      const slot = `${spec.keyCode}/${spec.shiftKey}`;
      if (seen.has(slot)) collisions.push(`${slot}: ${seen.get(slot)} and ${character}`);
      seen.set(slot, character);
    }
    expect(collisions).toEqual([]);
  });

  /**
   * The safety property. A character with no key on the layout must produce an
   * error, never a plausible-looking spec: this is what stops a caller getting
   * silent corruption by default.
   */
  it('refuses a character no US-layout key produces, instead of guessing', () => {
    for (const character of ['é', '£', '—', '😀', '\t', '\n']) {
      expect(() => keySpecFor(character), JSON.stringify(character)).toThrow(/no US-layout key/);
    }
    // Space is on the layout and must still work — the guard is not "refuse
    // anything unfamiliar".
    expect(keySpecFor(' ')).toEqual({ key: ' ', code: 'Space', keyCode: 32, text: ' ', shiftKey: false });
    // And the error points at the route that can carry it.
    expect(() => keySpecFor('é')).toThrow(/--insert-text/);
  });

  it('reports every unmappable character in a string, in order, before anything is typed', () => {
    expect(unmappableCharacters('127.0.0.1:8033')).toEqual([]);
    expect(unmappableCharacters('Local llama.cpp')).toEqual([]);
    expect(unmappableCharacters('café — 5£')).toEqual(['é', '—', '£']);
  });

  /** `NAMED_KEYS[name]` answered `Object.prototype` members with a function. */
  it('does not answer a prototype member as if it were a key', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(() => keySpecFor(name), name).toThrow(/unknown key/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. the round trip
// ---------------------------------------------------------------------------

/**
 * The editing commands Chromium binds to a bare (unmodified) virtual-key code
 * in `EditingBehavior::InterpretKeyEvent`. When one of these runs, the keydown
 * is handled and the character event never fires — the character is not typed.
 *
 * Only the commands this file actually exercises are modelled. The rest of the
 * 33–47 block is covered by the pure-function guard above, which needs no claim
 * about what each command does — only that a printable character must not carry
 * that virtual-key code at all.
 */
const BARE_EDITING_COMMAND = {
  8: ['DeleteBackward', (el) => replaceRange(el, Math.max(0, caret(el) - 1), caret(el), '')],
  35: ['MoveToEndOfLine', (el) => setCaret(el, el.value.length)],
  36: ['MoveToBeginningOfLine', (el) => setCaret(el, 0)],
  37: ['MoveLeft', (el) => setCaret(el, Math.max(0, caret(el) - 1))],
  39: ['MoveRight', (el) => setCaret(el, Math.min(el.value.length, caret(el) + 1))],
  46: ['DeleteForward', (el) => replaceRange(el, caret(el), Math.min(el.value.length, caret(el) + 1), '')],
};

const caret = (el) => el.selectionStart ?? el.value.length;
const setCaret = (el, at) => el.setSelectionRange(at, at);

function replaceRange(el, start, end, text) {
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  setCaret(el, start + text.length);
}

/**
 * Types `text` into `el` one key at a time using `specFor`, modelling
 * Chromium's dispatch: a real DOM keydown is fired for every character, and
 * then either the editing command bound to that virtual-key code runs, or the
 * character is inserted at the caret.
 *
 * Returns what the element holds afterwards — the thing under test is the
 * field's value, not the string that was requested.
 */
function typeInto(el, text, specFor) {
  const keydowns = [];
  const record = (event) =>
    keydowns.push({
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      shiftKey: event.shiftKey,
    });
  el.addEventListener('keydown', record);
  try {
    for (const character of text) {
      const spec = specFor(character);
      el.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: spec.key,
          code: spec.code,
          keyCode: spec.keyCode,
          which: spec.keyCode,
          shiftKey: Boolean(spec.shiftKey),
          bubbles: true,
          cancelable: true,
        }),
      );
      const command = BARE_EDITING_COMMAND[spec.keyCode];
      if (command) {
        command[1](el);
        continue;
      }
      if (spec.text !== undefined) replaceRange(el, caret(el), el.selectionEnd ?? caret(el), spec.text);
    }
  } finally {
    el.removeEventListener('keydown', record);
  }
  return { value: el.value, keydowns };
}

/** `keySpecFor` as it shipped, for the calibration control only. */
function shippedKeySpecFor(character) {
  const upper = character.toUpperCase();
  return {
    key: character,
    code: /[a-z]/i.test(character) ? `Key${upper}` : `Digit${character}`,
    keyCode: upper.charCodeAt(0),
    text: character,
  };
}

describe('the strings a user actually types reach the field intact', () => {
  /** A fresh, empty, focused-equivalent input for each case. */
  function field() {
    document.body.innerHTML = '<input id="endpoint" type="text" />';
    const el = document.getElementById('endpoint');
    el.setSelectionRange(0, 0);
    return el;
  }

  /**
   * CONTROL, and the model's calibration. Driven by the mapping that shipped,
   * the model reproduces both strings that were observed coming out of a real
   * window — from nothing but the virtual-key codes. That is the evidence that
   * the model's account of the pipeline is the right one.
   *
   * It cannot go red when the fix is reverted, because it carries its own copy
   * of the old mapping. It is a control, not a regression test.
   */
  it('CONTROL: the shipped mapping reproduces both field-observed corruptions', () => {
    expect(typeInto(field(), '127.0.0.1:8033', shippedKeySpecFor).value).toBe('127001:8033');
    expect(typeInto(field(), 'Local llama.cpp', shippedKeySpecFor).value).toBe('Local llamacpp');
  });

  /**
   * CONTROL: the same model, same mapping, on two further corruption classes —
   * a caret command that survives and eats the *position* rather than the
   * character. This is the direction that makes a working form look broken.
   */
  it('CONTROL: the shipped mapping also moved the caret mid-string', () => {
    // '%' is 37, VK_LEFT → MoveLeft.
    expect(typeInto(field(), '50%off', shippedKeySpecFor).value).toBe('5off0');
    // "'" is 39, VK_RIGHT → MoveRight, which eats nothing at the end of a field
    // and is therefore invisible until it is not at the end.
    expect(typeInto(field(), "it's", shippedKeySpecFor).value).toBe('its');
  });

  it('CONTROL: the model inserts a character that carries no editing command', () => {
    // Guards against a model that simply drops everything: with the mapping
    // fixed there is no command in the way, and the same code path types.
    expect(typeInto(field(), 'abc', keySpecFor).value).toBe('abc');
  });

  it('127.0.0.1:8033 — the most common real endpoint a user configures', () => {
    const el = field();
    const { value } = typeInto(el, '127.0.0.1:8033', keySpecFor);
    expect(el.value).toBe('127.0.0.1:8033');
    expect(value).toBe('127.0.0.1:8033');
  });

  it('http://localhost:8033/v1 — round trips, and every keydown is the right key', () => {
    const el = field();
    const { keydowns } = typeInto(el, 'http://localhost:8033/v1', keySpecFor);
    expect(el.value).toBe('http://localhost:8033/v1');

    // This string is the one whose *text* survived the old mapping: ':' (58)
    // and '/' (47) carry no bare editing command, so they inserted anyway. Its
    // corruption was in the events, so that is what this asserts.
    expect(keydowns.filter((event) => event.key === ':')).toEqual([
      { key: ':', code: 'Semicolon', keyCode: 186, shiftKey: true },
      { key: ':', code: 'Semicolon', keyCode: 186, shiftKey: true },
    ]);
    expect(keydowns.filter((event) => event.key === '/')).toEqual([
      { key: '/', code: 'Slash', keyCode: 191, shiftKey: false },
      { key: '/', code: 'Slash', keyCode: 191, shiftKey: false },
      { key: '/', code: 'Slash', keyCode: 191, shiftKey: false },
    ]);
    expect(keydowns[0]).toEqual({ key: 'h', code: 'KeyH', keyCode: 72, shiftKey: false });
  });

  it('Local llama.cpp — the endpoint name from the audit', () => {
    const el = field();
    typeInto(el, 'Local llama.cpp', keySpecFor);
    expect(el.value).toBe('Local llama.cpp');
    expect(el.value).not.toBe('Local llamacpp');
  });

  /** Typing into the middle of an existing value, where a caret command shows. */
  it('inserts at the caret without disturbing what is already in the field', () => {
    const el = field();
    el.value = '127.0.0.1';
    el.setSelectionRange(3, 3);
    typeInto(el, '.50', keySpecFor);
    expect(el.value).toBe('127.50.0.0.1');
  });

  /** Every shifted symbol that appears in a URL, a key, or a model name. */
  it('round trips the punctuation the rest of Vela puts in a field', () => {
    const el = field();
    const value = 'sk-ant_api03/A+b=C?d&e#f@g:h,i;j.k~l`m^n%o$p!q(r)s*t[u]v{w}x|y\\z"\'<>_-';
    typeInto(el, value, keySpecFor);
    expect(el.value).toBe(value);
  });
});

// ---------------------------------------------------------------------------
// 3. the route
// ---------------------------------------------------------------------------

/**
 * `Input.insertText` and the pre-flight refusal are CDP calls against a live
 * window, which nothing in this suite may open. They are guarded at the source,
 * the same way `os-input.ps1` is in `verdicts.test.mjs`: the runtime symptom of
 * losing either one is silence.
 */
describe('typing has two routes, and the silent one is never the default', () => {
  const source = readFileSync(join(HERE, 'vela-drive.mjs'), 'utf8');
  /** Just `commands.type`, so an `indexOf` cannot answer from another command. */
  const typeCommand = (() => {
    const from = source.indexOf('commands.type = async');
    const to = source.indexOf('commands.key = async');
    expect(from, 'commands.type not found').toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return source.slice(from, to);
  })();

  it('types with key events unless --insert-text is asked for', () => {
    expect(typeCommand).toContain("const insertText = Boolean(flags['insert-text']);");
    expect(typeCommand).toContain("await cdp.send('Input.insertText', { text });");
    // The key path is the `else`: insertion is the exception, not the fallback.
    expect(typeCommand).toMatch(
      /if \(insertText\) \{[\s\S]*?\} else \{[\s\S]*?pressKey\(cdp, keySpecFor\(character\)\)/,
    );
  });

  it('refuses an unmappable string before the window is touched', () => {
    // The check must come before `attach`, or a failure leaves a half-typed
    // field for the next command to read as evidence.
    const check = typeCommand.indexOf('unmappableCharacters(text)');
    const attach = typeCommand.indexOf('await attach(session)');
    expect(check, 'no pre-flight check on the string to be typed').toBeGreaterThan(-1);
    expect(attach).toBeGreaterThan(-1);
    expect(check).toBeLessThan(attach);
    expect(typeCommand).toContain('--insert-text to insert it');
  });

  it('says in its own output which route ran, so a transcript cannot be misread', () => {
    expect(source).toContain('no key events at all');
    expect(source).toContain('keyEvents: !insertText');
  });

  it('carries the key spec shift bit onto the wire', () => {
    expect(source).toContain('const effective = modifiers | (spec.shiftKey ? MODIFIER_BITS.shift : 0);');
    expect(source).toContain('modifiers: effective,');
  });

  /**
   * The defect as a shape. `charCodeAt` is how it was written; the table in
   * `keys.mjs` is the only legitimate source of a `keyCode` and contains no
   * call. Comment lines are skipped, because both files *quote* the defect in
   * prose on purpose — the control below drives the detector with real code so
   * that skipping comments cannot be what makes this pass.
   */
  const derivedKeyCodes = (text, file) =>
    text
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'))
      .filter(({ line }) => /charCodeAt/.test(line))
      .map(({ line, number }) => `${file}:${number} — ${line}`);

  it('derives no virtual-key code from a character, in either file', () => {
    const found = ['vela-drive.mjs', 'keys.mjs'].flatMap((file) =>
      derivedKeyCodes(readFileSync(join(HERE, file), 'utf8'), file),
    );
    expect(
      found,
      'a virtual-key code derived from the character it types is the defect this branch closed: ' +
        'ASCII and the Windows VK space agree only on 0-9 and A-Z',
    ).toEqual([]);
  });

  it('CONTROL: the detector catches the exact line that shipped the defect', () => {
    const defect = [
      '  if (name.length === 1) {',
      '    const upper = name.toUpperCase();',
      '    return {',
      '      keyCode: upper.charCodeAt(0),',
      '    };',
    ].join('\n');
    const caught = derivedKeyCodes(defect, 'vela-drive.mjs');
    expect(caught).toHaveLength(1);
    expect(caught[0]).toBe('vela-drive.mjs:4 — keyCode: upper.charCodeAt(0),');
    // And it is not fooled by the same bytes inside a comment, which is the
    // only reason the assertion above is allowed to skip them.
    expect(derivedKeyCodes(' * keyCode: upper.charCodeAt(0)', 'x')).toEqual([]);
  });

  it('documents --insert-text where a caller reading --help will see it', () => {
    expect(source).toContain('--insert-text');
    expect(source).toContain('fires NO');
  });
});
