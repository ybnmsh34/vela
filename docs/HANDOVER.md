# Vela — handover from the cloud session

Written at the point of retirement, for the desktop session taking over both building and grading.
Everything here is what was in my head and nowhere on disk. For everything else, read
`docs/vela-progress.md` (the running narrative, 2,900+ lines), `docs/architecture/conventions.md`
(the rules the code is written to), `docs/vela-feature-spec.md` (178 features, the target),
`docs/desktop-gate/` (the two-session protocol and every verdict), and
`docs/regression-baseline/` (17M of evidence, with the staleness warnings in section 5 below).

I am writing this in plain prose. Where I am uncertain I say so. Where something is unproven I
label it unproven, and there is more of that than I would like.

---

## 1. Where I actually stopped

`HEAD` and `origin/claude/new-session-tgl1ut` are both **`bf10d98`** at the time of writing. The
working tree is **not clean**, and what is in it matters, because two container resets in the last
few hours destroyed two waves mid-flight and what you see uncommitted is partly wreckage and partly
mine.

**Modified, and it is my own work, finished but only half-verified:**

- `src/styles/tokens.css`
- `src/features/conversation/MessageTurn.module.css`
- `src/features/conversation/CodeBlock.module.css`
- `src/features/conversation/Markdown.module.css`

This is the operator's layout request — the one he was most visibly waiting on. On a maximised
2560px window the conversation used 23% of the pane: a 480px text column with 800px of dead space
on each side, and user and assistant turns with byte-identical geometry distinguished only by a
background fill. I made three changes. `--vela-measure` became
`clamp(30rem, 24rem + 6vw, 33rem)` so the column grows on genuinely wide windows and is unchanged
below roughly 1600px. `--vela-wide-measure` was added and applied to code blocks (`CodeBlock.module.css`)
and tables (`Markdown.module.css`), so non-prose content escapes the reading measure — this is
where a big window actually pays off, and it is the safer half of the change. And `.turn` became a
flex column with `align-items: flex-end` for the user and `stretch` for the assistant, with the
user's bubble capped at a new `--vela-turn-user-measure` of 26rem, so turn ownership is legible
from edge and width rather than fill colour.

**`pnpm typecheck` and `pnpm build` both pass with these changes. I did not get to measure them in
a browser.** That is the gap. I was in the middle of running a Playwright probe to compute
characters-per-line at 900 / 1280 / 1440 / 1920 / 2560 when the handover arrived; the script failed
on module resolution because I wrote it to `/tmp` where `playwright` is not resolvable, and the fix
is simply to put it under the repo root. **Do not trust the layout change until that measurement is
taken.** The binding constraint is that prose stays in the **60–80 characters per line** band at
every window size. The current floor was measured at 68.3 characters in Inter; my ceiling of 33rem
should compute to about 75, but *should* is not *measured*, and this project has been bitten four
separate times by exactly that gap.

**Untracked, and it is salvage from the two killed waves — real work, not scaffolding:**

- `src/platform/keyboard.ts` and `keyboard.test.ts` — a platform-aware modifier layer that resolves
  the glyph *and its accessible name together*, with tests that drive a Windows-like and a Mac-like
  environment in one process rather than asserting whatever machine they run on. This is good work
  and it survived. I made one edit to it myself: the `KeyboardEnvironment` fields needed
  `| undefined` explicitly, not just `?`, because the repo runs `exactOptionalPropertyTypes` and a
  real `navigator` hands you a property that is present and undefined. Without that edit the tree
  did not typecheck.
- `src/platform/KeyboardProvider.tsx`, `src/components/ShortcutHint.tsx` and its stylesheet, and
  `src/features/navigation/shortcut-glyphs.test.tsx` — the rest of that fix. **I do not know whether
  the three call sites in `Sidebar.tsx` (around lines 203 and 226) and `HomeSurface.tsx` (around
  110) were actually rewired to use it.** Check before assuming. The app currently renders Command
  glyphs on a Windows build; the shortcuts themselves work, because `use-navigation-shortcuts.ts:47`
  tests `metaKey || ctrlKey`. It is a labelling defect and an accessibility defect — the glyphs are
  baked into the buttons' accessible names, so a screen reader announces "command K" on a machine
  with no Command key — and it is **not** a broken shortcut. Do not "fix" the handler.
- `src-tauri/crates/vela-providers/src/private_fs.rs` — the Windows DACL work. Unknown how complete.
  It cannot be executed on Linux at all, so whatever state it is in has never run.

