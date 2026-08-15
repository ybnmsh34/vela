# Audit — desktop shell, layout and visual design

Auditor domain: `src/app/`, `src/features/navigation/`, `src/components/`, `src/styles/`.
Worktree `C:\Users\User\vela-tmp`, branch `claude/new-session-tgl1ut`, HEAD `a1fa55e`.

This is the evidence behind the structured grades. Commands are given with their
literal output where the output is the finding.

---

## 0. Establishing that what I drove was the code under audit

The brief warns that a stale build nearly cost a verdict here. Two things had to
be true before any measurement counted: the binary had to be current, and the
frontend it loaded had to be this checkout.

**The binary.** `src-tauri/target/debug/vela.exe` was built at 13:17 today; no
`.ts`, `.tsx`, `.css` or `.rs` file under `src/` or `src-tauri/src/` was newer
than it. `dist/` was older (10:49), so I rebuilt the frontend and compared
content hashes:

```
$ pnpm build
dist/assets/index-6hSBMkr6.css      80.29 kB
dist/assets/index-Bw5yaEKr.js      400.63 kB
dist/assets/window-C7pz_2Ow.js      13.37 kB
```

Every emitted filename is content-addressed and every one matched the bytes
already on disk. The `dist/` the binary embeds is a byte-exact rebuild of the
current source.

**The frontend it actually loaded.** After launching, the page reported
`location.href === "http://localhost:1420/"`. The debug binary is a `tauri dev`
build, so it loads `devUrl`, not the embedded `dist/`. Something was already
serving 1420, and it mattered enormously *what*:

```
$ Get-CimInstance Win32_Process -Filter "ProcessId = 6532" | ... CommandLine
node   "C:\Users\User\vela-tmp\node_modules\.bin\\..\vite\bin\vite.js"
```

An orphaned vite server rooted in **this** worktree — not the operator's other
checkout at `C:\Users\User\vela`. So the running window was the audited source,
transformed live. That is fresher than any build, but it is the *dev* bundle;
see §10 for what I did about the production bytes and §12 for what remains
unverified because of it.

**Launch.** As the brief specifies — both env vars, because a shared profile
silently swallows the debug port:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
$env:WEBVIEW2_USER_DATA_FOLDER="<scratchpad>\wv2"
Start-Process src-tauri\target\debug\vela.exe        # pid 13084
```

```json
{"Browser":"Edg/151.0.4129.78","V8-Version":"15.1.23.6", ...}
```

Only one `vela.exe` existed while I worked. I stopped it at the end and
confirmed the CDP port closed. The pre-existing vite server was left alone.

---

## 1. Window controls drive the real OS window

I clicked the caption buttons and read the OS window's own dimensions, not the
viewport.

```
before:          inner [1180, 780]   outer [1180, 780]   labels [Minimise, Maximise, Close]
clicked Maximise
after maximise:  inner [2560, 1392]  outer [2560, 1392]  labels [Minimise, Restore,  Close]
clicked Restore
after restore:   inner [1180, 780]   outer [1180, 780]   labels [Minimise, Maximise, Close]
```

`screen` reports `2560×1440` with `availHeight 1392`, so the maximised size is
the real work area. The icon and `aria-label` flipped to *Restore* and back —
and the rule `use-window-controls.ts` is built around ("`maximized` is read from
the window; it is never inferred from a click") is what makes that flip correct
in both directions. This is a real window, resized by a button in the app.

**Not exercised:** Minimise and Close. Pressing Minimise hides the window with
no in-app affordance to bring it back; Close ends the session under audit.
Their wiring shares one seam with Maximise, which I did prove, and
`window-controls.test.tsx` covers both against a fake window — but I did not
watch them move real glass, and I say so rather than implying otherwise.

## 2. Double-click on the drag region maximises exactly once

This is the claim that most deserved a real window, because the failure mode is
invisible in a unit test that has no Tauri drag script attached: Tauri's own
document-level listener also calls `internal_toggle_maximize` on this event, and
two toggles on one gesture reads as a control that does nothing.

I dispatched a genuine `mousePressed`/`mouseReleased` pair with `clickCount: 1`
then `clickCount: 2` at the centre of `[data-tauri-drag-region]`:

```
size before dblclick: [1180,780]
size after dblclick:  [2560,1392]
maximise button label now: Minimise,Restore,Close
```

One toggle. Had the event reached the framework as well, the window would have
gone up and straight back down and ended at 1180×780. The geometry was checked
too — the drag region spans x 224.3 → 913.6, the caption group starts at
x 1042, `overlapsCaption: false`, `containsButtons: 0` — so the gesture cannot
land on Close.

**And the test bites.** Commenting out the one line:

```
$ perl -i -pe 's/event\.stopPropagation\(\);/\/* MUT *\/;/' src/app/shell/TitleBar.tsx
$ pnpm exec vitest run src/app/shell/window-controls.test.tsx
 × the drag region > keeps the double-click gesture away from the framework, so it cannot fire twice
   → expected [ 1, 2 ] to not include 2
 Tests  1 failed | 14 passed (15)
