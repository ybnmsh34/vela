# Audit — Build, packaging and developer experience

Auditor: independent domain auditor (1 of 12), running against
`C:\Users\User\vela-tmp`, branch `claude/new-session-tgl1ut`, HEAD `a1fa55e`
("Run CI on the platform Vela ships on").

Everything below was run on the machine Vela ships on: Windows 11, Node
v24.15.0, pnpm 10.33.0, `git config core.autocrlf = true`. No tracked file was
modified; the two places where mutation was necessary are described, and both
were reverted and confirmed clean.

---

## Headline

**`pnpm verify` cannot complete on Windows.** It is documented in `README.md` as
"the full gate, and a superset of CI — run before every commit" and in
`docs/architecture/conventions.md` §10 as "a superset of CI, and that is
asserted, not maintained by hand". The assertion that exists
(`src/platform/verify-covers-ci.test.ts`) is a *string containment* check over
`package.json` and `ci.yml`. It says nothing about whether the chain runs, and
on Windows the chain fails at step 4 of 9 and again at steps 6 and 7 — so it
never reaches `cargo build --workspace --locked` or `cargo test --workspace
--locked` at all.

The second finding is that the line-ending repair landed at HEAD is incomplete.
`.gitattributes` protects `*.sse` and `*.jsonl`. The mock-matrix wire captures
are 48 `.json` files, and they are being translated on checkout — which is
exactly the defect the file was written to stop, in the same directory the file's
own comment names.

---

## 1. Does `pnpm verify` run?

The chain, from `package.json`:

```
verify = pnpm typecheck && pnpm lint:rust && pnpm test && pnpm test:harness
      && pnpm build && pnpm test:transcripts && pnpm test:secrets
      && cd src-tauri && cargo build --workspace --locked
      && cargo test --workspace --locked
```

### 1a. Step 4 — `pnpm test:harness` fails on Windows

```
$ pnpm run test:harness
 FAIL  src/record-transcripts.test.ts > the committed mock-matrix transcripts
       > still match what the harness produces today, byte for byte
AssertionError: frontier/01-health.json is stale — re-run record-transcripts.ts:
  expected '{\n  "status": "ok",\n  "slots_idle":…'
  to be     '{\r\n  "status": "ok",\r\n  "slots_id…'

 FAIL  src/server.test.ts > a request body over the 8 MiB cap
       > still answers a body that reaches the drain cap, then closes the connection
TypeError: fetch failed
Caused by: Error: read ECONNRESET
Serialized Error: { errno: -4077, code: 'ECONNRESET', syscall: 'read' }

 Test Files  2 failed | 10 passed (12)
      Tests  2 failed | 140 passed (142)
 ELIFECYCLE  Command failed with exit code 1.
```

Run twice, same two failures both times. Neither is flake.

Failure 1 is line endings. Failure 2 is a genuine platform difference: Winsock
resets a connection that is closed with unread data in the receive buffer, where
Linux delivers a graceful close, so the client sees `ECONNRESET` instead of a
response.

`pnpm test:harness` is a CI gate — `GATE M Part 1 — mock capability matrix` in
the `test-ts` job. That job runs on `ubuntu-latest`. **The `test-windows` job
does not run it.** So CI is green on both platforms while the gate is red on the
platform the product ships on.

### 1b. Steps 6 and 7 — `pnpm` cannot invoke a `.sh` script on Windows

```
$ pnpm run test:transcripts
> vela@0.1.0 test:transcripts C:\Users\User\vela-tmp
> ./scripts/check-transcripts.sh

'.' is not recognized as an internal or external command,
operable program or batch file.
 ELIFECYCLE  Command failed with exit code 1.

$ pnpm run test:transcripts > /dev/null 2>&1; echo $?
1
```

```
$ pnpm run test:secrets
> vela@0.1.0 test:secrets C:\Users\User\vela-tmp
> ./scripts/secret-scan.test.sh && ./scripts/secret-scan.sh

'.' is not recognized as an internal or external command,
operable program or batch file.
 ELIFECYCLE  Command failed with exit code 1.
```

pnpm runs lifecycle scripts through `cmd.exe` on Windows and there is no
`script-shell` setting in `.npmrc` (it contains only
`strict-peer-dependencies=false` and `auto-install-peers=true`). Three of the
nine links in `verify` are `./scripts/*.sh` invocations —
`test:transcripts`, and both halves of `test:secrets`.

