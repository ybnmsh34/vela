//! **The escape battery, and the rules that hold without one.**
//!
//! The reference study (`docs/references/unsloth-studio.md`) records a sandbox
//! escape that was closed the same day as "completed" and reported still
//! reachable the next. The one part of that report that needed no interpretation
//! is *how the reporter checked*: not by asking the model whether it had escaped,
//! but by looking at the file on disk. Every test below is written that way. A
//! run is asked to reach something; the assertion is about what came back, and
//! for the filesystem tests there is a control asserting that the thing being
//! reached is genuinely reachable from outside — a battery that passes because
//! the target does not exist has demonstrated nothing.
//!
//! Two groups:
//!
//!  - the tests that call [`run_confined`] execute inside WSL. They are skipped,
//!    loudly, on a machine with no WSL distribution, because there is nothing
//!    there to make a claim about. Everything they assert was watched to pass
//!    and, for the escape cases, watched to fail against a weakened launcher.
//!  - the rest decide refusals and approvals, spawn nothing, and run anywhere.

use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use vela_sandbox::admission::{ProtectedPaths, SandboxConfig};
use vela_sandbox::contract::*;
use vela_sandbox::host::{SandboxEventSink, SandboxHost};
use vela_sandbox::wsl::WslBackend;
use vela_sandbox::{DEFAULT_PROJECT_ID, HOST_CEILINGS};

/* -------------------------------------------------------------------------- */
/* harness                                                                    */
/* -------------------------------------------------------------------------- */

#[derive(Default)]
struct Collector {
    events: Mutex<Vec<SandboxEventEnvelope>>,
}

struct Sink(Arc<Collector>);

impl SandboxEventSink for Sink {
    fn emit(&self, envelope: SandboxEventEnvelope) {
        self.0.events.lock().expect("event lock").push(envelope);
    }
}

impl Collector {
    fn snapshot(&self) -> Vec<SandboxEventEnvelope> {
        self.events.lock().expect("event lock").clone()
    }

    fn settled(&self) -> Option<(SandboxOutcome, RunUsage)> {
        self.snapshot().into_iter().find_map(|envelope| {
            match envelope.event {
                SandboxEvent::Settled { outcome, usage } => Some((outcome, usage)),
                _ => None,
            }
        })
    }

    fn text(&self, stream: OutputStream) -> String {
        self.snapshot()
            .into_iter()
            .filter_map(|envelope| match envelope.event {
                SandboxEvent::Output {
                    stream: got, text, ..
                } if got == stream => Some(text),
                _ => None,
            })
            .collect()
    }
}

fn config(permission: PermissionLevel) -> SandboxConfig {
    SandboxConfig {
        permission,
        profile: default_auto_approval_profile(),
        known_projects: vec![DEFAULT_PROJECT_ID.to_string()],
        protected: ProtectedPaths::default(),
        app_data_dir: None,
        ceilings: HOST_CEILINGS,
        maximum_concurrent_runs: 4,
    }
}

fn host_with(
    permission: PermissionLevel,
    backend: Option<WslBackend>,
) -> (Arc<SandboxHost>, Arc<Collector>) {
    let collector = Arc::new(Collector::default());
    let host = Arc::new(SandboxHost::new(
        config(permission),
        backend,
        Arc::new(Sink(Arc::clone(&collector))),
    ));
    (host, collector)
}

/// A backend that names a distribution without proving one is there. Enough for
/// every test that is refused before anything is spawned.
fn declared_backend() -> Option<WslBackend> {
    Some(WslBackend::for_distro("Ubuntu"))
}

fn submit_of(source: &str) -> SandboxSubmitReq {
    SandboxSubmitReq {
        run_id: format!("run-{}", next_id()),
        project_id: DEFAULT_PROJECT_ID.to_string(),
        program: SandboxProgram::Process(ProcessProgram {
            language: ProcessLanguage::Bash,
            source: source.to_string(),
            working_directory: ProcessWorkingDirectory::Scratch,
            environment: Vec::new(),
            stdin: None,
        }),
        filesystem: FilesystemScope {
            mounts: Vec::new(),
            scratch: ScratchRequest {
                guest_path: None,
                retain_after_settled: false,
            },
            outside_mounts: OutsideMounts::Denied,
        },
        network: NetworkPolicy::Denied,
        limits: DEFAULT_PROCESS_LIMITS,
        minimum_isolation: Isolation::Process {
            level: ProcessIsolation::Container,
        },
    }
}

fn next_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::SeqCst)
}

fn wait_for_settled(collector: &Collector, within: Duration) -> (SandboxOutcome, RunUsage) {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if let Some(settled) = collector.settled() {
            return settled;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!(
        "no `settled` event within {within:?}; every admitted run settles exactly once. \
         Events so far: {:?}",
        collector.snapshot()
    );
}

/// `None` when this machine has no WSL distribution, with a loud line on stderr
/// so a green run on such a machine cannot be read as evidence.
fn boundary_backend() -> Option<WslBackend> {
    match WslBackend::detect() {
        Some(backend) => Some(backend),
        None => {
            eprintln!(
                "SKIPPED: no WSL distribution on this machine, so there is no boundary to \
                 make a claim about. This test asserts nothing here."
            );
            None
        }
    }
}

/// Runs the program to completion inside the real boundary.
fn run_confined(source: &str, mounts: Vec<Mount>) -> Option<(Arc<Collector>, SandboxOutcome)> {
    let backend = boundary_backend()?;
    let (host, collector) = host_with(PermissionLevel::Full, Some(backend));
    let mut request = submit_of(source);
    request.filesystem.mounts = mounts;
    host.submit(request).expect("admitted");
    let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(120));
    Some((collector, outcome))
}

/* -------------------------------------------------------------------------- */
/* the escape battery                                                         */
/* -------------------------------------------------------------------------- */

/// A file every Windows install has and every user can read. The control below
/// proves this test is not passing because the target is absent.
const WINDOWS_WITNESS: &str = r"C:\Windows\System32\drivers\etc\hosts";

#[test]
fn the_users_windows_filesystem_is_not_reachable_from_inside_a_run() {
    assert!(
        Path::new(WINDOWS_WITNESS).exists() && std::fs::read(WINDOWS_WITNESS).is_ok(),
        "the control failed: this user cannot read {WINDOWS_WITNESS} either, so the \
         assertion below would pass for the wrong reason"
    );

    // The two counts are labelled rather than printed bare. Unlabelled, one
    // assertion covered both — `any(line == "0")` was satisfied by whichever
    // count happened to be zero, and stayed green with the launcher's
    // `umount -l` loop replaced by a no-op.
    let Some((collector, outcome)) = run_confined(
        "cat /mnt/c/Windows/System32/drivers/etc/hosts >/dev/null 2>&1 \
           && echo REACHED || echo blocked
         printf 'mnt-entries=%s\\n' \"$(ls /mnt | wc -l)\"
         printf 'ninep-mounts=%s\\n' \"$(grep -c 9p /proc/self/mountinfo || true)\"",
        Vec::new(),
    ) else {
        return;
    };

    let stdout = collector.text(OutputStream::Stdout);
    assert!(
        matches!(outcome, SandboxOutcome::Exited { exit_code: 0 }),
        "outcome was {outcome:?}, stdout {stdout:?}"
    );
    assert!(
        !stdout.contains("REACHED"),
        "the run read a file on the user's Windows disk. stdout: {stdout:?}"
    );
    assert!(
        stdout.contains("blocked"),
        "expected the read to fail; stdout: {stdout:?}"
    );
    assert!(
        stdout.lines().any(|line| line.trim() == "mnt-entries=0"),
        "`/mnt` must be empty; stdout: {stdout:?}"
    );
    // The other half, and the one the `umount -l` loop is there for: an empty
    // `/mnt` with a 9p mount still in the table is a drive the run can reach by
    // some other name.
    assert!(
        stdout.lines().any(|line| line.trim() == "ninep-mounts=0"),
        "no 9p mount may remain in the run's mount table; stdout: {stdout:?}"
    );
}

#[test]
fn a_granted_directory_is_readable_and_the_directory_beside_it_is_not() {
    let temp = tempfile::tempdir().expect("temp dir");
    let granted = temp.path().join("granted");
    let secret = temp.path().join("secret");
    std::fs::create_dir_all(&granted).expect("granted dir");
    std::fs::create_dir_all(&secret).expect("secret dir");
    std::fs::write(granted.join("in.txt"), b"granted-bytes").expect("granted file");
    std::fs::write(secret.join("keys.txt"), b"SECRET-BYTES").expect("secret file");

    let mounts = vec![Mount {
        host_path: granted.to_string_lossy().into_owned(),
        guest_path: "/work".into(),
        mode: MountMode::ReadWrite,
        materialisation: MountMaterialisation::Bind,
    }];

    let Some((collector, outcome)) = run_confined(
        "cat /work/in.txt
         cat /work/../secret/keys.txt 2>/dev/null && echo SIBLING_REACHED || echo sibling-blocked
         echo written-by-the-run > /work/out.txt && echo wrote-through",
        mounts,
    ) else {
        return;
    };

    let stdout = collector.text(OutputStream::Stdout);
    assert!(
        matches!(outcome, SandboxOutcome::Exited { exit_code: 0 }),
        "outcome {outcome:?}, stdout {stdout:?}"
    );
    assert!(stdout.contains("granted-bytes"), "stdout {stdout:?}");
    assert!(
        !stdout.contains("SIBLING_REACHED") && !stdout.contains("SECRET-BYTES"),
        "the run reached a directory beside the one it was granted. stdout {stdout:?}"
    );
    // The grant is a bind and not a copy, so the write is on the user's disk.
    // The control for the negative assertion above: the sibling really is there.
    assert_eq!(
        std::fs::read_to_string(granted.join("out.txt")).expect("the write landed"),
        "written-by-the-run\n"
    );
    assert!(secret.join("keys.txt").exists(), "the sibling really exists");
}

#[test]
fn a_read_only_grant_cannot_be_written() {
    let temp = tempfile::tempdir().expect("temp dir");
    std::fs::write(temp.path().join("in.txt"), b"read-me").expect("file");

    let mounts = vec![Mount {
        host_path: temp.path().to_string_lossy().into_owned(),
        guest_path: "/work".into(),
        mode: MountMode::ReadOnly,
        materialisation: MountMaterialisation::Bind,
    }];

    let Some((collector, _outcome)) = run_confined(
        "cat /work/in.txt
         echo nope > /work/out.txt 2>/dev/null && echo WROTE || echo write-denied",
        mounts,
    ) else {
        return;
    };

    let stdout = collector.text(OutputStream::Stdout);
    assert!(stdout.contains("read-me"), "stdout {stdout:?}");
    assert!(!stdout.contains("WROTE"), "stdout {stdout:?}");
    assert!(stdout.contains("write-denied"), "stdout {stdout:?}");
    assert!(
        !temp.path().join("out.txt").exists(),
        "a read-only grant let a file through onto the user's disk"
    );
}

