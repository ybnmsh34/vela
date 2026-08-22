/**
 * **The project rules, asserted through the real command surface.**
 *
 * `src/platform/contract-project.ts` states a great many rules and its own
 * header says none of them were enforced by anything — "Every rule stated below
 * is therefore **unenforced** unless the sentence naming it also names the thing
 * that enforces it." This file is that thing for the rules a renderer can see,
 * and `src-tauri/src/ipc/project.rs`'s tests are it for the rules that need a
 * disk.
 *
 * Everything here goes through `invoke`, never through the adapter's internals:
 * a fake that is only correct when poked from inside teaches the UI nothing.
 *
 * **VERIFIED-BY-FAKE.** No filesystem is touched. Nothing here is evidence about
 * a junction, a workspace directory, or a skill mount — those live in
 * `src-tauri/crates/vela-projects/`, where the tests run against a real
 * temporary directory because that is the only honest fixture for a claim about
 * a filesystem. What *is* evidence here is the protocol: which commands exist,
 * what they refuse, and what a UI written against them will see.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserAdapter } from './browser-adapter';
import { COMMAND_ALLOWLIST, isAllowedCommand } from './contract';
import {
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  PROJECT_COMMAND_NAMES,
  PROJECT_NAME_MAX_CHARS,
} from './contract-project';
import { PlatformError } from './errors';

let adapter: BrowserAdapter;

beforeEach(() => {
  adapter = new BrowserAdapter();
});

async function refused(run: () => Promise<unknown>): Promise<PlatformError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PlatformError) return error;
    throw error;
  }
  throw new Error('expected the command to be refused, and it was not');
}

describe('the project commands are actually reachable', () => {
  it('has every declared project command on the allowlist', () => {
    // The defect this whole repo keeps finding is "the thing everyone believed
    // was connected, was not". `contract-project.ts` declared these names for a
    // wire that did not exist; this is the assertion that says it does now.
    // Its Rust twin is `rust_and_typescript_allowlists_are_identical`, and
    // `src-tauri/tests/handler_binding.rs` covers the third leg — the dispatch
    // table the packaged binary consults.
    for (const name of PROJECT_COMMAND_NAMES) {
      expect(isAllowedCommand(name), `\`${name}\` is declared but not allowlisted`).toBe(true);
    }
    expect(PROJECT_COMMAND_NAMES.every((name) => COMMAND_ALLOWLIST.includes(name))).toBe(true);
  });

  it('answers every one of them rather than throwing UNKNOWN_COMMAND', async () => {
    const { project } = await adapter.invoke('project_create', { name: 'Reachability' });
    const id = project.summary.id;

    await expect(adapter.invoke('project_list', {})).resolves.toBeDefined();
    await expect(adapter.invoke('project_get', { projectId: id })).resolves.toBeDefined();
    await expect(adapter.invoke('project_layout', { projectId: id })).resolves.toBeDefined();
    await expect(
      adapter.invoke('project_reconcile_skills', { projectId: id }),
    ).resolves.toBeDefined();
    await expect(adapter.invoke('project_update', { projectId: id })).resolves.toBeDefined();

    const { conversation } = await adapter.invoke('store_create_conversation', {});
    await expect(
      adapter.invoke('project_move_conversation', {
        conversationId: conversation.id,
        projectId: id,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(adapter.invoke('project_delete', { projectId: id })).resolves.toEqual({
      ok: true,
    });
  });
});

describe('the one project that always exists', () => {
  it('is there from the first read, flagged rather than recognised by its id', async () => {
    const { projects } = await adapter.invoke('project_list', {});

    expect(projects).toHaveLength(1);
    expect(projects[0]?.isDefault).toBe(true);
    expect(projects[0]?.name).toBe(DEFAULT_PROJECT_NAME);
    // The id is checked here — in a test, which is the one place that may — to
    // prove the seed names the row the contract says it does. No component may
    // do this: `isDefault` exists so the literal never appears in a condition
    // under `src/features/`.
    expect(projects[0]?.id).toBe(DEFAULT_PROJECT_ID);

    const { project } = await adapter.invoke('project_create', { name: 'Sails' });
    expect(project.summary.isDefault).toBe(false);
  });

  it('may be renamed, because its directory is keyed by id and not by name', async () => {
    const { project } = await adapter.invoke('project_update', {
      projectId: DEFAULT_PROJECT_ID,
      name: 'Everything else',
    });

    expect(project.summary.name).toBe('Everything else');
    expect(project.summary.isDefault).toBe(true);
    // Nothing re-derives a label from the seed constant, which is why
    // DEFAULT_PROJECT_NAME is documented as true only at seed time.
    const { projects } = await adapter.invoke('project_list', {});
    expect(projects.map((summary) => summary.name)).toEqual(['Everything else']);
  });

  it('may not be deleted, because it is where every other project empties into', async () => {
    const error = await refused(() =>
      adapter.invoke('project_delete', { projectId: DEFAULT_PROJECT_ID }),
    );
    expect(error.code).toBe('INVALID_PAYLOAD');

    const { projects } = await adapter.invoke('project_list', {});
    expect(projects.some((summary) => summary.isDefault)).toBe(true);
  });
});

describe('deleting a project', () => {
  it('reassigns its conversations to the default and never deletes them', async () => {
    const { project } = await adapter.invoke('project_create', { name: 'Sails' });
    const { conversation } = await adapter.invoke('store_create_conversation', {
      title: 'rigging',
    });
    await adapter.invoke('project_move_conversation', {
      conversationId: conversation.id,
      projectId: project.summary.id,
    });

    const filed = await adapter.invoke('project_get', { projectId: project.summary.id });
    expect(filed.project.summary.conversationCount).toBe(1);
    expect(filed.project.summary.lastActiveAtMs).not.toBeNull();

    await adapter.invoke('project_delete', { projectId: project.summary.id });

    const { conversations } = await adapter.invoke('store_list_conversations', {});
    expect(
      conversations.map((summary) => summary.id),
      'the conversation survives its project',
    ).toContain(conversation.id);

    const { projects } = await adapter.invoke('project_list', {});
    const fallback = projects.find((summary) => summary.isDefault);
    expect(fallback?.conversationCount, 'it landed in the default project').toBe(1);
  });

  it('is NOT_FOUND for a project that is not there, rather than a silent success', async () => {
    const error = await refused(() => adapter.invoke('project_delete', { projectId: 'proj_ghost' }));
    expect(error.code).toBe('NOT_FOUND');
  });
});

describe('enabled skills are intent, and a colliding pair is refused', () => {
  it('refuses two names that are one directory, without deduplicating them', async () => {
    // The user enabled two things, one of them cannot exist, and the host has
    // no way to know which they meant. Silently dropping one leaves a skill
    // switched on that never mounts and never says so.
    const error = await refused(() =>
      adapter.invoke('project_create', {
        name: 'Sails',
        enabledSkills: ['Research', 'research'],
      }),
    );
    expect(error.code).toBe('INVALID_PAYLOAD');
    expect(error.message).toContain('Research');
    expect(error.message).toContain('research');

    // Byte-identical duplicates are the same problem and are refused too.
    const duplicate = await refused(() =>
      adapter.invoke('project_create', { name: 'Sails', enabledSkills: ['notes', 'notes'] }),
    );
    expect(duplicate.code).toBe('INVALID_PAYLOAD');

    const { projects } = await adapter.invoke('project_list', {});
    expect(projects, 'a refused create leaves no row behind').toHaveLength(1);
  });

  it('leaves a refused update entirely alone, including the fields beside it', async () => {
    const { project } = await adapter.invoke('project_create', {
      name: 'Sails',
      enabledSkills: ['research'],
    });

    const error = await refused(() =>
      adapter.invoke('project_update', {
        projectId: project.summary.id,
        name: 'Renamed',
        enabledSkills: ['Research', 'research'],
      }),
    );
    expect(error.code).toBe('INVALID_PAYLOAD');

    const after = await adapter.invoke('project_get', { projectId: project.summary.id });
    expect(after.project.summary.name).toBe('Sails');
    expect(after.project.enabledSkills).toEqual(['research']);
  });

  it('replaces the whole set rather than adding to it, and keeps the order', async () => {
    const { project } = await adapter.invoke('project_create', {
      name: 'Sails',
      enabledSkills: ['research', 'writing'],
    });
    expect(project.enabledSkills).toEqual(['research', 'writing']);

    const replaced = await adapter.invoke('project_update', {
      projectId: project.summary.id,
      enabledSkills: ['writing'],
    });
    expect(replaced.project.enabledSkills).toEqual(['writing']);

    const cleared = await adapter.invoke('project_update', {
      projectId: project.summary.id,
      enabledSkills: [],
    });
    expect(cleared.project.enabledSkills).toEqual([]);
  });

  it('reports one mount per enabled skill even when none of them can be mounted', async () => {
    const { project } = await adapter.invoke('project_create', {
      name: 'Sails',
      enabledSkills: ['research', 'writing'],
    });
    const { layout } = await adapter.invoke('project_layout', { projectId: project.summary.id });

    // Dropping a failed mount would let a project silently run without a skill
    // the user switched on.
    expect(layout.mounts.map((mount) => mount.name)).toEqual(['research', 'writing']);
    expect(layout.mounts.every((mount) => mount.status.kind === 'unavailable')).toBe(true);
  });
});

describe('what the payload rules refuse', () => {
  it('counts a name in scalar values, so the host and the renderer agree', async () => {
    // 120 emoji: 120 scalars, 240 UTF-16 code units. Counting `.length` here
    // would refuse a name Rust accepts, and the user would see a validation
    // error the field it came from cannot explain.
    const border = '\u{1F30A}'.repeat(PROJECT_NAME_MAX_CHARS);
    await expect(adapter.invoke('project_create', { name: border })).resolves.toBeDefined();

    const error = await refused(() =>
      adapter.invoke('project_create', { name: `${border}\u{1F30A}` }),
    );
    expect(error.code).toBe('INVALID_PAYLOAD');

    const blank = await refused(() => adapter.invoke('project_create', { name: '   ' }));
    expect(blank.code).toBe('INVALID_PAYLOAD');
  });

  it('refuses a relative working directory', async () => {
    const error = await refused(() =>
      adapter.invoke('project_create', {
        name: 'Notes',
        workingDirectory: { kind: 'path', path: 'notes' },
      }),
    );
    expect(error.code).toBe('INVALID_PAYLOAD');
  });

  it('tells "clear it" apart from "leave it alone"', async () => {
    const { project } = await adapter.invoke('project_create', {
      name: 'Field notes',
      workingDirectory: { kind: 'path', path: 'C:\\Users\\me\\notes' },
    });
    expect(project.summary.workingDirectoryPath).toBe('C:\\Users\\me\\notes');

    // An omitted field leaves it alone…
    const untouched = await adapter.invoke('project_update', {
      projectId: project.summary.id,
      name: 'Notes',
    });
    expect(untouched.project.summary.workingDirectoryPath).toBe('C:\\Users\\me\\notes');

    // …and only the `none` variant clears it. A nullable string could spell
    // only one of those two intents.
    const cleared = await adapter.invoke('project_update', {
      projectId: project.summary.id,
      workingDirectory: { kind: 'none' },
    });
    expect(cleared.project.summary.workingDirectoryPath).toBeNull();
  });

  it('has one spelling of "no instructions", and it is the empty string', async () => {
    const { project } = await adapter.invoke('project_create', { name: 'Sails' });
    expect(project.instructions).toBe('');
  });
});

describe('archiving', () => {
  it('hides a project from the list without destroying it', async () => {
    const { project } = await adapter.invoke('project_create', { name: 'Sails' });
    await adapter.invoke('project_update', { projectId: project.summary.id, archived: true });

    const visible = await adapter.invoke('project_list', {});
    expect(visible.projects.map((summary) => summary.id)).not.toContain(project.summary.id);

    const all = await adapter.invoke('project_list', { includeArchived: true });
    const archived = all.projects.find((summary) => summary.id === project.summary.id);
    expect(archived?.archivedAtMs).not.toBeNull();

    // Restoring is exactly undoing, which is why it is one bit and not two
    // commands.
    await adapter.invoke('project_update', { projectId: project.summary.id, archived: false });
    const restored = await adapter.invoke('project_list', {});
    expect(restored.projects.map((summary) => summary.id)).toContain(project.summary.id);
  });
});

describe('what a list surface is allowed to see', () => {
  it('carries no workspace path and no mount state', async () => {
    const { project } = await adapter.invoke('project_create', {
      name: 'Sails',
      enabledSkills: ['research'],
    });
    const summary = project.summary as unknown as Record<string, unknown>;

    // A field the renderer can read is a field the renderer will eventually
    // branch on, and where the private agent workspace lives is not the
    // renderer's business.
    expect(Object.keys(summary).sort()).toEqual([
      'archivedAtMs',
      'conversationCount',
      'createdAtMs',
      'id',
      'isDefault',
      'lastActiveAtMs',
      'name',
      'updatedAtMs',
      'workingDirectoryPath',
    ]);
  });

  it('never claims a browser tab wrote anything to a disk', async () => {
    const { project } = await adapter.invoke('project_create', { name: 'Sails' });
    const { layout } = await adapter.invoke('project_layout', { projectId: project.summary.id });

    // The fake's honesty rule: a screenshot of this screen must not be
    // mistakable for evidence that a workspace exists.
    expect(layout.paths.root).toContain('browser fake');
    expect(layout.paths.workspace).toContain('browser fake');
    expect(layout.linkStrategy).toEqual({ kind: 'copy', reason: 'probeFailed' });
  });
});
