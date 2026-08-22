# GATE M — CONV-1 wave — EXECUTOR'S REPORT

**Verdict: PASS**, on everything this session is structurally capable of judging.
No application defect was found. Two defects were found **in the gate's own instruments**;
both are fixed here and both are described below rather than quietly corrected.

Fresh executor: ran none of the previous waves, wrote none of the fixes under test.

---

## 0. Honesty, first, because every number below depends on it

**Everything here is VERIFIED-BY-FAKE** (`docs/architecture/conventions.md` §10).

- The endpoints are `tests/harness/mock-provider` and, in the Rust assembled-app tests, a
  `TcpListener` fixture in the test file. **No byte of any answer came from a language model.**
- The credential store is `MemoryStore`. The screenshots say `memory-fake`, because the app says so.
- The renderer ran in **Chromium on Linux**. Not WebView2, not WebKitGTK, not the Tauri webview.
- The Rust host ran on `tauri::test`'s **mock runtime** — the real `vela_lib::configure`, the real
  `generate_handler!`, the real commands, but no window and no webview.

**What this session cannot judge, stated so nobody reads a PASS as covering it:**

| Not judged here | Why | Whose it is |
|---|---|---|
| The Tauri webview / WebView2 rendering | no display server; Chromium ≠ WebView2 | desktop `visual` |
| Real input latency, focus, window management | same | desktop `interaction` |
| The Windows build and the packaged binary | cross-compilation not attempted | desktop |
| Case-insensitive filesystem resolution | this container is case-sensitive; the guard is a *proxy* | desktop |
| Cold start, idle RAM, streaming throughput | container figures are meaningless for a desktop binary | desktop `performance` |
| Any real model | the operator's llama.cpp is behind home NAT | desktop `real-model` (GATE M Part 2) |
| The OS keychain | no Credential Manager / libsecret here | desktop `keychain-runtime` |

The debug-log modes are the **one** exception to VERIFIED-BY-FAKE in this report: those are real
files on a real filesystem, read with `stat` from a shell.

---

## 1. The seven items, each proved from outside

### 1. The thinking block renders markdown — asserted in the DOM, captured in both themes

Driven through the real `<App/>` over the relay: the shipping component tree, the real
`vela_lib::ipc::*` functions, the real provider core, a real mock endpoint over a real socket.
`#thinkmd` puts markdown in the **reasoning** channel.

The assertion (`C27`, `checks.mjs::reasoningRendersAsMarkdown`) was widened in both halves:

- **Syntax.** The literal list was `**`, `*   `, ` ``` `. A bare **backtick** is now in it. A block
  that renders bold and bullets and still leaves `` `llama-server` `` in backticks is exactly the
  half-wired outcome this project keeps producing, and three-backtick matching could never see it.
- **Structure.** It required `strong` and `li`. It now also requires `code` (inline) and `pre`
  (fenced), which are two further branches of `markdown-parser.ts`. The reasoning fixture gained a
  fenced block for this — a fence is the construct whose markers `fragmentText` will split across
  SSE frames.

Measured on `frontier`, expanded, from `reasoning-surface.json`:

```
strong 1 · listItems 2 · inlineCode 1 · codeBlocks 1 · white-space normal
text  "Deconstruct the requirements:The user wants a model-agnostic client…
       They mentioned llama-server, which means the endpoint is OpenAI-compatible.…
       bashCopyllama-server --port 8033 --ctx-size 131072Answering now."
