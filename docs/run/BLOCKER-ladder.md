# BLOCKER — the ladder cannot be lifted from inside this session

**Status:** open · **Affects:** all 18 tracks · **Raised:** round 2, after the same FAIL with the
same evidence twice · **Decision needed from:** the operator

## What is blocked

`LADDER` fails on all eighteen tracks. Nothing can rise above `dev-clicked`, so **no track can
PASS**, however good the work is. Four tracks (T8, T10, T11, T12) now fail on *nothing else*.

## Why — measured, not assumed

T1 produced two real installers, both confirmed on disk by a critic that did not build them:

- `src-tauri/target/release/bundle/msi/Vela_0.1.0_x64_en-US.msi` — 7,360,512 bytes
- `src-tauri/target/release/bundle/nsis/Vela_0.1.0_x64-setup.exe` — 5,444,437 bytes

The generated `src-tauri/target/release/nsis/x64/installer.nsi` sets:

```
!define INSTALLMODE "currentUser"
StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"     ; PRODUCTNAME = "Vela"
```

So an install lands in `%LOCALAPPDATA%\Vela`. From this session that path **resolves inside the
Claude MSIX container**. `scripts/check-real-path.ps1`, re-run independently by the round-2 critic
using `GetFinalPathNameByHandle`:

```
CONTROL PASS   the reader answers with the junction's TARGET
REAL           %APPDATA%\dev.vela.desktop
CONTAINER      vela.db
CONTAINER      diagnostics
REAL           skills
CONTAINER      C:\Users\User\AppData\Local\Vela
CONTAINER      ...\Vela\vela.exe  ->  ...\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Vela
REAL           both Vela.lnk paths
container-only paths 4 · exit 1
```

The control passes, so the reader is trustworthy; four of the paths that matter are container-only.

## Why nobody here should just install it anyway

1. **The observation would be void.** An install inside the container proves nothing about the
   machine. `docs/audit/REPORT.md` has already **withdrawn two** such observations. A third would
   make the document worse, not better.
2. **A previous install did real harm.** Section 7 of the release posture records that an earlier
   attempt **removed an unrelated third-party Vela's shortcuts**. This is not a hypothetical cost.
3. **Both builders declined, and both were right.** Two independent critics agreed. This is the
   correct engineering judgement, not an avoidance.

## What was tried

- Building the bundles: **done**, both artifacts exist and are machine-checked.
- Verifying the whole gate chain: **done** — a critic ran all ten gates green in one process with
  `RUST_TAIL=CONFIRMED` and `VERIFY_EXIT=0` read from the log body (122 files / 2445 tests, 65 cargo
  `test result: ok` lines, zero FAILED).
- Confirming where an install would land: **done**, from the generated `installer.nsi` plus the
  container probe above.
- Installing, updating, uninstalling: **not attempted**, for the reasons above.

## The decision

To reach `reaches-user` — installed from the produced bundle, launched as a user launches it,
driven by OS-level input, app-data resolving where it resolves on a real machine — **someone
outside the container has to install it.**

Options, for the operator:

1. **Install it yourself.** Open `C:\Users\User\vela-t01\src-tauri\target\release\bundle\nsis\`
   in Explorer and run `Vela_0.1.0_x64-setup.exe`. Launched from Explorer rather than from this
   session, `%LOCALAPPDATA%` resolves to the real machine. Then say so, and T3's OS-level input
   dispatch can drive the installed app for a genuine `reaches-user` grade.
   *Cost: it installs software on your machine and, per point 2 above, may touch shortcuts belonging
   to any other application also named Vela.*
2. **Accept the cap.** The run continues to produce work graded honestly at `dev-clicked` and
   `test-bites`. Nothing is lost except the top two rungs, and every track's other panel members
   still have to pass on their own merits.
3. **Neither yet.** The run keeps going; this blocker stays open and every track keeps its cap.

**Until this is decided, the run proceeds under option 3.** No track stops working; they simply
cannot pass. That is the honest state and the page reflects it.
