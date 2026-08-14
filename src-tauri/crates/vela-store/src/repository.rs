//! The repository interface — the only way anything outside this crate reaches
//! stored data.
//!
//! SQL does not leave [`crate::sqlite`]. Callers depend on these traits, not on
//! a connection, which is what lets the IPC layer be tested against an
//! in-memory database and lets the storage engine be replaced without touching
//! a single call site.
//!
//! Everything is synchronous. SQLite writes are fast, local and serialised by a
//! single connection; wrapping them in `async` would add an executor
//! requirement to a crate that has no I/O wait to hide.

use crate::error::StoreResult;
use crate::model::{
    Conversation, ConversationId, ConversationPatch, MemoryEntry, MemoryEntryId, MemoryPatch,
    MemoryScope, Message, MessageId, MessagePatch, NewConversation, NewMemoryEntry, NewMessage,
    NewProject, Project, ProjectId, ProjectPatch, Setting, SettingEntry, Timestamp,
};

/// Which project's conversations to list.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum ProjectFilter {
    /// Every conversation, filed or not.
    #[default]
    Any,
    /// Only conversations that are not filed under any project.
    Unfiled,
    Only(ProjectId),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConversationQuery {
    pub project: ProjectFilter,
    /// Archived conversations are hidden by default — archiving is the user
    /// saying "not now", and a list that ignores it is a list that lies.
    pub include_archived: bool,
    pub limit: Option<u32>,
    pub offset: u32,
}

impl ConversationQuery {
    pub fn in_project(project_id: ProjectId) -> Self {
        Self {
            project: ProjectFilter::Only(project_id),
            ..Self::default()
        }
    }

    pub fn including_archived(mut self) -> Self {
        self.include_archived = true;
        self
    }

    pub fn limited(mut self, limit: u32) -> Self {
        self.limit = Some(limit);
        self
    }
}

/// How much of a transcript to load.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageQuery {
    /// When false, reasoning parts are left out of the loaded messages. This is
    /// the query the "rebuild the prompt" path uses: reasoning is stored, but
    /// replaying another model's thinking back at a model is usually wrong.
    /// It is a projection, never a delete.
    pub include_reasoning: bool,
    /// Only messages after this position. Drives incremental loading.
    pub after_seq: Option<i64>,
    pub limit: Option<u32>,
}

impl Default for MessageQuery {
    fn default() -> Self {
        Self {
            include_reasoning: true,
            after_seq: None,
            limit: None,
        }
    }
}

impl MessageQuery {
    /// The transcript as it would be re-sent to a model: no reasoning.
    pub fn without_reasoning() -> Self {
        Self {
            include_reasoning: false,
            ..Self::default()
        }
    }

    pub fn after(mut self, seq: i64) -> Self {
        self.after_seq = Some(seq);
        self
    }

    pub fn limited(mut self, limit: u32) -> Self {
        self.limit = Some(limit);
        self
    }
}

/// Rolled-up token accounting for a conversation.
///
/// `messages_without_usage` is reported rather than hidden: most local runtimes
/// report nothing, and a total of "1,204 tokens" over a conversation where nine
/// of eleven turns reported nothing would be a fabrication.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UsageTotals {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub cached_input_tokens: i64,
    pub message_count: i64,
    pub messages_without_usage: i64,
}

impl UsageTotals {
    pub fn total_tokens(&self) -> i64 {
        self.input_tokens + self.output_tokens
    }

