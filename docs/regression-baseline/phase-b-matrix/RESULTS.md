# GATE M Part 1 (Phase B) — does Vela degrade gracefully?

**Recorded:** 2026-08-13 · **Executor:** GATE M Part 1 Phase B evidence run
**Round 3 re-execution:** 2026-08-13 — **373 gate assertions, 0 failures**
**Subject:** `src-tauri/crates/vela-providers` — Vela's own provider stack
**Raw evidence:** `<profile>/00-…11-*.txt`, `verdicts.tsv`, `ASSERTION-CONTROL.txt`,
`structural/probe-results.txt`, `structural/control-results.txt`
**Companion:** `../mock-matrix/RESULTS.md` — what the endpoints did

> **Rounds 1 → 2 → 3.** Round 1 FAILED on FINDING 1 (parallel tool calls
> collapsing on the non-streamed path). Round 2 closed FINDING 1 and opened
> FINDING 2: a query-string credential leaking through a mid-stream error frame
> on the streamed path — 16 failures, all one defect. Round 3 claims to have
> closed FINDING 2 **structurally** and to have stopped over-redacting transport
> errors. This document is a **third, independent re-execution** by an executor
> who wrote none of the three fixes and ran neither previous round. It re-ran
> every case, drove the leak through every forced failure path on all three
> adapters, attacked the structural claim rather than reading it, and fixed two
> defects in its own instrumentation along the way.
>
> **FINDING 1 stays closed. FINDING 2 is closed. GATE M Part 1 (Phase B) PASSES.**

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

| | round 1 | round 2 | **round 3 (this directory)** |
|---|---|---|---|
| gate assertions | 265 | 361 | **373** |
| failures | **5** — FINDING 1 | **16** — FINDING 2 | **0** |
| recorder controls | 15, of which 10 FAIL | 24, of which 15 FAIL | **24, of which 15 FAIL** |
| executor controls | — | — | **8 experiments → 21 recorded expected-FAILs** |
| **controls, total** | 15 / 10 FAIL | 24 / 15 FAIL | **32 / 36 expected FAILs** |
| wall clock, matrix run | ~17 s | ~22 s | ~21.9 s |

```
gate assertions   373
failures          0
controls          24 (their FAILs are expected)
wall clock        21.940479445s

No gate assertion failed.
```

Per case, gate assertions across all four profiles:

| case | assertions | failures |
|---|---:|---:|
| 00 capability probe | 32 | 0 |
| 01 plain chat | 20 | 0 |
| 02 tool calling | 24 | 0 |
| 02p parallel tool calls | 43 | 0 |
| 03 vision | 17 | 0 |
| 04 structured output | 22 | 0 |
| 05 context overflow | 24 | 0 |
| 06 reasoning | 23 | 0 |
| 07 stream termination | 18 | 0 |
| 07b stalled socket | 8 | 0 |
| 07c termination latency | 16 | 0 |
| 08 malformed frames | 13 | 0 |
| 09 no credential | 28 | 0 |
| 09b endpoint requires a key | 12 | 0 |
| 10 failover | 24 | 0 |
| **11 credential canary** | **49** *(was 37)* | **0** *(was 16)* |

Case 11 grew by 12 because the executor replaced one broken vacuity guard with
three working ones — see §4.1.

`verdicts.tsv` carries every line. `SUMMARY.txt` carries the (empty) failure list.

Beyond the matrix, run separately and recorded in `structural/`:

```
cargo test -p vela-providers                469 passed, 0 failed, 1 ignored
  incl. streamed_credential_canary          15 passed
        finding_two_recipe                   4 passed
        credential_canary (round 2's)        8 passed
        zz_gate_m_round3_executor_probe      5 passed   <- the executor's own
  doctests, incl. 2 compile_fail             3 passed
structural/probe.sh                          5 of 5 bypasses rejected
pnpm verify                                  exit 0 (whole gate, superset of CI)
```

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
| **07c** termination latency | ✅ **median 3.34 ms** | ✅ **median 3.51 ms** | ✅ **median 1.74 ms** | ✅ **median 3.36 ms** |
| **08** malformed frames | ✅ no bad frames, none claimed | ✅ same | ✅ same | ✅ **166 chars delivered vs 31 for a strict consumer** |
| **09** no credential | ✅ nothing on the wire | ✅ same | ✅ same | ✅ same |
| **10** failover / mid-request kill | ✅ routed past a dead peer, **and the dead peer is named**; killed stream **not** replayed | ✅ same | ✅ same | ✅ same |
| **11** credential canary | ✅ **clean on all 9 forced paths, 5 renderings each** | ✅ same | ✅ same | ✅ same |

