# The platform's defaults, measured — `fix:dark-scrollbars-dpi-insets-contrast`

Four defects the desktop session measured on real Windows 11 + WebView2, closed and pinned:

1. **Dark mode showed a pure-white legacy Windows scrollbar with arrow buttons.**
2. **At 150% display scaling the conversation empty state was clipped** — "the Vela mark
   disappears and the heading jams against the header rule".
3. **The model picker's insets were three different numbers** in one popover.
4. **`--vela-text-subtle` was the one colour role never re-authored for dark** — 4.16:1 light /
   4.43:1 dark, under AA in both, and it is the composer placeholder.

## Honesty (`docs/architecture/conventions.md` §10)

**VERIFIED-BY-FAKE, and PROVISIONAL.** Chromium on Linux, `BrowserAdapter`, no Tauri IPC, no
model, no Windows and no display scaling. What is established here is that the layout rules hold
at the viewport sizes 150% scaling actually produces, in *an* engine, and that the cascade
resolves the way the stylesheet says. **The binding visual verdict is the desktop session's.**

Two things this run deliberately does not claim:

- It does not claim the Windows scrollbar is fixed. It measures the half an engine can settle —
  what `color-scheme` resolves to in all six states — and leaves the painted scrollbar to the
  desktop session. Linux Chromium uses *overlay* scrollbars, so the reserved gutter is 0 and the
  width assertion reports "not measurable here" rather than a green tick.
- It does not claim `safe center` fixed the empty state. It did not; see below.

## The instrument

`tests/harness/production-bundle/drive-display-scaling.mjs`, against the **production bundle**
(`dist/`, what `tauri.conf.json` points `frontendDist` at) served under the **shipping CSP**, at
`deviceScaleFactor: 1.5`.

150% scaling does not shrink the CSS pixel. It shrinks the *desktop*, and the window is then
capped by what is left of it — so the viewports are the real effective sizes, less Windows 11's
48px taskbar:

| panel | work area in CSS px |
|---|---|
| 1920×1080 at 150% | 1280×672 |
| 1600×900 at 150% | 1066×552 |
| 1366×768 at 150% | 911×464 |
| Vela's configured minimum | 720×520 |

## Before — the pre-fix bundle, built from `410936b` in a scratch worktree

Run as `--baseline`, where **every assertion is required to fail**. Sixteen did.

| viewport | where the surface rested | Vela mark | heading |
|---|---|---|---|
| 1280×672 | `scrollTop: 104` | top **65.5** vs container 86.5 — **above the edge** | 134.5 |
| 1066×552 | `scrollTop: 264` | **−54.5** | 14.5 — above the container's 126.5 |
| 911×464 | `scrollTop: 352` | **−142.5** | **−73.5** |
| 720×520 | `scrollTop: 326` | **−86.5** | **−17.5** |

**The cause was not the first guess.** The shape of the defect points straight at
`justify-content: center` in a flex column out of room. Driving it showed the empty state was
*reachable* — the wrong thing was the **resting scroll position**: `ConversationView` pinned the
transcript to the bottom on every commit, including the one that renders an empty conversation,
so a state taller than its container opened scrolled past its own first line. On a 1180×780
window it fits (551px of content in 555px of container) and nothing shows; at 150% it does not.

The fix is `restingScrollTop` in `src/features/conversation/scroll.ts`: there is no stream to
follow when there are no entries, and an introduction is read from its first line.

`color-scheme`, all six states (three theme states × two OS preferences), pre-fix:

| theme | OS | declared | widgets painted | palette | |
|---|---|---|---|---|---|
| system | light | `light dark` | light | light | agrees by luck |
| system | dark | `light dark` | dark | dark | agrees by luck |
| light | light | `light dark` | light | light | agrees by luck |
| **light** | **dark** | `light dark` | **dark** | **light** | **disagrees** |
| **dark** | **light** | `light dark` | **light** | **dark** | **disagrees — the reported defect** |
| dark | dark | `light dark` | dark | dark | agrees by luck |

