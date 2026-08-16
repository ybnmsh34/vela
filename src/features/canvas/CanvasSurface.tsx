/**
 * Canvas as the shell mounts it: the transcript in its slot, the artifact panel
 * beside it.
 *
 * ## Why this wraps rather than sits beside
 *
 * The same reason `ModelWorkspace` wraps the transcript: the panel needs what
 * the transcript produced, and a parent cannot read its children. The
 * conversation surface reports its assistant messages outward — one array of
 * strings, no canvas type in sight, so that feature still imports nothing from
 * this one — and this component turns them into artifacts. The joint is in the
 * composition root, which is where `src/app/App.tsx` says both of Vela's other
 * cross-feature joints belong, and where the two that were *missing* were
 * eventually found.
 *
 * ## "Auto-rendered", and what happens when the user disagrees
 *
 * A new artifact opens the panel; that is the "auto" in the feature. Closing it
 * must stick, or the panel becomes a thing that keeps reappearing — but it must
 * stick to *that* artifact rather than to the panel, or a user who dismissed one
 * chart would never be shown the next. So a dismissal records the exact
 * artifact-and-version it dismissed, and anything newer opens again. The rail on
 * the right is how a dismissed artifact comes back without a new turn.
 */

import { useMemo, useState, type ReactNode } from 'react';

import { parseMarkdown } from '@/lib/markdown-parser';
import type { ProjectId } from '@/platform/contract-project';

import { collectArtifacts, type ArtifactTrack } from './artifacts';
import { CanvasPanel } from './CanvasPanel';
import { LocalDocumentHost, type DocumentHost } from './document-host';
import styles from './CanvasSurface.module.css';

interface CanvasSurfaceProps {
  /** Every assistant message in the open conversation, oldest first. */
  readonly assistantTexts: readonly string[];
  /**
   * Which project a document run belongs to. Handed in rather than reached for,
   * because the contract is explicit that no code under `src/` should decide for
   * itself what "the default project" is — and the composition root is the one
   * place that knows which project the window is in.
   *
   * `null` means the host has not said yet, or could not. The panel does not
   * open on `null`: a document run is a sandboxed program executing inside a
   * project's own filesystem scope, and there is no project to scope it to. The
   * artifact rail still lists what the model produced, so nothing is hidden —
   * only the running of it waits.
   */
  readonly projectId: ProjectId | null;
  /** Injected by tests, so a suite can drive a host at a different permission level. */
  readonly host?: DocumentHost | undefined;
  /** The transcript. */
  readonly children: ReactNode;
}

/** The artifact-and-version a dismissal is about. */
function signatureOf(track: ArtifactTrack): string {
  return `${track.slot}@${String(track.versions.length)}`;
}

export function CanvasSurface({ assistantTexts, projectId, host, children }: CanvasSurfaceProps) {
  const fallbackHost = useMemo(() => new LocalDocumentHost(), []);
  const activeHost = host ?? fallbackHost;

  const tracks = useMemo(
    () => collectArtifacts(assistantTexts.map((text) => parseMarkdown(text))),
    [assistantTexts],
  );

  const [picked, setPicked] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  // The newest artifact is the one whose latest version arrived in the latest
  // message — not the last track in slot order, which is the order they were
  // first seen in and does not move when an old artifact is revised.
  const newest = useMemo(() => {
    let best: ArtifactTrack | null = null;
    let bestMessage = -1;
    for (const track of tracks) {
      const last = track.versions[track.versions.length - 1];
      if (last === undefined) continue;
      if (last.messageIndex >= bestMessage) {
        bestMessage = last.messageIndex;
        best = track;
      }
    }
    return best;
  }, [tracks]);

  const openTrack =
    tracks.find((track) => track.slot === picked) ??
    (newest !== null && dismissed !== signatureOf(newest) ? newest : null);

  return (
    <div className={styles.split}>
      <div className={styles.main}>{children}</div>

      {openTrack !== null && projectId !== null ? (
        <div className={styles.panelSlot}>
          <CanvasPanel
            key={openTrack.slot}
            track={openTrack}
            host={activeHost}
            projectId={projectId}
            onClose={() => {
              setPicked(null);
              setDismissed(signatureOf(openTrack));
            }}
          />
        </div>
      ) : tracks.length > 0 ? (
        <nav className={styles.rail} aria-label="Artifacts">
          {tracks.map((track) => (
            <button
              key={track.slot}
              type="button"
              className={styles.chip}
              onClick={() => setPicked(track.slot)}
            >
              {track.title}
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
