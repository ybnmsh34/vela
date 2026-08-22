import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from './browser-adapter';
import { IPC_CONTRACT_VERSION } from './contract';
import { PlatformError } from './errors';

/**
 * These tests pin the fake host's behaviour to the real host's behaviour. The
 * matching Rust tests live in `src-tauri/src/ipc/*.rs`; if you change one side,
 * change the other.
 *
 * VERIFIED-BY-FAKE: nothing here touches an OS keychain or a model endpoint.
 */
describe('BrowserAdapter', () => {
  const adapter = () => new BrowserAdapter({ now: () => 1_700_000_000_000 });

  it('reports itself as the browser adapter and admits its store is a fake', async () => {
    const info = await adapter().invoke('app_info', {});
    expect(info.name).toBe('Vela');
    expect(info.contractVersion).toBe(IPC_CONTRACT_VERSION);
    expect(info.secretBackend).toBe('memory-fake');
  });

  it('round-trips a diagnostics echo', async () => {
    const result = await adapter().invoke('diagnostics_echo', { message: 'bridge up' });
    expect(result).toEqual({ message: 'bridge up', receivedAtMs: 1_700_000_000_000 });
  });

  it('rejects an empty echo payload with INVALID_PAYLOAD', async () => {
    await expect(adapter().invoke('diagnostics_echo', { message: '' })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
  });

  it('refuses a command that is not on the allowlist, without contacting a host', async () => {
    // Cast through `never`: the point of the test is the runtime guard behind
    // the type system, for when a string arrives from outside TypeScript.
    const call = adapter().invoke('shell_execute' as never, {} as never);
    await expect(call).rejects.toBeInstanceOf(PlatformError);
    await expect(call).rejects.toMatchObject({ code: 'UNKNOWN_COMMAND' });
  });

  describe('secrets', () => {
    it('round-trips set -> status -> delete', async () => {
      const bridge = adapter();
      const ref = { providerId: 'acme' };

      await expect(bridge.invoke('secrets_status', ref)).resolves.toEqual({ present: false });
      await expect(bridge.invoke('secrets_set', { ...ref, value: 'sk-test' })).resolves.toEqual({
        ok: true,
      });
      await expect(bridge.invoke('secrets_status', ref)).resolves.toEqual({ present: true });
      await expect(bridge.invoke('secrets_delete', ref)).resolves.toEqual({ ok: true });
      await expect(bridge.invoke('secrets_status', ref)).resolves.toEqual({ present: false });
    });

    it('treats "no credential" as a valid state, not an error', async () => {
      // The rule: many local endpoints have no auth. Asking about a provider
      // that has never had a key must resolve, never reject.
      await expect(
        adapter().invoke('secrets_status', { providerId: 'local-llamacpp' }),
      ).resolves.toEqual({ present: false });
    });

    it('deletes idempotently', async () => {
      await expect(adapter().invoke('secrets_delete', { providerId: 'nobody' })).resolves.toEqual({
        ok: true,
      });
    });

    it('namespaces fields per provider', async () => {
      const bridge = adapter();
      await bridge.invoke('secrets_set', { providerId: 'p', value: 'one' });
      await bridge.invoke('secrets_set', { providerId: 'p', field: 'orgId', value: 'two' });

      await expect(bridge.invoke('secrets_status', { providerId: 'p' })).resolves.toEqual({
        present: true,
      });
      await expect(
        bridge.invoke('secrets_status', { providerId: 'p', field: 'orgId' }),
      ).resolves.toEqual({ present: true });
      await expect(
        bridge.invoke('secrets_status', { providerId: 'p', field: 'other' }),
      ).resolves.toEqual({ present: false });
    });

    it('rejects an empty credential and a blank provider id', async () => {
      const bridge = adapter();
      await expect(bridge.invoke('secrets_set', { providerId: 'p', value: '' })).rejects.toMatchObject(
        { code: 'INVALID_PAYLOAD' },
      );
      await expect(
        bridge.invoke('secrets_set', { providerId: '   ', value: 'v' }),
      ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    });
  });

  describe('events', () => {
    it('delivers to subscribers until unsubscribed', async () => {
      const bridge = adapter();
      const seen: unknown[] = [];
      const unsubscribe = await bridge.listen('test:event', (payload) => seen.push(payload));

      bridge.emit('test:event', { n: 1 });
      unsubscribe();
      bridge.emit('test:event', { n: 2 });

      expect(seen).toEqual([{ n: 1 }]);
    });
  });
});
