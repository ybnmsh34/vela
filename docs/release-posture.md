# Release posture

What shipping Vela to a stranger's machine means **today**, on commit
`0fa0cec` plus this branch. This is a record of the state that exists, not a
plan for a state somebody intends. It proposes no signing scheme, buys nothing,
and describes no intended future work.

An earlier revision of this line claimed `Nothing here says "will"`, which was
false about the document containing it. Four places in this document's own
prose look forward, excluding quoted source (the `HKCU` doc comment in §5 is
Tauri's text): three say what an already-existing mechanism does the next time
it runs — §2 on SmartScreen, §6 on the two build failures recurring, §9's aside
— and one is a genuine prediction: **§9's claim about which toolchain CI
resolves, marked in place as a prediction because CI was not run.** That is the
only claim here that could turn out wrong on its own terms.

Conditional "would" is used throughout and is not in that count: it describes
counterfactuals that follow from mechanisms read out of the code — what the
uninstaller would delete, what a user without WebView2 would hit — and each is
labelled with whether it was executed. Mostly it was not.

The rule this document actually keeps is the narrower, useful one: **no
aspirational prose about work somebody means to do.**

Everything below was re-derived from the configuration and the dependency
sources as they stand, not from prior documentation.

> **Start with §12.** The work behind this record ran inside an MSIX container,
> which silently redirected the filesystem and registry. Vela was **not**
> installed on the user's machine, and two verifications in earlier revisions
> of this document were aimed at a vantage that could not see what they claimed
> to check. §12 says what that costs and what survives it. The build findings
> in §6 are unaffected.

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

### What those absent keys cost, read off the generated installer

An enumeration of the configuration is not an enumeration of the result. The
bundler expands the missing keys into empty defines in
`target/release/nsis/x64/installer.nsi`, and those have visible consequences:

- **Both installers carry the stock NSIS icon.** `installer.nsi:41`
  `INSTALLERICON ""` and `:44` `UNINSTALLERICON ""`. `MUI_ICON` and `MUI_UNICON`
  are only defined inside `!if "${INSTALLERICON}" != ""` (`:125-127`) and
  `!if "${UNINSTALLERICON}" != ""` (`:152-154`), so neither is ever defined and
  no `icon.ico` payload is present in either installer. This is **separate from**
  the `.ico` defect in §6: that fix made the bundle build and gave the installed
  `vela.exe` its icon; the installer and uninstaller executables a user
  double-clicks still show the generic NSIS icon.
- **No publisher links in Add/Remove Programs.** `COPYRIGHT ""`, `HOMEPAGE ""`
  and `LICENSE ""` mean no `URLInfoAbout`, no `HelpLink`, no `URLUpdateInfo`, no
  licence page in the installer, and no copyright string. Combined with §2's
  unsigned binary, a user inspecting this app in Settings finds a publisher
  string of `vela` and nowhere to go.

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
  offline-first product.
- **On download failure the install aborts; it does not degrade.** This is
  visible in the generated script rather than inferred: `installer.nsi:55` sets
  `INSTALLWEBVIEW2MODE "downloadBootstrapper"`, and the two failure paths under
  it, `:561` and `:593`, both do `Abort "$(webview2AbortError)"`. So an offline
  machine without WebView2 does not get a partly working Vela or a Vela that
  explains itself later — it gets an installer that stops and rolls back.
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

## 7. The installer was run — inside a container, which is not the machine

> **Read §12 before this section.** Every process in the session that produced
> this record was a descendant of an MSIX-packaged host, and the install landed
> in that package's private file and registry namespace. **Vela was never
> installed on the user's machine.** The properties of the *installer* recorded
> below are real and were measured. The conclusion "a user now has Vela
> installed" is **not** established, and an earlier revision of this document
> asserted it.

```
> Start-Process Vela_0.1.0_x64-setup.exe -ArgumentList "/S" -Wait
installer exit code = 0
```

Run from a **non-elevated** shell — `IsInRole(Administrator)` returned `False`
— and no UAC prompt appeared. That is the direct evidence for §5's claim that
the NSIS installer needs no administrator rights. It is also the one class of
claim this environment cannot corrupt: the installer either demanded elevation
or it did not, and it did not.

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
  this machine**, and installing ours **took its shortcuts away**. See below;
  this is the one place this document previously claimed more than it had
  checked.

### The install damaged another application's shortcuts

An Electron app also called Vela (version 1.1.0, `CompanyName: GitHub, Inc.`,
188,790,272 bytes) was already installed at `%LOCALAPPDATA%\Programs\vela`.

An earlier revision of this document said "the existing app was verified
untouched". **That sentence was false, and the way it was false is worth more
than the fact.** What was actually checked was the incumbent's *install
directory*, which is indeed untouched — the two apps install to different paths
(`%LOCALAPPDATA%\Vela` versus `%LOCALAPPDATA%\Programs\vela`) and its 188 MB of
files are all still there. The verification was scoped to the one place the
damage was not.

The damage is in the shortcuts, which are shared namespace, not per-app:

```
C:\Users\User\Desktop\Vela.lnk
    CreationTime  8/7/2026 1:23:16 AM      LastWriteTime 8/15/2026 5:36:42 PM
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Vela.lnk
    CreationTime  8/7/2026 1:23:16 AM      LastWriteTime 8/15/2026 5:36:42 PM
```

Both pre-dated this install by eight days and were rewritten at the exact
moment of it. Both now point at `C:\Users\User\AppData\Local\Vela\vela.exe`. A
sweep of the Desktop and of both the per-user and all-users Start Menus finds
**no shortcut anywhere still targeting** `%LOCALAPPDATA%\Programs\vela\Vela.exe`.
The incumbent is still installed, still 188 MB, still has its own `Vela 1.1.0`
uninstall entry — and is no longer reachable from any shortcut on this machine.

The mechanism is in the generated installer, not in anything Vela configures.
`installer.nsi:925` and `:901` both use a bare `CreateShortcut`:

```
CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
```

`CreateShortcut` overwrites unconditionally. There is no existence check and no
"is this someone else's shortcut" check; the only guard above it is a migration
path for *our own* previously named binary.

It compounds on the way out. `installer.nsi:793-798` has the uninstaller delete
`$DESKTOP\Vela.lnk` **if it targets our exe** — which, after the overwrite, it
does. So uninstalling Vela deletes a shortcut that belonged to a different
application, and the incumbent's shortcut is gone one-way: our installer does
not restore what it replaced.

**This is recorded, not fixed.** It cannot be fixed from configuration:
overwriting is the behaviour of Tauri's generated NSIS script. The real finding
is the general one — **shipping under a `productName` that another installed
application already uses silently annexes its shortcuts**, and "Vela" is not a
distinctive name.

### The shortcut damage is real, and worse than the rest of the install

This is the one part of the install that was **not** contained (§12). The two
`.lnk` files resolve to the user's actual profile:

```
C:\Users\User\Desktop\Vela.lnk
    -> \\?\C:\Users\User\Desktop\Vela.lnk                       REAL
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Vela.lnk
    -> \\?\...\Start Menu\Programs\Vela.lnk                     REAL
```

while their new target does not:

```
C:\Users\User\AppData\Local\Vela\vela.exe
    -> \\?\C:\Users\User\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Vela\vela.exe
```

So the install wrote **real shortcuts pointing at a path that does not exist
outside the container**. For the user, both shortcuts were silently retargeted
away from a working 188 MB application to something that cannot resolve — and a
dead `.lnk` fails with a generic Windows "cannot find" dialog naming a path the
user never chose and cannot find, with nothing identifying Vela as the cause.
The uninstaller would not repair it either: per `installer.nsi:793-798` it
deletes the shortcut rather than restoring what was there.

The shortcuts were read, never modified, by this document. They have since been
repointed at the user's other application by the coordinator.

Both apps would also have appeared as "Vela" in the installed-programs list —
except that ours never reached it (§12).

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
user" for the running application.** Nor, as it turns out, for the installed
one (§7, §12). The finding was established without a single destructive launch.

### What the "unchanged" evidence for that directory is actually worth

Throughout this work, `%APPDATA%\dev.vela.desktop` was enumerated before and
after each step and reported byte-for-byte and timestamp-for-timestamp
identical, with its ACL entry count unchanged. Those are two different
measurements and they are not worth the same.

**The enumeration of children was made through the container's merged view, and
most of what it compared was not the user's data.** The ACL entry count is a
property of the directory object itself, which is real, and that measurement
stands — see the single-handle check below. Resolving each entry with
`GetFinalPathNameByHandle` (§12):

```
REAL       %APPDATA%\dev.vela.desktop            <- the directory falls through
REAL       %APPDATA%\dev.vela.desktop\skills
CONTAINER  %APPDATA%\dev.vela.desktop\diagnostics
CONTAINER  %APPDATA%\dev.vela.desktop\diagnostics\exchanges.jsonl
CONTAINER  %APPDATA%\dev.vela.desktop\vela.db
CONTAINER  %APPDATA%\dev.vela.desktop\vela.db-wal
CONTAINER  %APPDATA%\dev.vela.desktop\vela.db.pre-cleanup-20260815
```

The directory is real and merges; individual entries inside it do not all
resolve the same way. So "the database is unchanged" describes a **container
copy of the database**, and the user's real one was never visible from here.

This does not mean anything was damaged. Nothing in this work launched Vela or
wrote to that path, and the installer demonstrably does not touch it. But the
*evidence offered* was weaker than the sentence it was offered for, in exactly
the way §7's install claim was — and it is corrected here rather than left
standing because it happened to reach a reassuring conclusion.

What follows from this is narrower than an earlier revision claimed. It follows
that **an enumeration of that directory's children is a merged view, and a file
read out of it may be a container copy.** It does **not** follow that
measurements of the directory object itself are invalid, and an earlier
revision of this document said it did — an over-correction that told another
track its central measurement was worthless when it is in fact sound.

**The directory's own security descriptor is real, and a measurement of it
stands.** Verified by opening a *single* handle and reading both the kernel's
final path and the security descriptor through that same handle, so no re-open
could substitute a different object:

```
kernel final path : \\?\C:\Users\User\AppData\Roaming\dev.vela.desktop   <- REAL
SDDL via THIS handle == (Get-Acl <same path>).Sddl : True
ACE count : 6
```

A handle that resolves to the real object is a handle on the real object, and
everything read through it — owner, group, DACL — is real.

**That covers the root directory and nothing else.** `fix/appdata-owner-only`
is hardening this ACL, and the honest scope of the reassurance is one clause:
**its measurement of this directory's own ACL is unaffected; its measurements
of the children inside it are not.** An earlier revision of this document said
its measurements were "unaffected by anything in this section", which is
broader than the data licenses.

The nine objects recorded in that track's
`docs/desktop-gate/evidence/appdata-root-acl/real-appdata-before.txt` were each
resolved:

```
REAL       <root dev.vela.desktop>          REAL       skills
CONTAINER  diagnostics                      CONTAINER  vela.db
CONTAINER  vela.db-shm                      CONTAINER  vela.db-shm.pre-cleanup-20260815
CONTAINER  vela.db-wal                      CONTAINER  vela.db-wal.pre-cleanup-20260815
CONTAINER  vela.db.pre-cleanup-20260815

REAL=2  CONTAINER=7   (of 9)
```

**Seven of the nine are objects this section says cannot be trusted.** The
second entry is the sharp one: `diagnostics` is recorded there with
`AreAccessRulesProtected : True` and annotated as hardened by an earlier fix,
and `diagnostics` resolves into the container — so that particular hardening
evidence may describe a container copy rather than the user's directory. This
has been routed to that track directly, because it is a finding for them rather
than a footnote here.

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

### The clippy gate reaches Vela's code, and carries exactly the two known errors

Running the gate as CI runs it, under the pin, in this worktree:

```
$ cargo clippy --workspace --all-targets -- -D warnings
error: unnecessary closure used to substitute value for `Option::None`
   --> crates\vela-sandbox\src\host.rs:709:23
    = help: ...#unnecessary_lazy_evaluations
error: useless use of `format!`
  --> crates\vela-sandbox\src\paths.rs:39:49
    = note: `-D clippy::useless-format` implied by `-D warnings`
error: could not compile `vela-sandbox` (lib) due to 2 previous errors
EXIT=101
```

Two errors, both in `vela-sandbox`, which belongs to the process-limit builder.
That is the known-red state, unchanged. This branch adds nothing to it: it
contains no Rust source, and the pinned toolchain is a byte-identical compiler
to the one previously in use (hashes above).

### A failure recorded as unreproducible

An earlier run of this same command in this same worktree died differently —
before reaching Vela's code, on a third-party dependency:

```
error[E0277]: `DatetimeParseError` doesn't implement `std::fmt::Display`
  --> ...\toml_datetime-0.7.5+spec-1.1.0\src\datetime.rs:769:28
error[E0277]: `SerializerError` doesn't implement `std::fmt::Display`
  --> ...\toml_datetime-0.7.5+spec-1.1.0\src\ser.rs:37:28
error[E0277]: `SerializerError` doesn't implement `std::fmt::Display`
  --> ...\toml_datetime-0.7.5+spec-1.1.0\src\ser.rs:80:18
error: could not compile `toml_datetime` (lib) due to 3 previous errors
```

**It does not reproduce.** Two consecutive re-runs of the identical command in
the identical tree both compiled `toml_datetime` without complaint and went on
to the two `vela-sandbox` lints above. Zero `E0277` in either.

An explanation offered for it in an earlier draft of this document was **wrong**
and is retracted here rather than quietly deleted. That draft said
`--all-targets` unified features such that `toml_datetime` was built "without
the feature that provides its `Display` impls". There is no such feature. Read
from the source on disk:

- `impl fmt::Display for DatetimeParseError` — `src/datetime.rs:754`, no `cfg`
- `impl core::fmt::Display for SerializerError` — `src/ser.rs:27`, no `cfg`

Both are unconditional. Only `impl std::error::Error` is gated
(`#[cfg(feature = "std")]`, `datetime.rs:768`). So no feature combination can
produce the error that was observed, and the mechanism claimed was impossible.

What has been ruled out:

- **The lockfile.** `toml_datetime 0.7.5+spec-1.1.0` is the locked version and
  no run modified `Cargo.lock`.
- **The toolchain pin.** Removing it would select `stable`, whose `rustc.exe`
  and `cargo-clippy.exe` are byte-identical to the pinned toolchain's. And
  empirically the pinned tree now yields the same two `vela-sandbox` errors that
  an unpinned tree yields, so the pin is inert for clippy as well as for `fmt`.
- **A partially extracted or concurrently rewritten crate source.** Every file
  under `toml_datetime-0.7.5+spec-1.1.0` carries `LastWriteTime`
  `2026-08-13 13:02:40` — untouched hours before the failing run — and the
  `.cargo-ok` completion marker is present.
- **A warm/stale target directory as the *necessary* condition.** The re-runs
  that succeeded used the same warm target directory as the run that failed.

**The cause is not established.** The failing run started at 17:40:40 on a
machine that, within the preceding thirty minutes, had already produced two
other pressure-induced failures that were not what they looked like — an MSVC
`C1056` from a Defender file-lock race, and a rustc OOM caused by a pagefile
that could not grow because the disk was nearly full (§6). A third transient
artifact of the same conditions is the most plausible reading, but it is a
hypothesis and nothing here establishes it. Recorded as unreproducible, because
an unreproducible failure written down as unreproducible is useful and one
quietly dropped is not.

One consequence for CI, recorded because nobody will connect it later
otherwise: the three jobs in `.github/workflows/ci.yml` use
`dtolnay/rust-toolchain@stable`, and a `rust-toolchain.toml` takes precedence
over `rustup default`. Those jobs should therefore resolve **1.97.1** rather
than whatever `stable` is on the day, with rustup downloading it on each run.
That is the intended effect of pinning — but **CI was not run, so this is a
prediction, not a measurement**, and it is the one forward-looking claim in this
document. The workflow file was not edited, because
`src/platform/verify-covers-ci.test.ts` reads it and belongs to another builder.

---

## 10. What this document does not establish

- **The installed application, on a real machine.** The install landed inside an
  MSIX container and is absent from the user's filesystem and registry — §12.
  Every statement here about "the installed app" describes files and registry
  entries in a private namespace, except the two shortcuts, which are real and
  were damaged.
- **The running application.** Never launched — §8. Everything here about the
  installed app describes files, registry entries and shortcuts, not observed
  behaviour of the program.
- **The contents of the user's real `%APPDATA%\dev.vela.desktop`.** Never
  visible from this environment — §8, §12.
- **The no-WebView2 install path.** This machine has the runtime — §4.
- **The SmartScreen dialog.** Not reproduced; a locally built file carries no
  Mark-of-the-Web and the install was silent — §2.
- **The MSI actually installing.** Built and inspected; not run, because it
  requires administrator rights — §7.
- **Whether the installers work on any machine other than this one.** One
  machine, one architecture (`x86_64-pc-windows-msvc`), one Windows version.
- **Uninstall, as a behaviour.** `uninstall.exe` was produced and never
  executed, so whether it removes cleanly is unknown. What its "Delete app
  data" checkbox *does* is no longer unknown — it is established by reading the
  generated script, and recorded in §11 rather than left as a question.

`docs/architecture/conventions.md` lists `pnpm tauri build` (with bundling) as
"not attempted". That entry sits under its §10 heading, which scopes the whole
table to what was "built and verified on a headless Linux container" — so it
remains true **of that environment** and is not stale. This document adds the
Windows answer it never claimed to have. The file was not edited.

---

## 11. What the uninstaller does to the user's data

Established **by reading the generated `installer.nsi` only**. The uninstaller
was not run, and nothing below is an observation of it running.

When the "Delete app data" checkbox on the uninstall confirmation page is
ticked, and the run is not an update, `installer.nsi:818-833` does:

```
SetShellVarContext current
RmDir /r "$APPDATA\${BUNDLEID}"
RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
```

with `:48` defining `BUNDLEID "dev.vela.desktop"`. So it recursively deletes
**both** `%APPDATA%\dev.vela.desktop` — the conversation database, the skill
store and the diagnostics log — and `%LOCALAPPDATA%\dev.vela.desktop`, which is
where the WebView2 user-data directory lives. `SetShellVarContext current`
scopes it to the uninstalling user. It also clears the installer's own registry
keys under `HKCU`.

**That path is real** (§12): `%APPDATA%\dev.vela.desktop` resolves to
`\\?\C:\Users\User\AppData\Roaming\dev.vela.desktop`, not into the container.
So this is not a hypothetical about a sandbox — an uninstaller running on a
user's machine with that box ticked deletes their genuine conversation
database, skill store and diagnostics log. What exactly a *container-scoped*
uninstall would destroy is undetermined, because the directory merges while
several entries inside it are container copies. **No uninstall of either kind
was run, and none should be run to find out.**

Two things a reader should not over-read:

- **The checkbox is the only thing standing between a user and their entire
  conversation history.** It is on the uninstall confirmation page, and this
  document does not know what it defaults to, because the page was never shown.
- **A silent uninstall does not delete data.** `$DeleteAppDataCheckboxState` is
  assigned in exactly one place, `:454`, by a `SendMessage ... BM_GETCHECK`
  against the checkbox control in the confirmation page's show handler. In `/S`
  mode that page never runs, so the variable keeps its zero-initialised value
  and the `${If} $DeleteAppDataCheckboxState = 1` guard at `:820` is false.
  **Untested** — no uninstall of either kind was performed.

---

## 12. The environment invalidated part of this record

Every process that produced this document was a descendant of an MSIX-packaged
host application, which gives its descendants a private, redirected view of the
filesystem and registry. **An install performed from inside it does not land on
the machine**, and nothing on disk advertises this: the redirection is a
bind-filter path mapping, not a reparse point, so directory listings, file
attributes and `fsutil reparsepoint` all look ordinary.

### The check that settles it

`GetFinalPathNameByHandle` on an open handle returns the true backing path. If
it resolves under `…\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\`,
the object is container-only. Measured from inside:

```
CONTAINER  %LOCALAPPDATA%\Vela              -> ...\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Vela
CONTAINER  %LOCALAPPDATA%\Vela\vela.exe     -> ...\LocalCache\Local\Vela\vela.exe
REAL       %LOCALAPPDATA%\Programs\vela     (the incumbent Electron app)
REAL       %LOCALAPPDATA%\dev.vela.desktop
REAL       C:\Users\User\Desktop\Vela.lnk
REAL       %APPDATA%\Microsoft\Windows\Start Menu\Programs\Vela.lnk
REAL       C:\Users\User\vela-wt-bundle\...  (the worktree)
REAL       %TEMP%
```

Confirmed independently from two vantage points **outside** the container — a
Task Scheduler job and a WMI `CIM_DataFile` query serviced by `WmiPrvSE.exe` —
each carrying a planted control proving the vantage could tell a container-only
file from a real one. From outside, `%LOCALAPPDATA%` contains
`dev.vela.desktop` and `vela-updater` and **no `Vela` directory at all**.

**Registry too.** Every `HKCU` write in this session is container-only. Read
from the real hive outside, `HKCU\…\Uninstall\Vela` does not exist, and neither
does any HKLM equivalent. So §7's uninstall entry — `DisplayName: Vela`,
`Publisher: vela` — would never appear in the user's Settings → Installed apps.

### What this costs, and what survives

Withdrawn: **the installed application never reached a user.** `%LOCALAPPDATA%\Vela\vela.exe`
exists only in a namespace that disappears with the container. B2 therefore has
**no `reaches-user` grade for the installed app**, on top of having none for the
running app (§8).

Standing, because these are properties of the installer rather than of where
its output landed: it runs to completion and exits 0; it requires no elevation;
it targets `%LOCALAPPDATA%` with `HKCU`-only registration; it creates the
shortcuts; it writes a binary differing from the compiler's output by exactly
the 3-byte provenance marker. And §6 is untouched — the `.ico` defect, the
build failure, the fix, and both artifacts are files in the worktree, which is
real.

**The installer is not broken. The measurement was.** Nothing here is evidence
against the bundle.

### The rule, and its limit

The pattern the evidence supports is that a top-level name which already
existed falls through to the real location, while one first created inside the
session is captured. It is **not** that simple one level down:
`%APPDATA%\dev.vela.desktop` is real as a directory, yet `vela.db`,
`vela.db-wal` and `diagnostics` inside it resolve into the container while
`skills` does not (§8).

**Some directories merge and some do not.** `skills` and `diagnostics` are both
directories, both immediate children of the same real parent, and they resolve
opposite ways — `skills` real, `diagnostics` container. Neither is a reparse
point; both report `Attributes=Directory` and nothing more. An earlier revision
of this section said "directories merge; individual files do not uniformly
follow their parent", which is refuted by `diagnostics` and would lead a reader
to conclude that `diagnostics` is real. Two samples looked like a rule and were
not.

The precise capture rule was not determined and should not be guessed at:
**probe the exact path you care about**, and do not infer a child's status from
its parent's, its siblings', or whether it is a file or a directory.

**For any future verification on this machine: resolve the path with
`GetFinalPathNameByHandle` before believing a filesystem or registry
observation.** Two findings in this document — the install and the
"unchanged" data directory — were verifications aimed at a vantage that could
not see the object they were about. This is the same class as §8's
`SHGetKnownFolderPath` result: an environment fact that silently invalidates a
measurement while every command still exits 0.

---

## 13. The bundle is now a gate, not a paragraph

Added on branch `track/t01-release-path`, against tag `run-start-2026-08-17`
(`c0feb93`). Sections 1 to 12 above record a bundle that was *built once and
written down*. Nothing in the repository asked for it again. That is the same
shape as every other defect in this file: the fact was true and the check for it
was prose, so the next person to break `bundle.icon` would find out the way the
last one did.

### What runs now

`pnpm bundle` (`scripts/bundle.mjs`) takes a sentinel timestamp, drives
`pnpm tauri build`, and then reads the disk — and it runs the disk check
**whether or not the bundler exited 0**, because the two failures it exists to
separate are exactly the two that `&&` merges: a bundler that fails after
producing good installers, and a bundler that succeeds having produced none.
`.github/workflows/ci.yml` runs it in a new `bundle` job on `windows-latest`.

`scripts/check-bundle.mjs` is the check. It derives the expected target set from
`tauri.conf.json` rather than hardcoding it, and for each declared target
demands a file that exists, clears a size floor, carries the format's magic
bytes, **carries the installer format's own signature where the magic is not
specific enough**, carries the configured version in its name, and is newer than
the sentinel. `bundle.active: false`, an empty target list, and an unrecognised
platform are all **refusals**, not passes. The header of that file lists the
progressively weaker checks and the specific broken tree each one lets through;
`src/platform/bundle-guard.test.ts` builds one synthetic tree per step and proves
the guard fails it.

The signature clause is a round-2 correction and not a flourish. `MZ` — the
original NSIS test — says "PE image", and `target/release/vela.exe` is a PE
image: copied into `bundle/nsis/` under the setup's name it produced
`OK ... NSIS setup (PE image)`, `BUNDLE_OK=yes`, exit 0. The guard now demands
`EF BE AD DE` + `NullsoftInst` somewhere in the file — all sixteen bytes, which
in the real setup occur exactly once, beginning at offset **52,740**, and in
`vela.exe` nowhere at all. Neither half would do: `NullsoftInst` alone begins
four bytes later at 52,744, and `EF BE AD DE` alone occurs twice, first at
9,732. Round 2 wrote 52,744 for the whole sequence at seven sites in five
files; see
`docs/corrections.md`, 2026-08-21 round 3, entry 1, and round 2, entry 2.

### The run on this branch

A ROUND-1 CAPTURE, AND ITS `check-bundle` LINES ARE NOT WHAT THE GUARD PRINTS
TODAY. The block below is the transcript of the `pnpm bundle` run that produced
the artefacts in the table under it, taken in round 1 and kept as the record of
that run. Its second half must not be read as current output. The nsis detail
string was `NSIS setup (PE image)` then and is
`NSIS setup (PE image carrying an NSIS payload)` now, because round 2 added the
first-header check and the wording follows it; the gap between `OK` and the
filename is 13 spaces there against the 17 that `row.verdict.padEnd(18)` in
`check-bundle.mjs` produces; and the guard's framing lines around the rows have
changed too. Re-running only the disk-reading half today, against the same
artefacts on disk, gives:

```
check-bundle: C:\Users\User\vela-t01\src-tauri\target\release\bundle
check-bundle: expecting msi, nsis for version 0.1.0
  OK                 Vela_0.1.0_x64_en-US.msi  7360512 bytes, MSI (OLE2 compound file)
  OK                 Vela_0.1.0_x64-setup.exe  5444437 bytes, NSIS setup (PE image carrying an NSIS payload)
check-bundle: every declared target produced an installer.
BUNDLE_OK=yes
CHECK_BUNDLE_EXIT=0
```

The round-1 capture, unedited:

```
bundle: sentinel 2026-08-20T20:21:06.060Z
    Running light to produce ...\bundle\msi\Vela_0.1.0_x64_en-US.msi
    Running makensis to produce ...\bundle\nsis\Vela_0.1.0_x64-setup.exe
BUNDLER_EXIT=0

=== the disk, not the exit code ===
check-bundle: expecting msi, nsis for version 0.1.0
  OK             Vela_0.1.0_x64_en-US.msi  7360512 bytes, MSI (OLE2 compound file)
  OK             Vela_0.1.0_x64-setup.exe  5444437 bytes, NSIS setup (PE image)
BUNDLE_OK=yes
BUNDLE_EXIT=0
```

| Artifact | Bytes | SHA-256 | Signature |
| --- | ---: | --- | --- |
| `target/release/bundle/msi/Vela_0.1.0_x64_en-US.msi` | 7,360,512 | `9E76FCE179362BEE718ED3274284649C5D67FC0EC800C4AAC9A916244FA7BDBD` | NotSigned |
| `target/release/bundle/nsis/Vela_0.1.0_x64-setup.exe` | 5,444,437 | `1DBA7E65304BB79EA56A1D425287D4EEBBB58147D11C8AB8064DBD8122BB24A2` | NotSigned |
| `target/release/vela.exe` | 18,095,104 | — | NotSigned |

Byte counts differ from section 6's; that is a different build of a moved tree
and no conclusion is drawn from the difference. **Signing posture is unchanged
and is unchanged deliberately: all three are `NotSigned`, there is no signing
configuration anywhere in the tree, and this branch adds none.** Section 2
stands in full. Nothing here is gated on signing, because a gate on signing
would fail every run until somebody buys a certificate.

Updater posture is likewise unchanged: section 3 stands. **`pnpm bundle`
therefore does not and cannot verify an update path**, and no claim about one is
made below.

### 13a. Install, update and uninstall were NOT verified, and here is the check

They could not be, and the reason is section 12's, re-measured on this branch
rather than taken on trust. `scripts/check-real-path.ps1` turns section 12's
closing instruction — "resolve the path with `GetFinalPathNameByHandle` before
believing a filesystem observation" — into something that runs. It carries its
own control: it builds a directory and a junction to it and asks for the
junction's final path, so a reader that merely echoed its argument reports **NO
VERDICT** rather than a clean bill of health.

```
CONTROL  junction -> \\?\C:\Users\User\AppData\Local\Temp\vela-finalpath-control-34268\target
CONTROL  PASS  the reader answers with the junction's TARGET, so it resolves backing storage.

VERDICT     PATH  ->  BACKING PATH
REAL        %APPDATA%\dev.vela.desktop                ->  ...\AppData\Roaming\dev.vela.desktop
CONTAINER   %APPDATA%\dev.vela.desktop\vela.db        ->  ...\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\dev.vela.desktop\vela.db
CONTAINER   %APPDATA%\dev.vela.desktop\diagnostics    ->  ...\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\dev.vela.desktop\diagnostics
REAL        %APPDATA%\dev.vela.desktop\skills         ->  ...\AppData\Roaming\dev.vela.desktop\skills
CONTAINER   %LOCALAPPDATA%\Vela                       ->  ...\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Vela
CONTAINER   %LOCALAPPDATA%\Vela\vela.exe              ->  ...\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Vela\vela.exe
REAL        C:\Users\User\Desktop\Vela.lnk            ->  ...\Desktop\Vela.lnk
REAL        %APPDATA%\...\Start Menu\Programs\Vela.lnk  ->  ...\Start Menu\Programs\Vela.lnk

container-only paths  4
exit 1
```

This independently reproduces section 12, including the part section 12 warned
must not be guessed at: `skills` and `diagnostics` are sibling directories under
the same **real** parent and resolve opposite ways.

So: **`vela.db` and `diagnostics\` cannot be shown to resolve to real user paths
from this session, because from this session they do not.** That is not a
statement about the product. It is a statement about the vantage, and it is why
no install was performed here.

**The installer was deliberately not run, and that was a decision rather than an
omission.** Two reasons, in order of weight:

1. It would have produced no new knowledge. The install lands in the container
   (rows 5 and 6 above), which is precisely the measurement section 12
   withdrew. Repeating it would add a second void observation to a document that
   already has one.
2. It would have done real damage on a real path. Section 7 records that
   installing Vela **took the shortcuts of an unrelated third-party application
   called "Vela" away**, and rows 7 and 8 above show those shortcut paths are
   REAL — they escape the container even though the install does not. Measured
   on this branch before deciding: `C:\Users\User\Desktop\Vela.lnk` and the
   Start Menu entry currently both target
   `C:\Users\User\AppData\Local\Programs\vela\Vela.exe`, the incumbent
   application. They are correct right now. Running the installer to learn
   nothing, at the cost of breaking them again, is not a trade worth making.

There is also nothing named `backups` to check. A search of all 167 `.rs` files
under `src-tauri/` (excluding `target/`) finds no `backups` directory, no backup
path constant and no backup routine. The string `backup`, case-insensitively,
occurs 21 times on 18 lines in six files, and every one of them is something
else:

| file | occurrences | what they are |
| --- | --- | --- |
| `vela-providers/examples/gate_m_phase_b2.rs` | 12 | a mock server and provider candidate named `backup` in a failover example |
| `vela-projects/src/link.rs` | 3 | `FILE_FLAG_BACKUP_SEMANTICS`, the Win32 flag for opening a directory handle |
| `vela-projects/src/workdir.rs` | 2 | a comment about a sibling directory whose name starts with the workdir’s, plus the test fixture it describes |
| `vela-settings/src/service.rs` | 2 | doc-comment prose: settings are "backup-able", credentials are "never in a backup of the database" |
| `vela-privatefs/src/lib.rs` | 1 | prose describing the `.pre-cleanup-` rename |
| `vela-store/src/location.rs` | 1 | the same `.pre-cleanup-` rename, from the other side |

Vela does not write backups today. Round 3 gave this count as 34 and named
neither `vela-settings/src/service.rs` nor `vela-store/src/location.rs`;
`docs/corrections.md`, round 4, entry 3.

**Re-run on 2026-08-21, in round 2, before deciding again.** Same script, same
verdicts, same order: `CONTROL PASS`, then REAL / CONTAINER / CONTAINER / REAL
for the four `%APPDATA%\dev.vela.desktop` rows, CONTAINER for both
`%LOCALAPPDATA%\Vela` rows, REAL for both `Vela.lnk` paths — `container-only
paths 4`, exit 1 read from the script's own output. The decision not to install
therefore stands on a measurement taken twice, a day apart, and not on the
memory of one. Row 6 is the operative one: the NSIS setup installs into
`%LOCALAPPDATA%\Vela`, which resolves inside the package container, so an
install performed from this session would put the application somewhere the
user's machine does not have — and the resulting "it installed" would be the
third void observation in this document. That the setup targets that directory
is not inferred from section 7's transcript alone: the generated
`target/release/nsis/x64/installer.nsi` sets `StrCpy $INSTDIR
"$LOCALAPPDATA\${PRODUCTNAME}"`, and `PRODUCTNAME` is `Vela`.

**The honest verdict for the installed application is unchanged from section 12:
there is none.** `ships` requires an install on a machine this session cannot
reach.

### 13b. The Rust tail is now proved by an artefact rather than an exit code

`cargo build` does not compile `tests/`; only `cargo test` does. That claim was
measured on this workspace rather than assumed:

```
$ cargo clean -p vela-store            # removed durability-f80bb87ad6590b36.{d,exe,pdb}
$ cargo build -p vela-store            # BUILD_P_EXIT=0
  durability-* after cargo build : count=0
$ cargo test -p vela-store --no-run    # TEST_NORUN_EXIT=0
  Executable tests\durability.rs (target\debug\deps\durability-44e26e9e472d07ec.exe)
  durability-* after cargo test : count=3
```

`scripts/check-rust-tail.mjs` enumerates every `tests/*.rs` in the workspace and
demands a matching binary in `target/debug/deps`. It read the tree red between
those two commands and green after the second, and it now runs in `pnpm verify`
and in both Rust CI jobs.

**It does not demand an age, and that is the correction rather than the design.**
Two freshness rules were written and both produced false reds on this
repository, each caught by running the thing rather than reasoning about it:

1. A wall-clock sentinel — `verify.mjs` passed the instant the run started. The
   first full ten-gate run came back all green, `cargo test --workspace
   --locked` exit 0 having genuinely executed the suite, and **all forty targets
   STALE**. Cargo is a build cache; nothing changed, nothing was relinked, no
   mtime moved.
2. The newest source in the workspace. `pnpm tauri build` rewrites
   `src-tauri/Cargo.toml` in place — identical bytes, new mtime — and four
   correct binaries were called stale against a file whose content nobody
   touched.

Both rules re-derive a decision cargo already makes, from a cruder signal than
cargo uses: cargo fingerprints content, not modification times. So the probe
answers "did the tail leave its artefacts" and the runner's gate ordering
answers "did the tail just run" — the probe is consulted only when the
`cargo test` gate has just passed, and reports `RUST_TAIL=NOT-REACHED`
otherwise. `--since` survives as an opt-in for a caller on a cold machine where
its premise holds; nothing in the repository passes it.

#### The evidence this section used to give, withdrawn

Round 1 of this branch printed the following here, introduced as "the final run,
with the corrected probe":

```
cargo-test                 PASS         0     168.2
RUST_TAIL=CONFIRMED
1 passed, 0 failed, 0 SKIPPED (skipped is not passed)
VERIFY_EXIT=0
```

**That was a one-gate run.** It was `node scripts/verify.mjs --from cargo-test`,
and the nine gates ahead of it were `NOT-RUN`: excluded from the counts on the
third line and from `VERIFY_EXIT` on the fourth, which is the defect section 13c
records and fixes. Presented under a ten-gate table, with no `VERIFY_EXIT` line
of its own, it read as a certification of the whole chain. It was not one.

The ten-gate table that followed it was also real and was also incomplete: it
carried no `VERIFY_EXIT` line at all. On the round-1 report's own account that
run ended at **1** — every gate green and the probe red, under the wall-clock
`--since` rule described above, which was withdrawn immediately afterwards for
exactly that false red. Both blocks were true statements about two different
runs, and putting them next to each other said something neither of them said.

Nothing is claimed from either any more. The run below replaces both.

#### The ten-gate run, in one process

One process, no `--from`, cargo prepended to PATH, on 2026-08-21. Every status
below is read from the log body; `VERIFY_EXIT` is the last line the runner
prints, on purpose, because a wrapper that ends in a reporting command reports
the reporting command.

A document cannot quote a run of itself, so the honest statement of scope is
this: every file in the repository was in its committed state when this run
started, and the only edit afterwards was writing this section.

One gate does read this document. Gate 8, `test:secrets`, runs `git grep` over
every tracked file: `scripts/secret-scan.sh` sets `excluded_paths=()`, so
nothing is excluded and `docs/` is scanned like anything else. These bytes are
therefore in that gate's input and its verdict depends on them. It reads them
for credential *shapes*, not for claims, and it passed over 1270 tracked files.
The gates that read prose for its content read other files: `check-transcripts.sh`
reads only `docs/regression-baseline/mock-matrix`, and the comment-claim guard
in `src/platform/claimed-guards.test.ts` has `CLAIM_ROOTS` of `src`, `src-tauri`,
`tests`, `scripts`, `.github`, `docs/architecture` and `docs/vela-progress.md`,
none of which contains this file. `pnpm test` was nevertheless re-run on the
exact committed bytes afterwards; the round-2 report carries that result.

```
GATE                       STATUS    EXIT   SECONDS
typecheck                  PASS         0      93.5
lint:rust                  PASS         0      30.6
test                       PASS         0     188.8
test:harness               PASS         0      40.3
test:click-harness         PASS         0      26.4
build                      PASS         0      93.1
test:transcripts           PASS         0      14.1
test:secrets               PASS         0     135.0
cargo-build                PASS         0      61.7
cargo-test                 PASS         0     281.6

RUST_TAIL=CONFIRMED

10 passed, 0 failed, 0 SKIPPED (skipped is not passed), 0 NOT-RUN (not-run is not passed either)
VERIFY_EXIT=0
```

What the four counted lines above are made of, from the same log:

| gate | what it reported |
| --- | --- |
| `test` | 122 files, 2445 tests, all passed |
| `test:harness` | 12 files, 142 tests |
| `test:click-harness` | 2 files, 41 tests |
| `test:secrets` | `no credential material found in 1269 tracked files (docs/ included)` |
| `cargo-test` | 65 `test result: ok` lines, zero `test result: FAILED` |
| the probe | `all 40 integration test targets have a compiled binary`, and `age demand: (nothing: no age is demanded ...)` |

**The run before it ended at 101, and that is on the record too.** The identical
tree, twenty minutes earlier, gave nine gates green and `cargo-test FAIL 101`:
two tests in `crates/vela-endpoint/tests/dual_endpoint_over_a_real_socket.rs`
panicked with `Os { code: 10053, kind: ConnectionAborted }` while binding real
loopback sockets. That file is unchanged since well before tag
`run-start-2026-08-17` and nothing on this branch touches Rust. Re-running that
target alone twice gave `12 passed; 0 failed` and then `11 passed; 1 failed` on
a **different** test — the same socket abort, a different name each time, which
is what a loaded machine does to a suite that binds ports and not what a defect
does. It is recorded rather than suppressed: the flake is real, it is not this
branch's, and a reader who hits it should know it is known.

#### The round-3 run, and the flake before it

Round 3 changed comments, two fixture constants, two test files and this
document; no product code and no script logic. The ten gates were run again, one
process, no `--from`, cargo prepended, on 2026-08-21. Same scope statement as
above: every file was in its committed state when the run started and the only
edit afterwards was writing this subsection, which no gate reads.

```
GATE                       STATUS    EXIT   SECONDS
typecheck                  PASS         0      64.8
lint:rust                  PASS         0      22.6
test                       PASS         0     103.4
test:harness               PASS         0      11.7
test:click-harness         PASS         0       9.8
build                      PASS         0      77.2
test:transcripts           PASS         0       8.4
test:secrets               PASS         0      95.3
cargo-build                PASS         0      35.9
cargo-test                 PASS         0     210.9

RUST_TAIL=CONFIRMED

10 passed, 0 failed, 0 SKIPPED (skipped is not passed), 0 NOT-RUN (not-run is not passed either)
VERIFY_EXIT=0
```

| gate | what it reported |
| --- | --- |
| `test` | 122 files, 2447 tests, all passed — two more tests than the run above, which are the two this round added |
| `test:harness` | 12 files, 142 tests |
| `test:click-harness` | 2 files, 41 tests |
| `test:secrets` | `no credential material found in 1270 tracked files (docs/ included)` |
| `cargo-test` | 65 `test result: ok` lines, zero `test result: FAILED` |
| the probe | `all 40 integration test targets have a compiled binary`, and `age demand: (nothing: no age is demanded ...)` |

**Two `pnpm test` reds either side of it, and that is on the record too.** The
attempt twenty minutes before this run gave `test FAIL 1` with the seven gates
behind it `SKIPPED` and `VERIFY_EXIT=1`. One test timed out:
`src/components/ModalSurface.test.tsx > ModalSurface contains Tab > leaves
nothing outside the dialog reachable in either direction`, `Test timed out in
5000ms`, `1 failed | 2446 passed (2447)`. A later `pnpm test`, run on its own
against the final bytes, went red the same way on a **different** test:
`src/features/navigation/Sidebar.test.tsx > Sidebar > resizes by keyboard
through the separator, and reports the width`, again `Test timed out in 5000ms`,
again `1 failed | 2446 passed (2447)`.

Neither file is changed since tag `run-start-2026-08-17` — last touched at
`aa33893` and `535f482` respectively, both 2026-08-14 — and nothing this round
touches either. Run alone, `ModalSurface.test.tsx` reported `Test Files 1 passed
(1)` / `Tests 8 passed (8)`, exit 0, three times out of three; `Sidebar.test.tsx`
reported `Test Files 1 passed (1)` / `Tests 15 passed (15)`, exit 0, three times
out of three. That file has fifteen tests, and round 3 printed its Test **Files**
line as though it were its Tests line; `docs/corrections.md`, round 4, entry 2.

**And what the isolated cost actually is.** Re-measured in round 4: three
consecutive whole-file runs of `npx vitest run
src/features/navigation/Sidebar.test.tsx --reporter=basic`, nothing else running
from this session, in which `resizes by keyboard through the separator` reported
956 ms, 926 ms and 941 ms. Vitest's default `testTimeout` is 5000 ms and
`vite.config.ts` sets no override, so those three costs are 19.1%, 18.5% and
18.8% of the budget. Three observations on one machine at one moment are not a
range and this section does not turn them into one — but they settle the
direction, and they settle it the other way from what round 3 wrote. This is not
a test sitting near its own ceiling on a quiet box. Whatever pushed it past 5000
ms in the full-suite run was the rest of the machine, not the test's own cost.
The failing logs say the same thing from that side: `Duration 156.73s` against
`environment 811.58s` and `setup 467.01s`, worker time far exceeding wall clock.
A different test name each time is what load does to a suite; a defect picks the
same one. Round 3 recorded 4535 ms and 90.7% in this paragraph, which three
separate sets of attempts — the round-3 critic's, the measurer's and this one's
— have failed to reproduce; `docs/corrections.md`, round 4, entry 5.

Recorded rather than suppressed, on the same principle as the `cargo-test` flake
above. Neither timeout was raised, because raising a timeout in a file this
branch does not own would hide the finding rather than fix it. **For whoever
owns those two files: the fix is an explicit per-test timeout with a stated
reason, the way `bundle-guard.test.ts` and `bundle-runner.test.ts` already carry
`SPAWN_TIMEOUT_MS`.** The reason to state is load, not the test's own cost: the
three isolated measurements above are 19.1%, 18.5% and 18.8% of the default
budget. A budget that is generous on an idle box is not generous on this one,
and the fix is to say so in the file rather than to hope. On the final bytes
`pnpm test` was re-run to completion and reported `122 files, 2447 tests, all
passed`, exit 0, read from the log body. A third file joined those two in round
4; the next subsection records it, and the advice above is meant for its owner
too.

#### The round-4 run: the same bytes five times, and what that settled

Round 4 changed comments in seven files, deleted one dead field from
`scripts/check-bundle.mjs`'s `--json` row, added one test, renamed one `describe`
block, and rewrote parts of this document and `docs/corrections.md`. No product
code. The ten gates were run **five times**, each in one process, no `--from`,
`C:\Users\User\.cargo\bin` prepended, every status read from the log body.

The runs fall into three trees that differ from one another only in comment
text. Runs 1 to 3 ran on the first, runs 4 and 5 on the second and third; the
executable files were sha256'd before and after each block and were identical
within it. What changed between the blocks, and why, is set out below. Run 5 is
on the bytes this round commits.

Five runs, three answers:

```
                     run 1        run 2        run 3    run 4    run 5
typecheck            PASS   0     PASS   0     PASS 0   PASS 0   PASS 0
lint:rust            PASS   0     PASS   0     PASS 0   PASS 0   PASS 0
test                 PASS   0     FAIL   1     PASS 0   PASS 0   PASS 0
test:harness         PASS   0     SKIPPED      PASS 0   PASS 0   PASS 0
test:click-harness   PASS   0     SKIPPED      PASS 0   PASS 0   PASS 0
build                PASS   0     SKIPPED      PASS 0   PASS 0   PASS 0
test:transcripts     PASS   0     SKIPPED      PASS 0   PASS 0   PASS 0
test:secrets         PASS   0     SKIPPED      PASS 0   PASS 0   PASS 0
cargo-build          PASS   0     SKIPPED      PASS 0   PASS 0   PASS 0
cargo-test           FAIL 101     SKIPPED      PASS 0   PASS 0   PASS 0

RUST_TAIL            NOT-REACHED  NOT-REACHED  CONFIRMED  CONFIRMED  CONFIRMED
passed               9            2            10         10         10
failed               1            1            0          0          0
SKIPPED              0            7            0          0          0
VERIFY_EXIT          101          1            0          0          0
```

The verbatim tail of run 5, the run this round commits:

```
GATE                       STATUS    EXIT   SECONDS
typecheck                  PASS         0      38.2
lint:rust                  PASS         0      53.2
test                       PASS         0      75.0
test:harness               PASS         0       4.1
test:click-harness         PASS         0       3.7
build                      PASS         0      19.9
test:transcripts           PASS         0       1.7
test:secrets               PASS         0      19.8
cargo-build                PASS         0      39.7
cargo-test                 PASS         0     170.9

RUST_TAIL=CONFIRMED

10 passed, 0 failed, 0 SKIPPED (skipped is not passed), 0 NOT-RUN (not-run is not passed either)
VERIFY_EXIT=0
```

**Run 1's red is the socket flake this section already records.**
`vela-endpoint`'s `dual_endpoint_over_a_real_socket`:
`a_streamed_anthropic_turn_arrives_as_the_documented_event_sequence` panicked
with `the endpoint must answer and close: Os { code: 10053, kind:
ConnectionAborted }`, `test result: FAILED. 11 passed; 1 failed`. The same target
re-run on its own three times immediately afterwards was `test result: ok. 12
passed; 0 failed` each time, exit 0 each time. Not this branch's code — nothing
in this round's diff is Rust — and not raised to a green by a resumed run,
because `--from` cannot report a clean run (§13c).

**Run 2's red is the load flake, and it named a third file.** `pnpm test`
reported `2 failed | 2446 passed (2448)`, both `Test timed out in 5000ms`:
`src/features/navigation/Sidebar.test.tsx > Sidebar > resizes by keyboard
through the separator` again, at 5171 ms, and
`src/app/staged-attachment-payload.test.tsx > a staged file reaches the payload >
puts a staged image in the outgoing chat_send request`, at 5236 ms — a file that
had not timed out before and that this branch does not touch either. That makes
four timeouts across this branch's runs, in three different files, none of them
files this branch touches. Run alone, three times out of three,
`staged-attachment-payload.test.tsx` reported `Test Files 1 passed (1)` / `Tests
8 passed (8)`, exit 0, with the test that timed out costing 1331 ms, 644 ms and
1193 ms of its 5000 ms — the same shape as `Sidebar.test.tsx` above. That is
what the paragraph above concludes, and this run is a third independent
observation of it on a third file.

Note also what run 2 does *not* say. Seven gates are `SKIPPED`, and `SKIPPED` is
not `PASS`: the runner counts the two separately and its summary line spells out
why, which is the behaviour §13c exists to document.

**What changed between run 3 and run 4.** Run 2 had just made a comment false.
The `SPAWN_TIMEOUT_MS` docblock in `bundle-guard.test.ts`, `bundle-runner.test.ts`,
`rust-tail.test.ts` and `verify-runner.test.ts` justified its 60-second ceiling
by pointing at "two `Test timed out in 5000ms` failures ... in two files this
branch does not touch". After run 2 that was four failures in three files.
Rather than move the number — this round exists because a moved number is how
the last two rounds failed — all four docblocks now carry no count at all and
point here, which is where the tally is kept and where a reader can check it.

**What changed between run 4 and run 5.** Two more numbers, both flagged by the
measurer as borderline and both fixed rather than argued: the `50-line` rationale
attributed to `src-tauri/rust-toolchain.toml` (58 lines, 53 of them comment), and
"eight `&&` links" in the `A GREEN cargo test IS NOT EVIDENCE` comment, in both
copies in `.github/workflows/ci.yml`. The tag's `verify` string carries ten `&&`
operators, nine of them ahead of `cargo build --workspace --locked`, and it is
not a shell string any more at all. The same paragraph in
`scripts/check-rust-tail.mjs`'s header was in the present tense about that chain
and is now in the past. `docs/corrections.md`, round 4, entry 7.

Both changes are comment or documentation text; neither touches a line any
runtime executes. Run 5 is the whole ten gates over the result.

**Runs 3, 4 and 5 are all clean, and run 5 is the record for this round.** They
reported the same numbers:

| gate | what it reported |
| --- | --- |
| `test` | 122 files, 2448 tests, all passed — one more than round 3's 2447, which is the `bytes` reader this round adds |
| `test:harness` | 12 files, 142 tests |
| `test:click-harness` | 2 files, 41 tests |
| `test:secrets` | `no credential material found in 1270 tracked files (docs/ included)` |
| `cargo-test` | 65 `test result: ok` lines, zero `test result: FAILED` |
| the probe | `all 40 integration test targets have a compiled binary`, and `age demand: (nothing: no age is demanded ...)` |

On `test:click-harness`: it does not launch Vela, and this is worth stating
because the name suggests otherwise. Its vitest project includes `**/*.test.mjs`
under `tests/harness/desktop-click/`, which resolves to `keys.test.mjs` and
`verdicts.test.mjs`. Neither imports `vela-drive.mjs` — the module that would
start the application — and `vela-drive.mjs` is not itself a test file. The gate
is 41 jsdom tests about key mapping and verdict parsing.

`test:secrets` reads tracked file contents, and this subsection was written after
the runs it describes. The scan was therefore re-run over the working tree with
this subsection in it, and reported the same all-clear over the same 1270 tracked
files, exit 0.

#### Round 5's run, and what changed under it

Round 5 changed the Rust-tail guard in ways a gate can see, and prose in ways
only a reader can. Seen by a gate: `scripts/check-rust-tail.mjs` lost the four
fields nothing read (`rows[].source`, `rows[].binary`, `binary.path`, and the
`result.ok` `main` refused to read), its MISSING detail gained the source path,
and its failure summary stopped saying "have no compiled binary" — which was
false of a STALE row — in favour of "are not BUILT; see the rows above". Three
tests were added — two for those changes, one for the `--json` row shape — which is
why `test` reports 2451 where round 4's runs reported 2448. Seen only by a
reader: five sentences the measurer found false, listed in `docs/corrections.md`,
round 5.

Two full runs, each one process, no `--from`, cargo prepended to PATH, on
2026-08-21. Run 1 was taken with the code and test changes in place and the
prose of this round half written; run 2 was taken on the bytes this round
commits, with only this subsection edited afterwards. Statuses and exit codes
are read from the log body, not from a reporting command. Run 2, the record:

```
GATE                       STATUS    EXIT   SECONDS
typecheck                  PASS         0      45.6
lint:rust                  PASS         0      13.9
test                       PASS         0      79.7
test:harness               PASS         0       6.8
test:click-harness         PASS         0       4.9
build                      PASS         0      61.8
test:transcripts           PASS         0       7.6
test:secrets               PASS         0      67.5
cargo-build                PASS         0      34.2
cargo-test                 PASS         0     192.9

RUST_TAIL=CONFIRMED

10 passed, 0 failed, 0 SKIPPED (skipped is not passed), 0 NOT-RUN (not-run is not passed either)
VERIFY_EXIT=0
```

| gate | what it reported |
| --- | --- |
| `test` | 122 files, 2451 tests, all passed — three more than the 2448 the round-4 runs reported, which are the three tests round 5 adds |
| `test:harness` | 12 files, 142 tests |
| `test:click-harness` | 2 files, 41 tests |
| `test:secrets` | `no credential material found in 1270 tracked files (docs/ included)` |
| `cargo-test` | 65 `test result: ok` lines, zero `test result: FAILED` |
| the probe | `all 40 integration test targets have a compiled binary`, and no MISSING or STALE row |

Run 1 reported the same ten PASS rows, the same `RUST_TAIL=CONFIRMED` and the
same `VERIFY_EXIT=0`, and every countable in the table above was identical to
run 2's. Only the SECONDS differed, and in both directions — run 1 was faster on
`build` (21.6 against 61.8) and slower on `typecheck` (56.8 against 45.6). No
rule is drawn from that: two observations of a shared machine under changing
load are two observations, and this document does not turn them into a range.
Neither run produced a `Test timed out in 5000ms` failure, so the flakes the
paragraphs above record did not recur — which is an observation, not a repair.

This subsection was written after the run it describes, and gate 8 reads it.
`scripts/secret-scan.sh` was therefore re-run over the working tree with this
subsection in it and reported the same all-clear over the same 1270 tracked
files, exit 0, as did `scripts/secret-scan.test.sh` at `15 passed, 0 failed`.

### 13c. How `pnpm verify` behaves when it cannot run everything

Two behaviours that a reader of section 13 would otherwise meet for the first
time in a transcript. Both were undocumented, and the first is why 13b's
headline evidence had to be withdrawn.

**`--from <id>` resumes, and cannot report a clean run.** A developer who has
fixed gate 2 can restart from it rather than paying for gate 1 again. The gates
before `<id>` are reported `NOT-RUN`. That is a fourth outcome alongside PASS,
FAIL and SKIPPED, and it is counted in the summary line and in the exit status:
a resumed run whose every executed gate passed exits **3**, never 0, and prints

```
INCOMPLETE: n of m gates were not run, because --from <id> started at gate k.
Every gate above ran and passed; this run does not certify the tree, and does
not claim to. Re-run without --from for that.
```

3 rather than 1 so that "a gate went red" stays distinguishable from "gates were
skipped". The first version excluded `NOT-RUN` from both the counts and the exit
code, which is how the withdrawn block below came to print `VERIFY_EXIT=0` over
nine gates it had never started. `src/platform/verify-runner.test.ts` now holds
this down: a `--from` run of three synthetic gates must report two `NOT-RUN`,
must leave no stamp file for either of them, must print `INCOMPLETE: 2 of 3`,
and must exit 3 — with a control that the same three gates without `--from`
still exit 0.

**A missing toolchain now blocks the whole run, not just the gates that need
it.** Preflight resolves the union of every remaining gate's `needs` before the
first gate starts. On this machine, where cargo is on no shell's PATH, that
means `pnpm verify` prints ten `BLOCKED` lines and `VERIFY_EXIT=2` and runs
nothing — measured on this branch, exit status read from the log body. The old
`&&` chain at least ran `pnpm typecheck` before dying, so this is a real loss,
and it is a deliberate one: a toolchain problem knowable at second zero should
not cost fifty seconds of `tsc` first. `--from` does not get round it either —
`--from test` on a cargo-less PATH still prints `PREFLIGHT FAILED`, eight
`BLOCKED` lines and `VERIFY_EXIT=2`, because `cargo-build` and `cargo-test` are
downstream of `test`. There is deliberately no flag that runs "the gates the
missing tool does not block": a run that quietly drops the cargo gates and
reports on the rest is the defect `verify.mjs` exists to remove.

The prepend that makes the ten gates runnable here is the one at the top of
every transcript in this document: put `C:\Users\User\.cargo\bin` on PATH first.

**And the `verify` line itself is pinned by exact string** (round 3).
`src/platform/verify-covers-ci.test.ts` already ran `package.json`'s `verify`
line with `--list` appended and compared what came back to `scripts/gates.json`,
which catches a `verify` that no longer reaches the gate list. It could not
catch a `verify` line that *already ends in* `--list`: measured twice, setting

```
"verify": "node scripts/verify.mjs --list"
```

— a `pnpm verify` that starts no gate and exits 0 — left that file and
`src/platform/verify-runner.test.ts` at `58 passed (58)`, exit 0, because a
listing that lists twice lists the same thing. So the line is now also asserted
verbatim against `node scripts/verify.mjs`, the way
`src/platform/bundle-runner.test.ts` pins `pnpm bundle`. Under the same mutation
that file is now `1 failed | 58 passed (59)`, reproduced twice. Neither
assertion subsumes the other: the string one sees a flag that neuters the run,
the executed one sees the script pointed at a different gate file.
