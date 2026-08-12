# Vela — Desktop Gate: VERDICTS

**This file is written by the DESKTOP session. The cloud session only reads it.**

The desktop session is a separate Claude Code session running on the operator's Windows
machine against this same repo. It owns five verdicts the cloud session is structurally
incapable of producing. The two sessions share no context and coordinate ONLY through the
files in this directory.

---

## How to write an entry

Append one block per verdict. Key every entry by **piece-id AND commit sha** — both are
required, because a verdict against stale code does not count.

```
## <piece-id> — <critic>
- commit: <full sha the verdict was produced against>
- critic: performance | keychain-runtime | visual | interaction | real-model
- verdict: PASS | FAIL
- largest_gap: <if FAIL, the single largest actionable gap; omit if PASS>
- evidence: <screenshots committed under docs/desktop-gate/evidence/, numbers measured,
             transcripts captured — real artifacts, not assertions>
- environment: <Windows version, WebView2 version, hardware — so results are interpretable>
```

## Rules governing these verdicts

Binding on both sessions:

1. **Strict binary.** PASS or FAIL. Never a score, never a percentage, never "mostly".
   No averaging, no majority vote.
2. **A FAIL here is exactly as binding as a cloud-side FAIL.** It sends the piece back to
   its builder and the loop runs again. The cloud session may not override it, discount it,
   or argue "but it passed in the container".
3. **PASS is explicitly permitted.** "No meaningful gap" and "no regression" are complete,
   acceptable reports when true. Do not manufacture failures to appear rigorous — that makes
   real FAILs unbelievable.
4. **Staleness.** If the sha in an entry is older than the current HEAD *for that piece*, the
   cloud session treats the verdict as STALE, does not count it, and re-requests it.
5. **Fail closed.** A critic that cannot actually obtain its external reference (cannot launch
   the app, cannot reach the model, cannot fetch the comparison target) must return FAIL and
   say it could not obtain the reference. Never invent a comparison and pass.
6. **No self-grading.** Whoever built a piece may not grade it.

## The five deferred critics

| Critic | Why the cloud session cannot produce it |
|---|---|
| `performance` | Cold start, idle RAM, and streaming throughput in a shared Linux container are meaningless for a Windows desktop binary. |
| `keychain-runtime` | No Credential Manager / Keychain / libsecret exists in the container. Cloud reviews the credential code path statically; only desktop can assert the OS integration actually works. |
| `visual` | Cloud can only render Linux WebKitGTK, which differs materially from WebView2 on Windows. Cloud verdicts are ADVISORY and PROVISIONAL. |
| `interaction` | Same rendering-engine problem, plus no real input latency, window management, or focus behavior. |
| `real-model` | GATE M Part 2. The llama.cpp server (Qwen3.6-27B, n_ctx 131072, vision via mmproj, `<think>` on by default) is on the operator's Windows host behind home NAT and is unroutable from the cloud sandbox. |

### Specific guidance for `real-model` (GATE M Part 2)

Follow the brief's CHARACTERIZE-BEFORE-CONCLUDING discipline, and record raw transcripts to
`docs/regression-baseline/local-smoke/` so they can be inspected rather than summarized:

- `GET /props` → record real `n_ctx`, slot count, server settings.
- `GET /v1/models` → record the exact model id string.
- `POST /v1/chat/completions` with `tools[]` → structured `tool_calls`, or plain text? If plain
  text, that is a possible **SERVER CONFIG** issue (llama.cpp may need `--jinja`). Report it as
  such. Do **NOT** record it as a Vela defect and do **NOT** record it as a model-capability finding.
- POST an image input → confirm the vision path works end to end.
- Send a prompt exceeding `n_ctx` → confirm Vela surfaces the context error gracefully.
- Confirm Vela separates `<think>` reasoning from the final answer AND excludes it from
  tool-call parsing.

**Concurrency:** `n_slots = 4`, `kv_unified = true`. Run serially, max 2 in flight.
**Do not restart or reconfigure the server.**

> **Interpretation limit, binding on both sessions:** this model is 27B, vision-capable,
> 131k-context, and reasoning-enabled — a STRONG model. Passing against it proves the happy
> path ONLY. It is never evidence of graceful degradation or model-agnosticism; that evidence
> comes exclusively from the GATE M Part 1 mock matrix.

---

## Verdicts

_None recorded yet. The desktop session appends below this line._
