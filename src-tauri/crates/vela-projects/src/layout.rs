//! Where a project's host-owned directories are, and what reading them repairs.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::casefold::CaseFolding;
use crate::link::{remove_tree, LinkStrategy};
use crate::mount::{reconcile_skills, SkillMount};
use crate::workdir::{resolve_working_directory, WorkingDirectory};

/// `<app data dir>/projects` — the parent of every project root.
pub fn projects_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("projects")
}

/// `<app data dir>/projects/<project-id>`.
///
/// **Keyed by id, never by name.** A name-derived directory needs a sanitiser —
/// characters stripped, hyphen runs collapsed, a length cap, a table of Windows
/// reserved device names to suffix around, and a containment re-check so a
/// project cannot escape its root — and it makes rename a directory move under
/// running work. An id needs none of that, which is what lets even the default
/// project be renamed.
pub fn project_root(app_data_dir: &Path, project_id: &str) -> PathBuf {
    projects_root(app_data_dir).join(project_id)
}

/// `<app data dir>/skills` — the canonical store, **one per machine**, shared by
/// every project.
pub fn skill_store(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("skills")
}

/// Where a project's host-owned directories are, all absolute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPaths {
    /// `<app data dir>/projects/<project-id>`.
    pub root: String,
    /// `<root>/workspace` — the private agent workspace. Disposable by
    /// construction: deleting the whole directory must lose nothing the user
    /// authored, which is what makes repairing it on read safe rather than
    /// destructive.
    pub workspace: String,
    /// `<root>/skills`, a **sibling** of the workspace rather than a child. The
    /// sibling relationship is load-bearing: this directory is full of links
    /// into the canonical store, so "empty the workspace" — the one operation
    /// this design calls safe — must not be able to reach a link at all.
    pub skills_mount: String,
    /// `<app data dir>/skills`. Carried so a UI explaining a mount can name the
    /// real target instead of implying each project holds its own copy.
    pub skill_store: String,
}

impl ProjectPaths {
    pub fn resolve(app_data_dir: &Path, project_id: &str) -> Self {
        let root = project_root(app_data_dir, project_id);
        Self {
            workspace: display(&root.join("workspace")),
            skills_mount: display(&root.join("skills")),
            skill_store: display(&skill_store(app_data_dir)),
            root: display(&root),
        }
    }

    pub fn root_path(&self) -> &Path {
        Path::new(&self.root)
    }

    pub fn workspace_path(&self) -> &Path {
        Path::new(&self.workspace)
    }

    pub fn skills_mount_path(&self) -> &Path {
        Path::new(&self.skills_mount)
    }

    pub fn skill_store_path(&self) -> &Path {
        Path::new(&self.skill_store)
    }
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The host-owned **per-project** directories, addressable one at a time.
///
/// Three of the four on [`ProjectPaths`]; `skillStore` is missing on purpose,
/// because it is machine-wide and is therefore not a thing reading one project
/// can repair or report. A per-project field that could name it would let forty
/// projects report the same repair forty times.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectDirectory {
    Root,
    Workspace,
    SkillsMount,
}

/// A project's on-disk reality, as of the moment it was read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLayout {
    pub project_id: String,
    pub paths: ProjectPaths,
    pub link_strategy: LinkStrategy,
    pub working_directory: WorkingDirectory,
    /// One per enabled skill, in the order the record lists them.
    pub mounts: Vec<SkillMount>,
    /// Host-owned directories that were missing on this read and were
    /// recreated. Empty is the normal case. Non-empty is not an error, but it is
    /// worth surfacing once: a project that repairs itself on every read is a
    /// project whose root something else is deleting.
    pub repaired: Vec<ProjectDirectory>,
}

/// Creates the three host-owned directories, **all or none**.
///
/// Called by `project_create` before it returns. A partially created project is
/// an error, never a success with a hole in it, so a failure part-way through
/// takes the root back out with it.
pub fn create_project_directories(
    app_data_dir: &Path,
    project_id: &str,
) -> io::Result<ProjectPaths> {
    let paths = ProjectPaths::resolve(app_data_dir, project_id);
    let attempt = fs::create_dir_all(paths.workspace_path())
        .and_then(|()| fs::create_dir_all(paths.skills_mount_path()));
    if let Err(error) = attempt {
        let _ = remove_tree(paths.root_path());
        return Err(error);
    }
    Ok(paths)
}

