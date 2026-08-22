# Audit — Providers and model layer

Auditor: independent agent, domain "Providers and model layer".
Worktree `C:\Users\User\vela-tmp`, branch `claude/new-session-tgl1ut`, HEAD `a1fa55e`
("Run CI on the platform Vela ships on"). Windows 11, real hardware, real
llama.cpp `b8833`-class server on `127.0.0.1:8033` serving
`unsloth/Qwen3.6-27B-GGUF:Q5_K_M`.

Scope: `src-tauri/crates/vela-providers/` (40,361 lines across 40 source and
23 test files) plus everything above it that decides whether any of it reaches a
user: `src-tauri/src/provider_host.rs`, `src-tauri/src/ipc/{chat,models}.rs`,
`src-tauri/src/lib.rs`, and the renderer's `src/platform/no-provider-leak.test.ts`,
`src/platform/chat-contract-parity.test.ts`, `src/features/models/*`,
`src/features/conversation/*`.

No tracked file was left modified. Every mutation below was applied, measured,
and reverted with `git checkout --`, with the revert confirmed by an empty
`git status --porcelain` on the file.

---

## 1. What I actually ran

### 1.1 Baseline

```
$ cd C:\Users\User\vela-tmp\src-tauri
$ cargo test -p vela-providers
...
test result: ok. 404 passed; 0 failed; 0 ignored; ...   (lib)
... 24 targets, all `ok` ...
```

24 test targets, 594 tests, 0 failures. Two `ignored`: the live probe
(`live_reasoning_tool_probe`, env-gated) and one doctest.

One run failed spuriously first time — `could not execute process
credential_canary-....exe (never executed) … The process cannot access the file
because it is being used by another process. (os error 32)`. That is
shared-worktree contention with the other ten auditors, not a test failure; the
immediate re-run was clean. Worth recording because it is exactly the sort of
thing a future reader would misread as a real red.

### 1.2 Live capability probe against real hardware

The repository already contains the vantage point, `#[ignore]`d on purpose:

```
$ VELA_LIVE_BASE_URL=http://127.0.0.1:8033/v1 \
  VELA_LIVE_MODEL_ID='unsloth/Qwen3.6-27B-GGUF:Q5_K_M' \
  cargo test -p vela-providers --test live_reasoning_tool_probe -- --ignored --nocapture

{
  "modelId": "unsloth/Qwen3.6-27B-GGUF:Q5_K_M",
  "streaming": "supported",
  "toolCalling": "supported",
  "vision": "supported",
  "structuredOutput": "degraded",
  "reasoning": "supported",
  "modelListing": "supported",
  "usageReporting": "supported",
  "promptCaching": "supported",
  "contextWindowTokens": 131072,
  "maxOutputTokens": null,
  "findings": [
    { "capability": "streaming",        "support": "unknown",   "evidence": "declared",
      "note": "endpoint declares a 131072-token context window" },
    { "capability": "modelListing",     "support": "supported", "evidence": "probed",
      "note": "1 model(s) listed" },
    { "capability": "streaming",        "support": "supported", "evidence": "probed",
      "note": "streamed a completion" },
    { "capability": "usageReporting",   "support": "supported", "evidence": "probed",
      "note": "usage frame on a streamed turn" },
    { "capability": "promptCaching",    "support": "supported", "evidence": "probed",
      "note": "usage carried cached-input accounting (0 token(s) cached on this turn)" },
    { "capability": "reasoning",        "support": "supported", "evidence": "probed",
      "note": "emitted a reasoning channel" },
    { "capability": "toolCalling",      "support": "supported", "evidence": "probed",
      "note": "returned a well-formed tool call" },
    { "capability": "vision",           "support": "supported", "evidence": "probed",
      "note": "accepted an image part" },
    { "capability": "structuredOutput", "support": "degraded",  "evidence": "probed",
      "note": "answered 200 without honouring the schema: the model returned prose, not JSON — the schema was ignored" }
  ]
}
test a_live_reasoning_model_is_probed_as_tool_calling ... ok
test result: ok. 1 passed; 0 failed; ... finished in 9.68s
```

This is the fix the session already recorded (`toolCalling` was `Unsupported`
because the probe capped output at 64 tokens and a reasoning model spent them
all before calling). Re-measured here on the same hardware: it now reports
`Supported` with `evidence: Probed`, in 9.68 s inside `Timeouts::probing()`'s
15 s budget. The structured-output verdict is the interesting one — the model
genuinely ignores a `json_schema` request and the probe caught it, which is
MEASURED-5's whole point, measured for the first time against a real model
rather than a mock.

