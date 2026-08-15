# Audit — Agentic runtime and tool execution

Scope: `src/runtime/` (`live-runs.ts`, `harness-runtime.ts`, `agent-loop-harness.ts`,
`subagent-toolkit.ts`, `content-part-codec.ts`, `app-runtime.ts`, `harness-registry.ts`,
`project-context.ts`) and its wiring through `src/app/App.tsx` into
`src/features/conversation/use-conversation.ts`.

Worktree `C:\Users\User\vela-tmp`, branch `claude/new-session-tgl1ut`, HEAD `a1fa55e`.

Method: every claim graded `test-bites` below was established by editing the shipped
implementation, running the targeted vitest file, watching a named test fail, and reverting
with `git checkout --` in the same shell command's `finally` block. Every mutation run below
printed `REVERTED-n: 0 chars`, i.e. `git status --porcelain <file>` came back empty. At the
end of the session `git status --porcelain src/runtime src/features/conversation src/app`
was empty. (Other files in the tree were dirty from the other eleven auditors —
`src/components/ModalSurface.tsx`, `src/platform/chat-contract-parity.test.ts`,
`src/styles/zz-audit-leak.css`, `src-tauri/crates/vela-providers/src/redact.rs`,
`src-tauri/crates/vela-store/src/sqlite.rs`. None of those is mine and none was touched.)

---

## 1. Reachability — the thing this track was FAILed for once

The trace, followed by hand:

```
src/main.tsx
  → src/app/App.tsx:119   const runtime = useMemo(() => createAgentRuntime(adapter), [adapter])
  → src/app/App.tsx:174   <ConversationSurface … runtime={runtime} />
  → src/features/conversation/ConversationSurface.tsx:126  useConversation({ …, runtime })
  → src/features/conversation/use-conversation.ts:610      agentAvailable = runtime !== null && conversationId !== null && capabilities.toolCalls
  → src/features/conversation/use-conversation.ts:1010     agent = { available, enabled, setEnabled }
  → src/features/conversation/ConversationView.tsx:150     agent={conversation.agent}
  → src/features/conversation/Composer.tsx:187             agent.available ? <button data-testid="composer-agent-toggle"> : null
  → src/features/conversation/use-conversation.ts:834      const begin = agentOn ? startRun : start
  → src/features/conversation/use-conversation.ts:731      runtime.runs.start({ … tools: [subagentToolDefinition] … })
```

`createAgentRuntime` (`src/runtime/app-runtime.ts:61`) supplies the real host: `createTurnDriver(adapter)`,
`createTranscriptRepository(adapter)`, and a subagent toolkit whose `newConversationId` calls
`adapter.invoke('store_create_conversation', …)`.

Two mutations, both watched.

**M5b — make the toggle decorative.** `const begin = agentOn ? startRun : start;` → `const begin = start;`
(both occurrences: `send` at :834 and `retry` at :935).

```
=== M5b agent toggle decorative (send/retry always take the plain path) ===
   × the agent runtime is reachable from the app > runs the turn through the live-run directory, which writes the row as it goes 1356ms
   × an agent run that never starts says which of the two reasons it was > says no harness in this build can run against this model 112ms
   … 14 more …
 Test Files  2 failed (2)
      Tests  16 failed | 8 passed (24)
REVERTED-5b: 0 chars dirty
```

The first of those is in `src/app/composition-root.test.tsx`, which renders the real `<App />`
against `BrowserAdapter` and clicks the real toggle. So the wiring is held by a test that
drives the assembled application, not only by a unit test. VERIFIED-BY-FAKE: the host underneath
is `BrowserAdapter`, an in-memory echo.

**M5a — remove the capability conjunct.** `…&& capabilities.toolCalls` deleted.

```
=== M5a toolCalls gate removed (toggle offered on any model) ===
   × the agent runtime is reachable from the app > offers no agent control on a model that cannot request a tool 312ms
      Tests  1 failed | 8 passed (9)
REVERTED-5a: 0 chars dirty
```

Both directions of the gate bite.

### Is the `toolCalls` gate honest, or a path that cannot execute?

Honest. `BrowserAdapter.#modelsProbe` (`src/platform/browser-adapter.ts:1263`) deliberately reports
only `streaming: true` — "Probing the fake establishes only what the fake can honestly demonstrate".
`toolCalls` is reachable there only through `seedCapabilities`, an explicit test hook that is
unreachable from `invoke`. But the shipped Windows build runs on the Tauri adapter, and the host's
report is built in `src-tauri/crates/vela-providers/src/capability.rs:191` —
`tool_calls: self.tool_calling.is_offerable()` — serialised camelCase by `src-tauri/src/ipc/models.rs`.
So on a probed tool-calling endpoint the toggle appears in the product. The gate is the same shape as
the attach-image button's `vision` gate, and the pessimistic floor (`NO_CAPABILITIES`, everything
false) is what an unprobed endpoint sees.

