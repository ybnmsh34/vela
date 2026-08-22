# Phase B — the OpenAI-compatible adapter (llama.cpp · Ollama · LM Studio · vLLM · generic)

**Recorded:** 2026-08-12 · **Scope:** `src-tauri/crates/vela-providers/src/compat/`
**Builds on:** `PROVIDER-CORE.md` (the normalisation layer this adapter delegates to)

---

## Read this before you read anything else

**Every result below is VERIFIED-BY-FAKE** (`docs/architecture/conventions.md`
§10). Two kinds of fake are used and they prove different amounts:

* **Live mock matrix** — the four capability profiles started as real OS
  processes and driven over real TCP. They serve `/props` and `/v1/models`, so
  for this adapter they present as a **llama.cpp-shaped** server. That is the
  one discovery path exercised end to end.
* **Scripted bytes** (`http::testing::ScriptedTransport`) — the Ollama, vLLM and
  LM Studio response shapes. Those shapes are taken from the projects'
  documented responses, **not** from a running server. No Ollama, vLLM or LM
  Studio instance was reached from this container, and GATE M Part 2 (a real
  llama.cpp at :8033) remains unverified.

Nothing here may be described as a real-model or real-server result.

---

## 1. What this adapter adds, and why each piece exists

| Divergence between servers | Answer | Test |
|---|---|---|
| `/v1/models` has at least four shapes; three families report the window in a field the core does not read | one parser reading `context_length`, `max_model_len`, `max_context_length`, `loaded_context_length`, `context_window`, `context_size`, `n_ctx` — **smallest wins** | `a_vllm_listing_yields_the_window_that_no_other_field_reports`, `lm_studios_loaded_window_beats_the_models_declared_maximum` |
| Only llama.cpp serves `/props`, only Ollama `/api/tags`, only LM Studio `/api/v0/models` | discovery identifies the family **by what it answers**, never by a name the user typed; a hint from the listing reorders the probes so a correctly-hinted server costs one request | `each_family_is_identified_by_a_field_only_it_reports`, `a_hint_moves_its_own_probe_to_the_front_without_dropping_the_others`, `every_profile_is_identified_by_what_it_serves_and_declares_its_own_window` (live) |
| A model listing may be absent entirely | three listing shapes tried in order; none is a *normal state* (`CapabilityUnsupported { ModelListing }` → free-text entry), not a failure | `a_listing_is_read_from_whichever_shape_the_server_serves`, `a_server_that_enumerates_nothing_is_a_normal_state_not_a_failure` |
| Error bodies are not the OpenAI shape on three of five families | `NormalisingTransport` rewrites them into it **at the transport seam**, before the core's mapper sees them | `llama_cpp_reports_a_numeric_code_and_would_otherwise_be_an_anonymous_400`, `vllm_puts_the_message_at_the_top_level_and_still_yields_both_token_counts`, `ollamas_bare_string_error_survives_as_a_model_not_found` |
| A server may declare nothing at all | conservative defaults: capabilities stay `Unknown`, and `Unknown` is not offerable | `an_unrecognised_server_stays_generic_rather_than_being_guessed` |
| A server declares things about itself that are not true (MEASURED-5) | **a declaration fills a gap and never overrules a probe; it can only ever withdraw an affordance, never grant one, and it may never speak for structured output** | `a_capability_the_server_omits_is_withdrawn_and_one_it_claims_is_not_granted`, `a_probe_that_watched_a_capability_work_outranks_a_declaration_that_denies_it` |
| Nothing is listening at all | reported as a transport failure, not as a model that "supports nothing" | `an_endpoint_nothing_answers_on_is_reported_as_unreachable_not_as_incapable`, `an_endpoint_that_is_not_running_is_unreachable_rather_than_incapable` (live) |
| An error body can stall (the core's `read_to_end` has no time bound) | the error-body read is bounded by `timeouts.stall`; a stalled body yields the status rather than hanging | `an_error_body_that_stalls_yields_the_status_instead_of_hanging` |

### The one behaviour worth reading the code for

MEASURED-7 recorded a clean `400 context_length_exceeded` from all four
profiles, and the canonical body names **both** the limit and what was
requested. That is not merely an error — it is a *measurement of the window*.
So the adapter records it and refits the conversation through the core's own
`fit_request`, then retries. Once, and only while nothing has reached the
screen: a retry that restarts a half-written answer is worse than the error it
was avoiding. A refusal that names no number teaches nothing, so nothing is
retried.

Live: `an_oversized_conversation_is_refitted_from_the_endpoints_own_refusal_and_retried`
(small-local, discovery off, window genuinely unknown → 400 → learn 8192 →
refit → 200, with `ContextReduced` + `FailedOver { attempts: 2 }` on the
response and **no** error ever reaching the sink).

---

## 2. Rules held by an asserting test

| Rule | Test |
|---|---|
| `Auth::None` sends **no** header — on discovery endpoints as well as chat (an empty Bearer is a 401 on every profile) | `no_credential_means_no_authorization_header_on_discovery_either`, `no_credential_means_no_authorization_header_anywhere_including_discovery` (live) |
| A configured credential reaches the discovery endpoints too | `a_configured_credential_reaches_the_discovery_endpoints_too` |
| Exactly one terminal event per turn, and never an `Error` before an answer | `the_user_sees_one_terminal_event_and_never_an_error_before_the_answer`, `a_turn_terminates_exactly_once_on_every_profile` (live) |
| No retry once a character has reached the screen | `nothing_is_retried_once_a_character_has_reached_the_screen` |
| At most one refit per turn — no loop | `a_second_overflow_after_refitting_is_surfaced_instead_of_looping` |
| Discovery runs once per provider, not once per turn | `discovery_runs_once_per_provider_not_once_per_turn` |
| What the core learns during a turn (a `tools_not_supported` refusal) survives into the next one | `what_the_core_learns_during_a_turn_is_kept_for_the_next_one` |
| No server identity reaches the UI flag set or any degradation | `no_server_identity_reaches_the_ui` |
| The core's degradations are not swallowed, reordered or duplicated by the sink wrapper | `the_hostile_profiles_degradations_still_arrive_through_the_adapter` (live) |
| A stalled stream is abandoned, and the sink is told | `a_stalled_stream_is_abandoned_rather_than_awaited_forever` |
| Cancellation stops before a byte is sent | `a_cancelled_turn_stops_before_anything_is_sent` |
| No affordance is offered that a profile cannot serve | `probing_never_offers_an_affordance_the_profile_cannot_serve` (live, all four) |

---

## 3. Verbatim test output

```
=== cargo test -p vela-providers --lib compat::
running 41 tests
test compat::discovery::tests::a_probe_that_watched_a_capability_work_outranks_a_declaration_that_denies_it ... ok
test compat::discovery::tests::a_hint_moves_its_own_probe_to_the_front_without_dropping_the_others ... ok
test compat::discovery::tests::a_capability_the_server_omits_is_withdrawn_and_one_it_claims_is_not_granted ... ok
test compat::discovery::tests::a_vllm_listing_yields_the_window_that_no_other_field_reports ... ok
test compat::discovery::tests::an_older_daemon_that_lists_no_capabilities_withdraws_nothing ... ok
test compat::discovery::tests::lm_studios_loaded_window_beats_the_models_declared_maximum ... ok
test compat::discovery::tests::ollamas_architecture_keyed_context_length_is_found_without_knowing_the_architecture ... ok
test compat::discovery::tests::only_a_transport_level_failure_counts_as_never_having_reached_a_server ... ok
test compat::discovery::tests::two_disagreeing_windows_resolve_to_the_smaller_one ... ok
test compat::discovery::tests::the_origin_is_used_for_root_endpoints_and_the_api_prefix_for_the_rest ... ok
test compat::error_shapes::tests::an_already_canonical_body_is_left_exactly_as_it_was ... ok
test compat::error_shapes::tests::an_authentication_type_maps_onto_the_auth_failure_that_never_fails_over ... ok
test compat::error_shapes::tests::an_unrecognised_message_falls_through_to_the_status_rather_than_being_guessed ... ok
test compat::error_shapes::tests::a_streamed_success_is_never_buffered_or_touched ... ok
test compat::error_shapes::tests::llama_cpp_reports_a_numeric_code_and_would_otherwise_be_an_anonymous_400 ... ok
test compat::error_shapes::tests::html_and_empty_bodies_are_passed_through_untouched ... ok
test compat::error_shapes::tests::ollamas_bare_string_error_survives_as_a_model_not_found ... ok
test compat::flavour::tests::a_proxy_that_answers_an_empty_object_is_not_mistaken_for_a_model_server ... ok
test compat::error_shapes::tests::vllm_puts_the_message_at_the_top_level_and_still_yields_both_token_counts ... ok
test compat::flavour::tests::an_unrecognised_server_stays_generic_rather_than_being_guessed ... ok
test compat::flavour::tests::each_family_is_identified_by_a_field_only_it_reports ... ok
test compat::flavour::tests::the_matrix_props_body_identifies_a_llama_cpp_shaped_server ... ok
test compat::provider::tests::a_cancelled_turn_stops_before_anything_is_sent ... ok
test compat::provider::tests::a_configured_credential_reaches_the_discovery_endpoints_too ... ok
test compat::provider::tests::a_listing_is_read_from_whichever_shape_the_server_serves ... ok
test compat::provider::tests::a_message_with_an_image_is_still_refused_when_a_probe_said_so ... ok
test compat::provider::tests::a_server_that_enumerates_nothing_is_a_normal_state_not_a_failure ... ok
test compat::provider::tests::a_refusal_that_names_no_number_is_reported_rather_than_retried ... ok
test compat::provider::tests::a_second_overflow_after_refitting_is_surfaced_instead_of_looping ... ok
test compat::provider::tests::an_endpoint_nothing_answers_on_is_reported_as_unreachable_not_as_incapable ... ok
test compat::provider::tests::a_vllm_style_overflow_teaches_the_window_and_the_turn_is_refitted_and_retried ... ok
test compat::provider::tests::discovery_finds_the_window_before_the_first_turn_so_it_is_fitted_first_time ... ok
test compat::provider::tests::discovery_runs_once_per_provider_not_once_per_turn ... ok
test compat::provider::tests::no_server_identity_reaches_the_ui ... ok
test compat::provider::tests::no_credential_means_no_authorization_header_on_discovery_either ... ok
test compat::provider::tests::the_finding_log_is_bounded_so_a_long_session_cannot_grow_it_without_limit ... ok
test compat::provider::tests::nothing_is_retried_once_a_character_has_reached_the_screen ... ok
test compat::provider::tests::what_the_core_learns_during_a_turn_is_kept_for_the_next_one ... ok
test compat::provider::tests::the_user_sees_one_terminal_event_and_never_an_error_before_the_answer ... ok
test compat::error_shapes::tests::an_error_body_that_stalls_yields_the_status_instead_of_hanging ... ok
test compat::provider::tests::a_stalled_stream_is_abandoned_rather_than_awaited_forever ... ok

test result: ok. 41 passed; 0 failed; 0 ignored; 0 measured; 201 filtered out; finished in 0.06s


=== cargo test -p vela-providers --test compat_live_matrix
running 9 tests
test control_the_same_conversation_is_refused_when_the_refit_is_switched_off ... ok
test an_oversized_conversation_is_refitted_from_the_endpoints_own_refusal_and_retried ... ok
test an_endpoint_that_is_not_running_is_unreachable_rather_than_incapable ... ok
test no_credential_means_no_authorization_header_anywhere_including_discovery ... ok
test once_the_window_is_known_the_next_turn_is_fitted_without_spending_a_refusal ... ok
test the_hostile_profiles_degradations_still_arrive_through_the_adapter ... ok
test a_turn_terminates_exactly_once_on_every_profile ... ok
test every_profile_is_identified_by_what_it_serves_and_declares_its_own_window ... ok
test probing_never_offers_an_affordance_the_profile_cannot_serve ... ok

test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.05s

```

Adjacent suites, unchanged by this work:

```
cargo test -p vela-providers --test mock_matrix_live           ok. 24 passed; 0 failed
cargo test -p vela-providers --test store_model_parity         ok.  6 passed; 0 failed
cargo test -p vela-settings --test capability_matrix_endpoints ok.  5 passed; 0 failed
```

`cargo clippy -p vela-providers --all-targets -- -D warnings` reports nothing in
`src/compat/` or `tests/compat_live_matrix.rs`; `cargo fmt --check` is clean for
both.

---

## 4. The controls — these assertions can fail

A test that cannot fail is decoration. Three controls are executed as tests:

1. **`control_the_same_conversation_is_refused_when_the_refit_is_switched_off`**
   (live) — the same oversized conversation against the same endpoint with
   `refit_on_context_overflow: false` **fails** with `ContextLengthExceeded`,
   and the failure reaches the sink. Without this, the recovery test could be
   passing because the harness was lenient.
2. **`llama_cpp_reports_a_numeric_code_and_would_otherwise_be_an_anonymous_400`**
   asserts the *unnormalised* behaviour first: the core's own mapper turns that
   body into `Transport { .. }`. The normalisation is therefore shown to be
   load-bearing rather than assumed to be.
3. **`a_refusal_that_names_no_number_is_reported_rather_than_retried`** and
   **`a_second_overflow_after_refitting_is_surfaced_instead_of_looping`** bound
   the retry in the other direction: it fires on evidence only, and never twice.

---

## 5. What is still not proved

* **No real server of any family was contacted.** The llama.cpp/Ollama/vLLM/LM
  Studio *shapes* are parsed correctly; whether a given release emits exactly
  those shapes is unverified here. GATE M Part 2 is where that changes for
  llama.cpp; Ollama, vLLM and LM Studio have no equivalent gate yet.
* **The prose-matching fallback** (`sniff_code`) is exercised only against the
  phrasings written into its tests. It is a last resort for servers that emit no
  machine-readable code, a miss falls through to the status-based mapping, and
  it can only ever produce two codes.
* **`/api/show`'s `capabilities` array** is parsed and tested, but no live
  Ollama daemon has been asked for one.
* Everything the core does not do here — the keychain, the packaged binary —
  remains as recorded in `PROVIDER-CORE.md` and `conventions.md` §10–11.

---

## 6. How to reproduce

```
cd src-tauri
cargo test -p vela-providers --lib compat::           # 41 unit tests, scripted bytes
cargo test -p vela-providers --test compat_live_matrix # 9 tests, four live mock servers
```

The live tests need Node 22+ on `PATH`; they start each profile with
`node tests/harness/mock-provider/src/cli.ts --profile <p> --port 0` and read
the port the OS assigned.
