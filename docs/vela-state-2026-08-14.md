# Vela — verified state, 2026-08-14

Written by the desktop session on taking over both building and grading. Everything below was
established by reading real artifacts and **running** things, not by reading summaries — including
not by trusting my own memory of this project. Every claim carries its evidence and how it was
verified. Where the only evidence is code inspection, it is labelled **UNVERIFIED** and should be
read as an assertion, not a fact.

HEAD at time of writing: **`535f482`**, working tree clean, local and `origin/claude/new-session-tgl1ut`
in sync.

---

## 0. A correction to the brief's own premise

The brief asks "where are the nine false-enforcement claims? Are they all fixed?" **There were never
nine false-enforcement claims.** The number nine counts instances of this project's *general* defect
class — built-but-wired-to-nothing — and only **two** of those nine were the "claimed enforcement"
shape specifically.

> `docs/vela-progress.md:2717-2719` — "It is the ninth instance of this project's central defect
> class and the second in the \"claimed enforcement\" shape specifically"

The sweep that followed found **eleven** sites, not nine.

> `docs/vela-progress.md:2754` — "**Ledger.** Eleven sites carried a claim with nothing behind it"

So the correct question is: are the **eleven** closed? Answer below, and it is not a clean yes.

---

## 1. The test suite, run rather than read

```
pnpm test  →  3 files failed | 69 passed (72)
              30 tests failed | 1523 passed (1553)
```

Trajectory this session, each figure measured:

| point | files failing | tests failing |
|---|---|---|
| handover arrived (`ad0d49e`) | 5 | 48 |
| after my layout + ruler-guard fix | 4 | 37 |
| after I wired the shortcut glyphs — **I broke it** | 5 | 53 |
| after fixing my own breakage (`535f482`) | **3** | **30** |

The 53 was mine: wiring `ShortcutHint` into `Sidebar` and `HomeSurface` put a `useShortcutLabel`
call inside components whose own tests render them without a `KeyboardProvider`. Fixed by wrapping
the components under test — **not** by giving the hook a silent fallback, which would have turned a
loud misconfiguration into a badge quietly rendering the wrong modifier.

The remaining 30 are in three files and are analysed below.

---

## 2. The eleven-site ledger — closed, with two live exceptions

The ledger is a table at `docs/vela-progress.md:2759-2770`. Ten of the eleven textual corrections
landed in a **single** commit, `75efef4`, whose message is about CI and never mentions the sweep.
The new parity test landed in `e70fc65`; the mechanical guard in `85540e1`.

All eleven original sites read as corrected in the tree at `535f482` — verified site by site by a
reader that quoted each file and line. **That part is code-inspection only.**

### 2a. A TENTH claim is live and open, and it is red right now

`src-tauri/crates/vela-providers/src/private_fs.rs:167` names
`ipc::diagnostics::tests::the_log_stays_off_when_the_directory_cannot_be_made_private`.

I verified myself: that identifier appears **exactly once in the entire tree — in the claim itself**.
The test does not exist. `src/platform/claimed-guards.test.ts` catches it and is **failing right
now** (`1 failed | 6 passed`).

Worse than a wrong name: the seam it advertises has no consumer at all. `private_fs.rs` is **not
compiled** — there is no `mod private_fs` anywhere, and the string appears in zero `.rs` files. The
Windows enforcement it describes does not exist; `src-tauri/src/ipc/diagnostics.rs:183-186` is a bare
`create_dir_all` with no hardening and no failure path.

**It was introduced by the handover commit `ad0d49e`, seventeen hours after the guard that catches it
was written** (`85540e1`, 2026-08-13 20:30 → `ad0d49e`, 2026-08-14 12:28). `docs/HANDOVER.md:394`
admits the file is unrun code.

### 2b. Ledger #1's replacement guard cannot run on Windows

`chat-contract-parity.test.ts` — the test written specifically to make the ninth false enforcement
true — **errors on 28 of its 31 cases on this machine.** The cause is a CRLF bug I verified directly:

```ts
const lines = source.slice(at).split('\n').slice(1);
const end = lines.indexOf('}');            // never matches '}\r'
```

`model.rs` measures **798 CRLF and 0 bare LF** (`git config core.autocrlf` is `true`, no
`.gitattributes`). So every line ends `\r` and the terminator search can never succeed.

It fails **loudly** rather than passing green, which is the one mercy here — but the guarantee that
`contract.ts:277-283` advertises **does not execute on any Windows checkout**. That is a
false-enforcement claim in its own right, of exactly the shape the sweep was meant to end.

### 2c. The mechanical guard has two measured holes

`claimed-guards.test.ts:296`:

```js
const SENTENCE_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){3,}$/;
```

Four-or-more underscore-separated words required, so shorter names are never checked. I ran the
actual regex:

| name | checked? | note |
|---|---|---|
| `audit_closed_vocabulary` | **SKIPPED** | this is ledger **#2's own false name** |
| `into_parts` | **SKIPPED** | this is ledger **#3's** |
| `validate_sequence` | **SKIPPED** | |
| `every_variant_is_listed_in_all` | checked | |

