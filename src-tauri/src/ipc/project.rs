//! `project_*` commands — the durable container a conversation belongs to, and
//! the three directories that belong to it.
//!
//! ## Two halves, joined here and nowhere else
//!
//! The **record** — name, instructions, enabled skills, the working-directory
//! binding — is a row in `vela-store`. The **layout** — the private agent
//! workspace, the skills mount, what is actually on disk right now — is
//! `vela-projects`. Neither knows about the other, which is what lets both be
//! tested headlessly, and this module is the only place the two meet.
//!
//! ## What crosses this boundary, and what does not
//!
//! [`ProjectSummary`] is what a list surface sees and it touches **no
//! filesystem at all**: listing forty projects must not stat forty directory
//! trees or block on a working directory that lives on a share that is down. It
//! also carries no path to the private workspace and no mount state — a field
//! the renderer can read is a field the renderer will eventually branch on, and
//! the workspace's location is not the renderer's business. Anything needing the
//! disk is [`vela_projects::ProjectLayout`] and is fetched per project,
//! deliberately.
//!
//! `is_default` is carried as a flag rather than left to be derived, so that
//! nothing under `src/` ever compares an id against
//! [`vela_store::DEFAULT_PROJECT_ID`] — conventions §0 rule 3.
//!
//! ## The one place case folding is decided
//!
//! Two enabled skills named `Foo` and `foo` are one directory on Windows. Which
//! names collide is a property of the volume the skills mount lives on, so the
//! host measures it ([`vela_projects::CaseFolding`]) and refuses a colliding
//! write with `INVALID_PAYLOAD`. **The renderer may warn about a pair it thinks
//! looks alike; it may not conclude, and it may not pre-filter the list it
//! sends.** A record that already holds a colliding pair — reachable because
//! `%APPDATA%` can be redirected onto a volume with different rules — is
//! reported rather than repaired: the first entry mounts and the rest come back
//! `nameCollidesWithAnotherEnabledSkill`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;
use vela_projects::{
    create_project_directories, ensure_skill_store, probe_link_strategy, projects_root,
    remove_project_root, resolve_layout, validate_binding, CaseFolding, LinkStrategy,
    ProjectLayout, WorkingDirectoryBinding,
};
use vela_store::{
    ConversationId, ConversationPatch, NewProject, Project, ProjectId, ProjectPatch, VelaStore,
    DEFAULT_PROJECT_ID,
};

use super::{Ack, IpcError, IpcResult};
use crate::store_host::StoreHandle;

/// Longest project name the host accepts, in **Unicode scalar values**.
///
/// Scalars rather than UTF-16 code units, because the renderer counts the
/// latter: a name of emoji would pass one check and fail the other, and the user
/// would see a validation error the field it came from cannot explain. Mirrored
/// as `PROJECT_NAME_MAX_CHARS` in `src/platform/contract-project.ts`.
pub const PROJECT_NAME_MAX_CHARS: usize = 120;

/// Longest instruction text the host accepts, in Unicode scalar values. A guard
/// rail, not a budget — the real limit is the model's context window, and that
/// belongs to whatever assembles the prompt. This only stops a pasted-in novel
/// from becoming a row nobody can load.
pub const PROJECT_INSTRUCTIONS_MAX_CHARS: usize = 65_536;

/* -------------------------------------------------------------------------- */
/* host state                                                                 */
/* -------------------------------------------------------------------------- */

/// Everything about projects that is a property of **this machine** rather than
/// of a project: where the application-data directory is, and what this
/// filesystem can do.
pub struct ProjectHost {
    app_data_dir: PathBuf,
    link_strategy: LinkStrategy,
}

impl ProjectHost {
    /// Resolved **once at launch**, before any command that reads it is served.
    ///
    /// Both halves are launch work on purpose. The canonical skill store is
    /// created here rather than lazily inside whichever command happens to run
    /// first, because a store created by one command produces a different UI
    /// sentence for the same disk depending on what the user clicked; empty is
    /// the correct state on a machine with no skills, and its one consequence is
    /// that every enabled skill then mounts `unavailable` with `skillNotFound`.
    /// The link strategy is probed here because the probe touches the disk and
    /// its answer cannot change under a running process.
    pub fn establish(app_data_dir: PathBuf) -> Self {
        let _ = ensure_skill_store(&app_data_dir);
        let link_strategy = probe_link_strategy(&app_data_dir);
        Self {
            app_data_dir,
            link_strategy,
        }
    }

    pub fn app_data_dir(&self) -> &Path {
        &self.app_data_dir
    }

    pub fn link_strategy(&self) -> LinkStrategy {
        self.link_strategy
    }

    /// How the volume the skills mount lives on folds case.
    ///
    /// Measured against the projects root rather than against a project's own
    /// mount, because a create has no project yet and the two are on the same
    /// volume by construction — the mount is `<projects root>/<id>/skills`.
    fn case_folding(&self) -> CaseFolding {
        let root = projects_root(&self.app_data_dir);
        let _ = std::fs::create_dir_all(&root);
        CaseFolding::probe(&root)
    }
}

/* -------------------------------------------------------------------------- */
/* wire types                                                                 */
/* -------------------------------------------------------------------------- */

