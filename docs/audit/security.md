# Audit — Secrets, credentials and data-at-rest

Auditor: independent domain auditor, full-audit round.
Worktree `C:\Users\User\vela-tmp`, branch `claude/new-session-tgl1ut`, HEAD `a1fa55e`.
Host: Windows 11 Home 10.0.26200, real filesystem, real NTFS ACLs, real `icacls`,
real Windows Credential Manager present.

Everything below labelled **MEASURED** was run by me on this machine during this
audit. Everything labelled **MUTATED** means I broke the implementation, watched
a test go red, and reverted with `git checkout -- <file>` (each revert confirmed
by `git status --porcelain` returning empty for that path — printed as
`REVERTED-CLEAN` in every transcript below).

No tracked file was left modified. `git status --porcelain` at the end of my run
showed only other auditors' edits (`src/features/conversation/*`,
`src/platform/contract.ts`) and this new file.

---

## 1. Headline

The four promises I was asked to grade specifically:

| Promise | Verdict |
|---|---|
| No secret value ever crosses the IPC boundary toward the renderer | **PASS** — three independent guards, two of which I broke and watched bite |
| A credential never appears in a rendered error | **PASS** — 34 canary tests on real loopback sockets, and the scrubber bites when gutted |
| The debug log is off at every launch, and cannot be read back through IPC | **PASS** — the read-back half bites under mutation; the launch-default half is structural and untested |
| The diagnostics directory is owner-only | **PASS**, measured live — and it is the **only** thing under `%APPDATA%\dev.vela.desktop` that is |

The last row is the finding. The DACL work landed, it works, and it is held
going forward by tests that run on Windows CI. It was applied to `diagnostics/`
and to nothing else. `vela.db` — the conversation store, every prompt and every
answer — sits one directory up with the exact ACE the whole module was written
to remove.

---

## 2. The command surface: `secrets_get` does not exist, and cannot be added quietly

### What is there

`src-tauri/src/ipc/secrets.rs` exposes three commands and no fourth:
`secrets_set`, `secrets_delete`, `secrets_status`. `secrets_status` returns
`SecretsStatusRes { present: bool }`. `SecretsSetReq.value` is a
`vela_core::secret::SecretValue`, which is `Deserialize` but **deliberately not
`Serialize`** — so no response type in the workspace can carry one even by
accident. I checked the derive list directly:

```rust
// src-tauri/crates/vela-core/src/secret.rs
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct SecretValue(String);
```

Three guards claim to hold the rule:

* `src-tauri/src/ipc/mod.rs::tests::no_command_returns_secret_material` — asserts
  `secrets_get` is not in `COMMAND_ALLOWLIST`;
* `src-tauri/src/ipc/mod.rs::tests::rust_and_typescript_allowlists_are_identical`
  — string-scans `src/platform/contract.ts` and compares sets;
* `src/platform/contract.test.ts:85` — the same assertion on the TS side.

### MUTATED — does the guard bite on Windows?

This matters more than usual: the session has already established that a
contract-parity guard on this repo was CRLF-broken and passed CI for months
because CI was Linux-only. So I added `secrets_get` to the Rust allowlist and ran
the guards on this Windows machine.

```
$ python -c "...insert '\"secrets_get\",' after '\"secrets_delete\",'..."
patched allowlist: added secrets_get
$ cargo test -p vela-app --lib ipc::tests --no-fail-fast
test ipc::tests::every_command_is_domain_prefixed ... ok
test ipc::tests::allowlist_is_sorted_and_has_no_duplicates ... ok
test ipc::tests::no_command_returns_secret_material ... FAILED
test ipc::tests::rust_and_typescript_allowlists_are_identical ... FAILED
test result: FAILED. 2 passed; 2 failed; 0 ignored; 0 measured; 185 filtered out
REVERTED-CLEAN
```

Both bite, on Windows, at HEAD. Clean re-run afterwards:

