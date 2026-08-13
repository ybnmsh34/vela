# Phase B2 — the typed, closed error surface

**Piece:** `redesign:typed-closed-error-surface`
**Status:** landed. GATE M Part 1's round-4 open finding (FINDING 3) is closed.
**Honesty (conventions.md §10):** **VERIFIED-BY-FAKE.** Loopback peers,
`MemoryStore`, scripted bytes, deliberately broken sockets. No real model, no
real keychain, no packaged binary. GATE M Part 2 remains deferred to the desktop
session and is untouched by this work.

---

## 1. What was wrong, and why a fifth round would not have fixed it

Four consecutive rounds of Phase B died on one generative cause. `ProviderError`
carried a `detail: String` built from an endpoint's own error message. The
credential the user configured could be echoed back inside that message, so Vela
searched the message for spellings of the credential and forwarded the rest to
`Display`, `Debug`, the serde shape that crosses the IPC bridge, and the UI.

That is a **blocklist over an encoding an adversary chooses**, and it cannot be
completed:

| round | spelling found | closed |
|---|---|---|
| 3 | JSON string escapes (`\/`, `\uXXXX`) | yes |
| 4 | percent-encoded, uppercase hex, on header bindings | yes |
| 4 | percent-encoded, lowercase hex, on either binding | **no** |
| 4 | every byte percent-encoded | **no** |
| 4 | HTML entities (`&#x2f;`) | **no** |
| — | base64, mixed encodings, case-folding | never reached |

Two independent critics named the strategy rather than the instances.

## 2. What replaced it

**Endpoint-supplied text is not carried.** Not redacted, not truncated, not
laundered — not present.

`ProviderError` keeps its eight variants and its behaviour (`allows_failover`,
`allows_retry`, `retry_after`, `code`). Every `detail: String` became a
`diagnosis: Diagnosis`, and a `Diagnosis` is a closed set of things Vela
constructs itself:

| field | type | where it comes from |
|---|---|---|
| `cause` | `Cause` — 35 unit variants | a `match` arm in `src/diagnostic.rs`; the endpoint picks the arm, Vela writes the sentence |
| `status` | `Option<u16>` | the HTTP status line |
| `endpoint` | `Option<EndpointIdentity>` | parsed out of the `RequestUrl` **Vela built** |
| `filter` | `Option<FilterVerdict>` | closed enums + a five-bit category set |
| `correlation` | `CorrelationId` (`u64`) | a counter this process owns |

Plus the typed payloads the variants already had: `limit_tokens`,
`requested_tokens`, `retry_after_ms`, `capability`, `failure`, and
`ConfiguredModelId`.

**`error::detail()` is deleted.** So is `fallback(message, default)` — the
"use the endpoint's own words if it sent any" helper — from all three adapters.
Both were the strategy in one function, and leaving them present but unused
would have left the next contributor a way back to it.

### 2.1 What the endpoint can still influence

Exactly one channel, and it is deliberate: **integers**. `limit_tokens`,
`requested_tokens`, `retry_after_ms`, `status`, `generated_chars`. A `u16`,
`u32` or `u64` cannot spell a credential, an escape sequence or a sentence, and
"this conversation is 809 tokens over the model's 200 000-token window" is worth
more to a user than any prose the endpoint could have sent.

### 2.2 What `EndpointIdentity` carries *less* of than round 3

Round 3's endpoint was `RequestUrl::redacted()` — a string with
`?key=<redacted>` in it. `EndpointIdentity` is a *type* with two private fields,
and it drops:

* the **query string**, whole — so an `Auth::ApiKeyQuery` credential has no
  parameter left to be redacted inside;
* **userinfo** (`user:password@host`), the other place RFC 3986 lets a secret
  live in a URL;
* the fragment.

What it keeps is `scheme://host[:port]` and the path — which is exactly what
tells one configured candidate from another.

## 3. Diagnostics survive — the regression critic's round-3 objection

> *"An error nobody can act on is its own kind of regression. A user with three
> configured candidates must still learn which endpoint failed and why."*

