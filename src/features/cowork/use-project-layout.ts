/**
 * The project panel's read: where this project's files are, and whether the host
 * can currently reach them.
 *
 * ## This is the renderer's first caller of `project_layout`
 *
 * That command has been allowlisted, declared in `IpcContract`, implemented in
 * `src-tauri/src/ipc/project.rs` and faked in `src/platform/browser-adapter.ts`
 * since AMENDMENT 5, with **no caller under `src/`**. Measured at `c997c89`,
 * the commit this track branches from: `git grep -c project_layout -- src/`
 * finds 15 hits across 8 files, and `git grep "invoke('project_layout'" -- src/`
 * finds exactly three, all in `browser-adapter-projects.test.ts`. The other
 * twelve are declarations and assertions — four in `contract-project.ts`, two
 * in `contract.ts`, one in `contract-sandbox.ts`, two in `browser-adapter.ts`
 * (its `case` arm and a `#requireProject` string), one each in
 * `project-host-parity.test.ts` and `project-run-scope.test.ts`, and one in
 * `src/data/projects-repository.ts`, which is prose and not a call: the
 * "Four methods, not eight" paragraph declining to write the method, quoted by
 * `src/runtime/reachable.test.ts` with its middle elided — the four command
 * names, and the clause saying nothing in the renderer calls them — rather than
 * "quoted in full", as an earlier version of this line said. That
 * paragraph now reads "Five methods, not eight", because this hook's method is
 * the fifth. That is a defensible choice and is
 * also why nothing counted the debt: that guard measures unreachable
 * *modules*, and a command whose door was never built has no module to be
 * missing from the graph.
 *
 * `src/runtime/reachable.test.ts` is the guard that asks the wider question, in
 * `every allowlisted command is reachable from something a user can press`. This
 * hook is the surface that lets `project_layout` off its list.
 *
 * ## Failure is a state, not a swallow
 *
 * Following `use-memory.ts` and `use-projects.ts`: the error is held and
 * rendered. A layout that cannot be read is not the same as a project with no
 * working directory, and the panel must not draw the second when the first is
 * true — that is the silently-wrong outcome conventions §9 rule 6 forbids.
 *
 * ## Read once per open, not on a timer
 *
 * `contract-project.ts` is explicit that **reading a layout repairs**: a missing
 * host-owned directory is recreated and reported in `ProjectLayout.repaired`. A
 * poll would therefore be a write loop wearing a refresh button. The user gets
 * an explicit `reload`, and that is the only repeat.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createProjectsRepository, type ProjectsRepository } from '@/data/projects-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import type { ProjectId, ProjectLayout } from '@/platform/contract-project';
import { toPlatformError } from '@/platform/errors';

export type ProjectLayoutState =
  /** No project selected. Not an error — `useActiveProjectId` answers `null` until the host has spoken. */
  | { readonly status: 'noProject' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly layout: ProjectLayout }
  | { readonly status: 'error'; readonly code: string; readonly message: string };

export interface ProjectLayoutController {
  readonly state: ProjectLayoutState;
  reload: () => void;
}

export function useProjectLayout(
  projectId: ProjectId | null,
  repository?: ProjectsRepository,
): ProjectLayoutController {
  const adapter = usePlatform();
  const projects = useMemo(
    () => repository ?? createProjectsRepository(adapter),
    [repository, adapter],
  );

  const [state, setState] = useState<ProjectLayoutState>({ status: 'noProject' });
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (projectId === null) {
      setState({ status: 'noProject' });
      return;
    }
    let abandoned = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const layout = await projects.layout(projectId);
        if (!abandoned && mounted.current) setState({ status: 'ready', layout });
      } catch (error: unknown) {
        const failure = toPlatformError(error);
        if (!abandoned && mounted.current) {
          setState({ status: 'error', code: failure.code, message: failure.message });
        }
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [projects, projectId, nonce]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { state, reload };
}
