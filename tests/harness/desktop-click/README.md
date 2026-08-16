# Driving the real Vela window — the click harness

**Entry point:**

```powershell
node tests/harness/desktop-click/vela-drive.mjs <command> [flags]
node tests/harness/desktop-click/vela-drive.mjs help
```

Nothing else needs to be read to use it. This page explains what it proves, what
it does not, and the four things about this machine that will otherwise cost you
an afternoon.

Every command prints one JSON object on stdout and a one-line summary on stderr.
Exit codes carry the verdict:

| code | meaning |
|---|---|
| 0 | did what was asked |
| 2 | usage error |
| **3** | **nothing matched — the element is not there** |
| 4 | more than one element matched; narrow the query or pass `--nth` |
| 5 | no session; run `up` |
| 6 | wrong process — another `vela.exe`, or the debug port belongs to someone else |
| 7 | the command failed (including: the click did not land) |

> In PowerShell, `| Select-Object -First N` closes the pipe and kills `node`
> before it exits, so `$LASTEXITCODE` becomes 255 regardless of the outcome.
> Redirect to a file, or read the `ok` field, if the exit code matters.

## The shortest useful session

```powershell
node tests/harness/desktop-click/vela-drive.mjs doctor      # safe to launch?
node tests/harness/desktop-click/vela-drive.mjs up          # build + launch + attach
node tests/harness/desktop-click/vela-drive.mjs mount       # did the renderer mount?
node tests/harness/desktop-click/vela-drive.mjs find  --role button --name "New conversation"
node tests/harness/desktop-click/vela-drive.mjs click --role button --name "New conversation" --watch nav
node tests/harness/desktop-click/vela-drive.mjs read  --selector nav
node tests/harness/desktop-click/vela-drive.mjs down        # stop, and prove it stopped
```

The app keeps running between commands. Each invocation opens its own CDP
connection, re-proves the port belongs to the process it started, does one
thing, and disconnects — so an agent can drive the window from separate shell
calls without holding any state itself.

## Four things about this machine

**1. Two environment variables, and the second is not optional.** Every instance
of this app shares the identifier `dev.vela.desktop`, and there is no
single-instance guard in the tree. WebView2 keys its browser process on the
user-data folder, so a second window on a *shared* profile is served by the
*first* browser process and its `--remote-debugging-port` is ignored entirely.
`up` therefore refuses to launch if any `vela.exe` is already running, gives the
app a private `WEBVIEW2_USER_DATA_FOLDER`, and then proves the pid holding the
listening socket is the pid it spawned — or one of its descendants, because the
port is opened by `msedgewebview2.exe`, a child of the app. That ancestry check
runs on **every** command, not just `up`.

**2. PowerShell 5.1 discards a write to a nested value-type field, in silence.**
`$input.mi.dwFlags = 2` mutates a temporary copy of `mi` and throws it away, so
every `INPUT` reached `SendInput` all-zero. The API accepted the count it was
handed, returned success, and delivered nothing — and the first version of this
harness read that as "the environment filters injected input" and said so, in
this file, to six other tracks. **It was wrong. `SendInput` works here.** Every
`INPUT` is now assembled inside the `Add-Type` C# block with the flags as
parameters, so there is no nested field for a script to assign to:

```
-Mode selftest  ->  "structAsBuilt": "size=40 type=0 dwFlags=32769 dx=32768 dy=32768",
                    "parkedAt": {"x":200,"y":200}, "cursorAfter": {"x":1280,"y":720},
                    "injectionWorks": true
```

`lastWin32Error: 203` comes back identically from the call that works and the
call that did nothing; it is stale residue and is reported without being
interpreted. Two lessons kept: the self-test runs before every `--via os` click
and refuses rather than delivering a silent no-op, and it prints the struct it
built, so an empty one can never again be mistaken for a hostile environment.