The scripts themselves are fine. Run under bash they work:

```
$ bash scripts/check-transcripts.sh
check-transcripts: docs/regression-baseline/mock-matrix is byte-identical after regeneration.
(exit 0)
```

The fix is one line (`script-shell` in `.npmrc`, or `bash ./scripts/…` in the
script bodies), but until it lands, a Windows contributor following `README.md`
gets `'.' is not recognized` with no indication that a POSIX shell was expected.

### 1c. Consequence — the Rust gate is unreachable locally on Windows

`&&` short-circuits. `verify` dies at step 4, so `cargo build --workspace
--locked` and `cargo test --workspace --locked` — the last two links, and the
whole Rust half of the gate — are never executed by anyone running the
documented command on Windows.

### 1d. Side effect worth knowing about

Running `bash scripts/check-transcripts.sh` regenerates the captures with LF and
leaves 49 tracked files rewritten in the working tree (CRLF → LF). `git diff`
normalises them back through the clean filter, so the script correctly reports
"byte-identical" and `git diff --quiet` exits 0 — but `git status --porcelain`
lists them as modified until `git checkout --` restores them. I did this once,
observed it, and restored:

```
$ git checkout -- docs/regression-baseline
$ git status --porcelain -- docs/regression-baseline
(empty)
```

Note the disagreement this produces: `scripts/check-transcripts.sh` **passes**
on Windows (it compares through git, which normalises), while
`record-transcripts.test.ts` **fails** on Windows (it compares raw bytes with
`readFileSync`). Two checks over the same evidence, opposite verdicts, same
machine. Which one you get also depends on the order you ran them in.

---

## 2. Does `verify-covers-ci.test.ts` bite?

This is the test that claims `pnpm verify` covers CI. I reproduced it outside the
shared worktree so I could mutate its inputs without touching tracked files:
`package.json`, `.github/workflows/ci.yml` and the test file copied to a
scratch directory, `node_modules` junctioned in, a minimal node-environment
vitest config. Baseline there matches the repo: **13 passed**. It also passes in
the repo itself:

```
$ pnpm exec vitest run src/platform/bundle-icons.test.ts src/platform/verify-covers-ci.test.ts
 ✓ src/platform/verify-covers-ci.test.ts (13 tests) 6ms
 ✓ src/platform/bundle-icons.test.ts (10 tests) 9ms
 Test Files  2 passed (2)
      Tests  23 passed (23)
```

One trap for anyone repeating this: `ci.yml` is CRLF in a Windows checkout (265
CRLF, 265 LF — every line). My first two mutations used `\n` anchors, silently
did not apply, and produced a false "the guard is blind" reading. The mutation
driver was corrected to `\r?\n` and re-run; the results below are from the
corrected run, with every mutation asserting that it actually changed the file.

| # | Mutation | Result |
|---|---|---|
| M1 | Remove `pnpm build` from the `verify` chain | **FAILS** — `ci.yml runs "pnpm build" but "pnpm verify" does not.` |
| M2 | Add a new single-line CI gate: `- name: New gate` / `run: pnpm lint:css` | **FAILS** — `a new CI step appeared … expected [ 'pnpm lint:css' ] to deeply equal []` |
| M3 | Add the same new gate as a block: `run: \|` / `pnpm lint:css` / `pnpm audit --prod` | **PASSES — blind** |
| M4 | New cargo job on `runs-on: freebsd-14` | **FAILS** — `runs cargo on "freebsd-14", which this guard cannot reason about` |
| M5 | New cargo job on `ubuntu-latest` with no apt step | **FAILS** — `runs cargo on Linux but never installs the Tauri system dependencies` |
| M7 | Add a new CI gate `run: pnpm test:e2e` | **PASSES — blind** |

So four of six bite, and the two that do not are the two that matter most.

**M3 — multi-line `run:` blocks are invisible.** The reverse-direction check
harvests gate commands with `/^[ \t]*-?[ \t]*run: (.+)$/gm` and drops lines equal
to `|`. The *body* of a `run: |` block never starts with `run:`, so it is never
harvested. A whole new gate added in block form — the form `ci.yml` already uses
for its apt steps, so it is idiomatic in this very file — is not seen at all.

**M7 — substring matching swallows sibling scripts.** "Accounted for" is
`line.includes(ci)`. `'pnpm test:e2e'.includes('pnpm test')` is `true`, so the
new gate is silently attributed to the existing `pnpm test` entry, and there is
no forward-direction entry demanding that `verify` run it. Any future
`pnpm test:integration`, `pnpm build:docs`, `pnpm typecheck:strict` escapes the
same way. This is precisely the failure the file's own header says it exists to
prevent.

