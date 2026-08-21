/**
 * **Can anything in this renderer write to disk while the user is in incognito?**
 *
 * Not "does the transcript writer check the flag" — that is the guard one notch
 * narrower, and the gap between the two is every writer the author of the flag
 * did not think of. So the checks below are over the **whole contract**: every
 * command in `COMMAND_ALLOWLIST`, classified, with the classification asserted
 * against the wrapper's behaviour rather than described next to it.
 *
 * ## Why the completeness check is here as well as in the type
 *
 * `COMMAND_DURABILITY` is `Record<CommandName, …>`, so a command added to
 * `IpcContract` without a row does not compile. That is the stronger of the two
 * checks and it is not enough on its own: `tsc` is not what runs in CI's test
 * gate, `pnpm verify` has been observed to die before reaching the type check's
 * dependants, and the repository's own convention is that a type is not a test.
 * The runtime check reads the allowlist array — the same value the Rust host's
 * `rust_and_typescript_allowlists_are_identical` parses out of `contract.ts` —
 * and fails by name.
 */

import { describe, expect, it, vi } from 'vitest';

import type { PlatformAdapter } from './adapter';
import { BrowserAdapter } from './browser-adapter';
import { COMMAND_ALLOWLIST, type CommandName } from './contract';
import { PlatformError } from './errors';
import {
  COMMAND_DURABILITY,
  createIncognitoAdapter,
  disarmDebugLogForIncognito,
  isRefusedInIncognito,
  refusedCommands,
} from './incognito-adapter';

/** A spy adapter: records what reached the host, answers nothing useful. */
function recording(): PlatformAdapter & { readonly reached: string[] } {
  const reached: string[] = [];
  return {
    kind: 'browser',
    window: {
      minimize: async () => {},
      toggleMaximize: async () => {},
      isMaximized: async () => false,
      close: async () => {},
      onResized: async () => () => {},
    },
    reached,
    invoke: (async (command: string) => {
      reached.push(command);
      return {} as never;
    }) as PlatformAdapter['invoke'],
    listen: async () => () => {},
  };
}

describe('every command in the contract is classified', () => {
  it('leaves none unclassified', () => {
    const unclassified = COMMAND_ALLOWLIST.filter(
      (command) => COMMAND_DURABILITY[command] === undefined,
    );
    expect(
      unclassified,
      'classify it in COMMAND_DURABILITY from the host body, not from the name',
    ).toEqual([]);
  });

  it('classifies nothing that is not a command', () => {
    // The other direction. A row for a command the contract no longer has is a
    // classification nobody will notice is dead, and it makes `refusedCommands`
    // — which a surface may show a user — name something that cannot be called.
    const allowed = new Set<string>(COMMAND_ALLOWLIST);
    expect(Object.keys(COMMAND_DURABILITY).filter((name) => !allowed.has(name))).toEqual([]);
  });

  it('reads the allowlist it is quantifying over, so an empty list cannot pass', () => {
    // `declared-commands.ts` states the rule: every caller must pin what it read,
    // or the comparison degrades into two empty lists agreeing.
    expect(COMMAND_ALLOWLIST.length).toBeGreaterThan(50);
    expect(COMMAND_ALLOWLIST).toContain('store_append_message');
  });
});

describe('the classification is drawn from what the host actually does', () => {
  it('refuses the writers a conversation leaves behind', () => {
    for (const command of [
      'store_append_message',
      'store_create_conversation',
      'store_update_message',
      'store_rename_conversation',
      // Called by `conversations-repository.ts` on its own, without the
      // conversation surface asking — the writer a call-site flag would miss.
      'store_autotitle_conversation',
      'memory_add',
      'memory_update',
    ] satisfies CommandName[]) {
      expect(isRefusedInIncognito(command), `${command} should be refused`).toBe(true);
    }
  });

  it('refuses the three whose names read like reads', () => {
    // `project_layout` and `project_reconcile_skills` both resolve to
    // `ipc::project::layout`, which calls `fs::create_dir_all` on the workspace
    // and the skills mount and then reconciles links. `diagnostics_debug_log_set`
    // arms a sink that records raw provider bodies — the prompt and the answer —
    // to a file. Classifying by name would have marked all three `no-write`, and
    // the third would have made the whole mode a lie.
    expect(isRefusedInIncognito('project_layout')).toBe(true);
    expect(isRefusedInIncognito('project_reconcile_skills')).toBe(true);
    expect(isRefusedInIncognito('diagnostics_debug_log_set')).toBe(true);
  });

  it('allows reading, and allows erasing', () => {
    for (const command of [
      'store_list_messages',
      'store_list_conversations',
      'store_search',
      'project_get',
      'memory_list',
      'settings_get',
      'skills_read',
      // Runs the turn. Writes nothing on this machine; what the endpoint on the
      // other end keeps is outside this mode and is said so in the panel.
      'chat_send',
      // In-memory `CapabilityCache`, which dies with the process.
      'models_probe',
    ] satisfies CommandName[]) {
      expect(isRefusedInIncognito(command), `${command} should be allowed`).toBe(false);
    }
    for (const command of [
      'store_delete_message',
      'store_delete_conversation',
      'memory_delete',
      'memory_clear_scope',
    ] satisfies CommandName[]) {
      // A deletion records nothing. Refusing it would be a privacy mode that
      // stops you removing things.
      expect(isRefusedInIncognito(command), `${command} should be allowed`).toBe(false);
    }
  });

  it('names the refusals from the table rather than from a second list', () => {
    const named = refusedCommands();
    expect(named).toContain('store_append_message');
    expect(named).not.toContain('store_list_messages');
    expect(named.every(isRefusedInIncognito)).toBe(true);
  });
});