#[test]
fn a_run_has_no_network_at_all() {
    let Some((collector, _outcome)) = run_confined(
        "(exec 3<>/dev/tcp/1.1.1.1/80) 2>/dev/null && echo NET_REACHED || echo net-blocked
         ip -o link show 2>/dev/null | wc -l || echo no-ip-tool",
        Vec::new(),
    ) else {
        return;
    };
    let stdout = collector.text(OutputStream::Stdout);
    assert!(
        !stdout.contains("NET_REACHED"),
        "the run opened an outbound connection. stdout {stdout:?}"
    );
    assert!(stdout.contains("net-blocked"), "stdout {stdout:?}");
}

#[test]
fn a_run_cannot_regain_privilege_and_cannot_write_the_distribution() {
    let Some((collector, _outcome)) = run_confined(
        "id -u
         sudo -n true 2>/dev/null && echo SUDO_WORKED || echo sudo-denied
         touch /etc/vela-was-here 2>/dev/null && echo ROOTFS_WRITTEN || echo rootfs-read-only
         cat /proc/self/status | grep NoNewPrivs",
        Vec::new(),
    ) else {
        return;
    };
    let stdout = collector.text(OutputStream::Stdout);
    assert!(stdout.contains("65534"), "stdout {stdout:?}");
    assert!(!stdout.contains("SUDO_WORKED"), "stdout {stdout:?}");
    assert!(!stdout.contains("ROOTFS_WRITTEN"), "stdout {stdout:?}");
    assert!(
        stdout.contains("NoNewPrivs:\t1"),
        "PR_SET_NO_NEW_PRIVS is what makes `sudo` fail by mechanism rather than \
         by a list somebody maintained. stdout {stdout:?}"
    );
}

#[test]
fn a_program_whose_text_is_hostile_to_a_shell_still_runs_as_written() {
    // Every one of these would end the guest script early, or run something
    // else entirely, if the source were pasted into a command line anywhere.
    let Some((collector, outcome)) = run_confined(
        "printf '%s\\n' \"'; touch /vela/pwned; #\"\n\
         printf '%s\\n' '$(id -u)'\n\
         echo done",
        Vec::new(),
    ) else {
        return;
    };
    let stdout = collector.text(OutputStream::Stdout);
    assert!(
        matches!(outcome, SandboxOutcome::Exited { exit_code: 0 }),
        "outcome {outcome:?} stdout {stdout:?}"
    );
    assert!(stdout.contains("'; touch /vela/pwned; #"), "stdout {stdout:?}");
    assert!(stdout.contains("$(id -u)"), "stdout {stdout:?}");
    assert!(stdout.contains("done"), "stdout {stdout:?}");
}

/* -------------------------------------------------------------------------- */
/* streaming, cancelling, limits                                              */
/* -------------------------------------------------------------------------- */

#[test]
fn output_arrives_in_the_programs_own_order_within_one_stream() {
    let Some((collector, outcome)) = run_confined(
        "for i in 1 2 3 4 5; do echo line-$i; done
         echo to-stderr >&2",
        Vec::new(),
    ) else {
        return;
    };
    assert!(matches!(outcome, SandboxOutcome::Exited { exit_code: 0 }));
    assert_eq!(
        collector.text(OutputStream::Stdout),
        "line-1\nline-2\nline-3\nline-4\nline-5\n"
    );
    assert_eq!(collector.text(OutputStream::Stderr), "to-stderr\n");

    let types: Vec<&'static str> = collector
        .snapshot()
        .iter()
        .map(|envelope| match envelope.event {
            SandboxEvent::Accepted { .. } => "accepted",
            SandboxEvent::Started { .. } => "started",
            SandboxEvent::Output { .. } => "output",
            SandboxEvent::Settled { .. } => "settled",
            _ => "other",
        })
        .collect();
    assert_eq!(types.first(), Some(&"accepted"));
    assert_eq!(types.get(1), Some(&"started"));
    assert_eq!(types.last(), Some(&"settled"));
    // `seq` is dense and 0-based, per run, assigned in one place.
    for (index, envelope) in collector.snapshot().iter().enumerate() {
        assert_eq!(envelope.seq, index as u64);
    }
}

#[test]
fn stdin_reaches_the_program_and_is_then_closed() {
    let Some(backend) = boundary_backend() else {
        return;
    };
    let (host, collector) = host_with(PermissionLevel::Full, Some(backend));
    let mut request = submit_of("cat; echo '[eof]'");
    if let SandboxProgram::Process(program) = &mut request.program {
        program.stdin = Some("fed-in\n".into());
    }
    host.submit(request).expect("admitted");
    let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(120));
    let stdout = collector.text(OutputStream::Stdout);
    assert!(
        matches!(outcome, SandboxOutcome::Exited { exit_code: 0 }),
        "outcome {outcome:?} stdout {stdout:?}"
    );
    assert_eq!(stdout, "fed-in\n[eof]\n");
}

#[test]
fn cancelling_stops_the_run_and_reaches_every_descendant() {
    let Some(backend) = boundary_backend() else {
        return;
    };
    let (host, collector) = host_with(PermissionLevel::Full, Some(backend));
    let request = submit_of("echo alive; sleep 120; echo NEVER");
    let run_id = request.run_id.clone();
    host.submit(request).expect("admitted");

    let deadline = Instant::now() + Duration::from_secs(90);
    while Instant::now() < deadline {
        if collector.text(OutputStream::Stdout).contains("alive") {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        collector.text(OutputStream::Stdout).contains("alive"),
        "the run never started; events {:?}",
        collector.snapshot()
    );

    let answer = host.cancel(SandboxCancelReq {
        run_id: run_id.clone(),
        reason: CancelReason::User,
    });
    assert!(answer.cancelled);

    let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(60));
    assert!(
        matches!(
            outcome,
            SandboxOutcome::Cancelled {
                reason: CancelReason::User
            }
        ),
        "outcome {outcome:?}"
    );
    assert!(
        !collector.text(OutputStream::Stdout).contains("NEVER"),
        "the program kept running after cancellation"
    );

    // Cancelling a settled run is a race, not an error.
    let again = host.cancel(SandboxCancelReq {
        run_id,
        reason: CancelReason::User,
    });
    assert!(!again.cancelled);
}

#[test]
fn a_run_that_will_not_finish_is_killed_at_the_wall_clock() {
    let Some(backend) = boundary_backend() else {
        return;
    };
    let (host, collector) = host_with(PermissionLevel::Full, Some(backend));
    let mut request = submit_of("echo working; sleep 120; echo NEVER");
    request.limits.wall_clock_ms = 3_000;
    host.submit(request).expect("admitted");

    let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(120));
    assert!(
        matches!(
            outcome,
            SandboxOutcome::LimitExceeded {
                limit: LimitName::WallClockMs
            }
        ),
        "outcome {outcome:?}; events {:?}",
        collector.snapshot()
    );
    assert!(!collector.text(OutputStream::Stdout).contains("NEVER"));
}

#[test]
fn exceeding_the_output_budget_truncates_once_and_does_not_kill_the_run() {
    let Some(backend) = boundary_backend() else {
        return;
    };
    let (host, collector) = host_with(PermissionLevel::Full, Some(backend));
    let mut request = submit_of(
        "i=0; while [ $i -lt 400 ]; do printf '%s\\n' \
         aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; \
         i=$((i+1)); done; exit 7",
    );
    request.limits.output_bytes = 512;
    host.submit(request).expect("admitted");

    let (outcome, usage) = wait_for_settled(&collector, Duration::from_secs(120));
    // A build that emitted eight megabytes of warnings and then succeeded is
    // more useful than a build killed for being verbose.
    assert!(
        matches!(outcome, SandboxOutcome::Exited { exit_code: 7 }),
        "outcome {outcome:?}"
    );
    let truncations = collector
        .snapshot()
        .iter()
        .filter(|envelope| matches!(envelope.event, SandboxEvent::Truncated { .. }))
        .count();
    assert_eq!(truncations, 1, "exactly one `truncated` per run");
    assert!(usage.dropped_output_bytes > 0);
    assert!(usage.output_bytes <= 512);
}

/* -------------------------------------------------------------------------- */
/* the permission gate — no WSL needed, nothing is spawned                    */
/* -------------------------------------------------------------------------- */

#[test]
fn off_refuses_every_submit_before_anything_can_run() {
    let (host, collector) = host_with(PermissionLevel::Off, declared_backend());
    host.submit(submit_of("echo hi")).expect("admitted");
    let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(5));
    assert!(matches!(
        outcome,
        SandboxOutcome::Refused {
            reason: RefusalReason::PermissionIsOff,
            ..
        }
    ));
    // Admission is not approval: the refusal arrives as the run's one terminal
    // event, and nothing was accepted or started on the way.
    assert!(collector
        .snapshot()
        .iter()
        .all(|envelope| matches!(envelope.event, SandboxEvent::Settled { .. })));
}

#[test]
fn ask_stops_for_a_person_and_a_denial_settles_the_run_refused() {
    let (host, collector) = host_with(PermissionLevel::Ask, declared_backend());
    let request = submit_of("echo hi");
    let run_id = request.run_id.clone();
    host.submit(request).expect("admitted");

    let deadline = Instant::now() + Duration::from_secs(5);
    let digest = loop {
        let found = collector.snapshot().into_iter().find_map(|envelope| {
            match envelope.event {
                SandboxEvent::AwaitingApproval { request } => Some(request),
                _ => None,
            }
        });
        if let Some(request) = found {
            // The person is shown the exact program and the whole grant.
            assert!(matches!(request.program, SandboxProgram::Process(_)));
            assert_eq!(request.grant.network, NetworkPolicy::Denied);
            break request.request_digest;
        }
        assert!(Instant::now() < deadline, "no approval was ever requested");
        std::thread::sleep(Duration::from_millis(10));
    };

    // A digest that was not handed out is a renderer bug, not a decision.
    assert!(host
        .approve(SandboxApproveReq {
            run_id: run_id.clone(),
            request_digest: "not-the-digest".into(),
            decision: ApprovalDecision::AllowOnce,
        })
        .is_err());
    assert!(collector.settled().is_none(), "a bad digest settles nothing");

    host.approve(SandboxApproveReq {
        run_id,
        request_digest: digest,
        decision: ApprovalDecision::Deny,
    })
    .expect("the digest matches");

    let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(5));
    assert!(matches!(
        outcome,
        SandboxOutcome::Refused {
            reason: RefusalReason::ApprovalDenied,
            ..
        }
    ));
}

