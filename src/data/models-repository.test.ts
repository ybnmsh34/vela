import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { NO_CAPABILITIES } from '@/platform/contract';

import { createModelsRepository } from './models-repository';

async function configured(): Promise<BrowserAdapter> {
  const adapter = new BrowserAdapter();
  await adapter.invoke('settings_put_provider', {
    id: 'workstation',
    displayName: 'The workstation',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelId: 'some-model',
  });
  return adapter;
}

describe('ModelsRepository', () => {
  it('reads capabilities without contacting anything, and reports the floor', async () => {
    const repository = createModelsRepository(new BrowserAdapter());
    const report = await repository.capabilities('workstation', 'some-model');
    expect(report.capabilities).toEqual(NO_CAPABILITIES);
    expect(report.probed).toBe(false);
  });

  it('returns a report and a failure together, rather than one or the other', async () => {
    const adapter = await configured();
    const result = await createModelsRepository(adapter).probe('workstation', 'some-model');
    expect(result.report.probed).toBe(true);
    expect(result.failure).toBeNull();
  });

  it('propagates a host refusal as a PlatformError rather than swallowing it', async () => {
    const repository = createModelsRepository(new BrowserAdapter());
    await expect(repository.probe('never-configured', 'm')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('reports an endpoint that does not enumerate without calling it an error', async () => {
    const result = await createModelsRepository(await configured()).listModels('workstation');
    expect(result.enumerated).toBe(false);
    expect(result.failure).toBeNull();
  });
});
