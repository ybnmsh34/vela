import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import type { SettingsPutProviderReq } from '@/platform/contract';

import { acceptsCredential, createSettingsRepository, needsCredential } from './settings-repository';

/**
 * These run against `BrowserAdapter`, which mirrors the Rust host's semantics.
 * Each assertion here has a counterpart in `src-tauri/src/ipc/settings.rs`;
 * when the two disagree, the fake is wrong.
 *
 * VERIFIED-BY-FAKE: this proves protocol shape and UI-facing behaviour. It
 * proves nothing about the OS keychain.
 */
const LOCAL: SettingsPutProviderReq = {
  id: 'llamacpp',
  displayName: 'llama.cpp',
  kind: 'local',
  baseUrl: 'http://127.0.0.1:8080/v1',
};

const REMOTE: SettingsPutProviderReq = {
  id: 'acme',
  displayName: 'Acme',
  kind: 'remoteApi',
  baseUrl: 'https://api.example.test/v1',
  auth: { type: 'bearerToken' },
  authRequirement: 'required',
};

function repository() {
  return createSettingsRepository(new BrowserAdapter());
}

describe('createSettingsRepository', () => {
  it('starts at the documented defaults', async () => {
    const snapshot = await repository().load();
    expect(snapshot.theme).toBe('system');
    expect(snapshot.telemetryEnabled).toBe(false);
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.credentialBackend).toBe('memory-fake');
  });

  it('round-trips the theme', async () => {
    const settings = repository();
    await expect(settings.setTheme('dark')).resolves.toBe('dark');
    expect((await settings.load()).theme).toBe('dark');
  });

  it('has no way to enable telemetry', async () => {
    // Structural: there is no setter on the repository, no command on the
    // contract, and the snapshot always reports false.
    const settings = repository();
    expect(Object.keys(settings)).not.toContain('setTelemetry');
    await settings.setTheme('light');
    expect((await settings.load()).telemetryEnabled).toBe(false);
  });

  describe('a local endpoint with no auth', () => {
    it('is usable immediately, with no credential and no warning', async () => {
      const settings = repository();
      const view = await settings.putProvider(LOCAL);

      expect(view.usable).toBe(true);
      expect(view.credentialPresent).toBe(false);
      expect(view.credentialCheck).toBe('satisfiedWithoutCredential');
      expect(needsCredential(view)).toBe(false);
      expect(acceptsCredential(view)).toBe(false);
      expect(view.credentialFieldLabel).toBeNull();
      expect(view.security.level).toBe('none');
      expect(view.security.concerns).toEqual([]);
    });

    it('accepts a payload that omits auth entirely', async () => {
      // The shortest thing a user can save. If this breaks, local models break.
      const view = await repository().putProvider({
        id: 'ollama',
        displayName: 'Ollama',
        kind: 'local',
        baseUrl: 'http://127.0.0.1:11434',
      });
      expect(view.auth).toEqual({ type: 'none' });
      expect(view.authRequirement).toBe('notRequired');
      expect(view.usable).toBe(true);
    });
  });

  describe('a provider that requires a credential', () => {
    it('reports what is missing without ever exposing what is stored', async () => {
      const settings = repository();
      const before = await settings.putProvider(REMOTE);

      expect(before.usable).toBe(false);
      expect(needsCredential(before)).toBe(true);
      expect(acceptsCredential(before)).toBe(true);
      expect(before.credentialFieldLabel).toBe('Access token');
      expect(before.security.concerns).toContain('requiredCredentialMissing');

      await settings.storeCredential('acme', 'sk-live-canary-DO-NOT-LOG');

      expect(await settings.hasCredential('acme')).toBe(true);
      const snapshot = await settings.load();
      const after = snapshot.providers.find((view) => view.id === 'acme');
      expect(after?.credentialPresent).toBe(true);
      expect(after?.usable).toBe(true);
      expect(after?.credentialCheck).toBe('satisfied');

      // Nothing in the snapshot carries the value.
      expect(JSON.stringify(snapshot)).not.toContain('sk-live-canary');
    });

    it('reports an absent credential as absence, not as an error', async () => {
      const settings = repository();
      await settings.putProvider(REMOTE);
      await expect(settings.hasCredential('acme')).resolves.toBe(false);
      await expect(settings.clearCredential('acme')).resolves.toBeUndefined();
    });
  });

  describe('security posture', () => {
    it('says nothing about plaintext HTTP to loopback', async () => {
      const view = await repository().putProvider(LOCAL);
      expect(view.security.level).toBe('none');
      expect(view.security.scope).toBe('loopback');
      expect(view.security.leavesDevice).toBe(false);
      expect(view.security.trafficIsPlaintext).toBe(true);
    });

    it('flags plaintext traffic that leaves the machine', async () => {
      const view = await repository().putProvider({
        id: 'lab',
        displayName: 'Lab box',
        kind: 'local',
        baseUrl: 'http://192.168.1.50:8080/v1',
      });
      expect(view.security.level).toBe('elevated');
      expect(view.security.scope).toBe('privateNetwork');
      expect(view.security.concerns).toContain('plaintextTrafficLeavesDevice');
      // A risk is something to tell the user, not a reason to block them.
      expect(view.usable).toBe(true);
    });

    it('escalates when the credential itself would cross the network in the clear', async () => {
      const settings = repository();
      await settings.putProvider({
        id: 'exposed',
        displayName: 'Exposed',
        kind: 'remoteApi',
        baseUrl: 'http://api.example.test/v1',
        auth: { type: 'apiKeyHeader', header: 'x-api-key' },
        authRequirement: 'required',
      });
      await settings.storeCredential('exposed', 'sk-live-canary-DO-NOT-LOG');

      const snapshot = await settings.load();
      const view = snapshot.providers.find((p) => p.id === 'exposed');
      expect(view?.security.level).toBe('high');
      expect(view?.security.credentialSentInPlaintext).toBe(true);
      expect(view?.credentialFieldLabel).toBe('API key');
    });

    it('treats an open but encrypted remote endpoint as a quiet notice', async () => {
      const view = await repository().putProvider({
        id: 'open',
        displayName: 'Open',
        kind: 'remoteApi',
        baseUrl: 'https://gpu.example.test/v1',
      });
      expect(view.security.level).toBe('notice');
      expect(view.security.concerns).toEqual(['remoteEndpointIsUnauthenticated']);
    });
  });

  describe('deletion', () => {
    it('removes the provider and its credential together', async () => {
      const settings = repository();
      await settings.putProvider(REMOTE);
      await settings.storeCredential('acme', 'sk-live-canary-DO-NOT-LOG');

      await settings.deleteProvider('acme');

      expect((await settings.load()).providers).toEqual([]);
      await expect(settings.hasCredential('acme')).resolves.toBe(false);
    });

    it('reports an unknown provider as NOT_FOUND', async () => {
      await expect(repository().deleteProvider('ghost')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('rejections mirror the host', () => {
    it.each([
      ['a blank id', { ...LOCAL, id: '  ' }],
      ['an id containing a slash', { ...LOCAL, id: 'a/b' }],
      ['a blank display name', { ...LOCAL, displayName: ' ' }],
      ['a file: url', { ...LOCAL, baseUrl: 'file:///etc/passwd' }],
      ['a url with no host', { ...LOCAL, baseUrl: 'http://' }],
      ['nonsense instead of a url', { ...LOCAL, baseUrl: 'not a url' }],
      ['a blank model id', { ...LOCAL, modelId: '  ' }],
      [
        'an unnamed api-key header',
        { ...LOCAL, auth: { type: 'apiKeyHeader' as const, header: '' } },
      ],
    ])('rejects %s as INVALID_PAYLOAD', async (_label, payload) => {
      const settings = repository();
      await expect(settings.putProvider(payload)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
      });
      // And nothing was stored.
      expect((await settings.load()).providers).toEqual([]);
    });
  });
});
