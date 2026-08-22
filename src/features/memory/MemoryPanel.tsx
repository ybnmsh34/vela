/**
 * The memory pane: everything Vela remembers, and the only place it is written.
 *
 * ## Why a plain, editable list rather than an opaque store
 *
 * `docs/references/mindshub-cowork.md`'s memory is a **transparent file the
 * user edits**, and for a local-first application that keeps everything on the
 * user's own machine that is the right shape: a store the user cannot read is a
 * store they cannot correct, and a wrong remembered fact is worse than a
 * forgotten one because it silently steers every later answer. This pane is
 * Vela's version of that transparency — every entry the model will be shown is
 * on screen, in the order it will be shown, and each one can be reworded,
 * pinned or deleted on the spot.
 *
 * It is not yet a file on disk. `docs/vela-feature-spec.md` MEM-1 wants a
 * markdown memory file rendered after every write and reparsed by a filesystem
 * watcher, and that is a two-writer problem with no merge story written down —
 * `src/platform/contract-project.ts` refuses the same trade for project
 * instructions and gives the argument. What exists is the store, this pane, and
 * the read path. Nothing here may be read as saying the file exists.
 *
 * ## What writes here
 *
 * **The user, through this pane, and nothing else.** MEM-1 also describes a
 * post-turn extraction pass that decides for itself what was worth remembering
 * and writes it without being asked; it is not built, no turn calls
 * `memory_add`, and this pane says so out loud at the bottom rather than
 * leaving a user to assume their chats are being mined.
 *
 * ## Scope
 *
 * Global only, because nothing in the renderer knows which project a
 * *conversation* belongs to — `ConversationSummary` carries no project id. The
 * host's project scope is real and tested and is not reachable from here.
 *
 * That sentence used to end "and there is no project surface". One was built
 * (`src/features/projects/`) and this did not change, because the surface
 * answers a different question: which project the **window** is in, not which
 * one this conversation is in. Scoping memory to the former would file a user's
 * remembered facts under whichever project happened to be selected at the time.
 * The intro sentence below says these notes go to conversations "not in a
 * project", and that phrasing predates any project surface existing —
 * `use-conversation.ts` reads this scope for **every** conversation, so a reader
 * of this file should not take it as evidence that a project-scoped path exists.
 */

import { useRef, useState } from 'react';

import { ModalSurface } from '@/components/ModalSurface';
import { MEMORY_CONTENT_MAX_CHARS, type MemoryCategory, type MemoryEntry } from '@/platform/contract';

import styles from './MemoryPanel.module.css';
import { useMemory } from './use-memory';
import type { MemoryController } from './use-memory';

/**
 * The words a user reads for each category, owned here.
 *
 * The wire type is a closed enum precisely so the renderer writes every
 * sentence and the host never invents one — the same discipline the error
 * causes keep. Order matches `src/lib/memory-prompt.ts`'s headings, so the
 * pane lists memory in the order the model will be shown it.
 */
const CATEGORY_LABELS: readonly (readonly [MemoryCategory, string])[] = [
  ['roleContext', 'Role and context'],
  ['commsPrefs', 'Communication preferences'],
  ['techPrefs', 'Technical preferences'],
  ['projectDetails', 'Project details'],
  ['other', 'Other'],
];

function labelOf(category: MemoryCategory): string {
  return CATEGORY_LABELS.find(([value]) => value === category)?.[1] ?? 'Other';
}

interface MemoryPanelProps {
  readonly onClose: () => void;
  /** Substituted in tests; defaults to one built over the platform adapter. */
  readonly controller?: MemoryController;
}

