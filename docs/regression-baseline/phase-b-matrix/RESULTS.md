# GATE M Part 1 (Phase B) — does Vela degrade gracefully?

**Recorded:** 2026-08-13 · **Executor:** GATE M Part 1 Phase B evidence run
**Round 2 re-execution:** 2026-08-13 — **361 assertions, 16 failures, one defect**
**Subject:** `src-tauri/crates/vela-providers` — Vela's own provider stack
**Raw evidence:** `<profile>/00-…11-*.txt`, `verdicts.tsv`, `ASSERTION-CONTROL.txt`
**Companion:** `../mock-matrix/RESULTS.md` — what the endpoints did

> **Round 1 → round 2.** Round 1 FAILED on FINDING 1: parallel tool calls collapsing
> into one on the non-streamed path. Round 2 shipped a fix for that and a fix for a
> credential leak in provider errors. This document is a **fresh, independent
> re-execution** by an executor who wrote neither fix. It re-ran every round-1 case
> and added four new ones. **FINDING 1 is closed and now proved live rather than
> scripted. FINDING 2 is new: the credential fix does not cover the streaming path,
> and the gate fails on it.**

---

## Read this before you read anything else

**Every result below is VERIFIED-BY-FAKE** (`conventions.md` §10). The four
capability profiles are deterministic mock servers, started as real OS processes
and driven over real TCP by Vela's real HTTP client through Vela's real provider
layer — but they are mocks. **Not one byte came from a language model.**

**GATE M Part 2 — a real llama.cpp at :8033 on the operator's Windows host — is
unreachable from this container. It was not attempted and remains unverified.**
Nothing in this file is evidence about a real model.

---

## 1. The ledger

| | round 1 | round 2 (this directory) |
|---|---|---|
| gate assertions | 265 | **361** |
| failures | **5** — FINDING 1, one root cause | **16** — FINDING 2, one root cause |
| controls | 15, of which 10 FAIL | **24, of which 15 FAIL** — every one the expected one |
| wall clock, whole run | ~17 s | ~22 s |

```
gate assertions   361
failures          16
controls          24 (their FAILs are expected)
wall clock        21.762975632s
```

Per case, gate assertions across all four profiles:

| case | assertions | failures |
|---|---:|---:|
| 00 capability probe | 32 | 0 |
| 01 plain chat | 20 | 0 |
| 02 tool calling | 24 | 0 |
| **02p parallel tool calls** *(new)* | **43** | **0** |
| 03 vision | 17 | 0 |
| 04 structured output | 22 | 0 |
| 05 context overflow | 24 | 0 |
| 06 reasoning | 23 | 0 |
| 07 stream termination | 18 | 0 |
| 07b stalled socket | 8 | 0 |
| **07c termination latency** *(new)* | **16** | **0** |
| 08 malformed frames | 13 | 0 |
| 09 no credential | 28 | 0 |
| 09b endpoint requires a key | 12 | 0 |
| 10 failover | 24 | 0 |
| **11 credential leak** *(new)* | **37** | **16** |

`verdicts.tsv` carries every line. `SUMMARY.txt` carries the failure list.

---

## 2. The matrix — Vela's behaviour, per case, per profile

