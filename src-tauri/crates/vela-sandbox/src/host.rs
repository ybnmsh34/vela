//! The run's life: admitted, approved, started, streamed, settled — exactly
//! once, in that order, for every run this host takes.
//!
//! ## Why the events are assigned in one place
//!
//! `seq` is dense, 0-based, per run, and is the total order of *delivery*. Two
//! pipes and a wall-clock timer produce events concurrently, so every one of
//! them is funnelled through a single supervisor thread per run and numbered
//! there. Numbering at the point of production would give three numbering
//! authorities and a stream whose gaps depend on machine load.
//!
//! Within one stream — all of stdout, or all of stderr — that order is also the
//! program's write order. **Between the two it is not**, and no amount of care
//! here would make it so: the kernel does not order a write to one pipe against
//! a write to the other. A surface that renders them merged is rendering Vela's
//! observation order and must not present it as the program's.
//!
//! ## What a caller is promised
//!
//! One `settled`, always, for every admitted run — including one refused
//! instantly, one abandoned while a person was being asked, and one released
//! before it ever ran. A caller has exactly one place to clean up.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::admission::{admit, Admission, RunPlan, SandboxConfig};
use crate::contract::*;
use crate::digest::sha256_hex;
use crate::wsl::{WslBackend, READY_SENTINEL};

/// Where a run's events go. One implementation emits a Tauri event; the test
/// implementation collects them, which is the only way to assert an ordering.
pub trait SandboxEventSink: Send + Sync + 'static {
    fn emit(&self, envelope: SandboxEventEnvelope);
}

/// What a caller did wrong, as opposed to what was refused.
///
/// A refusal is a fact about a well-formed request and travels as an event with
/// a closed reason. This is the other thing: a payload this contract has no
/// shape for, which becomes `INVALID_PAYLOAD` on the invoke.
#[derive(Debug, Clone)]
pub struct MalformedRequest(pub String);

#[derive(Debug, Default)]
struct RunControl {
    digest: Option<String>,
    decision: Option<ApprovalDecision>,
    cancelled: Option<CancelReason>,
    released: bool,
    settled: bool,
}

struct RunHandle {
    seq: AtomicU64,
    control: Mutex<RunControl>,
    waiters: Condvar,
    /// The launcher process, once there is one. Cancellation kills it, and the
    /// PID namespace reaps everything it started.
    child: Mutex<Option<std::process::Child>>,
}

impl RunHandle {
    fn new() -> Self {
        Self {
            seq: AtomicU64::new(0),
            control: Mutex::new(RunControl::default()),
            waiters: Condvar::new(),
            child: Mutex::new(None),
        }
    }
}

pub struct SandboxHost {
    config: Mutex<SandboxConfig>,
    backend: Option<WslBackend>,
    document_backend: SandboxBackendReport,
    languages: Vec<SandboxLanguage>,
    runs: Mutex<HashMap<SandboxRunId, Arc<RunHandle>>>,
    sink: Arc<dyn SandboxEventSink>,
}

/// The document backend this build has: none.
///
/// Reported at the weakest level the document scale has, with every guarantee
/// `unenforced`, because Vela has no Canvas surface and therefore draws no
/// frame. `languages` carries no document language either, so every document
/// submit is refused before this report decides anything — it exists so that a
/// host with nothing to offer has to *say so* rather than leave the field out.
fn absent_document_backend() -> SandboxBackendReport {
    let unenforced = EnforcementLevel::Unenforced;
    SandboxBackendReport {
        isolation: Isolation::Document {
            level: DocumentIsolation::SameOrigin,
        },
        maximum_isolation: Isolation::Document {
            level: DocumentIsolation::SameOrigin,
        },
        evidence: IsolationEvidence::Declared,
        network: unenforced,
        filesystem: unenforced,
        process_tree: unenforced,
        limits: LimitEnforcement {
            wall_clock_ms: unenforced,
            memory_bytes: unenforced,
            cpu_millicores: unenforced,
            output_bytes: unenforced,
            processes: unenforced,
            file_write_bytes: unenforced,
        },
    }
}

