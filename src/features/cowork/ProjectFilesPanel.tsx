/**
 * PROJECT — where this project's files are, and whether the host can reach them.
 *
 * ## What "files visible" can honestly mean at this commit
 *
 * There is **no command in `COMMAND_ALLOWLIST` that lists the contents of a
 * directory**, and adding one is a host change. `contract-project.ts` is
 * explicit about the neighbouring gaps too: a native folder picker "needs the
 * `dialog` capability, which `src-tauri/capabilities/main.json` does not
 * currently grant", and "there is also no command to reveal a folder in the OS
 * file manager … do not assume a 'reveal' button exists to be wired up".
 *
 * So this panel shows what the host can actually answer, which is
 * `ProjectLayout`: the three directories a project owns, the user's working
 * directory **resolved against the disk**, and one row per enabled skill with
 * its real mount state. That is a real answer to "where are my files and can
 * Vela see them" and it is not a file tree. The panel says so in its own words
 * rather than drawing an empty tree and letting the user conclude their folder
 * is empty — which is exactly what a `notFound` working directory would have
 * looked like.
 *
 * ## The distinction this panel exists to keep visible
 *
 * `ProjectSummary.workingDirectoryPath` is "the **stored binding**, not a
 * checked path". `ProjectLayout.workingDirectory` is that binding *resolved*.
 * Rendering the first would say "this is where the user pointed" while looking
 * like "this exists". Only the second can distinguish a folder that is gone from
 * one on a drive that is merely unplugged — `volumeUnavailable`, which the
 * contract carries precisely so a UI does not offer to re-pick a folder that is
 * asleep.
 */

import type {
  ProjectLayout,
  SkillMount,
  SkillMountProblem,
  WorkingDirectory,
  WorkingDirectoryProblem,
} from '@/platform/contract-project';

import styles from './CoworkPanel.module.css';
import type { ProjectLayoutController } from './use-project-layout';

