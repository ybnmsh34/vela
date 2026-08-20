/**
 * The feature's public surface: the mounted surface, and nothing else.
 *
 * Narrower on purpose than `src/features/skills/index.ts`, which also re-exports
 * its panel, its hook and three of its types. Nothing outside this directory
 * imports any of those — `McpSurface` imports `./McpPanel` directly, and both
 * test files import the module they are testing by relative path. An export
 * nobody reads is the same shape of defect as a column nobody selects: it reads
 * as a supported entry point, and the first caller to use it makes the pane part
 * of another feature's surface, which `src/features/README.md` forbids.
 *
 * Widen it when something outside actually needs a name, and the thing that
 * needs it is the evidence.
 */

export { McpSurface } from './McpSurface';
