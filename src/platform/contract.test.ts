import { describe, expect, it } from 'vitest';

import { COMMAND_ALLOWLIST, isAllowedCommand, type IpcContract } from './contract';

/**
 * The TS half of the cross-language contract guard. The Rust half
 * (`ipc::tests::rust_and_typescript_allowlists_are_identical`) reads this file
 * and fails `cargo test` if the two lists diverge.
 */
describe('IPC contract', () => {
  it('lists every command in the contract, and nothing else', () => {
    // Runtime exhaustiveness: a key added to IpcContract but forgotten in the
    // allowlist would be unreachable from the renderer.
    const contractKeys: (keyof IpcContract)[] = [
      'app_info',
      'chat_cancel',
      'chat_send',
      'diagnostics_debug_log_get',
      'diagnostics_debug_log_set',
      'diagnostics_echo',
      'models_capabilities',
      'models_list',
      'models_probe',
      'secrets_delete',
      'secrets_set',
      'secrets_status',
      'settings_delete_provider',
      'settings_get',
      'settings_put_provider',
      'settings_set_theme',
      'skills_list',
      'skills_read',
      'store_append_message',
      'store_autotitle_conversation',
      'store_create_conversation',
      'store_delete_conversation',
      'store_delete_message',
      'store_list_conversations',
      'store_list_messages',
      'store_rename_conversation',
      'store_search',
      'store_update_message',
      'ui_get_layout',
      'ui_set_layout',
    ];
    expect([...COMMAND_ALLOWLIST].sort()).toEqual([...contractKeys].sort());
  });

  it('is sorted and free of duplicates', () => {
    expect([...COMMAND_ALLOWLIST]).toEqual([...COMMAND_ALLOWLIST].sort());
    expect(new Set(COMMAND_ALLOWLIST).size).toBe(COMMAND_ALLOWLIST.length);
  });

  it('names every command <domain>_<verb> in snake_case', () => {
    for (const name of COMMAND_ALLOWLIST) {
      expect(name).toMatch(/^[a-z]+(_[a-z]+)+$/);
    }
  });

  it('exposes no command that returns secret material', () => {
    expect(COMMAND_ALLOWLIST).not.toContain('secrets_get');
    expect(isAllowedCommand('secrets_get')).toBe(false);
  });

  it('rejects unknown command names at the type guard', () => {
    expect(isAllowedCommand('app_info')).toBe(true);
    expect(isAllowedCommand('shell_execute')).toBe(false);
  });
});
