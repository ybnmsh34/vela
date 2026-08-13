# GATE M Part 1 — capability-matrix results

**Recorded:** 2026-08-12 · **Executor:** GATE M Part 1 evidence run
**Raw evidence:** `<profile>/00-…09-*.txt` (verbatim wire transcripts),
`verdicts.tsv` (every assertion), `ASSERTION-CONTROL.txt`, `EDGE-PROBES.txt`,
`VELA-SIDE-CONSUMPTION.txt`.

---

## Read this before you read anything else

**Every result below came from a deterministic fake.** Four mock servers were
started as real OS processes (`node tests/harness/mock-provider/src/cli.ts
--profile <p> --port <n>`, ports 8101–8104) and driven over real TCP by curl
8.5.0 and by `node:http` probes. Not one byte was produced by a language model.
Everything here is **VERIFIED-BY-FAKE** (`docs/architecture/conventions.md` §10).

**GATE M Part 2 — the real llama.cpp model on the operator's Windows host at
:8033 — is unreachable from this container. There is no network route.** That
makes this mock matrix the sole evidence for graceful degradation in the entire
project, which is a weakness of the evidence base, not a strength of the code.

**And Vela does not consume any of it yet.** Phase A ships no HTTP client — not
in the Rust core, not in any crate, not in the renderer. That is asserted
mechanically, not asserted in prose: `cargo test -p vela-settings --test
capability_matrix_endpoints` walks every `Cargo.toml` in the workspace and fails
if an HTTP client appears. So the matrix below describes **what the endpoints
did** and **what a naive consumer suffered**. It does not describe Vela's
provider layer, because there is no provider layer to describe. See
`VELA-SIDE-CONSUMPTION.txt` for exactly where the boundary sits.

---

## 1. The matrix

Ten cases × four profiles. Every cell is backed by a verbatim transcript in
`<profile>/<case>.txt`, each ending in machine-checked assertions.

| case | frontier | mid-local | small-local | hostile |
|---|---|---|---|---|
| **00** server, `/health`, `/props`, `/v1/models` | ✅ 200, n_ctx 200000 | ✅ 200, n_ctx 32768 | ✅ 200, n_ctx 8192 | ✅ 200, n_ctx 4096 |
| **01** plain chat, non-streaming | ✅ 200 · `stop` | ✅ 200 · `stop` | ✅ 200 · `stop` | ✅ 200 · `stop` |
| **02** plain chat, streaming | ✅ SSE ≡ non-streamed | ✅ SSE ≡ non-streamed | ✅ SSE ≡ non-streamed | ✅ SSE ≡ non-streamed (tolerant parser only) |
| **03** tool calling | ✅ native, args valid JSON | ✅ native, args valid JSON | ⛔ **400 `tools_not_supported`** (explicit) | ⚠️ **200 + malformed calls** |
| **04** image / vision input | ✅ 200, image billed | ⛔ **400 `vision_not_supported`** | ⛔ **400 `vision_not_supported`** | ⛔ **400 `vision_not_supported`** |
| **05** structured output (`json_schema`) | ✅ honoured, keys match | 🚨 **200, silently ignored** | 🚨 **200, silently ignored** | 🚨 **200, silently ignored** |
| **06** context overflow | ⛔ **400 `context_length_exceeded`** | ⛔ 400 (states 32768) | ⛔ 400 (states 8192) | ⛔ 400 (states 4096) |
| **07** reasoning / `<think>` | ✅ separate `reasoning_content` | 🚨 inline `<think>`, **closing tag split across frames** | ✅ none emitted | 🚨 **`<think>` opened twice, never closed, junk inside** |
| **08** stream termination | ✅ `[DONE]` + usage | ✅ `[DONE]` + usage | 🚨 **usage never sent → naive consumer HANGS** | 🚨 **no `[DONE]`, unparseable frames → HANG + DATA LOSS** |
| **09** no-credential endpoint | ✅ 200 with no auth header; 401 on empty `Bearer` | ✅ same | ✅ same | ✅ same |

✅ works · ⛔ refused **explicitly**, with a machine-readable code · ⚠️ answered
with broken data · 🚨 **degrades silently or hangs a naive consumer**

**Assertion ledger: 169 assertions, 0 failures** (`verdicts.tsv`).
That number means "the endpoints behaved exactly as their profiles specify" — it
is a statement about the harness, not about Vela.

### The assertions can fail

169/169 green is worthless if a red is impossible. `ASSERTION-CONTROL.txt`
applies each check to a server that does *not* satisfy it and records the FAIL,
then re-applies it to the right server and records the PASS. Eleven control
lines, all behaving as the control expected. The Rust boundary test was
mutation-checked the same way (swap `reqwest` for `serde` in its deny-list → the
test fails).

### The evidence is reproducible and cross-checks against the committed capture

