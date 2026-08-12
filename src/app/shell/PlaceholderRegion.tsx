/**
 * The main content placeholder for Phase A.
 *
 * It exists to prove three things visually, in a real render:
 *   1. the theme tokens resolve in both light and dark,
 *   2. the platform seam is wired and answering,
 *   3. which adapter and which secret backend are actually in play — stated
 *      plainly, so a screenshot of this screen can never be mistaken for
 *      evidence about a real keychain or a real model.
 *
 * Feature builders replace this component; they do not build on top of it.
 */

import { VelaMark } from '@/components/VelaMark';
import { usePlatform } from '@/platform/PlatformProvider';

import styles from './PlaceholderRegion.module.css';
import type { HostStatus } from './use-host-status';

const REGIONS: readonly { readonly name: string; readonly owner: string }[] = [
  { name: 'Conversation', owner: 'src/features/chat' },
  { name: 'Model & providers', owner: 'src/features/providers' },
  { name: 'Workspace settings', owner: 'src/features/settings' },
];

interface PlaceholderRegionProps {
  /** Owned by `AppShell`; passed down rather than re-fetched, so the bridge is
   * probed once per mount. */
  readonly status: HostStatus;
}

export function PlaceholderRegion({ status }: PlaceholderRegionProps) {
  const adapter = usePlatform();

  return (
    <div className={styles.region}>
      <section className={styles.hero}>
        <span className={styles.heroMark}>
          <VelaMark size={28} title="Vela" />
        </span>
        <h1 className={styles.title}>Vela</h1>
        <p className={styles.subtitle}>
          A desktop workspace that brings its own interface and none of its own intelligence. You
          supply the model — local runtime, your own API key, or a subscription endpoint.
        </p>
      </section>

      <section className={`${styles.card} ${status.state === 'error' ? styles.error : ''}`}>
        <h2 className={styles.cardTitle}>Platform bridge</h2>
        <dl className={styles.rows}>
          <dt>Adapter</dt>
          <dd data-testid="adapter-kind">{adapter.kind}</dd>

          {status.state === 'loading' && (
            <>
              <dt>Host</dt>
              <dd data-testid="host-state">connecting…</dd>
            </>
          )}

          {status.state === 'ready' && (
            <>
              <dt>Host</dt>
              <dd data-testid="host-state">
                {status.info.name} {status.info.version} · {status.info.os}/{status.info.arch}
              </dd>
              <dt>IPC contract</dt>
              <dd>v{status.info.contractVersion}</dd>
              <dt>Credential store</dt>
              <dd data-testid="secret-backend">
                {status.info.secretBackend}
                {status.info.secretBackend !== 'os-keychain' && ' (not a real keychain)'}
              </dd>
              <dt>Round trip</dt>
              <dd>{status.roundTripMs} ms</dd>
            </>
          )}

          {status.state === 'error' && (
            <>
              <dt>Host</dt>
              <dd data-testid="host-state">
                {status.code}: {status.message}
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className={styles.slots} aria-label="Reserved regions">
        {REGIONS.map((region) => (
          <div key={region.name} className={styles.slot}>
            <span className={styles.slotName}>{region.name}</span>
            <span>{region.owner}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
