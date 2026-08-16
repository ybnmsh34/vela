/**
 * The endpoint configuration surface: what is set up, and how to change it.
 *
 * A row states what the host computed and nothing else — `usable`,
 * `credentialCheck`, `credentialFieldLabel`, `security`. There is no branch on
 * an id anywhere in this file, which is why adding a backend to Vela changes
 * nothing here.
 *
 * Note the two states that look alike and are not: an endpoint with **no**
 * credential shape ("needs no key" — a finished configuration) and one that
 * requires a key it does not have ("waiting for a key" — an unfinished one).
 * They are distinguished by `credentialCheck`, never by `credentialPresent`,
 * because the second says nothing about whether a key was ever wanted.
 *
 * ## Focus
 *
 * This panel replaces the transcript rather than floating over it, and it is
 * opened from a menu item that unmounts itself in the act of opening it — so
 * unless the panel takes the keyboard, nothing has it. It takes the region
 * itself rather than the first control: the first thing a user needs here is to
 * know *where they are*, which is what a focused landmark announces, and
 * jumping straight to a control would skip the heading that says which screen
 * this is. On the way out the keyboard goes back through the ladder in
 * `src/state/focus-store.ts`, which lands it on the composer.
 */

import { useEffect, useRef, useState } from 'react';

import { DebugLogSwitch } from '@/features/diagnostics';
import type {
  ProviderView,
  SettingsPutProviderReq,
  WireProtocolOption,
} from '@/platform/contract';
import { returnFocusTo } from '@/state/focus-store';

import { EndpointForm } from './EndpointForm';
import { LocalEndpointSection } from './LocalEndpointSection';
import { SecurityNotice } from './SecurityNotice';
import styles from './EndpointsPanel.module.css';
import type { ProvidersState } from './use-providers';

interface EndpointsPanelProps {
  readonly state: ProvidersState;
  readonly onSave: (config: SettingsPutProviderReq) => Promise<unknown>;
  readonly onRemove: (providerId: string) => Promise<void>;
  readonly onStoreCredential: (providerId: string, value: string) => Promise<void>;
  readonly onClearCredential: (providerId: string) => Promise<void>;
  readonly onClose?: () => void;
}

export function EndpointsPanel({
  state,
  onSave,
  onRemove,
  onStoreCredential,
  onClearCredential,
  onClose,
}: EndpointsPanelProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const openedFrom = document.activeElement;
    panel.current?.focus();
    return () => {
      returnFocusTo(openedFrom);
    };
  }, []);

  return (
    <section className={styles.panel} aria-label="Endpoints" ref={panel} tabIndex={-1}>
      <header className={styles.header}>
        <h2 className={styles.heading}>Endpoints</h2>
        {onClose === undefined ? null : (
          <button type="button" className={styles.close} onClick={onClose}>
            Close
          </button>
        )}
      </header>

      {state.status === 'loading' ? (
        <p className={styles.muted}>Reading your configuration…</p>
      ) : state.status === 'error' ? (
        <p className={styles.error} role="alert">
          Vela could not read its own settings ({state.code}). Nothing has been changed.
        </p>
      ) : (
        <>
          <p className={styles.backend}>
            Keys are stored by: <code>{state.credentialBackend}</code>
          </p>

          {state.providers.length === 0 ? (
            <p className={styles.muted}>
              No endpoints yet. Add the address of a model running on this machine, or of a service
              you have a key for.
            </p>
          ) : (
            <ul className={styles.list}>
              {state.providers.map((view) => (
                <li key={view.id} className={styles.row}>
                  <EndpointRow
                    view={view}
                    protocols={state.protocols}
                    editing={editing === view.id}
                    onEdit={() => {
                      setEditing(editing === view.id ? null : view.id);
                    }}
                    onSave={onSave}
                    onRemove={onRemove}
                    onStoreCredential={onStoreCredential}
                    onClearCredential={onClearCredential}
                  />
                </li>
              ))}
            </ul>
          )}

          {adding ? (
            <EndpointForm
              protocols={state.protocols}
              onSave={onSave}
              onStoreCredential={onStoreCredential}
              onCancel={() => {
                setAdding(false);
              }}
            />
          ) : (
            <button
              type="button"
              className={styles.add}
              onClick={() => {
                setAdding(true);
              }}
            >
              Add an endpoint
            </button>
          )}

          {/* The other direction: this panel is where the endpoints Vela talks
              *to* are configured, and the local endpoint is one of them served
              back out. It needs the list above to choose from, which is the
              reason it is mounted here and not somewhere with a tidier name. */}
          <LocalEndpointSection providers={state.providers} />

          {/* This panel is where a user comes when an endpoint is misbehaving,
              which is exactly when the debug log is worth turning on and the
              only moment its `trace` ids mean anything. */}
          <DebugLogSwitch />
        </>
      )}
    </section>
  );
}

interface EndpointRowProps {
  readonly view: ProviderView;
  /** Carried straight through to the edit form. Never read here. */
  readonly protocols: readonly WireProtocolOption[];
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onSave: (config: SettingsPutProviderReq) => Promise<unknown>;
  readonly onRemove: (providerId: string) => Promise<void>;
  readonly onStoreCredential: (providerId: string, value: string) => Promise<void>;
  readonly onClearCredential: (providerId: string) => Promise<void>;
}

function EndpointRow({
  view,
  protocols,
  editing,
  onEdit,
  onSave,
  onRemove,
  onStoreCredential,
  onClearCredential,
}: EndpointRowProps) {
  return (
    <>
      <div className={styles.rowHead}>
        <div className={styles.rowIdentity}>
          <span className={styles.rowName}>{view.displayName}</span>
          <span className={styles.rowUrl}>{view.baseUrl}</span>
          <span className={styles.rowModel}>
            {view.modelId ?? 'No model named — ask the endpoint, or type one in'}
          </span>
        </div>
        <div className={styles.rowActions}>
          <span className={styles.credentialState}>{credentialText(view)}</span>
          <button type="button" className={styles.rowButton} onClick={onEdit}>
            {editing ? 'Done' : 'Edit'}
          </button>
          {view.credentialPresent ? (
            <button
              type="button"
              className={styles.rowButton}
              onClick={() => {
                void onClearCredential(view.id);
              }}
            >
              Forget key
            </button>
          ) : null}
          <button
            type="button"
            className={styles.rowDanger}
            onClick={() => {
              void onRemove(view.id);
            }}
          >
            Remove
          </button>
        </div>
      </div>

      <SecurityNotice security={view.security} />

      {editing ? (
        <EndpointForm
          editing={view}
          protocols={protocols}
          onSave={onSave}
          onStoreCredential={onStoreCredential}
          onCancel={onEdit}
        />
      ) : null}
    </>
  );
}

/**
 * The credential state, in one phrase.
 *
 * Branches on `credentialCheck` and `credentialFieldLabel` — the two things the
 * host computed — and never on `credentialPresent` alone, which cannot tell
 * "no key needed" from "key missing".
 */
export function credentialText(view: ProviderView): string {
  if (view.credentialFieldLabel === null) return 'No key needed';
  switch (view.credentialCheck) {
    case 'satisfied':
      return 'Key stored';
    case 'satisfiedWithoutCredential':
      return 'No key stored — this endpoint does not insist on one';
    case 'missingRequired':
      return 'Waiting for a key';
  }
}
