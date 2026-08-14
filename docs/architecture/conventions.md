# Vela — Architecture & Conventions

**Status:** binding for all Phase A–H work.
**Owner:** Phase A scaffold.
**Audience:** every builder working in this repo.

This document is prescriptive, not advisory. Where it says "must", the tree has a test that
fails if you don't. Read §2, §3 and §4 before writing a line of code.

---

## 0. The five rules that outrank everything else

1. **Offline-first, no telemetry.** Nothing phones home. No analytics, no crash reporting, no
   "anonymous usage stats", not even behind a flag. Any outbound request must be one the user
   explicitly configured (their model endpoint) or explicitly triggered.
2. **"No API key" is a first-class provider state.** Most local runtimes have no auth at all.
   Absence of a credential is never an error, never a validation failure, never a warning
   badge. Encoded in `AuthPolicy` / `CredentialCheck` (`src-tauri/crates/vela-core/src/auth.rs`)
   and enforced by tests in both languages.
3. **No provider-specific detail may leak into UI code.** The UI branches on capability flags,
   never on a provider id. `if (provider.id === 'ollama')` is a review-blocking change. Adding
   a provider must require zero changes under `src/`.
4. **Secret values move in one direction only.** The renderer can write, delete and ask
   *whether* a credential exists. It can never read one. There is no `secrets_get` and there
   never will be; a `cargo test` asserts its absence.
5. **Never claim a fake verified something real.** Anything exercised only against
   `MemoryStore`, `BrowserAdapter`, or a mock endpoint is labelled **VERIFIED-BY-FAKE** in
   commit messages, docs and reports. See §10.

---

## 1. Folder layout

```
vela/
├── index.html                     Vite entry. Do not add script tags here.
├── package.json                   One package, no workspaces on the JS side.
├── vite.config.ts                 Vite + vitest config (single file, both jobs).
├── tsconfig.json                  Solution file → app + node projects.
├── tsconfig.app.json              Strict config for src/. Do NOT weaken these flags.
├── tsconfig.node.json             Config for vite.config.ts only.
│
├── src/                           ── THE RENDERER ──────────────────────────────
│   ├── main.tsx                   Mounts <App/>. Nothing else.
│   ├── app/
│   │   ├── App.tsx                Composition root: mounts PlatformProvider.
│   │   └── shell/                 Window chrome: TitleBar, AppShell, status bar.
│   │                              Layout only — the shell never imports a feature.
│   ├── platform/                  ── THE SEAM (§3). Read before touching. ──
│   │   ├── contract.ts            Typed command map + COMMAND_ALLOWLIST.
│   │   ├── adapter.ts             PlatformAdapter interface.
│   │   ├── tauri-adapter.ts       Real IPC. The ONLY file that may import @tauri-apps/api.
│   │   ├── browser-adapter.ts     In-memory fake host. Keep in step with Rust.
│   │   ├── errors.ts              PlatformError + normalisation.
│   │   ├── PlatformProvider.tsx   React context + usePlatform().
│   │   └── index.ts               createPlatformAdapter() runtime selection.
│   ├── features/                  ── ONE FOLDER PER VERTICAL SLICE (§2) ──
│   │   └── <feature>/             components, hooks, local types for that feature
│   ├── components/                Shared presentational primitives. No feature logic,
│   │                              no IPC, no provider knowledge. Reusable in isolation.
│   ├── data/                      Repositories: adapter in, domain shapes out. No React.
│   ├── state/                     zustand stores, one per domain: <domain>-store.ts.
│   ├── lib/                       Pure helpers. No imports from features/ or data/.
│   ├── styles/                    tokens.css (all design tokens) + base.css (reset).
│   └── test/setup.ts              vitest setup. jest-dom matchers, cleanup.
│
├── src-tauri/                     ── THE RUST CORE ─────────────────────────────
│   ├── Cargo.toml                 Workspace root + the thin `vela-app` host crate.
│   ├── tauri.conf.json            Window, CSP, bundle. decorations:false (custom titlebar).
│   ├── capabilities/main.json     Least-privilege permission grant. Justify every addition.
│   ├── icons/                     Vela's own mark. Generated, checked in.
│   ├── src/
│   │   ├── main.rs                Three lines. Leave it that way.
│   │   ├── lib.rs                 Builder + generate_handler! (the registration list).
│   │   ├── state.rs               AppState: trait objects only, so tests can fake them.
│   │   └── ipc/                   ── THE COMMAND LAYER (§3) ──
│   │       ├── mod.rs             COMMAND_ALLOWLIST, EmptyPayload, Ack, the pattern docs.
│   │       ├── error.rs           IpcError / IpcErrorCode — the only wire error shape.
│   │       ├── app.rs             app_* commands
│   │       ├── diagnostics.rs     diagnostics_* commands
│   │       └── secrets.rs         secrets_* commands
│   └── crates/                    ── DOMAIN LOGIC: no Tauri, no windows, no I/O ──
│       ├── vela-core/             Provider descriptors, auth policy, secret refs, errors.
│       ├── vela-secrets/          SecretStore trait + KeyringStore (real) + MemoryStore (fake).
│       ├── vela-settings/         Typed settings, provider configs, security posture.
│       │                          Joins vela-store (describable config) to
│       │                          vela-secrets (credential values). No secret on disk.
│       └── vela-providers/        THE PROVIDER CORE (§9). Provider trait, the one
│                                  request/response model, the one error taxonomy,
│                                  stream normalisation, reasoning separation, tool
│                                  emulation, capability probing, routing — and the
│                                  workspace's ONLY HTTP client.
│
└── docs/
    └── architecture/conventions.md   ← this file
```

