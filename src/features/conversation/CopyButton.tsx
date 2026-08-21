/**
 * A copy affordance that reports what actually happened.
 *
 * Three visible states, not two: idle, copied, and *failed*. A clipboard write
 * can be refused, and a button that always flashes "Copied" after a refusal is
 * worse than no button — the user walks away with an empty clipboard.
 */

import { useEffect, useRef, useState } from 'react';

import { copyText } from './copy-text';
import styles from './CopyButton.module.css';

type Outcome = 'idle' | 'copied' | 'failed';

const RESET_MS = 1600;

interface CopyButtonProps {
  /** Resolved at click time, so a streaming answer copies what is on screen now. */
  readonly getText: () => string;
  /** Accessible name; the visible label stays short. */
  readonly label: string;
  readonly subtle?: boolean;
}

export function CopyButton({ getText, label, subtle = false }: CopyButtonProps) {
  const [outcome, setOutcome] = useState<Outcome>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = (): void => {
    void copyText(getText()).then((ok) => {
      setOutcome(ok ? 'copied' : 'failed');
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setOutcome('idle');
      }, RESET_MS);
    });
  };

  return (
    <button
      type="button"
      className={subtle ? `${styles.button} ${styles.subtle}` : styles.button}
      onClick={onClick}
      aria-label={label}
      // THE OUTCOME IS NOT ONLY A COLOUR.
      //
      // `data-outcome` is what `CopyButton.module.css` recolours, and this
      // branch is what made that recolour carry meaning — success and failure
      // moved onto the code palette and now differ from each other by a border.
      // Colour is never the only channel: the words "Copied" and "Copy failed"
      // are in the DOM, which satisfies 1.4.1 for anyone who can see them. It
      // did not satisfy 4.1.3 for anyone who cannot, because `aria-label` fixes
      // the accessible name to `label` and the outcome never entered it — the
      // button said "Copy this reply" before the click and "Copy this reply"
      // after a refused one. `aria-live` marks the changed contents as a live
      // region, which is the mechanism by which an outcome can be announced
      // without moving the name the rest of the app addresses this button by.
      //
      // WHETHER IT IS SPOKEN IS NOT MEASURED HERE, and the earlier version of
      // this comment said it was. A polite region that is also the focused
      // element and carries an `aria-label` is a known-unreliable announcement
      // path: implementations differ on whether they read the author name or
      // the changed contents. What is checked, in `CopyButton.test.tsx` >
      // `announces the outcome without moving the name the app addresses it
      // by`, is the half that lives in the DOM — the region is on the node whose
      // contents change, and the accessible name does not move. WCAG 4.1.3 is
      // not closed on the strength of this attribute, and 2.5.3 (Label in Name)
      // is separately still open.
      aria-live="polite"
      data-outcome={outcome}
    >
      {outcome === 'copied' ? 'Copied' : outcome === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}
