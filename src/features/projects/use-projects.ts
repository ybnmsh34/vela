/**
 * The projects feature's state: which projects exist, which one the window is
 * in, and the two things a user can do about it.
 *
 * Two hooks, deliberately split, because two different callers want two
 * different amounts of work done.
 *
 * {@link useActiveProjectId} is what the composition root needs and is all it
 * needs: one id, and the read that establishes it. It runs for the whole life of
 * the window because every agent run depends on its answer.
 *
 * {@link useProjects} is the pane's: the list, the instructions of the selected
 * project, and the writes. It runs only while the pane is open, so a user who
 * never opens it never pays for the reads.
 *
 * ## Failure is a state, not a swallow
 *
 * Both hold a `problem` the surface renders, following `use-memory.ts`. The
 * difference that matters is what an unread list *costs*: a project that could
 * not be listed means the window has no project, which means an agent run has
 * nowhere to belong and is refused with a sentence. Reaching for a default in
 * that situation is the defect this feature was built to remove.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createProjectsRepository, type ProjectsRepository } from '@/data/projects-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import type { ProjectId, ProjectSummary } from '@/platform/contract-project';
import { toPlatformError } from '@/platform/errors';
import { useProjectStore } from '@/state/project-store';

/**
 * The project this window's runs belong to, or `null` until the host has said
 * which projects there are.
 *
 * The initial choice is **the summary the host flags `isDefault`**, never a
 * constant: `ProjectSummary.isDefault` is carried precisely "so no code under
 * `src/` ever compares against `DEFAULT_PROJECT_ID`, and so the one place that
 * decides what default means is the host". Once the user picks another, this
 * stops choosing — the store's value wins and the effect does nothing.
 *
 * A list that fails leaves the answer `null`. That is the honest state and the
 * callers below it are built for it: a run with no project is refused, visibly,
 * rather than run against a guess.
 */
export function useActiveProjectId(repository?: ProjectsRepository): ProjectId | null {
  const adapter = usePlatform();
  const projects = useMemo(
    () => repository ?? createProjectsRepository(adapter),
    [repository, adapter],
  );
  const selected = useProjectStore((store) => store.selectedProjectId);
  const select = useProjectStore((store) => store.select);

  useEffect(() => {
    if (selected !== null) return;
    let abandoned = false;
    void (async () => {
      try {
        const summaries = await projects.list();
        if (abandoned) return;
        const first = summaries.find((summary) => summary.isDefault) ?? summaries[0];
        if (first !== undefined) select(first.id);
      } catch {
        // Left `null`. Nothing here may fall back to a constant — that fallback
        // is the whole defect. The conversation surface refuses an agent run
        // without a project and says why.
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [projects, select, selected]);

  return selected;
}

export type ProjectListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly projects: readonly ProjectSummary[] }
  | { readonly status: 'error'; readonly code: string; readonly message: string };

export interface ProjectsController {
  readonly state: ProjectListState;
  /** The selected project's id, or `null` before the first list has landed. */
  readonly selectedProjectId: ProjectId | null;
  /**
   * The selected project's instructions as stored, or `null` while they are
   * being read. Empty string is a project with none — the contract's only
   * spelling of that.
   */
  readonly instructions: string | null;
  /** Set by the last failed read or write, cleared by the next that works. */
  readonly problem: string | null;
  select: (projectId: ProjectId) => void;
  create: (name: string) => Promise<void>;
  /**
   * `true` when the host accepted the write.
   *
   * Returned rather than inferred, because every way of inferring it is wrong.
   * "The stored text now equals the draft" is true the moment a *failed* save
   * leaves both at their old value, and a pane that tells the user their words
   * are stored when they are not is the one failure this surface must not have.
   */
  save: (instructions: string) => Promise<boolean>;
}

export function useProjects(repository?: ProjectsRepository): ProjectsController {
  const adapter = usePlatform();
  const projects = useMemo(
    () => repository ?? createProjectsRepository(adapter),
    [repository, adapter],
  );

  const selectedProjectId = useActiveProjectId(projects);
  const select = useProjectStore((store) => store.select);

  const [state, setState] = useState<ProjectListState>({ status: 'loading' });
  const [instructions, setInstructions] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const summaries = await projects.list();
      if (mounted.current) setState({ status: 'ready', projects: summaries });
    } catch (error: unknown) {
      const failure = toPlatformError(error);
      if (mounted.current) {
        setState({ status: 'error', code: failure.code, message: failure.message });
      }
    }
  }, [projects]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The selected project's instructions, re-read whenever the selection moves.
  // Not derived from the list: `ProjectSummary` deliberately does not carry
  // them, so that listing a hundred projects does not drag a hundred bodies
  // across the bridge.
  useEffect(() => {
    if (selectedProjectId === null) {
      setInstructions(null);
      return;
    }
    let abandoned = false;
    setInstructions(null);
    void (async () => {
      try {
        const view = await projects.get(selectedProjectId);
        if (!abandoned && mounted.current) {
          setInstructions(view.instructions);
          setProblem(null);
        }
      } catch (error: unknown) {
        if (!abandoned && mounted.current) setProblem(toPlatformError(error).message);
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [projects, selectedProjectId]);

  const create = useCallback(
    async (name: string): Promise<void> => {
      try {
        const created = await projects.create(name);
        if (mounted.current) setProblem(null);
        // Selected on creation: a user who makes a project meant to work in it,
        // and leaving them in the old one is the kind of silence this feature
        // exists to remove.
        select(created.summary.id);
      } catch (error: unknown) {
        if (mounted.current) setProblem(toPlatformError(error).message);
      }
      await reload();
    },
    [projects, reload, select],
  );

  const save = useCallback(
    async (next: string): Promise<boolean> => {
      if (selectedProjectId === null) return false;
      let ok = false;
      try {
        const updated = await projects.setInstructions(selectedProjectId, next);
        ok = true;
        if (mounted.current) {
          // From the host's answer, not from the draft: what the next run will
          // read is what the host stored, and showing the draft back would hide
          // any difference between the two.
          setInstructions(updated.instructions);
          setProblem(null);
        }
      } catch (error: unknown) {
        if (mounted.current) setProblem(toPlatformError(error).message);
      }
      await reload();
      return ok;
    },
    [projects, reload, selectedProjectId],
  );

  return { state, selectedProjectId, instructions, problem, select, create, save };
}
