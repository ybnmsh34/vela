import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * A separate vitest project, on purpose.
 *
 * The app suite runs in jsdom with Testing Library set up; this one runs in
 * plain node, binds real TCP sockets, and must never load the renderer's test
 * setup. Keeping the configs apart also keeps the harness out of the app's
 * module graph — `pnpm test` cannot accidentally pull test infrastructure into
 * a bundle.
 *
 * Run with: `pnpm test:harness`
 */
export default defineConfig({
  // Pinned to this directory, not the working directory. Without it vitest
  // roots at the cwd and drags the app's `src/**` tests into a config that has
  // neither their `@/` alias nor their jsdom setup.
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    globals: false,
    include: ['**/*.test.ts'],
    // Real listeners on ephemeral ports; a hung server must fail, not stall CI.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    restoreMocks: true,
  },
});
