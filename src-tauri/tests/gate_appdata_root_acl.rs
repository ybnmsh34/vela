//! **GATE — the application-data root's ACL, measured on a real Windows
//! machine.**
//!
//! # What this exists to settle
//!
//! `vela-privatefs` was written for a measured finding on
//! `%APPDATA%\dev.vela.desktop\diagnostics`, and it fixed it. It was applied to
//! **that subdirectory only**. The audit that followed measured the directory
//! containing it — the one holding `vela.db`, its 2.6 MB write-ahead log and
//! `skills/` — and found the identical inherited ACE still there:
//!
//! ```text
//! C:\Users\User\AppData\Roaming\dev.vela.desktop
//!   AreAccessRulesProtected : False
//!   DESKTOP-298M5DU\CodexSandboxUsers  ReadAndExecute, Synchronize  inherited=True
//! ```
//!
//! Every conversation the user has ever had, readable by a second local group,
//! with the debug log beside it correctly locked. `DatabaseLocation::prepare`
//! now hardens the root through the same crate. This driver is how that claim
//! stops being a claim.
//!
//! # What this driver is, and is not
//!
//! It is an **evidence driver, not an assertion about a temporary directory**.
//! The unit tests in `vela-store` run in-process and read the result back with
//! the same code that wrote it — a good assertion and a poor measurement, since
//! it shares a process and a reader with the thing under test. This one opens a
//! **real `SqliteStore`** at the directory the shell names, writes a real
//! conversation so SQLite creates a real `-wal`, and then gets out of the way so
//! `Get-Acl` can answer the same question with a reader that shares no code
//! with `vela-privatefs`.
//!
//! # It never runs against the user's data
//!
//! Unlike `gate_m_debug_log_acl.rs`, which drives the real application-data
//! directory, this one drives a **scratch directory the script creates under
//! `%TEMP%`**. There is no reading of a user's real database that this gate
//! needs and cannot get from a scratch copy: what is under test is the
//! *transition* from a widened directory to a private one, and a scratch
//! directory widened with the identical `icacls` grant reproduces that exactly.
//! Pointing an automated ACL rewrite at a live 315 KB database to prove it is
//! safe is not a trade worth making.
//!
//! `#[ignore]`d, and it takes its target from the environment rather than
//! choosing one, so an ordinary `cargo test` can never write into any
//! application-data directory by accident.

use std::path::PathBuf;

use vela_privatefs as private_fs;
use vela_store::{
    ConversationRepository, DatabaseLocation, MessageRepository, NewConversation, NewMessage,
    SqliteStore, DATABASE_FILE_NAME,
};

/// The directory to drive, supplied by the shell. Not defaulted: a driver that
/// picks its own directory is one that runs during an ordinary `cargo test`.
fn data_home() -> PathBuf {
    PathBuf::from(std::env::var("VELA_GATE_APPDATA_ROOT_DIR").expect(
        "VELA_GATE_APPDATA_ROOT_DIR must name the SCRATCH directory to drive \
         (scripts/gate-appdata-root-acl.ps1 creates one under %TEMP% and sets it)",
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
#[ignore = "evidence driver: opens a database in the scratch directory the shell names; run by scripts/gate-appdata-root-acl.ps1"]
fn appdata_root_acl_evidence_driver() {
    let data = data_home();
    println!("VELA_ACL_DIRECTORY={}", data.display());

    // BEFORE — whatever state the shell left it in. The script widens it first,
    // so this is expected to name a foreign principal; absent is also a
    // legitimate reading, for the clean-machine half.
    match private_fs::describe(&data) {
        Ok(before) => report("BEFORE", &before),
        Err(error) => println!("BEFORE absent ({error})"),
    }

    // The real production path. `SqliteStore::open` calls
    // `DatabaseLocation::prepare`, which is the thing under test; nothing here
    // reaches past it to a private entry point.
    let store = SqliteStore::open(DatabaseLocation::in_directory(&data))
        .expect("the store refused to open the database");

    // A `-wal` only exists once something has been committed. Writing a real
    // conversation is what makes the sibling half of this measurable at all.
    let chat = store
        .create_conversation(NewConversation::titled(
            "gate: the sort of thing a user types",
        ))
        .expect("a conversation");
    store
        .append_message(NewMessage::user(
            chat.id.clone(),
            "GATE-ACL: text that must not be readable by another local account",
        ))
        .expect("a message");

    let after_directory =
        private_fs::describe(&data).expect("the directory must be readable after opening");
    report("AFTER-DIR", &after_directory);

    assert!(
        after_directory.is_private(),
        "the directory holding every conversation is reachable by a principal \
         that is not its owner: {after_directory:?}"
    );

    // The siblings. The database is hardened in its own right by `prepare`;
    // the `-wal` and `-shm` are created by SQLite afterwards and are private by
    // inheritance from the root, which is why `foreign` — not `is_private()` —
    // is the quantity asserted for them.
    let mut measured_wal = false;
    for suffix in ["", "-wal", "-shm"] {
        let path = data.join(format!("{DATABASE_FILE_NAME}{suffix}"));
        if !path.exists() {
            println!("AFTER-{suffix} absent");
            continue;
        }
        let privacy = private_fs::describe(&path).expect("a sibling must be readable");
        report(&format!("AFTER-FILE{suffix}"), &privacy);
        assert!(
            privacy.foreign.is_empty(),
            "`{}` holds conversation text and is reachable by another account: \
             {privacy:?}",
            path.display()
        );
        if suffix == "-wal" {
            measured_wal = true;
        }
    }
    assert!(
        measured_wal,
        "no write-ahead log existed, so the sibling half measured nothing"
    );

    // Closed before the shell reads the ACLs, so `Get-Acl` is not racing an
    // open handle and the `-shm` is in whatever state a real shutdown leaves.
    drop(store);
}