$ git checkout -- src/app/shell/TitleBar.tsx      # status: clean
```

Note which tests *stayed green*: "toggles maximise on a double click, exactly
once" still passed with the mutation in place. Only the test written for the
propagation half caught it. That is the right shape — but it means the guard is
one assertion wide.

## 3. The capability grant matches the wire that runs

`capabilities/main.json` withholds `core:window:allow-internal-toggle-maximize`
on purpose (the renderer owns that gesture) and grants exactly five window
permissions. I mutated it in both directions at once — removed a needed grant,
added the forbidden one:

```
 × grants exactly the window commands the title bar calls
   → expected [ 'core:event:default', …(5) ] to include 'core:window:allow-is-maximized'
 × withholds internal-toggle-maximize, because the renderer owns that gesture
   → expected [ … ] to not include 'core:window:allow-internal-toggle-max…'
 Tests  2 failed | 13 passed (15)
```

Reverted clean. This is a real parity guard, not a comment.

## 4. Title bar tab order, and the Close button

Walked with real `Input.dispatchKeyEvent` Tab presses in the assembled app. DOM
order inside the bar:

```
[{"label":"Theme: light","ti":0},{"label":"Minimise","ti":0},
 {"label":"Maximise","ti":0},{"label":"Close","ti":0}]
```

Close is last **within the title bar**, which is what
`window-controls.test.tsx:287` asserts (it renders `TitleBar` alone and expects
`['Theme: system','Minimise','Maximise','Close']`).

One honest correction to the prose in `TitleBar.tsx`, which says Close is "last
in the tab order, so nothing tabs *through* it on the way somewhere else". In
the assembled window the title bar is the **first** landmark in the document, so
the global order is Theme → Minimise → Maximise → Close → sidebar → main: a user
tabbing forward does pass over Close on the way to the sidebar. Passing over is
not activating, and the other three protections (outside the drag region, no
focus at mount, acts on a real click not `mousedown`) are intact and tested. I
grade the aspect PASS and flag the sentence as bar-scoped, not app-scoped.

## 5. The theme preference is applied *and* kept

The named defect was that `settings_set_theme` had no caller and the choice was
discarded at every restart. I clicked the real button and asked the Rust host
what it now holds:

```
host settings now: {"theme":"dark", "credentialBackend":"os-keychain", ...}
   (click, click)
after switching to light, host settings: {"theme":"light", ...}
```

The cycle itself, read off the live document at each step:

| click | aria-label | `data-theme` | `color-scheme` | body bg | `--vela-accent` |
|---|---|---|---|---|---|
| — | Theme: dark | `dark` | dark | rgb(8,11,22) | `#5fe2d6` |
| 1 | Theme: system | *(absent)* | light | rgb(247,248,251) | `#0b6864` |
| 2 | Theme: light | `light` | light | rgb(247,248,251) | `#0b6864` |
| 3 | Theme: dark | `dark` | dark | rgb(8,11,22) | `#5fe2d6` |

Two independent confirmations that the *load* half works too: at first paint the
app was in dark while the OS preference is light (system resolves to light here,
as row 1 shows), so the dark had to have come from the store; and after I
navigated the webview away and back, it came up dark again from a fresh adapter.

## 6. `color-scheme` follows the app's theme, not the OS

Row-by-row in the table above: `color-scheme` is `dark` exactly when the palette
is dark, in all three states, on a machine whose OS preference is light. That is
the property that stops Windows painting a white legacy scrollbar down the side
of a dark app.

## 7. Vela draws its own scrollbar