| case | frontier | mid-local | small-local | hostile |
|---|---|---|---|---|
| **00** capability probe | ✅ 200k · tools/vision/schema Supported | ✅ 32k · schema **Degraded**, vision Unsupported | ✅ 8k · tools **Unsupported**, schema Degraded | ✅ 4k · tools **Degraded**, schema Degraded |
| **01** plain chat, streamed ≡ whole | ✅ identical | ✅ identical | ✅ identical | ✅ identical |
| **02** tool calling | ✅ native | ✅ native | ✅ **emulation works end to end** | ✅ 2 broken calls on **both** transports |
| **02p** parallel tool calls | ✅ **3 calls, live, both transports agree** | ✅ same | ✅ **2 emulated calls, both transports agree** | ✅ **3 calls, middle one broken, both transports agree** |
| **03** vision | ✅ offered, image answered | ✅ affordance absent, image refused locally | ✅ same | ✅ same |
| **04** structured output | ✅ honoured and validated | ✅ **mismatch reported**, affordance withdrawn | ✅ same | ✅ same |
| **05** context overflow | ✅ clean error, `200000`/`250004` | ✅ `32768`/`40964` | ✅ `8192`/`10244` | ✅ `4096`/`5124` |
| **06** reasoning | ✅ separate field, never in the answer | ✅ split `</think>` never leaks | ✅ none emitted, none invented | ✅ unterminated block does not swallow the answer |
| **07** stream termination | ✅ terminates | ✅ | ✅ usage-absence declared | ✅ missing sentinel declared |
| **07c** termination latency | ✅ **median 2.4 ms** | ✅ **median 3.1 ms** | ✅ **median 3.3 ms** | ✅ **median 1.9 ms** |
| **08** malformed frames | ✅ no bad frames, none claimed | ✅ same | ✅ same | ✅ **166 chars delivered vs 31 for a strict consumer** |
| **09** no credential | ✅ nothing on the wire | ✅ same | ✅ same | ✅ same |
| **10** failover / mid-request kill | ✅ routed past a dead peer; killed stream **not** replayed | ✅ same | ✅ same | ✅ same |
| **11** credential leak | ⛔ **leaks on the streamed error-frame path** | ⛔ same | ⛔ same | ⛔ same |

✅ passes every assertion · ⚠️ degrades, explicitly · ⛔ **gate failure**

---

## 3. FINDING 1 — parallel tool calls collapse — **CLOSED, and now proved live**

Round 1's report is preserved in `git log` and in `tool_accum.rs`'s module docs.
The fix (`2e4a4fc`) gave the accumulator an explicit `ToolCallShape`, stated by
the caller that read the response and never guessed: a `message.tool_calls[]`
element opens its own slot, a `delta.tool_calls[]` element still joins its
siblings by `index`.

**This executor did not take that on trust, and did not re-use round 1's
evidence.** Round 1 could only *script* the parallel shape, and said so: the
mock harness answered every tool request with exactly one call, and one call
cannot collide with itself. That blindness is why the defect reached a gate.

The harness now answers a multi-tool request with a **batch**
(`tests/harness/mock-provider/src/reply-plan.ts::planToolCalls`), so case **02p**
offers three tools and drives the batch **live, over real TCP, on all four
profiles, on both transports** — 43 assertions, 0 failures.

What the wire actually carried, from `frontier/02p-parallel-tool-calls.txt`:

```
  non-streamed elements                  3
  any element carried `index`            false      <-- the FINDING 1 shape
    element 0 arguments                  "{\"city\":\"celsius\"}"
    element 1 arguments                  "{\"timezone\":\"fixture\"}"
    element 2 arguments                  "{\"ticker\":\"eastward\"}"
  streamed tool-call elements            20
  every streamed element carried `index` true
    wire index slot 0 arguments          "{\"city\":\"celsius\"}"
    wire index slot 1 arguments          "{\"timezone\":\"fixture\"}"
    wire index slot 2 arguments          "{\"ticker\":\"eastward\"}"
```

The two shapes genuinely differ — that is asserted, not assumed — and Vela
reports the same three calls from both. The comparison is **call by call**, not
by count: id, name, arguments and failure reason must match. `index` is
deliberately excluded and the transcript says why: it exists only in the
streamed shape, and demanding it match would be demanding the two shapes be the
same shape, which is the mistake FINDING 1 was.

Round 1's `hostile` case is also stronger now. The harness's parallel hostile
batch breaks **only the middle call**, which is what makes a lost call visible:

