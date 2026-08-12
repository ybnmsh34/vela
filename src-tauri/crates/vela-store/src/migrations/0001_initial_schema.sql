-- Vela initial schema.
--
-- FORWARD-ONLY. Once this file has shipped it is frozen: it is checksummed and
-- recorded in `schema_migrations`, and editing it makes every existing database
-- refuse to open. Change the schema by adding 000N_*.sql, never by editing this.
--
-- All tables are STRICT: SQLite's default type affinity would happily store the
-- string "seven" in an INTEGER column, and a system of record cannot afford
-- that. Timestamps are INTEGER milliseconds since the Unix epoch, UTC.

CREATE TABLE projects (
    id            TEXT    PRIMARY KEY,
    name          TEXT    NOT NULL,
    description   TEXT,
    -- Instructions applied to every conversation filed under this project.
    system_prompt TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    archived_at   INTEGER,
    CHECK (length(trim(name)) > 0)
) STRICT;

CREATE INDEX idx_projects_name ON projects (name);

CREATE TABLE conversations (
    id              TEXT    PRIMARY KEY,
    -- ON DELETE SET NULL: deleting a project must never destroy the user's
    -- conversations. They become unfiled, which is a recoverable state.
    project_id      TEXT    REFERENCES projects (id) ON DELETE SET NULL,
    title           TEXT    NOT NULL,
    -- Advisory "last used here". The authoritative record of what produced a
    -- turn lives on the message, because switching model mid-conversation is
    -- a normal thing to do in a model-agnostic client.
    provider_id     TEXT,
    model_id        TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    last_message_at INTEGER,
    archived_at     INTEGER
) STRICT;

-- The sidebar's query: most recently touched first, optionally within a project.
CREATE INDEX idx_conversations_recent ON conversations (updated_at DESC);
CREATE INDEX idx_conversations_project ON conversations (project_id, updated_at DESC);

CREATE TABLE messages (
    id                  TEXT    PRIMARY KEY,
    conversation_id     TEXT    NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    -- Gapless position within the conversation, assigned by the store.
    seq                 INTEGER NOT NULL,
    role                TEXT    NOT NULL,
    -- A streaming turn is persisted before it finishes, so a crash mid-answer
    -- loses only the tail rather than the whole exchange.
    status              TEXT    NOT NULL,
    provider_id         TEXT,
    model_id            TEXT,
    stop_reason         TEXT,
    -- NULL means "the endpoint did not report it". Never write 0 for unknown:
    -- a zero is a claim, an absence is the truth.
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    reasoning_tokens    INTEGER,
    cached_input_tokens INTEGER,
    error_message       TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    UNIQUE (conversation_id, seq),
    CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    CHECK (status IN ('streaming', 'complete', 'cancelled', 'failed')),
    CHECK (seq >= 0),
    CHECK (input_tokens IS NULL OR input_tokens >= 0),
    CHECK (output_tokens IS NULL OR output_tokens >= 0),
    CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
    CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0)
) STRICT;

CREATE INDEX idx_messages_conversation ON messages (conversation_id, seq);
CREATE INDEX idx_messages_created ON messages (created_at DESC);

-- One row per content part. A message is an ordered list of parts, not a
-- string: an assistant turn routinely contains reasoning, a tool call, a tool
-- result and prose, and each of those must be addressable on its own.
--
-- `reasoning` is a first-class kind. Models that emit <think> blocks must have
-- them stored and retrievable *separately* from the final answer — that is
-- what lets the UI collapse them, lets export drop them, and stops them being
-- silently replayed to a model that never asked for them.
CREATE TABLE message_parts (
    id           INTEGER PRIMARY KEY,
    message_id   TEXT    NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    kind         TEXT    NOT NULL,
    -- text | reasoning | tool_result payload
    text         TEXT,
    -- reasoning only: some backends sign thinking blocks and require the
    -- signature back verbatim on the next turn, so it must round-trip.
    signature    TEXT,
    redacted     INTEGER NOT NULL DEFAULT 0,
    -- image only. Bytes, not a URL: an offline-first client cannot depend on a
    -- remote resource still being there.
    mime_type    TEXT,
    data         BLOB,
    -- tool_call / tool_result
    tool_call_id TEXT,
    tool_name    TEXT,
    arguments    TEXT,
    is_error     INTEGER NOT NULL DEFAULT 0,
    UNIQUE (message_id, seq),
    CHECK (kind IN ('text', 'reasoning', 'image', 'tool_call', 'tool_result')),
    CHECK (seq >= 0),
    CHECK (redacted IN (0, 1)),
    CHECK (is_error IN (0, 1)),
    CHECK (kind <> 'text' OR text IS NOT NULL),
    CHECK (kind <> 'reasoning' OR text IS NOT NULL),
    CHECK (kind <> 'image' OR (mime_type IS NOT NULL AND data IS NOT NULL)),
    CHECK (kind <> 'tool_call' OR (tool_call_id IS NOT NULL
                                   AND tool_name IS NOT NULL
                                   AND arguments IS NOT NULL
                                   AND json_valid(arguments))),
    CHECK (kind <> 'tool_result' OR (tool_call_id IS NOT NULL AND text IS NOT NULL))
) STRICT;

-- "Show me just the thinking for this turn" without scanning every part.
CREATE INDEX idx_parts_reasoning ON message_parts (message_id) WHERE kind = 'reasoning';

-- Configuration.
--
-- THERE IS NO COLUMN HERE THAT CAN HOLD A CREDENTIAL, AND THERE NEVER WILL BE.
-- `secret_ref` holds the *name* of an OS-keychain entry ("<providerId>/<field>"),
-- which is a lookup key, not a secret. The value itself is only ever read by
-- the Rust core, from the keychain, and never lands on disk in the clear.
CREATE TABLE settings (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    secret_ref TEXT,
    updated_at INTEGER NOT NULL,
    CHECK (length(trim(key)) > 0),
    CHECK (json_valid(value))
) STRICT;
