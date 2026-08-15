# Audit — Sandbox and code execution

Scope: `src-tauri/crates/vela-sandbox/` (7 source files, 2 349 lines; 1 integration test file,
2 394 lines) and `src-tauri/src/ipc/sandbox.rs` (196 lines).
Repo `C:\Users\User\vela-tmp`, branch `claude/new-session-tgl1ut`, HEAD `a1fa55e`.
Auditor ran on Windows 11 26200 with WSL2 present.

---

## 0. Did the escape battery run, or did it skip?

This is the first thing to settle, because `sandbox_boundary.rs` is written to skip loudly rather
than fail on a machine with no WSL distribution, and a green run on such a machine is worth
nothing.

```
$ wsl.exe -l -v
  NAME              STATE           VERSION
* Ubuntu            Stopped         2
  docker-desktop    Stopped         2
```

`WslBackend::detect()` skips `docker-desktop` (`NOT_A_GUEST`) and takes `Ubuntu`.

```
$ cargo test -p vela-sandbox
running 22 tests
test result: ok. 22 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

running 43 tests
...
test the_users_windows_filesystem_is_not_reachable_from_inside_a_run ... ok
test a_run_cannot_regain_privilege_and_cannot_write_the_distribution ... ok
test a_run_that_will_not_finish_is_killed_at_the_wall_clock ... ok
test result: ok. 43 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 13.93s
```

13.93 s for 43 tests, and afterwards:

```
$ wsl.exe -l -v
  NAME              STATE           VERSION
* Ubuntu            Running         2
```

No `SKIPPED:` line appeared on stderr in any run (I re-ran the suite three times over the audit and
grepped for it each time). **The battery executed real programs inside a real WSL2 namespace.**
Everything below marked *measured* is measured against that.

---

## 1. Mutation log — what bites and what does not

The brief asks me to spend effort on the difference between "tests exist" and "tests bite". I ran
eight mutations. Each was applied to a tracked file, exercised against the smallest relevant test,
and reverted with `git checkout --` immediately; `git status --porcelain -- src-tauri/` was
confirmed empty after every one. (Two untracked files from other auditors —
`src/lib/zz_audit_probe_tmp.ts`, `src/platform/zz-audit-battery.md`,
`src-tauri/crates/vela-providers/tests/zz_audit_live_compat.rs` — appeared in `git status` during
the session and are not mine.)

### A. No-op the `umount -l` loop (`wsl.rs`) — **BITES**

Replaced `do umount -l "$m" …` with `do : "$m" …`, leaving the `tmpfs` mask over `/mnt` in place.

```
thread '…' panicked at tests\sandbox_boundary.rs:231:5:
no 9p mount may remain in the run's mount table; stdout: "blocked\nmnt-entries=0\nninep-mounts=4\n"
```

This is the exact failure mode the test's own comment describes: `/mnt` *looks* empty
(`mnt-entries=0`) and the `cat` still fails (`blocked`), but four 9p shares of the user's Windows
disk are still in the mount table and reachable by another name. The labelled two-count assertion
is what catches it. Without the labels — the earlier `any(line == "0")` form the comment describes —
this mutation would have stayed green.

### B. Remove `--kill-child` from the launcher (`wsl.rs`) — **DOES NOT BITE**

```
test cancelling_stops_the_run_and_reaches_every_descendant ... ok
```

The test named *"reaches every descendant"* passes with the flag removed. Its only descendant-facing
assertion is `!stdout.contains("NEVER")`, and stdout is a pipe the host stops reading the moment the
launcher dies — an orphaned guest process could print `NEVER` into a closed pipe forever and the
assertion would still hold. See §3 for what I measured instead.

### C. Disable the read-only remount (`wsl.rs`) — **BITES**

Changed `if mount.mode == MountMode::ReadOnly` to `if false && …`.

```
thread '…' panicked at tests\sandbox_boundary.rs:304:5:
stdout "read-meWROTE\n"
```

The run wrote through a grant it was handed read-only.

### D. Remove `--no-new-privs` from `setpriv` (`wsl.rs`) — **BITES**

```
thread '…' panicked at tests\sandbox_boundary.rs:344:5:
PR_SET_NO_NEW_PRIVS is what makes `sudo` fail by mechanism rather than by a list somebody
maintained. stdout "65534\nsudo-denied\nrootfs-read-only\nNoNewPrivs:\t0\n"
```

Worth noting what the failure output shows: `sudo-denied` and `rootfs-read-only` still hold without
the flag — `nobody` is not in sudoers and the rootfs is remounted `ro` regardless. Only the
`NoNewPrivs:\t1` assertion distinguishes "denied by a list" from "denied by the kernel", which is
the distinction the whole file is written around. That assertion is load-bearing.