/// Creates `<app data dir>/skills` if it is not there.
///
/// **Called by the host at launch, before it serves any command that reads it**
/// — not lazily by whichever command runs first, because a store created inside
/// one command produces a different answer for the same disk depending on which
/// command the user happened to invoke. Empty is the correct state on a machine
/// with no skills installed, and it has exactly one consequence: every enabled
/// skill then mounts `unavailable` with `skillNotFound`.
pub fn ensure_skill_store(app_data_dir: &Path) -> io::Result<PathBuf> {
    let store = skill_store(app_data_dir);
    fs::create_dir_all(&store)?;
    Ok(store)
}

/// Removes a project root, **detaching the skill mounts rather than walking
/// through them**.
///
/// The root contains the skills mount, which is full of reparse points into the
/// machine-wide canonical store. A recursive delete that descends one of them
/// takes every skill on the machine rather than one project's view of them.
/// `remove_tree` is what makes that impossible;
/// `removing_a_project_root_unlinks_the_skill_mounts_instead_of_emptying_the_store`
/// is the test that proves it, and it goes red the moment reparse points stop
/// being detected.
///
/// The **working directory is not touched**, and no argument exists that could
/// ask for it to be: a flag for that is right ninety-nine times and
/// unrecoverable the hundredth.
pub fn remove_project_root(app_data_dir: &Path, project_id: &str) -> io::Result<()> {
    remove_tree(&project_root(app_data_dir, project_id))
}

