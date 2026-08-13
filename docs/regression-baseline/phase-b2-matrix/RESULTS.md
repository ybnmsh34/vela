# GATE M Part 1 — Phase B2 — RESULTS

**Verdict: FAIL.** One defect, found by the coverage this phase was created to add,
reproduced on all three adapters and both transports, with a control that isolates its
cause to a single accessor. Everything Phase B earned is intact and is re-verified live.

| | |
|---|---|
| gate assertions | **1455** (round 4: 471) |
| failures | **24** — all of them FINDING 4, case 16 |
| controls | **25 experiments, 46 verdicts, 31 recorded expected FAILs** in the recorder, plus **7 defect injections** in a scratch copy |
| adapters driven | **3** — `OpenAiCompatible`, `Anthropic`, `Google` (round 4 drove 1) |
| profiles | 4 — `frontier`, `mid-local`, `small-local`, `hostile` |
| wall clock | ~26 s |
| honesty | **VERIFIED-BY-FAKE.** GATE M Part 2 not attempted, still unverified. |

Reproduce: `bash docs/regression-baseline/phase-b2-matrix/record.sh` — exits 1.

---

## 1. What this phase did differently, and why it was worth doing

Four gate rounds drove the matrix **case by case**. Every case was driven; **every pair
of cases was not.** FINDING 3 — an unterminated `<think>` turning a model's *refusal* to
run `delete_everything` into an executable call — lived in the pair (case 06 reasoning,
case 02 tools) and survived four rounds because nothing ever put them in one turn.

B2's premise was that the blind spot is the size of the cross product, not the size of
any case. Six cross-product cases were added. **One of them is red**, and it is red in
exactly the way the premise predicted: a pair of individually-correct behaviours whose
intersection nobody had driven.

A second structural gap was closed at the same time. Cases 00–14 drive
`OpenAiCompatibleProvider` **and nothing else**, so every property four rounds
established was a property of one adapter out of three. Cases 15–20 drive all three.

---

## 2. Round 4's assertions, re-driven — and the five that were inverted

Every case `00`–`14` was re-run live. **Five assertions failed against the B2 tree on
the first run.** None was a regression: all five were round-4 assertions about the error
surface B2 deliberately replaced. They are **inverted, not deleted**, each argued at its
site in `examples/gate_m_phase_b2.rs`.

| case | round 4 asserted | B2 asserts | why |
|---|---|---|---|
| `09b` | "no upstream body **or HTTP status** escapes into the error" | no upstream **body text** escapes — **and, stronger**, every string in the serde shape is drawn from the closed vocabulary; **and** the status IS carried, as a typed `u16` | B2 carries the status deliberately. It is one of five typed fields, it is Vela's own parse of the status line, and it is the most useful thing a user can be told. Failing a gate for doing what the gate asked would be the dishonest move |
| `11` | "no `provider_*` command crosses the IPC bridge" | the same, asked correctly | **the probe was lying.** `contract.ts.contains("provider_")` matches `'no_provider_configured'` — a `Cause` **code**, not a command. It failed the gate for a fact that was not true. Fixed and re-run rather than filed; the transcript prints what the old probe would have said |
| `12` | "the error names **BOTH** authorities — who redirected, and where to" | the error names the **configured** authority and **NOT** the redirect target | the target is a host **the endpoint chose**. Printing it is the exact defect four rounds died on, with the extra sting that a hostile endpoint picks the "hostname". It is in the debug log under the correlation id. Recorded as a diagnostics **degradation**, not sold as a win |
| `13` | "the endpoint's message reached the error on every arm — nothing below is vacuous" | **the endpoint's message reaches the error on NO arm** — plus the premise moved upstream (the peer put it on the socket), plus the strongest form (0 unexplained strings) | B2 deleted the field it arrived in, so the canary search below is now **genuinely vacuous**. A vacuous test reading green is a trap, so vacuity is asserted **directly** and a stronger assertion added beside it |
| `13` | "redaction, not deletion — `<redacted>` is present" | **deletion, not redaction** — no `<redacted>` marker on the error surface either | a masking marker on the error surface would now mean a laundering step had crept back. The marker still belongs on the URL and in the debug log |

**The four rounds of canaries are kept.** They are regression coverage, they still run on
every profile, and cases `11`, `12` and `13` between them contribute 136 assertions.

