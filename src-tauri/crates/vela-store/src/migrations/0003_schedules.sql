-- Scheduled work, and the history of what it did.
--
-- FORWARD-ONLY. Once this file has shipped it is frozen: it is checksummed and
-- recorded in `schema_migrations`, and editing it makes every existing database
-- refuse to open. Change the schema by adding 000N_*.sql, never by editing this.
--
-- ## Why a `next_run_at` column instead of a cron expression
--
-- The due check is `enabled = 1 AND next_run_at <= :now`, which is an index
-- range scan. A cron expression would have to be parsed and evaluated for every
-- row on every poll, and the poll runs forever in the background of a desktop
-- app. Storing the answer instead of the question also means the *scheduler*
-- owns catch-up: after the machine has been asleep, the row says exactly which
-- slot was owed, and advancing past the ones that were missed is one UPDATE.
--
-- ## What is deliberately not here
--
--   * **No `timezone` column.** Cadences advance by a fixed number of
--     milliseconds (see `Cadence::advance`), so `daily` is exactly 24h and not
--     "09:00 local, whatever the clocks did overnight". A timezone column
--     nothing honoured would be a claim the code does not keep, which is the
--     defect this repo keeps finding in itself. When wall-clock cadences are
--     built, they arrive with a column and a migration together.
--   * **No `last_error` on `schedules`.** The run row already holds the error.
--     Two copies of one fact are two facts that can disagree, and the one that
--     can go stale is the summary. Ask `schedule_runs`.
--   * **No credential column of any kind.** `provider_id` and `model_id` are
--     the same transported identifiers `messages` already stores; the key they
--     imply lives in the OS keychain and is read only by the Rust core.

CREATE TABLE schedules (
    id           TEXT    PRIMARY KEY,
    -- The user's own words. Becomes the spawned conversation's title.
    title        TEXT    NOT NULL,
    -- What gets sent, verbatim, as the first user message of each run.
    prompt       TEXT    NOT NULL,
    cadence      TEXT    NOT NULL,
    -- The instant this schedule is next owed a run, in epoch milliseconds. The
    -- whole due check is a comparison against this column.
    next_run_at  INTEGER NOT NULL,
    -- Disabling is how a user stops a schedule without losing its history; a
    -- `once` schedule disables itself after it has fired.
    enabled      INTEGER NOT NULL DEFAULT 1,
    -- ON DELETE SET NULL, matching `conversations`: deleting a project must
    -- never destroy the user's schedules. They become unfiled.
    project_id   TEXT    REFERENCES projects (id) ON DELETE SET NULL,
    -- Advisory, exactly as on `conversations`: which endpoint and model the
    -- spawned conversation should open against. NULL means "whatever the app
    -- would have used anyway".
    provider_id  TEXT,
    model_id     TEXT,
    -- Slots that came due while nothing was polling — the machine was asleep,
    -- or Vela was closed. Counted rather than fired: waking up to eleven
    -- identical conversations is worse than waking up to one and a number.
    missed_runs  INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    CHECK (cadence IN ('once', 'hourly', 'daily', 'weekly')),
    CHECK (enabled IN (0, 1)),
    CHECK (length(trim(title)) > 0),
    CHECK (length(trim(prompt)) > 0),
    CHECK (missed_runs >= 0)
) STRICT;

-- The poll's only query. Partial on `enabled` because a disabled schedule is
-- never a candidate and there is no reason to keep it in the index.
CREATE INDEX idx_schedules_due ON schedules (next_run_at) WHERE enabled = 1;

-- One row per attempt, including the attempt that is happening right now.
--
-- A run is inserted `running` *before* its conversation exists, then the
-- conversation is attached: that ordering is what lets a UI open a run that is
-- still in flight instead of waiting for it to finish.
CREATE TABLE schedule_runs (
    id              TEXT    PRIMARY KEY,
    schedule_id     TEXT    NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
    status          TEXT    NOT NULL,
    -- Whether the poll started this or a person did. A manual run does not
    -- move `next_run_at`, so the two must be distinguishable forever.
    trigger         TEXT    NOT NULL,
    started_at      INTEGER NOT NULL,
    finished_at     INTEGER,
    duration_ms     INTEGER,
    -- ON DELETE SET NULL: deleting the conversation leaves the run's own record
    -- of what happened, which is the point of having a runs table at all.
    conversation_id TEXT    REFERENCES conversations (id) ON DELETE SET NULL,
    error           TEXT,
    CHECK (status IN ('running', 'success', 'failed')),
    CHECK (trigger IN ('schedule', 'manual')),
    CHECK (duration_ms IS NULL OR duration_ms >= 0),
    -- A finished run has an end; a running one does not. Enforced here because
    -- a row that says `running` with a `finished_at` is unreadable, and the
    -- orphan reaper depends on `running` meaning exactly one thing.
    CHECK (status <> 'running' OR (finished_at IS NULL AND duration_ms IS NULL)),
    CHECK (status =  'running' OR (finished_at IS NOT NULL AND duration_ms IS NOT NULL)),
    -- An error belongs to a failure. A `success` carrying one would be a run
    -- the UI draws green over a message saying what went wrong.
    CHECK (error IS NULL OR status = 'failed')
) STRICT;

-- "Show me this schedule's history, newest first."
CREATE INDEX idx_schedule_runs_history ON schedule_runs (schedule_id, started_at DESC);
-- The overlap guard: does this schedule already have something in flight?
CREATE INDEX idx_schedule_runs_running ON schedule_runs (schedule_id) WHERE status = 'running';
