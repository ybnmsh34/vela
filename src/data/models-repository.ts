/**
 * Models repository — what an endpoint holds, and what each model can do.
 *
 * Deliberately separate from {@link createSettingsRepository}: settings say what
 * the user *configured*, this says what an endpoint *demonstrated*, and a
 * configuration pointing at a switched-off box is a valid configuration with no
 * demonstrated capability at all. One repository would have to blur the two.
 *
 * Two calls, two costs, and the difference matters to the UI:
 *
 *  - {@link ModelsRepository.capabilities} is free. It reads the host's cache
 *    and never touches the network, so the switcher can ask about every model
 *    it lists without a settings screen going quiet for ten seconds.
 *  - {@link ModelsRepository.probe} and {@link ModelsRepository.listModels}
 *    contact the endpoint. They are user-triggered, never automatic.
 *
 * Neither returns a provider name, a URL or a vendor error string; adding a
 * backend changes nothing here and nothing above it.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import type {
  ModelCapabilityReport,
  ModelsListRes,
  ModelsProbeRes,
} from '@/platform/contract';

export interface ModelsRepository {
  /**
   * What is known right now. A model nobody has probed comes back with every
   * flag `false` and `probed: false` — not an error, and never an optimistic
   * guess. That floor is what the UI renders against.
   */
  capabilities(providerId: string, modelId: string): Promise<ModelCapabilityReport>;
  /**
   * Ask the endpoint what it can do. The report comes back either way: a probe
   * that could not reach the box returns what was already known plus a
   * `failure`, so the caller never has to choose between an error and a report.
   */
  probe(providerId: string, modelId: string): Promise<ModelsProbeRes>;
  /**
   * Ask the endpoint to enumerate its models. `enumerated: false` with no
   * failure is the normal answer from a runtime with no listing route — the UI
   * offers free-text entry and must not show an error.
   */
  listModels(providerId: string): Promise<ModelsListRes>;
}

export function createModelsRepository(adapter: PlatformAdapter): ModelsRepository {
  return {
    capabilities(providerId: string, modelId: string): Promise<ModelCapabilityReport> {
      return adapter.invoke('models_capabilities', { providerId, modelId });
    },

    probe(providerId: string, modelId: string): Promise<ModelsProbeRes> {
      return adapter.invoke('models_probe', { providerId, modelId });
    },

    listModels(providerId: string): Promise<ModelsListRes> {
      return adapter.invoke('models_list', { providerId });
    },
  };
}
