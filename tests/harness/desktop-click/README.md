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
page target, then **waits for the mount grade** and exits non-zero if it never
passes.

#### What `up` waits for, and why it is not `readyState`

This paragraph used to say `up` "waits for `readyState === 'complete'`". That
sentence is the defect. `readyState` is a question about one word in whatever
document the CDP session happens to be attached to, and on this stack it reaches
`complete` **faster when the bundle fails than when it loads**. Three
constructions were run against the old guard over real CDP and all three came
back `ok: true`, exit 0, with a mount report beside them saying the renderer was
not there:

| | what it was | `readyState` at loop exit | what the old `up` said |
|---|---|---|---|
| E1 | an `about:blank` admitted by the target picker's own fallback | `complete` on poll #1 | `ok: true` |
| E2 | Vela's `index.html` shape with the module bundle 404ing | `complete` in ~50ms, forever | `ok: true` |
| E3 | a static `<div id="root">` splash, zero JavaScript | `complete` | `ok: true`, and `mount` said *"the renderer mounted"* |

In all three the loop iterated **zero times** and its give-up branch was
unreachable. Waiting longer waits zero longer; reporting that we gave up never
fires. So the loop now waits on the **grade** in `mount-grade.mjs`, which is a
conjunction of named criteria, three of which are provenance questions rather
than presence questions:

- **which document** — the CDP target was accepted because it had navigated,
  not by `waitForEndpoint`'s `about:blank` fallback. That branch still exists,
  and now reports `acceptedBecause: "blank-fallback-at-deadline"` instead of
  saying nothing.
- **whose document** — `window.__TAURI_INTERNALS__` is an object, so this is a
  Tauri main frame. Tauri 2.11.5 (`src-tauri/Cargo.lock`) injects it from an
  unconditional main-frame init script; `withGlobalTauri: false` suppresses
  `window.__TAURI__`, which is a different object.
- **who rendered it** — `#root` carries a React root-container key, so a
  renderer put the nodes there. A node count cannot tell a mounted app from a
  splash screen, and E3 is what that costs.

`up` returns `readiness: { exitedBy, readyStateAtExit, polls, waitedMs,
gradeHistory, summary }`. `exitedBy` is `"condition"` or `"deadline"` — the old
loop's exit condition was a local variable that never reached the return value,
so "it gave up" and "it succeeded instantly" printed identically. `--settle-timeout ms`
sets the budget.

**What a passing grade does not entail.** It says a React renderer ran in a
Tauri main frame and owns `#root`. It does **not** say the intended screen
rendered: an error-boundary fallback, or a shell mounted before its data
arrived, satisfies every criterion. `grade.entails` carries that sentence in
every result, and `firstRootChild` shows what mounted. To claim more, assert on
specific application content.

