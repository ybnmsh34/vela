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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * The first sentence this file exists to keep out of the refusal, kept verbatim.
 *
 * It was the shipped message until this pin was written. It is here so the word
 * list below is anchored on something that really was on screen: a list that
 * matched nothing would pass over any message at all, which is the vacuous-oracle
 * shape `refusedCommands()` was already caught in once.
 */
const WITHDRAWN_REFUSAL =
  'This window is in incognito, so nothing it does is written to this machine.';

/**
 * The second one, and the reason the first pin was not enough.
 *
 * `This window is in incognito, and that command would write to this machine`
 * makes no blanket promise — none of the four {@link MACHINE_PROMISES} shapes
 * matches it — and it is still false for two of the commands this file sweeps
 * it over.
 * `sandbox_report_document` is `writes` with an empty host body
 * (`pub fn report_document(&self, _request: SandboxReportDocumentReq) {}`), and
 * `sandbox_approve` is `writes` because an approval releases a command that
 * writes, not because approving writes. The wrapper refuses on the row, so it
 * cannot say what the call would have done.
 */
const WITHDRAWN_COUNTERFACTUAL =
  'This window is in incognito, and that command would write to this machine, so it was refused.';

/**
 * The third one, which was never on screen — it documented the code.
 *
 * `errors.ts`'s docblock on `INCOGNITO_REFUSED` said this until the round that
 * added the pin below, in the very file `incognito-adapter.ts` cites as the
 * source of the rule the shipped message had broken. It is the same
 * counterfactual, one level down: it names the code that is raised for
 * `sandbox_report_document` and `sandbox_approve` and asserts of both that a
 * durable write was going to happen.
 *
 * It is quoted **wrapped as it stood** — byte-identical to what
 * `git show 483875d:src/platform/errors.ts` holds, newline and comment marker
 * included — because the wrap is why it survived a sweep. The sentence breaks
 * between `would have` and `written`, so `grep -c 'would have written'` over
 * that file answers 0. {@link normalise} is what closes that, and
 * `is why the shapes are matched against normalised text` is the test that says
 * so.
 */
const WITHDRAWN_DOCBLOCK =
  'Renderer-only: the window is in incognito and this command would have\n' +
  '   * written something durable derived from the session.';

/**
 * Shapes that make a refusal claim something about the machine.
 *
 * The refusal is rendered verbatim by every failure surface in the application
 * — `use-memory.ts` sets `problem` from `toPlatformError(error).message`, and
 * use-projects and use-schedules do the same — so it is user-facing copy
 * whatever it was written as. Two states make a blanket promise false, and the
 * wrapper can see neither of them: `disarmDebugLogForIncognito` answering
 * `'failed'`, in which the host's provider debug log is still writing raw
 * prompts and answers to a file; and `project_delete`, which is `erases`, is
 * forwarded, and whose host body runs an `UPDATE` beside its `DELETE`.
 */
const MACHINE_PROMISES: readonly RegExp[] = [
  /nothing/i,
  /never/i,
  /no trace/i,
  /not (?:written|saved|kept|stored|recorded)/i,
];

/**
 * The other direction: saying what the refused command *would* have done.
 *
 * Claiming an effect the wrapper never observed, and that two `writes` rows do
 * not have. **These are the shapes that are not about copy.** A blanket promise
 * is wrong because a user reads it; a counterfactual is wrong because it is not
 * true of the rows the refusal fires on, and that is as wrong in a docblock as
 * in a sentence on screen. So {@link MACHINE_PROMISES} is swept over the
 * message only, and this list is swept over the message *and* over the
 * `INCOGNITO_REFUSED` docblock in `errors.ts`.
 */
const COUNTERFACTUALS: readonly RegExp[] = [
  /would (?:write|record|save|store|keep)/i,
  /would have (?:written|recorded|saved|stored|kept)/i,
];

/** What the shipped message may not say: either list. */
const BLANKET_PROMISES: readonly RegExp[] = [...MACHINE_PROMISES, ...COUNTERFACTUALS];

/**
 * Comment markers off, whitespace flattened.
 *
 * A sentence that wraps across two comment lines is one sentence to a reader and
 * two to a regular expression, and the withdrawn docblock escaped a sweep on
 * exactly that seam. Every match below is made against this, never against the
 * raw bytes.
 */
