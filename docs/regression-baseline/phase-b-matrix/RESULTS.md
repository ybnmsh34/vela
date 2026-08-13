# GATE M Part 1 (Phase B) — does Vela degrade gracefully?

**Recorded:** 2026-08-13 · **Executor:** GATE M Part 1 Phase B evidence run
**Re-recorded:** 2026-08-13, round 2 integration — **265 assertions, 0 failures**
**Subject:** `src-tauri/crates/vela-providers` — Vela's own provider stack
**Raw evidence:** `<profile>/00-…10-*.txt`, `verdicts.tsv`, `ASSERTION-CONTROL.txt`
**Companion:** `../mock-matrix/RESULTS.md` — what the endpoints did

> **Round 1 → round 2.** The first execution of this gate FAILED: five assertions,
> all one defect — FINDING 1, non-streamed tool calls collapsing into one. Round 2
> fixed it and the transcripts in this directory are a re-record against the fixed
> tree, so every file here now reads PASS. **FINDING 1's round-1 red is preserved
> verbatim in §3 below**, which is the before/after and is not rewritten: the
> defect was real, it was measured, and the quotes are what the recorder printed.
> Everything else in this document is the round-1 text, unchanged — the numbers it
> reports were re-measured and still hold.

---

## Read this before you read anything else

**Every result below is VERIFIED-BY-FAKE** (`conventions.md` §10). The four
capability profiles are deterministic mock servers, started as real OS processes
and driven over real TCP by Vela's real HTTP client through Vela's real provider
layer — but they are mocks. **Not one byte came from a language model.**

**GATE M Part 2 — a real llama.cpp at :8033 on the operator's Windows host — is
unreachable from this container. It was not attempted and remains unverified.**
Nothing in this file is evidence about a real model.

**What is new since Phase A.** Phase A shipped no HTTP client anywhere, so the
gate could only characterise the harness. The gate criterion — *a piece FAILS if
under any profile it crashes, hangs, silently produces wrong output, or offers an
affordance the profile cannot support* — is applied to Vela's runtime behaviour
here for the first time.

**This run does not inherit Phase A's pass.** It is an independent execution: its
own recorder, its own wire-tapping transport, its own assertions. Where it
overlaps `crates/vela-providers/tests/mock_matrix_live.rs` (the builders' own
suite, 24/24 green) it agrees with it. Where it does not overlap, it found
something the builders' suite does not cover — see FINDING 1.

---

## 1. The ledger

**265 gate assertions across four profiles. Round 1: 5 failures, all one defect.
Round 2, after the fix: 0.**

| | round 1 | round 2 (this directory) |
|---|---|---|
| gate assertions | 265 | 265 |
| failures | **5** (FINDING 1, one root cause) | **0** |
| controls | 15, of which 10 FAIL — every one the expected one | unchanged |
| wall clock, whole run | ~17 s | ~17 s |

`verdicts.tsv` carries every line. `SUMMARY.txt` carries the failure list.

---

## 2. The matrix — Vela's behaviour, per case, per profile

| case | frontier | mid-local | small-local | hostile |
|---|---|---|---|---|
| **00** capability probe | ✅ 200k · tools/vision/schema all Supported | ✅ 32k · schema **Degraded**, vision Unsupported | ✅ 8k · tools **Unsupported**, schema Degraded | ✅ 4k · tools **Degraded**, schema Degraded |
| **01** plain chat, streamed ≡ whole | ✅ identical, deltas sum to the answer | ✅ identical | ✅ identical | ✅ identical |
| **02** tool calling | ✅ native · parallel calls now agree on both transports (round 1: ⛔ non-streamed) | ✅ native | ✅ **emulation works end to end** | ✅ 2 broken calls surfaced on **both** transports (round 1: ⛔ 1 of 2 lost non-streamed) |
| **03** vision | ✅ offered, image answered | ✅ affordance absent, image refused locally | ✅ same | ✅ same |
| **04** structured output | ✅ honoured and validated | ✅ **mismatch reported**, affordance withdrawn | ✅ same | ✅ same |
| **05** context overflow | ✅ clean error, `200000`/`250004` | ✅ `32768`/`40964` | ✅ `8192`/`10244` | ✅ `4096`/`5124` |
| **06** reasoning | ✅ separate field, never in the answer | ✅ split `</think>` never leaks | ✅ none emitted, none invented | ✅ unterminated block does not swallow the answer |
| **07** stream termination | ✅ **3.0 ms** | ✅ **3.4 ms** | ✅ **2.8 ms**, usage-absence declared | ✅ **3.6 ms**, missing sentinel declared |
| **08** malformed frames | ✅ no bad frames, none claimed | ✅ same | ✅ same | ✅ **166 chars delivered vs 31 for a strict consumer** |
| **09** no credential | ✅ nothing on the wire | ✅ same | ✅ same | ✅ same |
| **10** failover / mid-request kill | ✅ routed past a dead peer; killed stream **not** replayed | ✅ same | ✅ same | ✅ same |