#[test]
fn releasing_a_run_that_is_still_waiting_for_a_person_abandons_it() {
    let (host, collector) = host_with(PermissionLevel::Ask, declared_backend());
    let request = submit_of("echo hi");
    let run_id = request.run_id.clone();
    host.submit(request).expect("admitted");

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if collector
            .snapshot()
            .iter()
            .any(|envelope| matches!(envelope.event, SandboxEvent::AwaitingApproval { .. }))
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    host.release(SandboxReleaseReq { run_id });

    let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(5));
    assert!(
        matches!(
            outcome,
            SandboxOutcome::Refused {
                reason: RefusalReason::ApprovalAbandoned,
                ..
            }
        ),
        "outcome {outcome:?}"
    );
}

#[test]
fn approve_still_asks_when_the_run_falls_outside_the_shipped_profile() {
    // The shipped profile has no readable roots, so a run with any mount at all
    // prompts. This is the profile behaving as designed, not a placeholder.
    let temp = tempfile::tempdir().expect("temp dir");
    let (host, collector) = host_with(PermissionLevel::Approve, declared_backend());
    let mut request = submit_of("echo hi");
    request.filesystem.mounts = vec![Mount {
        host_path: temp.path().to_string_lossy().into_owned(),
        guest_path: "/work".into(),
        mode: MountMode::ReadOnly,
        materialisation: MountMaterialisation::Bind,
    }];
    host.submit(request).expect("admitted");

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut asked = false;
    while Instant::now() < deadline && !asked {
        asked = collector
            .snapshot()
            .iter()
            .any(|envelope| matches!(envelope.event, SandboxEvent::AwaitingApproval { .. }));
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(asked, "events {:?}", collector.snapshot());
}

#[test]
fn approve_runs_a_scratch_only_container_run_without_asking() {
    // Every clause of the shipped profile holds: the submit itself demanded
    // `container`, the network is denied, the limits are the defaults, and
    // there is no mount to fall outside a root. The floor moved down because a
    // mechanism moved up.
    let Some(backend) = boundary_backend() else {
        return;
    };
    let (host, collector) = host_with(PermissionLevel::Approve, Some(backend));
    host.submit(submit_of("echo approved")).expect("admitted");
    let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(120));
    assert!(
        !collector
            .snapshot()
            .iter()
            .any(|envelope| matches!(envelope.event, SandboxEvent::AwaitingApproval { .. })),
        "a run inside the profile must not prompt; events {:?}",
        collector.snapshot()
    );
    assert!(
        matches!(outcome, SandboxOutcome::Exited { exit_code: 0 }),
        "outcome {outcome:?}"
    );
    assert_eq!(collector.text(OutputStream::Stdout), "approved\n");
}

#[test]
fn a_caller_that_demands_more_isolation_than_this_host_has_is_refused() {
    let (host, collector) = host_with(PermissionLevel::Full, declared_backend());
    let mut request = submit_of("echo hi");
    request.minimum_isolation = Isolation::Process {
        level: ProcessIsolation::MicroVm,
    };
    host.submit(request).expect("admitted");
    let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(5));
    assert!(matches!(
        outcome,
        SandboxOutcome::Refused {
            reason: RefusalReason::IsolationUnavailable,
            ..
        }
    ));
}

#[test]
fn a_process_program_with_a_document_floor_is_a_family_mismatch() {
    let (host, collector) = host_with(PermissionLevel::Full, declared_backend());
    let mut request = submit_of("echo hi");
    request.minimum_isolation = Isolation::Document {
        level: DocumentIsolation::OpaqueOriginFrame,
    };
    host.submit(request).expect("admitted");
    let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(5));
    assert!(matches!(
        outcome,
        SandboxOutcome::Refused {
            reason: RefusalReason::IsolationFamilyMismatch,
            ..
        }
    ));
}

#[test]
fn python_and_every_document_language_are_refused_as_unsupported() {
    for program in [
        SandboxProgram::Process(ProcessProgram {
            language: ProcessLanguage::Python,
            source: "print(1)".into(),
            working_directory: ProcessWorkingDirectory::Scratch,
            environment: Vec::new(),
            stdin: None,
        }),
        SandboxProgram::Document(DocumentProgram {
            language: DocumentLanguage::Svg,
            source: "<svg/>".into(),
            scripts: None,
        }),
    ] {
        let (host, collector) = host_with(PermissionLevel::Full, declared_backend());
        let mut request = submit_of("unused");
        let document = matches!(program, SandboxProgram::Document(_));
        request.program = program;
        if document {
            request.minimum_isolation = Isolation::Document {
                level: DocumentIsolation::SameOrigin,
            };
        }
        host.submit(request).expect("admitted");
        let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(5));
        assert!(
            matches!(
                outcome,
                SandboxOutcome::Refused {
                    reason: RefusalReason::LanguageUnsupported,
                    ..
                }
            ),
            "outcome {outcome:?}"
        );
    }
}

#[test]
fn a_mount_of_a_protected_root_names_the_category_and_not_the_path() {
    let temp = tempfile::tempdir().expect("temp dir");
    let keys = temp.path().join(".ssh");
    std::fs::create_dir_all(&keys).expect("key dir");

    let collector = Arc::new(Collector::default());
    let mut settings = config(PermissionLevel::Full);
    settings.protected.user_key_material = vec![std::fs::canonicalize(&keys)
        .map(|path| vela_sandbox::paths::strip_verbatim(&path))
        .expect("canonical")];
    let host = Arc::new(SandboxHost::new(
        settings,
        declared_backend(),
        Arc::new(Sink(Arc::clone(&collector))),
    ));

    let mut request = submit_of("echo hi");
    request.filesystem.mounts = vec![Mount {
        host_path: keys.to_string_lossy().into_owned(),
        guest_path: "/work".into(),
        mode: MountMode::ReadOnly,
        materialisation: MountMaterialisation::Bind,
    }];
    host.submit(request).expect("admitted");

    let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(5));
    match outcome {
        SandboxOutcome::Refused {
            reason: RefusalReason::MountIsProtectedRoot,
            mount_index,
            protected_root,
        } => {
            assert_eq!(mount_index, Some(0));
            // A category, never the path: naming it would put the location of
            // the user's key material into an error a surface may log.
            assert_eq!(protected_root, Some(ProtectedRoot::UserKeyMaterial));
        }
        other => panic!("outcome {other:?}"),
    }
}

#[test]
fn a_network_policy_this_backend_cannot_impose_is_refused_and_not_downgraded() {
    for policy in [
        NetworkPolicy::Allowed,
        NetworkPolicy::LoopbackOnly { ports: vec![8033] },
    ] {
        let (host, collector) = host_with(PermissionLevel::Full, declared_backend());
        let mut request = submit_of("echo hi");
        request.network = policy;
        host.submit(request).expect("admitted");
        let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(5));
        assert!(
            matches!(
                outcome,
                SandboxOutcome::Refused {
                    reason: RefusalReason::NetworkPolicyUnavailable,
                    ..
                }
            ),
            "outcome {outcome:?}"
        );
    }
}

#[test]
fn a_caller_setting_a_host_owned_environment_name_collides() {
    let (host, collector) = host_with(PermissionLevel::Full, declared_backend());
    let mut request = submit_of("echo hi");
    if let SandboxProgram::Process(program) = &mut request.program {
        program.environment = vec![EnvironmentEntry {
            name: "HOME".into(),
            value: "/mnt/c".into(),
        }];
    }
    host.submit(request).expect("admitted");
    let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(5));
    assert!(
        matches!(
            outcome,
            SandboxOutcome::Refused {
                reason: RefusalReason::EnvironmentNamesCollide,
                ..
            }
        ),
        "outcome {outcome:?}"
    );
}

#[test]
fn two_runs_may_not_share_an_id() {
    let (host, _collector) = host_with(PermissionLevel::Ask, declared_backend());
    let request = submit_of("echo hi");
    let duplicate = SandboxSubmitReq {
        run_id: request.run_id.clone(),
        ..submit_of("echo other")
    };
    host.submit(request).expect("admitted");
    // A failure that rejects the invoke instead of settling the run.
    assert!(host.submit(duplicate).is_err());
}

/* -------------------------------------------------------------------------- */
/* malformed payloads — rejected at the invoke, never settled `hostFailed`     */
/*                                                                            */
/* `HostFailureReason` is defined by the frozen contract as "a host-side       */
/* failure that is nobody's request being wrong". Each shape below is exactly  */
/* the caller's request being wrong, and each one was, in an earlier draft,    */
/* decided inside the run thread the invoke had already answered `admitted` —  */
/* so the caller who asked for `copyIn`, or named a directory that is not      */
/* there, was told Vela had an internal failure and went looking in the wrong  */
/* place. The decision now runs on the invoke's thread; these tests are what   */
/* holds it there.                                                            */
/* -------------------------------------------------------------------------- */

/// Submits, and insists the answer was `INVALID_PAYLOAD` on the invoke and not
/// a settled run of any kind. Returns the message, so each caller can say which
/// shape it is about.
#[track_caller]
fn rejected_at_the_invoke(request: SandboxSubmitReq) -> String {
    let (host, collector) = host_with(PermissionLevel::Full, declared_backend());
    let message = match host.submit(request) {
        Err(error) => error.0,
        Ok(response) => {
            let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(5));
            panic!(
                "the invoke answered `admitted: {}` and the run settled {outcome:?}. A \
                 malformed request must be `INVALID_PAYLOAD` on the invoke: settling it \
                 `hostFailed` spends a reason the contract defines as nobody's request \
                 being wrong on precisely the caller's request being wrong",
                response.admitted
            );
        }
    };
    // Nothing was spawned and nothing was said — no `accepted`, no `settled`,
    // and in particular no `hostFailed` arriving after the rejection.
    assert!(
        collector.snapshot().is_empty(),
        "a rejected submit emitted {:?}",
        collector.snapshot()
    );
    // The run was never registered, so the id is free for the corrected
    // request rather than spent on a payload the host would not take.
    assert_eq!(
        host.policy().active_runs,
        0,
        "a rejected submit left the run id in flight"
    );
    message
}

#[test]
fn a_materialisation_this_host_does_not_serve_is_a_malformed_payload() {
    let temp = tempfile::tempdir().expect("temp dir");
    let mut request = submit_of("echo hi");
    request.filesystem.mounts = vec![Mount {
        host_path: temp.path().to_string_lossy().into_owned(),
        guest_path: "/work".into(),
        mode: MountMode::ReadOnly,
        // The mode whose only alternative was serving it quietly as `bind`,
        // which would write the user's files during a run promised it could not.
        materialisation: MountMaterialisation::CopyIn,
    }];
    let message = rejected_at_the_invoke(request);
    assert!(
        message.contains("bind"),
        "the message must name what this host serves; got {message:?}"
    );
}

