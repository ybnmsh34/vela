/**
 * The code workspace's public face: one component, mounted by the shell.
 *
 * Nothing else is exported. The panes, the layout arithmetic's bindings, the
 * setup form and the review composer are internal — a second feature reaching
 * for one of them is the signal that it belongs in `lib/`, `state/` or
 * `components/`, which is the trip `src/lib/text-diff.ts` has already made.
 */

export { CodeWorkspaceSurface } from './CodeWorkspaceSurface';
