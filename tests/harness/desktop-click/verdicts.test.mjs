/**
 * The three ways this harness reported a click that never happened.
 *
 * Every case here failed a critic's review of the first version, and each one
 * would have graded an unwired feature as present — the single failure Wave 2
 * exists to prevent. They are regression cases, so each is written to go red if
 * the fix is reverted, and each carries a control showing the detector is not
 * vacuous.
 *
 * The DOM half runs `page.mjs`'s real bootstrap source in a bare jsdom window.
 * jsdom has no layout, so `getClientRects()` is empty and every query passes
 * `includeHidden` — which costs nothing here, because none of these assertions
 * is about visibility. What they are about is which node the pointer reached,
 * and that is decided from the dispatched event, which jsdom models exactly.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { BOOTSTRAP } from './page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Evaluates the real bootstrap into this jsdom window and hands back the API. */
function install() {
  new Function(`return ${BOOTSTRAP}`)();
  return window.__velaHarness;
}

function dispatchMouseDown(node) {
  node.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
}

describe('a click is only on target when the window says the queried element was hit', () => {
  /** @type {ReturnType<typeof install>} */
  let harness;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="outer">
        <button id="wired"><span id="label">Wired</span></button>
        <button id="inert">Inert</button>
        <div id="veil">veil</div>
      </div>`;
    harness = install();
    harness.armPointerRecorder();
  });

  it('accepts a press on the queried element itself', () => {
    harness.resolve({ selector: '#wired', includeHidden: true });
    dispatchMouseDown(document.getElementById('wired'));

    const hit = harness.pointerHit(0);
    expect(hit.landed).toBe(true);
    expect(hit.onTarget).toBe(true);
    expect(hit.eventTarget).toMatchObject({ tag: 'BUTTON', isQueriedElement: true });
  });

  it('accepts a press on a child of the queried element, which is where a real click lands', () => {
    harness.resolve({ selector: '#wired', includeHidden: true });
    dispatchMouseDown(document.getElementById('label'));

    const hit = harness.pointerHit(0);
    expect(hit.onTarget).toBe(true);
    expect(hit.eventTarget).toMatchObject({ tag: 'SPAN', isQueriedElement: false, isInsideQueried: true });
  });

  /**
   * DEFECT 1. The clause was `hit === el || el.contains(hit) || hit.contains(el)`.
   * The third disjunct is true for every ancestor, and `document.body` is an
   * ancestor of everything — so a button with `pointer-events: none`, which is
   * exactly the shape of a control that is drawn but not wired, was graded as
   * clicked while its handler never ran.
   */
  it('refuses a press that fell through the queried element onto an ancestor', () => {
    harness.resolve({ selector: '#inert', includeHidden: true });
    // What the engine does with `pointer-events: none`: the press is dispatched
    // at whatever is behind, which is the container.
    dispatchMouseDown(document.getElementById('outer'));

    const hit = harness.pointerHit(0);
    expect(hit.landed).toBe(true);
    expect(hit.onTarget).toBe(false);
    expect(hit.eventTarget).toMatchObject({ tag: 'DIV', isQueriedElement: false, isInsideQueried: false });
  });

  it('refuses a press that reached BODY, the ancestor of everything', () => {
    harness.resolve({ selector: '#inert', includeHidden: true });
    dispatchMouseDown(document.body);
    expect(harness.pointerHit(0).onTarget).toBe(false);
  });

  /**
   * CONTROL for defect 1: the relation the removed disjunct tested really is
   * true in these fixtures, so the assertions above are not passing because the
   * scenario is impossible to construct.
   */
  it('CONTROL: the ancestor relation the old clause accepted does hold here', () => {
    const inert = document.getElementById('inert');
    expect(document.body.contains(inert)).toBe(true);
    expect(document.getElementById('outer').contains(inert)).toBe(true);
    // ...and the relation the fix keeps does not.
    expect(inert.contains(document.body)).toBe(false);
    expect(inert.contains(document.getElementById('outer'))).toBe(false);
  });

  /**
   * DEFECT 2. `pointerHit` used to re-run `elementFromPoint` after the settle
   * delay. An overlay that removes itself on `mousedown` is gone by then, so
   * the point resolved to the button underneath and the harness reported a
   * click on a button that was never pressed — with `changed: true` supplied by
   * the overlay's own removal.
   */
  it('refuses a press taken by an overlay that removed itself before the question was asked', () => {
    const veil = document.getElementById('veil');
    veil.addEventListener('mousedown', () => veil.remove());

    harness.resolve({ selector: '#wired', includeHidden: true });
    dispatchMouseDown(veil);

    // The overlay is gone. Anything that re-reads the DOM now sees the button.
    expect(document.getElementById('veil')).toBeNull();

    const hit = harness.pointerHit(0);
    expect(hit.landed).toBe(true);
    expect(hit.onTarget).toBe(false);
    expect(hit.decidedFrom).toBe('the event target captured at mousedown');
    expect(hit.eventTarget).toMatchObject({ tag: 'DIV', isQueriedElement: false });
  });

  it('reports the press as not landed at all when nothing was pressed', () => {
    harness.resolve({ selector: '#wired', includeHidden: true });
    const hit = harness.pointerHit(0);
    expect(hit).toMatchObject({ landed: false, onTarget: null, record: null });
  });

  /**
   * The same defect in `pointFor`, which warns *before* the click rather than
   * judging after it. `coversTarget` must mean "this pixel belongs to the
   * queried element", not "the queried element is somewhere below whatever owns
   * it".
   *
   * jsdom has no layout, so `elementFromPoint` is stubbed to name the topmost
   * element directly. That is the whole input to the clause under test — the
   * stub supplies the answer a real engine would compute, and nothing else.
   */
  it('pointFor calls a pixel covered only when the topmost element is the target or inside it', () => {
    // Also absent from jsdom, and called on the way to the measurement.
    window.Element.prototype.scrollIntoView = function scrollIntoView() {};

    const topmostIs = (node) => {
      document.elementFromPoint = () => node;
      harness.resolve({ selector: '#wired', includeHidden: true });
      return harness.pointFor(0).topmostAtPoint;
    };

    expect(topmostIs(document.getElementById('wired'))).toMatchObject({
      tag: 'BUTTON',
      coversTarget: true,
    });
    expect(topmostIs(document.getElementById('label'))).toMatchObject({
      tag: 'SPAN',
      coversTarget: true,
    });
    // The ancestor cases: both were reported as covering the target before.
    expect(topmostIs(document.body)).toMatchObject({ tag: 'BODY', coversTarget: false });
    expect(topmostIs(document.getElementById('outer'))).toMatchObject({
      tag: 'DIV',
      coversTarget: false,
    });
    // And a sibling that has nothing to do with it.
    expect(topmostIs(document.getElementById('veil'))).toMatchObject({
      tag: 'DIV',
      coversTarget: false,
    });
  });
});

/**
 * DEFECT 3, guarded at the source rather than at runtime, because the runtime
 * symptom is silence.
 *
 * Windows PowerShell 5.1 discards a write to a nested value-type field:
 * `$input.mi.dwFlags = 2` mutates a temporary copy of `mi`. Every `INPUT` this
 * harness sent was therefore all-zero, `SendInput` accepted the count and
 * delivered nothing, and the harness concluded — and told six other tracks —
 * that injected input is filtered on this machine. It is not. The struct was
 * empty. A `.ps1` is not executed by any test, so the guard reads the file.
 */
describe('no INPUT struct is ever assembled in PowerShell', () => {
  const source = readFileSync(join(HERE, 'os-input.ps1'), 'utf8');

  /**
   * A PowerShell assignment to a field of a field: `$x.y.z = ...`. This is the
   * shape that silently does nothing on a value type. Written as a function so
   * the control below can drive it with the defect's own bytes.
   *
   * **The nesting is `{2,}`, not exactly two.** The first version of this
   * detector required exactly three dotted components before the `=`, so it
   * matched `$down.mi.dwFlags = ...` and did **not** match
   * `$down.u.ki.wVk = ...`. That fourth level became reachable the moment the
   * INPUT struct grew a real union — which is what the keyboard path needed —
   * so the detector was one notch narrower than the defect it guards. The
   * control below drives it with both depths.
   */
  const nestedFieldAssignments = (text) =>
    text
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => /^\$[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*){2,}\s*=[^=]/.test(line))
      .map(({ line, number }) => `os-input.ps1:${number} — ${line}`);

  it('assigns no nested value-type field from PowerShell', () => {
    expect(
      nestedFieldAssignments(source),
      'PowerShell 5.1 silently discards these. Build the struct inside the Add-Type C# block and ' +
        'take the flags as parameters.',
    ).toEqual([]);
  });

  it('CONTROL: the detector catches the exact lines that shipped the defect', () => {
    const defect = [
      '    $move = New-Object VelaOsInput+INPUT',
      '    $move.type = [VelaOsInput]::INPUT_MOUSE',
      '    $move.mi.dwFlags = [VelaOsInput]::MOUSEEVENTF_MOVE -bor [VelaOsInput]::MOUSEEVENTF_ABSOLUTE',
      '    $move.mi.dx = 32768',
      '    $down.mi.dwFlags = [VelaOsInput]::MOUSEEVENTF_LEFTDOWN',
    ].join('\n');
    const caught = nestedFieldAssignments(defect);
    expect(caught).toHaveLength(3);
    expect(caught[0]).toContain('$move.mi.dwFlags');
    // And it does not fire on the single-level assignment beside it, which is
    // legal: `$move.type` is a field of the struct itself, not of a nested one.
    expect(nestedFieldAssignments('$move.type = 0')).toEqual([]);
  });

  it('CONTROL: it also catches the union depth the keyboard path made reachable', () => {
    // `$x.u.ki.wVk` is four dotted components, not three. The original detector
    // required exactly three and would have let every one of these through —
    // and an all-zero KEYBDINPUT is `wVk=0`, which SendInput accepts and which
    // delivers a keystroke for virtual key 0, indistinguishable at the return
    // value from a working call.
    const unionDefect = [
      '    $press = New-Object VelaOsInput+INPUT',
      '    $press.type = [VelaOsInput]::INPUT_KEYBOARD',
      '    $press.u.ki.wVk = 13',
      '    $press.u.ki.dwFlags = 0',
      '    $press.u.mi.dx = 32768',
    ].join('\n');
    const caught = nestedFieldAssignments(unionDefect);
    expect(caught).toHaveLength(3);
    expect(caught[0]).toContain('$press.u.ki.wVk');
    expect(caught[2]).toContain('$press.u.mi.dx');
    // The narrower regex that shipped at the tag. Kept here as the measurement
    // behind the claim above rather than as a comment asserting it.
    const tagRegex = /^\$[A-Za-z_][\w]*\.[A-Za-z_][\w]*\.[A-Za-z_][\w]*\s*=[^=]/;
    expect(tagRegex.test('$press.u.ki.wVk = 13')).toBe(false);
    expect(tagRegex.test('$move.mi.dwFlags = 2')).toBe(true);
  });

  /**
   * The keyboard half, which did not exist at the tag: `ValidateSet` was
   * `raise|selftest|sendinput|message`, the legacy keybd_event entry point
   * appeared only as the ALT tap that unblocks SetForegroundWindow, and
   * `type`/`key` were pure CDP.
   * Every `reaches-user` claim that involved typing anything was therefore
   * CDP-substituted.
   */
  it('assembles every keyboard INPUT in C#, with the union declared rather than assumed', () => {
    expect(source).toContain('public struct KEYBDINPUT');
    expect(source).toContain('[StructLayout(LayoutKind.Explicit)]');
    expect(source).toContain('private static INPUT Key(ushort vk, ushort scan, uint flags)');
    expect(source).toContain('public static uint PressSequence(');
    // The keyboard equivalents of `structAsBuilt` and of the self-test, so an
    // empty or mis-aligned struct can never be read as a filtered environment.
    expect(source).toContain('DescribeKeyInput');
    expect(source).toContain('public static string Offsets()');
    expect(source).toContain('KeyboardSelfTest');
  });

  it('proves keyboard delivery by reading the key state back, not by trusting SendInput', () => {
    // SendInput returns the count it was handed whether or not anything is
    // delivered. GetAsyncKeyState reads the global async key state, which the
    // raw input thread maintains, so it needs no message pump in a console
    // process.
    expect(source).toContain('GetAsyncKeyState');
    expect(source).toContain('keyboardInjectionWorks');
    // And the caller refuses rather than proceeding when it did not observe it.
    expect(source).toContain('$selfTest.keyboardInjectionWorks');
  });

  it('does not use the PowerShell 7 ternary, which is a parse error under 5.1', () => {
    // `cond ? a : b` parses in PowerShell 7 and is a syntax error in Windows
    // PowerShell 5.1, which is what runs this file (5.1.26100.9168 measured on
    // this machine). A parse error here would take the whole script out, not
    // just the branch.
    const ternaries = source
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => !line.startsWith('#') && !line.startsWith('//') && !line.startsWith('///'))
      .filter(({ line }) => /\)\s*\?\s*[^?:]+\s*:\s/.test(line))
      .map(({ line, number }) => `os-input.ps1:${number} — ${line}`);
    expect(ternaries).toEqual([]);
  });

  it('keeps every string literal ASCII, because this file has no BOM', () => {
    // Windows PowerShell 5.1 reads a BOM-less .ps1 as the system ANSI code
    // page. A UTF-8 em dash decodes under cp1252 to `â€"`, whose last byte is
    // U+201D — a right double quotation mark, which PowerShell accepts as a
    // string delimiter. An em dash inside a double-quoted string therefore
    // CLOSES the string, and the rest of the line becomes bare tokens. That
    // happened while writing the keyboard modes and took the whole file out
    // with "Unexpected token 'it'". Comments are unaffected, which is why the
    // ones at the top of this file have survived.
    expect(source.charCodeAt(0)).not.toBe(0xfeff);
    const offenders = source
      .split('\n')
      // The trailing CR of a CRLF line is itself outside the printable range,
      // and this tree is `core.autocrlf=true` with no `* text=auto`, so the
      // working copy has CRLF and a naive detector flags every single line.
      .map((raw, index) => ({ line: raw.replace(/\r$/, ''), number: index + 1 }))
      .filter(({ line }) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('///')) return false;
        // Only lines that open a quote can be broken by one.
        if (!/['"]/.test(line)) return false;
        return /[^\x20-\x7e\t]/.test(line);
      })
      .map(({ line, number }) => `os-input.ps1:${number} — ${line.trim()}`);
    expect(
      offenders,
      'a non-ASCII character inside a quoted string in a BOM-less .ps1 read as cp1252 can ' +
        'terminate the string. Use ASCII, or give the file a BOM.',
    ).toEqual([]);
  });

  it('builds every INPUT in C#, and exposes the bytes so an empty one is visible', () => {
    expect(source).toContain('private static INPUT Mouse(uint flags, int dx, int dy)');
    expect(source).toContain('public static uint MoveAbsolute(int nx, int ny)');
    expect(source).toContain('public static uint LeftClick()');
    // The self-test reports what it built, so "SendInput did nothing" can be
    // told apart from "the struct was empty" without guessing.
    expect(source).toContain('DescribeMouseInput');
    expect(source).toContain('structAsBuilt');
  });

  it('claims nothing about mouse_event, which this file does not import', () => {
    // The first version of the README asserted that the legacy entry point
    // "behaves the same way". Nothing here ever called it.
    const importsMouseEvent = /DllImport[^\n]*\n[^\n]*mouse_event/.test(source);
    expect(importsMouseEvent).toBe(false);
    const readme = readFileSync(join(HERE, 'README.md'), 'utf8');
    expect(readme).not.toContain('mouse_event');
    expect(readme.toLowerCase()).not.toContain('sendinput` is inert');
  });
});