#[test]
fn a_host_path_that_does_not_resolve_is_a_malformed_payload() {
    let temp = tempfile::tempdir().expect("temp dir");
    let absent = temp.path().join("no-such-directory");
    let mut request = submit_of("echo hi");
    request.filesystem.mounts = vec![Mount {
        host_path: absent.to_string_lossy().into_owned(),
        guest_path: "/work".into(),
        mode: MountMode::ReadOnly,
        materialisation: MountMaterialisation::Bind,
    }];
    let message = rejected_at_the_invoke(request);
    // There is no `RefusalReason` for "that directory is not there", and
    // reusing a neighbouring member would put a wrong sentence in front of the
    // user. See `paths::resolve_host_directory`.
    assert!(
        message.contains("hostPath"),
        "the message must name the field; got {message:?}"
    );
}

#[test]
fn a_program_past_what_this_host_can_carry_is_a_malformed_payload() {
    let oversized = "#".repeat(vela_sandbox::admission::MAX_PROGRAM_BYTES + 1);
    let request = submit_of(&oversized);
    let message = rejected_at_the_invoke(request);
    // The alternative is the worst available failure: the Windows command line
    // truncates the program and the run executes something the user never saw.
    assert!(
        message.contains("bytes"),
        "the message must say how big is too big; got {message:?}"
    );

    // At the limit exactly, the same host takes it: the boundary is the size
    // and not the shape of the request. At `ask`, so this stops for a person
    // rather than spending a WSL launch on 16 KiB of comments.
    let (host, _collector) = host_with(PermissionLevel::Ask, declared_backend());
    let largest = "#".repeat(vela_sandbox::admission::MAX_PROGRAM_BYTES);
    assert!(host.submit(submit_of(&largest)).is_ok());
}

#[test]
fn the_guest_path_project_filesystem_scope_produces_is_a_malformed_payload() {
    // `projectFilesystemScope` in `src/platform/contract-sandbox.ts` builds its
    // host-owned mounts with `guestPath: layout.paths.workspace` — the Windows
    // path repeated. It is not a POSIX path, so this host cannot mount it, and
    // the caller has to be told that by the invoke that carried it.
    let temp = tempfile::tempdir().expect("temp dir");
    let windows_path = temp.path().to_string_lossy().into_owned();
    let mut request = submit_of("echo hi");
    request.filesystem.mounts = vec![Mount {
        host_path: windows_path.clone(),
        guest_path: windows_path,
        mode: MountMode::ReadWrite,
        materialisation: MountMaterialisation::Bind,
    }];
    let message = rejected_at_the_invoke(request);
    assert!(
        message.contains("guest path"),
        "the message must name the field; got {message:?}"
    );
}

#[test]
fn the_policy_snapshot_says_what_this_machine_can_actually_do() {
    let (host, _collector) = host_with(PermissionLevel::Ask, declared_backend());
    let policy = host.policy();
    assert_eq!(policy.permission, PermissionLevel::Ask);
    assert_eq!(policy.guest_platform, GuestPlatform::Posix);
    assert_eq!(policy.languages, vec![SandboxLanguage::Bash]);
    assert_eq!(
        policy.backends.process.isolation,
        Isolation::Process {
            level: ProcessIsolation::Container
        }
    );
    assert_eq!(policy.backends.process.network, EnforcementLevel::Kernel);
    assert_eq!(policy.backends.process.filesystem, EnforcementLevel::Kernel);
    assert_eq!(
        policy.backends.process.limits.memory_bytes,
        EnforcementLevel::Unenforced,
        "there is no cgroup behind this backend and the report must say so"
    );
    assert_eq!(policy.backends.process.evidence, IsolationEvidence::Declared);

    let (empty, _) = host_with(PermissionLevel::Ask, None);
    assert!(empty.policy().languages.is_empty());
    assert_eq!(
        empty.policy().backends.process.isolation,
        Isolation::Process {
            level: ProcessIsolation::None
        }
    );
}

/* -------------------------------------------------------------------------- */
/* rules the frozen contract states as sentences, and what holds them          */
/*                                                                            */
/* Everything below this banner is about a rule `pnpm typecheck` cannot reach: */
/* an ordering, a narrowing, a comparison made over the wrong operand. Each    */
/* one was watched to fail against a named change to the implementation it is  */
/* about, and each doc comment says which change and what the caller sees when */
/* it is made. A test nobody has watched fail is a claim, and claims are the   */
/* thing this repository keeps finding in its own comments.                    */
/* -------------------------------------------------------------------------- */

impl Collector {
    fn events_for(&self, run_id: &str) -> Vec<SandboxEventEnvelope> {
        self.snapshot()
            .into_iter()
            .filter(|envelope| envelope.run_id == run_id)
            .collect()
    }

    fn settled_for(&self, run_id: &str) -> Option<SandboxOutcome> {
        self.events_for(run_id).into_iter().find_map(|envelope| {
            match envelope.event {
                SandboxEvent::Settled { outcome, .. } => Some(outcome),
                _ => None,
            }
        })
    }

    /// What the person was shown, if anybody was asked.
    fn prompt_for(&self, run_id: &str) -> Option<ApprovalRequest> {
        self.events_for(run_id).into_iter().find_map(|envelope| {
            match envelope.event {
                SandboxEvent::AwaitingApproval { request } => Some(request),
                _ => None,
            }
        })
    }

    /// The grant on the `accepted` event — the one the contract's ceiling rule
    /// names, and the one a caller may act on.
    fn accepted_grant(&self, run_id: &str) -> Option<EffectiveGrant> {
        self.events_for(run_id).into_iter().find_map(|envelope| {
            match envelope.event {
                SandboxEvent::Accepted { grant } => Some(grant),
                _ => None,
            }
        })
    }
}

fn host_with_settings(
    settings: SandboxConfig,
    backend: Option<WslBackend>,
) -> (Arc<SandboxHost>, Arc<Collector>) {
    let collector = Arc::new(Collector::default());
    let host = Arc::new(SandboxHost::new(
        settings,
        backend,
        Arc::new(Sink(Arc::clone(&collector))),
    ));
    (host, collector)
}

/// A backend that reports `container` like the real one and cannot start a
/// single process.
///
/// Every test that asks "was a person asked, or was this run accepted" needs the
/// decision and not the run. Admission reads [`WslBackend::report`], which is
/// the same here as for a real distribution, so the decision is identical — and
/// anything that gets past it dies in the launcher instead of spending a WSL
/// start-up. Tests about what a run *does* use [`boundary_backend`] and say so.
fn unreachable_backend() -> Option<WslBackend> {
    Some(WslBackend::for_distro("vela-test-no-such-distribution"))
}

#[track_caller]
fn wait_until(within: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    done()
}

/// `true` if a person was asked, `false` if the run was accepted without one.
/// Anything else settling first is reported as itself rather than read as a
/// silent `false`.
#[track_caller]
fn asked_or_accepted(collector: &Collector, run_id: &str) -> bool {
    let decided = wait_until(Duration::from_secs(20), || {
        collector.prompt_for(run_id).is_some()
            || collector.accepted_grant(run_id).is_some()
            || collector.settled_for(run_id).is_some()
    });
    if collector.prompt_for(run_id).is_some() {
        return true;
    }
    if collector.accepted_grant(run_id).is_some() {
        return false;
    }
    panic!(
        "the run neither asked nor was accepted (decided within the deadline: {decided}); \
         events {:?}",
        collector.events_for(run_id)
    );
}

/// A directory junction, the Windows spelling of the reparse point
/// `CONTRACT-SANDBOX` calls "the same problem wearing Windows clothes". `false`
/// when this machine would not make one, so the caller can say so out loud
/// rather than assert nothing quietly.
fn make_junction(link: &Path, target: &Path) -> bool {
    std::process::Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(link.as_os_str())
        .arg(target.as_os_str())
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
        && link.exists()
}

fn canonical(path: &Path) -> std::path::PathBuf {
    std::fs::canonicalize(path)
        .map(|resolved| vela_sandbox::paths::strip_verbatim(&resolved))
        .expect("the test's own directory resolves")
}

/// A mount, spelled out so a row's intent is legible at the call site.
fn mount_of(host_path: String, guest_path: &str, mode: MountMode) -> Mount {
    Mount {
        host_path,
        guest_path: guest_path.to_string(),
        mode,
        materialisation: MountMaterialisation::Bind,
    }
}

/* -------------------------------------------------------------------------- */
/* resolution before the check                                                */
/* -------------------------------------------------------------------------- */

/// A protected root reached by a different spelling is still a protected root.
///
/// `SANDBOX_PROTECTED_ROOTS` requires `hostPath` to be resolved — symlinks,
/// `..`, `~`, Windows short names — **before** it is checked, and calls checking
/// the unresolved string "the classic bypass". The existing
/// `a_mount_of_a_protected_root_names_the_category_and_not_the_path` hands the
/// host a path that is already canonical, so it holds the category-naming half
/// and nothing about resolution: with `category_for` given
/// `Path::new(&mount.host_path)` it stays green. Neither spelling below is a
/// component prefix of the directory it reaches, so neither is caught by a check
/// on the string.
///
/// Watched to fail with exactly that substitution in `admission::admit`: both
/// spellings were admitted and the run executed with the user's key material
/// mounted. The failure it describes is silent — no refusal, no prompt copy, a
/// run that simply succeeds and reads the keys.
#[test]
fn a_protected_root_reached_by_another_spelling_is_still_a_protected_root() {
    let temp = tempfile::tempdir().expect("temp dir");
    let keys = temp.path().join("keys");
    let decoy = temp.path().join("decoy");
    std::fs::create_dir_all(&keys).expect("key dir");
    std::fs::create_dir_all(&decoy).expect("decoy dir");
    std::fs::write(keys.join("id_ed25519"), b"PRIVATE-KEY-BYTES").expect("key file");

    let mut spellings: Vec<(&'static str, String)> = vec![(
        "a `..` out of a sibling directory and back in",
        decoy.join("..").join("keys").to_string_lossy().into_owned(),
    )];
    let junction = temp.path().join("link-to-keys");
    if make_junction(&junction, &keys) {
        spellings.push((
            "a Windows directory junction",
            junction.to_string_lossy().into_owned(),
        ));
    } else {
        eprintln!(
            "SKIPPED one half: this machine would not create a directory junction, so the \
             reparse-point spelling asserts nothing here. The `..` spelling below still runs."
        );
    }

    for (spelling, host_path) in spellings {
        let mut settings = config(PermissionLevel::Full);
        settings.protected.user_key_material = vec![canonical(&keys)];
        let (host, collector) = host_with_settings(settings, unreachable_backend());
        let mut request = submit_of("cat /work/*");
        request.filesystem.mounts = vec![mount_of(host_path, "/work", MountMode::ReadOnly)];
        host.submit(request).expect("well-formed: the directory is there");

        let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(30));
        match outcome {
            SandboxOutcome::Refused {
                reason: RefusalReason::MountIsProtectedRoot,
                protected_root,
                ..
            } => assert_eq!(protected_root, Some(ProtectedRoot::UserKeyMaterial)),
            other => panic!(
                "{spelling} reached a protected root and the host answered {other:?}. The \
                 protected-root check must run against the path `resolve_host_directory` \
                 produced, not against the string the caller sent."
            ),
        }
    }

    // The control. Without it, a host that refused every mount in this tree
    // would pass the loop above and have demonstrated nothing.
    let mut settings = config(PermissionLevel::Ask);
    settings.protected.user_key_material = vec![canonical(&keys)];
    let (host, collector) = host_with_settings(settings, unreachable_backend());
    let mut request = submit_of("echo hi");
    let run_id = request.run_id.clone();
    request.filesystem.mounts = vec![mount_of(
        decoy.to_string_lossy().into_owned(),
        "/work",
        MountMode::ReadOnly,
    )];
    host.submit(request).expect("admitted");
    assert!(
        asked_or_accepted(&collector, &run_id),
        "the sibling directory is not protected and must reach a person, or the refusals \
         above are about the whole temporary tree rather than about resolution"
    );
}