/// A project as a list surface sees it. Cheap: no filesystem access at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    /// This is the seeded default. Carried rather than derived so the one place
    /// that decides what "default" means is the host.
    pub is_default: bool,
    /// The **stored binding**, not a checked path. It may name a directory that
    /// has been deleted or is on a drive that is not plugged in, so rendering it
    /// says "this is where the user pointed", never "this exists".
    pub working_directory_path: Option<String>,
    pub created_at_ms: i64,
    /// When the **record** last changed. It does not move when a conversation
    /// inside the project is added or answered — `last_active_at_ms` answers
    /// that question.
    pub updated_at_ms: i64,
    pub last_active_at_ms: Option<i64>,
    pub conversation_count: i64,
    /// Archiving hides a project and touches **nothing on disk**, which is what
    /// makes "restored exactly as it was" trivially true.
    pub archived_at_ms: Option<i64>,
}

/// One project in full: the summary plus the two fields a list must not carry.
/// Still no filesystem access — both are columns, not files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub summary: ProjectSummary,
    /// Empty string is the only spelling of "none": a nullable string would give
    /// this field two empty values and every consumer a choice about which to
    /// check.
    pub instructions: String,
    /// The skills the user has enabled — **intent**, not what is mounted. What
    /// is actually on disk is the layout's mount list, and the two can differ.
    /// Keeping them in one field would mean a failed mount silently disables the
    /// skill.
    pub enabled_skills: Vec<String>,
}