```

No `*`, no `` ` ``, no ` ``` ` anywhere in the rendered text content.

**Captures, collapsed and expanded, in both themes**, driven through the app's own theme control
(the title bar button, not `emulateMedia` and not a hand-set attribute), returned to `system`
afterwards so it does not re-theme the rest of the run:

```
phase-c-matrix/frontier/18-thinking-markdown-collapsed-dark.png
phase-c-matrix/frontier/19-thinking-markdown-collapsed-light.png
phase-c-matrix/frontier/20-thinking-markdown-expanded-dark.png
phase-c-matrix/frontier/21-thinking-markdown-expanded-light.png
```

Both themes matter here for a reason the CONV-1 verdict named: `--vela-code-bg` and
`--vela-thinking-bg` were each equal to the page background in *one* of the two themes, so a
one-theme capture of a thinking block containing a code block is precisely the artifact that cannot
show it. In these captures both containers are fill-differentiated in both themes.

Control: **K37** rebuilds the shipped renderer byte for byte — `<p>{text}</p>`, `pre-wrap`, the same
reasoning text — in the live page, and the same function returns FAIL.

### 2. Headings — h1 through h6 with unclassed `<strong>`, captured

The CONV-1 verdict disclosed that **no artifact in its set exercised `h1`, `h3`, `h4`, `h5` or
`h6`**, so "the scale collapses below h3 and a bold run outweighs every heading under it" was a
reading of a stylesheet. That gap is closed with two frames per theme — the six levels do not fit
in one at a readable size, and the point of the capture is that a human can compare them:

```
14/15-heading-scale-from-h1-{dark,light}.png        h1 and the top of the scale
16/17-heading-scale-deep-levels-{dark,light}.png    h4, h5, h6 beside their bold runs

(the same four names exist under mid-local/, small-local/ and hostile/. `hostile`
never closes its thinking block, so its heading document is salvaged rather than
answered and the type assertions are not applied to it — the frames are still
captured, because what a hostile endpoint does to a structured document is worth
looking at even where there is nothing to assert)
```

Measured (`heading-scale.json`, identical on all three profiles with a clean answer channel):

| level | size | weight | | `<strong>` | 15px | **600** |
|---|---|---|---|---|---|---|
| h1 | 24px | 700 | | body | 15px | 400 |
| h2 | 18px | 700 |
| h3 | 16px | 700 |
| h4 | 15px | 700 |
| h5 | 15px | 700 |
| h6 | 15px | 700 |

The inversion is gone: every heading is 700 against a bold run at 600, and no heading is smaller
than the prose it heads. `h4`–`h6` share body *size* and are separated by weight, case and colour
rather than by size steps too fine to see — which is a decision, and it is visible in the captures.

Controls **K30** (bold back at 700 over headings at 600 — the inversion as found) and **K31**
(`h5`/`h6` at 13px under 15px body) both return FAIL through the same function.

### 3. The measure, read from the DOM

`C25` measures characters per line through `Range.getClientRects()` — one rect per rendered line,
summed inked width divided by character count. Not "characters ÷ line boxes", which under-reports
by half a line per paragraph (~8% on a document this length, enough to move the number out of the
band). Nothing reads `--vela-measure`.

```
60.6 characters per line in a 480px column
```

on all three profiles with an answer channel. Control **K33** puts the column back to the 688px it
shipped with and the same function returns FAIL.

The layout ruler, at two viewports with the sidebar dragged to its maximum:

| | 1440px window | 880px window |
|---|---|---|
| transcript text | 720–1200 (480px) | 376–856 (480px) |
| composer box | 720–1200 (480px) | 376–856 (480px) |
| sidebar | 480px | 352px |

One ruler, and the sidebar is what gives way.

### 4. The handler list, mutated in BOTH directions

In a **`git worktree` scratch copy** with its own `CARGO_TARGET_DIR`. The shared tree was never
mutated. Full transcript: `handler-binding-mutations.txt`.

| | mutation | what went red |
|---|---|---|
| baseline | — | 10 passed, 0 failed |
| **A** | `diagnostics_echo` removed from `generate_handler!` **only** (left in both allowlists) | **2 failed.** `every_allowlisted_command_is_reachable_in_the_assembled_app`: *"these commands are in COMMAND_ALLOWLIST but the assembled app answers `Command … not found` for them: diagnostics_echo"* — and the source-level set comparison names the registration |
| **B** | `ui_set_layout` removed from **both** allowlists, still registered | **3 failed.** `no_command_is_reachable_that_the_allowlist_does_not_declare`: *"these commands are reachable from the renderer but absent from COMMAND_ALLOWLIST: ui_set_layout"* |
| restore | — | 10 passed, 0 failed |

The two directions turn **disjoint runtime tests** red, which is the property that matters: the gate
does not merely go red, it says *which way* the two lists drifted. Direction A's verdict comes from
the assembled application answering by name on the mock runtime, not from parsing a file.

### 5. The staged attachment, at both boundaries the bytes must cross

This is the finding two critics found independently, so it is asked at both places a staged file has
to arrive, and the recordings are the **endpoint's own testimony**, not the sender's:

```
renderer -> host        the chat_send payload, recorded at the relay's /invoke
core     -> endpoint    the HTTP body, recorded by the mock endpoint itself
```

Staged through the shipping affordances in the real `<App/>`: a `.md` through the picker on every
profile, and a PNG through **the composer's own paperclip** — the control that shipped with no
`onClick` at all — driven by pressing the button and answering the `filechooser` the browser opens.

Measured (`phase-c-matrix/frontier/staged-attachment-wire.json`):

```json
{ "role": "user", "text": "what is in this picture?",
  "parts": [ { "kind": "image", "mimeType": "image/png", "data": "iVBORw0KGgoAAAANSUhEUg==" } ] }
