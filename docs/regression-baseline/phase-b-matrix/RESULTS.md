# GATE M Part 1 (Phase B) — does Vela degrade gracefully?

**Recorded:** 2026-08-13 · **Executor:** GATE M Part 1 Phase B evidence run
**Round 4 re-execution:** 2026-08-13 — **471 gate assertions, 8 failures**
**Subject:** `src-tauri/crates/vela-providers` — Vela's own provider stack
**Raw evidence:** `<profile>/00-…13-*.txt`, `verdicts.tsv`, `ASSERTION-CONTROL.txt`,
`structural/probe-results.txt`, `structural/control-results.txt`,
`structural/control-results-round4.txt`
**Companion:** `../mock-matrix/RESULTS.md` — what the endpoints did

> **⛔ GATE M Part 1 (Phase B) FAILS in round 4, on a new finding — FINDING 3.**
>
> Round 3 scored 373 assertions and 0 failures, and then two critics failed it
> on defects the gate had never looked for. Round 4's builders closed both of
> those, and this executor confirms both closures live. Then it looked where
> nobody had looked, and found a third: **three spellings of a credential reach
> `Display`, `Debug`, the serde JSON that crosses the IPC bridge, and the
> `StreamEvent` the UI is handed.**
>
> Rounds 1 → 2 → 3 → 4 have now each died on a surface the previous round's
> tests did not cover. This round's evidence includes the surface *this* round's
> tests would not have covered either, which is why it is being reported rather
> than discovered by the panel.

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

| | round 1 | round 2 | round 3 | **round 4 (this directory)** |
|---|---|---|---|---|
| gate assertions | 265 | 361 | 373 | **471** |
| failures | **5** — FINDING 1 | **16** — FINDING 2 | 0 | **8** — FINDING 3 |
| cases | 00–11 | +02p, 07c, 11 | same | **+12 redirect, +13 encoding** |
| recorder controls | 15 / 10 FAIL | 24 / 15 FAIL | 24 / 15 FAIL | **24 / 15 FAIL** |
| executor controls | — | — | 8 → 21 FAILs | **12 → 24 FAILs** |
| **controls, total** | 15 / 10 | 24 / 15 | 32 / 36 | **36 / 39** |
| wall clock, matrix run | ~17 s | ~22 s | ~21.9 s | **~21.7 s** |

```
gate assertions   471
failures          8
controls          24 (their FAILs are expected)
wall clock        21.673259788s

FAILURES:  all 8 in case 13, two per profile — see §5
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
| 07c termination latency | **32** *(was 16)* | 0 |
| 08 malformed frames | 13 | 0 |
| 09 no credential | 28 | 0 |
| 09b endpoint requires a key | 12 | 0 |
| 10 failover | 24 | 0 |
| 11 credential canary | **56** *(was 49)* | 0 |
| **12 redirect egress** | **52** *(new)* | **0** |
| **13 encoded credential leak** | **20** *(new)* | **8** |
| canary containment | 3 | 0 |

`verdicts.tsv` carries every line. `SUMMARY.txt` carries the failure list.

Beyond the matrix, run separately:

```
structural/probe.sh                   5 of 5 compile bypasses rejected (re-run live)
structural/controls.sh                round 3's three defect injections (re-run live)
structural/controls-round4.sh         round 4's four defect injections
cargo test -p vela-providers          green, with ONE deliberately-ignored test
                                      carrying FINDING 3 — see §5.4