**The guard built to generalise the eleven sites would have missed two of them.** Second hole
reported by the reader and not yet independently verified by me: path claims fall back to
basename-anywhere, so a claim with a correct filename under a fabricated directory resolves as true.

---

## 3. Desktop verdicts — current, with shas

| piece | critic | verdict | sha |
|---|---|---|---|
| GATE-M2 | real-model | **PASS** (supersedes an earlier FAIL) | `84c256f` |
| A3-keychain-settings | keychain-runtime | **PASS** | `9540d6c` |
| A1-scaffold-shell | visual | **PASS** on re-judge | `e7b56d6` |
| A1-scaffold-shell | **interaction** | **FAIL — still standing** | `4c01a60` |
| CONV-1 | visual | **PASS** on re-judge | `923e6da` wave |
| CONV-1 | interaction | **PASS** | |
| CONV-1 | performance | **PASS** | release build |

### The CONV-1 visual FAIL the brief asks about **is resolved.**

Its largest gap was the thinking block printing raw markdown at users
(`ThinkingBlock.tsx:64` emitting `<p>{text}</p>` with `white-space: pre-wrap`). Verified closed
against **real pixels and a live model**: the block now renders 17 `<strong>` and 74 `<li>` elements
with **zero literal `**`**, and a fresh-context visual critic re-judged the surface PASS. The literal
asterisks that remain on screen are the operator's own prompt text echoed in the user bubble, which
is correct.

### The A1 **interaction** FAIL is still open, and it is half closed

- **Closed and verified on WebView2:** focus restore. `CommandPalette.tsx:86,94` captures
  `document.activeElement` and calls `returnFocusTo`, and all four of the cloud's focus moments land
  on a named element rather than `<body>` (Escape recovers in 0 tabs against 11 pre-fix).
- **Open:** the palette declares `aria-modal="true"` and does not enforce it. There is still no
  `case 'Tab'` and no `inert`; 15 focusable elements stay reachable and Tab leaks in both directions.
  `DeleteConversationDialog` is a second instance of the same class.

---

## 4. Built and verified vs built and merely inspected

**Verified against a real running app or a measured artifact:**

- The app boots and renders on Windows/WebView2 (blank-window defect closed).
- A real streamed turn end to end against llama.cpp — 266 reasoning deltas, 3 text deltas, clean
  answer, correct reasoning/answer separation.
- Vision and tool calling through Vela's own IPC (correct ground-truth image answer; 6
  `toolCallDelta` events assembling `{"city":"Tel Aviv"}` with reasoning not leaking into tool parsing).
- Context overflow rejected pre-flight in 0.34s with typed `contextLengthExceeded`.
- Cancellation genuinely aborts upstream, verified against llama.cpp `/slots` going 1 → 0.
- Credentials in Windows Credential Manager, round-tripped, deleted, canary-scanned with controls
  both ways; `Auth::None` sends no `Authorization` header (full outbound header set captured).
- Window controls drive the real OS window (maximise/restore/minimise/close, icon tracks state).
- Typeface bundled — confirmed by a runtime width control against a deliberately absent font.
- Reading measure 63.8–71.8 characters across five window widths, counted by walking real
  line-break boundaries.
- Performance on the **release** build: 14.91 MB binary, 3106 ms cold start to rendered content,
  360.6 MB idle attributed to Vela's own process tree, 0.00% idle CPU.

**UNVERIFIED — inspection or unit tests only:**

- The eleven ledger corrections (read, not driven).
- `private_fs.rs` in its entirety — **never compiled**.
- Windows DACL hardening of the diagnostics directory — the finding I filed is **open**; a non-owner
  local group can read raw provider exchanges.
- Anything asserted by `chat-contract-parity.test.ts`, since it cannot run here.
- Model-agnosticism beyond the happy path. The mock matrix is the only evidence and I have not
  re-run it this session.

---

## 5. Repo hygiene

- Nothing unpushed. Local and remote both at `535f482`.
- One stash, deliberately: `killed-wave-1: no-provider-leak guard edit, UNGRADED — may weaken the
  allowlist`. It de-duplicates a regex that was written twice (so the self-test was proving against a
  stale twin) but also widens a `CARRIERS` allowlist. It is preserved, not applied, pending a critic.
- `private_fs.rs`: 36KB, orphaned, uncompiled, and carrying a live false claim. Decide: wire and
  enforce, or delete.

---

## 6. What this means for the wave order

The brief's Phase 3 fans out ten feature tracks. Two things should land first, because they are
guards on everything that follows:

1. **`chat-contract-parity` cannot run on Windows.** Until it does, contract drift between
   `model.rs` and `contract.ts` is unguarded on the only machine that builds the product.
2. **`claimed-guards` is red and has a hole that would have missed two of the eleven sites it
   generalises.** A guard with a known blind spot is worse than none, because it is cited as cover.

Both are small. Neither is a feature. Both are the difference between the next ten tracks being
verified and being asserted.
