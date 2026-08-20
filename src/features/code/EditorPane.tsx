/**
 * The file editor pane: the session's open files, and the text of one of them.
 *
 * ## Why this pane exists in a build with no filesystem
 *
 * It is the only thing here that can *produce a change*, and without one the
 * diff review is a surface with no input — the shape of defect this repo keeps
 * finding, and the reason `src/app/App.tsx` spends four sections on joints that
 * were never made. `src/platform/contract.ts` declares no filesystem and no git
 * command, so there is no seam to read a working tree through and building one
 * is a Rust change this track was told not to make.
 *
 * So the baseline is the session's own last save rather than the bytes on disk,
 * and the pane says so on screen. When a git-diff or file-read command exists,
 * the change is here and it is one function: `baseline` stops being "what Save
 * last wrote" and becomes "what the host read". Nothing downstream moves —
 * `src/lib/text-diff.ts` takes two strings either way.
 *
 * ## Save clears the file's comments, deliberately
 *
 * A review comment is anchored to a line of a diff. Saving replaces the baseline
 * with the working text, so that diff is empty and every anchor into it points
 * at nothing. Dropping the comments is the honest outcome; keeping them would
 * leave a review attached to a file whose diff no longer has the lines it talks
 * about. `saveFile` in `src/state/code-workspace-store.ts` is where that happens.
 */

import { useId, useState } from 'react';

import { useCodeWorkspaceStore, workOf } from '@/state/code-workspace-store';

import styles from './CodeWorkspace.module.css';

export function EditorPane({ sessionId }: { readonly sessionId: string }) {
  const work = useCodeWorkspaceStore((state) => workOf(state, sessionId));
  const addFile = useCodeWorkspaceStore((state) => state.addFile);
  const editFile = useCodeWorkspaceStore((state) => state.editFile);
  const saveFile = useCodeWorkspaceStore((state) => state.saveFile);

  const [path, setPath] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const ids = useId();

  const open = work.files.find((file) => file.path === selectedPath) ?? work.files[0] ?? null;
  const dirty = open !== null && open.working !== open.baseline;

  return (
    <div className={styles.editorPane}>
      <form
        className={styles.addFile}
        onSubmit={(event) => {
          event.preventDefault();
          addFile(sessionId, path);
          setSelectedPath(path.trim());
          setPath('');
        }}
      >
        <label className={styles.fieldLabel} htmlFor={`${ids}-path`}>
          Open a file
        </label>
        <input
          id={`${ids}-path`}
          className={styles.input}
          placeholder="src/app/App.tsx"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <button type="submit" className={styles.paneButton}>
          Open
        </button>
      </form>

      {work.files.length > 0 ? (
        <div className={styles.fileList} role="list" aria-label="Open files">
          {work.files.map((file) => (
            <div key={file.path} role="listitem">
              <button
                type="button"
                className={styles.fileRow}
                aria-current={file.path === open?.path ? 'true' : undefined}
                onClick={() => setSelectedPath(file.path)}
              >
                <span className={styles.filePath}>{file.path}</span>
                {file.working !== file.baseline ? (
                  <span className={styles.fileStat}>unsaved</span>
                ) : null}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {open === null ? (
        <p className={styles.empty}>No file is open. Name one above to start editing.</p>
      ) : (
        <>
          <label className={styles.fieldLabel} htmlFor={`${ids}-body`}>
            {open.path}
          </label>
          <textarea
            id={`${ids}-body`}
            className={styles.code}
            value={open.working}
            spellCheck={false}
            onChange={(event) => editFile(sessionId, open.path, event.target.value)}
          />
          <div className={styles.editorBar}>
            <button
              type="button"
              className={styles.paneButton}
              disabled={!dirty}
              onClick={() => saveFile(sessionId, open.path)}
            >
              Save
            </button>
            <span className={styles.fieldNote}>
              Saving makes this text the new baseline, which empties the diff and clears this
              file’s review comments.
            </span>
          </div>
        </>
      )}

      <p className={styles.footnote}>
        These files live in this session only. Vela has no host command that reads or writes your
        working tree yet, so nothing here touches disk and the diff is against the last Save.
      </p>
    </div>
  );
}
