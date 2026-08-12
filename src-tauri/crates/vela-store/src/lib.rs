//! # vela-store
//!
//! Vela's **system of record**: conversations, messages, projects and
//! configuration, in a local SQLite database on the user's own disk.
//!
//! Offline-first is not a feature of this crate, it is its premise. Nothing
//! here syncs, phones home, or degrades when the machine is offline. There is
//! no remote of any kind — the database *is* the source of truth, not a cache
//! of one.
//!
//! ## What this crate guarantees
//!
//! | Guarantee | How |
//! |---|---|
//! | Schema evolves safely | Versioned, forward-only [`migrations`], applied at startup, checksummed |
//! | Referential integrity | `PRAGMA foreign_keys = ON`, verified on open, plus `STRICT` tables and `CHECK` constraints |
//! | Durability | WAL journalling, verified on open (`SqliteStore::journal_mode`) |
//! | Reasoning is preserved distinctly | [`ContentPart::Reasoning`] is its own part kind; [`Message::answer_text`] can never return it |
//! | Usage accounting is honest | Token counts are `Option`; `None` means "not reported", never `0` |
//! | No SQL leaks out | Callers depend on [`repository`] traits; [`sqlite`] is the only module with queries |
//! | **No credential ever lands on disk** | The schema has no column that can hold one; a setting may name a keychain entry ([`SecretRefName`]) and nothing more |
//!
//! ## Where the database lives
//!
//! The location is injected, never discovered ([`DatabaseLocation`]). The Tauri
//! host resolves the real per-user application-data directory through Tauri's
//! path API and passes it in; tests pass a temporary directory or ask for
//! [`DatabaseLocation::InMemory`]. The store itself has no opinion about
//! operating systems, which is what makes the whole layer testable headlessly.
//!
//! ## Example
//!
//! ```
//! use std::sync::Arc;
//! use vela_store::{
//!     ContentPart, ConversationRepository, DatabaseLocation, MessageRepository,
//!     NewConversation, NewMessage, SqliteStore,
//! };
//!
//! let store = SqliteStore::open(DatabaseLocation::InMemory)?;
//! let chat = store.create_conversation(NewConversation::titled("First light"))?;
//!
//! store.append_message(NewMessage::user(chat.id.clone(), "why is the sky dark at night?"))?;
//! let answer = store.append_message(
//!     NewMessage::assistant(
//!         chat.id.clone(),
//!         vec![
//!             ContentPart::reasoning("Olbers' paradox — finite age of the universe"),
//!             ContentPart::text("Because the universe has a finite age."),
//!         ],
//!     )
//!     .with_model("local-llamacpp", "qwen3-8b"),
//! )?;
//!
//! // Reasoning is stored, and stays out of the answer.
//! assert_eq!(answer.answer_text(), "Because the universe has a finite age.");
//! assert!(answer.reasoning_text().unwrap().contains("Olbers"));
//! # Ok::<(), vela_store::StoreError>(())
//! ```

pub mod clock;
pub mod error;
pub mod location;
pub mod migrations;
pub mod model;
pub mod repository;
pub mod sqlite;

pub use clock::{Clock, FixedClock, IdSource, SeqIdSource, SystemClock, UuidSource};
pub use error::{StoreError, StoreResult};
pub use location::{DatabaseLocation, DATABASE_FILE_NAME};
pub use migrations::{AppliedMigration, Migration, MIGRATIONS, SCHEMA_VERSION};
pub use model::{
    ContentPart, Conversation, ConversationId, ConversationPatch, Message, MessageId, MessagePatch,
    MessageRole, MessageStatus, NewConversation, NewMessage, NewProject, Project, ProjectId,
    ProjectPatch, SecretRefName, Setting, SettingEntry, StopReason, Timestamp, TokenUsage,
};
pub use repository::{
    ConversationQuery, ConversationRepository, HasLocation, MessageQuery, MessageRepository,
    ProjectFilter, ProjectRepository, SearchHit, SearchHitKind, SettingsRepository, UsageTotals,
    VelaStore,
};
pub use sqlite::SqliteStore;
