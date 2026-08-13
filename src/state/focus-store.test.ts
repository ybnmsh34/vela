/**
 * The focus ladder itself, below the level the assembled-app tests reach.
 *
 * `focus-ownership.test.tsx` drives `<App/>` and proves the four interactions
 * land where they should. What it cannot easily stage is the *bottom* of the
 * ladder — a composer that exists but is `disabled` because no model is chosen,
 * which is the one real situation where `ground` is the answer — or the reason
 * each rung is skipped. Those are asserted here, on bare DOM.
 *
 * Every rung is also checked in the negative. A ladder that always returns the
 * same rung would pass a test that only ever asks for the top of it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canTakeFocus,
  focusKeyboardHome,
  isKeyboardHomeless,
  resetFocusStore,
  returnFocusTo,
  useFocusStore,
} from './focus-store';

function anchor(role: 'composer' | 'primary' | 'ground', element: HTMLElement): void {
  useFocusStore.getState().setAnchor(role, element);
}

function mount<T extends HTMLElement>(element: T): T {
  document.body.append(element);
  return element;
}

function composer(): HTMLTextAreaElement {
  const node = document.createElement('textarea');
  node.id = 'composer';
  return node;
}

function button(label: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.textContent = label;
  return node;
}

function region(): HTMLElement {
  const node = document.createElement('main');
  node.tabIndex = -1;
  return node;
}

beforeEach(() => {
  resetFocusStore();
  document.body.replaceChildren();
});

afterEach(() => {
  resetFocusStore();
  document.body.replaceChildren();
});

describe('canTakeFocus refuses everything a browser would silently refuse', () => {
  it('accepts a mounted, enabled control', () => {
    expect(canTakeFocus(mount(composer()))).toBe(true);
    expect(canTakeFocus(mount(button('Start')))).toBe(true);
    expect(canTakeFocus(mount(region()))).toBe(true);
  });

  it('refuses an element that is no longer in the document', () => {
    // The delete case, in one line: the dialog remembers the row, the row is
    // destroyed, and `focus()` on it does nothing and reports nothing.
    const row = mount(button('Open Star charts'));
    row.remove();
    expect(canTakeFocus(row)).toBe(false);
  });

  it('refuses a disabled control', () => {
    // The composer with no model chosen. It is on screen and it is the right
    // *place*, and it still cannot hold the keyboard.
    const field = mount(composer());
    field.disabled = true;
    expect(canTakeFocus(field)).toBe(false);
  });

  it('refuses anything inside a hidden or aria-hidden subtree', () => {
    const shell = mount(document.createElement('div'));
    const inner = button('Buried');
    shell.append(inner);
    shell.hidden = true;
    expect(canTakeFocus(inner)).toBe(false);

    shell.hidden = false;
    shell.setAttribute('aria-hidden', 'true');
    expect(canTakeFocus(inner)).toBe(false);
  });

  it('refuses a plain container that nothing made focusable', () => {
    // Without this, `returnFocusTo` would "succeed" into a <div> and the
    // keyboard would land on <body> with every call site reporting success.
    const box = mount(document.createElement('div'));
    expect(canTakeFocus(box)).toBe(false);
    box.tabIndex = -1;
    expect(canTakeFocus(box)).toBe(true);
  });

  it('refuses a link with no href, and accepts one with', () => {
    const dead = mount(document.createElement('a'));
    expect(canTakeFocus(dead)).toBe(false);
    dead.href = 'https://example.invalid/';
    expect(canTakeFocus(dead)).toBe(true);
  });

  it('refuses null and undefined rather than throwing', () => {
    expect(canTakeFocus(null)).toBe(false);
    expect(canTakeFocus(undefined)).toBe(false);
  });
});

describe('the ladder is tried in order, and every rung can be reached', () => {
  it('prefers the opener over every rung', () => {
    const opener = mount(button('Rename'));
    anchor('composer', mount(composer()));
    expect(returnFocusTo(opener)).toBe(opener);
    expect(document.activeElement).toBe(opener);
  });

  it('falls to the composer when the opener was destroyed', () => {
    const opener = mount(button('Open Star charts'));
    const field = mount(composer());
    anchor('composer', field);

    opener.remove();
    expect(returnFocusTo(opener)).toBe(field);
    expect(document.activeElement).toBe(field);
  });

  it('falls past a disabled composer to the primary action', () => {
    // No model configured: the composer is present and refuses the keyboard.
    const field = mount(composer());
    field.disabled = true;
    const primary = mount(button('Start a conversation'));
    anchor('composer', field);
    anchor('primary', primary);

    expect(focusKeyboardHome()).toBe(primary);
    expect(document.activeElement).toBe(primary);
  });

  it('lands on the ground when nothing above it will take the keyboard', () => {
    // The floor. This is the assertion that makes "never <body>" a guarantee
    // rather than a claim about the cases somebody thought of.
    const field = mount(composer());
    field.disabled = true;
    const ground = mount(region());
    anchor('composer', field);
    anchor('ground', ground);

    expect(focusKeyboardHome()).toBe(ground);
    expect(document.activeElement).toBe(ground);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('reports honestly when there is nothing to focus at all', () => {
    // No application on screen. Returning `null` is the truth; pretending
    // otherwise would make every caller's success check meaningless.
    expect(focusKeyboardHome()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('skips a rung whose element left the document', () => {
    const field = mount(composer());
    const ground = mount(region());
    anchor('composer', field);
    anchor('ground', ground);

    field.remove();
    expect(focusKeyboardHome()).toBe(ground);
  });
});

describe('registration is identity-checked, so a remount cannot erase itself', () => {
  it('keeps the newest registration when the old element releases late', () => {
    // React can mount a replacement before detaching the replaced one. An
    // unconditional clear would leave the rung empty and the ladder one shorter
    // than it looks — a defect that only appears under a remount.
    const older = mount(composer());
    const newer = mount(composer());
    anchor('composer', older);
    anchor('composer', newer);

    useFocusStore.getState().releaseAnchor('composer', older);
    expect(useFocusStore.getState().anchors.composer).toBe(newer);

    useFocusStore.getState().releaseAnchor('composer', newer);
    expect(useFocusStore.getState().anchors.composer).toBeNull();
  });
});

describe('homelessness is the condition a surface may claim on', () => {
  it('counts <body> as nowhere', () => {
    expect(isKeyboardHomeless()).toBe(true);
  });

  it('counts the ground as nowhere, because it is a floor and not a place', () => {
    const ground = mount(region());
    anchor('ground', ground);
    ground.focus();
    expect(document.activeElement).toBe(ground);
    expect(isKeyboardHomeless()).toBe(true);
  });

  it('does not count a real control as nowhere', () => {
    const primary = mount(button('Start a conversation'));
    primary.focus();
    expect(isKeyboardHomeless()).toBe(false);
  });
});
