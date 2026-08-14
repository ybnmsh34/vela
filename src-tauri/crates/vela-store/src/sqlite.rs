//! The SQLite implementation of the repository traits.
//!
//! **This is the only module in Vela that contains SQL.** Everything else
//! depends on [`crate::repository`]. If you find yourself writing a query
//! anywhere else, the query belongs here behind a method.
//!
//! ## Connection model
//!
//! One connection, behind a mutex. A desktop client has a single user issuing a
//! handful of writes a minute; a pool would add lifetime and lock-ordering
//! complexity to solve contention that does not exist. WAL is still enabled
//! because it makes writes durable without blocking the reader on the same
//! connection and survives an abrupt shutdown far better than the rollback
//! journal.

use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};

use crate::clock::{Clock, IdSource, SystemClock, UuidSource};
use crate::error::{StoreError, StoreResult};
use crate::location::DatabaseLocation;
use crate::migrations;
use crate::model::{
    validate_memory_content, ContentPart, Conversation, ConversationId, ConversationPatch,
    MemoryCategory, MemoryEntry, MemoryEntryId, MemoryPatch, MemoryScope, Message, MessageId,
    MessagePatch, MessageRole, MessageStatus, NewConversation, NewMemoryEntry, NewMessage,
    NewProject, Project, ProjectId, ProjectPatch, SecretRefName, Setting, SettingEntry, StopReason,
    Timestamp, TokenUsage,
};
use crate::repository::{
    ConversationQuery, ConversationRepository, HasLocation, MemoryRepository, MessageQuery,
    MessageRepository, ProjectFilter, ProjectRepository, SearchHit, SearchHitKind,
    SettingsRepository, UsageTotals,
};

const CONVERSATION_COLUMNS: &str = "c.id, c.project_id, c.title, c.provider_id, c.model_id, \
     c.created_at, c.updated_at, c.last_message_at, c.archived_at, \
     (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id)";

const PROJECT_COLUMNS: &str = "p.id, p.name, p.description, p.system_prompt, p.created_at, \
     p.updated_at, p.archived_at, \
     (SELECT count(*) FROM conversations c WHERE c.project_id = p.id)";

const MESSAGE_COLUMNS: &str = "id, conversation_id, seq, role, status, provider_id, model_id, \
     stop_reason, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, \
     error_message, created_at, updated_at";

pub struct SqliteStore {
    connection: Mutex<Connection>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn IdSource>,
    location: DatabaseLocation,
}

impl std::fmt::Debug for SqliteStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteStore")
            .field("location", &self.location)
            .finish_non_exhaustive()
    }
}

impl SqliteStore {
    /// Opens (creating if needed) the database at `location`, applies every
    /// outstanding migration, and returns a ready store. Migrations run **at
    /// startup**, inside this call: there is no separate "migrate" step a
    /// caller could forget.
    pub fn open(location: DatabaseLocation) -> StoreResult<Self> {
        Self::open_with(location, Arc::new(SystemClock), Arc::new(UuidSource))
    }

    /// [`Self::open`] with injected time and identity, for deterministic tests.
    pub fn open_with(
        location: DatabaseLocation,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn IdSource>,
    ) -> StoreResult<Self> {
        location.prepare()?;

        let mut connection = match &location {
            DatabaseLocation::InMemory => Connection::open_in_memory()?,
            DatabaseLocation::File(path) => {
                Connection::open(path).map_err(|error| StoreError::Io {
                    path: path.display().to_string(),
                    reason: error.to_string(),
                })?
            }
        };

        connection.execute_batch(
            // foreign_keys: off by default in SQLite, and a client whose
            //   parent/child rows can drift apart is not a system of record.
            // recursive_triggers: the search-index triggers must also fire for
            //   rows removed by ON DELETE CASCADE.
            // synchronous NORMAL: with WAL this is the documented safe setting
            //   — durable across process crashes, only at risk from an OS-level
            //   power loss, in exchange for not fsyncing on every commit.
            // busy_timeout: another Vela window (or a stray reader) briefly
            //   holding the write lock should wait, not fail.
            "PRAGMA foreign_keys = ON;
             PRAGMA recursive_triggers = ON;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;",
        )?;

        if !location.is_in_memory() {
            // Returns the resulting mode as a row, so it cannot go in the batch.
            let mode: String =
                connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
            if !mode.eq_ignore_ascii_case("wal") {
                return Err(StoreError::Backend {
                    reason: format!("could not enable WAL journalling (mode is `{mode}`)"),
                });
            }
        }

        let foreign_keys: i64 =
            connection.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
        if foreign_keys != 1 {
            return Err(StoreError::Backend {
                reason: "SQLite refused to enable foreign key enforcement".into(),
            });
        }

        migrations::apply(&mut connection, clock.as_ref())?;

        Ok(Self {
            connection: Mutex::new(connection),
            clock,
            ids,
            location,
        })
    }

    /// A private, non-persisted database with deterministic time and ids.
    /// Tests only — anything demonstrated against it says nothing about a real
    /// file on a real disk.
    #[cfg(any(test, feature = "test-support"))]
    pub fn in_memory() -> StoreResult<Self> {
        use crate::clock::{FixedClock, SeqIdSource};
        Self::open_with(
            DatabaseLocation::InMemory,
            Arc::new(FixedClock::default()),
            Arc::new(SeqIdSource::new()),
        )
    }

    /// The journal mode SQLite actually settled on (`wal` for a file database,
    /// `memory` for an in-memory one). Diagnostics and tests — a claim about
    /// WAL should be checkable, not asserted in a comment.
    pub fn journal_mode(&self) -> StoreResult<String> {
        let connection = self.connection();
        Ok(connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?)
    }

    pub fn location(&self) -> &DatabaseLocation {
        &self.location
    }

    fn connection(&self) -> MutexGuard<'_, Connection> {
        // A poisoned mutex means a previous caller panicked while holding the
        // connection. SQLite is still consistent — any open transaction was
        // rolled back when its guard dropped — so recovering is strictly better
        // than propagating a panic through every later read.
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn now(&self) -> Timestamp {
        self.clock.now()
    }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

fn read_conversation(row: &Row<'_>) -> rusqlite::Result<Conversation> {
    let project_id: Option<String> = row.get(1)?;
    Ok(Conversation {
        id: ConversationId::new(row.get::<_, String>(0)?).map_err(to_sqlite_error)?,
        project_id: project_id
            .map(ProjectId::new)
            .transpose()
            .map_err(to_sqlite_error)?,
        title: row.get(2)?,
        provider_id: row.get(3)?,
        model_id: row.get(4)?,
        created_at: Timestamp::from_millis(row.get(5)?),
        updated_at: Timestamp::from_millis(row.get(6)?),
        last_message_at: row.get::<_, Option<i64>>(7)?.map(Timestamp::from_millis),
        archived_at: row.get::<_, Option<i64>>(8)?.map(Timestamp::from_millis),
        message_count: row.get(9)?,
    })
}

fn read_project(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: ProjectId::new(row.get::<_, String>(0)?).map_err(to_sqlite_error)?,
        name: row.get(1)?,
        description: row.get(2)?,
        system_prompt: row.get(3)?,
        created_at: Timestamp::from_millis(row.get(4)?),
        updated_at: Timestamp::from_millis(row.get(5)?),
        archived_at: row.get::<_, Option<i64>>(6)?.map(Timestamp::from_millis),
        conversation_count: row.get(7)?,
    })
}

/// Reads a message row *without* its parts; the caller attaches those.
fn read_message_head(row: &Row<'_>) -> rusqlite::Result<Message> {
    let stop_reason: Option<String> = row.get(7)?;
    Ok(Message {
        id: MessageId::new(row.get::<_, String>(0)?).map_err(to_sqlite_error)?,
        conversation_id: ConversationId::new(row.get::<_, String>(1)?).map_err(to_sqlite_error)?,
        seq: row.get(2)?,
        role: MessageRole::from_db(&row.get::<_, String>(3)?).map_err(to_sqlite_error)?,
        status: MessageStatus::from_db(&row.get::<_, String>(4)?).map_err(to_sqlite_error)?,
        parts: Vec::new(),
        provider_id: row.get(5)?,
        model_id: row.get(6)?,
        usage: TokenUsage {
            input_tokens: row.get(8)?,
            output_tokens: row.get(9)?,
            reasoning_tokens: row.get(10)?,
            cached_input_tokens: row.get(11)?,
        },
        stop_reason: stop_reason
            .as_deref()
            .map(StopReason::from_db)
            .transpose()
            .map_err(to_sqlite_error)?,
        error_message: row.get(12)?,
        created_at: Timestamp::from_millis(row.get(13)?),
        updated_at: Timestamp::from_millis(row.get(14)?),
    })
}

fn read_part(row: &Row<'_>) -> rusqlite::Result<(String, ContentPart)> {
    let message_id: String = row.get(0)?;
    let kind: String = row.get(1)?;
    let text: Option<String> = row.get(2)?;
    let signature: Option<String> = row.get(3)?;
    let redacted: i64 = row.get(4)?;
    let mime_type: Option<String> = row.get(5)?;
    let data: Option<Vec<u8>> = row.get(6)?;
    let tool_call_id: Option<String> = row.get(7)?;
    let tool_name: Option<String> = row.get(8)?;
    let arguments: Option<String> = row.get(9)?;
    let is_error: i64 = row.get(10)?;

    let missing = |field: &str| {
        to_sqlite_error(StoreError::corrupt(format!(
            "part of kind `{kind}` is missing `{field}`"
        )))
    };

    let part = match kind.as_str() {
        "text" => ContentPart::Text {
            text: text.ok_or_else(|| missing("text"))?,
        },
        "reasoning" => ContentPart::Reasoning {
            text: text.ok_or_else(|| missing("text"))?,
            signature,
            redacted: redacted != 0,
        },
        "image" => ContentPart::Image {
            mime_type: mime_type.ok_or_else(|| missing("mime_type"))?,
            data: data.ok_or_else(|| missing("data"))?,
        },
        "tool_call" => ContentPart::ToolCall {
            call_id: tool_call_id.ok_or_else(|| missing("tool_call_id"))?,
            name: tool_name.ok_or_else(|| missing("tool_name"))?,
            arguments: serde_json::from_str(&arguments.ok_or_else(|| missing("arguments"))?)
                .map_err(|error| to_sqlite_error(StoreError::from(error)))?,
        },
        "tool_result" => ContentPart::ToolResult {
            call_id: tool_call_id.ok_or_else(|| missing("tool_call_id"))?,
            content: text.ok_or_else(|| missing("text"))?,
            is_error: is_error != 0,
        },
        other => {
            return Err(to_sqlite_error(StoreError::corrupt(format!(
                "unknown content part kind `{other}`"
            ))))
        }
    };
    Ok((message_id, part))
}

