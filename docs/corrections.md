# Corrections

A false statement is a defect regardless of who made it. Correcting it is what makes the other
grades believable. This file records claims made by the lead, by builders, and by critics that
turned out to be wrong — with what was said, what is true, and how it was caught.

Entries are append-only. Do not delete a correction because it has been fixed; the record of
having been wrong is the point.

---

## 2026-08-21 — six sentences a separate agent measured, and none of them inherited

**Claimed**, all six on this branch, all six written by me, two of them inside the entries below
that exist to correct exactly this. Someone else went through the diff and ran a command against
every checkable sentence in it — 76 by their count — before I committed. Six failed.

| # | where | claimed | true |
|---|---|---|---|
| 1 | `docs/corrections.md`, the nesting entry | the **five** scoped dismiss names each put a panel's opener inside its dismisser | **four**. The endpoints panel's opener is `Manage endpoints…`, not a substring of `Close the endpoints panel`. `ACCEPTED_NESTINGS` held four such pairs at `8e91daf`, the commit that wrote the sentence — so it was false when written, not stale |
| 2 | `src/app/accessible-names.test.tsx` docblock | `aria-label`, `aria-labelledby`, text, `title` "in that precedence" | `aria-labelledby` outranks `aria-label`. Measured through the library that computes these names: a button carrying all four resolves to the `aria-labelledby` text |
| 3 | `src/app/close-collision.test.tsx`, `BUDGET_MS` | "measured on an idle box they finish in one to two seconds"; "each … drives four clicks" | Three runs here give 551–2754ms; the four clicks are the shared setup's, and the second test drives three more |
| 4 | `src/app/accessible-names.test.tsx`, `BUDGET_MS` | "measured idle they finish in well under a second each" | 911–3764ms across three runs. No run had every state under a second |
| 5 | `docs/corrections.md`, the nesting entry | "the **19** states the sweep now drives" | **21**. 19 was right at `8e91daf`; `6ed60a3` added two states and the present-tense sentence was not re-taken |
| 6 | `src/app/modal-containment.test.tsx` | "the non-vacuity floor is measured against that screen rather than carried over" | The floor is `> 8`, the same literal the two tests above it use. The screen holds **27** focusables |

**And one more, from the round-3 critic, in a report rather than in the tree:** the mutation
snapshot for `RemoveEndpointDialog.module.css` was given as `03bd7f08…`, 3128 bytes. The committed
file is `e8be4094…`, 3490 bytes; `03bd7f08…` is the blob at `6ed60a3` with CRLF applied. One
mutation was therefore run against the tree as it stood a commit before the one handed over — the
defect the entry two sections down promises to have fixed, in the same commit that promises it.

