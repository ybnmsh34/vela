//! The host side of `src/platform/contract-sandbox.ts`, in Rust.
//!
//! Every shape here is the wire shape that file froze — same field names, same
//! discriminants, same closed unions. Where this file omits something the
//! contract states, it is because **this host cannot serve it**, and the
//! omission is a compile error waiting for whoever adds the backend that can,
//! rather than a field filled in with a plausible-looking default.
//!
//! Two omissions worth naming up front, because a reader will otherwise assume
//! their opposites:
//!
//!  - there is no `copyIn`/`copyInCopyOut` implementation behind
//!    [`MountMaterialisation`]. The variants deserialize, and
//!    [`crate::admission`] refuses them, because a materialisation that is
//!    silently downgraded to `bind` writes the user's files during a run that
//!    was promised it could not.
//!  - the document family deserializes and is refused. Vela's Canvas surface
//!    does not exist yet, and a host that accepted a document submit would be
//!    promising a frame nothing draws.

use serde::{Deserialize, Serialize};

/// A run's identity, minted by the caller. Opaque: never used to build a path.
pub type SandboxRunId = String;

/* -------------------------------------------------------------------------- */
/* isolation                                                                  */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessIsolation {
    None,
    Process,
    Container,
    MicroVm,
}

impl ProcessIsolation {
    fn rank(self) -> u8 {
        match self {
            Self::None => 0,
            Self::Process => 1,
            Self::Container => 2,
            Self::MicroVm => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentIsolation {
    SameOrigin,
    OpaqueOriginFrame,
    OwnRendererProcess,
}

impl DocumentIsolation {
    fn rank(self) -> u8 {
        match self {
            Self::SameOrigin => 0,
            Self::OpaqueOriginFrame => 1,
            Self::OwnRendererProcess => 2,
        }
    }
}

/// One isolation claim: which family, and how strong within it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "family", rename_all = "camelCase")]
pub enum Isolation {
    Process { level: ProcessIsolation },
    Document { level: DocumentIsolation },
}

/// Does `offered` satisfy the floor `required` asks for?
///
/// The Rust twin of `isolationMeets`. A family mismatch is `false` here as it is
/// there — the caller then reports `isolationFamilyMismatch` rather than
/// `isolationUnavailable`, because the two say different things to a user.
pub fn isolation_meets(offered: Isolation, required: Isolation) -> bool {
    match (offered, required) {
        (Isolation::Process { level: o }, Isolation::Process { level: r }) => o.rank() >= r.rank(),
        (Isolation::Document { level: o }, Isolation::Document { level: r }) => {
            o.rank() >= r.rank()
        }
        _ => false,
    }
}

pub fn same_family(a: Isolation, b: Isolation) -> bool {
    matches!(
        (a, b),
        (Isolation::Process { .. }, Isolation::Process { .. })
            | (Isolation::Document { .. }, Isolation::Document { .. })
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnforcementLevel {
    Kernel,
    Supervisor,
    Unenforced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IsolationEvidence {
    Declared,
    Probed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitEnforcement {
    pub wall_clock_ms: EnforcementLevel,
    pub memory_bytes: EnforcementLevel,
    pub cpu_millicores: EnforcementLevel,
    pub output_bytes: EnforcementLevel,
    pub processes: EnforcementLevel,
    pub file_write_bytes: EnforcementLevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxBackendReport {
    pub isolation: Isolation,
    pub maximum_isolation: Isolation,
    pub evidence: IsolationEvidence,
    pub network: EnforcementLevel,
    pub filesystem: EnforcementLevel,
    pub process_tree: EnforcementLevel,
    pub limits: LimitEnforcement,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxBackends {
    pub process: SandboxBackendReport,
    pub document: SandboxBackendReport,
}

/* -------------------------------------------------------------------------- */
/* the program                                                                */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessLanguage {
    Bash,
    Python,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentLanguage {
    Html,
    React,
    Svg,
    Mermaid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SandboxLanguage {
    Bash,
    Python,
    Html,
    React,
    Svg,
    Mermaid,
}

impl From<ProcessLanguage> for SandboxLanguage {
    fn from(value: ProcessLanguage) -> Self {
        match value {
            ProcessLanguage::Bash => Self::Bash,
            ProcessLanguage::Python => Self::Python,
        }
    }
}

impl From<DocumentLanguage> for SandboxLanguage {
    fn from(value: DocumentLanguage) -> Self {
        match value {
            DocumentLanguage::Html => Self::Html,
            DocumentLanguage::React => Self::React,
            DocumentLanguage::Svg => Self::Svg,
            DocumentLanguage::Mermaid => Self::Mermaid,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GuestPlatform {
    Posix,
    Windows,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentEntry {
    pub name: String,
    pub value: String,
}

/// The keys the host adds itself when the guest is POSIX. Closed: a variable
/// absent from [`ProcessProgram::environment`] and from this list does not exist
/// inside the run, including every token the user exported into the shell that
/// launched Vela.
pub const SANDBOX_BASE_ENVIRONMENT_POSIX: [&str; 5] = ["PATH", "HOME", "TMPDIR", "LANG", "PWD"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProcessWorkingDirectory {
    Scratch,
    GuestPath { path: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessProgram {
    pub language: ProcessLanguage,
    pub source: String,
    pub working_directory: ProcessWorkingDirectory,
    pub environment: Vec<EnvironmentEntry>,
    pub stdin: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentScripts {
    Denied,
    SandboxedNullOrigin,
}

/// A document Canvas would draw, if Vela had a Canvas.
///
/// `scripts` is `Option` here where the TypeScript makes it unrepresentable on
/// the two languages that cannot carry it. Rust's internally-tagged enums cannot
/// discriminate on a second field, so the rule the type held there is held by
/// [`DocumentProgram::validate`] here — and a payload that breaks it is
/// `INVALID_PAYLOAD`, which is exactly what the contract says a payload spelling
/// an unrepresentable shape is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentProgram {
    pub language: DocumentLanguage,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scripts: Option<DocumentScripts>,
}

impl DocumentProgram {
    pub fn validate(&self) -> Result<(), &'static str> {
        let scriptable = matches!(
            self.language,
            DocumentLanguage::Html | DocumentLanguage::React
        );
        match (scriptable, self.scripts.is_some()) {
            (true, false) => Err("scripts is required for html and react"),
            (false, true) => Err("svg and mermaid are drawn, never executed; they take no scripts"),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SandboxProgram {
    Process(ProcessProgram),
    Document(DocumentProgram),
}

impl SandboxProgram {
    pub fn language(&self) -> SandboxLanguage {
        match self {
            Self::Process(program) => program.language.into(),
            Self::Document(program) => program.language.into(),
        }
    }
}

/* -------------------------------------------------------------------------- */
/* filesystem scope                                                           */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MountMode {
    ReadOnly,
    ReadWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MountMaterialisation {
    Bind,
    CopyIn,
    CopyInCopyOut,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mount {
    pub host_path: String,
    pub guest_path: String,
    pub mode: MountMode,
    pub materialisation: MountMaterialisation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProtectedRoot {
    CredentialStore,
    VelaStore,
    VelaInstall,
    UserKeyMaterial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchRequest {
    pub guest_path: Option<String>,
    pub retain_after_settled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedScratch {
    pub guest_path: String,
    pub retain_after_settled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemScope {
    pub mounts: Vec<Mount>,
    pub scratch: ScratchRequest,
    /// One-member union in the contract, so one legal string here. A second
    /// value arriving is a payload from a newer contract and is refused by
    /// serde rather than defaulted.
    pub outside_mounts: OutsideMounts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutsideMounts {
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveFilesystemScope {
    pub mounts: Vec<Mount>,
    pub scratch: ResolvedScratch,
    pub outside_mounts: OutsideMounts,
}

/* -------------------------------------------------------------------------- */
/* network and limits                                                         */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NetworkPolicy {
    Denied,
    LoopbackOnly { ports: Vec<u16> },
    Allowed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxLimits {
    pub wall_clock_ms: u64,
    pub memory_bytes: u64,
    pub cpu_millicores: u32,
    pub output_bytes: u64,
    pub processes: u32,
    pub file_write_bytes: u64,
}

pub const DEFAULT_PROCESS_LIMITS: SandboxLimits = SandboxLimits {
    wall_clock_ms: 30_000,
    memory_bytes: 512 * 1024 * 1024,
    cpu_millicores: 1000,
    output_bytes: 1024 * 1024,
    processes: 128,
    file_write_bytes: 100 * 1024 * 1024,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LimitName {
    WallClockMs,
    MemoryBytes,
    CpuMillicores,
    OutputBytes,
    Processes,
    FileWriteBytes,
}

/* -------------------------------------------------------------------------- */
/* permission                                                                 */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionLevel {
    Ask,
    Approve,
    Off,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoApprovalIsolationFloor {
    pub process: ProcessIsolation,
    pub document: DocumentIsolation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoApprovalProfile {
    pub minimum_isolation: AutoApprovalIsolationFloor,
    pub readable_roots: Vec<String>,
    pub writable_roots: Vec<String>,
    pub maximum_limits: SandboxLimits,
    pub languages: Vec<SandboxLanguage>,
}

/// The profile Vela ships with, which auto-approves nothing at all.
///
/// Its `minimumIsolation` demands `container` of a process run — which this
/// host *can* now serve — and `ownRendererProcess` of a document, which nothing
/// can. A process submit that demands `container` and asks for nothing else the
/// profile forbids will auto-approve at `approve`. That is the floor moving down
/// because a mechanism moved up, which is the rule the TypeScript states.
pub fn default_auto_approval_profile() -> AutoApprovalProfile {
    AutoApprovalProfile {
        minimum_isolation: AutoApprovalIsolationFloor {
            process: ProcessIsolation::Container,
            document: DocumentIsolation::OwnRendererProcess,
        },
        readable_roots: Vec::new(),
        writable_roots: Vec::new(),
        maximum_limits: DEFAULT_PROCESS_LIMITS,
        languages: vec![
            SandboxLanguage::Bash,
            SandboxLanguage::Python,
            SandboxLanguage::Html,
            SandboxLanguage::React,
            SandboxLanguage::Svg,
            SandboxLanguage::Mermaid,
        ],
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub run_id: SandboxRunId,
    pub request_digest: String,
    pub program: SandboxProgram,
    pub grant: EffectiveGrant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    AllowOnce,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxPolicySnapshot {
    pub permission: PermissionLevel,
    pub profile: AutoApprovalProfile,
    pub backends: SandboxBackends,
    pub languages: Vec<SandboxLanguage>,
    pub guest_platform: GuestPlatform,
    pub active_runs: u32,
    pub maximum_concurrent_runs: u32,
}

/* -------------------------------------------------------------------------- */
/* commands                                                                   */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSubmitReq {
    pub run_id: SandboxRunId,
    pub project_id: String,
    pub program: SandboxProgram,
    pub filesystem: FilesystemScope,
    pub network: NetworkPolicy,
    pub limits: SandboxLimits,
    pub minimum_isolation: Isolation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSubmitRes {
    pub run_id: SandboxRunId,
    pub admitted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefusalReason {
    IsolationUnavailable,
    IsolationFamilyMismatch,
    PermissionIsOff,
    ApprovalDenied,
    ApprovalAbandoned,
    LanguageUnsupported,
    UnknownProject,
    MountIsProtectedRoot,
    MountOutsideProjectScope,
    SkillsMountMustBeReadOnly,
    MountsOverlap,
    GuestPathRemapUnsupported,
    WorkingDirectoryOutsideScope,
    EnvironmentNamesCollide,
    LimitAboveHostCeiling,
    NetworkPolicyUnavailable,
    DocumentGrantInvalid,
    TooManyConcurrentRuns,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostFailureReason {
    BackendUnavailable,
    BackendStartFailed,
    ScratchUnavailable,
    CopyOutFailed,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveGrant {
    pub backend: SandboxBackendReport,
    pub filesystem: EffectiveFilesystemScope,
    pub network: NetworkPolicy,
    pub limits: SandboxLimits,
    pub working_directory: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CancelReason {
    User,
    SurfaceClosed,
    Superseded,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCancelReq {
    pub run_id: SandboxRunId,
    pub reason: CancelReason,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCancelRes {
    pub cancelled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxReleaseReq {
    pub run_id: SandboxRunId,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxApproveReq {
    pub run_id: SandboxRunId,
    pub request_digest: String,
    pub decision: ApprovalDecision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentFailureReason {
    FrameCrashed,
    SourceRejectedByParser,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DocumentObservation {
    Rendered {
        render_ms: u64,
    },
    Diagnostic {
        severity: DiagnosticSeverity,
        text: String,
    },
    Truncated {
        dropped_bytes: u64,
    },
    Failed {
        reason: DocumentFailureReason,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxReportDocumentReq {
    pub run_id: SandboxRunId,
    pub observation: DocumentObservation,
}

/* -------------------------------------------------------------------------- */
/* the event stream                                                           */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunUsage {
    pub wall_clock_ms: u64,
    pub cpu_ms: Option<u64>,
    pub peak_memory_bytes: Option<u64>,
    pub output_bytes: u64,
    pub dropped_output_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SandboxOutcome {
    Exited {
        exit_code: i32,
    },
    Crashed {
        signal: Option<i32>,
    },
    Rendered {
        render_ms: u64,
    },
    DocumentFailed {
        reason: DocumentFailureReason,
    },
    LimitExceeded {
        limit: LimitName,
    },
    Cancelled {
        reason: CancelReason,
    },
    Refused {
        reason: RefusalReason,
        mount_index: Option<u32>,
        protected_root: Option<ProtectedRoot>,
    },
    HostFailed {
        reason: HostFailureReason,
    },
}

impl SandboxOutcome {
    /// The refusal shape most call sites want: a reason and no mount.
    pub fn refused(reason: RefusalReason) -> Self {
        Self::Refused {
            reason,
            mount_index: None,
            protected_root: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SandboxEvent {
    AwaitingApproval {
        request: ApprovalRequest,
    },
    Accepted {
        grant: EffectiveGrant,
    },
    Started {
        startup_ms: u64,
    },
    Output {
        stream: OutputStream,
        text: String,
        bytes: u64,
    },
    Diagnostic {
        severity: DiagnosticSeverity,
        text: String,
    },
    Truncated {
        dropped_bytes: u64,
    },
    Settled {
        outcome: SandboxOutcome,
        usage: RunUsage,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxEventEnvelope {
    pub run_id: SandboxRunId,
    pub seq: u64,
    pub event: SandboxEvent,
}

/// The host event this stream is delivered on. Mirrored by `SANDBOX_EVENT_NAME`
/// in `src/platform/contract-sandbox.ts` and by the `EventContract` entry in
/// `src/platform/adapter.ts`.
pub const SANDBOX_EVENT: &str = "sandbox:event";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolation_ranks_within_a_family_and_refuses_across_families() {
        let container = Isolation::Process {
            level: ProcessIsolation::Container,
        };
        let process = Isolation::Process {
            level: ProcessIsolation::Process,
        };
        let frame = Isolation::Document {
            level: DocumentIsolation::OpaqueOriginFrame,
        };

        assert!(isolation_meets(container, process));
        assert!(!isolation_meets(process, container));
        assert!(isolation_meets(container, container));
        // There is no answer to "is a browser frame stronger than a process",
        // and this is where the absence of one is enforced.
        assert!(!isolation_meets(container, frame));
        assert!(!isolation_meets(frame, container));
    }

    #[test]
    fn the_wire_form_is_the_one_the_typescript_contract_froze() {
        let event = SandboxEvent::Settled {
            outcome: SandboxOutcome::Refused {
                reason: RefusalReason::PermissionIsOff,
                mount_index: None,
                protected_root: None,
            },
            usage: RunUsage {
                wall_clock_ms: 0,
                cpu_ms: None,
                peak_memory_bytes: None,
                output_bytes: 0,
                dropped_output_bytes: 0,
            },
        };
        let json = serde_json::to_string(&event).expect("serialises");
        assert!(json.contains("\"type\":\"settled\""), "{json}");
        assert!(json.contains("\"kind\":\"refused\""), "{json}");
        assert!(json.contains("\"reason\":\"permissionIsOff\""), "{json}");
        assert!(json.contains("\"droppedOutputBytes\":0"), "{json}");
    }

    /// Reads the TypeScript contract and extracts one `as const` string array.
    ///
    /// A dumb string scan on purpose, for the reason
    /// `rust_and_typescript_allowlists_are_identical` gives for the same
    /// technique in `src-tauri/src/ipc/mod.rs`: no TS toolchain exists inside
    /// `cargo test`, and a parser here would be more code than the thing it
    /// checks.
    fn typescript_string_array(name: &str) -> Vec<String> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../src/platform/contract-sandbox.ts"
        );
        let source = std::fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("cannot read the TS contract at {path}: {error}"));
        let marker = format!("export const {name}");
        let start = source
            .find(&marker)
            .unwrap_or_else(|| panic!("src/platform/contract-sandbox.ts must export {name}"));
        let open = source[start..]
            .find('[')
            .unwrap_or_else(|| panic!("{name} must be an array literal"))
            + start;
        let close = source[open..]
            .find(']')
            .unwrap_or_else(|| panic!("{name}'s array is unterminated"))
            + open;
        source[open + 1..close]
            .split(',')
            .map(|entry| entry.trim().trim_matches(['\'', '"', '\n', ' ']).to_owned())
            .filter(|entry| !entry.is_empty())
            .collect()
    }

    /// The base environment is one list in two languages, and this is what keeps
    /// it one list.
    ///
    /// [`SANDBOX_BASE_ENVIRONMENT_POSIX`] above is a hand-written parallel copy
    /// of the TypeScript constant — the "hand-maintained parallel pair" that
    /// `PROCESS_ISOLATION_STRENGTH` in `src/platform/contract-sandbox.ts` calls
    /// this project's central defect in miniature — and it had no parity check.
    /// Neither direction of drift is a type error and neither is visible:
    /// a key added on the TypeScript side and not here makes
    /// `environmentNamesCollide` refuse a name the host no longer injects, and a
    /// key dropped there and left here lets a caller legally set a variable the
    /// host also sets, where the last writer wins and neither half knows.
    ///
    /// This pins the two constants to each other. What the host actually puts
    /// inside a run is a separate question, asserted from inside a real run by
    /// `the_run_sees_the_base_environment_the_callers_entries_and_nothing_else`;
    /// the two together are the whole loop from the frozen list to the child's
    /// environment.
    #[test]
    fn the_base_environment_list_is_the_one_the_typescript_contract_froze() {
        let typescript = typescript_string_array("SANDBOX_BASE_ENVIRONMENT_POSIX");
        let rust: Vec<String> = SANDBOX_BASE_ENVIRONMENT_POSIX
            .iter()
            .map(|name| name.to_string())
            .collect();
        assert_eq!(
            rust, typescript,
            "the Rust `SANDBOX_BASE_ENVIRONMENT_POSIX` and the TypeScript one have drifted \
             apart. The contract calls its list \"the complete list\" of keys the host adds, \
             and two complete lists that disagree are neither."
        );

        // A duplicate would let the two lists agree as sets while disagreeing
        // about what "these are the keys, and no others" enumerates.
        let mut unique = rust.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), rust.len(), "a key is listed twice");
    }

    #[test]
    fn a_drawn_language_carrying_a_scripts_field_is_malformed() {
        let svg_with_scripts = DocumentProgram {
            language: DocumentLanguage::Svg,
            source: "<svg/>".into(),
            scripts: Some(DocumentScripts::SandboxedNullOrigin),
        };
        assert!(svg_with_scripts.validate().is_err());

        let html_without_scripts = DocumentProgram {
            language: DocumentLanguage::Html,
            source: "<p/>".into(),
            scripts: None,
        };
        assert!(html_without_scripts.validate().is_err());
    }
}
