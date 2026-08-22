/**
 * WHO OWNS THE KEYBOARD.
 *
 * ## The defect this exists to close
 *
 * Vela dropped focus to `<body>` at four reproducible moments: Escape out of
 * the command bar, confirming a delete, committing an F2 rename, and choosing a
 * model in the switcher. From `<body>` the keyboard is nowhere — Tab restarts
 * at the top of the document, which measured **eleven** presses back to the
 * composer after the command bar closed.
 *
 * Every one of those overlays was individually careful.
 * `DeleteConversationDialog` captured `document.activeElement` on open and
 * restored it on close, exactly as the pattern says — and still dropped the
 * keyboard, because the element it so carefully remembered was the conversation
 * row it was asking permission to destroy. Each component minded its own focus.
 * **Nobody owned focus**, so nothing could answer the question a closing
 * overlay actually asks: *where should the keyboard go now, given that where it
 * came from may no longer exist?*
 *
 * ## The answer: a ladder, tried in order
 *
 * | Rung | What it is | Registered by |
 * |---|---|---|
 * | the opener | whatever had the keyboard before the overlay opened | the overlay |
 * | `composer` | the message box — where a chat app's keyboard lives | `Composer` |
 * | `primary` | the home screen's primary action | `HomeSurface` |
 * | `ground` | the content region, focusable but never tabbable | `NavigationSurface` |
 *
 * Each rung is tried and skipped if it cannot actually take focus — detached
 * from the document, `disabled`, or hidden. The opener rung is what makes a
 * *cancel* return you exactly where you were; the rungs below it are what stop
 * a *destructive* action from returning you to a corpse.
 *
 * `ground` is the floor that makes "never `<body>`" a guarantee rather than a
 * hope. It is reachable in one real situation — a conversation open with no
 * model configured, where the composer exists but is `disabled` — and it is
 * deliberately the `main` landmark rather than a wrapper div, so a screen
 * reader announces a region the user can orient in instead of going silent.
 *
 * ## Why a store, and why it is read imperatively
 *
 * Conventions §5: cross-component client state is a zustand store, one per
 * domain. This is that — three components register, several read. But no
 * component *renders* from it: an anchor changing must not re-render anything,
 * and every read happens inside an event handler or an effect. So the store is
 * the registry, and the functions below are the API; `useFocusStore` is
 * exported for tests and for symmetry, not to be selected from in a component.
 */

import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';

/** The rungs of the ladder, in the order they are tried. */
export type FocusAnchor = 'composer' | 'primary' | 'ground';

const LADDER: readonly FocusAnchor[] = ['composer', 'primary', 'ground'];

type Anchors = Readonly<Record<FocusAnchor, HTMLElement | null>>;

const EMPTY: Anchors = { composer: null, primary: null, ground: null };

interface FocusState {
  readonly anchors: Anchors;
  /** Claim a rung. The most recently mounted element wins. */
  setAnchor: (role: FocusAnchor, element: HTMLElement) => void;
  /**
   * Give a rung up — but only if it is still this element's.
   *
   * React mounts the replacement before unmounting the replaced one when a
   * subtree remounts, so an unconditional clear would let a departing component
   * erase its successor's registration.
   */
  releaseAnchor: (role: FocusAnchor, element: HTMLElement) => void;
}

export const useFocusStore = create<FocusState>((set, get) => ({
  anchors: EMPTY,
  setAnchor: (role, element) => {
    set({ anchors: { ...get().anchors, [role]: element } });
  },
  releaseAnchor: (role, element) => {
    if (get().anchors[role] !== element) return;
    set({ anchors: { ...get().anchors, [role]: null } });
  },
}));

/** Test helper: forget every registration between renders. */
export function resetFocusStore(): void {
  useFocusStore.setState({ anchors: EMPTY });
}

/**
 * Elements a browser will focus without being told to make them focusable.
 * Anything else needs an explicit `tabindex` — including `ground`, which has
 * `tabindex="-1"` precisely so it can be a destination without being a stop on
 * the Tab order.
 */
const NATIVELY_FOCUSABLE = new Set([
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'SUMMARY',
  'AUDIO',
  'VIDEO',
  'IFRAME',
]);

/**
 * Whether this element could actually hold the keyboard right now.
 *
 * Deliberately *not* a layout question. `offsetParent` and bounding boxes are
 * meaningless in jsdom and expensive in a real engine, and every case that
 * matters here — the row a delete just removed, the composer with no model
 * chosen, a panel behind `hidden` — is answerable from the DOM alone.
 */
export function canTakeFocus(element: Element | null | undefined): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (!element.isConnected) return false;
  if (element.hasAttribute('disabled')) return false;
  if (element.getAttribute('aria-disabled') === 'true') return false;
  if (element.closest('[hidden]') !== null) return false;
  if (element.closest('[aria-hidden="true"]') !== null) return false;
  if (element.hasAttribute('tabindex') || element.isContentEditable) return true;
  if (element instanceof HTMLAnchorElement) return element.hasAttribute('href');
  return NATIVELY_FOCUSABLE.has(element.tagName);
}

