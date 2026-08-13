# GATE M Part 1 — Phase C — the conversation surface meets the capability matrix

**Verdict: FAIL, on the context axis alone.**

On the capability axes the surface is sound: no profile crashed the UI, hung it, leaked
reasoning markup, dropped a malformed tool call, or offered an affordance its endpoint cannot
serve. Twenty-one of twenty-two assertions pass on all four profiles.

The failure is C5, and it is the same on all four. The gate asked, in as many words, whether the
UI *"shows the endpoint's real window and warns before exceeding it"*. It shows the window. It
does not warn — and while it is not warning, it displays **"About 0 of 200,000 tokens"** with a
message in the composer that is four times the window. That is not a missing warning; it is a
quantity on screen that is false, and a user who reads it concludes they have room they do not
have. See FINDING 2.

> **A revision, recorded rather than quietly made.** The first draft of this report classed C5
> as a wiring gap and said neither finding was a misrepresentation. That was wrong, and by my
> own criterion: the surface states a number about the turn the user is holding, and the number
> is wrong. A concurrent reviewing session reached the same conclusion independently and said so
> in commit `11c46d1`; I had already been re-reading the criterion when it landed, and I record
> both facts so the next reader can weigh the agreement for what it is worth rather than mistake
> it for two independent findings. FINDING 1 stands as classified — it is a blocking absence,
> not a false statement.

| | frontier | mid-local | small-local | hostile |
|---|---|---|---|---|
| assertions passed | 21/22 | 21/22 | 21/22 | 21/22 |
| the one failure | C5 | C5 | C5 | C5 |
| console errors | 0 | 0 | 0 | 0 |
| uncaught exceptions | 0 | 0 | 0 | 0 |
| browser→endpoint requests | 0 | 0 | 0 | 0 |
| time to first painted token | 29.2 ms | 28.9 ms | 22.1 ms | 18.6 ms |

Assertion controls: **21/21 behaved as expected** (`ASSERTION-CONTROL.tsv`, and the narrative in
`ASSERTION-CONTROL.md`). Every assertion above was also applied where it must not hold, and
failed there.

---

## 1. Honesty — read this before quoting any number

**Everything here is VERIFIED-BY-FAKE** (conventions.md §10).

- The endpoint is `tests/harness/mock-provider`, a deterministic mock. **No byte of any answer
  came from a language model.** Nothing here is evidence about llama.cpp, Ollama, vLLM, or any
  hosted API.
- The credential store is `MemoryStore`. The screenshots say `memory-fake` on the status line,
  because the app says so.
- The renderer ran in **Chromium on Linux**, not in the Tauri webview. Every visual and
  interaction judgement is **PROVISIONAL**; Linux WebKitGTK is not Windows WebView2 and neither
  is Chromium. Binding verdicts belong to `docs/desktop-gate/`.
- The transport between the renderer and the host is HTTP + SSE, not Tauri IPC. What that
  substitution can and cannot prove is set out in `tests/harness/ui-bridge/README.md`.
- The timings are browser figures on this container, through a relay that Tauri IPC does not
  have. They are an upper bound on the renderer's own cost, not a product claim.

What *is* real: the component tree under `src/`, the IPC contract, and the whole provider core —
stream normalisation, the reasoning splitter, tool accumulation, capability probing and the
degradation reports. Each command in the bridge delegates to the same
`vela_lib::ipc::<domain>::<fn>` its `#[tauri::command]` wrapper delegates to.

---

## 2. How it was driven

`tests/harness/ui-bridge/` mounts the **shipping `<App/>`** — same components, same CSS, same
contract — with a `RelayAdapter` in place of `TauriAdapter`. Behind the relay is
`src-tauri/examples/ui_matrix_bridge.rs`: the real IPC functions over a real
`OpenAiCompatibleProvider` against a real mock endpoint on a real loopback socket.

Each profile was driven twice: once against an endpoint with **no** inter-frame delay (where
time-to-first-token is measured, because a harness-imposed delay would be measuring the harness)
and once at **60 ms per frame** (where the incremental-rendering evidence comes from, because at
full speed a whole turn lands inside one animation frame and a renderer that could only draw
finished answers would look identical to one that streams).

