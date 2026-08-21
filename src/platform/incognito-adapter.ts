/**
 * INCOGNITO, ENFORCED AT THE SEAM RATHER THAN AT THE CALL SITES.
 *
 * ## Why this is an adapter and not a flag every writer checks
 *
 * The obvious incognito is a boolean the conversation surface reads before it
 * calls `store_append_message`. That guard asks "does the transcript writer
 * remember to check?", and the real question is "can anything in this renderer
 * write something durable while the user believes nothing is being written?"
 * Those are one notch apart, and the gap is every writer the author of the flag
 * did not think of — `store_autotitle_conversation`, which the conversations
 * repository calls on its own; `memory_add`, in another feature entirely;
 * `project_layout`, whose name says read and whose host body calls
 * `fs::create_dir_all`; and every command added after the flag was written.
 *
 * So the refusal lives on the one object every one of those goes through.
 * `PlatformAdapter.invoke` is the sole route from this renderer to the host
 * (`src/platform/adapter.ts`: nothing under `src/` may import `@tauri-apps/api`
 * except `tauri-adapter.ts`, and `adapter.test.ts` scans for a second importer).
 * A wrapper here cannot be gone around by a feature that did not know it exists.
 *
 * ## The rule, in one line
 *
 * **Read anything, erase anything, write nothing.**
 *
 * {@link COMMAND_DURABILITY} answers, for every command in the contract, which
 * of the three it is, and `command-durability.test.ts` holds every one of those
 * answers against the Rust body it was read off. Erasing is allowed because a deletion records nothing: a
 * user who opens their memory pane in incognito and deletes an entry has left
 * *less* behind, not more, and refusing it would be a privacy mode that stops
 * you removing things.
 *
 * **One `erases` row also modifies rows, and it is named here rather than left
 * to be found.** `project_delete` reaches
 * `vela-store/src/sqlite.rs`'s `delete_project_reassigning`, whose body runs
 * `UPDATE conversations SET project_id = ?2 WHERE project_id = ?1` in the same
 * transaction as its `DELETE FROM projects`. That is a change to rows that
 * already existed — the conversations are re-filed onto the sentinel default
 * project so none is left unfiled — and it records nothing about the session,
 * which is why the row stands. It is not nothing, though, so **no surface in
 * this feature may say that a window in incognito changes nothing on this
 * machine**: what it may say is that the commands whose job is to write
 * something down are refused. `command-durability.test.ts`'s erase-may-not-write check
 * reports any `erases` row in this position and demands the argument in `why`.
 *
 * ## Why the table is a total `Record`, and what that does NOT defend against
 *
 * A denylist defaults to *allow*, so a command added to `IpcContract` next month
 * ships as a leak until somebody remembers this file. `Record<CommandName, …>`
 * defaults to *nothing*: adding a command to the contract without adding a row
 * here does not compile. `incognito-adapter.test.ts` asserts the same thing at
 * runtime against `COMMAND_ALLOWLIST`, because `tsc` does not see `.mjs` and a
 * type is not a test.
 *
 * **That defends against omission, and omission is the easy half.** A missing
 * row does not compile; a *wrong* row compiles perfectly, and it is the wrong
 * row that leaks — a `writes` command quietly reclassified `no-write` is
 * forwarded to the host by a window telling the user nothing is being kept.
 * Measured, before there was anything to catch it: flipping `schedules_create`,
 * and then `secrets_set`, `ui_set_layout` and `sandbox_submit` together, left
 * the whole suite green.
 *
 * `command-durability.test.ts` is what closes that. Every row below carries a
 * cited chain of Rust symbols in `src-tauri/`; the test reads those files, finds
 * each `fn`, brace-matches its body, and fails if the quoted bytes are not in
 * it — then derives the durability from the kind of effect the terminal bytes
 * are, and compares that with this table. So the classification is checked
 * against the host rather than against a memory of the host. Read that file's
 * header for the bound: it holds a *reviewed path* to the bytes, and it does not
 * claim to have walked every call graph.
 *
 * ## What incognito does NOT reach, stated because a mode you can be wrong
 * about is worse than no mode
 *
 * 1. **The endpoint on the other end of `chat_send`.** The prompt leaves this
 *    machine. Whether the provider keeps it is the provider's business and
 *    nothing here can bind it. A local llama.cpp keeps nothing; a hosted API is
 *    a contract the user signed elsewhere.
 * 2. **A configured MCP server.** `mcp_list_tools` starts programs the user
 *    configured, and those programs write whatever they write. Blocking the
 *    command would not make the claim true — it would only remove the tools.
 * 3. **The operating system.** Swap, hibernation, crash dumps, a backup agent.
 * 4. **Anything written before the mode was entered.** Incognito is not a
 *    scrub.
 *
 * The panel says all four in the words a user reads. This comment and that copy
 * are the same statement; if one changes the other is wrong.
 *
 * ## The debug log, which is the one that would have made this a lie
 *
 * `diagnostics_debug_log_set` arms `vela_providers::debuglog`, and what that
 * records is the **raw upstream bytes** of every provider exchange — the prompt
 * and the answer — into a file under the app-data directory. It is host-side
 * and it is switched from here. An incognito that blocked `store_append_message`
 * and left that recorder running would write the whole conversation to disk in
 * plaintext while telling the user nothing was being kept.
 *
 * Two things follow, and both are here rather than in a comment somewhere:
 * `diagnostics_debug_log_set` is classified `writes`, so incognito cannot arm
 * it; and {@link disarmDebugLogForIncognito} turns it off on the way in.
 */