```
$ cargo test -p vela-app --lib ipc::tests
test ipc::tests::every_command_is_domain_prefixed ... ok
test ipc::tests::no_command_returns_secret_material ... ok
test ipc::tests::allowlist_is_sorted_and_has_no_duplicates ... ok
test ipc::tests::rust_and_typescript_allowlists_are_identical ... ok
test result: ok. 4 passed; 0 failed
```

### The honest limit of the guard

`no_command_returns_secret_material` matches one literal string. A command named
`secrets_read` or `secrets_reveal` would sail past it. What actually stops that
is not this test — it is that `SecretValue` has no `Serialize` impl, so such a
command would not compile. The test is a reminder; the type is the guard. Worth
knowing which is which, because the comment above the test calls itself
"structural guard for the one-way rule," which reads stronger than it is.

`src-tauri/tests/handler_binding.rs:471` additionally dispatches `secrets_get`
against the real assembled `invoke_handler` and asserts it is not found — so the
allowlist and `generate_handler!` are bound together rather than being two
parallel lists.

### Does it reach a user?

Traced end to end, no assumptions:

```
src/features/models/ModelWorkspace.tsx:205   <EndpointsPanel ... onStoreCredential={providers.storeCredential}
src/features/models/use-providers.ts:95      await repository.storeCredential(providerId, value)
src/data/settings-repository.ts:70           await adapter.invoke('secrets_set', { providerId, value })
src-tauri/src/lib.rs:221-223                 ipc::secrets::{secrets_delete, secrets_set, secrets_status}
```

The renderer has a write path and no read path. `src/data/settings-repository.ts`
states the rule in its own module docs and the interface has no `getCredential`.

---

## 3. Redaction: `SecretValue` cannot be printed

### MUTATED — Debug leaks the value

```
$ python -c "...replace write!(f, \"SecretValue({REDACTED})\") with write!(f, \"SecretValue({})\", self.0)..."
patched
$ cargo test -p vela-core -p vela-secrets
test secret::tests::a_derived_secret_stays_wrapped ... FAILED
test secret::tests::a_secret_nested_inside_a_derived_debug_struct_is_still_redacted ... FAILED
test secret::tests::debug_and_display_of_a_secret_value_never_contain_the_credential ... FAILED
test result: FAILED. 22 passed; 3 failed
REVERTED-CLEAN
```

And separately, with only `Debug` broken (not `Display`), to prove the canary in
`vela-secrets` is independent rather than riding on `vela-core`'s own tests:

```
$ cargo test -p vela-secrets --lib --no-fail-fast
failures:
    tests::resolved_request_material_is_redacted_when_logged
test result: FAILED. 12 passed; 1 failed
REVERTED-CLEAN
```

That is four separate tests in two crates, each of which bites. The canary
constant `sk-live-canary-9f2b7c41-DO-NOT-LOG` appears in `vela-core`,
`vela-secrets`, `src-tauri/src/ipc/secrets.rs` and `vela-settings/src/service.rs`
— the leak-through-the-request-struct case is covered in each.

### Where the wrapper is escaped

`expose()` has exactly five production call sites in the workspace (excluding
tests and the `examples/` harness):

```
src-tauri/crates/vela-providers/src/http.rs:130     header value → Vec<(String,String)>
src-tauri/crates/vela-providers/src/http.rs:1039-40 reqwest URL (the socket)
src-tauri/crates/vela-secrets/src/keyring_store.rs:58 set_password
src-tauri/crates/vela-providers/src/redact.rs:115,120 percent-encoding into RequestUrl
```

`http.rs:130` is the one to note: the credential is copied into
`pub headers: Vec<(String, String)>`, a plain `String` that is **not** zeroized
and a **public** field. Three things bound it: `HttpRequest` has a hand-written
`Debug` that redacts, `redacted_headers()` exists for recorders, and the struct
has no `Serialize`. It is a real escape from the type discipline, closed by
convention rather than by the compiler — but I found no production reader that
turns it into a string.

`SecretValue` does zeroize on `Drop`. That is best-effort: `Clone` makes copies
with independent drops, and the `String` above is outside the wrapper entirely.
For a single-user local desktop app this is proportionate; it should just not be
described as a memory-hygiene guarantee.

---

## 4. A credential never appears in a rendered error