export function MemoryPanel({ onClose, controller }: MemoryPanelProps) {
  // Called unconditionally — hooks may not be skipped — and its result is
  // discarded when the caller supplied one. The alternative is two components.
  const own = useMemory();
  const memory = controller ?? own;

  const closeRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState('');
  const [category, setCategory] = useState<MemoryCategory>('techPrefs');

  const tooLong = [...draft].length > MEMORY_CONTENT_MAX_CHARS;
  const canSave = draft.trim() !== '' && !tooLong;

  return (
    <ModalSurface
      labelledBy="memory-title"
      describedBy="memory-intro"
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
        <h2 id="memory-title" className={styles.title}>
          Memory
        </h2>
        <button type="button" ref={closeRef} className={styles.close} onClick={onClose}>
          Close
        </button>
      </div>

      <p id="memory-intro" className={styles.intro}>
        These notes are sent with every message in conversations that are not in a project. They
        stay on this device.
      </p>

      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) return;
          const content = draft;
          setDraft('');
          void memory.remember(content, category);
        }}
      >
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Remember something</span>
          <textarea
            className={styles.input}
            value={draft}
            rows={2}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </label>
        <div className={styles.composerRow}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Category</span>
            <select
              className={styles.select}
              value={category}
              onChange={(event) => {
                setCategory(event.target.value as MemoryCategory);
              }}
            >
              {CATEGORY_LABELS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={styles.save} disabled={!canSave}>
            Remember this
          </button>
        </div>
        {tooLong && (
          <p className={styles.error} role="status">
            Too long · a memory is one fact, at most {MEMORY_CONTENT_MAX_CHARS} characters
          </p>
        )}
      </form>

      {memory.problem !== null && (
        <p className={styles.error} role="status">
          That did not save · {memory.problem}
        </p>
      )}

      {memory.state.status === 'loading' && (
        <p className={styles.note} data-testid="memory-loading">
          Reading memory…
        </p>
      )}

      {memory.state.status === 'error' && (
        <p className={styles.error} role="status">
          Memory unavailable · {memory.state.code}
        </p>
      )}

      {memory.state.status === 'ready' && memory.state.entries.length === 0 && (
        <p className={styles.note}>Nothing is remembered yet.</p>
      )}

      {memory.state.status === 'ready' && memory.state.entries.length > 0 && (
        <ul className={styles.list}>
          {memory.state.entries.map((entry) => (
            <MemoryRow key={entry.id} entry={entry} memory={memory} />
          ))}
        </ul>
      )}

      <p className={styles.footnote}>
        Vela only remembers what you write here. Nothing is added automatically from your
        conversations.
      </p>
    </ModalSurface>
  );
}

/**
 * One entry, editable in place.
 *
 * The textarea is uncontrolled between edits — its value is committed on blur
 * and on Enter — so a slow host round trip cannot swallow a keystroke that has
 * already been typed.
 */
function MemoryRow({
  entry,
  memory,
}: {
  readonly entry: MemoryEntry;
  readonly memory: MemoryController;
}) {
  const [text, setText] = useState(entry.content);

  const commit = (): void => {
    const next = text.trim();
    if (next === '' || next === entry.content) {
      setText(entry.content);
      return;
    }
    void memory.amend(entry.id, next);
  };

  return (
    <li className={styles.row}>
      <span className={styles.category}>{labelOf(entry.category)}</span>
      <textarea
        className={styles.rowInput}
        aria-label={`Memory: ${entry.content}`}
        value={text}
        rows={1}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) return;
          event.preventDefault();
          commit();
        }}
      />
      <div className={styles.rowActions}>
        <button
          type="button"
          className={entry.pinned ? `${styles.pin} ${styles.pinned}` : styles.pin}
          aria-pressed={entry.pinned}
          onClick={() => {
            void memory.setPinned(entry.id, !entry.pinned);
          }}
        >
          {entry.pinned ? 'Pinned' : 'Pin'}
        </button>
        <button
          type="button"
          className={styles.forget}
          aria-label={`Forget: ${entry.content}`}
          onClick={() => {
            void memory.forget(entry.id);
          }}
        >
          Forget
        </button>
      </div>
    </li>
  );
}
