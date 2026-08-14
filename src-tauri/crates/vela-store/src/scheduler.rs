//! One poll of the schedule table, and what a due schedule does when it fires.
//!
//! # How time is made testable, which is the whole design of this module
//!
//! [`poll_once`] takes the instant to evaluate as an **argument**. It does not
//! read a clock, does not sleep, and holds no timer. "Is this schedule due?" is
//! therefore a pure question about a database and a number, and a test proves
//! that an hourly schedule fires an hour later by passing an instant an hour
//! later — in microseconds, with no fake timers and no waiting.
//!
//! The alternative — a module that owned a `SystemClock` and a sleep loop —
//! would have made the interesting behaviour (due, not due, missed a week,
//! already running) reachable only by waiting for it, which in practice means it
//! is never tested at all. The loop still has to exist, and it does: it lives in
//! the host, at `src-tauri/src/scheduler_host.rs`, and it is four lines that
//! sleep and call this function. Everything that could be wrong is on this side
//! of that seam.
//!
//! [`crate::Clock`] is still injected into the store for `created_at` stamps.
//! This module deliberately does not reach for it: the instant a poll evaluates
//! and the instant a row was written are different facts, and reading one from
//! the other is how a test ends up unable to control either.
//!
//! # What firing actually does
//!
//! Firing a schedule **spawns a conversation** and **records a run**. It does
//! not send anything to a model: driving a model turn is the renderer's job (see
//! the run loop in `src/platform/contract-harness.ts`), and this crate has no
//! network, no provider and no opinion about either. So a fired run is left
//! `running` with its conversation attached, holding the user's prompt as its
//! first message — which is exactly the state the reference's own scheduler
//! leaves a run in between opening it and closing it, and exactly the state a
//! UI needs in order to open a run that is still in flight.
//!
//! **Nothing in this repository closes that run yet.** `finish_schedule_run`
//! exists, is tested, and has no caller outside tests; the component that would
//! call it is the agent loop, which is a contract and not yet an implementation.
//! Saying so here is the point — a comment claiming this module completes a run
//! would be the defect this project keeps finding in itself.

use crate::error::StoreResult;
use crate::model::{
    ConversationId, NewConversation, NewMessage, RunTrigger, Schedule, ScheduleId, SchedulePatch,
    ScheduleRunId, Timestamp,
};
use crate::repository::VelaStore;

/// One schedule that fired, and what it produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FiredRun {
    pub schedule_id: ScheduleId,
    pub run_id: ScheduleRunId,
    /// The conversation the run spawned, already holding the schedule's prompt
    /// as its first user message.
    pub conversation_id: ConversationId,
    /// Slots this schedule skipped to catch up. Zero in the ordinary case; see
    /// [`crate::Cadence::advance`].
    pub missed_slots: u32,
}

/// What one poll did. Empty `fired` is the normal answer — most polls find
/// nothing due, which is why this is cheap enough to run every half minute.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PollReport {
    pub fired: Vec<FiredRun>,
}

impl PollReport {
    pub fn is_empty(&self) -> bool {
        self.fired.is_empty()
    }
}

/// Fire every schedule owed a run at `now`.
///
/// The order per schedule is fixed and each step is why the next one is safe:
///
/// 1. **Spawn the conversation** and append the prompt, so a run always points
///    at something a user can open.
/// 2. **Open the run row**, `running`, started at `now`.
/// 3. **Attach the conversation** to the run.
/// 4. **Move the schedule on** — `next_run_at` to the first slot after `now`,
///    `missed_runs` incremented by whatever was skipped, and `enabled` cleared
///    for a `once` schedule, which has no next slot.
///
/// Step 4 is what stops the next poll re-firing the same slot. It runs last on
/// purpose: a crash between steps 3 and 4 re-fires one slot, which is a
/// duplicate conversation the user can delete, whereas a crash between an
/// early step 4 and step 1 loses the run with no trace that it was owed.
///
/// Schedules that are disabled, not yet due, or already have a run in flight
/// are not returned by [`ScheduleRepository::due_schedules`] and so are not
/// touched here — the overlap guard lives in that query, not in this loop.
pub fn poll_once(store: &dyn VelaStore, now: Timestamp) -> StoreResult<PollReport> {
    let due = store.due_schedules(now)?;
    let mut fired = Vec::with_capacity(due.len());
    for schedule in due {
        fired.push(fire(store, &schedule, RunTrigger::Schedule, now)?);
    }
    Ok(PollReport { fired })
}