/// The process backend a host without WSL reports: none at all.
fn absent_process_backend() -> SandboxBackendReport {
    let unenforced = EnforcementLevel::Unenforced;
    SandboxBackendReport {
        isolation: Isolation::Process {
            level: ProcessIsolation::None,
        },
        maximum_isolation: Isolation::Process {
            level: ProcessIsolation::None,
        },
        evidence: IsolationEvidence::Declared,
        network: unenforced,
        filesystem: unenforced,
        process_tree: unenforced,
        limits: LimitEnforcement {
            wall_clock_ms: unenforced,
            memory_bytes: unenforced,
            cpu_millicores: unenforced,
            output_bytes: unenforced,
            processes: unenforced,
            file_write_bytes: unenforced,
        },
    }
}

impl SandboxHost {
    /// A host with the backend it was handed.
    ///
    /// `None` is a host with no process backend: `languages` is empty and every
    /// process submit is refused `languageUnsupported`. That is the honest
    /// answer on a machine without WSL, and it is reached without spawning
    /// anything.
    pub fn new(
        config: SandboxConfig,
        backend: Option<WslBackend>,
        sink: Arc<dyn SandboxEventSink>,
    ) -> Self {
        // Bash only. `python` is in the contract's vocabulary and is not in this
        // list, because a language this host has not tested inside the guest is
        // a language it must not claim: `SandboxPolicySnapshot.languages` exists
        // precisely so a caller learns that without submitting and being
        // refused in front of the user.
        let languages = if backend.is_some() {
            vec![SandboxLanguage::Bash]
        } else {
            Vec::new()
        };
        Self {
            config: Mutex::new(config),
            backend,
            document_backend: absent_document_backend(),
            languages,
            runs: Mutex::new(HashMap::new()),
            sink,
        }
    }

    fn process_backend(&self) -> SandboxBackendReport {
        match &self.backend {
            Some(backend) => backend.report(),
            None => absent_process_backend(),
        }
    }

    pub fn policy(&self) -> SandboxPolicySnapshot {
        let config = self.config.lock().expect("sandbox config lock");
        SandboxPolicySnapshot {
            permission: config.permission,
            profile: config.profile.clone(),
            backends: SandboxBackends {
                process: self.process_backend(),
                document: self.document_backend,
            },
            languages: self.languages.clone(),
            // The guest is Linux even though the host is Windows. Every rule
            // that depends on this depends on the split: which base-environment
            // list applies, whether a killed process has a signal number, and
            // what a path separator is.
            guest_platform: GuestPlatform::Posix,
            active_runs: self.runs.lock().expect("run table lock").len() as u32,
            maximum_concurrent_runs: config.maximum_concurrent_runs,
        }
    }

