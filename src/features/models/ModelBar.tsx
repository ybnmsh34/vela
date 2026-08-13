/**
 * The bar above the transcript: which model, what it cannot do, how much room
 * is left.
 *
 * Three things share this strip because they are one question — *what happens
 * when I press send* — and splitting them across a settings screen would mean
 * the answer is only available somewhere the user is not looking.
 *
 * The degradation chip is the load-bearing part. Affordances that are absent are
 * invisible by construction, so something has to be visible instead: a count of
 * what this model cannot do, one click from the sentences that explain each one.
 */

import { useState, type ReactNode } from 'react';

import type { ChatError, ModelCapabilityReport } from '@/platform/contract';
import type { ModelSelection } from '@/state/model-store';

import { CapabilitySummary } from './CapabilitySummary';
import { ContextMeter } from './ContextMeter';
import { ModelSwitcher } from './ModelSwitcher';
import { capabilityRows, degradations } from './capability-rows';
import type { ModelEntry } from './catalogue';
import styles from './ModelBar.module.css';

interface ModelBarProps {
  readonly entries: readonly ModelEntry[];
  readonly selection: ModelSelection | null;
  readonly report: ModelCapabilityReport | null;
  readonly hasHistory: boolean;
  readonly probing: boolean;
  readonly probeFailure: ChatError | null;
  readonly switchedFrom: ModelSelection | null;
  /** Everything this turn would send, for the context estimate. */
  readonly texts: readonly string[];
  readonly onSelect: (selection: ModelSelection, hasHistory: boolean) => void;
  readonly onProbe: () => void;
  readonly onAcknowledgeSwitch: () => void;
  readonly onDiscover?: (providerId: string) => void;
  readonly onConfigure?: () => void;
  /** The attachment affordances, which are themselves capability-gated. */
  readonly attachments?: ReactNode;
}

export function ModelBar({
  entries,
  selection,
  report,
  hasHistory,
  probing,
  probeFailure,
  switchedFrom,
  texts,
  onSelect,
  onProbe,
  onAcknowledgeSwitch,
  onDiscover,
  onConfigure,
  attachments,
}: ModelBarProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const rows = capabilityRows(report);
  const limits = degradations(rows);

  return (
    <div className={styles.bar}>
      <div className={styles.row}>
        <ModelSwitcher
          entries={entries}
          selection={selection}
          hasHistory={hasHistory}
          onSelect={onSelect}
          {...(onDiscover === undefined ? {} : { onDiscover })}
          {...(onConfigure === undefined ? {} : { onConfigure })}
        />

        <button
          type="button"
          className={`${styles.limits} ${limits.length > 0 ? styles.limitsActive ?? '' : ''}`}
          aria-expanded={detailsOpen}
          onClick={() => {
            setDetailsOpen((open) => !open);
          }}
        >
          {report?.probed === true
            ? limits.length === 0
              ? 'No limits found'
              : `${String(limits.length)} ${limits.length === 1 ? 'limit' : 'limits'}`
            : 'Capabilities unknown'}
        </button>

        <span className={styles.spacer} />

        <ContextMeter
          windowTokens={report?.contextWindowTokens ?? null}
          texts={texts}
        />

        {attachments}
      </div>

      {switchedFrom === null ? null : (
        <div className={styles.notice} role="status">
          <p className={styles.noticeText}>
            You changed model with this conversation open. Replies before now came from{' '}
            <strong>{switchedFrom.modelLabel}</strong> on {switchedFrom.providerLabel}. The new
            endpoint has not seen any of it: Vela sends the whole conversation again with the next
            message, its context window may be smaller, and what it can do is listed above — not
            inherited from the model you left.
          </p>
          <button type="button" className={styles.noticeDismiss} onClick={onAcknowledgeSwitch}>
            Got it
          </button>
        </div>
      )}

      {detailsOpen ? (
        <div className={styles.details}>
          <CapabilitySummary
            report={report}
            probing={probing}
            probeFailure={probeFailure}
            onProbe={onProbe}
          />
        </div>
      ) : null}
    </div>
  );
}