`mount` and `status` grade with the same function, so the three commands cannot
disagree with each other the way `up`'s exit code disagreed with `mount`'s
verdict.

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
type  <query> --value "..." [--via cdp|os] [--clear] [--enter] [--insert-text]
key   --key Enter|Escape|Tab|ArrowDown|<char> [--via cdp|os] [--modifiers ctrl,shift] [--repeat N]
eval  --expr "..." | --file FILE
```

#### `--via os` on the keyboard

`click` has been real `SendInput` since the mouse struct was fixed. `type` and
`key` were **not**: they were `Input.dispatchKeyEvent` only, so any
`reaches-user` claim on this project that involved typing anything was
CDP-substituted at the delivery step. `--via os` on both is now real
`SendInput` with `INPUT_KEYBOARD`.

Three things happen before a key is sent, and all three are in the JSON:

1. **The window is raised and the foreground is proved to belong to this
   session.** A keystroke has no coordinate, so there is no `WindowFromPoint`
   equivalent — the foreground *is* the target. If it is not this session, the
   script refuses and sends nothing. That refusal has already fired here
   against another application's window.
2. **A keyboard self-test runs**, holding `VK_SHIFT` through `SendInput` and
   reading it back with `GetAsyncKeyState` (which reads the global async key
   state and needs no message pump). `SendInput` returns the count it was
   handed whether or not anything is delivered; `keyboardInjectionWorks` comes
   from the read-back, not from the return value. Shift alone types nothing,
   and it is released and re-checked so a stuck modifier is reported.
3. **The struct is described** — `structAsBuilt` and `offsets` — so an empty or
   mis-aligned `KEYBDINPUT` can never again be read as a filtered environment.

The `INPUT` union is declared as a union (`LayoutKind.Explicit`, both members at
offset 0) rather than as "MOUSEINPUT alone, which is the widest member". That
old declaration is why there was no way to send a keystroke: there was no field
to put one in. Measured on this machine, x64:

```
size=40 type@0 union@8 mi.dwFlags@20 ki.wVk@8 ki.wScan@10 ki.dwFlags@12 keybdinputSize=24
```

Hand-padding a flat keyboard struct to 40 bytes instead would have put `wVk` at
offset 4, and `SendInput` would have accepted it and delivered a keystroke for
whatever the padding spelled.

**The self-test's own Shift is delivered.** It runs after the window is raised,
so the focused control sees one extra `VK_SHIFT` keydown/keyup before the run.
It produces no character and is released, but subtract it before reading a key
log. Measured against a WinForms `TextBox` driven by this path: typing
`Vela 127.0.0.1:8033` produced `TEXT=[Vela 127.0.0.1:8033]` and
`KEYDOWNS=<16><16><86><69><76><65><32><49><50><55><190><48>…<16><186><56><48><51><51>`
— the leading `<16>` is the self-test, and `<190>` is `VK_OEM_PERIOD`, which is
the point: the CDP route once sent `.` as `46`/`VK_DELETE` and forward-deleted
instead of typing it.

The virtual-key codes come from the same `keys.mjs` table the CDP route uses, so
the two routes cannot disagree about which physical key a character is on, and
the whole run — `--clear`'s Backspace, every character, `--enter`'s Enter — goes
out in **one** `SendInput` call. Extended keys (arrows, Home/End, Delete,
Insert) carry `KEYEVENTF_EXTENDEDKEY`; without it they are the numpad keys of
the same scan code, which is the same class of wrong-key defect as `.` being
sent as `VK_DELETE`.

`os-input.ps1 -Mode text` delivers a string as `KEYEVENTF_UNICODE` instead. It
bypasses the layout, so it types characters no US key produces — and it reports
**no meaningful virtual-key code**: a handler reading `event.keyCode` sees 0.
It is the OS-side counterpart of `--insert-text` and carries the same warning.

`--text` is a **query filter** everywhere, including on `type`. The string to be
typed is `--value`. Conflating them made `type` search for an element containing
the text about to be entered into it, and report "not found".

#### The two ways to put text in a field, and why there are two

`type` sends **one real key event per character** by default: `keydown` carrying
`text`, then `keyup`, with the US-layout virtual-key code and shift state for
that character. That is the only route that anything listening for keys can
see — `use-navigation-shortcuts.ts`, the `onKeyDown` handlers in `Composer`,
`ModalSurface`, `CommandPalette`, and the roving-tabindex list in `Sidebar.tsx`.

`--insert-text` uses CDP `Input.insertText` instead: the **value** goes in as one
insertion, through `beforeinput`/`input` so React's `onChange` fires, with no key
events of its own. Use it for text no key produces. Never use it to exercise
something whose behaviour is keyboard-driven — it will report success while the
handler under test never ran.

Read the JSON carefully, because "which route" has two answers and they differ:
`valueKeyEvents` is whether the *value* went in as keys, and `keyEvents` is
whether the *run* put any key on the wire. They come apart because `--clear`
presses Backspace and `--enter` presses Enter on **either** route, so
`--insert-text --enter` is an insertion plus two real key events. `cleared` and
`enter` are reported for the same reason: without `cleared`, the Backspace that
`--clear` fires is unrecoverable from the transcript.

The virtual-key code comes from a written-out table in `keys.mjs`, not from the
character. It used to be `name.toUpperCase().charCodeAt(0)`, and ASCII and the
Windows VK space agree only on `0`–`9` and `A`–`Z`. **32 of the 95 printable
ASCII characters were sent with the wrong Windows virtual-key code, and 59 of 95
with at least one wrong field** (virtual-key code, `code`, or shift state) —
`A`–`Z` carried the right code and were wrong only in the missing shift bit, and
space was wrong only in `code`. The whole run `!` to `/` (33–47) landed on the VK
navigation/editing block: `.` was 46 = `VK_DELETE`, so Chromium ran
`DeleteForward` on the keydown and never fired the character event —
`Local llama.cpp` arrived as `Local llamacpp` and `127.0.0.1:8033` as
`127001:8033`. Nine characters were swallowed that way. Above `/` the damage was
quieter: eight (`: ; < = > ? @ ^`) pressed genuinely unassigned codes, but nine
pressed *assigned* keys — `[`→VK_LWIN, `\`→VK_RWIN, `]`→**VK_APPS**, `_`→VK_SLEEP,
`` ` ``→VK_NUMPAD0, `{`→F12, `|`→F13, `}`→F14, `~`→F15. VK_APPS is the one to
notice: Blink fires a context menu on an unmodified VK_APPS keyup on non-Mac, so
typing `]` plausibly opened a context menu over the window being measured.