```

---

## 2. The matrix — Vela's behaviour, per case, per profile

| case | frontier | mid-local | small-local | hostile |
|---|---|---|---|---|
| **00** capability probe | ✅ 200k · tools/vision/schema Supported | ✅ 32k · schema **Degraded**, vision Unsupported | ✅ 8k · tools **Unsupported**, schema Degraded | ✅ 4k · tools **Degraded**, schema Degraded |
| **01** plain chat, streamed ≡ whole | ✅ identical | ✅ identical | ✅ identical | ✅ identical |
| **02** tool calling | ✅ native | ✅ native | ✅ **emulation works end to end** | ✅ 2 broken calls on **both** transports |
| **02p** parallel tool calls | ✅ **3 calls, live, both transports agree** | ✅ same | ✅ **2 emulated calls, both agree** | ✅ **3 calls, middle broken, both agree** |
| **03** vision | ✅ offered, image answered | ✅ affordance absent, image refused locally | ✅ same | ✅ same |
| **04** structured output | ✅ honoured and validated | ✅ **mismatch reported**, affordance withdrawn | ✅ same | ✅ same |
| **05** context overflow | ✅ clean error, `200000`/`250004` | ✅ `32768`/`40964` | ✅ `8192`/`10244` | ✅ `4096`/`5124` |
| **06** reasoning | ✅ separate field, never in the answer | ✅ split `</think>` never leaks | ✅ none emitted, none invented | ✅ unterminated block does not swallow the answer |
| **07** stream termination | ✅ terminates | ✅ | ✅ usage-absence declared | ✅ missing sentinel declared |
| **07c** latency, **credentialed** | ✅ **3.38 ms** (uncred. 2.97) | ✅ **3.10 ms** (2.57) | ✅ **2.11 ms** (1.82) | ✅ **3.76 ms** (3.01) |
| **08** malformed frames | ✅ no bad frames, none claimed | ✅ same | ✅ same | ✅ **166 chars vs 31 for a strict consumer** |
| **09** no credential | ✅ nothing on the wire | ✅ same | ✅ same | ✅ same |
| **10** failover / mid-request kill | ✅ routed past a dead peer, **named**; killed stream not replayed | ✅ same | ✅ same | ✅ same |
| **11** credential canary | ✅ clean on all forced paths | ✅ same | ✅ same | ✅ same |
| **12** redirect egress | ✅ **third party got 0 bytes, 0 connections** | ✅ same | ✅ same | ✅ same |
| **13** encoded credential | ⛔ **3 spellings leak** | ⛔ same | ⛔ same | ⛔ same |

✅ passes every assertion · ⚠️ degrades, explicitly · ⛔ gate failure

---

## 3. What round 4's builders fixed, re-checked live by someone who did not fix it

### 3.1 Credential egress on redirect — **CLOSED**, and the control proves the channel was real

This was the round-3 panel's security FAIL, and the most serious defect the
project has recorded: a `3xx` from the configured endpoint handed the user's API
key to a host they never named, on the first request of a healthy turn, with no
error involved anywhere.

Case **12** drives it as gate evidence rather than reading the fix. The subject
of every assertion is **the third party** — a recording listener on a port the
user never configured — not Vela:

```
  Auth::None                       third party: 0 connections, 0 bytes
  Auth::Bearer                     third party: 0 connections, 0 bytes
  Auth::ApiKeyHeader{x-api-key}    third party: 0 connections, 0 bytes
  Auth::ApiKeyHeader{x-goog-api-key} third party: 0 connections, 0 bytes
  Auth::ApiKeyQuery{key}           third party: 0 connections, 0 bytes
                                   … × complete() and stream() = 10 arms
  [PASS] THE THIRD PARTY ACCEPTED ZERO CONNECTIONS            0
  [PASS] THE THIRD PARTY RECEIVED ZERO BYTES                  0
  [PASS] the configured endpoint really was contacted         10 connections / 10 arms
