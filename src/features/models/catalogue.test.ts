import { describe, expect, it } from 'vitest';

import type { ProviderView, SecurityPosture } from '@/platform/contract';

import {
  defaultSelection,
  entryKey,
  isSelectable,
  modelEntries,
  selectionOf,
  stillExists,
} from './catalogue';

const QUIET: SecurityPosture = {
  level: 'none',
  scope: 'loopback',
  leavesDevice: false,
  trafficIsPlaintext: true,
  credentialSentInPlaintext: false,
  credentialInQueryString: false,
  endpointIsUnauthenticated: true,
  concerns: [],
};

function view(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: 'workstation',
    displayName: 'The workstation',
    kind: 'local',
    // An opaque token the host chose; this feature only ever carries it.
    protocol: 'someProtocolTheHostNamed',
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelId: 'some-model',
    auth: { type: 'none' },
    authRequirement: 'notRequired',
    credentialPresent: false,
    usable: true,
    credentialCheck: 'satisfiedWithoutCredential',
    authMode: { type: 'none' },
    credentialFieldLabel: null,
    security: QUIET,
    ...overrides,
  };
}

describe('modelEntries', () => {
  it('makes one row per configured endpoint', () => {
    const entries = modelEntries([view(), view({ id: 'laptop', displayName: 'Laptop' })]);
    expect(entries.map((entry) => entry.providerId)).toEqual(['workstation', 'laptop']);
    expect(entries.every(isSelectable)).toBe(true);
  });

  it('keeps an unusable endpoint visible, with the reason attached', () => {
    // Hiding it would leave the user staring at a switcher that omits the thing
    // they just configured, with nowhere to find out why.
    const entries = modelEntries([
      view({ usable: false, credentialCheck: 'missingRequired', credentialFieldLabel: 'API key' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.blocked).toBe('credentialRequired');
    expect(isSelectable(entries[0]!)).toBe(false);
  });

  it('marks an endpoint with no model named, without calling it broken', () => {
    const entries = modelEntries([view({ modelId: null })]);
    expect(entries[0]?.blocked).toBe('noModelChosen');
  });

  it('blames the credential first when an endpoint is missing both', () => {
    // The order is fixed so the message cannot flicker between two truths as
    // the user fixes them in either order.
    const entries = modelEntries([view({ modelId: null, usable: false })]);
    expect(entries[0]?.blocked).toBe('credentialRequired');
  });

  it('adds the models an endpoint enumerated, without duplicating the configured one', () => {
    const entries = modelEntries(
      [view({ modelId: 'some-model' })],
      new Map([
        [
          'workstation',
          [
            { modelId: 'some-model', displayName: 'Some model', contextWindowTokens: 4096 },
            { modelId: 'another', displayName: 'Another', contextWindowTokens: null },
          ],
        ],
      ]),
    );
    expect(entries.map((entry) => entry.modelId)).toEqual(['some-model', 'another']);
  });

  it('falls back to the id when an endpoint names a model with an empty string', () => {
    const entries = modelEntries(
      [view({ modelId: null })],
      new Map([['workstation', [{ modelId: 'raw-id', displayName: '', contextWindowTokens: null }]]]),
    );
    expect(entries[1]?.modelLabel).toBe('raw-id');
  });

  it('gives a discovered model the endpoint-level block, never "no model chosen"', () => {
    const entries = modelEntries(
      [view({ modelId: null, usable: false })],
      new Map([['workstation', [{ modelId: 'x', displayName: 'X', contextWindowTokens: null }]]]),
    );
    expect(entries[1]?.blocked).toBe('credentialRequired');
  });
});

describe('selection', () => {
  it('refuses to build a selection from a row that cannot be chosen', () => {
    const [blocked] = modelEntries([view({ usable: false })]);
    expect(selectionOf(blocked!)).toBeNull();
  });

  it('defaults to the first selectable row, skipping the ones that are not', () => {
    const entries = modelEntries([
      view({ id: 'a', displayName: 'A', modelId: null }),
      view({ id: 'b', displayName: 'B', usable: false }),
      view({ id: 'c', displayName: 'C', modelId: 'good' }),
    ]);
    expect(defaultSelection(entries)).toEqual({
      providerId: 'c',
      modelId: 'good',
      providerLabel: 'C',
      modelLabel: 'good',
    });
  });

  it('has no default when nothing is usable', () => {
    expect(defaultSelection(modelEntries([view({ usable: false })]))).toBeNull();
    expect(defaultSelection([])).toBeNull();
  });

  it('notices a selection whose endpoint was deleted', () => {
    // Without this the app addresses a provider the host no longer has, and
    // every turn comes back NOT_FOUND with nothing on screen to explain it.
    const entries = modelEntries([view({ id: 'kept', modelId: 'm' })]);
    const gone = { providerId: 'deleted', modelId: 'm', providerLabel: 'D', modelLabel: 'm' };
    expect(stillExists(entries, gone)).toBe(false);
    expect(
      stillExists(entries, {
        providerId: 'kept',
        modelId: 'm',
        providerLabel: 'K',
        modelLabel: 'm',
      }),
    ).toBe(true);
    expect(stillExists(entries, null)).toBe(false);
  });

  it('distinguishes two models on the same endpoint by key', () => {
    expect(entryKey({ providerId: 'p', modelId: 'a' })).not.toBe(
      entryKey({ providerId: 'p', modelId: 'b' }),
    );
  });

  it('cannot be made to collide by an id that contains the separator', () => {
    // The reason the separator is a NUL and not a slash, a space or a colon.
    // Both halves are user-supplied — a base URL's id and whatever the endpoint
    // calls its model — so any *printable* separator is one an id can contain,
    // and these two rows would fold into one in the switcher.
    expect(entryKey({ providerId: 'a/b', modelId: 'c' })).not.toBe(
      entryKey({ providerId: 'a', modelId: 'b/c' }),
    );
    expect(entryKey({ providerId: 'a b', modelId: 'c' })).not.toBe(
      entryKey({ providerId: 'a', modelId: 'b c' }),
    );
    expect(entryKey({ providerId: 'a:b', modelId: 'c' })).not.toBe(
      entryKey({ providerId: 'a', modelId: 'b:c' }),
    );
  });

  it('keeps a separator at all — a joined key with none collides', () => {
    // Guards the failure mode `control-characters.test.ts` exists to prevent:
    // an invisible separator that a patch tool or an editor silently ate leaves
    // `entryKey` still compiling, still passing the test above, and returning
    // the same string for two different rows.
    expect(entryKey({ providerId: 'ab', modelId: 'c' })).not.toBe(
      entryKey({ providerId: 'a', modelId: 'bc' }),
    );
  });
});
