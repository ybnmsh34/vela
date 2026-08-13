# The typeface, measured — `fix:bundle-a-typeface`

Closes the `largest_gap` of the `A1-scaffold-shell` **visual FAIL** in
[`docs/desktop-gate/VERDICTS.md`](../../desktop-gate/VERDICTS.md): *"Vela ships no typeface, so on
Windows it renders in Segoe UI and Consolas."*

Produced by `tests/harness/production-bundle/drive-app-root.mjs --controls`, run against the
**production bundle** (`dist/`, the directory `tauri.conf.json` points `frontendDist` at) served
under the **shipping Content-Security-Policy**, in headless Chromium.

## Honesty (`docs/architecture/conventions.md` §10)

**VERIFIED-BY-FAKE.** Chromium on Linux, not WebView2 and not WebKitGTK; `BrowserAdapter` and a
memory credential store; no byte here came from a model, from the Rust core, or from any endpoint.
What these numbers establish is that the built bundle carries the faces and that the stacks resolve
to them **in this engine**. The binding verdict is the desktop session's, and
[`REQUESTS.md`](../../desktop-gate/REQUESTS.md) asks for it with the method spelled out.

## The instrument, and the one that lies

A font's presence is settled by **advance width against a deliberately absent family**. Render a
probe string at 64px in `ZzQqNoSuchFontXx` (the control), in the family the stack names first with
that absent family as its *only* fallback, and in the whole stack as applied. Loaded ⇔ the second
differs from the first. Actually painted ⇔ the third equals the second.

`document.fonts.check('16px Inter')` returns **`true`** in every state recorded here — pre-fix,
post-fix, and on both damaged control bundles. The desktop session saw the same on Windows with no
Inter installed anywhere. It is recorded in the JSON and asserted on nowhere.

## Before

`typeface-probe-PRE-FIX.json`, `PRE-FIX-PROBE.txt` — 5 failures.

| requested family | advance width of the probe string at 64px |
|---|---|
| `ZzQqNoSuchFontXx` (control — definitely absent) | **1725.91** |
| `Inter` | **1725.91** — identical to the control |
| `JetBrains Mono` | **1725.91** — identical |
| the app's actual body stack | 2134.16 — the platform fallback |

`loadedFaces: []`. Zero font requests. `document.fonts.check` said `true` for both.

The same shape the desktop session measured on Windows 11 / WebView2, where the numbers were
481.72 / 481.72 / 481.72 / 523.91 and the last one was Segoe UI.

## After

`typeface-probe.json`, `ASSERTION-LEDGER.tsv` — **42 assertions, 0 failures.**

| | width | verdict |
|---|---|---|
| absent-font control | 1725.91 | — |
| `Inter Variable` requested | **2009** | P17a loaded |
| `--vela-font-sans` applied | **2009** | P17b resolves to it |
| `JetBrains Mono Variable` requested | **2356** | P18a loaded |
| `--vela-font-mono` applied | **2356** | P18b resolves to it |

Four `.woff2` requests, every one from the page origin (P19b). Both italics are real cuts present
in the document's own font set, not the engine shearing the roman (P17c/P18c).

## The reading measure, re-taken in the face that now renders

`--vela-measure: 30rem` was back-calculated from a characters-per-line reading taken in **Segoe
UI**. A reading measure is a property of the pair (width, face), so the typeface change obliged a
re-measurement:

| | mean advance | characters per line |
|---|---|---|
| bundled Inter, 30rem (shipping) | 7.029px | **68.3** — inside the 65–75 band (P20) |
| platform fallback, 30rem | 7.482px | 64.2 (control K6d) |
| bundled Inter, 46rem (pre-Phase-C) | 7.029px | 104.7 (control K7) |

The token does not move — but that is now a measurement rather than an inheritance. K7's 104.7 also
reproduces the operator's independently-observed "~95–105 characters per line" at 46rem, from a
different engine.

## The controls — why none of this is vacuous

`typeface-probe-control.json` is the real bundle served with every `@font-face` rule stripped out of
its CSS on the way to the browser. Nothing on disk changes; the pre-fix state is staged on demand.

| id | what it stages | what it shows |
|---|---|---|
| K6a | a family that is definitely absent | measures *exactly* the control — the "did not load" reading is one the probe can produce |
| K6b | every `@font-face` stripped | P17a/P18a **fail** — the probe catches the defect this commit closes |
| K6c | same | the stack falls to a platform face, which is what Windows saw as Segoe UI |
| K6d | same | characters-per-line moves with the face, so P20 is a measurement and not a constant |
| K7 | `--vela-measure: 46rem` | 104.7 cpl — the band judges the width rather than blessing anything handed to it |
| K8a | only the italic faces stripped | no italic entry in the font set — P17c/P18c fail |
| K8b | same | the sans italic advances collapse to *exactly* the roman: the signature of a synthesised oblique |
| K8c | same | P17a/P18a still **pass**, so the italic checks judge the italic cut and not the family |

## Why `document.fonts.load()` is not in here either

It was tried, and it fails the same way `check()` does for the italic question. CSS font matching
permits style fallback, so on a bundle with every italic stripped,
`document.fonts.load('italic 400 64px "JetBrains Mono Variable"')` resolves happily — with the
**roman** face, reporting `matched: 1, status: ["loaded"]`. It answers "something can serve this
request". The probe enumerates `document.fonts` and matches on `family` **and** `style` instead;
that has no fallback in it, and the entry is either there or it is not.

Width cannot answer the italic question for the mono at all: a monospaced italic carries the
roman's advances by definition, so equal widths there are the *correct* result. An assertion of the
sans's shape would have been a coin flip dressed as a measurement.

## Files

| file | what it is |
|---|---|
| `ASSERTION-LEDGER.tsv` | every assertion and control from the post-fix run |
| `typeface-probe.json` | the post-fix probe: widths, per-weight readings, loaded faces, the reading measure |
| `typeface-probe-control.json` | the same probe against the `@font-face`-stripped bundle |
| `typeface-probe-PRE-FIX.json`, `PRE-FIX-PROBE.txt` | the run on the tree before this commit |
| `01-production-bundle-cold.png` | the app cold, set in Inter — Chromium on Linux, PROVISIONAL |