```
  non-streamed calls  OK id=call_36cb7766 name=get_weather emulated=false args={"city":"alpha"}
                      MALFORMED index=None    id=MISSING name=get_time reason=UnknownDiscriminator raw="{\"timezone\":\""
                      OK id=call_36cb7766_2 name=get_quote emulated=false args={"ticker":"eastward"}
  streamed calls      OK id=call_36cb7766 name=get_weather emulated=false args={"city":"alpha"}
                      MALFORMED index=Some(1) id=MISSING name=get_time reason=UnknownDiscriminator raw="{\"timezone\":\""
                      OK id=call_36cb7766_2 name=get_quote emulated=false args={"ticker":"eastward"}
```

Two good calls survive, the broken one is reported and is not executable, the
`MalformedToolCalls { count: 1 }` degradation is raised on **both** transports,
and no arguments string is a splice of two calls (asserted explicitly against
the set of strings the endpoint actually sent).

**Can this assertion still fail?** CONTROL 8 feeds the same three whole calls to
the same accumulator with round 1's rule restored and records the verbatim red:

```
  WholeCall (today)    calls reported=3  → PASS
  Fragment  (round 1)  calls reported=1  → FAIL
        MALFORMED id=call_a name=get_weather reason=UnparseableArguments
        raw="{\"city\":\"berlin\"}{\"city\":\"paris\"}{\"city\":\"rome\"}"
```

That spliced string never existed on any wire. FINDING 1 is reproducible on
demand, and case 02p is measuring something.

---

## 4. FINDING 2 — a query-string credential leaks through a mid-stream error frame — **GATE FAILURE**

**Severity: high. It fires on the default path (streaming), it reaches the shape
that crosses the IPC bridge, and it affects the one auth binding Vela's Google
adapter always uses.**

### What was configured, and what came back

`Auth::ApiKeyQuery { param: "key" }` with a distinctive canary in `MemoryStore`.
Seven failure paths were forced on every profile: connection refused (both
transports), first-byte timeout, TLS handshake failure, mid-stream reset (both
transports), a 400 whose error body quotes the request target, and a **200 SSE
stream whose only frame is `{"error":{"message": …}}` quoting the request
target**. Every rendering of every resulting `ProviderError` was grepped.

Six of the seven are clean. The seventh is not — verbatim from
`frontier/11-credential-leak.txt`:

```
---- forced failure — the endpoint echoes the URL back (200 + error frame) -
  variant                                malformed_response
  Display        "the endpoint returned a response Vela could not read: upstream request
                  failed: POST /v1/chat/completions?key=vela%2Bgate%2Fm1-7Q2Xz9f3a-DO-NOT-LEAK"
  Debug          "MalformedResponse { detail: \"upstream request failed: POST
                  /v1/chat/completions?key=vela%2Bgate%2Fm1-7Q2Xz9f3a-DO-NOT-LEAK\" }"
  serde_json (THE IPC WIRE SHAPE)
                 "{\"kind\":\"malformedResponse\",\"detail\":\"upstream request failed: POST
                  /v1/chat/completions?key=vela%2Bgate%2Fm1-7Q2Xz9f3a-DO-NOT-LEAK\"}"
```

The credential is in **all five** renderings, and in the **`CollectingSink` event
stream** the UI is handed (`StreamEvent::Error`). Four gate assertions fail on
each of the four profiles: the rendering check, the serde check, the sink check,
and the bare-transport confirmation below.

### Why, precisely

`redact.rs`'s module doc states the rule the fix was built on:

> **[`Scrubber`] is the belt to that pair of braces.** Any text derived from a
> request — a `reqwest` error string, an error body an endpoint echoed back at
> us — is passed through the needles the request itself carries before it
> becomes a `detail`.

For **streamed** error bodies that is not true. The scrubber is applied in
exactly two places:

* `http.rs::map_reqwest_error` — the `reqwest` error string. ✅
* `http.rs::HttpResponse::read_to_end` — `Ok(self.body.scrubber().scrub_bytes(out))`. ✅

`read_to_end` is the **non-streamed** body path. The streamed path reads frames
through `ByteStream::next_chunk`, and `ReqwestBody::next_chunk` returns the
bytes unmodified:

```rust
async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
    match self.response.chunk().await {
        Ok(Some(bytes)) => Ok(Some(bytes.to_vec())),   // <-- not scrubbed
        Ok(None) => Ok(None),
        Err(error) => Err(map_reqwest_error(error, &self.scrubber)),
    }
}
```

so `stream.rs::error_from_body` → `openai_compatible::map_error_code` →
`ProviderError::malformed(message)` carries the endpoint's text — credential
included — straight into `detail`. `detail()` truncates and strips control
characters; it does not redact, which is the exact observation the round-2 fix
was written on.

**All three adapters share the shape.** `openai_compatible/../stream.rs:123`,
`google/stream.rs:193` and `anthropic/stream.rs:208` each take an `{"error": …}`
object out of an otherwise-200 stream and hand its `message` to a mapper that
builds a `detail`. Google is the most exposed: `?key=` is the only binding it
has (`google/provider.rs:1061`).

### It is not the recorder

An earlier draft of this run reported a leak on the **non-streamed** echo too.
That one was the recorder's fault: `RecordingTransport`'s `Tee` body implements
`ByteStream` but did not forward `scrubber()`, and the trait defaults it to
`Scrubber::none()`, so wrapping the real body silently disabled the redaction.
The recorder was fixed (`Tee::scrubber` now forwards, with a comment saying
why), the non-streamed echo went clean, and the streamed one did not.

Because a decorator is exactly the sort of thing that can invent a leak, the
streamed echo is repeated in the same transcript on a **bare `ReqwestTransport`
with nothing wrapping it**:

```
---- the same streamed echo on a BARE ReqwestTransport (no recorder in the path)
  bare Display   "the endpoint returned a response Vela could not read: upstream request
                  failed: POST /v1/chat/completions?key=vela%2Bgate%2Fm1-7Q2Xz9f3a-DO-NOT-LEAK"
  [FAIL] NO CREDENTIAL in an error produced with no recorder anywhere in the path
```

The defect is Vela's.

**This is a finding about the recorder worth keeping too:** `ByteStream::scrubber()`
is a security property carried by an overridable method whose default is "no
protection". Any future decorating body — a rate limiter, a cache, a replayer —
disables the redaction by omission and nothing complains.

### Why the builders' own canary suite is green

`crates/vela-providers/tests/credential_canary.rs` passes, and so does the whole
crate — **438 passed, 0 failed, 1 ignored**. The canary suite covers:

* `assert_every_endpoint_is_clean` — five endpoints, **both** transports, but all
  five are *transport* failures. No endpoint in that list echoes anything.
* `an_endpoint_that_echoes_the_key_back_does_not_get_it_into_an_error` — a real
  echo, but a **400** driven through **`complete()` only**, which is the
  `read_to_end` path that is correctly scrubbed.

Nothing in the tree drives an echoed credential through a **200 + in-stream error
object**. That is the shape, and it is the same class of blind spot as round 1's:
the suite tests the path the author was thinking about.

### The regression recipe

Exact, and each part fails against the tree as it stands:

1. A 200 SSE body whose only frame is `{"error":{"message":"… ?key=<canary> …"}}`,
   through `provider.stream(…)`, on `OpenAiCompatibleProvider` with
   `Auth::ApiKeyQuery` → the canary must appear in **none** of `Display`,
   `Debug`, `serde_json`, or any `StreamEvent` reaching the sink.
2. The same, on `GoogleProvider` (whose only binding is `?key=`) and on
   `AnthropicProvider` with `Auth::ApiKeyHeader` — the header binding puts
   needles in the scrubber too, so it should be covered by the same fix.
3. A positive control on the identical path with `Auth::None`, asserting the
   error still carries the endpoint's message, so the fix is a redaction and not
   a blanket "drop the detail".