The four live server processes returned bodies **byte-identical** to the
previously committed `<profile>/04-plain.json`, which was recorded in-process by
a different client (`fetch`) on a different port in a different run. Determinism
holds across processes, ports, clients and runs.

---

## 2. Findings

### FINDING 1 — DEFECT in the harness: the 8 MiB body guard cannot answer

**Severity: real. The harness is the sole evidence base, and one of its own
error paths is unreachable.**

`server.ts` `readBody()` rejects a body over `MAX_BODY_BYTES` (8 MiB) with a
`413 request body too large` — and calls `request.destroy()` in the same turn.
The socket dies before the response can be written, so the client gets:

```
curl: (56) Recv failure: Connection reset by peer
http_code=000        response bytes = 0
```

No status, no body, no code — and the server logs nothing, so the failure is
silent at both ends. Seven MiB is answered normally (400 `context_length_exceeded`),
so the cap is the trigger. Raw reproduction: `EDGE-PROBES.txt` probe 1.

Consequences: the documented `413` / `invalid_json` behaviour is **dead code and
was never verified**; and a consumer cannot distinguish "the endpoint refused an
oversized request" from "the endpoint crashed". **Not fixed here** — this run
produces evidence, and a fix belongs to the harness owner, with the transcript
above as its regression test. Phase B must treat a connection reset on a large
POST as a possible size-limit rejection, not proof of a dead endpoint.

> **UPDATE — closed after this run, by someone other than the finder.**
> `readBody()` now drains the remainder of an over-cap body (bounded by
> `OVERSIZE_DRAIN_BYTES`) before answering, so the response is written to a
> socket the client can still read, and only then is the connection closed.
> A client now observes `http_code=413` with `code: invalid_json`; the 17 MiB
> case, where the server stops reading mid-upload, answers too. Regression test:
> `tests/harness/mock-provider/src/server.test.ts`, *"a request body over the
> 8 MiB cap"* — 4 assertions, all of which fail with `ECONNRESET` against the
> pre-fix `server.ts`. Re-measured transcript: `EDGE-PROBES.txt` probe 1, which
> keeps the pre-fix transcript above it, labelled. Everything in this section
> above the line remains what was true at the time of this run.
> The Phase B guidance is unaffected: a *real* endpoint may still reset.

### FINDING 2 — Two hang classes are real, reproducible, and 5 seconds wide

Measured, not theorised, by `consumer-probes.mjs` against the live servers:

| consumer (5 s budget) | hostile | small-local | mid-local / frontier |
|---|---|---|---|
| finalises on `[DONE]` | **TIMED OUT at 5003 ms** | ok, 9 ms | ok, 8 ms |
| waits for the `usage` frame it requested | **TIMED OUT at 5006 ms** | **TIMED OUT at 5006 ms** | ok, 9 ms |
| `JSON.parse` on every frame | **THREW after 4 frames; 31 of 349 chars delivered, 318 lost** | ok, 122/122 chars | ok, 219/219 and 298/298 chars |

Both hangs are *consumer* hangs: the HTTP body ends and the socket closes in
every case, so a consumer that treats end-of-body as terminal never hangs. The
requirement this puts on Phase B is exact: **end-of-body is the only reliable
terminator; `[DONE]` and the usage frame are hints.** `small-local` is the
uncomfortable one — it accepts `stream_options.include_usage` and then never
sends usage, so requesting usage is not evidence that usage will arrive.

### FINDING 3 — Silent structured-output failure on three of four profiles

`mid-local`, `small-local` and `hostile` accept `response_format: json_schema`,
answer **200 OK**, and return prose. Nothing in the response says the schema was
ignored — no field, no warning, no error code. A caller that trusts
`response_format` gets `JSON.parse` throwing on data it believed was validated.
This is deliberate in the profiles and it is the correct thing to model: the
clean 400 is easy, the silent success is what ships. Phase B cannot advertise
structured output on a provider without probing for it, and must validate the
result of every structured request rather than assuming conformance.

### FINDING 4 — Reasoning leaks through the obvious filter

`mid-local` splits the closing `</think>` across two SSE frames (`</thi` +
`nk>`), so **no single frame contains it**. A frame-local stripper — the obvious
first implementation — therefore leaks `<think>` markup into the answer, which
the probe recorded verbatim. `hostile` opens `<think>` twice, never closes it,
and interleaves `▒▒`, `<|im_start|>`, `</s>`, `[UNK]` inside. Requirement on
Phase B: reasoning extraction must run on the **accumulated** text with an
explicit unterminated-block policy, never per frame.

### FINDING 5 — The naive tool-call accumulator loses data on `hostile`

Keying deltas by `index` and appending `arguments` — the implementation everyone
writes first — produces, verbatim from the live stream:

```
index=0 id=call_de2c67dd type=function  name=MISSING  argumentsParse=FAILED  args="{\"city\":\"berlin\",\"un"
index=7 id=MISSING       type=funktion  name=get_weather argumentsParse=FAILED args="not-json-at-all"
```

The name arrived in a delta with no `index` and was dropped; the second call has
no id, a misspelled discriminator, and indices that are not contiguous. Any code
treating `index` as an array offset writes into the wrong slot or allocates
seven empty calls. A tool call that fails to parse must be surfaced as a failed
call, never executed on a best-effort reconstruction.

### FINDING 6 — Over-rejection: `tools` + `tool_choice:"none"`

`small-local` refuses with 400 `tools_not_supported` even when the caller
explicitly asked for **no** tool use. A consumer that always attaches its tool
catalogue is locked out of the endpoint entirely, including for turns that need
no tools. Phase B should omit `tools` when `tool_choice` is `none`, and must not
assume a tools-refusal means the turn was impossible. (`EDGE-PROBES.txt` probe 5.)

### FINDING 7 — Silently ignored request fields

`n: 3` returns one choice; `temperature`, `top_p`, `stop` and `seed` are accepted
and discarded; the request `content-type` is not validated (`text/plain` is
accepted). None of it is detectable from the response. Realistic, and a warning
that these transcripts prove nothing about any of those knobs.

### FINDING 8 — LIMITATION: the harness cannot be driven from browser mode

There are no CORS headers on any response and an `OPTIONS` preflight is answered
`405`. The frontend must run standalone in a browser (`pnpm dev`) so it can be
screenshotted headlessly — and a browser-hosted renderer therefore **cannot call
these endpoints at all**. Consistent with the architecture (HTTP belongs in the
Rust core behind the IPC bridge), but it means browser-mode chat can never be
exercised end-to-end against this harness; it will need mock adapter responses.

### FINDING 9 — No robustness problems found where they were looked for

30 concurrent streams: all 200, server healthy afterwards. Client aborting
mid-stream: server healthy afterwards. Overflow, malformed exchanges and 400s:
the endpoint keeps serving. Recorded so the absence is on the record too.

---

## 3. Gate verdict

**On the harness (what was actually testable): PASS with one defect.**
All four profiles behave exactly as specified across all ten cases, 169/169
assertions, controls prove the assertions discriminate, and the output is
byte-reproducible across processes. FINDING 1 is a genuine defect in the
harness's own oversized-body path.

**On Vela: NOT TESTABLE IN PHASE A. Not a pass.**
The gate criterion — "a piece FAILS if under any profile it crashes, hangs,
silently produces wrong output, or offers an affordance the profile cannot
support" — cannot be applied to Vela's runtime behaviour, because Vela has no
code that talks to a model endpoint. The only Vela code that can consume an
endpoint today is the configuration layer, and it was exercised against all four
live endpoint URLs: each is accepted, each is `usable` with a completely empty
keychain (`credentialCheck: satisfiedWithoutCredential`), each scores
`RiskLevel::None` because it is loopback, and the same configuration on a remote
host correctly scores `Elevated`. That is the whole of the Vela-side result.

**Anyone citing this directory as proof that Vela degrades gracefully is
misreading it.** It is the specification Phase B has to satisfy. The honest
summary of Phase A against GATE M Part 1 is: *the endpoints that break every way
we could think of now exist, run, and are recorded to the byte; the client that
must survive them does not exist yet.*

> **The Phase B answer now exists: `../phase-b-matrix/RESULTS.md`.** It runs
> Vela's own provider stack against these same four profiles over real TCP and
> applies the gate criterion to Vela's runtime behaviour for the first time.
> Result: nine of ten pieces pass, one fails — non-streamed tool calls collapse
> into one — so **GATE M Part 1 does not pass for Phase B**. Read that file
> before citing this one about Vela. It is still all VERIFIED-BY-FAKE, and
> GATE M Part 2 is still unreachable from this container.

---

## 4. How to reproduce

```bash
bash tests/harness/mock-provider/live-matrix/record.sh            # the ten cases × four profiles
bash tests/harness/mock-provider/live-matrix/assertion-control.sh # prove a FAIL is reachable
bash tests/harness/mock-provider/live-matrix/edge-probes.sh       # the undeclared surface
cd src-tauri && cargo test -p vela-settings --test capability_matrix_endpoints
```

`record.sh` starts and stops its own servers on ports 8101–8104 and exits
non-zero if any assertion fails. All three scripts overwrite their transcripts
in place: because the servers are deterministic, `git diff` over this directory
is itself a regression test.

The older `<profile>/{01..12}.{json,sse}` files and `manifest.json` in this
directory are the earlier in-process capture, regenerated by
`node tests/harness/mock-provider/src/record-transcripts.ts` and guarded by
`record-transcripts.test.ts`. The `.txt` files added here are the live-process
capture and are independent of the harness's own HTTP client.
