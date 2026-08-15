//! The one backend that is a boundary: a Linux mount, PID, network, IPC and UTS
//! namespace inside the WSL2 utility VM.
//!
//! ## Why this, on this machine
//!
//! The two reference products this contract was written against both stop at a
//! child process. `docs/references/unsloth-studio.md` records what that buys:
//! a command filter that lost to full binary paths, shell quoting, nested
//! shells and a pivot through Python's own process spawning, fixed with six
//! layered mitigations and reported still reachable the next day by the person
//! who found it. `docs/references/mindshub-cowork.md` is weaker — a virtualenv
//! subprocess whose installer adds a firewall rule to *permit* outbound
//! traffic. Neither is a boundary; both are a filter with good intentions.
//!
//! What this machine actually has was measured rather than assumed: WSL2 with a
//! running Ubuntu distribution, Docker Desktop present but its daemon not
//! something a desktop app may assume, and no Windows Sandbox. Of those, WSL2 is
//! the only one that is both present and a kernel boundary — it is a Hyper-V
//! utility VM running a Linux kernel that is not the Windows kernel — and it is
//! the only one that costs no daemon and no image pull.
//!
//! ## What the guest script does, and what each line is for
//!
//! Bare `wsl.exe -e bash -c …` is **not** a sandbox: the user's whole C: drive
//! is mounted at `/mnt/c` with their own privileges and the VM has NAT'd
//! outbound networking. Every line below exists to take one of those away.
//!
//!  - `unshare --mount --pid --net --uts --ipc --fork --kill-child --mount-proc`
//!    — five namespaces. `--net` is an *empty* network namespace: not a firewall
//!    rule, not a proxy, no interface but a down loopback. `--pid` plus
//!    `--kill-child` is what makes teardown total: when the namespace's PID 1
//!    dies the kernel reaps every descendant, so a double-forked grandchild has
//!    nowhere to survive.
//!  - `mount --make-rprivate /` — so the unmounts below do not propagate out of
//!    this namespace and break the user's own WSL session.
//!  - the granted directories are bind-mounted **before** `/mnt` is taken away,
//!    and to a path that is not under `/mnt`, so the bind keeps the drvfs
//!    superblock alive while the path that reaches the rest of the drive stops
//!    existing.
//!  - every mount under `/mnt` **and under `/usr/lib/wsl`** is lazily unmounted,
//!    and an empty read-only tmpfs is mounted over `/mnt` itself. `/mnt` is a
//!    plain directory rather than a mount point, so `umount -R /mnt` answers
//!    "not mounted" — which is exactly the kind of thing that is discovered by
//!    running it and never by reasoning about it. The second prefix is the same
//!    kind of discovery: WSL puts a 9p share of the Windows driver store at
//!    `/usr/lib/wsl/drivers`, an unmount aimed at `/mnt` never touches it, and a
//!    run that still has it can read files off the user's Windows disk.
//!  - `binfmt_misc` is unmounted and `env -i` clears `WSL_INTEROP`. Those are
//!    the two halves of WSL's Windows-interop path; either one left in place
//!    means the run can execute a Windows binary, which is every guarantee here
//!    at once.
//!  - the rootfs is remounted read-only, so the distribution the user shares
//!    with this run cannot be modified by it.
//!  - `setpriv --reuid --regid --clear-groups --no-new-privs` — the run is uid
//!    65534 with no supplementary groups and `PR_SET_NO_NEW_PRIVS`, which is the
//!    kernel-level privilege denial the reference product's fix added. `sudo`
//!    and `su` cannot raise privileges regardless of how they are invoked,
//!    because the kernel refuses the setuid bit rather than because a list was
//!    consulted.
//!
//! **No part of the program's text is examined by any of this**, and no shell
//! ever parses it: it is base64-encoded on the way in and decoded to a file the
//! interpreter reads. There is no blocklist here and no place to put one.

use std::process::{Command, Stdio};

use crate::admission::RunPlan;
use crate::contract::*;
use crate::digest::base64_encode;

