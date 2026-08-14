/**
 * The memory pane's state: what is remembered, and the four things a user can
 * do about it.
 *
 * Every mutation re-reads the scope rather than patching a local array. The
 * host owns the order (pinned first, then most recently updated) and a pin
 * moves a row; reproducing that sort here would be a second opinion about the
 * ordering, and the two would drift the first time either changed.
 *
 * ## Failure is a state, not a swallow
 *
 * `problem` is set whenever the host refuses, and the pane renders it. An empty
 * memory and a memory that could not be read look identical on screen and one
 * of them is a lie — the same distinction `use-conversation.ts` draws for an
 * unreadable transcript.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createMemoryRepository, GLOBAL_MEMORY, type MemoryRepository } from '@/data/memory-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import type { MemoryCategory, MemoryEntry } from '@/platform/contract';
import { toPlatformError } from '@/platform/errors';
import { useMemoryStore } from '@/state/memory-store';

export type MemoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly entries: readonly MemoryEntry[] }
  | { readonly status: 'error'; readonly code: string; readonly message: string };

export interface MemoryController {
  readonly state: MemoryState;
  /** Set by the last failed mutation, cleared by the next successful one. */
  readonly problem: string | null;
  remember: (content: string, category: MemoryCategory) => Promise<void>;
  amend: (entryId: string, content: string) => Promise<void>;
  setPinned: (entryId: string, pinned: boolean) => Promise<void>;
  forget: (entryId: string) => Promise<void>;
}

export function useMemory(repository?: MemoryRepository): MemoryController {
  const adapter = usePlatform();
  const memory = useMemo(
    () => repository ?? createMemoryRepository(adapter),
    [repository, adapter],
  );

  const [state, setState] = useState<MemoryState>({ status: 'loading' });
  const [problem, setProblem] = useState<string | null>(null);
  // Announced so an open conversation re-reads. Without it a memory written
  // while a conversation is up appears to save and changes nothing about the
  // next answer, because the conversation read memory once on mount.
  const noteChanged = useMemoryStore((store) => store.noteChanged);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const entries = await memory.list(GLOBAL_MEMORY);
      if (mounted.current) setState({ status: 'ready', entries });
    } catch (error: unknown) {
      const failure = toPlatformError(error);
      if (mounted.current) {
        setState({ status: 'error', code: failure.code, message: failure.message });
      }
    }
  }, [memory]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Run a mutation, then re-read. A refusal is kept as `problem` and the list
   * is still re-read, because the row the user acted on may have changed for
   * some other reason and showing them the stale copy would be the second lie.
   */
  const mutate = useCallback(
    async (work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
        if (mounted.current) setProblem(null);
        // After the write and before the re-read, so a listener that reacts by
        // reading the host cannot read the state the write replaced.
        noteChanged();
      } catch (error: unknown) {
        if (mounted.current) setProblem(toPlatformError(error).message);
      }
      await reload();
    },
    [noteChanged, reload],
  );

  return {
    state,
    problem,
    remember: useCallback(
      (content: string, category: MemoryCategory) =>
        mutate(() => memory.add({ scope: GLOBAL_MEMORY, category, content })),
      [memory, mutate],
    ),
    amend: useCallback(
      (entryId: string, content: string) => mutate(() => memory.update({ entryId, content })),
      [memory, mutate],
    ),
    setPinned: useCallback(
      (entryId: string, pinned: boolean) => mutate(() => memory.update({ entryId, pinned })),
      [memory, mutate],
    ),
    forget: useCallback((entryId: string) => mutate(() => memory.remove(entryId)), [memory, mutate]),
  };
}
