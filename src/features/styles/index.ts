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
 * The panel is exported for its own test and for nothing else.
 */

export { StylesSurface } from './StylesSurface';
export { StylePanel } from './StylePanel';
export { IncognitoGate } from './IncognitoGate';
