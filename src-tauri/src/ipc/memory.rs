//! `memory_*` — the durable, categorised facts Vela keeps about the user.
//!
//! # What this module is, and what it deliberately is not
//!
//! It is **storage and retrieval with the user in the loop**: list a scope,
//! write an entry, amend one, delete one, empty a scope. Every write below has
//! a caller the user drove.
//!
//! It is **not** the extraction pipeline. `docs/vela-feature-spec.md` MEM-1
//! describes a post-turn pass that asks a model what was worth remembering and
//! writes the result here without being asked. Nothing in this build does that,
//! nothing calls these commands from a turn, and no comment in this file may
//! imply otherwise. That is the whole of the honesty rule this project keeps:
//! the surface exists, the automatic writer does not, and a reader must be able
//! to tell which is which from the code rather than from a changelog.
//!
//! # Scope isolation is the one rule worth stating twice
//!
//! MEM-2: a chat inside project P reads and writes `project:P` only; a chat
//! outside projects reads and writes global only; no leakage either direction.
//! It is implemented one layer down — `vela_store::MemoryRepository` takes a
//! scope on every read and has no method that returns more than one — and
//! `vela-store`'s `project_memory_and_global_memory_never_see_each_other` is
//! what holds it. This layer only has to avoid inventing a way around it: no
//! command below returns more than one scope's entries, and adding one would be
//! the first place that rule quietly stopped being true.
//!
//! # Why the renderer only ever asks for the global scope today
//!
//! Because nothing in the renderer knows which project a conversation is in.
//! The column exists (`conversations.project_id`, since 0001) and the store
//! reads it, but `ConversationSummary` in `src/platform/contract.ts` does not
//! carry it and there is no project surface at all. So the project half of the
//! scope is real, tested, and reachable from Rust — and unreachable from the
//! UI until a project surface exists. Said here rather than discovered.

use serde::{Deserialize, Serialize};
use tauri::State;
use vela_store::{
    MemoryCategory, MemoryEntry, MemoryEntryId, MemoryPatch, MemoryScope, NewMemoryEntry,
    ProjectId, VelaStore, MEMORY_CONTENT_MAX_CHARS,
};

use super::{Ack, IpcError, IpcResult};
use crate::store_host::StoreHandle;

/* -------------------------------------------------------------------------- */
/* wire types                                                                 */
/* -------------------------------------------------------------------------- */

/// Which memory space a request addresses.
///
/// A tagged union on the wire, matching `vela_store::MemoryScope`, rather than
/// the `project:<id>` string MEM-1 writes. A caller that has to *build* that
/// string is a caller that can build `project:` with nothing after it, and the
/// resulting scope is neither global nor any project — a partition nothing can
/// ever read back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MemoryScopeDto {
    Global,
    Project { project_id: String },
}

impl MemoryScopeDto {
    fn into_scope(self) -> IpcResult<MemoryScope> {
        Ok(match self {
            Self::Global => MemoryScope::Global,
            Self::Project { project_id } => {
                MemoryScope::project(ProjectId::new(project_id.trim()).map_err(IpcError::from)?)
            }
        })
    }
}

impl From<MemoryScope> for MemoryScopeDto {
    fn from(scope: MemoryScope) -> Self {
        match scope {
            MemoryScope::Global => Self::Global,
            MemoryScope::Project { project_id } => Self::Project {
                project_id: project_id.into_string(),
            },
        }
    }
}

/// Mirrors `vela_store::MemoryCategory`. Closed on both sides so the renderer
/// writes every heading a user reads and the host never invents one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MemoryCategoryDto {
    RoleContext,
    CommsPrefs,
    TechPrefs,
    ProjectDetails,
    Other,
}

impl From<MemoryCategoryDto> for MemoryCategory {
    fn from(value: MemoryCategoryDto) -> Self {
        match value {
            MemoryCategoryDto::RoleContext => Self::RoleContext,
            MemoryCategoryDto::CommsPrefs => Self::CommsPrefs,
            MemoryCategoryDto::TechPrefs => Self::TechPrefs,
            MemoryCategoryDto::ProjectDetails => Self::ProjectDetails,
            MemoryCategoryDto::Other => Self::Other,
        }
    }
}