**3. A real click goes wherever the cursor is.** The first version of this
harness aimed at the button, landed on a Chrome window that was in front, and
reported honestly that nothing had reached Vela — after having already clicked
inside somebody else's application. `--via message` and `--via os` now raise the
window, move the cursor, ask `WindowFromPoint` who owns that pixel, and send
nothing at all unless the answer is the app or a descendant of it.

Picking "the window" is its own trap, and `candidateWindows` in every result is
there because of it. The process owns a 16x16 untitled `WS_POPUP` helper at
(0,0) — the tao event-loop window — alongside the real one, so the choice is
titled-first-then-largest, and it is reported rather than assumed. Invisible
windows are candidates too: the Vela window was seen once with `WS_VISIBLE`
cleared (`style=0x04CF0000`, title "Vela", rect (690,306)-(1886,1095)) while its
webview went on answering CDP normally, which left the helper as the only
visible candidate and every click blocked. What cleared it was not established.
A hidden window is now shown before being raised, and the result says
`wasHidden: true` when that happened.

**4. The app cannot be pointed at a different app-data directory by environment.**
Tauri resolves it as `dirs::data_dir().join(identifier)`, and on Windows `dirs`
calls `SHGetKnownFolderPath(FOLDERID_RoamingAppData)` — `%APPDATA%` is not read
and cannot redirect it. The only lever is the identifier, which `tauri-build`
and `generate_context!` both take from the `TAURI_CONFIG` merge patch at *build*
time. See "Where the data goes" below.

## Commands

### Lifecycle

```
doctor                              what is running, what is built, is it safe to launch
up   [--bundle prod|dev] [--app-data isolated|real] [--identifier ID]
     [--port 9222] [--scale 1.5] [--no-build] [--timeout ms]
status                              session, /json/version, mount report
down [--all]                        stop; prove the port closed and nothing survived
```

`up` builds unless the binary already matches the requested flavour, launches
with a private WebView2 profile and remote debugging, waits for a *navigated*
page target (a target that is still `about:blank` is not accepted until the
deadline is nearly up — attaching there would report a blank window and call it
a mount failure), waits for `readyState === 'complete'`, and prints the pid, the
`/json/version` response, the ownership proof and the mount report.

`--scale N` adds `--force-device-scale-factor=N` to the browser arguments. That
is the flag that actually changes layout; `Emulation.setDeviceMetricsOverride`
does not, and a verdict built on it is measuring nothing.

### Reading

```
mount                               did the renderer mount? — the one question
read  [--selector CSS] [--limit N]  visible text, line by line
find  <query> [--expect N]          locate elements; exit 3 when nothing matches
appdata [--identifier ID]           where app data really is (GetFinalPathNameByHandle)
screenshot --out FILE               webview contents as PNG (not the window frame)
```

### Driving

```
click <query> [--via os|message|cdp] [--nth N] [--watch CSS] [--settle ms]
type  <query> --value "..." [--clear] [--enter] [--insert-text]
key   --key Enter|Escape|Tab|ArrowDown|<char> [--modifiers ctrl,shift] [--repeat N]
eval  --expr "..." | --file FILE
```

`--text` is a **query filter** everywhere, including on `type`. The string to be
typed is `--value`. Conflating them made `type` search for an element containing
the text about to be entered into it, and report "not found".

#### The two ways to put text in a field, and why there are two

`type` sends **one real key event per character** by default: `keydown` carrying
`text`, then `keyup`, with the US-layout virtual-key code and shift state for
that character. That is the only route that anything listening for keys can
see — `use-navigation-shortcuts.ts`, the `onKeyDown` handlers in `Composer`,
`ModalSurface`, `CommandPalette`, and the roving-tabindex list in `Sidebar.tsx`.

`--insert-text` uses CDP `Input.insertText` instead: one insertion, through
`beforeinput`/`input` so React's `onChange` fires, and **no key events at all**.
Use it for text no key produces. Never use it to exercise something whose
behaviour is keyboard-driven — it will report success while the handler under
test never ran. The command's JSON says which route it took (`keyEvents`), so a
transcript cannot be misread later.

