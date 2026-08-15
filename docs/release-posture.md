# Release posture

What shipping Vela to a stranger's machine means **today**, on commit
`0fa0cec` plus this branch. This is a record of the state that exists, not a
plan for a state somebody intends. Nothing here says "will".

Everything below was re-derived from the configuration and the dependency
sources as they stand, not from prior documentation.

---

## 1. The bundle configuration, in full

`src-tauri/tauri.conf.json` has exactly one `bundle` block, and it has exactly
six keys:

```
active, targets, category, shortDescription, longDescription, icon
```

Checked mechanically rather than by eye:

```
$ node -e "const c=require('./src-tauri/tauri.conf.json');
           console.log(Object.keys(c.bundle));
           console.log('bundle.windows:', JSON.stringify(c.bundle.windows));
           console.log('plugins:', JSON.stringify(c.plugins));"
[ 'active', 'targets', 'category', 'shortDescription', 'longDescription', 'icon' ]
bundle.windows: undefined
plugins: undefined
```

`bundle.windows` being **undefined** is the load-bearing fact for the two
sections that follow. There is no `windows` sub-object at all, so every
Windows-specific default applies wholesale: no `signingIdentity`, no
`certificateThumbprint`, no `timestampUrl`, no `signCommand`, no
`webviewInstallMode`, no `nsis` block, no `wix` block.

`identifier` is `dev.vela.desktop`. `productName` is `Vela`. `version` is
`0.1.0`.

---

## 2. The installer is unsigned

No code-signing configuration exists anywhere in the tree. In addition to
`bundle.windows` being absent, a repository-wide search finds no occurrence of
any signing key in any tracked file under `src-tauri/`:

```
$ git grep -in "signingIdentity\|certificateThumbprint\|timestampUrl" -- src-tauri/
(no matches)
```

### What a user actually sees

The installer carries no Authenticode signature, so:

- **The publisher is unknown.** The UAC dialog, where one appears, and the file's
  Properties → Digital Signatures tab show no signer. There is no "Digital
  Signatures" tab at all on an unsigned binary. Windows has no name to show,
  so any prompt that names a publisher says *Unknown publisher*.

- **Microsoft Defender SmartScreen blocks it on first run.** When the file
  carries a Mark-of-the-Web — which is what a download from a browser, a chat
  client, or an email attachment attaches — SmartScreen has no reputation
  record for an unsigned, never-before-seen binary. The user gets a blue
  full-screen dialog headed **"Windows protected your PC"**, with the body
  "Microsoft Defender SmartScreen prevented an unrecognised app from starting.
  Running this app might put your PC at risk." The only visible button is
  **Don't run**.

- **To install, the user must deliberately override it.** They must click the
  small **More info** link, which reveals the app name and "Publisher: Unknown
  publisher", and then click **Run anyway**. This is a two-step, deliberately
  discouraging flow, and a cautious user will stop at it.

Signing is the only thing that removes this. An EV certificate removes it
immediately; an OV certificate removes it only after the binary accumulates
reputation across enough installs. Neither exists here, and this document does
not propose buying one — it records that neither exists.

### The limit of what was verified

The SmartScreen dialog itself was **not** reproduced on this machine. Two
honest reasons, both of which mean the absence of a prompt here proves nothing:

1. A locally built file has no Mark-of-the-Web. SmartScreen's app-reputation
   check is triggered by that zone marker, so a file that never crossed a
   network boundary does not get the treatment a downloaded one does.
2. The install performed for this item was run silently (`/S`), which suppresses
   installer UI by construction.

What *was* verified directly is the input SmartScreen keys off: the signature
state of the produced artifacts. See §6.

---

## 3. There is no updater

Not "an updater that is switched off" — none is wired at all. Checked in every
place one could hide:

| Where an updater would appear | Result |
| --- | --- |
| `bundle.createUpdaterArtifacts` in `tauri.conf.json` | key absent |
| top-level `plugins` in `tauri.conf.json` (updater endpoints, pubkey) | `undefined` |
| `tauri-plugin-updater` in `src-tauri/Cargo.toml` | absent |
| `updater` anywhere in `src-tauri/Cargo.lock` | no match |
| `@tauri-apps/plugin-updater` in `package.json` | absent |
| `updater` anywhere in `pnpm-lock.yaml` | no match |
| updater permission in `src-tauri/capabilities/main.json` | absent — the capability grants only `core:event:default` and five `core:window:*` permissions |

