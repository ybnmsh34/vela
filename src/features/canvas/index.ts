/**
 * Canvas's public face.
 *
 * A shell mounts {@link CanvasSurface} around the transcript and hands it the
 * assistant messages of the open conversation, and the sandbox door it should
 * submit through. Everything else — detection, versioning, the sandbox run, the
 * frame — is internal.
 *
 * **Nothing host-shaped is exported here any more.** `LocalDocumentHost` used to
 * be, "for one reason: a test needs to drive the surface at a permission level
 * other than the default" — and the surface then defaulted to constructing one,
 * which is how a test double became the shipping boundary. It is now a test
 * double and nothing else, in `document-host-double.ts`, reachable only by the
 * suites in this directory. The seam a caller hands in is
 * `src/data/sandbox-repository.ts`.
 */

export { CanvasSurface } from './CanvasSurface';
