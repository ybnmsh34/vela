/**
 * The projects feature's public face.
 *
 * Two things leave it. {@link ProjectsSurface} is mounted by the composition
 * root and draws nothing until the user opens the pane. {@link useActiveProjectId}
 * is the answer to "which project does a run started in this window belong to",
 * and the composition root calls it because that is the one place allowed to
 * join two features together.
 *
 * Everything else — the repository, the list state, the writes — is internal.
 */

export { ProjectsSurface } from './ProjectsSurface';
export { ProjectPanel } from './ProjectPanel';
export { useActiveProjectId, useProjects, type ProjectsController } from './use-projects';