The honest caveat: **in `pnpm dev` in a browser the agent toggle can never appear.** That is by
design and is what `composition-root.test.tsx:307` asserts, but it means no human has ever clicked
this control outside a packaged Tauri build. I did not launch the app (not my brief), so I did not
observe the toggle on real hardware.

**M14 — the structural guard.** Wrote a new, unimported `src/runtime/orphan-probe.ts` (no tracked
file touched) and ran `reachable.test.ts`:

```
   × the agentic runtime is wired into the product > reaches every shipping module in src/runtime from src/main.tsx
     → …: expected [ 'src/runtime/orphan-probe.ts' ] to deeply equal []
      Tests  1 failed | 3 passed (4)
REMOVED: False
```

The guard bites on a real orphan, not only on a synthetic sample.

---

## 2. Sequencing — where the brief said the real risk is

All against `src/runtime/live-runs.test.ts` (21 tests, baseline green in 17 ms).

**M1 — `runStarted` is not seq 0.** `nextSeq: 0,` → `nextSeq: 1,`.

```
 ❯ src/runtime/live-runs.test.ts (21 tests | 8 failed)
   × sequencing > numbers events densely from zero, so runStarted is seq 0
   × sequencing > numbers nothing after the terminal event
   × late join > replays from a seq and then delivers live, with no gap and no duplicate
   × late join > delivers the replay before subscribe returns
   × late join > replays nothing from a seq past the end, and says so with replayedFrom
   × late join > gives every subscriber its own replay
   × late join > unsubscribes one subscription without touching another that shares a listener
   × late join > retains at least RUN_BUFFER_MIN_EVENTS and reports the truncation
      Tests  8 failed | 13 passed (21)
```

**M11 — number events after the terminal event.** `if (record.terminal) return;` → `if (false) return;`
→ `× sequencing > numbers nothing after the terminal event`, 1 failed / 20 passed.

**M2a — open a gap in the replay.** `Math.max(asked, retainedFrom(record))` → `Math.max(asked + 1, …)`
→ 3 failed / 18 passed, including `replays from a seq and then delivers live, with no gap and no duplicate`.

**M2b — register the listener before replaying.** Moved `record.subscribers.add(subscriber)` above the
replay loop.

```
=== M2b subscriber-registered-before-replay mutant ===
   × late join > never interleaves a live event into a replay that is still in flight 6ms
      Tests  1 failed | 20 passed (21)
```

Exactly one test catches it, and it is the one whose comment says it was written because
"registering the subscriber *before* replaying passes the whole suite". That comment is accurate,
and the test earns its place: without it this ordering is unheld.

**M3a — build the services bundle before the rejection checks.** Moved `const bundle = services(request);`
above `if (records.has(request.runId))` → `× admission > a rejected request builds neither a bundle nor a harness`,
1 failed / 20 passed.

**M3b — insert the record before `definition.create`.** Moved `records.set(request.runId, record)` above
`const harness = definition.create(bundle)` → `× admission > leaves no record behind when a harness throws
out of create or start`, 1 failed / 20 passed. This is the defect the file's own comment describes
(a run stuck `running` with no controller, poisoning `conversationBusy` for the rest of the session).
It is guarded.

**M10 — retain less than the documented floor.** Compaction target `RUN_BUFFER_MIN_EVENTS` →
`Math.floor(RUN_BUFFER_MIN_EVENTS / 2)` → `× late join > retains at least RUN_BUFFER_MIN_EVENTS and reports
the truncation`, 1 failed / 20 passed.

Every sequencing rule the brief named is real, implemented in the directory rather than in a harness,
and held by a test that bites.

### But the late-join machinery has no consumer

`git grep forConversation -- src/` returns only `src/platform/contract-harness.ts` (the declaration)
and `src/runtime/live-runs.ts` (the implementation). Same for `runs.list()` and `RunHandle.snapshot()`:
no shipping module under `src/features`, `src/app`, `src/components` or `src/state` calls any of them.

`use-conversation.ts:768` subscribes with `{ fromSeq: 0 }` on the line after `start` returns. That is
the only subscribe in the product. The replay path is therefore exercised in production only for the
degenerate case the comment names — a harness that failed before `subscribe` ran — never for an
actual late join.