**What I was about to do next, in order:** measure the layout change in a browser; commit and push
it; then finish the window controls, which are the single most visible thing still missing.

**Intent that exists nowhere but here.** I had decided that the next wave after those would be the
one the operator has been asking about — subscription-backed providers via the Claude CLI and Codex
CLI as local subprocess transports. That is a genuinely different provider *shape* from an HTTP
endpoint: it is a process you spawn and speak a protocol to over stdio, not a URL you POST to. I
believe the existing `Provider` trait can host it — the trait is about request/response and
streaming, not about HTTP — but I never validated that, and if the trait turns out to assume a URL
anywhere, that assumption is the first thing to break. It is worth checking `RequestUrl`'s reach
before designing anything.

---

## 2. The Gauntlet Loop as I actually ran it

The idealised version is in the docs. Here is what really happened.

**Composition.** I never let a builder decide its own scope. I decomposed the work myself into
three to five pieces that could be built in parallel without touching the same files, wrote each
piece a brief containing the defect, the evidence, the constraint, and explicitly what *not* to do,
and then spawned them all at once. Then one integration agent reconciled them, one gate executor
drove the assembled result, and four critics judged with fresh context. I planned; agents built,
integrated, gated and judged. I did not build, with two exceptions I will come back to.

**The mechanism was the `Workflow` tool** — a script with `phase()` markers and `parallel()` over
`agent()` calls. The shape that worked, every time:

```
phase('Fix')      parallel over 3–5 builders, each with a self-contained brief
phase('Integrate') one agent, reconciles, runs the full gate in an isolated worktree
phase('GateM')    one fresh agent, drives the REAL assembled app, produces evidence
phase('Critique') parallel over 4 critics with a JSON schema forcing a binary verdict
```

Roughly 9–12 agents per wave. Each wave ran two to four hours of wall clock and consumed on the
order of two million subagent tokens. That is the real cost and you should budget for it.

**Things that failed, concretely.** Backticks inside a JavaScript template literal broke one script
at parse time; I switched to building briefs from arrays of strings joined with newlines and never
hit it again. `isolation: 'worktree'` is per-agent, which means builders in separate worktrees
cannot see each other's work — it is useless for a wave that needs integration, and I never found a
good use for it. Two waves running concurrently against one working tree share **one git index**,
and `git add` plus `git commit` is not atomic: one wave's commit swallowed another's staged files.
Path-disjoint is not isolation. If you run anything concurrently, use path-limited
`git commit -- <paths>` exclusively and never `git add -A`.

**What I passed them.** Always: the project one-liner, the current real state, the specific defect
with its measured numbers, the constraint they must not break and *why it was earned*, and the
named traps. The single highest-value thing I ever put in a brief was the sentence "before writing
any assertion, state what quantity would change if the defect were present" — see section 4.

**How a FAIL routes back.** A critic returns `{verdict, largest_gap}`. One FAIL fails the piece.
I read the gap, folded it into the next wave's brief with the evidence attached, and re-ran with
**fresh builders**, never the same agent. The rule that mattered more than any other: **the panel
does not negotiate.** I never averaged, never took three-of-four, never let a strong PASS offset a
FAIL. The moment you allow that, the loop stops working, because the cheapest way to get a PASS
becomes persuasion rather than repair.

**How I decided a piece was done.** All critics PASS *and* the deferred desktop critics PASS at a
sha no older than the piece's current HEAD. A verdict against stale code does not count and gets
re-requested. I enforced that by checking `git log <verdict-sha>..HEAD -- <the piece's files>` — if
anything came back, the verdict was stale. That check caught real staleness twice.

**When to stop rather than iterate.** I ran a no-thrash rule: if the same critic fails twice on the
same evidence with the fix not landing, stop the piece and escalate rather than run a fifth round.
Phase B hit it — four rounds, each closing what the last found, each dying on a new surface. Stopping
was right, and the architectural redesign that followed (stop *carrying* untrusted text rather than
laundering it) fixed the class where four point-fixes had not. But note the important refinement:
when a *systematic sweep* finds a defect, that is not thrash, because the sweep tells you the size
of what remains. Distinguish "we keep being surprised" from "we are working through a known list".

**Preventing self-grading now that one session does both.** This is the thing you are right to
worry about, and it is the load-bearing property of the whole method. My honest advice:

The rule is not "different people". It is **different context**. A critic must not have seen the
builder's reasoning. When you spawn a critic, give it the artifact and the standard, and *nothing*
about how the code came to be — no builder summary, no "here is what I did", no diff narrated in
prose. Make it run the commands itself. I put "you did NOT build this and must NOT be charitable to
it" and "RUN THE COMMANDS YOURSELF — never trust a claim that tests pass" in every critic brief, and
critics repeatedly caught things the builder had asserted were fine.

Concretely, if I were you: keep spawning subagents even though you are one session. Your own
context is the contamination. A critic you spawn with a fresh context and a bare artifact is a real
critic; you reading your own work is not, no matter how sceptical you feel. Two agents in this run
enforced this on themselves without being asked — a gate executor refused to fix a defect it had
graded, saying "an executor who fixes what he also grades is manufacturing agreement", and the
desktop session declined to commit a fix for the `icon.ico` defect it had itself reported. Preserve
that instinct. When a gate finds something, the fix goes to a *different* agent.

Also: **let PASS be real.** I wrote "PASS is explicitly permitted; do not manufacture failures to
appear rigorous" into every critic brief, because a panel that always finds something is a panel
whose findings you stop believing. Several critics returned clean passes and they were more useful
for it.

**Where the mock matrix fits, and why it is irreplaceable.** `tests/harness/mock-provider` runs
four capability profiles — frontier, mid-local, small-local, hostile — as real OS processes over
real TCP. It is the **only** evidence in this project of graceful degradation and model-agnosticism,
and that is not a stylistic claim: a real model can only ever demonstrate the happy path. Qwen3.6-27B
passing proves Vela works with a strong vision-capable reasoning model. It proves nothing about a
model with no tool support, a 4k context, or an endpoint that emits malformed JSON and never closes
a `<think>` block. Only the hostile profile proves that.

So: **never let a real-model result stand in for a matrix result.** The harness stamps a `vela_mock`
block into `/health` and `/props` specifically so a transcript cannot be laundered into looking
real. Every gate must re-run the matrix, and the cross-product cases matter more than the individual
ones — the worst defect in the entire run (a model's `<think>` deliberation becoming an *executed*
tool call) lived in the intersection of two individually-tested cases that nothing drove together.

---

## 3. The remaining roadmap

Roughly 35–40 of the spec's 178 features exist. What follows is dependency-ordered. "Done" means
the cloud-side panel passes *and* the desktop critics that apply have passed at a current sha.

**Immediately outstanding (all started, none finished):**

1. **Window controls.** `tauri.conf.json` sets `decorations: false`, so the app is its own title
   bar, and `TitleBar.tsx` renders only a theme toggle — there is no way to minimise, maximise or
   close from inside the window. Alt+F4 and the taskbar work, which is why it went unnoticed for six
   pushes. `capabilities/main.json` **already grants** every needed permission and nothing uses
   them. Done means: three controls in Windows order, the maximise icon driven by `is-maximized`
   rather than local state, buttons outside the drag region or they will not receive clicks, real
   accessible names, close not reachable by accident, and double-click on the drag region toggling
   maximise.
2. **The layout change** described in section 1 — measured, not assumed.
3. **The shortcut glyphs** — wire the surviving `keyboard.ts` to the three call sites.
4. **The Windows DACL.** The debug-log directory is created with inheritance enabled; on the
   operator's machine an inherited ACE grants a non-owner group read access to raw provider
   exchanges. Done means an explicit DACL with inheritance disabled, owner and SYSTEM only, and a
   deliberate decision to **fail closed** if it cannot be set — a debug log that silently stays
   readable is worse than no debug log.
5. **The OFL licence.** Four redistributed font binaries ship with no licence text while
   `typeface.css` claims otherwise. This is a real redistribution violation, not a formality. Done
   means the licence for both families in the **built artifact**, plus a test that fails if a binary
   ships without it.
6. **The endpoints-form placeholder** at 3.96:1, under AA, plus extending `contrast.test.ts` to
   painted strings rather than token pairs — it could not see this defect because the foreground is
   not a token.
7. **Two guards that do not enforce their own sentences** — `claimed-guards.test.ts` resolves file
   claims by basename, so a claim naming a nonexistent path passes if the basename exists elsewhere;
   `verify-covers-ci.test.ts` matches CI steps by prefix, so `pnpm test:e2e` is "covered" by
   `pnpm test`.

**Then, in dependency order:**

8. **Subscription-backed providers (Claude CLI, Codex CLI).** The operator has asked for this
   explicitly and it is the largest functional gap. A subprocess-over-stdio transport rather than
   HTTP. Depends on nothing; blocked only by attention. Done means a user with a Claude or ChatGPT
   subscription and no API key can hold a conversation.