impl From<Project> for ProjectView {
    fn from(project: Project) -> Self {
        Self {
            instructions: project.system_prompt.clone().unwrap_or_default(),
            enabled_skills: project.enabled_skills.clone(),
            summary: ProjectSummary {
                is_default: project.id.as_str() == DEFAULT_PROJECT_ID,
                id: project.id.into_string(),
                name: project.name,
                working_directory_path: project.working_directory,
                created_at_ms: project.created_at.as_millis(),
                updated_at_ms: project.updated_at.as_millis(),
                last_active_at_ms: project.last_active_at.map(|at| at.as_millis()),
                conversation_count: project.conversation_count,
                archived_at_ms: project.archived_at.map(|at| at.as_millis()),
            },
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRefReq {
    pub project_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRes {
    pub project: ProjectView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLayoutRes {
    pub layout: ProjectLayout,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListReq {
    /// Defaults to `false`: archived projects are hidden unless asked for.
    #[serde(default)]
    pub include_archived: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListRes {
    pub projects: Vec<ProjectSummary>,
}

/// Create a project.
///
/// Names are **not unique and are not checked for uniqueness**: identity is the
/// id, enforcing unique names would mean rename can fail, and there is no reason
/// one person may not have two projects called "Notes".
///
/// On success the three host-owned directories exist and skills are reconciled.
/// On failure nothing was created — **including no row**. That second half is
/// [`roll_back_create`], held by
/// `a_create_that_cannot_finish_leaves_neither_a_row_nor_a_directory` and
/// `the_rollback_takes_the_tree_and_then_the_row`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreateReq {
    pub name: String,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub working_directory: Option<WorkingDirectoryBinding>,
    #[serde(default)]
    pub enabled_skills: Option<Vec<String>>,
}

/// Amend a project. An omitted field means "leave it alone".
///
/// `enabled_skills` replaces the whole set rather than adding to it. Applying
/// this re-reconciles the skills mount before returning, so a caller that
/// changes the set and then reads a layout cannot observe the old mount.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdateReq {
    pub project_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub working_directory: Option<WorkingDirectoryBinding>,
    #[serde(default)]
    pub enabled_skills: Option<Vec<String>>,
    /// `true` archives, `false` restores. One bit with no asymmetry —
    /// restoring is exactly undoing.
    #[serde(default)]
    pub archived: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMoveConversationReq {
    pub conversation_id: String,
    /// The destination. The default project is how a conversation is moved
    /// "out": there is no unfiled state.
    pub project_id: String,
}

/* -------------------------------------------------------------------------- */
/* validation                                                                 */
/* -------------------------------------------------------------------------- */

fn project_id(raw: &str) -> IpcResult<ProjectId> {
    ProjectId::new(raw.trim()).map_err(IpcError::from)
}

fn validate_name(raw: &str) -> IpcResult<String> {
    let name = raw.trim().to_owned();
    if name.is_empty() {
        return Err(IpcError::invalid("invalid name: must not be blank"));
    }
    if name.chars().count() > PROJECT_NAME_MAX_CHARS {
        return Err(IpcError::invalid(format!(
            "invalid name: must be at most {PROJECT_NAME_MAX_CHARS} characters"
        )));
    }
    Ok(name)
}

fn validate_instructions(raw: &str) -> IpcResult<String> {
    if raw.chars().count() > PROJECT_INSTRUCTIONS_MAX_CHARS {
        return Err(IpcError::invalid(format!(
            "invalid instructions: must be at most {PROJECT_INSTRUCTIONS_MAX_CHARS} characters"
        )));
    }
    Ok(raw.to_owned())
}

/// Refuses a skill list two of whose entries would land on one path.
///
/// **Not deduplicated and not reordered.** The user enabled two things, one of
/// them cannot exist, and the host has no way to know which they meant. Silently
/// dropping one would leave a skill switched on that never mounts and never says
/// so, which is the silently-wrong outcome §9 rule 6 forbids.
fn validate_enabled_skills(names: &[String], folding: CaseFolding) -> IpcResult<()> {
    for (index, name) in names.iter().enumerate() {
        if name.trim().is_empty() {
            return Err(IpcError::invalid(format!(
                "invalid enabledSkills[{index}]: must not be blank"
            )));
        }
    }
    if let Some((earlier, later)) = folding.first_collision(names) {
        return Err(IpcError::invalid(format!(
            "invalid enabledSkills: `{earlier}` and `{later}` are one directory on this \
             filesystem; disable one of them"
        )));
    }
    Ok(())
}

fn validate_working_directory(
    binding: &WorkingDirectoryBinding,
    app_data_dir: &Path,
) -> IpcResult<Option<String>> {
    validate_binding(binding, app_data_dir)
        .map(|resolved| resolved.map(|path| path.to_string_lossy().into_owned()))
        .map_err(|refusal| IpcError::invalid(refusal.as_message()))
}

/// Filesystem failures are host-side facts. The renderer gets the class, never
/// the path or the OS message — the same rule `IpcError::from` applies to a
/// store failure.
fn layout_failed(_error: std::io::Error) -> IpcError {
    IpcError::new(
        super::IpcErrorCode::Internal,
        "the project's directories could not be prepared",
    )
}

/* -------------------------------------------------------------------------- */
/* logic                                                                      */
/* -------------------------------------------------------------------------- */

pub fn list(store: &dyn VelaStore, req: ProjectListReq) -> IpcResult<ProjectListRes> {
    let projects = store
        .list_projects(req.include_archived.unwrap_or(false))?
        .into_iter()
        .map(|project| ProjectView::from(project).summary)
        .collect();
    Ok(ProjectListRes { projects })
}

pub fn get(store: &dyn VelaStore, req: ProjectRefReq) -> IpcResult<ProjectRes> {
    let id = project_id(&req.project_id)?;
    Ok(ProjectRes {
        project: store.get_project(&id)?.into(),
    })
}

pub fn create(
    store: &dyn VelaStore,
    host: &ProjectHost,
    req: ProjectCreateReq,
) -> IpcResult<ProjectRes> {
    let name = validate_name(&req.name)?;
    let instructions = validate_instructions(req.instructions.as_deref().unwrap_or_default())?;
    let enabled_skills = req.enabled_skills.unwrap_or_default();
    validate_enabled_skills(&enabled_skills, host.case_folding())?;
    let working_directory = match &req.working_directory {
        Some(binding) => validate_working_directory(binding, host.app_data_dir())?,
        None => None,
    };

    let project = store.create_project(NewProject {
        name,
        description: None,
        system_prompt: Some(instructions),
        working_directory,
        enabled_skills,
    })?;

    // All three directories or none, and **no row without them**. A partially
    // created project is an error, never a success with a hole in it, so any
    // failure from here to the return takes the row back out with it — the row
    // is what a later read would build a layout from, and a row whose
    // directories never appeared is precisely the reference's own defect (a
    // workspace scaffold that was commented out).
    //
    // The first reconcile is *inside* this rather than after it, and that is the
    // repair rather than an arrangement of the same lines. It used to sit
    // outside, covered by nothing, which made the sentence next to it in
    // `ProjectCreateReq` false in one arm: a `layout_of` that failed returned an
    // error and left the row and all three directories exactly where they were.
    if let Err(error) = create_on_disk(store, host, &project.id) {
        roll_back_create(store, host, &project.id);
        return Err(error);
    }

    Ok(ProjectRes {
        project: store.get_project(&project.id)?.into(),
    })
}

/// The on-disk half of a create: the three directories, then the first
/// reconcile.
///
/// Reconciling here rather than on first read is what makes the promise "on
/// success the skills are mounted" true rather than eventual.
fn create_on_disk(store: &dyn VelaStore, host: &ProjectHost, id: &ProjectId) -> IpcResult<()> {
    create_project_directories(host.app_data_dir(), id.as_str()).map_err(layout_failed)?;
    layout_of(store, host, id)?;
    Ok(())
}

/// One half of taking a project back apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RollbackStep {
    /// The project root, and the three host-owned directories inside it.
    Tree,
    /// The record.
    Row,
}

impl RollbackStep {
    /// Performs the step, reporting nothing. See [`roll_back_create`] for why
    /// failures are dropped here and not propagated.
    fn take(self, store: &dyn VelaStore, host: &ProjectHost, id: &ProjectId) {
        match self {
            Self::Tree => {
                let _ = remove_project_root(host.app_data_dir(), id.as_str());
            }
            Self::Row => {
                let _ = store.delete_project(id);
            }
        }
    }
}

/// **The tree, and then the row.**
///
/// A constant rather than two statements in an order, for the reason
/// `NATIVE_LINK_STRATEGY` in `vela-projects` is one: the order *is* the rule
/// here, and a rule spelled as the sequence two lines happen to be in is a rule
/// a reviewer cannot see and a test cannot hold. Interrupted after the row and
/// before the tree leaves a directory under the application-data folder that
/// nothing will ever name again; interrupted the other way round leaves a
/// project whose directories the next layout read repairs. Only one of those is
/// recoverable, which is why this is not an arbitrary order.
///
/// [`delete`] takes a project apart in the same order and says so, and holds it
/// one degree more strongly than this can: it propagates the tree's failure, so
/// there the row is only ever reached once the tree is gone.
const ROLLBACK_ORDER: [RollbackStep; 2] = [RollbackStep::Tree, RollbackStep::Row];

/// Takes a project that could not be finished back out, in [`ROLLBACK_ORDER`].
///
/// Both failures are dropped on purpose. The caller is already returning the
/// error that caused the rollback, and a rollback that reported its own trouble
/// instead would replace the diagnosis with the symptom.
fn roll_back_create(store: &dyn VelaStore, host: &ProjectHost, id: &ProjectId) {
    for step in ROLLBACK_ORDER {
        step.take(store, host, id);
    }
}

pub fn update(
    store: &dyn VelaStore,
    host: &ProjectHost,
    req: ProjectUpdateReq,
) -> IpcResult<ProjectRes> {
    let id = project_id(&req.project_id)?;
    store.get_project(&id)?;

    let name = req.name.as_deref().map(validate_name).transpose()?;
    let instructions = req
        .instructions
        .as_deref()
        .map(validate_instructions)
        .transpose()?;
    if let Some(skills) = &req.enabled_skills {
        // Refused before anything is written, so a colliding list changes
        // nothing — including the fields alongside it.
        validate_enabled_skills(skills, host.case_folding())?;
    }
    let working_directory = match &req.working_directory {
        Some(binding) => Some(validate_working_directory(binding, host.app_data_dir())?),
        None => None,
    };

    store.update_project(
        &id,
        ProjectPatch {
            name,
            description: None,
            system_prompt: instructions.map(Some),
            working_directory,
            enabled_skills: req.enabled_skills,
            archived: req.archived,
        },
    )?;

    // Re-reconcile before returning, so a caller that changed the enabled set
    // and then reads a layout cannot observe the old mount.
    let _ = layout_of(store, host, &id)?;
    Ok(ProjectRes {
        project: store.get_project(&id)?.into(),
    })
}

/// Delete a project. Deliberately **one behaviour, with no options**.
///
/// Conversations are reassigned to the default project and never deleted; the
/// project root is removed; the working directory is **not touched**, and no
/// flag exists that could ask for it to be — that parameter is right ninety-nine
/// times and unrecoverable the hundredth.
///
/// The directories go first and the row second. Either order can be interrupted;
/// this is the order whose interrupted state is recoverable, because a project
/// whose host-owned directories are missing is repaired on the next layout read,
/// while a row deleted before its directories leaves a tree under the
/// application-data directory that nothing will ever name again.
pub fn delete(store: &dyn VelaStore, host: &ProjectHost, req: ProjectRefReq) -> IpcResult<Ack> {
    let id = project_id(&req.project_id)?;
    if id.as_str() == DEFAULT_PROJECT_ID {
        return Err(IpcError::invalid(
            "invalid projectId: the default project cannot be deleted; it is where every \
             other project's conversations go",
        ));
    }
    store.get_project(&id)?;

    remove_project_root(host.app_data_dir(), id.as_str()).map_err(layout_failed)?;
    store.delete_project_reassigning(&id, &ProjectId::new(DEFAULT_PROJECT_ID)?)?;
    Ok(Ack::ok())
}

/// Read a project's on-disk reality, repairing any host-owned directory that has
/// gone missing and re-mounting its enabled skills.
///
/// `project_reconcile_skills` is **the same operation under a second name**, and
/// that is stated here rather than left for a reader to discover: reading a
/// layout has to reconcile anyway, or the mount list it reports would be a
/// description of the last write rather than of the disk. The second name exists
/// because a mount can break without the record changing — a skill deleted from
/// the canonical store, an application-data directory moved onto a share that
/// refuses junctions — and a caller in that situation is not asking for a
/// "layout".
pub fn layout(
    store: &dyn VelaStore,
    host: &ProjectHost,
    req: ProjectRefReq,
) -> IpcResult<ProjectLayoutRes> {
    let id = project_id(&req.project_id)?;
    Ok(ProjectLayoutRes {
        layout: layout_of(store, host, &id)?,
    })
}

fn layout_of(
    store: &dyn VelaStore,
    host: &ProjectHost,
    id: &ProjectId,
) -> IpcResult<ProjectLayout> {
    let project = store.get_project(id)?;
    resolve_layout(
        host.app_data_dir(),
        id.as_str(),
        host.link_strategy(),
        project.working_directory.as_deref(),
        &project.enabled_skills,
    )
    .map_err(layout_failed)
}

pub fn move_conversation(store: &dyn VelaStore, req: ProjectMoveConversationReq) -> IpcResult<Ack> {
    let conversation = ConversationId::new(req.conversation_id.trim()).map_err(IpcError::from)?;
    let id = project_id(&req.project_id)?;
    // Both are checked before anything moves: a conversation filed under a
    // project that does not exist is the orphan state the sentinel default
    // exists to make impossible.
    store.get_conversation(&conversation)?;
    store.get_project(&id)?;

    store.update_conversation(
        &conversation,
        ConversationPatch {
            project_id: Some(Some(id)),
            ..ConversationPatch::default()
        },
    )?;
    Ok(Ack::ok())
}

/* -------------------------------------------------------------------------- */
/* commands — thin adapters, nothing but extraction and delegation            */
/* -------------------------------------------------------------------------- */

#[tauri::command]
pub fn project_list(
    store: State<'_, StoreHandle>,
    payload: ProjectListReq,
) -> IpcResult<ProjectListRes> {
    list(store.store(), payload)
}

#[tauri::command]
pub fn project_get(store: State<'_, StoreHandle>, payload: ProjectRefReq) -> IpcResult<ProjectRes> {
    get(store.store(), payload)
}

#[tauri::command]
pub fn project_create(
    store: State<'_, StoreHandle>,
    host: State<'_, ProjectHost>,
    payload: ProjectCreateReq,
) -> IpcResult<ProjectRes> {
    create(store.store(), &host, payload)
}

#[tauri::command]
pub fn project_update(
    store: State<'_, StoreHandle>,
    host: State<'_, ProjectHost>,
    payload: ProjectUpdateReq,
) -> IpcResult<ProjectRes> {
    update(store.store(), &host, payload)
}

#[tauri::command]
pub fn project_delete(
    store: State<'_, StoreHandle>,
    host: State<'_, ProjectHost>,
    payload: ProjectRefReq,
) -> IpcResult<Ack> {
    delete(store.store(), &host, payload)
}

#[tauri::command]
pub fn project_layout(
    store: State<'_, StoreHandle>,
    host: State<'_, ProjectHost>,
    payload: ProjectRefReq,
) -> IpcResult<ProjectLayoutRes> {
    layout(store.store(), &host, payload)
}

#[tauri::command]
pub fn project_reconcile_skills(
    store: State<'_, StoreHandle>,
    host: State<'_, ProjectHost>,
    payload: ProjectRefReq,
) -> IpcResult<ProjectLayoutRes> {
    layout(store.store(), &host, payload)
}

#[tauri::command]
pub fn project_move_conversation(
    store: State<'_, StoreHandle>,
    payload: ProjectMoveConversationReq,
) -> IpcResult<Ack> {
    move_conversation(store.store(), payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::IpcErrorCode;
    use std::fs;
    use vela_store::{ConversationRepository, DatabaseLocation, NewConversation, SqliteStore};

    struct Fixture {
        dir: tempfile::TempDir,
        store: SqliteStore,
        host: ProjectHost,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let store = SqliteStore::open(DatabaseLocation::in_directory(dir.path())).unwrap();
        let host = ProjectHost::establish(dir.path().to_path_buf());
        Fixture { dir, store, host }
    }

    impl Fixture {
        fn install_skill(&self, name: &str) -> PathBuf {
            let path = vela_projects::skill_store(self.dir.path()).join(name);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("SKILL.md"), format!("# {name}")).unwrap();
            path
        }

        fn create(&self, request: ProjectCreateReq) -> IpcResult<ProjectRes> {
            create(&self.store, &self.host, request)
        }

        fn layout_of(&self, id: &str) -> ProjectLayout {
            layout(
                &self.store,
                &self.host,
                ProjectRefReq {
                    project_id: id.to_string(),
                },
            )
            .unwrap()
            .layout
        }

        fn named(&self, name: &str) -> ProjectView {
            self.create(ProjectCreateReq {
                name: name.to_string(),
                ..ProjectCreateReq::default()
            })
            .unwrap()
            .project
        }
    }

    #[test]
    fn the_default_project_is_listed_from_the_first_launch_and_says_it_is_the_default() {
        let fixture = fixture();
        let listed = list(&fixture.store, ProjectListReq::default())
            .unwrap()
            .projects;

        assert_eq!(listed.len(), 1);
        assert!(listed[0].is_default);
        assert_eq!(listed[0].id, DEFAULT_PROJECT_ID);
        assert_eq!(listed[0].conversation_count, 0);
        assert_eq!(listed[0].working_directory_path, None);

        let other = fixture.named("Sails");
        assert!(
            !other.summary.is_default,
            "the flag is the only way to tell, and it is the host that decides"
        );
    }

    #[test]
    fn creating_a_project_makes_all_three_directories_before_it_returns() {
        let fixture = fixture();
        let created = fixture.named("Field notes");
        let layout = fixture.layout_of(&created.summary.id);

        assert!(Path::new(&layout.paths.root).is_dir());
        assert!(Path::new(&layout.paths.workspace).is_dir());
        assert!(Path::new(&layout.paths.skills_mount).is_dir());
        assert!(
            layout.repaired.is_empty(),
            "nothing to repair on a project that was just made"
        );
        assert!(
            layout.paths.root.ends_with(&created.summary.id),
            "directories are keyed by id, so renaming moves nothing"
        );
    }

    #[test]
    fn a_create_that_cannot_finish_leaves_neither_a_row_nor_a_directory() {
        let fixture = fixture();
        // `<app data>/projects` as a *file*: no project's directories can be
        // made under it, whatever id the store hands back.
        let projects = projects_root(fixture.dir.path());
        let _ = fs::remove_dir_all(&projects);
        fs::write(&projects, "not a directory").unwrap();
        let before = list(&fixture.store, ProjectListReq::default())
            .unwrap()
            .projects
            .len();

        let refused = fixture
            .create(ProjectCreateReq {
                name: "Doomed".into(),
                ..ProjectCreateReq::default()
            })
            .unwrap_err();

        assert_eq!(refused.code, IpcErrorCode::Internal);
        let after = list(&fixture.store, ProjectListReq::default())
            .unwrap()
            .projects;
        assert_eq!(
            after.len(),
            before,
            "the row went back out with the directories that could not be made"
        );
        assert!(!after.iter().any(|project| project.name == "Doomed"));
        assert!(projects.is_file(), "and nothing was made beside it");
    }

    /// The rollback's order, and that each half of it does what it is named for.
    ///
    /// **The order cannot be observed from outside and this test says so rather
    /// than implying otherwise.** Both steps are unconditional and both swallow
    /// their failures, so every end state a caller can see is identical under
    /// either order — swapping the two lines used to leave this test green. The
    /// order only matters to an interruption *between* them, and nothing in a
    /// single-threaded test can stand there. So the order is held where it is
    /// readable — as [`ROLLBACK_ORDER`] — and this asserts that constant
    /// alongside the effect of each step, which is what stops the constant from
    /// being two labels in a row.
    #[test]
    fn the_rollback_takes_the_tree_and_then_the_row() {
        assert_eq!(
            ROLLBACK_ORDER,
            [RollbackStep::Tree, RollbackStep::Row],
            "a row deleted before its directories leaves a tree nothing can name again",
        );

        let fixture = fixture();
        let created = fixture.named("Half made");
        let id = ProjectId::new(&created.summary.id).unwrap();
        let reference = ProjectRefReq {
            project_id: created.summary.id.clone(),
        };
        let root = vela_projects::project_root(fixture.dir.path(), id.as_str());
        assert!(root.is_dir(), "the project really was made first");

        RollbackStep::Tree.take(&fixture.store, &fixture.host, &id);
        assert!(!root.exists(), "the tree step takes the tree");
        assert!(
            get(&fixture.store, reference.clone()).is_ok(),
            "and leaves the row for the step that follows it"
        );

        RollbackStep::Row.take(&fixture.store, &fixture.host, &id);
        assert!(
            get(&fixture.store, reference).is_err(),
            "the row step takes the row"
        );
    }

    #[test]
    fn the_whole_rollback_leaves_neither_the_tree_nor_the_row() {
        let fixture = fixture();
        let created = fixture.named("Half made");
        let id = ProjectId::new(&created.summary.id).unwrap();
        let root = vela_projects::project_root(fixture.dir.path(), id.as_str());
        assert!(root.is_dir());

        roll_back_create(&fixture.store, &fixture.host, &id);

        assert!(!root.exists());
        assert!(get(
            &fixture.store,
            ProjectRefReq {
                project_id: created.summary.id.clone()
            }
        )
        .is_err());
    }

    #[test]
    fn a_project_renamed_keeps_its_directories_exactly_where_they_were() {
        let fixture = fixture();
        let created = fixture.named("Sails");
        let before = fixture.layout_of(&created.summary.id).paths;

        let renamed = update(
            &fixture.store,
            &fixture.host,
            ProjectUpdateReq {
                project_id: created.summary.id.clone(),
                name: Some("Rigging".into()),
                ..ProjectUpdateReq::default()
            },
        )
        .unwrap()
        .project;

        assert_eq!(renamed.summary.name, "Rigging");
        assert_eq!(fixture.layout_of(&created.summary.id).paths, before);
    }

    #[test]
    fn the_default_project_may_be_renamed_and_may_not_be_deleted() {
        let fixture = fixture();
        let renamed = update(
            &fixture.store,
            &fixture.host,
            ProjectUpdateReq {
                project_id: DEFAULT_PROJECT_ID.to_string(),
                name: Some("Everything else".into()),
                ..ProjectUpdateReq::default()
            },
        )
        .unwrap()
        .project;
        assert_eq!(renamed.summary.name, "Everything else");
        assert!(
            renamed.summary.is_default,
            "renaming does not un-default it"
        );

        let root = PathBuf::from(fixture.layout_of(DEFAULT_PROJECT_ID).paths.root);
        let refused = delete(
            &fixture.store,
            &fixture.host,
            ProjectRefReq {
                project_id: DEFAULT_PROJECT_ID.to_string(),
            },
        )
        .unwrap_err();
        assert_eq!(refused.code, IpcErrorCode::InvalidPayload);
        assert!(
            refused
                .message
                .contains("default project cannot be deleted"),
            "the refusal has to be this rule and not some later failure that \
             happens to share a code: {}",
            refused.message
        );
        // Refused **before** anything was touched. Without this the test passes
        // even when the up-front check is gone, because the store refuses to
        // reassign a project's conversations to itself — by which point the
        // directories have already been removed.
        assert!(
            root.is_dir(),
            "a refused delete must not have removed the project's directories"
        );
        assert!(list(&fixture.store, ProjectListReq::default())
            .unwrap()
            .projects
            .iter()
            .any(|project| project.is_default));
    }

    #[test]
    fn deleting_a_project_reassigns_its_conversations_and_removes_only_its_own_directories() {
        let fixture = fixture();
        let installed = fixture.install_skill("research");
        let created = fixture
            .create(ProjectCreateReq {
                name: "Sails".into(),
                enabled_skills: Some(vec!["research".into()]),
                ..ProjectCreateReq::default()
            })
            .unwrap()
            .project;
        let root = fixture.layout_of(&created.summary.id).paths.root;

        let chat = fixture
            .store
            .create_conversation(NewConversation::titled("keep me"))
            .unwrap();
        move_conversation(
            &fixture.store,
            ProjectMoveConversationReq {
                conversation_id: chat.id.clone().into_string(),
                project_id: created.summary.id.clone(),
            },
        )
        .unwrap();
        assert_eq!(
            get(
                &fixture.store,
                ProjectRefReq {
                    project_id: created.summary.id.clone()
                }
            )
            .unwrap()
            .project
            .summary
            .conversation_count,
            1
        );

        delete(
            &fixture.store,
            &fixture.host,
            ProjectRefReq {
                project_id: created.summary.id.clone(),
            },
        )
        .unwrap();

        assert!(!Path::new(&root).exists());
        assert!(
            installed.join("SKILL.md").is_file(),
            "the machine-wide skill store must survive a project delete"
        );
        assert_eq!(
            fixture
                .store
                .get_conversation(&chat.id)
                .unwrap()
                .project_id
                .unwrap()
                .as_str(),
            DEFAULT_PROJECT_ID,
            "conversations are reassigned, never deleted and never left unfiled"
        );
    }

    #[test]
    fn a_working_directory_inside_the_application_data_directory_is_refused_and_nothing_is_created()
    {
        let fixture = fixture();
        let before = list(&fixture.store, ProjectListReq::default())
            .unwrap()
            .projects
            .len();

        let refused = fixture
            .create(ProjectCreateReq {
                name: "Sneaky".into(),
                working_directory: Some(WorkingDirectoryBinding::Path {
                    path: fixture
                        .dir
                        .path()
                        .join("projects")
                        .to_string_lossy()
                        .into_owned(),
                }),
                ..ProjectCreateReq::default()
            })
            .unwrap_err();

        assert_eq!(refused.code, IpcErrorCode::InvalidPayload);
        assert_eq!(
            list(&fixture.store, ProjectListReq::default())
                .unwrap()
                .projects
                .len(),
            before,
            "a refused create leaves no row behind"
        );
    }

    #[test]
    fn a_relative_working_directory_is_refused() {
        let fixture = fixture();
        let refused = fixture
            .create(ProjectCreateReq {
                name: "Notes".into(),
                working_directory: Some(WorkingDirectoryBinding::Path {
                    path: "notes".into(),
                }),
                ..ProjectCreateReq::default()
            })
            .unwrap_err();
        assert_eq!(refused.code, IpcErrorCode::InvalidPayload);
    }

    #[test]
    fn a_bound_working_directory_is_stored_and_read_back_resolved() {
        let fixture = fixture();
        let notes = tempfile::tempdir().unwrap();
        let created = fixture
            .create(ProjectCreateReq {
                name: "Field notes".into(),
                working_directory: Some(WorkingDirectoryBinding::Path {
                    path: notes.path().to_string_lossy().into_owned(),
                }),
                ..ProjectCreateReq::default()
            })
            .unwrap()
            .project;

        assert!(created.summary.working_directory_path.is_some());
        assert!(matches!(
            fixture.layout_of(&created.summary.id).working_directory,
            vela_projects::WorkingDirectory::Bound { .. }
        ));

        // Clearing it is a distinct intent from leaving it alone, and the
        // binding union is what lets a caller spell it.
        let cleared = update(
            &fixture.store,
            &fixture.host,
            ProjectUpdateReq {
                project_id: created.summary.id.clone(),
                working_directory: Some(WorkingDirectoryBinding::None),
                ..ProjectUpdateReq::default()
            },
        )
        .unwrap()
        .project;
        assert_eq!(cleared.summary.working_directory_path, None);
        assert_eq!(
            fixture.layout_of(&created.summary.id).working_directory,
            vela_projects::WorkingDirectory::None
        );
    }

    #[test]
    fn two_enabled_skills_that_are_one_directory_are_refused_rather_than_deduplicated() {
        let fixture = fixture();
        if fixture.host.case_folding() == CaseFolding::Sensitive {
            return; // On a case-sensitive volume they really are two skills.
        }
        fixture.install_skill("research");

        let refused = fixture
            .create(ProjectCreateReq {
                name: "Sails".into(),
                enabled_skills: Some(vec!["Research".into(), "research".into()]),
                ..ProjectCreateReq::default()
            })
            .unwrap_err();
        assert_eq!(refused.code, IpcErrorCode::InvalidPayload);
        assert!(
            refused.message.contains("Research") && refused.message.contains("research"),
            "the refusal names both halves so the user knows which two to look at"
        );

        // Byte-identical duplicates are refused too: one of them can never
        // mount, and the host cannot know which the user meant.
        assert!(fixture
            .create(ProjectCreateReq {
                name: "Sails".into(),
                enabled_skills: Some(vec!["research".into(), "research".into()]),
                ..ProjectCreateReq::default()
            })
            .is_err());

        // A refused update changes nothing, including the fields beside it.
        let existing = fixture.named("Rigging");
        let error = update(
            &fixture.store,
            &fixture.host,
            ProjectUpdateReq {
                project_id: existing.summary.id.clone(),
                name: Some("Renamed".into()),
                enabled_skills: Some(vec!["Research".into(), "research".into()]),
                ..ProjectUpdateReq::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::InvalidPayload);
        assert_eq!(
            get(
                &fixture.store,
                ProjectRefReq {
                    project_id: existing.summary.id
                }
            )
            .unwrap()
            .project
            .summary
            .name,
            "Rigging"
        );
    }

    #[test]
    fn an_enabled_skill_that_is_not_installed_mounts_unavailable_and_is_not_an_error() {
        let fixture = fixture();
        let created = fixture
            .create(ProjectCreateReq {
                name: "Sails".into(),
                enabled_skills: Some(vec!["never-installed".into()]),
                ..ProjectCreateReq::default()
            })
            .unwrap()
            .project;

        assert_eq!(created.enabled_skills, vec!["never-installed"]);
        let mounts = fixture.layout_of(&created.summary.id).mounts;
        assert_eq!(mounts.len(), 1, "intent and reality are separate fields");
        assert_eq!(
            mounts[0].status,
            vela_projects::SkillMountStatus::Unavailable {
                problem: vela_projects::SkillMountProblem::SkillNotFound
            }
        );
    }

    #[test]
    fn changing_the_enabled_set_re_mounts_before_the_command_returns() {
        let fixture = fixture();
        fixture.install_skill("research");
        fixture.install_skill("writing");
        let created = fixture
            .create(ProjectCreateReq {
                name: "Sails".into(),
                enabled_skills: Some(vec!["research".into()]),
                ..ProjectCreateReq::default()
            })
            .unwrap()
            .project;
        let mount_root = PathBuf::from(fixture.layout_of(&created.summary.id).paths.skills_mount);
        assert!(mount_root.join("research").exists());

        update(
            &fixture.store,
            &fixture.host,
            ProjectUpdateReq {
                project_id: created.summary.id.clone(),
                enabled_skills: Some(vec!["writing".into()]),
                ..ProjectUpdateReq::default()
            },
        )
        .unwrap();

        // Read straight off the disk, not through a second layout call: the
        // promise is that the mount is already right when `project_update`
        // returns.
        assert!(mount_root.join("writing").exists());
        assert!(!mount_root.join("research").exists());
    }

    #[test]
    fn a_layout_read_repairs_a_workspace_something_else_deleted_and_says_so() {
        let fixture = fixture();
        let created = fixture.named("Sails");
        let workspace = PathBuf::from(fixture.layout_of(&created.summary.id).paths.workspace);
        fs::remove_dir_all(&workspace).unwrap();

        let repaired = fixture.layout_of(&created.summary.id);
        assert_eq!(
            repaired.repaired,
            vec![vela_projects::ProjectDirectory::Workspace]
        );
        assert!(workspace.is_dir());
        assert!(
            fixture.layout_of(&created.summary.id).repaired.is_empty(),
            "a second read has nothing left to fix"
        );
    }

    #[test]
    fn a_name_longer_than_the_limit_is_refused_by_scalar_count() {
        let fixture = fixture();
        // Emoji: 120 scalars, 240 UTF-16 code units. Counting the wrong unit
        // makes the host and the renderer disagree about the same string.
        let border = "\u{1F30A}".repeat(PROJECT_NAME_MAX_CHARS);
        assert!(fixture
            .create(ProjectCreateReq {
                name: border.clone(),
                ..ProjectCreateReq::default()
            })
            .is_ok());
        assert_eq!(
            fixture
                .create(ProjectCreateReq {
                    name: format!("{border}\u{1F30A}"),
                    ..ProjectCreateReq::default()
                })
                .unwrap_err()
                .code,
            IpcErrorCode::InvalidPayload
        );
        assert!(fixture
            .create(ProjectCreateReq {
                name: "   ".into(),
                ..ProjectCreateReq::default()
            })
            .is_err());
    }

    #[test]
    fn instructions_default_to_an_empty_string_rather_than_to_a_second_empty_value() {
        let fixture = fixture();
        let created = fixture.named("Sails");
        assert_eq!(created.instructions, "");

        let written = update(
            &fixture.store,
            &fixture.host,
            ProjectUpdateReq {
                project_id: created.summary.id.clone(),
                instructions: Some("Answer like a navigator.".into()),
                ..ProjectUpdateReq::default()
            },
        )
        .unwrap()
        .project;
        assert_eq!(written.instructions, "Answer like a navigator.");

        assert_eq!(
            update(
                &fixture.store,
                &fixture.host,
                ProjectUpdateReq {
                    project_id: created.summary.id.clone(),
                    instructions: Some("x".repeat(PROJECT_INSTRUCTIONS_MAX_CHARS + 1)),
                    ..ProjectUpdateReq::default()
                },
            )
            .unwrap_err()
            .code,
            IpcErrorCode::InvalidPayload
        );
    }

    #[test]
    fn archiving_hides_a_project_and_touches_nothing_on_disk() {
        let fixture = fixture();
        let created = fixture.named("Sails");
        let root = PathBuf::from(fixture.layout_of(&created.summary.id).paths.root);

        update(
            &fixture.store,
            &fixture.host,
            ProjectUpdateReq {
                project_id: created.summary.id.clone(),
                archived: Some(true),
                ..ProjectUpdateReq::default()
            },
        )
        .unwrap();

        let visible = list(&fixture.store, ProjectListReq::default())
            .unwrap()
            .projects;
        assert!(!visible.iter().any(|p| p.id == created.summary.id));
        let all = list(
            &fixture.store,
            ProjectListReq {
                include_archived: Some(true),
            },
        )
        .unwrap()
        .projects;
        let archived = all
            .iter()
            .find(|p| p.id == created.summary.id)
            .expect("archived, not deleted");
        assert!(archived.archived_at_ms.is_some());
        assert!(
            root.is_dir(),
            "archiving is a flag, not a filesystem action"
        );
    }

    #[test]
    fn the_summary_carries_no_workspace_path_and_no_mount_state() {
        let fixture = fixture();
        let created = fixture.named("Sails");
        let json = serde_json::to_value(ProjectRes {
            project: created.clone(),
        })
        .unwrap();
        let summary = &json["project"]["summary"];

        // A field the renderer can read is a field the renderer will eventually
        // branch on, and where the private workspace lives is not its business.
        assert!(summary.get("workspace").is_none());
        assert!(summary.get("skillsMount").is_none());
        assert!(summary.get("mounts").is_none());
        assert_eq!(summary["isDefault"], false);
        assert!(summary["workingDirectoryPath"].is_null());
        assert_eq!(json["project"]["enabledSkills"], serde_json::json!([]));
    }

    #[test]
    fn the_layout_wire_shape_is_what_the_renderer_switches_on() {
        let fixture = fixture();
        let created = fixture.named("Sails");
        let json = serde_json::to_value(ProjectLayoutRes {
            layout: fixture.layout_of(&created.summary.id),
        })
        .unwrap();
        let layout = &json["layout"];

        assert_eq!(layout["projectId"], created.summary.id);
        assert!(layout["paths"]["skillsMount"].is_string());
        assert!(layout["paths"]["skillStore"].is_string());
        assert_eq!(layout["workingDirectory"]["kind"], "none");
        assert!(matches!(
            layout["linkStrategy"]["kind"].as_str(),
            Some("junction") | Some("symlink") | Some("copy")
        ));
        if cfg!(windows) {
            assert_ne!(
                layout["linkStrategy"]["kind"], "symlink",
                "a symlink on Windows needs a privilege the user does not have"
            );
        }
    }

    #[test]
    fn moving_a_conversation_to_a_project_that_does_not_exist_is_refused() {
        let fixture = fixture();
        let chat = fixture
            .store
            .create_conversation(NewConversation::titled("loose"))
            .unwrap();

        let error = move_conversation(
            &fixture.store,
            ProjectMoveConversationReq {
                conversation_id: chat.id.clone().into_string(),
                project_id: "proj_ghost".into(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, IpcErrorCode::NotFound);
        assert_eq!(
            fixture.store.get_conversation(&chat.id).unwrap().project_id,
            None
        );
    }
}
