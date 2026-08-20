# Corrections

A false statement is a defect regardless of who made it. Correcting it is what makes the other
grades believable. This file records claims made by the lead, by builders, and by critics that
turned out to be wrong — with what was said, what is true, and how it was caught.

Entries are append-only. Do not delete a correction because it has been fixed; the record of
having been wrong is the point.

---

## 2026-08-20 — "ambiguous rather than wrong", and three readers that proved otherwise

**Claimed:** in `src/app/skills-reachable.test.tsx`, beside a query scoped to the dialog: *"the
title bar carries a window Close button too, and an unscoped query would be ambiguous rather than
wrong."*

**True:** unscoped, it was wrong, and three harness drivers were making exactly that unscoped query.
`tests/harness/production-bundle/drive-app-root.mjs`,
`tests/harness/production-bundle/drive-platform-defaults-executor.mjs` and
`tests/harness/ui-bridge/drive-matrix.mjs` each dismissed the endpoints panel with
`page.getByRole('button', { name: 'Close' }).first()` (the last with `/Close|Done|Back/u`). The title
bar is the first element in the shell, so `.first()` is the caption control — the one that quits the
application. That is the mechanism behind the entry in `docs/audit/REPORT.md`: `CDP
Runtime.evaluate timed out after 30000ms`, then `vela processes alive: 0`, no Rust panic, no Windows
Error Reporting entry.

**How it was caught:** by enumerating computed accessible names over the rendered application rather
than reading JSX, then grepping for what *reads* those names. The comment above had been in the tree
since the collision was introduced, correctly identifying the duplicate and mis-grading its
consequence.

**Also corrected on this branch:**

- `src/app/shell/TitleBar.tsx` said Close is "last in the tab order, so nothing tabs *through* it on
  the way somewhere else". `docs/audit/shell.md` §4 had already measured that as bar-scoped, not
  app-scoped, and flagged it — the flag never reached the source. The sentence is now scoped and
  carries the measurement.
- `docs/audit/shell.md` §4 quotes the caption labels as
  `['Theme: system','Minimise','Maximise','Close']` and says `window-controls.test.tsx` asserts that
  list. The last entry is now `Close Vela`. The audit record is left as written; this line is the
  correction.

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