## After

**104 assertions, 0 failures** — `ASSERTION-LEDGER.tsv`.

- 86 on the fixed bundle: four viewports × two themes × eight layout checks, six colour-scheme
  states × two claims, and the scrollbar probe.
- 16 on the pre-fix baseline, each *required* to fail, each of which did.
- 2 synthetic controls: `color-scheme` widened back to `light dark`, and the composer's cap put
  back to a constant. Both reproduce their defect on demand.

Screenshots: `<viewport>-<theme>.png`, eight of them.

## The 7px composer offset — taken, because the scrollbar caused it

The desktop session's re-measurement notes: *"scrollbar-gutter is still auto, so the 7px composer
offset filed under CONV-1 is expected to remain."* It is answered here rather than left to CONV-1,
because the scrollbar causes it and the scrollbar is this piece.

`surfaces.test.ts` proves from the stylesheet that the transcript's text and the composer's box
stand on one vertical ruler. That arithmetic has no scrollbar in it. On Windows there is one: a
classic scrollbar takes its width out of the scroller's content box, the centred column re-centres
inside what is left, and the ruler bends by half a scrollbar. Linux and macOS *overlay* their
scrollbars, so the defect is invisible on both machines that could have caught it and plain on the
platform most users are on — a guarantee asserted in one place and delivered in none.

`.scroller` now sets `scrollbar-gutter: stable both-edges`. `both-edges` rather than plain
`stable`: reserving one side stops the column moving as content grows but still puts its centre
half a scrollbar off the window's. Measured after the change, at every viewport: **24px reserved,
column centre and field centre identical to 0.0px** (assertion `-h`).

## What is guarded but was not broken

`safe center` on every centred column, and the viewport-aware `max-height` caps, are neighbouring
guarantees rather than fixes: the reachability assertion (`-a2`) passed on the pre-fix bundle too.
They are recorded as guards, not as evidence of a closed defect. What enforces them is
`src/styles/platform-defaults.test.ts`, which fails on any centred column that can push content
past its own start edge and on any `max-height` that does not read the viewport.

## The contrast audit

`src/styles/contrast.test.ts` measures **181 pairs** — every `(foreground, ground)` the components
actually paint, read off the components and carrying the file and rule each was read from —
resolved through the token graph, composited where a fill is translucent, in **both** themes.

It was RED on **101 of them** before this change — **66 in light, 35 in dark**, plus ten pairs
whose token did not exist yet (`--vela-text-on-danger`, the scrollbar roles). The briefed role was one of them; the others it
found:

- `EndpointForm .save` and `DeleteConversationDialog .confirm` painted `--vela-night-0` — white in
  *both* themes — on fills that are **light** in dark mode: **1.4:1** and **2.5:1**.
  `--vela-text-on-accent` already existed for exactly this and both files bypassed it.
- `--vela-warning` 3.20–3.33:1 in light, including warning text on its own warning fill.
- `--vela-success` 3.16–3.60:1, `--vela-danger` 4.45:1 in light.
- `--vela-accent` as text (links, the switcher's footer actions) 3.94–4.49:1 in light.
- `--vela-syntax-comment` 3.74–4.18:1 on the code bar, in both themes.
- `--vela-focus` **2.59:1** in light — under the 3:1 that makes a focus ring a ring.

The half that makes it an audit rather than a sample: **a colour role that is not in the table
fails the suite.** Every token used as a `color:` in any component must appear as a foreground;
every token used as a `background:` must appear as a ground or be exempt with a written reason.
Adding a colour to Vela without auditing it is now a test failure, by name.

## A finding for the desktop session, not asserted here

On a **1366×768 panel at 150%** the work area is 911×**464** CSS px, and `tauri.conf.json` sets
`minHeight: 520`. The window cannot fit the work area on that hardware at all. Nothing in this run
can say what Windows does about it — clamp, overlap the taskbar, or push the composer under it —
and it is filed in `REQUESTS.md` rather than guessed at.
