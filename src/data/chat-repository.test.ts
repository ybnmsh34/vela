import { describe, expect, it, vi } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import type { PlatformAdapter } from '@/platform/adapter';
import type { ChatStreamEvent } from '@/platform/contract';
import { PlatformError } from '@/platform/errors';

import { createChatRepository, newTurnId } from './chat-repository';

/** A configured provider, because the host refuses to stream without one. */
async function configured(adapter: BrowserAdapter, id = 'workstation'): Promise<BrowserAdapter> {
  await adapter.invoke('settings_put_provider', {
    id,
    displayName: 'Workstation',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
  });
  return adapter;
}

function collect(): { events: ChatStreamEvent[]; onEvent: (event: ChatStreamEvent) => void } {
  const events: ChatStreamEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

async function settle(): Promise<void> {
  // The fake schedules frames on the microtask queue; a macrotask turn drains
  // every one of them without a timer or an arbitrary sleep.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the chat repository', () => {
  it('streams a turn end to end and terminates it', async () => {
    const adapter = await configured(new BrowserAdapter());
    const repository = createChatRepository(adapter);
    const sink = collect();

    await repository.streamTurn({
      turnId: newTurnId(),
      providerId: 'workstation',
      modelId: 'some-model',
      messages: [{ role: 'user', text: 'ping pong' }],
      onEvent: sink.onEvent,
    });
    await settle();

    expect(sink.events.filter((event) => event.type === 'textDelta').length).toBeGreaterThan(1);
    expect(sink.events.at(-1)?.type).toBe('done');
  });

  /**
   * The ordering rule. `chat_send` resolves once the turn is *accepted*; frames
   * follow on the event channel and the first can beat the promise. Subscribing
   * after sending would drop it, so the repository subscribes first — this test
   * fails if that order is ever reversed, because the fake emits its first
   * frame in the microtask right after the send.
   */
  it('subscribes before it sends, so the first frame cannot be missed', async () => {
    const order: string[] = [];
    const inner = await configured(new BrowserAdapter());
    const spy: PlatformAdapter = {
      kind: inner.kind,
      invoke: (command, payload) => {
        order.push(`invoke:${command}`);
        return inner.invoke(command, payload);
      },
      listen: (event, handler) => {
        order.push(`listen:${event}`);
        return inner.listen(event, handler);
      },
    };

    const repository = createChatRepository(spy);
    const sink = collect();
    await repository.streamTurn({
      turnId: 't-order',
      providerId: 'workstation',
      modelId: 'm',
      messages: [{ role: 'user', text: 'hello there' }],
      onEvent: sink.onEvent,
    });
    await settle();

    expect(order[0]).toBe('listen:chat:event');
    expect(order).toContain('invoke:chat_send');
    expect(sink.events[0]?.type).toBe('textDelta');
  });

  it('subscribes once however many turns are run', async () => {
    const inner = await configured(new BrowserAdapter());
    const listen = vi.fn(inner.listen.bind(inner));
    const spy: PlatformAdapter = {
      kind: inner.kind,
      invoke: inner.invoke.bind(inner),
      listen: listen as PlatformAdapter['listen'],
    };
    const repository = createChatRepository(spy);

    for (const turnId of ['a', 'b', 'c']) {
      const sink = collect();
      await repository.streamTurn({
        turnId,
        providerId: 'workstation',
        modelId: 'm',
        messages: [{ role: 'user', text: 'hi' }],
        onEvent: sink.onEvent,
      });
      await settle();
    }
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it('routes each turn’s events only to that turn', async () => {
    const adapter = await configured(new BrowserAdapter());
    const repository = createChatRepository(adapter);
    const first = collect();
    const second = collect();

    await repository.streamTurn({
      turnId: 'one',
      providerId: 'workstation',
      modelId: 'm',
      messages: [{ role: 'user', text: 'alpha' }],
      onEvent: first.onEvent,
    });
    await repository.streamTurn({
      turnId: 'two',
      providerId: 'workstation',
      modelId: 'm',
      messages: [{ role: 'user', text: 'beta' }],
      onEvent: second.onEvent,
    });
    await settle();

    expect(first.events.some((e) => e.type === 'textDelta' && e.text.includes('alpha'))).toBe(true);
    expect(first.events.some((e) => e.type === 'textDelta' && e.text.includes('beta'))).toBe(false);
    expect(second.events.some((e) => e.type === 'textDelta' && e.text.includes('beta'))).toBe(true);
  });

  it('stops delivering after release, and a late frame is not an error', async () => {
    const adapter = await configured(new BrowserAdapter());
    const repository = createChatRepository(adapter);
    const sink = collect();

    const handle = await repository.streamTurn({
      turnId: 'released',
      providerId: 'workstation',
      modelId: 'm',
      messages: [{ role: 'user', text: 'one two three four' }],
      onEvent: sink.onEvent,
    });
    // Some frames have already landed by the time the send resolves — that is
    // the point of the fake. What matters is that none arrive after release.
    const atRelease = sink.events.length;
    handle.release();
    await settle();

    expect(sink.events).toHaveLength(atRelease);
    expect(sink.events.some((event) => event.type === 'done')).toBe(false);
  });

  it('cancels a live turn and reports a finished one honestly', async () => {
    const adapter = await configured(new BrowserAdapter());
    const repository = createChatRepository(adapter);
    const sink = collect();

    const handle = await repository.streamTurn({
      turnId: 'cancelled',
      providerId: 'workstation',
      modelId: 'm',
      messages: [{ role: 'user', text: 'a b c d e f g' }],
      onEvent: sink.onEvent,
    });

    expect(await handle.cancel()).toBe(true);
    await settle();
    expect(sink.events.at(-1)).toEqual({ type: 'error', error: { kind: 'cancelled' } });

    // Cancelling again is a race, not a fault.
    expect(await handle.cancel()).toBe(false);
  });

  it('propagates a refusal instead of returning a dead handle', async () => {
    const adapter = new BrowserAdapter();
    const repository = createChatRepository(adapter);

    await expect(
      repository.streamTurn({
        turnId: 'nope',
        providerId: 'not-configured',
        modelId: 'm',
        messages: [{ role: 'user', text: 'hi' }],
        onEvent: () => undefined,
      }),
    ).rejects.toBeInstanceOf(PlatformError);
  });

  it('mints unique turn ids', () => {
    const ids = new Set(Array.from({ length: 64 }, () => newTurnId()));
    expect(ids.size).toBe(64);
  });
});
