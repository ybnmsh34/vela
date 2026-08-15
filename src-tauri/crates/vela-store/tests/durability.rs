//! Integration tests against a **real file on disk**, in a temporary
//! directory — the unit tests use in-memory databases, which cannot say
//! anything about surviving a restart, about WAL, or about upgrading a
//! database an older build left behind.
//!
//! What this still does not prove: behaviour on the user's actual OS
//! application-data directory (this container resolves no such path), or
//! behaviour under power loss. Those are not testable here and are not claimed.

use std::sync::Arc;

use vela_store::{
    Clock, ContentPart, ConversationRepository, DatabaseLocation, FixedClock, IdSource,
    MessageQuery, MessageRepository, NewConversation, NewMessage, SettingEntry, SettingsRepository,
    SqliteStore, SystemClock, UuidSource, VelaStore, MIGRATIONS, SCHEMA_VERSION,
};

fn open(dir: &std::path::Path) -> SqliteStore {
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let ids: Arc<dyn IdSource> = Arc::new(UuidSource);
    SqliteStore::open_with(DatabaseLocation::in_directory(dir), clock, ids)
        .expect("store opens on a real file")
}

#[test]
fn everything_written_survives_closing_and_reopening_the_file() {
    let dir = tempfile::tempdir().unwrap();

    let (conversation_id, message_id) = {
        let store = open(dir.path());
        let chat = store
            .create_conversation(
                NewConversation::titled("Across a restart")
                    .with_model("local-llamacpp", "qwen3-8b"),
            )
            .unwrap();
        store
            .append_message(NewMessage::user(chat.id.clone(), "does this survive?"))
            .unwrap();
        let answer = store
            .append_message(NewMessage::assistant(
                chat.id.clone(),
                vec![
                    ContentPart::reasoning("the file is fsynced through WAL"),
                    ContentPart::text("Yes."),
                ],
            ))
            .unwrap();
        store
            .put_setting(SettingEntry::new(
                "appearance.theme",
                serde_json::json!("dark"),
            ))
            .unwrap();
        (chat.id, answer.id)
    }; // the connection is dropped here — as it would be on quitting the app

    let reopened = open(dir.path());
    assert_eq!(reopened.schema_version().unwrap(), SCHEMA_VERSION);

    let chat = reopened.get_conversation(&conversation_id).unwrap();
    assert_eq!(chat.title, "Across a restart");
    assert_eq!(chat.message_count, 2);

    let transcript = reopened
        .list_messages(&conversation_id, MessageQuery::default())
        .unwrap();
    assert_eq!(transcript.len(), 2);

    let answer = reopened.get_message(&message_id).unwrap();
    assert_eq!(answer.answer_text(), "Yes.");
    assert_eq!(
        answer.reasoning_text().as_deref(),
        Some("the file is fsynced through WAL"),
        "reasoning must survive a restart as its own channel"
    );

    assert_eq!(
        reopened
            .get_setting("appearance.theme")
            .unwrap()
            .unwrap()
            .value,
        serde_json::json!("dark")
    );

    // Search is rebuilt from the same file, not from process memory.
    let hits = reopened.search_messages("fsynced", 10).unwrap();
    assert_eq!(hits.len(), 1);
}

#[test]
fn a_second_store_on_the_same_file_sees_the_first_ones_writes() {
    let dir = tempfile::tempdir().unwrap();
    let writer = open(dir.path());
    let reader = open(dir.path());

    let chat = writer
        .create_conversation(NewConversation::titled("shared file"))
        .unwrap();
    writer
        .append_message(NewMessage::user(chat.id.clone(), "written by the first"))
        .unwrap();

    let seen = reader.get_conversation(&chat.id).unwrap();
    assert_eq!(seen.message_count, 1);
    assert_eq!(
        reader
            .list_messages(&chat.id, MessageQuery::default())
            .unwrap()[0]
            .answer_text(),
        "written by the first"
    );
    assert_eq!(writer.journal_mode().unwrap().to_lowercase(), "wal");
}