import type { EventContract, EventName, PlatformAdapter, Unsubscribe } from './adapter';
import { COMMAND_ALLOWLIST, type CommandName, type CommandReq, type CommandRes } from './contract';
import { PlatformError } from './errors';

/**
 * What one command leaves behind on **this machine**, durably.
 *
 * - `no-write` — nothing survives the process. A read, a cancel, an in-memory
 *   cache, or a request that leaves the machine entirely.
 * - `erases` — removes durable state and adds none.
 * - `writes` — creates or changes durable state. Refused in incognito.
 *
 * "On this machine" is load-bearing: `chat_send` is `no-write` here and still
 * sends the user's words to a server. See the header's list of what this mode
 * does not reach.
 */
export type CommandDurability = 'no-write' | 'erases' | 'writes';

/**
 * Every command in the contract, classified.
 *
 * **Classified from the host body, not from the name — and held there.** That
 * sentence used to be a promise about how the table was written, which is a
 * promise about the day of the commit and nothing after it.
 * `command-durability.test.ts` makes it a property of the tree: each row cites
 * the file and symbol its classification came from, and the citation is checked
 * against the bytes on every run.
 *
 * Three of these read as reads and are not:
 *
 * - `project_layout` and `project_reconcile_skills` both resolve to
 *   `ipc::project::layout`, which calls `resolve_layout` in
 *   `vela-projects/src/layout.rs` — `fs::create_dir_all` on the workspace and
 *   the skills mount, then `reconcile_skills`, which creates and removes links.
 *   A "layout" query materialises a directory tree.
 * - `diagnostics_debug_log_set` reads as a preference and arms a file sink that
 *   records raw provider traffic.
 * - `sandbox_approve` reads as an acknowledgement and is what lets a submitted
 *   command actually run in the project's workspace.
 *
 * `models_probe` is the mirror image: it looks like a write and is not. Its host
 * body puts the result in `CapabilityCache`, which is Tauri `State` and dies
 * with the process.
 */
