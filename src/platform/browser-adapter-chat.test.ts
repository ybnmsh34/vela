/**
 * The fake host's chat semantics, asserted against the rules the Rust host
 * enforces in `src-tauri/src/ipc/chat.rs`.
 *
 * Each test here has a named counterpart in that module's `#[cfg(test)] mod
 * tests`. When the two disagree, the fake is wrong — the host is the
 * specification. Everything proved here is **VERIFIED-BY-FAKE**: it establishes
 * protocol shape and UI behaviour, and nothing whatsoever about a real endpoint.
 */

import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from './browser-adapter';
import type { ChatEventEnvelope } from './contract';
import { PlatformError } from './errors';

async function withProvider(id = 'workstation'): Promise<BrowserAdapter> {
  const adapter = new BrowserAdapter();
  await adapter.invoke('settings_put_provider', {
    id,
    displayName: 'Workstation',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
  });
  return adapter;
}

async function record(adapter: BrowserAdapter): Promise<ChatEventEnvelope[]> {
  const seen: ChatEventEnvelope[] = [];
  await adapter.listen('chat:event', (payload) => seen.push(payload));
  return seen;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const TURN = { turnId: 't1', providerId: 'workstation', modelId: 'a-model' };

describe('the fake host: chat_send', () => {
  it('accepts a turn and streams it afterwards, not inside the call', async () => {
    const adapter = await withProvider();
    const seen = await record(adapter);

    const accepted = await adapter.invoke('chat_send', {
      ...TURN,
      messages: [{ role: 'user', text: 'two words' }],
    });

    expect(accepted).toEqual({ turnId: 't1', accepted: true });
    await settle();
    expect(seen.at(-1)?.event.type).toBe('done');
    expect(seen.every((envelope) => envelope.turnId === 't1')).toBe(true);
  });

  it('splits the answer across frames, so a whole-answer renderer cannot pass', async () => {
    const adapter = await withProvider();
    const seen = await record(adapter);
    await adapter.invoke('chat_send', {
      ...TURN,
      messages: [{ role: 'user', text: 'one two three four' }],
    });
    await settle();

    const deltas = seen.filter((envelope) => envelope.event.type === 'textDelta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => (d.event.type === 'textDelta' ? d.event.text : '')).join('')).toBe(
      'one two three four',
    );
  });

  it('always ends the stream exactly once', async () => {
    const adapter = await withProvider();
    const seen = await record(adapter);
    await adapter.invoke('chat_send', { ...TURN, messages: [{ role: 'user', text: 'hi' }] });
    await settle();

    const terminals = seen.filter(
      (envelope) => envelope.event.type === 'done' || envelope.event.type === 'error',
    );
    expect(terminals).toHaveLength(1);
  });

  it('reports that it does not know token counts rather than reporting zeros', async () => {
    const adapter = await withProvider();
    const seen = await record(adapter);
    await adapter.invoke('chat_send', { ...TURN, messages: [{ role: 'user', text: 'hi' }] });
    await settle();

    const done = seen.at(-1)?.event;
    expect(done?.type).toBe('done');
    if (done?.type !== 'done') return;
    expect(done.response.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cachedInputTokens: null,
    });
    expect(done.response.degradations).toContainEqual({ kind: 'usageNotReported' });
  });

  /* -- the rejection paths, in the host's own order ----------------------- */

  it('rejects a blank turn id before it looks at anything else', async () => {
    const adapter = await withProvider();
    await expect(
      adapter.invoke('chat_send', {
        turnId: '  ',
        providerId: '',
        modelId: '',
        messages: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD', message: expect.stringContaining('turnId') });
  });

  it('rejects a turn with no messages', async () => {
    const adapter = await withProvider();
    await expect(adapter.invoke('chat_send', { ...TURN, messages: [] })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
      message: expect.stringContaining('at least one message'),
    });
  });

  it('names the offending index when a message is oversized', async () => {
    const adapter = await withProvider();
    await expect(
      adapter.invoke('chat_send', {
        ...TURN,
        messages: [
          { role: 'user', text: 'fine' },
          { role: 'user', text: 'x'.repeat(1_048_577) },
        ],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('messages[1]') });
  });

  it('is NOT_FOUND for an unconfigured provider, never a quiet substitution', async () => {
    const adapter = await withProvider();
    const error = await adapter
      .invoke('chat_send', { ...TURN, providerId: 'somewhere-else', messages: [{ role: 'user', text: 'hi' }] })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe('NOT_FOUND');
  });

  it('refuses a turn id that is already streaming', async () => {
    const adapter = await withProvider();
    await adapter.invoke('chat_send', {
      ...TURN,
      messages: [{ role: 'user', text: 'a b c d e' }],
    });
    await expect(
      adapter.invoke('chat_send', { ...TURN, messages: [{ role: 'user', text: 'again' }] }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD', message: expect.stringContaining('already') });
  });

  it('frees a turn id once its turn has finished', async () => {
    const adapter = await withProvider();
    await adapter.invoke('chat_send', { ...TURN, messages: [{ role: 'user', text: 'hi' }] });
    await settle();
    await expect(
      adapter.invoke('chat_send', { ...TURN, messages: [{ role: 'user', text: 'again' }] }),
    ).resolves.toMatchObject({ accepted: true });
  });
});

describe('the fake host: chat_cancel', () => {
  it('ends a cancelled turn with a terminal cancelled error', async () => {
    const adapter = await withProvider();
    const seen = await record(adapter);
    await adapter.invoke('chat_send', {
      ...TURN,
      messages: [{ role: 'user', text: 'a b c d e f g h' }],
    });

    expect(await adapter.invoke('chat_cancel', { turnId: 't1' })).toEqual({ cancelled: true });
    await settle();

    expect(seen.at(-1)?.event).toEqual({ type: 'error', error: { kind: 'cancelled' } });
    expect(seen.filter((envelope) => envelope.event.type === 'done')).toHaveLength(0);
  });

  it('reports `false` for a turn that already finished — a race, not an error', async () => {
    const adapter = await withProvider();
    await adapter.invoke('chat_send', { ...TURN, messages: [{ role: 'user', text: 'hi' }] });
    await settle();
    expect(await adapter.invoke('chat_cancel', { turnId: 't1' })).toEqual({ cancelled: false });
  });

  it('rejects a blank turn id', async () => {
    const adapter = await withProvider();
    await expect(adapter.invoke('chat_cancel', { turnId: '' })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
  });
});