    /// Hand a run over. Returns as soon as the run is registered; everything
    /// else arrives on the event stream.
    ///
    /// **The decision is made here, on the caller's thread, and not in the run
    /// thread.** [`admit`]'s `Err` is the caller's payload being malformed, and
    /// the only place a malformed payload can be answered is the invoke that
    /// carried it: settling the run instead would spend a `HostFailureReason` —
    /// "nobody's request being wrong" — on precisely the caller's request being
    /// wrong, and send them looking for a bug in Vela. Nothing has been spawned
    /// and no event has been emitted by the time this returns `Err`, so the run
    /// id is free for the corrected request.
    pub fn submit(
        self: &Arc<Self>,
        request: SandboxSubmitReq,
    ) -> Result<SandboxSubmitRes, MalformedRequest> {
        let run_id = request.run_id.clone();
        let handle = {
            let mut runs = self.runs.lock().expect("run table lock");
            if runs.contains_key(&run_id) {
                // A failure that rejects the invoke rather than settling the
                // run: pushing a refusal onto that id's stream would tell a
                // different caller their healthy run had failed.
                return Err(MalformedRequest(format!(
                    "run id `{run_id}` is already in flight"
                )));
            }
            let handle = Arc::new(RunHandle::new());
            runs.insert(run_id.clone(), Arc::clone(&handle));
            handle
        };

        // The id is registered first so that `tooManyConcurrentRuns` counts the
        // same way it did when this decision was made in the run thread, and so
        // that two submits racing on one id cannot both pass the check above.
        // `saturating_sub(1)` takes this run back out of that count.
        let decision = {
            let config = self.config.lock().expect("sandbox config lock").clone();
            let active = self.runs.lock().expect("run table lock").len() as u32;
            admit(
                &config,
                &self.process_backend(),
                &self.document_backend,
                &self.languages,
                active.saturating_sub(1),
                &request,
            )
        };
        let decision = match decision {
            Ok(decision) => decision,
            Err(message) => {
                self.runs.lock().expect("run table lock").remove(&run_id);
                return Err(MalformedRequest(message));
            }
        };

        let host = Arc::clone(self);
        let driven = run_id.clone();
        let spawned = std::thread::Builder::new()
            .name("vela-sandbox-run".to_string())
            .spawn({
                let handle = Arc::clone(&handle);
                move || host.drive(driven, handle, request, decision)
            });
        if spawned.is_err() {
            // A thread this host could not start is Vela's failure and not the
            // caller's, so it settles the run rather than rejecting the invoke:
            // `MalformedRequest` would say the request was wrong, and it was
            // not. This is the sole producer of `internal`.
            self.settle(
                &run_id,
                &handle,
                SandboxOutcome::HostFailed {
                    reason: HostFailureReason::Internal,
                },
                RunUsage {
                    wall_clock_ms: 0,
                    cpu_ms: None,
                    peak_memory_bytes: None,
                    output_bytes: 0,
                    dropped_output_bytes: 0,
                },
            );
        }

        Ok(SandboxSubmitRes {
            run_id,
            admitted: true,
        })
    }

    pub fn approve(&self, request: SandboxApproveReq) -> Result<(), MalformedRequest> {
        let handle = self
            .runs
            .lock()
            .expect("run table lock")
            .get(&request.run_id)
            .cloned();
        let Some(handle) = handle else {
            return Err(MalformedRequest("no such run".into()));
        };
        let mut control = handle.control.lock().expect("run control lock");
        match control.digest.as_deref() {
            Some(digest) if digest == request.request_digest => {
                control.decision = Some(request.decision);
                handle.waiters.notify_all();
                Ok(())
            }
            // The digest is host-computed and host-checked, and it is the whole
            // of what binds a person's answer to the bytes they were shown. A
            // mismatch is a renderer bug, not a decision to record.
            _ => Err(MalformedRequest("approval digest does not match".into())),
        }
    }

    pub fn cancel(&self, request: SandboxCancelReq) -> SandboxCancelRes {
        let handle = self
            .runs
            .lock()
            .expect("run table lock")
            .get(&request.run_id)
            .cloned();
        let Some(handle) = handle else {
            return SandboxCancelRes { cancelled: false };
        };
        let already_settled = {
            let mut control = handle.control.lock().expect("run control lock");
            if control.settled {
                true
            } else {
                control.cancelled.get_or_insert(request.reason);
                handle.waiters.notify_all();
                false
            }
        };
        if already_settled {
            return SandboxCancelRes { cancelled: false };
        }
        kill_child(&handle);
        SandboxCancelRes { cancelled: true }
    }

    pub fn release(&self, request: SandboxReleaseReq) {
        let handle = self
            .runs
            .lock()
            .expect("run table lock")
            .get(&request.run_id)
            .cloned();
        let Some(handle) = handle else {
            return;
        };
        let settled = {
            let mut control = handle.control.lock().expect("run control lock");
            control.released = true;
            if !control.settled {
                control.cancelled.get_or_insert(CancelReason::SurfaceClosed);
            }
            handle.waiters.notify_all();
            control.settled
        };
        if settled {
            self.runs
                .lock()
                .expect("run table lock")
                .remove(&request.run_id);
        } else {
            // The supervisor emits the terminal event and then forgets the id,
            // so "exactly one settled per admitted run" holds through a release.
            kill_child(&handle);
        }
    }

    /// A document surface reporting what it saw.
    ///
    /// Every report is dropped, because this host accepts no document run: there
    /// is no run for one to belong to. That is the contract's own rule for a
    /// report about a run the host has already settled, applied to the case
    /// where the run never existed.
    pub fn report_document(&self, _request: SandboxReportDocumentReq) {}

