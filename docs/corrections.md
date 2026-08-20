# Corrections

A false statement is a defect regardless of who made it. Correcting it is what makes the other
grades believable. This file records claims made by the lead, by builders, and by critics that
turned out to be wrong — with what was said, what is true, and how it was caught.

Entries are append-only. Do not delete a correction because it has been fixed; the record of
having been wrong is the point.

---

## 2026-08-17 — the lead dropped thirteen of eighteen tracks with a null return

**Claimed:** "Run is live. All eighteen tracks are spawned and working."

**True:** five ran. Thirteen never reached a builder.

**The defect.** Round 1's pipeline had a stage-1 callback that skipped the probe for non-guard
tracks:

```js
(t) => { if (!t.guard) return null; return agent(...) }
```

A pipeline stage that returns `null` **drops the item and skips its remaining stages**. I meant
"this track needs no probe"; the pipeline's semantics are "this item is finished". Thirteen tracks
were silently discarded between stage 1 and stage 2. The run reported `agents_done: 15,
agents_error: 0, agents_skipped: 0` — a clean green with two-thirds of the work missing.

**How it was caught.** The returned rows said `"no verdict returned"` with `tagGraded: null` for
seventeen of eighteen tracks, and the agent count was 15 where the structure implied ~41. Reading
`journal.jsonl` — which the tool result explicitly tells you to read before diagnosing — showed
exactly three agents each for `t03`-`t07` and none for anything else.

**Why it belongs in this file rather than a fix note.** It is the run's own governing class,
committed by the lead, inside the harness built to hunt that class: a filter whose frame was one
notch off the real semantics, passing green while doing two-thirds less than it claimed. The
announcement that all eighteen were "spawned and working" was false when I made it, and nothing in
the tooling contradicted it — `agents_error: 0` and `agents_skipped: 0` both read as confirmation.

**Fixed by** returning a non-null sentinel (`{ track, skipped: true, evasions: [] }`) so non-guard
tracks pass through stage 1 into a builder. Stage 2 already gated its probe block on
`probe.evasions.length`, so the sentinel needed no downstream change. Resumed with
`resumeFromRunId`, so the fifteen completed agents replayed from cache and only the thirteen
dropped tracks ran live.

**The reusable lesson**, which is the point of recording it: a zero in an error counter is not
evidence that work happened. `agents_skipped: 0` was true and meaningless — the items were dropped
by the pipeline's own success path, not skipped by anything that counts skips.

---

## 2026-08-17 — the ladder itself was one notch narrow

**Claimed:** Projects, Skills and Schedules reached `reaches-user`, the top tier, on the strength
of being clicked in a running window.

**True:** that evidence is `dev-clicked`. A dev binary against a Vite dev server, CDP-dispatched
events rather than OS input, and app-data substituted into an isolated profile inside an MSIX
container — three substitutions from the shipping product.

**How it was caught:** the operator. Not by any agent, and not by the audit, which had *already
written down* the three substitutions in a paragraph headed "What this evidence is not" and then
graded the section top-tier anyway. The defect was in the rule, not the measurement: `reaches-user`
was defined as "clicked in a running window", which asks *did something respond to a click* when
the question is *does this reach a person who installed the app*.

**Consequence:** the ladder now has five rungs (`traced` → `test-bites` → `dev-clicked` →
`reaches-user` → `ships`), and nothing rises above `dev-clicked` until an installer exists.

This is the same class the whole run is organised around — a check asking a question one notch
narrower than the real one — occurring in the definition of the check that grades everything else.

---

## 2026-08-16 — seven corrections from the previous session

Carried forward from the session record so they are not lost with the scrollback.

| # | claimed | true | caught by |
|---|---|---|---|
| 1 | contrast ratios of 1.17:1 / 1.11:1, stated twice | **1.19:1 / 1.14:1**, settled to four decimals by three independent derivations | a builder recomputing rather than accepting the brief |
| 2 | "the app renders nothing" | cold-start latency on a first-run Vite dev server | re-checking `mount` a minute later |
| 3 | "that's the explanation" for the app's disappearance | stated before the confirmation ran; the first confirmation was inconclusive (a modal covered the titlebar) | the lead's own follow-up test |
| 4 | the harness sent "59 of 95 characters wrong" | **32** carried a wrong virtual-key code; 59 had at least one wrong field. The builder's own README contradicted itself | a critic re-deriving the character table by hand |
| 5 | the harness calibration was "strong evidence the account is right" | it validates exactly one claim — that VK 46 swallowed the character — and says nothing about five other modelled commands | a critic replacing `DeleteForward` with a pure swallow and getting identical output |
| 6 | a lead brief specified the range as "12–13" | the builder sampled four more times, got 14/16/17/17, and refused the instruction. **The brief would have planted the defect it was sent to fix** | the builder declining a lead instruction |
| 7 | "two orphans in `src/data`" | one. `skills-repository.ts` is value-reachable in four edges from `main.tsx` | a builder rebuilding the census on the TypeScript AST |

**The pattern across all seven:** five were caught by an agent refusing to accept a claim from the
agent above it. None were caught by more care from the agent that made them.

---

## How to add an entry

Record: what was claimed, verbatim where possible; what is true, with the evidence; who caught it
and how. Do not soften. "I was wrong about X because I assumed Y" is worth more than a silent fix,
because the assumption is reusable and the fix is not.