### Where does my new code go?

| You are adding | It goes in |
|---|---|
| A new model backend (Ollama, vLLM, a hosted API) | `src-tauri/crates/vela-providers/src/<name>.rs` |
| Anything that talks HTTP to a model | Rust. **Never** the renderer. |
| A new screen or user-facing capability | `src/features/<feature>/` |
| A button/input/dialog reused by 2+ features | `src/components/` |
| A call to a host command | `src/data/<domain>-repository.ts`, called from a feature hook |
| Cross-component client state | `src/state/<domain>-store.ts` |
| A pure function with no dependencies | `src/lib/` |
| Persistence (conversations, messages) | Rust: `vela-store`, exposed via `store_*` commands |
| A user-configurable setting or provider field | `src-tauri/crates/vela-settings/`, exposed via `settings_*` commands. Never a second database. |
| A credential value | The OS keychain via `vela-secrets`. Never a settings row, never a log line. |
| A colour, radius, font size or spacing value | `src/styles/tokens.css`. Nowhere else. |

---

## 2. Naming and file conventions

**TypeScript**

- React component files: `PascalCase.tsx`, one primary component per file, named export
  (no `export default`).
- Everything else: `kebab-case.ts` — `host-repository.ts`, `use-host-status.ts`,
  `theme-store.ts`.
- Hooks: file `use-thing.ts`, export `useThing`.
- Styles: `ComponentName.module.css` beside the component. CSS Modules only — no global
  class names, no styled-components, no Tailwind.
- Tests: colocated, `<subject>.test.ts(x)` beside the file under test. No `__tests__/`
  directories, no separate test tree.
- Imports: use the `@/` alias for anything outside the current folder
  (`import { X } from '@/platform/contract'`). Relative imports only within a folder.
- Types: `import type { … }` always (`verbatimModuleSyntax` is on and will fail the build).

**Rust**

- Modules `snake_case`, types `PascalCase`, commands `<domain>_<verb>`.
- Unit tests in a `#[cfg(test)] mod tests` at the bottom of the file they test. Integration
  tests in `crates/<crate>/tests/`.
- Test names are sentences describing the rule being protected —
  `no_auth_endpoint_with_no_credential_is_a_success_state`, not "test_auth_1".
- One request struct and one response struct per command, both
  `#[serde(rename_all = "camelCase")]`.

**Both**

- Comments explain *why*, and especially why-not. Do not narrate what the code does.
- No `TODO` without an owner and a phase: `// TODO(phase-C, providers): …`.

---

## 3. The IPC bridge — the pattern

### 3.1 Signature

Every command, without exception:

```
<domain>_<verb>(payload: <Verb>Req) -> Result<<Verb>Res, IpcError>
```

- **Exactly one argument, always named `payload`.** The TS adapter invokes as
  `invoke(name, { payload })`. A Rust parameter with a different name silently receives
  `undefined`. There is no exception to this rule, and per this document's own preamble
  that sentence has to be backed by a test — it is:
  `src-tauri/tests/handler_binding.rs::every_command_takes_exactly_one_argument_and_it_is_named_payload`
  parses every `#[tauri::command]` in the host crate and rejects any other shape. Until
  that test existed the rule was stated three times and enforced nowhere.