The virtual-key code comes from a written-out table in `keys.mjs`, not from the
character. It used to be `name.toUpperCase().charCodeAt(0)`, and ASCII and the
Windows VK space agree only on `0`–`9` and `A`–`Z`: 59 of the 95 printable ASCII
characters were sent as the wrong key, and the whole run `!` to `/` (33–47)
landed on the VK navigation/editing block. `.` was 46 = `VK_DELETE`, so Chromium
ran `DeleteForward` on the keydown and never fired the character event —
`Local llama.cpp` arrived as `Local llamacpp` and `127.0.0.1:8033` as
`127001:8033`. A character with no key on the layout is now **refused before the
window is touched**, naming `--insert-text`, rather than being given a guessed
code: half a value in a field is worse evidence than none.

### Query flags

`--selector CSS` · `--role ROLE` · `--name TEXT` · `--text TEXT` · `--exact` ·
`--include-hidden`. They are ANDed; at least one is required. `--name` and
`--text` match case-insensitively by substring unless `--exact`. When matching
by text or name without a selector, only the innermost matches are kept, so a
query does not also return every ancestor that contains the words.

`click` and `type` require exactly one match. Two matches is exit 4, not a
coin-toss — pass `--nth` deliberately if you mean the second one.

## What a click is, exactly

Three mechanisms, three different claims. Every result carries `via`,
`isOsInput`, and the evidence.

| `--via` | what happens | `isOsInput` |
|---|---|---|
| `os` (default) | `SendInput` — `MOUSEEVENTF_LEFTDOWN` then `LEFTUP` into the system input queue, with the cursor really at the element's screen point. Windows decides which window receives it. **This is what a user's mouse does.** Self-tested first, and it refuses rather than delivering a no-op. | `true` |
| `message` | The window is raised, the cursor is really moved onto the element (so `:hover` and `:active` are real), ownership of the pixel is checked, then `WM_MOUSEMOVE`/`WM_LBUTTONDOWN`/`WM_LBUTTONUP` are posted to the WebView2 child window. The message goes through that window's own message loop and Chromium hit-tests the client coordinates as it would for a user click — but it never entered the system input queue, and the *window* was chosen by the harness rather than by the input stack. | `false` |
| `cdp` | `Input.dispatchMouseEvent` at the element's viewport point. Enters the browser's input pipeline **ahead of hit-testing**, so the page sees a trusted event that React handles exactly as a user's. Not an OS message; does not need the window focused or visible. | `false` |

**None of them is `element.click()`.** The harness never dispatches a synthetic
DOM event.

### How the verdict is decided, and the two ways it was wrong

A capture-phase `mousedown` listener on `window` records **the node the event
was dispatched at**, and `onTarget` is `node === queried || queried.contains(node)`.
Nothing else decides it. `clicked` requires `onTarget === true`; anything else
exits 7.

Two earlier versions of that one line reported clicks that never happened, and
both are now regression cases in `verdicts.test.mjs`:

- **An ancestor clause.** `hit.contains(el)` was in the disjunction, and
  `document.body` contains everything — so a press that fell *through* the
  queried element onto a container graded as on-target. A button with
  `pointer-events: none`, which is exactly the shape of a control that is drawn
  but not wired, passed while its handler never ran. Measured again after the
  fix, with a real `SendInput` click: `exit 7`, `eventTarget: UL`, no handler.
- **Re-hit-testing after the settle delay.** `elementFromPoint` was called again
  once the dust settled, which reads the DOM as it is *now*. An overlay that
  removes itself on `mousedown` is gone by then, so the point resolved to the
  button underneath and the harness reported a click on it — with `changed:
  true` supplied by the overlay's own removal. Now: `exit 7`, `eventTarget:
  DIV`, only the overlay's handler fired.

`--watch CSS` fingerprints a surface before and after, and `changed` is a DJB2
hash of `innerText` plus an element count. **It corroborates and never
establishes** — any re-render moves it, including one caused by something other
than the click. The result says so in its own `changedMeans` field.

## What this drives: dev bytes or production bytes

`--bundle prod` (default) builds with `--features tauri/custom-protocol`. That
feature is what flips `tauri-macros`' `dev` flag off, so `generate_context!`
embeds `dist/` and the window loads `http://tauri.localhost/` — **the bytes
`pnpm build` produced, over the real Tauri IPC**, with `__TAURI_INTERNALS__`
present and commands answering. Confirmed: `scriptSources` is
`["/assets/index-<hash>.js"]`.