The likely shape of the fix — for the crate's owner to judge, not the executor —
is that the scrubber belongs where the frame text becomes a `detail`, or that
`next_chunk` should scrub the way `read_to_end` does. The second is the smaller
change and the harder one to forget, but it scrubs every streamed byte rather
than only error text, which is a cost worth weighing.

---

## 5. What passed, and what the numbers were

### Termination is single-digit milliseconds (MEASURED-1, sharpened)

Case **07c** takes five samples per profile and asserts the **median**, printing
every sample so the spread is visible rather than summarised away.

| profile | median | worst of five | `[DONE]` sent? | usage sent? |
|---|---|---|---|---|
| frontier | **2.42 ms** | 3.46 ms | yes | yes |
| mid-local | **3.07 ms** | 3.79 ms | yes | yes |
| small-local | **3.33 ms** | 15.79 ms | yes | **never** (it accepted `include_usage`) |
| hostile | **1.90 ms** | 2.75 ms | **never** | **never** |

Against the recorded naive consumers: **5003 ms** and **5006 ms**, both timeouts.
CONTROL 1 rebuilds the `[DONE]`-driven consumer on Vela's own transport and runs
it live: **hostile hung for 5.001 s** and delivered 0 characters; frontier
finished in 12.6 ms. The one
outlier — small-local's 15.79 ms worst sample — is container scheduling noise
and is printed rather than hidden; the median assertion is what the gate reads,
and CONTROL 11 shows the same assertion failing at 810 ms on a stalled socket, so
it is not satisfied by every code path being fast.

A socket that goes quiet is still abandoned rather than awaited: `07b`, with the
endpoint on a 4 s inter-frame delay and an 800 ms stall budget, ends in an
explicit error after **~810 ms** on all four profiles.

### Prompt-emulated tool calling still works end to end, and now in parallel

`small-local` has no native tools and 400s even with `tool_choice: "none"`. Case
02 shows the single-call emulation round trip unchanged: catalogue into a system
message, `tools` array dropped, textual call parsed back out, markup never shown,
`ToolCallingEmulated` declared, turn ends in `ToolUse`. The control with
emulation disabled confirms the refusal is real.

Case 02p adds the **parallel** emulated batch: two `<tool_call>` blocks in one
answer, recovered as two executable calls with their own arguments, **identical
on both transports**, markup never reaching the user.

**A harness limit, stated rather than papered over.** `small-local` echoes back
only the first eight whitespace-delimited words of the prompt, hard-capped at 120
characters (`reply-plan.ts::firstWords`). The ordinary spelling of a two-call
prompt is cut off mid-way through the second call, and the first draft of this
case failed for that reason — Vela correctly reported one good call and one
`UnparseableArguments`, on both transports, which was the mock truncating, not
Vela losing anything. The prompt was shortened to fit inside 120 characters.
**What this proves is the parser and the round trip; it does not prove that two
emulated calls survive an answer longer than 120 characters, because this harness
cannot produce one.**

### No data loss from malformed frames (MEASURED-2)

`hostile/08-malformed-frames.txt`: 31 frames, three unusable. Strict `JSON.parse`
on every frame delivers **31 characters**; Vela delivers **166** — byte-identical
to the non-streamed ground truth — and raises `MalformedFramesSkipped { count: 3 }`.

### Reasoning never leaks, and never reaches the tool parser (MEASURED-3)

Unchanged from round 1 and re-measured: `mid-local` splits `</think>` across two
frames (asserted against the recorded frames), `hostile` opens `<think>` twice and
never closes it and the answer is recovered rather than swallowed, `frontier`'s
`reasoning_content` lands in the reasoning channel and nowhere else. CONTROL 2
applies "no markup" to the raw `content` channel and FAILS on exactly the two
profiles that carry reasoning inline.

### Structured output is never silently trusted (MEASURED-5)