    pub fn set_permission(&self, permission: PermissionLevel) {
        self.config.lock().expect("sandbox config lock").permission = permission;
    }

    /* ---------------------------------------------------------------- */

    fn emit(&self, run_id: &str, handle: &RunHandle, event: SandboxEvent) {
        let seq = handle.seq.fetch_add(1, Ordering::SeqCst);
        self.sink.emit(SandboxEventEnvelope {
            run_id: run_id.to_string(),
            seq,
            event,
        });
    }

    fn settle(
        &self,
        run_id: &str,
        handle: &RunHandle,
        outcome: SandboxOutcome,
        usage: RunUsage,
    ) {
        {
            let mut control = handle.control.lock().expect("run control lock");
            if control.settled {
                return;
            }
            control.settled = true;
        }
        self.emit(run_id, handle, SandboxEvent::Settled { outcome, usage });
        let released = handle
            .control
            .lock()
            .expect("run control lock")
            .released;
        if released {
            self.runs.lock().expect("run table lock").remove(run_id);
        }
    }

    /// Everything after the decision. The decision itself was made in
    /// [`SandboxHost::submit`], before the invoke answered, because a malformed
    /// payload has to be answered there — this function only ever sees a
    /// well-formed request, and so has no host-failure arm for one.
    fn drive(
        self: Arc<Self>,
        run_id: SandboxRunId,
        handle: Arc<RunHandle>,
        request: SandboxSubmitReq,
        decision: Admission,
    ) {
        let started_at = Instant::now();
        let zero_usage = || RunUsage {
            wall_clock_ms: 0,
            cpu_ms: None,
            peak_memory_bytes: None,
            output_bytes: 0,
            dropped_output_bytes: 0,
        };

        let (grant, plan, needs_approval) = match decision {
            Admission::Refused(outcome) => {
                self.settle(&run_id, &handle, outcome, zero_usage());
                return;
            }
            Admission::NeedsApproval { grant, plan } => (grant, plan, true),
            Admission::Approved { grant, plan } => (grant, plan, false),
        };

        if needs_approval {
            let digest = sha256_hex(
                serde_json::to_string(&request)
                    .unwrap_or_default()
                    .as_bytes(),
            );
            {
                let mut control = handle.control.lock().expect("run control lock");
                control.digest = Some(digest.clone());
            }
            self.emit(
                &run_id,
                &handle,
                SandboxEvent::AwaitingApproval {
                    request: ApprovalRequest {
                        run_id: run_id.clone(),
                        request_digest: digest,
                        program: request.program.clone(),
                        grant: grant.clone(),
                    },
                },
            );

            // No timer. A prompt that answers itself after sixty seconds answers
            // *no* at the moment the user walked back to their desk, and a user
            // who learns that prompts expire learns to click through them.
            let outcome = {
                let mut control = handle.control.lock().expect("run control lock");
                loop {
                    if let Some(reason) = control.cancelled {
                        // A caller that released a run still waiting for a person
                        // gets `approvalAbandoned`; one that cancelled it gets
                        // `cancelled`, because the person did not deny it.
                        break Some(if control.released {
                            SandboxOutcome::refused(RefusalReason::ApprovalAbandoned)
                        } else {
                            SandboxOutcome::Cancelled { reason }
                        });
                    }
                    match control.decision {
                        Some(ApprovalDecision::AllowOnce) => break None,
                        Some(ApprovalDecision::Deny) => {
                            break Some(SandboxOutcome::refused(RefusalReason::ApprovalDenied))
                        }
                        None => {
                            control = handle
                                .waiters
                                .wait(control)
                                .expect("approval wait");
                        }
                    }
                }
            };
            if let Some(outcome) = outcome {
                self.settle(&run_id, &handle, outcome, zero_usage());
                return;
            }
        }

        self.emit(
            &run_id,
            &handle,
            SandboxEvent::Accepted {
                grant: grant.clone(),
            },
        );
        self.execute(&run_id, &handle, &plan, started_at);
    }

