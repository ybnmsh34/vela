# Assertion controls — GATE M Part 1, Phase C

Fifty-six experiments. **56/56 behaved as expected.** Machine-readable results in
`ASSERTION-CONTROL.tsv`; the script is `tests/harness/ui-bridge/controls.mjs`.

> **GATE M executor, this wave.** Eight experiments are new (K49–K56) and cover the staged
> attachment at both of the boundaries it has to cross. They are listed with the rest below.

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
| K22–K28 | C22–C24 | the first reading-surface set: a flattened heading scale, one that runs backwards, paragraphs put back on `pre-wrap`, and four thousand pixels of content in the column | PASS/FAIL | as wanted |
| K29 | C22b | baseline: structure-outranks-emphasis on the surface as it ships | PASS | PASS |
| K30 | C22b | `<strong>` put back on the user agent's 700 with every heading at 600 — **the inversion exactly as found** | FAIL | FAIL |
| K31 | C22b | `h5` and `h6` set at 13px under 15px of body text — the other half as found | FAIL | FAIL |
| K32 | C25 | baseline: the characters-per-line reading on the column as it ships | PASS | PASS |
| K33 | C25 | the column put back to the 688px it shipped with | FAIL | FAIL |
| K34 | C26 | baseline: a settled thinking block, closed | PASS | PASS |
| K35 | C26 | the same block opened — the pre-fix default | FAIL | FAIL |
| K36 | C27 | baseline: the thinking block rendering markdown | PASS | PASS |
| K37 | C27 | `<p>{text}</p>` with `pre-wrap` and the same reasoning text — **the defect exactly as it shipped** | FAIL | FAIL |
| K38 | C28 | baseline: nothing in the aside louder than the answer | PASS | PASS |
| K39 | C28 | a 24px heading inserted inside the aside | FAIL | FAIL |
| K40 | C29 | baseline: the transcript and the composer on one ruler | PASS | PASS |
| K41 | C29 | the composer's box put back to 736px over 688px of text | FAIL | FAIL |
| K42 | C30 | baseline: the sidebar giving way as the window narrows | PASS | PASS |
| K43 | C30 | the sidebar pinned inline at 480px — **the constant as it shipped** | FAIL | FAIL |
| K44 | C31 | baseline: the transcript faded into an edge that hides content | PASS | PASS |
| K45 | C31 | the mask removed while content is still hidden above the edge | FAIL | FAIL |
| K46 | C6b | the dropped-opening reader, on the transcript this repo **committed** at `4647556` (`mid-local`) | FAIL | FAIL |
| K47 | C6b | the same, on the transcript committed at `a936bad` (`small-local`) | FAIL | FAIL |
| K48 | C6b | the same reader on a turn that did arrive whole — the check is not stuck on FAIL | PASS | PASS |
| K49 | C33 | the composer's own attach button, with its handler removed by `cloneNode` — **a button that opens nothing, which is what shipped** | FAIL | FAIL |
| K50 | C32 | baseline: a staged text file reaching the payload and the wire | PASS | PASS |
| K51 | C32 | the same, with the file arriving unnamed — bare contents the model cannot tell from the question | FAIL | FAIL |
| K52 | C34 | baseline: a staged image reaching the payload and the wire | PASS | PASS |
| K53 | C34 | the payload with `parts` deleted — **the defect exactly as it shipped: Send discarded the picture** | FAIL | FAIL |
| K54 | C34 | the payload right and the endpoint's body carrying no image — the same defect one storey down | FAIL | FAIL |
| K55 | C35 | baseline: the endpoint offered an `image_url` content part | PASS | PASS |
| K56 | C35 | the base64 pasted into the prompt as prose — a body that *contains* the bytes and offers no image | FAIL | FAIL |

## The attachment set, and why it has two boundaries rather than one

The eighth instance of this project's defect class was an attachment feature whose every part
worked and which was joined to nothing. `useSelectedModel().attachments` had no reader, so pressing
Send discarded the user's picture without a word, and every component test passed — because every
one asked a component about its own state.

So C32/C34/C35 are read at the two places the bytes have to arrive, and each has a control that is
the failure *at that place*: **K53** deletes `parts` from what the renderer sent (the defect as it
shipped), and **K54** leaves the payload correct and empties what the core put on the wire (the
same defect in the Rust layer, which a renderer-side check could never see). **K56** is the one
that justifies parsing rather than substring-searching the endpoint body: base64 pasted into the
prompt text contains the bytes, so a body search alone would call it a pass.

**A stronger control than any of these was also run, and it is recorded outside this file.** The
whole browser matrix was re-driven against a scratch worktree with one line deleted from the
composition root — `attachments={attachments}` in `src/app/App.tsx` — and came back **37/40, with
C32, C34 and C35 red and nothing else moved**. C33 stayed green, correctly: that mutation removes
the payload wiring, not the button's handler. See
`../gate-m-conv1-executor/attachment-mutation.txt`.

## Why the second set breaks the live page rather than a fixture

Every K29–K45 breakage is applied to the **running application**, through `page.evaluate`, and each
one reproduces a state the operator actually saw on a real machine rather than a state invented to
be red. K37 in particular rebuilds the shipped renderer byte for byte — `<p>{text}</p>`, `pre-wrap`,
the same reasoning text flowing into it — so what the control proves is not "the reader can return
FAIL" but "the reader returns FAIL *on the defect it was written for*".

**K46/K47 — the only controls whose broken input is a file in this repository.**
`C6b` was written because for four gate runs the recorded transcript began mid-word and all
thirty-odd assertions passed anyway: an answer missing its first ninety-five characters is still
non-empty, still settled, still free of reasoning markup, still painted incrementally. Nothing
compared what was on screen to what the core had emitted. So these two controls do not invent a
broken turn — they read `streamed-turn.json` and `core-events.json` out of git at the two commits
where it happened, and put them through the same function the matrix run uses. The assertion has
to fail on the evidence that motivated it, or it is decoration. (The cause was in the harness, not
in Vela: see `tests/harness/ui-bridge/relay-adapter.ts`.)

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