All four profiles answer **200 OK**; `frontier` conforms, the other three return
prose. CONTROL 3 records **1 PASS, 3 FAIL** applying conformance directly. Vela
returns `structured: Some(Err(SchemaMismatch))`, raises
`StructuredOutputMismatch`, moves the model's `structured_output` to `Degraded`,
and refuses the affordance thereafter with zero HTTP requests sent.

### Explicit refusals, context overflow, failover

Unchanged from round 1 and re-measured green: vision refused locally with no
request on the wire where unprobed; a clean `ContextLengthExceeded` carrying each
profile's own two numbers; `ContextReduced { dropped_messages: 17 }` when the
window is known; a dead peer routed past in ~10 ms with `FailedOver { attempts: 2 }`;
and a provider `SIGKILL`ed mid-request surfacing as `Transport { failure: Reset }`
in ~205 ms with **zero requests reaching the backup**, because output had already
been committed.

### Credentials, other than FINDING 2

With `Auth::None`: no `authorization` header, no api-key-shaped header of any
other name, no credential in the query string, across every exchange of every
case. CONTROL 4 configures a bearer token on the same path and the header
appears. An empty keychain produces `AuthFailed` with **zero requests sent**. An
endpoint that demands a key (`09b`) yields `AuthFailed`, never retried, never
failed over.

For `Auth::ApiKeyQuery` specifically, case 11 records what **is** safe:
connection refused, first-byte timeout, TLS handshake failure and mid-stream
reset are clean on both transports, and so is a 400 whose error body quotes the
key. `RequestUrl`'s `Display` and `Debug` render `?key=<redacted>`. Only the
streamed error-frame path leaks.

**The IPC boundary, recorded rather than assumed:** there is no `provider_*`
command on the Rust allowlist and none in `contract.ts`, so no `ProviderError`
crosses the bridge today. FINDING 2's leak surface is **latent, not live** — but
the leaking value is the `serde` rendering, which is precisely what a future
`provider_stream` command would serialise into the WebView.

---

## 6. The controls

`ASSERTION-CONTROL.txt` runs eleven controls, **24 recorded verdicts, 15 of them
FAIL — every one the expected one** (round 1: 15 verdicts, 10 FAIL).

| control | applied where it should not hold | result |
|---|---|---|
| 1 | a `[DONE]`-driven consumer against `hostile` | **HUNG, 5.001 s** |
| 2 | "no `<think>` markup" against the raw content channel | **FAIL** on `mid-local`, `hostile`; PASS on `frontier` |
| 3 | "the answer conforms to the schema" against each profile | **FAIL** on three of four |
| 4 | "no authorization header" against a configured bearer token | **FAIL** |
| 5 | "the vision affordance is absent" against `frontier` | **FAIL** |
| 6 | "exactly one executable tool call" against `hostile` | **FAIL** |
| 7 | "the turn overflows the window" against a 5-character prompt | **FAIL** |
| **8** | "every parallel call comes back" with round 1's rule restored | **FAIL** — one spliced call, verbatim |
| **9** | "the credential is not in this text" against `expose()` and the pre-fix detail string | **FAIL** on both; PASS on the two redacted renderings |
| **10** | "the two transports agree" against a deliberately truncated batch | **FAIL** |
| **11** | "termination in single-digit ms" against a stalled socket | **FAIL, 810 ms** |

Controls 8 and 10 are the ones that matter for round 2's central claim: they show
that if the parallel-tool-call fix were reverted, or if the two transports
disagreed, **this run would go red**. Round 1's tool-call comparison checked only
the *count*, which on the three profiles that emit a single call compares 1 to 1
and can never fail.

---

## 7. Gate verdict

**Round 2: ten of the eleven pieces PASS, one FAILS.**

