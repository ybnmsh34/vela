//! Whether a submit runs, waits for a person, or is refused — decided from the
//! request, never from the program.
//!
//! **Nothing in this file reads `source`.** That is the whole design and it is
//! the one thing a reviewer should check first. The reference product's escape
//! (`docs/references/unsloth-studio.md`, issue #4818) is a catalogue of ways two
//! parsers disagree about the same command string; a decision procedure that
//! never tokenises anything cannot inherit any of it. What a run may do is
//! decided by what it is *given* — mounts, a network policy, a limit set —
//! before its first byte is interpreted.
//!
//! ## The order the checks run in, and why it is fixed
//!
//! A caller gets exactly one refusal, so which one it gets is a decision this
//! file makes rather than an accident of control flow:
//!
//! 1. `permissionIsOff` — the level is host-held, and `off` means *every*
//!    submit, including the languages that "don't really execute".
//! 2. `tooManyConcurrentRuns` — cheap, and says nothing about the request.
//! 3. `unknownProject` — the project decides which directories the run may be
//!    handed at all, so a mount verdict without one would be meaningless.
//! 4. `isolationFamilyMismatch`, then `isolationUnavailable` — the family
//!    mismatch is checked first because an unrankable comparison is not the same
//!    fact as a floor this host cannot reach.
//! 5. `languageUnsupported`.
//! 6. `networkPolicyUnavailable`.
//! 7. the mount checks, in mount order, so `mountIndex` points at the first bad
//!    row rather than an arbitrary one.
//! 8. `environmentNamesCollide`, `workingDirectoryOutsideScope`.
//!
//! Limits are last and are not a refusal at all: the host lowers what it cannot
//! serve and reports the lowered value in the grant, which is the behaviour
//! `SandboxLimits` describes. `limitAboveHostCeiling` therefore has no producer
//! in this host, and that is written down here rather than left for a reader to
//! infer from its absence.

use std::path::PathBuf;

use crate::contract::*;
use crate::paths;

/// Locations that may never be mounted, resolved for this machine.
///
/// Categories rather than a literal path list, exactly as
/// `SANDBOX_PROTECTED_ROOTS` says, because the paths are per-OS and per-install.
/// Each field holds every directory that resolves to that category here.
#[derive(Debug, Clone, Default)]
pub struct ProtectedPaths {
    pub credential_store: Vec<PathBuf>,
    pub vela_store: Vec<PathBuf>,
    pub vela_install: Vec<PathBuf>,
    pub user_key_material: Vec<PathBuf>,
}

impl ProtectedPaths {
    fn category_for(&self, resolved: &std::path::Path) -> Option<ProtectedRoot> {
        let hit = |roots: &[PathBuf]| {
            roots
                .iter()
                .any(|root| paths::is_within(resolved, root) || paths::is_within(root, resolved))
        };
        if hit(&self.credential_store) {
            Some(ProtectedRoot::CredentialStore)
        } else if hit(&self.vela_store) {
            Some(ProtectedRoot::VelaStore)
        } else if hit(&self.vela_install) {
            Some(ProtectedRoot::VelaInstall)
        } else if hit(&self.user_key_material) {
            Some(ProtectedRoot::UserKeyMaterial)
        } else {
            None
        }
    }
}

/// What the admission decision needs to know about this machine and this user's
/// settings. Held by the host; never any part of a request.
#[derive(Debug, Clone)]
pub struct SandboxConfig {
    /// The four-level selector. **Host-held**: no request can raise it, which is
    /// the one property of the reference product's design that is unambiguously
    /// right.
    pub permission: PermissionLevel,
    pub profile: AutoApprovalProfile,
    /// Projects this host knows. A run's `projectId` decides which of the user's
    /// directories it may be handed at all.
    pub known_projects: Vec<String>,
    pub protected: ProtectedPaths,
    /// Everything under here except a project's own directories is unmountable.
    pub app_data_dir: Option<PathBuf>,
    /// The most this host will serve. Never raised, only lowered from.
    pub ceilings: SandboxLimits,
    pub maximum_concurrent_runs: u32,
}

/// A mount, resolved and translated, ready for the guest script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedMount {
    /// Where WSL sees the host directory today: `/mnt/c/...`.
    pub wsl_source: String,
    /// Where the run will see it. Not under `/mnt`: see [`crate::wsl`].
    pub guest_path: String,
    pub mode: MountMode,
}