### The canaries pass, on real sockets

Three suites, 34 tests, driven through real `ReqwestTransport` against real
loopback listeners that are deliberately broken (closed port, TLS handshake
against a plaintext server, unroutable address, a body that dies mid-stream, an
endpoint that echoes the key back):

```
$ cargo test -p vela-providers --test credential_canary --test encoded_credential_canary --test streamed_credential_canary
running 8 tests   ... test result: ok. 8 passed; 0 failed   (credential_canary)
running 11 tests  ... test result: ok. 11 passed; 0 failed  (encoded_credential_canary)
running 15 tests  ... test result: ok. 15 passed; 0 failed  (streamed_credential_canary)
```

Each file carries its own positive control that rebuilds the pre-fix leak by
hand and asserts the detector finds it, so a silently-passing detector is
already guarded against.

### MUTATED — which mechanism is actually load-bearing?

`redact.rs`'s module docs name two mechanisms and say the first "is the one that
matters":

1. `RequestUrl` cannot be printed into showing the credential (`redacted()`);
2. `Scrubber` removes needles from any derived text.

I gutted each in turn.

**Gutting `RequestUrl::redacted()`** (made it return the wire form):

```
$ cargo test -p vela-providers --test credential_canary --test encoded_credential_canary --test streamed_credential_canary --no-fail-fast
test result: ok. 8 passed; 0 failed
test result: ok. 11 passed; 0 failed
test result: ok. 15 passed; 0 failed
REVERTED-CLEAN
```

**All 34 canaries stay green.** Only the unit tests catch it:

```
$ cargo test -p vela-providers --lib --no-fail-fast     # same mutation
    redact::tests::a_credential_cannot_restructure_the_query_string_it_is_put_into
    redact::tests::a_url_carrying_a_credential_cannot_be_displayed_or_debugged_into_showing_it
test result: FAILED. 402 passed; 2 failed
REVERTED-CLEAN
```

**Gutting `Scrubber::scrub()`**:

```
$ cargo test -p vela-providers --lib --test credential_canary --test encoded_credential_canary --test streamed_credential_canary --no-fail-fast
    http::tests::a_response_header_that_echoes_the_credential_is_scrubbed
    redact::tests::a_credential_spelled_entirely_in_unicode_escapes_is_still_removed
    redact::tests::a_mixture_of_spellings_inside_one_credential_is_one_case_not_three
    redact::tests::a_surrogate_pair_spelling_of_a_non_ascii_credential_is_removed
    redact::tests::both_the_encoded_and_the_raw_form_of_a_credential_are_scrubbed
    redact::tests::merging_keeps_both_sets_and_deduplicates
    redact::tests::scrub_value_reaches_every_string_in_a_decoded_body_including_keys
    redact::tests::the_second_barrier_runs_after_the_decoder_has_undone_the_encoding
test result: FAILED. 396 passed; 8 failed             (--lib)
test result: ok. 8 passed; 0 failed                   (credential_canary)
    a_transport_decorator_that_records_response_headers_records_no_credential
    the_two_barriers_are_independent
test result: FAILED. 9 passed; 2 failed               (encoded_credential_canary)
test result: ok. 15 passed; 0 failed                  (streamed_credential_canary)
REVERTED-CLEAN
```

### What this tells us, and it is good news

Neither redaction mechanism is what keeps a credential out of the error that the
`credential_canary` suite drives. The thing that does is stronger than both:
`ProviderError` **has no field that can hold endpoint- or client-supplied text
at all**. `map_reqwest_error` (`src-tauri/crates/vela-providers/src/http.rs:1133`)
classifies the failure into a typed `TransportFailure::{Connect,Timeout,Reset}`
plus a `Diagnosis`, and sends `reqwest`'s own string — with `.without_url()`
applied — to the local debug log instead:

```rust
crate::debuglog::record(move || crate::debuglog::DebugEntryOwned {
    correlation, cause, status: None, endpoint: None,
    body: error.without_url().to_string().into_bytes(),
});
TransportError::new(failure, diagnosis)
```