### E. Remove `unshare` and all five namespace flags from the launcher (`wsl.rs`) — **BITES**, and the interlock holds

This is the historic regression the file's longest comment describes: a launcher without `unshare`
runs the guest script in the user's own live Ubuntu and unmounts *their* `/mnt/c`.

First I established the interlock's premise on this machine:

```
$ wsl -d Ubuntu -e sh -c 'tail -n +3 /proc/net/dev | wc -l'
8
```

The script's first executable line is `[ "$(tail -n +3 /proc/net/dev | wc -l)" = 1 ] || exit 99`.
8 ≠ 1, so the script must exit before its first `mount`. With that established the mutation is safe
to run. Result:

```
running 2 tests
test the_users_windows_filesystem_is_not_reachable_from_inside_a_run ... FAILED
test a_run_has_no_network_at_all ... FAILED

---- the_users_windows_filesystem_is_not_reachable_from_inside_a_run stdout ----
outcome was HostFailed { reason: BackendStartFailed }, stdout ""
---- a_run_has_no_network_at_all stdout ----
stdout ""
```

`stdout ""` is the interlock: the ready sentinel never arrived, so not one line of the script after
the check ran. And the user's live distribution afterwards:

```
$ wsl -d Ubuntu -e sh -c '…'
MNT_C_OK
mnt-entries=5
ninep=4
ROOTFS_STILL_WRITABLE
```

**The interlock is real and it is the thing standing between a launcher regression and vandalising
the user's own WSL session.** This is the single most valuable line in the crate and it is the only
guard I found whose failure mode is damage to the user rather than exposure of the user.

Note also what this mutation says about the network test: `a_run_has_no_network_at_all` does not
detect a missing `--net` by observing a network. It detects it because the interlock refuses to run.
That is a stronger guarantee than the test's assertions suggest, but it means the test would not
catch a `--net` that was present-but-ineffective.

### F. Strip `canonicalize` from `resolve_host_directory` (`paths.rs`) — **BITES**

Replaced the `std::fs::canonicalize(path)` call with `path.to_path_buf()`.

```
thread '…' panicked at tests\sandbox_boundary.rs:1249:22:
a `..` out of a sibling directory and back in reached a protected root and the host answered
HostFailed { reason: BackendStartFailed }. The protected-root check must run against the path
`resolve_host_directory` produced, not against the string the caller sent.
```

`HostFailed` rather than `Refused { MountIsProtectedRoot }` means the mount was **admitted** — the
run reached execution with the user's key material in its grant. The test's control (a genuinely
unprotected sibling that must still reach a person) means this is not passing because the host
refuses everything in the temp tree. Run with `--nocapture`, no "SKIPPED one half" line appeared, so
the Windows directory-junction spelling was exercised too, not just the `..` spelling.

### G. Compute the approval digest over the run id alone (`host.rs`) — **BITES**

```
thread '…' panicked at tests\sandbox_boundary.rs:2139:13:
assertion `left != right` failed: changing the program text left the digest identical to the base
request: an approval of one would cover the other, and the person answered about neither
  left: "fe7e0934a029429c1011ffd4b76233478a059d294e8b41e8aeda5ba49993bc64"
 right: "fe7e0934a029429c1011ffd4b76233478a059d294e8b41e8aeda5ba49993bc64"
```

The test holds the run id fixed across every row precisely so this substitution cannot hide.

### H. Drift the Rust base-environment list from the TypeScript one (`contract.rs`) — **BITES**

Changed `PWD` to `SHELL` in `SANDBOX_BASE_ENVIRONMENT_POSIX`.

```
assertion `left == right` failed: the Rust `SANDBOX_BASE_ENVIRONMENT_POSIX` and the TypeScript one
have drifted apart. …
  left: ["PATH", "HOME", "TMPDIR", "LANG", "SHELL"]
 right: ["PATH", "HOME", "TMPDIR", "LANG", "PWD"]
```

The guard reads `src/platform/contract-sandbox.ts` off disk at test time — a real parity check, not
a second hand-written copy. The TS constant is a single-line array, so the CRLF hazard that broke a
sibling parity guard does not apply here (`trim_matches` includes `'\n'` but not `'\r'`; there is no
line break inside the array to expose it).

### Regression after all eight

```
$ cargo test -p vela-sandbox
running 22 tests → ok. 22 passed; 0 failed
running 43 tests → ok. 43 passed; 0 failed
$ git status --porcelain -- src-tauri/crates
(empty)
```

---

