/**
 * Registration and selection, against the rules `contract-harness.ts` states.
 *
 * The one worth reading twice is the first-run case: the contract spends a
 * paragraph insisting that a `null` `requestedId` against a healthy registry
 * answers `substituted` with reason `noneChosen`, **not** `selected`, and that a
 * surface rendering every `substituted` as a warning would warn every new user
 * about nothing. Nothing enforced that until this file.
 */

import { describe, expect, it } from 'vitest';

import { NO_CAPABILITIES, type ChatCapabilities } from '@/platform/contract';
import type { HarnessDefinition, HarnessServices, RuntimeHarness } from '@/platform/contract-harness';

import { createHarnessRegistry, selectHarness } from './harness-registry';
import { inertServices } from './run-doubles';

function definition(
  id: string,
  requires: readonly (keyof ChatCapabilities)[] = [],
): HarnessDefinition {
  return {
    descriptor: {
      id,
      displayName: id,
      capabilities: { multiStep: true, toolExecution: true, auxiliaryModel: false },
      requiresModelCapabilities: requires,
    },
    create: (_services: HarnessServices): RuntimeHarness => ({
      start: () => ({ cancel: () => Promise.resolve() }),
    }),
  };
}

const TOOL_MODEL: ChatCapabilities = { ...NO_CAPABILITIES, toolCalls: true };

describe('the registry', () => {
  it('throws on a duplicate id, loudly, naming the collision', () => {
    // "Duplicate ids must be rejected, loudly, by throwing." The reference
    // assigns into a dict, so the winner is whichever module imported last.
    expect(() => createHarnessRegistry([definition('a'), definition('a')])).toThrow(/a/);
  });

  it('does not throw on an empty list', () => {
    // "An empty list does not throw, and the difference is not inconsistency."
    // `noneRegistered` is a SelectionReason a caller renders, and select is
    // called on every render.
    const registry = createHarnessRegistry([]);
    expect(registry.definitions).toEqual([]);
    expect(registry.find('a')).toBeNull();
  });

  it('answers find with null for an id this build does not have', () => {
    const registry = createHarnessRegistry([definition('a')]);
    expect(registry.find('a')?.descriptor.id).toBe('a');
    expect(registry.find('b')).toBeNull();
  });

  it('keeps the fallback order it was given, and a caller cannot reorder it', () => {
    // "Order is meaningful. `definitions` is the fallback order used by
    // selection; the first entry whose requirements the model meets is the
    // default."
    const registry = createHarnessRegistry([definition('first'), definition('second')]);
    const ids = registry.definitions.map((d) => d.descriptor.id);
    expect(ids).toEqual(['first', 'second']);

    expect(() => (registry.definitions as HarnessDefinition[]).reverse()).toThrow(TypeError);
    expect(registry.definitions.map((d) => d.descriptor.id)).toEqual(['first', 'second']);
  });

  it('creates a fresh harness per call, never a shared instance', () => {
    // "create is a factory rather than a shared instance ... an implementation
    // that held per-run state on itself would corrupt one of them."
    const registry = createHarnessRegistry([definition('a')]);
    const found = registry.find('a');
    expect(found).not.toBeNull();
    const services: HarnessServices = inertServices();
    expect(found?.create(services)).not.toBe(found?.create(services));
  });
});

describe('selection', () => {
  it('answers substituted with noneChosen on a first run, never selected', () => {
    const registry = createHarnessRegistry([definition('first'), definition('second')]);
    const selection = selectHarness(registry, { requestedId: null, model: NO_CAPABILITIES });

    expect(selection).toEqual({
      outcome: 'substituted',
      definition: registry.definitions[0],
      requestedId: null,
      reason: 'noneChosen',
    });
  });

  it('answers selected only when a stored choice was honoured', () => {
    const registry = createHarnessRegistry([definition('first'), definition('second')]);
    const selection = selectHarness(registry, { requestedId: 'second', model: NO_CAPABILITIES });
    expect(selection.outcome).toBe('selected');
    if (selection.outcome !== 'selected') return;
    expect(selection.definition.descriptor.id).toBe('second');
  });

  it('substitutes with unknownHarnessId for an id this build removed', () => {
    const registry = createHarnessRegistry([definition('first')]);
    const selection = selectHarness(registry, { requestedId: 'gone', model: NO_CAPABILITIES });
    expect(selection).toEqual({
      outcome: 'substituted',
      definition: registry.definitions[0],
      requestedId: 'gone',
      reason: 'unknownHarnessId',
    });
  });

  it('substitutes with modelCapabilityUnmet when the chosen harness needs a flag', () => {
    const registry = createHarnessRegistry([definition('plain'), definition('tools', ['toolCalls'])]);
    const selection = selectHarness(registry, { requestedId: 'tools', model: NO_CAPABILITIES });
    expect(selection).toEqual({
      outcome: 'substituted',
      definition: registry.definitions[0],
      requestedId: 'tools',
      reason: 'modelCapabilityUnmet',
    });
  });

  it('honours a requirement the model has established', () => {
    const registry = createHarnessRegistry([definition('plain'), definition('tools', ['toolCalls'])]);
    const selection = selectHarness(registry, { requestedId: 'tools', model: TOOL_MODEL });
    expect(selection.outcome).toBe('selected');
  });

  it('is unavailable with noneRegistered for an empty registry', () => {
    // "The registry is empty, which is a build defect rather than a user state."
    const registry = createHarnessRegistry([]);
    expect(selectHarness(registry, { requestedId: null, model: NO_CAPABILITIES })).toEqual({
      outcome: 'unavailable',
      requestedId: null,
      reason: 'noneRegistered',
    });
  });

  it('is unavailable with modelCapabilityUnmet when nothing in a full registry qualifies', () => {
    // The judgement `harness-registry.ts` documents as its own rather than the
    // contract's: an unprobed model excludes every entry, and answering
    // `noneChosen` would tell a user who chose nothing that they chose nothing.
    const registry = createHarnessRegistry([definition('tools', ['toolCalls'])]);
    expect(selectHarness(registry, { requestedId: null, model: NO_CAPABILITIES })).toEqual({
      outcome: 'unavailable',
      requestedId: null,
      reason: 'modelCapabilityUnmet',
    });
  });

  it('performs no I/O, so a settings surface can call it on every render', () => {
    // Pure and synchronous: the same request answers identically, and nothing
    // it touched can have changed in between.
    const registry = createHarnessRegistry([definition('first')]);
    const once = selectHarness(registry, { requestedId: null, model: NO_CAPABILITIES });
    const twice = selectHarness(registry, { requestedId: null, model: NO_CAPABILITIES });
    expect(once).toEqual(twice);
  });
});
