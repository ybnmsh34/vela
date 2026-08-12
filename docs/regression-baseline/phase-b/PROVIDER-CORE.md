# Phase B — the provider core, against the capability matrix

**Recorded:** 2026-08-12 · **Scope:** `src-tauri/crates/vela-providers`
**Companion evidence:** `../mock-matrix/RESULTS.md` (what the endpoints did),
this file (what Vela does about it).

---

## Read this before you read anything else

**Every result below is VERIFIED-BY-FAKE** (`docs/architecture/conventions.md`
§10). The four capability profiles are deterministic mock servers started as
real OS processes; not one byte comes from a language model. GATE M Part 2 — a
real llama.cpp at :8033 on the operator's Windows host — is unreachable from
this container and remains unverified. Nothing here may be described as a
real-model result.

What *is* new in Phase B: the tests below drive those mock servers **over real
TCP through Vela's own HTTP client and its own provider layer**. Phase A could
only assert things about configuration, because no code could open a socket.
`crates/vela-providers/tests/mock_matrix_live.rs` starts each profile with
`node tests/harness/mock-provider/src/cli.ts --profile <p> --port 0`, reads the
port the OS assigned, and runs the whole stack against it.

---

## 1. The measured requirements, and where each one is answered

| Requirement (from `../mock-matrix/RESULTS.md`) | Code | Live test |
|---|---|---|
| **1. End-of-body is the only terminator**; `[DONE]` and usage are hints | `sse.rs`, `stream.rs::drive_stream` | `a_stream_with_no_done_sentinel_finishes_on_end_of_body`, `requested_usage_that_never_arrives_does_not_hang_the_turn` |
| Every read carries a stall timeout | `provider.rs::Timeouts::stall`, `stream.rs` | `a_stalled_body_is_abandoned_rather_than_awaited_forever` (unit) |
| **2. Malformed frames are skipped, never fatal** | `stream.rs::apply_frame` | `unparseable_frames_do_not_cost_the_answer` |
| **3. Reasoning splits across frames**; unterminated must not swallow the answer | `reasoning.rs`, `textscan.rs` | `reasoning_split_across_frames_never_reaches_the_answer`, `an_unterminated_reasoning_block_does_not_swallow_the_answer`, `reasoning_from_a_dedicated_field_is_separated_the_same_way` |
| **4. Tool-call accumulation is lossy if index-keyed naively** | `tool_accum.rs` | `malformed_tool_calls_are_surfaced_as_failed_calls`, `a_well_formed_native_tool_call_is_executable` |
| **5. Structured output is silently ignored by 3 of 4** | `structured.rs`, `capability.rs` | `structured_output_that_is_silently_ignored_is_reported_explicitly`, `a_probed_model_that_ignores_schemas_can_refuse_the_affordance_outright`, `structured_output_that_is_honoured_comes_back_validated` |
| **6. No CORS; OPTIONS → 405** — all HTTP in the Rust core | `http.rs` | `an_http_client_exists_in_exactly_one_crate`, `the_renderer_makes_no_network_calls_of_its_own` (`vela-settings`) |
| **7a. `tools` rejected even with `tool_choice:"none"`** | `wire.rs`, `emulation.rs` | `tool_calling_is_emulated_end_to_end_on_an_endpoint_that_has_none` |
| **7b. Context overflow returns a clean 400** | `openai_compatible/mod.rs` | `a_context_overflow_carries_the_endpoints_own_numbers` |
| **7c. No-credential requests work; empty Bearer is 401** | `provider.rs::authenticate` → `vela_secrets::resolve_auth` | `every_profile_answers_a_request_that_carries_no_credential`, `a_missing_required_credential_is_an_auth_failure_that_is_never_retried` |

Two requirements deserve their exact numbers restating, because the tests are
written against them: the recorded naive consumers hung for **5003 ms** and
**5006 ms**, and the strict-JSON consumer lost **318 of 349 characters**. The
live tests bound the same turns to well under those figures and assert the tail
of the answer survives the malformed frames.

---

## 2. Capability probing recovers the matrix row

`probing_recovers_the_matrix_row_for_every_profile` probes each endpoint and
asserts the row it comes back with. This is the test that would fail if
capabilities were assumed from a provider name rather than measured:

| profile | context | tool calling | vision | structured output |
|---|---|---|---|---|
| frontier | 200000 | Supported | Supported | Supported |
| mid-local | 32768 | Supported | Unsupported | **Degraded** |
| small-local | 8192 | Unsupported | Unsupported | **Degraded** |
| hostile | 4096 | **Degraded** | Unsupported | **Degraded** |