✅ passes every assertion · ⚠️ degrades, explicitly · ⛔ gate failure

---

## 3. FINDING 1 — parallel tool calls collapse — **STILL CLOSED**

Re-executed, not carried forward. Case **02p** offers three tools, drives the
batch live over real TCP on all four profiles on both transports, and compares
**call by call** — id, name, arguments, failure reason. 43 assertions, 0
failures, and the two wire shapes are asserted to genuinely differ rather than
assumed to:

```
  non-streamed elements                  3
  any element carried `index`            false      <-- the FINDING 1 shape
  streamed tool-call elements            20
  every streamed element carried `index` true
```

The hostile batch still breaks only the middle call; two good calls survive, the
broken one is reported and is not executable, `MalformedToolCalls { count: 1 }`
is raised on **both** transports, and no arguments string is a splice of two
calls. CONTROL 8 restores round 1's rule against the same three whole calls and
records **one** spliced call — a string that never existed on any wire.

---

## 4. FINDING 2 — a credential leaking through a mid-stream error frame — **CLOSED**

Round 2's report and its regression recipe are preserved in `git log` (commits
`5845d29`, `b9ca371`) and quoted in `conventions.md` §9. The claim under test in
round 3 is not "the leak is patched" but "**an unscrubbed read is not
expressible**". Those are different claims and were checked differently.

### 4.1 The instrumentation was wrong first, twice — both fixed, not filed

Two false signals came out of the executor's own tooling. Both are recorded here
because round 2's most valuable finding was of exactly this kind.

**(a) The recorder's premise check went red against a clean tree.** The first
round-3 matrix run reported **4 failures**, one per profile, all of them:

```
frontier / 11-credential-leak / at least one peer really did echo the credential
    back — the echo cases are real
      []
```

That guard existed to stop the leak assertions passing vacuously, and it read
the endpoint's echo off the **recorder's body tee**. Round 3's fix scrubs inside
`BodyStream::next_chunk`, *before any decorator can see a byte* — so the tee
stopped being able to observe the endpoint's echo at all. The guard was correct
about what it measured and wrong about what it meant.

The fix is to ask the peer, which is upstream of everything Vela does:
`RawPeer` now records its own send buffer, and the premise is asserted there.
That turned one broken guard into three working ones, and one of them is
stronger than anything either previous round had — see §4.2.

**(b) The executor's own compile probes were too coarse.** Three bypass attempts
(a sealed field, an `into_inner`, a `BodyStream` used as a raw stream) started
life in one file. Under the DEFECT 3 control — `BodyStream::inner` made public —
that file *still failed to compile*, on the other two hatches, and the probe
reported "rejected" against a tree that had the hole. One hatch per file now,
and the control catches it: `probe-03-private-field COMPILED (correctly
detected)`.

### 4.2 The leak, driven

**In the recorder (case 11), all four profiles.** Nine forced failure paths with
`Auth::ApiKeyQuery { param: "key" }` and a distinctive canary in `MemoryStore`:
connection refused (both transports), first-byte timeout, TLS handshake failure,
mid-stream reset (both transports), a 400 whose error body quotes the request
target, **a 200 SSE stream whose only frame is an `{"error":{"message": …}}`
quoting the request target** (both transports). Every rendering of every
resulting `ProviderError` is grepped — `Display`, `Debug`, `Debug` alternate,
`serde_json`, `serde_json` pretty — plus the `CollectingSink` event stream and
the transport's own normalised failure detail.

The path that failed in round 2, verbatim from `frontier/11-credential-leak.txt`:

```
---- forced failure — the endpoint echoes the URL back (200 + error frame) -
  variant                                malformed_response
  Display        "the endpoint returned a response Vela could not read: upstream request
                  failed: POST /v1/chat/completions?key=<redacted>"
  Debug          "MalformedResponse { detail: \"upstream request failed: POST
                  /v1/chat/completions?key=<redacted>\" }"
  serde_json (THE IPC WIRE SHAPE)
                 "{\"kind\":\"malformedResponse\",\"detail\":\"upstream request failed: POST
                  /v1/chat/completions?key=<redacted>\"}"
```