### 1.3 A real streamed turn through the *shipped* provider class

The live probe above drives `OpenAiCompatibleProvider`. The class the
application actually builds is `CompatProvider` (see §2.1). I wrote a temporary
`#[ignore]`d probe under `crates/vela-providers/tests/`, ran it once, and deleted
it in the same shell command. It constructed `CompatProvider` with exactly the
five arguments `ProviderHost::build` passes, and streamed one turn with a tool
offered:

```
FLAVOUR       LlamaCpp
CAPS          ModelCapabilities { model_id: "unsloth/Qwen3.6-27B-GGUF:Q5_K_M",
                streaming: Unknown, tool_calling: Unknown, vision: Unknown,
                structured_output: Unknown, reasoning: Unknown, model_listing: Unknown,
                usage_reporting: Unknown, prompt_caching: Unknown,
                context_window_tokens: Some(131072), max_output_tokens: None, findings: [] }
EVENTS        text=0 reasoning=127 toolDeltas=5 usage=1 done=1
STOP          ToolUse
USAGE         TokenUsage { input_tokens: Some(278), output_tokens: Some(155),
                reasoning_tokens: None, cached_input_tokens: Some(0) }
DEGRADATIONS  []
TOOL CALLS    [Ok { call_id: "1CHmzhEGMAkEo5bLXKM1i4yJ0wDblJsN", name: "get_weather",
                arguments: Object {"city": String("Berlin")}, emulated: false }]
ANSWER        ""
REASONING?    true
test a_real_turn_through_the_shipped_adapter ... ok
```

What that measures, on hardware, in one turn:

* server discovery works against a real llama.cpp — `ServerFlavour::LlamaCpp`,
  `context_window_tokens: Some(131072)` off `/props`;
* the SSE decoder and stream assembler survive a real socket — 127 reasoning
  deltas, 5 tool-call deltas, 1 usage frame, **exactly one** `Done`;
* the reasoning channel is separated: every one of the 127 deltas landed as
  `ReasoningDelta`, the answer text is `""`, and a `Reasoning` content part is on
  the response. Nothing of the model's deliberation reached the answer;
* native tool calling round-trips: `emulated: false`, arguments parsed into a
  JSON object, `StopReason::ToolUse`;
* `degradations: []` — meaning the `[DONE]` sentinel *and* the requested usage
  frame both arrived, so neither `NoTerminationSentinel` nor `UsageNotReported`
  fired falsely.

Note `CAPS` afterwards: everything still `Unknown` except the declared window.
That is the honest floor working — a turn is not a probe, and it raised no flag.

---

## 2. Shipping traces

### 2.1 A configured provider is a live provider

`src-tauri/src/provider_host.rs` is the composition root, and it exists because
the defect it names actually happened: `AppState::for_runtime()` built an empty
`ProviderRegistry` and nothing ever called `register`, so `chat::resolve_provider`
answered `NOT_FOUND` for every endpoint the user had configured.

Traced by hand, both directions:

* `src-tauri/src/lib.rs:86` — `app.state::<AppState>().providers.sync_from_settings(store.store())?`
  at startup, with per-id failures printed rather than swallowed.
* `src-tauri/src/ipc/settings.rs:148` — `providers.install(&config)?` on every
  accepted `settings_put_provider`; `:163` — `providers.forget(&req.provider_id)`
  on delete.
* `src-tauri/src/ipc/chat.rs` — `chat_send` → `resolve_provider(state.providers, …)`
  → `provider.stream(...)`, with events emitted verbatim on `chat:event`.
* `src-tauri/src/lib.rs:186` — `generate_handler!` lists `chat_send`, `chat_cancel`,
  `models_capabilities`, `models_list`, `models_probe`,
  `diagnostics_debug_log_{get,set}`.
* Renderer: `src/app/App.tsx` → `ModelWorkspace` → `EndpointsPanel` →
  `DebugLogSwitch`; `ModelWorkspace.tsx:177` calls `models.probe()`;
  `src/features/conversation/turn-stream.ts` consumes every `StreamEvent` arm
  (`textDelta`, `reasoningDelta`, `toolCallDelta`, `usage`, `done`).

