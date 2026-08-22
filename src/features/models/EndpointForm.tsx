/**
 * Add or edit an endpoint.
 *
 * ## The one rule this form exists to get right
 *
 * **"No API key" is a first-class, valid, complete configuration.** It is the
 * default the form opens on, it is worded as a choice rather than as an absence
 * ("This endpoint needs no key" — not "leave blank"), it produces no warning,
 * no red field, no asterisk, and no disabled Save. Most local runtimes have no
 * auth at all, and a form that treats that as a gap is a form that tells the
 * majority of Vela's users they have done something wrong.
 *
 * The credential input is not merely optional in that mode — it **does not
 * exist**. `credentialFieldLabel` is `null` for an unauthenticated endpoint, and
 * a field that is rendered-but-ignored is a question the user still has to
 * answer in their head.
 *
 * ## Validation
 *
 * Deferred to the host, deliberately. `settings_put_provider` is the
 * specification for what a valid endpoint is — including which field it blames
 * first when two are wrong — and a second implementation here would be a second
 * thing to drift. The form submits, and renders the host's refusal.
 *
 * ## The protocol chooser, and why it is the odd one out
 *
 * `KIND_CHOICES` and `AUTH_CHOICES` below are written here because they are
 * closed vocabularies the renderer is *supposed* to know: where a thing runs
 * and what shape its credential takes are UI concepts.
 *
 * The protocol list is not. It arrives as `protocols` — data the host sends on
 * the settings snapshot — and this file renders whatever it is given without
 * ever naming an entry. That is conventions §0.3 held for the one field most
 * likely to break it: an endpoint's wire dialect is a backend identity, and a
 * renderer that could spell one could branch on one. Adding a fourth protocol
 * is a variant in `vela_core::protocol` and **zero lines here**.
 */

import { useId, useState, type FormEvent } from 'react';

import type {
  AuthMode,
  ProviderKind,
  ProviderView,
  SettingsPutProviderReq,
  WireProtocolId,
  WireProtocolOption,
} from '@/platform/contract';
import { toPlatformError } from '@/platform/errors';

import styles from './EndpointForm.module.css';

/** The auth shapes the form offers, with the wording the user reads. */
const AUTH_CHOICES: readonly { readonly value: AuthKind; readonly label: string }[] = [
  { value: 'none', label: 'None — this endpoint needs no key' },
  { value: 'bearerToken', label: 'Bearer token' },
  { value: 'apiKeyHeader', label: 'Key in a request header' },
  { value: 'apiKeyQuery', label: 'Key in a query parameter' },
];

type AuthKind = AuthMode['type'];

const KIND_CHOICES: readonly { readonly value: ProviderKind; readonly label: string }[] = [
  { value: 'local', label: 'On this machine' },
  { value: 'remoteApi', label: 'A service I have a key for' },
  { value: 'remoteSubscription', label: 'A service I have an account with' },
];

interface EndpointFormProps {
  /** The endpoint being edited, or `null` to add a new one. */
  readonly editing?: ProviderView | null;
  /**
   * The protocol choices, straight off the settings snapshot. An empty list
   * renders no chooser at all — a host with nothing to offer must not produce
   * an empty dropdown for the user to puzzle over.
   */
  readonly protocols?: readonly WireProtocolOption[];
  readonly onSave: (config: SettingsPutProviderReq) => Promise<unknown>;
  /** Called with the credential the user typed, if they typed one. */
  readonly onStoreCredential?: (providerId: string, value: string) => Promise<void>;
  readonly onCancel?: () => void;
}