- Commands with no input take `EmptyPayload` (`{}`); commands with no output return
  `Ack` (`{ ok: true }`). Never `()`, never a bare scalar.
- Wire fields are camelCase in both directions.
- **Registered in `COMMAND_ALLOWLIST` *and* in `generate_handler!`.** They are not the
  same list and only the second one ships: `generate_handler!` in `src-tauri/src/lib.rs`
  is the dispatch table the packaged binary consults, and the allowlist is the reviewed
  declaration of what that table is allowed to contain. `handler_binding.rs` builds the
  real app on the mock runtime and invokes every allowlisted name against the real
  handler, so drift in either direction fails `cargo test` instead of shipping.

Rust:

```rust
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct SecretsSetReq { pub provider_id: String, pub value: String }

// Logic: plain function, no Tauri types → unit-testable headlessly.
pub fn set(store: &dyn SecretStore, req: SecretsSetReq) -> IpcResult<Ack> { … }

// Command: a thin adapter. Nothing but extraction and delegation.
#[tauri::command]
pub fn secrets_set(state: State<'_, AppState>, payload: SecretsSetReq) -> IpcResult<Ack> {
    set(state.secrets.as_ref(), payload)
}
```

TypeScript:

```ts
export interface IpcContract {
  secrets_set: { req: SecretsSetReq; res: Ack };
}
const ack = await adapter.invoke('secrets_set', { providerId: 'acme', value });
```

### 3.2 Errors

One shape, always: `{ code: IpcErrorCode, message: string }`.

| Code | Meaning |
|---|---|
| `INVALID_PAYLOAD` | Malformed input or a violated domain invariant |
| `NOT_FOUND` | The addressed entity does not exist |
| `SECRET_STORE_UNAVAILABLE` | The keychain exists but refused us — **not** "no key stored" |
| `UNSUPPORTED` | Command exists, this build/platform cannot serve it |
| `INTERNAL` | Anything unexpected. Details logged host-side, never returned |
| `UNKNOWN_COMMAND` | Renderer-only: not on the allowlist; never reaches the host |
| `CONTRACT_MISMATCH` | Renderer-only: host speaks a different contract version |

The renderer switches on `code`. `message` is for logs and a fallback string; never parse it.
Rust panics, file paths and raw upstream response bodies must never reach the renderer.

### 3.3 Adding a command — the five-step checklist

1. `src/platform/contract.ts` — add req/res interfaces, an `IpcContract` entry, and the name
   in `COMMAND_ALLOWLIST` (keep it sorted).
2. `src-tauri/src/ipc/<domain>.rs` — add the pure function, its tests, and the
   `#[tauri::command]` wrapper.
3. `src-tauri/src/ipc/mod.rs` — add the name to the Rust `COMMAND_ALLOWLIST` (sorted).
4. `src-tauri/src/lib.rs` — register it in `generate_handler![…]`. **This list is the actual
   security boundary**; the allowlists are the readable mirror of it.
5. `src/platform/browser-adapter.ts` — implement it in the fake, matching the host's
   semantics *including its failure modes*.

Skip any step and the tree fails: `cargo test` diffs the two allowlists by reading
`contract.ts` from disk, `pnpm test` checks the TS allowlist against the contract keys, and
the `BrowserAdapter` switch is exhaustive over `CommandName`, so TypeScript rejects a missing
case.

### 3.4 Least privilege

`src-tauri/capabilities/main.json` grants the renderer the event channel and five window-chrome
permissions. That is all. No `fs`, no `shell`, no `http`, no `process`, no `dialog`, and the
asset protocol is disabled. Any new permission needs a one-line justification in the
capability file's `description` and a note in the PR. Prefer adding a narrow command over
widening a capability: a command you wrote is auditable, a capability is a blanket grant.

CSP is set in `tauri.conf.json` and is strict: `default-src 'self'`, no remote origins,
`object-src 'none'`, `frame-ancestors 'none'`. Nothing may be loaded from a CDN — bundle it.

---

## 4. The platform adapter seam — why the frontend must never import Tauri