✅ passes every assertion · ⚠️ degrades, explicitly · ⛔ **gate failure**

---

## 3. FINDING 1 — non-streamed tool calls collapse into one — **CLOSED in round 2**

**Severity: high. This is data loss on the ordinary path, not only the hostile one.**

> **Status: FIXED.** `2e4a4fc` gave the accumulator an explicit
> [`ToolCallShape`](../../../src-tauri/crates/vela-providers/src/tool_accum.rs) —
> stated by the caller that read the response, never guessed — so a
> `message.tool_calls[]` element opens its own slot and a `delta.tool_calls[]`
> element still joins its siblings by `index`. The three-part regression recipe
> named at the end of this section is implemented in
> `tests/parallel_tool_calls.rs`; the same three cases now also run **live, over
> real HTTP, against the mock matrix** in
> `tests/mock_matrix_live.rs::parallel_tool_calls_survive_both_transports_on_a_live_endpoint`
> and `::a_partly_broken_parallel_batch_loses_neither_the_good_calls_nor_the_bad_one`.
> Everything below is the round-1 report, kept verbatim as the before picture.

`ToolCallAccumulator::push` (`src/tool_accum.rs`) keys a delta by its wire
`index`, and when there is none it continues *the slot it last touched*:

```rust
// No index: continue the slot we were last working on, or open one.
None => match self.last_touched { Some(slot) => slot, … }
```

That rule is right for **streaming**, where an element of `delta.tool_calls` is a
*fragment* of a call and an unindexed fragment continues the previous one. It is
wrong for **non-streaming**, where every element of `message.tool_calls` is a
*whole, distinct call* and **none of them carries an `index` at all** — that field
does not exist in the non-streamed OpenAI shape.

So on the non-streamed path every tool call in the answer lands in slot 0, the
first `id` and `name` win, and the `arguments` strings are **concatenated**.

The file's own doc comment asserts the opposite, which is how this survived:

> ``raw`` is one element of `delta.tool_calls` (streaming) or of
> `message.tool_calls` (non-streaming) — the same shape, deliberately handled by
> the same code so the two paths cannot diverge.

The two shapes are not the same, and the two paths do diverge.

### Measured, live, on `hostile`

`hostile/02-tool-calling.txt`. The endpoint sent two calls in one non-streamed
body. Vela reported one:

```
tool calls   MALFORMED index=None id=call_c16f5968 name=get_weather
             reason=UnknownDiscriminator raw="{\"city\":\"delnot-json-at-all"
```

`{"city":"del` is the first call's truncated arguments; `not-json-at-all` is the
second call's. They have been spliced into a single string that never existed on
the wire, and shown to the user as evidence. The same request **streamed**, to
the same server, in the same file, reports both calls correctly. Two paths, one
endpoint, different answers.

### Measured on the shape that matters more

No matrix profile ever emits two *well-formed* calls, so the commonest
tool-calling shape in the wild — parallel tool calls — is invisible to the live
harness. `frontier/02-tool-calling.txt` therefore scripts it, in the OpenAI
shape, through the same accumulator (**scripted bytes, clearly labelled as such
in the transcript**):

| transport | sent | Vela reported |
|---|---|---|
| streamed (`index` 0 and 1) | `get_weather{"city":"berlin"}`, `get_weather{"city":"paris"}` | **2 executable calls** ✅ |
| non-streamed (no `index`) | the same two calls | **1 malformed call**, `raw="{\"city\":\"berlin\"}{\"city\":\"paris\"}"` ⛔ |

Two valid tool calls become one unusable one. Nothing is executed on a bad
reconstruction — `executable_tool_calls()` is empty and a
`MalformedToolCalls { count: 1 }` degradation is raised, so the user is not
silently given a *wrong* action. But **one entire call disappears with nothing
saying so**, and the surviving report is a splice of two different calls.