Repeated on a **bare `ReqwestTransport` with nothing wrapping it** — because a
decorator is exactly the sort of thing that can invent or hide a leak — with the
same result:

```
---- the same streamed echo on a BARE ReqwestTransport (no recorder in the path)
  bare Display   "…: upstream request failed: POST /v1/chat/completions?key=<redacted>"
  [PASS] NO CREDENTIAL in an error produced with no recorder anywhere in the path
```

**The premise, and the byte-level proof.** This is the part round 2 could not
produce. Each peer's own send buffer is checked, and then the same bytes are
checked one layer further in — at the recorder's tee, which since round 3 sits
*outside* `BodyStream` and therefore sees exactly what Vela's SSE parser
consumes:

```
---- what the ENDPOINT sent back (the premise, not the verdict) --------------
  peer `400 error body` put the credential on the wire                   true
  peer `200 + error frame` put the credential on the wire                true
  peer `200 + error frame (bare transport)` put the credential on the wire true
  [PASS] at least one peer really did echo the credential back — the echo cases are real
  [PASS] ALL THREE echo peers echoed it — no echo case is vacuous

---- what VELA read (the same bytes, one layer further in) -------------------
  `… (200 + error frame)` as the parser saw it
     "data: {\"error\":{\"code\":\"server_error\",\"message\":\"upstream request failed:
      POST /v1/chat/completions?key=<redacted>\"}}\n\ndata: [DONE]\n\n"
  [PASS] the credential is ALREADY GONE from the bytes Vela's parser reads
  [PASS] and the redaction marker IS there — the body was not merely empty
```

The endpoint wrote the key; the parser read `<redacted>`. The scrub is not a
property of the error-formatting code, it is a property of the byte stream.

**On all three adapters.** The recorder drives `OpenAiCompatibleProvider` only.
The three-adapter coverage is `tests/streamed_credential_canary.rs` — **seven**
forced failures × **three** adapters × **two** bindings × **two** transports,
four surfaces each, 15 tests — audited by this executor rather than trusted, and
supplemented where the audit found a gap:

* its wide matrix counts *cases*, not *echoes*, so for five of the six
  adapter/binding pairs "no leak" and "the endpoint was never sent one" were not
  distinguished. `zz_gate_m_round3_executor_probe.rs::every_adapter_really_was_echoed_a_credential_and_really_redacted_it`
  closes that: per adapter, per transport, it asserts the endpoint's diagnostic
  marker **survived**, `<redacted>` **is present** (so there was a secret to
  remove), and the canary **is gone**. 6 of 6 checked.
* the executor's probe uses **its own canary literal**, so a fix that
  special-cased the string in the builder's test would not pass it.

### 4.3 The structural claim, attacked

Round 3's claim is that redaction no longer hangs off an overridable method
defaulting to no protection: `ByteStream::scrubber()` is gone, `BodyStream` is a
struct that seals the raw stream and cannot be built without a `BodyOrigin`, and
`BodyStream::next_chunk` is the single exit.

**Compile-time.** Five bypasses, written by the executor, compiled as real
examples against the real crate (`structural/probe.sh`, output in
`structural/probe-results.txt`). Every one is rejected, and for the predicted
reason:

| probe | the bypass | verdict |
|---|---|---|
| 01 | `let _body: BodyStream = Box::new(Forgetful);` — the round-2 shape | rejected, **E0308** |
| 02 | declaring `fn scrubber(&self) -> Scrubber` on a `ByteStream` impl — the literal line the recorder omitted | rejected, **E0407** |
| 03 | reaching the sealed field: `&mut body.inner` | rejected, **E0616** *field is private* |
| 04 | a consuming `body.into_inner()` | rejected, **E0599** *no method* |
| 05 | passing a `BodyStream` where `impl ByteStream` is wanted | rejected, **E0277** *trait bound not satisfied* |

Probes 03–05 matter beyond the two `compile_fail` doctests the builder shipped:
they are the three ways a decorator author would actually try to get at raw
bytes, and all three are closed by the type rather than by a comment.

**Runtime.** `LaunderingTransport` in the executor's probe is the worst decorator
the current API permits: it wraps the real transport, wraps the real body in a
`ByteStream` that forwards **nothing**, and re-wraps that with
`BodyOrigin::carries_no_credential()` — an origin that actively asserts there is
no secret to remove. Under round 2's API this was enough to disable redaction
entirely, and it is what happened to the gate's own recorder mid-round-2.