The refused-redirect path is the same shape, and `RefusedRedirect`'s fields are
built only from `authority_of()` (scheme + host + port), so nothing that could be
a credential is expressible in one.

So the promise holds for a better reason than the docs claim, and the redaction
layers are genuine belts. The one thing worth recording is that
`RequestUrl::redacted()` — the mechanism the module docs single out — is verified
only by two unit tests, and no integration canary depends on it. That is a test
gap, not a defect.

### Not scrubbed, and correctly so

Two `debuglog::record` sites pass text that never went through a `Scrubber`
(`error.without_url()` and `refused.to_string()`). Both are safe by
construction — `without_url()` removes the only place a query credential could
be, and the redirect line is scheme/host/port. But `debuglog.rs`'s module docs
say the bytes are "already through the credential scrubber," which is true of the
`UpstreamBytes` path and not of these two. A reader auditing that file would be
mildly misled.

---

## 5. The debug log

### Off at every launch

* `debuglog`'s sink is a `OnceLock<RwLock<Option<Arc<dyn DebugSink>>>>`
  initialised to `None` (`debuglog.rs`, `fn slot()`).
* `src-tauri/src/lib.rs:97` only `app.manage(...)`s the *path*; nothing calls
  `enable`.
* No persistence exists. `git grep -rn "debugLog\|debug_log" -- vela-settings vela-store`
  returns **nothing** — there is no setting key, no row, no file that could
  restore the switch.

Verdict PASS, but on **inspection**, not on a test. Every test in
`ipc::diagnostics::tests` calls `debuglog::disable()` first, so the assertion
`assert!(!off.enabled)` in `the_switch_turns_the_log_on_and_off_and_the_log_then_records`
is verifying the state the test just set, not the launch default. Nothing would
fail if someone added persistence tomorrow.

### The log cannot be read back through IPC — MUTATED

`DebugLogStatus` is `{ enabled: bool, path: String }`, returned by both
`diagnostics_debug_log_get` and `diagnostics_debug_log_set`, which are the only
two commands that touch the log. I made `status_of` put the log's **contents**
into `path`:

```
$ cargo test -p vela-app --lib ipc::diagnostics --no-fail-fast
test ipc::diagnostics::tests::no_debug_log_response_can_carry_what_the_log_recorded ... FAILED
test result: FAILED. 8 passed; 1 failed
REVERTED-CLEAN
```

The guard bites.

### Fail-closed wiring

`debug_log_set_with` refuses to install a sink when `create_private_dir` fails,
calls `debuglog::disable()` on that path, and returns an `IpcError` naming the
directory and the OS error. Both the refusal test and its control pass on this
machine (`the_log_stays_off_when_the_directory_cannot_be_made_private` and
`the_pre_fix_body_lets_the_log_come_up_over_a_directory_nothing_protected`).

One nuance not covered: after the directory is hardened, `FileSink` opens its
file lazily through `private_fs::open_private_append(path).ok()`. If *file*
hardening fails at that later moment, the sink silently records nothing while
`diagnostics_debug_log_get` continues to report `enabled: true`. That fails
closed for secrecy and open for honesty. No test covers it.

---

## 6. The DACL — measured live, and mutated

### It works, right now, on this machine

```powershell
PS> $root = Join-Path $env:APPDATA 'dev.vela.desktop'
PS> $acl = Get-Acl (Join-Path $root 'diagnostics')
=== diagnostics ===
  Protected: True
    NT AUTHORITY\SYSTEM  FullControl  inherited=False
    DESKTOP-298M5DU\User  FullControl  inherited=False
```

Owner + SYSTEM, inheritance disabled. Exactly what `private_fs.rs` promises.

### The Windows tests bite — MUTATED

Clean run first, on real NTFS:

```
$ cargo test -p vela-providers --lib private_fs
test private_fs::tests::a_directory_that_cannot_be_hardened_is_an_error_not_a_warning ... ok
test private_fs::tests::a_directory_this_module_creates_is_reachable_by_nobody_else ... ok
test private_fs::tests::a_log_this_module_opens_is_reachable_by_nobody_else ... ok
test private_fs::tests::an_existing_directory_a_non_owner_can_read_is_tightened_not_accepted ... ok
test private_fs::tests::assuming_the_os_already_made_it_private_does_not_get_past_the_read_back ... ok
test private_fs::tests::a_log_from_an_earlier_run_is_tightened_without_losing_a_line ... ok
test result: ok. 6 passed; 0 failed
```

