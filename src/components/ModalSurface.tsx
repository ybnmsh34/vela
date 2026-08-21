/**
 * A modal overlay: the scrim, the dialog box, and the promise `aria-modal` makes.
 *
 * ## Why the promise and the enforcement had to become one thing
 *
 * `aria-modal="true"` tells assistive technology that nothing outside the dialog
 * is reachable. It does not *make* that true — it is a claim the author is
 * expected to have made true by other means. Vela's two dialogs both made the
 * claim and neither had a line of Tab handling anywhere in it, so a screen
 * reader announced a sealed background and one Tab press walked into the
 * fourteen live controls behind it, counted in the assembled app. An unenforced
 * `aria-modal` is worse than none: without it a user distrusts the background
 * and checks; with it they are told not to.
 *
 * Two hand-rolled traps would be the third dialog waiting to be wrong, so the
 * attribute is not something a dialog writes. It is something this component
 * writes, next to the code that keeps it. A dialog that renders itself through
 * here cannot make the claim without the containment, and cannot get the
 * containment without also getting the restore.
 *
 * ## Wrapping Tab, not marking the background `inert`
 *
 * `inert` is the modern answer and WebView2's Chromium has it. It is not the
 * answer here, and the reason is not taste — it is that this tree could not
 * *show* that it worked. Measured on this toolchain rather than assumed: jsdom
 * 26 does not implement `inert` at all, the property is absent from
 * `HTMLElement.prototype`, a control inside an `[inert]` subtree still accepts
 * focus, and `@testing-library/user-event` walks Shift+Tab straight into one. An
 * `inert` background would therefore ship behind a green suite that had verified
 * nothing about it, which is exactly the shape of defect this repo keeps
 * finding. Verifying it honestly would take a driven WebView2 window, which is
 * not available here.
 *
 * The wrap needs no engine support, runs identically everywhere, and is asserted
 * end to end in `src/app/modal-containment.test.tsx` against three of the
 * surfaces that render through here — the command bar, the delete-conversation
 * dialog and the endpoint-removal dialog — each driven against its own
 * background rather than assumed to inherit the property from the one before
 * it. Four more render through here and are **not** driven there: the memory,
 * skills, schedules and projects panels. They get the containment by
 * construction, which is the point of this component, but nothing in that file
 * walks Tab out of them.
 *
 * ## What the wrap has to answer
 *
 * Forward off the last stop and backward off the first are the two obvious
 * cases. The two that are usually missed are a dialog holding **one** focusable
 * child — where "the next one" has to mean itself, and a naive next-index wraps
 * to nothing — and a dialog holding **none**, where there is nowhere inside to
 * send the keyboard at all. The second is why the panel carries
 * `tabIndex={-1}`: something inside must be able to hold focus, or the key
 * handler never runs and there is nothing to contain.
 *
 * Interior presses are left to the engine. Tab stops inside a dialog are
 * contiguous in document order, so only the two ends can leak, and intercepting
 * the middle would mean reimplementing an order the engine already knows.
 *
 * ## Focus, in and out
 *
 * Capture on mount, restore on unmount through the ladder in
 * `src/state/focus-store.ts`. Both dialogs used to do this themselves, correctly
 * and separately; it moves here because a dialog that gets the trap by
 * construction should not be able to forget the half that was already fixed.
 * `initialFocus` is still the dialog's choice — Cancel rather than Delete is a
 * statement about consequence, not a default anything can supply — but a dialog
 * that names nothing gets the first stop inside, never a background element.
 */

import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

import { returnFocusTo, tabStopsWithin } from '@/state/focus-store';

/**
 * The optionals spell out `| undefined` because `exactOptionalPropertyTypes` is
 * on and a CSS-module class name is `string | undefined` — the sharper rule, and
 * the price of it is this line of noise per prop.
 */
interface ModalSurfaceProps {
  /** `alertdialog` when the dialog interrupts to ask about a consequence. */
  readonly role?: 'dialog' | 'alertdialog' | undefined;
  readonly label?: string | undefined;
  readonly labelledBy?: string | undefined;
  readonly describedBy?: string | undefined;
  /** The full-bleed backdrop. Owned by the caller so it keeps its own z-layer. */
  readonly scrimClassName?: string | undefined;
  /** The dialog box itself. */
  readonly className?: string | undefined;
  /**
   * Where the keyboard goes on open. Omit and it goes to the first stop inside,
   * which is right for a dialog whose first control is also its safest.
   */
  readonly initialFocus?: RefObject<HTMLElement | null> | undefined;
  /** A press on the scrim — outside the box — asking to be let out. */
  readonly onDismiss: () => void;
  /** The dialog's own keys. Runs first; a handled key is left alone. */
  readonly onKeyDown?: ((event: KeyboardEvent<HTMLDivElement>) => void) | undefined;
  readonly children: ReactNode;
}

export function ModalSurface({
  role = 'dialog',
  label,
  labelledBy,
  describedBy,
  scrimClassName,
  className,
  initialFocus,
  onDismiss,
  onKeyDown,
  children,
}: ModalSurfaceProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(
    () => {
      // Read before moving: one line later this is no longer true.
      const opener = document.activeElement;
      const wanted = initialFocus?.current ?? tabStopsWithin(panel.current)[0] ?? panel.current;
      wanted?.focus();
      return () => {
        returnFocusTo(opener);
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open and close, once
    [],
  );

  const containTab = (event: KeyboardEvent<HTMLDivElement>): void => {
    const box = panel.current;
    if (box === null) return;

    const stops = tabStopsWithin(box);
    if (stops.length === 0) {
      // A dialog with nothing tabbable in it. Every destination Tab has is
      // outside, so the press does nothing — which is the containment holding,
      // not failing to. Focus stays on the panel, where the mount effect put it.
      event.preventDefault();
      return;
    }

    const active = document.activeElement;
    const at = stops.findIndex((stop) => stop === active);
    // `at === -1` is the panel itself, or a focusable-but-not-tabbable node
    // inside it. Treating that as "before the first" going forward and "after
    // the last" going back is what makes the no-stops and one-stop dialogs
    // behave, and it is the only reading that cannot send the keyboard outside.
    const leaving = event.shiftKey ? at <= 0 : at === -1 || at === stops.length - 1;
    if (!leaving) return;

    event.preventDefault();
    // First one that will actually take it. `focus()` is a request, not a
    // result — the same discipline the ladder uses, and for the same reason: an
    // element that refuses leaves the keyboard where it was, and where it was is
    // the element Tab was trying to leave.
    for (const candidate of event.shiftKey ? [...stops].reverse() : stops) {
      candidate.focus();
      if (document.activeElement === candidate) return;
    }
  };

  return (
    <div
      className={scrimClassName}
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return;
        // The scrim is not focusable, so the default answer to a press on it is
        // to blur whatever holds the keyboard — and that blur can land *after*
        // the closing dialog has handed the keyboard back, quietly undoing the
        // restore. It did: dismissing the command bar by clicking outside it put
        // focus on `<body>`, which is the same defect the rest of this wave was
        // about, on the one exit nobody had tested. Refusing the default is the
        // move the palette's own result rows already make, for the same reason.
        event.preventDefault();
        onDismiss();
      }}
    >
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        className={className}
        tabIndex={-1}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.key === 'Tab' && !event.isDefaultPrevented()) containTab(event);
        }}
      >
        {children}
      </div>
    </div>
  );
}
