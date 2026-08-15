# Audit — Conversation surface

Auditor: independent domain audit, Vela full sweep.
Worktree: `C:\Users\User\vela-tmp`, branch `claude/new-session-tgl1ut`, HEAD `a1fa55e`.
Scope: `src/features/conversation/`, `src/data/chat-repository.ts`, `src-tauri/src/ipc/chat.rs`,
plus whatever those reach (`src/platform/contract.ts`, `src-tauri/crates/vela-providers/src/{diagnostic,model,error,stream}.rs`,
`src/app/App.tsx`).

Everything below was established in this session. No tracked file was left modified; every
mutation was applied, run, and reverted inside a single shell call, and `git status` was checked
after each. Two throwaway probe test files were created under `src/features/conversation/`,
run once, and deleted in the same call.

---

## 0. Method, and one thing that cost twenty minutes

The repo's working tree on Windows checks out **CRLF**. My first mutation harness matched zero
anchors and reported it honestly rather than silently no-opping, which is the only reason I
noticed:

```
$ node -e "... console.log('idx', i, JSON.stringify(s.slice(i-12,i+70)))"
idx 7024 "g.\r\n        phase: event.error.kind === 'cancelled' ? 'stopped' : 'failed',\r\n     "
count 0
```

`grep -n … | cat -A` had shown `$` with no `^M`, so the line endings are invisible from the
obvious check. The harness now normalises the anchor to the file's own endings. Recording this
because it is the same class of thing the lead's six Windows-only defects came from, and a
mutation harness that silently matched nothing would have produced a page of confident PASSes
with no evidence behind any of them.

Baseline, before any mutation:

```
$ pnpm exec vitest run src/features/conversation src/data/chat-repository
 Test Files  17 passed (17)
      Tests  239 passed (239)
   Duration  16.17s
```

Same command after every mutation was reverted: `17 passed (17) / 239 passed (239)`.

---

## 1. Shipping — does any of this reach a user?

`ConversationSurface` is mounted at `src/app/App.tsx:164` inside `Transcript`, keyed on
`conversationId`, fed `providerId`/`modelId`/`modelLabel`/`capabilities`/`attachments`/
`contextWindowTokens`/`runtime` from `useSelectedModel()` and `useNavigationStore`. That is a
real composition root, not a test. `ConversationView` renders `EmptyConversation`, the
transcript (`UserTurn`/`AssistantTurn`) and `Composer`; `AssistantTurn` renders `ThinkingBlock`,
`Markdown`, `ToolCalls`, `DegradationNotes`, the refusal box, the error box, `CopyButton` and the
usage line. The host side is `chat_send` / `chat_cancel` in `src-tauri/src/ipc/chat.rs`, both
`#[tauri::command]`.

So the domain ships. The interesting question is which *parts* of it do, and three of them
do not — see §5.

---

## 2. What bites — mutations applied and the tests that caught them

Each row: I broke the implementation, ran the targeted suites, and recorded the exact test that
went red. All reverted.

### M1 — cancellation stops reading as "you stopped this"

`turn-stream.ts`, `case 'error'`: `phase: event.error.kind === 'cancelled' ? 'stopped' : 'failed'`
→ `phase: 'failed'`.

```
 × the turn reducer > treats cancellation as stopped, not failed, from either signal
 × the conversation surface: failure and cancellation > cancels on Escape and reads the result as stopped, not failed
      Tests  2 failed | 44 passed (46)
```

### M2 — the reasoning-markup guard made a pass-through

`reasoning-guard.ts`, first line of `guardDelta` → `return { state, answer: chunk, reasoning: '' };`.

```
      Tests  13 failed | 50 passed (63)
FAIL ConversationSurface.test.tsx > never leaks reasoning markup into the answer, even split across frames
FAIL ConversationSurface.test.tsx > keeps an unterminated thinking block open and says why
FAIL reasoning-guard.test.ts > (10 rules)
FAIL turn-stream.test.ts > strips reasoning markup that reaches the answer channel anyway
FAIL turn-stream.test.ts > marks an unterminated block and keeps its text visible
```