So the adapter layer genuinely reaches a user.

### 2.2 …but only one of the three adapters can be built

`ProviderHost::build` has a single arm:

```rust
Ok(Arc::new(CompatProvider::new(
    descriptor, config.base_url.as_str(), config.auth.clone(),
    Arc::clone(&self.secrets), transport,
)))
```

`AnthropicProvider` and `GoogleProvider` are unreachable from the host. This is
stated in the module's own docs as a deliberate limitation — `ProviderConfig` has
no protocol field, and inventing one from the URL would be the "branch on backend
identity" conventions §0.3 forbids. I verified it rather than taking the comment
at its word:

```
$ git grep -n "OpenAiCompatibleProvider\|AnthropicProvider\|GoogleProvider\|CompatProvider" \
    -- src-tauri/src src-tauri/crates | grep -v crates/vela-providers
src-tauri/src/provider_host.rs:30://! [`CompatProvider`] accumulates *learned* facts …
src-tauri/src/provider_host.rs:37://! Every configured provider is built as a [`CompatProvider`] …
src-tauri/src/provider_host.rs:41://! `AnthropicProvider` and `GoogleProvider` exist in the provider core and are
src-tauri/src/provider_host.rs:63:use vela_providers::{CompatProvider, Provider, ProviderRegistry};
src-tauri/src/provider_host.rs:256:        Ok(Arc::new(CompatProvider::new(
```

Two comment lines and one constructor. Nothing builds Anthropic or Google.
Roughly 5,000 lines of adapter (Anthropic 4,144; Google 4,845 including tests)
are `tests-only`.

The same grep is why the router row below is graded the way it is:

```
$ git grep -n "Router\|Candidate::new\|\.route(" -- src-tauri/src src-tauri/crates/vela-endpoint
(no output)
```

`Router`, `Candidate`, `RetryPolicy` — bounded retry, backoff, `Retry-After`
honouring, "never fail over after first visible output" — have **no caller
outside the provider crate and its own example binary**. `chat_send` calls
`provider.stream` directly. Failover does not exist in the shipping product.

### 2.3 What `chat_send` never sets

`ChatSendReq` carries `turnId, providerId, modelId, messages, tools, toolChoice`
and nothing else. Consequently the host never sets `ResponseFormat`,
`ReasoningRequest`, `Sampling`, `CacheHints`, or `max_context_tokens`:

```
$ git grep -rn "ResponseFormat\|response_format\|responseFormat" -- src-tauri/src src
(no output)
$ git grep -rn "ReasoningRequest\|with_reasoning" -- src-tauri/src src
(no output)
```

So `structured.rs` (468 lines, `MachineText`, `StructuredOutputPolicy`, schema
validation) is exercised **only** by the capability probe, which sends its own
`json_schema` request. A user cannot ask for structured output. Similarly,
`ContextBudget::for_request` falls back to `request.max_context_tokens` only when
the probe found no window — and the host never sets it, so context fitting is
entirely driven by discovery.

Also: `src/data/chat-repository.ts`'s `streamTurn` invokes `chat_send` with
`{turnId, providerId, modelId, messages}` — no `tools`. The only caller that
sends tools is `src/runtime/agent-loop-harness.ts:361`. So tool calling and its
emulation reach a user through the agentic runtime, not the plain composer.

---

## 3. Mutation testing — where I broke the implementation and watched

Six mutations. Each was applied, run, and reverted inside one shell command.

### 3.1 Model-agnosticism (`src/platform/no-provider-leak.test.ts`)

Rather than edit a tracked file, I created an untracked renderer file:

```
$ printf "export const AUDIT_PROBE = 'ollama';\n" > src/lib/zz_audit_probe_tmp.ts
$ npx vitest run src/platform/no-provider-leak.test.ts

- Expected
+ Received
- []
+ [
+   "src\\lib\\zz_audit_probe_tmp.ts:1 — export const AUDIT_PROBE = 'ollama';",
+ ]
 ❯ src/platform/no-provider-leak.test.ts:106:7
 Test Files  1 failed (1)
      Tests  1 failed | 17 passed (18)
```

The guard bites, and it bites on Windows — which matters, because this file
carries an in-source account of a sibling defect where `split('/')` made a
different arm of the same guard silently inert on a Windows checkout. Note the
backslash in the reported path: the scan is walking real `join`ed paths.