/* -------------------------------------------------------------------------- */
/* the order the checks run in                                                */
/* -------------------------------------------------------------------------- */

/// At `off`, every submit is `permissionIsOff` **before** anything else about it
/// is looked at.
///
/// `PermissionLevel` says `off` refuses every submit, and `admission`'s own
/// header fixes the order with `permissionIsOff` first. The existing
/// `off_refuses_every_submit_before_anything_can_run` submits a request that is
/// valid in every other respect, so it holds "off refuses" and not "off is
/// first": with the check moved to the end of `admit` it stays green.
///
/// Each row below is a request that is wrong in exactly one other way, and each
/// is asserted twice — `permissionIsOff` at `off`, and its own answer at `full`.
/// The second half is what makes the first mean something: without it a host
/// that refused these for some third reason would pass. This is the pattern the
/// house uses where an ordering is not directly observable — the steps named as
/// data, each one asserted alongside the effect it has.
///
/// Two rows are `INVALID_PAYLOAD` at `full` rather than a refusal, and those are
/// the sharpest: reaching them means the host resolved a caller-supplied path
/// and touched the filesystem for a request it had been told to ignore.
///
/// Watched to fail with the `off` check moved below the project check in
/// `admit`: the row for an unknown project answered `unknownProject`, which
/// tells a user who switched execution off nothing whatever about their own
/// setting.
#[test]
fn off_is_answered_before_the_project_the_mounts_the_language_or_the_network() {
    enum AtFull {
        Refused(RefusalReason),
        RejectedAtTheInvoke,
    }

    let temp = tempfile::tempdir().expect("temp dir");
    let absent = temp.path().join("no-such-directory");
    let present = temp.path().to_string_lossy().into_owned();

    #[allow(clippy::type_complexity)]
    let rows: Vec<(&str, Box<dyn Fn(&mut SandboxSubmitReq)>, AtFull)> = vec![
        (
            "the project id",
            Box::new(|request: &mut SandboxSubmitReq| {
                request.project_id = "not-a-project-this-host-knows".into();
            }),
            AtFull::Refused(RefusalReason::UnknownProject),
        ),
        (
            "the isolation family",
            Box::new(|request: &mut SandboxSubmitReq| {
                request.minimum_isolation = Isolation::Document {
                    level: DocumentIsolation::SameOrigin,
                };
            }),
            AtFull::Refused(RefusalReason::IsolationFamilyMismatch),
        ),
        (
            "the isolation floor",
            Box::new(|request: &mut SandboxSubmitReq| {
                request.minimum_isolation = Isolation::Process {
                    level: ProcessIsolation::MicroVm,
                };
            }),
            AtFull::Refused(RefusalReason::IsolationUnavailable),
        ),
        (
            "the language",
            Box::new(|request: &mut SandboxSubmitReq| {
                request.program = SandboxProgram::Process(ProcessProgram {
                    language: ProcessLanguage::Python,
                    source: "print(1)".into(),
                    working_directory: ProcessWorkingDirectory::Scratch,
                    environment: Vec::new(),
                    stdin: None,
                });
            }),
            AtFull::Refused(RefusalReason::LanguageUnsupported),
        ),
        (
            "the network policy",
            Box::new(|request: &mut SandboxSubmitReq| {
                request.network = NetworkPolicy::Allowed;
            }),
            AtFull::Refused(RefusalReason::NetworkPolicyUnavailable),
        ),
        (
            "the caller's environment",
            Box::new(|request: &mut SandboxSubmitReq| {
                if let SandboxProgram::Process(program) = &mut request.program {
                    program.environment = vec![EnvironmentEntry {
                        name: "HOME".into(),
                        value: "/mnt/c".into(),
                    }];
                }
            }),
            AtFull::Refused(RefusalReason::EnvironmentNamesCollide),
        ),
        (
            "the working directory",
            Box::new(|request: &mut SandboxSubmitReq| {
                if let SandboxProgram::Process(program) = &mut request.program {
                    program.working_directory = ProcessWorkingDirectory::GuestPath {
                        path: "/somewhere-nobody-granted".into(),
                    };
                }
            }),
            AtFull::Refused(RefusalReason::WorkingDirectoryOutsideScope),
        ),
        (
            "a mount's materialisation",
            Box::new(move |request: &mut SandboxSubmitReq| {
                request.filesystem.mounts = vec![Mount {
                    host_path: present.clone(),
                    guest_path: "/work".into(),
                    mode: MountMode::ReadOnly,
                    materialisation: MountMaterialisation::CopyIn,
                }];
            }),
            AtFull::RejectedAtTheInvoke,
        ),
        (
            "whether a mount's hostPath is even there",
            Box::new(move |request: &mut SandboxSubmitReq| {
                request.filesystem.mounts = vec![mount_of(
                    absent.to_string_lossy().into_owned(),
                    "/work",
                    MountMode::ReadOnly,
                )];
            }),
            AtFull::RejectedAtTheInvoke,
        ),
    ];

    for (what, break_it, at_full) in rows {
        let (host, collector) = host_with(PermissionLevel::Off, unreachable_backend());
        let mut request = submit_of("echo hi");
        break_it(&mut request);
        assert!(
            host.submit(request).is_ok(),
            "at `off` the host answered `INVALID_PAYLOAD` over {what}: it had to look at it \
             to say so, for a request it was told to ignore"
        );
        let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(5));
        assert!(
            matches!(
                outcome,
                SandboxOutcome::Refused {
                    reason: RefusalReason::PermissionIsOff,
                    ..
                }
            ),
            "at `off` a request that is wrong about {what} settled {outcome:?}. The user \
             switched execution off and was told about something else."
        );

        // The other half: this row really is wrong in the way it claims, so the
        // assertion above is about the order and not about a request that would
        // have been fine anyway.
        let (host, collector) = host_with(PermissionLevel::Full, unreachable_backend());
        let mut request = submit_of("echo hi");
        break_it(&mut request);
        match at_full {
            AtFull::RejectedAtTheInvoke => assert!(
                host.submit(request).is_err(),
                "the row for {what} claims to be a malformed payload and was accepted"
            ),
            AtFull::Refused(expected) => {
                host.submit(request).expect("admitted");
                let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(5));
                match outcome {
                    SandboxOutcome::Refused { reason, .. } => assert_eq!(
                        reason, expected,
                        "the row for {what} does not produce the refusal it claims"
                    ),
                    other => panic!("the row for {what} settled {other:?} at `full`"),
                }
            }
        }
    }
}

/// `mountIndex` names the **first** bad row by position.
///
/// The only existing assertion on `mountIndex` is made with a single mount at
/// index 0, so an off-by-one or a last-match-wins loop survives it. A surface
/// that highlights the wrong row of an approval prompt has a person looking at
/// one path and answering about another.
///
/// Watched to fail with the mount loop's `enumerate` replaced by a counter that
/// keeps scanning and reports the last match: the first case below answered
/// index 2 for a bad row at index 1.
#[test]
fn a_refusal_names_the_first_bad_mount_row_by_position() {
    let temp = tempfile::tempdir().expect("temp dir");
    let ordinary = temp.path().join("ordinary");
    let also_ordinary = temp.path().join("also-ordinary");
    let keys = temp.path().join("keys");
    let more_keys = temp.path().join("more-keys");
    for directory in [&ordinary, &also_ordinary, &keys, &more_keys] {
        std::fs::create_dir_all(directory).expect("directory");
    }
    let path = |directory: &Path| directory.to_string_lossy().into_owned();

    let cases: Vec<(&str, Vec<Mount>, RefusalReason, u32)> = vec![
        (
            "two protected rows: the first one is named",
            vec![
                mount_of(path(&ordinary), "/a", MountMode::ReadOnly),
                mount_of(path(&keys), "/b", MountMode::ReadOnly),
                mount_of(path(&more_keys), "/c", MountMode::ReadOnly),
            ],
            RefusalReason::MountIsProtectedRoot,
            1,
        ),
        (
            "a bad row last: the index is not clamped to the first row",
            vec![
                mount_of(path(&ordinary), "/a", MountMode::ReadOnly),
                mount_of(path(&also_ordinary), "/b", MountMode::ReadOnly),
                mount_of(path(&keys), "/c", MountMode::ReadOnly),
            ],
            RefusalReason::MountIsProtectedRoot,
            2,
        ),
        (
            "an overlap names the row that collided, not the row it collided with",
            vec![
                mount_of(path(&ordinary), "/a", MountMode::ReadOnly),
                mount_of(path(&also_ordinary), "/a/inner", MountMode::ReadWrite),
            ],
            RefusalReason::MountsOverlap,
            1,
        ),
    ];

    for (what, mounts, expected, expected_index) in cases {
        let mut settings = config(PermissionLevel::Full);
        settings.protected.user_key_material = vec![canonical(&keys), canonical(&more_keys)];
        let (host, collector) = host_with_settings(settings, unreachable_backend());
        let mut request = submit_of("echo hi");
        request.filesystem.mounts = mounts;
        host.submit(request).expect("admitted");

        let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(5));
        match outcome {
            SandboxOutcome::Refused {
                reason,
                mount_index,
                ..
            } => {
                assert_eq!(reason, expected, "{what}");
                assert_eq!(
                    mount_index,
                    Some(expected_index),
                    "{what}: `mountIndex` points a surface at a row of the approval prompt, \
                     and this one points at the wrong path"
                );
            }
            other => panic!("{what}: settled {other:?}"),
        }
    }
}

/* -------------------------------------------------------------------------- */
/* the grant is the request narrowed                                          */
/* -------------------------------------------------------------------------- */