The assertion is made on **the decorator's own tee**, not on the error at the far
end of the pipeline — "the bytes were already clean when the most hostile
decorator this API permits first touched them":

```
what_the_decorator_itself_saw ......................... ok
a_decorator_that_forwards_nothing_and_lies_about_its_origin_changes_nothing ... ok
```

The second one also asserts the laundered error is **string-identical** to the
undecorated one, on all three adapters, so the decorator cannot have changed what
was readable in either direction.

**Verdict on the claim: it holds.** The executor could not write a body that
silently bypasses redaction. Two residual observations, neither a gate failure:

* `BodyOrigin::carries_no_credential()` and `BodyOrigin::default()` will produce
  an unscrubbed body if handed a raw stream — but only from inside a
  **transport**, which owns its bytes anyway, and only by typing out a named
  claim. A *decorator* cannot reach a raw stream at all (probes 03–05).
* `#[derive(Default)]` on `BodyOrigin` makes `BodyOrigin::default()` a quieter
  spelling of that named claim. Cosmetic; noted for the crate's owner.

### 4.4 The other direction — over-redaction — also closed

Round 2 removed the credential by removing the endpoint. The three rounds, from
`frontier/10-failover.txt` at each round's commit, verbatim from `git show`:

```
round 1  be4f1d8   <<< NO RESPONSE — Connect: error sending request for url (http://127.0.0.1:1/v1/chat/completions)
round 2  81b5b8f   <<< NO RESPONSE — Connect: error sending request
round 2  5845d29   <<< NO RESPONSE — Connect: error sending request
round 3  (this)    <<< NO RESPONSE — Connect: error sending request for url (http://127.0.0.1:1/v1/chat/completions)
```

Round 1's diagnosis is back, and now it is safe: with a query credential the same
line reads `…/v1/chat/completions?key=<redacted>`, from
`frontier/11-credential-leak.txt`. **Silence would have been the regression; a
redacted URL is the correct answer.**

The user-facing form of the requirement — *a user with three candidates
configured must be able to tell them apart* — is asserted directly rather than
inferred, in `three_configured_candidates_produce_three_distinguishable_errors`:
three dead loopback ports, three errors, each naming its own authority **and its
request target**, each carrying `<redacted>` rather than nothing, and all three
**pairwise distinct**. Naming *an* endpoint is not enough; the three strings have
to differ.

`with_no_credential_configured_nothing_is_redacted_at_all` is the control that
tells redaction apart from deletion: same endpoint, same message, `Auth::None`,
nothing redacted, the endpoint's diagnostic verbatim, on all three adapters.

### 4.5 A correction to round 2's own table

RESULTS.md round 2 §4 predicted that re-introducing defect 1 would leave round
2's `credential_canary.rs` at **8 pass**. Measured on the round-3 tree it is
**7 pass, 1 fail** — `an_endpoint_that_echoes_the_key_back_does_not_get_it_into_an_error`
goes red. The reason is the fix itself: `read_to_end` no longer scrubs
separately, because everything it reads has already come through
`BodyStream::next_chunk`. There is now one door, so breaking it breaks both
paths. That is a strict improvement in coverage and it makes round 2's prediction
stale rather than wrong.

---

## 5. What passed, and what the numbers were

### Termination is single-digit milliseconds (MEASURED-1)

Case **07c** takes five samples per profile and asserts the **median**, printing
every sample.

| profile | median | worst of five | `[DONE]` sent? | usage sent? |
|---|---|---|---|---|
| frontier | **3.34 ms** | 3.69 ms | yes | yes |
| mid-local | **3.51 ms** | 4.41 ms | yes | yes |
| small-local | **1.74 ms** | 2.19 ms | yes | **never** (it accepted `include_usage`) |
| hostile | **3.36 ms** | 3.80 ms | **never** | **never** |

Against the recorded naive consumers: **5003 ms** and **5006 ms**, both timeouts.
CONTROL 1 rebuilds the `[DONE]`-driven consumer on Vela's own transport and runs
it live: **hostile hung for 5.001 s** and delivered 0 characters; frontier
finished in 14.5 ms. CONTROL 11 shows the same median assertion failing at
**810 ms** against a stalled socket, so it is not satisfied by every code path
being fast. Round 2's 15.79 ms outlier did not recur; the spread this round is
1.5–4.4 ms across all twenty samples.

