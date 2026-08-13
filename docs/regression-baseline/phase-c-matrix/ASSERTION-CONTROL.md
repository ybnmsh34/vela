# Assertion controls — GATE M Part 1, Phase C

Twenty-one experiments. **21/21 behaved as expected.** Machine-readable results in
`ASSERTION-CONTROL.tsv`; the script is `tests/harness/ui-bridge/controls.mjs`.

A gate run that prints twenty-two green lines proves nothing unless those lines could have been
red. Every assertion in `tests/harness/ui-bridge/checks.mjs` is applied here to a case where it
must come out the other way. The controls **import the same functions the matrix run used** —
not copies — so a control that fails is evidence about the assertion that actually ran.

Where an experiment needs a broken state, the state is made real rather than simulated: markup is
put into the live DOM, a `console.error` is actually emitted, the page really fetches the model
endpoint, a credentialled endpoint is really configured through `settings_put_provider`.

## Which matrix assertion each control puts at risk

| Control | Puts at risk | What was done | Wanted | Got |
|---|---|---|---|---|
| K1 | C3 (vision absent) | asserted "no image affordance" against `frontier`, which has vision | FAIL | FAIL |
| K2 | C3 (vision present) | asserted "offers an image affordance" against `hostile`, which does not | FAIL | FAIL |
| K3 | C3 | same reader, on the profile it does hold for — the check is not stuck on one answer | PASS | PASS |
| K4 | C4 | asserted frontier's 200,000-token window against hostile's meter | FAIL | FAIL |
| K5 | C4 | a meter carrying the right figure **and** a foreign one — the stale-report shape | FAIL | FAIL |
| K6 | C5b | the overflow warning, with a staged file that fits comfortably | FAIL | FAIL |
| K7 | C1 | "an unprobed model claims nothing", applied after the probe has run | FAIL | FAIL |
| K8 | C7 | baseline: the markup check on the turn as it really rendered | PASS | PASS |
| K9 | C7 | the same check after `<think>leaked</think>` is appended to the answer paragraph **in the live DOM** | FAIL | FAIL |
| K10 | C11 (hostile) | the malformed-call assertion, applied to frontier's well-formed native call | FAIL | FAIL |
| K11 | C11 (small-local) | the emulation-disclosure assertion, applied to a natively-supported call | FAIL | FAIL |
| K12 | C9 | the usage assertion, told the endpoint reports nothing when it demonstrably does | FAIL | FAIL |
| K13 | C14 | the error-state assertion, applied to a turn that succeeded | FAIL | FAIL |
| K14 | C13 | the no-credential assertion, applied to an endpoint that genuinely requires a key — the host's own `missingRequired` verdict, from a real `settings_put_provider` | FAIL | FAIL |
| K15 | C19 | baseline: the console assertion on the run as it stood | PASS | PASS |
| K16 | C19 | the same, after one deliberate `console.error` in the page | FAIL | FAIL |
| K17 | C20/C21 | the egress assertion, after the renderer really requested the model endpoint | FAIL | FAIL |
| K18 | C18 | the incremental-paint assertion, against an endpoint with no inter-frame delay | FAIL | FAIL |
| K19 | C18 | and against a 120 ms endpoint, where it must hold | PASS | PASS |
| K20 | C6/C15 | the "turn is settled" assertion, applied while the turn is still in flight | FAIL | FAIL |
| K21 | FINDING 1 | the bridge run with `--no-register`, i.e. the shipping wiring | PASS | PASS |

## The three that carry the most weight

**K17 — the egress assertion, and why CORS is the point.** The matrix asserts that the browser
never requested a model endpoint. On its own that is satisfiable by a check that never looks. So
the control makes the page really do it: `fetch('http://127.0.0.1:PORT/v1/models')` from the
renderer. The assertion notices — and the browser is refused with `TypeError: Failed to fetch`,
because the mock sends no CORS headers and answers `OPTIONS` with 405. Both halves matter: the
check works, and the architectural reason all provider HTTP lives in the Rust core was
re-confirmed from inside the renderer.

**K18/K19 — the streaming evidence is not free.** `C18` claims the turn is painted incrementally.
Against a full-speed endpoint the same measurement gives three growth steps inside a few
milliseconds — React mounting the turn, swapping in the waiting line, then replacing it — which
a renderer that could only draw finished answers would also produce. So the assertion demands
six growth steps spread over at least 300 ms, and K18 shows it failing at full speed while K19
shows it holding at 120 ms per frame. That is why the matrix drives each profile through two
endpoints.

**K21 — FINDING 1, demonstrated rather than argued.** The bridge's `--no-register` flag makes it
behave exactly as the shipping host does: a provider row written by `settings_put_provider`, and
an empty `ProviderRegistry`. `settings_get` returns one configured provider; `chat_send` for that
same id returns `NOT_FOUND`. The finding is not an inference from reading `state.rs` — it is a
run.

## What is not controlled, and why

- **C2** (the capability flag equals the endpoint's real support) is a comparison against the
  profile table transcribed from `mock-provider/src/profiles.ts`. K1/K2/K4 exercise the same
  ground-truth table against the wrong profile, which is the same risk from the other end.
- **C8** (the answer is not swallowed) has no clean broken state to build without editing the
  renderer. Its weaker half is covered: K20 shows the settled-turn check failing mid-flight, and
  K9 shows the markup check failing on a real leak. This is the one assertion in the set that
  rests on inspection rather than on a control, and it is called out here rather than left to be
  discovered.