Against the gate criterion this is a **FAIL on "silently produces wrong output"**:
the count is wrong, the `raw_arguments` shown as evidence is fabricated, and a
turn that would have worked streamed fails non-streamed.

### Why the existing suite is green

`tests/mock_matrix_live.rs::malformed_tool_calls_are_surfaced_as_failed_calls`
uses `provider.stream(…)`; `a_well_formed_native_tool_call_is_executable` uses
`complete(…)` but every profile returns exactly one call there, and one call
cannot collide with itself. The unit tests in `tool_accum.rs` feed streaming
deltas. Nothing in the tree feeds the accumulator two unindexed whole calls.

### Not fixed here *(round 1; fixed in round 2 — see the status note above)*

This run produces evidence; the fix belongs to the crate's owner, following the
precedent of Phase A FINDING 1. The regression test it needs is exact:

* two elements, each with `id`, `type: "function"`, a `name` and complete
  `arguments`, **no `index` on either**, through `complete(…)` → two
  `ToolCallOutcome::Ok`;
* the streamed equivalent → the same two calls;
* `hostile` non-streamed → two `Malformed`, one `UnparseableArguments` and one
  `UnknownDiscriminator`, arguments **not** concatenated.

All three fail against the tree as it stands; the transcripts above are the
verbatim red. **Round 2: all three exist and pass, and each was proven red first
by reverting the one-line shape decision in `stream.rs` — that revert reproduces
the spliced `raw_arguments` quoted above.**

The likely shape of the fix — for the owner to judge, not the executor — is that
"continue the last slot" must apply only to the streaming path. A whole-call
element (one that carries `id` **or** a complete `function.name`, and no `index`)
opens its own slot.

---

## 4. What passed, and what the numbers were

Recorded because the absence of a failure is evidence too, and because several of
these are the exact hangs and losses the Phase A gate measured.

### No hangs anywhere (MEASURED-1)

| profile | `[DONE]` sent? | usage sent? | Vela's turn |
|---|---|---|---|
| frontier | yes | yes | **3.0 ms** |
| mid-local | yes | yes | **3.4 ms** |
| small-local | yes | **never** (it accepted `include_usage`) | **2.8 ms** |
| hostile | **never** | **never** | **3.6 ms** |

Against the recorded naive consumers: **5003 ms** and **5006 ms**, both timeouts.
`ASSERTION-CONTROL.txt` CONTROL 1 rebuilds the `[DONE]`-driven consumer on Vela's
own transport and runs it live: **hostile hung for 5.001 s** and delivered 0
characters, frontier finished in 13 ms. Vela finished hostile in 3.6 ms and
declared `NoTerminationSentinel` and `UsageNotReported` rather than pretending
either had arrived. Usage is never invented: `small-local` and `hostile` come
back with every token count `None`.

A socket that goes quiet is also abandoned rather than awaited: `07b`, with the
endpoint on a 4 s inter-frame delay and an 800 ms stall budget, ends in an
explicit error after **~810 ms** on all four profiles.

### No data loss from malformed frames (MEASURED-2)

`hostile/08-malformed-frames.txt`: 31 frames. Two are not valid JSON at all — a
frame truncated mid-`content` with a raw newline in it, and the literal
`not-json-at-all`. A third is valid JSON whose `choices` is the *string*
`"not-an-array"`, which is why Vela's count is one higher than the census's.

| consumer | delivered |
|---|---|
| strict `JSON.parse` on every frame (recomputed from the recorded bytes) | **31 characters** |
| Vela | **166 characters** — byte-identical to the non-streamed ground truth |

`MalformedFramesSkipped { count: 3 }` is raised, so the skip is declared rather
than absorbed. The tail of the answer, which arrives *after* the bad frames, is
present — that is the proof one bad frame did not end the stream.

### Reasoning never leaks, and never reaches the tool parser (MEASURED-3)

`mid-local` splits `</think>` across two frames — asserted directly against the
recorded frames: **no single frame contains the closing tag**. `hostile` opens
`<think>` twice, never closes it, and the answer inside it is recovered
(`UnterminatedReasoning { recovered_answer_chars: 166 }`) rather than swallowed.
`frontier`'s `reasoning_content` lands in the reasoning channel and nowhere else.
CONTROL 2 applies the same "no markup" assertion to the raw `content` channel —
what a frame-local stripper would have shown — and it FAILS on `mid-local` and
`hostile` while passing on `frontier`, which never touches that code path.