```

and the endpoint's own record of the request that followed carries that base64 inside an
`image_url` content part — asserted by **parsing** the body, not by searching it, because base64
pasted into the prompt as prose would satisfy a search (control **K56**).

The expected base64 is written out in the driver rather than computed from the file the app read: a
check that shares an encoder with the code it checks agrees with it about the wrong answer as
readily as about the right one.

**The strongest control in this report.** The whole browser matrix was re-driven against a scratch
worktree with **one line deleted from the composition root** — `attachments={attachments}` in
`src/app/App.tsx`, the defect exactly as it shipped:

```
frontier: 37/40 passed
C32 FAIL  renderer->host textParts=[] | core->endpoint carriesName=false carriesBody=false
C33 PASS  chooser opened on composer-attachment-picker
C34 FAIL  renderer->host parts=[] carriesImage=false | core->endpoint carriesImage=false
C35 FAIL  content parts=[]
```

Exactly the three attachment assertions go red and nothing else in the matrix moves. **C33 stays
green and should**: that mutation removes the payload wiring, not the button's handler, and an
assertion set that could not tell those apart could not say which half broke. The same mutation
turns **7 of 8** tests red in `src/app/staged-attachment-payload.test.tsx`. Full transcript:
`attachment-mutation.txt`.

### 6. The debug log — real modes, read by `stat`, under umask 0022

`scripts/gate-m-debug-log-modes.sh`. It throws the switch through the **real
`diagnostics_debug_log_set` command in the assembled app**, makes a turn fail against a dead
loopback port so the sink actually opens its file — an enabled log with nothing written to it is a
directory and no file — then exits the process and asks `stat`.

```
umask 0022

CLEAN — a data home with nothing in it
  PASS  the diagnostics directory is 0700   drwx------
  PASS  the debug log is 0600               -rw-------
  lines recorded 5

LOOSE — a 0755 directory holding a 0644 log with a line already in it
  before: 755 / 644
  PASS  the pre-existing directory is tightened to 0700
  PASS  the pre-existing log is tightened to 0600
  PASS  the line that was already in the log is still in it

CONTROL — the same reader, on a deliberately loose copy
  PASS  the reader reports 644 on a 0644 copy, so 600 above is a measurement
