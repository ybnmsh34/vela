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
      // after a refused one. `aria-live` announces the content change itself,
      // so the outcome is spoken without moving the name the rest of the app
      // (and `CopyButton.test.tsx`) addresses this button by.
      aria-live="polite"
      data-outcome={outcome}
    >
      {outcome === 'copied' ? 'Copied' : outcome === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}