```

The assertion is **zero bytes**, not "no credential in the bytes", because the
rule the transport is built on is *Vela talks to the endpoint the user
configured and to nothing else* — and a prompt is user data too.

The refusal is actionable rather than silent, on all ten arms and in all five
renderings:

```
  could not reach the endpoint (request): refused the endpoint's 302 redirect to a
  different host (http://127.0.0.1:46853 -> http://127.0.0.1:41803): Vela sends a
  request only where you configured it
```

**The positive control, which is what makes the above mean anything.**
`PreFixTransport` is this transport as it was before the fix — the same client
with `no_proxy` and a user agent, and `reqwest`'s untouched redirect and referer
defaults — driven through identical sockets:

```
  Auth::None:                          third party got 173 bytes, canary absent
  Auth::Bearer:                        third party got 173 bytes, canary absent
  Auth::ApiKeyHeader{x-api-key}:       third party got 227 bytes, canary ARRIVED
  Auth::ApiKeyHeader{x-goog-api-key}:  third party got 232 bytes, canary ARRIVED
  Auth::ApiKeyQuery{key}:              third party got 223 bytes, canary ARRIVED

  GET /v1/chat/completions HTTP/1.1
  user-agent: vela/pre-fix-control
  x-api-key: <CANARY — MASKED BY THE RECORDER>
  referer: http://127.0.0.1:34441/v1/chat/completions
  host: 127.0.0.1:34935
```

It leaks for exactly the three bindings `reqwest` does not protect and not for
`Bearer`, which pins the upstream behaviour the fix compensates for as a
measurement rather than a changelog citation.

**And the control makes the design decision visible.** Even on `Auth::None` and
`Auth::Bearer` — the bindings upstream *does* protect — the third party still
received **173 bytes**: the request line, the model id, the prompt. Stripping
the credential and following anyway would have left that. Refusing is the only
answer that does not egress user data, and this is the number that says so.

**Two things nobody had driven, added by this executor:**

* **Every redirect status, not just `302`.** `301`, `302`, `303`, `307`, `308`
  — all five refused, third party `0 bytes` on each. `303` rewrites the method
  to `GET`, and that changes nothing, because the check is on authority and runs
  before the rewrite.
* **The same-authority hop, recorded rather than assumed.** A `301` from
  `…/v1/chat/completions` to `…/v2/chat/completions` on the same scheme, host
  and port **is followed**: 2 connections to the one authority, the second path
  observed in its transcript, and the turn succeeds. That is the
  reverse-proxy-normalising-a-path case the fix deliberately still allows, and
  it egresses nowhere new. Recorded here so the choice is on the record with its
  evidence, not only in a doc comment.

### 3.2 Encoding-defeated redaction — the **briefed** encodings are closed

This was the round-3 panel's functionality FAIL: round 3's scrub was
byte-literal, and an endpoint that JSON-escapes `/` as `\/` — PHP's
`"json_encode"` default — emitted a credential matching no needle, which
`serde_json` then reassembled downstream of every scrub point.

Case **13** drives it, in FINDING 2's exact shape (a `200` whose SSE stream
carries the error object, read frame by frame) and beside it a `400` read whole,
on both bindings and both transports. All three briefed encodings are removed:

```
  verbatim (control)              · ?key= / x-api-key · 200 / 400 · both calls → clean
  PHP json_encode: \/             · …                                          → clean
  every char as \uXXXX            · …                                          → clean
```

And the mechanism is right rather than a list: the peers put **no literal copy**
of the credential on the wire (asserted from each peer's own send buffer), so
the literal pass genuinely had nothing to match, and `<redacted>` is present on
the cleaned arms, so this is redaction and not deletion.

One unbriefed spelling is closed too, and by the second barrier rather than the
first: **JSON escaped twice** (`\\/`, an upstream error body embedded in an
outer one) survives the byte scrub — one decode pass leaves `\/`, which is not
the credential — and is removed when `decode_json` scrubs the decoded value.

### 3.3 Round 3's guarantees, re-verified rather than carried forward

* **An unscrubbed read is still not expressible.** `structural/probe.sh` re-run
  live: all five compile bypasses rejected, each for its predicted error code
  (E0308 / E0407 / E0616 / E0599 / E0277).
* **Endpoint identity is still named in redacted form.** Case 10, all four
  profiles: the dead peer is named; case 11's query-credential arms name the
  request target with `?key=<redacted>`.
* **Parallel tool calls still agree**, call by call, on both transports, on all
  four profiles — 43 assertions, 0 failures.
* **Prompt emulation still works end to end**, including the parallel emulated
  batch on `small-local`.

---

## 4. Latency, on the path that actually ships (MEASURED-1, corrected)

Round 3's latency case built its provider with `Auth::None`. An empty credential
set is an empty `Scrubber`, and `BodyStream::next_chunk` short-circuits when the
scrubber is empty — no copy, no carry buffer, no scan. **The medians round 3
published were medians of a path that does not run once a user configures a
key**, offered implicitly as the latency evidence for redaction they never
exercised. The round-3 regression critic caught this as an evidentiary flaw; it
is corrected here.

Case 07c now runs **two arms**, and the single-digit claim is made about the
credentialed one. `Auth::ApiKeyQuery` is chosen because it makes the scrubber
non-empty for *every chunk of every response*, so these are numbers about
`scrub_bytes` and `hold_back_len` actually running.

| profile | **credentialed median** | uncredentialed median | cost of redaction | worst credentialed |
|---|---|---|---|---|
| frontier | **3.38 ms** | 2.97 ms | 415 µs | 3.9 ms |
| mid-local | **3.10 ms** | 2.57 ms | 529 µs | — |
| small-local | **2.11 ms** | 1.82 ms | 286 µs | — |
| hostile | **3.76 ms** | 3.01 ms | 756 µs | 3.95 ms |

Against the recorded naive `[DONE]`-driven consumers: **5003 ms** and **5006
ms**, both timeouts. CONTROL 1 rebuilds that consumer on Vela's own transport
and runs it live: hostile hangs 5.001 s and delivers 0 characters.

Two vacuity guards make the arms mean what they say, and both are asserted:
the credentialed arm really did put a credential on the wire, and the
uncredentialed arm really did not — so these are two different code paths and
not the same one measured twice. Both arms deliver the same answer length, so
redaction did not truncate anything.

**Redaction costs about half a millisecond per turn.** That is the honest number
and it was not previously available.

---

## 5. ⛔ FINDING 3 — three spellings of a credential reach every surface

**This is the gate failure.** 8 assertions, two per profile, in case 13.

### 5.1 What leaks

The endpoint echoes the credential it was sent, spelled a given way, inside its
error message. Vela's scrub resolves **JSON escapes** — because `serde_json` is
the decoder Vela runs — and removes two **literal** spellings: the credential as
written, and the percent-encoded form `RequestUrl::with_query_credential` puts
in a query string. Everything else survives.

| spelling | who writes it | verdict |
|---|---|---|
| percent-encoded, **UPPERCASE** hex, on a **header** binding | any encoder; this is the exact spelling Vela itself writes | ⛔ **READABLE** |
| percent-encoded, **lowercase** hex, on **either** binding | a lowercase-hex percent encoder | ⛔ **READABLE** |
| **every byte** percent-encoded | a paranoid encoder — or an endpoint choosing its spelling | ⛔ **RECONSTRUCTIBLE** in one decode pass |
| HTML entities (`&#x2f;`) | anything HTML-escaping a message that also renders in a web console | ⛔ **READABLE** |

Verbatim from `frontier/13-encoded-credential-leak.txt`:

```
percent-encoded, UPPERCASE hex · x-api-key · HTTP 200 · stream()
    → READABLE — Display: matched "vela%2Bgate%2Fm4-encode-Zx7Tn2q-DO-NOT-LEAK"
percent-encoded, lowercase hex   [UNBRIEFED] · ?key= · HTTP 400 · complete()
    → READABLE — Display: matched "vela%2bgate%2fm4-encode-Zx7Tn2q-DO-NOT-LEAK"
percent-encoded, every byte      [UNBRIEFED] · x-api-key · HTTP 200 · stream()
    → RECONSTRUCTIBLE by one decode pass
HTML entities: &#x2f;            [UNBRIEFED] · ?key= · HTTP 200 · stream()
    → READABLE — Display: matched "Zx7Tn2q"
```

And the surface it lands on — the same four FINDING 2 landed on:

```
  Display     the endpoint rejected the credential: VELA-M4-ENCODING-MARKER:
              rejected credential [%76%65%6C%61%2B…] for /v1/chat/completions
  Debug       AuthFailed { detail: "… [%76%65%6C%61%2B…] …" }
  serde JSON  {"kind":"authFailed","detail":"… [%76%65%6C%61%2B…] …"}   <- THE IPC WIRE SHAPE
  StreamEvent {"type":"error","error":{"kind":"authFailed","detail":"… "}}  <- what the UI is handed
```

28 of 64 driven arms in each profile, on both bindings, both response shapes and
both transports.

### 5.2 The sharpest one is not the unbriefed one

`percent-encoded, UPPERCASE hex` is in the table as a **control** — it is the
spelling Vela itself writes on the wire, and it is deliberately a needle. It is
removed on the query binding and **not** on a header binding.

The cause, in `http.rs::HttpRequest::scrubber`:

```rust
for (name, value) in &self.headers {
    if !self.secret_headers.iter().any(|secret| secret == name) { continue; }
    needles.push(value.clone());                       // the raw value
    if let Some((_, token)) = value.split_once(' ') {
        needles.push(token.to_owned());                // and the bare token
    }
}
Scrubber::new(needles).merged(&self.url.scrubber())    // percent forms arrive ONLY from here
```

The percent-encoded needle exists only inside `RequestUrl`, and a header-bound
credential never goes through `RequestUrl`. So the two non-`Bearer` bindings
Vela ships — **`x-api-key` (Anthropic) and `x-goog-api-key` (Google)** — carry a
strictly smaller needle set than the query binding does. That is not a new
requirement this executor invented; it is an existing intent, implemented for
one of the three shapes.

### 5.3 The structural statement, and the honest counter-argument

**The statement.** Round 4 made the scrub *decoder-aware* for JSON escapes:
`DecodedView` resolves escapes and matches in the decoded bytes, so `\/`,
`\uXXXX`, a surrogate pair and any mixture are one case rather than a list. That
is the right mechanism, and it holds. **Percent-encoding is handled by the
opposite mechanism** — a hard-coded second literal, added in one place, for one
binding. Two encodings, two mechanisms, and one of them is a list of one entry.

**The counter-argument, stated because a reader deserves it.** A defensible
narrower rule is: *remove every spelling Vela puts on the wire, and every
spelling a decoder Vela runs will produce.* Under that rule percent and HTML
spellings are out of scope, because Vela never percent-decodes or
entity-decodes a response body — a human or a downstream tool does. On that
reading FINDING 3 is materially less severe than FINDING 2, where Vela's own
decoder handed the plaintext key to the UI.

**Why it is still recorded as a FAIL.** Three reasons, in order of weight:

1. The uppercase-percent case is not covered by that narrower rule either. It is
   a spelling Vela **does** put on the wire, and the codebase already treats it
   as a needle — just not for the bindings Anthropic and Google use.
2. The instruction this round was executed under is explicit: *the canary must
   reach no `Display`, `Debug`, serde rendering, or `StreamEvent` sink.* It
   does, in four of them, in a form a reader recovers the key from by eye.
3. For a product whose premise is offline-first local data sovereignty, a
   credential recoverable from an error toast, a log line or a pasted bug report
   is not consistent with the posture. Round 4's own commit messages argue this
   about `\/`; the argument does not change when the alphabet does.

### 5.4 Where the finding lives in the tree

`tests/zz_gate_m_round4_executor_probe.rs::no_spelling_of_the_credential_survives_into_any_surface`
is **red** and carries `#[ignore]` with the reason spelled out at the site.
That is deliberate and is not a way of hiding it:

* the **gate verdict** is carried by `record.sh`'s non-zero exit and by this
  document, not by that test;
* `cargo test` keeps meaning *"nothing NEW is broken"* — a permanently-red suite
  trains a reader to skip the failure list, which is exactly how a second defect
  hides behind a first;
* **deleting the `#[ignore]` is the fix's acceptance test.**

Run it with
`cargo test -p vela-providers --test zz_gate_m_round4_executor_probe -- --ignored`.

> **CLOSED by piece B2 (`redesign:typed-closed-error-surface`).** The
> `#[ignore]` is gone; the test runs in the ordinary suite and passes. It was
> not closed by removing a fifth spelling — it was closed by removing the field
> the spellings were arriving in. `ProviderError` carries no `String`, the
> `detail()` that used to launder upstream text no longer exists, and the raw
> body goes to a local, opt-in debug log keyed by a correlation id.
>
> **Read `docs/regression-baseline/phase-b/TYPED-CLOSED-ERROR-SURFACE.md`
> before trusting the green.** Every needle search in every canary in this
> crate now passes *vacuously* — there is no endpoint text on the surface for a
> needle to match — and that document says which assertions carry weight
> instead: the endpoint-invariance test and the closed-vocabulary audit in
> `tests/typed_closed_error_surface.rs`.

### 5.5 What a fix probably looks like — not prescribed, only scoped

The executor did not fix this and does not own the design. Two shapes are
visible from the evidence:

* **Narrow:** add `percent_encode(value)` to the needle set for header bindings
  too, closing 5.2 alone. One line, closes the case the codebase already thinks
  it handles, leaves lowercase and every-byte open.
* **Structural:** a `PercentDecodedView` beside `DecodedView`, so percent
  spellings are *resolved* rather than *enumerated*, the way JSON escapes now
  are. That closes all three percent cases with one mechanism. HTML entities
  would remain, and a deliberate written decision to leave them out of scope
  would then be a defensible answer rather than an omission.

---

## 6. What else this round drove that nobody had

### 6.1 A credential fragmented across two real TCP writes

Round 3's §8 recorded this as a hole it could not close: *"Nothing about a
credential split across a chunk boundary on a real socket.
`Scrubber::hold_back_len` is proved by a scripted one-byte-at-a-time body, not
by a peer that actually fragments that way."*

`zz_gate_m_round4_executor_probe.rs::a_credential_fragmented_across_two_real_tcp_writes_is_still_removed`
closes it. The peer splits its response body across two `write_all` calls with a
60 ms delay, and the split offset is **swept** so it lands inside the
credential and inside a `\/` escape sequence. The test asserts, from the peer's
own send buffer, that at least four sampled offsets genuinely cut the credential
in half — so it cannot pass by never having split anything. **Green.**

### 6.2 The redirect status sweep and the same-authority hop

§3.1. Nobody had driven anything but `302`, and nobody had recorded what the
implementation *chose* to do about a same-authority hop.

### 6.3 The canary containment tripwire, generalised

Round 3 asserted its one canary appeared in no transcript but case 11's. Round 4
has three canaries and three answers: case 11's belongs in
`11-credential-leak.txt`; case 13's belongs in `13-encoded-credential-leak.txt`,
because there **the spelling is the evidence** and masking it would destroy what
a reader has to see; case 12's is **masked wherever that transcript prints
received bytes** and should therefore appear nowhere at all. All three assertions
pass.

---

## 7. ASSERTION CONTROL — 36 experiments, 39 recorded expected FAILs

Round 3 recorded 32 experiments with 36 expected FAILs. Round 4 records **36
experiments with 39**: the recorder's 24, round 3's 8 **re-run live rather than
carried forward**, and 4 new ones attacking what round 4 changed.

**The counting rule, stated because the previous rounds' totals do not
reconstruct from their own tables.** An *experiment* is one control setup. An
*expected FAIL* is one recorded red-or-rejected outcome inside it.

| group | experiments | expected FAILs |
|---|---:|---:|
| the recorder's controls (`ASSERTION-CONTROL.txt`) | 24 | 15 |
| round 3's executor controls, re-run live | 8 | 13 |
| round 4's executor controls | 4 | 11 |
| **total** | **36** | **39** |

### 7.1 The recorder's controls (`ASSERTION-CONTROL.txt`) — 24 verdicts, 15 FAIL

| control | applied where it should not hold | result |
|---|---|---|
| 1 | a `[DONE]`-driven consumer against `hostile` | **HUNG, 5.001 s**, 0 chars |
| 2 | "no `<think>` markup" against the raw content channel | **FAIL** on `mid-local`, `hostile` |
| 3 | "the answer conforms to the schema" against each profile | **FAIL** on three of four |
| 4 | "no authorization header" against a configured bearer token | **FAIL** |
| 5 | "the vision affordance is absent" against `frontier` | **FAIL** |
| 6 | "exactly one executable tool call" against `hostile` | **FAIL** (2 reported) |
| 7 | "the turn overflows the window" against a 5-character prompt | **FAIL** |
| 8 | "every parallel call comes back" with round 1's rule restored | **FAIL** — one spliced call |
| 9 | "the credential is not in this text" against `expose()` | **FAIL** |
| 10 | "the two transports agree" against a truncated batch | **FAIL** |
| 11 | "termination in single-digit ms" against a stalled socket | **FAIL, 810 ms** |

### 7.2 In-case positive controls (not counted above)

Case **12** carries its own, and it is the strongest control in this directory
because it is a *live channel* rather than a re-introduced defect: the same
sockets, the same providers, `reqwest`'s defaults instead of Vela's policy, and
**the canary arrives** — for exactly the three bindings upstream does not
protect. Case **13** carries the peer-send-buffer premise, which asserts the
encoding peers left no literal copy on the wire, so the literal pass genuinely
had nothing to match.

### 7.3 Round 3's executor controls, re-run live (`structural/control-results.txt`)

| # | control | expected | observed |
|---|---|---|---|
| E1–E5 | five compile bypasses against the real crate | all rejected, each for its own code | **all rejected**, E0308 / E0407 / E0616 / E0599 / E0277 |
| E6 | **DEFECT 1** — `next_chunk` hands bytes back unmodified | the leak suites go red | **5 red** across two suites *(round 3 recorded 17)* |
| E7 | **DEFECT 2** — `without_url()` and nothing re-attached | only endpoint-identity assertions go red | **exactly 2 red**, both endpoint-identity — unchanged from round 3 |
| E8 | **DEFECT 3** — `BodyStream::inner` made public | a compile probe starts compiling | **probe-03 COMPILED**, correctly detected |

**A correction to round 3's own table, measured rather than carried forward.**
Round 3 recorded DEFECT 1 turning **17 tests red across four suites**. On this
tree it turns **5 red across two**, and `finding_two_recipe` (was 3 red) and
round 2's `credential_canary` (was 1 red) now stay **fully green** under it:

```
  DEFECT 1, round 3 tree      probe 3/5 · streamed 10/15 · recipe 3/4 · canary 1/8  = 17
  DEFECT 1, round 4 tree      probe 2/5 · streamed  3/15 · recipe 0/4 · canary 0/8  =  5
```

That is not a regression in coverage — it is round 4's **second barrier** doing
its job. Breaking the byte scrub no longer breaks the whole pipeline, because
`decode_json` scrubs the decoded value afterwards and catches most of what gets
through. Defence in depth is worth having; the cost, stated plainly, is that
**a single control now under-reports how much of the redaction it disabled.**
That is exactly why round 4 injects the two barriers separately (E10, E11)
rather than relying on E6 alone.

The three surviving red tests under DEFECT 1 are the ones that read the *bytes*
rather than the rendered error — `positive_control_the_pre_fix_streamed_read_leaks`,
`positive_control_a_credential_split_across_two_chunks_leaks`, and the decorator
probes — which is the correct set for a defect in the byte stream.

### 7.4 Round 4's executor controls (`structural/control-results-round4.txt`) — 4 experiments, 11 FAILs

Baseline (with `--include-ignored`, so FINDING 3's test is counted rather than
skipped):

```
  wire_redirect_egress               6 passed; 0 failed
  encoded_credential_canary         11 passed; 0 failed
  zz_gate_m_round4_executor_probe    3 passed; 1 failed   <- FINDING 3, expected
  zz_integration_round4_probe        3 passed; 0 failed
  streamed_credential_canary        15 passed; 0 failed
```

| # | defect re-introduced | expected | observed |
|---|---|---|---|
| **E9** | **DEFECT 4** — the redirect policy removed; `reqwest`'s `Policy::limited(10)` and `referer: true` restored (the tree the round-3 critic failed) | the redirect suite goes red, the redaction suites do not | **4 red**, all in `wire_redirect_egress`; every redaction suite **green** |
| **E10** | **DEFECT 5** — BARRIER ONE: `scrub_bytes` stops resolving escape spans (round 3's tree exactly) | the encoding suite goes red, the redirect suite does not | **2 red** — `positive_control_a_byte_literal_scrub_is_undone_by_the_decoder`, `the_two_barriers_are_independent`; redirect **green** |
| **E11** | **DEFECT 6** — BARRIER TWO: `decode_json` stops calling `scrub_value` | a *different, narrower* set goes red | **1 red** — `the_two_barriers_are_independent` only |
| **E12** | **DEFECT 7** — `authority_of` compares scheme and host but drops the **port** | the redirect suite goes red; nothing else does | **4 red** in `wire_redirect_egress`; every redaction suite **green** |

**The four are disjoint in the way the gate needs.** E9 and E12 move only the
redirect axis; E10 and E11 move only the redaction axis, and they move it by
*different amounts* — 2 tests versus 1 — which is what shows the two barriers
are independently tested rather than jointly satisfied by one assertion.

E10 and E11 are injected **separately on purpose**. Commit `8e3d3ef` records a
session in which both were disabled at once and a probe still passed, which is
how a third, undesigned defence was found (`normalise_error_body`'s
decode/re-encode round trip normalises escaping). One defect at a time is the
only way to attribute anything.

E12 is the one worth dwelling on: dropping the port from the authority
comparison is the *plausible* weakening — it reads like a simplification, and it
would let a redirect to a **different service on the same host** through. It
turns four tests red, so the port check is load-bearing and asserted.

---

## 8. Gate verdict

| piece | verdict |
|---|---|
| 1. plain chat, streamed and not | **PASS** — identical on all four |
| 2. tool calling, including parallel | **PASS** — native, emulated and parallel; both transports agree call by call |
| 3. vision | **PASS** — offered only where probed |
| 4. structured output | **PASS** — never silently conformant |
| 5. context overflow | **PASS** — clean error, visible reduction |
| 6. reasoning | **PASS** — no leak, no swallow |
| 7. stream termination | **PASS** — credentialed medians 2.1–3.8 ms where a naive consumer hangs 5 s |
| 8. malformed frames | **PASS** — 166 characters against a strict consumer's 31 |
| 9. no credential | **PASS** — nothing on the wire, positively controlled |
| 10. failover | **PASS** — routes past a dead peer, names it, refuses to replay a killed one |
| 11. credentials in errors — **literal and JSON-escaped** | **PASS** — clean on every forced path, both bindings, both transports, all adapters |
| **12. redirect egress** | **PASS** — third party receives zero bytes on all four `Auth` variants × both calls; positively controlled against a live leak |
| **13. credentials in errors — other encodings** | ⛔ **FAIL** — see FINDING 3 |

**⛔ GATE M Part 1 (Phase B) FAILS.**

The gate criterion asks whether any piece crashes, hangs, silently produces
wrong output, offers an affordance the profile cannot support, or lets a
credential reach a host the user did not configure. **None of those is what
failed.** Nothing crashed, nothing hung, no affordance was over-offered, and
case 12 establishes that no credential reaches an unconfigured host — including
under a redirect, which is where it used to. The failure is the explicit
round-4 assertion that a credential must reach no `Display`, `Debug`, serde
rendering or `StreamEvent` sink, in §5.

Three things this executor wants on the record with the failure:

1. **The two defects round 4 was launched to fix are both closed, and were
   checked adversarially rather than read.** The redirect fix is proved against
   a live third party with a positive control that watches the canary arrive
   when the policy is removed; the encoding fix is proved against peers whose
   bytes contain no literal copy of the credential at all.
2. **FINDING 3 is one step further out along the same axis as the round-3
   functionality FAIL, and it is not the same defect.** Round 3's was "the
   scrub is byte-literal and a decoder undoes it". Round 4 fixed that for the
   decoder Vela runs. FINDING 3 is "the scrub is decoder-aware for one encoding
   and literal-with-one-hard-coded-alternative for another, and that
   alternative is missing on two of the three bindings Vela ships." Whether
   that pattern is convergence or thrash is the lead's call, not the executor's,
   and §5.3 gives both readings honestly.
3. **The executor's own instrumentation was wrong once and was fixed rather
   than filed.** The first draft of the lowercase-percent spelling lowercased
   the *whole* credential rather than only its hex digits — a spelling no
   encoder produces — and the probe duly reported a leak that was an artefact of
   its own construction. It was corrected before anything was believed, and the
   corrected spelling still leaks. This is the fourth consecutive round in
   which the gate executor caught its own tooling lying; that habit is why
   these results are worth believing.

**Nothing here has moved on GATE M Part 2** — a real llama.cpp endpoint — which
was not attempted and remains deferred to the desktop session.

---

## 9. What this run does NOT prove

* **Nothing about a real model.** Every endpoint is a mock. GATE M Part 2 stays
  deferred and is still the largest hole in the evidence base for the project.
* **Nothing about the OS keychain.** Exercised against `MemoryStore`.
* **Nothing about the packaged binary or the running app.** `conventions.md` §11.
* **Nothing about HTTPS.** Every socket here is plaintext loopback. The redirect
  policy treats `http`→`https` on the same host as a *different* authority and
  refuses it, which is asserted — but no TLS handshake was performed, so nothing
  here is evidence about certificate handling or about what `reqwest` does on a
  real scheme upgrade.
* **Nothing about a redirect *chain* longer than the two hops driven.** The
  same-authority hop limit (`MAX_SAME_AUTHORITY_REDIRECTS = 4`) is asserted by
  `wire_redirect_egress.rs`, not by the matrix.
* **Nothing about cases 00–10 on the Anthropic or Google adapters.** The
  capability matrix still drives `OpenAiCompatibleProvider` alone. Cases 11, 12
  and 13 and the credential suites drive all four adapters, but **only for the
  credential, error and egress paths.**
* **Nothing about `CompatProvider`'s discovery, capability probing or tool
  emulation.** Only its credential-in-error path is driven
  (`zz_integration_round4_probe.rs`).
* **Nothing about emulated tool calls in a long answer.** The `small-local` mock
  echoes at most 120 characters.
* **Nothing about sampling knobs, or prompt caching.** Sent and discarded; not
  implemented by any matrix endpoint.
* **Nothing about whether the encodings in FINDING 3 are ones a real gateway
  emits.** They are ones an encoder *can* emit, and one of them is the spelling
  Vela itself writes. The realism ranking in §5.1 is the executor's judgement,
  labelled as such.

---

## 10. Reproducing

```bash
bash docs/regression-baseline/phase-b-matrix/record.sh                 # the matrix: exits 1 (FINDING 3)
bash docs/regression-baseline/phase-b-matrix/structural/probe.sh       # 5 bypasses, all rejected
bash docs/regression-baseline/phase-b-matrix/structural/controls.sh    # round 3's defect injections
bash docs/regression-baseline/phase-b-matrix/structural/controls-round4.sh  # round 4's
cd src-tauri && cargo test -p vela-providers                           # green, 1 ignored (FINDING 3)
cd src-tauri && cargo test -p vela-providers -- --ignored              # FINDING 3, red
```

Needs Node 22+ on `PATH`. The recorder is
`src-tauri/crates/vela-providers/examples/gate_m_phase_b.rs`; it starts and stops
its own servers on OS-assigned ports, including the raw TCP peers for cases 11,
12 and 13. Wall-clock lines and ephemeral port numbers differ between runs;
everything else is byte-stable.

Both control scripts edit shipping source in place and restore it from a backup
on every exit path including a failure. `controls-round4.sh` touches `http.rs`
**and** `redact.rs`; if either is ever interrupted hard,
`git checkout src-tauri/crates/vela-providers/src/` is the recovery.

The three canaries are fake strings that were never credentials for anything.
The recorder asserts each appears only where it belongs — see §6.3 — so a future
run that scattered one into another case's evidence would fail the gate rather
than sit here unnoticed.