## 2. The defect: `processes` is reported `kernel`-enforced and is not enforced at all

`WslBackend::report()` (`wsl.rs:161-184`) declares, per limit:

```rust
wall_clock_ms:    EnforcementLevel::Supervisor,
memory_bytes:     EnforcementLevel::Unenforced,   // + a paragraph explaining why
cpu_millicores:   EnforcementLevel::Unenforced,
output_bytes:     EnforcementLevel::Supervisor,
processes:        EnforcementLevel::Kernel,       // "`RLIMIT_NPROC`, set before privileges are dropped."
file_write_bytes: EnforcementLevel::Unenforced,   // + a paragraph explaining why
```

`processes` is the **only** limit this backend claims at kernel strength. The line behind it is
`wsl.rs:322-325`:

```rust
push(
    &mut lines,
    format!("ulimit -u {} 2>/dev/null || true", plan.limits.processes),
);
```

and the script it lands in is piped into `/bin/sh` by `command()`:

```rust
.arg(format!("exec 3<&0; printf %s {script} | base64 -d | /bin/sh"))
```

On Ubuntu `/bin/sh` is **dash**, and dash's `ulimit` builtin has no `-u`. Measured inside a real
namespace on this machine:

```
$ wsl --exec /usr/bin/unshare --mount --pid --net --uts --ipc --fork --kill-child --mount-proc \
      /bin/sh -c '<probe>'
before=127929
ulimit-stderr=[/bin/sh: 3: ulimit: Illegal option -u]
seen-by-bash-child=127929
seen-after-setpriv=127929
prlimit-view=NPROC    max number of processes 127929 127929 processes
```

`2>/dev/null || true` swallows the error and `set -e` never sees it.

I then verified this against the **real implementation** rather than my reconstruction, by adding a
temporary integration test (`tests/zz_audit_probe.rs`, deleted immediately afterwards; the file was
untracked and `git status -- src-tauri/` was confirmed clean after removal) that submits through
`SandboxHost` with `limits.processes = 8`:

```
GRANT limits=SandboxLimits { wall_clock_ms: 60000, memory_bytes: 536870912, cpu_millicores: 1000,
                             output_bytes: 1048576, processes: 8, file_write_bytes: 104857600 }
EVENT Started { startup_ms: 3445 }
[Stdout] nproc-inside=127929
[Stdout] forked=300
[Stdout] memlimit=unlimited
[Stdout] cpulimit=unlimited
[Stdout] filesize=unlimited
[Stdout] scratch-fs=102400kb
SETTLED Exited { exit_code: 0 } RunUsage { … output_bytes: 343, dropped_output_bytes: 0 }
```

The grant handed to the caller — and, in a build with an approval surface, shown to the person —
says `processes: 8`. The run's actual `RLIMIT_NPROC` is 127 929 and it forked 300 processes with
zero errors. No test in the crate covers the `processes` limit, which is why this survived: it is
the one limit with a `kernel` claim and the one limit with no test.

This is precisely the defect class the brief names. Eleven comments once named a guard that did not
exist; here one field name and one doc-comment sentence name a guard that does not exist.

Two secondary observations from the same run, both in the crate's favour:

- `memlimit=unlimited`, `cpulimit=unlimited`, `filesize=unlimited` — exactly consistent with the
  three `Unenforced` declarations. Those absences are declared truthfully.
- `scratch-fs=102400kb` for a requested `file_write_bytes` of 104 857 600 (= 102 400 KiB). The
  scratch tmpfs sizing at `wsl.rs:290` is real and lands on the number asked for. It is still
  reported `Unenforced`, correctly, because it says nothing about writes into a `readWrite` bind
  mount. Under-claiming, as the comment says.

Severity: this is a resource-exhaustion claim, not a confinement claim. Nothing here lets a run
*reach* anything it should not. But a fork bomb inside the guest is bounded only by the WSL utility
VM, which is shared with the user's own session — and `memory_bytes` and `cpu_millicores` are
already `Unenforced`, so `processes` was the last cost limit standing.

---

## 3. Cancellation and process-tree reaping — measured, because the test does not

Mutation B showed the test does not bite on the descendant clause. So I measured the mechanism
directly, outside the repo, launching the same `wsl.exe --exec /usr/bin/unshare …` shape and killing
the Windows-side launcher, with a `setsid`-detached grandchild as the target:

```
flags='--kill-child' launcherAlive=yes markersDuring=2 markersAfterKill=0
flags=''             launcherAlive=yes markersDuring=2 markersAfterKill=0
```