Enforced by `tests/typed_closed_error_surface.rs::the_diagnosis_a_user_needs_survives`:
three dead ports produce three **pairwise distinct** errors, each naming its own
authority, its own path, its own failure class, and a reference into the debug
log.

Verbatim, the same failure across the run:

```
round 1  Connect: error sending request for url (http://127.0.0.1:1/v1/chat/completions)
round 2  Connect: error sending request                                    <- the regression
round 3  Connect: error sending request for url (http://127.0.0.1:1/v1/chat/completions)
B2       could not reach the endpoint (connect): the connection could not be
         established [endpoint http://127.0.0.1:1/v1/chat/completions] [ref 000000000000002a]
```

## 4. The body is kept — locally, opt-in, linked

`src/debuglog.rs`. The raw exchange goes to a sink the user installs, and:

* **off by default.** Nothing is written until `debuglog::enable(sink)` is
  called. Vela's posture is offline-first with no telemetry; a debug log that
  defaults to on is a log that gets attached to a bug report by accident.
* **never across IPC.** No serde surface the bridge carries, no Tauri command,
  nothing on `ProviderError` pointing at its contents. What crosses the bridge
  is a `u64`.
* **still scrubbed.** The bytes reach the log through `UpstreamBytes`, which
  means *after* round 3's byte scrubber. Turning the log on is not a way to opt
  into writing your own API key to a file. Asserted by
  `assert_the_body_reached_the_debug_log` in the encoded canary and by
  `the_recorded_body_never_appears_on_the_error_surface`.
* **linked.** `[ref 000000000000002a]` in the error is the key.

Three call sites feed it, all chokepoints: each adapter's `map_error_response`,
`UpstreamBytes::decode_json`, and `map_reqwest_error` (which is also where the
refused-redirect destination goes — see §6).

## 5. Why this is structural rather than a convention

### 5.1 Six `compile_fail` doctests, each with its error code asserted

| what a contributor would try | rejected as |
|---|---|
| `Diagnosis::new("the endpoint said …")` | E0308 — expected `Cause`, found `&str` |
| `String::from("upstream body").into()` → `Diagnosis` | E0277 — no `From<String>` |
| `vela_providers::error::detail("…")` | E0425 — the function does not exist |
| `EndpointIdentity::new("https://evil.invalid/…")` | E0599 — no such constructor |
| `String::from("https://evil.invalid/").into()` → `EndpointIdentity` | E0277 |
| `"whatever-the-peer-said".into()` → `ConfiguredModelId` | E0277 |

Plus the three round-3 doctests on `http::BodyStream` and `ResponseHeaders`,
which are unchanged and still pass.

### 5.2 The audit — the property checked from the other end

`diagnostic::unexplained_in_error(&error)` walks the whole serde surface and
returns every string leaf the closed vocabulary does not explain. The vocabulary
is **computed from the enums** (`Cause::ALL`, `Capability::ALL`,
`error::closed_vocabulary()`), not hand-listed, so adding a variant cannot
silently narrow it and adding a `String` field cannot slip through.

There is deliberately **no heuristic escape hatch**. An earlier draft exempted
strings that "look like an identifier"; that would have waved a purely
alphanumeric credential straight through, which is the exact class of mistake
this piece exists to end. The control
(`the_vocabulary_audit_can_detect_a_planted_string`) plants five spellings
including `skABCDEF0123456789` and watches the audit name each one.

### 5.3 The invariance test — the claim no encoding can defeat

`the_rendering_is_invariant_under_what_the_endpoint_sent` drives four peers that
answer the identical request with the identical status and the identical
machine-readable `code`, differing **only** in the bytes of `message`: empty, a
plain sentence, the credential in the clear, and the credential spelled one
`\uXXXX` escape per byte. All four produce **byte-identical** renderings on all
four surfaces (`Display`, `Debug`, serde JSON, `StreamEvent::Error`).

If the output does not vary with the input, the input is not a channel. That
subsumes every needle search in the crate and there is no fifth encoding to look
for.

## 6. One diagnosis deliberately given up

A **refused cross-authority redirect** used to name where the endpoint pointed:
`refused the endpoint's 302 redirect to a different host (A -> B)`. `B` is a
host the endpoint chose, in a `Location` header — endpoint-controlled text, and
therefore exactly what this design does not carry.

