/**
 * The security posture of one endpoint, in words.
 *
 * ## The rule that decides everything here
 *
 * **A local endpoint with no key is not a warning.** Plaintext HTTP to
 * 127.0.0.1 with no credential is the normal, correct, most common way to run a
 * model, and the host says so by returning `level: 'none'` with no concerns.
 * This component renders nothing at all in that case. Warning there would train
 * the user to dismiss the warnings that matter — and the one that matters,
 * `remoteEndpointIsUnauthenticated`, is about an endpoint on the network with
 * its door open, not about a loopback socket.
 *
 * The wording is the renderer's, from an enumerable {@link Concern}. The host
 * decides *what is true*; this file decides *how to say it*.
 */

import type { Concern, RiskLevel, SecurityPosture } from '@/platform/contract';

import styles from './SecurityNotice.module.css';

const CONCERN_TEXT: Record<Concern, string> = {
  credentialSentInPlaintext:
    'Your key is sent over plain HTTP to another machine. Anything between here and there can read it.',
  plaintextTrafficLeavesDevice:
    'This endpoint is not on this machine and the connection is plain HTTP, so your prompts and the replies cross the network in the clear.',
  queryParamCredentialIsLogged:
    'The key travels in the URL. Even over HTTPS, the server and every proxy in between write the full address into their access logs.',
  remoteEndpointIsUnauthenticated:
    'This endpoint is reachable over the network and takes no credential, so anyone who can reach it can use it. That is fine on a network you control and worth knowing about on one you do not.',
  requiredCredentialMissing:
    'This endpoint is set to require a key and none is stored yet, so it cannot be used until you add one.',
};

const LEVEL_LABEL: Record<Exclude<RiskLevel, 'none'>, string> = {
  notice: 'Worth knowing',
  elevated: 'Take care',
  high: 'Risk',
};

interface SecurityNoticeProps {
  readonly security: SecurityPosture;
}

export function SecurityNotice({ security }: SecurityNoticeProps) {
  // The quiet case, and it is the common one. Nothing is rendered, including no
  // reassuring green badge: an endpoint on this machine with no key needs no
  // commentary at all.
  if (security.level === 'none' || security.concerns.length === 0) return null;

  return (
    <div className={`${styles.notice} ${toneClass(security.level)}`} data-testid="security-notice">
      <span className={styles.level}>{LEVEL_LABEL[security.level]}</span>
      <ul className={styles.list}>
        {security.concerns.map((concern) => (
          <li key={concern}>{CONCERN_TEXT[concern]}</li>
        ))}
      </ul>
    </div>
  );
}

function toneClass(level: RiskLevel): string {
  if (level === 'high') return styles.high ?? '';
  if (level === 'elevated') return styles.elevated ?? '';
  return styles.notice_ ?? '';
}