/// Everything the backend needs, with nothing left to re-derive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunPlan {
    pub language: ProcessLanguage,
    pub source: String,
    pub stdin: Option<String>,
    /// The caller's entries. The host's own additions are
    /// [`RunPlan::base_environment`]; the run's environment is exactly the two
    /// together and nothing else.
    pub environment: Vec<EnvironmentEntry>,
    pub base_environment: Vec<EnvironmentEntry>,
    pub mounts: Vec<ResolvedMount>,
    pub scratch_guest_path: String,
    pub working_directory: String,
    pub limits: SandboxLimits,
}

/// The three ways a submit can go.
#[derive(Debug, Clone)]
pub enum Admission {
    /// Settle the run refused, with this outcome, and emit nothing else.
    Refused(SandboxOutcome),
    /// A person must say yes first. The grant is what they are shown.
    NeedsApproval {
        grant: EffectiveGrant,
        plan: Box<RunPlan>,
    },
    /// Run it.
    Approved {
        grant: EffectiveGrant,
        plan: Box<RunPlan>,
    },
}

/// The default scratch location, when the caller does not name one.
pub const DEFAULT_SCRATCH_GUEST_PATH: &str = "/vela/scratch";

/// Longest program this host will carry into the guest.
///
/// The source travels base64-encoded inside the guest script, and the script is
/// one argument on a Windows command line, which the OS caps at 32767
/// characters. A source larger than this would be truncated by the command-line
/// limit rather than refused, and a *silently truncated program* is the worst
/// available failure: it runs, and it is not what the user approved. The same
/// reasoning `chat.rs` uses for `MAX_MESSAGE_BYTES`.
pub const MAX_PROGRAM_BYTES: usize = 16 * 1024;

