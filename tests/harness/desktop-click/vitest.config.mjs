import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * A third vitest project, for the desktop click harness's own guards.
 *
 * Separate from the app suite because it evaluates `page.mjs`'s bootstrap
 * source into a bare jsdom window with no Testing Library setup, and separate
 * from `tests/harness/mock-provider` because that project runs in plain node
 * and binds sockets. Run with `pnpm test:click-harness`.
 *
 * The files are `.mjs` on purpose. `tsconfig.harness.json` includes
 * `tests/harness` with `types: ["node"]` and no DOM lib, so a `.ts` test that
 * touched `document` would fail `pnpm typecheck` for a reason that has nothing
 * to do with what it asserts. `.mjs` is invisible to that project and to every
 * other one.
 */
export default defineConfig({
  // Pinned to this directory, not the working directory: without it vitest
  // roots at the cwd and drags the app's `src/**` tests into a config that has
  // neither their alias nor their setup.
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['**/*.test.mjs'],
    restoreMocks: true,
  },
});