export function EndpointForm({
  editing = null,
  protocols = [],
  onSave,
  onStoreCredential,
  onCancel,
}: EndpointFormProps) {
  const ids = {
    name: useId(),
    id: useId(),
    url: useId(),
    model: useId(),
    kind: useId(),
    protocol: useId(),
    auth: useId(),
    header: useId(),
    credential: useId(),
    required: useId(),
  };

  const [displayName, setDisplayName] = useState(editing?.displayName ?? '');
  const [id, setId] = useState(editing?.id ?? '');
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '');
  const [modelId, setModelId] = useState(editing?.modelId ?? '');
  const [kind, setKind] = useState<ProviderKind>(editing?.kind ?? 'local');
  // The endpoint's own choice when editing; otherwise whatever the host listed
  // first. Not a name written here — the host decides which is the safe start,
  // because the host is the layer allowed to know what any of them are.
  const [protocol, setProtocol] = useState<WireProtocolId | null>(
    editing?.protocol ?? protocols[0]?.id ?? null,
  );
  const [authKind, setAuthKind] = useState<AuthKind>(editing?.authMode.type ?? 'none');
  const [headerName, setHeaderName] = useState(headerOf(editing?.authMode));
  const [credential, setCredential] = useState('');
  const [required, setRequired] = useState(editing?.authRequirement === 'required');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const effectiveId = (id.trim() === '' ? slugify(displayName) : id.trim());
  const credentialLabel = credentialFieldLabel(authKind);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const auth = authModeOf(authKind, headerName);
      const config: SettingsPutProviderReq = {
        id: effectiveId,
        displayName: displayName.trim(),
        kind,
        // Omitted when the host offered nothing to choose from, so the host's
        // own default stands rather than the renderer inventing one.
        ...(protocol === null ? {} : { protocol }),
        baseUrl: baseUrl.trim(),
        ...(modelId.trim() === '' ? {} : { modelId: modelId.trim() }),
        auth,
        // The requirement is only meaningful when there is a credential to
        // require. With `none` it is always `notRequired`, which is what makes
        // a keyless endpoint a success state rather than an unmet requirement.
        authRequirement: auth.type === 'none' ? 'notRequired' : required ? 'required' : 'optional',
      };
      await onSave(config);
      if (credential !== '' && onStoreCredential !== undefined) {
        await onStoreCredential(effectiveId, credential);
        setCredential('');
      }
      if (editing === null) {
        setDisplayName('');
        setId('');
        setBaseUrl('');
        setModelId('');
      }
    } catch (thrown) {
      setError(toPlatformError(thrown, 'settings_put_provider').message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        void submit(event);
      }}
      aria-label={editing === null ? 'Add an endpoint' : `Edit ${editing.displayName}`}
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.name}>
          Name
        </label>
        <input
          id={ids.name}
          className={styles.input}
          value={displayName}
          placeholder="The workstation in the study"
          onChange={(event) => {
            setDisplayName(event.target.value);
          }}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.id}>
          Identifier
        </label>
        <input
          id={ids.id}
          className={styles.input}
          value={id}
          readOnly={editing !== null}
          placeholder={slugify(displayName) === '' ? 'study-box' : slugify(displayName)}
          onChange={(event) => {
            setId(event.target.value);
          }}
        />
        <p className={styles.hint}>
          Used to file the endpoint and, if it has one, its key. Derived from the name if you leave
          it empty.
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.url}>
          Address
        </label>
        <input
          id={ids.url}
          className={styles.input}
          value={baseUrl}
          placeholder="http://127.0.0.1:8080/v1"
          onChange={(event) => {
            setBaseUrl(event.target.value);
          }}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.model}>
          Model <span className={styles.optional}>optional</span>
        </label>
        <input
          id={ids.model}
          className={styles.input}
          value={modelId}
          onChange={(event) => {
            setModelId(event.target.value);
          }}
        />
        <p className={styles.hint}>
          The name this endpoint knows the model by. Leave it empty if you would rather ask the
          endpoint what it has.
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.kind}>
          Where it runs
        </label>
        <select
          id={ids.kind}
          className={styles.input}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as ProviderKind);
          }}
        >
          {KIND_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>

      {/* Rendered only when the host offered something to choose. Every option,
          and every word of it, comes off the snapshot: this component cannot
          name a protocol, so it cannot branch on one. */}
      {protocols.length === 0 || protocol === null ? null : (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.protocol}>
            What it speaks
          </label>
          <select
            id={ids.protocol}
            className={styles.input}
            value={protocol}
            onChange={(event) => {
              setProtocol(event.target.value);
            }}
          >
            {protocols.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
          <p className={styles.hint}>
            {protocols.find((choice) => choice.id === protocol)?.summary ??
              'Vela asks rather than guessing: the address does not say which of these an endpoint serves.'}
          </p>
        </div>
      )}

      <div className={styles.field}>
        <label className={styles.label} htmlFor={ids.auth}>
          Authentication
        </label>
        <select
          id={ids.auth}
          className={styles.input}
          value={authKind}
          onChange={(event) => {
            setAuthKind(event.target.value as AuthKind);
          }}
        >
          {AUTH_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        {authKind === 'none' ? (
          <p className={styles.hint}>
            Nothing more to do. Most models running on your own machine take no key, and that is a
            complete configuration — not something left unfinished.
          </p>
        ) : null}
      </div>

      {authKind === 'apiKeyHeader' || authKind === 'apiKeyQuery' ? (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.header}>
            {authKind === 'apiKeyHeader' ? 'Header name' : 'Parameter name'}
          </label>
          <input
            id={ids.header}
            className={styles.input}
            value={headerName}
            onChange={(event) => {
              setHeaderName(event.target.value);
            }}
          />
        </div>
      ) : null}

      {/* Rendered only when the chosen shape actually has a credential. Not
          disabled, not greyed — absent. */}
      {credentialLabel === null ? null : (
        <>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={ids.credential}>
              {credentialLabel}
            </label>
            <input
              id={ids.credential}
              className={styles.input}
              type="password"
              value={credential}
              autoComplete="off"
              onChange={(event) => {
                setCredential(event.target.value);
              }}
            />
            <p className={styles.hint}>
              Goes straight to the operating system&apos;s keychain. Vela can ask whether one is
              stored; it can never read it back.
            </p>
          </div>

          <div className={styles.checkbox}>
            <input
              id={ids.required}
              type="checkbox"
              checked={required}
              onChange={(event) => {
                setRequired(event.target.checked);
              }}
            />
            <label htmlFor={ids.required}>This endpoint refuses requests without the key</label>
          </div>
        </>
      )}

      {error === null ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        <button type="submit" className={styles.save} disabled={saving}>
          {saving ? 'Saving…' : editing === null ? 'Add endpoint' : 'Save changes'}
        </button>
        {onCancel === undefined ? null : (
          <button type="button" className={styles.cancel} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** Mirrors `vela_core::auth::AuthMode::field_label`; `null` means render none. */
function credentialFieldLabel(kind: AuthKind): string | null {
  switch (kind) {
    case 'none':
      return null;
    case 'bearerToken':
      return 'Access token';
    case 'apiKeyHeader':
    case 'apiKeyQuery':
      return 'API key';
  }
}

function authModeOf(kind: AuthKind, name: string): AuthMode {
  switch (kind) {
    case 'none':
      return { type: 'none' };
    case 'bearerToken':
      return { type: 'bearerToken' };
    case 'apiKeyHeader':
      return { type: 'apiKeyHeader', header: name.trim() };
    case 'apiKeyQuery':
      return { type: 'apiKeyQuery', param: name.trim() };
  }
}

function headerOf(mode: AuthMode | undefined): string {
  if (mode === undefined) return '';
  if (mode.type === 'apiKeyHeader') return mode.header;
  if (mode.type === 'apiKeyQuery') return mode.param;
  return '';
}

/** A name the user typed → an id the host will accept: no spaces, no slashes. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