/// Decide. `Err` is a malformed payload — `INVALID_PAYLOAD` on the invoke —
/// and never a refusal: a refusal is a fact about a well-formed request.
pub fn admit(
    config: &SandboxConfig,
    backend: &SandboxBackendReport,
    document_backend: &SandboxBackendReport,
    languages: &[SandboxLanguage],
    active_runs: u32,
    request: &SandboxSubmitReq,
) -> Result<Admission, String> {
    if config.permission == PermissionLevel::Off {
        return Ok(Admission::Refused(SandboxOutcome::refused(
            RefusalReason::PermissionIsOff,
        )));
    }
    if active_runs >= config.maximum_concurrent_runs {
        return Ok(Admission::Refused(SandboxOutcome::refused(
            RefusalReason::TooManyConcurrentRuns,
        )));
    }
    if !config.known_projects.iter().any(|id| id == &request.project_id) {
        return Ok(Admission::Refused(SandboxOutcome::refused(
            RefusalReason::UnknownProject,
        )));
    }

    let program_family = match &request.program {
        SandboxProgram::Process(_) => Isolation::Process {
            level: ProcessIsolation::None,
        },
        SandboxProgram::Document(program) => {
            program.validate()?;
            Isolation::Document {
                level: DocumentIsolation::SameOrigin,
            }
        }
    };
    if !same_family(program_family, request.minimum_isolation) {
        return Ok(Admission::Refused(SandboxOutcome::refused(
            RefusalReason::IsolationFamilyMismatch,
        )));
    }
    let offered = match request.minimum_isolation {
        Isolation::Process { .. } => backend.isolation,
        Isolation::Document { .. } => document_backend.isolation,
    };
    if !isolation_meets(offered, request.minimum_isolation) {
        return Ok(Admission::Refused(SandboxOutcome::refused(
            RefusalReason::IsolationUnavailable,
        )));
    }

    if !languages.contains(&request.program.language()) {
        return Ok(Admission::Refused(SandboxOutcome::refused(
            RefusalReason::LanguageUnsupported,
        )));
    }

    // Everything past here is a process run: no document language is in
    // `languages` on any build of this host, so a document submit has already
    // been refused above.
    let program = match &request.program {
        SandboxProgram::Process(program) => program,
        SandboxProgram::Document(_) => {
            return Ok(Admission::Refused(SandboxOutcome::refused(
                RefusalReason::LanguageUnsupported,
            )))
        }
    };
    if program.source.len() > MAX_PROGRAM_BYTES {
        return Err(format!(
            "program source is {} bytes; this host carries at most {MAX_PROGRAM_BYTES}",
            program.source.len()
        ));
    }

    // The only network policy this backend can *impose* is the absence of a
    // network. Serving `loopbackOnly` would mean handing the run the WSL VM's
    // own loopback, where the user's inference server lives, and calling the
    // result a policy.
    if !matches!(request.network, NetworkPolicy::Denied) {
        return Ok(Admission::Refused(SandboxOutcome::refused(
            RefusalReason::NetworkPolicyUnavailable,
        )));
    }

    let scratch_guest_path = match &request.filesystem.scratch.guest_path {
        None => DEFAULT_SCRATCH_GUEST_PATH.to_string(),
        Some(path) => {
            paths::validate_guest_path(path)?;
            path.trim_end_matches('/').to_string()
        }
    };

    let mut resolved: Vec<ResolvedMount> = Vec::new();
    for (index, mount) in request.filesystem.mounts.iter().enumerate() {
        let index = index as u32;
        if !matches!(mount.materialisation, MountMaterialisation::Bind) {
            return Err(format!(
                "mount {index}: this host serves `bind` only; a copy mode it \
                 quietly served as `bind` would write the user's files during a \
                 run that was promised it could not"
            ));
        }
        paths::validate_guest_path(&mount.guest_path)?;
        let host = paths::resolve_host_directory(&mount.host_path)?;

        if let Some(category) = config.protected.category_for(&host) {
            return Ok(Admission::Refused(SandboxOutcome::Refused {
                reason: RefusalReason::MountIsProtectedRoot,
                mount_index: Some(index),
                protected_root: Some(category),
            }));
        }
        if let Some(app_data) = &config.app_data_dir {
            if paths::is_within(&host, app_data) {
                return Ok(Admission::Refused(SandboxOutcome::Refused {
                    reason: RefusalReason::MountOutsideProjectScope,
                    mount_index: Some(index),
                    protected_root: None,
                }));
            }
        }

        let guest = mount.guest_path.trim_end_matches('/').to_string();
        if paths::guest_paths_overlap(&guest, &scratch_guest_path)
            || resolved
                .iter()
                .any(|other| paths::guest_paths_overlap(&other.guest_path, &guest))
        {
            return Ok(Admission::Refused(SandboxOutcome::Refused {
                reason: RefusalReason::MountsOverlap,
                mount_index: Some(index),
                protected_root: None,
            }));
        }

        resolved.push(ResolvedMount {
            wsl_source: paths::windows_path_to_wsl(&host)?,
            guest_path: guest,
            mode: mount.mode,
        });
    }

    let base_environment = base_environment_for(&scratch_guest_path);
    if let Some(reason) = environment_collides(&program.environment, &base_environment)? {
        return Ok(Admission::Refused(SandboxOutcome::refused(reason)));
    }

    let working_directory = match &program.working_directory {
        ProcessWorkingDirectory::Scratch => scratch_guest_path.clone(),
        ProcessWorkingDirectory::GuestPath { path } => {
            paths::validate_guest_path(path)?;
            let path = path.trim_end_matches('/').to_string();
            let inside_scratch = paths::guest_paths_overlap(&path, &scratch_guest_path)
                && path.starts_with(&scratch_guest_path);
            let inside_mount = resolved.iter().any(|mount| {
                path == mount.guest_path || path.starts_with(&format!("{}/", mount.guest_path))
            });
            if !inside_scratch && !inside_mount {
                return Ok(Admission::Refused(SandboxOutcome::refused(
                    RefusalReason::WorkingDirectoryOutsideScope,
                )));
            }
            path
        }
    };

    let limits = lower_to_ceilings(request.limits, config.ceilings);
    let grant = EffectiveGrant {
        backend: *backend,
        filesystem: EffectiveFilesystemScope {
            mounts: request.filesystem.mounts.clone(),
            scratch: ResolvedScratch {
                guest_path: scratch_guest_path.clone(),
                // Narrowed, never widened. The scratch directory is a tmpfs
                // inside a namespace that is destroyed when the run ends, so
                // there is nothing left to retain. Reporting the request back
                // unchanged would promise a caller it could come back for the
                // files afterwards.
                retain_after_settled: false,
            },
            outside_mounts: OutsideMounts::Denied,
        },
        network: request.network.clone(),
        limits,
        working_directory: Some(working_directory.clone()),
    };

    let plan = Box::new(RunPlan {
        language: program.language,
        source: program.source.clone(),
        stdin: program.stdin.clone(),
        environment: program.environment.clone(),
        base_environment,
        mounts: resolved,
        scratch_guest_path,
        working_directory,
        limits,
    });

    let automatic = match config.permission {
        PermissionLevel::Off => unreachable!("refused at the top of this function"),
        PermissionLevel::Full => true,
        PermissionLevel::Ask => false,
        PermissionLevel::Approve => within_profile(&config.profile, request, limits),
    };
    Ok(if automatic {
        Admission::Approved { grant, plan }
    } else {
        Admission::NeedsApproval { grant, plan }
    })
}