Reproduce: `tests/harness/ui-bridge/README.md`.

---

## 3. FINDINGS

### FINDING 1 — the shipping host registers no providers, so the real app cannot chat at all

**Severity: blocking for Phase C. Not a UI defect.**

`AppState::for_runtime()` constructs an empty `ProviderRegistry`, and nothing ever adds to it.
`settings_put_provider` writes a settings row and stops there; no code path anywhere under
`src-tauri/src/` calls `ProviderRegistry::register`. `chat_send` resolves its provider out of
that registry, so in the packaged application every turn returns

```
NOT_FOUND: no provider configured with id `…`
```

even though the endpoint is visibly configured in the UI.

Demonstrated, not argued: control **K21** runs the bridge with `--no-register`, which is exactly
the shipping wiring, and shows `settings_get` returning one configured provider while
`chat_send` for that same id returns `NOT_FOUND`.

The bridge performs the missing registration itself, which is the only reason the rest of this
matrix could be exercised. **The UI surface is ready for a host that registers providers; the
host is not.** The fix belongs in `src-tauri/src/` — build the registry from the settings
repository, and rebuild it when `settings_put_provider` / `settings_delete_provider` change it.

### FINDING 2 — the context meter never sees the message you are about to send, and says "About 0"

**Severity: gate-failing. This is the one assertion that fails, and it fails on all four
profiles.**

The gate criterion was "does the UI show the endpoint's real window **and warn before exceeding
it**". The first half holds on every profile (C4). The second does not (**C5, the only failing
assertion in the run, on all four profiles**).

`ContextMeter` measures `ModelWorkspace`'s `turnTexts` prop plus the staged attachments.
`src/app/App.tsx` mounts `<ModelWorkspace hasHistory={…}>` and passes no `turnTexts`, and the
composer's draft lives in `Composer`'s own state inside the transcript below. So:

- typing 880,000 characters into the composer on `frontier` leaves the meter reading
  **"About 0 of 200,000 tokens"**;
- the same is true on every profile (`About 0 of 32K`, `of 8K`, `of 4K`);
- the transcript already on screen is not counted either.

The component is not broken — **C5b** stages a text file of the same size through the real
picker and the meter warns correctly ("this turn is larger than the window…"). Control **K6**
stages a small file and the same assertion fails, so C5b is not passing vacuously. The gap is
purely the wiring at the composition root: nothing hands the turn's text to the meter.

Consequence for a user: a message that will not fit is discovered by sending it. On `hostile`
(4,096 tokens) that is easy to hit by accident.

**Why this is a misrepresentation and not only an omission.** A meter that could not measure the
draft could say so — `contextBudget` already has an `unknown` verdict for exactly that case, and
`ContextMeter` renders it as a sentence with no bar. Instead the surface computes a figure from
an empty input and prints it as fact: *"About 0 of 200,000 tokens"*, with the bar drawn at zero,
above a composer holding 880,000 characters. The user is told they have room. Phase C's own
requirement is that degradation be **visible**; on the context axis the surface is not merely
silent, it is confidently wrong. That is why the gate verdict is FAIL rather than PASS-with-
findings.

**The narrowest honest fix** is not a redesign: pass the composer's draft and the transcript
into `ModelWorkspace`'s existing `turnTexts` prop. Until then, a meter that reported `unknown`
whenever it cannot see the turn would already be an improvement over one that reports zero.

### FINDING 3 — the composer cannot ask for tools, so no shipping path reaches a tool call

**Severity: incomplete feature, honestly rendered. Not a misrepresentation.**

`ChatSendReq` carries `turnId`, `providerId`, `modelId` and `messages`. There is no tool
catalogue on it, and `build_request` therefore constructs a `ChatRequest` with no tools. A mock
endpoint only produces tool calls when tools were offered, so **through the shipping path no
profile can ever produce a tool call** — including a malformed one.