#[test]
fn a_database_left_by_an_older_build_is_upgraded_in_place_and_its_content_indexed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(vela_store::DATABASE_FILE_NAME);

    // Stand up a database at schema version 1 only — no search index existed
    // yet — and put a row in it by hand, exactly as the older build would have.
    {
        let mut old = rusqlite::Connection::open(&path).unwrap();
        old.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let applied =
            vela_store::migrations::apply_list(&mut old, &MIGRATIONS[..1], &FixedClock::default())
                .unwrap();
        assert_eq!(applied, vec![1]);

        old.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at)
             VALUES ('conv_old', 'Written by an older Vela', 1, 1)",
            [],
        )
        .unwrap();
        old.execute(
            "INSERT INTO messages (id, conversation_id, seq, role, status, created_at, updated_at)
             VALUES ('msg_old', 'conv_old', 0, 'assistant', 'complete', 1, 1)",
            [],
        )
        .unwrap();
        old.execute(
            "INSERT INTO message_parts (message_id, seq, kind, text)
             VALUES ('msg_old', 0, 'reasoning', 'an older thought about heliocentrism')",
            [],
        )
        .unwrap();
        old.execute(
            "INSERT INTO message_parts (message_id, seq, kind, text)
             VALUES ('msg_old', 1, 'text', 'The Earth goes round the Sun.')",
            [],
        )
        .unwrap();
    }

    // Opening with this build applies the outstanding migration at startup.
    let store = open(dir.path());
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);

    let conversation_id = vela_store::ConversationId::new("conv_old").unwrap();
    let transcript = store
        .list_messages(&conversation_id, MessageQuery::default())
        .unwrap();
    assert_eq!(transcript.len(), 1);
    assert_eq!(transcript[0].answer_text(), "The Earth goes round the Sun.");
    assert_eq!(
        transcript[0].reasoning_text().as_deref(),
        Some("an older thought about heliocentrism")
    );

    // 0002 backfills the index, so content written before the feature existed
    // is searchable afterwards.
    let hits = store.search_messages("heliocentrism", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].conversation_title, "Written by an older Vela");
    assert_eq!(hits[0].kind, vela_store::SearchHitKind::Reasoning);

    assert_eq!(store.search_messages("Earth", 10).unwrap().len(), 1);
}

/// The wave-i integration guard, on a real file.
///
/// Schedules (track 7) and memory (track 9) were developed on separate
/// branches and each shipped "the next migration" as `0003`. Schedules kept
/// version 3 and memory was renumbered to 4, which means the interesting
/// database is not a fresh one — it is one that a *pre-memory* build already
/// migrated and filled. That database must gain `memory_entries` without
/// losing its schedules and without its existing ledger rows being rewritten.
///
/// `migrations::tests::a_database_migrated_before_memory_landed_gains_it_without_disturbing_schedules`
/// makes the same argument in memory; this one makes it against a file that is
/// closed and reopened, with rows in it.
#[test]
fn a_database_from_before_the_memory_merge_gains_memory_and_keeps_its_schedules() {
    use vela_store::{
        Cadence, MemoryCategory, MemoryRepository, MemoryScope, NewMemoryEntry, ScheduleRepository,
    };

    const NOON: i64 = 1_700_000_000_000;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(vela_store::DATABASE_FILE_NAME);

    // Stand the database up at exactly the schema the pre-merge build shipped:
    // versions 1..=3, the last of which is `schedules`. These three entries are
    // byte-identical to that build's, so the checksums recorded here are the
    // ones it would have recorded.
    // The pre-merge `SqliteStore` does not exist in this tree, so the schedule
    // row goes in by hand — exactly as the older-build test above writes its
    // conversation. `open()` cannot be used here: it migrates on open, which is
    // the very thing under test.
    let pre_merge = &MIGRATIONS[..3];
    assert_eq!(pre_merge.last().unwrap().name, "schedules");
    let ledger_before = {
        let mut old = rusqlite::Connection::open(&path).unwrap();
        old.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let applied =
            vela_store::migrations::apply_list(&mut old, pre_merge, &FixedClock::default()).unwrap();
        assert_eq!(applied, vec![1, 2, 3]);

        old.execute(
            "INSERT INTO schedules
                 (id, title, prompt, cadence, next_run_at, created_at, updated_at)
             VALUES ('sched_old', 'weekly review', 'what happened this week?', 'weekly', ?1, 1, 1)",
            [NOON],
        )
        .unwrap();

        vela_store::migrations::applied(&old).unwrap()
    }; // quitting the pre-merge app

    let schedule_id = vela_store::ScheduleId::new("sched_old").unwrap();

    // The merged build opens the same file.
    let store = open(dir.path());
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(SCHEMA_VERSION, 4, "memory is the fourth migration");

    // The old feature is intact — the row, not just the table.
    let schedule = store.get_schedule(&schedule_id).unwrap();
    assert_eq!(schedule.title, "weekly review");
    assert_eq!(schedule.cadence, Cadence::Weekly);

    // The new feature works on this upgraded database, not only on a fresh one.
    let entry = store
        .create_memory_entry(NewMemoryEntry::new(
            MemoryScope::Global,
            MemoryCategory::TechPrefs,
            "prefers Rust",
        ))
        .unwrap();
    let listed = store.list_memory_entries(&MemoryScope::Global).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, entry.id);

    // The ledger gained exactly one row, and did not rewrite the three it had.
    let ledger_after = {
        let conn = rusqlite::Connection::open(&path).unwrap();
        vela_store::migrations::applied(&conn).unwrap()
    };
    assert_eq!(
        ledger_after.keys().copied().collect::<Vec<_>>(),
        vec![1, 2, 3, 4]
    );
    assert_eq!(ledger_after[&3].name, "schedules");
    assert_eq!(ledger_after[&4].name, "memory");
    for version in [1, 2, 3] {
        assert_eq!(
            ledger_after[&version], ledger_before[&version],
            "migration {version} was rewritten by the upgrade"
        );
    }
}