9. **Projects.** Conversation grouping with shared context and instructions. The store already has
   a `projects` table. Depends on nothing further.
10. **Artifacts.** Rendered side-panel documents and code. Depends on the layout work above, because
    it needs the horizontal space that change creates.
11. **The local code-execution sandbox.** `docs/vela-feature-spec.md` chapter 4 names the ladder:
    Seatbelt/bubblewrap, then Docker/Podman, then Virtualization.framework/Hyper-V. Depends on
    artifacts for its output surface. This is the largest single piece left and the one with real
    security surface.
12. **File creation** (docx, pptx, xlsx, pdf) via a bundled python-docx/openpyxl/python-pptx/reportlab
    image. Depends on the sandbox.
13. **MCP client** with loopback OAuth, to replace hosted connectors. Independent of the sandbox.
14. **Skills.** Depends on MCP and the sandbox.
15. **Scheduled tasks** via a `vela-daemon` with OS wake timers, replacing server-side scheduling.
16. **Memory, web search, Styles.** Styles is documented as thin because Anthropic **deleted** the
    source documentation (404 at fetch time) and the Phase 1 critic confirmed it rather than letting
    it be reconstructed from memory.

**Deliberately deferred, not forgotten:** macOS and Linux packaging (only Windows has been
exercised); anything requiring Anthropic's server-side infrastructure, which the spec classifies as
62 of the 178 features and which is why chapter 4 exists.

---

## 4. Traps and judgement calls that are not in the docs

**"Right subject, wrong quantity" is the failure mode of this project.** Four separate defects, all
the same shape: a gate read `fontFamily` from the *declared* CSS stack, so every artifact named a
font that had never loaded; `document.fonts.check()` returns **true** for a font that is absent, and
was very nearly trusted; an assertion compared two boxes' **centres** where the complaint was their
**widths**, and passed on a provably broken ruler where both centred at exactly 600.0; and a test
read a CSS declaration back out of a stylesheet, verifying what was *written* rather than what the
browser *laid out* — and thereby **forbade its own fix**, because correcting the defect made a
passing test fail. Before writing any assertion, ask what quantity would change if the defect were
present. If you cannot answer, the assertion is wrong. This one sentence is the most valuable thing
I learned.

**A test that reads back your own declaration cannot fail.** I shipped a CSS fix, ran a test that
asserted the CSS value I had just written, saw 19/19, and reported it verified. It was wrong at
narrow widths. The measurement has to come from the rendered result — `Range.getClientRects()`, the
computed style, the actual DOM — never from the source you edited.

**Measure at the width where it breaks, not the width where it works.** The gutter regression got
two independent sign-offs because both were taken at 1400px with the sidebar at its 280px default —
the one configuration where every delta reads 0 whether the bug is present or not. It only
reproduces at 880px **with the sidebar dragged to its 480 maximum**, because that is what clamps the
column. A passing measurement at a non-discriminating point is worse than no measurement, because it
buys false confidence.

**Guards claiming enforcement that does not exist.** Eleven or twelve instances, depending how you
count. `lib.rs` said "the `generate_handler!` list and `COMMAND_ALLOWLIST` must agree — `cargo test`
enforces it" and no test did. `contract.ts` named a parity test nobody had written. A sweep chartered
specifically to find these **missed the one in the file that defines the IPC contract**. A comment
asserting a guarantee is load-bearing documentation: every later builder reads it and believes the
invariant holds. A missing guard is a hole; a falsely claimed guard is a trap. The fix is always a
test, never a better comment.

**The composition-root class.** Things built, tested in isolation, and never connected. The provider
registry was never populated, so the shipping app could not reach any endpoint while 1455 gate
assertions passed. `ContextMeter` measured a prop nothing passed. The debug log had no switch while
the UI printed a trace id pointing at it. The thinking block never routed through the `<Markdown>`
component sitting twenty pixels below it. Window controls have every permission granted and no
wire. **When you add a capability, the last step is proving something reaches it from the real
assembled app** — not from a bridge, not from an example, not from a component test. Every gate in
this project drove a substitute until one didn't, and that is how an app that did not start
accumulated a four-figure assertion count.

**Three defect classes a Linux container cannot see, by construction.** Filesystem case sensitivity
— `Markdown.tsx` and `markdown.ts` coexisted, Vite resolved `.ts` first, and the app rendered blank
white on every Windows launch while CI was green. Platform defaults — no bundled typeface, so it
shipped as Segoe UI; a white legacy scrollbar in dark mode; 150% DPI clipping, which is the *default*
scale on most Windows 11 laptops. And anything requiring a real webview, a real keychain, or a real
model. You now hold both roles, which removes this blindness — but it also removes the second pair
of eyes, so be deliberate about it.