/// Carries a domain error out through rusqlite's row-mapping signature.
fn to_sqlite_error(error: StoreError) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(BoxedStoreError(error)))
}

#[derive(Debug)]
struct BoxedStoreError(StoreError);

impl std::fmt::Display for BoxedStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.0, f)
    }
}

impl std::error::Error for BoxedStoreError {}

/// Unwraps a domain error that travelled through a rusqlite row mapper, so the
/// caller sees `Corrupt`/`Invalid` rather than an opaque backend failure.
fn unwrap_store_error(error: rusqlite::Error) -> StoreError {
    if let rusqlite::Error::ToSqlConversionFailure(inner) = &error {
        if let Some(boxed) = inner.downcast_ref::<BoxedStoreError>() {
            return boxed.0.clone();
        }
    }
    StoreError::from(error)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn conversation_exists(conn: &Connection, id: &ConversationId) -> StoreResult<()> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM conversations WHERE id = ?1",
            [id.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    found.map(|_| ()).ok_or_else(|| StoreError::NotFound {
        entity: ConversationId::ENTITY,
        id: id.to_string(),
    })
}

/// Writes one part row. `seq` is the part's position within its message.
fn insert_part(
    tx: &rusqlite::Transaction<'_>,
    message_id: &str,
    seq: usize,
    part: &ContentPart,
) -> StoreResult<()> {
    let (text, signature, redacted, mime_type, data, call_id, tool_name, arguments, is_error) =
        match part {
            ContentPart::Text { text } => {
                (Some(text.clone()), None, 0, None, None, None, None, None, 0)
            }
            ContentPart::Reasoning {
                text,
                signature,
                redacted,
            } => (
                Some(text.clone()),
                signature.clone(),
                i64::from(*redacted),
                None,
                None,
                None,
                None,
                None,
                0,
            ),
            ContentPart::Image { mime_type, data } => (
                None,
                None,
                0,
                Some(mime_type.clone()),
                Some(data.clone()),
                None,
                None,
                None,
                0,
            ),
            ContentPart::ToolCall {
                call_id,
                name,
                arguments,
            } => (
                None,
                None,
                0,
                None,
                None,
                Some(call_id.clone()),
                Some(name.clone()),
                Some(arguments.to_string()),
                0,
            ),
            ContentPart::ToolResult {
                call_id,
                content,
                is_error,
            } => (
                Some(content.clone()),
                None,
                0,
                None,
                None,
                Some(call_id.clone()),
                None,
                None,
                i64::from(*is_error),
            ),
        };

    tx.execute(
        "INSERT INTO message_parts (
             message_id, seq, kind, text, signature, redacted,
             mime_type, data, tool_call_id, tool_name, arguments, is_error
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            message_id,
            seq as i64,
            part.kind_db(),
            text,
            signature,
            redacted,
            mime_type,
            data,
            call_id,
            tool_name,
            arguments,
            is_error,
        ],
    )?;
    Ok(())
}

