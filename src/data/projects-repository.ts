/**
 * Projects, as the renderer needs them.
 *
 * A plain factory over a {@link PlatformAdapter}, exactly like
 * `memory-repository.ts` and `conversations-repository.ts`: every method is one
 * host command and nothing here reshapes, caches, or merges.
 *
 * Five methods, not eight. `project_delete`, `project_reconcile_skills` and
 * `project_move_conversation` are real commands with no caller in the renderer,
 * and a method here for each would be three more seams claiming a surface that
 * does not exist. They are added by whoever builds the surface that needs them.
 *
 * `project_layout` **was** the fourth of those, and this paragraph used to say
 * so. It is now {@link ProjectsRepository.layout}, because the surface that
 * needs it exists: the cowork dock's project panel
 * (`src/features/cowork/ProjectFilesPanel.tsx`) shows the user where their files are
 * and whether the host can currently reach them, and a layout is the only thing
 * in the whole contract that answers that. Adding the method without the panel
 * would have been the seam this header warns about; the panel is the reason the
 * method is allowed to exist.
 *
 * Errors propagate as `PlatformError`. In particular `NOT_FOUND` from
 * {@link ProjectsRepository.get} is passed through rather than turned into a
 * null: "the project you named is gone" is an answer a caller has to be able to
 * tell apart from "the project you named has no instructions", and collapsing
 * the two is how a run ends up quietly using nothing.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import type {
  ProjectId,
  ProjectLayout,
  ProjectSummary,
  ProjectView,
} from '@/platform/contract-project';

export interface ProjectsRepository {
  /** Unarchived projects. The host owns the order. */
  list(): Promise<readonly ProjectSummary[]>;
  /** One project in full — the summary plus `instructions` and `enabledSkills`. */
  get(projectId: ProjectId): Promise<ProjectView>;
  create(name: string): Promise<ProjectView>;
  /**
   * Replace one project's instructions.
   *
   * `''` is the only spelling of "none" ({@link ProjectView.instructions}), so
   * clearing the box is an ordinary update rather than a delete.
   */
  setInstructions(projectId: ProjectId, instructions: string): Promise<ProjectView>;
  /**
   * One project's on-disk reality: where its directories are, whether the user's
   * working directory can currently be reached, and one entry per enabled skill.
   *
   * **This touches the disk and the other four do not**, which is the reason
   * `ProjectSummary` and `ProjectView` exist separately from `ProjectLayout` at
   * all — see `contract-project.ts`, which is explicit that listing forty
   * projects must not stat forty directory trees. So it is called for one
   * project, when a surface is showing that project, and never in a list.
   *
   * **Reading it repairs**, per the same contract: a missing host-owned
   * directory is recreated and named in `ProjectLayout.repaired`. That is a
   * write performed by a method whose name says read, and it is the host's
   * design rather than this door's, but a caller should know it before putting
   * this on a timer.
   */
  layout(projectId: ProjectId): Promise<ProjectLayout>;
}

export function createProjectsRepository(adapter: PlatformAdapter): ProjectsRepository {
  return {
    async list(): Promise<readonly ProjectSummary[]> {
      const response = await adapter.invoke('project_list', {});
      return response.projects;
    },

    async get(projectId: ProjectId): Promise<ProjectView> {
      const response = await adapter.invoke('project_get', { projectId });
      return response.project;
    },

    async create(name: string): Promise<ProjectView> {
      const response = await adapter.invoke('project_create', { name });
      return response.project;
    },

    async setInstructions(projectId: ProjectId, instructions: string): Promise<ProjectView> {
      const response = await adapter.invoke('project_update', { projectId, instructions });
      return response.project;
    },

    async layout(projectId: ProjectId): Promise<ProjectLayout> {
      const response = await adapter.invoke('project_layout', { projectId });
      return response.layout;
    },
  };
}