The stronger claim in the brief — *reasoning never reaches tool-call parsing* —
is proved live on `frontier` (`06-reasoning.txt`). With emulation active, so the
textual `<tool_call>` parser is running, `max_output_tokens: 4` cuts the answer
channel to `"Mock frontier re"` while the unbudgeted `reasoning_content` still
carries a complete `<tool_call>{name: echo_tool, arguments: {text: ok}}</tool_call>`.
Vela recovers **no** tool call. The positive control immediately below it — the
same markup, unsqueezed, in the answer channel — recovers the call, so the
assertion is not passing for the trivial reason that nothing is parsing.

On `mid-local` this probe is **not constructible** and the transcript says so
rather than omitting it: that profile carries reasoning inline in the same
budgeted `content` string, so no `max_output_tokens` separates the two channels.

### Structured output is never silently trusted (MEASURED-5)

All four profiles answer **200 OK**. `frontier` conforms; the other three return
prose. CONTROL 3 applies the conformance assertion directly to each answer and
records **1 PASS, 3 FAIL** — that is the danger, and nothing in any response says
so. Vela returns `structured: Some(Err(SchemaMismatch))` on the three, raises
`StructuredOutputMismatch`, and **remembers**: the model's `structured_output`
moves to `Degraded`, `honours_structured_output()` goes false, and the affordance
is not offered again. The streaming path validates identically. Under the default
`StructuredOutputPolicy::Refuse` a probed-bad model is refused **with zero HTTP
requests sent**.

### Explicit refusals, and the affordance follows the probe

An image to a probed vision-less model is `CapabilityUnsupported { Vision }`,
raised **locally with no request on the wire**, and `allows_failover()` is false.
`to_descriptor().vision` is false on those three profiles and true on `frontier` —
CONTROL 5 applies "the affordance is absent" to `frontier` and it correctly FAILS.
No profile name or backend identity appears anywhere in the flag set the renderer
receives.

`small-local` has no native tools and 400s even with `tool_choice: "none"`
(FINDING 6 of the Phase A gate). The control with emulation disabled confirms the
refusal is real; with emulation on, the catalogue moves into a system message, the
`tools` array is dropped, the textual call is parsed back out, the markup never
reaches the user, and `ToolCallingEmulated { tool_count: 1 }` is declared. The
turn ends in `ToolUse` exactly as a native one would.

### Context overflow, both directions

Every profile returns a clean `ContextLengthExceeded` carrying **its own two
numbers**, never failed over. When the window is known instead, a
three-windows-long conversation is reduced — `ContextReduced { dropped_messages: 17 }`
— and answered, rather than refused. CONTROL 7 applies the overflow assertion to a
5-character prompt and FAILS, so the assertion is not satisfied by accident.

### Credentials

Across every exchange in every case, with `Auth::None`: **no `authorization`
header, no api-key-shaped header of any other name, no credential in the query
string.** CONTROL 4 configures a bearer token on the same code path and the header
appears — the check is not vacuous. A binding that points at an empty keychain
produces `AuthFailed` with **zero requests sent**: an empty `Bearer` is never
constructed, which matters because the harness answers that with a 401
`empty_authorization_header` precisely to make the bug loud. An endpoint that does
demand a key (`09b`) yields `AuthFailed`, never retried, never failed over, with no
HTTP status or upstream body leaking into the error.

### Failover, including a provider killed mid-request

A candidate that refuses the connection is routed past in ~10 ms and the failover
is declared (`FailedOver { attempts: 2 }`).

The harder case the brief asks for — **kill a provider mid-request** — is `10`'s
second half: the primary streams with a 40 ms inter-frame delay and is `SIGKILL`ed
200 ms in, with a healthy second candidate configured behind it. On all four
profiles output had already been committed, the socket death surfaced as
`Transport { failure: Reset }` in ~205 ms, **zero requests reached the backup**,
and the turn was never reported as normally finished. That is router Rule 2
holding on a real killed process: once the user has seen output, replaying the
answer from another backend is worse than surfacing the error.

Worth stating precisely, because it is a design choice a critic should see: on
`frontier`, `mid-local` and `hostile` the only thing the user had seen at 200 ms
was **reasoning**, not answer text — and reasoning counts as committed, because it
is rendered. `small-local`, which emits no reasoning, had committed answer text.
Either way no replay happened.

---

## 5. The controls

