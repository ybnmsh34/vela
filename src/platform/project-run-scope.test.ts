/**
 * What a run scoped to a project may see of the filesystem.
 *
 * `projectFilesystemScope` in `src/platform/contract-sandbox.ts` is the one
 * place the three-mount rule is code rather than prose — that file calls it
 * "shipped rather than described" — and it had **no test at all**: no file under
 * `src/` or `tests/` referenced it. So the sentence both frozen contracts argue
 * from was, in the end, still prose in two files and a constructor guarded by
 * nobody.
 *
 * The rule, from `src/platform/contract-project.ts` at `ProjectPaths.workspace`:
 * exactly three paths are mountable for a project run — this project's workspace
 * read-write, this project's skills mount **read-only, always**, and the
 * project's working directory if it has one. `vela.db`, the settings, the
 * keychain and the install are not mountable by anything at any permission
 * level, and neither is another project's root.
 *
 * ## Why the read-only clause is the one worth a test of its own
 *
 * The skills mount is a directory of junctions into the machine-wide skill store
 * (`LinkStrategy`), and every file API follows a junction transparently. A
 * `readWrite` mount of it is therefore a read-write handle on every skill
 * installed on the machine, handed to model-authored code, through a path that
 * looks project-scoped. Changing that one word in the constructor compiles,
 * typechecks, and — before this file — passed every test in the repository.
 * Nothing in the run's own output would show it.
 *
 * ## Nothing in the shipping app calls this function yet
 *
 * Said here, at the top, because it changes how every assertion below should be
 * read. `projectFilesystemScope` has **no call site in shipping code**: outside
 * its own definition in `src/platform/contract-sandbox.ts` and this file, every
 * reference to it is prose — three mentions in `src/platform/contract-project.ts`
 * (at `ProjectPaths.workspace`, at `WorkingDirectoryBinding`, and in that file's
 * amendments), two in `src/platform/contract-harness.ts` (at `ToolExecutor` and
 * in its amendment 4), and one in a comment in
 * `src-tauri/crates/vela-sandbox/tests/sandbox_boundary.rs`. So the seven tests
 * below hold a rule for a function no production path reaches.
 *
 * They are still worth having, and they are deliberately written before the
 * caller rather than after it: the rule they hold is one whose *first* wrong
 * implementation is the destructive one, and the reason it is shipped as a
 * function at all is that a rule re-derived by each builder is a rule that
 * varies. But "tested" and "reached" are different claims, and a reader meeting
 * a green suite named after the three-mount rule should not conclude that any
 * run in this application is scoped by it. None is, because no run in this
 * application executes code yet.
 *
 * **What would have to call it.** A `ToolExecutor` implementation — the
 * interface at `src/platform/contract-harness.ts`, whose own doc names this
 * function as the one place a run's mount set is built — assembling the
 * `SandboxSubmitReq` for a Bash or Python tool call. That executor would read
 * `project_layout` for `RunRequest.projectId`, decide the one judgement the
 * function leaves to a caller (the `WorkingDirectoryGrant`, or `null`), and pass
 * the result as the submit's `FilesystemScope`. Nothing on that path exists:
 * `src/runtime/subagent-toolkit.ts` is the only `ToolExecutor` in the tree and
 * it starts subagent runs rather than sandbox runs, and
 * `createSandboxRepository` in `src/data/sandbox-repository.ts` — which owns the
 * `sandbox_submit` invoke — has no caller outside its own tests. The day that
 * executor is written, this file is what says its mount set was not its to
 * invent; until then, it is a guard standing in front of a door.
 *
 * ## What this file does not claim
 *
 * `skillsMountMustBeReadOnly` is declared in `RefusalReason` and implemented in
 * no host, TypeScript or Rust. There is nothing to drive, so nothing here
 * asserts a refusal; what is held instead is the stronger half the contract
 * chose deliberately — that a caller **cannot spell** a writable skills mount
 * through this function, because it does not take the mode as an argument. The
 * refusal exists for a caller who assembles `Mount`s by hand, and it will need
 * its own test the day a host checks mounts.
 */

import { describe, expect, it } from 'vitest';

import type { ProjectLayout, WorkingDirectory } from './contract-project';
import type { Mount, WorkingDirectoryGrant } from './contract-sandbox';
import { projectFilesystemScope } from './contract-sandbox';

/**
 * The application-data layout of `ProjectPaths`, spelled out so the assertions
 * below can name a path that must **not** appear as easily as one that must.
 *
 * Windows separators because that is the platform Vela ships to; nothing in the
 * function parses these strings, so the choice only affects what a failure
 * message looks like.
 */
const APP_DATA = 'C:\\Users\\me\\AppData\\Roaming\\dev.vela.desktop';
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const ROOT = `${APP_DATA}\\projects\\${PROJECT_ID}`;
const WORKSPACE = `${ROOT}\\workspace`;
const SKILLS_MOUNT = `${ROOT}\\skills`;
const SKILL_STORE = `${APP_DATA}\\skills`;
const WORKING_DIRECTORY = 'C:\\Users\\me\\notes';

/** Paths a project run may never be handed, whatever it asks for. */
const UNREACHABLE = [
  `${APP_DATA}\\vela.db`,
  `${APP_DATA}\\settings.json`,
  APP_DATA,
  SKILL_STORE,
  `${APP_DATA}\\projects\\${OTHER_PROJECT_ID}`,
  `${APP_DATA}\\projects\\${OTHER_PROJECT_ID}\\workspace`,
];

