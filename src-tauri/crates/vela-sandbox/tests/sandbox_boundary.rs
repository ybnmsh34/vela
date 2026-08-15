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

/// Keeps `std::io::Write` used on platforms where nothing else needs it, and
/// documents that the harness writes nothing to disk of its own.
#[allow(dead_code)]
fn unused_writer() {
    let mut sink = Vec::new();
    let _ = sink.write_all(b"");
}