The user is now told that the endpoint they configured tried to send the request
somewhere else and Vela refused; **where** is in the debug log under the same
ref. `tests/wire_redirect_egress.rs` asserts both halves: the destination is
absent from every error surface, and present in the log.

This is the one place the redesign is a real, if small, diagnostics loss, and it
is recorded here rather than left for a critic to find.

## 7. The four rounds of canaries: kept, and **now vacuous**

All four suites still pass and are kept as regression coverage. **Most of them
now pass vacuously**, and that is stated at every site rather than left for a
green tick to imply otherwise: there is no endpoint text on the surface for a
needle to match, so a needle search *cannot* fail.

Every one of them therefore gained the stronger assertion the brief asked for —
`unexplained_in_error(&error).is_empty()`, "the error surface contains no
endpoint-derived text **at all**" — which is simpler and strictly stronger than
"contains no credential".

Several assertions **inverted**, and each inversion is argued at its site:

| suite | was | is |
|---|---|---|
| `encoded_credential_canary` | the peer's `MARKER` must reach the error | it must **not** — and must be in the debug log under the error's ref |
| `streamed_credential_canary` | `Auth::None` and `Auth::ApiKeyQuery` render differently (message vs `<redacted>`) | they render **byte-identically**, because neither carries the message |
| `streamed_credential_canary` | positive control: the pre-fix read leaks into the error | it leaks into the **bytes**; the error is clean even so — two independent barriers |
| `credential_canary` | positive control: build the pre-fix error and find the canary | the pre-fix error **does not compile**; the control proves the *detector* still works |
| `finding_two_recipe` part 3 | `Auth::None` keeps the endpoint's message | it does not, and the request target survives instead |
| `zz_gate_m_round3_executor_probe` | `<redacted>` must be visible in the named URL | there is no query to redact; authority and path are both asserted present |
| `zz_gate_m_round4_executor_probe` | `#[ignore]`, red | runs in the ordinary suite, green |

One measured finding worth recording: a `LaunderingTransport` that re-wraps a
body with `BodyOrigin::carries_no_credential()` now legitimately **loses its
endpoint identity**, because an origin that claims to know no endpoint produces
none. That is a diagnostics degradation the decorator asked for, not a leak, and
the round-3 probe now asserts both halves separately instead of comparing
renderings for string equality.

## 8. Scope note — `SchemaMismatch` is not on this surface

`SchemaMismatch { path, detail }` still has a `detail: String`. It is **not** a
`ProviderError`: it says how the *model's answer* failed the schema *the user
supplied*, both of which the user is already looking at. Its sanitiser moved out
of `error.rs` into `model.rs` as `SchemaMismatch::new`, deliberately away from
the error path, and the one call site that interpolated raw model output
(`anthropic/provider.rs`, "the model's structured answer was not usable JSON:
{raw}") no longer does.

## 9. The IPC type changed, and the frontend already agrees

`ProviderError`'s serde shape is a public IPC type. `src/platform/contract.ts`
mirrors it and has been updated by the concurrent Phase C session; the two were
checked mechanically and agree exactly — all 35 `Cause` codes, both directions,
no drift.

## 10. Evidence

```
cargo test -p vela-providers --test zz_gate_m_round4_executor_probe
    running 4 tests
    test what_each_spelling_actually_does ... ok
    test no_spelling_of_the_credential_survives_into_any_surface ... ok
    test a_credential_fragmented_across_two_real_tcp_writes_is_still_removed ... ok
    test result: ok. 4 passed; 0 failed; 0 ignored

cargo test -p vela-providers --test typed_closed_error_surface
    test result: ok. 7 passed; 0 failed; 0 ignored

cargo test --workspace --locked      all green, 40 test binaries
cargo test -p vela-providers --doc   12 passed; 0 failed; 1 ignored
cargo clippy --workspace --all-targets -- -D warnings    clean
cargo fmt --all --check              clean
pnpm typecheck / test (462) / test:harness (130) / build / test:transcripts / test:secrets (12)   all green
```