Then I made the Win32 `apply()` a no-op — `if true { return Ok(()); }` at the
top of the function that calls `SetEntriesInAclW` / `SetNamedSecurityInfoW`:

```
test result: FAILED. 2 passed; 4 failed
failures:
    private_fs::tests::a_directory_this_module_creates_is_reachable_by_nobody_else
    private_fs::tests::a_log_from_an_earlier_run_is_tightened_without_losing_a_line
    private_fs::tests::a_log_this_module_opens_is_reachable_by_nobody_else
    private_fs::tests::an_existing_directory_a_non_owner_can_read_is_tightened_not_accepted
REVERTED-CLEAN
```

The failure text is itself evidence, because it shows the environment is
genuinely hostile — `%TEMP%` on this machine hands down four foreign ACEs:

```
`C:\Users\User\AppData\Local\Temp\vela-private-fs-24408-log-...\diagnostics`
could not be made private on this machine (windows reachable by:
  S-1-5-21-1337097237-1456437254-2378116049-1006,
  S-1-5-21-334268411-1552034672-3966210088-2644424740,
  S-1-5-32-544;
inheritance disabled: false; ...)
```

So these tests are not passing in a vacuum. They pass because the code repairs a
real, inherited, non-private starting state.

The two that survive the mutation are the two seam tests, which inject their own
enforcer — correct, they are testing the wiring, not the Win32 call.

### And in `vela-app`, on the same hardware

```
$ cargo test -p vela-app --lib ipc::diagnostics
test ipc::diagnostics::tests::turning_the_log_on_tightens_a_directory_another_account_could_read ... ok
test ipc::diagnostics::tests::the_log_stays_off_when_the_directory_cannot_be_made_private ... ok
test ipc::diagnostics::tests::the_pre_fix_body_lets_the_log_come_up_over_a_directory_nothing_protected ... ok
test ipc::diagnostics::tests::no_debug_log_response_can_carry_what_the_log_recorded ... ok
... 9 passed; 0 failed
```

`turning_the_log_on_tightens_a_directory_another_account_could_read` is
deliberately *not* `#[cfg(unix)]` and uses `icacls /grant *S-1-5-32-545:(OI)(CI)(RX)`
to widen a real directory before driving the real switch. That is the test that
holds this property going forward.

### Does anything hold it going forward? Yes — and one thing does not

`.github/workflows/ci.yml:186` adds a `test-windows` job on `windows-latest`
running `cargo build --workspace --locked` and `cargo test --workspace --locked`.
That executes all 6 `private_fs` tests and all 9 `ipc::diagnostics` tests against
real ACLs on every push. Combined with the mutation above, this is a guard that
bites.

`src-tauri/tests/gate_m_debug_log_acl.rs` — the evidence driver that reads back
with `Get-Acl` out of process — is `#[ignore]`d and requires
`VELA_GATE_DEBUG_LOG_DATA_DIR`. It does **not** run in CI, by design. Fine, but
worth stating: the out-of-process cross-check is a manual gate, not a regression
guard.

---

## 7. THE FINDING — `diagnostics/` is the only thing that got hardened

`private_fs.rs` exists because of one sentence that turned out to be false:

> *"the application-data directory is already per-user, and nothing here widens it."*

The module's own docs quote it and demolish it. It was demolished for
`diagnostics/`. It is still standing, verbatim in spirit, one directory up:

```
src-tauri/crates/vela-store/src/lib.rs:26
//! host resolves the real per-user application-data directory through Tauri's

src-tauri/crates/vela-store/src/location.rs:5
//! about the OS and never calls a path API itself: the Tauri host resolves the
//! real per-user application-data directory
```

And the code that creates it (`location.rs:65`) is the pre-fix body, verbatim:

```rust
std::fs::create_dir_all(parent).map_err(|error| StoreError::Io { ... })?;
```

### MEASURED, live, on this machine, right now

```powershell
PS> Get-ChildItem (Join-Path $env:APPDATA 'dev.vela.desktop') -Force
Name                              Length
----                              ------
diagnostics
skills
vela.db                           315392
vela.db-shm                        32768
vela.db-wal                           32
vela.db-wal.pre-cleanup-20260815 2603872
vela.db.pre-cleanup-20260815        4096
```

```
=== dev.vela.desktop (root) ===
  AreAccessRulesProtected: False
    S-1-15-3-3557520199-…-3692855932       FullControl                 inherited=True
    DESKTOP-298M5DU\User                   FullControl                 inherited=True
    DESKTOP-298M5DU\CodexSandboxUsers      ReadAndExecute, Synchronize inherited=True
    NT AUTHORITY\SYSTEM                    FullControl                 inherited=True
    BUILTIN\Administrators                 FullControl                 inherited=True

=== diagnostics ===
  Protected: True
    NT AUTHORITY\SYSTEM   FullControl  inherited=False
    DESKTOP-298M5DU\User  FullControl  inherited=False

=== skills ===
  Protected: False
    …CodexSandboxUsers  ReadAndExecute, Synchronize  inherited=True   (+ app-container SID FullControl)

=== vela.db ===
  Protected: False
    …CodexSandboxUsers  ReadAndExecute, Synchronize  inherited=True   (+ app-container SID FullControl)

=== vela.db-wal ===
  Protected: False
    …CodexSandboxUsers  ReadAndExecute, Synchronize  inherited=True   (+ app-container SID FullControl)
```

`DESKTOP-298M5DU\CodexSandboxUsers` is the *same* foreign principal the desktop
gate found on `diagnostics/`. It is still there, on a 315 KB live SQLite database
holding every conversation, and on a 2.6 MB WAL. `private_fs::describe()` applied
to `vela.db` would return `foreign = [CodexSandboxUsers, <app-container SID>]`
and `inheritance_disabled = Some(false)`, i.e. `is_private() == false` — by the
project's own definition, in the project's own reader.

### Why this matters more than it looks

The argument that made the debug log worth a Win32 DACL module is on
`private_fs.rs:6-11`:

> *The debug log holds raw upstream bodies — prompts and answers, verbatim.*

`vela.db` holds prompts and answers verbatim too, permanently, for every
conversation the user has ever had, plus project and memory content. It is
strictly the larger exposure of the same data class, and it received none of the
protection. The debug log is opt-in and off by default; the database is always
on.

### What is *not* exposed

The credential guarantee is intact. `vela-settings/tests/no_plaintext_on_disk.rs`
drives the real settings service against a real SQLite file, closes it, and greps
the database, WAL and SHM for two canaries. It passes here:

```
$ cargo test -p vela-settings --test no_plaintext_on_disk
test a_local_provider_survives_a_restart_and_is_usable_with_an_empty_keychain ... ok
test reopening_the_database_restores_the_configuration_but_no_credential ... ok
test a_stored_credential_never_appears_in_any_file_the_database_writes ... ok
test result: ok. 3 passed; 0 failed
```

It has its own non-vacuity control: it asserts the keychain entry *name*
(`acme/primary`) **is** on disk, so a scan looking in the wrong place fails
loudly. A key in the keychain stays in the keychain.

### Adjacent

`src-tauri/src/ipc/mcp.rs:41` reads `mcp-servers.json` from the same
application-data directory, and an MCP server entry carries
`env: BTreeMap<String, String>` — where a user will put an API token, because
that is what MCP configs are for. That file is not present on this machine
(checked), so I have no ACL reading for it, but it would inherit the root's.

---

## 8. `scripts/secret-scan.sh` — MEASURED, and it bites

