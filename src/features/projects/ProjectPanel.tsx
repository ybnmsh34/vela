/**
 * The projects pane: which project this window is in, and what that project
 * tells the model.
 *
 * ## What the instructions box actually does, said here because it is not
 * obvious from the box
 *
 * The text saved here is read by `src/runtime/project-context.ts` when a run
 * starts and becomes part of the system message the model is sent. That is the
 * **agent-run** path only — the toggle in the composer. An ordinary send goes
 * through `chat_send`, which has no context seam on it, and carries the user's
 * memory but not their project's instructions.
 *
 * That asymmetry is a real limitation and not a subtlety to be hidden: a user
 * who writes "always answer in French", sends an ordinary message, and gets
 * English back would otherwise conclude the box does nothing. So the pane says
 * which path uses it, in the footnote, in the same words this comment uses.
 *
 * ## Why a switcher and not a picker per conversation
 *
 * Because `ConversationSummary` carries no project id, so the renderer cannot
 * ask which project a conversation is in — only which project the *window* is
 * in. Moving a conversation between projects is `project_move_conversation`,
 * which exists on the host and has no surface; building one means deciding what
 * a conversation list grouped by project looks like, which is a bigger question
 * than this pane. Until then the window's project is what a run belongs to, and
 * this is where it is chosen.
 */

import { useEffect, useRef, useState } from 'react';

import { ModalSurface } from '@/components/ModalSurface';
import {
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  PROJECT_NAME_MAX_CHARS,
} from '@/platform/contract-project';

import styles from './ProjectPanel.module.css';
import { useProjects, type ProjectsController } from './use-projects';

interface ProjectPanelProps {
  readonly onClose: () => void;
  /** Substituted in tests; defaults to one built over the platform adapter. */
  readonly controller?: ProjectsController;
}

export function ProjectPanel({ onClose, controller }: ProjectPanelProps) {
  // Called unconditionally — hooks may not be skipped — and its result is
  // discarded when the caller supplied one. The alternative is two components.
  const own = useProjects();
  const projects = controller ?? own;

  const closeRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState('');
  const [name, setName] = useState('');
  /**
   * The exact text the host last said it stored, or `null` for "nothing has
   * been saved from this pane for this project".
   *
   * A string rather than a boolean, and set only from a `save` that reported
   * success. A boolean cleared by the effect below flickers: the save resolves,
   * `instructions` changes, the effect runs, and the acknowledgement appears and
   * vanishes inside one commit — visible to nobody and a race for any test that
   * looks for it. Comparing text answers the question the user is actually
   * asking, which is whether *what is in the box* is what is stored.
   */
  const [savedText, setSavedText] = useState<string | null>(null);

  const selectedProjectId = projects.selectedProjectId;
  const instructions = projects.instructions;

  // The box follows the host, not the other way round: switching project, or a
  // save coming back, replaces what is in it.
  useEffect(() => {
    setDraft(instructions ?? '');
  }, [selectedProjectId, instructions]);

  // A different project's acknowledgement is not this one's.
  useEffect(() => {
    setSavedText(null);
  }, [selectedProjectId]);

  const tooLong = [...draft].length > PROJECT_INSTRUCTIONS_MAX_CHARS;
  const nameTooLong = [...name].length > PROJECT_NAME_MAX_CHARS;
  const canSave = selectedProjectId !== null && instructions !== null && !tooLong;
  const canCreate = name.trim() !== '' && !nameTooLong;

  return (
    <ModalSurface
      labelledBy="projects-title"
      describedBy="projects-intro"
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
        <h2 id="projects-title" className={styles.title}>
          Projects
        </h2>
        {/* Named for what it closes, not for the verb alone: a bare "Close"
            answered to the same name as the caption control that quits Vela.
            `src/app/close-collision.test.tsx`. */}
        <button
          type="button"
          ref={closeRef}
          className={styles.close}
          onClick={onClose}
          aria-label="Close the projects panel"
        >
          Close
        </button>
      </div>

      <p id="projects-intro" className={styles.intro}>
        A project holds instructions that are sent with every agent run started while it is open.
      </p>

      {projects.state.status === 'loading' && (
        <p className={styles.note} data-testid="projects-loading">
          Reading projects…
        </p>
      )}

      {projects.state.status === 'error' && (
        <p className={styles.error} role="status">
          Projects unavailable · {projects.state.code}
        </p>
      )}

      {projects.state.status === 'ready' && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Working in</span>
          <select
            className={styles.select}
            aria-label="Working in"
            value={selectedProjectId ?? ''}
            onChange={(event) => {
              projects.select(event.target.value);
            }}
          >
            {selectedProjectId === null && <option value="">No project</option>}
            {projects.state.projects.map((summary) => (
              <option key={summary.id} value={summary.id}>
                {summary.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <form
        className={styles.row}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canCreate) return;
          const wanted = name.trim();
          setName('');
          void projects.create(wanted);
        }}
      >
        <label className={styles.field}>
          <span className={styles.fieldLabel}>New project</span>
          <input
            className={styles.input}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>
        <button type="submit" className={styles.secondary} disabled={!canCreate}>
          Create
        </button>
      </form>

      {nameTooLong && (
        <p className={styles.error} role="status">
          Too long · a project name is at most {PROJECT_NAME_MAX_CHARS} characters
        </p>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) return;
          const wanted = draft;
          void projects.save(wanted).then((ok) => {
            if (ok) setSavedText(wanted);
          });
        }}
      >
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Instructions for this project</span>
          <textarea
            className={styles.input}
            aria-label="Instructions for this project"
            value={draft}
            rows={6}
            disabled={selectedProjectId === null || instructions === null}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </label>
        <div className={styles.row}>
          <button type="submit" className={styles.save} disabled={!canSave}>
            Save instructions
          </button>
          {savedText !== null && savedText === draft && (
            <span className={styles.note} role="status">
              Saved
            </span>
          )}
        </div>
        {tooLong && (
          <p className={styles.error} role="status">
            Too long · instructions are at most {PROJECT_INSTRUCTIONS_MAX_CHARS} characters
          </p>
        )}
      </form>

      {projects.problem !== null && (
        <p className={styles.error} role="status">
          That did not save · {projects.problem}
        </p>
      )}

      <p className={styles.footnote}>
        Instructions reach the model on an agent run — the toggle beside the composer. An ordinary
        message is sent without them.
      </p>
    </ModalSurface>
  );
}