`src/platform/adapter.ts` defines `PlatformAdapter`. Two implementations:

| Implementation | Used when | What it proves |
|---|---|---|
| `TauriAdapter` | `__TAURI_INTERNALS__` present | Real IPC to the Rust host |
| `BrowserAdapter` | everything else (`pnpm dev`, vitest, headless render) | UI behaviour, protocol shape — **and nothing else** |

Selection is runtime, not build-time (`createPlatformAdapter()`), so the identical bundle runs
in both places. That is what makes a headless screenshot honest: the code being rendered is the
code that ships.

**The rule:** nothing under `src/` may import `@tauri-apps/api` except
`src/platform/tauri-adapter.ts`. `src/platform/adapter.test.ts` scans every `.ts`/`.tsx` file
in `src/` (comments stripped) and fails if a second importer appears. Components get their
adapter from `usePlatform()`; non-React code takes one as an argument. Never a module
singleton — tests need to substitute it.

When you add a command to `BrowserAdapter`, mirror the host's *failure* behaviour too, not
just the happy path. A fake that only succeeds teaches the UI nothing.

---

## 5. State management

**zustand.** Settled. Do not introduce Redux, MobX, Jotai, Recoil, or a second context store.

- One store per domain: `src/state/<domain>-store.ts`, exporting `use<Domain>Store`.
- Stores hold state and actions. **No IPC inside a store** — call a repository from
  `src/data/`, then set the result.
- Components select the narrowest slice they need
  (`useThemeStore((s) => s.preference)`), so unrelated updates don't re-render them.
- Server/host data that is fetched-and-cached belongs in a hook beside its feature, not in a
  global store, unless two features genuinely share it.
- Local, single-component state stays in `useState`.

---

## 6. The data layer

`src/data/<domain>-repository.ts` exports `create<Domain>Repository(adapter)`.

- Plain factory closing over a `PlatformAdapter`. No React, no hooks, no component imports.
- May reshape host responses into domain types; may never invent data the host did not send.
- Errors propagate as `PlatformError`. Do not swallow them into `null` or `undefined`.
- This is where features get their cheapest tests: pass a `BrowserAdapter` and the whole
  repository is under test with no DOM.

Feature hooks (`use-*.ts`, beside the feature) call repositories and model loading/error as an
explicit union — `{ state: 'loading' } | { state: 'ready', … } | { state: 'error', … }` —
never `undefined` doing double duty.

---

## 7. Styling and visual identity

- All design tokens live in `src/styles/tokens.css`. A hex code, a `px` radius, or a bare font
  stack inside a component file is a review-blocking change. Add a token instead.
- **This is enforced, not asked for.** `src/styles/design-system.test.ts` scans every
  `*.module.css` and fails on a raw colour, type size, radius, font stack, shadow, transition
  duration, line height, letter spacing, focus outline or `z-index`. It also fails on a
  `var(--vela-…)` the token sheet does not define — CSS drops an unresolvable declaration
  silently, so nothing else would ever notice.
- **The scales, and the question each one settles.** Phase C had four builders on one surface,
  and each answered the same questions privately: line height landed on six values for
  overlapping jobs, a bare icon button on five sizes, the focus ring's offset on four. Every one
  of those files was internally consistent, which is why only a check from above found it. Ask a
  question once:

  | Question | Scale |
  |---|---|
  | How tall is a line? | `--vela-leading-{none,tight,snug,ui,code,prose}` |
  | How is the text tracked? | `--vela-tracking-{tight,label,code,caps,wordmark}` |
  | How big is a square control? | `--vela-control-{xs,sm,md}` |
  | How is focus drawn? | `--vela-focus-ring`, offset `--vela-focus-offset` or `-inset` |
  | What is on top of what? | `--vela-z-{overlay,popover,dialog,palette}` |
  | How wide is an overlay? | `--vela-overlay-{sm,md}` |

  Adding a step to a scale is fine. Answering the question again inside a component is the
  review-blocking change.
- The focus ring has exactly **two** offsets: outside a control (`--vela-focus-offset`), or
  inset on a full-bleed row whose outward ring the scroll container would clip
  (`--vela-focus-offset-inset`). A third value is drift, and a ring that changes width between
  two controls in one toolbar reads to a user as a rendering bug.