function normalise(text: string): string {
  return text
    .replace(/^[ \t]*\/?\*+\/?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One sentence per shape: the anchor, and what stops a shape going dead.
 *
 * Three of the six were really in this tree — two were the shipped refusal, and
 * the third documented the error code. **The other three have never been in this
 * repository** — `git log --all -S` on a distinctive phrase from each returns no
 * commit; they are written here, one per shape, only so that every shape has
 * something it alone catches. A list that matched nothing would pass over any
 * message at all, which is the vacuous-oracle shape `refusedCommands()` was
 * already caught in once, and until this list existed three of the shapes had no
 * specimen: deleting `/never/i` left this file green.
 */
const SPECIMENS: readonly (readonly [string, string])[] = [
  ['the first sentence the refusal replaced', WITHDRAWN_REFUSAL],
  ['the second one', WITHDRAWN_COUNTERFACTUAL],
  ['the docblock that documented this error code, wrapped as it stood', WITHDRAWN_DOCBLOCK],
  [
    'a sentence never shipped, for `/never/i`',
    'This window never keeps a record of what you type here.',
  ],
  ['a sentence never shipped, for `/no trace/i`', 'Your turns leave no trace on this machine.'],
  [
    'a sentence never shipped, for `/not (?:written|…)/i`',
    'Anything you send from this window is not saved on this machine.',
  ],
];

describe('the refusal is copy, and it promises only what this wrapper can keep', () => {
  it.each(SPECIMENS)('would have caught %s', (_name, specimen) => {
    // The anchor. Delete or misspell any shape and its specimen is left matched
    // by nothing, which reddens here by name.
    const caught = BLANKET_PROMISES.filter((shape) => shape.test(normalise(specimen))).map(String);
    expect(caught).toHaveLength(1);
  });

  it('leaves no shape without a specimen, and no specimen to two shapes', () => {
    // The other direction, so the list cannot grow a decorative shape nothing
    // exercises, and so "one per shape" above is a checked property rather than
    // a description of how the list happened to be written.
    expect(BLANKET_PROMISES).toHaveLength(SPECIMENS.length);
    const caught = BLANKET_PROMISES.map((shape) =>
      SPECIMENS.filter(([, specimen]) => shape.test(normalise(specimen))).map(([name]) => name),
    );
    expect(caught.map((names) => names.length)).toEqual(SPECIMENS.map(() => 1));
    expect(new Set(caught.flat()).size).toBe(SPECIMENS.length);
  });

  it('is why the shapes are matched against normalised text', () => {
    // The withdrawn docblock is the measurement: raw, it matches nothing,
    // because the phrase it is caught by breaks across two comment lines.
    expect(BLANKET_PROMISES.filter((shape) => shape.test(WITHDRAWN_DOCBLOCK))).toEqual([]);
    expect(
      BLANKET_PROMISES.filter((shape) => shape.test(normalise(WITHDRAWN_DOCBLOCK))).map(String),
    ).toEqual([String(/would have (?:written|recorded|saved|stored|kept)/i)]);
  });

  it('holds the docblock on the error code to the counterfactual shapes too', () => {
    // The rule is about what this wrapper is in a position to say, so the file
    // that documents the code obeys it as well. Found by symbol, not by line.
    const source = readFileSync(join(process.cwd(), 'src', 'platform', 'errors.ts'), 'utf8');
    const member = source.indexOf("  'INCOGNITO_REFUSED',");
    expect(member, 'errors.ts no longer declares the code where this pin looks').toBeGreaterThan(0);
    const preceding = source.slice(0, member);
    const opened = preceding.lastIndexOf('/**');
    expect(opened, 'the code is no longer preceded by a docblock').toBeGreaterThan(0);

    const docblock = normalise(preceding.slice(opened));
    // Not vacuous: an empty or truncated slice would pass any shape list.
    expect(docblock.length).toBeGreaterThan(400);
    expect(docblock).toMatch(/incognito/i);
    expect(docblock).toContain('COMMAND_DURABILITY');

    expect(
      COUNTERFACTUALS.filter((shape) => shape.test(docblock)).map(String),
      'the docblock may say the row was refused; it may not say what the call was going to do',
    ).toEqual([]);
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
    expect(error.message).not.toBe(WITHDRAWN_COUNTERFACTUAL);
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