describe('the wrapper refuses at the seam', () => {
  it('never lets a refused command reach the host', async () => {
    const real = recording();
    const incognito = createIncognitoAdapter(real);

    await expect(
      incognito.invoke('store_append_message', {
        conversationId: 'c',
        role: 'user',
        parts: [{ kind: 'text', text: 'a secret' }],
      }),
    ).rejects.toBeInstanceOf(PlatformError);
    expect(real.reached, 'the command must not have been forwarded').toEqual([]);
  });

  it('rejects rather than resolving a value it did not get', async () => {
    // A silent no-op would put this mode in the silent-reduction class: the
    // caller believes it wrote and the user believes it saved.
    const incognito = createIncognitoAdapter(recording());
    const entry = {
      scope: { kind: 'global' } as const,
      category: 'other' as const,
      content: 'x',
    };
    await expect(incognito.invoke('memory_add', entry)).rejects.toThrow(/incognito/i);
    const error = await incognito.invoke('memory_add', entry).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe('INCOGNITO_REFUSED');
    // A distinct code, not `UNSUPPORTED`: "this build cannot" and "this window
    // is refusing right now" are different sentences to a user.
    expect((error as PlatformError).command).toBe('memory_add');
  });

  it('passes every allowed command straight through', async () => {
    const real = recording();
    const incognito = createIncognitoAdapter(real);
    await incognito.invoke('store_list_conversations', {});
    await incognito.invoke('settings_get', {});
    expect(real.reached).toEqual(['store_list_conversations', 'settings_get']);
  });

  it('leaves subscriptions and the window alone', async () => {
    // Refusing `listen` would stop the user seeing their own answer stream, and
    // the window controls write nothing at all.
    const real = recording();
    const incognito = createIncognitoAdapter(real);
    expect(incognito.window).toBe(real.window);
    expect(incognito.kind).toBe(real.kind);
    await expect(incognito.listen('chat:event', () => {})).resolves.toBeTypeOf('function');
  });

  it('refuses every `writes` command and forwards every other one', async () => {
    // The sweep. Not a sample: a command classified `writes` that the wrapper
    // forwards, or a `no-write` one it refuses, fails here by name — so the
    // table and the behaviour cannot drift apart.
    const forwarded: CommandName[] = [];
    const refused: CommandName[] = [];
    for (const command of COMMAND_ALLOWLIST) {
      const real = recording();
      const incognito = createIncognitoAdapter(real);
      await incognito
        .invoke(command, {} as never)
        .then(() => forwarded.push(command))
        .catch(() => refused.push(command));
    }
    expect(refused).toEqual(refusedCommands());
    expect(forwarded).toEqual(COMMAND_ALLOWLIST.filter((c) => !isRefusedInIncognito(c)));
  });
});

/**
 * The sentence this file exists to keep out of the refusal, kept verbatim.
 *
 * It was the shipped message until this pin was written. It is here so the word
 * list below is anchored on something that really was on screen: a list that
 * matched nothing would pass over any message at all, which is the vacuous-oracle
 * shape `refusedCommands()` was already caught in once.
 */
const WITHDRAWN_REFUSAL =
  'This window is in incognito, so nothing it does is written to this machine.';

