/**
 * The styles pane: how Vela should answer, what the user has told it standing,
 * whether this window is private — and, underneath all three, **the resolved
 * result**: which of those layers actually reaches the model, on which path.
 *
 * ## Why the resolved result is the point of this pane and not a nicety
 *
 * There are three sources of instruction in front of a turn and they do not all
 * arrive. `ProjectPanel.tsx` already discloses that a project's instructions
 * ride an agent run and not an ordinary send — a real asymmetry, honestly
 * written down, in a different pane, in a footnote. A user who has written
 * something in both boxes has no way to find out what is actually in front of
 * their next message.
 *
 * So the pane renders {@link resolveInstructionLayers} itself, for a path the
 * user picks, and prints each layer's own `why` string verbatim. The copy is not
 * composed here: if the resolution and the sentence could be written separately
 * they could disagree, and a pane that said "applied" over a layer the resolver
 * drops would be worse than the footnote it replaces.
 *
 * ## What this pane is allowed to promise about incognito
 *
 * Only what `src/platform/incognito-adapter.ts` enforces, in that file's own
 * terms. Its four stated limits are reproduced here as list items because a
 * privacy mode a user can be wrong about is worse than none — and they are the
 * limits, not a hedge: the endpoint, a configured MCP server, the operating
 * system, and anything written before the mode was entered.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { ModalSurface } from '@/components/ModalSurface';
import { createProjectsRepository } from '@/data/projects-repository';
import {
  BUILT_IN_STYLES,
  resolveInstructionLayers,
  type ProjectInstructionsState,
  type SendPath,
  type StyleId,
} from '@/lib/instruction-layers';
import { usePlatform } from '@/platform/PlatformProvider';
import { useIncognitoStore } from '@/state/incognito-store';
import { useProjectStore } from '@/state/project-store';
import { INSTRUCTIONS_MAX_CHARS, useStyleStore } from '@/state/style-store';

import styles from './StylePanel.module.css';

interface StylePanelProps {
  readonly onClose: () => void;
}

/**
 * What the pane says happened to the host's debug log, in the user's words.
 *
 * `'failed'` is not softened. The whole reason the log is disarmed on entering
 * incognito is that it records raw provider traffic to a file; a user whose
 * disarm failed is in a mode that is not doing what its name says, and telling
 * them so is the only useful thing this pane can do about it.
 */
const DEBUG_LOG_SENTENCE: Readonly<Record<'checking' | 'was-off' | 'turned-off' | 'failed', string>> =
  Object.freeze({
    checking: 'Checking whether the provider debug log is on…',
    'was-off': 'The provider debug log was already off.',
    'turned-off':
      'The provider debug log was on and has been switched off. It is not switched back on when you leave.',
    failed:
      'The provider debug log could not be switched off. Raw provider traffic may still be written to disk — leave incognito, or turn the log off from diagnostics, before continuing.',
  });

