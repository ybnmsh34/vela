import { describe, expect, it } from 'vitest';

import type { PlatformAdapter } from '@/platform/adapter';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformError } from '@/platform/errors';

import { createHostRepository } from './host-repository';

/**
 * Repository tests are the cheapest tests in the codebase: no DOM, no React,
 * no host. Build features so their logic lands here.
 */
describe('createHostRepository', () => {
  it('returns host identity through the adapter', async () => {
    const repository = createHostRepository(new BrowserAdapter());
    const info = await repository.getAppInfo();
    expect(info.name).toBe('Vela');
    expect(info.contractVersion).toBe(1);
  });

  it('probes the bridge', async () => {
    const repository = createHostRepository(new BrowserAdapter({ now: () => 42 }));
    await expect(repository.probeBridge('ping')).resolves.toEqual({
      message: 'ping',
      receivedAtMs: 42,
    });
  });

  it('refuses to run against a host speaking a different contract version', async () => {
    const stale: PlatformAdapter = {
      kind: 'browser',
      invoke: async () =>
        ({
          name: 'Vela',
          version: '9.9.9',
          contractVersion: 99,
          os: 'test',
          arch: 'test',
          secretBackend: 'memory-fake',
        }) as never,
      listen: async () => () => {},
    };

    const failure = await createHostRepository(stale)
      .getAppInfo()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlatformError);
    expect(failure).toMatchObject({ code: 'CONTRACT_MISMATCH' });
  });
});