/// Every clause of the auto-approval profile, checked **over the request**.
///
/// Reading any of this against the backend would auto-approve a run on a
/// container-capable machine whose caller never demanded containment — it would
/// sail through on the strength of a guarantee it did not request and cannot
/// rely on.
fn within_profile(
    profile: &AutoApprovalProfile,
    request: &SandboxSubmitReq,
    limits: SandboxLimits,
) -> bool {
    let floor = match request.minimum_isolation {
        Isolation::Process { .. } => Isolation::Process {
            level: profile.minimum_isolation.process,
        },
        Isolation::Document { .. } => Isolation::Document {
            level: profile.minimum_isolation.document,
        },
    };
    if !isolation_meets(request.minimum_isolation, floor) {
        return false;
    }
    if !matches!(request.network, NetworkPolicy::Denied) {
        return false;
    }
    if !profile.languages.contains(&request.program.language()) {
        return false;
    }
    if limits.wall_clock_ms > profile.maximum_limits.wall_clock_ms
        || limits.memory_bytes > profile.maximum_limits.memory_bytes
        || limits.cpu_millicores > profile.maximum_limits.cpu_millicores
        || limits.output_bytes > profile.maximum_limits.output_bytes
        || limits.processes > profile.maximum_limits.processes
        || limits.file_write_bytes > profile.maximum_limits.file_write_bytes
    {
        return false;
    }
    request.filesystem.mounts.iter().all(|mount| {
        let Ok(host) = paths::resolve_host_directory(&mount.host_path) else {
            return false;
        };
        let inside = |roots: &[String]| {
            roots.iter().any(|root| {
                paths::resolve_host_directory(root)
                    .map(|root| paths::is_within(&host, &root))
                    .unwrap_or(false)
            })
        };
        // The two lists are checked independently and neither implies the
        // other: a `readWrite` mount must appear in the writable list, and
        // appearing there does not make the path readable.
        match mount.mode {
            MountMode::ReadOnly => inside(&profile.readable_roots),
            MountMode::ReadWrite => inside(&profile.writable_roots) && inside(&profile.readable_roots),
        }
    })
}

fn lower_to_ceilings(requested: SandboxLimits, ceilings: SandboxLimits) -> SandboxLimits {
    SandboxLimits {
        wall_clock_ms: requested.wall_clock_ms.min(ceilings.wall_clock_ms),
        memory_bytes: requested.memory_bytes.min(ceilings.memory_bytes),
        cpu_millicores: requested.cpu_millicores.min(ceilings.cpu_millicores),
        output_bytes: requested.output_bytes.min(ceilings.output_bytes),
        processes: requested.processes.min(ceilings.processes),
        file_write_bytes: requested.file_write_bytes.min(ceilings.file_write_bytes),
    }
}

/// The environment the host adds for a POSIX guest, and the whole of it.
///
/// `HOME` and `TMPDIR` point at the run's own scratch directory because those
/// are the two variables a shell and an interpreter reach for when they want
/// somewhere to write, and pointing them anywhere else is how a run ends up
/// writing into a directory nobody granted it.
fn base_environment_for(scratch: &str) -> Vec<EnvironmentEntry> {
    let entry = |name: &str, value: String| EnvironmentEntry {
        name: name.to_string(),
        value,
    };
    vec![
        entry(
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into(),
        ),
        entry("HOME", scratch.to_string()),
        entry("TMPDIR", scratch.to_string()),
        entry("LANG", "C.UTF-8".into()),
        entry("PWD", scratch.to_string()),
    ]
}

/// `Ok(Some(reason))` is a refusal; `Err` is a malformed name.
///
/// Two collisions, not one. Two caller entries with the same name collide under
/// POSIX casing rules. A caller entry that names a key from
/// `SANDBOX_BASE_ENVIRONMENT_POSIX` also collides, because the values for those
/// keys are the host's and point inside the run's own filesystem scope — a
/// caller that could set `HOME` could point the run's writes at a directory the
/// grant never mentioned.
fn environment_collides(
    caller: &[EnvironmentEntry],
    _base: &[EnvironmentEntry],
) -> Result<Option<RefusalReason>, String> {
    let mut seen: Vec<&str> = Vec::new();
    for entry in caller {
        if entry.name.is_empty()
            || !entry
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            || entry.name.as_bytes()[0].is_ascii_digit()
        {
            return Err(format!("environment name is not a variable: {}", entry.name));
        }
        if entry.value.contains('\0') {
            return Err("environment value contains a NUL".into());
        }
        if SANDBOX_BASE_ENVIRONMENT_POSIX.contains(&entry.name.as_str())
            || seen.contains(&entry.name.as_str())
        {
            return Ok(Some(RefusalReason::EnvironmentNamesCollide));
        }
        seen.push(&entry.name);
    }
    Ok(None)
}