/**
 * The Tab stops inside `root`, in the order Tab visits them.
 *
 * `canTakeFocus` answers *whether* an element can hold the keyboard; this adds
 * the one further question Tab asks — **is it a stop** — and the difference is
 * entirely `tabindex="-1"`. Three things in Vela are deliberately focusable
 * without being tabbable, and every one of them would be a bug in this list: the
 * sidebar's non-current rows (a roving tabindex is what stops forty
 * conversations costing forty Tab presses), the `ground` landmark, and a
 * dialog's own panel.
 *
 * Document order, not a sort by `tabindex` value. Nothing in this tree uses a
 * positive `tabindex`, and a surface that started to would need its order
 * reasoned about out loud rather than silently rearranged here.
 */
export function tabStopsWithin(root: Element | null | undefined): readonly HTMLElement[] {
  if (!(root instanceof HTMLElement)) return [];
  const stops: HTMLElement[] = [];
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (canTakeFocus(element) && element.tabIndex >= 0) stops.push(element);
  }
  return stops;
}

/**
 * Hand the keyboard back after an overlay closes.
 *
 * `preferred` is the element the overlay took focus from. It is tried first and
 * silently skipped when it can no longer hold focus — which is the whole point,
 * and the case all four defects were.
 *
 * Every candidate is focused and then **verified**: `focus()` is a request, not
 * a result, and an element that refuses it leaves the keyboard on `<body>` with
 * no error anywhere. Checking `document.activeElement` afterwards is what turns
 * this from four hopeful call sites into one guarantee.
 *
 * Returns whatever ended up with the keyboard, or `null` if nothing would take
 * it — which in the assembled app means `ground` is unmounted, i.e. there is no
 * application on screen.
 */
export function returnFocusTo(preferred?: Element | null): HTMLElement | null {
  const { anchors } = useFocusStore.getState();
  const candidates = [preferred, ...LADDER.map((role) => anchors[role])];
  for (const candidate of candidates) {
    if (!canTakeFocus(candidate)) continue;
    candidate.focus();
    if (document.activeElement === candidate) return candidate;
  }
  return null;
}

/** The ladder with no opener: after an action that destroyed where you were. */
export function focusKeyboardHome(): HTMLElement | null {
  return returnFocusTo(null);
}

/**
 * Is the keyboard nowhere?
 *
 * `<body>` and `null` are the two ways a browser says "nothing has focus".
 * `ground` counts as nowhere on purpose: it is the floor, not a destination, so
 * a real surface appearing above it is entitled to take over.
 */
export function isKeyboardHomeless(): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body) return true;
  return active === useFocusStore.getState().anchors.ground;
}

/**
 * Take the keyboard, but only if nothing else has it.
 *
 * For a surface that appears *because* something else went away — the home
 * screen after the open conversation was deleted. It must not steal focus from
 * a user who is typing somewhere else, and it must not leave the keyboard on
 * the floor when it is the only thing on screen.
 */
export function claimKeyboardIfHomeless(element: Element | null | undefined): boolean {
  if (!isKeyboardHomeless() || !canTakeFocus(element)) return false;
  element.focus();
  return true;
}

/**
 * For a component that can be **removed while holding the keyboard**: a
 * conversation row that a delete destroys, a result that a filter narrows away.
 *
 * There is no event for this. A browser removing the focused element moves
 * focus to `<body>` and fires nothing at all, which is why this class of defect
 * is invisible until somebody presses Tab and counts. An unmount cleanup is the
 * one place the code still runs, and by then the node is already detached and
 * the keyboard is already on the floor — so the check is "is the keyboard
 * homeless", not "was it mine".
 *
 * That reading is deliberate and slightly wider than the literal case: if the
 * keyboard is nowhere and a surface is disappearing, putting it back on the
 * ladder is right whoever dropped it. It can never *take* focus from anything,
 * because something holding focus is by definition not homeless.
 *
 * This is what closes the delete path. The dialog's own restore aims at the row
 * — correctly, because cancelling must land there — and the row then outlives
 * the dialog by one render, because the conversation list reloads after the
 * selection clears. The keyboard falls at that second commit, not the first.
 */
export function useKeyboardHandoff(): void {
  useEffect(
    () => () => {
      if (isKeyboardHomeless()) focusKeyboardHome();
    },
    [],
  );
}

/**
 * A `ref` callback that registers an element as a rung for as long as it is
 * mounted. `<textarea ref={useFocusAnchor('composer')} …>` and the composer is
 * the keyboard's home; nothing else has to be said anywhere.
 */
export function useFocusAnchor<T extends HTMLElement>(role: FocusAnchor): (element: T | null) => void {
  // What *this* callback last registered. React hands the detach call a bare
  // `null` rather than the element being detached, and a remount can mount the
  // replacement before detaching the replaced — so releasing "whatever is
  // registered" would let a departing component erase its successor.
  const registered = useRef<T | null>(null);

  return useCallback(
    (element: T | null) => {
      const { setAnchor, releaseAnchor } = useFocusStore.getState();
      if (element === null) {
        if (registered.current !== null) releaseAnchor(role, registered.current);
        registered.current = null;
        return;
      }
      registered.current = element;
      setAnchor(role, element);
    },
    [role],
  );
}