/// Run one schedule immediately, whatever its `next_run_at` says.
///
/// **`next_run_at` is not moved.** A person pressing "run now" is asking for an
/// extra run, not for the schedule's next slot to be pushed a day into the
/// future — which is why [`RunTrigger`] is a discriminated value rather than a
/// boolean "is manual" flag that a caller could forget to read.
///
/// The overlap guard still applies and is checked here rather than borrowed
/// from the due query, because a manual run is due by definition: if a run is
/// already in flight this answers `Ok(None)` instead of stacking a second one.
pub fn run_now(
    store: &dyn VelaStore,
    schedule_id: &ScheduleId,
    now: Timestamp,
) -> StoreResult<Option<FiredRun>> {
    let schedule = store.get_schedule(schedule_id)?;
    let in_flight = store
        .list_schedule_runs(schedule_id, RUNNING_PROBE_LIMIT)?
        .iter()
        .any(|run| run.is_running());
    if in_flight {
        return Ok(None);
    }
    Ok(Some(fire(store, &schedule, RunTrigger::Manual, now)?))
}

/// How far back [`run_now`] looks for a run still in flight.
///
/// A limit rather than a count query because `list_schedule_runs` is ordered
/// newest-first and a run that is still `running` is, by construction, among the
/// most recent: the poll opens one and never opens another for the same
/// schedule until it closes. Sixteen is slack for a history written by a
/// process that died repeatedly.
const RUNNING_PROBE_LIMIT: u32 = 16;

