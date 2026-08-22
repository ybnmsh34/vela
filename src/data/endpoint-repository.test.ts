/**
 * The local endpoint repository, against the fake host.
 *
 * **VERIFIED-BY-FAKE.** `BrowserAdapter` opens no socket. What is under test
 * here is the protocol shape and the *decisions* — which configurations are
 * refused, and the bind-address tool policy, which is a security rule and is
 * therefore worth exercising on both sides of the boundary. Nothing here is
 * evidence that a port was ever opened; the socket probe in
 * `src-tauri/tests/endpoint_runtime_control.rs` is.
 */

import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformError } from '@/platform/errors';

import { awaitsExposureConfirmation, createEndpointRepository } from './endpoint-repository';

const KEY = 'sk-vela-test';

function repository() {
  return createEndpointRepository(new BrowserAdapter());
}

describe('the local endpoint repository', () => {
  it('starts off, and off is not an error', async () => {
    const status = await repository().status();
    expect(status.state).toBe('off');
    expect(status.address).toBeNull();
    expect(status.toolsEnabled).toBe(false);
    expect(status.toolPolicy).toBeNull();
  });

  it('enables, reports the port that was bound, and disables again', async () => {
    const endpoints = repository();

    const on = await endpoints.enable({
      bind: '127.0.0.1:0',
      key: KEY,
      providerId: 'study-box',
    });
    expect(on.state).toBe('serving');
    expect(on.providerId).toBe('study-box');
    expect(on.loopback).toBe(true);
    // The host answers with the port it was *given*, so a caller that asked for
    // 0 gets a real one back. A repository that echoed the request would hide
    // that, and the panel would show a user `:0`.
    expect(on.address).not.toBeNull();
    expect(on.address ?? '').not.toMatch(/:0$/);

    const off = await endpoints.disable();
    expect(off.state).toBe('off');
    expect(off.address).toBeNull();
    expect(off.toolsEnabled).toBe(false);
  });

  it('refuses an address, a key or an endpoint id it cannot use, without binding', async () => {
    const endpoints = repository();
    for (const [label, request] of [
      ['a hostname', { bind: 'localhost:8034', key: KEY, providerId: 'a' }],
      ['no port', { bind: '127.0.0.1', key: KEY, providerId: 'a' }],
      ['a port out of range', { bind: '127.0.0.1:70000', key: KEY, providerId: 'a' }],
      ['an octet out of range', { bind: '127.0.0.300:1', key: KEY, providerId: 'a' }],
      ['no key', { bind: '127.0.0.1:0', key: '   ', providerId: 'a' }],
      ['no endpoint', { bind: '127.0.0.1:0', key: KEY, providerId: ' ' }],
    ] as const) {
      await expect(endpoints.enable(request), label).rejects.toBeInstanceOf(PlatformError);
    }
    expect((await endpoints.status()).state, 'a refusal must not have opened a port').toBe('off');
  });

  describe('the bind-address tool policy', () => {
    // The rule, exercised through the door the UI actually uses. Loopback may
    // run tools; an address the network can reach may not, and forcing them
    // there needs a confirmation or it fails closed.
    it('turns tools on for a loopback bind and off for a wildcard one', async () => {
      const endpoints = repository();

      const loopback = await endpoints.enable({ bind: '127.0.0.1:0', key: KEY, providerId: 'a' });
      expect(loopback.toolsEnabled).toBe(true);
      expect(loopback.toolPolicy).toBe('loopback-default');
      expect(loopback.loopback).toBe(true);

      const exposed = await endpoints.enable({ bind: '0.0.0.0:0', key: KEY, providerId: 'a' });
      expect(exposed.toolsEnabled).toBe(false);
      expect(exposed.toolPolicy).toBe('exposed-default');
      expect(exposed.loopback).toBe(false);
    });

    it('treats the whole of 127.0.0.0/8 and [::1] as loopback, and [::] as not', async () => {
      const endpoints = repository();
      for (const bind of ['127.0.0.1:0', '127.0.0.53:0', '[::1]:0']) {
        expect((await endpoints.enable({ bind, key: KEY, providerId: 'a' })).loopback, bind).toBe(
          true,
        );
      }
      for (const bind of ['0.0.0.0:0', '192.168.1.10:0', '[::]:0']) {
        expect((await endpoints.enable({ bind, key: KEY, providerId: 'a' })).loopback, bind).toBe(
          false,
        );
      }
    });

    it('fails closed when tools are forced onto an exposed bind unconfirmed', async () => {
      const endpoints = repository();

      const unconfirmed = await endpoints.enable({
        bind: '0.0.0.0:0',
        key: KEY,
        providerId: 'a',
        tools: 'on',
      });
      expect(unconfirmed.toolsEnabled).toBe(false);
      expect(unconfirmed.toolPolicy).toBe('exposed-enable-unconfirmed');
      expect(awaitsExposureConfirmation(unconfirmed)).toBe(true);

      const confirmed = await endpoints.enable({
        bind: '0.0.0.0:0',
        key: KEY,
        providerId: 'a',
        tools: 'on',
        confirmExposedTools: true,
      });
      expect(confirmed.toolsEnabled).toBe(true);
      expect(confirmed.toolPolicy).toBe('forced-on');
      expect(awaitsExposureConfirmation(confirmed)).toBe(false);
    });

    it('honours a request for no tools everywhere, loopback included', async () => {
      const endpoints = repository();
      for (const bind of ['127.0.0.1:0', '0.0.0.0:0']) {
        const status = await endpoints.enable({ bind, key: KEY, providerId: 'a', tools: 'off' });
        expect(status.toolsEnabled, bind).toBe(false);
        expect(status.toolPolicy, bind).toBe('forced-off');
      }
    });

    /**
     * **The rebind rule, on the renderer's side of the boundary.**
     *
     * Going loopback → wildcard must not carry the loopback answer forward.
     * The reverse leg is the control: a fake that simply always answered
     * "exposed" after the first rebind would pass the first half alone.
     */
    it('re-resolves the policy on every rebind rather than carrying one forward', async () => {
      const endpoints = repository();

      const first = await endpoints.enable({ bind: '127.0.0.1:0', key: KEY, providerId: 'a' });
      expect(first.toolsEnabled).toBe(true);

      const widened = await endpoints.enable({ bind: '0.0.0.0:0', key: KEY, providerId: 'a' });
      expect(widened.toolsEnabled, 'a widened bind must not inherit tools').toBe(false);
      expect(widened.toolPolicy).toBe('exposed-default');

      const narrowed = await endpoints.enable({ bind: '127.0.0.1:0', key: KEY, providerId: 'a' });
      expect(narrowed.toolsEnabled).toBe(true);
      expect(narrowed.toolPolicy).toBe('loopback-default');
    });
  });

  it('never hands the key back', async () => {
    const endpoints = repository();
    const status = await endpoints.enable({
      bind: '127.0.0.1:0',
      key: 'sk-vela-canary-DO-NOT-LOG',
      providerId: 'a',
    });
    expect(JSON.stringify(status)).not.toContain('sk-vela-canary');
    expect(JSON.stringify(await endpoints.status())).not.toContain('sk-vela-canary');
  });
});
