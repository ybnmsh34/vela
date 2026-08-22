/**
 * The switch for Vela's own local port.
 *
 * Vela can serve one of the endpoints you have configured back out over HTTP,
 * so that other tools on this machine can talk to the same model through it.
 * Before this section existed the only way to do that was to set five
 * environment variables and restart, and the host's own comment said a settings
 * row was blocked — it was not.
 *
 * ## Three things this surface is careful about
 *
 * 1. **Off is the default and it is a state, not a gap.** Nothing here is
 *    prefilled with a key, nothing enables on load, and the section says what
 *    the switch does before it is thrown.
 * 2. **The tool policy is reported, never predicted.** The host resolves it
 *    from the address the *listener* bound, which is not always the address
 *    that was typed — port `0` becomes a real port, and a wildcard binds every
 *    interface the machine has. So this component renders `toolsEnabled` and
 *    `toolPolicy` off the answer and computes neither. The one thing it does
 *    ahead of time is *ask*: the confirmation checkbox appears whenever tools
 *    are requested, because the question has to be answerable before the bind,
 *    and the host is what decides whether the answer was needed.
 * 3. **It names no backend.** The port answers more than one wire format, and
 *    the only identifier here is an id the user typed into the list above. The
 *    belief that a panel like this would have to name them is the false comment
 *    `endpoint_host` now retracts.
 */

import { useId, useState, type FormEvent } from 'react';

import type {
  EndpointStatus,
  EndpointToolPolicy,
  EndpointToolsRequest,
  ProviderView,
} from '@/platform/contract';

import styles from './LocalEndpointSection.module.css';
import { useLocalEndpoint } from './use-local-endpoint';

/** What the user can ask for, and the words they read. */
const TOOLS_CHOICES: readonly { readonly value: EndpointToolsRequest; readonly label: string }[] = [
  { value: 'default', label: 'Let the address decide' },
  { value: 'on', label: 'Offer tools' },
  { value: 'off', label: 'Never offer tools' },
];

const DEFAULT_BIND = '127.0.0.1:8034';

interface LocalEndpointSectionProps {
  /** The endpoints already configured above. One of them answers this port. */
  readonly providers: readonly ProviderView[];
}