Measured, not asserted. A synthetic `overflow-y: scroll` probe reported
`offsetWidth - clientWidth === 12`, matching `--vela-scrollbar-size: 12px`; the
Windows classic scrollbar is 17px. Both live scrollers (`Sidebar .list`,
`main`) reported the same 12. `scrollbarColor` and `scrollbarWidth` both
computed to `auto`, i.e. the two standard properties that would disable every
`::-webkit-scrollbar-*` rule are absent.

The arrow buttons are the part a number cannot settle, so I photographed them —
a ×8 clip of the top and bottom 60px of the main scroller:

- top (`s02-scrollbar-top.png`): a rounded pill thumb in night-400 starting at
  the very top edge, on an unpainted trough. No button.
- bottom (`s03-scrollbar-bottom.png`): uniform page colour. No button.

With the transcript open, its scroller reported
`scrollbar-gutter: stable both-edges` and `offsetWidth - clientWidth === 24`,
which is exactly `--vela-scroll-reserve: calc(2 * var(--vela-scrollbar-size))`.
The token is the number the engine actually produces.

**The test bites.** Adding the one property the comment forbids:

```
$ # inserted `*  { scrollbar-width: thin; }` above ::-webkit-scrollbar in base.css
$ pnpm exec vitest run src/styles/platform-defaults.test.ts
 × does not set the standard properties that would disable all of it
 Tests  1 failed | 18 passed (19)
```

## 8. The bundled typeface actually paints

Advance-width against a deliberately absent family, per the repo's own rule that
`document.fonts.check()` must not be used:

| family | width of the probe string @100px |
|---|---|
| `'Inter Variable'` | **1467.00** |
| `'Inter Variable Zz'` (control) | 1353.28 |
| `'Segoe UI'` | 1382.77 |
| `'JetBrains Mono Variable'` | **1740.00** |
| `Consolas` | 1594.44 |

Inter renders as neither its fallback nor Segoe UI; JetBrains Mono renders as
neither Consolas nor the generic. Both faces are really being drawn in WebView2.

Then the part nobody had done: the **production bytes** in the **real WebView2**.
I served `dist/` on 127.0.0.1:1421 and navigated the window to it.

```json
{"mounted": true,
 "interPaints": true, "interW": 1467, "interCtl": 1353.28125,
 "jbPaints": true,
 "fontFaces": ["Inter Variable 100 900 loaded", "JetBrains Mono Variable 100 800 loaded", ...],
 "scrollbarGutter": 12, "measure": 480}
served paths: ["/", "/assets/index-B1Da_iwg.css", "/assets/index-798-plae.js",
               "/assets/inter-latin-wght-normal-Dx4kXJAl.woff2",
               "/assets/jetbrains-mono-latin-wght-normal-B9CIFXIH.woff2", ...]
```

Identical advance widths from the built CSS, both `.woff2` files actually
fetched, both faces `loaded`. The repo's own gate proves this on Chromium/Linux;
this is the same claim on the engine Vela ships on, from the bytes Tauri embeds.

## 9. The reading measure, measured on WebView2

`--vela-measure` is `clamp(30rem, 24rem + 6vw, 33rem)`. Characters per line
computed as column ÷ mean advance (the repo's method, which avoids the ~8% bias
of counting line boxes), on a real assistant answer:

| window | resolved measure | prose column | **chars/line** |
|---|---|---|---|
| 1180×780 | 480px | 480.0px | **68.1** and **68.0** |
| 2560×1392 (really maximised) | 528px | 528.0px | **74.9** |

Both inside the 65–75 band; the wide end lands on 74.9 against the 75.1 the
token comment predicts. The user's own turn measured 382px / 53.1 cpl — capped
narrower and on the opposite edge, as designed.

**The test bites.** Restoring the pre-fix value:

```
$ # --vela-measure: 46rem;
$ pnpm exec vitest run src/styles/surfaces.test.ts
 × the reading measure is a measure > sets the reading column near the comfortable band
 Tests  1 failed | 28 passed (29)
```

## 10. Contrast, on the real render

Ratios computed from `getComputedStyle` on the live window, walking up to the
first solid ground:

| element | dark | light |
|---|---|---|
| status line (12px/400) | 5.69 | 5.26 |
| title bar context (13px/400) | 5.69 | 5.26 |
| wordmark (13px/600) | 16.03 | 16.03 |
| hero h1 (24px/600) | 17.23 | — |
| hero lede (18px/400) | 7.74 | — |

**The test bites, and it bites well.** I reverted `--vela-text-subtle` in both
dark blocks to the pre-fix `night-400`:

```
 × holds in dark
 + "3.74:1 (needs 4.5) — --vela-text-subtle on --vela-surface-raised — CommandPalette .field / .input::placeholder / .rowKind / .footnote",
 + "3.60:1 (needs 4.5) — --vela-text-subtle on --vela-row-hover over --vela-chrome — ConversationRow .meta, hovered",
 + "3.34:1 (needs 4.5) — --vela-text-subtle on --vela-row-selected over --vela-chrome — ConversationRow .meta, selected",
 + "4.49:1 (needs 4.5) — --vela-text-subtle on --vela-bg — HomeSurface .recentHeading / .recentMeta / .fact dt",
 ...12 pairs, each naming the component
 Tests  1 failed | 7 passed (8)
```

It resolves the whole `var()` graph and composites translucent row states over
their grounds. A 4.49 vs 4.5 failure is a table that is actually doing
arithmetic, not pattern-matching.

## 11. The command palette, end to end in the real window

Ctrl+K from a focused sidebar button:

```
after Ctrl+K: role=dialog, aria-modal=true, aria-label="Command bar",
              activeElement = the combobox input,
              aria-activedescendant = _r_0_-option-0, 11 rows, row 0 aria-selected
```

Typing `kitchen` (seven real key events) narrowed the local filter *and* brought
back host results — rows labelled `In message` and `In thinking` appeared, which
means the search IPC really fires from the assembled app and the two halves stay
labelled as the file promises. ArrowDown moved both `aria-activedescendant` and
`aria-selected` to row 1 while focus stayed in the input. Escape closed it.

Ctrl+P opened the same bar with `aria-label="Go to conversation"`; Ctrl+F opened
it with `aria-label="Search conversations"` — the mode is real, not decorative.

## 12. Modal focus containment and restore

The palette has exactly **one** tab stop, so containment is doing all the work.
24 forward Tab presses and 24 backward:

```
24 forward Tabs, all inside dialog: true  ([true × 24])
24 backward Tabs, all inside dialog: true
```

Escape returned focus to the button that opened it, not `<body>`:

```
after Escape: dialogPresent=false, activeTag=BUTTON,
              activeAria="New conversationCtrl+NControl N", activeIsBody=false
```

The `ModalSurface.tsx` header says verifying this honestly "would take a driven
WebView2 window, which is not available here". It is available now, and the
answer is yes — including in the `alertdialog`, where 8 Tabs stayed inside and
Escape restored focus to the composer textarea.

**The test bites, hard.** Disabling the containment call:

```
$ # removed: if (event.key === 'Tab' && !event.isDefaultPrevented()) containTab(event);
$ pnpm exec vitest run src/app/modal-containment.test.tsx src/components/ModalSurface.test.tsx
 Tests  11 failed | 5 passed (16)
```

## 13. The delete-conversation dialog

Opened from a row's Delete button:

```json
{"role":"alertdialog","ariaModal":"true",
 "labelledBy":"delete-conversation-title","describedBy":"delete-conversation-body",
 "text":"Delete this conversation? | Gate rename OK and everything in it will be removed from this device. This cannot be undone. | Cancel | Delete",
 "focused":"Cancel","focusInside":true,"stops":["Cancel","Delete"]}
```

Initial focus is **Cancel**, the safe control. Escape dismissed it and the row
survived (`gateRowStillThere: true`). Separately, at the end of §16 I exercised
the destructive path once — on a conversation I had just created myself — and it
removed exactly that row and nothing else.

## 14. Sidebar layout controls

The resize handle, driven by keyboard only (I did not test the pointer-drag
path):

```
initial:                {"navWidth":480,"valuenow":"480","valuemin":"200","valuemax":"480",
                         "ariaOrientation":"vertical","sepTabIndex":0,"sepLabel":"Resize sidebar"}
after 5 ArrowRight:     480   (clamped at max)
after 30 ArrowLeft:     200   (clamped at min)
after 60 ArrowRight:    480   (clamped at max)
```

`role="separator"` with a live `aria-valuenow`, operable from the keyboard,
clamped in both directions at the values `navigation-store.ts` declares. It
writes through `--vela-sidebar-width` on the element, which is what the token
comment says it does.

Collapse:

```
before:    {"w":480,"label":"Collapse sidebar","mainX":480}
collapsed: {"w":56, "label":"Expand sidebar",  "mainX":56}
expanded:  {"w":480,"label":"Collapse sidebar","mainX":480}
```

