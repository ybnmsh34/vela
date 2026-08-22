//! `schedules_*` commands — standing instructions, and the history of what they
//! ran.
//!
//! ## Why the renderer can create a schedule but cannot fire one
//!
//! There is no poll command, and there must not be one. Deciding that a slot
//! has arrived is the host's job and nobody else's: the poll thread in
//! [`crate::scheduler_host`] is the only caller of [`vela_store::poll_once`],
//! and it runs whether or not a window is open on the schedules pane. A command
//! that let the renderer fire a schedule would be a second answer to "has this
//! slot come round", and two answers to that question are two schedulers.
//!
//! What the renderer gets is the *state*: create, list, enable, delete, and the
//! run history. That is enough to draw the whole surface.
//!
//! ## What a fired run actually contains, and what it does not
//!
//! Firing spawns a conversation seeded with the schedule's prompt and records a
//! `running` run pointing at it. **Nothing sends that conversation to a model
//! yet** — the agent loop that would is `src/platform/contract-harness.ts`, a
//! frozen contract with no implementation in this tree. So a run listed here
//! stays `running` until a restart reaps it. That is the honest state of the
//! feature and it is written down rather than implied by a status enum that
//! happens to have a `success` member.
//!
//! ## `firstRunAtMs` is the renderer's to compute, and why
//!
//! The host takes an absolute instant, not "tomorrow at nine". The user's
//! timezone lives in the renderer — it is what `Intl.DateTimeFormat` already
//! knows — and a host that re-derived it would be a second answer to what
//! "tomorrow" means. What the host owns is what happens *after* the first run,
//! and there it is explicit that cadences are fixed offsets: see
//! `vela_store::Cadence::interval_ms`.

use serde::{Deserialize, Serialize};
use tauri::State;
use vela_store::{
    Cadence, NewSchedule, ProjectId, RunTrigger, Schedule, ScheduleId, SchedulePatch, ScheduleRun,
    ScheduleRunStatus, Timestamp, VelaStore,
};

use super::{Ack, IpcError, IpcResult};
use crate::store_host::StoreHandle;

/// Hard ceiling on a schedule title. Matches `store::MAX_SUPPLIED_TITLE`'s
/// reasoning: long enough for a sentence, short enough that pasting a document
/// cannot become a list row.
const MAX_TITLE_CHARS: usize = 200;

/// Hard ceiling on a prompt. Generous — a scheduled prompt is often a paragraph
/// of standing instructions — but bounded, because this row is read on every
/// poll for the life of the application.
const MAX_PROMPT_CHARS: usize = 8_000;

const DEFAULT_RUN_LIMIT: u32 = 50;
const MAX_RUN_LIMIT: u32 = 500;

/* -------------------------------------------------------------------------- */
/* wire types                                                                 */
/* -------------------------------------------------------------------------- */

/// How often a schedule comes round, on the wire.
///
/// A closed set of four, not a cron string. The renderer renders one of four
/// labels and never parses anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CadenceWire {
    Once,
    Hourly,
    Daily,
    Weekly,
}

impl From<Cadence> for CadenceWire {
    fn from(cadence: Cadence) -> Self {
        match cadence {
            Cadence::Once => Self::Once,
            Cadence::Hourly => Self::Hourly,
            Cadence::Daily => Self::Daily,
            Cadence::Weekly => Self::Weekly,
        }
    }
}

impl From<CadenceWire> for Cadence {
    fn from(cadence: CadenceWire) -> Self {
        match cadence {
            CadenceWire::Once => Self::Once,
            CadenceWire::Hourly => Self::Hourly,
            CadenceWire::Daily => Self::Daily,
            CadenceWire::Weekly => Self::Weekly,
        }
    }
}