**Do not delete the reading measure cap.** The 480px column is about 66–68 characters. It was set in
response to a desktop FAIL at 95–105 characters, and the visual critic passed the reading surface
*specifically on that measure*, naming it as why Vela beat the reference in a blind comparison.
Filling a 2080px pane with prose would be roughly 280 characters per line and would regress an
earned verdict. The fix is a *bounded* increase plus letting non-prose break out. The obvious fix is
the previous defect.

**`Auth::None` is a first-class valid state, not an error.** Local endpoints usually have no auth.
Treating an empty credential as a failure, or emitting an empty `Authorization` header, makes the
product unusable with exactly the models it exists to serve. There is a wire test for this; keep it.

**End-of-body is the only reliable stream terminator.** The matrix measured two hang classes: a
consumer waiting on a `[DONE]` sentinel or a usage frame provably hangs against real endpoints that
send neither.

**My own near-misses, since you asked for them.** I pushed a HEAD with both credential-redaction
barriers disabled, because a snapshot commit captured an agent mid-experiment — the third time the
snapshot habit shipped a half-written state, and the reason the practice narrowed to docs-and-
evidence only while builders are live. I let 47 source files across five commits sit committed but
unpushed while reporting progress; from the remote that work did not exist, and the desktop session
was right to say nothing had shipped. **Push every cycle.** A container reset later destroyed an
entire wave and the only thing that saved twelve commits was that they had been pushed. I misrouted
a binding visual FAIL as platform polish, and the fix would have shipped fonts and scrollbars while
leaving raw markdown printing at the user — the desktop session caught it. And twice I ran a
risky-file inspection and the commit in the same shell invocation, so the warning printed *after*
the decision; the check has to be its own step or it is theatre.

**Two exceptions where I built rather than delegated**, both defensible and both worth noting: I
hand-assembled `icons/icon.ico` because it was blocking the desktop session entirely and the session
that reported it correctly refused to fix what it had graded; and I deleted an orphaned test helper
to unbreak a tree that did not typecheck after a container reset. Neither was graded by me
afterwards.

---

## 5. Which documents are authoritative and which are stale

**Authoritative and current:**

- `docs/architecture/conventions.md` — the rules the code is actually written to, including the
  VERIFIED-BY-FAKE labelling discipline in §10.
- `docs/vela-feature-spec.md` and `docs/spec-parts/` — the target. 178 features, unchanged since
  Phase 1, still the definition of done.
- `docs/desktop-gate/VERDICTS.md` — every desktop verdict, keyed by piece and sha. Authoritative,
  **but check staleness**: a verdict against a sha older than that piece's current HEAD does not
  count. The GATE-M2 entry has a superseding re-run; read both.
- `docs/desktop-gate/REQUESTS.md` — the request side. Mostly current, but it contains status blocks
  I wrote about waves that a container reset then destroyed. Trust `VERDICTS.md` over any status I
  claimed in `REQUESTS.md`.
- `docs/vela-progress.md` — the running narrative and the best single account of how the project got
  here. Append-only in spirit; later sections supersede earlier ones where they conflict.

**Faithful records of something since fixed — do not read as current state:**

- `docs/regression-baseline/phase-b-matrix/` — frozen as round-4 history. Superseded by
  `phase-b2-matrix/`.
- `docs/regression-baseline/phase-b2-matrix/RESULTS.md` — its headline FAIL describes 24 failures
  that are now 0. The failure was real when written.
- Any Phase C screenshot older than the typeface work — **every image captured before Inter was
  bundled shows the app in a fallback font**. They are faithful records of something wrong. The
  matrix was re-captured for this reason; if you find two sets, the later one is current.
- `docs/regression-baseline/platform-defaults-executor/RESULTS.md` — reports a FAIL on a ruler
  regression that has since been fixed and independently confirmed on WebView2.
- The `mock-matrix/` transcripts are **byte-reproducible by design** and there is a script that
  regenerates and diffs them. If they ever differ, that is a real signal, not drift.

**A trap specific to evidence.** The desktop session once declined to photograph a scrollbar because
a pending fix would touch it, on the grounds that "a stale scrollbar image in the record is the kind
of artifact that gets cited later as if it were current". That instinct is right and I recommend
adopting it: do not generate evidence you know will be invalidated within the hour.