### 2.1 The regression critic's standing complaint — closed, with a number

Round 4's latency case measured a credentialed provider against **222 characters with
zero backslash bytes**. `Scrubber::touches` early-outs on a chunk with no `\` and no
literal needle; `encoded_spans` never runs; `hold_back_len` returns 0 on every chunk.
The arm was credentialed; **the measurement was not.**

Case `07c` gains **arm C**, whose peer streams a body built so none of those three can
skip, and which prints the counts **read off the wire**:

| measured on the wire, per five-turn arm | round 4's arm B | B2's arm C |
|---|---|---|
| backslash bytes | **0** | **4 200** |
| `\u00XX` escapes | 0 | **600** |
| near-miss credential prefixes ending a frame | 0 | **150** |
| median termination | 3–5 ms | **5.0 ms** |

Round 4's own payload is kept as **CONTROL 20**, where it is applied to arm C's
assertion and recorded failing at `4881 body characters, 0 backslash byte(s)`. The
complaint is now a measurement rather than an argument, and a future round can see at a
glance whether the arm has gone hollow again.

---

## 3. FINDING 4 — deliberation becomes a validated answer. **THE GATE FAILURE.**

**Case 16 — reasoning × structured output. Red on all three adapters, both transports,
all four profiles. 24 failing assertions.**

### The turn

A model asked for JSON deliberates *in JSON*, rejects the value it wrote, and is cut off
by its token budget before closing the block:

```
<think>The user wants an object. My first guess is
{"city":"Atlantis","celsius":-273.15} — no, that city does not exist and
that temperature is below absolute zero, so I must
```

Both halves are routine. An unterminated `<think>` on `length` is what a small local
model does — `hostile` does it in case 06. Deliberating in JSON is what a model asked
for JSON does.

### What Vela returns

```
STRUCTURED VERDICT   Some(Ok(Object {"celsius": Number(-273.15), "city": String("Atlantis")}))
degradations         UnterminatedReasoning { recovered_answer_chars: … }
```

`Some(Ok(value))` from a schema-validated field is Vela telling the caller **the model
produced this value.** The model did the opposite: it wrote the value and said it was
wrong. The only place that fact lives is the prose around the JSON, which the schema
checker does not read.

### Why it is the same defect as FINDING 3

FINDING 3 was *deliberation becoming an executed action*. This is *deliberation becoming
an answer* — the same failure in the data channel rather than the action channel, and
the same severity, because a caller that destructures `Ok(value)` has been told
something untrue about what the model did.

**The fix for FINDING 3 was a chokepoint that already exists.** `answer.rs` defines:

```rust
/// **The only text a tool parser may see**: committed answer text, with
/// reasoning excluded by construction and salvaged text excluded by
/// [`Provenance::Salvaged`]'s argument.
pub fn executable_text(&self) -> &str
```

All three adapters call `structured::check_answer(schema, &response.answer_text())` —
the **visible** answer, which by construction includes the salvaged text of a block that
never closed. The schema checker is exactly the same kind of consumer as the tool
parser: it turns model text into a machine-consumed value. **The chokepoint was
installed on one consumer and not the other.**

- `openai_compatible/provider.rs:400`, `:668`
- `anthropic/provider.rs:515`, `:843`
- `google/provider.rs:522`, `:873`

### Two controls localise it precisely

**In-case control (case 16, six arms).** The identical peer, differing by the eight
characters `</think>` and nothing else, returns the correct verdict on **all six arms**.
The cause is the intersection and nothing else.

**CONTROL 13.** The same schema applied to the two candidate inputs:

```
over answer_text()        Ok(Object {"celsius": -273.15, "city": "Atlantis"})   → FAIL
over executable_text()    Err(SchemaMismatch { … "the model returned prose,
                              not JSON — the schema was ignored" })             → PASS
```

One accessor apart.

### It is reported, not fixed, and that is deliberate

I am the executor. A defect I fix in the same session is a defect I also grade, and this
run's own rules forbid manufacturing agreement. The failing assertions stay in the
recorder as the acceptance test for whoever does fix it.

**Two candidate fixes, and what the evidence says about each:**

1. **Validate over committed text, not visible text.** Reuses machinery built for this
   exact reason, on the argument already written down in `answer.rs`. Not measured here.
2. **Stop `extract_json` scavenging a loose object out of prose.** Measured, as
   **DEFECT 2** in `structural/control-results-b2.txt` — a *positive* control, applied
   in a scratch copy only. Result: **gate failures 24 → 0**, nothing else in the matrix
   moves. But it also removes a real capability — a model answering "Here is your JSON:
   `{…}`" — and `structured.rs`'s own unit test asserts inline extraction works. The
   recorder does not run unit tests, so **this measurement understates that fix's cost**,
   and it is recorded here rather than left for a reader to discover.

Fix (1) is the one the evidence points at. Fix (2) is in the file because measuring the
obvious fix is how you find out it is not the right one.

---

## 4. The other five cross products — all green, and what each actually proves

### 4.1 Case 15 — reasoning × tools × **every adapter** × both transports (184 assertions)

FINDING 3's turn, verbatim, down all three adapters. The three enter emulation by three
different routes, and the case drives the **production** route in each rather than a test
flag:

| adapter | route into emulation | outcome |
|---|---|---|
| `openai-compatible` | retry after the endpoint's own `400 tools_not_supported` | quarantined, reported, not executable |
| `google` | `probe_capabilities` learns `ToolCalling: Unsupported` from a refused `functionDeclarations`, and the turn then emulates | quarantined, reported, not executable |
| `anthropic` | **structurally unreachable** | refuses the turn |

The Anthropic arm is the interesting one. That adapter has no `with_tool_emulation` call
site at all, and refuses instead — its own source says why: *"Refusing is truthful;
rewriting the request into prompt emulation behind the user's back would not be."* So
the case asserts the refusal, asserts it is neither retried nor failed over into an
unsupported affordance, and **greps the adapter to prove emulation is absent** — with
CONTROL 21 recording that grep failing, so the day someone attaches emulation there,
this arm stops being true out loud instead of quietly.

On the two adapters that do emulate, every arm shows the same shape:

```
answer      "I could call  but that would be destructive, so I will not."
reasoning   "I could call <tool_call>{"name":"delete_everything",…}</tool_call> but …"
tool calls  MALFORMED … reason=RecoveredFromUnterminatedReasoning
stop reason MaxTokens          (never ToolUse)
```

### 4.2 Case 17 — tools × malformed frames (144 assertions)

Two recorded requirements collide here: **MEASURED-2** says skip a bad frame and keep
going; **MEASURED-4** says `index` is the only join key — and it lives in the frames a
skip removes.

Four kinds of junk woven between the fragments of three real parallel calls, on all
three dialects. The fourth kind is the dangerous one: **a truncated frame that is the
prefix of a real call.**

```
degradations             MalformedFramesSkipped { count: 3 }
well-formed fingerprints ["get_weather({"city":"Berlin"})",
                          "get_weather({"city":"Paris"})",
                          "get_time({"zone":"CET"})"]
```

Three sent, three recovered, none spliced, no phantom fourth. The non-streamed arm
drives FINDING 1's other half — a batch of three whose **middle** element is broken —
and the two intact calls survive with the broken one reported.

### 4.3 Case 18 — error-echo × every adapter × both transports (40 assertions)

The stronger property the brief asked for, answered two independent ways because either
alone is weak:

1. **Audit.** `diagnostic::unexplained_strings` walks the serde shape and returns every
   string leaf not in the closed vocabulary — which is **computed from the enums**.
   Result: **0 unexplained strings, every arm.**
2. **Invariance.** Four peers, one port, identical status and `code`, differing **only**
   in the bytes of `message`: empty · prose · a marker in the clear · the same marker as
   one `\uXXXX` escape per byte. Result: **byte-identical** `Display`, `Debug`, serde IPC
   shape and every `StreamEvent`, on all three adapters and both transport shapes.

Premise, read off the wire, not assumed: **12 of 12** marker-carrying arms saw it arrive.

Only two values are normalised before comparison — the correlation id and nothing else —
and `strip_correlation` does it structurally, by named shape, so it cannot touch an IP,
a port or a status. It is called out in the source because the first draft did it with a
`String::replace` and turned `127.0.0.1` into `<n>.0.0.1`, which made the gate red for a
reason that was not true.

### 4.4 Case 19 — cancellation × tool accumulation — **executor's pick #1** (56 assertions)

**Why I picked it.** FINDING 3 is "a call the model never finished becomes executable".
The model truncating itself is one way a call arrives half-built. There is a second, and
in a desktop app it is far more common: **the user presses stop.** Cancellation and tool
accumulation had each been driven alone and never together — the same gap shape FINDING
3 sat in for four rounds.

A batch of parallel calls, streamed, socket going silent one third of the way through,
cancel fired at 120 ms. On all three adapters: `Cancelled` at ~121 ms, no `ChatResponse`,
no `Done` event on the sink, and no retry or failover.

**And then through the `Router`, with a second candidate waiting** — because a
provider-level answer is not enough. If cancellation were treated as a transport hiccup,
the user's stop would **start** a turn rather than end one, running the same tool call
against a second endpoint.

```
requests the SECOND candidate received   0
router outcome                           Cancelled
```

**DEFECT 6** injects the opposite — `Cancelled => allows_failover() = true` — and case 19
goes red by 12 assertions while CONTROL 17's line flips. The rule is load-bearing.

### 4.5 Case 20 — the sibling surfaces × endpoint text — **executor's pick #2** (300 assertions)

**Why I picked it.** B2's thesis is that untrusted bytes must not cross the IPC boundary,
and B2 delivered that — **for `ProviderError`**. `ChatResponse` crosses the same bridge
and has three string-bearing fields nobody had ever audited:

```
Degradation::StructuredOutputMismatch { detail }
SchemaMismatch { path, detail }
ToolCallOutcome::Malformed { raw_arguments }
```

Every argument that made the error surface dangerous applies verbatim. The reason nobody
looked is that these live on the **success** path, and four rounds of security work all
started from an error. That is a category boundary, not a safety property.

The answer is not "these must carry nothing" — `raw_arguments` carries the model's broken
payload **on purpose**, so a user can see what the model was trying to do with a call
Vela refused to run. So the case asks the three questions that matter, with a hostile
11 610-character payload:

| question | answer |
|---|---|
| is `SchemaMismatch::detail` Vela's own words? | **yes** — `"expected number, got string"`, no endpoint bytes |
| is `path` from the user's own schema? | **yes** — `/celsius` |
| does any `Degradation` carry endpoint text? | **no** |
| is the deliberate carry bounded? | **yes** — 401 characters from an 11 610-character payload |
| does the answer text carry it? | **yes, and that is correct** — the model's answer is the model's answer; this case is about the metadata |
| does any of it reach the error surface? | **no** — identical hostile bytes on the error path, 0 unexplained strings |

**This case found a gap in itself, and the gap is recorded rather than smoothed over.**
The first version covered the bound in `tool_accum::truncate` and missed the one in
`answer::bounded` — the bound on a call salvaged out of deliberation. **DEFECT 4**
raised both, and the case did not notice one of them. *Two bounds, in two files, one
covered* is precisely the shape the round-4 report named as the reason percent-encoding
was fixed for one binding of three, and this case had reproduced it. Arm 2b was added;
DEFECT 4 now moves the count.

---

## 5. Gate criteria, one line each

| criterion | verdict |
|---|---|
| crashes under any profile | **no** — 1455 assertions across 4 profiles × 3 adapters, no panic |
| hangs | **no** — worst case 121 ms under cancellation; latency medians 3–5 ms against a recorded 5003 ms naive hang |
| **silently produces wrong output** | **YES — FINDING 4.** A rejected value returned as a schema-validated answer, with `UnterminatedReasoning` on the response as the only clue, and nothing forcing a caller to read it |
| offers an unsupported affordance | **no** — Anthropic refuses tool calling rather than emulating behind the user's back (case 15); case 00 and case 03 unchanged |
| lets a credential reach an unconfigured host | **no** — case 12: third party accepted **0 connections, 0 bytes**, all five bindings, both transports |
| lets endpoint text reach an error surface | **no** — case 18: 0 unexplained strings and byte-invariance across four peer messages, on all three adapters |
| **lets deliberation become an executed action** | **no** — cases 14, 15, 19 across three adapters and both transports; `delete_everything` is quarantined, reported and non-executable everywhere it can be reached |

The failure is the third row. It is the *data* form of the seventh, and it is why the
gate verdict is FAIL rather than PASS-with-a-note.

---

## 6. ASSERTION CONTROL — 32 experiments, 40 recorded expected FAILs

An assertion nobody has watched fail is not evidence. The unit is round 4's, so the
comparison is like for like, and the flattering unit is given second rather than first.

| source | experiments | recorded expected FAILs |
|---|---|---|
| the recorder's controls (`ASSERTION-CONTROL.txt`) | 25 | **31** (of 46 verdicts) |
| defect injections (`structural/control-results-b2.txt`) | 7 | **9** — 8 newly-red *cases* + 1 control line flipping to FAIL |
| **total** | **32** | **40** |
| *round 4, for comparison* | *36* | *39* |

Two further injection effects are recorded and are deliberately **not** counted as
FAILs, because they are flips toward PASS: DEFECT 2 (the candidate fix for FINDING 4)
turns CONTROL 13 green, and DEFECT 7 turns CONTROL 15's bare-identifier line green by
blinding the audit. Both are informative; neither is a control failing.

In the recorder's own finer unit — newly-red **assertions** rather than newly-red cases
— the seven injections produce **109** (64 + 24 + 4 + 5 + 12), which would make the
total 140. That number is not the headline because it is not comparable with round 4's.

### 6.1 The recorder's controls — 25 experiments, 31 FAIL

Round 4's eleven are kept and still run. B2 adds fourteen, one per new assertion:

| control | applied where it must not hold | result |
|---|---|---|
| **12** | "a call from a never-closed `<think>` is not executable" → the **pre-FINDING-3 consumer** | **FAIL** — 1 call, **EXECUTABLE `delete_everything`** |
| **13** | the schema check over `answer_text()` vs `executable_text()` | **FAIL** / PASS — FINDING 4, localised to one accessor |
| **14** | "all three calls survive the junk" → a fatal-on-bad-frame consumer | **FAIL** — 1 of 3 |
| **15** | "0 unexplained strings" → round 4's error shape · a **bare alphanumeric** leak · B2's shape | **FAIL** / **FAIL** / PASS |
| **16** | the invariance comparator → the four peer **bodies**, which differ | **FAIL** — it is not blind |
| **17** | "never failed over" → a transport failure · a cancellation | **FAIL** / PASS |
| **18** | "the carry is bounded" → the 11 610-character payload itself | **FAIL** |
| **19** | "the detail is Vela's own words" → a naive explainer that interpolates the value · Vela's · the naive one's length | **FAIL** / PASS / PASS |
| **20** | "the payload exercises the scrubber" → **round 4's own payload** | **FAIL** — `4881 body characters, 0 backslash byte(s)` |
| **21** | "emulation is entered" → the Anthropic adapter · the Google adapter | **FAIL** / PASS |
| **22** | case 15's premise → a turn offering no tools; and the markup still inert | **FAIL** / **FAIL** |
| **23** | case 18's wire premise → the `empty` variant's body | **FAIL** |
| **24** | "the sink is never told the turn finished" → a turn that **did** finish | **FAIL** |
| **25** | "three calls, unspliced" → a spliced batch (FINDING 1's shape) | **FAIL** |

### 6.2 Defect injections — 7 experiments, **in a scratch copy**

| # | defect | expected | observed |
|---|---|---|---|
| **1** | the FINDING 3 quarantine removed from the answer channel | 14, 15, 20 red | **88 failures** (baseline 24); red: 14, 15, 20 |
| **2** | *positive control* — `extract_json` stops scavenging a loose object | case 16 green | **0 failures**; CONTROL 13's line flips FAIL → PASS |
| **3** | `tool_accum` raw-argument bound 400 → 40 000 | case 20 red | **48 failures**; red: 20 |
| **4** | `answer::bounded` raised the same way, in the other file | case 20 red | **28 failures**; red: 20 — *and it moved nothing until arm 2b was added; see §4.5* |
| **5** | malformed frames counted but never reported | 08 and 17 red | **29 failures**; red: 08, 17 |
| **6** | a cancelled turn becomes failable-over | case 19 red | **36 failures**; red: 19; CONTROL 17's line flips |
| **7** | the closed-vocabulary audit given the "looks like an identifier" exemption | CONTROL 15's bare-identifier line flips | **24 failures** (unchanged) — **and the flip happens**: `1 unexplained string ["sk7Q2Xz9f3aDONOTLEAK"] → 0` |

DEFECT 7 moves the gate count by zero **and that is the correct result**: B2 carries no
endpoint text, so case 18's audit assertion has nothing to miss either way. The exemption
is only visible in a control built to plant the leak — which is exactly the case
`diagnostic.rs`'s comment names when it refuses the exemption:

> There is deliberately no "looks like an identifier" exemption: that would have waved a
> purely alphanumeric credential through.

The first run of these injections reported DEFECT 4 and DEFECT 7 as "no effect", because
it read only the gate count and control FAILs are excluded from it by design. **The
reporting was wrong, not the experiments.** A second observation channel was added, both
became legible, and the fix is recorded in the script rather than quietly applied.

### 6.3 Why the injections copy the tree

`../phase-b-matrix/structural/controls.sh` and `controls-round4.sh` patch the working
tree and restore on exit. That is safe when one session owns the repo. **It is not safe
here** — a concurrent Phase C session shares this checkout and this index, and this run
has already lost work to exactly that mistake (`docs/vela-progress.md`, "Run incidents").
A `trap restore EXIT` does not help if the other session reads or stages the tree during
the seconds the defect is in place, and does not help at all against SIGKILL.

`controls-b2.sh` copies 12 MB to `$TMPDIR`, builds into its own `CARGO_TARGET_DIR`, and
**only ever reads** the shared tree. The copy's recorder writes into the copy's own
`docs/`, because `repo_root()` derives from `CARGO_MANIFEST_DIR`.

---

## 7. Two tooling defects, fixed and re-run rather than filed

The brief said: *if your tooling lies, fix it and re-run rather than filing it.* Both of
these were mine, both are recorded at their site, and both would have been reported as
findings by a less careful run.

1. **A probe that manufactured a RED.** Case 11 asked
   `contract.ts.contains("provider_")`, which matches `'no_provider_configured'` — a
   `Cause` code, not a command name. It failed the gate for a fact that was not true. A
   probe that manufactures a red is exactly as dishonest as one that manufactures a
   green, and worse in one way: it makes a real red indistinguishable from noise. Fixed
   to ask about command names; the transcript prints what the old probe would have said.

2. **A normaliser that manufactured a difference, then hung the recorder.** Case 18's
   first draft masked the correlation id with `String::replace`, so correlation 127
   rewrote `127.0.0.1` into `<n>.0.0.1` and two arms "differed". The structural rewrite
   then replaced `[ref …]` with a string starting `[ref `, matched its own output, and
   spun for ten minutes. Both fixed; both argued in `strip_correlation`'s doc comment,
   because the next person to touch it needs to know why it is written the hard way.

---

## 8. What is NOT verified

- **GATE M Part 2.** A real llama.cpp at `:8033` on the operator's Windows host is
  unreachable from this container. Not attempted. Still unverified. **Nothing in this
  directory is evidence about any real model.**
- **Real endpoints for the Anthropic and Gemini adapters.** Cases 15–20 drive them
  against loopback peers speaking their published wire shapes. That establishes the
  adapters survive streams shaped like this; it establishes nothing about the real APIs.
- **The frontend's rendering of any of it.** These are provider-core results. The IPC
  types are asserted; what Phase C draws with them is Phase C's evidence.
- **FINDING 4's fix.** Not attempted here, on purpose (§3).

---

## 9. Files

```
RESULTS.md                              this file
README.md                               what the directory is, and the case map
SUMMARY.txt                             counts and the failure list from the last run
verdicts.tsv                            every assertion, machine-readable
ASSERTION-CONTROL.txt                   25 controls, 46 verdicts, 31 expected FAILs
<profile>/00-…20-*.txt                  the transcripts
record.sh                               regenerate everything above
structural/controls-b2.sh               7 defect injections, in a scratch copy
structural/control-results-b2.txt       their results
```

Round 4's evidence is next door in `../phase-b-matrix/`, **frozen**, including its
`structural/probe-results.txt` (five compile-time bypass attempts against `BodyStream`)
and its two injection scripts. Those results stand; the compile-fail doctests that
enforce them run in `cargo test --workspace` and are green.