    fn execute(
        &self,
        run_id: &str,
        handle: &RunHandle,
        plan: &RunPlan,
        started_at: Instant,
    ) {
        let Some(backend) = &self.backend else {
            self.settle(
                run_id,
                handle,
                SandboxOutcome::HostFailed {
                    reason: HostFailureReason::BackendUnavailable,
                },
                RunUsage {
                    wall_clock_ms: started_at.elapsed().as_millis() as u64,
                    cpu_ms: None,
                    peak_memory_bytes: None,
                    output_bytes: 0,
                    dropped_output_bytes: 0,
                },
            );
            return;
        };

        let mut command = backend.command(plan);
        if plan.stdin.is_some() {
            command.stdin(std::process::Stdio::piped());
        }
        let spawn_at = Instant::now();
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                self.settle(
                    run_id,
                    handle,
                    SandboxOutcome::HostFailed {
                        reason: HostFailureReason::BackendStartFailed,
                    },
                    RunUsage {
                        wall_clock_ms: started_at.elapsed().as_millis() as u64,
                        cpu_ms: None,
                        peak_memory_bytes: None,
                        output_bytes: 0,
                        dropped_output_bytes: 0,
                    },
                );
                return;
            }
        };

        if let Some(text) = &plan.stdin {
            if let Some(mut pipe) = child.stdin.take() {
                let _ = pipe.write_all(text.as_bytes());
            }
            // Dropping the pipe closes it, which is what the contract means by
            // "then stdin is closed".
        }

        let mut stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        *handle.child.lock().expect("child lock") = Some(child);

        // Wait for confinement to be established. Until the sentinel arrives
        // nothing of the program has run, so anything that goes wrong before it
        // is a host failure and not a program result.
        let mut sentinel_seen = 0usize;
        let sentinel = READY_SENTINEL.as_bytes();
        let mut byte = [0u8; 1];
        let ready = loop {
            match stdout.read(&mut byte) {
                Ok(0) => break false,
                Ok(_) => {
                    if byte[0] == sentinel[sentinel_seen] {
                        sentinel_seen += 1;
                        if sentinel_seen == sentinel.len() {
                            break true;
                        }
                    } else {
                        sentinel_seen = usize::from(byte[0] == sentinel[0]);
                    }
                }
                Err(_) => break false,
            }
        };
        if !ready {
            let cancelled = handle.control.lock().expect("run control lock").cancelled;
            let outcome = match cancelled {
                Some(reason) => SandboxOutcome::Cancelled { reason },
                None => SandboxOutcome::HostFailed {
                    reason: HostFailureReason::BackendStartFailed,
                },
            };
            reap(handle);
            self.settle(
                run_id,
                handle,
                outcome,
                RunUsage {
                    wall_clock_ms: started_at.elapsed().as_millis() as u64,
                    cpu_ms: None,
                    peak_memory_bytes: None,
                    output_bytes: 0,
                    dropped_output_bytes: 0,
                },
            );
            return;
        }

        self.emit(
            run_id,
            handle,
            SandboxEvent::Started {
                startup_ms: spawn_at.elapsed().as_millis() as u64,
            },
        );

        let (sender, receiver) = mpsc::channel::<Pump>();
        spawn_pump(stdout, OutputStream::Stdout, sender.clone());
        spawn_pump(stderr, OutputStream::Stderr, sender.clone());
        drop(sender);

        let deadline = Instant::now() + Duration::from_millis(plan.limits.wall_clock_ms);
        let mut budget_left = plan.limits.output_bytes;
        let mut counted = 0u64;
        let mut dropped = 0u64;
        let mut truncated_announced = false;
        let mut open_pumps = 2;
        let mut terminal: Option<SandboxOutcome> = None;

        while open_pumps > 0 {
            let now = Instant::now();
            if terminal.is_none() {
                if let Some(reason) = handle.control.lock().expect("run control lock").cancelled {
                    terminal = Some(SandboxOutcome::Cancelled { reason });
                    kill_child(handle);
                } else if now >= deadline {
                    terminal = Some(SandboxOutcome::LimitExceeded {
                        limit: LimitName::WallClockMs,
                    });
                    kill_child(handle);
                }
            }
            // Cancelling does not truncate the stream: whatever the readers
            // already have still arrives, in sequence, before the terminal
            // event. A caller that stopped rendering at the moment it cancelled
            // would drop the last thing the program said.
            let wait = if terminal.is_some() {
                Duration::from_millis(200)
            } else {
                deadline.saturating_duration_since(now).min(Duration::from_millis(100))
            };
            match receiver.recv_timeout(wait) {
                Ok(Pump::Chunk { stream, bytes }) => {
                    let length = bytes.len() as u64;
                    if length <= budget_left {
                        budget_left -= length;
                        counted += length;
                        self.emit(
                            run_id,
                            handle,
                            SandboxEvent::Output {
                                stream,
                                text: String::from_utf8_lossy(&bytes).into_owned(),
                                bytes: length,
                            },
                        );
                    } else {
                        dropped += length;
                        if !truncated_announced {
                            truncated_announced = true;
                            self.emit(
                                run_id,
                                handle,
                                SandboxEvent::Truncated {
                                    dropped_bytes: length,
                                },
                            );
                        }
                    }
                }
                Ok(Pump::Closed) => open_pumps -= 1,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }

        let status = reap(handle);
        let outcome = terminal.unwrap_or_else(|| match status {
            Some(code) => SandboxOutcome::Exited { exit_code: code },
            // A Windows launcher has no signal to report, and the guest is the
            // thing that would have one. `null` rather than `0`, which is a
            // signal.
            None => SandboxOutcome::Crashed { signal: None },
        });
        self.settle(
            run_id,
            handle,
            outcome,
            RunUsage {
                wall_clock_ms: started_at.elapsed().as_millis() as u64,
                cpu_ms: None,
                peak_memory_bytes: None,
                output_bytes: counted,
                dropped_output_bytes: dropped,
            },
        );
    }
}