---

## 6. The open ledger

Defects and debt, whether or not they were ever filed. I have included things I found and did not
raise.

**Filed and open:**

- Window controls absent (section 3, item 1).
- Windows debug-log directory readable by a non-owner group. Bounded by the feature being opt-in and
  off by default. The **directory** was measured; the log file was never created, because `FileSink`
  opens lazily, so the file itself is **unmeasured** — though a file created there inherits the
  directory DACL, so the exposure follows.
- Four OFL font binaries redistributed with no licence text, and a docblock asserting otherwise.
- Endpoints-form placeholders at 3.96:1, under AA, in both themes.
- `claimed-guards.test.ts` basename resolution; `verify-covers-ci.test.ts` prefix matching.
- Command glyphs on Windows, including in accessible names.
- Two collapsed token pairs: `--vela-turn-user-bg` equals `--vela-thinking-bg` in light, and
  `--vela-bg-inset` equals `--vela-thinking-bg` in both themes.
- A renderer reload drops the open conversation. Minor, surfaced incidentally.

**Unproven claims — things asserted but never demonstrated:**

- **My layout change is unmeasured in a browser.** Typecheck and build pass. Characters-per-line at
  the new ceiling is *calculated* at roughly 75 and *not observed*.
- **The Windows DACL branch has never executed.** It cannot run on Linux. Whatever exists in
  `private_fs.rs` is unrun code.
- **The `cfg(not(unix))` debug-log branch is unenforced and unmeasured**, which is the finding above,
  and remains true until the DACL work lands and the desktop session measures it.
- **CI has never run.** All four checks on PR #1 report `skipped` — a deliberate draft guard so
  half-written commits from parallel agents do not produce noise. The reasoning is sound, but the
  consequence is that **every "gate green" in this project is self-reported by agents**, never
  verified independently. I confirmed by hand that the agents' gate matches CI's command sequence,
  including `pnpm install --frozen-lockfile` and `./scripts/secret-scan.test.sh` which agent gates
  routinely skip — but the first real CI run will hit roughly 160 accumulated commits at once.
- **Everything except the desktop verdicts is VERIFIED-BY-FAKE.** Mock endpoints, `MemoryStore`,
  Chromium on Linux, `tauri::test`'s mock runtime. The genuinely real evidence is narrow: GATE M
  Part 2 against Qwen3.6-27B, the keychain against Windows Credential Manager, and the WebView2
  measurements. Everything else is a fake that was chosen carefully.
- **The mock matrix proves degradation; the real model proves the happy path.** Do not let the
  second stand in for the first.

**Things I found and did not raise, now raised:**

- The `--vela-measure` clamp I just wrote uses a `24rem + 6vw` ramp chosen by arithmetic, not by
  looking at it. It should be reviewed by eye at 1920 and 2560 before it is trusted.
- `compat/provider.rs` was found clean of a credential leak for a reason nobody designed:
  `normalise_error_body`'s serde round-trip incidentally normalises JSON escaping, so the credential
  met the byte scrub. That third defence is undocumented, load-bearing, and evaporates if that
  decorator stops re-wrapping. It was recorded as a candidate and never made intentional.
- The bundle grew 46% when fonts were added — 183KB of woff2, of which the italics are 52%. That is
  a real 46% and simultaneously 0.05% of idle RSS. Both framings are true and the gate that reported
  it insisted neither be substituted for the other. Whether shipping italic variable fonts is worth
  half the increase was never actually decided.
- I never verified that the `Provider` trait can host a subprocess transport. It is an assumption
  underneath roadmap item 8.

---

## 7. If I had one paragraph

Trust the artifact and distrust the narrative, including your own. Almost every serious defect in
this project survived because someone — an agent, the desktop session, me — described work
accurately and nobody checked the thing itself: a font that was declared and never loaded, a
registry that was granted permissions and never populated, a comment asserting an enforcement no
test performed, a passing suite in front of an app that would not start. The habit that caught them
was always the same and it is cheap: run the command yourself, measure the rendered result rather
than the source you wrote, and pick the input where the defect would actually show. You are about to
hold both the building and the grading roles, which means the only thing standing between you and a
comfortable story is a deliberate decision to keep spawning critics who have not seen your
reasoning — do that even when it feels redundant, especially when the work is yours. And build more
than you prove: about six percent of this run's line changes were product code, the rest was
evidence and documentation, and while much of that evidence earned its place, the operator was right
that he watched for two days and saw the app barely move.