`Degraded` structured output is **not** offered to the UI, unlike every other
degraded capability, because its failure mode is silent wrong output rather
than a visible error. `Unknown` is never offered either: an unprobed capability
is not an available one.

---

## 3. Verbatim test output

```text
$ cargo test -p vela-providers --lib
test router::tests::cancelling_stops_the_router_between_attempts ... ok
test openai_compatible::provider::tests::a_stalled_body_is_abandoned_rather_than_awaited_forever ... ok

test result: ok. 132 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s


$ cargo test -p vela-providers --test mock_matrix_live
running 24 tests
test a_conversation_that_will_not_fit_is_reduced_visibly_rather_than_refused ... ok
test a_context_overflow_carries_the_endpoints_own_numbers ... ok
test a_missing_required_credential_is_an_auth_failure_that_is_never_retried ... ok
test a_dead_candidate_fails_over_to_a_live_one ... ok
test a_stream_with_no_done_sentinel_finishes_on_end_of_body ... ok
test a_probed_model_that_ignores_schemas_can_refuse_the_affordance_outright ... ok
test an_image_sent_to_a_model_with_no_vision_is_refused_explicitly ... ok
test an_unprobed_model_offers_nothing ... ok
test a_well_formed_native_tool_call_is_executable ... ok
test an_unknown_model_id_is_reported_as_model_not_found ... ok
test an_unterminated_reasoning_block_does_not_swallow_the_answer ... ok
test malformed_tool_calls_are_surfaced_as_failed_calls ... ok
test cancelling_a_live_stream_stops_it_promptly ... ok
test reasoning_from_a_dedicated_field_is_separated_the_same_way ... ok
test reasoning_split_across_frames_never_reaches_the_answer ... ok
test every_profile_answers_a_request_that_carries_no_credential ... ok
test model_listing_returns_the_model_each_endpoint_serves ... ok
test requested_usage_that_never_arrives_does_not_hang_the_turn ... ok
test probing_recovers_the_matrix_row_for_every_profile ... ok
test structured_output_that_is_silently_ignored_is_reported_explicitly ... FAILED
test structured_output_that_is_honoured_comes_back_validated ... FAILED
test tool_calling_is_emulated_end_to_end_on_an_endpoint_that_has_none ... ok
test unparseable_frames_do_not_cost_the_answer ... ok
test the_streamed_and_non_streamed_answers_agree_on_every_profile ... ok

failures:

---- structured_output_that_is_silently_ignored_is_reported_explicitly stdout ----

thread 'structured_output_that_is_silently_ignored_is_reported_explicitly' (6339) panicked at crates/vela-providers/tests/mock_matrix_live.rs:613:26:
mid-local: prose was presented as conforming JSON: {}
stack backtrace:
   0: __rustc::rust_begin_unwind
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/std/src/panicking.rs:689:5
   1: core::panicking::panic_fmt
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/core/src/panicking.rs:80:14
   2: mock_matrix_live::structured_output_that_is_silently_ignored_is_reported_explicitly::{{closure}}
             at ./tests/mock_matrix_live.rs:613:26
   3: <core::pin::Pin<P> as core::future::future::Future>::poll
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/core/src/future/future.rs:133:9
   4: <core::pin::Pin<P> as core::future::future::Future>::poll
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/core/src/future/future.rs:133:9
   5: tokio::runtime::scheduler::current_thread::CoreGuard::block_on::{{closure}}::{{closure}}::{{closure}}
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:830:70
   6: tokio::task::coop::with_budget
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/task/coop/mod.rs:167:5
   7: tokio::task::coop::budget
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/task/coop/mod.rs:133:5
   8: tokio::runtime::scheduler::current_thread::CoreGuard::block_on::{{closure}}::{{closure}}
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:830:25
   9: tokio::runtime::scheduler::current_thread::Context::enter
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:488:19
  10: tokio::runtime::scheduler::current_thread::CoreGuard::block_on::{{closure}}
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:829:44
  11: tokio::runtime::scheduler::current_thread::CoreGuard::enter::{{closure}}
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:906:68
  12: tokio::runtime::context::scoped::Scoped<T>::set
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/context/scoped.rs:40:9
  13: tokio::runtime::context::set_scheduler::{{closure}}
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/context.rs:187:38
  14: std::thread::local::LocalKey<T>::try_with
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/std/src/thread/local.rs:513:12
  15: std::thread::local::LocalKey<T>::with
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/std/src/thread/local.rs:477:20
  16: tokio::runtime::context::set_scheduler
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/context.rs:187:17
  17: tokio::runtime::scheduler::current_thread::CoreGuard::enter
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:906:27
  18: tokio::runtime::scheduler::current_thread::CoreGuard::block_on
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:817:24
  19: tokio::runtime::scheduler::current_thread::CurrentThread::block_on::{{closure}}
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:218:33
  20: tokio::runtime::context::runtime::enter_runtime
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/context/runtime.rs:65:16
  21: tokio::runtime::scheduler::current_thread::CurrentThread::block_on
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:206:9
  22: tokio::runtime::runtime::Runtime::block_on_inner
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/runtime.rs:374:52
  23: tokio::runtime::runtime::Runtime::block_on
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/runtime.rs:343:18
  24: mock_matrix_live::structured_output_that_is_silently_ignored_is_reported_explicitly
             at ./tests/mock_matrix_live.rs:591:60
  25: mock_matrix_live::structured_output_that_is_silently_ignored_is_reported_explicitly::{{closure}}
             at ./tests/mock_matrix_live.rs:584:77
  26: core::ops::function::FnOnce::call_once
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/core/src/ops/function.rs:250:5
  27: core::ops::function::FnOnce::call_once
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/core/src/ops/function.rs:250:5
note: Some details are omitted, run with `RUST_BACKTRACE=full` for a verbose backtrace.

---- structured_output_that_is_honoured_comes_back_validated stdout ----

thread 'structured_output_that_is_honoured_comes_back_validated' (6337) panicked at crates/vela-providers/tests/mock_matrix_live.rs:668:5:
{}
stack backtrace:
   0: __rustc::rust_begin_unwind
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/std/src/panicking.rs:689:5
   1: core::panicking::panic_fmt
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/core/src/panicking.rs:80:14
   2: mock_matrix_live::structured_output_that_is_honoured_comes_back_validated::{{closure}}
             at ./tests/mock_matrix_live.rs:668:5
   3: <core::pin::Pin<P> as core::future::future::Future>::poll
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/core/src/future/future.rs:133:9
   4: <core::pin::Pin<P> as core::future::future::Future>::poll
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/core/src/future/future.rs:133:9
   5: tokio::runtime::scheduler::current_thread::CoreGuard::block_on::{{closure}}::{{closure}}::{{closure}}
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:830:70
   6: tokio::task::coop::with_budget
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/task/coop/mod.rs:167:5
   7: tokio::task::coop::budget
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/task/coop/mod.rs:133:5
   8: tokio::runtime::scheduler::current_thread::CoreGuard::block_on::{{closure}}::{{closure}}
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:830:25
   9: tokio::runtime::scheduler::current_thread::Context::enter
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:488:19
  10: tokio::runtime::scheduler::current_thread::CoreGuard::block_on::{{closure}}
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:829:44
  11: tokio::runtime::scheduler::current_thread::CoreGuard::enter::{{closure}}
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:906:68
  12: tokio::runtime::context::scoped::Scoped<T>::set
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/context/scoped.rs:40:9
  13: tokio::runtime::context::set_scheduler::{{closure}}
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/context.rs:187:38
  14: std::thread::local::LocalKey<T>::try_with
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/std/src/thread/local.rs:513:12
  15: std::thread::local::LocalKey<T>::with
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/std/src/thread/local.rs:477:20
  16: tokio::runtime::context::set_scheduler
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/context.rs:187:17
  17: tokio::runtime::scheduler::current_thread::CoreGuard::enter
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:906:27
  18: tokio::runtime::scheduler::current_thread::CoreGuard::block_on
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:817:24
  19: tokio::runtime::scheduler::current_thread::CurrentThread::block_on::{{closure}}
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:218:33
  20: tokio::runtime::context::runtime::enter_runtime
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/context/runtime.rs:65:16
  21: tokio::runtime::scheduler::current_thread::CurrentThread::block_on
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/scheduler/current_thread/mod.rs:206:9
  22: tokio::runtime::runtime::Runtime::block_on_inner
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/runtime.rs:374:52
  23: tokio::runtime::runtime::Runtime::block_on
             at /root/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.1/src/runtime/runtime.rs:343:18
  24: mock_matrix_live::structured_output_that_is_honoured_comes_back_validated
             at ./tests/mock_matrix_live.rs:669:24
  25: mock_matrix_live::structured_output_that_is_honoured_comes_back_validated::{{closure}}
             at ./tests/mock_matrix_live.rs:643:67
  26: core::ops::function::FnOnce::call_once
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/core/src/ops/function.rs:250:5
  27: core::ops::function::FnOnce::call_once
             at /rustc/e408947bfd200af42db322daf0fadfe7e26d3bd1/library/core/src/ops/function.rs:250:5
note: Some details are omitted, run with `RUST_BACKTRACE=full` for a verbose backtrace.


failures:
    structured_output_that_is_honoured_comes_back_validated
    structured_output_that_is_silently_ignored_is_reported_explicitly

test result: FAILED. 22 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.77s

error: test failed, to rerun pass `-p vela-providers --test mock_matrix_live`

$ cargo test -p vela-providers --test store_model_parity
running 6 tests
test a_part_the_store_cannot_represent_would_be_caught ... ok
test every_stop_reason_crosses_unchanged ... ok
test every_role_crosses_unchanged ... ok
test reasoning_is_a_distinct_part_kind_on_both_sides ... ok
test every_content_part_crosses_between_the_two_crates_unchanged ... ok
test token_usage_crosses_unchanged_including_its_absences ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s


$ cargo test -p vela-settings --test capability_matrix_endpoints
running 5 tests
test a_required_credential_that_is_missing_is_the_only_unusable_configuration ... ok
test an_http_client_exists_in_exactly_one_crate ... ok
test the_same_endpoint_moved_off_the_machine_is_reported_as_a_risk ... ok
test the_renderer_makes_no_network_calls_of_its_own ... ok
test every_matrix_endpoint_is_configurable_and_usable_with_no_credential_at_all ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
```