Both holes are cheap to close: harvest block-scalar bodies, and match gate lines
by tokenised equality rather than `includes`.

**What the guard cannot do at all, by construction:** it compares strings. `verify`
containing the text `./scripts/check-transcripts.sh` satisfies it. Whether that
text can execute on the developer's machine is outside its universe — which is
how §1 stayed invisible.

---

## 3. Is the shipped capability set minimal?

The claim, from `src-tauri/src/lib.rs:9`:

> Tauri capabilities (`capabilities/main.json`) grant nothing beyond window
> chrome and the event channel: no `fs`, no `shell`, no `http`, no `process`.

`src-tauri/capabilities/main.json` grants six permissions: `core:event:default`,
and `core:window:allow-{start-dragging,minimize,toggle-maximize,is-maximized,close}`.

That is the source. I checked the artifact. The resolved ACL is embedded in the
binary at build time, so its command keys are recoverable from the compiled
`vela.exe` (`src-tauri/target/release/vela.exe`, 15,638,528 bytes, built
2026-08-13 17:09):

```
$ grep -a -o -E 'plugin:[a-z]+\|[a-z_]+' src-tauri/target/release/vela.exe | sort | uniq -c
      1 plugin:event|emitplugin
      1 plugin:event|listenplugin
      1 plugin:window|closeplugin
      1 plugin:window|internal_toggle_maximize
      1 plugin:window|minimizeplugin
      1 plugin:window|toggle_maximize
```

(the trailing `plugin` is the next key running on in the string table)

Targeted probes for what is *not* there:

```
plugin:window|close             => 1
plugin:window|minimize          => 1
plugin:event|listen             => 1
plugin:window|set_always_on_top => 0
plugin:path|resolve             => 0
plugin:fs|read_file             => 0
plugin:shell|execute            => 0
plugin:http|fetch               => 0
plugin:process|exit             => 0
plugin:webview|create_webview   => 0
```

The debug binary additionally carries `plugin:webview|internal_toggle_devtools`;
the release binary does not. That is correct and worth noting as a positive.

The claim also holds one level below the ACL. `src-tauri/Cargo.lock` contains no
`tauri-plugin-*` crate of any kind — only `tauri`, `tauri-build`,
`tauri-codegen`, `tauri-macros`, `tauri-runtime`, `tauri-runtime-wry`,
`tauri-utils`, `tauri-winres`. And `src-tauri/gen/schemas/acl-manifests.json`
contains exactly ten manifests, all `core:*`:

```
core, core:app, core:event, core:image, core:menu,
core:path, core:resources, core:tray, core:webview, core:window
```

There is no `fs`, `shell`, `http` or `process` manifest to grant a permission
*from*. The claim is true, and true structurally rather than by discipline.
`assetProtocol` is `{"enable": false, "scope": []}`; `withGlobalTauri` is
`false`; `freezePrototype` is `true`.

**But nothing guards it.** `capabilities/main.json` is named in eight prose
comments —
`src-tauri/src/lib.rs:9`, `src-tauri/src/ipc/mod.rs:6`,
`src/app/shell/use-window-controls.ts:7`, `src/platform/adapter.ts:73`,
`src/platform/contract-project.ts:530` and `:638`,
`src/platform/tauri-adapter.ts:38`, `src/platform/window-seam.test.ts:4` — and
read by **zero** tests. `window-seam.test.ts` mentions the grant in its header
and then asserts only that `TauriAdapter` reaches the real window object; it
never opens the file. Adding `core:fs:default` (once an fs plugin existed) or
`core:webview:allow-print` to that list fails nothing, anywhere. Given this
repo's stated central defect class, an eight-site prose claim with no mechanical
check is the exact shape that has bitten before. It happens to be true today.

---

## 4. The bundle identifier

`identifier: "dev.vela.desktop"` in `tauri.conf.json`, and hard-coded again as
`KEYCHAIN_SERVICE` in `src-tauri/crates/vela-secrets/src/lib.rs:47`.

