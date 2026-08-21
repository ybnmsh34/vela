/**
 * The styles feature's public face.
 *
 * Two things leave it. {@link StylesSurface} is mounted by the composition root
 * and draws nothing until the user opens the pane. {@link IncognitoGate} is the
 * seam that makes the mode real: it wraps the platform adapter so that every
 * durable write in the tree below it is refused, and it is mounted by the
 * composition root because that is the only place allowed to decide what the
 * rest of the application talks to.
 *
 * `StylePanel` used to be exported here too, under the sentence "exported for
 * its own test and for nothing else". There is no such test — the pane is
 * covered through `<App/>` in `src/app/instructions-and-incognito.test.tsx` —
 * and `grep -rn "from '@/features/styles'" src/` names exactly one importer,
 * `src/app/App.tsx`, which takes the two below. So the export was reachable from
 * nothing, described by a reason that did not exist. It is gone rather than
 * re-described: `StylesSurface.tsx` imports the panel directly, which is the
 * only path anything actually uses.
 */

export { StylesSurface } from './StylesSurface';
export { IncognitoGate } from './IncognitoGate';
