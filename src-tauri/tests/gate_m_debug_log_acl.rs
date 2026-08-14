//! **GATE M — the debug log's ACL, measured on a real Windows machine.**
//!
//! # What this exists to settle
//!
//! `vela-providers/src/private_fs.rs` shipped with an honesty note saying its
//! Windows implementation was **UNRUN**: written in a Linux container,
//! type-checked against `x86_64-pc-windows-msvc`, never executed, not one line
//! of it having touched a real ACL. Worse, the module was not even in
//! `lib.rs` — it had never been compiled, on any platform.
//!
//! The finding it was written for was real and measured:
//! `%APPDATA%\dev.vela.desktop\diagnostics` — which holds raw provider
//! exchanges, verbatim prompts and answers — carried an **inherited**
//! `CodexSandboxUsers  ReadAndExecute` ACE, with DACL inheritance enabled. A
//! separate local group could read it. The `unix` branch enforced `0700`/`0600`;
//! the Windows branch was `create_dir_all` under a comment assuming the OS had
//! already done the equivalent.
//!
//! # What this driver is, and is not
//!
//! It is an **evidence driver, not an assertion about a temporary directory**.
//! Every unit test in this workspace that touches this property runs in
//! `%TEMP%`, in-process, reading the result back with the same code that wrote
//! it. This one runs the real [`debug_log_set`] against the directory the shell
//! names — which `scripts/gate-m-debug-log-acl.ps1` sets to the **real**
//! application-data path — records one exchange so the sink actually opens its
//! file, and then gets out of the way so `Get-Acl` can answer the same question
//! independently.
//!
//! `#[ignore]`d, and it takes its target from the environment rather than
//! choosing one, precisely so that `cargo test` can never write into a user's
//! application-data directory by accident.

use std::path::PathBuf;

use vela_lib::ipc::diagnostics::{debug_log_set, DebugLogHandle, DebugLogSetReq};
use vela_providers::{debuglog, private_fs};

/// The data home to drive, supplied by the shell. Not defaulted: a driver that
/// picks its own real directory is one that runs during an ordinary
/// `cargo test`.
fn data_home() -> PathBuf {
    PathBuf::from(std::env::var("VELA_GATE_DEBUG_LOG_DATA_DIR").expect(
        "VELA_GATE_DEBUG_LOG_DATA_DIR must name the application-data \
             directory to drive (scripts/gate-m-debug-log-acl.ps1 sets it)",
    ))
}

fn report(label: &str, privacy: &private_fs::Privacy) {
    println!(
        "{label} platform={} private={} inheritance_disabled={:?}",
        privacy.platform,
        privacy.is_private(),
        privacy.inheritance_disabled
    );
    if privacy.foreign.is_empty() {
        println!("{label} foreign=<none>");
    } else {
        for who in &privacy.foreign {
            println!("{label} foreign={who}");
        }
    }
    println!("{label} detail={}", privacy.detail);
}

#[test]
#[ignore = "evidence driver: writes to the application-data directory the shell names; run by scripts/gate-m-debug-log-acl.ps1"]
fn debug_log_acl_evidence_driver() {
    let handle = DebugLogHandle::under_data_dir(data_home());
    let diagnostics = handle
        .path()
        .parent()
        .expect("the log lives in a directory")
        .to_path_buf();

    println!("VELA_ACL_DIRECTORY={}", diagnostics.display());
    println!("VELA_ACL_LOG={}", handle.path().display());

    // BEFORE — whatever state the shell left the directory in. Absent is a
    // legitimate reading: the first run on a clean machine has nothing here.
    match private_fs::describe(&diagnostics) {
        Ok(before) => report("BEFORE", &before),
        Err(error) => println!("BEFORE absent ({error})"),
    }

    // The real switch, on the real path.
    let status = debug_log_set(&handle, DebugLogSetReq { enabled: true })
        .expect("the switch refused to enable the log");
    assert!(
        status.enabled,
        "the switch reported the log off after enabling"
    );

    // `FileSink` opens its file lazily, so an enabled log with nothing written
    // to it is a directory and no file. One recorded exchange is what makes the
    // file half of this measurable at all.
    debuglog::record(|| debuglog::DebugEntryOwned {
        correlation: vela_providers::diagnostic::CorrelationId::next(),
        cause: vela_providers::diagnostic::Cause::CredentialRejected,
        status: Some(401),
        endpoint: None,
        body: b"GATE-M-ACL: the endpoint's own words".to_vec(),
    });
    debuglog::disable();

    let after_directory = private_fs::describe(&diagnostics)
        .expect("the directory must be readable after the switch");
    report("AFTER-DIR", &after_directory);

    let after_log = private_fs::describe(handle.path());
    match &after_log {
        Ok(privacy) => report("AFTER-LOG", privacy),
        Err(error) => println!("AFTER-LOG absent ({error})"),
    }

    assert!(
        after_directory.is_private(),
        "the directory holding raw provider exchanges is reachable by a \
         principal that is not its owner: {after_directory:?}"
    );
    assert!(
        handle.path().exists(),
        "the log received no line, so the file half was not measured"
    );
    let after_log = after_log.expect("the log must be readable after a recorded exchange");
    assert!(
        after_log.is_private(),
        "the debug log itself is reachable by a principal that is not its \
         owner: {after_log:?}"
    );
}