`src-tauri/src/store_host.rs` resolves the database from
`app.path().app_data_dir()`, which Tauri defines as `%APPDATA%\<identifier>` on
Windows. Everything else hangs off the same root:
`vela-projects/src/layout.rs` puts `projects/` and `skills/` there,
`vela-providers/src/debuglog.rs` and `ipc/diagnostics.rs` put
`diagnostics/exchanges.jsonl` there. WebView2 puts its profile in
`%APPDATA%\dev.vela.desktop\EBWebView`.

So two running Velas share: one SQLite file, one projects tree, one skills
store, one diagnostics log, one keychain service name, and one WebView2 profile.

There is no mitigation in the tree. No `tauri-plugin-single-instance` (no plugin
crates at all, per §3). No named mutex, no lock file: a search for
`single.instance|CreateMutex|already running|second instance` across
`src-tauri/src`, `src-tauri/crates` and `src` returns one hit, and it is an
unrelated comment in `vela-store/src/scheduler.rs:13`. Nothing sets
`WEBVIEW2_USER_DATA_FOLDER`.

The hazard is already on the record inside the repo.
`docs/desktop-gate/VERDICTS.md:1414`:

> …relaunched with a private `WEBVIEW2_USER_DATA_FOLDER`, confirming through the
> webview's own `--user-data-dir` that it was not sharing the shared
> `dev.vela.desktop\EBWebView` profile. Both hazards are now on the record:
> **check the binary is newer than the sources before you believe a pixel, and
> give every instance its own profile.**

That is a note to the operator, not a change to the product. The instruction
"give every instance its own profile" is carried out by hand, per launch, by
whoever remembers. It has cost this session twice. A single-instance guard, or an
identifier suffix in dev builds, or a `WEBVIEW2_USER_DATA_FOLDER` set in `setup`,
would each close it; none is present.

---

## 5. Reproducibility of the build

**JavaScript side: pinned.** `pnpm-lock.yaml` is committed and CI uses
`--frozen-lockfile`. I checked the lockfile is actually in sync, in a scratch
copy so the shared `node_modules` was untouched:

```
$ pnpm install --frozen-lockfile --lockfile-only
Done in 435ms using pnpm v10.33.0
$ node -e "…normalise EOL and compare…"
identical after EOL normalisation: true
scratch len 70502 repo len 70502
```

(the raw files differ only because the working-tree copy is CRLF)

**Rust side: not pinned.** There is no `rust-toolchain.toml` anywhere in the
tree. `Cargo.toml` sets `rust-version = "1.82"`, which is a floor, not a pin. CI
uses `dtolnay/rust-toolchain@stable`, which floats with the calendar. `Cargo.lock`
is committed and `--locked` is used, so *dependency* versions are pinned; the
compiler is not. Two builds a month apart are two different compilers.

**Bundling: never done, and not hermetic.** `bundle.active` is `true` and
`bundle.targets` is `"all"`, which on Windows means WiX (MSI) and NSIS. Both
toolchains are downloaded from the internet by the Tauri CLI at build time — a
network dependency in the build of a product whose first line of description is
"offline-first". No bundle has ever been produced here:

```
$ ls src-tauri/target/release/bundle
NO BUNDLE DIR
$ ls -la src-tauri/target/release/wix
drwxr-xr-x  x64      (empty)
```

`wix/x64` is where the CLI unpacks WiX 3.14; it exists and is empty, so a
`pnpm tauri build` was started on 2026-08-13 and did not get through the bundler.
`docs/architecture/conventions.md` §11 is honest about this — it lists
`pnpm tauri build` (with bundling) as "⚠️ **not attempted**". There is also no
code-signing configuration and no updater configuration, so even a successful
bundle would produce an unsigned installer that Windows SmartScreen will warn on.

**The frontend bundle does build, on Windows:**

```
$ pnpm run build
> tsc --build --force && vite build
vite v7.3.6 building client environment for production...
✓ 191 modules transformed.
dist/index.html                     0.46 kB │ gzip: 0.28 kB
dist/assets/index-B1Da_iwg.css     80.29 kB │ gzip: 12.04 kB
dist/assets/index-798-plae.js     400.63 kB │ gzip: 128.19 kB
… four self-hosted woff2 files …
✓ built in 5.50s
```

and the output is CSP-clean against the policy in `tauri.conf.json`: zero inline
`<script>` in `dist/index.html` (it emits `<script type="module" src=…>`), and
the Inter/JetBrains Mono faces are emitted as local `.woff2` assets rather than
fetched from a CDN, which is what `script-src 'self'` and `font-src 'self' data:`
require.

---

## 6. `.gitattributes` does not cover the evidence it names

