//! # vela-sandbox — the host half of `CONTRACT-SANDBOX`
//!
//! What runs model-produced code, and what that code may reach.
//!
//! ## What is here, and what is not
//!
//! This crate implements **one vertical slice** of
//! `src/platform/contract-sandbox.ts`, all the way down to a real boundary:
//! Bash, executed inside a Linux mount/PID/network/IPC/UTS namespace in the
//! WSL2 utility VM, streamed, cancellable, with the four-level permission
//! selector enforced host-side. Read [`wsl`] for what the boundary is made of
//! and [`admission`] for what decides whether a run gets one.
//!
//! What is **not** here, stated plainly because the absence of a feature is
//! easier to notice in a list than in silence:
//!
//!  - **Python.** The contract's `ProcessLanguage` has two members and this host
//!    reports one. A language whose guest behaviour has not been tested is a
//!    language this host must not claim.
//!  - **The document family.** Vela has no Canvas surface, so every document
//!    submit is refused and every `sandbox_report_document` is dropped.
//!  - **`copyIn` and `copyInCopyOut`.** Only `bind` is served. A copy mode
//!    quietly served as `bind` writes the user's files during a run that was
//!    promised it could not.
//!  - **Resident-memory and CPU limits.** There is no cgroup behind this
//!    backend and [`wsl::WslBackend::report`] says so, per limit.
//!
//! ## The rule this crate is written against
//!
//! **A blocklist is not a boundary and an AST filter is not a boundary.**
//! Nothing in this crate reads the program's source: not to decide whether it
//! may run, not to decide what it may reach, not to build the command line it
//! runs under. The source is base64-encoded before it crosses any shell and is
//! decoded to a file the interpreter opens. `docs/references/unsloth-studio.md`
//! records what the other approach costs — an escape closed the same day as
//! "completed", still reachable the next, and a fix its own review calls layered
//! mitigation rather than closure of the vulnerability class.

pub mod admission;
pub mod contract;
pub mod digest;
pub mod host;
pub mod paths;
pub mod wsl;

pub use admission::{Admission, ProtectedPaths, RunPlan, SandboxConfig};
pub use contract::*;
pub use host::{MalformedRequest, SandboxEventSink, SandboxHost};
pub use wsl::WslBackend;

use std::path::PathBuf;

/// The default project's id, seeded by `src/platform/contract-project.ts` so
/// that "no project" is never a state.
pub const DEFAULT_PROJECT_ID: &str = "00000000-0000-4000-8000-000000000001";

/// The most this host will serve, whatever a caller asks for.
///
/// A caller that asks for more is not refused — the host lowers the number and
/// reports the lowered value in `SandboxAccepted.grant`, which is what
/// `SandboxLimits` says a ceiling does. It may never raise one.
pub const HOST_CEILINGS: contract::SandboxLimits = contract::SandboxLimits {
    wall_clock_ms: 300_000,
    memory_bytes: 4 * 1024 * 1024 * 1024,
    cpu_millicores: 8_000,
    output_bytes: 8 * 1024 * 1024,
    processes: 512,
    file_write_bytes: 1024 * 1024 * 1024,
};

/// Resolve the four protected categories for this machine.
///
/// Categories rather than paths in the contract because the paths are per-OS and
/// per-install; this is where they become paths, once, for the OS actually
/// running. A category that resolves to nothing here contributes no rule, which
/// is why `vela_store` is passed in rather than guessed: the app-data directory
/// is only knowable once the Tauri app handle exists.
pub fn protected_paths_for_this_machine(
    vela_store_dir: Option<PathBuf>,
    vela_install_dir: Option<PathBuf>,
) -> ProtectedPaths {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let local_appdata = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);

    let mut credential_store = Vec::new();
    for (base, tail) in [
        (&appdata, "Microsoft/Protect"),
        (&appdata, "Microsoft/Credentials"),
        (&local_appdata, "Microsoft/Credentials"),
        (&local_appdata, "Microsoft/Vault"),
    ] {
        if let Some(base) = base {
            credential_store.push(base.join(tail));
        }
    }

    let mut user_key_material = Vec::new();
    if let Some(home) = &home {
        for tail in [".ssh", ".gnupg", ".aws", ".config/gcloud"] {
            user_key_material.push(home.join(tail));
        }
    }

    ProtectedPaths {
        credential_store,
        vela_store: vela_store_dir.into_iter().collect(),
        vela_install: vela_install_dir.into_iter().collect(),
        user_key_material,
    }
}