export const COMMAND_DURABILITY: Readonly<Record<CommandName, CommandDurability>> = Object.freeze({
  app_info: 'no-write',
  chat_cancel: 'no-write',
  /* Leaves the machine; writes nothing on it. See the header's limit 1. */
  chat_send: 'no-write',
  diagnostics_debug_log_get: 'no-write',
  /* Arms a recorder of raw provider bodies. See the header. */
  diagnostics_debug_log_set: 'writes',
  diagnostics_echo: 'no-write',
  /* `EndpointControl` is Tauri `State`; enabling starts a listener, not a file. */
  endpoint_disable: 'no-write',
  endpoint_enable: 'no-write',
  endpoint_status: 'no-write',
  /* Starts the user's own configured programs. See the header's limit 2. */
  mcp_list_tools: 'no-write',
  memory_add: 'writes',
  memory_clear_scope: 'erases',
  memory_delete: 'erases',
  memory_list: 'no-write',
  memory_update: 'writes',
  models_capabilities: 'no-write',
  models_list: 'no-write',
  models_probe: 'no-write',
  project_create: 'writes',
  project_delete: 'erases',
  project_get: 'no-write',
  project_layout: 'writes',
  project_list: 'no-write',
  project_move_conversation: 'writes',
  project_reconcile_skills: 'writes',
  project_update: 'writes',
  sandbox_approve: 'writes',
  sandbox_cancel: 'no-write',
  sandbox_policy: 'no-write',
  sandbox_release: 'no-write',
  sandbox_report_document: 'writes',
  sandbox_submit: 'writes',
  schedules_create: 'writes',
  schedules_delete: 'erases',
  schedules_list: 'no-write',
  schedules_list_runs: 'no-write',
  schedules_set_enabled: 'writes',
  secrets_delete: 'erases',
  secrets_set: 'writes',
  /* Asks the keychain whether a key is there. Answers a boolean, stores none. */
  secrets_status: 'no-write',
  settings_delete_provider: 'erases',
  settings_get: 'no-write',
  settings_put_provider: 'writes',
  settings_set_theme: 'writes',
  skills_list: 'no-write',
  skills_read: 'no-write',
  store_append_message: 'writes',
  store_autotitle_conversation: 'writes',
  store_create_conversation: 'writes',
  store_delete_conversation: 'erases',
  store_delete_message: 'erases',
  store_list_conversations: 'no-write',
  store_list_messages: 'no-write',
  store_rename_conversation: 'writes',
  store_search: 'no-write',
  store_update_message: 'writes',
  ui_get_layout: 'no-write',
  ui_set_layout: 'writes',
});

/** Whether incognito refuses this command. */
export function isRefusedInIncognito(command: CommandName): boolean {
  return COMMAND_DURABILITY[command] === 'writes';
}

/**
 * The commands incognito refuses, sorted, for a surface that wants to show the
 * user what the mode actually stops.
 *
 * Derived from the table rather than restated, so the list a user reads and the
 * behaviour they get cannot disagree.
 */
export function refusedCommands(): readonly CommandName[] {
  return COMMAND_ALLOWLIST.filter(isRefusedInIncognito);
}

/**
 * Turn the host's debug log off, if it is on.
 *
 * Called on the way *into* incognito, on the **unwrapped** adapter — the
 * wrapped one would refuse it, since arming and disarming are the same command.
 *
 * **It does not turn the log back on when the user leaves**, and that is a
 * decision rather than an omission. The host's own header says the log "does not
 * persist. Each launch starts with the log off … Turning it on is a thing you do
 * to the run you are debugging." Re-arming a recorder of raw provider traffic
 * without the user asking again is the wrong direction to be wrong in, and the
 * mode has no business restoring a state the next launch would have cleared
 * anyway. The panel says the log was turned off; nothing says it will come back.
 *
 * Answers what it did so the caller can say so. A failure resolves `'failed'`
 * rather than rejecting: the caller's next move is the same either way — tell
 * the user — and a rejection here would abort entering the mode, which leaves
 * the user with the recorder still running and no incognito.
 */
export type DebugLogDisarm = 'was-off' | 'turned-off' | 'failed';

export async function disarmDebugLogForIncognito(
  adapter: PlatformAdapter,
): Promise<DebugLogDisarm> {
  try {
    const status = await adapter.invoke('diagnostics_debug_log_get', {});
    if (!status.enabled) return 'was-off';
    const after = await adapter.invoke('diagnostics_debug_log_set', { enabled: false });
    return after.enabled ? 'failed' : 'turned-off';
  } catch {
    return 'failed';
  }
}