/// A lowered limit is reported lowered, and a limit under the ceiling is not
/// raised to it.
///
/// `SandboxLimits` says the host "may lower any of these and must report the
/// lowered value in `SandboxAccepted.grant`. It may never raise one, and never
/// lowers silently." Nothing held it: with `request.limits` placed in the grant
/// while the run kept the lowered set, every test stayed green. The person then
/// consents to a wall clock of ten minutes for a run that will be killed at
/// five, and the only evidence is a `limitExceeded` that arrives early with no
/// explanation.
///
/// Watched to fail with `limits: request.limits` in the `EffectiveGrant` built
/// by `admit`.
#[test]
fn a_limit_the_host_lowers_is_reported_lowered_and_one_under_the_ceiling_is_untouched() {
    let mut settings = config(PermissionLevel::Full);
    settings.ceilings = SandboxLimits {
        wall_clock_ms: 5_000,
        memory_bytes: 256 * 1024 * 1024,
        cpu_millicores: 2_000,
        output_bytes: 64 * 1024,
        processes: 64,
        file_write_bytes: 1024 * 1024,
    };
    let (host, collector) = host_with_settings(settings, unreachable_backend());

    let mut request = submit_of("echo hi");
    let run_id = request.run_id.clone();
    request.limits = SandboxLimits {
        // Over the ceiling: must come back lowered.
        wall_clock_ms: 600_000,
        memory_bytes: 4 * 1024 * 1024 * 1024,
        cpu_millicores: 8_000,
        // Under the ceiling: must come back untouched, not raised to it. A host
        // that "normalised" these to its own numbers would be widening a grant
        // the caller deliberately made narrow.
        output_bytes: 4_096,
        processes: 8,
        file_write_bytes: 1_024,
    };
    host.submit(request).expect("admitted");

    assert!(
        wait_until(Duration::from_secs(20), || collector
            .accepted_grant(&run_id)
            .is_some()),
        "no `accepted` event; events {:?}",
        collector.events_for(&run_id)
    );
    let grant = collector.accepted_grant(&run_id).expect("accepted");
    assert_eq!(
        grant.limits.wall_clock_ms, 5_000,
        "the grant a person is shown must carry the number the run will actually be held to"
    );
    assert_eq!(grant.limits.memory_bytes, 256 * 1024 * 1024);
    assert_eq!(grant.limits.cpu_millicores, 2_000);
    assert_eq!(
        grant.limits.output_bytes, 4_096,
        "a limit under the ceiling is the caller's, and raising it to the ceiling would \
         widen the grant"
    );
    assert_eq!(grant.limits.processes, 8);
    assert_eq!(grant.limits.file_write_bytes, 1_024);
}

/// The grant never promises a scratch directory that outlives the run.
///
/// `EffectiveGrant` is the request narrowed: "Nothing here may be wider than the
/// request — not a mode, not a mount, not a network policy, not a number", which
/// is what lets a caller ignore it safely. `retainAfterSettled` is the one field
/// this host actually narrows, and nothing held it: echoing the request back
/// left every test green. A caller then comes back for the files of a failed run
/// in a tmpfs that died with the namespace, finds an empty directory, and had
/// been told by the grant that they would be there.
///
/// Watched to fail with `retain_after_settled: request.filesystem.scratch
/// .retain_after_settled` in `admit`.
#[test]
fn the_grant_never_promises_a_scratch_directory_that_outlives_the_run() {
    let (host, collector) = host_with(PermissionLevel::Full, unreachable_backend());
    let mut request = submit_of("echo hi");
    let run_id = request.run_id.clone();
    request.filesystem.scratch = ScratchRequest {
        guest_path: Some("/vela-scratch-of-this-run".into()),
        retain_after_settled: true,
    };
    host.submit(request).expect("admitted");

    assert!(
        wait_until(Duration::from_secs(20), || collector
            .accepted_grant(&run_id)
            .is_some()),
        "no `accepted` event; events {:?}",
        collector.events_for(&run_id)
    );
    let grant = collector.accepted_grant(&run_id).expect("accepted");
    assert!(
        !grant.filesystem.scratch.retain_after_settled,
        "the scratch directory is a tmpfs inside a namespace destroyed with the run, so a \
         grant that echoes `retainAfterSettled: true` back promises files that cannot exist"
    );
    // Narrowed where it must be, and faithful everywhere else: the caller still
    // learns where its scratch directory is.
    assert_eq!(
        grant.filesystem.scratch.guest_path,
        "/vela-scratch-of-this-run"
    );
}

/// A working directory outside every mount and outside scratch is refused, and
/// not quietly moved somewhere convenient.
///
/// `ProcessWorkingDirectory` calls this "a refusal and not a fallback to
/// somewhere convenient — the convenient fallback is the user's home directory,
/// which is the whole problem". `workingDirectoryOutsideScope` had no producer
/// in any test. A fallback yields a run that starts, works, and writes its
/// output where the caller never named: a successful run with the artefacts
/// missing from where they were expected.
///
/// Watched to fail with the refusal replaced by `scratch_guest_path.clone()`:
/// the run was accepted and the grant reported a directory the caller had not
/// asked for.
#[test]
fn a_working_directory_outside_every_mount_is_refused_and_not_moved_to_scratch() {
    let temp = tempfile::tempdir().expect("temp dir");
    let outside = |path: &str| {
        let (host, collector) = host_with(PermissionLevel::Ask, unreachable_backend());
        let mut request = submit_of("echo hi");
        if let SandboxProgram::Process(program) = &mut request.program {
            program.working_directory = ProcessWorkingDirectory::GuestPath {
                path: path.to_string(),
            };
        }
        request.filesystem.mounts = vec![mount_of(
            temp.path().to_string_lossy().into_owned(),
            "/work",
            MountMode::ReadWrite,
        )];
        let run_id = request.run_id.clone();
        host.submit(request).expect("admitted");
        wait_until(Duration::from_secs(5), || {
            collector.settled_for(&run_id).is_some() || collector.prompt_for(&run_id).is_some()
        });
        if let Some(prompt) = collector.prompt_for(&run_id) {
            panic!(
                "a working directory at `{path}` was carried forward to a person as \
                 `{:?}` instead of being refused. The convenient fallback is the whole \
                 problem the refusal exists for.",
                prompt.grant.working_directory
            );
        }
        collector
            .settled_for(&run_id)
            .unwrap_or_else(|| panic!("no terminal event for a working directory at `{path}`"))
    };

    for path in [
        // Nowhere at all.
        "/somewhere-nobody-granted",
        // The sibling trap, twice: a string prefix of the mount and of the
        // scratch directory, inside neither. A containment check written with
        // `starts_with` on the raw string admits both.
        "/workshop",
        "/vela/scratchy",
    ] {
        let outcome = outside(path);
        match outcome {
            SandboxOutcome::Refused {
                reason: RefusalReason::WorkingDirectoryOutsideScope,
                ..
            } => {}
            other => panic!(
                "a working directory at `{path}` settled {other:?}. It must be refused rather \
                 than replaced with somewhere convenient."
            ),
        }
    }
}

/// The paths that *are* in scope are honoured and reported back, so the refusal
/// above is about scope and not about `guestPath` being unserved.
#[test]
fn a_working_directory_inside_a_mount_or_inside_scratch_is_reported_in_the_grant() {
    let temp = tempfile::tempdir().expect("temp dir");
    for (what, requested, expected) in [
        ("a mount's own root", "/work", "/work"),
        ("a directory inside a mount", "/work/inner", "/work/inner"),
        (
            "a directory inside scratch",
            "/vela/scratch/inner",
            "/vela/scratch/inner",
        ),
    ] {
        let (host, collector) = host_with(PermissionLevel::Ask, unreachable_backend());
        let mut request = submit_of("echo hi");
        let run_id = request.run_id.clone();
        if let SandboxProgram::Process(program) = &mut request.program {
            program.working_directory = ProcessWorkingDirectory::GuestPath {
                path: requested.to_string(),
            };
        }
        request.filesystem.mounts = vec![mount_of(
            temp.path().to_string_lossy().into_owned(),
            "/work",
            MountMode::ReadWrite,
        )];
        host.submit(request).expect("admitted");

        assert!(
            wait_until(Duration::from_secs(10), || collector
                .prompt_for(&run_id)
                .is_some()),
            "{what}: no approval was requested; events {:?}",
            collector.events_for(&run_id)
        );
        let prompt = collector.prompt_for(&run_id).expect("prompt");
        assert_eq!(
            prompt.grant.working_directory.as_deref(),
            Some(expected),
            "{what}: `EffectiveGrant.workingDirectory` reports the path the run will start in"
        );
    }
}

/* -------------------------------------------------------------------------- */
/* automatic approval, decided over the request                               */
/* -------------------------------------------------------------------------- */

/// At `approve`, the isolation clause is compared over the **request's**
/// `minimumIsolation` and never over the backend.
///
/// `AutoApprovalProfile` states it and says why: reading it against the backend
/// "would auto-approve a run on a container-capable machine whose caller never
/// demanded containment — a caller that named a floor of `none` would sail
/// through on the strength of a guarantee it did not request and cannot rely
/// on". This backend reports `container`, so the two readings differ for every
/// submit that asks for less. The TypeScript twin is held by 'does not approve a
/// run that merely lands on a capable backend' in
/// `src/features/canvas/document-run.test.ts`; the half that a real Bash run
/// goes through was not — `approve_runs_a_scratch_only_container_run_without_asking`
/// demands `container` itself, so it cannot tell the two readings apart.
///
/// Watched to fail with `within_profile` comparing a hardcoded
/// `Isolation::Process { level: ProcessIsolation::Container }` instead of
/// `request.minimum_isolation`: both rows below were accepted with no prompt and
/// no record, and Bash ran.
#[test]
fn approve_asks_when_the_submit_named_a_floor_below_the_profile_on_a_capable_backend() {
    for level in [ProcessIsolation::None, ProcessIsolation::Process] {
        let (host, collector) = host_with(PermissionLevel::Approve, unreachable_backend());
        let mut request = submit_of("echo hi");
        let run_id = request.run_id.clone();
        // Everything else about this submit is inside the shipped profile: no
        // mounts, network denied, the default limits, a language the profile
        // covers. The isolation clause is the only one deciding.
        request.minimum_isolation = Isolation::Process { level };
        host.submit(request).expect("admitted");

        assert!(
            asked_or_accepted(&collector, &run_id),
            "a submit whose own floor is {level:?} is below the profile's `container` and must \
             stop for a person, whatever this machine happens to be capable of"
        );
    }
}