    /// True when at least one message contributed no numbers, i.e. the totals
    /// are a floor rather than the whole story.
    pub fn is_partial(&self) -> bool {
        self.messages_without_usage > 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchHitKind {
    /// The match is in the model's answer or the user's text.
    Answer,
    /// The match is inside a reasoning block. Surfaced distinctly so the UI can
    /// say where it came from instead of quoting private thinking as an answer.
    Reasoning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub message_id: MessageId,
    pub conversation_id: ConversationId,
    pub conversation_title: String,
    pub kind: SearchHitKind,
    /// Matched text with the hit delimited by `[` and `]`.
    pub snippet: String,
    pub created_at: Timestamp,
}

pub trait ProjectRepository {
    fn create_project(&self, input: NewProject) -> StoreResult<Project>;
    fn get_project(&self, id: &ProjectId) -> StoreResult<Project>;
    fn list_projects(&self, include_archived: bool) -> StoreResult<Vec<Project>>;
    fn update_project(&self, id: &ProjectId, patch: ProjectPatch) -> StoreResult<Project>;
    /// Deleting a project **unfiles** its conversations; it never deletes them.
    fn delete_project(&self, id: &ProjectId) -> StoreResult<()>;
}

pub trait ConversationRepository {
    fn create_conversation(&self, input: NewConversation) -> StoreResult<Conversation>;
    fn get_conversation(&self, id: &ConversationId) -> StoreResult<Conversation>;
    fn list_conversations(&self, query: ConversationQuery) -> StoreResult<Vec<Conversation>>;
    /// Case-insensitive substring match on the **title**, most recently touched
    /// first.
    ///
    /// This exists because [`MessageRepository::search_messages`] cannot answer
    /// the commonest question a sidebar asks. The FTS index covers message
    /// content only, so a conversation the user named "Rendering notes" and
    /// never typed those words into is invisible to a content search. Searching
    /// both and merging is the caller's job; producing each half honestly is
    /// this layer's.
    ///
    /// A blank query is [`crate::StoreError::Invalid`], matching
    /// `search_messages` — "match everything" is what `list_conversations` is
    /// for. Folding is SQLite's ASCII `lower()`: it is not Unicode-aware, and
    /// pretending otherwise in the doc comment would be worse than the limit.
    fn search_conversations(&self, query: &str, limit: u32) -> StoreResult<Vec<Conversation>>;
    fn update_conversation(
        &self,
        id: &ConversationId,
        patch: ConversationPatch,
    ) -> StoreResult<Conversation>;
    /// Deletes the conversation and, by cascade, its messages, their parts and
    /// their search index entries.
    fn delete_conversation(&self, id: &ConversationId) -> StoreResult<()>;
}

pub trait MessageRepository {
    /// Appends a message at the end of its conversation, assigning `seq`,
    /// stamping the times, and bumping the conversation's `updated_at` /
    /// `last_message_at` — all in one transaction.
    fn append_message(&self, input: NewMessage) -> StoreResult<Message>;
    fn get_message(&self, id: &MessageId) -> StoreResult<Message>;
    fn list_messages(
        &self,
        conversation_id: &ConversationId,
        query: MessageQuery,
    ) -> StoreResult<Vec<Message>>;
    /// Applies a partial update. Supplying `parts` replaces the whole part
    /// list, which is how a streamed turn is finalised.
    fn update_message(&self, id: &MessageId, patch: MessagePatch) -> StoreResult<Message>;
    fn delete_message(&self, id: &MessageId) -> StoreResult<()>;
    fn conversation_usage(&self, conversation_id: &ConversationId) -> StoreResult<UsageTotals>;
    /// Local full-text search. `query` is FTS5 syntax; a malformed query is a
    /// [`crate::StoreError::Invalid`], never a panic.
    fn search_messages(&self, query: &str, limit: u32) -> StoreResult<Vec<SearchHit>>;
}

/// Durable, categorised facts, partitioned by [`MemoryScope`].
///
/// The one rule this trait exists to keep is MEM-2's: **a read of one scope
/// never returns an entry from another.** Every method below takes the scope or
/// an id, and there is deliberately no "list everything" method — a caller that
/// could ask for all entries would sooner or later render them together, which
/// is the leak. Export across scopes is a feature that has to be written
/// deliberately, not one that falls out of a convenience method.
///
/// `sqlite::tests::project_memory_and_global_memory_never_see_each_other` is
/// what makes the previous paragraph true rather than aspirational.
pub trait MemoryRepository {
    fn create_memory_entry(&self, input: NewMemoryEntry) -> StoreResult<MemoryEntry>;
    fn get_memory_entry(&self, id: &MemoryEntryId) -> StoreResult<MemoryEntry>;
    /// One scope's entries, **pinned first, then most recently updated first**.
    ///
    /// The order is the injection order MEM-1 specifies (pinned > recency), so
    /// a caller that takes the first N under a budget takes the right N without
    /// re-sorting. Embedding similarity, the third term in that rule, is not
    /// implemented anywhere in Vela and is not applied here.
    fn list_memory_entries(&self, scope: &MemoryScope) -> StoreResult<Vec<MemoryEntry>>;
    fn update_memory_entry(
        &self,
        id: &MemoryEntryId,
        patch: MemoryPatch,
    ) -> StoreResult<MemoryEntry>;
    fn delete_memory_entry(&self, id: &MemoryEntryId) -> StoreResult<()>;
    /// Empties one scope and reports how many rows went.
    ///
    /// The per-scope reset the reference does not have: its Reset "permanently
    /// deletes all memories including project memories", which forces a user
    /// who wants to forget one project into an all-or-nothing wipe.
    fn clear_memory_scope(&self, scope: &MemoryScope) -> StoreResult<u64>;
}

pub trait SettingsRepository {
    /// Insert or replace. The value is arbitrary JSON and must never be a
    /// credential — pass a [`crate::model::SecretRefName`] instead.
    fn put_setting(&self, entry: SettingEntry) -> StoreResult<Setting>;
    fn get_setting(&self, key: &str) -> StoreResult<Option<Setting>>;
    /// All settings whose key starts with `prefix` (pass `""` for all), sorted
    /// by key so the caller gets a stable order.
    fn list_settings(&self, prefix: &str) -> StoreResult<Vec<Setting>>;
    fn delete_setting(&self, key: &str) -> StoreResult<()>;
}

/// The whole system of record in one object. `AppState` holds an
/// `Arc<dyn VelaStore>`, so the host, the IPC layer and tests all depend on
/// this trait rather than on SQLite.
pub trait VelaStore:
    ProjectRepository
    + ConversationRepository
    + MessageRepository
    + MemoryRepository
    + SettingsRepository
    + Send
    + Sync
{
    /// Which database is actually live, for honest diagnostics — the same
    /// reason `app_info.secretBackend` exists. Returns
    /// `"in-memory (not persisted)"` for a test database, so a screenshot can
    /// never be mistaken for evidence of persistence.
    fn describe_location(&self) -> String;

    /// The schema version currently applied to this database.
    fn schema_version(&self) -> StoreResult<u32>;
}

impl<T> VelaStore for T
where
    T: ProjectRepository
        + ConversationRepository
        + MessageRepository
        + MemoryRepository
        + SettingsRepository
        + Send
        + Sync
        + HasLocation,
{
    fn describe_location(&self) -> String {
        self.location_description()
    }

    fn schema_version(&self) -> StoreResult<u32> {
        self.applied_schema_version()
    }
}

/// Implementation detail of the blanket [`VelaStore`] impl: it lets a concrete
/// store provide its diagnostics without every caller re-implementing the
/// aggregate trait.
pub trait HasLocation {
    fn location_description(&self) -> String;
    fn applied_schema_version(&self) -> StoreResult<u32>;
}