/// Loads parts for a set of messages in one query — a transcript must not cost
/// one round trip per message.
fn load_parts(
    conn: &Connection,
    message_ids: &[String],
    include_reasoning: bool,
) -> StoreResult<std::collections::HashMap<String, Vec<ContentPart>>> {
    let mut out: std::collections::HashMap<String, Vec<ContentPart>> =
        std::collections::HashMap::new();
    if message_ids.is_empty() {
        return Ok(out);
    }

    let placeholders = std::iter::repeat_n("?", message_ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let reasoning_clause = if include_reasoning {
        ""
    } else {
        " AND kind <> 'reasoning'"
    };
    let sql = format!(
        "SELECT message_id, kind, text, signature, redacted, mime_type, data,
                tool_call_id, tool_name, arguments, is_error
         FROM message_parts
         WHERE message_id IN ({placeholders}){reasoning_clause}
         ORDER BY message_id, seq"
    );

    let mut statement = conn.prepare(&sql)?;
    let rows = statement
        .query_map(params_from_iter(message_ids.iter()), read_part)
        .map_err(unwrap_store_error)?;
    for row in rows {
        let (message_id, part) = row.map_err(unwrap_store_error)?;
        out.entry(message_id).or_default().push(part);
    }
    Ok(out)
}

fn touch_conversation(
    tx: &rusqlite::Transaction<'_>,
    conversation_id: &str,
    now: Timestamp,
    stamp_last_message: bool,
) -> StoreResult<()> {
    if stamp_last_message {
        tx.execute(
            "UPDATE conversations SET updated_at = ?2, last_message_at = ?2 WHERE id = ?1",
            params![conversation_id, now.as_millis()],
        )?;
    } else {
        tx.execute(
            "UPDATE conversations SET updated_at = ?2 WHERE id = ?1",
            params![conversation_id, now.as_millis()],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

impl ProjectRepository for SqliteStore {
    fn create_project(&self, input: NewProject) -> StoreResult<Project> {
        input.validate()?;
        let now = self.now();
        let id = ProjectId::new(self.ids.next_id(ProjectId::PREFIX))?;
        let conn = self.connection();

        conn.execute(
            "INSERT INTO projects (id, name, description, system_prompt, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                id.as_str(),
                input.name.trim(),
                input.description,
                input.system_prompt,
                now.as_millis(),
            ],
        )?;

        fetch_project(&conn, &id)
    }

    fn get_project(&self, id: &ProjectId) -> StoreResult<Project> {
        let conn = self.connection();
        fetch_project(&conn, id)
    }

    fn list_projects(&self, include_archived: bool) -> StoreResult<Vec<Project>> {
        let conn = self.connection();
        let filter = if include_archived {
            ""
        } else {
            " WHERE p.archived_at IS NULL"
        };
        let sql = format!(
            "SELECT {PROJECT_COLUMNS} FROM projects p{filter} ORDER BY p.name COLLATE NOCASE, p.id"
        );
        let mut statement = conn.prepare(&sql)?;
        let rows = statement
            .query_map([], read_project)
            .map_err(unwrap_store_error)?;
        rows.map(|row| row.map_err(unwrap_store_error))
            .collect::<StoreResult<Vec<_>>>()
    }

    fn update_project(&self, id: &ProjectId, patch: ProjectPatch) -> StoreResult<Project> {
        if let Some(name) = &patch.name {
            if name.trim().is_empty() {
                return Err(StoreError::invalid("name", "a project must have a name"));
            }
        }
        let now = self.now();
        let conn = self.connection();
        fetch_project(&conn, id)?;

        let mut assignments: Vec<String> = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        if let Some(name) = patch.name {
            assignments.push(format!("name = ?{}", values.len() + 1));
            values.push(Value::Text(name.trim().to_string()));
        }
        if let Some(description) = patch.description {
            assignments.push(format!("description = ?{}", values.len() + 1));
            values.push(description.map_or(Value::Null, Value::Text));
        }
        if let Some(system_prompt) = patch.system_prompt {
            assignments.push(format!("system_prompt = ?{}", values.len() + 1));
            values.push(system_prompt.map_or(Value::Null, Value::Text));
        }
        if let Some(archived) = patch.archived {
            assignments.push(format!("archived_at = ?{}", values.len() + 1));
            values.push(if archived {
                Value::Integer(now.as_millis())
            } else {
                Value::Null
            });
        }

        if !assignments.is_empty() {
            assignments.push(format!("updated_at = ?{}", values.len() + 1));
            values.push(Value::Integer(now.as_millis()));
            values.push(Value::Text(id.to_string()));
            let sql = format!(
                "UPDATE projects SET {} WHERE id = ?{}",
                assignments.join(", "),
                values.len()
            );
            conn.execute(&sql, params_from_iter(values.iter()))?;
        }

        fetch_project(&conn, id)
    }

    fn delete_project(&self, id: &ProjectId) -> StoreResult<()> {
        let conn = self.connection();
        let removed = conn.execute("DELETE FROM projects WHERE id = ?1", [id.as_str()])?;
        if removed == 0 {
            return Err(StoreError::NotFound {
                entity: ProjectId::ENTITY,
                id: id.to_string(),
            });
        }
        Ok(())
    }
}

fn fetch_project(conn: &Connection, id: &ProjectId) -> StoreResult<Project> {
    let sql = format!("SELECT {PROJECT_COLUMNS} FROM projects p WHERE p.id = ?1");
    conn.query_row(&sql, [id.as_str()], read_project)
        .optional()
        .map_err(unwrap_store_error)?
        .ok_or_else(|| StoreError::NotFound {
            entity: ProjectId::ENTITY,
            id: id.to_string(),
        })
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

impl ConversationRepository for SqliteStore {
    fn create_conversation(&self, input: NewConversation) -> StoreResult<Conversation> {
        let now = self.now();
        let id = ConversationId::new(self.ids.next_id(ConversationId::PREFIX))?;
        let conn = self.connection();

        conn.execute(
            "INSERT INTO conversations
                 (id, project_id, title, provider_id, model_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                id.as_str(),
                input.project_id.as_ref().map(ProjectId::as_str),
                input.title,
                input.provider_id,
                input.model_id,
                now.as_millis(),
            ],
        )?;

        fetch_conversation(&conn, &id)
    }

    fn get_conversation(&self, id: &ConversationId) -> StoreResult<Conversation> {
        let conn = self.connection();
        fetch_conversation(&conn, id)
    }

    fn list_conversations(&self, query: ConversationQuery) -> StoreResult<Vec<Conversation>> {
        let conn = self.connection();
        let mut clauses: Vec<String> = Vec::new();
        let mut values: Vec<Value> = Vec::new();

        match query.project {
            ProjectFilter::Any => {}
            ProjectFilter::Unfiled => clauses.push("c.project_id IS NULL".into()),
            ProjectFilter::Only(project_id) => {
                values.push(Value::Text(project_id.into_string()));
                clauses.push(format!("c.project_id = ?{}", values.len()));
            }
        }
        if !query.include_archived {
            clauses.push("c.archived_at IS NULL".into());
        }

        let where_clause = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };

        // `id` breaks ties so two conversations written in the same millisecond
        // still list in a stable order.
        values.push(Value::Integer(query.limit.map_or(-1, i64::from)));
        let limit_index = values.len();
        values.push(Value::Integer(i64::from(query.offset)));
        let offset_index = values.len();

        let sql = format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations c{where_clause}
             ORDER BY c.updated_at DESC, c.id DESC
             LIMIT ?{limit_index} OFFSET ?{offset_index}"
        );

        let mut statement = conn.prepare(&sql)?;
        let rows = statement
            .query_map(params_from_iter(values.iter()), read_conversation)
            .map_err(unwrap_store_error)?;
        rows.map(|row| row.map_err(unwrap_store_error))
            .collect::<StoreResult<Vec<_>>>()
    }

    fn search_conversations(&self, query: &str, limit: u32) -> StoreResult<Vec<Conversation>> {
        let needle = query.trim();
        if needle.is_empty() {
            return Err(StoreError::invalid("query", "must not be blank"));
        }
        let conn = self.connection();
        // `instr` on two `lower()`ed strings rather than `LIKE`: a substring the
        // user typed can contain `%`, `_` or `\`, and every one of those is a
        // metacharacter to `LIKE`. Searching for "100%" must find "100%", not
        // "1000 tokens".
        let mut statement = conn.prepare(&format!(
            "SELECT {CONVERSATION_COLUMNS} FROM conversations c
             WHERE c.archived_at IS NULL AND instr(lower(c.title), lower(?1)) > 0
             ORDER BY c.updated_at DESC, c.id DESC
             LIMIT ?2"
        ))?;
        let rows = statement
            .query_map(params![needle, i64::from(limit)], read_conversation)
            .map_err(unwrap_store_error)?;
        rows.map(|row| row.map_err(unwrap_store_error))
            .collect::<StoreResult<Vec<_>>>()
    }

    fn update_conversation(
        &self,
        id: &ConversationId,
        patch: ConversationPatch,
    ) -> StoreResult<Conversation> {
        let now = self.now();
        let conn = self.connection();
        fetch_conversation(&conn, id)?;

        let mut assignments: Vec<String> = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        if let Some(title) = patch.title {
            assignments.push(format!("title = ?{}", values.len() + 1));
            values.push(Value::Text(title));
        }
        if let Some(project_id) = patch.project_id {
            assignments.push(format!("project_id = ?{}", values.len() + 1));
            values.push(project_id.map_or(Value::Null, |p| Value::Text(p.into_string())));
        }
        if let Some(provider_id) = patch.provider_id {
            assignments.push(format!("provider_id = ?{}", values.len() + 1));
            values.push(provider_id.map_or(Value::Null, Value::Text));
        }
        if let Some(model_id) = patch.model_id {
            assignments.push(format!("model_id = ?{}", values.len() + 1));
            values.push(model_id.map_or(Value::Null, Value::Text));
        }
        if let Some(archived) = patch.archived {
            assignments.push(format!("archived_at = ?{}", values.len() + 1));
            values.push(if archived {
                Value::Integer(now.as_millis())
            } else {
                Value::Null
            });
        }

        if !assignments.is_empty() {
            assignments.push(format!("updated_at = ?{}", values.len() + 1));
            values.push(Value::Integer(now.as_millis()));
            values.push(Value::Text(id.to_string()));
            let sql = format!(
                "UPDATE conversations SET {} WHERE id = ?{}",
                assignments.join(", "),
                values.len()
            );
            conn.execute(&sql, params_from_iter(values.iter()))?;
        }

        fetch_conversation(&conn, id)
    }

    fn delete_conversation(&self, id: &ConversationId) -> StoreResult<()> {
        let conn = self.connection();
        let removed = conn.execute("DELETE FROM conversations WHERE id = ?1", [id.as_str()])?;
        if removed == 0 {
            return Err(StoreError::NotFound {
                entity: ConversationId::ENTITY,
                id: id.to_string(),
            });
        }
        Ok(())
    }
}

fn fetch_conversation(conn: &Connection, id: &ConversationId) -> StoreResult<Conversation> {
    let sql = format!("SELECT {CONVERSATION_COLUMNS} FROM conversations c WHERE c.id = ?1");
    conn.query_row(&sql, [id.as_str()], read_conversation)
        .optional()
        .map_err(unwrap_store_error)?
        .ok_or_else(|| StoreError::NotFound {
            entity: ConversationId::ENTITY,
            id: id.to_string(),
        })
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

impl MessageRepository for SqliteStore {
    fn append_message(&self, input: NewMessage) -> StoreResult<Message> {
        input.validate()?;
        let now = self.now();
        let id = MessageId::new(self.ids.next_id(MessageId::PREFIX))?;
        let mut conn = self.connection();
        conversation_exists(&conn, &input.conversation_id)?;

        let tx = conn.transaction()?;
        let seq: i64 = tx.query_row(
            "SELECT coalesce(max(seq) + 1, 0) FROM messages WHERE conversation_id = ?1",
            [input.conversation_id.as_str()],
            |row| row.get(0),
        )?;

        tx.execute(
            "INSERT INTO messages (
                 id, conversation_id, seq, role, status, provider_id, model_id, stop_reason,
                 input_tokens, output_tokens, reasoning_tokens, cached_input_tokens,
                 error_message, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
            params![
                id.as_str(),
                input.conversation_id.as_str(),
                seq,
                input.role.as_db(),
                input.status.as_db(),
                input.provider_id,
                input.model_id,
                input.stop_reason.map(StopReason::as_db),
                input.usage.input_tokens,
                input.usage.output_tokens,
                input.usage.reasoning_tokens,
                input.usage.cached_input_tokens,
                input.error_message,
                now.as_millis(),
            ],
        )?;

        for (index, part) in input.parts.iter().enumerate() {
            insert_part(&tx, id.as_str(), index, part)?;
        }

        touch_conversation(&tx, input.conversation_id.as_str(), now, true)?;
        tx.commit()?;

        Ok(Message {
            id,
            conversation_id: input.conversation_id,
            seq,
            role: input.role,
            status: input.status,
            parts: input.parts,
            provider_id: input.provider_id,
            model_id: input.model_id,
            usage: input.usage,
            stop_reason: input.stop_reason,
            error_message: input.error_message,
            created_at: now,
            updated_at: now,
        })
    }

    fn get_message(&self, id: &MessageId) -> StoreResult<Message> {
        let conn = self.connection();
        let sql = format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE id = ?1");
        let mut message = conn
            .query_row(&sql, [id.as_str()], read_message_head)
            .optional()
            .map_err(unwrap_store_error)?
            .ok_or_else(|| StoreError::NotFound {
                entity: MessageId::ENTITY,
                id: id.to_string(),
            })?;

        let mut parts = load_parts(&conn, &[id.to_string()], true)?;
        message.parts = parts.remove(id.as_str()).unwrap_or_default();
        Ok(message)
    }

    fn list_messages(
        &self,
        conversation_id: &ConversationId,
        query: MessageQuery,
    ) -> StoreResult<Vec<Message>> {
        let conn = self.connection();
        conversation_exists(&conn, conversation_id)?;

        let mut values: Vec<Value> = vec![Value::Text(conversation_id.to_string())];
        let mut clauses = String::from("conversation_id = ?1");
        if let Some(after) = query.after_seq {
            values.push(Value::Integer(after));
            clauses.push_str(&format!(" AND seq > ?{}", values.len()));
        }
        values.push(Value::Integer(query.limit.map_or(-1, i64::from)));
        let limit_index = values.len();

        let sql = format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages
             WHERE {clauses} ORDER BY seq LIMIT ?{limit_index}"
        );

        let mut statement = conn.prepare(&sql)?;
        let rows = statement
            .query_map(params_from_iter(values.iter()), read_message_head)
            .map_err(unwrap_store_error)?;
        let mut messages = rows
            .map(|row| row.map_err(unwrap_store_error))
            .collect::<StoreResult<Vec<_>>>()?;

        let ids: Vec<String> = messages.iter().map(|m| m.id.to_string()).collect();
        let mut parts = load_parts(&conn, &ids, query.include_reasoning)?;
        for message in &mut messages {
            message.parts = parts.remove(message.id.as_str()).unwrap_or_default();
        }
        Ok(messages)
    }

    fn update_message(&self, id: &MessageId, patch: MessagePatch) -> StoreResult<Message> {
        patch.validate()?;
        let changes_something = !patch.is_empty();
        let now = self.now();

        {
            let mut conn = self.connection();
            let conversation_id: String = conn
                .query_row(
                    "SELECT conversation_id FROM messages WHERE id = ?1",
                    [id.as_str()],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| StoreError::NotFound {
                    entity: MessageId::ENTITY,
                    id: id.to_string(),
                })?;

            let tx = conn.transaction()?;

            let mut assignments: Vec<String> = Vec::new();
            let mut values: Vec<Value> = Vec::new();
            if let Some(status) = patch.status {
                assignments.push(format!("status = ?{}", values.len() + 1));
                values.push(Value::Text(status.as_db().to_string()));
            }
            if let Some(usage) = patch.usage {
                for (column, count) in [
                    ("input_tokens", usage.input_tokens),
                    ("output_tokens", usage.output_tokens),
                    ("reasoning_tokens", usage.reasoning_tokens),
                    ("cached_input_tokens", usage.cached_input_tokens),
                ] {
                    assignments.push(format!("{column} = ?{}", values.len() + 1));
                    values.push(count.map_or(Value::Null, |n| Value::Integer(i64::from(n))));
                }
            }
            if let Some(stop_reason) = patch.stop_reason {
                assignments.push(format!("stop_reason = ?{}", values.len() + 1));
                values
                    .push(stop_reason.map_or(Value::Null, |r| Value::Text(r.as_db().to_string())));
            }
            if let Some(error_message) = patch.error_message {
                assignments.push(format!("error_message = ?{}", values.len() + 1));
                values.push(error_message.map_or(Value::Null, Value::Text));
            }

            if !assignments.is_empty() {
                assignments.push(format!("updated_at = ?{}", values.len() + 1));
                values.push(Value::Integer(now.as_millis()));
                values.push(Value::Text(id.to_string()));
                let sql = format!(
                    "UPDATE messages SET {} WHERE id = ?{}",
                    assignments.join(", "),
                    values.len()
                );
                tx.execute(&sql, params_from_iter(values.iter()))?;
            }

            if let Some(parts) = &patch.parts {
                // Replace wholesale. Streaming rewrites the same turn many
                // times; diffing part-by-part would buy nothing but bugs.
                tx.execute(
                    "DELETE FROM message_parts WHERE message_id = ?1",
                    [id.as_str()],
                )?;
                for (index, part) in parts.iter().enumerate() {
                    insert_part(&tx, id.as_str(), index, part)?;
                }
                tx.execute(
                    "UPDATE messages SET updated_at = ?2 WHERE id = ?1",
                    params![id.as_str(), now.as_millis()],
                )?;
            }

            if changes_something {
                touch_conversation(&tx, &conversation_id, now, false)?;
            }
            tx.commit()?;
        }

        self.get_message(id)
    }

    fn delete_message(&self, id: &MessageId) -> StoreResult<()> {
        let conn = self.connection();
        let removed = conn.execute("DELETE FROM messages WHERE id = ?1", [id.as_str()])?;
        if removed == 0 {
            return Err(StoreError::NotFound {
                entity: MessageId::ENTITY,
                id: id.to_string(),
            });
        }
        Ok(())
    }

    fn conversation_usage(&self, conversation_id: &ConversationId) -> StoreResult<UsageTotals> {
        let conn = self.connection();
        conversation_exists(&conn, conversation_id)?;

        Ok(conn.query_row(
            "SELECT
                 coalesce(sum(input_tokens), 0),
                 coalesce(sum(output_tokens), 0),
                 coalesce(sum(reasoning_tokens), 0),
                 coalesce(sum(cached_input_tokens), 0),
                 count(*),
                 sum(CASE WHEN input_tokens IS NULL AND output_tokens IS NULL
                           AND reasoning_tokens IS NULL AND cached_input_tokens IS NULL
                          THEN 1 ELSE 0 END)
             FROM messages WHERE conversation_id = ?1",
            [conversation_id.as_str()],
            |row| {
                Ok(UsageTotals {
                    input_tokens: row.get(0)?,
                    output_tokens: row.get(1)?,
                    reasoning_tokens: row.get(2)?,
                    cached_input_tokens: row.get(3)?,
                    message_count: row.get(4)?,
                    messages_without_usage: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                })
            },
        )?)
    }

    fn search_messages(&self, query: &str, limit: u32) -> StoreResult<Vec<SearchHit>> {
        if query.trim().is_empty() {
            return Err(StoreError::invalid("query", "must not be blank"));
        }
        let conn = self.connection();
        let mut statement = conn.prepare(
            "SELECT s.message_id, s.conversation_id, c.title, s.kind,
                    snippet(message_search, 0, '[', ']', '…', 12), m.created_at
             FROM message_search s
             JOIN messages m ON m.id = s.message_id
             JOIN conversations c ON c.id = s.conversation_id
             WHERE message_search MATCH ?1
             ORDER BY bm25(message_search), m.created_at DESC
             LIMIT ?2",
        )?;

        let rows = statement.query_map(params![query, i64::from(limit)], |row| {
            let kind: String = row.get(3)?;
            Ok(SearchHit {
                message_id: MessageId::new(row.get::<_, String>(0)?).map_err(to_sqlite_error)?,
                conversation_id: ConversationId::new(row.get::<_, String>(1)?)
                    .map_err(to_sqlite_error)?,
                conversation_title: row.get(2)?,
                kind: if kind == "reasoning" {
                    SearchHitKind::Reasoning
                } else {
                    SearchHitKind::Answer
                },
                snippet: row.get(4)?,
                created_at: Timestamp::from_millis(row.get(5)?),
            })
        });

        let rows = match rows {
            Ok(rows) => rows,
            Err(error) => return Err(map_search_error(error)),
        };

        let mut hits = Vec::new();
        for row in rows {
            match row {
                Ok(hit) => hits.push(hit),
                Err(error) => return Err(map_search_error(error)),
            }
        }
        Ok(hits)
    }
}

/// FTS5 reports a malformed query (`"unbalanced`, a stray `NEAR(`, …) as plain
/// `SQLITE_ERROR` while running an otherwise static statement. That is user
/// input, not a Vela fault, so it becomes `Invalid` rather than `Backend`.
/// Real trouble — I/O failure, corruption — carries its own error code and is
/// still reported as what it is.
fn map_search_error(error: rusqlite::Error) -> StoreError {
    if let rusqlite::Error::SqliteFailure(inner, _) = &error {
        if inner.code == rusqlite::ErrorCode::Unknown {
            return StoreError::invalid("query", "is not a valid search expression");
        }
    }
    unwrap_store_error(error)
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const MEMORY_COLUMNS: &str = "id, scope_kind, project_id, category, content, pinned, \
     source_conversation_id, created_at, updated_at";

fn read_memory_entry(row: &Row<'_>) -> rusqlite::Result<MemoryEntry> {
    let source: Option<String> = row.get(6)?;
    Ok(MemoryEntry {
        id: MemoryEntryId::new(row.get::<_, String>(0)?).map_err(to_sqlite_error)?,
        scope: MemoryScope::from_db(&row.get::<_, String>(1)?, row.get(2)?)
            .map_err(to_sqlite_error)?,
        category: MemoryCategory::from_db(&row.get::<_, String>(3)?).map_err(to_sqlite_error)?,
        content: row.get(4)?,
        pinned: row.get::<_, i64>(5)? != 0,
        source_conversation_id: source
            .map(ConversationId::new)
            .transpose()
            .map_err(to_sqlite_error)?,
        created_at: Timestamp::from_millis(row.get(7)?),
        updated_at: Timestamp::from_millis(row.get(8)?),
    })
}

fn fetch_memory_entry(conn: &Connection, id: &MemoryEntryId) -> StoreResult<MemoryEntry> {
    conn.query_row(
        &format!("SELECT {MEMORY_COLUMNS} FROM memory_entries WHERE id = ?1"),
        [id.as_str()],
        read_memory_entry,
    )
    .optional()
    .map_err(unwrap_store_error)?
    .ok_or_else(|| StoreError::NotFound {
        entity: MemoryEntryId::ENTITY,
        id: id.to_string(),
    })
}

impl MemoryRepository for SqliteStore {
    fn create_memory_entry(&self, input: NewMemoryEntry) -> StoreResult<MemoryEntry> {
        input.validate()?;
        let now = self.now();
        let id = MemoryEntryId::new(self.ids.next_id(MemoryEntryId::PREFIX))?;
        let conn = self.connection();

        conn.execute(
            "INSERT INTO memory_entries (id, scope_kind, project_id, category, content, pinned,
                                         source_conversation_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                id.as_str(),
                input.scope.as_db(),
                input.scope.project_id().map(ProjectId::as_str),
                input.category.as_db(),
                input.content.trim(),
                i64::from(input.pinned),
                input
                    .source_conversation_id
                    .as_ref()
                    .map(ConversationId::as_str),
                now.as_millis(),
            ],
        )?;

        fetch_memory_entry(&conn, &id)
    }

    fn get_memory_entry(&self, id: &MemoryEntryId) -> StoreResult<MemoryEntry> {
        let conn = self.connection();
        fetch_memory_entry(&conn, id)
    }

    fn list_memory_entries(&self, scope: &MemoryScope) -> StoreResult<Vec<MemoryEntry>> {
        let conn = self.connection();
        // `project_id IS ?2` rather than `= ?2`: SQLite's `=` is never true for
        // NULL, so the global scope — whose project_id is NULL by construction —
        // would silently list nothing. `IS` compares NULLs as equal, which is
        // exactly the comparison this partition needs.
        let mut statement = conn.prepare(&format!(
            "SELECT {MEMORY_COLUMNS} FROM memory_entries
             WHERE scope_kind = ?1 AND project_id IS ?2
             ORDER BY pinned DESC, updated_at DESC, id DESC"
        ))?;
        let rows = statement
            .query_map(
                params![scope.as_db(), scope.project_id().map(ProjectId::as_str)],
                read_memory_entry,
            )
            .map_err(unwrap_store_error)?;
        rows.map(|row| row.map_err(unwrap_store_error))
            .collect::<StoreResult<Vec<_>>>()
    }

    fn update_memory_entry(
        &self,
        id: &MemoryEntryId,
        patch: MemoryPatch,
    ) -> StoreResult<MemoryEntry> {
        if let Some(content) = &patch.content {
            validate_memory_content(content)?;
        }
        let now = self.now();
        let conn = self.connection();
        fetch_memory_entry(&conn, id)?;

        let mut assignments: Vec<String> = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        if let Some(category) = patch.category {
            assignments.push(format!("category = ?{}", values.len() + 1));
            values.push(Value::Text(category.as_db().to_string()));
        }
        if let Some(content) = patch.content {
            assignments.push(format!("content = ?{}", values.len() + 1));
            values.push(Value::Text(content.trim().to_string()));
        }
        if let Some(pinned) = patch.pinned {
            assignments.push(format!("pinned = ?{}", values.len() + 1));
            values.push(Value::Integer(i64::from(pinned)));
        }

        // The scope is deliberately absent from `MemoryPatch`. Moving an entry
        // between scopes is MEM-2's "promote to global" and it is a different
        // operation with a different consent question; letting it happen as a
        // field on a general-purpose patch would make it something a caller
        // could do by accident.
        if !assignments.is_empty() {
            assignments.push(format!("updated_at = ?{}", values.len() + 1));
            values.push(Value::Integer(now.as_millis()));
            values.push(Value::Text(id.as_str().to_string()));
            let sql = format!(
                "UPDATE memory_entries SET {} WHERE id = ?{}",
                assignments.join(", "),
                values.len()
            );
            conn.execute(&sql, params_from_iter(values.iter()))?;
        }

        fetch_memory_entry(&conn, id)
    }

    fn delete_memory_entry(&self, id: &MemoryEntryId) -> StoreResult<()> {
        let conn = self.connection();
        let removed = conn.execute("DELETE FROM memory_entries WHERE id = ?1", [id.as_str()])?;
        if removed == 0 {
            return Err(StoreError::NotFound {
                entity: MemoryEntryId::ENTITY,
                id: id.to_string(),
            });
        }
        Ok(())
    }

    fn clear_memory_scope(&self, scope: &MemoryScope) -> StoreResult<u64> {
        let conn = self.connection();
        let removed = conn.execute(
            "DELETE FROM memory_entries WHERE scope_kind = ?1 AND project_id IS ?2",
            params![scope.as_db(), scope.project_id().map(ProjectId::as_str)],
        )?;
        Ok(removed as u64)
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

impl SettingsRepository for SqliteStore {
    fn put_setting(&self, entry: SettingEntry) -> StoreResult<Setting> {
        entry.validate()?;
        let now = self.now();
        let key = entry.key.trim().to_string();
        let encoded = serde_json::to_string(&entry.value)
            .map_err(|error| StoreError::invalid("value", error.to_string()))?;
        let conn = self.connection();

        conn.execute(
            "INSERT INTO settings (key, value, secret_ref, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (key) DO UPDATE SET
                 value = excluded.value,
                 secret_ref = excluded.secret_ref,
                 updated_at = excluded.updated_at",
            params![
                key,
                encoded,
                entry.secret_ref.as_ref().map(SecretRefName::as_str),
                now.as_millis(),
            ],
        )?;

        fetch_setting(&conn, &key)?.ok_or(StoreError::NotFound {
            entity: "setting",
            id: key,
        })
    }

    fn get_setting(&self, key: &str) -> StoreResult<Option<Setting>> {
        let conn = self.connection();
        fetch_setting(&conn, key)
    }

    fn list_settings(&self, prefix: &str) -> StoreResult<Vec<Setting>> {
        let conn = self.connection();
        let mut statement = conn.prepare(
            "SELECT key, value, secret_ref, updated_at FROM settings
             WHERE key LIKE ?1 ESCAPE '\\' ORDER BY key",
        )?;
        // Escape LIKE wildcards so `provider.a_b` is a literal prefix.
        let pattern = format!(
            "{}%",
            prefix
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let rows = statement
            .query_map([pattern], read_setting)
            .map_err(unwrap_store_error)?;
        rows.map(|row| row.map_err(unwrap_store_error))
            .collect::<StoreResult<Vec<_>>>()
    }

    fn delete_setting(&self, key: &str) -> StoreResult<()> {
        let conn = self.connection();
        // Idempotent: deleting a setting that was never written is the state
        // the caller asked for, not an error.
        conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
        Ok(())
    }
}

fn read_setting(row: &Row<'_>) -> rusqlite::Result<Setting> {
    let raw: String = row.get(1)?;
    let secret_ref: Option<String> = row.get(2)?;
    Ok(Setting {
        key: row.get(0)?,
        value: serde_json::from_str(&raw)
            .map_err(|error| to_sqlite_error(StoreError::from(error)))?,
        secret_ref: secret_ref
            .map(SecretRefName::new)
            .transpose()
            .map_err(to_sqlite_error)?,
        updated_at: Timestamp::from_millis(row.get(3)?),
    })
}

fn fetch_setting(conn: &Connection, key: &str) -> StoreResult<Option<Setting>> {
    conn.query_row(
        "SELECT key, value, secret_ref, updated_at FROM settings WHERE key = ?1",
        [key],
        read_setting,
    )
    .optional()
    .map_err(unwrap_store_error)
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

impl HasLocation for SqliteStore {
    fn location_description(&self) -> String {
        self.location.describe()
    }

    fn applied_schema_version(&self) -> StoreResult<u32> {
        let conn = self.connection();
        Ok(migrations::applied(&conn)?
            .keys()
            .next_back()
            .copied()
            .unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::SCHEMA_VERSION;
    use crate::repository::VelaStore;

    fn store() -> SqliteStore {
        SqliteStore::in_memory().expect("in-memory store opens")
    }

    fn conversation(store: &SqliteStore) -> ConversationId {
        store
            .create_conversation(NewConversation::titled("First light"))
            .unwrap()
            .id
    }

    // -- opening ------------------------------------------------------------

    #[test]
    fn opening_a_database_migrates_it_to_the_current_schema() {
        let store = store();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(store.describe_location().contains("in-memory"));
    }

    #[test]
    fn a_file_database_gets_wal_journalling_and_foreign_key_enforcement() {
        let dir = tempfile::tempdir().unwrap();
        let store = SqliteStore::open(DatabaseLocation::in_directory(dir.path())).unwrap();

        assert_eq!(store.journal_mode().unwrap().to_lowercase(), "wal");
        assert!(dir
            .path()
            .join(crate::location::DATABASE_FILE_NAME)
            .exists());

        let enabled: i64 = store
            .connection()
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(enabled, 1);
    }

    #[test]
    fn a_missing_application_data_directory_is_created_on_first_run() {
        let root = tempfile::tempdir().unwrap();
        let unborn = root.path().join("dev.vela.desktop");
        assert!(!unborn.exists());

        let store = SqliteStore::open(DatabaseLocation::in_directory(&unborn)).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(unborn.join(crate::location::DATABASE_FILE_NAME).is_file());
    }

    // -- conversations ------------------------------------------------------

    #[test]
    fn a_conversation_round_trips() {
        let store = store();
        let created = store
            .create_conversation(
                NewConversation::titled("Naming the ship").with_model("local-llamacpp", "qwen3-8b"),
            )
            .unwrap();

        let loaded = store.get_conversation(&created.id).unwrap();
        assert_eq!(loaded, created);
        assert_eq!(loaded.title, "Naming the ship");
        assert_eq!(loaded.provider_id.as_deref(), Some("local-llamacpp"));
        assert_eq!(loaded.message_count, 0);
        assert_eq!(loaded.last_message_at, None);
        assert!(!loaded.is_archived());
    }

    #[test]
    fn conversations_list_most_recently_updated_first_and_hide_archived_by_default() {
        let store = store();
        let first = store
            .create_conversation(NewConversation::titled("older"))
            .unwrap();
        let second = store
            .create_conversation(NewConversation::titled("newer"))
            .unwrap();

        let listed = store
            .list_conversations(ConversationQuery::default())
            .unwrap();
        assert_eq!(
            listed.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(),
            vec!["newer", "older"]
        );

        store
            .update_conversation(
                &second.id,
                ConversationPatch {
                    archived: Some(true),
                    ..ConversationPatch::default()
                },
            )
            .unwrap();

        let visible = store
            .list_conversations(ConversationQuery::default())
            .unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, first.id);

        let all = store
            .list_conversations(ConversationQuery::default().including_archived())
            .unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn a_conversation_can_be_filed_unfiled_and_listed_by_project() {
        let store = store();
        let project = store
            .create_project(NewProject::named("Star charts"))
            .unwrap();
        let filed = store
            .create_conversation(
                NewConversation::titled("in project").in_project(project.id.clone()),
            )
            .unwrap();
        let loose = store
            .create_conversation(NewConversation::titled("unfiled"))
            .unwrap();

        let in_project = store
            .list_conversations(ConversationQuery::in_project(project.id.clone()))
            .unwrap();
        assert_eq!(in_project.len(), 1);
        assert_eq!(in_project[0].id, filed.id);

        let unfiled = store
            .list_conversations(ConversationQuery {
                project: ProjectFilter::Unfiled,
                ..ConversationQuery::default()
            })
            .unwrap();
        assert_eq!(unfiled.len(), 1);
        assert_eq!(unfiled[0].id, loose.id);

        assert_eq!(
            store.get_project(&project.id).unwrap().conversation_count,
            1
        );
    }

    #[test]
    fn a_conversation_cannot_be_filed_under_a_project_that_does_not_exist() {
        let store = store();
        let ghost = ProjectId::new("proj_missing").unwrap();
        let error = store
            .create_conversation(NewConversation::titled("orphan").in_project(ghost))
            .unwrap_err();
        assert!(
            matches!(error, StoreError::Constraint { .. }),
            "got {error:?}"
        );
    }

    // -- messages -----------------------------------------------------------

    #[test]
    fn messages_are_appended_in_order_and_stamp_their_conversation() {
        let store = store();
        let chat = conversation(&store);

        let first = store
            .append_message(NewMessage::user(chat.clone(), "hello"))
            .unwrap();
        let second = store
            .append_message(NewMessage::assistant(
                chat.clone(),
                vec![ContentPart::text("hi")],
            ))
            .unwrap();

        assert_eq!(first.seq, 0);
        assert_eq!(second.seq, 1);

        let transcript = store.list_messages(&chat, MessageQuery::default()).unwrap();
        assert_eq!(transcript.len(), 2);
        assert_eq!(transcript[0].id, first.id);
        assert_eq!(transcript[1].id, second.id);

        let updated = store.get_conversation(&chat).unwrap();
        assert_eq!(updated.message_count, 2);
        assert_eq!(updated.last_message_at, Some(second.created_at));
        assert_eq!(updated.updated_at, second.created_at);
    }

    #[test]
    fn a_message_cannot_be_appended_to_a_conversation_that_does_not_exist() {
        let store = store();
        let ghost = ConversationId::new("conv_missing").unwrap();
        let error = store
            .append_message(NewMessage::user(ghost, "hello?"))
            .unwrap_err();
        assert!(
            matches!(
                error,
                StoreError::NotFound {
                    entity: "conversation",
                    ..
                }
            ),
            "got {error:?}"
        );
    }

    #[test]
    fn a_message_without_content_is_refused_before_any_row_is_written() {
        let store = store();
        let chat = conversation(&store);

        let error = store
            .append_message(NewMessage::new(chat.clone(), MessageRole::User))
            .unwrap_err();
        assert!(matches!(error, StoreError::Invalid { .. }), "got {error:?}");
        assert_eq!(store.get_conversation(&chat).unwrap().message_count, 0);
    }

    /// The load-bearing test for this crate: a model that emits `<think>`
    /// blocks must have them stored, retrievable, ordered, and never mixed
    /// into the answer.
    #[test]
    fn reasoning_is_stored_and_retrieved_distinctly_from_the_answer() {
        let store = store();
        let chat = conversation(&store);

        let written = store
            .append_message(
                NewMessage::assistant(
                    chat.clone(),
                    vec![
                        ContentPart::Reasoning {
                            text: "The user said Vela. Vela is a constellation, not the star Vega."
                                .into(),
                            signature: Some("sig-abc123".into()),
                            redacted: false,
                        },
                        ContentPart::text("Vela is a constellation in the southern sky."),
                        ContentPart::Reasoning {
                            text: "(withheld)".into(),
                            signature: None,
                            redacted: true,
                        },
                    ],
                )
                .with_model("local-llamacpp", "qwen3-8b")
                .with_usage(TokenUsage {
                    input_tokens: Some(31),
                    output_tokens: Some(64),
                    reasoning_tokens: Some(48),
                    cached_input_tokens: None,
                })
                .with_stop_reason(StopReason::EndTurn),
            )
            .unwrap();

        let loaded = store.get_message(&written.id).unwrap();

        // Ordering survives, part-for-part.
        assert_eq!(loaded.parts.len(), 3);
        assert_eq!(
            loaded.parts,
            vec![
                ContentPart::Reasoning {
                    text: "The user said Vela. Vela is a constellation, not the star Vega.".into(),
                    signature: Some("sig-abc123".into()),
                    redacted: false,
                },
                ContentPart::text("Vela is a constellation in the southern sky."),
                ContentPart::Reasoning {
                    text: "(withheld)".into(),
                    signature: None,
                    redacted: true,
                },
            ]
        );

        // The two channels stay separate.
        assert_eq!(
            loaded.answer_text(),
            "Vela is a constellation in the southern sky."
        );
        assert!(!loaded.answer_text().contains("Vega"));
        let reasoning = loaded.reasoning_text().unwrap();
        assert!(reasoning.contains("not the star Vega"));
        assert!(reasoning.contains("(withheld)"));

        // Signature and redaction round-trip: a backend that requires the
        // signature back verbatim must get it back verbatim.
        match &loaded.parts[0] {
            ContentPart::Reasoning {
                signature,
                redacted,
                ..
            } => {
                assert_eq!(signature.as_deref(), Some("sig-abc123"));
                assert!(!redacted);
            }
            other => panic!("expected reasoning, got {other:?}"),
        }
        assert!(matches!(
            &loaded.parts[2],
            ContentPart::Reasoning { redacted: true, .. }
        ));

        assert_eq!(loaded.usage.reasoning_tokens, Some(48));
        assert_eq!(loaded.stop_reason, Some(StopReason::EndTurn));
        assert_eq!(loaded.model_id.as_deref(), Some("qwen3-8b"));
    }

    #[test]
    fn a_transcript_can_be_loaded_without_reasoning_without_destroying_it() {
        let store = store();
        let chat = conversation(&store);
        let message = store
            .append_message(NewMessage::assistant(
                chat.clone(),
                vec![
                    ContentPart::reasoning("private thinking"),
                    ContentPart::text("public answer"),
                ],
            ))
            .unwrap();

        let for_the_model = store
            .list_messages(&chat, MessageQuery::without_reasoning())
            .unwrap();
        assert_eq!(
            for_the_model[0].parts,
            vec![ContentPart::text("public answer")]
        );
        assert!(!for_the_model[0].has_reasoning());

        // It is a projection, not a delete.
        let for_the_user = store.get_message(&message.id).unwrap();
        assert!(for_the_user.has_reasoning());
        assert_eq!(
            for_the_user.reasoning_text().as_deref(),
            Some("private thinking")
        );
    }

    #[test]
    fn tool_calls_and_results_round_trip_with_their_arguments() {
        let store = store();
        let chat = conversation(&store);

        let call = store
            .append_message(NewMessage::assistant(
                chat.clone(),
                vec![ContentPart::ToolCall {
                    call_id: "call_1".into(),
                    name: "read_file".into(),
                    arguments: serde_json::json!({ "path": "/etc/hosts", "lines": 20 }),
                }],
            ))
            .unwrap();
        let result = store
            .append_message(
                NewMessage::new(chat.clone(), MessageRole::Tool).with_parts(vec![
                    ContentPart::ToolResult {
                        call_id: "call_1".into(),
                        content: "127.0.0.1 localhost".into(),
                        is_error: false,
                    },
                ]),
            )
            .unwrap();

        let loaded_call = store.get_message(&call.id).unwrap();
        assert_eq!(loaded_call.tool_calls().len(), 1);
        match &loaded_call.parts[0] {
            ContentPart::ToolCall {
                name,
                arguments,
                call_id,
            } => {
                assert_eq!(name, "read_file");
                assert_eq!(call_id, "call_1");
                assert_eq!(arguments["path"], "/etc/hosts");
                assert_eq!(arguments["lines"], 20);
            }
            other => panic!("expected a tool call, got {other:?}"),
        }

        let loaded_result = store.get_message(&result.id).unwrap();
        assert_eq!(loaded_result.role, MessageRole::Tool);
        assert_eq!(
            loaded_result.parts,
            vec![ContentPart::ToolResult {
                call_id: "call_1".into(),
                content: "127.0.0.1 localhost".into(),
                is_error: false,
            }]
        );
        // A failed tool call is data, not an error.
        assert_eq!(loaded_result.status, MessageStatus::Complete);
    }

    #[test]
    fn an_image_part_round_trips_its_bytes_unchanged() {
        let store = store();
        let chat = conversation(&store);
        let png = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF];

        let written = store
            .append_message(NewMessage::new(chat, MessageRole::User).with_parts(vec![
                ContentPart::Image {
                    mime_type: "image/png".into(),
                    data: png.clone(),
                },
                ContentPart::text("what is this?"),
            ]))
            .unwrap();

        let loaded = store.get_message(&written.id).unwrap();
        assert_eq!(
            loaded.parts[0],
            ContentPart::Image {
                mime_type: "image/png".into(),
                data: png,
            }
        );
        assert_eq!(loaded.answer_text(), "what is this?");
    }

    #[test]
    fn finalising_a_streamed_message_replaces_its_parts_and_records_usage() {
        let store = store();
        let chat = conversation(&store);

        let streaming = store
            .append_message(
                NewMessage::assistant(chat.clone(), vec![ContentPart::text("")])
                    .with_status(MessageStatus::Streaming),
            )
            .unwrap();
        assert_eq!(streaming.status, MessageStatus::Streaming);

        let finished = store
            .update_message(
                &streaming.id,
                MessagePatch {
                    parts: Some(vec![
                        ContentPart::reasoning("checking the ephemeris"),
                        ContentPart::text("Canopus is in Carina, not Vela."),
                    ]),
                    status: Some(MessageStatus::Complete),
                    usage: Some(TokenUsage {
                        input_tokens: Some(12),
                        output_tokens: Some(20),
                        ..TokenUsage::default()
                    }),
                    stop_reason: Some(Some(StopReason::EndTurn)),
                    error_message: None,
                },
            )
            .unwrap();

        assert_eq!(finished.status, MessageStatus::Complete);
        assert_eq!(finished.parts.len(), 2);
        assert_eq!(finished.answer_text(), "Canopus is in Carina, not Vela.");
        assert_eq!(finished.usage.output_tokens, Some(20));
        assert_eq!(finished.stop_reason, Some(StopReason::EndTurn));
        assert!(finished.updated_at.as_millis() > finished.created_at.as_millis());
        assert_eq!(
            finished.seq, streaming.seq,
            "finalising must not move the turn"
        );

        // No orphan parts left behind by the replacement.
        let parts: i64 = store
            .connection()
            .query_row(
                "SELECT count(*) FROM message_parts WHERE message_id = ?1",
                [finished.id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parts, 2);
    }

    #[test]
    fn a_cancelled_turn_keeps_what_arrived_and_says_why_it_stopped() {
        let store = store();
        let chat = conversation(&store);
        let message = store
            .append_message(
                NewMessage::assistant(chat, vec![ContentPart::text("half an ans")])
                    .with_status(MessageStatus::Streaming),
            )
            .unwrap();

        let stopped = store
            .update_message(
                &message.id,
                MessagePatch {
                    status: Some(MessageStatus::Cancelled),
                    stop_reason: Some(Some(StopReason::Cancelled)),
                    ..MessagePatch::default()
                },
            )
            .unwrap();

        assert_eq!(stopped.status, MessageStatus::Cancelled);
        assert_eq!(stopped.answer_text(), "half an ans");
    }

    // -- usage accounting ---------------------------------------------------

    #[test]
    fn usage_totals_add_up_and_admit_what_was_never_reported() {
        let store = store();
        let chat = conversation(&store);

        store
            .append_message(NewMessage::user(chat.clone(), "hello"))
            .unwrap();
        store
            .append_message(
                NewMessage::assistant(chat.clone(), vec![ContentPart::text("hi")]).with_usage(
                    TokenUsage {
                        input_tokens: Some(10),
                        output_tokens: Some(5),
                        reasoning_tokens: Some(2),
                        cached_input_tokens: Some(8),
                    },
                ),
            )
            .unwrap();
        store
            .append_message(
                NewMessage::assistant(chat.clone(), vec![ContentPart::text("more")]).with_usage(
                    TokenUsage {
                        input_tokens: Some(20),
                        output_tokens: Some(7),
                        ..TokenUsage::default()
                    },
                ),
            )
            .unwrap();

        let totals = store.conversation_usage(&chat).unwrap();
        assert_eq!(totals.input_tokens, 30);
        assert_eq!(totals.output_tokens, 12);
        assert_eq!(totals.reasoning_tokens, 2);
        assert_eq!(totals.cached_input_tokens, 8);
        assert_eq!(totals.message_count, 3);
        assert_eq!(totals.total_tokens(), 42);
        // The user message reported nothing — which is the normal case for a
        // local endpoint, and must be visible rather than papered over.
        assert_eq!(totals.messages_without_usage, 1);
        assert!(totals.is_partial());
    }

    // -- title search -------------------------------------------------------

    #[test]
    fn searching_titles_finds_a_conversation_the_content_index_cannot() {
        let store = store();
        let named = store
            .create_conversation(NewConversation::titled("Rendering notes"))
            .unwrap();
        store
            .append_message(NewMessage::user(named.id.clone(), "how do sails work"))
            .unwrap();

        // The words of the title appear nowhere in the transcript, so the FTS
        // index — which only covers content — cannot answer this.
        assert!(store.search_messages("Rendering", 10).unwrap().is_empty());
        let hits = store.search_conversations("rendering", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, named.id);
    }

    #[test]
    fn title_search_matches_a_substring_case_insensitively_and_orders_by_recency() {
        let store = store();
        let older = store
            .create_conversation(NewConversation::titled("Star charts"))
            .unwrap();
        let newer = store
            .create_conversation(NewConversation::titled("CHARTING the sails"))
            .unwrap();
        // `update_conversation` restamps `updated_at`, which is what the order
        // is keyed on.
        store
            .update_conversation(
                &newer.id,
                ConversationPatch {
                    title: Some("CHARTING the sails".into()),
                    ..ConversationPatch::default()
                },
            )
            .unwrap();

        let hits = store.search_conversations("chart", 10).unwrap();
        assert_eq!(
            hits.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec![newer.id.as_str(), older.id.as_str()]
        );
    }

    #[test]
    fn title_search_treats_like_metacharacters_as_literal_text() {
        let store = store();
        let literal = store
            .create_conversation(NewConversation::titled("Down to 100% context"))
            .unwrap();
        store
            .create_conversation(NewConversation::titled("Down to 1000 tokens"))
            .unwrap();

        // Under `LIKE`, `100%` matches "1000 tokens" too. It must not.
        let hits = store.search_conversations("100%", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, literal.id);

        // `_` is LIKE's single-character wildcard; here it is just a character.
        store
            .create_conversation(NewConversation::titled("a_b"))
            .unwrap();
        store
            .create_conversation(NewConversation::titled("axb"))
            .unwrap();
        let underscore = store.search_conversations("a_b", 10).unwrap();
        assert_eq!(underscore.len(), 1);
        assert_eq!(underscore[0].title, "a_b");
    }

    #[test]
    fn title_search_hides_archived_conversations_and_rejects_a_blank_query() {
        let store = store();
        let chat = store
            .create_conversation(NewConversation::titled("Archived charts"))
            .unwrap();
        store
            .update_conversation(
                &chat.id,
                ConversationPatch {
                    archived: Some(true),
                    ..ConversationPatch::default()
                },
            )
            .unwrap();

        assert!(store.search_conversations("charts", 10).unwrap().is_empty());
        assert!(matches!(
            store.search_conversations("   ", 10),
            Err(StoreError::Invalid { .. })
        ));
    }

    #[test]
    fn title_search_honours_its_limit() {
        let store = store();
        for index in 0..5 {
            store
                .create_conversation(NewConversation::titled(format!("chart {index}")))
                .unwrap();
        }
        assert_eq!(store.search_conversations("chart", 2).unwrap().len(), 2);
    }

    // -- deletion and referential integrity ---------------------------------

    #[test]
    fn deleting_a_conversation_takes_its_messages_parts_and_search_rows_with_it() {
        let store = store();
        let chat = conversation(&store);
        store
            .append_message(NewMessage::assistant(
                chat.clone(),
                vec![
                    ContentPart::reasoning("thinking about parallax"),
                    ContentPart::text("Canopus is 310 light years away."),
                ],
            ))
            .unwrap();

        assert_eq!(store.search_messages("parallax", 10).unwrap().len(), 1);

        store.delete_conversation(&chat).unwrap();

        let connection = store.connection();
        for table in ["messages", "message_parts", "message_search"] {
            let remaining: i64 = connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(remaining, 0, "`{table}` still holds rows after the cascade");
        }
        drop(connection);

        assert!(matches!(
            store.get_conversation(&chat),
            Err(StoreError::NotFound { .. })
        ));
    }

    #[test]
    fn deleting_a_message_leaves_the_rest_of_the_transcript_intact() {
        let store = store();
        let chat = conversation(&store);
        let first = store
            .append_message(NewMessage::user(chat.clone(), "one"))
            .unwrap();
        let second = store
            .append_message(NewMessage::user(chat.clone(), "two"))
            .unwrap();

        store.delete_message(&first.id).unwrap();

        let remaining = store.list_messages(&chat, MessageQuery::default()).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, second.id);
        assert!(matches!(
            store.delete_message(&first.id),
            Err(StoreError::NotFound {
                entity: "message",
                ..
            })
        ));
    }

    #[test]
    fn deleting_a_project_unfiles_its_conversations_instead_of_destroying_them() {
        let store = store();
        let project = store.create_project(NewProject::named("Sails")).unwrap();
        let chat = store
            .create_conversation(NewConversation::titled("keep me").in_project(project.id.clone()))
            .unwrap();

        store.delete_project(&project.id).unwrap();

        let survivor = store.get_conversation(&chat.id).unwrap();
        assert_eq!(survivor.project_id, None);
        assert!(matches!(
            store.get_project(&project.id),
            Err(StoreError::NotFound {
                entity: "project",
                ..
            })
        ));
    }

    // -- projects -----------------------------------------------------------

    #[test]
    fn a_project_round_trips_and_can_be_renamed_and_archived() {
        let store = store();
        let created = store
            .create_project(NewProject {
                name: "Navigation".into(),
                description: Some("route planning".into()),
                system_prompt: Some("Answer like a navigator.".into()),
            })
            .unwrap();

        assert_eq!(created.name, "Navigation");
        assert_eq!(
            created.system_prompt.as_deref(),
            Some("Answer like a navigator.")
        );

        let renamed = store
            .update_project(
                &created.id,
                ProjectPatch {
                    name: Some("Celestial navigation".into()),
                    description: Some(None),
                    ..ProjectPatch::default()
                },
            )
            .unwrap();
        assert_eq!(renamed.name, "Celestial navigation");
        assert_eq!(renamed.description, None);
        assert!(renamed.updated_at.as_millis() > created.updated_at.as_millis());

        store
            .update_project(
                &created.id,
                ProjectPatch {
                    archived: Some(true),
                    ..ProjectPatch::default()
                },
            )
            .unwrap();
        assert!(store.list_projects(false).unwrap().is_empty());
        assert_eq!(store.list_projects(true).unwrap().len(), 1);
    }

    #[test]
    fn a_project_must_have_a_name() {
        let store = store();
        assert!(matches!(
            store.create_project(NewProject::named("   ")),
            Err(StoreError::Invalid { .. })
        ));
        let project = store.create_project(NewProject::named("ok")).unwrap();
        assert!(matches!(
            store.update_project(
                &project.id,
                ProjectPatch {
                    name: Some(String::new()),
                    ..ProjectPatch::default()
                }
            ),
            Err(StoreError::Invalid { .. })
        ));
    }

    // -- search -------------------------------------------------------------

    #[test]
    fn search_finds_answers_and_labels_reasoning_hits_as_reasoning() {
        let store = store();
        let chat = store
            .create_conversation(NewConversation::titled("Southern sky"))
            .unwrap()
            .id;
        store
            .append_message(NewMessage::user(chat.clone(), "tell me about Canopus"))
            .unwrap();
        store
            .append_message(NewMessage::assistant(
                chat.clone(),
                vec![
                    ContentPart::reasoning("Canopus sits in Carina; the user asked about Vela"),
                    ContentPart::text("Canopus is the brightest star in Carina."),
                ],
            ))
            .unwrap();

        let hits = store.search_messages("Carina", 10).unwrap();
        assert_eq!(hits.len(), 2, "one hit in the answer, one in the reasoning");
        assert!(hits.iter().any(|h| h.kind == SearchHitKind::Reasoning));
        assert!(hits.iter().any(|h| h.kind == SearchHitKind::Answer));
        assert!(hits.iter().all(|h| h.conversation_id == chat));
        assert!(hits.iter().all(|h| h.conversation_title == "Southern sky"));
        assert!(hits.iter().any(|h| h.snippet.contains("[Carina]")));

        assert!(store.search_messages("Betelgeuse", 10).unwrap().is_empty());
    }

    #[test]
    fn editing_a_message_updates_what_search_can_find() {
        let store = store();
        let chat = conversation(&store);
        let message = store
            .append_message(NewMessage::assistant(
                chat,
                vec![ContentPart::text("the answer mentions Sirius")],
            ))
            .unwrap();
        assert_eq!(store.search_messages("Sirius", 10).unwrap().len(), 1);

        store
            .update_message(
                &message.id,
                MessagePatch {
                    parts: Some(vec![ContentPart::text("corrected: it is Canopus")]),
                    ..MessagePatch::default()
                },
            )
            .unwrap();

        assert!(store.search_messages("Sirius", 10).unwrap().is_empty());
        assert_eq!(store.search_messages("Canopus", 10).unwrap().len(), 1);
    }

    #[test]
    fn a_malformed_search_expression_is_a_user_error_not_a_crash() {
        let store = store();
        assert!(matches!(
            store.search_messages("   ", 10),
            Err(StoreError::Invalid { .. })
        ));
        let error = store.search_messages("\"unbalanced", 10).unwrap_err();
        assert!(matches!(error, StoreError::Invalid { .. }), "got {error:?}");
    }

    // -- settings -----------------------------------------------------------

    #[test]
    fn settings_round_trip_and_overwrite_by_key() {
        let store = store();
        store
            .put_setting(SettingEntry::new(
                "appearance.theme",
                serde_json::json!("dark"),
            ))
            .unwrap();
        store
            .put_setting(SettingEntry::new(
                "appearance.density",
                serde_json::json!({ "compact": true }),
            ))
            .unwrap();

        let theme = store.get_setting("appearance.theme").unwrap().unwrap();
        assert_eq!(theme.value, serde_json::json!("dark"));

        let replaced = store
            .put_setting(SettingEntry::new(
                "appearance.theme",
                serde_json::json!("light"),
            ))
            .unwrap();
        assert_eq!(replaced.value, serde_json::json!("light"));
        assert!(replaced.updated_at.as_millis() > theme.updated_at.as_millis());

        let listed = store.list_settings("appearance.").unwrap();
        assert_eq!(
            listed.iter().map(|s| s.key.as_str()).collect::<Vec<_>>(),
            vec!["appearance.density", "appearance.theme"]
        );

        store.delete_setting("appearance.theme").unwrap();
        assert!(store.get_setting("appearance.theme").unwrap().is_none());
        // Deleting what is already gone is the state the caller asked for.
        store.delete_setting("appearance.theme").unwrap();
        assert!(store.get_setting("never.written").unwrap().is_none());
    }

    #[test]
    fn a_setting_may_name_a_keychain_entry_but_never_carry_its_value() {
        let store = store();
        let reference = vela_core::secret::SecretRef::primary("acme-hosted").unwrap();

        let stored = store
            .put_setting(
                SettingEntry::new(
                    "provider.acme-hosted.endpoint",
                    serde_json::json!({ "baseUrl": "https://api.example.test/v1" }),
                )
                .referencing_secret(SecretRefName::from_secret_ref(&reference)),
            )
            .unwrap();

        assert_eq!(
            stored.secret_ref.as_ref().map(SecretRefName::as_str),
            Some("acme-hosted/primary")
        );

        // What actually landed on disk is the keychain entry's *name*.
        let raw: String = store
            .connection()
            .query_row(
                "SELECT secret_ref || '|' || value FROM settings WHERE key = ?1",
                ["provider.acme-hosted.endpoint"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            raw,
            "acme-hosted/primary|{\"baseUrl\":\"https://api.example.test/v1\"}"
        );
    }

    /// Structural guard: rule 0.4 says credentials never touch the disk. This
    /// asserts it of the live schema, not just of the migration text.
    #[test]
    fn no_table_in_the_live_schema_has_a_column_that_could_hold_a_credential() {
        let store = store();
        let connection = store.connection();

        let mut tables = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .unwrap();
        let names: Vec<String> = tables
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        drop(tables);

        const FORBIDDEN: &[&str] = &[
            "secret_value",
            "api_key",
            "apikey",
            "password",
            "passphrase",
            "access_token",
            "refresh_token",
            "credential",
        ];

        for table in names {
            let mut columns = connection
                .prepare(&format!("PRAGMA table_info('{table}')"))
                .unwrap();
            let column_names: Vec<String> = columns
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            for column in column_names {
                let lowered = column.to_lowercase();
                for needle in FORBIDDEN {
                    assert!(
                        !lowered.contains(needle),
                        "`{table}.{column}` looks like it could hold a credential; \
                         credentials live in the OS keychain and settings reference one by name"
                    );
                }
            }
        }
    }

    #[test]
    fn a_blank_setting_key_is_rejected() {
        let store = store();
        assert!(matches!(
            store.put_setting(SettingEntry::new("  ", serde_json::json!(1))),
            Err(StoreError::Invalid { .. })
        ));
    }

    // -- not found ----------------------------------------------------------

    #[test]
    fn addressing_something_that_does_not_exist_reports_not_found() {
        let store = store();
        assert!(matches!(
            store.get_conversation(&ConversationId::new("conv_nope").unwrap()),
            Err(StoreError::NotFound {
                entity: "conversation",
                ..
            })
        ));
        assert!(matches!(
            store.get_message(&MessageId::new("msg_nope").unwrap()),
            Err(StoreError::NotFound {
                entity: "message",
                ..
            })
        ));
        assert!(matches!(
            store.get_project(&ProjectId::new("proj_nope").unwrap()),
            Err(StoreError::NotFound {
                entity: "project",
                ..
            })
        ));
        assert!(matches!(
            store.list_messages(
                &ConversationId::new("conv_nope").unwrap(),
                MessageQuery::default()
            ),
            Err(StoreError::NotFound { .. })
        ));
    }

    // -- pagination ---------------------------------------------------------

    #[test]
    fn a_long_transcript_can_be_loaded_incrementally() {
        let store = store();
        let chat = conversation(&store);
        for index in 0..10 {
            store
                .append_message(NewMessage::user(chat.clone(), format!("message {index}")))
                .unwrap();
        }

        let first_page = store
            .list_messages(&chat, MessageQuery::default().limited(4))
            .unwrap();
        assert_eq!(first_page.len(), 4);
        assert_eq!(first_page[0].seq, 0);

        let last = first_page.last().unwrap().seq;
        let second_page = store
            .list_messages(&chat, MessageQuery::default().after(last).limited(4))
            .unwrap();
        assert_eq!(second_page.len(), 4);
        assert_eq!(second_page[0].seq, 4);

        let listed = store
            .list_conversations(ConversationQuery::default().limited(1))
            .unwrap();
        assert_eq!(listed.len(), 1);
    }

    // -- memory -------------------------------------------------------------

    fn remember(store: &SqliteStore, scope: MemoryScope, content: &str) -> MemoryEntry {
        store
            .create_memory_entry(NewMemoryEntry::new(
                scope,
                MemoryCategory::TechPrefs,
                content,
            ))
            .unwrap()
    }

    #[test]
    fn a_memory_entry_round_trips_with_its_provenance() {
        let store = store();
        let chat = conversation(&store);
        let written = store
            .create_memory_entry(
                NewMemoryEntry::new(
                    MemoryScope::Global,
                    MemoryCategory::TechPrefs,
                    "  uses pnpm, never npm  ",
                )
                .from_conversation(chat.clone()),
            )
            .unwrap();

        assert_eq!(
            written.content, "uses pnpm, never npm",
            "content is trimmed"
        );
        assert_eq!(written.scope, MemoryScope::Global);
        assert!(!written.pinned);
        assert_eq!(written.source_conversation_id, Some(chat));

        let read_back = store.get_memory_entry(&written.id).unwrap();
        assert_eq!(read_back, written);
    }

    /// MEM-2's only claim, and the reason [`MemoryRepository`] has no
    /// list-everything method.
    #[test]
    fn project_memory_and_global_memory_never_see_each_other() {
        let store = store();
        let alpha = store.create_project(NewProject::named("Alpha")).unwrap().id;
        let beta = store.create_project(NewProject::named("Beta")).unwrap().id;

        remember(&store, MemoryScope::Global, "global fact");
        remember(&store, MemoryScope::project(alpha.clone()), "alpha fact");
        remember(&store, MemoryScope::project(beta.clone()), "beta fact");

        let global = store.list_memory_entries(&MemoryScope::Global).unwrap();
        assert_eq!(
            global.iter().map(|e| &e.content).collect::<Vec<_>>(),
            vec!["global fact"],
        );

        let in_alpha = store
            .list_memory_entries(&MemoryScope::project(alpha))
            .unwrap();
        assert_eq!(
            in_alpha.iter().map(|e| &e.content).collect::<Vec<_>>(),
            vec!["alpha fact"],
        );

        let in_beta = store
            .list_memory_entries(&MemoryScope::project(beta))
            .unwrap();
        assert_eq!(
            in_beta.iter().map(|e| &e.content).collect::<Vec<_>>(),
            vec!["beta fact"],
        );
    }

    /// The order MEM-1 specifies for injection: pinned first, then recency.
    /// Taking the first N under a budget must take the right N.
    #[test]
    fn listing_puts_pinned_entries_first_then_the_most_recently_updated() {
        let store = store();
        let oldest = remember(&store, MemoryScope::Global, "oldest");
        let middle = remember(&store, MemoryScope::Global, "middle");
        let newest = remember(&store, MemoryScope::Global, "newest");

        store
            .update_memory_entry(
                &oldest.id,
                MemoryPatch {
                    pinned: Some(true),
                    ..MemoryPatch::default()
                },
            )
            .unwrap();

        let listed = store.list_memory_entries(&MemoryScope::Global).unwrap();
        assert_eq!(
            listed.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec![oldest.id.as_str(), newest.id.as_str(), middle.id.as_str()],
        );
    }

    #[test]
    fn an_entry_with_no_content_is_refused_on_write_and_on_amendment() {
        let store = store();
        assert!(matches!(
            store.create_memory_entry(NewMemoryEntry::new(
                MemoryScope::Global,
                MemoryCategory::Other,
                "   ",
            )),
            Err(StoreError::Invalid { .. }),
        ));

        let entry = remember(&store, MemoryScope::Global, "real");
        assert!(matches!(
            store.update_memory_entry(
                &entry.id,
                MemoryPatch {
                    content: Some("  ".into()),
                    ..MemoryPatch::default()
                },
            ),
            Err(StoreError::Invalid { .. }),
        ));
        assert_eq!(store.get_memory_entry(&entry.id).unwrap().content, "real");
    }

    /// Per-scope reset: the thing the reference's all-or-nothing wipe cannot do.
    #[test]
    fn clearing_one_scope_leaves_every_other_scope_intact() {
        let store = store();
        let project = store.create_project(NewProject::named("Alpha")).unwrap().id;
        remember(&store, MemoryScope::Global, "global fact");
        remember(&store, MemoryScope::project(project.clone()), "one");
        remember(&store, MemoryScope::project(project.clone()), "two");

        let removed = store
            .clear_memory_scope(&MemoryScope::project(project.clone()))
            .unwrap();
        assert_eq!(removed, 2);
        assert!(store
            .list_memory_entries(&MemoryScope::project(project))
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .list_memory_entries(&MemoryScope::Global)
                .unwrap()
                .len(),
            1,
        );
    }

    /// The cascade `0003_memory.sql` argues for: an entry whose project is gone
    /// is a row no scope can ever list, so it must not survive the project.
    #[test]
    fn deleting_a_project_takes_its_memory_and_leaves_global_memory_alone() {
        let store = store();
        let project = store.create_project(NewProject::named("Alpha")).unwrap().id;
        remember(&store, MemoryScope::Global, "global fact");
        let doomed = remember(&store, MemoryScope::project(project.clone()), "alpha fact");

        store.delete_project(&project).unwrap();

        assert!(matches!(
            store.get_memory_entry(&doomed.id),
            Err(StoreError::NotFound { .. }),
        ));
        assert_eq!(
            store
                .list_memory_entries(&MemoryScope::Global)
                .unwrap()
                .len(),
            1,
        );
    }

    /// Provenance survives the conversation it came from. Deleting the chat
    /// does not make the fact untrue, so the entry stays and only loses its
    /// pointer.
    #[test]
    fn deleting_the_source_conversation_keeps_the_entry_and_drops_the_pointer() {
        let store = store();
        let chat = conversation(&store);
        let entry = store
            .create_memory_entry(
                NewMemoryEntry::new(MemoryScope::Global, MemoryCategory::CommsPrefs, "terse")
                    .from_conversation(chat.clone()),
            )
            .unwrap();

        store.delete_conversation(&chat).unwrap();

        let read_back = store.get_memory_entry(&entry.id).unwrap();
        assert_eq!(read_back.content, "terse");
        assert_eq!(read_back.source_conversation_id, None);
    }

    #[test]
    fn deleting_an_entry_that_is_not_there_is_not_found_rather_than_silence() {
        let store = store();
        let missing = MemoryEntryId::new("mem_nope").unwrap();
        assert!(matches!(
            store.delete_memory_entry(&missing),
            Err(StoreError::NotFound { .. }),
        ));
    }
}
