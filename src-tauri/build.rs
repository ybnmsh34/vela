//! Build script for the Tauri host process.
//!
//! `tauri_build::build()` does the real work. The block after it exists to fix
//! a defect that made two integration tests unrunnable on Windows for the
//! entire life of this project — see [`link_windows_resources_into_tests`].

fn main() {
    tauri_build::build();
    link_windows_resources_into_tests();
}

/// **Give the test binaries the Windows manifest the real binary already has.**
///
/// ## The defect
///
/// `tests/handler_binding.rs` and `tests/gate_m_assembled_app.rs` died at
/// process load with `0xC0000139` (`STATUS_ENTRYPOINT_NOT_FOUND`), before
/// `main` ran, so they produced no output to diagnose and were repeatedly
/// written off as environmental. They were not.
///
/// Every binary that links Tauri's Windows backend imports
/// `TaskDialogIndirect` from `comctl32.dll`. That symbol exists **only in
/// comctl32 version 6**, which lives in WinSxS. The `comctl32.dll` in
/// `System32` is the legacy 5.82 build and exports no `TaskDialog*` at all.
/// Version 6 is bound only for a binary carrying an application manifest that
/// declares a dependency on `Microsoft.Windows.Common-Controls` `6.0.0.0`.
///
/// `tauri-build` generates exactly that manifest — together with the version
/// info and the icon — compiles it to a resource library in `OUT_DIR`, and
/// emits:
///
/// ```text
/// cargo:rustc-link-arg-bins=<OUT_DIR>\resource.lib
/// ```
///
/// `rustc-link-arg-bins` applies to **bin targets only**. Integration tests are
/// separate targets, so they never received it: `vela.exe` has a `.rsrc`
/// section, the test binaries have none, and the loader resolved their
/// `comctl32` imports against 5.82 and refused to start them.
///
/// ## The fix
///
/// Emit the same path again as `rustc-link-arg-tests`, which is the directive
/// aimed at precisely this. Note what is *not* happening here: no second
/// manifest is written. This links the identical artifact `tauri-build` just
/// produced for the shipped binary, so the two cannot drift — if the app's
/// manifest changes, the tests' manifest changes with it, because it is the
/// same file. Nothing about the bin target's linkage is touched, so `vela.exe`
/// is byte-for-byte unaffected.
///
/// ## Why this fails loudly rather than quietly
///
/// The `OUT_DIR/resource.{lib,a}` name is `tauri-winres`'s (it writes
/// `resource.rc` and hands it to `embed-resource`, which names the output after
/// the stem). If a future `tauri-build` changes that, this panics with an
/// explanation instead of silently reverting the tests to unrunnable — which is
/// the exact failure mode being repaired, and it went unnoticed for months the
/// first time.
fn link_windows_resources_into_tests() {
    // Gate on the *target*, not the host: a Linux or macOS build has no
    // Windows resources, and `CARGO_CFG_TARGET_OS` is what `tauri-build`
    // itself branches on.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let out_dir = std::path::PathBuf::from(
        std::env::var("OUT_DIR").expect("OUT_DIR is always set for a build script"),
    );

    // MSVC links a `.lib`; the windows-gnu toolchain gets a `libresource.a`
    // from windres. `tauri-build` may also skip resource generation entirely
    // for a target it does not handle, which is not an error here.
    let candidates = [out_dir.join("resource.lib"), out_dir.join("libresource.a")];
    let Some(resource) = candidates.iter().find(|path| path.exists()) else {
        panic!(
            "tauri-build produced no Windows resource library in {}.\n\
             The integration tests need the application manifest it embeds \
             (Microsoft.Windows.Common-Controls 6.0.0.0); without it they fail \
             to load with STATUS_ENTRYPOINT_NOT_FOUND on `comctl32!TaskDialogIndirect`.\n\
             If tauri-build changed where it writes this file, update \
             `link_windows_resources_into_tests` in build.rs to match — do not \
             delete this check.",
            out_dir.display()
        );
    };

    println!("cargo::rustc-link-arg-tests={}", resource.display());
}