/// The first bytes the guest writes on stdout once confinement is established
/// and before the program is executed.
///
/// Without it there is no way to tell "the setup failed" from "the program
/// exited non-zero", and a host that guessed would report one as the other. It
/// is always the first thing on the stream because nothing else has run yet.
pub const READY_SENTINEL: &str = "\u{1}VELA_SANDBOX_READY\u{1}\n";

/// Distributions that are somebody else's machinery rather than a place to run
/// a user's script.
const NOT_A_GUEST: [&str; 2] = ["docker-desktop", "docker-desktop-data"];

#[derive(Debug, Clone)]
pub struct WslBackend {
    distro: String,
}

impl WslBackend {
    /// Ask Windows which distributions exist and take the first usable one.
    ///
    /// `None` means this host has no process backend at all, which is a legal
    /// answer: `SandboxPolicySnapshot.languages` is then empty and every process
    /// submit is refused `languageUnsupported` before anything is spawned.
    pub fn detect() -> Option<Self> {
        let output = new_command(&wsl_executable())
            .args(["--list", "--quiet"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        // `wsl.exe --list` answers UTF-16LE.
        let text: String = output
            .stdout
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<u16>>()
            .into_iter()
            .collect::<Vec<u16>>()
            .chunks(1)
            .filter_map(|unit| char::from_u32(unit[0] as u32))
            .collect();
        text.lines()
            .map(|line| line.trim().trim_matches('\0').to_string())
            .find(|name| !name.is_empty() && !NOT_A_GUEST.contains(&name.as_str()))
            .map(|distro| Self { distro })
    }

    pub fn for_distro(distro: impl Into<String>) -> Self {
        Self {
            distro: distro.into(),
        }
    }

    pub fn distro(&self) -> &str {
        &self.distro
    }

    /// What this backend can actually deliver, per guarantee.
    ///
    /// Read the three `unenforced` values before rendering the word "sandbox"
    /// anywhere: this backend confines *reach* completely and *cost* only
    /// partly, and the difference is the whole reason this type exists.
    pub fn report(&self) -> SandboxBackendReport {
        SandboxBackendReport {
            // `container` and not `microVm`, deliberately. The Linux kernel here
            // is not the Windows kernel, so the escape surface *to Windows* is
            // the hypervisor — but the VM is shared with the user's own WSL
            // session, so the escape surface *to the user's Linux files* is the
            // namespace boundary. The weaker of the two true statements is the
            // one this field must make.
            isolation: Isolation::Process {
                level: ProcessIsolation::Container,
            },
            maximum_isolation: Isolation::Process {
                level: ProcessIsolation::Container,
            },
            // `declared`, and it stays `declared` until an escape battery runs
            // at start-up rather than in `cargo test`. The battery exists —
            // `sandbox_boundary.rs` — and running it here would cost every
            // launch several seconds, so this field is honest about what this
            // process has personally verified: nothing.
            evidence: IsolationEvidence::Declared,
            // An empty network namespace. Not a rule, not a proxy: no interface.
            network: EnforcementLevel::Kernel,
            // A constructed mount namespace. What the run can read is a property
            // of what was mounted, not of what it thought to open.
            filesystem: EnforcementLevel::Kernel,
            // PID namespace plus `--kill-child`.
            process_tree: EnforcementLevel::Kernel,
            limits: LimitEnforcement {
                // A host-side timer that kills the run. Real, and racy.
                wall_clock_ms: EnforcementLevel::Supervisor,
                // **Unenforced, and not by oversight.** There is no cgroup here,
                // and the limit that could be applied — `RLIMIT_AS` — bounds
                // address space, which is not the resident bytes this field
                // names. Applying it and reporting `kernel` would put a number
                // in front of a user that means something else. The real bound
                // on a runaway allocation is the WSL VM's own memory ceiling and
                // its own OOM killer, which is inside the VM and not on the
                // user's desktop.
                memory_bytes: EnforcementLevel::Unenforced,
                cpu_millicores: EnforcementLevel::Unenforced,
                // Counted host-side; one `truncated` event, then output is
                // dropped and the program runs on.
                output_bytes: EnforcementLevel::Supervisor,
                // `RLIMIT_NPROC`, set before privileges are dropped.
                processes: EnforcementLevel::Kernel,
                // The scratch tmpfs is sized from this number, which is a real
                // kernel bound on scratch writes — but it says nothing about
                // writes into a `readWrite` bind mount, and this field is about
                // all writes. Under-claiming is the only safe direction.
                file_write_bytes: EnforcementLevel::Unenforced,
            },
        }
    }

    /// The whole guest program, as one POSIX shell script.
    ///
    /// Public because a test that cannot read the script cannot assert that a
    /// line it depends on is still in it.
    pub fn guest_script(&self, plan: &RunPlan) -> String {
        let mut lines: Vec<String> = Vec::new();
        let push = &mut |lines: &mut Vec<String>, line: String| lines.push(line);

        push(&mut lines, "set -e".into());

        // **The interlock, and it is the most important line in this file.**
        //
        // Everything below unmounts the user's drives and remounts their
        // distribution read-only. Inside the namespaces `unshare` creates that
        // is confinement. *Outside* them it is vandalism against a live Ubuntu
        // the user is also using — which is not hypothetical: an earlier draft
        // of `command` omitted `unshare` entirely, this script ran in the
        // distribution's own namespace, and `/mnt/c` was gone from the user's
        // machine until the distribution was terminated. The filesystem escape
        // test *passed* through all of it, because the drive really was
        // unreachable; only the network test failed, and only because
        // `unshare --net` had never run.
        //
        // So: prove the namespaces exist before touching anything. An unshared
        // network namespace has exactly one interface, `lo`, and there is no way
        // to see that number without the `unshare` call having succeeded — the
        // five namespaces are one syscall's worth of flags and they arrive
        // together or not at all. Exit before the first mount otherwise; the
        // ready sentinel never arrives and the host reports a backend failure.
        push(
            &mut lines,
            "[ \"$(tail -n +3 /proc/net/dev | wc -l)\" = 1 ] || exit 99".into(),
        );

        push(&mut lines, "mount --make-rprivate /".into());

        // A tmpfs for everything this run owns, so the program text and the
        // scratch tree exist only for as long as the namespace does.
        push(&mut lines, "mkdir -p /vela".into());
        push(
            &mut lines,
            "mount -t tmpfs -o size=8m,mode=0755 tmpfs /vela".into(),
        );

        // Grants first: the bind has to be taken while `/mnt` still reaches the
        // drive, and it survives the unmount below because it is not under it.
        for mount in &plan.mounts {
            push(&mut lines, format!("mkdir -p {}", sh_quote(&mount.guest_path)));
            push(
                &mut lines,
                format!(
                    "mount --bind {} {}",
                    sh_quote(&mount.wsl_source),
                    sh_quote(&mount.guest_path)
                ),
            );
            if mount.mode == MountMode::ReadOnly {
                push(
                    &mut lines,
                    format!(
                        "mount -o remount,ro,bind {}",
                        sh_quote(&mount.guest_path)
                    ),
                );
            }
        }

        // Now take the drives away. Deepest first, so a nested mount does not
        // block its parent.
        //
        // **Two prefixes, and `/mnt` alone is not enough.** WSL mounts the
        // Windows drives under `/mnt`, and it also mounts the host's driver
        // store at `/usr/lib/wsl/drivers` — a second 9p share of the user's
        // Windows disk, read-only, that survives every unmount aimed at `/mnt`.
        // A run with that still in its table can read Windows files, which is
        // the one thing this script exists to prevent.
        //
        // The prefixes are named rather than "every 9p mount" because a grant is
        // a *bind* of a 9p source and reports `9p` at its new location: a loop
        // that unmounted by filesystem type would take away the directory the
        // caller was granted. Neither prefix can hold a grant —
        // `paths::RESERVED_GUEST_ROOTS` refuses `/mnt` and `/usr` — so this loop
        // can only ever unmount WSL's own.
        push(
            &mut lines,
            "for m in $(awk '$5 ~ /^\\/mnt\\// || $5 ~ /^\\/usr\\/lib\\/wsl\\// {print $5}' \
             /proc/self/mountinfo | sort -r); do umount -l \"$m\" 2>/dev/null || true; done"
                .into(),
        );
        push(
            &mut lines,
            "mount -t tmpfs -o size=1m,mode=0555 tmpfs /mnt".into(),
        );
        // Half of WSL's Windows-interop path. The other half is `WSL_INTEROP`,
        // which `env -i` below removes.
        push(
            &mut lines,
            "umount -l /proc/sys/fs/binfmt_misc 2>/dev/null || true".into(),
        );

        // The scratch directory: a tmpfs of its own, owned by the run's uid,
        // sized from the write budget so a runaway `dd` fills a bounded thing.
        let scratch_kib = (plan.limits.file_write_bytes / 1024).clamp(1024, 262_144);
        push(
            &mut lines,
            format!("mkdir -p {}", sh_quote(&plan.scratch_guest_path)),
        );
        push(
            &mut lines,
            format!(
                "mount -t tmpfs -o size={scratch_kib}k,mode=0700,uid={SANDBOX_UID},gid={SANDBOX_GID} tmpfs {}",
                sh_quote(&plan.scratch_guest_path)
            ),
        );

        // The program. Base64 on the way in, a file on the way out: no shell
        // ever sees a byte of it.
        push(
            &mut lines,
            format!(
                "printf %s {} | base64 -d > /vela/program",
                base64_encode(plan.source.as_bytes())
            ),
        );
        push(&mut lines, "chmod 0444 /vela/program".into());

        // The distribution the user shares with this run is not the run's to
        // modify.
        push(
            &mut lines,
            "mount -o remount,ro,bind / 2>/dev/null || true".into(),
        );

        push(&mut lines, format!("cd {}", sh_quote(&plan.working_directory)));
        push(
            &mut lines,
            format!("ulimit -u {} 2>/dev/null || true", plan.limits.processes),
        );

        // Confinement is established. Everything after this line runs as the
        // sandbox uid.
        push(
            &mut lines,
            format!("printf %s {} | base64 -d", base64_encode(READY_SENTINEL.as_bytes())),
        );
        let mut env_args = String::new();
        for entry in plan.base_environment.iter().chain(plan.environment.iter()) {
            env_args.push(' ');
            env_args.push_str(&sh_quote(&format!("{}={}", entry.name, entry.value)));
        }
        let interpreter = match plan.language {
            ProcessLanguage::Bash => "/bin/bash",
            // Not reachable: `languages` never contains `python` on this
            // backend, so `admit` refuses it. Named rather than defaulted, so
            // that adding it is a decision and not an accident.
            ProcessLanguage::Python => "/usr/bin/python3",
        };
        // **`0<&3 3<&-` belongs on this line and nowhere else.**
        //
        // The caller's stdin is parked on fd 3 by the launcher, because fd 0 is
        // carrying this script into `sh`. The obvious move — an earlier
        // `exec 0<&3 3<&-` on a line of its own — is wrong in a way that only
        // shows up with a non-empty stdin: `sh` is *still reading the script
        // from fd 0*, so the next thing it parses is the caller's input. The
        // observed result was `/bin/bash /vela/programfed-in`, the program path
        // with the first line of stdin welded onto it. Redirecting on the `exec`
        // that replaces the shell means the shell never reads again.
        push(
            &mut lines,
            format!(
                "exec setpriv --reuid={SANDBOX_UID} --regid={SANDBOX_GID} --clear-groups \
                 --no-new-privs -- /usr/bin/env -i{env_args} {interpreter} /vela/program 0<&3 3<&-"
            ),
        );

        lines.join("\n")
    }

    /// The launcher, ready to spawn.
    ///
    /// The script is base64-encoded again here, for a different reason than the
    /// program was: this argument crosses a Windows command line, and a form
    /// made only of `[A-Za-z0-9+/=]`, spaces and pipes is one that
    /// `CommandLineToArgvW` and every shell in the chain agree about. The
    /// study's escape lived in exactly the gap between two parsers' opinions
    /// about the same bytes.
    pub fn command(&self, plan: &RunPlan) -> Command {
        let script = base64_encode(self.guest_script(plan).as_bytes());
        let mut command = new_command(&wsl_executable());
        command
            .arg("--distribution")
            .arg(&self.distro)
            .arg("--user")
            .arg("root")
            // Without this, WSL starts in the Windows working directory, which
            // it reaches through `/mnt` — the one thing this run must not have.
            .arg("--cd")
            .arg("/")
            .arg("--exec")
            // The namespaces. Nothing below this argument is a boundary without
            // it, and the guest script refuses to run if it is missing.
            .arg("/usr/bin/unshare")
            .arg("--mount")
            .arg("--pid")
            .arg("--net")
            .arg("--uts")
            .arg("--ipc")
            .arg("--fork")
            .arg("--kill-child")
            .arg("--mount-proc")
            .arg("/bin/sh")
            .arg("-c")
            // fd 0 carries the script, so the caller's stdin is parked on fd 3
            // and the guest script moves it back before executing the program.
            .arg(format!(
                "exec 3<&0; printf %s {script} | base64 -d | /bin/sh"
            ))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
}

/// `wsl.exe` by absolute path, because the launcher's environment is cleared.
fn wsl_executable() -> std::ffi::OsString {
    match std::env::var_os("SystemRoot") {
        Some(root) => std::path::Path::new(&root)
            .join("System32")
            .join("wsl.exe")
            .into_os_string(),
        None => std::ffi::OsString::from("wsl.exe"),
    }
}

/// `nobody`. A uid with no files, no groups and no login shell anywhere in a
/// stock distribution.
const SANDBOX_UID: u32 = 65534;
const SANDBOX_GID: u32 = 65534;

/// Single-quote for POSIX `sh`. The only character with meaning inside single
/// quotes is the single quote, and this is the standard way to spell it.
pub fn sh_quote(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 2);
    out.push('\'');
    for ch in raw.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

fn new_command(program: &std::ffi::OsStr) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW. A desktop app that flashes a console window every
        // time a model runs a script has told the user something about its
        // implementation that is none of their business.
        command.creation_flags(0x0800_0000);
    }
    // **The launcher inherits nothing.** Two reasons, and the second is the one
    // that matters. WSL translates the Windows `PATH` into the guest and prints
    // a line per entry it cannot translate, which is every entry once `/mnt` is
    // gone — pages of it, on the run's own stderr, attributed to the program.
    // And the environment Vela was launched with is the user's shell
    // environment: every token they exported into it would otherwise reach the
    // launcher, which is the inherit-then-blocklist pattern
    // `SANDBOX_BASE_ENVIRONMENT_POSIX` exists to invert.
    command.env_clear();
    if let Some(root) = std::env::var_os("SystemRoot") {
        // `wsl.exe` needs to find the Windows subsystem; nothing else survives.
        command.env("SystemRoot", &root);
    }
    // Empty, and stated rather than omitted: `WSLENV` is how a variable is
    // forwarded into the guest, and an unset one behaves the same as an empty
    // one only until somebody sets it process-wide.
    command.env("WSLENV", "");
    command.stdin(Stdio::null());
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::admission::ResolvedMount;

    fn plan() -> RunPlan {
        RunPlan {
            language: ProcessLanguage::Bash,
            source: "echo hi".into(),
            stdin: None,
            environment: vec![],
            base_environment: vec![EnvironmentEntry {
                name: "HOME".into(),
                value: "/vela/scratch".into(),
            }],
            mounts: vec![ResolvedMount {
                wsl_source: "/mnt/c/Users/User/proj".into(),
                guest_path: "/vela/work".into(),
                mode: MountMode::ReadOnly,
            }],
            scratch_guest_path: "/vela/scratch".into(),
            working_directory: "/vela/scratch".into(),
            limits: DEFAULT_PROCESS_LIMITS,
        }
    }

    #[test]
    fn single_quoting_survives_a_path_containing_a_quote() {
        assert_eq!(sh_quote("/a/b"), "'/a/b'");
        assert_eq!(sh_quote("/it's"), "'/it'\\''s'");
        assert_eq!(sh_quote("$(id)`id`"), "'$(id)`id`'");
    }

    #[test]
    fn the_guest_script_takes_away_every_route_to_the_windows_filesystem() {
        let script = WslBackend::for_distro("Ubuntu").guest_script(&plan());
        assert!(script.contains("mount --make-rprivate /"), "{script}");
        assert!(script.contains("umount -l \"$m\""), "{script}");
        // Both routes, not just the drives: `/usr/lib/wsl/drivers` is a second
        // 9p share of the Windows disk and no `/mnt` unmount reaches it.
        assert!(script.contains("$5 ~ /^\\/mnt\\//"), "{script}");
        assert!(script.contains("$5 ~ /^\\/usr\\/lib\\/wsl\\//"), "{script}");
        assert!(
            script.contains("mount -t tmpfs -o size=1m,mode=0555 tmpfs /mnt"),
            "{script}"
        );
        assert!(script.contains("binfmt_misc"), "{script}");
        assert!(script.contains("remount,ro,bind /"), "{script}");
        assert!(script.contains("--no-new-privs"), "{script}");
        assert!(script.contains("--reuid=65534"), "{script}");
        assert!(script.contains("env -i"), "{script}");
    }

    #[test]
    fn the_program_text_never_appears_in_the_script_a_shell_parses() {
        let mut plan = plan();
        plan.source = "echo '; rm -rf /".into();
        let script = WslBackend::for_distro("Ubuntu").guest_script(&plan);
        assert!(
            !script.contains("rm -rf"),
            "the program travels base64-encoded; a shell must never see its bytes:\n{script}"
        );
        assert!(script.contains("base64 -d > /vela/program"), "{script}");
    }

    #[test]
    fn a_read_only_grant_is_remounted_read_only_and_a_writable_one_is_not() {
        let backend = WslBackend::for_distro("Ubuntu");
        let read_only = backend.guest_script(&plan());
        assert!(read_only.contains("remount,ro,bind '/vela/work'"), "{read_only}");

        let mut writable = plan();
        writable.mounts[0].mode = MountMode::ReadWrite;
        let script = backend.guest_script(&writable);
        assert!(!script.contains("remount,ro,bind '/vela/work'"), "{script}");
        assert!(script.contains("mount --bind '/mnt/c/Users/User/proj' '/vela/work'"), "{script}");
    }

    /// **The regression this file exists to never repeat.**
    ///
    /// An earlier draft built the launcher without `unshare`. The guest script
    /// ran in the user's own distribution and unmounted `/mnt/c` there; the
    /// filesystem escape test passed, because the drive really had become
    /// unreachable, and only the network test noticed. Nothing about the script
    /// can catch that — it is a property of how the script is launched.
    #[test]
    fn the_launcher_creates_every_namespace_the_boundary_is_made_of() {
        let command = WslBackend::for_distro("Ubuntu").command(&plan());
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        for required in [
            "/usr/bin/unshare",
            "--mount",
            "--pid",
            "--net",
            "--uts",
            "--ipc",
            "--fork",
            "--kill-child",
            "--mount-proc",
        ] {
            assert!(
                args.iter().any(|arg| arg == required),
                "the launcher must pass `{required}`; without it the guest script \
                 operates on the user's own distribution. args: {args:?}"
            );
        }
    }

    #[test]
    fn the_script_proves_it_is_confined_before_it_touches_a_single_mount() {
        let script = WslBackend::for_distro("Ubuntu").guest_script(&plan());
        let interlock = script
            .find("/proc/net/dev")
            .expect("the script checks that it is in a fresh network namespace");
        let first_mount = script.find("mount ").expect("the script mounts things");
        assert!(
            interlock < first_mount,
            "the interlock must come first, or a launcher that lost its \
             `unshare` unmounts the user's drives before anything notices"
        );
    }

    #[test]
    fn the_grant_is_bound_before_the_drives_are_taken_away() {
        let script = WslBackend::for_distro("Ubuntu").guest_script(&plan());
        let bind = script.find("mount --bind").expect("binds the grant");
        let hide = script.find("mountinfo").expect("hides the drives");
        assert!(
            bind < hide,
            "binding after the unmount would bind an empty tmpfs over the user's \
             directory, which is a run that writes into nowhere and reports success"
        );
    }
}
