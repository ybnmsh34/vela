/**
 * The five things a session is configured with **before the first message**.
 *
 * The spec is emphatic that this happens up front — environment, project
 * folder, model, permission mode — and the reason is that every one of them
 * changes what a message *means*. A prompt sent before the permission mode is
 * settled has already been answered under whatever mode happened to be in
 * force. This build adds a fifth to the spec's four, the worktree name, because
 * a session here *is* a worktree and there is nothing else to tell two of them
 * apart by; the footnote on screen counts five for that reason, and `isComplete`
 * in `src/state/code-workspace-store.ts` refuses a draft until all six of its
 * fields are set — five controls, six fields, because a model is a provider and
 * an id.
 *
 * So the form is a gate, not a preference sheet: until it is complete there is
 * no session, and until there is a session there is no composer to type into.
 * That is the whole of the rule, and it is what
 * `src/features/code/CodeWorkspace.test.tsx` checks.
 *
 * ## What is recorded and what is enforced
 *
 * Nothing in this build executes a tool. The permission mode is recorded on the
 * session and shown in the workspace header and the chat pane; it gates nothing,
 * because there is nothing yet to gate. The footnote at the bottom of this form
 * says exactly that, on screen, rather than implying an enforcement that would
 * arrive with the agent loop. Conventions §10: an honesty readout goes where the
 * user is, not in a comment.
 */

import { useId, useState } from 'react';

import {
  useCodeWorkspaceStore,
  worktreeKey,
  type CodeEnvironment,
  type PermissionMode,
  type StartSessionRefusal,
} from '@/state/code-workspace-store';

import { useCodeModels } from './use-code-models';
import styles from './CodeWorkspace.module.css';

/** Total over the union, so a new environment cannot ship without a sentence. */
const ENVIRONMENTS: Record<CodeEnvironment, string> = {
  local: 'Local — this machine, your own shell',
  container: 'Container — Docker or Podman on this machine',
  ssh: 'SSH — a machine you own, reached over SSH',
  wsl: 'WSL — a Windows Subsystem for Linux distribution',
};

/**
 * Total over the union. The keys are the settings keys from the spec's table;
 * the sentences are what each mode lets run without asking.
 */
const PERMISSION_MODES: Record<PermissionMode, string> = {
  default: 'Manual — reads only; every edit and command is asked',
  acceptEdits: 'Accept edits — reads, file edits and common filesystem commands',
  plan: 'Plan — reads only, and a plan before anything changes',
  auto: 'Auto — everything, with no prompt',
};

const REFUSALS: Record<StartSessionRefusal, string> = {
  incomplete: 'Fill in every field above before starting the session.',
  worktreeTaken: 'A session already has that worktree. Isolation means one session per worktree.',
};

export function SessionSetup() {
  const startSession = useCodeWorkspaceStore((state) => state.startSession);
  const sessions = useCodeWorkspaceStore((state) => state.sessions);
  const models = useCodeModels();

  const [worktree, setWorktree] = useState('');
  const [folder, setFolder] = useState('');
  const [environment, setEnvironment] = useState<CodeEnvironment | null>(null);
  const [choice, setChoice] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);
  const [refusal, setRefusal] = useState<StartSessionRefusal | null>(null);

  const ids = useId();
  const selected = models.choices.find(
    (candidate) => `${candidate.providerId}::${candidate.modelId}` === choice,
  );

  // Said *before* Start is pressed, because a case-folded registry that only
  // objects on submit reads as arbitrary: the name in the list is spelled
  // differently from the name in the field.
  const clash = sessions.find((session) => session.id === worktreeKey(worktree));

  return (
    <form
      className={styles.setup}
      aria-label="New session"
      onSubmit={(event) => {
        event.preventDefault();
        const result = startSession({
          worktree,
          folder,
          environment,
          providerId: selected?.providerId ?? '',
          modelId: selected?.modelId ?? '',
          permissionMode,
        });
        setRefusal(result.ok ? null : result.reason);
      }}
    >
      <h2 className={styles.setupTitle}>Start a session</h2>
      <p className={styles.setupLead}>
        Each session works in its own git worktree, so changes in one do not reach another until
        you commit them. All five choices below are made before the first message.
      </p>

      <label className={styles.field} htmlFor={`${ids}-worktree`}>
        <span className={styles.fieldLabel}>Worktree name</span>
        <input
          id={`${ids}-worktree`}
          className={styles.input}
          value={worktree}
          onChange={(event) => setWorktree(event.target.value)}
        />
      </label>
      {clash !== undefined ? (
        <p className={styles.fieldNote} role="status">
          “{clash.worktree}” already has a session. Worktree names are compared without regard to
          case, because two names differing only by case are one directory on Windows and macOS.
        </p>
      ) : null}

      <label className={styles.field} htmlFor={`${ids}-folder`}>
        <span className={styles.fieldLabel}>Project folder</span>
        <input
          id={`${ids}-folder`}
          className={styles.input}
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
        />
      </label>

      <fieldset className={styles.fieldset}>
        <legend className={styles.fieldLabel}>Environment</legend>
        {(Object.keys(ENVIRONMENTS) as CodeEnvironment[]).map((value) => (
          <label key={value} className={styles.choice}>
            <input
              type="radio"
              name={`${ids}-environment`}
              value={value}
              checked={environment === value}
              onChange={() => setEnvironment(value)}
            />
            <span>{ENVIRONMENTS[value]}</span>
          </label>
        ))}
      </fieldset>

      <label className={styles.field} htmlFor={`${ids}-model`}>
        <span className={styles.fieldLabel}>Model</span>
        <select
          id={`${ids}-model`}
          className={styles.input}
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
        >
          <option value="">Choose a model…</option>
          {models.choices.map((candidate) => (
            <option
              key={`${candidate.providerId}::${candidate.modelId}`}
              value={`${candidate.providerId}::${candidate.modelId}`}
            >
              {candidate.label}
            </option>
          ))}
        </select>
      </label>
      {models.status === 'ready' && models.choices.length === 0 ? (
        <p className={styles.fieldNote} role="status">
          No endpoint is configured with a model yet. Add one in the model picker on the main
          window, then reopen this workspace.
        </p>
      ) : null}

      <label className={styles.field} htmlFor={`${ids}-mode`}>
        <span className={styles.fieldLabel}>Permission mode</span>
        <select
          id={`${ids}-mode`}
          className={styles.input}
          value={permissionMode ?? ''}
          onChange={(event) =>
            setPermissionMode(event.target.value === '' ? null : (event.target.value as PermissionMode))
          }
        >
          <option value="">Choose a mode…</option>
          {(Object.keys(PERMISSION_MODES) as PermissionMode[]).map((value) => (
            <option key={value} value={value}>
              {PERMISSION_MODES[value]}
            </option>
          ))}
        </select>
      </label>

      {refusal !== null ? (
        <p className={styles.refusal} role="alert">
          {REFUSALS[refusal]}
        </p>
      ) : null}

      <button type="submit" className={styles.primary}>
        Start session
      </button>

      <p className={styles.footnote}>
        Vela records the permission mode and shows it on the session. It does not yet enforce one:
        this build runs no tool and executes no command, so there is nothing for a mode to gate.
      </p>
    </form>
  );
}