/// A schedule as the renderer sees it.
///
/// Note what is **absent**: `providerId` and `modelId`. A stored schedule
/// carries both, exactly as a stored conversation does, and this view drops
/// them for the same reason `ConversationSummary` does — conventions §0 rule 3,
/// the UI branches on capability and never on a backend identity. A schedules
/// pane that could read them is a schedules pane that would eventually switch
/// on one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleView {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub cadence: CadenceWire,
    pub next_run_at_ms: i64,
    pub enabled: bool,
    pub project_id: Option<String>,
    /// Slots that came due while Vela was not running. Counted, never fired —
    /// see `vela_store::Cadence::advance`.
    pub missed_runs: u32,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl From<Schedule> for ScheduleView {
    fn from(schedule: Schedule) -> Self {
        Self {
            id: schedule.id.into_string(),
            title: schedule.title,
            prompt: schedule.prompt,
            cadence: schedule.cadence.into(),
            next_run_at_ms: schedule.next_run_at.as_millis(),
            enabled: schedule.enabled,
            project_id: schedule.project_id.map(ProjectId::into_string),
            missed_runs: schedule.missed_runs,
            created_at_ms: schedule.created_at.as_millis(),
            updated_at_ms: schedule.updated_at.as_millis(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatusWire {
    /// In flight — or left behind by a process that died, until the next
    /// startup reaps it.
    Running,
    Success,
    Failed,
}

impl From<ScheduleRunStatus> for RunStatusWire {
    fn from(status: ScheduleRunStatus) -> Self {
        match status {
            ScheduleRunStatus::Running => Self::Running,
            ScheduleRunStatus::Success => Self::Success,
            ScheduleRunStatus::Failed => Self::Failed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunTriggerWire {
    Schedule,
    Manual,
}

impl From<RunTrigger> for RunTriggerWire {
    fn from(trigger: RunTrigger) -> Self {
        match trigger {
            RunTrigger::Schedule => Self::Schedule,
            RunTrigger::Manual => Self::Manual,
        }
    }
}

/// One attempt, finished or not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunView {
    pub id: String,
    pub schedule_id: String,
    pub status: RunStatusWire,
    pub trigger: RunTriggerWire,
    pub started_at_ms: i64,
    pub finished_at_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    /// The conversation this run spawned, so the UI can open a run that is
    /// still in flight. `None` only if the user deleted the conversation.
    pub conversation_id: Option<String>,
    /// Set only on a failed run. A closed vocabulary is not possible here — the
    /// text comes from whatever failed — so it is rendered, never matched.
    pub error: Option<String>,
}

impl From<ScheduleRun> for ScheduleRunView {
    fn from(run: ScheduleRun) -> Self {
        Self {
            id: run.id.into_string(),
            schedule_id: run.schedule_id.into_string(),
            status: run.status.into(),
            trigger: run.trigger.into(),
            started_at_ms: run.started_at.as_millis(),
            finished_at_ms: run.finished_at.map(|t| t.as_millis()),
            duration_ms: run.duration_ms,
            conversation_id: run.conversation_id.map(|id| id.into_string()),
            error: run.error,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulesCreateReq {
    pub title: String,
    pub prompt: String,
    pub cadence: CadenceWire,
    /// When the first run is owed, as an absolute epoch millisecond. See this
    /// module's header for why the host does not compute it.
    pub first_run_at_ms: i64,
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulesListReq {
    /// Disabled schedules are hidden by default: disabling is the user saying
    /// "not now", and a list that ignores it is a list that lies.
    #[serde(default)]
    pub include_disabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulesRefReq {
    pub schedule_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulesSetEnabledReq {
    pub schedule_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulesListRunsReq {
    pub schedule_id: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRes {
    pub schedule: ScheduleView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleListRes {
    pub schedules: Vec<ScheduleView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunListRes {
    pub runs: Vec<ScheduleRunView>,
}

/* -------------------------------------------------------------------------- */
/* logic — plain functions, no Tauri types, unit-testable headlessly           */
/* -------------------------------------------------------------------------- */

fn schedule_id(raw: &str) -> IpcResult<ScheduleId> {
    ScheduleId::new(raw.trim()).map_err(IpcError::from)
}

fn validate_text(field: &str, raw: &str, max: usize) -> IpcResult<String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(IpcError::invalid(format!(
            "invalid {field}: must not be blank"
        )));
    }
    if text.chars().count() > max {
        return Err(IpcError::invalid(format!(
            "invalid {field}: must be at most {max} characters"
        )));
    }
    Ok(text.to_owned())
}

pub fn create(store: &dyn VelaStore, req: SchedulesCreateReq) -> IpcResult<ScheduleRes> {
    let title = validate_text("title", &req.title, MAX_TITLE_CHARS)?;
    let prompt = validate_text("prompt", &req.prompt, MAX_PROMPT_CHARS)?;

    let mut input = NewSchedule::new(
        title,
        prompt,
        req.cadence.into(),
        Timestamp::from_millis(req.first_run_at_ms),
    );
    if let Some(raw) = req.project_id.as_deref() {
        let project_id = ProjectId::new(raw.trim()).map_err(IpcError::from)?;
        // Checked here rather than left to the foreign key, so a schedule
        // pointing at a project that never existed is a NOT_FOUND naming the
        // project instead of an opaque constraint error.
        store.get_project(&project_id)?;
        input = input.in_project(project_id);
    }

    Ok(ScheduleRes {
        schedule: store.create_schedule(input)?.into(),
    })
}

pub fn list(store: &dyn VelaStore, req: SchedulesListReq) -> IpcResult<ScheduleListRes> {
    Ok(ScheduleListRes {
        schedules: store
            .list_schedules(req.include_disabled)?
            .into_iter()
            .map(ScheduleView::from)
            .collect(),
    })
}

pub fn set_enabled(store: &dyn VelaStore, req: SchedulesSetEnabledReq) -> IpcResult<ScheduleRes> {
    let id = schedule_id(&req.schedule_id)?;
    Ok(ScheduleRes {
        schedule: store
            .update_schedule(
                &id,
                SchedulePatch {
                    enabled: Some(req.enabled),
                    ..SchedulePatch::default()
                },
            )?
            .into(),
    })
}

pub fn delete(store: &dyn VelaStore, req: SchedulesRefReq) -> IpcResult<Ack> {
    let id = schedule_id(&req.schedule_id)?;
    // NOT_FOUND rather than a silent success: the user just asked to destroy a
    // schedule and its whole history, and "it was already gone" is information.
    store.delete_schedule(&id)?;
    Ok(Ack::ok())
}

pub fn list_runs(
    store: &dyn VelaStore,
    req: SchedulesListRunsReq,
) -> IpcResult<ScheduleRunListRes> {
    let id = schedule_id(&req.schedule_id)?;
    let limit = req.limit.unwrap_or(DEFAULT_RUN_LIMIT).min(MAX_RUN_LIMIT);
    Ok(ScheduleRunListRes {
        runs: store
            .list_schedule_runs(&id, limit)?
            .into_iter()
            .map(ScheduleRunView::from)
            .collect(),
    })
}

/* -------------------------------------------------------------------------- */
/* commands — thin adapters, nothing but extraction and delegation            */
/* -------------------------------------------------------------------------- */

#[tauri::command]
pub fn schedules_create(
    store: State<'_, StoreHandle>,
    payload: SchedulesCreateReq,
) -> IpcResult<ScheduleRes> {
    create(store.store(), payload)
}

#[tauri::command]
pub fn schedules_delete(store: State<'_, StoreHandle>, payload: SchedulesRefReq) -> IpcResult<Ack> {
    delete(store.store(), payload)
}

#[tauri::command]
pub fn schedules_list(
    store: State<'_, StoreHandle>,
    payload: SchedulesListReq,
) -> IpcResult<ScheduleListRes> {
    list(store.store(), payload)
}

#[tauri::command]
pub fn schedules_list_runs(
    store: State<'_, StoreHandle>,
    payload: SchedulesListRunsReq,
) -> IpcResult<ScheduleRunListRes> {
    list_runs(store.store(), payload)
}

#[tauri::command]
pub fn schedules_set_enabled(
    store: State<'_, StoreHandle>,
    payload: SchedulesSetEnabledReq,
) -> IpcResult<ScheduleRes> {
    set_enabled(store.store(), payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_store::{DatabaseLocation, SqliteStore};

    const NOON: i64 = 1_700_000_000_000;
    const HOUR: i64 = 60 * 60 * 1_000;

    fn store() -> SqliteStore {
        SqliteStore::open(DatabaseLocation::InMemory).unwrap()
    }

    fn new_daily(title: &str, first_run_at_ms: i64) -> SchedulesCreateReq {
        SchedulesCreateReq {
            title: title.into(),
            prompt: "summarise the day".into(),
            cadence: CadenceWire::Daily,
            first_run_at_ms,
            project_id: None,
        }
    }

    #[test]
    fn a_created_schedule_comes_back_enabled_and_lists() {
        let store = store();
        let created = create(&store, new_daily("standup", NOON)).unwrap().schedule;
        assert!(created.enabled);
        assert_eq!(created.cadence, CadenceWire::Daily);
        assert_eq!(created.next_run_at_ms, NOON);
        assert_eq!(created.missed_runs, 0);

        let listed = list(&store, SchedulesListReq::default()).unwrap().schedules;
        assert_eq!(listed, vec![created]);
    }

    #[test]
    fn a_blank_title_or_prompt_is_refused_before_a_row_exists() {
        let store = store();
        let mut blank_title = new_daily("   ", NOON);
        blank_title.title = "   ".into();
        assert!(create(&store, blank_title).is_err());

        let mut blank_prompt = new_daily("fine", NOON);
        blank_prompt.prompt = "\n\t ".into();
        assert!(create(&store, blank_prompt).is_err());

        assert!(list(
            &store,
            SchedulesListReq {
                include_disabled: true
            }
        )
        .unwrap()
        .schedules
        .is_empty());
    }

    #[test]
    fn disabling_hides_a_schedule_from_the_default_list_without_deleting_it() {
        let store = store();
        let id = create(&store, new_daily("paused", NOON))
            .unwrap()
            .schedule
            .id;

        let disabled = set_enabled(
            &store,
            SchedulesSetEnabledReq {
                schedule_id: id.clone(),
                enabled: false,
            },
        )
        .unwrap()
        .schedule;
        assert!(!disabled.enabled);

        assert!(list(&store, SchedulesListReq::default())
            .unwrap()
            .schedules
            .is_empty());
        assert_eq!(
            list(
                &store,
                SchedulesListReq {
                    include_disabled: true
                }
            )
            .unwrap()
            .schedules
            .len(),
            1
        );
    }

    /// The command surface's half of the feature: a schedule created through
    /// IPC is the schedule the host's poll fires, and the run it produces is
    /// the run this surface lists. Nothing here is a fake — it is one store.
    #[test]
    fn a_schedule_created_through_ipc_is_fired_by_the_poll_and_listed_as_a_run() {
        let store = store();
        let id = create(&store, new_daily("nightly report", NOON))
            .unwrap()
            .schedule
            .id;

        assert!(list_runs(
            &store,
            SchedulesListRunsReq {
                schedule_id: id.clone(),
                limit: None,
            },
        )
        .unwrap()
        .runs
        .is_empty());

        let report = vela_store::poll_once(&store, Timestamp::from_millis(NOON)).unwrap();
        assert_eq!(report.fired.len(), 1);

        let runs = list_runs(
            &store,
            SchedulesListRunsReq {
                schedule_id: id.clone(),
                limit: None,
            },
        )
        .unwrap()
        .runs;
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, RunStatusWire::Running);
        assert_eq!(runs[0].trigger, RunTriggerWire::Schedule);
        assert!(
            runs[0].conversation_id.is_some(),
            "a run must name the conversation it spawned, so the UI can open it"
        );

        // And the schedule moved on, which the pane can see.
        let after = list(&store, SchedulesListReq::default())
            .unwrap()
            .schedules
            .remove(0);
        assert_eq!(after.next_run_at_ms, NOON + 24 * HOUR);
    }

    #[test]
    fn deleting_a_schedule_takes_its_run_history_with_it() {
        let store = store();
        let id = create(&store, new_daily("temporary", NOON))
            .unwrap()
            .schedule
            .id;
        vela_store::poll_once(&store, Timestamp::from_millis(NOON)).unwrap();

        delete(
            &store,
            SchedulesRefReq {
                schedule_id: id.clone(),
            },
        )
        .unwrap();

        // The runs went with it, so listing them is NOT_FOUND on the schedule
        // rather than an empty list that implies it never ran.
        assert!(list_runs(
            &store,
            SchedulesListRunsReq {
                schedule_id: id.clone(),
                limit: None,
            },
        )
        .is_err());
        // Deleting it twice is NOT_FOUND, not a silent success.
        assert!(delete(&store, SchedulesRefReq { schedule_id: id }).is_err());
    }

    #[test]
    fn a_schedule_filed_under_a_project_that_does_not_exist_is_refused() {
        let store = store();
        let mut req = new_daily("filed", NOON);
        req.project_id = Some("proj_nonexistent".into());
        assert!(create(&store, req).is_err());
    }

    #[test]
    fn the_wire_shape_is_camel_case() {
        let store = store();
        let created = create(&store, new_daily("wire", NOON)).unwrap();
        let json = serde_json::to_value(&created).unwrap();
        let schedule = &json["schedule"];
        assert!(schedule["nextRunAtMs"].is_i64());
        assert!(schedule["missedRuns"].is_u64());
        assert!(schedule["createdAtMs"].is_i64());
        assert_eq!(schedule["cadence"], serde_json::json!("daily"));
        assert!(
            schedule.get("providerId").is_none(),
            "a schedule view must not carry a backend identity"
        );
    }
}
