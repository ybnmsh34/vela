-- Projects gain the two columns the project contract needs, and the default
-- project is seeded.
--
-- FORWARD-ONLY, and frozen once shipped. See migrations.rs.
--
-- ## Why the seed is here and not in 0001
--
-- `src/platform/contract-project.ts` says the row is created by "the store
-- migration that introduces the projects table, in the same transaction, before
-- any other row can reference it", and gives the reason: a lazily created
-- fallback target can be created twice by two racing readers, and the loser's
-- conversations end up attached to a project the UI never lists.
--
-- 0001 shipped without the row and is checksummed, so it cannot be edited. What
-- transfers is the part of the rule that was load-bearing — a migration creates
-- it, inside a transaction, before anything can read a database that lacks it —
-- and that is what this file does. AMENDMENT 4 in the contract records the
-- departure.
--
-- ## Why "no project" is not a state
--
-- The alternative to a sentinel row is a nullable project id on every
-- conversation, which makes "in a project" and "loose" two code paths at every
-- call site that reads one. They drift, and the loose path is the one nobody
-- writes a test for. `conversations.project_id` is still nullable in the schema
-- 0001 froze; what this row buys is that there is always somewhere to put a
-- conversation, which is what makes `project_delete`'s reassignment rule
-- possible at all.

-- The stored working-directory binding. NULL is "this project has no working
-- directory", which is an ordinary complete state and not an error. It is a
-- *binding*, not a checked path: it may name a directory that has been deleted,
-- renamed, or is on a drive that is not plugged in, and reading it back is
-- `vela_projects::resolve_working_directory`'s job, not this column's.
ALTER TABLE projects ADD COLUMN working_directory TEXT;

-- The skills the user enabled, as a JSON array of single path segments, in the
-- order they mount. Intent, not reality: what is actually on disk is the mount
-- list, and the two can differ. Order is preserved because it decides which of
-- two names that fold to one directory wins.
--
-- A JSON array in one column rather than a join table: the whole value is
-- replaced on every write (the contract's update semantics), it is never queried
-- across projects, and a join table would buy indexing nobody needs at the price
-- of a second write path.
ALTER TABLE projects ADD COLUMN enabled_skills TEXT NOT NULL DEFAULT '[]';

-- The one project that always exists. Its id is fixed rather than generated so
-- that the seed, the host and the browser fake all name the same row; the
-- literal is version-4 shaped (the `4` and the `8` variant nibble) so it
-- survives a strict UUID parser.
--
-- `WHERE NOT EXISTS` because a user who already made a project with this exact
-- id would otherwise fail the migration and be unable to open their database.
INSERT INTO projects (id, name, created_at, updated_at, enabled_skills)
SELECT
    '00000000-0000-4000-8000-000000000001',
    'General',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    '[]'
WHERE NOT EXISTS (
    SELECT 1 FROM projects WHERE id = '00000000-0000-4000-8000-000000000001'
);