/// `readableRoots` and `writableRoots` are checked independently and neither
/// implies the other.
///
/// `AutoApprovalProfile`: "a `readWrite` mount must appear here, and appearing
/// here does not make a path readable. Spelling write access as a flag on the
/// read list is how a widened read root silently becomes a widened write root."
/// No test entered this loop at all, because `DEFAULT_AUTO_APPROVAL_PROFILE`
/// ships both lists empty — so a profile a user widens by one root has never
/// been exercised.
///
/// The rows are the whole matrix. Watched to fail with the `readWrite` arm
/// reduced to `inside(&profile.writable_roots)`: the second row auto-approved a
/// read-write mount of a root the user had only made readable.
#[test]
fn a_profile_root_on_one_list_does_not_grant_the_mode_the_other_list_names() {
    let temp = tempfile::tempdir().expect("temp dir");
    let sub = temp.path().join("sub");
    std::fs::create_dir_all(&sub).expect("sub dir");
    let root = temp.path().to_string_lossy().into_owned();

    let rows: [(&str, bool, bool, MountMode, bool); 5] = [
        ("read-only inside a readable root", true, false, MountMode::ReadOnly, false),
        ("read-write inside a root that is only readable", true, false, MountMode::ReadWrite, true),
        ("read-write inside a root that is only writable", false, true, MountMode::ReadWrite, true),
        ("read-only inside a root that is only writable", false, true, MountMode::ReadOnly, true),
        ("read-write inside a root on both lists", true, true, MountMode::ReadWrite, false),
    ];

    for (what, readable, writable, mode, expect_prompt) in rows {
        let mut settings = config(PermissionLevel::Approve);
        settings.profile.readable_roots = if readable { vec![root.clone()] } else { Vec::new() };
        settings.profile.writable_roots = if writable { vec![root.clone()] } else { Vec::new() };
        let (host, collector) = host_with_settings(settings, unreachable_backend());

        let mut request = submit_of("echo hi");
        let run_id = request.run_id.clone();
        request.filesystem.mounts = vec![mount_of(
            sub.to_string_lossy().into_owned(),
            "/work",
            mode,
        )];
        host.submit(request).expect("admitted");

        assert_eq!(
            asked_or_accepted(&collector, &run_id),
            expect_prompt,
            "{what}: this is the clause that decides whether model-authored code writes to \
             the user's disk without anybody being asked"
        );
    }
}

/* -------------------------------------------------------------------------- */
/* the run table                                                              */
/* -------------------------------------------------------------------------- */

/// After release the id is free, and the slot it was holding is free with it.
///
/// `SandboxReleaseReq` says "after release the id is free", and
/// `SandboxPolicySnapshot.activeRuns` counts "runs already admitted and not yet
/// released". Nothing held either: with `settle` never removing a released run,
/// every test stayed green — `releasing_a_run_that_is_still_waiting_for_a_person_abandons_it`
/// asserts the outcome and nothing about the id. The run table then grows
/// without bound and, after `maximumConcurrentRuns` submits, Vela refuses every
/// later run `tooManyConcurrentRuns` forever: a slow wedge that looks like a
/// capacity problem and has no error anywhere near its cause.
///
/// Watched to fail with the `remove` in `SandboxHost::settle` deleted:
/// `activeRuns` stayed at four and the re-used id was rejected as already in
/// flight.
#[test]
fn releasing_a_run_frees_its_id_and_the_slot_it_was_holding() {
    let (host, collector) = host_with(PermissionLevel::Ask, unreachable_backend());
    let capacity = host.policy().maximum_concurrent_runs as usize;

    let mut ids: Vec<SandboxRunId> = Vec::new();
    for _ in 0..capacity {
        let request = submit_of("echo hi");
        let run_id = request.run_id.clone();
        host.submit(request).expect("admitted");
        assert!(
            wait_until(Duration::from_secs(10), || collector
                .prompt_for(&run_id)
                .is_some()),
            "a run at `ask` stops for a person"
        );
        ids.push(run_id);
    }
    assert_eq!(host.policy().active_runs as usize, capacity);

    // The control: the limit is real, so the assertions after the release are
    // about the release and not about a limit that was never reached.
    let over = submit_of("echo hi");
    let over_id = over.run_id.clone();
    host.submit(over).expect("admitted");
    let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(5));
    assert!(
        matches!(
            outcome,
            SandboxOutcome::Refused {
                reason: RefusalReason::TooManyConcurrentRuns,
                ..
            }
        ),
        "outcome {outcome:?}"
    );

    for run_id in ids.iter().chain(std::iter::once(&over_id)) {
        host.release(SandboxReleaseReq {
            run_id: run_id.clone(),
        });
    }
    assert!(
        wait_until(Duration::from_secs(10), || host.policy().active_runs == 0),
        "released runs still counted as active: {} of them",
        host.policy().active_runs
    );
    for run_id in ids.iter() {
        assert!(
            collector.settled_for(run_id).is_some(),
            "every admitted run settles exactly once, release included"
        );
    }

    // The id itself, and not merely the count: a caller that releases and
    // retries with the same id is the ordinary shape of a retry.
    let reused = SandboxSubmitReq {
        run_id: ids[0].clone(),
        ..submit_of("echo hi")
    };
    host.submit(reused)
        .expect("after release the id is free for the corrected request");
    assert!(
        wait_until(Duration::from_secs(10), || collector
            .events_for(&ids[0])
            .iter()
            .any(|envelope| matches!(
                envelope.event,
                SandboxEvent::AwaitingApproval { .. }
            ))),
        "the re-used id was admitted and then refused; events {:?}",
        collector.events_for(&ids[0])
    );
}

/// `seq` is dense, 0-based and **per run**.
///
/// The one existing assertion (`envelope.seq == index`, in
/// `output_arrives_in_the_programs_own_order_within_one_stream`) runs against a
/// collector holding exactly one run, so it cannot tell a per-run counter from a
/// global one. Two runs in flight at once can: with the counter moved onto the
/// host, the second run's stream starts at 2 and every consumer that treats
/// `seq` as dense — the contract says reattachment will — silently mis-orders or
/// discards events.
///
/// Watched to fail with `RunHandle::seq` replaced by a single `AtomicU64` on
/// `SandboxHost`: the second run's envelopes were numbered 2 and 3.
#[test]
fn seq_is_dense_and_zero_based_within_each_run_and_not_shared_between_two() {
    let (host, collector) = host_with(PermissionLevel::Ask, unreachable_backend());

    let mut ids: Vec<SandboxRunId> = Vec::new();
    for _ in 0..2 {
        let request = submit_of("echo hi");
        let run_id = request.run_id.clone();
        host.submit(request).expect("admitted");
        assert!(
            wait_until(Duration::from_secs(10), || collector
                .prompt_for(&run_id)
                .is_some()),
            "a run at `ask` stops for a person"
        );
        ids.push(run_id);
    }

    // Interleaved on purpose: both runs are live, so a shared counter would be
    // handing out numbers to both.
    for run_id in ids.iter() {
        let digest = collector.prompt_for(run_id).expect("prompt").request_digest;
        host.approve(SandboxApproveReq {
            run_id: run_id.clone(),
            request_digest: digest,
            decision: ApprovalDecision::Deny,
        })
        .expect("the digest matches");
    }

    for run_id in ids.iter() {
        assert!(
            wait_until(Duration::from_secs(10), || collector
                .settled_for(run_id)
                .is_some()),
            "no terminal event for {run_id}"
        );
        let seqs: Vec<u64> = collector
            .events_for(run_id)
            .iter()
            .map(|envelope| envelope.seq)
            .collect();
        assert_eq!(
            seqs,
            vec![0, 1],
            "`seq` is per run: {run_id} saw {seqs:?}, which is a stream with a gap in it for \
             every consumer that treats it as dense"
        );
    }
}

/* -------------------------------------------------------------------------- */
/* the approval digest                                                        */
/* -------------------------------------------------------------------------- */

/// The digest covers the request, not the run.
///
/// `ApprovalRequest`: the approval "is bound to `requestDigest`, computed
/// host-side over the canonical form of the submit. Approving covers exactly
/// those bytes and that grant." The one existing assertion checks that a digest
/// which was never handed out is refused — which hashing the run id alone would
/// also pass. Every row below changes something a person was shown and nothing
/// else, including the run id, which is held fixed so that a digest computed
/// over the id cannot accidentally differ.
///
/// Watched to fail with the digest computed over `run_id.as_bytes()`: every row
/// produced the same hex string, so an approval of one program would have
/// covered any other.
#[test]
fn the_approval_digest_changes_when_anything_the_person_was_shown_changes() {
    let temp = tempfile::tempdir().expect("temp dir");
    let mount = temp.path().to_string_lossy().into_owned();

    // One id for every row. A digest that changes here changes because the
    // request changed.
    let fixed_id = "the-same-run-id-for-every-row";
    let base = || SandboxSubmitReq {
        run_id: fixed_id.to_string(),
        ..submit_of("echo hi")
    };
    let digest_of = |request: SandboxSubmitReq| -> String {
        let (host, collector) = host_with(PermissionLevel::Ask, unreachable_backend());
        let run_id = request.run_id.clone();
        host.submit(request).expect("admitted");
        assert!(
            wait_until(Duration::from_secs(10), || collector
                .prompt_for(&run_id)
                .is_some()),
            "no approval was requested; events {:?}",
            collector.events_for(&run_id)
        );
        collector.prompt_for(&run_id).expect("prompt").request_digest
    };

    // Same bytes, twice: the digest is a function of the request and not of the
    // clock, the host, or the order the rows run in.
    assert_eq!(
        digest_of(base()),
        digest_of(base()),
        "the same submit must produce the same digest, or a person's answer could never be \
         matched to what they were shown"
    );

    let mut variants: Vec<(&str, SandboxSubmitReq)> = Vec::new();
    variants.push(("the program text", {
        let mut request = base();
        request.program = SandboxProgram::Process(ProcessProgram {
            language: ProcessLanguage::Bash,
            source: "echo hi ".into(),
            working_directory: ProcessWorkingDirectory::Scratch,
            environment: Vec::new(),
            stdin: None,
        });
        request
    }));
    variants.push(("the program's stdin", {
        let mut request = base();
        if let SandboxProgram::Process(program) = &mut request.program {
            program.stdin = Some("fed-in".into());
        }
        request
    }));
    variants.push(("the mounts", {
        let mut request = base();
        request.filesystem.mounts = vec![mount_of(mount.clone(), "/work", MountMode::ReadOnly)];
        request
    }));
    variants.push(("a mount's mode", {
        let mut request = base();
        request.filesystem.mounts = vec![mount_of(mount.clone(), "/work", MountMode::ReadWrite)];
        request
    }));
    variants.push(("the limits", {
        let mut request = base();
        request.limits.wall_clock_ms += 1;
        request
    }));
    variants.push(("the isolation floor", {
        let mut request = base();
        request.minimum_isolation = Isolation::Process {
            level: ProcessIsolation::Process,
        };
        request
    }));
    variants.push(("the scratch directory", {
        let mut request = base();
        request.filesystem.scratch = ScratchRequest {
            guest_path: Some("/scratch-somewhere-else".into()),
            retain_after_settled: false,
        };
        request
    }));
    variants.push(("the environment", {
        let mut request = base();
        if let SandboxProgram::Process(program) = &mut request.program {
            program.environment = vec![EnvironmentEntry {
                name: "CI".into(),
                value: "1".into(),
            }];
        }
        request
    }));

    // The network policy is deliberately absent: every value but `denied` is
    // refused by this backend before an approval is ever requested, so there is
    // no prompt to compare. That is a fact about this host and not about the
    // rule.
    let mut seen: Vec<(String, String)> = vec![("the base request".into(), digest_of(base()))];
    for (what, request) in variants {
        let digest = digest_of(request);
        for (other, previous) in seen.iter() {
            assert_ne!(
                &digest, previous,
                "changing {what} left the digest identical to {other}: an approval of one \
                 would cover the other, and the person answered about neither"
            );
        }
        seen.push((what.to_string(), digest));
    }
}