A socket that goes quiet is still abandoned rather than awaited: `07b`, with the
endpoint on a 4 s inter-frame delay and an 800 ms stall budget, ends in an
explicit error after ~810 ms on all four profiles — and that error now **names
the endpoint**, from `BodyStream::endpoint()`.

### Parallel tool calls agree across both transports

Case 02p, all four profiles: `THE TWO TRANSPORTS AGREE, call by call — id, name,
arguments, reason` passes on every profile, as does `NO SPLICING — every
arguments string reported is one the endpoint sent`, and `the correlation ids in
the batch are distinct — a result cannot be misrouted`. CONTROL 10 applies the
same comparison to a deliberately truncated batch and **FAILS**, so the
comparison is not vacuous on the profiles that emit one call.

### Prompt-emulated tool calling still works end to end, including in parallel

`small-local` has no native tools and 400s even with `tool_choice: "none"` — the
control asserts that refusal is real before the emulation result is believed.
Case 02: catalogue into a system message, `tools` array dropped, textual call
parsed back out (`OK id=call_emulated_0 name=echo_tool emulated=true
args={"text":"ok"}`), markup never shown, `ToolCallingEmulated { tool_count: 1 }`
declared, turn ends in `ToolUse`.

Case 02p adds the **parallel** emulated batch: two `<tool_call>` blocks in one
answer, both recovered with their own arguments, **identical on both
transports**, markup never reaching the user.

**A harness limit, stated rather than papered over.** `small-local` echoes back
only the first eight whitespace-delimited words of the prompt, hard-capped at 120
characters. The two-call prompt was written to fit inside that. **What this
proves is the parser and the round trip; it does not prove that two emulated
calls survive an answer longer than 120 characters, because this harness cannot
produce one.**

### No data loss from malformed frames (MEASURED-2)

`hostile/08-malformed-frames.txt`: 31 frames, three unusable. Strict `JSON.parse`
on every frame delivers **31 characters**; Vela delivers **166** — byte-identical
to the non-streamed ground truth — and raises `MalformedFramesSkipped { count: 3 }`.

### Reasoning never leaks, and never reaches the tool parser (MEASURED-3)

`mid-local` splits `</think>` across two frames (asserted against the recorded
frames), `hostile` opens `<think>` twice and never closes it and the answer is
recovered rather than swallowed, `frontier`'s `reasoning_content` lands in the
reasoning channel and nowhere else. CONTROL 2 applies "no markup" to the raw
`content` channel and FAILS on exactly the two profiles that carry reasoning
inline.

### Structured output is never silently trusted (MEASURED-5)

All four profiles answer **200 OK**; `frontier` conforms, the other three return
prose. CONTROL 3 records **1 PASS, 3 FAIL** applying conformance directly. Vela
returns `structured: Some(Err(SchemaMismatch))`, raises
`StructuredOutputMismatch`, moves `structured_output` to `Degraded`, and refuses
the affordance thereafter with zero HTTP requests sent.

### Explicit refusals, context overflow, failover

Re-measured green: vision refused locally with no request on the wire where
unprobed; a clean `ContextLengthExceeded` carrying each profile's own two
numbers; `ContextReduced { dropped_messages: 17 }` when the window is known; a
dead peer routed past with `FailedOver { attempts: 2 }` **and the dead peer named
in the transcript**; a provider `SIGKILL`ed mid-request surfacing as
`Transport { failure: Reset }` with **zero requests reaching the backup**,
because output had already been committed.

### Credentials

With `Auth::None`: no `authorization` header, no api-key-shaped header of any
other name, no credential in the query string, across every exchange of every
case. CONTROL 4 configures a bearer token on the same path and the header
appears. An empty keychain produces `AuthFailed` with **zero requests sent**. An
endpoint that demands a key (`09b`) yields `AuthFailed`, never retried, never
failed over.

**The IPC boundary, recorded rather than assumed:** there is no `provider_*`
command on the Rust allowlist and none in `contract.ts`, so no `ProviderError`
crosses the bridge today. The serde rendering is asserted clean regardless —
that is the shape a future `provider_stream` command would serialise into the
WebView.

---

## 6. ASSERTION CONTROL