/// Reads a project's layout, **repairing what is missing**.
///
/// If a host-owned directory has gone — the user cleaned out their
/// application-data folder, a sync client removed it, an installer moved it —
/// it is recreated and named in [`ProjectLayout::repaired`]. That is safe
/// because the workspace is disposable by construction, and it is the answer to
/// a layout that is only correct if one function ran once, months ago.
///
/// The working directory is emphatically **not** repaired. It is the user's, and
/// a missing one is reported.
pub fn resolve_layout(
    app_data_dir: &Path,
    project_id: &str,
    strategy: LinkStrategy,
    stored_working_directory: Option<&str>,
    enabled_skills: &[String],
) -> io::Result<ProjectLayout> {
    let paths = ProjectPaths::resolve(app_data_dir, project_id);

    // Every existence question is asked before anything is created, so that
    // creating the workspace (which creates the root on the way) cannot make
    // the root look like it was there all along.
    let missing: Vec<ProjectDirectory> = [
        (ProjectDirectory::Root, paths.root_path()),
        (ProjectDirectory::Workspace, paths.workspace_path()),
        (ProjectDirectory::SkillsMount, paths.skills_mount_path()),
    ]
    .into_iter()
    .filter(|(_, path)| !path.is_dir())
    .map(|(which, _)| which)
    .collect();

    fs::create_dir_all(paths.workspace_path())?;
    fs::create_dir_all(paths.skills_mount_path())?;

    // Asked of the skills mount and not of the application-data directory,
    // because it is the mount's volume whose casing rules decide whether two
    // enabled names are one path. `%APPDATA%` can be redirected onto a
    // different volume than the one this process started on.
    let folding = CaseFolding::probe(paths.skills_mount_path());
    let mounts = reconcile_skills(&paths, strategy, enabled_skills, folding);

    Ok(ProjectLayout {
        project_id: project_id.to_owned(),
        paths,
        link_strategy: strategy,
        working_directory: resolve_working_directory(stored_working_directory),
        mounts,
        repaired: missing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link::{create_link, is_reparse_point, probe_link_strategy};
    use crate::mount::SkillMountStatus;

    const PROJECT: &str = "00000000-0000-4000-8000-000000000001";

    fn app_data() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        ensure_skill_store(dir.path()).unwrap();
        dir
    }

    fn install_skill(app_data_dir: &Path, name: &str) -> PathBuf {
        let path = skill_store(app_data_dir).join(name);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("SKILL.md"), format!("# {name}")).unwrap();
        path
    }

    fn layout(app_data_dir: &Path, enabled: &[&str]) -> ProjectLayout {
        let enabled: Vec<String> = enabled.iter().map(|name| (*name).to_string()).collect();
        resolve_layout(
            app_data_dir,
            PROJECT,
            probe_link_strategy(app_data_dir),
            None,
            &enabled,
        )
        .unwrap()
    }

    #[test]
    fn the_three_directories_are_keyed_by_id_and_the_store_is_not_one_of_them() {
        let data = app_data();
        let paths = ProjectPaths::resolve(data.path(), PROJECT);

        assert!(paths.root.ends_with(PROJECT), "the root is the id");
        assert_eq!(paths.workspace_path().parent().unwrap(), paths.root_path());
        assert_eq!(
            paths.skills_mount_path().parent().unwrap(),
            paths.root_path(),
            "the mount is a sibling of the workspace, not a child of it"
        );
        assert!(
            !paths.skill_store_path().starts_with(paths.root_path()),
            "the canonical store is machine-wide and lives outside every project"
        );
    }

    #[test]
    fn creating_a_project_makes_all_three_directories_before_it_returns() {
        let data = app_data();
        let paths = create_project_directories(data.path(), PROJECT).unwrap();

        assert!(paths.root_path().is_dir());
        assert!(paths.workspace_path().is_dir());
        assert!(paths.skills_mount_path().is_dir());
    }

    #[test]
    fn reading_a_layout_repairs_what_is_missing_and_says_what_it_had_to_fix() {
        let data = app_data();
        create_project_directories(data.path(), PROJECT).unwrap();

        // A clean read repairs nothing.
        assert!(layout(data.path(), &[]).repaired.is_empty());

        // A sync client removed the workspace.
        let paths = ProjectPaths::resolve(data.path(), PROJECT);
        remove_tree(paths.workspace_path()).unwrap();
        let repaired = layout(data.path(), &[]);
        assert_eq!(repaired.repaired, vec![ProjectDirectory::Workspace]);
        assert!(paths.workspace_path().is_dir());

        // The whole root went. All three are named, in layout order.
        remove_tree(paths.root_path()).unwrap();
        assert_eq!(
            layout(data.path(), &[]).repaired,
            vec![
                ProjectDirectory::Root,
                ProjectDirectory::Workspace,
                ProjectDirectory::SkillsMount,
            ]
        );
    }

    #[test]
    fn reading_a_layout_never_recreates_the_users_working_directory() {
        let data = app_data();
        create_project_directories(data.path(), PROJECT).unwrap();
        let notes = tempfile::tempdir().unwrap();
        let gone = notes.path().join("moved-away");
        let stored = gone.to_string_lossy().into_owned();

        let resolved = resolve_layout(
            data.path(),
            PROJECT,
            probe_link_strategy(data.path()),
            Some(&stored),
            &[],
        )
        .unwrap();

        assert!(matches!(
            resolved.working_directory,
            WorkingDirectory::Unavailable { .. }
        ));
        assert!(!gone.exists(), "the user's folder is theirs, not ours");
    }

    #[test]
    fn removing_a_project_root_unlinks_the_skill_mounts_instead_of_emptying_the_store() {
        // THE test this crate exists for. A recursive delete that follows a
        // junction takes every skill on the machine, not one project's view of
        // them.
        let data = app_data();
        let installed = install_skill(data.path(), "research");
        create_project_directories(data.path(), PROJECT).unwrap();
        let resolved = layout(data.path(), &["research"]);

        let mounted = ProjectPaths::resolve(data.path(), PROJECT)
            .skills_mount_path()
            .join("research");
        match &resolved.mounts[0].status {
            SkillMountStatus::Linked { path, .. } => {
                assert_eq!(Path::new(path), mounted);
                assert_eq!(
                    fs::read_to_string(mounted.join("SKILL.md")).unwrap(),
                    "# research",
                    "the mount really does reach the canonical skill"
                );
            }
            // A machine that copies has no reparse point at the mount, so the
            // hazard this test is about would not be present and the test would
            // pass without measuring anything. Plant the link, so what is under
            // test is the removal rather than the machine.
            _ => {
                remove_tree(&mounted).unwrap();
                create_link(&mounted, &installed).unwrap();
            }
        }
        assert!(
            is_reparse_point(&mounted).unwrap(),
            "the scenario is only worth removing if there is a link to walk through"
        );
        fs::write(
            ProjectPaths::resolve(data.path(), PROJECT)
                .workspace_path()
                .join("scratch.txt"),
            "agent output",
        )
        .unwrap();

        remove_project_root(data.path(), PROJECT).unwrap();

        assert!(!project_root(data.path(), PROJECT).exists());
        assert!(
            installed.join("SKILL.md").is_file(),
            "deleting one project must never reach into the machine-wide skill store"
        );
    }

    #[test]
    fn a_link_left_directly_under_the_root_is_still_not_walked_through() {
        // Defence in depth for the rule above: the mount is where a link is
        // *supposed* to be, and a removal that only special-cased that one path
        // would be correct today and wrong the moment the layout changes.
        let data = app_data();
        let installed = install_skill(data.path(), "research");
        create_project_directories(data.path(), PROJECT).unwrap();
        let stray = project_root(data.path(), PROJECT).join("stray-link");
        create_link(&stray, &installed).unwrap();

        remove_project_root(data.path(), PROJECT).unwrap();

        assert!(installed.join("SKILL.md").is_file());
    }
}