`ASSERTION-CONTROL.txt` runs seven controls, 15 recorded verdicts, **10 of them
FAIL — every one the expected one**:

| control | applied where it should not hold | result |
|---|---|---|
| 1 | a `[DONE]`-driven consumer against `hostile` | **HUNG, 5.001 s** |
| 2 | "no `<think>` markup" against the raw content channel | **FAIL** on `mid-local`, `hostile`; PASS on `frontier` |
| 3 | "the answer conforms to the schema" against each profile | **FAIL** on three of four |
| 4 | "no authorization header" against a configured bearer token | **FAIL** |
| 5 | "the vision affordance is absent" against `frontier` | **FAIL** |
| 6 | "exactly one executable tool call" against `hostile` | **FAIL** |
| 7 | "the turn overflows the window" against a 5-character prompt | **FAIL** |

Control 2's discrimination is the interesting one: disabling reasoning separation
would break exactly the two profiles that carry it inline and **not** `frontier`,
which uses a separate field. An assertion that failed everywhere would be
measuring the harness, not the code.

---

## 6. Gate verdict

**Round 1: nine of the ten pieces PASS, one FAILS. Round 2: ten of ten PASS.**

| piece | verdict |
|---|---|
| 1. plain chat, streamed and not | **PASS** — identical on all four |
| 2. tool calling | **PASS in round 2** — native, emulated and parallel; streamed and non-streamed agree. Round 1 **FAILED** here (FINDING 1) |
| 3. vision | **PASS** — offered only where probed, refused locally elsewhere |
| 4. structured output | **PASS** — never silently conformant, on either transport |
| 5. context overflow | **PASS** — clean error, and visible reduction when the window is known |
| 6. reasoning | **PASS** — no leak, no swallow, excluded from tool parsing |
| 7. stream termination | **PASS** — 2.8–3.6 ms where a naive consumer hangs 5 s |
| 8. malformed frames | **PASS** — 166 characters against a strict consumer's 31 |
| 9. no credential | **PASS** — nothing on the wire, positively controlled |
| 10. failover | **PASS** — routes past a dead peer, refuses to replay a killed one |

**Round 1 overall: GATE M Part 1 (Phase B) does not pass.** One piece fails the
criterion, and a gate with a known failure is a failed gate. The failure is narrow,
precisely located, has a reproduction and a regression-test recipe, and does not
touch the degradation behaviours the gate exists to protect — but it is a real
defect on the most ordinary tool-calling shape there is, and calling this a pass
would be the kind of reporting this gate exists to prevent.

**Round 2 overall: GATE M Part 1 (Phase B) passes — 265 assertions, 0 failures**,
with the ten controls that are supposed to fail still failing. That is a pass of
*Part 1 only*. **GATE M Part 2 — a real llama.cpp endpoint — was not attempted and
remains deferred**, so nothing here has moved on the question of a real model.

---

## 7. What this run does NOT prove

* **Nothing about a real model.** Every endpoint is a mock. GATE M Part 2 stays
  deferred to the desktop session and is still the largest hole in the evidence
  base for the whole project.
* **Nothing about the OS keychain.** Exercised against `MemoryStore`.
* **Nothing about the packaged binary or the running app.** `conventions.md` §11.
* **Nothing about the Anthropic or Google adapters.** This run drives
  `OpenAiCompatibleProvider`, the backend all four matrix profiles speak. Those two
  adapters are pinned by fixture replay only and have no evidence document of
  their own — a gap the Phase B integration pass already recorded.
* **Nothing about sampling knobs.** `temperature`, `top_p`, `stop` and `seed` are
  sent and silently discarded by all four profiles, so no assertion here claims an
  effect that cannot be observed.
* **Nothing about prompt caching.** No matrix endpoint implements it; the
  capability stays `Unknown` on all four, and `Unknown` is not offerable.
* **Nothing about multi-call tool conversations.** Emulation's `render_results`
  round trip is not exercised here.

---

## 8. Reproducing

```bash
bash docs/regression-baseline/phase-b-matrix/record.sh   # round 2: exits 0
cd src-tauri && cargo test -p vela-providers             # the builders' own suite
```

Needs Node 22+ on `PATH`. The recorder is
`src-tauri/crates/vela-providers/examples/gate_m_phase_b.rs`; it starts and stops
its own servers on OS-assigned ports. Wall-clock lines and ephemeral port numbers
differ between runs; everything else is byte-stable.