Round 2 recorded 24 controls with 15 expected FAILs. Round 3 records **32 control
experiments with 36 recorded FAILs, every one the expected one** — the 24 the
recorder runs, plus 8 the executor added to attack the two claims this round is
about.

### 6.1 The recorder's controls (`ASSERTION-CONTROL.txt`) — 24 verdicts, 15 FAIL

| control | applied where it should not hold | result |
|---|---|---|
| 1 | a `[DONE]`-driven consumer against `hostile` | **HUNG, 5.001 s**, 0 chars |
| 2 | "no `<think>` markup" against the raw content channel | **FAIL** on `mid-local`, `hostile`; PASS on `frontier` |
| 3 | "the answer conforms to the schema" against each profile | **FAIL** on three of four |
| 4 | "no authorization header" against a configured bearer token | **FAIL** |
| 5 | "the vision affordance is absent" against `frontier` | **FAIL** |
| 6 | "exactly one executable tool call" against `hostile` | **FAIL** (2 reported) |
| 7 | "the turn overflows the window" against a 5-character prompt | **FAIL** |
| 8 | "every parallel call comes back" with round 1's rule restored | **FAIL** — one spliced call, verbatim |
| 9 | "the credential is not in this text" against `expose()` and the pre-fix detail | **FAIL** on both; PASS on the two redacted renderings |
| 10 | "the two transports agree" against a deliberately truncated batch | **FAIL** |
| 11 | "termination in single-digit ms" against a stalled socket | **FAIL, 810 ms** |

### 6.2 The executor's controls (`structural/control-results.txt`) — 8 experiments

Five are compile probes; three re-introduce a defect into `src/http.rs` and
re-run four suites. Full output in `structural/control-results.txt`; the tree is
restored on every exit path and `git diff src/` is empty afterwards, which was
verified.