`.gitattributes` at HEAD protects two patterns:

```
*.sse -text
*.jsonl -text
```

Its comment says the same argument covers "the recorded transcripts under
`docs/regression-baseline/`, which `scripts/check-transcripts.sh` compares byte
for byte".

Extensions actually present under `docs/regression-baseline/mock-matrix/`:

```
     48 json
     43 txt
     12 sse
      2 md
      1 tsv
```

**Zero `.jsonl`.** The 48 files `record-transcripts.ts` writes as raw socket
bytes are `.json`, which is not covered, so `core.autocrlf=true` translates them
on checkout:

```
docs/regression-baseline/mock-matrix/frontier/01-health.json CRLF= 8 LF= 8
```

That is the direct cause of failure 1 in §1a. The `.jsonl` rule does protect six
real files (five under `docs/regression-baseline/local-smoke/`, one under
`docs/desktop-gate/evidence/`), so it is not dead — it is just aimed at a
different directory than the one its comment describes. Adding `*.json` under
`docs/regression-baseline/` (and `*.txt`, `*.tsv` if those captures are also
byte-exact) finishes the repair that HEAD started.

---

## 7. CI shape

Five jobs. `static` (ubuntu) → `test-ts` (ubuntu), `test-rust` (ubuntu),
`test-windows` (windows); `secret-tripwire` (ubuntu) standalone. Draft PRs skip
everything, because `static` carries the draft `if:` and the three test jobs
`needs: static`.

The `test-windows` job added at HEAD runs: `pnpm typecheck`, `pnpm test`,
`cargo build --workspace --locked`, `cargo test --workspace --locked`,
`./scripts/check-transcripts.sh` (with `shell: bash`, correctly).

It does **not** run `pnpm test:harness` or `pnpm build`. `pnpm test:harness` is
the gate that fails on Windows (§1a). So the job whose entire purpose is stated
as "make a green run mean something on the platform users have" omits the one
gate that is currently red there.

`shell: bash` on the transcripts step is the right call and shows the author knew
about the shell problem in CI. The same knowledge did not reach `package.json`,
where the same script is invoked without a shell override (§1b).

Two guards in `verify-covers-ci.test.ts` do genuinely protect CI's shape, and I
watched both fail: an unknown runner name is rejected rather than assumed (M4),
and a Linux cargo job without the webkit/gtk apt step is rejected (M5). Those are
good, and they are non-vacuous.

---

## 8. New-contributor experience

`README.md` prescribes:

```
pnpm install
pnpm dev
pnpm verify              # the full gate, and a superset of CI — run before every commit
pnpm tauri dev
```

On Windows, the third command fails with two vitest assertion failures followed
(if you fix those) by `'.' is not recognized as an internal or external command`.
Nothing in the README says a POSIX shell is needed.

Other rough edges found by reading:

- `engines.node` is `">=20.19"`. The mock-provider harness is unbuilt TypeScript
  run directly by `node` — `tests/harness/mock-provider/src/cli.ts:6` says "Node
  22 strips TypeScript types natively", `ci.yml:132` pins `node-version: 22` for
  exactly this reason, and `vela-providers/tests/mock_matrix_live.rs:60-63`
  spawns `node …/cli.ts` from a Rust test. A contributor on Node 20.19 satisfies
  `engines`, installs cleanly, and then gets an unexplained failure in
  `cargo test -p vela-providers` and from `pnpm mock-provider`. The declared floor
  is wrong by two majors for the tree as it stands.