`markersDuring=2` is the foreground `sleep` plus the `setsid`-detached grandchild; both are visible
from the init PID namespace (PID namespaces are hierarchical, so a plain `wsl -e ps` sees them).
After `Stop-Process -Force` on the launcher, zero survive — **with or without `--kill-child`.**

So the reaping guarantee holds on this machine. Its provenance is `--pid --fork` (when the
namespace's PID 1 dies the kernel SIGKILLs every member) and/or WSL's own relay teardown when the
Windows client disconnects; I did not isolate which, because either is sufficient and both are
present. `--kill-child` covers a third case — the `unshare` parent dying without the child noticing
— that I did not construct.

The actionable finding is not about the implementation. It is that
`cancelling_stops_the_run_and_reaches_every_descendant` is named for a guarantee it does not check,
and would be cited as cover for it.

---

## 4. stderr fidelity: host bytes attributed to the program

From the probe run in §2, on the run's **stderr** channel, before any program output:

```
[Stderr] w s l :   T h e   w s l 2 . l o c a l h o s t F o r w a r d i n g   s e t t i n g
         h a s   n o   e f f e c t   w h e n   u s i n g   m i r r o r e d   n e t w o r k i n g   m o d e
```

That is UTF-16LE from `wsl.exe`, lossily decoded, delivered as a `SandboxEvent::Output { stream:
Stderr }` and counted against `output_bytes`. Its cause is on disk:

```
$ cat C:\Users\User\.wslconfig
[wsl2]
networkingMode=mirrored
localhostForwarding=true
```

`wsl.exe` warns about that combination. `new_command()` already anticipates this exact class — its
comment describes WSL printing "pages of it, on the run's own stderr, attributed to the program" for
untranslatable `PATH` entries, and fixes that with `env_clear()`. This warning gets through anyway,
because it is not about the environment.

The startup cost in that run was `startup_ms: 3445` (cold VM). With the VM warm I could not
re-trigger it in four consecutive launcher invocations (`stderr-bytes=0` each time), which is why
`output_arrives_in_the_programs_own_order_within_one_stream` — which asserts
`collector.text(Stderr) == "to-stderr\n"` **exactly** — passes in a full suite run: by the time it
executes, an earlier test has warmed the VM. That test is order-dependent and would fail if it were
the first to run against a cold distribution. I did not confirm the cold-start trigger by
terminating the user's distribution, which I judged out of bounds.

---

## 5. Reachability — does any of this reach a user?

The IPC layer is fully wired:

- `src-tauri/src/lib.rs:210-215` registers all six commands in `invoke_handler`.
- `src-tauri/src/ipc/mod.rs:116-121` lists all six in `COMMAND_ALLOWLIST`, and
  `rust_and_typescript_allowlists_are_identical` pins that to `src/platform/contract.ts` by reading
  the TS file at test time.
- `src/data/sandbox-repository.ts` invokes all six by name.

The renderer stops there:

```
$ git grep -rln "createSandboxRepository" -- src
src/data/sandbox-repository.test.ts
src/data/sandbox-repository.ts
src/platform/project-run-scope.test.ts
```

**No non-test caller.** The only `ToolExecutor` the composition root builds is
`createSubagentToolkit(...)` (`src/runtime/app-runtime.ts:81`), which has no bash tool, so the join
`contract-sandbox.ts` describes ("the executor is where a submit is built") does not exist yet.

`src/data/sandbox-repository.test.ts` (178 lines, 7 cases) runs against `BrowserAdapter`'s fake,
which refuses every submit `languageUnsupported`. That is VERIFIED-BY-FAKE: it covers the renderer
seam's plumbing, not the host.

The permission selector is in the same state. `ipc/sandbox.rs:97` hardcodes
`permission: PermissionLevel::Ask`, and:

```
$ git grep -n "\.set_permission(" -- src-tauri | grep -i sandbox
(nothing)
```

`SandboxHost::set_permission` (`host.rs:383`) has **zero callers repo-wide, including tests**.
`off`, `approve` and `full` are unreachable in the shipped binary. Their admission logic is correct
and tested (`off_refuses_every_submit_before_anything_can_run`,
`off_is_answered_before_the_project_the_mounts_the_language_or_the_network`,
`approve_still_asks_when_the_run_falls_outside_the_shipped_profile`,
`approve_runs_a_scratch_only_container_run_without_asking`,
`a_profile_root_on_one_list_does_not_grant_the_mode_the_other_list_names`) — it just cannot be
selected.

All of this is declared, accurately, in `contract-sandbox.ts`'s amendment 4:
*"Still unbuilt: every document command path, `python`, both copying materialisations, and any
surface that renders an approval prompt — `awaitingApproval` reaches `src/data/sandbox-repository.ts`
and stops there."* I checked that sentence against the code and it is true in both directions.

---

## 6. The declared absences, checked one by one

The crate's own list (`lib.rs:14-27`) versus what I found:

| Declared absent | Verified |
| --- | --- |
| `python` | `languages` is `vec![SandboxLanguage::Bash]` (`host.rs:161-165`); `admit` refuses `languageUnsupported`; `ProcessLanguage::Python` is matched explicitly in `guest_script` with a comment saying it is unreachable rather than defaulted. Test: `python_and_every_document_language_are_refused_as_unsupported`. |
| the document family | `absent_document_backend()` reports every guarantee `Unenforced`; `languages` carries no document language; `report_document` is `pub fn report_document(&self, _request: …) {}` (`host.rs:381`) and `ipc/sandbox.rs:180-196` says so in its doc comment. |
| `copyIn` / `copyInCopyOut` | `admission.rs:257-262` returns `Err` (→ `INVALID_PAYLOAD`), not a silent downgrade. Test: `a_materialisation_this_host_does_not_serve_is_a_malformed_payload`. |
| memory and CPU limits | `Unenforced` in `report()`, with a paragraph each; measured `unlimited` inside a real run (§2). |
| every network policy but `denied` | `admission.rs:240-244` refuses `networkPolicyUnavailable` rather than downgrading. Test: `a_network_policy_this_backend_cannot_impose_is_refused_and_not_downgraded`. |

Refusal vocabulary. `RefusalReason` has 18 members. Grepping producers across `admission.rs` and
`host.rs` finds 14. The four without a producer are `SkillsMountMustBeReadOnly`,
`GuestPathRemapUnsupported`, `LimitAboveHostCeiling`, `DocumentGrantInvalid` — **exactly** the four
the contract names as having no producer, and `admission.rs`'s module comment independently explains
why `limitAboveHostCeiling` cannot occur (limits are lowered, never refused). No drift.

`HostFailureReason` has 5 members with 3 producers (`Internal`, `BackendUnavailable`,
`BackendStartFailed`). `ScratchUnavailable` and `CopyOutFailed` have none — consistent with there
being no copy materialisation and the scratch being a tmpfs created inside the guest, but this pair
is *not* called out anywhere the way the four `RefusalReason` members are.

---

## 7. What I could not establish

- **Whether the `processes` defect is Ubuntu-specific.** It is a property of `/bin/sh` being dash.
  A distribution whose `/bin/sh` is bash would apply the limit. `WslBackend::detect()` takes the
  first non-Docker distribution, whatever it is, so the report's truthfulness varies by machine —
  which is itself the problem with a hardcoded `EnforcementLevel`.
- **The cold-start trigger for the stderr leak.** Observed once at `startup_ms: 3445`; not
  reproducible with a warm VM in four attempts. Confirming it would mean terminating the user's
  live distribution, which I did not do.
- **Which mechanism reaps descendants** — PID-namespace teardown or WSL relay teardown. Both were
  present and either is sufficient.
- **The TOCTOU window** between `resolve_host_directory` and the bind mount. `paths.rs:16-19` names
  it openly and argues the mount namespace closes it. I did not attempt to race it.
- **The hypervisor boundary.** Whether WSL2's utility VM holds against a hostile guest is out of
  scope and the crate does not claim it — `isolation: Container`, not `MicroVm`, for the stated
  reason that the VM is shared with the user's own WSL session.
- **`absent_process_backend()` behaviour on a machine with no WSL.** This machine has WSL; I could
  not exercise the no-backend path except through `unreachable_backend()` in tests.
- **Concurrency under real contention.** `MAX_CONCURRENT_RUNS = 4` and the `saturating_sub(1)`
  accounting in `submit` are covered by `releasing_a_run_frees_its_id_and_the_slot_it_was_holding`,
  which I read but did not mutate.
- **Whether `python` would work if enabled.** Untested by design, and correctly not claimed.

---

## 8. Commands run

```
wsl.exe --status ; wsl.exe -l -v
cargo test -p vela-sandbox                                   (×4, including post-mutation regression)
cargo test -p vela-sandbox --test sandbox_boundary <filter>  (×7, one per mutation)
cargo test -p vela-sandbox --lib the_base_environment_list
git grep / git status --porcelain / git diff --stat          (read-only only)
wsl.exe -d Ubuntu -e sh -c '…'                               (namespace and mount-table probes)
Start-Process wsl.exe --exec /usr/bin/unshare …              (descendant-reaping measurement)
```

No `cargo build --workspace`, no `cargo test --workspace`, no requests to 127.0.0.1:8033, the app
was not launched, and no tracked file was left modified.
