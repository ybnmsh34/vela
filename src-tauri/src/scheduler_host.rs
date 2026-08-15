//! The scheduler's clock: the only part of scheduling that has to wait.
//!
//! Everything a schedule *does* — is it due, what does firing spawn, where does
//! it move to next — lives in `vela_store::scheduler` and takes the instant as
//! an argument, so it is tested in microseconds. What is left here is a thread
//! that sleeps and calls it, plus the one-shot repair a restart owes the
//! database. That split is the point: this file has nothing in it that could be
//! wrong in an interesting way, because everything interesting is on the other
//! side of [`vela_store::poll_once`].
//!
//! ## Why a thread and not a Tauri async task
//!
//! `vela-store` is synchronous — its own module header says a SQLite write has
//! no I/O wait to hide — so a poll is a handful of blocking queries. Running
//! them on an async executor would block that executor for exactly as long, and
//! buy nothing. A dedicated thread that is asleep 99.99% of the time is the
//! cheaper and more honest shape.
//!
//! ## What this does not do
//!
//! It does not finish a run. Firing spawns a conversation, records a `running`
//! run and moves the schedule on; sending that conversation to a model is the
//! renderer's job and the component that would do it does not exist yet. A run
//! this thread starts therefore stays `running` until something closes it or a
//! restart reaps it. That is written here rather than left to be discovered.

use std::sync::Arc;
use std::time::Duration;

use vela_store::{Clock, SystemClock, VelaStore};

/// How often the poll wakes up.
///
/// **A convention, not a measurement.** It is short enough that an `hourly`
/// schedule fires within a minute of its slot and long enough that the cost is
/// invisible — a poll of an empty schedule table is one indexed range scan. The
/// reference is described as polling every thirty seconds, but the study could
/// not find the loop's source and marked its cadence UNVERIFIED, so this number
/// is Vela's own choice rather than a copied one.
pub const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Repairs runs that a previous process left in flight, and answers how many.
///
/// **Must run before the first poll.** A run row still marked `running` is what
/// `due_schedules` reads as "still working", so a crash mid-run wedges that
/// schedule forever: it is never due again, and the user sees a run that never
/// ends. Called from the composition root's `setup`, once, on the way up.
pub fn reap_on_boot(store: &dyn VelaStore) -> u32 {
    match store.reap_orphaned_runs(SystemClock.now()) {
        Ok(reaped) => reaped,
        Err(error) => {
            // Not fatal. A database that cannot be written to has bigger
            // problems than a stale run row, and refusing to start over this
            // would take the whole app down for a repair it could retry later.
            eprintln!("vela: could not reap interrupted schedule runs: {error}");
            0
        }
    }
}

/// Starts the poll loop on its own thread.
///
/// **It sleeps first.** Firing the instant the window opens would mean a
/// schedule that came due while the machine was off produces a conversation
/// before the user has finished looking at the app starting; it also keeps this
/// thread out of the way of everything else `setup` is doing. The first poll is
/// therefore one interval in.
///
/// The thread is detached and runs for the life of the process. There is no
/// stop handle because there is nothing that would use one: the loop holds only
/// a store reference, and quitting the app drops the process.
pub fn spawn(store: Arc<dyn VelaStore>) {
    std::thread::Builder::new()
        .name("vela-scheduler".into())
        .spawn(move || loop {
            std::thread::sleep(POLL_INTERVAL);
            if let Err(error) = vela_store::poll_once(store.as_ref(), SystemClock.now()) {
                // One bad poll must not end scheduling. The next tick tries
                // again; a genuinely broken database will say so on every line.
                eprintln!("vela: schedule poll failed: {error}");
            }
        })
        // A machine that cannot spawn a thread cannot run a desktop app either,
        // but that is not this function's call to make: scheduling is a feature,
        // and losing it is worth a line on stderr rather than a dead window.
        .map(|_| ())
        .unwrap_or_else(|error| eprintln!("vela: could not start the scheduler: {error}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_store::{
        Cadence, DatabaseLocation, NewSchedule, ScheduleRunStatus, SqliteStore, Timestamp,
    };

    fn store() -> Arc<dyn VelaStore> {
        Arc::new(SqliteStore::open(DatabaseLocation::InMemory).unwrap())
    }

    /// The boot repair, end to end: a run left `running` by a dead process
    /// blocks its schedule, and reaping is what unblocks it. Uses the real
    /// system clock, because that is what `reap_on_boot` uses — the assertion
    /// is about the *state transition*, not about the instant.
    #[test]
    fn boot_reaping_unwedges_a_schedule_whose_run_never_finished() {
        let store = store();
        let schedule = store
            .create_schedule(NewSchedule::new(
                "interrupted",
                "carry on",
                Cadence::Hourly,
                Timestamp::from_millis(0),
            ))
            .unwrap();

        // A previous process fired it and died.
        let fired = vela_store::poll_once(store.as_ref(), Timestamp::from_millis(0))
            .unwrap()
            .fired
            .remove(0);
        assert_eq!(fired.schedule_id, schedule.id);
        assert!(
            vela_store::poll_once(store.as_ref(), Timestamp::from_millis(10_000_000))
                .unwrap()
                .is_empty(),
            "the orphaned run blocks the schedule, which is what makes reaping necessary"
        );

        assert_eq!(reap_on_boot(store.as_ref()), 1);

        let history = store.list_schedule_runs(&schedule.id, 10).unwrap();
        assert_eq!(history[0].status, ScheduleRunStatus::Failed);
        assert_eq!(
            vela_store::poll_once(store.as_ref(), Timestamp::from_millis(10_000_000))
                .unwrap()
                .fired
                .len(),
            1,
            "after reaping, the schedule is due again"
        );
    }

    #[test]
    fn reaping_a_database_with_nothing_in_flight_changes_nothing() {
        assert_eq!(reap_on_boot(store().as_ref()), 0);
    }

    /// The poll thread must not fire on the way up: `setup` runs it, and a
    /// schedule that came due while the machine was off would otherwise open a
    /// conversation before the window is drawn.
    #[test]
    fn the_poll_thread_sleeps_before_its_first_poll() {
        let store = store();
        store
            .create_schedule(NewSchedule::new(
                "due right now",
                "go",
                Cadence::Hourly,
                Timestamp::from_millis(0),
            ))
            .unwrap();

        spawn(Arc::clone(&store));
        // Far shorter than POLL_INTERVAL, so this asserts the ordering rather
        // than racing it.
        std::thread::sleep(Duration::from_millis(50));

        let schedules = store.list_schedules(true).unwrap();
        assert!(
            store
                .list_schedule_runs(&schedules[0].id, 10)
                .unwrap()
                .is_empty(),
            "the first poll is one interval in, not at startup"
        );
        assert!(POLL_INTERVAL >= Duration::from_secs(5));
    }
}