enum Pump {
    Chunk {
        stream: OutputStream,
        bytes: Vec<u8>,
    },
    Closed,
}

/// One reader thread per pipe.
///
/// UTF-8 is decoded across chunk boundaries by holding an incomplete trailing
/// sequence back until the bytes that finish it arrive, so no event ever splits
/// a code point. Bytes that are not valid UTF-8 become U+FFFD and are still
/// counted, so a caller can tell "the program printed a replacement character"
/// from "the program is not emitting text at all".
fn spawn_pump<R: Read + Send + 'static>(
    mut source: R,
    stream: OutputStream,
    sender: mpsc::Sender<Pump>,
) {
    std::thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            match source.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    pending.extend_from_slice(&buffer[..read]);
                    let split = complete_utf8_prefix(&pending);
                    if split == 0 {
                        continue;
                    }
                    let chunk: Vec<u8> = pending.drain(..split).collect();
                    if sender.send(Pump::Chunk { stream, bytes: chunk }).is_err() {
                        return;
                    }
                }
            }
        }
        if !pending.is_empty() {
            let _ = sender.send(Pump::Chunk {
                stream,
                bytes: pending,
            });
        }
        let _ = sender.send(Pump::Closed);
    });
}

/// How much of `buffer` can be decoded without splitting a code point.
fn complete_utf8_prefix(buffer: &[u8]) -> usize {
    match std::str::from_utf8(buffer) {
        Ok(_) => buffer.len(),
        Err(error) => match error.error_len() {
            // Truncated sequence at the end: hold it back for the next read.
            None => error.valid_up_to(),
            // Genuinely invalid: emit it and let the lossy decode mark it.
            Some(_) => buffer.len(),
        },
    }
}

fn kill_child(handle: &RunHandle) {
    if let Some(child) = handle.child.lock().expect("child lock").as_mut() {
        let _ = child.kill();
    }
}

/// Wait for the launcher and report its exit code, or `None` if it did not
/// exit normally.
fn reap(handle: &RunHandle) -> Option<i32> {
    let mut slot = handle.child.lock().expect("child lock");
    let child = slot.as_mut()?;
    child.wait().ok().and_then(|status| status.code())
}
