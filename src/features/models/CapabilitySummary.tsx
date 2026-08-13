/**
 * What this model can and cannot do, said out loud.
 *
 * The point of this component is that **degradation is not incidental**. It is
 * not "the attach button isn't rendered, work it out": every capability appears
 * in the same list whether it is present or absent, and an absent one carries
 * the consequence in a sentence. A user should be able to answer "can this
 * model read a screenshot?" without opening documentation or trying it.
 *
 * The probe button is the other half. An unprobed model offers nothing, which is
 * the correct floor but a bad place to be stuck in, so the way out is one click
 * and it is labelled with what it will do — contact the endpoint.
 */

import type { ChatError, ModelCapabilityReport } from '@/platform/contract';

import { capabilityRows, type CapabilityTone } from './capability-rows';
import styles from './CapabilitySummary.module.css';

interface CapabilitySummaryProps {
  readonly report: ModelCapabilityReport | null;
  readonly probing: boolean;
  readonly probeFailure: ChatError | null;
  readonly onProbe: () => void;
}

const TONE_CLASS: Record<CapabilityTone, string> = {
  available: styles.available ?? '',
  emulated: styles.emulated ?? '',
  absent: styles.absent ?? '',
  unknown: styles.unknown ?? '',
};

export function CapabilitySummary({
  report,
  probing,
  probeFailure,
  onProbe,
}: CapabilitySummaryProps) {
  const rows = capabilityRows(report);

  return (
    <section className={styles.summary} aria-label="What this model can do">
      <header className={styles.header}>
        <h3 className={styles.heading}>What this model can do</h3>
        <button type="button" className={styles.probe} onClick={onProbe} disabled={probing}>
          {probing ? 'Asking the endpoint…' : report?.probed === true ? 'Check again' : 'Check'}
        </button>
      </header>

      {report?.probed === true ? null : (
        <p className={styles.floor}>
          Nothing has been asked of this endpoint yet, so Vela offers nothing. Checking sends one
          short request to the address you configured.
        </p>
      )}

      {probeFailure === null ? null : (
        <p className={styles.failure} role="status">
          {probeFailureText(probeFailure)}
        </p>
      )}

      <dl className={styles.rows}>
        {rows.map((row) => (
          <div key={row.id} className={`${styles.row} ${TONE_CLASS[row.tone]}`}>
            <dt className={styles.label}>{row.label}</dt>
            <dd className={styles.value}>
              <span className={styles.badge}>{row.value}</span>
              {row.detail === null ? null : <span className={styles.detail}>{row.detail}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The renderer's own words for a failed probe.
 *
 * Switches on `kind`, and on `cause` only to pick between two sentences that are
 * both ours. Nothing the endpoint wrote appears — there is nowhere in
 * {@link ChatError} for it to have travelled.
 */
export function probeFailureText(error: ChatError): string {
  switch (error.kind) {
    case 'authFailed':
      return 'The endpoint refused the credential. Check the key on this endpoint and try again.';
    case 'modelNotFound':
      return `The endpoint does not serve \`${error.modelId}\`. Pick another model, or correct the name.`;
    case 'rateLimited':
      return 'The endpoint is rate-limiting us. Nothing was established; try again shortly.';
    case 'contextLengthExceeded':
      return 'The check itself was too large for this model, which is unusual. Nothing was established.';
    case 'capabilityUnsupported':
      return 'The endpoint refused the check outright, so nothing could be established.';
    case 'transport':
      return error.diagnosis.cause === 'no_provider_configured'
        ? 'This endpoint has not been contacted this session. Vela will establish what it can do the first time you use it.'
        : 'Vela could not reach the endpoint. Nothing was established, and nothing is being assumed.';
    case 'malformedResponse':
      return 'The endpoint answered with something Vela could not read, so nothing was established.';
    case 'cancelled':
      return 'The check was cancelled.';
  }
}
