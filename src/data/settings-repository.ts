/**
 * Settings repository — appearance, privacy, and provider configuration.
 *
 * Everything here is a thin, typed pass-through to the host. Two properties are
 * deliberate and load-bearing:
 *
 *  1. **No credential value ever passes through this file.** A key is written
 *     with {@link SettingsRepository.storeCredential}, which forwards to
 *     `secrets_set` and gets back an acknowledgement. There is no read; the
 *     value goes to the OS keychain and the renderer only ever learns
 *     `credentialPresent: boolean` from a snapshot.
 *  2. **No provider-specific knowledge.** Nothing here (and nothing in any UI
 *     built on it) may branch on a provider id. Every decision the UI needs is
 *     a flag the host computed: `usable`, `credentialFieldLabel`,
 *     `security.level`. Adding a backend changes no code under `src/`.
 *
 * Telemetry has no setter, here or in the host. `SettingsSnapshot.telemetryEnabled`
 * is read-only and always `false`.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import type {
  ProviderView,
  SettingsPutProviderReq,
  SettingsSnapshot,
  ThemePreference,
} from '@/platform/contract';

export interface SettingsRepository {
  /** Everything a settings screen needs, in one call. */
  load(): Promise<SettingsSnapshot>;
  setTheme(theme: ThemePreference): Promise<ThemePreference>;
  /** Create or replace a provider configuration. Never carries a credential. */
  putProvider(config: SettingsPutProviderReq): Promise<ProviderView>;
  /** Removes the configuration and any credential it owned. */
  deleteProvider(providerId: string): Promise<void>;
  /**
   * Write a provider's credential to the OS keychain.
   *
   * One-way: there is no matching read, by design. Resolves to nothing —
   * confirmation is `credentialPresent` on the next snapshot.
   */
  storeCredential(providerId: string, value: string): Promise<void>;
  /** Idempotent: clearing an absent credential succeeds. */
  clearCredential(providerId: string): Promise<void>;
  /** Whether a credential is stored. `false` is not an error. */
  hasCredential(providerId: string): Promise<boolean>;
}

export function createSettingsRepository(adapter: PlatformAdapter): SettingsRepository {
  return {
    load(): Promise<SettingsSnapshot> {
      return adapter.invoke('settings_get', {});
    },

    async setTheme(theme: ThemePreference): Promise<ThemePreference> {
      const result = await adapter.invoke('settings_set_theme', { theme });
      return result.theme;
    },

    putProvider(config: SettingsPutProviderReq): Promise<ProviderView> {
      return adapter.invoke('settings_put_provider', config);
    },

    async deleteProvider(providerId: string): Promise<void> {
      await adapter.invoke('settings_delete_provider', { providerId });
    },

    async storeCredential(providerId: string, value: string): Promise<void> {
      await adapter.invoke('secrets_set', { providerId, value });
    },

    async clearCredential(providerId: string): Promise<void> {
      await adapter.invoke('secrets_delete', { providerId });
    },

    async hasCredential(providerId: string): Promise<boolean> {
      const status = await adapter.invoke('secrets_status', { providerId });
      return status.present;
    },
  };
}

/**
 * Does this provider need the user to supply a credential before it can be
 * used? Distinguishes "needs a key it does not have" from "takes no key at
 * all", which look identical if you only test `credentialPresent`.
 *
 * A settings UI should call *this*, never `!view.credentialPresent`.
 */
export function needsCredential(view: ProviderView): boolean {
  return view.credentialCheck === 'missingRequired';
}

/** Should the UI render a credential input for this provider at all? */
export function acceptsCredential(view: ProviderView): boolean {
  return view.credentialFieldLabel !== null;
}