### What that means for a user

**An installed copy never learns that a new version exists.** There is no
update check at startup, no background check, no notification, no "a new
version is available" surface anywhere in the product. The installed build is
frozen at whatever version was installed, permanently, until a human
independently discovers a newer one, downloads it, and runs a new installer by
hand.

The practical consequence is that every shipped copy is a copy that cannot be
fixed remotely. A defect found after release — including a security defect —
reaches existing users only if they happen to come back and look.

### One thing that is *not* wrong here

A Tauri updater plugin that is present as a dependency but left unconfigured
would be worse than none: it ships update-checking code and a permission
surface into the binary while pointing at no endpoint and verifying against no
public key. **That is not the case here.** The plugin is absent from both
lockfiles, which is the stronger and more honest of the two states. This is
recorded because it is the one place in this document where the truth is better
than it might have been, and it was checked rather than assumed.

---

## 4. WebView2: what happens on a machine that lacks it

`webviewInstallMode` is not set, so the Tauri v2 default applies. That default
is not a guess — it is in the dependency source this build compiles against,
`tauri-utils 2.9.3`, `src/config.rs`:

```rust
impl Default for WebviewInstallMode {
  fn default() -> Self {
    Self::DownloadBootstrapper { silent: true }
  }
}
```

So the effective mode is **`downloadBootstrapper`, silent**.

For a user whose machine has no WebView2 runtime, that means the installer
**downloads the WebView2 bootstrapper from Microsoft during installation**.
Consequences worth stating plainly:

- **Installation requires a working internet connection** on any machine that
  does not already have the runtime — even though Vela is presented as an
  offline-first product. An offline install on a fresh machine fails at this
  step.
- The download is silent, so a user on a slow link sees an installer that
  appears to stall with no explanation.
- The alternative modes exist and are not used: `embedBootstrapper` (smaller,
  still needs network), `offlineInstaller` (adds ~127 MB, no network needed),
  and `fixedRuntime` (adds ~180 MB, pins a version). Recording, not
  recommending.

In practice most Windows 11 machines already carry WebView2 — it ships with the
OS and with Edge — so this path is not hit often. But "usually already present"
is not "not required", and the failure mode belongs to the machines that lack
it.

### The limit of what was verified

**This was not tested end to end, and could not be.** This machine already has
the runtime:

```
Microsoft Edge WebView2 Runtime, version 151.0.4129.78
(HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5})
```

so the installer's no-WebView2 branch was never exercised here. The statement
above is derived from the configured default in the bundler's own source, not
from an observed download. Verifying it for real needs a machine or VM with the
runtime removed, which this item did not have.

---

## 5. Elevation

**NSIS: no elevation.** `bundle.windows.nsis.installMode` is unset, and the
default in `tauri-utils 2.9.3` is `CurrentUser`:

```rust
pub enum NSISInstallerMode {
  /// Install the app by default in a directory that doesn't require Administrator access.
  /// Installer metadata will be saved under the `HKCU` registry path.
  #[default]
  CurrentUser,
  ...
}
```

So the NSIS installer runs without a UAC prompt, installs under the user's
own profile, and writes its uninstall metadata to `HKCU`. A user with no
administrator rights can install Vela. The flip side: it installs per-user
only, so it is invisible to other accounts on the same machine.

**MSI: elevation required.** Measured from the produced MSI itself, not
assumed. Its Property table contains `ALLUSERS = 1`, which is a per-machine
install into `Program Files`, and its Summary Information word count is `2` —
bit 3 (value 8), the flag meaning *this package does not require elevation*, is
**not** set. So the MSI prompts for administrator rights and a standard user
cannot install it.

The two targets therefore disagree about who can install Vela: the NSIS
installer works for any user, the MSI requires an administrator. Both are
produced by default, and nothing in the product tells a user which to pick.

---

## 6. What the build actually produced

### The bundle configuration could not produce an installer at all

The first thing `pnpm tauri build` did on Windows was fail, after a complete and
successful Rust release compile:

```
Built application at: C:\Users\User\vela-wt-bundle\src-tauri\target\release\vela.exe
    Error failed to bundle project: `Couldn't find a .ico icon`