The guard is also unusually well built for a guard: it carries its own controls
(`the scan actually catches a leak`, `the id-inspection guards actually catch
what they are for`), it asserts non-vacuity for each sub-scan (`files.length …
toBeGreaterThan(5)`), and it asserts that its own exemption (`use-conversation.ts`
as the sole `providerId` carrier) is still *needed*, not merely still listed.

One gap: the top-level `src/` scan has no file-count assertion, so if
`sourceFiles(SRC_ROOT, …)` ever returned nothing that first test would pass
vacuously. Every sub-scan does have one, so the exposure is small.

### 3.2 Reasoning separation across frames (MEASURED-3)

`held_back` in `textscan.rs` is the whole trick: hold the few trailing bytes that
could still become `</think>`. I made it a no-op:

```rust
pub(crate) fn held_back(buffer: &str, candidates: &[&str]) -> usize {
    return 0; // AUDIT MUTATION
```

```
test result: FAILED. 397 passed; 7 failed
  textscan::tests::a_partial_marker_at_the_end_is_held_back_whole
  reasoning::tests::a_closing_tag_split_across_frames_never_leaks
  reasoning::tests::one_character_at_a_time_gives_the_same_result_as_one_chunk
  stream::tests::think_tags_split_across_frames_are_separated_and_ordered
  anthropic::stream::tests::leaked_think_markup_split_across_frames_never_reaches_the_answer
  google::stream::tests::leaked_think_markup_split_across_frames_never_reaches_the_answer
  emulation::tests::the_stripper_never_lets_call_markup_reach_the_user_even_split_across_frames

reasoning markup reached the user: "<think>Considering the request about what is
the weather in Berlin. Profile mid-local has a 32768-token window. Answering
directly.</think>\nMock mid-local reply to: what is the weather in Berlin."
```

Seven tests, across **all three** adapters plus the emulated-tool-call stripper.
The failure message is the leak itself. This is the strongest guard in the crate.

### 3.3 The two tool-call wire shapes (MEASURED-4 / GATE M Phase B FINDING 1)

`stream.rs:211` decides, at the only place that knows, whether `tool_calls[]`
elements are streaming *fragments* keyed by `index` or non-streamed *whole calls*
that carry no index. I collapsed the distinction — the original defect:

```rust
None => (object.get("message").and_then(Value::as_object),
         ToolCallShape::Fragment,   // was WholeCall — AUDIT MUTATION
```

```
lib                     ok.   404 passed
google_fixture_replay   ok.    15 passed
anthropic_fixture_replay ok.   17 passed
parallel_tool_calls     FAILED. 2 passed; 3 failed
  two_parallel_calls_with_no_index_come_back_as_two_executable_calls
  two_broken_calls_in_one_body_are_both_reported_and_neither_is_spliced
  streamed_and_non_streamed_agree_on_the_same_endpoint_answer

left: "MALFORMED id=call_a name=get_weather reason=UnparseableArguments
        raw=\"{\\\"city\\\":\\\"berlin\\\"}{\\\"city\\\":\\\"paris\\\"}\""
```

The two parallel calls fused into one unparseable argument blob — exactly the
recorded FINDING 1 symptom. The guard is `tests/parallel_tool_calls.rs` alone;
the lib tests and both fixture replays stayed green, so this property has a
single line of defence. It holds, but it is thin.

### 3.4 Credential redaction of encoded spellings (round-4 defect)