A character with no key on the layout is now **refused before the window is
touched**, naming `--insert-text`, rather than being given a guessed code: half a
value in a field is worse evidence than none.

**This narrowed a case that used to work.** Non-ASCII code points all produced
virtual-key codes ≥ 128 under `charCodeAt`, which cannot collide with a bare
editing command, so the character rode in on the `text` field and
`type --value "café"` did the right thing. It now hard-refuses. The refusal is
correct — there is no single key on a US layout that produces `é`, so any code
sent for it is a fiction, and the old success was luck rather than design — but
it is a capability that moved rather than one that was only ever broken. The
replacement is `--insert-text`, which is why that flag exists.

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
`isOsInput`, `provenance`, and the evidence.

**Read `provenance.ladderCeiling`, not `isOsInput`.** `isOsInput` answers one
narrow question — did the button or key events go through `SendInput`? — and it
was being read as the broader one a ladder claim needs: could this run have
happened against an installed app with no CDP attached? Those have different
answers here, because CDP does more than deliver on both OS paths. `type --via
os` used to call `focusStored`, which runs `el.focus()` and `el.scrollIntoView()`;
`click --via os` calls `pointFor`, which runs `el.scrollIntoView()` on the way
to computing the screen point. Each is a user's hand or eye, performed by the
harness, while `isOsInput: true` sat in the same object.

`provenance` composes the two. Every step of a run is classified in
`input-provenance.mjs`'s `KNOWN_STEPS` as a `read` (CDP asked a question), an
`instrument` (CDP installed harness-owned state the app never sees), or an `act`
(CDP did something a user would have had to do). One CDP `act` sets
`ladderCeiling` to `dev-clicked` and `substitutions` names which step did it.
The other value is `os-input-unsubstituted`, which is deliberately **not** a
ladder tier: it is the delivery half of `reaches-user`, and the other half is an
installed bundle this harness knows nothing about. `entails.doesNot` says so in
every result.

### The frame is the session, and once it was not

The first version of that grade saw only the steps of the command that called
it, while the sentence it printed — `entails.does` — made a claim about the run:
"no CDP call on this run did anything a user would have had to do". A third
agent falsified it with two documented commands at their default flags:

```
vela-drive type --via cdp --value x --selector #q   # --focus cdp is its default
vela-drive type --via os  --value y --selector #q   # --focus require is its default
```

The first focuses the field over CDP and grades itself honestly at
`dev-clicked`. The second finds the field focused, so the refusal does not fire,
and grades `os-input-unsubstituted` — the strongest thing this harness says —
about a sequence whose precondition CDP manufactured one command earlier. The
class is not focus: a guard whose frame is narrower than the claim its output is
quoted for.

So every command that attaches now writes what it did into a **run ledger** kept
inside the session file, and the grade is composed over the whole session:

- `provenance.ladderCeiling`, `substituted` and `substitutions` are the RUN
  answer. A CDP act in any earlier command caps this one, and each substitution
  names the command and sequence number it came from.
- `provenance.command.*` is the narrower per-command answer. It is kept, because
  it is true and useful — it is simply not the headline any more.
- A run that cannot be **established** grades `dev-clicked` with
  `reason: "earlier-commands-not-accounted-for"`, which is a different answer
  from "CDP was caught". That happens when a command attached and never
  declared what it did (killed part-way), or when the session carries no ledger
  this build can read. Silence is not innocence.
- `eval` is now graded, at the maximum an arbitrary expression could be: an act
  that moved focus. It used to be a CDP channel that entered no grade at all.
- `status` prints the run so far, including `focusOrigin`.