export function LocalEndpointSection({ providers }: LocalEndpointSectionProps) {
  const ids = { bind: useId(), key: useId(), serve: useId(), tools: useId(), confirm: useId() };
  const { state, failure, busy, enable, disable } = useLocalEndpoint();

  const [bind, setBind] = useState(DEFAULT_BIND);
  const [key, setKey] = useState('');
  const [serve, setServe] = useState('');
  const [tools, setTools] = useState<EndpointToolsRequest>('default');
  const [confirmed, setConfirmed] = useState(false);

  const serving = state.status === 'ready' && state.endpoint.state === 'serving';

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    await enable({
      bind: bind.trim(),
      key,
      providerId: serve === '' ? (providers[0]?.id ?? '') : serve,
      tools,
      confirmExposedTools: confirmed,
    });
  };

  return (
    <section className={styles.section} aria-label="Local endpoint">
      <h3 className={styles.heading}>Local endpoint</h3>
      <p className={styles.explanation}>
        Serve one of the endpoints above on a port of this machine, so other tools here can send
        turns through Vela. Off every time Vela starts, and off again when you close it — the key
        below lives in this session only.
      </p>

      {state.status === 'loading' ? (
        <p className={styles.muted}>Asking Vela what it is serving…</p>
      ) : state.status === 'error' ? (
        <p className={styles.error} role="alert">
          Vela could not say whether it is serving ({state.code}). Nothing has been changed.
        </p>
      ) : (
        <StatusReport endpoint={state.endpoint} />
      )}

      <form
        className={styles.form}
        onSubmit={(event) => {
          void submit(event);
        }}
        aria-label={serving ? 'Change the local endpoint' : 'Start the local endpoint'}
      >
        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.bind}>
            Listen on
          </label>
          <input
            id={ids.bind}
            className={styles.input}
            value={bind}
            placeholder={DEFAULT_BIND}
            onChange={(event) => {
              setBind(event.target.value);
            }}
          />
          <p className={styles.hint}>
            An address and a port. <code>127.0.0.1</code> can only be reached from this machine;
            anything else can be reached from your network, and Vela will not offer tools on it
            unless you say so below.
          </p>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.key}>
            Key callers must send
          </label>
          <input
            id={ids.key}
            className={styles.input}
            type="password"
            value={key}
            autoComplete="off"
            onChange={(event) => {
              setKey(event.target.value);
            }}
          />
          <p className={styles.hint}>
            Invent one. Every request has to present it as a bearer token, and Vela refuses to open
            the port without it.
          </p>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.serve}>
            Which endpoint to serve
          </label>
          <select
            id={ids.serve}
            className={styles.input}
            value={serve === '' ? (providers[0]?.id ?? '') : serve}
            onChange={(event) => {
              setServe(event.target.value);
            }}
          >
            {/* Name *and* id. The id is what the report below says turns are
                being passed to — it is what the host knows the endpoint by —
                and a menu that showed only the friendly name would leave the
                user matching two vocabularies in their head. */}
            {providers.map((view) => (
              <option key={view.id} value={view.id}>
                {`${view.displayName} (${view.id})`}
              </option>
            ))}
          </select>
          {providers.length === 0 ? (
            <p className={styles.hint}>
              Add an endpoint above first — this port has to have something to pass turns to.
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.tools}>
            Tools
          </label>
          <select
            id={ids.tools}
            className={styles.input}
            value={tools}
            onChange={(event) => {
              setTools(event.target.value as EndpointToolsRequest);
            }}
          >
            {TOOLS_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>

        {/* Asked whenever tools are wanted, not only when the address looks
            exposed. Which addresses count is the host's decision, made from
            what the listener actually bound; a checkbox that appeared based on
            this component's reading of a string would be that decision made
            twice, in the place with less information. */}
        {tools === 'on' ? (
          <div className={styles.checkbox}>
            <input
              id={ids.confirm}
              type="checkbox"
              checked={confirmed}
              onChange={(event) => {
                setConfirmed(event.target.checked);
              }}
            />
            <label htmlFor={ids.confirm}>
              I understand what offering tools means if this address can be reached from my network
            </label>
          </div>
        ) : null}

        {failure === null ? null : (
          <p className={styles.error} role="alert">
            {failure}
          </p>
        )}

        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={busy || providers.length === 0}>
            {busy ? 'Working…' : serving ? 'Apply' : 'Enable'}
          </button>
          {serving ? (
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={() => {
                void disable();
              }}
            >
              Disable
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

/**
 * What the host said, in words. Every branch is over a closed set the host
 * defined; nothing here is derived from the address string.
 */
function StatusReport({ endpoint }: { readonly endpoint: EndpointStatus }) {
  switch (endpoint.state) {
    case 'off':
      return <p className={styles.muted}>Not serving. Nothing is listening.</p>;
    case 'refused':
      return (
        <p className={styles.error} role="alert">
          Vela would not open the port ({endpoint.detail ?? 'no reason given'}). Nothing is
          listening.
        </p>
      );
    case 'bindFailed':
      return (
        <p className={styles.error} role="alert">
          The port could not be opened. Something else may already have it.{' '}
          {endpoint.detail ?? ''}
        </p>
      );
    case 'serving':
      return (
        <div className={styles.report}>
          <p className={styles.reportLine}>
            Serving on <code data-testid="local-endpoint-address">{endpoint.address}</code>
            {endpoint.loopback ? ' — reachable only from this machine' : ' — reachable from your network'}
          </p>
          <p className={styles.reportLine}>
            Passing turns to <strong>{endpoint.providerId}</strong>
          </p>
          <p
            className={
              endpoint.toolPolicy === 'exposed-enable-unconfirmed' ? styles.error : styles.reportLine
            }
            {...(endpoint.toolPolicy === 'exposed-enable-unconfirmed' ? { role: 'alert' } : {})}
          >
            {toolPolicyText(endpoint.toolsEnabled, endpoint.toolPolicy)}
          </p>
        </div>
      );
  }
}

/**
 * The host's reason code, in a sentence. The codes are a closed set and the
 * wording is the renderer's, which is the rule every enumerable host reason in
 * this project follows.
 */
export function toolPolicyText(enabled: boolean, policy: EndpointToolPolicy | null): string {
  switch (policy) {
    case 'loopback-default':
      return 'Tools on — only this machine can reach the port.';
    case 'exposed-default':
      return 'Tools off — this address can be reached from your network, so Vela does not offer them.';
    case 'forced-on':
      return 'Tools on — you asked for them.';
    case 'exposed-enable-unconfirmed':
      return 'Tools off. You asked for them on an address your network can reach; tick the box below and apply again to confirm that.';
    case 'forced-off':
      return 'Tools off — you asked for them to be off.';
    case null:
      return enabled ? 'Tools on.' : 'Tools off.';
  }
}