/**
 * An adapter that refuses every durable write.
 *
 * `kind`, `window` and `listen` pass straight through. The window controls
 * write nothing, and a subscription is a read: refusing `listen` would stop the
 * user seeing their own answer stream.
 *
 * The refusal is a rejected promise rather than a silent no-op. A no-op would
 * hand every caller a resolved value it did not get and put this mode in the
 * silent-reduction class conventions §9 forbids — the caller believes it wrote
 * and the user believes it saved. A `PlatformError` with a distinct code is
 * something a surface can catch and word.
 *
 * ## The message is the one a user reads, and it names no command
 *
 * It used to be `` `store_create_conversation` writes to this machine and the
 * window is in incognito ``, which is what the sidebar painted when a user
 * pressed **New conversation** in the mode. `errors.ts` had already written the
 * rule this broke, on `PlatformError.command`: "The command that failed, for
 * logging. Never included in user-facing copy." Every surface that shows a
 * failure — `MemoryPanel`, `ProjectPanel`, `SchedulesPanel`, the sidebar —
 * renders `PlatformError.message` verbatim, so this string is user-facing copy
 * whether it was written as such or not.
 *
 * The command name is still on the error, where a log or a test can read it;
 * `incognito-adapter.test.ts` asserts it. What changed is that it is no longer
 * in the sentence.
 *
 * ## …and it promises nothing about the machine, because it cannot keep one
 *
 * Two sentences have been withdrawn from this string, and the second one is why
 * the first fix was not enough.
 *
 * **Withdrawn once:** `This window is in incognito, so nothing it does is
 * written to this machine.` — the defect the same commit had just removed from
 * `StylePanel.tsx`, reintroduced one file along in the copy that *every* failure
 * surface renders verbatim. It is false twice over:
 *
 * 1. When {@link disarmDebugLogForIncognito} answers `'failed'`, the host's
 *    provider debug log is still recording raw prompts and answers to a file.
 *    The band in `AppShell.tsx` says so, in `BAND.failed`; a refusal saying
 *    the opposite, in the same window at the same moment, is the mode being
 *    wrong about itself.
 * 2. Even with the log off, `project_delete` is `erases`, is forwarded, and its
 *    host body runs an `UPDATE`. See the header.
 *
 * **Withdrawn again:** `This window is in incognito, and that command would
 * write to this machine, so it was refused.` — narrower, and still not
 * something this function is in a position to say. The refusal fires on the
 * command's **row**, and two rows are `writes` by decision rather than by an
 * observed effect. `sandbox_report_document`'s host body is
 * `pub fn report_document(&self, _request: SandboxReportDocumentReq) {}` in
 * `src-tauri/crates/vela-sandbox/src/host.rs` — empty — and its row in
 * `command-durability.test.ts` says so: "There is therefore no durable effect to
 * cite, and the row is `writes` by decision". `sandbox_approve`'s row says "An
 * approval is not itself a write". Both are refused, and for both that sentence
 * asserted a write that was not going to happen. The sweep
 * `says the same thing for every command it refuses` quantifies the string over
 * exactly that set, so the falsehood was enumerated by this file's own test the
 * day it was written.
 *
 * So the message states **what happened to the command that was refused** and
 * makes no claim about the machine at all. That is the only claim this function
 * is in a position to make: it knows the command's row and it knows it did not
 * forward it, and it knows nothing about the debug log, about what an allowed
 * command is doing, or about what the refused one would have done had it gone
 * through. `incognito-adapter.test.ts` pins it — the oracle is anchored on both
 * withdrawn sentences, so an empty word list cannot pass — and
 * `instructions-and-incognito.test.tsx` provokes the refusal with the band in
 * its `failed` state and fails if the two contradict each other.
 */
export function createIncognitoAdapter(adapter: PlatformAdapter): PlatformAdapter {
  return {
    kind: adapter.kind,
    window: adapter.window,
    async invoke<C extends CommandName>(command: C, payload: CommandReq<C>): Promise<CommandRes<C>> {
      if (isRefusedInIncognito(command)) {
        throw new PlatformError(
          'INCOGNITO_REFUSED',
          'This window is in incognito, so that command was refused rather than carried out.',
          command,
        );
      }
      return adapter.invoke(command, payload);
    },
    listen<E extends EventName>(
      event: E,
      handler: (payload: EventContract[E]) => void,
    ): Promise<Unsubscribe> {
      return adapter.listen(event, handler);
    },
  };
}