| piece | verdict |
|---|---|
| 1. plain chat, streamed and not | **PASS** — identical on all four |
| 2. tool calling, including **parallel** | **PASS** — native, emulated and parallel; live on all four profiles; both transports agree call by call. Round 1's FINDING 1 is closed and reproducible on demand |
| 3. vision | **PASS** — offered only where probed, refused locally elsewhere |
| 4. structured output | **PASS** — never silently conformant, on either transport |
| 5. context overflow | **PASS** — clean error, and visible reduction when the window is known |
| 6. reasoning | **PASS** — no leak, no swallow, excluded from tool parsing |
| 7. stream termination | **PASS** — medians 1.9–3.3 ms where a naive consumer hangs 5 s |
| 8. malformed frames | **PASS** — 166 characters against a strict consumer's 31 |
| 9. no credential | **PASS** — nothing on the wire, positively controlled |
| 10. failover | **PASS** — routes past a dead peer, refuses to replay a killed one |
| **11. credentials in errors** | ⛔ **FAIL** — a query-string credential reaches `Display`, `Debug`, the serde JSON and the event sink through a mid-stream error frame, on all four profiles |

**GATE M Part 1 (Phase B) does not pass.**

The gate criterion asks whether any piece crashes, hangs, silently produces wrong
output, or offers an affordance the profile cannot support. FINDING 2 is none of
those four literally — and it is a gate failure anyway, because the thing it
produces silently and wrongly is a *credential in a place credentials must never
be*, in the one binding whose entire risk model (`Concern::QueryParamCredentialIsLogged`,
`RiskLevel::Elevated`) is built on that value being handled carefully. A gate that
watched a fix land for exactly this leak, in exactly this crate, and then passed
the tree while the same leak survives one path over, would be the kind of
reporting this gate exists to prevent.

The failure is narrow, precisely located, has a live reproduction, a bare-transport
confirmation that rules out the instrumentation, and a three-part regression recipe.
It does not touch the degradation behaviours the gate exists to protect, and it does
not reopen FINDING 1.

**Nothing here has moved on GATE M Part 2** — a real llama.cpp endpoint — which was
not attempted and remains deferred to the desktop session.

---

## 8. What this run does NOT prove

* **Nothing about a real model.** Every endpoint is a mock. GATE M Part 2 stays
  deferred and is still the largest hole in the evidence base for the project.
* **Nothing about the OS keychain.** Exercised against `MemoryStore`.
* **Nothing about the packaged binary or the running app.** `conventions.md` §11.
* **Nothing about the Anthropic or Google adapters' runtime behaviour.** This run
  drives `OpenAiCompatibleProvider`. FINDING 2's reach into those two is argued
  from their source (`google/stream.rs:193`, `anthropic/stream.rs:208`), not
  measured — which is why the regression recipe asks for them explicitly.
* **Nothing about emulated tool calls in a long answer.** The `small-local` mock
  echoes at most 120 characters, so a two-call emulated batch had to be written
  to fit inside that. §5 states the limit.
* **Nothing about sampling knobs.** `temperature`, `top_p`, `stop` and `seed` are
  sent and silently discarded by all four profiles.
* **Nothing about prompt caching.** No matrix endpoint implements it; the
  capability stays `Unknown`, and `Unknown` is not offerable.
* **Nothing about multi-call tool conversations.** Emulation's `render_results`
  round trip is still not exercised here.

---

## 9. Reproducing

```bash
bash docs/regression-baseline/phase-b-matrix/record.sh   # round 2: exits 1, see FINDING 2
cd src-tauri && cargo test -p vela-providers             # the builders' own suite: 438 passed, 0 failed
```

Needs Node 22+ on `PATH`. The recorder is
`src-tauri/crates/vela-providers/examples/gate_m_phase_b.rs`; it starts and stops
its own servers on OS-assigned ports, including four raw TCP peers of its own for
case 11. Wall-clock lines and ephemeral port numbers differ between runs;
everything else is byte-stable.

The credential canary `vela+gate/m1-7Q2Xz9f3a-DO-NOT-LEAK` is a fake string that
was never a credential for anything. The recorder asserts it appears in no
per-profile transcript except `11-credential-leak.txt`, so a future run that
leaked it into another case's evidence would fail the gate rather than sit here
unnoticed.
