/**
 * Canvas's public face.
 *
 * A shell mounts {@link CanvasSurface} around the transcript and hands it the
 * assistant messages of the open conversation. Everything else — detection,
 * versioning, the sandbox run, the frame — is internal.
 *
 * {@link LocalDocumentHost} is exported for one reason: a test needs to drive
 * the surface at a permission level other than the default. It is not a seam a
 * second feature should reach for, and the honesty note about what it is and is
 * not lives at the top of `document-host.ts`.
 */

export { CanvasSurface } from './CanvasSurface';
export { LocalDocumentHost, type DocumentHost } from './document-host';