56px is `--vela-rail-width`, and the content region really moves with it.

## 15. Roving tabindex

Ten conversation rows. At rest, exactly one carries `tabIndex 0` and the rest
`-1`. After two real ArrowDown presses:

```json
{"rows":10, "zero":1, "zeroAt":2, "activeIsRow":true, "activeText":"New conversation…"}
```

The single tab stop moved with focus. A forty-conversation list still costs one
Tab to step past.

The per-row Rename/Delete buttons are `tabindex="-1"` on every row including the
focused one, so they are reachable by pointer or by the F2/Delete keys but never
by Tab. That is the documented design; I note it because nothing on screen
advertises those keys.

## 16. Global shortcuts

All five, as real key events, against the real window:

```
Ctrl+K -> palette open,  input aria-label "Go to conversation"
Ctrl+P -> palette open,  input aria-label "Go to conversation"
Ctrl+F -> palette open,  input aria-label "Search conversations"
Ctrl+B -> nav width 480 -> 56 -> 480
Ctrl+N -> conversations 10 => 11, selected "New conversation"
```

I then deleted the conversation Ctrl+N had created, through the real dialog's
Delete button, and the count returned to 10. The store is as I found it.

## 17. Focus ring and the global element defaults

```json
{"outlineWidth":"2px","outlineStyle":"solid","outlineColor":"rgb(13, 133, 127)",
 "outlineOffset":"2px","tokenWidth":"2px","tokenColor":"#0d857f"}
```

The ring a focused control actually draws is the token, not a component's guess.

`user-select`, measured across the tree:

```json
{"body":"none","titlebar":"none","sidebarRow":"none","statusBar":"none",
 "transcriptProse":"text","codeBlock":"text"}
```

Chrome is not a document; content opts selection back in. Exactly what
`base.css` claims.

Reduced motion, via `Emulation.setEmulatedMedia`:

```
default: {"prefersReduced":false,"navTransition":"0s","btnTransition":"0s"}
reduce:  {"prefersReduced":true, "navTransition":"1e-05s","btnTransition":"1e-05s"}
```

## 18. The type scale

Every leaf element with text, tallied by computed `font-size/font-weight`:

```
13px/400 ×204, 15px/700 ×40, 16px/400 ×38, 12px/400 ×32, 13px/600 ×18,
15px/400 ×16, 13px/500 ×14, 11.7px/400 ×13, 10.8px/400 ×3, 12px/500 ×2,
12px/600 ×2, 24px/700 ×1, 18px/700 ×1, 16px/700 ×1, 15px/600 ×1
```

Root is 16px, so: 12 = `--vela-text-xs`, 13 = `sm`, 15 = `base`, 16 = `md`,
18 = `lg`, 24 = `xl`. The two odd ones are `--vela-text-inline: 0.9em` resolving
against 13px (11.7) and 12px (10.8). Nothing on screen renders at a size that is
not a token or a token times a token. Weights are 400/500/600/700 — the four
declared steps.

## 19. The status bar says what is true

```
"Bridge ready · os-keychain | Offline · no telemetry"   height 28px (= --vela-statusbar-height)
```

`os-keychain` is the value `settings_get` really returned from the Rust host
(see §5), not a literal. The dot is `rgb(22,121,74)` = `--vela-mint-700` =
`--vela-success`, and it is `aria-hidden` with the state also in the text.

## 20. FAIL — nothing returns you to the home surface

`HomeSurface` carries the product's own honesty readout, the two primary CTAs
and "Pick up where you left off". It is the first thing a user sees. After the
first conversation is opened, **no control anywhere in the application returns to
it.**

I enumerated every interactive element in the assembled window with a
conversation open — 54 of them:

- title bar: Theme, Minimise, Maximise, Close
- sidebar: New conversation, Collapse sidebar, Search conversations, Memory,
  Resize sidebar, and Open/Rename/Delete per row
- main: model picker, Capabilities, attach, Thought process, Copy ×N, Send,
  composer

Nothing labelled Home, Vela, Back or Close conversation. The wordmark and the
mark are `<span>`s with no clickable ancestor (`wordmarkClickable: false`,
`markClickable: false`). Escape in the content region does nothing. The command
palette's only action row is "New conversation".

The call-path check agrees. `select(null)` has exactly one caller in the whole
renderer:

```
$ git grep -n "select(null)" -- src
src/features/navigation/use-conversations.ts:160:        if (selectedId === conversationId) select(null);
```

— the delete path. I confirmed it live: after deleting the open conversation the
home screen returned (`heroPresent: true`). So within a session, the only routes
back to the empty state are *delete the conversation you are reading* or *quit
and relaunch*. This is the domain's defect signature exactly: a surface that is
built, styled, tested and unreachable.

## 21. FAIL — Windows High Contrast is not handled

Vela ships on Windows only, where High Contrast is a first-class accessibility
mode.

```
$ git grep -n "forced-colors\|-ms-high-contrast" -- src
(no matches)
```

Under `forced-colors: active` (screenshot `s05-forced-colors.png`) the app is
mostly fine — the OS palette takes over, borders appear, the caption glyphs
survive because they are `currentColor`. But the **selected conversation loses
its only cue**. `ConversationRow.module.css` distinguishes it by colour alone:

```css
.selected, .selected:hover { background: var(--vela-row-selected); }
.selected .main            { color: var(--vela-row-selected-text); }
```

Forced colors strips both, and there is no border, weight or marker to fall back
on. `aria-current="page"` is present (`ConversationRow.tsx:150`), so assistive
technology is told — a sighted High Contrast user is not. Nothing in the test
suite exercises `forced-colors` at all.

## 22. The design-token drift guard

`src/styles/design-system.test.ts` scans every `*.module.css` for raw colours,
bare line-heights, bare `z-index`, hand-rolled shadows, invented type sizes and
non-token font stacks, and closes with a self-test — `the scans actually catch
drift` — that asserts each regex fires on the shape it exists to catch and not
on the tokenised form. That self-test is real and it is the reason I grade this
PASS. I did **not** plant a raw hex in a component sheet and watch it fail, so
the evidence is `test-only-unproven` and I say so.

---

## Contamination I caused, and repaired

Worth recording, because eleven agents share this worktree. At 13:33, while my
`--vela-text-subtle: night-400` mutation was in `src/styles/tokens.css` for the
~40 seconds it took to run one vitest file, **another agent ran `pnpm build`**.
The mutation was baked into `dist/`:

```
$ node -e "... first diff ..."
NOW   : "--vela-text-subtle: var(--vela-night-400);"
BEFORE: "--vela-text-subtle: var(--vela-night-350);"
```

I could not simply rebuild — another agent had `src/lib/memory-prompt.ts`
mutated at that moment and `tsc` refused. I restored `dist/` byte-for-byte from
the clean build I had copied to the scratchpad before starting, and verified:

```
subtle: night-450 | night-350 | night-350
measure ok: true
no scrollbar-width: true
```

`dist/` is correct now. Any measurement another auditor took from `dist/`
between roughly 13:33 and 13:41 should be re-taken. All six of my source
mutations were reverted with `git checkout --` and each confirmed clean via
`git status --porcelain`; the only modified tracked file at the end was another
agent's.

## What I could not establish

- **Minimise and Close were never pressed.** Hiding or ending the window under
  audit was not worth the evidence.
- **Every interaction verdict is against the dev bundle.** The debug binary
  loads `devUrl`, so React ran in development mode with vite-transformed source.
  I confirmed the production `dist/` bytes render identically in the same
  WebView2 (typeface, scrollbar, measure, mount) but could not *interact* with
  them: Tauri's IPC is origin-bound and the conversations call returned
  `INTERNAL` at the foreign origin, so the production bundle fell back to its
  in-memory adapter.
- **The release binary was never built or run.** Disk was at 15 GB across eleven
  agents.
- **150% display scaling is emulated, not real.** `deviceScaleFactor: 1.5` left
  the chrome intact (header top 0, height 40; footer bottom 780; main 712) but
  reported elements above the viewport top, which I could not distinguish from
  ordinary scrolled-out content. Real OS DPI was not changed.
- **The pointer-drag resize path** was not driven; only the keyboard separator.
- **Inline rename (F2)** was not tested.
- **The palette's failure paths** — host search error, the "no match" footnote —
  were not exercised, because I had no way to make the host search fail without
  disturbing other agents.
- **Theme survival across a full process relaunch** was not tested. I proved the
  host round-trip and survival across a full page reload, which is strong but is
  not the same as a cold start.
- **`design-system.test.ts` was not mutation-tested** against a component
  stylesheet.
