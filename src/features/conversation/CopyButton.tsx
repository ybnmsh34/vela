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
      data-outcome={outcome}
    >
      {outcome === 'copied' ? 'Copied' : outcome === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}