export function StylePanel({ onClose }: StylePanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  const styleId = useStyleStore((state) => state.styleId);
  const customInstructions = useStyleStore((state) => state.customInstructions);
  const setStyleId = useStyleStore((state) => state.setStyleId);
  const setCustomInstructions = useStyleStore((state) => state.setCustomInstructions);

  const incognito = useIncognitoStore((state) => state.active);
  const setIncognito = useIncognitoStore((state) => state.setActive);
  const debugLog = useIncognitoStore((state) => state.debugLog);

  const [path, setPath] = useState<SendPath>('chat');

  const project = useProjectInstructions();

  const layers = useMemo(
    () => resolveInstructionLayers({ styleId, customInstructions, project, path }),
    [styleId, customInstructions, project, path],
  );

  const tooLong = customInstructions.length > INSTRUCTIONS_MAX_CHARS;

  return (
    <ModalSurface
      role="dialog"
      labelledBy="styles-title"
      describedBy="styles-intro"
      scrimClassName={styles.scrim}
      className={styles.dialog}
      initialFocus={closeRef}
      onDismiss={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={styles.head}>
        <h2 id="styles-title" className={styles.title}>
          Style and instructions
        </h2>
        <button type="button" ref={closeRef} className={styles.close} onClick={onClose}>
          Close
        </button>
      </div>

      <p id="styles-intro" className={styles.intro}>
        A style and your own standing instructions are sent with every turn — on an ordinary message
        and on an agent run alike. They are kept for this session only: Vela has no host command
        that can store them, so closing the window forgets them.
      </p>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Style</h3>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Answer style</span>
          <select
            className={styles.select}
            aria-label="Answer style"
            value={styleId}
            onChange={(event) => {
              setStyleId(event.target.value as StyleId);
            }}
          >
            {BUILT_IN_STYLES.map((style) => (
              <option key={style.id} value={style.id}>
                {style.label} — {style.blurb}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Your instructions</h3>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Sent in front of every message</span>
          <textarea
            className={styles.input}
            aria-label="Sent in front of every message"
            rows={4}
            value={customInstructions}
            onChange={(event) => {
              setCustomInstructions(event.target.value);
            }}
          />
        </label>
        {tooLong && (
          <p className={styles.error} role="status">
            Too long · instructions are at most {INSTRUCTIONS_MAX_CHARS} characters
          </p>
        )}
      </section>

      <section className={styles.privacy}>
        <div className={styles.privacyRow}>
          <h3 className={styles.sectionTitle}>Incognito</h3>
          <button
            type="button"
            className={styles.secondary}
            aria-pressed={incognito}
            onClick={() => {
              setIncognito(!incognito);
            }}
          >
            {incognito ? 'Leave incognito' : 'Enter incognito'}
          </button>
        </div>
        {/*
          Scoped to what is enforced, because the sentence it replaced was not.
          "This window writes nothing durable to this machine" was stated flatly
          and is false whenever the disarm below answers `failed`: the host's
          provider debug log is not a command this renderer issues, so refusing
          commands does not stop it. What the wrapper in
          `src/platform/incognito-adapter.ts` does guarantee — and what
          `incognito-adapter.test.ts` sweeps the whole contract for — is that
          every command classified `writes` is refused. That is the claim made
          here, and the debug log gets its own sentence directly underneath.

          The second clause is scoped for a second reason, found later and
          smaller. "It may still delete" left the reader to assume a delete only
          subtracts, and one of them does not: `project_delete` is `erases`, so
          it is forwarded, and `delete_project_reassigning` in
          `src-tauri/crates/vela-store/src/sqlite.rs` runs
          `UPDATE conversations SET project_id = ?2 WHERE project_id = ?1`
          alongside its `DELETE FROM projects`, in one transaction, so that no
          conversation is left unfiled. Nothing about this session is recorded by
          it — but rows on this machine do change, so the sentence says so
          instead of letting "refuses every command that would write" be read as
          a promise that nothing at all is written while the mode is on.
        */}
        {/*
          The testid is read by `instructions-and-incognito.test.tsx`, which
          holds this paragraph to the two properties above: that it says what is
          refused, and that it does not round the delete case off. Matched by
          testid rather than by a phrase, so a rewrite of the sentence meets the
          assertion instead of slipping past a stale regex.
        */}
        <p className={styles.note} data-testid="incognito-standing-note">
          In incognito this window refuses every command that would record something on this
          machine. It may still read, and it may still delete — and a delete can rewrite what is
          already stored: removing a project re-files its conversations onto your default project.
          Leaving discards the conversation held in it: the transcript is dropped from the window
          and was never written down.
        </p>
        {incognito && (
          <p className={styles.note} role="status" data-testid="incognito-debug-log">
            {DEBUG_LOG_SENTENCE[debugLog ?? 'checking']}
          </p>
        )}
        <p className={styles.note}>What it does not reach:</p>
        <ul className={styles.limits}>
          <li>The endpoint your message is sent to. What it keeps is its own to decide.</li>
          <li>Programs a configured MCP server starts on your machine.</li>
          <li>The operating system — swap, hibernation, crash dumps, a backup agent.</li>
          <li>Anything already written before you entered. Incognito is not a scrub.</li>
        </ul>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>What the next turn actually carries</h3>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>For this kind of turn</span>
          <select
            className={styles.select}
            aria-label="For this kind of turn"
            value={path}
            onChange={(event) => {
              setPath(event.target.value as SendPath);
            }}
          >
            <option value="chat">An ordinary message</option>
            <option value="agent">An agent run</option>
          </select>
        </label>
        <ul className={styles.layers} data-testid="resolved-layers">
          {layers.map((layer) => (
            <li key={layer.id} className={styles.layer} data-layer={layer.id}>
              <div className={styles.layerHead}>
                <span className={styles.layerLabel}>{layer.label}</span>
                <span className={styles.layerState} data-applies={layer.applies}>
                  {layer.applies ? 'Sent' : 'Not sent'}
                </span>
              </div>
              <p className={styles.layerWhy}>{layer.why}</p>
              {layer.text !== '' && <p className={styles.layerText}>{layer.text}</p>}
            </li>
          ))}
        </ul>
      </section>

      <p className={styles.footnote}>
        Where a project&rsquo;s instructions and yours conflict, the project&rsquo;s are sent last
        and are named as the ones to follow. That is an ordering and a sentence, not a guarantee
        about what the model does with them.
      </p>
    </ModalSurface>
  );
}

/**
 * This project's instructions, read for display only.
 *
 * **Read here rather than taken from the send path**, because the two want
 * different things: the send path deliberately does not read the body (see
 * `ProjectInstructionsState`), and this pane exists to show the user the words.
 * It is `project_get` — `no-write` in `COMMAND_DURABILITY`, so it is answered in
 * incognito too.
 *
 * The four states are kept apart all the way to the screen. A rejected read
 * answers `unreadable`, not `none`: "your instructions could not be read" and
 * "you have not written any" are different sentences and collapsing them is the
 * failure `projects-repository.ts` refuses to make on the way in.
 */
function useProjectInstructions(): ProjectInstructionsState {
  const adapter = usePlatform();
  const projectId = useProjectStore((state) => state.selectedProjectId);
  const [state, setState] = useState<ProjectInstructionsState>({ kind: 'unknown' });

  useEffect(() => {
    if (projectId === null) {
      setState({ kind: 'unknown' });
      return;
    }
    let live = true;
    const projects = createProjectsRepository(adapter);
    void projects.get(projectId).then(
      (view) => {
        if (!live) return;
        setState(view.instructions === '' ? { kind: 'none' } : { kind: 'text', text: view.instructions });
      },
      () => {
        if (live) setState({ kind: 'unreadable' });
      },
    );
    return () => {
      live = false;
    };
  }, [adapter, projectId]);

  return state;
}
