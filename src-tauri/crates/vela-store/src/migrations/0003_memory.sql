-- Memory: durable, categorised facts the user has agreed Vela may keep.
--
-- FORWARD-ONLY, like every migration here. Once shipped this file is
-- checksummed and frozen; change the shape by adding 0004_*.sql.
--
-- ## Why the scope is two columns and not one string
--
-- `docs/vela-feature-spec.md` MEM-1 writes the scope as a single text column
-- holding either `global` or `project:<id>`. That spelling cannot carry a
-- foreign key, and a project-scoped entry whose project no longer exists is the
-- worst kind of row: the read path selects strictly by scope (MEM-2 — "no
-- cross-scope leakage in either direction"), so nothing would ever list it,
-- nothing could ever delete it, and it would sit in the database forever being
-- invisible. Splitting the discriminator from the id buys the FK, and the
-- CHECK below makes the two columns a real discriminated union rather than a
-- pair that can disagree: `global` has no project, `project` always has one.
--
-- ON DELETE CASCADE, deliberately, and it is the one place in this schema where
-- deleting a project destroys user data. Conversations are SET NULL because an
-- unfiled conversation is still readable; a memory entry has no unfiled state —
-- its whole identity is the scope it is read in. Vela's own answer to the
-- reference's all-or-nothing wipe is `clear_memory_scope`, which lets the user
-- empty one project's memory without touching the rest.
CREATE TABLE memory_entries (
    id          TEXT    PRIMARY KEY,
    -- 'global' | 'project'. The discriminant; `project_id` is its payload.
    scope_kind  TEXT    NOT NULL,
    project_id  TEXT    REFERENCES projects (id) ON DELETE CASCADE,
    category    TEXT    NOT NULL,
    content     TEXT    NOT NULL,
    -- Ranking, not decoration: MEM-1's injection order is pinned > recency,
    -- and the pin is the only part of it the user controls.
    pinned      INTEGER NOT NULL DEFAULT 0,
    -- Provenance. "Why do you know this?" is the question a server-side memory
    -- cannot answer; SET NULL rather than CASCADE because deleting the
    -- conversation a fact came from does not make the fact untrue.
    source_conversation_id TEXT REFERENCES conversations (id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    CHECK (scope_kind IN ('global', 'project')),
    CHECK ((scope_kind = 'global') = (project_id IS NULL)),
    CHECK (category IN ('roleContext', 'commsPrefs', 'techPrefs', 'projectDetails', 'other')),
    CHECK (length(trim(content)) > 0),
    CHECK (pinned IN (0, 1))
) STRICT;

-- The read path's only query: everything in one scope, pinned first, newest
-- first. `project_id` is nullable and SQLite indexes NULLs, so one index serves
-- both the global scope and every project scope.
CREATE INDEX idx_memory_scope ON memory_entries (
    scope_kind, project_id, pinned DESC, updated_at DESC
);
