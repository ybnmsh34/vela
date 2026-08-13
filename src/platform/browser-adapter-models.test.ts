/**
 * The fake's `models_*` commands against the semantics of
 * `src-tauri/src/ipc/models.rs`. Where the two disagree, the fake is wrong.
 *
 * VERIFIED-BY-FAKE: this proves the protocol shape and the UI's contract with
 * it. It proves nothing about any endpoint's real capabilities.
 */

import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from './browser-adapter';
import { NO_CAPABILITIES } from './contract';
import { PlatformError } from './errors';

function hostWithEndpoint(): BrowserAdapter {
  const adapter = new BrowserAdapter();
  void adapter.invoke('settings_put_provider', {
    id: 'workstation',
    displayName: 'The workstation',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelId: 'some-model',
  });
  return adapter;
}

describe('models_capabilities', () => {
  it('answers a model nobody has probed with the pessimistic floor', async () => {
    // Mirrors `a_model_nobody_has_probed_offers_nothing_at_all`. This is the
    // single most load-bearing default in the whole surface.
    const report = await new BrowserAdapter().invoke('models_capabilities', {
      providerId: 'workstation',
      modelId: 'some-model',
    });

    expect(report.capabilities).toEqual(NO_CAPABILITIES);
    expect(report.probed).toBe(false);
    expect(report.structuredOutput).toBe(false);
    expect(report.contextWindowTokens).toBeNull();
    expect(report.findings).toEqual([]);
  });

  it('is a report and never a NOT_FOUND, for any pair of ids', async () => {
    // The host answers a cache miss with the floor rather than an error,
    // because "nothing established" is a fact the switcher has to render.
    await expect(
      new BrowserAdapter().invoke('models_capabilities', {
        providerId: 'never-configured',
        modelId: 'never-seen',
      }),
    ).resolves.toMatchObject({ probed: false });
  });

  it('rejects blank identifiers and names the field it blames', async () => {
    const adapter = new BrowserAdapter();
    await expect(
      adapter.invoke('models_capabilities', { providerId: '  ', modelId: 'm' }),
    ).rejects.toThrow(/providerId/);
    await expect(
      adapter.invoke('models_capabilities', { providerId: 'p', modelId: '' }),
    ).rejects.toThrow(/modelId/);
    await expect(
      adapter.invoke('models_capabilities', { providerId: 'p', modelId: 'm'.repeat(201) }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it('keys on provider and model together, so a shared name is not a shared model', async () => {
    const adapter = hostWithEndpoint();
    adapter.seedCapabilities({
      providerId: 'workstation',
      modelId: 'shared-name',
      capabilities: { ...NO_CAPABILITIES, vision: true },
      structuredOutput: false,
      toolCallsEmulated: true,
      contextWindowTokens: 8192,
      maxOutputTokens: null,
      probed: true,
      findings: [],
    });

    const mine = await adapter.invoke('models_capabilities', {
      providerId: 'workstation',
      modelId: 'shared-name',
    });
    const elsewhere = await adapter.invoke('models_capabilities', {
      providerId: 'somewhere-else',
      modelId: 'shared-name',
    });

    expect(mine.capabilities.vision).toBe(true);
    expect(elsewhere.capabilities.vision).toBe(false);
    expect(elsewhere.probed).toBe(false);
  });
});

describe('models_probe', () => {
  it('establishes only what the fake can honestly demonstrate', async () => {
    const adapter = hostWithEndpoint();
    const result = await adapter.invoke('models_probe', {
      providerId: 'workstation',
      modelId: 'some-model',
    });

    expect(result.failure).toBeNull();
    expect(result.report.probed).toBe(true);
    expect(result.report.capabilities.streaming).toBe(true);
    // Everything else stays false. A fake that claimed vision would let a UI
    // that offers an unsupported affordance pass its tests.
    expect(result.report.capabilities.vision).toBe(false);
    expect(result.report.capabilities.toolCalls).toBe(false);
  });

  it('caches, so the free lookup afterwards agrees with the probe', async () => {
    const adapter = hostWithEndpoint();
    await adapter.invoke('models_probe', { providerId: 'workstation', modelId: 'some-model' });
    const cached = await adapter.invoke('models_capabilities', {
      providerId: 'workstation',
      modelId: 'some-model',
    });
    expect(cached.probed).toBe(true);
    expect(cached.capabilities.streaming).toBe(true);
  });

  it('refuses an endpoint that is not configured, exactly as the host does', async () => {
    await expect(
      new BrowserAdapter().invoke('models_probe', { providerId: 'ghost', modelId: 'm' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('models_list', () => {
  it('reports an endpoint with no listing route as a normal state, not a failure', async () => {
    // The llama.cpp-shaped case: `enumerated: false`, `failure: null`. A UI that
    // rendered an error here would tell most local users something is wrong.
    const result = await hostWithEndpoint().invoke('models_list', { providerId: 'workstation' });
    expect(result.enumerated).toBe(false);
    expect(result.failure).toBeNull();
    expect(result.models).toEqual([]);
  });

  it('returns what an enumerating endpoint reported, windows and all', async () => {
    const adapter = hostWithEndpoint();
    adapter.seedModelListing('workstation', [
      { modelId: 'big', displayName: 'Big', contextWindowTokens: 32768 },
      { modelId: 'small', displayName: 'Small', contextWindowTokens: null },
    ]);

    const result = await adapter.invoke('models_list', { providerId: 'workstation' });
    expect(result.enumerated).toBe(true);
    expect(result.models[0]?.contextWindowTokens).toBe(32768);
    expect(result.models[1]?.contextWindowTokens).toBeNull();
  });

  it('is NOT_FOUND for an endpoint the user has not configured', async () => {
    await expect(
      new BrowserAdapter().invoke('models_list', { providerId: 'ghost' }),
    ).rejects.toBeInstanceOf(PlatformError);
  });
});
