/**
 * Projects, as the renderer needs them.
 *
 * A plain factory over a {@link PlatformAdapter}, exactly like
 * `memory-repository.ts` and `conversations-repository.ts`: every method is one
 * host command and nothing here reshapes, caches, or merges.
 *
 * Four methods, not eight. `project_delete`, `project_layout`,
 * `project_reconcile_skills` and `project_move_conversation` are real commands
 * with no caller in the renderer, and a method here for each would be four more
 * seams claiming a surface that does not exist. They are added by whoever builds
 * the surface that needs them.
 *
 * Errors propagate as `PlatformError`. In particular `NOT_FOUND` from
 * {@link ProjectsRepository.get} is passed through rather than turned into a
 * null: "the project you named is gone" is an answer a caller has to be able to
 * tell apart from "the project you named has no instructions", and collapsing
 * the two is how a run ends up quietly using nothing.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import type { ProjectId, ProjectSummary, ProjectView } from '@/platform/contract-project';

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
  };
}
