/**
 * Drag-and-drop onto the conversation.
 *
 * The zone is deliberately the whole conversation region rather than a small
 * target: a drop target you have to aim at is a drop target people miss. The
 * overlay only appears once something is actually being dragged over it, so it
 * costs nothing at rest.
 *
 * Capability gating happens on the *drop*, not on the zone. The user can drag
 * anything they like from the desktop; Vela cannot know what it is until it
 * lands, and refusing to accept the drop at all would leave the browser to open
 * the file in place of the app. So the drop is always accepted and then
 * `use-attachments` says, per file, what was staged and what was not — which is
 * also the only route by which an image can reach a model with no vision, and
 * the route where the refusal must therefore be loudest.
 */

import { useCallback, useRef, useState, type DragEvent, type ReactNode } from 'react';

import styles from './AttachmentDropZone.module.css';

interface AttachmentDropZoneProps {
  readonly onFiles: (files: readonly File[]) => void;
  /** Shown in the overlay so the user knows what will happen before they let go. */
  readonly vision: boolean;
  readonly children: ReactNode;
}

export function AttachmentDropZone({ onFiles, vision, children }: AttachmentDropZoneProps) {
  const [dragging, setDragging] = useState(false);
  // `dragenter`/`dragleave` fire for every descendant the pointer crosses, so a
  // plain boolean flickers the overlay as the cursor moves over children. The
  // depth counter is the standard fix and the only reason this is not a one-liner.
  const depth = useRef(0);

  const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  }, []);

  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    // Without this the browser navigates away to the dropped file, taking the
    // whole app with it.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = [...(event.dataTransfer.files ?? [])];
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  return (
    <div
      className={styles.zone}
      data-testid="attachment-drop-zone"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {children}
      {dragging ? (
        <div className={styles.overlay} aria-hidden="true">
          <p className={styles.overlayText}>
            {vision ? 'Drop images or text files here' : 'Drop text files here'}
          </p>
          {vision ? null : (
            <p className={styles.overlayHint}>This model reads text only.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Is this drag carrying files, rather than selected text from elsewhere in the
 * app? Without the check, selecting a message and dragging it lights up the
 * overlay for a drop that could never produce a file.
 */
function carriesFiles(event: DragEvent<HTMLDivElement>): boolean {
  const transfer = event.dataTransfer as DataTransfer | null;
  if (transfer == null) return false;
  const types = transfer.types as readonly string[] | undefined;
  if (types === undefined) return false;
  return [...types].includes('Files');
}