**The pattern, and it is not "be careful".** Three of the six (#3, #4, #5) are a number or a bound
written without running the command that would produce it — two timing ranges and a state count.
Two more (#1, #6) describe code that was open in the same editor and says otherwise: the ledger
directly below the sentence held four entries where the sentence said five, and the `> 8` on the
next line is the literal the sentence called measured. The sixth is a fact recalled instead of
looked up. **None is inherited prose; all six were written by this branch.** Three rounds of being
told to check did not catch one of them. One agent told to run a command per sentence caught all
six in a single pass.

**How it was caught:** by a measurer given the diff and told to run a command per sentence, before
the commit rather than after it — the same move that made mutation evidence trustworthy, applied
to prose.

**What changed:** all six corrected in place, each now carrying the command that produced it and,
where the number moves between runs, the spread rather than a bound. The two timing docblocks say
what the budget is *for* (spread) instead of asserting a duration nothing measures. Where a claim
could not be made true it was deleted rather than softened. Three writes with no reader also got
one — the dialog's credential sentence, both branches, and its Escape path — because a sentence
nothing reads is the same defect in a different file.

And the standing rule got the piece it was missing: after correcting a claim, **grep the tree, and
count what the grep returns**. The entry directly below corrected two of the six files carrying
its figure, deliberately left two as historical records, and silently missed two — one of them
live source. Missing them is finding #1's shape one turn earlier.

---

## 2026-08-21 — a contrast figure four files repeat, and none of them measured

**Claimed**, in `src/features/navigation/DeleteConversationDialog.module.css`: that white on the
dark theme's danger fill "read at 2.5:1 there". And in `src/styles/contrast.test.ts`'s own
docblock, listing what the gate found on its first run: that `EndpointForm .save` and
`DeleteConversationDialog .confirm` "sat at ~1.4:1 and ~2.5:1".

**True:** **1.57:1** and **2.98:1**. Resolved from `src/styles/tokens.css` — dark
`--vela-accent` is `--vela-signal-300` `#5fe2d6`, dark `--vela-danger` is `--vela-rose-400`
`#f2668b`, and `--vela-night-0` is `#ffffff` in both themes — and computed by WCAG 2.x relative
luminance, on a function checked against black-on-white = 21.000:1. Neither token has changed
since `bb6f768`, the commit that created `src/styles/tokens.css` — the fifth commit in this
repository, not the first, which is `d205a88` (`git rev-list --count bb6f768` = 5 of 366). So the
figures were not stale: they were never measured. For completeness the same run gives
`--vela-text-on-accent` at 12.47:1 and
`--vela-text-on-danger` at 6.59:1 on those fills, which is what the repair bought.

**Nothing about the conclusion changes.** 1.57 and 2.98 are as far under AA as 1.4 and 2.5, the
repair was right, and the gate that enforces it computes its own numbers and never reads these
comments. That is exactly the danger: a figure no assertion depends on is a figure nobody checks,
and it survived a full contrast audit written by the same hand.

**How it was caught:** by copying it. This branch added a third dialog whose confirm button takes
the same role inversion, and the comment beside it was pasted from the file next door. Re-deriving
it before writing it down was the only reason it came up.

**What changed:** the source comments now carry the measured figures and say where the old one came
from. The title of this entry says *four files*, and that was never counted. Measured at the tag —
`git grep -l "1\.4:1" run-start-2026-08-17 -- src docs tests` gives five files,
`git grep -l "2\.5:1"` gives four, and the union is **six**. The first pass corrected two of them
and left `src/styles/tokens.css` and `docs/design/vela-tokens.md` standing, the first of which is
live source *and* the file this entry names as its own resolution source. That is this entry's own
defect one turn later: correcting a claim without grepping the tree for the claim. Both corrected
2026-08-21. The full inventory, and what each got:

| file | then | now |
|---|---|---|
| `src/features/navigation/DeleteConversationDialog.module.css` | `2.5:1` | measured `2.98:1`, with the old figure named |
| `src/styles/contrast.test.ts` | `~1.4:1 and ~2.5:1` | measured `1.57:1` and `2.98:1`, with the old figures named |
| `src/styles/tokens.css` | `1.4:1` | measured `1.57:1`, with the two hex values it comes from |
| `docs/design/vela-tokens.md` | `1.4:1` | measured `1.57:1`, pointing here |
| `docs/desktop-gate/REQUESTS.md` | `1.4:1 and 2.5:1` | **left as written** — a record of what was reported at the time |
| `docs/regression-baseline/platform-defaults/RESULTS.md` | `1.4:1 and 2.5:1` | **left as written**, same reason |

---

## 2026-08-21 — two numbers in a report about numbers, and the rename that could not finish

**Claimed**, in this branch's round-2 report — not in the tree, which is why the tree stayed green
while the account of it did not.

1. That the ladder evidence was produced with `playwright-core@1.60.1`.
2. That the branch diff against `run-start-2026-08-17` was `19 files, 1430 insertions, 31
   deletions`.

**True:**

1. The package actually sitting in the directory the report says it installed into reads
   `"version": "1.61.1"` — read out of `package.json` in that same scratch directory, which the
   entry originally declined to name and so left uncheckable by anyone else. It is
   `…/Temp/claude/C--Users-User-vela/6df8af95-5781-4f9f-aacd-0bb2bf1120da/scratchpad/t02r2/node_modules/playwright-core`,
   and it still reads `1.61.1` on 2026-08-21, as does the round-2 critic's own copy under
   `…/scratchpad/critic-t02-r2/pw/node_modules/playwright-core`. (A scratch path is not durable
   evidence — it will be swept — but an unnamed one is not evidence at all.) Whether `1.60.1` was
   ever published I could not check from
   this session: `npm view playwright-core versions` did not return and was killed at 120s, so the
   claim that the version does not exist stands on the round-2 critic's measurement, not on mine.
   Either way the number was written without looking at the thing it named.
2. `git diff --shortstat run-start-2026-08-17..1176ca5` is **1432** insertions. 1430 is the count
   at `8e91daf`, the commit *before* the one the report described — a figure measured in a tree
   other than the one being handed over.

Neither number was load-bearing. That is the same excuse the entry below this one refused, and it
is refused again: a number nobody needs is a number nobody checks, and this was the second
consecutive round in which this track's report carried one.

**How it was caught:** by the round-2 critic re-running the two measurements against the tree at
the graded commit instead of reading them.

**What changed:** nothing in the product. The procedure: the diff stat and any tool version quoted
in a report are taken *after* the last commit, from the tree and the directory being described, and
pasted rather than recalled.

---

**Also on this branch, and this one is in the product.**

**Claimed:** that renaming the endpoint delete button from `Remove` to `Remove: <endpoint>` closed
the collision it was renamed for.

**True:** it closed the collision with `Remove shot.png` and the one between two configured rows,
and it could not close the general case, because the text it interpolates is the user's.
`EndpointForm` derives the identifier from the display name but leaves the field editable, so two
endpoints can be given one display name and two ids — and then two buttons named
`Remove: The workstation` each delete a different endpoint, and the key stored for it, with nothing
in between. A name is a way of pointing at a control; it is not a property of what the control
does, and the defect here was always in what the control does.

**How it was caught:** by the round-2 critic, who took the fix and asked what it carried one level
down, rather than checking that the named pair was gone.

**What changed:** `src/features/models/RemoveEndpointDialog.tsx`. The click now asks, and the
question states the address and the identifier — the two fields that differ when the display names
do not. The duplicate name is admitted in `src/app/accessible-names.test.tsx`'s ledger *on that
basis*, so deleting the dialog reddens the sweep and not only the endpoint tests, and the state
that produces it (`the endpoints panel with two endpoints the user called the same thing`) is
driven there.

**And one the new guard caught on its own author.** The first version of the dialog copied
`Sidebar`'s shape — close the dialog, then start the delete. `ModalSurface` restores focus to
whatever held it when the dialog opened, which is the Remove button of the row being destroyed, and
at the moment of that restore the row is still on screen because the removal has not been awaited.
So the restore succeeded, the reload then detached the element it had succeeded on, and focus fell
to `<body>` with no overlay left to run the ladder — the exact defect `src/state/focus-store.ts`
exists for, reintroduced by a component written after it. The assertion added to
`src/app/focus-ownership.test.tsx` failed with `focus was dropped to <body>` before the order was
changed to destroy first and close after.

---

## 2026-08-21 — the guard that stopped at its own family, and a count that was never measured

**Claimed**, on this branch, one day earlier. Two things, both by me.

1. `src/app/close-collision.test.tsx` asserted that *"no name is a substring of another"* and
   presented that, with the consequence assertion, as the two properties the defect needed. It
   compares close-shaped names **to each other only**.
2. The branch report headed its list of substring collisions *"Full sweep inventory"*. It had four
   entries.

**True:** neither was complete, and the incompleteness included nestings this branch *created*.
Five panel dismiss buttons were given scoped names (`Close the memory panel`, and the same for
Skills, Schedules, Projects, Endpoints), and **four** of the five put that panel's own **opener**
inside its dismisser: Memory, Skills, Schedules, Projects — exactly the four opener/dismisser pairs
`ACCEPTED_NESTINGS` carries. Endpoints is the exception, and it is worth naming rather than
rounding up: that panel's opener is the menu item `Manage endpoints…`
(`src/features/models/ModelSwitcher.tsx`), which is not a substring of `Close the endpoints panel`.
The word `Endpoints` occurs there only as the region's `aria-label` and as an `<h2>`, neither of
which is a control, and the sweep compares actionable names only. Before the branch each dismiss
button was called `Close`, which nested with nothing but the control that quits Vela. Beside those,
the product already held a `button` and a `combobox` sharing the exact name `Search conversations`,
which the sweep could not see at all because it keyed on `(role, name)`. Rendering the **21** states
the sweep now drives and comparing every actionable name against every other produces **17**
containments, not four.

The branch report also gave a baseline of `Tests 2393 passed (2393)` and *"21 new tests"*. Both
figures were wrong and neither had been measured in the tree they described: the two new files held
19 tests, no existing test file gained or lost one (`it(`/`test(` counts compared at
`run-start-2026-08-17` and at HEAD for all five modified test files), and the suite at that HEAD
with exactly those two files excluded is `Test Files 118 passed (118) / Tests 2395 passed (2395)`.
The conclusion the figures were offered for — no regression — was true anyway, which is the whole
danger: a number nobody needs is a number nobody checks.

**How it was caught:** by a critic who rendered the product and enumerated the pairs the guard did
not compare, rather than reading the guard's own account of itself.

**What changed:** `src/app/accessible-names.test.tsx` now asks three questions off one drive per
state — one name on two elements, one name inside another, one name on two different roles — each
against a ledger that carries the reason a case is survivable, and each with a companion test that
fails when a ledger entry stops being produced. Two containments were **not** admitted, because
their two landings are not equally survivable, and were renamed instead:

- `Offer tools` inside `Never offer tools` — two `option`s of one select whose consequences are
  opposed. Now `Always offer tools` (`src/features/models/LocalEndpointSection.tsx`).
- `Remove` inside `Remove shot.png` — the shorter one deletes a configured endpoint and does not
  ask first, and the attachment tray puts the longer one on screen beside it. Now
  `Remove: <endpoint>` (`src/features/models/EndpointsPanel.tsx`), which also ends the shared name
  two configured rows used to have.

Neither rename changes a visible word except the one option label; `Remove` is still the word drawn
on the button.

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
