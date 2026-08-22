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
    NewProject, NewSchedule, Project, ProjectId, ProjectPatch, RunTrigger, Schedule, ScheduleId,
    SchedulePatch, ScheduleRun, ScheduleRunId, ScheduleRunOutcome, Setting, SettingEntry,
    Timestamp,
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
    /// Deletes a project after moving every conversation filed under it to
    /// `reassign_to`, **in one transaction**, and answers with how many moved.
    ///
    /// This exists beside [`ProjectRepository::delete_project`] rather than
    /// replacing it because the two answer different questions. Plain deletion
    /// leans on the schema's `ON DELETE SET NULL` and leaves conversations
    /// unfiled, which is a complete state for a store whose project column is
    /// nullable. The command layer's contract is stricter — there is always a
    /// default project and conversations are reassigned to it, so "loose" and
    /// "in a project" never become two code paths at every call site.
    ///
    /// Reassigning to the project being deleted is
    /// [`crate::StoreError::Invalid`]; it would delete the row the
    /// conversations were just pointed at.
    fn delete_project_reassigning(
        &self,
        id: &ProjectId,
        reassign_to: &ProjectId,
    ) -> StoreResult<u64>;
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

/// Schedules, and the history of what they ran.
///
/// ## Why every method that cares about time takes an instant
///
/// This trait never reads the clock. `due_schedules`, `begin_schedule_run`,
/// `finish_schedule_run` and `reap_orphaned_runs` all take the instant they are
/// to act at, so that "is this schedule due?" is a pure question about a
/// database and a number. That is the whole of how the scheduler is tested
/// without waiting an hour: `crate::scheduler::poll_once` is handed
/// `Timestamp::from_millis(..)` and answers immediately.
///
/// The store's own [`crate::Clock`] still stamps `created_at` and `updated_at`,
/// because those are facts about the write rather than about the schedule.
pub trait ScheduleRepository {
    fn create_schedule(&self, input: NewSchedule) -> StoreResult<Schedule>;
    fn get_schedule(&self, id: &ScheduleId) -> StoreResult<Schedule>;
    /// Soonest-due first, so a list view reads as a queue. Disabled schedules
    /// are hidden by default: disabling is the user saying "not now", and a
    /// list that ignores it is a list that lies — the same rule
    /// [`ConversationQuery::include_archived`] follows.
    fn list_schedules(&self, include_disabled: bool) -> StoreResult<Vec<Schedule>>;
    fn update_schedule(&self, id: &ScheduleId, patch: SchedulePatch) -> StoreResult<Schedule>;
    /// Deletes the schedule **and its run history**, by cascade. The runs are
    /// the schedule's own record; keeping them orphaned would leave a history
    /// pane full of rows pointing at nothing.
    fn delete_schedule(&self, id: &ScheduleId) -> StoreResult<()>;

    /// Every schedule that is enabled, owed a run at or before `now`, and does
    /// not already have a run in flight.
    ///
    /// **The overlap guard is here, in the query, not in the caller.** A
    /// schedule whose previous run is still `running` is not due: a poll that
    /// re-fired it would stack conversations on a slow model until the machine
    /// ran out of them. Putting it in the SQL is what stops a second caller —
    /// a "run all now" button, a test — from re-deriving it differently.
    fn due_schedules(&self, now: Timestamp) -> StoreResult<Vec<Schedule>>;

    /// Opens a run, `running`, started at `at`.
    ///
    /// The conversation is attached afterwards rather than passed here, and the
    /// order is deliberate: the row exists before the work does, so a crash
    /// between the two leaves a run that says it was attempted instead of no
    /// evidence at all.
    fn begin_schedule_run(
        &self,
        schedule_id: &ScheduleId,
        trigger: RunTrigger,
        at: Timestamp,
    ) -> StoreResult<ScheduleRun>;

    /// Points a run at the conversation it spawned. Separate from
    /// [`ScheduleRepository::finish_schedule_run`] so a UI can open a run that
    /// is still in flight.
    fn attach_run_conversation(
        &self,
        run_id: &ScheduleRunId,
        conversation_id: &ConversationId,
    ) -> StoreResult<ScheduleRun>;

    /// Closes a run at `at`, computing `duration_ms` from its own `started_at`.
    /// Finishing an already-finished run is [`crate::StoreError::Invalid`]: a
    /// second close would overwrite the first outcome with a later one.
    fn finish_schedule_run(
        &self,
        run_id: &ScheduleRunId,
        at: Timestamp,
        outcome: ScheduleRunOutcome,
    ) -> StoreResult<ScheduleRun>;

    /// This schedule's history, newest first.
    fn list_schedule_runs(
        &self,
        schedule_id: &ScheduleId,
        limit: u32,
    ) -> StoreResult<Vec<ScheduleRun>>;

    /// Fails every run still marked `running`, and answers how many there were.
    ///
    /// **Called once at startup, before the first poll.** A process that died
    /// mid-run leaves a `running` row, and `due_schedules` treats a running row
    /// as "still working" — so without this the schedule is wedged forever and
    /// the user sees a spinner that outlives the reason for it.
    fn reap_orphaned_runs(&self, at: Timestamp) -> StoreResult<u32>;
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
    + ScheduleRepository
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
        + ScheduleRepository
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