impl From<MemoryCategory> for MemoryCategoryDto {
    fn from(value: MemoryCategory) -> Self {
        match value {
            MemoryCategory::RoleContext => Self::RoleContext,
            MemoryCategory::CommsPrefs => Self::CommsPrefs,
            MemoryCategory::TechPrefs => Self::TechPrefs,
            MemoryCategory::ProjectDetails => Self::ProjectDetails,
            MemoryCategory::Other => Self::Other,
        }
    }
}

/// One entry as the renderer sees it.
///
/// `sourceConversationId` is carried so a memory pane can answer "why do you
/// know this?" with a link rather than a shrug. It is `None` both for an entry
/// the user typed and for one whose source conversation has been deleted; the
/// store does not distinguish those and this type does not pretend to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntryDto {
    pub id: String,
    pub scope: MemoryScopeDto,
    pub category: MemoryCategoryDto,
    pub content: String,
    pub pinned: bool,
    pub source_conversation_id: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl From<MemoryEntry> for MemoryEntryDto {
    fn from(entry: MemoryEntry) -> Self {
        Self {
            id: entry.id.into_string(),
            scope: entry.scope.into(),
            category: entry.category.into(),
            content: entry.content,
            pinned: entry.pinned,
            source_conversation_id: entry.source_conversation_id.map(|id| id.into_string()),
            created_at_ms: entry.created_at.as_millis(),
            updated_at_ms: entry.updated_at.as_millis(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryScopeReq {
    pub scope: MemoryScopeDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListRes {
    /// Pinned first, then most recently updated first — the order MEM-1 wants
    /// entries injected in, produced once by the store rather than re-derived
    /// by every consumer.
    pub entries: Vec<MemoryEntryDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAddReq {
    pub scope: MemoryScopeDto,
    pub category: MemoryCategoryDto,
    pub content: String,
    /// The conversation this fact came out of, when there is one.
    #[serde(default)]
    pub source_conversation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryUpdateReq {
    pub entry_id: String,
    /// Omitted means "leave it alone" for all three. The scope is absent on
    /// purpose: moving an entry between scopes is a separate decision with a
    /// separate consent question, and it must not be something a caller can do
    /// as a side effect of fixing a typo.
    #[serde(default)]
    pub category: Option<MemoryCategoryDto>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRefReq {
    pub entry_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRes {
    pub entry: MemoryEntryDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryClearRes {
    /// How many entries went. Reported rather than acked so a confirmation can
    /// say what it actually did — "forgot 12 things" is a sentence the user can
    /// check, "ok" is not.
    pub removed: u64,
}

/* -------------------------------------------------------------------------- */
/* logic                                                                      */
/* -------------------------------------------------------------------------- */

fn entry_id(raw: &str) -> IpcResult<MemoryEntryId> {
    MemoryEntryId::new(raw.trim()).map_err(IpcError::from)
}

/// Refused here as well as in the store, because the message the user reads
/// should name the limit rather than say the row would not insert.
fn validate_content(content: &str) -> IpcResult<()> {
    if content.trim().is_empty() {
        return Err(IpcError::invalid("invalid content: must not be blank"));
    }
    if content.chars().count() > MEMORY_CONTENT_MAX_CHARS {
        return Err(IpcError::invalid(format!(
            "invalid content: must be at most {MEMORY_CONTENT_MAX_CHARS} characters"
        )));
    }
    Ok(())
}

pub fn list(store: &dyn VelaStore, req: MemoryScopeReq) -> IpcResult<MemoryListRes> {
    let scope = req.scope.into_scope()?;
    Ok(MemoryListRes {
        entries: store
            .list_memory_entries(&scope)?
            .into_iter()
            .map(MemoryEntryDto::from)
            .collect(),
    })
}

pub fn add(store: &dyn VelaStore, req: MemoryAddReq) -> IpcResult<MemoryRes> {
    validate_content(&req.content)?;
    let scope = req.scope.into_scope()?;
    let mut input = NewMemoryEntry::new(scope, req.category.into(), req.content);
    if let Some(raw) = req.source_conversation_id.as_deref() {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            input = input.from_conversation(
                vela_store::ConversationId::new(trimmed).map_err(IpcError::from)?,
            );
        }
    }
    Ok(MemoryRes {
        entry: store.create_memory_entry(input)?.into(),
    })
}

pub fn update(store: &dyn VelaStore, req: MemoryUpdateReq) -> IpcResult<MemoryRes> {
    let id = entry_id(&req.entry_id)?;
    if let Some(content) = &req.content {
        validate_content(content)?;
    }
    let patch = MemoryPatch {
        category: req.category.map(MemoryCategory::from),
        content: req.content,
        pinned: req.pinned,
    };
    Ok(MemoryRes {
        entry: store.update_memory_entry(&id, patch)?.into(),
    })
}

pub fn delete(store: &dyn VelaStore, req: MemoryRefReq) -> IpcResult<Ack> {
    let id = entry_id(&req.entry_id)?;
    store.delete_memory_entry(&id)?;
    Ok(Ack::ok())
}

pub fn clear(store: &dyn VelaStore, req: MemoryScopeReq) -> IpcResult<MemoryClearRes> {
    let scope = req.scope.into_scope()?;
    Ok(MemoryClearRes {
        removed: store.clear_memory_scope(&scope)?,
    })
}

/* -------------------------------------------------------------------------- */
/* commands — thin adapters, nothing but extraction and delegation            */
/* -------------------------------------------------------------------------- */

#[tauri::command]
pub fn memory_list(
    store: State<'_, StoreHandle>,
    payload: MemoryScopeReq,
) -> IpcResult<MemoryListRes> {
    list(store.store(), payload)
}

#[tauri::command]
pub fn memory_add(store: State<'_, StoreHandle>, payload: MemoryAddReq) -> IpcResult<MemoryRes> {
    add(store.store(), payload)
}

#[tauri::command]
pub fn memory_update(
    store: State<'_, StoreHandle>,
    payload: MemoryUpdateReq,
) -> IpcResult<MemoryRes> {
    update(store.store(), payload)
}

#[tauri::command]
pub fn memory_delete(store: State<'_, StoreHandle>, payload: MemoryRefReq) -> IpcResult<Ack> {
    delete(store.store(), payload)
}

#[tauri::command]
pub fn memory_clear_scope(
    store: State<'_, StoreHandle>,
    payload: MemoryScopeReq,
) -> IpcResult<MemoryClearRes> {
    clear(store.store(), payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::IpcErrorCode;
    use vela_store::{DatabaseLocation, NewProject, ProjectRepository, SqliteStore};

    fn store() -> SqliteStore {
        SqliteStore::open(DatabaseLocation::InMemory).expect("in-memory store opens")
    }

    fn add_global(store: &SqliteStore, content: &str) -> MemoryEntryDto {
        add(
            store,
            MemoryAddReq {
                scope: MemoryScopeDto::Global,
                category: MemoryCategoryDto::TechPrefs,
                content: content.into(),
                source_conversation_id: None,
            },
        )
        .expect("write accepted")
        .entry
    }

    #[test]
    fn an_entry_written_to_a_scope_is_listed_by_that_scope() {
        let store = store();
        let written = add_global(&store, "uses pnpm, never npm");

        let listed = list(
            &store,
            MemoryScopeReq {
                scope: MemoryScopeDto::Global,
            },
        )
        .unwrap()
        .entries;

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, written.id);
        assert_eq!(listed[0].content, "uses pnpm, never npm");
        assert_eq!(listed[0].scope, MemoryScopeDto::Global);
        assert!(!listed[0].pinned);
    }

    /// MEM-2 at the wire, not only in the store: asking for one scope must
    /// never come back holding another's.
    #[test]
    fn listing_a_project_scope_never_returns_a_global_entry_or_another_projects() {
        let store = store();
        let alpha = store.create_project(NewProject::named("Alpha")).unwrap().id;
        let beta = store.create_project(NewProject::named("Beta")).unwrap().id;
        add_global(&store, "global fact");
        for (project, content) in [(&alpha, "alpha fact"), (&beta, "beta fact")] {
            add(
                &store,
                MemoryAddReq {
                    scope: MemoryScopeDto::Project {
                        project_id: project.as_str().into(),
                    },
                    category: MemoryCategoryDto::ProjectDetails,
                    content: content.into(),
                    source_conversation_id: None,
                },
            )
            .unwrap();
        }

        let in_alpha = list(
            &store,
            MemoryScopeReq {
                scope: MemoryScopeDto::Project {
                    project_id: alpha.as_str().into(),
                },
            },
        )
        .unwrap()
        .entries;

        assert_eq!(
            in_alpha.iter().map(|e| &e.content).collect::<Vec<_>>(),
            vec!["alpha fact"],
        );
    }

    #[test]
    fn amending_an_entry_changes_only_what_was_supplied() {
        let store = store();
        let written = add_global(&store, "prefers tabs");

        let amended = update(
            &store,
            MemoryUpdateReq {
                entry_id: written.id.clone(),
                category: None,
                content: Some("prefers spaces".into()),
                pinned: Some(true),
            },
        )
        .unwrap()
        .entry;

        assert_eq!(amended.content, "prefers spaces");
        assert!(amended.pinned);
        assert_eq!(amended.category, written.category);
        assert_eq!(amended.created_at_ms, written.created_at_ms);
    }

    #[test]
    fn a_blank_entry_is_refused_rather_than_stored_as_an_empty_line() {
        let store = store();
        let error = add(
            &store,
            MemoryAddReq {
                scope: MemoryScopeDto::Global,
                category: MemoryCategoryDto::Other,
                content: "   ".into(),
                source_conversation_id: None,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::InvalidPayload);
    }

    #[test]
    fn an_oversized_entry_is_refused_with_the_limit_in_the_message() {
        let store = store();
        let error = add(
            &store,
            MemoryAddReq {
                scope: MemoryScopeDto::Global,
                category: MemoryCategoryDto::Other,
                content: "x".repeat(MEMORY_CONTENT_MAX_CHARS + 1),
                source_conversation_id: None,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::InvalidPayload);
        assert!(error
            .message
            .contains(&MEMORY_CONTENT_MAX_CHARS.to_string()));
    }

    #[test]
    fn deleting_an_entry_removes_it_and_deleting_it_twice_is_not_found() {
        let store = store();
        let written = add_global(&store, "forget me");

        assert!(
            delete(
                &store,
                MemoryRefReq {
                    entry_id: written.id.clone(),
                },
            )
            .unwrap()
            .ok
        );

        let error = delete(
            &store,
            MemoryRefReq {
                entry_id: written.id,
            },
        )
        .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::NotFound);
    }

    #[test]
    fn clearing_a_scope_reports_how_many_entries_it_forgot() {
        let store = store();
        add_global(&store, "one");
        add_global(&store, "two");

        let cleared = clear(
            &store,
            MemoryScopeReq {
                scope: MemoryScopeDto::Global,
            },
        )
        .unwrap();
        assert_eq!(cleared.removed, 2);
        assert!(list(
            &store,
            MemoryScopeReq {
                scope: MemoryScopeDto::Global,
            },
        )
        .unwrap()
        .entries
        .is_empty());
    }

    /// The scope is a tagged union on the wire so this failure is possible to
    /// report at all: a `project:` string with nothing after it would have been
    /// a scope neither branch can read back.
    #[test]
    fn a_project_scope_with_a_blank_id_is_an_invalid_payload_not_a_silent_partition() {
        let store = store();
        let error = list(
            &store,
            MemoryScopeReq {
                scope: MemoryScopeDto::Project {
                    project_id: "   ".into(),
                },
            },
        )
        .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::InvalidPayload);
    }
}