`--bundle dev` builds the plain debug binary, starts `pnpm dev` if nothing holds
port 1420, and the window loads `http://localhost:1420/` with `scriptSources`
`["/@vite/client", "/src/main.tsx"]` — React in development mode over
vite-transformed source.

**What neither is.** Both are the `dev` **cargo profile**: unoptimised host,
debug assertions on, console subsystem. The shipping artefact is
`--release` with `windows_subsystem = "windows"`, and this harness has not built
or run it. A verdict from here may say "this reaches a user in the shipping
frontend bundle through the real IPC"; it may not say "this is what the release
installer does".

## Where the data goes, measured

`appdata` opens the directory **and every entry inside it** and asks the kernel
(`CreateFileW(FILE_FLAG_BACKUP_SEMANTICS)` + `GetFinalPathNameByHandleW`) rather
than believing the path it was given, because inside an MSIX container those are
different answers. Resolving only the root is not enough and the first version
of this command did exactly that: the root answers "real" while the database
inside it does not, so the finding below was invisible from the shipped
command. It now reports `entriesInContainer` and says which.

`--app-data isolated` (default) builds with `TAURI_CONFIG` merging
`{"identifier":"dev.vela.harness"}`, so the app writes to
`%APPDATA%\dev.vela.harness` and **cannot** touch `%APPDATA%\dev.vela.desktop`.
The identifier is the only configuration field that differs from the shipping
build. Two things it does *not* isolate:

- **The OS keychain.** `vela-secrets` uses a hard-coded service name,
  `KEYCHAIN_SERVICE = "dev.vela.desktop"` (`crates/vela-secrets/src/lib.rs:47`),
  which is not derived from the Tauri identifier. An isolated run shares
  Windows Credential Manager entries with every other run.
- **Anything keyed on the identifier at runtime** — if a future verdict turns on
  the identifier itself, use `--app-data real` and accept the consequence below.

`--app-data real` builds the shipping identifier and prints a warning on every
launch: everything the run does is written to `%APPDATA%\dev.vela.desktop`.

### What the kernel actually answered, 2026-08-15, from inside this session

```
%APPDATA%\dev.vela.desktop                     -> C:\Users\User\AppData\Roaming\dev.vela.desktop        (real)
%APPDATA%\dev.vela.desktop\skills              -> C:\Users\User\AppData\Roaming\dev.vela.desktop\skills (real)
%APPDATA%\dev.vela.desktop\vela.db             -> ...\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\dev.vela.desktop\vela.db
%APPDATA%\dev.vela.desktop\vela.db-wal         -> ...\LocalCache\Roaming\dev.vela.desktop\vela.db-wal
%APPDATA%\dev.vela.desktop\vela.db-shm         -> ...\LocalCache\Roaming\dev.vela.desktop\vela.db-shm
%APPDATA%\dev.vela.desktop\diagnostics         -> ...\LocalCache\Roaming\dev.vela.desktop\diagnostics
%APPDATA%\dev.vela.desktop\diagnostics\exchanges.jsonl -> ...\LocalCache\Roaming\...\exchanges.jsonl
%APPDATA%\dev.vela.harness                     -> ...\LocalCache\Roaming\dev.vela.harness
%LOCALAPPDATA%\Temp\vela-desktop-click         -> C:\Users\User\AppData\Local\Temp\vela-desktop-click   (real)
C:\Users\User\vela-w2-harness                  -> C:\Users\User\vela-w2-harness                         (real)
```