/// A schedule is only a schedule if it is still there after the app is closed.
/// The unit tests run in memory and cannot say this; this one writes a real
/// file, drops the connection, reopens it, and fires the schedule from the
/// reopened database.
#[test]
fn a_schedule_and_its_run_history_survive_a_restart_and_still_fire() {
    use vela_store::{
        Cadence, NewSchedule, ScheduleRepository, ScheduleRunOutcome, ScheduleRunStatus, Timestamp,
    };

    const NOON: i64 = 1_700_000_000_000;
    const HOUR: i64 = 60 * 60 * 1_000;
    let dir = tempfile::tempdir().unwrap();

    let schedule_id = {
        let store = open(dir.path());
        let schedule = store
            .create_schedule(NewSchedule::new(
                "daily standup notes",
                "summarise yesterday",
                Cadence::Daily,
                Timestamp::from_millis(NOON),
            ))
            .unwrap();

        // Fire it once and close the run, so there is history to survive too.
        let fired = vela_store::poll_once(&store, Timestamp::from_millis(NOON))
            .unwrap()
            .fired
            .remove(0);
        store
            .finish_schedule_run(
                &fired.run_id,
                Timestamp::from_millis(NOON + 2_000),
                ScheduleRunOutcome::Succeeded,
            )
            .unwrap();
        schedule.id
    }; // quitting the app

    let reopened = open(dir.path());
    let schedule = reopened.get_schedule(&schedule_id).unwrap();
    assert_eq!(schedule.title, "daily standup notes");
    assert_eq!(schedule.cadence, Cadence::Daily);
    assert_eq!(
        schedule.next_run_at,
        Timestamp::from_millis(NOON + 24 * HOUR),
        "the slot the first run moved it to has to be on disk, or a restart re-fires it"
    );

    let history = reopened.list_schedule_runs(&schedule_id, 10).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].status, ScheduleRunStatus::Success);
    assert_eq!(history[0].duration_ms, Some(2_000));
    let spawned = history[0].conversation_id.clone().expect("run has a chat");
    assert_eq!(
        reopened
            .list_messages(&spawned, MessageQuery::default())
            .unwrap()[0]
            .answer_text(),
        "summarise yesterday"
    );

    // And the reopened database still schedules: the next slot fires.
    let again = vela_store::poll_once(&reopened, Timestamp::from_millis(NOON + 24 * HOUR)).unwrap();
    assert_eq!(again.fired.len(), 1);
    assert_eq!(reopened.list_schedule_runs(&schedule_id, 10).unwrap().len(), 2);
}

#[test]
fn wal_leaves_its_sidecar_files_beside_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    store
        .create_conversation(NewConversation::titled("write something"))
        .unwrap();

    let db = dir.path().join(vela_store::DATABASE_FILE_NAME);
    let wal = dir
        .path()
        .join(format!("{}-wal", vela_store::DATABASE_FILE_NAME));
    assert!(db.is_file());
    assert!(
        wal.is_file(),
        "WAL journalling should produce a -wal sidecar while the connection is open"
    );
}