/* -------------------------------------------------------------------------- */
/* what the run sees, checked from inside the run                             */
/* -------------------------------------------------------------------------- */

/// The child's environment is exactly `ProcessProgram.environment` plus
/// `SANDBOX_BASE_ENVIRONMENT_POSIX`, and nothing else exists inside the run.
///
/// `SANDBOX_BASE_ENVIRONMENT_POSIX` states it as a closed set: "a variable that
/// is not in one of those two places does not exist inside the run — including
/// every token the user happened to export into the shell that launched Vela".
/// No test asserted it from inside a run. Broken, model-authored Bash gets the
/// user's whole shell environment with no symptom at all — the run works and the
/// output looks normal. This is the exact leak the contract inverts the
/// reference product's blocklist to prevent.
///
/// The set is asserted closed rather than by absence of names somebody thought
/// of: a list of forbidden names is the blocklist this rule exists to replace.
/// Two names the shell gives itself are the only exception and are named here.
///
/// **Which of the two mechanisms this holds, measured rather than assumed.**
/// `env -i` on the guest exec line is held: removing it put `WSL_DISTRO_NAME`,
/// `WSL_INTEROP`, `XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir` and fifteen more of
/// the distribution's own variables inside the run, and this test went red
/// naming them. `Command::env_clear` on the launcher is **not** held by it, and
/// that was measured too: with `env -i` standing, removing `env_clear` changes
/// nothing a run can see, because the guest clears the environment again on the
/// way in. It is the outer half of a belt-and-braces pair and only the inner
/// half is observable from where the contract states the rule. Removing both,
/// plus the `WSLENV` line that decides what crosses into the guest at all, put
/// the value exported below inside the run — so the rule as a whole is held,
/// and one of its two implementations is held only in composition with the
/// other.
#[test]
fn the_run_sees_the_base_environment_the_callers_entries_and_nothing_else() {
    let Some(backend) = boundary_backend() else {
        return;
    };
    // Exported into this process, which is what a launcher that inherited
    // anything would inherit. Named like the thing it stands for.
    std::env::set_var("VELA_TEST_EXPORTED_TOKEN", "sk-this-must-not-reach-a-run");

    let (host, collector) = host_with(PermissionLevel::Full, Some(backend));
    let mut request = submit_of("env");
    if let SandboxProgram::Process(program) = &mut request.program {
        program.environment = vec![EnvironmentEntry {
            name: "VELA_RUN_LABEL".into(),
            value: "set-by-the-caller".into(),
        }];
    }
    host.submit(request).expect("admitted");

    let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(120));
    let stdout = collector.text(OutputStream::Stdout);
    assert!(
        matches!(outcome, SandboxOutcome::Exited { exit_code: 0 }),
        "outcome {outcome:?} stdout {stdout:?}"
    );

    let seen: Vec<(&str, &str)> = stdout
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect();
    let value_of = |name: &str| -> Option<&str> {
        seen.iter()
            .find(|(seen, _)| *seen == name)
            .map(|(_, value)| *value)
    };

    // The two the shell sets for itself. Written down rather than filtered out
    // by a pattern, so that a third one arriving is a failure and not a silent
    // widening of what counts as expected.
    const SHELL_OWN: [&str; 2] = ["SHLVL", "_"];
    let mut expected: Vec<&str> = SANDBOX_BASE_ENVIRONMENT_POSIX.to_vec();
    expected.push("VELA_RUN_LABEL");
    expected.extend_from_slice(&SHELL_OWN);
    expected.sort_unstable();

    let mut got: Vec<&str> = seen.iter().map(|(name, _)| *name).collect();
    got.sort_unstable();
    assert_eq!(
        got, expected,
        "the run's environment is the caller's entries plus the base list and nothing else. \
         `{}` of the shell's own is the only allowance. stdout {stdout:?}",
        SHELL_OWN.join("`, `")
    );

    assert_eq!(value_of("VELA_RUN_LABEL"), Some("set-by-the-caller"));
    assert_eq!(value_of("HOME"), Some("/vela/scratch"));
    assert_eq!(value_of("TMPDIR"), Some("/vela/scratch"));
    assert_eq!(value_of("LANG"), Some("C.UTF-8"));
    assert_eq!(
        value_of("PATH"),
        Some("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
        "the host's `PATH` and not a translation of the user's: a `PATH` with `/mnt/c` in \
         it is the Windows filesystem reachable by name"
    );
    assert!(
        !stdout.contains("sk-this-must-not-reach-a-run"),
        "a value exported into the shell that launched Vela reached the run"
    );

    // The launcher's own noise is attributed to the program if it is not
    // suppressed: WSL prints one line per `PATH` entry it cannot translate,
    // which is every entry once `/mnt` is gone.
    assert_eq!(
        collector.text(OutputStream::Stderr),
        "",
        "the run's stderr belongs to the program"
    );
}

/// `EffectiveGrant.workingDirectory` reports the directory the run actually
/// starts in.
///
/// `ProcessWorkingDirectory`: "Whichever is chosen,
/// `EffectiveGrant.workingDirectory` reports the path the run will actually
/// start in, so a caller that said `scratch` still learns where that was." The
/// plan and the grant share one value today, but nothing bound that value to the
/// guest's own `pwd` — the `cd` line in `guest_script` could diverge and no test
/// would notice. A caller told `/vela/scratch` that is actually started
/// elsewhere writes relative paths into the wrong tree and reads back nothing.
///
/// Watched to fail with `cd {}` in `wsl::WslBackend::guest_script` replaced by
/// `cd /`: every row reported a directory the run had not started in.
#[test]
fn the_grant_reports_the_directory_the_run_actually_starts_in() {
    let Some(backend) = boundary_backend() else {
        return;
    };
    let temp = tempfile::tempdir().expect("temp dir");
    std::fs::create_dir_all(temp.path().join("inner")).expect("inner dir");

    let rows = [
        ("the caller said `scratch`", ProcessWorkingDirectory::Scratch),
        (
            "a mount's own root",
            ProcessWorkingDirectory::GuestPath {
                path: "/work".into(),
            },
        ),
        (
            "a directory inside a mount",
            ProcessWorkingDirectory::GuestPath {
                path: "/work/inner".into(),
            },
        ),
    ];

    for (what, working_directory) in rows {
        let (host, collector) = host_with(PermissionLevel::Full, Some(backend.clone()));
        let mut request = submit_of("pwd");
        let run_id = request.run_id.clone();
        if let SandboxProgram::Process(program) = &mut request.program {
            program.working_directory = working_directory;
        }
        request.filesystem.mounts = vec![mount_of(
            temp.path().to_string_lossy().into_owned(),
            "/work",
            MountMode::ReadWrite,
        )];
        host.submit(request).expect("admitted");

        let (outcome, _usage) = wait_for_settled(&collector, Duration::from_secs(120));
        let stdout = collector.text(OutputStream::Stdout);
        assert!(
            matches!(outcome, SandboxOutcome::Exited { exit_code: 0 }),
            "{what}: outcome {outcome:?} stdout {stdout:?}"
        );
        let reported = collector
            .accepted_grant(&run_id)
            .expect("accepted")
            .working_directory;
        assert_eq!(
            Some(stdout.trim()),
            reported.as_deref(),
            "{what}: the grant said one directory and the run started in another"
        );
    }
}

/// Multibyte output crosses the reader's buffer without growing a replacement
/// character, and `bytes` counts bytes.
///
/// `SandboxOutput`: the host "decodes UTF-8 across chunk boundaries and never
/// splits a code point between two events", and `bytes` is "the length of the
/// decoded source bytes, not of `text`". `complete_utf8_prefix` had no test at
/// any level. Broken, every read boundary in a run's output grows a replacement
/// character mid-word, which the user attributes to their own program — a
/// plausible wrong answer, never a crash.
///
/// The shape is chosen so the boundary lands inside a character rather than
/// between two: the reader's buffer is 8192 bytes and each line here is 31
/// (ten three-byte characters and a newline), and 8192 is 264 lines plus eight
/// bytes, which is the middle of the third character of the next one.
///
/// Watched to fail with `complete_utf8_prefix` returning `buffer.len()`
/// unconditionally: the run's output came back with replacement characters in
/// it and the text no longer matched what the program printed.
#[test]
fn multibyte_output_crosses_the_read_buffer_without_a_replacement_character() {
    let Some(backend) = boundary_backend() else {
        return;
    };
    const LINES: usize = 20_000;
    const LINE: &str = "€€€€€€€€€€";

    let (host, collector) = host_with(PermissionLevel::Full, Some(backend));
    host.submit(submit_of(&format!("yes '{LINE}' | head -n {LINES}")))
        .expect("admitted");
    let (outcome, usage) = wait_for_settled(&collector, Duration::from_secs(120));

    let stdout = collector.text(OutputStream::Stdout);
    assert!(
        matches!(outcome, SandboxOutcome::Exited { exit_code: 0 }),
        "outcome {outcome:?}"
    );
    assert!(
        !stdout.contains('\u{FFFD}'),
        "the output grew a replacement character the program never printed, at byte {:?}",
        stdout.find('\u{FFFD}')
    );
    let expected: String = format!("{LINE}\n").repeat(LINES);
    assert_eq!(stdout.len(), expected.len(), "the whole stream arrived");
    assert_eq!(stdout, expected);

    // `bytes` is the length of the source bytes. A host counting characters, or
    // UTF-16 units, would answer a third of this against a byte budget.
    assert_eq!(usage.output_bytes as usize, expected.len());
    for envelope in collector.snapshot() {
        if let SandboxEvent::Output { text, bytes, .. } = envelope.event {
            assert_eq!(
                bytes,
                text.as_bytes().len() as u64,
                "`bytes` counts the decoded source bytes, not the length of `text`"
            );
        }
    }
}

/// Keeps `std::io::Write` used on platforms where nothing else needs it, and
/// documents that the harness writes nothing to disk of its own.
#[allow(dead_code)]
fn unused_writer() {
    let mut sink = Vec::new();
    let _ = sink.write_all(b"");
}