The ledger records **what this harness did**. A second CDP client on the port, or
a hand on the real keyboard, is outside it — `run-ledger.mjs` says so in its
header, and `entails.does` says so in every clean result. Two smaller things it
does do: the run is re-read from disk at the moment it is used rather than
snapshotted, so a command from another `vela-drive` process that ran *during*
this one shows up as `concurrent` and caps it; and sequence numbers are
consecutive by construction, so an entry cut out of the middle of the ledger is
reported as an unreadable ledger rather than as a shorter run. An entry cut off
the **end** is not detectable, and `run-ledger.mjs` names the measurement that
would close the whole class — a `focusin` counter compared against what the run
accounts for — as something it does **not** implement.

Two consequences you will meet:

- `type --via os` **refuses to focus the target for you**, and also refuses when
  the last step this session recorded that could have moved focus was a CDP act
  — naming that step and the command it was in. What it enforces, exactly: the
  target is `document.activeElement`, AND `lastFocusMove` over the session's
  ledger is either a step `KNOWN_STEPS` marks `userEquivalent` — one a user
  could have produced themselves, which today means `os.sendInputMouse`,
  `os.sendInputKeyboard` — or nothing at all (nothing meaning the run has never
  moved focus, so it is where the application itself put it, which is what a
  user finds on launch). Note what that excludes: `os.postMessage` is spelled
  `os.` and is **not** user-equivalent, because nobody posts a
  `WM_LBUTTONDOWN` to a child window they looked up by handle — so a
  `click --via message` cannot supply the focus either. That distinction was a
  hole in the first draft of this fix, found by attacking it. The gate cannot
  prove causation — it names the last recorded step that *could* have been the
  one. `--focus cdp` opts back in and reports `ladderCeiling: "dev-clicked"`
  with `cdp.focusStored` in `substitutions`.
- `type --via os --clear` sends **Ctrl+A then Backspace** through the same
  `SendInput` call, not a CDP `activeElement.select()`. It is not identical:
  `select()` is defined on input and textarea, whereas Ctrl+A goes to whatever
  has focus and outside an editable control selects the document. See
  `clearMechanism` in the result.
- `click --via os` reports `cdp.pointFor.scroll` — and caps at `dev-clicked` —
  only when computing the point actually **moved** the element. `pointFor`
  compares the element's client rect before and after, so an already-visible
  target stays `os-input-unsubstituted`. That is measured, not assumed.

| `--via` | what happens | `isOsInput` |
|---|---|---|
| `os` (default) | `SendInput` — `MOUSEEVENTF_LEFTDOWN` then `LEFTUP` into the system input queue, with the cursor really at the element's screen point. Windows decides which window receives it. **This is what a user's mouse does.** Self-tested first, and it refuses rather than delivering a no-op. | `true` (but see `provenance`: an off-screen target is scrolled to over CDP first, and that caps the run) |
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
  character pipeline into a jsdom `<input>`. Fed the mapping that shipped, the
  model reproduces `127001:8033` and `Local llamacpp` — the two corruptions
  observed against the real window — byte-for-byte, from nothing but the
  virtual-key numbers, so the reproduction is not circular.

  **Read that narrowly.** It is strong evidence for exactly one claim: that
  VK 46 swallowed the character. Both observed strings exercise only that one
  command, and the caret sits at the end of the field on every `.` in both — so
  a model whose VK 46 deletes *nothing at all* fits both observations equally
  well. `keys.test.mjs` asserts that explicitly, so the limit cannot quietly
  widen. The forward delete itself, and the other nine modelled commands, are
  supported by Chromium's source and by ordinary keyboard behaviour, not by any
  observation recorded here. Type `127.0.0.1:8033` into Vela on the next live
  session and record the `activeElementAfter` value here.
- **The model is a model.** It covers the ten bare-VK editing commands that bear
  on this defect. An earlier version of it omitted four (VK 33/34/38/40) and
  therefore reported `"Hello, World!"` and `"a&b(c)d"` as round-tripping under
  the shipped mapping when the real pipeline gives `"Hello, World"` and
  `"bac)d"`. Both are now pinned as controls. A test model that reports a
  corrupted string as intact is the same failure class as the instrument this
  branch was fixing, so treat any future addition to `BARE_EDITING_COMMAND` as
  evidence that the previous account was incomplete rather than as a detail.
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
