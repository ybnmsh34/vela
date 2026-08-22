/**
 * The side panel: one artifact, its revisions, and three ways to look at it.
 *
 * ## Why Code is a peer of Preview and not a disclosure under it
 *
 * The contract puts a hard floor under this: at permission level `off` "Canvas
 * shows source for all four" languages, and a refused run still has to show the
 * user what they were refused. A source view that only existed as an expander
 * beneath a successful preview would vanish in exactly the states where it is the
 * only thing there is. So the three views are tabs over one artifact, and Code
 * works when nothing else does — including for `react` and `mermaid`, which this
 * build cannot draw at all and which arrive here as a `languageUnsupported`
 * refusal with their source intact.
 *
 * ## Following the newest version without trapping the user on it
 *
 * A model that revises an artifact three times in one turn should leave the
 * panel showing the third. A user who has clicked back to version 1 to read it
 * should stay there. Both are the same rule: the selection is `null` — meaning
 * "whatever is newest" — until the user picks one, and then it is what they
 * picked. An effect that reset the index whenever the version list grew would
 * yank the panel out from under the second user, and a plain `useState(last)`
 * would strand the first on version 1 forever.
 */

import { useMemo, useState } from 'react';

import type { SandboxRepository } from '@/data/sandbox-repository';
import type { ProjectId } from '@/platform/contract-project';

import type { ArtifactTrack } from './artifacts';
import { diffLines, summariseDiff } from './diff';
import { withScripts } from './document-run';
import { DocumentPreview } from './DocumentPreview';
import { useDocumentRun } from './use-document-run';
import styles from './CanvasPanel.module.css';

type CanvasView = 'preview' | 'code' | 'diff';

interface CanvasPanelProps {
  readonly track: ArtifactTrack;
  readonly sandbox: SandboxRepository;
  readonly projectId: ProjectId;
  readonly onClose: () => void;
}

export function CanvasPanel({ track, sandbox, projectId, onClose }: CanvasPanelProps) {
  const [pinned, setPinned] = useState<number | null>(null);
  const [view, setView] = useState<CanvasView>('preview');
  const [allowScripts, setAllowScripts] = useState(false);

  const latest = track.versions.length - 1;
  const selected = pinned === null ? latest : Math.min(pinned, latest);
  const version = track.versions[selected];

  const program = useMemo(() => {
    if (version === undefined) return null;
    return withScripts(version.program, allowScripts ? 'sandboxedNullOrigin' : 'denied');
  }, [version, allowScripts]);

  const run = useDocumentRun(sandbox, projectId, program);

  const scriptable =
    version?.program.language === 'html' || version?.program.language === 'react';

  if (version === undefined || program === null) return null;

  return (
    <aside className={styles.panel} aria-label={`Artifact: ${track.title}`}>
      <header className={styles.head}>
        <h2 className={styles.title}>{track.title}</h2>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label="Close the artifact panel"
        >
          ×
        </button>
      </header>

      <div className={styles.bar}>
        <div className={styles.tabs} role="tablist" aria-label="Artifact view">
          <ViewTab current={view} value="preview" onPick={setView}>
            Preview
          </ViewTab>
          <ViewTab current={view} value="code" onPick={setView}>
            Code
          </ViewTab>
          <ViewTab current={view} value="diff" onPick={setView} disabled={selected === 0}>
            Changes
          </ViewTab>
        </div>

        {track.versions.length > 1 ? (
          <div className={styles.versions} role="group" aria-label="Version">
            {track.versions.map((candidate) => (
              <button
                key={candidate.index}
                type="button"
                className={styles.version}
                aria-pressed={candidate.index === selected}
                onClick={() => setPinned(candidate.index)}
              >
                v{candidate.index + 1}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {view === 'preview' ? (
        <>
          <DocumentPreview
            key={`${String(selected)}:${String(allowScripts)}`}
            program={program}
            run={run}
            title={track.title}
          />
          {scriptable ? (
            <label className={styles.scripts}>
              <input
                type="checkbox"
                checked={allowScripts}
                onChange={(event) => setAllowScripts(event.target.checked)}
              />
              {/* Toggling this is not a setting: it builds a different program,
                  which is a different run with its own approval. The contract
                  puts `scripts` on the program for exactly this reason. */}
              Allow this page&rsquo;s script to run in the isolated frame
            </label>
          ) : null}
        </>
      ) : null}

      {view === 'code' ? (
        <pre className={styles.code} data-testid="canvas-code">
          <code>{version.program.source}</code>
        </pre>
      ) : null}

      {view === 'diff' ? <DiffView track={track} selected={selected} /> : null}
    </aside>
  );
}

function ViewTab({
  current,
  value,
  onPick,
  disabled = false,
  children,
}: {
  readonly current: CanvasView;
  readonly value: CanvasView;
  readonly onPick: (view: CanvasView) => void;
  readonly disabled?: boolean | undefined;
  readonly children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      className={styles.tab}
      aria-selected={current === value}
      disabled={disabled}
      onClick={() => onPick(value)}
    >
      {children}
    </button>
  );
}

/**
 * What changed between the selected version and the one before it.
 *
 * Against the *previous* version rather than against the first, because the
 * question a version rail answers is "what did this revision do" — a diff against
 * the original grows monotonically and stops being readable by version four.
 */
function DiffView({ track, selected }: { readonly track: ArtifactTrack; readonly selected: number }) {
  const before = track.versions[selected - 1];
  const after = track.versions[selected];
  const rows = useMemo(
    () => (before === undefined || after === undefined
      ? []
      : diffLines(before.program.source, after.program.source)),
    [before, after],
  );
  const summary = useMemo(() => summariseDiff(rows), [rows]);

  if (before === undefined || after === undefined) return null;

  return (
    <div className={styles.diff} data-testid="canvas-diff">
      <p className={styles.diffLead}>
        v{selected} → v{selected + 1} · {summary.added} added, {summary.removed} removed
      </p>
      <pre className={styles.diffBody}>
        {rows.map((row, index) => (
          <span key={index} className={styles.diffRow} data-kind={row.kind}>
            {row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '}
            {row.text}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  );
}