```

The umask is 0022 on purpose: it is the value under which `create_dir_all` yields 0755 and
`File::create` yields 0644, so a wrong implementation cannot pass by accident. The LOOSE case exists
because a "fix" that reached 0600 by deleting the user's log would be worse than the bug it closed,
and only that case can see it. Full transcript: `debug-log-modes.txt`.

### 7. Nothing regressed

| Gate | Result |
|---|---|
| composition-root gate (`drive-app-root.mjs --controls`, production bundle in Chromium) | **25 assertions, 0 failures**, its 5 controls included |
| Phase C matrix — `frontier` / `mid-local` / `small-local` / `hostile` | **40 / 38 / 36 / 33, 0 failures** |
| Phase C assertion controls | **56 / 56 behaved as expected** |
| Phase B2 matrix (`record.sh`) | **1455 assertions, 0 failures**, 46 controls, exit 0 |
| `pnpm typecheck` · `pnpm build` | ✅ |
| `pnpm test` | ✅ **1395 in 63 files** |
| `pnpm test:harness` | ✅ **142 in 12 files** |
| `./scripts/check-transcripts.sh` | ✅ **byte-identical** |
| `./scripts/secret-scan.test.sh` · `secret-scan.sh` | ✅ 12/12 · clean |
| `cargo fmt --all --check` · `clippy --workspace --all-targets -D warnings` | ✅ · ✅ 0 warnings |
| `cargo build --workspace --locked` · `cargo test --workspace --locked` | ✅ · ✅ **44 binaries, 929 passed, 0 failed, 4 ignored** |

The fourth ignored test is new and is this report's: `debug_log_evidence_driver`, `#[ignore]`d so
that it only ever runs from the shell script that measures its output.

---

## 2. The two defects found, both in the instrument

Neither is an application defect. Both are the same class the brief is about — something that
*reads* correct and *measures* something else — and both were in the gate rather than in Vela.

### The C33 assertion named one button and measured another

`getByRole('button', { name: 'Attach an image' })` defaults to a **substring** match, and the model
bar's control is named *"Attach an image or a file"*. `.first()` therefore selected the model-bar
button, and the first run of this step reported

```
C33 PASS  chooser opened on attachment-picker-with-images
```

while claiming to be about the composer's paperclip — the one control in the app that had shipped
dead. Fixed with `exact: true`, and the assertion now checks *which* picker opened
(`composer-attachment-picker`), so the name and the measurement cannot come apart again. The
control **K49** removes the handler from that same button and returns FAIL.

Caught because the mutation run printed the chooser's `data-testid` in its detail column. An
assertion detail that names what was measured is worth the characters.

### `reading-surface.json` attributed a measurement to a font that never loaded

The field was commented *"what the engine **actually resolved**, not what the stack asked for"* and
computed as `getComputedStyle().fontFamily.split(',')[0]` — which is the **declared** stack. Every
committed reading-surface artifact in this repository therefore said

```json
"fontFamily": "Inter"
```

on a container where `fc-list | grep -ci inter` is **0**. A characters-per-line figure is
uninterpretable without knowing the face it was set in, and this one was attributed to a face that
was never found — which is a stone's throw from the A1 desktop FAIL (*"Vela ships no typeface"*),
whose own evidence had to warn that `document.fonts.check('16px Inter')` returns a false positive.

Replaced with a real resolution probe, using the same width-control method the desktop `visual`
critic used to settle it:

```json
"firstFamilyResolves": { "asked": "Inter", "requestedAdvancePx": 481.72,
                         "absentControlAdvancePx": 481.72, "resolves": false }
```

Identical advances: the requested family does not resolve here, exactly as on the operator's
machine. `C25`'s detail line now says so out loud —
`60.6 characters per line at 480px, set in Inter (NOT resolved — a fallback face was used)` — so the
number can never again be read as evidence about Inter. **The A1 finding "Vela bundles no typeface"
is still open and this does not close it.** It makes the gate stop implying otherwise.

---

## 3. What a reader should not take from this

- **This is not GATE M Part 2.** No real model was reached. The desktop session's PASS at
  `84c256f` stands on its own and this report neither extends nor re-tests it.
- **The visual judgements are PROVISIONAL.** Chromium on Linux is not WebView2. The both-theme
  captures are evidence that the markdown *renders* and that the containers are differentiated;
  they are not a verdict on how it looks on Windows.
- **A green matrix on four mock profiles is evidence about degradation handling, not about any
  model.** The interpretation limit in `docs/desktop-gate/VERDICTS.md` binds both ways.