Both the unit rules *and* the rendered surface catch it. This is the one defence in the domain
that is genuinely belt-and-braces (the host splits reasoning too), and the renderer half is real.

### M3 — retry appends instead of replacing

`use-conversation.ts`, `retry`: `begin(current.slice(0, current.indexOf(lastUser)), …)` → `begin(current, …)`.

```
FAIL ConversationSurface.test.tsx > re-sends the last message on retry, without duplicating it
```

(In a three-file parallel run this also produced a cascade of agent-run failures that did not
reproduce in isolation — see §6 on flakiness. Run alone, the mutation produces exactly the one
expected failure.)

### M4 + M5 — restore claims, and the unreadable transcript

Two anchors in `use-conversation.ts`: dropping `claimed.current.add(entry.id)` from the restore
loop, and `setUnreadable(true)` → `setUnreadable(false)`.

```
 × a conversation is written as it happens > says the transcript is unreadable rather than showing it as empty
 × a conversation is written as it happens > does not write the transcript it just read back to the store
      Tests  2 failed | 3 passed (5)
```

### M6 — the first token loses its synchronous commit

`onEvent`: `if (isFirst() || isTerminalEvent(event))` → `if (isTerminalEvent(event))`.

```
FAIL ConversationSurface.test.tsx > commits the first token immediately and batches the rest
      Tests  1 failed | 29 passed (30)
```

One test, precisely. The "time-to-first-token pays no scheduling tax" claim in the file header
is backed.

### M7 — retry stops deleting the store rows it replaces

`await transcript.remove(messageId);` → `void messageId;`.

```
FAIL use-conversation-record.test.tsx > replaces what retry replaces, instead of recording it twice
      Tests  1 failed | 19 passed (20)
```

### M8 — reasoning replayed back to the endpoint

`historyMessages`: `text: entry.turn.answer` → `text: entry.turn.reasoning + entry.turn.answer`.

```
FAIL ConversationSurface.test.tsx > sends the prior turns, and never sends reasoning back
FAIL ConversationSurface.test.tsx > reports exactly the messages chat_send will carry — reasoning excluded
```

Both halves — what is sent, and what the context meter is told is being sent — go red together,
which is the point of the shared traversal.

### M9 — the refusal box removed

`MessageTurn.tsx`: `{turn.refusal === null ? null : (` → `{true ? null : (`.

```
FAIL ConversationSurface.test.tsx > reports a turn the host refused as Vela's own fault, not the endpoint's
      Tests  1 failed | 44 passed (45)
```

Note what did **not** go red: all fifteen `agent-run.test.tsx` tests passed with the refusal box
deleted, because they assert `reply(result.current).turn.refusal` — hook state — and never touch
the DOM. The agent path's failure *sentences* are pinned; the agent path's failure *rendering* is
covered only transitively, by the one plain-path test above.

### M10 + M11 — stop made a no-op; a restored streaming row left streaming

`stop` gains an early `return`; `stored-entries.ts` `phaseOf` returns `'streaming'` instead of `'stopped'`.

```
FAIL ConversationSurface.test.tsx > cancels on Escape and reads the result as stopped, not failed
FAIL ConversationSurface.test.tsx > cancels from the Stop button too
FAIL stored-entries.test.ts > never comes back with a spinner that cannot resolve
      Tests  3 failed | 50 passed (53)
```

### M12 — markdown text spans injected as HTML

`Markdown.tsx` `case 'text': return span.text;` → a `dangerouslySetInnerHTML` span.

```
      Tests  7 failed | 27 passed (34)
FAIL Markdown.test.tsx > renders nothing through innerHTML, at any level
FAIL MessageTurn.test.tsx > the 'answer' channel … builds the elements the source described
FAIL MessageTurn.test.tsx > the 'reasoning' channel … builds the elements the source described
```

The guard is not just a source scan — the same test renders `<img src=x onerror="alert(1)">` and
asserts no `img` role appears. Model output is text, and that is enforced by execution.

### M13 — the error sentence built from the host's cause code

`notices.ts` `causeSentence` → `` return `The endpoint said: ${String(diagnosis.cause)}`; ``.