```

The cause is in `bundle.icon`. It listed four PNGs and no `.ico`:

```
[ 'icons/32x32.png', 'icons/128x128.png', 'icons/128x128@2x.png', 'icons/icon.png' ]
```

The Windows bundler requires an `.ico` in that list. `src-tauri/icons/icon.ico`
**was already present on disk** — 5275 bytes, valid ICO magic `00 00 01 00`,
three images — it was simply never referenced. The application binary was
unaffected, because `tauri-build` embeds the icon resource by a different path,
which is why this defect could sit behind a green `cargo build` indefinitely.

So `"targets": "all"` with `"active": true` was aspirational: as committed at
`0fa0cec`, this configuration could not produce a Windows installer of either
kind. **This is the ship-blocker B2 existed to find.** The fix is one added
array element, `"icons/icon.ico"` — no target was narrowed and no failure was
routed around.

### After the fix, both targets produced output

```
Running light to produce ...\bundle\msi\Vela_0.1.0_x64_en-US.msi
Running makensis to produce ...\bundle\nsis\Vela_0.1.0_x64-setup.exe
EXIT=0
```

| Artifact | Bytes | SHA-256 | Signature |
| --- | ---: | --- | --- |
| `target/release/bundle/msi/Vela_0.1.0_x64_en-US.msi` | 7,102,464 (6.77 MB) | `4CACAB5E3E7F72599F69D04078124B06DFEB5769E8BF99B39C241181F34DC231` | NotSigned |
| `target/release/bundle/nsis/Vela_0.1.0_x64-setup.exe` | 5,266,116 (5.02 MB) | `4BDF5E3B1AF0CF1B816466823039144BBC9CE9D0C3B78F35F7E4A42FDEFFFB97` | NotSigned |

`Get-AuthenticodeSignature` reports `NotSigned` with no signer certificate for
both, and for `vela.exe` itself. That is the direct measurement behind §2.

**MSI needs WiX, and WiX happened to be present.** `light.exe` ran from
`%LOCALAPPDATA%\tauri\WixTools314`, a complete WiX 3.14 unpacked by an earlier
attempt on 2026-08-13. A machine without that cache downloads it at build time.

**The build requires network access.** NSIS was not cached and was fetched
during this build:

```
Downloading https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip
Downloading https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll
```

An offline machine cannot build these installers, and the bundler toolchains
come from GitHub release URLs rather than from anything pinned in this
repository.

### Two failures on the way that were not the project's fault

Recorded because they will recur on this machine and both disguise themselves:

1. **`fatal error C1056: cannot update the time date stamp field`** while
   `cc-rs` compiled `ring`'s `mem.c`. Disk was not full (38.7 GB free). This is
   a Defender real-time-scanning file-lock race on the freshly written `.o`.
   It cleared on retry.
2. **`memory allocation of 88339483 bytes failed`** — a genuine rustc OOM that
   killed `windows` and `tauri-utils`. The machine has 63.8 GB of RAM, so this
   was not RAM exhaustion: the pagefile was pinned at its allocated maximum
   (10,173 MB allocated, 10,086 MB in use) and could not grow, because C: had
   fallen to 20 GB free while two other agents' `target` directories occupied
   40 GB between them. **This is the disk-pressure failure wearing a different
   mask** — it surfaced as an out-of-memory abort, not as a link error.
   Retrying with `CARGO_BUILD_JOBS=4` and ~30 GB free succeeded.

---

## 7. The installer was run, and what it did

```
> Start-Process Vela_0.1.0_x64-setup.exe -ArgumentList "/S" -Wait
installer exit code = 0
```

Run from a **non-elevated** shell — `IsInRole(Administrator)` returned `False`
— and no UAC prompt appeared. That is the direct evidence for §5's claim that
the NSIS installer needs no administrator rights.

What it produced:

- `C:\Users\User\AppData\Local\Vela\vela.exe` — 16.65 MB
- `C:\Users\User\AppData\Local\Vela\uninstall.exe`
- Desktop shortcut and Start Menu shortcut, both targeting
  `C:\Users\User\AppData\Local\Vela\vela.exe`
- An uninstall entry under **HKCU** (`DisplayName: Vela`, `DisplayVersion:
  0.1.0`, `Publisher: vela`). There are **zero** matching entries under HKLM,
  confirming the per-user scope.

The installed binary is byte-identical to the one the compiler produced except
for **three bytes** at offset 13410002, where the bundler stamps the installer
provenance: `55 4E 4B` (`UNK`) becomes `4E 53 53` (`NSS`). Nothing else in
17,462,272 bytes differs.

Two things worth flagging about what a user sees here:

- **`Publisher` is the string `vela`, lower-case.** It is derived from the
  `dev.vela.desktop` identifier, not from any configured publisher name. It is
  what appears in Settings → Apps.
- **An unrelated third-party application named "Vela" was already installed on
  this machine** — an Electron app (version 1.1.0, `CompanyName: GitHub, Inc.`)
  at `%LOCALAPPDATA%\Programs\vela`. Vela's NSIS installer targets
  `%LOCALAPPDATA%\Vela`, a different directory, so the two coexist and the
  existing app was verified untouched. But both now appear as "Vela" in the
  installed-programs list, and the name is not distinctive.

**The MSI was not installed.** It requires administrator rights (§5) that this
session does not hold, and a per-machine install is the more invasive of the
two. It was built and inspected, not run.

---

## 8. The installed app was NOT launched, and why that is a finding

This is the part of B2 that could not be completed, stated plainly rather than
papered over.

The intent was to launch the installed app with `APPDATA` redirected to a
scratch directory, so that a concurrent measurement of the ACL on
`%APPDATA%\dev.vela.desktop` would survive. **That redirect does not work, and
Vela cannot be launched in isolation on this machine at all.**

The chain, re-derived from the source that this build actually compiled:

1. Startup opens the database before anything else, and a failure there aborts
   startup — `src-tauri/src/lib.rs` `setup` calls `store_host::open`, which
   calls `SqliteStore::open` and runs migrations. Launching *writes*.
2. `store_host::database_location` resolves that path with
   `app.path().app_data_dir()`.
3. `tauri 2.11.5`, `src/path/desktop.rs:247` — `app_data_dir()` is
   `dirs::data_dir()` joined with the bundle identifier.
4. `dirs 6.0.0`, `src/win.rs:10` — `data_dir()` is
   `dirs_sys::known_folder_roaming_app_data()`.
5. `dirs-sys 0.5.0`, `src/lib.rs:150-158,176` — that is
   `SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, NULL, ...)`.

`SHGetKnownFolderPath` is a Win32 shell API that reads the user's profile
configuration. **It does not consult the `APPDATA` environment variable.**
Verified directly, with a probe that writes nothing:

```
### Control: normal APPDATA ###
APPDATA env var seen by this process : C:\Users\User\AppData\Roaming
SHGetKnownFolderPath(RoamingAppData) : C:\Users\User\AppData\Roaming

