/**
 * The cowork feature's public face: what the composition root mounts.
 *
 * Everything else in this folder is internal. The panels take controllers rather
 * than reading the host themselves, so they can be rendered in a test without an
 * adapter — which is why the hooks are exported here too.
 */

export { CoworkSurface } from './CoworkSurface';
export { CoworkDock } from './CoworkPanel';
export { useCowork, useCommentDraft, type CoworkController } from './use-cowork';
export { useProjectLayout, type ProjectLayoutController } from './use-project-layout';
export { useConnectors, type ConnectorsController } from './use-connectors';
export { createUnwiredDirector, type TaskDirector, type DirectiveDelivery } from './director';