fn fire(
    store: &dyn VelaStore,
    schedule: &Schedule,
    trigger: RunTrigger,
    now: Timestamp,
) -> StoreResult<FiredRun> {
    let mut new_conversation = NewConversation::titled(schedule.title.clone());
    if let Some(project_id) = &schedule.project_id {
        new_conversation = new_conversation.in_project(project_id.clone());
    }
    if let (Some(provider_id), Some(model_id)) = (&schedule.provider_id, &schedule.model_id) {
        new_conversation = new_conversation.with_model(provider_id.clone(), model_id.clone());
    }
    let conversation = store.create_conversation(new_conversation)?;
    store.append_message(NewMessage::user(
        conversation.id.clone(),
        schedule.prompt.clone(),
    ))?;

    let run = store.begin_schedule_run(&schedule.id, trigger, now)?;
    store.attach_run_conversation(&run.id, &conversation.id)?;

    let missed_slots = match trigger {
        RunTrigger::Manual => 0,
        RunTrigger::Schedule => {
            let advance = schedule.cadence.advance(schedule.next_run_at, now);
            let patch = match advance.next_run_at {
                Some(next_run_at) => SchedulePatch {
                    next_run_at: Some(next_run_at),
                    missed_runs: Some(schedule.missed_runs.saturating_add(advance.missed_slots)),
                    ..SchedulePatch::default()
                },
                // No next slot: a `once` schedule has done the only thing it
                // was for. Disabled rather than deleted, so its run history
                // survives and the user can see what it did.
                None => SchedulePatch {
                    enabled: Some(false),
                    ..SchedulePatch::default()
                },
            };
            store.update_schedule(&schedule.id, patch)?;
            advance.missed_slots
        }
    };

    Ok(FiredRun {
        schedule_id: schedule.id.clone(),
        run_id: run.id,
        conversation_id: conversation.id,
        missed_slots,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        Cadence, MessageStatus, NewSchedule, ScheduleRunOutcome, ScheduleRunStatus,
    };
    use crate::repository::{
        ConversationRepository, MessageQuery, MessageRepository, ProjectRepository,
        ScheduleRepository,
    };
    use crate::sqlite::SqliteStore;

    const HOUR: i64 = 60 * 60 * 1_000;
    const DAY: i64 = 24 * HOUR;
    const NOON: i64 = 1_700_000_000_000;

    fn at(millis: i64) -> Timestamp {
        Timestamp::from_millis(millis)
    }

    fn store() -> SqliteStore {
        SqliteStore::in_memory().unwrap()
    }

    fn schedule(store: &SqliteStore, title: &str, cadence: Cadence, first: i64) -> ScheduleId {
        store
            .create_schedule(NewSchedule::new(
                title,
                format!("{title}: what happened?"),
                cadence,
                at(first),
            ))
            .unwrap()
            .id
    }

    /// **The headline claim of this module**: a schedule whose slot has arrived
    /// fires, one whose slot has not does not, and neither of them needed an
    /// hour of wall clock to prove it.
    #[test]
    fn a_due_schedule_fires_and_a_not_due_one_does_not() {
        let store = store();
        let due = schedule(&store, "morning briefing", Cadence::Hourly, NOON - 1);
        let later = schedule(&store, "evening wrap", Cadence::Hourly, NOON + HOUR);

        let report = poll_once(&store, at(NOON)).unwrap();

        assert_eq!(report.fired.len(), 1, "exactly one schedule was owed a run");
        let fired = &report.fired[0];
        assert_eq!(fired.schedule_id, due);
        assert_eq!(fired.missed_slots, 0);

        // The run really exists, really says `running`, and really points at a
        // conversation.
        let runs = store.list_schedule_runs(&due, 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, ScheduleRunStatus::Running);
        assert_eq!(runs[0].trigger, RunTrigger::Schedule);
        assert_eq!(runs[0].started_at, at(NOON));
        assert_eq!(runs[0].conversation_id.as_ref(), Some(&fired.conversation_id));

        // The conversation really exists and really holds the prompt.
        let spawned = store.get_conversation(&fired.conversation_id).unwrap();
        assert_eq!(spawned.title, "morning briefing");
        let transcript = store
            .list_messages(&fired.conversation_id, MessageQuery::default())
            .unwrap();
        assert_eq!(transcript.len(), 1);
        assert_eq!(transcript[0].answer_text(), "morning briefing: what happened?");
        assert_eq!(transcript[0].status, MessageStatus::Complete);

        // And the one that was not due was not touched at all.
        assert!(store.list_schedule_runs(&later, 10).unwrap().is_empty());
        assert_eq!(
            store.get_schedule(&later).unwrap().next_run_at,
            at(NOON + HOUR),
            "a schedule that did not fire must not be moved"
        );
    }

    #[test]
    fn firing_moves_the_schedule_to_the_next_slot_so_the_next_poll_finds_nothing() {
        let store = store();
        let id = schedule(&store, "hourly", Cadence::Hourly, NOON);

        assert_eq!(poll_once(&store, at(NOON)).unwrap().fired.len(), 1);
        assert_eq!(
            store.get_schedule(&id).unwrap().next_run_at,
            at(NOON + HOUR)
        );

        // Immediately polling again finds nothing — but only because the run is
        // still in flight *and* the slot moved. Close the run to prove the slot
        // is doing the work.
        let run = store.list_schedule_runs(&id, 1).unwrap().remove(0);
        store
            .finish_schedule_run(&run.id, at(NOON + 1_000), ScheduleRunOutcome::Succeeded)
            .unwrap();

        assert!(poll_once(&store, at(NOON + 1_000)).unwrap().is_empty());
        assert_eq!(poll_once(&store, at(NOON + HOUR)).unwrap().fired.len(), 1);
    }

    #[test]
    fn a_disabled_schedule_is_never_due() {
        let store = store();
        let id = schedule(&store, "paused", Cadence::Daily, NOON - DAY);
        store
            .update_schedule(
                &id,
                SchedulePatch {
                    enabled: Some(false),
                    ..SchedulePatch::default()
                },
            )
            .unwrap();

        assert!(poll_once(&store, at(NOON)).unwrap().is_empty());
        assert!(store.list_schedule_runs(&id, 10).unwrap().is_empty());
    }

    #[test]
    fn a_schedule_whose_previous_run_is_still_in_flight_is_not_fired_again() {
        let store = store();
        let id = schedule(&store, "slow model", Cadence::Hourly, NOON);
        assert_eq!(poll_once(&store, at(NOON)).unwrap().fired.len(), 1);

        // Two hours later the slot is due again, but the first run never
        // finished. Firing would stack a second conversation on a model that is
        // evidently still busy.
        assert!(
            poll_once(&store, at(NOON + 2 * HOUR)).unwrap().is_empty(),
            "an in-flight run blocks the next one"
        );

        let run = store.list_schedule_runs(&id, 1).unwrap().remove(0);
        store
            .finish_schedule_run(&run.id, at(NOON + 2 * HOUR), ScheduleRunOutcome::Succeeded)
            .unwrap();
        assert_eq!(
            poll_once(&store, at(NOON + 2 * HOUR)).unwrap().fired.len(),
            1,
            "once it closes, the schedule is due again"
        );
    }

    #[test]
    fn a_once_schedule_fires_exactly_once_and_disables_itself() {
        let store = store();
        let id = schedule(&store, "one-off audit", Cadence::Once, NOON);

        assert_eq!(poll_once(&store, at(NOON)).unwrap().fired.len(), 1);
        let after = store.get_schedule(&id).unwrap();
        assert!(!after.enabled, "a `once` schedule has no second slot");
        assert_eq!(
            after.next_run_at,
            at(NOON),
            "the slot it fired stays on the row as the record of when it ran"
        );

        let run = store.list_schedule_runs(&id, 1).unwrap().remove(0);
        store
            .finish_schedule_run(&run.id, at(NOON + 1), ScheduleRunOutcome::Succeeded)
            .unwrap();
        assert!(poll_once(&store, at(NOON + 10 * DAY)).unwrap().is_empty());
    }

    #[test]
    fn a_day_asleep_fires_one_run_and_counts_the_slots_it_skipped() {
        let store = store();
        let id = schedule(&store, "hourly digest", Cadence::Hourly, NOON);

        // The laptop was shut for a day. Twenty-five slots came due: the one at
        // NOON, and one on every hour up to and including the moment it woke.
        let woke = NOON + DAY;
        let report = poll_once(&store, at(woke)).unwrap();

        assert_eq!(report.fired.len(), 1, "one run, not twenty-five");
        assert_eq!(report.fired[0].missed_slots, 24);

        let after = store.get_schedule(&id).unwrap();
        assert_eq!(after.missed_runs, 24);
        assert_eq!(
            after.next_run_at,
            at(woke + HOUR),
            "the next slot is the first one strictly after now"
        );
    }

    #[test]
    fn a_manual_run_does_not_move_the_schedule() {
        let store = store();
        let id = schedule(&store, "on demand", Cadence::Daily, NOON + DAY);

        let fired = run_now(&store, &id, at(NOON)).unwrap().expect("ran");
        assert_eq!(fired.missed_slots, 0);
        assert_eq!(
            store.get_schedule(&id).unwrap().next_run_at,
            at(NOON + DAY),
            "pressing `run now` must not push the next scheduled slot"
        );

        let runs = store.list_schedule_runs(&id, 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].trigger, RunTrigger::Manual);

        // And the guard: a second manual run while the first is in flight is
        // refused rather than stacked.
        assert!(run_now(&store, &id, at(NOON + 1)).unwrap().is_none());
    }

    #[test]
    fn a_finished_run_records_how_long_it_took_and_what_went_wrong() {
        let store = store();
        let id = schedule(&store, "flaky", Cadence::Daily, NOON);
        poll_once(&store, at(NOON)).unwrap();
        let run = store.list_schedule_runs(&id, 1).unwrap().remove(0);

        let finished = store
            .finish_schedule_run(
                &run.id,
                at(NOON + 4_500),
                ScheduleRunOutcome::Failed {
                    error: "the endpoint refused the request".into(),
                },
            )
            .unwrap();

        assert_eq!(finished.status, ScheduleRunStatus::Failed);
        assert_eq!(finished.duration_ms, Some(4_500));
        assert_eq!(
            finished.error.as_deref(),
            Some("the endpoint refused the request")
        );

        // A second close is refused: it would overwrite the outcome.
        assert!(store
            .finish_schedule_run(&run.id, at(NOON + 9_000), ScheduleRunOutcome::Succeeded)
            .is_err());
    }

    #[test]
    fn runs_left_behind_by_a_restart_are_reaped_so_the_schedule_is_not_wedged() {
        let store = store();
        let id = schedule(&store, "interrupted", Cadence::Hourly, NOON);
        poll_once(&store, at(NOON)).unwrap();

        // Vela died here. The run row still says `running`, which is exactly
        // what blocks the next poll.
        assert!(poll_once(&store, at(NOON + 5 * HOUR)).unwrap().is_empty());

        let reaped = store.reap_orphaned_runs(at(NOON + 5 * HOUR)).unwrap();
        assert_eq!(reaped, 1);
        let run = store.list_schedule_runs(&id, 1).unwrap().remove(0);
        assert_eq!(run.status, ScheduleRunStatus::Failed);
        assert_eq!(run.finished_at, Some(at(NOON + 5 * HOUR)));
        assert!(run.error.is_some(), "a reaped run says why it has no result");

        assert_eq!(
            poll_once(&store, at(NOON + 5 * HOUR)).unwrap().fired.len(),
            1,
            "reaping unwedges the schedule"
        );
    }

    #[test]
    fn several_due_schedules_all_fire_in_soonest_first_order() {
        let store = store();
        let late = schedule(&store, "late", Cadence::Daily, NOON - HOUR);
        let early = schedule(&store, "early", Cadence::Daily, NOON - DAY);

        let report = poll_once(&store, at(NOON)).unwrap();
        let order: Vec<_> = report.fired.iter().map(|f| f.schedule_id.clone()).collect();
        assert_eq!(order, vec![early, late]);
    }

    #[test]
    fn a_schedule_carries_its_project_and_model_onto_the_conversation_it_spawns() {
        let store = store();
        let project = store
            .create_project(crate::model::NewProject::named("Ops"))
            .unwrap();
        let id = store
            .create_schedule(
                NewSchedule::new("filed", "check the logs", Cadence::Daily, at(NOON))
                    .in_project(project.id.clone())
                    .with_model("local-llamacpp", "qwen3-8b"),
            )
            .unwrap()
            .id;

        let fired = poll_once(&store, at(NOON)).unwrap().fired.remove(0);
        assert_eq!(fired.schedule_id, id);
        let spawned = store.get_conversation(&fired.conversation_id).unwrap();
        assert_eq!(spawned.project_id, Some(project.id));
        assert_eq!(spawned.provider_id.as_deref(), Some("local-llamacpp"));
        assert_eq!(spawned.model_id.as_deref(), Some("qwen3-8b"));
    }
}