- Theming: light values are defined on bare `:root`; dark is redefined twice — under
  `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme='light'])`, and under
  `:root[data-theme='dark']` so an explicit choice wins in both directions. **Never define a
  colour only inside a dark block.**
- CSS Modules only, colocated as `Component.module.css`.
- One transition duration and one easing curve (`--vela-duration`, `--vela-ease`).
  `prefers-reduced-motion` is honoured globally in `base.css`.
- **Identity:** Vela is the constellation of the Sails — night-sky indigo, a cyan-teal signal
  accent, an amber highlight, and its own sail-and-stars mark (`src/components/VelaMark.tsx`,
  `src-tauri/icons/`). Vela must not borrow another assistant product's trade dress: no
  clay/terracotta orange, no cream paper tone, no imitation of anyone else's marks or naming.

---

## 8. Testing

| Layer | Tool | Location | Command |
|---|---|---|---|
| Rust domain + IPC | `cargo test` | `#[cfg(test)] mod tests` in-file | `cd src-tauri && cargo test --workspace` |
| Rust integration | `cargo test` | `crates/<crate>/tests/` | same |
| TS units, repositories, components | vitest + jsdom + Testing Library | colocated `*.test.ts(x)` | `pnpm test` |
| Types | `tsc --build` | — | `pnpm typecheck` |

`pnpm verify` runs the whole gate in one shot: typecheck → rustfmt → clippy → vitest →
harness → frontend build → transcript reproducibility → secret tripwire → `cargo build` →
`cargo test`, the last two with `--locked`. Run it before every commit.

**It is a superset of CI, and that is asserted, not maintained by hand.** It used to be
narrower — no `pnpm build`, no `cargo build`, no `--locked`, and the transcript check existed
only as an inline block in `ci.yml` that nobody could run locally. Three Phase B builders each
finished green and each shipped something CI caught. `src/platform/verify-covers-ci.test.ts`
now fails if a gate command appears in the workflow but is unreachable from `verify`, in either
direction. Add a CI step and you must add it here too.

Rules:

- Every command gets a Rust test for its happy path **and** its rejection path.
- Every `BrowserAdapter` command gets a vitest test mirroring the Rust one. When they disagree,
  the fake is wrong.
- **A rule the fake reimplements is pinned by a shared fixture, not by prose.** `tests/parity/`
  holds JSON tables of `(input) -> (expected output)` read from disk by *both* `cargo test` and
  `pnpm test`; see `tests/parity/README.md`. `adapter-parity.json` covers the whole
  `settings_put_provider` derivation — endpoint parsing and normalisation, network scope, the
  security posture, the auth binding, the credential check, and every rejection path including
  which field is blamed first. Add a row rather than a second pair of hand-written assertions:
  a row is picked up by both languages automatically. The Rust host is the specification — never
  edit an expectation to make one side go green.
- Components are tested through `render(<App adapter={new BrowserAdapter()} />)` or by
  wrapping the subject in `<PlatformProvider adapter={fake}>`. Never mock `@tauri-apps/api`.
- Query by role and accessible name first; `data-testid` only for values with no accessible
  identity (e.g. a diagnostics readout).
- No network in tests. No sleeping; use `findBy*` and fake clocks
  (`new BrowserAdapter({ now: () => 42 })`).

---

## 9. Adding a provider (the shape adapter builders build against)

`vela-providers` is the provider **core**: one normalisation layer, one error
taxonomy, one event stream. An adapter is a thin thing on top of it. Read
`crates/vela-providers/src/lib.rs` — it carries the full map — then:

1. New module in `src-tauri/crates/vela-providers/src/`.
2. Implement `Provider`: `descriptor()`, `list_models()`, `probe_capabilities()`,
   `stream()`. `complete()` is defaulted on top of `stream()`, so the streamed
   and non-streamed answers to the same request cannot diverge; override it only
   when the backend has a genuinely separate non-streaming API.
3. Declare an `AuthPolicy`. No auth is `AuthPolicy::none()` — a supported
   configuration, not a gap. Optional auth is `AuthPolicy::optional(...)` and
   **both** states must work. Never touch the keychain: take a
   `&dyn SecretStore` and let `vela_secrets::resolve_auth` build the header, so
   "no credential" means *no header* rather than an empty one.
4. Start at `ModelCapabilities::unknown()`. Raise a flag only on probe evidence,
   never on assumption — and remember `Unknown` is not offerable, because
   offering an affordance the endpoint cannot serve is a gate failure.