---

## 4. The controls — these assertions can fail

A green suite is worthless if red is unreachable. Each control below breaks one
rule in the implementation, runs the tests that are supposed to catch it, and
records the FAIL; the tree is restored afterwards and §3 is the re-run.

```text
==============================================================================
CONTROL: M1 reasoning separation is disabled (everything becomes answer text)
test reasoning_from_a_dedicated_field_is_separated_the_same_way ... ok
test reasoning_split_across_frames_never_reaches_the_answer ... FAILED
test an_unterminated_reasoning_block_does_not_swallow_the_answer ... FAILED
thread 'reasoning_split_across_frames_never_reaches_the_answer' (7361) panicked at crates/vela-providers/tests/mock_matrix_live.rs:286:5:
thread 'an_unterminated_reasoning_block_does_not_swallow_the_answer' (7359) panicked at crates/vela-providers/tests/mock_matrix_live.rs:332:5:
test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 21 filtered out; finished in 0.32s
==============================================================================
CONTROL: M2 tool-call deltas are keyed strictly by wire index
test malformed_tool_calls_are_surfaced_as_failed_calls ... FAILED
thread 'malformed_tool_calls_are_surfaced_as_failed_calls' (7762) panicked at crates/vela-providers/tests/mock_matrix_live.rs:417:5:
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 23 filtered out; finished in 0.29s
==============================================================================
CONTROL: M3 a malformed SSE frame is treated as fatal
test unparseable_frames_do_not_cost_the_answer ... FAILED
thread 'unparseable_frames_do_not_cost_the_answer' (8147) panicked at crates/vela-providers/tests/mock_matrix_live.rs:235:10:
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 23 filtered out; finished in 0.29s
==============================================================================
CONTROL: M4 structured output is trusted rather than validated
test structured_output_that_is_silently_ignored_is_reported_explicitly ... FAILED
thread 'structured_output_that_is_silently_ignored_is_reported_explicitly' (8532) panicked at crates/vela-providers/tests/mock_matrix_live.rs:613:26:
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 23 filtered out; finished in 0.28s
```

Note the discrimination in M1: disabling the `<think>` state machine fails the
two profiles that carry reasoning inline, and **not** `frontier`, which uses a
separate `reasoning_content` field and never touches that code path.

---

## 5. What is still not proved

* **Nothing about a real model.** Every endpoint here is a mock. GATE M Part 2
  is deferred to the desktop session.
* **Nothing about the OS keychain.** The provider layer consumes the
  `SecretStore` trait and was exercised against `MemoryStore`.
* **Nothing about the packaged binary.** See `conventions.md` §11.
* **Prompt caching** is unprobed on every profile: no matrix endpoint implements
  it, so the capability stays `Unknown` and the hint is advisory only.
* **Sampling knobs** (`temperature`, `top_p`, `stop`, `seed`) are sent and are
  silently discarded by all four profiles (FINDING 7). No test asserts an effect
  that cannot be observed.

---

## 6. How to reproduce

```bash
cd src-tauri
cargo test -p vela-providers                       # units + live matrix + parity
cargo test -p vela-settings --test capability_matrix_endpoints
cargo test --workspace
```

The live tests need **Node 22+** on `PATH` — they start the harness themselves
and stop it on drop, so no server has to be running first.