function layoutWith(workingDirectory: WorkingDirectory): ProjectLayout {
  return {
    projectId: PROJECT_ID,
    paths: {
      root: ROOT,
      workspace: WORKSPACE,
      skillsMount: SKILLS_MOUNT,
      skillStore: SKILL_STORE,
    },
    linkStrategy: { kind: 'junction' },
    workingDirectory,
    mounts: [
      {
        name: 'research',
        source: `${SKILL_STORE}\\research`,
        status: { kind: 'linked', link: 'junction', path: `${SKILLS_MOUNT}\\research` },
      },
    ],
    repaired: [],
  };
}

const BOUND: WorkingDirectory = { kind: 'bound', path: WORKING_DIRECTORY, writable: true };

/** The most permissive thing a caller is allowed to ask for. */
const FULL_GRANT: WorkingDirectoryGrant = { mode: 'readWrite', materialisation: 'bind' };

const SCRATCH = { guestPath: null, retainAfterSettled: false } as const;

function scopeFor(
  workingDirectory: WorkingDirectory,
  grant: WorkingDirectoryGrant | null,
): readonly Mount[] {
  return projectFilesystemScope({
    layout: layoutWith(workingDirectory),
    workingDirectory: grant,
    scratch: SCRATCH,
  }).mounts;
}

function mountAt(mounts: readonly Mount[], hostPath: string): Mount {
  const found = mounts.find((mount) => mount.hostPath === hostPath);
  if (found === undefined) throw new Error(`no mount at ${hostPath}`);
  return found;
}

describe('a run scoped to a project sees three paths and no others', () => {
  it('mounts the skills mount read-only however permissive the caller was', () => {
    // The caller asks for everything it is allowed to ask for. The skills mount
    // is not one of the things it may ask about, and this is what says so.
    const mounts = scopeFor(BOUND, FULL_GRANT);
    const skills = mountAt(mounts, SKILLS_MOUNT);

    expect(skills.mode).toBe('readOnly');
    // The grant really was permissive, so the assertion above is about the
    // skills mount rather than about a scope that grants nothing to anybody.
    expect(mountAt(mounts, WORKING_DIRECTORY).mode).toBe('readWrite');
    // `copyIn` is refused for a second reason worth keeping separate: copying a
    // tree of junctions duplicates the machine-wide store once per run.
    expect(skills.materialisation).toBe('bind');
  });

  it('mounts the private workspace read-write and by binding, never by copy', () => {
    // A `copyIn` of the workspace would discard the run's own work at the moment
    // it settled — the one place a copy mode silently undoes the point of the
    // mount.
    const workspace = mountAt(scopeFor(BOUND, FULL_GRANT), WORKSPACE);
    expect(workspace.mode).toBe('readWrite');
    expect(workspace.materialisation).toBe('bind');
  });

  it('hands out the working directory only as the caller asked, or not at all', () => {
    const readOnly = scopeFor(BOUND, { mode: 'readOnly', materialisation: 'copyInCopyOut' });
    expect(mountAt(readOnly, WORKING_DIRECTORY).mode).toBe('readOnly');
    expect(mountAt(readOnly, WORKING_DIRECTORY).materialisation).toBe('copyInCopyOut');

    // `null` is "this run has no business in the user's files", and it wins over
    // a project that has one.
    expect(scopeFor(BOUND, null).map((mount) => mount.hostPath)).toEqual([
      WORKSPACE,
      SKILLS_MOUNT,
    ]);
  });

  it('produces no working-directory mount for a binding that is not there', () => {
    // Mounting a path that is not on disk is how a run gets an empty directory
    // where the user's files should be, and writes into it.
    for (const workingDirectory of [
      { kind: 'none' },
      { kind: 'unavailable', path: WORKING_DIRECTORY, problem: 'notFound' },
      { kind: 'unavailable', path: WORKING_DIRECTORY, problem: 'volumeUnavailable' },
    ] satisfies readonly WorkingDirectory[]) {
      const mounts = scopeFor(workingDirectory, FULL_GRANT);
      expect(mounts.map((mount) => mount.hostPath)).toEqual([WORKSPACE, SKILLS_MOUNT]);
    }
  });

  it('never reaches the store, the install, or another project, at any grant', () => {
    for (const grant of [FULL_GRANT, null]) {
      for (const workingDirectory of [BOUND, { kind: 'none' } as const]) {
        const paths = scopeFor(workingDirectory, grant).map((mount) => mount.hostPath);
        for (const forbidden of UNREACHABLE) {
          expect(paths).not.toContain(forbidden);
        }
      }
    }
  });

  it('reports the mounts in the order a refusal can point at', () => {
    // `RefusedOutcome.mountIndex` names a row a surface has to be able to show,
    // so the order is part of the answer rather than an artefact of it.
    expect(scopeFor(BOUND, FULL_GRANT).map((mount) => mount.hostPath)).toEqual([
      WORKSPACE,
      SKILLS_MOUNT,
      WORKING_DIRECTORY,
    ]);
  });

  it('mounts each path where it already is, and denies everything else', () => {
    const scope = projectFilesystemScope({
      layout: layoutWith(BOUND),
      workingDirectory: FULL_GRANT,
      scratch: SCRATCH,
    });
    for (const mount of scope.mounts) {
      expect(mount.guestPath).toBe(mount.hostPath);
    }
    expect(scope.outsideMounts).toBe('denied');
    expect(scope.scratch).toBe(SCRATCH);
  });
});
