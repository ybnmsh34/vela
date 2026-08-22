/**
 * The harness table, and the selection over it.
 *
 * `src/platform/contract-harness.ts` argues at length for why registration is an
 * explicit table built at the composition root rather than a decorator writing
 * into a module-level dict. This file is the table; nothing here is a module
 * singleton and nothing registers itself by being imported.
 *
 * ## The two failure shapes, which are deliberately different
 *
 * `createHarnessRegistry` **throws** on a duplicate id and **does not** throw on
 * an empty list. That asymmetry is the contract's, and its rule is "throw when
 * there is no defensible next state": there is no correct answer to which of two
 * implementations claiming one id the user wanted, and this call happens once at
 * a composition root where a wiring defect should stop the app. An empty
 * registry has a correct answer — `noneRegistered`, a state
 * `selectHarness` returns and a settings pane renders — and selection is called
 * on every render, so throwing there would take the window down repeatedly in
 * front of the surface that could have explained the problem.
 */

import type { ChatCapabilities } from '@/platform/contract';
import type {
  CreateHarnessRegistry,
  HarnessDefinition,
  HarnessId,
  HarnessRegistry,
  HarnessSelection,
  HarnessSelectionRequest,
  SelectionReason,
} from '@/platform/contract-harness';

/** Every model flag this harness demands has actually been established. */
function modelMeets(definition: HarnessDefinition, model: ChatCapabilities): boolean {
  return definition.descriptor.requiresModelCapabilities.every((flag) => model[flag]);
}

export const createHarnessRegistry: CreateHarnessRegistry = (
  definitions: readonly HarnessDefinition[],
): HarnessRegistry => {
  const byId = new Map<HarnessId, HarnessDefinition>();
  for (const definition of definitions) {
    const id = definition.descriptor.id;
    if (byId.has(id)) {
      // No id is interpolated into this message beyond the one that collided:
      // it is a build defect, read by whoever wired the root, and it has to name
      // the collision to be actionable.
      throw new Error(`duplicate harness id in registry: ${id}`);
    }
    byId.set(id, definition);
  }
  return {
    // Copied *and frozen*. `definitions` is documented as the fallback order and
    // as meaningful, so a caller that reordered it in place would silently
    // change which harness every later selection defaults to. `readonly` in the
    // type stops an honest caller; the freeze stops the other kind, and in a
    // module — always strict — the attempt throws rather than passing quietly.
    definitions: Object.freeze([...definitions]),
    find: (id: HarnessId): HarnessDefinition | null => byId.get(id) ?? null,
  };
};

/**
 * Pure and synchronous, so a settings surface can call it on every render to
 * show what *would* happen without starting anything.
 *
 * The order of the checks is the contract's, and the interesting one is the
 * first-run case it spells out explicitly: a `null` `requestedId` against a
 * non-empty registry answers **`substituted` with reason `noneChosen`**, never
 * `selected`. `selected` means the user's stored choice was honoured, and on
 * first run there is no stored choice to honour — which today is *every* run,
 * because nothing in `src/platform/contract.ts` can store a harness id.
 *
 * One judgement the contract leaves open, resolved here and stated so it is not
 * mistaken for the contract's own word: when the registry is non-empty and
 * nothing in it meets the model's established flags, the reason is
 * `modelCapabilityUnmet` even if the caller chose nothing. `noneChosen` would be
 * true and useless — it would tell a user who picked nothing that they picked
 * nothing, when what happened is that every harness was excluded by the model in
 * front of it. A requested id that is unknown keeps `unknownHarnessId` in that
 * position, because that is the fact about the request that matters most.
 */
export function selectHarness(
  registry: HarnessRegistry,
  request: HarnessSelectionRequest,
): HarnessSelection {
  const { requestedId, model } = request;
  if (registry.definitions.length === 0) {
    return { outcome: 'unavailable', requestedId, reason: 'noneRegistered' };
  }

  let reason: SelectionReason = 'noneChosen';
  if (requestedId !== null) {
    const requested = registry.find(requestedId);
    if (requested === null) {
      reason = 'unknownHarnessId';
    } else if (modelMeets(requested, model)) {
      return { outcome: 'selected', definition: requested };
    } else {
      reason = 'modelCapabilityUnmet';
    }
  }

  const fallback = registry.definitions.find((definition) => modelMeets(definition, model));
  if (fallback === undefined) {
    return {
      outcome: 'unavailable',
      requestedId,
      reason: reason === 'noneChosen' ? 'modelCapabilityUnmet' : reason,
    };
  }
  return { outcome: 'substituted', definition: fallback, requestedId, reason };
}