/** Vela's words for the closed vocabulary. The renderer owns the wording. */
function workingDirectoryProblemText(problem: WorkingDirectoryProblem): string {
  switch (problem) {
    case 'notFound':
      return 'Nothing is at that path — it was deleted or renamed.';
    case 'notADirectory':
      return 'Something is at that path and it is not a folder.';
    case 'permissionDenied':
      return 'It is there, and Vela is not allowed to read it.';
    case 'volumeUnavailable':
      // Deliberately does not offer to re-pick. The contract carries this member
      // apart from `notFound` so that a UI does not tell a user to go and find a
      // folder that is on a drive they have not plugged in yet.
      return 'The drive or share it lives on is not connected right now.';
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}

function mountProblemText(problem: SkillMountProblem): string {
  switch (problem) {
    case 'skillNotFound':
      return 'Enabled for this project, but not in the skill store.';
    case 'nameIsNotASinglePathSegment':
      return 'That name is not a single folder name, so it was refused before being used as a path.';
    case 'pathTooLong':
      return 'The mounted path is longer than this system accepts.';
    case 'occupiedByUnrelatedEntry':
      // The contract is emphatic that this and the next are different repairs:
      // here the occupant is a stranger and the fix is the user's.
      return 'Something that is not Vela’s already occupies the mount path.';
    case 'nameCollidesWithAnotherEnabledSkill':
      return 'Another enabled skill already mounts here — the two names are one folder on this disk. Disable one.';
    case 'permissionDenied':
      return 'Vela is not allowed to create the mount.';
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}

function WorkingDirectoryRow({ directory }: { readonly directory: WorkingDirectory }) {
  if (directory.kind === 'none') {
    return (
      <li className={styles.row} data-testid="cowork-working-directory" data-kind="none">
        <span className={styles.rowHead}>
          <span className={styles.rowName}>Working directory</span>
          <span className={styles.badge}>Not set</span>
        </span>
        <p className={styles.note}>
          This project is not pointed at a folder of your own, which is an
          ordinary state. A run in it sees only its own scratch directory.
        </p>
      </li>
    );
  }

  if (directory.kind === 'bound') {
    return (
      <li className={styles.row} data-testid="cowork-working-directory" data-kind="bound">
        <span className={styles.rowHead}>
          <span className={styles.rowName}>Working directory</span>
          <span className={`${styles.badge} ${directory.writable ? styles.badgeOk : styles.badgeWarn}`}>
            {directory.writable ? 'Readable & writable' : 'Read-only'}
          </span>
        </span>
        <p className={styles.path}>{directory.path}</p>
        {!directory.writable && (
          <p className={styles.note}>
            Vela can read these files and cannot write them. A read-only reference
            folder is a legitimate thing to point a project at.
          </p>
        )}
      </li>
    );
  }

  return (
    <li className={styles.row} data-testid="cowork-working-directory" data-kind="unavailable">
      <span className={styles.rowHead}>
        <span className={styles.rowName}>Working directory</span>
        <span className={`${styles.badge} ${styles.badgeBad}`}>Unreachable</span>
      </span>
      <p className={styles.path}>{directory.path}</p>
      <p className={styles.error} role="status">
        {workingDirectoryProblemText(directory.problem)}
      </p>
    </li>
  );
}

function MountRow({ mount }: { readonly mount: SkillMount }) {
  const status = mount.status;
  return (
    <li className={styles.row} data-testid={`cowork-mount-${mount.name}`}>
      <span className={styles.rowHead}>
        <span className={styles.rowName}>{mount.name}</span>
        {status.kind === 'linked' && <span className={`${styles.badge} ${styles.badgeOk}`}>{status.link}</span>}
        {status.kind === 'copied' && (
          // A copy is a snapshot, and `stale` is why the contract refuses to let
          // it be rendered as just another link kind.
          <span className={`${styles.badge} ${status.stale ? styles.badgeWarn : styles.badgeOk}`}>
            {status.stale ? 'Copy — out of date' : 'Copy'}
          </span>
        )}
        {status.kind === 'unavailable' && (
          <span className={`${styles.badge} ${styles.badgeBad}`}>Not mounted</span>
        )}
      </span>
      {/* `source` is null in exactly one case — a name that is not a single path
          segment — because producing its resolved path would perform the join
          the rule forbids. So there is genuinely nothing to show. */}
      {mount.source !== null && <p className={styles.path}>{mount.source}</p>}
      {status.kind === 'unavailable' && (
        <p className={styles.note}>{mountProblemText(status.problem)}</p>
      )}
    </li>
  );
}

export function ProjectFilesPanel({ layout }: { readonly layout: ProjectLayoutController }) {
  const state = layout.state;

  if (state.status === 'noProject') {
    return (
      <p className={styles.note} data-testid="cowork-project-none">
        No project yet. Vela asks the host which projects exist before a run can
        belong to one; until that answer lands there is nothing to show here.
      </p>
    );
  }

  if (state.status === 'loading') {
    return (
      <p className={styles.note} data-testid="cowork-project-loading">
        Reading this project’s folders…
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <p className={styles.error} role="status" data-testid="cowork-project-error">
        {`This project’s folders could not be read · ${state.code} · ${state.message}`}
      </p>
    );
  }

  const value: ProjectLayout = state.layout;

  return (
    <>
      <p className={styles.intro}>
        Where this project’s files live. Vela cannot list the contents of your
        folder — no host command does that yet — so this is where it looks and
        whether it can currently get there.
      </p>

      <ul className={styles.rows}>
        <WorkingDirectoryRow directory={value.workingDirectory} />

        <li className={styles.row} data-testid="cowork-workspace">
          <span className={styles.rowHead}>
            <span className={styles.rowName}>Agent workspace</span>
            <span className={styles.badge}>Vela’s</span>
          </span>
          <p className={styles.path}>{value.paths.workspace}</p>
          <p className={styles.note}>
            Scratch space the agent writes in. Disposable by design — deleting it
            loses nothing you wrote.
          </p>
        </li>

        <li className={styles.row} data-testid="cowork-skills-mount">
          <span className={styles.rowHead}>
            <span className={styles.rowName}>Skills mount</span>
            <span className={styles.badge}>
              {value.linkStrategy.kind === 'copy'
                ? `Copies · ${value.linkStrategy.reason}`
                : value.linkStrategy.kind}
            </span>
          </span>
          <p className={styles.path}>{value.paths.skillsMount}</p>
        </li>
      </ul>

      {value.mounts.length > 0 && (
        <>
          <p className={styles.intro}>{`Enabled skills · ${value.mounts.length}`}</p>
          <ul className={styles.rows}>
            {value.mounts.map((mount) => (
              <MountRow key={mount.name} mount={mount} />
            ))}
          </ul>
        </>
      )}

      {value.repaired.length > 0 && (
        // Not an error and deliberately not rendered as one — the contract says
        // so — but worth saying once, because a project that repairs itself on
        // every read is a project whose root something else is deleting.
        <p className={styles.note} role="status" data-testid="cowork-repaired">
          {`Vela recreated ${value.repaired.join(', ')} — ${
            value.repaired.length === 1 ? 'it was' : 'they were'
          } missing when this was read.`}
        </p>
      )}

      <p className={styles.footnote}>
        Read from the host just now. Reading it also repairs Vela’s own folders,
        so it is not on a timer.
      </p>

      <span className={styles.commentActions}>
        <button type="button" className={styles.button} onClick={layout.reload}>
          Read again
        </button>
      </span>
    </>
  );
}