```
$ bash scripts/secret-scan.sh
secret-scan: no credential material found in tracked files (docs/ included).
EXIT=0

$ bash scripts/secret-scan.test.sh
# the finding this file exists for: docs/ is scanned
ok   a key in a committed mock transcript is caught
ok   a key in ordinary docs prose is caught
ok   a key in a docs JSON fixture is caught
ok   a private key committed under docs/ is caught
# the shapes it already covered, still covered
ok   a key in source is caught
ok   a key in a Rust test is caught
ok   a tracked .env file is caught even when empty
# no false positives, or the tripwire gets muted
ok   prose that merely contains 'sk-' is not a credential
ok   a placeholder that is not key-shaped is left alone
ok   an empty repository is clean
# the scanner and this test are themselves in scope
ok   scan_scans_itself_and_stays_clean: the real tree passes with no exclusions
ok   exclusions_are_exact_paths_never_globs: the exclusion list is empty
12 passed, 0 failed
EXIT=0
```

The self-test *is* a mutation harness: it plants real key shapes in throwaway
repositories and proves each is caught. `excluded_paths=()` is empty and a test
fails the build if a `*` appears in it. Wired into CI as the `secret-tripwire`
job (`ci.yml:251`), which runs the self-test **before** the scan — so a broken
scanner cannot report clean. Also `pnpm test:secrets`.

Runs on `ubuntu-latest` only, but `git grep -nIE` is platform-neutral and there
is no path-splitting or line-ending logic in it, so this is not another
Windows-only blind spot.

Coverage limits worth stating: four shapes only (`sk-ant-`, `sk-`, `AIza`, PEM).
An Azure key, an AWS pair, a bearer JWT or a `llama-server --api-key` value the
user invented would not match. That is a deliberate crude tripwire, not a claim
of completeness, and the script says so.

---

## 9. The real Windows Credential Manager path

`KeyringStore` is wired as the production backend:

```
src-tauri/Cargo.toml:105        default = ["os-keychain"]
src-tauri/Cargo.toml:109        os-keychain = ["vela-secrets/os-keychain"]
src-tauri/src/state.rs:57-60    #[cfg(feature = "os-keychain")] KeyringStore::new()
                                #[cfg(not(...))]                MemoryStore::new()
```

and the substitution is never silent: `app_info.secretBackend` reports
`os-keychain` vs `memory-fake`, and `src/features/navigation/HomeSurface.tsx:162`
renders `"memory-fake (not a real keychain)"` to the user. `BrowserAdapter`
reports `memory-fake` too (`browser-adapter.ts:989`), so a runtime that fell back
to the browser adapter would say so rather than pretend.

**But nothing in the test suite executes a line of `keyring_store.rs`.**
`git grep KeyringStore` over `src-tauri/` returns only its own file, `state.rs`'s
`#[cfg]`, and documentation. It *compiles* under `cargo test --workspace`
(feature unification via `vela-app`'s default pulls `vela-secrets/os-keychain`;
`libkeyring-8b58a577cf53ffdc.rlib` is in `target/debug/deps`) — but under
`cargo test -p vela-secrets` alone it is not even compiled, because that crate's
own default feature set is empty.

I did **not** exercise it. Writing a probe would have written a credential into
the user's real Credential Manager, which is a side effect I was not asked to
take. I did check read-only:

```powershell
PS> cmdkey /list | Select-String "vela"
(no output; 958 lines total, none matching)
```

No `dev.vela.desktop` entry exists on this machine right now. That is consistent
with the prior desktop gate having cleaned up after itself and tells me nothing
positive.

The evidence that this path works is `docs/desktop-gate/VERDICTS.md`
§A3-keychain-settings, at commit `9540d6c`, driven through WebView2 remote
debugging against the real `AppState::for_runtime()`, confirming
`cmdkey /list` showed `LegacyGeneric:target=<providerId>/primary.dev.vela.desktop`
and a full set→update→delete round trip. That is real evidence at a different
commit, by someone else. `keyring_store.rs` has not changed in a way I checked
against that commit.

---

## 10. Other things I looked at and found sound

* **`Auth::None` never touches the keychain.** `resolve_auth` returns early on
  `auth.secret_ref() == None`. The test uses an `ExplodingStore` whose every
  method panics, so the assertion cannot pass vacuously. Not mutated (the panic
  construction makes it self-proving).