| # | control | expected | observed |
|---|---|---|---|
| E1–E5 | five bypasses compiled against the real crate (§4.3) | all rejected, each for its own error code | **all rejected**, E0308 / E0407 / E0616 / E0599 / E0277 |
| **E6** | **DEFECT 1** — `next_chunk` hands bytes back unmodified (round 2's streaming path, restored) | the leak suites go red | **17 tests red**: executor probe 3/5, `streamed_credential_canary` 10/15, `finding_two_recipe` 3/4, `credential_canary` 1/8 |
| **E7** | **DEFECT 2** — `without_url()` and nothing re-attached (round 2's over-redaction) | only the endpoint-identity assertions go red | **exactly 2 tests red**, and different ones: `three_configured_candidates_produce_three_distinguishable_errors`, `transport_failures_still_name_the_endpoint_they_failed_on` |
| **E8** | **DEFECT 3** — `BodyStream::inner` made public | a compile probe starts compiling | **probe-03 COMPILED**, correctly detected |

**E6 and E7 are disjoint**, which is what a gate needs in order to tell the two
directions of this round's change apart. Under DEFECT 1 the `Auth::None` control
and every endpoint-identity test stay green; under DEFECT 2 every leak assertion
stays green. Round 2's own `credential_canary.rs` is **untouched by DEFECT 2** —
which is exactly why it shipped that defect.

E8 is the control that caught a hole in the executor's *own* probe (§4.1b) before
the probe was believed.

---

## 7. Gate verdict

**Round 3: all eleven pieces PASS.**

| piece | verdict |
|---|---|
| 1. plain chat, streamed and not | **PASS** — identical on all four |
| 2. tool calling, including **parallel** | **PASS** — native, emulated and parallel; live on all four profiles; both transports agree call by call. FINDING 1 closed and reproducible on demand (CONTROL 8) |
| 3. vision | **PASS** — offered only where probed, refused locally elsewhere |
| 4. structured output | **PASS** — never silently conformant, on either transport |
| 5. context overflow | **PASS** — clean error, and visible reduction when the window is known |
| 6. reasoning | **PASS** — no leak, no swallow, excluded from tool parsing |
| 7. stream termination | **PASS** — medians 1.7–3.5 ms where a naive consumer hangs 5 s |
| 8. malformed frames | **PASS** — 166 characters against a strict consumer's 31 |
| 9. no credential | **PASS** — nothing on the wire, positively controlled |
| 10. failover | **PASS** — routes past a dead peer, names it, refuses to replay a killed one |
| **11. credentials in errors** | **PASS** — clean on nine forced paths × four profiles × five renderings × the event sink, on a bare transport and behind the worst decorator the API permits; on all three adapters, both bindings, both transports; with the endpoint's own diagnosis intact |

**GATE M Part 1 (Phase B) PASSES.**

The gate criterion asks whether any piece crashes, hangs, silently produces wrong
output, or offers an affordance the profile cannot support. Nothing observed in
this run does. The one hang recorded is CONTROL 1, which is a *naive* consumer
built to hang so that Vela's 3 ms termination means something.

Two things this executor wants on the record with the pass:

1. **The claim that was checked is the strong one.** Not "the leak is gone" but
   "an unscrubbed read is not expressible". Five bypasses written by someone who
   did not write the fix were all rejected by the compiler, and the one runtime
   bypass the API still permits — a decorator that forwards nothing and lies
   about its origin — changes the output not at all.
2. **The gate's own instrumentation was wrong twice and was fixed rather than
   filed** (§4.1). Both fixes made the evidence stronger: the premise is now
   taken from the peer's send buffer rather than from inside Vela, and the
   compile probes now fail one reason at a time.

**Nothing here has moved on GATE M Part 2** — a real llama.cpp endpoint — which
was not attempted and remains deferred to the desktop session.

---

## 8. What this run does NOT prove

* **Nothing about a real model.** Every endpoint is a mock. GATE M Part 2 stays
  deferred and is still the largest hole in the evidence base for the project.
* **Nothing about the OS keychain.** Exercised against `MemoryStore`.
* **Nothing about the packaged binary or the running app.** `conventions.md` §11.
* **The Anthropic and Google adapters are now driven live** — over real TCP,
  through all seven forced failures, both bindings, both transports
  (`streamed_credential_canary.rs`, and the executor's probe) — which round 2's
  §8 had to disclaim. But **only for the credential and error paths.** The
  capability matrix (cases 00–10) still drives `OpenAiCompatibleProvider` alone;
  nothing here is evidence about Anthropic's or Google's normalisation,
  reasoning splitting, tool accumulation or streaming behaviour beyond errors.
* **Nothing about emulated tool calls in a long answer.** The `small-local` mock
  echoes at most 120 characters, so a two-call emulated batch had to be written
  to fit inside that. §5 states the limit.
* **Nothing about sampling knobs.** `temperature`, `top_p`, `stop` and `seed` are
  sent and silently discarded by all four profiles.
* **Nothing about prompt caching.** No matrix endpoint implements it; the
  capability stays `Unknown`, and `Unknown` is not offerable.
* **Nothing about multi-call tool conversations.** Emulation's `render_results`
  round trip is still not exercised here.
* **Nothing about a credential split across a chunk boundary *on a real
  socket*.** `Scrubber::hold_back_len` is proved by a scripted one-byte-at-a-time
  body (`positive_control_a_credential_split_across_two_chunks_leaks`), not by a
  peer that actually fragments that way — this container's loopback does not
  reliably produce that split.

---

## 9. Reproducing

```bash
bash docs/regression-baseline/phase-b-matrix/record.sh            # the matrix: exits 0
bash docs/regression-baseline/phase-b-matrix/structural/probe.sh  # 5 bypasses, all rejected
bash docs/regression-baseline/phase-b-matrix/structural/controls.sh  # the defect injections
cd src-tauri && cargo test -p vela-providers                      # 469 passed, 0 failed, 1 ignored
pnpm verify                                                       # the whole gate, exit 0
```

Needs Node 22+ on `PATH`. The recorder is
`src-tauri/crates/vela-providers/examples/gate_m_phase_b.rs`; it starts and stops
its own servers on OS-assigned ports, including five raw TCP peers of its own for
case 11. Wall-clock lines and ephemeral port numbers differ between runs;
everything else is byte-stable.

`controls.sh` edits `src/http.rs` in place and restores it from a backup on every
exit path, including a failure. It leaves `git diff src/` empty; if it ever does
not, `git checkout src-tauri/crates/vela-providers/src/http.rs` is the recovery.

The credential canary `vela+gate/m1-7Q2Xz9f3a-DO-NOT-LEAK` is a fake string that
was never a credential for anything. The recorder asserts it appears in no
per-profile transcript except `11-credential-leak.txt`, so a future run that
leaked it into another case's evidence would fail the gate rather than sit here
unnoticed. The executor's probe uses a second, different fake
(`vela+exec3/Zq-…`) that appears only in its own source.
