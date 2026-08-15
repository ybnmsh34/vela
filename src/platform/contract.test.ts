import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { COMMAND_ALLOWLIST, isAllowedCommand, type CommandName } from './contract';
import { declaredCommandsIn } from './declared-commands';

/**
 * The TS half of the cross-language contract guard. The Rust half
 * (`ipc::tests::rust_and_typescript_allowlists_are_identical`) reads this file
 * and fails `cargo test` if the two lists diverge.
 *
 * ## What used to be here, and why it could not bite
 *
 * The exhaustiveness case below was checked against a **hand-written array of
 * fifty-five names copied into this file**. That array cannot catch the case it
 * was written for. A command declared in `IpcContract` and forgotten in
 * `COMMAND_ALLOWLIST` is unreachable from the renderer — and it stayed green
 * here, because the copy did not know about it either. The same in reverse: a
 * name in the allowlist with no entry in `IpcContract` passed as long as
 * somebody typed it into the copy too. Three lists existed, and the comparison
 * never touched the declaration.
 *
 * So the key set is now read out of the contract's own source by
 * {@link declaredCommandsIn}, because an `export interface` has no runtime value
 * and `Object.keys` of it is not a thing that exists. The comparison below is
 * between the exported array and the declaration it is supposed to mirror, and
 * a command added to either one alone reddens
 * `lists every command the contract declares, and nothing else`.
 */

const CONTRACT_SOURCE = readFileSync(
  join(process.cwd(), 'src', 'platform', 'contract.ts'),
  'utf8',
);

/**
 * The same direction, held a second time at `pnpm typecheck`.
 *
 * `contract.ts` already proves allowlist ⊆ contract with an annotation; this is
 * contract ⊆ allowlist, which that file said could not be expressed. It can —
 * `src/platform/project-host-parity.test.ts` carries the identical device over
 * `ProjectCommands` — and the annotation resolves to `true` only while nothing
 * is missing, and to a tuple naming the absent command otherwise. It is `void`ed
 * rather than asserted on: asserting that a constant initialised to `true` is
 * `true` is a green test holding nothing at runtime.
 *
 * Two guards, and they fail at different times: this one stops the repository
 * compiling, the test below fails `pnpm test` even when the type has been
 * silenced. Neither is decoration for the other.
 */
type CommandsMissingFromTheAllowlist = Exclude<CommandName, (typeof COMMAND_ALLOWLIST)[number]>;

const everyContractCommandIsAllowlisted: [CommandsMissingFromTheAllowlist] extends [never]
  ? true
  : ['this command is declared but not allowlisted', CommandsMissingFromTheAllowlist] = true;
void everyContractCommandIsAllowlisted;

describe('IPC contract', () => {
  it('lists every command the contract declares, and nothing else', () => {
    // Runtime exhaustiveness, against the declaration rather than against a
    // transcription of it. A key added to `IpcContract` but forgotten in the
    // allowlist would be unreachable from the renderer; a name in the allowlist
    // with no contract entry is untyped at every call site.
    const declared = declaredCommandsIn(CONTRACT_SOURCE, 'IpcContract');

    expect([...COMMAND_ALLOWLIST].sort()).toEqual([...declared].sort());
  });

  it('read the declaration rather than an empty body', () => {
    // The control for the reader above. The comparison is an exact-set
    // comparison, so a parse that read nothing fails it — but a parse that read
    // a *truncated* body would only ever fail with a diff, never with an
    // explanation, so what it reached is pinned here by name: the first member,
    // the member sitting directly under the interface's one block doc comment,
    // and the last member. Membership, not position — a pinned index or a
    // pinned count is a second copy of the list, and would fail on every honest
    // addition to the contract. The parser's own behaviour on a fabricated
    // interface is covered where it is also used, in
    // `src/platform/project-host-parity.test.ts`.
    const declared = declaredCommandsIn(CONTRACT_SOURCE, 'IpcContract');

    expect(declared.length).toBeGreaterThan(50);
    expect(declared).toContain('app_info');
    expect(declared).toContain('project_create');
    expect(declared).toContain('ui_set_layout');
    for (const command of declared) expect(command).toMatch(/^[a-z]+(_[a-z]+)+$/);
    expect(() => declaredCommandsIn(CONTRACT_SOURCE, 'NoSuchInterface')).toThrow();
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
    // Named, because "secrets_get" is the one this repo argues about by name —
    // `src-tauri/crates/vela-core/src/secret.rs` says there is deliberately no
    // such command and there never will be.
    expect(COMMAND_ALLOWLIST).not.toContain('secrets_get');
    expect(isAllowedCommand('secrets_get')).toBe(false);

    // And by shape, because a rule that only knows one spelling is not a rule.
    // The same verbs the host forbids in `ipc::tests::no_command_returns_secret_material`,
    // matched on the first word after the domain so a longer name cannot slip
    // past by appending to it.
    for (const name of COMMAND_ALLOWLIST) {
      expect(name).not.toMatch(/^secrets_(?:get|read|reveal|export|show|fetch|dump)(?:_|$)/);
    }

    // The control: the three `secrets_*` commands that do exist must survive the
    // pattern, or it would be passing by forbidding the whole domain.
    expect(COMMAND_ALLOWLIST).toContain('secrets_set');
    expect(COMMAND_ALLOWLIST).toContain('secrets_delete');
    expect(COMMAND_ALLOWLIST).toContain('secrets_status');
  });

  it('rejects unknown command names at the type guard', () => {
    expect(isAllowedCommand('app_info')).toBe(true);
    expect(isAllowedCommand('shell_execute')).toBe(false);
  });
});