- `vite.config.ts` binds the dev server to `host: '127.0.0.1'` while
  `tauri.conf.json` sets `devUrl: "http://localhost:1420"`. On Windows
  `localhost` may resolve to `::1` first. I could not test this (launching the
  app is another auditor's remit), so it is flagged, not graded.
- `README.md`'s Linux package list names `libayatana-appindicator3-dev`;
  `ci.yml` installs `libappindicator3-dev`. One of the two is stale.
- `docs/architecture/conventions.md` §1 describes `tsconfig.json` as a solution
  file over "app + node projects". It actually references four:
  `tsconfig.app.json`, `tsconfig.node.json`, `tsconfig.harness.json`,
  `tsconfig.uibridge.json`.

---

## 9. Things that are simply right

Worth stating plainly, because a report of only defects is not a fair account.

- **`src/platform/bundle-icons.test.ts`** is a model of what the rest of this
  domain should look like. It re-implements `tauri-build`'s own `.ico` resolution
  rule rather than hard-coding a path, checks the ICO magic rather than mere
  existence, and carries six of its own non-vacuity controls that build a broken
  icon set in a temp directory and prove each detector fires. 10 tests, all green
  here. It closes a real cloud-blind defect (`icon.ico` missing until `a50ee9f`,
  invisible on Linux, fatal on Windows).
- **`src-tauri/build.rs`** links `tauri-build`'s own resource library into the
  test targets via `rustc-link-arg-tests`, rather than writing a second manifest,
  and panics with an explanation if the artifact name ever moves. That is the
  right shape for a fix that must not silently revert.
- The **Cargo workspace layout** is coherent: `members = ["crates/*"]` resolves
  to exactly the ten crates enumerated in `default-members`, plus the root, so
  bare `cargo test` really does cover everything (unguarded, but currently true).
  The host crate depends on no plugin and holds only the IPC boundary.
- **Version numbers agree**: `package.json` `0.1.0`, `tauri.conf.json` `0.1.0`,
  `[workspace.package] version` `0.1.0`. No guard holds them together, and the
  MSI version and the exe's version resource come from different files, so this
  will drift eventually — but it has not yet.
- The **release binary carries no devtools command** while the debug binary does.
- `.gitignore` correctly excludes `src-tauri/gen/`, `target/`, `dist/`, `*.db`,
  `.env*`, `*.pem`, `*.key`.

---

## Commands run, in order

1. `git log/status/ls-files/grep/show/check-attr/config` — read-only throughout.
2. `pnpm run test:transcripts` — failed, `'.' is not recognized`, exit 1.
3. `pnpm run test:secrets` — failed identically, exit 1.
4. `bash scripts/check-transcripts.sh` — exit 0, "byte-identical". **Rewrote 49
   tracked files CRLF→LF in the working tree**; reverted with
   `git checkout -- docs/regression-baseline`, confirmed
   `git status --porcelain` empty.
5. `pnpm run test:harness` — 2 failed / 140 passed, twice.
6. `pnpm run build` — succeeded, 5.50s.
7. `pnpm exec vitest run src/platform/bundle-icons.test.ts src/platform/verify-covers-ci.test.ts`
   — 23 passed.
8. Seven mutations of a scratch copy of `package.json` + `ci.yml` +
   `verify-covers-ci.test.ts`, under
   `…\scratchpad\vcc\` with `node_modules` junctioned from the repo. **No
   tracked file involved.**
9. `pnpm install --frozen-lockfile --lockfile-only` in a scratch copy of
   `package.json` + `pnpm-lock.yaml` + `.npmrc`. **Not run in the repo**, so the
   shared `node_modules` was never touched.
10. `grep -a -o` over `src-tauri/target/release/vela.exe` and
    `…/debug/vela.exe` — read-only.

Final state of the worktree: `git status --porcelain` clean for every path this
audit touched.

## What I could not establish

- Whether `pnpm tauri build` produces a working MSI or NSIS installer. Building
  it needs the WiX and NSIS toolchains downloaded and a full release compile of a
  ten-crate workspace; the machine has ~15 GB free and eleven agents on it. All
  that is established is that no bundle exists and one attempt on 2026-08-13 left
  an empty `wix/x64`.
- Whether the Windows-only harness failures reproduce on GitHub's
  `windows-latest` runner. Both depend on runner configuration I cannot see —
  failure 1 on the runner's `core.autocrlf`, failure 2 on Winsock behaviour that
  should reproduce but was not observed there. The point stands regardless: CI
  does not run `pnpm test:harness` on Windows, so it would not find out either
  way.
- Whether `devUrl: http://localhost:1420` actually reaches a dev server bound to
  `127.0.0.1` under WebView2. Requires launching the app.
- Whether a Node 20.19 contributor really fails. Only one Node (v24.15.0) is
  installed here; the conclusion is read off `cli.ts`'s own header, `ci.yml`'s
  pin, and Node's type-stripping history, not measured.
- Whether `cargo build --workspace --locked` and `cargo test --workspace
  --locked` pass here. Taken as given from the lead's measurement (60 targets, 0
  failed, 1277 tests); not re-run, by instruction.
- Whether `pnpm lint:rust` (`cargo fmt --all --check && cargo clippy --workspace
  --all-targets -- -D warnings`) passes. Not run — clippy must build the whole
  graph, and the disk budget did not allow it.