```
FAIL notices.test.ts > writes every sentence itself, from the cause alone
FAIL notices.test.ts > falls back to the error kind when the host reports a cause it does not know
FAIL notices.test.ts > reports a content-filter refusal from the closed filter vocabulary
```

---

## 3. The "no endpoint text in a rendered error" rule

Checked on both sides of the seam, not just asserted.

**Renderer.** `describeChatError` takes `ChatError`. `src/platform/contract.ts:596-628`: every
variant carries a `Diagnosis` plus integers, `TransportFailure` (a closed union), `modelId` (read
off *Vela's own request*, per the doc comment), and `retryAfterMs`. There is no free-text field.
Every sentence a user reads is a literal in `notices.ts` — `CAUSE_SENTENCE`, `FILTER_KIND_LABEL`,
`transportTitle`, and the per-kind `extra` strings. M13 proves a test catches it if that changes.

**Host.** `src-tauri/crates/vela-providers/src/diagnostic.rs:811`:

```rust
pub struct Diagnosis {
    cause: Cause,
    status: Option<u16>,
    endpoint: Option<EndpointIdentity>,
    filter: Option<FilterVerdict>,
    correlation: CorrelationId,
}
```

`Cause` is a Rust enum; `EndpointIdentity` is `{authority, path}` parsed out of Vela's *own*
request URL with userinfo and query stripped; `FilterVerdict` is two enums, a bitset and a `u32`
with the comment "the only kind of endpoint-influenced value this design carries". `error.rs`'s
header records that a `detail: String` used to exist and why it is gone.

**Two honest exceptions, both outside the error surface.**

1. `Degradation::StructuredOutputMismatch { detail: String }` is rendered verbatim by
   `describeDegradation`. `SchemaMismatch::detail` is Vela's own validator wording, bounded at
   `MAX_MISMATCH_DETAIL_CHARS = 200` and sanitised in `model.rs`. It is also **unreachable from
   the chat surface** — `ChatSendReq` has no schema field and `build_request` never calls
   `with_schema`, so structured output is never requested on this path.
2. `ToolCallOutcome::Malformed.rawArguments` is model-authored text shown as evidence, bounded by
   `bounded()`/`truncate()` in `answer.rs`, `emulation.rs`, `google/stream.rs`. It is deliberate
   and documented ("Shown as evidence; never parsed into a call"), and the accompanying notice
   says the call was not run.

**The actionable half.** `MessageTurn` shows the `trace` correlation id only while the local
debug log is recording (`isDebugLogRecording`). That switch is real and mounted:
`src/features/models/EndpointsPanel.tsx:138` renders `<DebugLogSwitch />`, and
`src/features/diagnostics/dead-pointer.test.ts:82` asserts that mounting stays true. So the
"endpoint text goes to an opt-in log instead" promise has a route a user can actually take.

What a user sees for an unreachable endpoint, measured by executing the shipped component:

```
UNREACHABLE_ENDPOINT => "Could not reach the endpointVela could not open a connection.http://127.0.0.1:8033/v1"
```

Title, Vela's own sentence, and the endpoint *as the user configured it*. Correct.

---

## 4. Where it fails

### 4.1 A model that returns nothing renders as literally nothing

I rendered `AssistantTurn` over a set of hand-built `TurnState`s through the real component and
logged `article.textContent`:

```
EMPTY_COMPLETE_TURN  => ""
CONTENT_FILTER_STOP  => ""            (phase complete, stopReason 'unspecified', no text)
LENGTH_TRUNCATED_TURN=> "half a senCopy"
CANCELLED_TURN       => "partialCopyStopped"
REASONING_ONLY       => "Thought processhmmThis turn produced reasoning but no answer text."
HOST_REFUSAL         => "Vela could not start this turninvalid messages: a turn needs at least one message"
```

`EMPTY_COMPLETE_TURN` is a `done` with no parts, no reasoning, no error, no degradations. Trace
through `AssistantTurn`: `phase !== 'awaiting'` so no spinner; `answer === ''` so no `<Markdown>`;
`showThinkingOnly` is false because `reasoning === ''` so no "produced reasoning but no answer
text"; no tool calls, no degradations, no refusal, no error; the footer shows no copy button
(needs `answer !== ''`), no usage (none reported) and no "Stopped" (phase is `complete`). The
result is an empty `<article aria-label="Model reply">`.

**Is that reachable?** Yes. All three stream adapters convert an empty answer into an error only
when frames were *malformed*:

```rust
// src-tauri/crates/vela-providers/src/stream.rs:335
if self.answer.is_empty() && tool_calls.is_empty() && self.malformed_frames > 0 {
    return Err(ProviderError::malformed(Cause::StreamEndedWithoutAnswer));
}
```

Identical guards at `anthropic/stream.rs:619` and `google/stream.rs:559`. A *clean* stream that
produces zero tokens — an immediate EOS, an empty completion, a filter that stopped generation
without setting an error — is `Done` with empty parts, and the user gets a blank turn with no
explanation, no retry, and nothing to act on. The reasoning-only case has a sentence for exactly
this situation; the no-output case does not.

### 4.2 A truncated answer is presented as a complete one

`stopReason: 'maxTokens'` survives into `TurnState`, is written to the store, and is rendered
**nowhere**:

```
$ git grep -n "maxTokens" -- src
src/platform/chat-contract-parity.test.ts:98:  'maxTokens',
src/platform/contract.ts:333:export type StopReason = 'endTurn' | 'maxTokens' | 'cancelled' | 'toolUse' | 'unspecified';
src/platform/contract.ts:1115:export type StoredStopReason = …
```

`MessageTurn` reads `turn.stopReason` only to decide whether to print "Stopped" for a cancel. So
a reply that the endpoint cut off at the token limit — `anthropic/stream.rs:659` maps both
`max_tokens` and `model_context_window_exceeded` onto it — is drawn identically to one that
finished. Probe output: `"half a senCopy"`. The user sees a sentence that stops mid-word and a
Copy button, and no indication that anything is missing.

### 4.3 "Try again" on an older failed turn re-runs the newest message

The retry button is rendered per turn (`AssistantTurn`, `onRetry={conversation.retry}` for every
assistant entry), but `retry()` is global: it finds `[...current].reverse().find(kind === 'user')`
— the *last* user message in the whole transcript — and replaces everything from there.

Demonstrated by executing the real hook and view: send "QUESTION ONE", push a `stalled` transport
error, send "QUESTION TWO", push a successful `done`, then click the only "Try again" button
(which sits under QUESTION ONE's failure):

```
TRY_AGAIN_BUTTON_COUNT => 1
SENT_BEFORE_RETRY      => [["QUESTION ONE"],["QUESTION ONE","QUESTION TWO"]]
SENT_AFTER_RETRY       => [["QUESTION ONE"],["QUESTION ONE","QUESTION TWO"],["QUESTION ONE","QUESTION TWO"]]
TRANSCRIPT_AFTER_RETRY => "QUESTION ONEThe reply stopped arrivingThe reply stopped arriving and did not
                          resume.QUESTION TWOWaiting for the first token…MessageStopEsc to stop"
```

Clicking the button under the failed first turn re-sent **QUESTION TWO**, discarded QUESTION
TWO's answer (and, in a persisted conversation, `transcript.remove`s its rows), and left the
failed turn and its error box exactly as they were. The failure the user was trying to fix is
untouched; the answer they were keeping is gone.

The scenario is ordinary: nothing blocks the composer after a failed turn — `blockedReason` only
covers "no model chosen" and "transcript unreadable" — so sending another message and then
noticing the earlier failure is a normal sequence. The one thing that limits blast radius is that
a *restored* transcript carries no typed error (`stored-entries.ts` deliberately refuses to widen
`errorMessage` back into a `ChatError`), so the button only appears within a live session.

---

## 5. Wired, half-wired, not wired

**Tools are never offered on the ordinary chat path.** `createChatRepository`'s `streamTurn`
invokes:

```ts
await adapter.invoke('chat_send', {
  turnId: request.turnId,
  providerId: request.providerId,
  modelId: request.modelId,
  messages: request.messages,
});
```

No `tools`, no `toolChoice`. `ChatSendReq` accepts both (`#[serde(default)]`), `build_request`
validates both thoroughly, and eleven Rust tests cover that validation — but nothing on the plain
chat path ever sends one. Consequences:

- `Degradation::ToolCatalogueWithheld` fires only when `!request.tools.is_empty()`
  (`emulation.rs:78`), and `ToolCallingEmulated` only when tools were offered. Neither can occur
  on the plain path; their wording in `notices.ts` is unit-tested and unreachable from a chat.
- `ToolCallList`'s cards can only be fed through the **agent** path, which does pass
  `tools: [subagentToolDefinition]` (`use-conversation.ts:747`).

**`ToolCallList`'s `results` and `running` props have no production caller.** The only caller of
`ToolCallList` is `TurnNotices.ToolCalls`, and the only caller of that is `MessageTurn`:

```tsx
<ToolCalls outcomes={turn.outcomes} progress={turn.toolProgress} />
```

Neither `results` nor `running` is ever supplied. The "result came back" and "currently
executing" states in `ToolCallList` — and their twenty unit tests — are reachable only from tests.

**Structured-output degradations** are unreachable from chat, as above.

---

## 6. Flakiness I could not pin down, and why it matters

Twice during this audit, tests in this domain failed on an *unmutated* tree and then passed on
re-run. Both under load (eleven agents share this machine).

Unmutated, three files together:

```
$ pnpm exec vitest run ConversationSurface.test.tsx use-conversation-record.test.tsx agent-run.test.tsx
FAIL agent-run.test.tsx > an agent run carries the same memory the plain chat path does
     > leads the run's input with the remembered facts, not just the question
FAIL ConversationSurface.test.tsx > the conversation surface: mounted in the app
     > fills the content region once a conversation is selected
      Tests  2 failed | 48 passed (50)
```

The memory failure's mode is specific:

```
AssertionError: expected { role: 'user', …(1) } to match object { role: 'system' }
  at agent-run.test.tsx:783
- "role": "system"
+ "role": "user"
```

That is *the memory block missing from the run's input* — the exact defect the test was written
to catch, and the test's own doc comment says nothing else in the file would notice. The same
three-file command then passed 3/3, `agent-run.test.tsx` alone passed 3/3, and the single test
under `-t` passed 6/6. I could not reproduce it deliberately, so I cannot say whether it is a
test-timing artifact or a real race in `useConversation` — the memory read is an async effect
(`memory.list` → `setRemembered` → `memoryMessage` → `memoryRef.current`) and `start`/`startRun`
read `memoryRef.current`, so a send that beats the read sends a turn with no memory block and
says nothing about it. The test guards against that by `waitFor`ing the preamble first, which is
why a failure *after* that wait is the interesting shape.

Recorded as UNVERIFIED rather than graded. It is the single thing in this domain I would most
want re-run under load before shipping.

Separately: with M3 applied I saw all fifteen `agent-run.test.tsx` tests fail in a three-file
parallel run, and only one fail when run alone. Whatever produces the flake above appears to
amplify under contention. **"The suite is green" is a weaker statement in this domain than the
239/239 headline suggests.**

---

## 7. Things I checked and found sound, without mutating

- **Keyboard contract.** `Composer.tsx` handles `isComposing` *and* `keyCode === 229` before
  treating Enter as send, refuses on `shiftKey`/`altKey`, and `Escape` only cancels while
  streaming. Thirteen tests in `Composer.test.tsx`. Escape→`stop()`→`chat_cancel` is proven by
  M10; the IME and Shift+Enter rules I read but did not mutate.
- **Capability gating.** The attach control and the agent toggle are rendered from
  `capabilities.vision` / `AgentMode.available`, never from a backend name, and are *absent*
  rather than disabled. `agentAvailable = runtime !== null && conversationId !== null &&
  capabilities.toolCalls` — three real conditions, not an identity check.
- **Empty state.** Reads the capability struct, shows absence as well as presence, suggests no
  prompts, and says so in its header comment. `modelLabel` is the user's own name for the model.
- **`MessageTurn.test.tsx`'s reflexive guard.** It parses `TurnState` out of `turn-stream.ts`,
  extracts every `string` field whose doc comment calls it the model's, and fails if the
  render-test table does not cover it. That is a guard against the exact defect class this
  project is worried about, and it is the best test in the domain.
- **`chat.rs` boundary.** `build_request` rejects in a fixed order (turnId, providerId, modelId,
  messages), bounds message size and count, and `TerminalTracking` guarantees the sink sees
  exactly one terminal event — asserted by `a_driven_turn_always_terminates_the_stream_exactly_once`
  and `a_cancelled_turn_still_terminates_rather_than_hanging_the_renderer`.
- **Scroll.** `scroll.ts` is pure and has ten tests including the 1280×672 display-scaling
  geometry that produced the empty-state defect. The `ConversationView` plumbing around it
  (ResizeObserver, passive scroll listener, `useLayoutEffect` scrollTo) is inspection-only —
  jsdom has no layout, and the file says so.

---

## 8. Ordinary path vs agent path

Graded separately, as instructed.

The **ordinary path** (`start`) is the better-tested of the two: the reducer, the guard, the
batching, the refusal, the error rendering, the retry, the store round-trip all have tests that
bite at the surface level.

The **agent path** (`startRun`) shares the reducer and the view — `RunEvent`'s `chat` arm carries
`ChatStreamEvent` verbatim, so no new rendering code exists — and adds: a write barrier
(`await writes.current`) so the question's row lands before the run opens its own; `claimed`
entries so the surface does not double-write rows the harness owns; a `viaRun` branch in `retry`
that finds the tail by store order because a harness reports none of the ids it wrote; and a
subscription whose `ended` flag handles a run that finished before `subscribe` returned. All of
that is tested in `agent-run.test.tsx` (15 tests) — but **at hook-state level only**. M9 deleted
the entire refusal box from the DOM and all fifteen still passed. The agent path's *sentences*
are pinned; its *rendering* rides on one plain-path test.

Two further asymmetries worth naming:

- The agent path writes the user's message to the store eagerly (`enqueue` before the run starts);
  the ordinary path writes both messages only once the turn settles. The header comment
  acknowledges this and says a `streaming` row + `store_update_message` would be the better
  record and is not this change. So an ordinary turn interrupted by a window close is lost;
  an agent turn's question is not.
- `stop()` prefers `activeRun.cancel()` over the turn handle, with a comment explaining that
  cancelling only the turn would leave the loop free to open the next one. Correct, and
  inspection-only — I did not build a run to cancel.

---

## 9. Summary of grades

| Aspect | Verdict | Evidence |
|---|---|---|
| Compose & send a turn (composer → `chat_send` payload) | PASS | M8 |
| Escape / Stop reaches `chat_cancel` | PASS | M10 |
| Cancel reads as stopped, not failed | PASS | M1 |
| Streaming render: first token immediate, rest batched | PASS | M6 |
| Reasoning channel kept out of the answer | PASS | M2 |
| Reasoning never replayed to the endpoint | PASS | M8 |
| Markdown rendering never builds HTML from model text | PASS | M12 |
| Error notices carry no endpoint text | PASS | M13 + source, both sides |
| Error surface is actionable (title, sentence, endpoint, retry, trace) | PASS | probe + `DebugLogSwitch` mounted |
| Host refusal drawn as Vela's own fault | PASS | M9 |
| Retry of the *last* turn: no duplicate, store rows replaced | PASS | M3, M7 |
| Retry button on an *older* failed turn | **FAIL** | probe |
| A model that returns nothing | **FAIL** | probe + Rust guards |
| A truncated answer (`maxTokens`) | **FAIL** | probe + `git grep` |
| Transcript restore: no double-write, no stuck spinner | PASS | M4, M11 |
| Unreadable transcript blocks sending, with a reason | PASS | M5 |
| Empty state | PASS | tests, unmutated |
| Composer keyboard contract (Enter / Shift+Enter / IME) | PASS | tests, unmutated |
| Tool-call cards: `results` / `running` | **FAIL (not wired)** | caller trace |
| Tools on the ordinary chat path | **FAIL (not wired)** | `chat-repository.ts` |
| Memory block rides on every turn | UNVERIFIED | intermittent failure, §6 |
| Agent path rendering (as opposed to state) | PASS, thinly | M9 |