5. Return only `ProviderError`s. An HTTP status, a vendor error string or a
   `finish_reason` escaping this crate is a review-blocking change.
6. Degrade deliberately, and *report* it: every reduction produces a
   `Degradation` on the response. No native tools → prompt emulation. Short
   context → explicit reduction with a note in the prompt, never a silent
   truncation. No structured output → refuse the affordance or validate the
   answer and report the mismatch. Silently wrong output is the one forbidden
   outcome.
7. Export nothing backend-specific. If the UI needs to know something, it
   becomes a capability flag on `ProviderCapabilities`.
8. All HTTP goes through the `HttpTransport` seam. Adapter tests script bytes
   with `http::testing::{ScriptedTransport, ScriptedBody, StalledBody}`; results
   from those are **VERIFIED-BY-FAKE**.
9. **Read a response body only through `BodyStream::next_chunk`.** It is the one
   exit bytes have, and it is where this crate's credential redaction happens —
   a body cannot be constructed without a `BodyOrigin` stating what request it
   answers, and `ByteStream` deliberately has no `scrubber()` to forward or
   forget. If you write a decorating body, wrap a `BodyStream` and read through
   it; the bytes you see are already clean. This is not style: redaction used to
   hang off an overridable trait method defaulting to no protection, the
   streaming path never called it, and a credential reached the IPC bridge
   (GATE M Part 1, Phase B, FINDING 2). Errors derived from a request carry
   `BodyOrigin::endpoint()` — the **redacted** URL — because a user with three
   configured candidates has to be told which one failed. Redaction removes the
   secret, not the diagnosis.

Every degradation path needs an asserting test against the mock profile that
triggers it — see `crates/vela-providers/tests/mock_matrix_live.rs`, which runs
the whole stack against all four live profiles, and
`docs/regression-baseline/phase-b/PROVIDER-CORE.md` for the evidence and its
controls.

## 10. Honesty rules for reports and commits

This repo is built and verified on a headless Linux container. Three things genuinely cannot be
exercised here, and must never be described as if they were:

- **The OS keychain.** `KeyringStore` compiles but is never run. Anything demonstrated with
  `MemoryStore` is **VERIFIED-BY-FAKE**.
- **A real model endpoint.** Any capability matrix produced against mocks is a mock result.
- **The packaged desktop binary.** See §11 — the bundle does not build here. Cold-start and
  idle-RAM figures measured in a browser are browser figures, not Tauri-binary figures.

`app_info.secretBackend` reports which store is actually live (`os-keychain` vs `memory-fake`),
and the placeholder screen prints it, so a screenshot can never be mistaken for evidence about
a real keychain. Keep that property when you replace the placeholder.

---

## 11. What does and does not build headlessly

| Command | Status here |
|---|---|
| `pnpm install`, `pnpm typecheck`, `pnpm build`, `pnpm test` | ✅ works |
| `pnpm dev` (browser, `BrowserAdapter`) | ✅ works — serves on `127.0.0.1:1420`, renders in headless Chromium with no console errors |
| `cargo build`, `cargo test` (workspace) | ✅ works |
| `pnpm tauri build --no-bundle` | ✅ works — produces `src-tauri/target/release/vela` (~10.9 MB, keyring linked) |
| **Running** that binary | ❌ panics at `gtk::rt::init` — no display server. Expected and correct. |
| `pnpm tauri build` (with bundling: deb/AppImage/dmg/msi) | ⚠️ **not attempted** — needs the platform bundler toolchain |
| `pnpm tauri dev` | ❌ needs a display server |

The Rust workspace — including the `tauri` crate — compiles because the container has
`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`,
`libjavascriptcoregtk-4.1-dev`, `librsvg2-dev` and `patchelf` installed. Those are **not**
in the base image; a fresh container needs:

```
apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev librsvg2-dev patchelf libayatana-appindicator3-dev
```

The release binary compiles and links — including the real `keyring` backend — but it cannot
be *run*: `tao` panics initialising GTK because there is no display server. Producing an
installable bundle additionally needs the platform bundler toolchain, which was not attempted.

**Therefore: no claim about the running application — startup time, idle memory, window
chrome, OS notifications, keychain round-trips — may be made from this environment.** "It
compiles" is the strongest honest statement available here about the desktop shell.