### Test: APPDATA redirected to ...\scratchpad\fake-appdata ###
APPDATA env var seen by this process : ...\scratchpad\fake-appdata
SHGetKnownFolderPath(RoamingAppData) : C:\Users\User\AppData\Roaming
```

The child process saw the redirected variable and the API ignored it. So
launching Vela would have written to the real
`C:\Users\User\AppData\Roaming\dev.vela.desktop` regardless of any environment
setting, destroying the concurrent measurement. No per-process override exists:
the only ways to change what that API returns are to edit the user's shell
registry or to run as a different user, both of which are worse than the problem.

**The app was therefore never launched, and this item cannot claim "reaches a
user" for the running application.** The installer reached a user; the running
app did not. The finding was established without a single destructive launch —
`%APPDATA%\dev.vela.desktop` was byte-for-byte and timestamp-for-timestamp
identical before and after the install, and still carries its ACL entries
unchanged.

### A related documentation defect, not fixed here

`src-tauri/store_host.rs` documents the location as ``%APPDATA%\<identifier>``
on Windows. That names the right directory but invites exactly the wrong
inference — that the `APPDATA` environment variable selects it. It does not.
This file is adjacent to the app-data builder's territory, so B2 reports the
defect rather than editing it.

---

## 9. The toolchain is now pinned

`src-tauri/rust-toolchain.toml` pins `1.97.1` with `rustfmt` and `clippy`. Its
own comment explains why the version is not cosmetic; the short form is that
rustfmt's output changes between releases, so the compiler version is an input
to the `cargo fmt --all --check` gate.

Verified not to change the gate's answer: `cargo fmt --all --check` was
captured before and after the file existed, and the two outputs are
byte-identical — same 33 hunks across the same 5 files, SHA-256
`0A86486D2195FD4A70CA0BF2F89BD71F5B0B177C78B0A68D1DE823080FE22588` both times.

The pin cannot change any compilation outcome on this machine, which was
checked rather than argued: `stable-x86_64-pc-windows-msvc` and
`1.97.1-x86_64-pc-windows-msvc` are the **same build**. Both report
`commit-hash: 8bab26f4f68e0e26f0bb7960be334d5b520ea452`, and their `rustc.exe`
and `cargo-clippy.exe` are byte-identical
(`CF79CFD77B0A144C56A0A6AF6BF10BCDF095A73718CD4BF2B9D4FE2D2CBDED55` for
`rustc.exe` under both). Pinning selects the compiler that was already in use.

### The clippy gate fails earlier than expected, and not in Vela's code

Running the gate as CI runs it:

```
$ cargo clippy --workspace --all-targets -- -D warnings
error[E0277]: `DatetimeParseError` doesn't implement `std::fmt::Display`
  --> ...\toml_datetime-0.7.5+spec-1.1.0\src\datetime.rs:769:28