**The directory is real; the database is not.** MSIX redirection is
copy-on-write per entry, so `dev.vela.desktop` itself resolves to the machine
path while every file that has been *written* inside it resolves into this
session's container. Two consequences, both worth stating before somebody builds
a verdict on the opposite assumption:

1. A Vela launched from inside an agent session with `--app-data real` reads and
   writes the **container copy**. Its conversations are not the ones a human
   would see by opening Vela from the Start menu.
2. Conversely, that copy is shared by every agent session in this container, so
   `--app-data real` still collides with other tracks. `isolated` is the only
   mode that does not.

This was measured with `GetFinalPathNameByHandle`, not inferred. Re-measure
rather than quoting these lines: the mapping is a fact about the container the
command ran in.

## What this harness has not established

Stated rather than left to be discovered:

- **`--app-data real` has never been run.** The code path is the same one
  `isolated` uses with a different `TAURI_CONFIG` value, and isolation was
  proved in the direction that matters — an isolated run created
  `%APPDATA%\dev.vela.harness\vela.db` and left every timestamp under
  `dev.vela.desktop` untouched. But launching against the shipping identifier
  would have mutated state other tracks are working on, so it was not done.
- **The release binary.** Never built, never driven. See "What neither is".
- **The window-hiding event was not explained**, only detected and worked
  around.
- **Nothing has been driven through Tauri IPC end to end against a live model.**
  The composer is disabled with no endpoint configured, and the harness reports
  that state correctly (`disabled: true`, focus refused) rather than typing into
  it.
- **The key-mapping fix has not been re-driven against a live window.** The
  window was down and had to stay down, so `keys.test.mjs` proves it two ways
  that are not a live run: pure-function assertions on the table, and the three
  strings driven through a *model* of Chromium's keydown → editing-command →
  character pipeline into a jsdom `<input>`. The model's calibration is that,
  fed the mapping that shipped, it reproduces `127001:8033` and
  `Local llamacpp` — the two corruptions observed against the real window —
  byte-for-byte. That is strong evidence the account is right and it is not the
  same thing as having typed `127.0.0.1:8033` into Vela. Do that on the next
  live session and record the `activeElementAfter` value here.
- **`--insert-text` has never been executed.** `Input.insertText` is a CDP call;
  no test in this suite may open a window, so the route is guarded at the source
  (that it exists, that it is not the default, and that the JSON says which
  route ran) and not by running it.

## Failing on purpose

The harness is only worth anything if it can say "not there". Two ways to
re-establish that in ten seconds:

```powershell
node tests/harness/desktop-click/vela-drive.mjs find --role button --name "Export transcript to PDF"
# {"ok": false, "found": false, "count": 0}   exit 3

node tests/harness/desktop-click/vela-drive.mjs find --selector "main" --expect 7
# {"ok": false, "expected": 7, "satisfied": false}   exit 4
```

`--expect N` turns a count into an assertion, which is what you want in a gate
script: it fails on *both* directions of drift, not only on absence.

## Files

| file | what it is |
|---|---|
| `vela-drive.mjs` | the CLI; the only thing you have to run |
| `cdp.mjs` | minimal CDP client, plus the port-ownership proof |
| `page.mjs` | everything that runs *inside* the window, as source strings |
| `os-input.ps1` | Win32: raise, the `SendInput` self-test, and the two delivery modes |
| `final-path.ps1` | `GetFinalPathNameByHandle` — where a path really is |
| `keys.mjs` | the US layout as a table: character → `{key, code, keyCode, shiftKey}` |
| `verdicts.test.mjs` | the regression cases for the three ways this reported a click that never happened |
| `keys.test.mjs` | the regression cases for the harness typing something other than what it was given |
| `vitest.config.mjs` | their project; `pnpm test:click-harness`, and inside `pnpm verify` |

No dependencies beyond Node 22+ (global `WebSocket` and `fetch`) and Windows
PowerShell. Nothing here is imported by the app, and `pnpm build` never sees it.