* **No empty `Authorization: Bearer ` header.** A bound-but-missing credential is
  `SecretError::NotFound`, never an empty header; `HttpRequest::with_auth` adds
  nothing for `AppliedAuth::None`.
* **`SecretStore::list` on `KeyringStore` returns `EnumerationUnsupported`
  rather than `Ok(vec![])`.** An empty list would read as "the user has no
  credentials," a claim the backend cannot make. Correct, and unusual enough to
  be worth recording.
* **Bounded credential size.** `MAX_SECRET_BYTES = 8192`, enforced in
  `ipc::secrets::set` before the store is touched, tested.
* **Idempotent delete.** `secrets_delete` on an absent key returns `Ok` —
  `NotFound` is mapped to success because the desired end state is reached.
* **`BrowserAdapter` holds credentials in a `Map` and nothing else.** No
  `localStorage`, no `sessionStorage`, no `indexedDB` anywhere in
  `src/platform/browser-adapter.ts`. Nothing at rest in the dev/browser runtime.
* **Settings row never carries a value.** `vela-settings/src/service.rs` tests
  assert the row serialises without the canary and that a no-auth provider's row
  names no keychain entry at all.

---

## 11. What I could not establish

1. **`KeyringStore` against the real Windows Credential Manager at HEAD.** Not
   run by me (would write to the user's credential store). No test in the
   workspace runs it either. Prior evidence exists at a different commit.
2. **Whether a member of `CodexSandboxUsers` can actually open `vela.db`.** I
   read the ACE and applied the project's own `is_private()` definition to it; I
   cannot impersonate that group to prove the read succeeds.
3. **The debug log's launch default under a real launch.** I was not authorised
   to start the app. Established by inspection (no persistence exists anywhere)
   rather than by observation.
4. **The lazy-open failure path** — file hardening failing after the directory
   succeeded, leaving `enabled: true` over a sink that records nothing. No test,
   and I did not construct one.
5. **`mcp-servers.json` at rest.** Absent on this machine, so no ACL reading.
   Would inherit the unprotected root.
6. **Whether the Scrubber's `hold_back_len` chunk-boundary logic is exercised by
   anything that bites.** I mutated `scrub`, not `scrub_bytes`; the streamed
   canary suite stayed green under the `scrub` mutation, which suggests the
   streaming path has a separate barrier I did not isolate.
7. **`secret-scan.sh` against key shapes it does not enumerate.** By design, but
   unmeasured: I did not plant an Azure/AWS/JWT-shaped secret to confirm it is
   missed.

---

## 12. Commands run, in order

```
bash scripts/secret-scan.sh
bash scripts/secret-scan.test.sh
cargo test -p vela-providers --lib private_fs
[MUT] private_fs.rs apply() → no-op ; cargo test -p vela-providers --lib private_fs ; git checkout
[MUT] secret.rs Debug+Display → leak ; cargo test -p vela-core -p vela-secrets ; git checkout
[MUT] secret.rs Debug → leak ; cargo test -p vela-secrets --lib --no-fail-fast ; git checkout
cargo test -p vela-providers --test credential_canary --test encoded_credential_canary --test streamed_credential_canary
[MUT] redact.rs redacted() → wire ; same three suites ; git checkout
[MUT] redact.rs redacted() → wire ; cargo test -p vela-providers --lib ; git checkout
[MUT] redact.rs scrub() → identity ; --lib + three suites ; git checkout
cargo test -p vela-app --lib ipc::diagnostics
[MUT] ipc/mod.rs allowlist += secrets_get ; cargo test -p vela-app --lib ipc::tests ; git checkout
[MUT] diagnostics.rs status_of.path → log contents ; cargo test -p vela-app --lib ipc::diagnostics ; git checkout
cargo test -p vela-app --lib ipc::tests            (clean confirmation)
cargo test -p vela-settings --test no_plaintext_on_disk
powershell: Get-Acl on %APPDATA%\dev.vela.desktop and four children
powershell: cmdkey /list
```

Every `[MUT]` line ended with `git status --porcelain <path>` returning empty.