error[E0277]: `SerializerError` doesn't implement `std::fmt::Display`
  --> ...\toml_datetime-0.7.5+spec-1.1.0\src\ser.rs:37:28
error[E0277]: `SerializerError` doesn't implement `std::fmt::Display`
  --> ...\toml_datetime-0.7.5+spec-1.1.0\src\ser.rs:80:18
error: could not compile `toml_datetime` (lib) due to 3 previous errors
EXIT=101
```

This is a **third-party dependency failing to compile**, not a lint. Clippy
therefore never reaches `vela-sandbox` or `vela-skills`, so the two clippy
errors those crates are known to carry could not be observed or counted here —
the gate dies before it gets to them. That is a worse failure than "two lint
errors", because a green-looking fix to those two errors would still leave this
gate red.

Three things establish that this is pre-existing and not introduced by this
branch:

- `toml_datetime 0.7.5+spec-1.1.0` is already in the committed
  `src-tauri/Cargo.lock`, and the run did **not** modify the lockfile — the
  failing graph is the locked graph.
- This branch adds no Rust source and changes no dependency.
- The pinned toolchain is a byte-identical compiler to the one previously in
  use, per the hashes above.

Why `cargo build --release` succeeds while this fails: `--all-targets` pulls in
dev-dependencies and test/example targets, which unifies crate features
differently, and `toml_datetime` is built in that configuration without the
feature that provides its `Display` impls. Diagnosing the upstream cause is not
B2's, and no attempt was made to fix it.

One consequence for CI, recorded because nobody will connect it later
otherwise: the three jobs in `.github/workflows/ci.yml` use
`dtolnay/rust-toolchain@stable`, and a `rust-toolchain.toml` takes precedence
over `rustup default`. Those jobs will now resolve **1.97.1** rather than
whatever `stable` is on the day, and rustup will download it on each run. That
is the intended effect of pinning. The workflow file was not edited, because
`src/platform/verify-covers-ci.test.ts` reads it and belongs to another builder.

---

## 10. What this document does not establish

- **The running application.** Never launched — §8. Everything here about the
  installed app describes files, registry entries and shortcuts on disk, not
  observed behaviour of the program.
- **The no-WebView2 install path.** This machine has the runtime — §4.
- **The SmartScreen dialog.** Not reproduced; a locally built file carries no
  Mark-of-the-Web and the install was silent — §2.
- **The MSI actually installing.** Built and inspected; not run, because it
  requires administrator rights — §7.
- **Whether the installers work on any machine other than this one.** One
  machine, one architecture (`x86_64-pc-windows-msvc`), one Windows version.
- **Uninstall.** `uninstall.exe` was produced and never executed, so nothing is
  known about whether it removes cleanly, and in particular nothing is known
  about what its "Delete app data" checkbox does to
  `%APPDATA%\dev.vela.desktop`.

`docs/architecture/conventions.md` lists `pnpm tauri build` (with bundling) as
"not attempted". That is superseded by this document for Windows; the file
itself was not edited, being outside B2's claim.