That is why the tool axis was driven through a harness sentinel (`#tools …`), which makes the
bridge attach a one-tool catalogue to the request. Everything downstream of that request is the
real core against the real endpoint. Every tool-call screenshot in this directory is labelled
accordingly, and no screenshot here should be read as "the shipping composer produced this".

The rendering itself is correct and is the strongest part of the surface (see §4.3).

---

## 4. The axes, profile by profile

### 4.1 A complete streamed turn

| | frontier | mid-local | small-local | hostile |
|---|---|---|---|---|
| TTFT — first paint of anything | 29.2 ms | 28.9 ms | 22.1 ms | 18.6 ms |
| TTFT — first paint of *answer* text | 44.1 ms | 43.8 ms | 22.1 ms | 28.0 ms |
| whole turn | 44 ms | 44 ms | 29 ms | 28 ms |
| distinct paints at full speed | 2 | 2 | 3 | 2 |
| distinct paints at 60 ms/frame | 25 | 22 | 11 | 27 |

The gap between the two TTFT columns on `frontier`, `mid-local` and `hostile` is the reasoning
channel arriving first: the thinking block appears before the answer does, which is what those
endpoints actually send. `small-local` has no reasoning and the two coincide.

At full speed the surface commits twice — first token and terminal — which is the batching
`use-conversation.ts` documents: the first event and the terminal event bypass the frame queue,
everything between is coalesced. At 60 ms per frame the same turn paints 11–27 times, spread
across the life of the stream (C18). No jank was observed at either speed; a stall or a
double-render would show up as a flat or shrinking segment in `incremental-frames.json`, and
none is present.

**PASS on every profile.**

### 4.2 Reasoning

| | frontier | mid-local | small-local | hostile |
|---|---|---|---|---|
| transport | `reasoning_content` field | `<think>` split across frames | none | `<think>` opened twice, never closed |
| markup in any visible text | none | none | n/a | none |
| block rendered | yes | yes | correctly absent | yes, and marked |
| answer swallowed | no | no | n/a | no — 163 chars recovered and shown |

`hostile` is the interesting one. The block never closes, so:

- the summary reads **"Thinking (never closed)"** rather than "Thought process";
- the block stays **open** by default instead of collapsing, and carries a sentence saying the
  stream ended while it was open;
- the salvaged answer is shown *outside* the block as well, and a degradation note says
  **"The thinking block was never closed — 163 characters of answer were recovered from inside
  the block."**

Nothing was hidden and no `<think>` reached the page (C7, C12, C17 — the last of those measured
*mid-stream*, when a tag may be half-arrived). Control **K9** puts a literal `<think>` into the
live DOM and the same check fails, so C7 is not vacuous.

Screenshots: `*-thinking-collapsed.png`, `*-thinking-expanded.png` on every profile that has a
block, and `09-streamed-turn-complete.png` on hostile for the unterminated case.

**PASS on every profile.**

### 4.3 Tool calls

| | frontier | mid-local | small-local | hostile |
|---|---|---|---|---|
| what the core did | native | native | prompt emulation | native, and the endpoint sent junk |
| what the UI shows | a call card, "No result yet" | a call card | prose + an emulation notice | 2 cards, both marked refused |
| disclosure | — | — | "Tools were described in the prompt…" | "A tool call could not be read — they were not run" |

- **Malformed is visible and marked as refused.** Hostile's cards read *"Could not be read —
  Vela could not read this call: the arguments were not valid JSON. It was not run."*, with a
  **Show what arrived** disclosure that prints the raw bytes without re-serialising them, plus a
  degradation note counting them. Nothing is silently dropped. Control **K10** applies the same
  assertion to frontier's well-formed call and it fails.
- **Emulation is disclosed in plain words**, not with the word "emulated": *"This model has no
  built-in tool calling, so 1 tool was described in the prompt and the reply was read back for a
  call."* Control **K11** applies that check to a native call and it fails.
- On `small-local` the endpoint returned prose and no call was recovered — correct, and the
  notice still says what Vela did.

Read every one of these with FINDING 3 in mind: the request that produced them was built by the
harness, because the composer cannot build it.