/**
 * Shapes that turn a refusal into a promise about the machine.
 *
 * The refusal is rendered verbatim by every failure surface in the application
 * — `use-memory.ts` sets `problem` from `toPlatformError(error).message`, and
 * use-projects and use-schedules do the same — so it is user-facing copy
 * whatever it was written as. Two states make a blanket promise false, and the
 * wrapper can see neither of them: `disarmDebugLogForIncognito` answering
 * `'failed'`, in which the host's provider debug log is still writing raw
 * prompts and answers to a file; and `project_delete`, which is `erases`, is
 * forwarded, and whose host body runs an `UPDATE` beside its `DELETE`.
 *
 * So the message may say what was refused and why. It may not say what is or is
 * not being written.
 */
const BLANKET_PROMISES: readonly RegExp[] = [
  /nothing/i,
  /never/i,
  /no trace/i,
  /not (?:written|saved|kept|stored|recorded)/i,
];

describe('the refusal is copy, and it promises only what this wrapper can keep', () => {
  it('would have caught the sentence it replaced', () => {
    // The anchor. Without it an empty or misspelt list below passes anything.
    expect(BLANKET_PROMISES.filter((shape) => shape.test(WITHDRAWN_REFUSAL)).length).toBeGreaterThan(
      0,
    );
  });

  it('makes no claim about what this machine is writing', async () => {
    const incognito = createIncognitoAdapter(recording());
    const error = (await incognito
      .invoke('memory_add', {
        scope: { kind: 'global' },
        category: 'other',
        content: 'x',
      })
      .catch((thrown: unknown) => thrown)) as PlatformError;

    expect(error).toBeInstanceOf(PlatformError);
    // Not vacuous: it is a real sentence, and it does say why.
    expect(error.message.length).toBeGreaterThan(30);
    expect(error.message).toMatch(/incognito/i);

    // The substantive assertion first, so a regression reports *which* promise
    // came back rather than only that the sentence changed.
    const promised = BLANKET_PROMISES.filter((shape) => shape.test(error.message)).map(String);
    expect(
      promised,
      'the refusal may say what it refused; it may not promise what the machine is doing',
    ).toEqual([]);
    expect(error.message).not.toBe(WITHDRAWN_REFUSAL);
  });

  it('says the same thing for every command it refuses, and names none of them', async () => {
    // The sweep. A per-command message would let one of them carry a promise
    // the others do not, and would put a Rust command name back on screen.
    const messages = new Set<string>();
    for (const command of refusedCommands()) {
      const incognito = createIncognitoAdapter(recording());
      const error = (await incognito
        .invoke(command, {} as never)
        .catch((thrown: unknown) => thrown)) as PlatformError;
      messages.add(error.message);
      expect(
        (COMMAND_ALLOWLIST as readonly string[]).filter((name) => error.message.includes(name)),
        `the refusal for ${command} names a command`,
      ).toEqual([]);
    }
    expect(refusedCommands().length).toBeGreaterThan(15);
    expect(messages.size, 'one refusal sentence, not one per command').toBe(1);
    expect(
      [...messages].filter((message) => BLANKET_PROMISES.some((shape) => shape.test(message))),
    ).toEqual([]);
  });
});

describe('the debug log is disarmed on the way in', () => {
  it('turns off a log that was on, and says so', async () => {
    const adapter = new BrowserAdapter();
    await adapter.invoke('diagnostics_debug_log_set', { enabled: true });
    expect((await adapter.invoke('diagnostics_debug_log_get', {})).enabled).toBe(true);

    await expect(disarmDebugLogForIncognito(adapter)).resolves.toBe('turned-off');
    expect((await adapter.invoke('diagnostics_debug_log_get', {})).enabled).toBe(false);
  });

  it('says so when there was nothing to turn off', async () => {
    await expect(disarmDebugLogForIncognito(new BrowserAdapter())).resolves.toBe('was-off');
  });

  it('answers `failed` rather than rejecting when the host will not', async () => {
    // A rejection here would abort entering the mode, which leaves the user with
    // the recorder still running *and* no incognito. The caller's move is the
    // same either way: tell them.
    const adapter = new BrowserAdapter();
    vi.spyOn(adapter, 'invoke').mockRejectedValue(new PlatformError('INTERNAL', 'no'));
    await expect(disarmDebugLogForIncognito(adapter)).resolves.toBe('failed');
    vi.restoreAllMocks();
  });

  it('is refused by the wrapper, so incognito cannot arm the recorder', async () => {
    const incognito = createIncognitoAdapter(new BrowserAdapter());
    await expect(incognito.invoke('diagnostics_debug_log_set', { enabled: true })).rejects.toThrow(
      /incognito/i,
    );
  });
});