The user-visible consequence is not hypothetical, and the repo documents it as intended
(`src/features/conversation/agent-run.test.tsx:205`, "says the conversation is busy when a run outlived
the mount that started it"):

- `App.tsx:165` remounts `ConversationSurface` on `key={conversationId}`.
- `use-conversation.ts:288` unmount cleanup unsubscribes the tail and **does not cancel the run**.
- Nothing on mount asks `forConversation`, so the tail is never re-attached.
- `stop()` (`:849`) reads `activeRun.current`, which is `null` after the remount, so the stop button
  cannot reach the orphan — and `streaming` is `false`, so the composer shows Send, not Stop.
- Sending again is rejected `conversationBusy` and drawn as `RUN_BUSY` — "Another run is already going
  in this conversation."
- `DEFAULT_RUN_LIMITS.wallClockMs` is `10 * 60 * 1000`. So switching conversation mid-run and coming
  back locks that conversation for up to ten minutes with no cancel affordance.

I did not reproduce this on hardware (I am not authorised to launch the app); it is read off the code
and off a test that asserts the rejection half of it.

---

## 3. The agent loop

**M15 — open the turn row with no parts.** `EMPTY_TURN_PARTS` → `[]`.

```
   × the runtime over the real adapter > runs a turn end to end and leaves the answer in the store 20ms
   × the runtime over the real adapter > closes the row out as cancelled when a run is cancelled mid-turn 79ms
   × durability and cancellation > writes the transcript as the run goes, not at the end 8ms
      Tests  3 failed | 24 passed (27)
```

The file's header says only `adapter-integration.test.ts` found this, because "they all use a transcript
double that accepts anything". That is now out of date in the good direction: `agent-loop-harness.test.ts`
catches it too.

**M6 — count `maxToolCalls` per turn instead of per run.**
`maxToolCalls - this.toolCallsUsed` → `maxToolCalls` → `× limits > stops at maxToolCalls, counting across
the whole run`, 1 failed / 24 passed.

**M7 — stop checking the wall clock mid-stream.** Deleted the elapsed check inside `consumeTurn` →
`× limits > stops on the wall clock, measured on the injected now() 5016ms` (the test times out rather
than asserting, but it bites), 1 failed / 24 passed.

**M18 — dispatch tool calls sequentially.** Replaced `Promise.allSettled(calls.map(…))` with an awaited
`for` loop.

```
   × tools > runs one turn’s calls concurrently, and reports them in call order 88ms
   × two subagents are two runs > has three runs live in the directory at the same instant 138ms
   × two subagents are two runs > gives each child its own conversation, so neither is rejected as busy 128ms
   × two subagents are two runs > feeds each child's answer back as the tool result that called it 5013ms
   … 6 more …
```

The "real parallel subagents" claim rests on this one line and the tests hold it hard.

### The one loop claim nothing holds: `toolCallStarted`

The header of `agent-loop-harness.ts` says:

> `toolCallStarted` is emitted for every admitted call in call order before any of them is dispatched,
> and `toolCallFinished` in the same order once all have settled.

**M16 — emit `toolCallStarted` in reverse call order.** `for (const call of calls)` →
`for (const call of [...calls].reverse())`:

```
      Tests  25 passed (25)
```

**M17 — emit `toolCallStarted` only after every call has settled.** Moved the emit loop below
`Promise.allSettled`:

```
 Test Files  3 passed (3)
      Tests  42 passed (42)
```

(`agent-loop-harness.test.ts` + `subagent-toolkit.test.ts` + `run-capabilities.test.ts`.)

So neither the order nor the timing of `toolCallStarted` is held by anything. Reading
`agent-loop-harness.test.ts:588` confirms why: it asserts the `inFlight` dispatch order and the
`toolCallFinished` callId order, and never looks at `toolCallStarted`.

This matters less than it would, because **no surface consumes the event either.** The listener in
`use-conversation.ts:769` handles exactly two arms:

```ts
if (event.type === 'chat') { … }
if (event.type !== 'runFinished') return;
```

`turnStarted`, `contextLoaded`, `toolCallStarted`, `toolCallFinished` and `degraded` are all dropped
on the floor.

### Degradations are computed and shown to nobody

Four degradations exist — `stepLimitReached`, `toolCallLimitReached`, `wallClockLimitReached`,
`contextUnavailable` — each emitted by the loop, each accumulated into `RunRecord.degradations`, each
exposed on `RunSnapshot.degradations`. `settleRun` (`use-conversation.ts:499`) folds the outcome into
`phase: 'complete' | 'stopped' | 'failed'` and reads nothing else. `snapshot()` has no caller. So a run
that hit its 12-step ceiling, spent its 32-call budget, ran out of its 10-minute clock, or ran without
material the caller named, is drawn identically to one that finished because the model stopped talking.

`agent-loop-harness.ts:311` cites conventions §9 ("a run that quietly ran with less than it was asked
to is the silent reduction conventions §9 forbids") as the reason the *event* is emitted. The event is
emitted. Nothing renders it, so the reduction is still silent to the user.

---

## 4. Subagents

**M8 — remove the depth refusal**, leaving only the tool-stripping mechanism →
`× the depth ceiling > refuses a call that arrives anyway, with an error result rather than a rejection`,
1 failed / 10 passed. Both mechanisms are separately held.

**M12 — stop propagating the parent's abort to a running child.** Deleted
`else signal.addEventListener('abort', onAbort, { once: true });` →
`× cancellation reaches down > cancels every child when the parent's run is cancelled 5050ms`,
1 failed / 10 passed.

What is **not** established: no test anywhere drives `spawn_subagent` through the real composition
root. `BrowserAdapter.#chatSend` always answers `toolCalls: []` (`src/platform/browser-adapter.ts:1403`),
so the fake host cannot produce a tool call; `composition-root.test.tsx` renders the real `<App />`
and therefore does execute `createAgentRuntime`, but the echo provider never asks for a tool. Every
subagent test substitutes a scripted `TurnDriver`. So `app-runtime.ts`'s `newConversationId` —
the `store_create_conversation` call that gives a child somewhere to write, and the "Subagent N"
conversation the user would see in the sidebar — has never been executed by any test or by me.
Its correctness is inspection-only.

---

## 5. Context resolution and project scope

**M4a — drop the foreign-ref refusal.** Deleted `if (ref.id !== instructionsRefId(projectId)) return null;`
from `project-context.ts` → `× the project instructions resolver > refuses a ref indexed against another
project, rather than guessing`, 1 failed / 8 passed. The resolver half of the cross-project rule bites.

**M4b — collapse the `contextFor` memo across projects.** In `harness-runtime.ts`,
`const existing = resolvers.get(projectId);` → `const existing = [...resolvers.values()][0];`, so
`contextFor(B)` hands back the resolver built for A:

```
      Tests  33 passed (33)
```

(`project-context.test.ts` + `harness-registry.test.ts` + `no-harness-leak.test.ts`.) Nothing holds
that the memo is keyed by project. The implementation is literally `resolvers.get(projectId)` and is
correct; the tests do not hold it because every equivalence assertion in `project-context.test.ts`
uses `DEFAULT_PROJECT_ID` only, and the one test that touches two projects (`hands back a reader
without reading anything itself`) counts reads rather than comparing refs.

Today this cannot bite a user: `App.tsx:123` passes the constant `DEFAULT_PROJECT_ID`, and
`app-runtime.ts:83` sets `readProjectInstructions: () => Promise.resolve(null)` for every project, so
the resolver indexes nothing at all. It is a latent hole that opens the day projects get a real
selector and a real reader.

---

## 6. Codec and the structural scans

**M9 — make the image branch the cast the header warns about.** Returned `part as unknown as ContentPartInput`
for images instead of base64-encoding:

```
   × the image branch … > converts a byte array to standard base64 and keeps the mime type 18ms
   × the image branch … > agrees with the one encoder the renderer ships 19ms
   × the image branch … > carries an image through a whole turn, in order, beside the parts it did not convert 3ms
   × the image branch … > does not copy the bytes back out of the input part 3ms
   × the image branch … > leaves an empty image as an empty string rather than refusing it 2ms
      Tests  5 failed | 2 passed (7)
```

**M13 — make a real surface branch on a harness id.** Added
`const MUTANT_BRANCH = (id: string): boolean => id === 'agent-loop';` to
`src/features/conversation/use-conversation.ts` (a shipping file, not a synthetic sample) →
`× no surface branches on a harness id > never writes a registered id as a literal outside the definitions`,
1 failed / 10 passed. The scan bites on the real tree, not only on its own control fixture.

---

## 7. Things I could not establish

- **Anything on real hardware.** I did not launch the app and did not touch the llama.cpp server on
  127.0.0.1:8033 — neither is in my brief. Every grade here is VERIFIED-BY-FAKE (jsdom +
  `BrowserAdapter`) or read off the source. In particular I never saw the agent toggle rendered, never
  saw a real model emit a `spawn_subagent` call, and never saw a subagent conversation appear.
- **Whether a real endpoint's probe sets `toolCalls: true` in practice.** I read the Rust
  (`capability.rs:191`) and took the session's prior finding — that the probe was under-reporting
  because of a 64-token output cap and has been fixed — as given.
- **The retry-with-agent path end to end.** `retry` at `:935` routes to `startRun`, and M5b failed the
  three `retrying an agent turn replaces the rows the run wrote` tests, so it is wired; I did not
  mutate anything inside the retry-specific deletion/rewrite ordering.
- **`turnStarted` / `RunStatus.step`.** `advance()` folds `turnStarted` into `status.step`, and
  `list()`/`snapshot()` are the only readers of `status` — both uncalled by the product. I did not
  grade the fold separately because nothing consumes its output.
- **Whether the ten-minute lockout actually happens in the product.** The mechanism is traced and one
  half of it (the `conversationBusy` refusal after a remount) is asserted by a test; the other half
  (that no cancel affordance exists after the remount) is inspection-only.