**PASS on every profile.**

### 4.4 Vision

| | frontier | mid-local | small-local | hostile |
|---|---|---|---|---|
| endpoint vision | yes | no | no | no |
| capability flag the UI read | `true` | `false` | `false` | `false` |
| image affordance in the DOM | present | **absent** | **absent** | **absent** |

Absence was checked three independent ways, because a control can be reachable by any one of
them: the accessible name, the `data-testid`, and the file picker's own `accept` list. On the
three profiles without vision there is **no element** offering an image — not a disabled one —
and the picker's `accept` list contains no `image/` type at all. The composer's own attach
button is gone as well; what remains is a **"Text file"** control whose accessible name says so.
That is correct and deliberate: inlining a `.md` into a prompt needs no vision, and gating it on
vision would forbid a plain text file on a local model that handles it fine
(`src/features/attachments/attachment-rules.ts`).

Before any probe has run, **no** profile offers an image affordance (C1) — the pessimistic floor
holds, and the chip says "Capabilities unknown". Controls **K1**/**K2** apply each half of the
assertion to the wrong profile; both fail. Raw data: `attach-affordances.json`.

**PASS on every profile.**

### 4.5 Context window

Shown correctly on all four (C4): 200,000 · 32K · 8K · 4K. `formatTokens` writes exact multiples
of 1024 in binary units, so 32,768 renders as "32K" — the endpoint's real number, not a rounding.
The capability panel repeats it as a row. Control **K4** asserts frontier's window against
hostile's meter and fails; **K5** fails a meter that carries the right figure *and* a foreign one.

Warning before the turn: **FAIL — see FINDING 2.**

### 4.6 Empty, loading and error states

| State | Screenshot | Notes |
|---|---|---|
| empty — no conversations | `01-empty-no-conversations.png` | the home surface, with `PLATFORM browser` and `memory-fake` printed honestly |
| empty — conversation, nothing said | `02-empty-conversation-unprobed.png` | capability rows all "Not established"; nothing offered |
| loading — probe in flight | `04-probe-in-flight.png` | "Asking the endpoint…"; often already settled, the probe is single-digit ms |
| loading — turn in flight | `*-mid-stream.png` | partial answer, live thinking block, **Stop** replacing **Send** |
| error — endpoint unreachable | `*-error-endpoint-unreachable.png` | see below |

The error case is a real one: the driver kills the mock process, exactly as closing the terminal
running a local model would, and sends. Every profile shows

> **Could not reach the endpoint** — Vela could not open a connection.
> `http://127.0.0.1:PORT/v1/chat/completions`  ·  trace `0000000000000001`
> [Try again]

Vela's own words, the endpoint the *user* configured (redacted URL, no credential), a correlation
id pointing at the user's own opt-in local debug log, and a retry. No spinner is left running
(C15). Control **K13** applies the error assertion to a successful turn and it fails; **K20**
applies the "settled" assertion mid-flight and it fails.

**PASS on every profile.**

### 4.7 No credential

Every profile ran with **no API key at all**, against an endpoint that requires none — the
common local case. On all four the host reported `credentialCheck: satisfiedWithoutCredential`,
`usable: true`, `credentialPresent: false`, and the UI showed **no error, no warning badge and
no complaint** anywhere on screen (C13). The endpoints panel labels the endpoint **"No key
needed"** and renders no credential field. `security.level` is `none` and `concerns` is empty:
plaintext HTTP to loopback with no credential is not a risk and is not dressed up as one.

Control **K14** configures — through the real `settings_put_provider` — a remote endpoint that
genuinely requires a key, and the same assertion fails on the host's own `missingRequired`.

Screenshot: `*-endpoints-no-credential.png`. Raw: `provider-view.json`.

**PASS on every profile.**

### 4.8 Console and browser-side egress

Zero console errors and zero uncaught exceptions on every profile. The only console output is
Vite's dev handshake and React's DevTools suggestion (`console.txt`). Control **K16** emits one
deliberate `console.error` and the assertion fails, so the clean result is not an artefact of a
check that never looks.

**No request from the browser ever reached a model endpoint** (C20, C21). The full request log
is in `network.txt`: the Vite dev server, the relay's `/invoke` and `/events`, and nothing else.
Control **K17** makes the page really try — `fetch('http://127.0.0.1:PORT/v1/models')` from the
renderer — and records the result: **`refused: TypeError: Failed to fetch`**. The mock sends no
CORS headers and answers `OPTIONS` with 405, so the browser cannot reach it even when told to.
That is the measured fact the architecture is built on, re-confirmed from the renderer's side.

---

## 5. Observations that are not findings

1. **Hostile's junk tokens are rendered verbatim.** The hostile endpoint emits `</s>`,
   `<|im_start|>` and a U+FFFD replacement character inside its content. Vela shows them exactly
   as they arrived. Stripping them would mean shipping a list of one vendor's chat-template
   tokens into the renderer, which conventions §0.3 forbids, and silently altering a model's
   output is worse than showing it. Recorded so the next reader knows it was seen and decided.
2. **Hostile's probe reports `toolCalls: true`.** The endpoint claims native tool calling and
   then emits broken calls. The UI believes the probe — correctly, it has nothing else — and the
   breakage surfaces where it actually happens, in the call cards. No affordance was offered
   that the endpoint had denied.
3. **`adapter.kind` reads `browser` in the diagnostics list.** True, and left alone: the
   renderer really is in a browser. Saying `tauri` to make a screenshot look better would be the
   exact category of lie this gate exists to catch.
4. **A transient timeout was seen once** while driving a background tab in the controls script
   (one run of K10 timed out waiting for a turn to settle; the next two runs of the same script
   were clean, as were all matrix runs). It could not be reproduced. Recorded rather than
   omitted: it is the only unexplained observation of this gate.

---

## 6. Gate criterion, line by line

| The gate fails if, under any profile, the UI… | Observed |
|---|---|
| crashes | Never. Zero uncaught exceptions across four profiles |
| hangs | Never. Every turn settled, including hostile's stream with no `[DONE]` sentinel and the killed-endpoint case |
| shows an affordance the profile cannot support | Never. Image attach exists only on `frontier`; nothing is offered before a probe |
| leaks reasoning markup | Never — including mid-stream, and including the block hostile never closes |
| silently drops a malformed tool call | Never. Both hostile calls are on screen, marked refused, with the raw bytes available |
| misrepresents what the model can do | Every capability row, window figure and degradation matched the endpoint's real behaviour. But the context meter states a figure about the turn that is false whenever the composer holds text — see FINDING 2 |

**FAIL.** One axis, four profiles, one assertion: the context meter. Everything the gate asked
about *capabilities* — reasoning, tool calls, vision, degradation, errors, credentials, egress —
holds on every profile.

FINDING 1 is separately blocking for Phase C: the packaged application cannot reach any endpoint
at all, because nothing registers a provider. It is not counted in the verdict above only
because it is invisible from inside the matrix — the bridge had to fix it before a single
screenshot could be taken.

---

## 7. Files

```
phase-c-matrix/
├── RESULTS.md                    this file
├── ASSERTION-CONTROL.md          why each control is where it is
├── ASSERTION-CONTROL.tsv         21 controls, expected vs observed
└── <profile>/
    ├── NN-*.png                  16 screenshots, in the order they were taken
    ├── assertions.tsv            22 assertions, verdict and detail
    ├── capability-report.json    what the probe established
    ├── provider-view.json        the host's settings snapshot, credential check included
    ├── streamed-turn.json        the turn as the DOM held it: answer, reasoning, notes
    ├── tool-turn.json            same, for the tool turn
    ├── error-turn.json           same, for the unreachable-endpoint turn
    ├── core-events.json          every StreamEvent the core emitted, in order
    ├── incremental-frames.json   the paint timeline at 60 ms/frame
    ├── attach-affordances.json   every attach control in the DOM, and its accept list
    ├── timings.json              TTFT and turn duration
    ├── console.txt               every console message
    └── network.txt               every URL the browser requested
```