`Scrubber::replace_encoded` is the pass that matches a needle against a
*decoded view* of the bytes, so `sk\/x\/KEY` (PHP's `json_encode` escaping `/`)
cannot get past a byte scrub and be reassembled by `serde_json` downstream. I
made it a no-op:

```
test result: FAILED. 399 passed; 5 failed
  redact::tests::an_endpoint_that_escapes_the_solidus_does_not_get_the_credential_past_the_byte_scrub
  redact::tests::a_credential_spelled_entirely_in_unicode_escapes_is_still_removed
  redact::tests::a_surrogate_pair_spelling_of_a_non_ascii_credential_is_removed
  redact::tests::a_mixture_of_spellings_inside_one_credential_is_one_case_not_three
  redact::tests::an_escaped_credential_split_across_two_chunks_is_still_removed
```

Five, including the chunk-boundary case. `cargo` stops on the first target
failure, so the three dedicated canary integration targets never ran; the lib
evidence is sufficient.

### 3.5 Deliberation is not an instruction (FINDING 3)

`AnswerChannel::push_reasoning` must never reach `executable_text()`. I made
reasoning append to `committed` as well:

```rust
self.append_reasoning(text);
self.committed.push_str(text); // AUDIT MUTATION
```

lib: `402 passed; 2 failed` —
`answer::tests::committed_text_is_the_only_text_a_tool_parser_sees`,
`answer::tests::the_salvaged_tail_is_a_suffix_of_the_visible_answer`.

Re-run against the integration targets only (so the lib failure did not abort
the run):

```
answer_chokepoint                   ok.      5 passed
deliberation_is_not_an_answer       ok.     10 passed
deliberation_is_not_an_instruction  FAILED.  4 passed; 3 failed
  a_call_the_model_never_committed_to_is_not_executable_on_either_transport
  no_raw_tool_call_markup_reaches_the_user_on_either_transport
  the_refusal_is_visible_and_carries_its_evidence
```

The named guard bites, on both transports. This is the security-relevant one: a
model *thinking* about `delete_everything` must not thereby call it.

### 3.6 Refit-on-context-overflow (MEASURED-7)

`CompatOptions::default().refit_on_context_overflow` flipped to `false`:

```
test result: FAILED. 401 passed; 3 failed
  compat::provider::tests::a_vllm_style_overflow_teaches_the_window_and_the_turn_is_refitted_and_retried
  compat::provider::tests::a_second_overflow_after_refitting_is_surfaced_instead_of_looping
  compat::provider::tests::the_user_sees_one_terminal_event_and_never_an_error_before_the_answer
```

Both halves are guarded: that the refit happens, and that it happens **once**
and only before anything reached the screen.

### 3.7 Rust↔TypeScript wire-type parity

`chat-contract-parity.test.ts` reads the Rust sources off disk and compares
serde wire names against compiler-closed TS lists. Baseline: `33 passed`. I
deleted `'cancelled'` from the `STOP_REASON` list — simulating a Rust variant
that never got its TypeScript twin:

```
 × StopReason carries every StopReason variant, and no other
   → model.rs::StopReason vs StopReason: expected [ 'cancelled', 'endTurn', …(3) ]
     to deeply equal [ 'endTurn', 'maxTokens', …(2) ]
```

It bites, and the CRLF repair recorded in its own source is holding on this
Windows checkout (all 33 cases parse; the file documents that 28 of 31 used to
throw `unterminated`).

**Limitation found by inspection, not mutation.** `parseRustItem` handles the
item-level `#[serde(rename_all = …)]` and `#[serde(skip)]`, but it ignores
**per-variant `#[serde(rename = "…")]`** — it derives the wire name from the Rust
identifier alone. A variant renamed on the wire would drift from TypeScript
silently. I checked for live exposure:

```
$ grep -rn '#\[serde(rename = ' src-tauri/crates/vela-providers/src/
(no output)
```

No variant uses one today, so there is no drift now; the gap is a trap for the
next person who reaches for one.

---

## 4. Findings that are not mutations

### 4.1 A capability finding filed under the wrong capability

`openai_compatible/provider.rs:820-827` records the declared context window as:

```rust
capabilities.findings.push(CapabilityFinding {
    capability: Capability::Streaming,
    support: Support::Unknown,
    evidence: Evidence::Declared,
    note: format!("endpoint declares a {n_ctx}-token context window"),
});
```

It is about the context window, not streaming. The live probe output in §1.2
shows it reaching the top of the findings list as
`{"capability":"streaming","support":"unknown","evidence":"declared"}`. Google's
equivalent (`google/provider.rs:697`) at least files under `ModelListing`, which
is where it came from.

Consequence today is small but real:

* it crosses the IPC boundary — `ipc::models::CapabilityFindingView` keeps
  `capability`/`support`/`evidence` and drops only the `note`, which is the
  *explanatory* half. So the boundary carries a mislabelled fact stripped of the
  sentence that would have revealed the mislabelling;
* nothing in `src/` reads `report.findings` today (`git grep findings -- src/`
  returns only `contract.ts:856` and the browser fake), so no pixel is currently
  wrong;
* `ModelCapabilityReport.probed` is computed as
  `findings.iter().any(|f| f.evidence != Unprobed)` — and this finding is
  `Declared`. An endpoint that answered `/props` and then failed every
  subsequent probe step would therefore report `probed: true` with every flag at
  the pessimistic floor, and `capability-rows.ts` renders that as positive
  assertions of absence ("Images: Not accepted", "Tools: Unavailable") rather
  than "Not established". That is the capability system's stated failure mode,
  reached from the other side.

There is no `Capability::ContextWindow` variant, which is presumably why an
existing one was borrowed. Adding one is a contract change (`chat-contract-parity`
would demand the TS twin), which is probably why it was not.

### 4.2 The Anthropic and Google fixtures are not captures

My brief described them as "byte-exact captures". The files themselves say
otherwise, and the honesty is the repository's, not mine to correct:

> `tests/anthropic_fixture_replay.rs`: "The fixtures are event sequences
> transcribed from the published protocol shape — they are *not* captured
> traffic, and not one byte of them came from a language model."

They are excellent fakes — replayed at five chunk sizes including one byte at a
time, with four in-file negative controls that implement the naive consumer and
assert it fails — but "the adapter survives streams shaped like this" is the
claim, and no stronger one is available. `.gitattributes` (`*.sse -text`,
`*.jsonl -text`) is holding: `cat -A` on
`fixtures/anthropic/01-thinking-tool-use.sse` shows `$` line ends, no `^M$`.

### 4.3 `RequestUrl::expose` has two production call sites, not one

`redact.rs`'s module docs say "there is exactly one production call site, in the
transport". There are two — `http.rs:1039` and `:1040`, the GET and POST arms of
the same `reqwest` builder call. Immaterial to the property; noted because the
crate's own style is to make such statements checkable.

### 4.4 Discovery, dialects, and the honest floor

`compat/discovery.rs` (726 lines) and `compat/flavour.rs` handle four `/v1/models`
shapes; `compat/error_shapes.rs` (408 lines) normalises four error dialects
(OpenAI-shaped, llama.cpp's numeric `code`, vLLM's no-`error`-object, Ollama's
string `error`) at the transport seam *before* the core sees them, with prose
matching allowed only where no machine-readable code exists and a miss always
falling through to the status mapping. The live run in §1.3 confirms the
llama.cpp arm of the discovery half on real hardware (`FLAVOUR LlamaCpp`,
`Some(131072)`); the other three families are mock-only.

### 4.5 Egress control

`tests/wire_proxy_egress.rs` (492 lines) and `tests/wire_redirect_egress.rs`
(914 lines) both open real loopback listeners and assert against literal request
bytes, with in-file positive controls. `wire_proxy_egress`'s own preamble records
that `ReqwestTransport::with_connect_timeout`'s `.no_proxy()` had **no test at
all** until that file existed — "a rule whose only evidence is the line that
claims it is a comment, not a control" — which is this repository's central
defect class, caught and closed. `wire_auth_headers.rs` proves `Auth::None`
sends no `Authorization` header by teeing the socket, with a credential-present
positive control. I ran all three (green in the baseline) but did not mutate
them.

---

## 5. Judgement on the domain as a whole

The provider crate is the strongest code in this repository that I have read. Its
load-bearing rules are named, numbered against recorded evidence (MEASURED-1..7),
and — where I tested — genuinely guarded by tests that fail when the rule is
broken. Six of six mutations were caught. The two properties whose failure would
be silent and dangerous (reasoning leaking into executable text; a credential
surviving in an encoded spelling) are the two most heavily guarded.

The gap is not quality, it is reach. The crate implements a product larger than
the one wired up:

| Built | Reaches a user |
|---|---|
| OpenAI-compatible / `CompatProvider` | yes |
| Anthropic adapter (1,577 + 1,240 + 757 lines) | no — nothing constructs it |
| Google adapter (1,743 + 1,161 + 997 lines) | no — nothing constructs it |
| `Router` — failover, backoff, `Retry-After` | no — no caller outside the crate |
| `structured.rs` — schema validation | probe only; no user path sets `ResponseFormat` |
| Reasoning *request* controls (`ReasoningRequest`) | no — `chat_send` cannot express it |
| Emulated tool calling | yes, but only via the agentic runtime |

Every one of those is disclosed in the source rather than hidden — `provider_host.rs`
states the Anthropic/Google limitation and why, and gives the shape of the fix.
That is the opposite of the defect class this audit exists to catch. But a reader
of `lib.rs`'s module table would reasonably conclude Vela speaks three protocols
and fails over between backends, and it does neither.
