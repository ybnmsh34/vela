import { describe, expect, it } from 'vitest';

import { NO_WINDOW_CONTROLS, type PlatformAdapter } from '@/platform/adapter';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { isAllowedCommand } from '@/platform/contract';
import { PlatformError } from '@/platform/errors';

import { createSkillsRepository } from './skills-repository';

/**
 * **VERIFIED-BY-FAKE.** Driven against `BrowserAdapter`, so what is proved here
 * is the protocol shape and the repository's own behaviour — that a broken
 * skill stays in the list, that reading one is a second call, and which
 * failures reject rather than resolve. Nothing here reads a SKILL.md file; the
 * parser and the real store are tested in `src-tauri/crates/vela-skills/`,
 * against real directories.
 */
describe('createSkillsRepository', () => {
  it('lists the store, broken skills included', async () => {
    const listed = await createSkillsRepository(new BrowserAdapter()).listSkills();

    // The point of the assertion: a directory that could not be parsed is a
    // row with a problem on it, not a row that is missing. A skill the user
    // installed must never disappear from every surface with no sentence
    // anywhere saying why.
    expect(listed.map((entry) => entry.kind)).toContain('invalid');
    expect(listed.map((entry) => entry.directory)).toEqual(['commit-messages', 'half-written']);
  });

  it('keeps the body out of the listing, which is what the budget is', async () => {
    const listed = await createSkillsRepository(new BrowserAdapter()).listSkills();
    const first = listed[0];
    expect(first?.kind).toBe('skill');
    // Structural, not a string search: there is no key on a listing entry a
    // body could arrive in.
    expect(Object.keys(first ?? {}).sort()).toEqual(['description', 'directory', 'kind', 'name']);
  });

  it('reads one skill on request, and only on request', async () => {
    const sent: Array<{ command: string; payload: unknown }> = [];
    const recording: PlatformAdapter = {
      kind: 'browser',
      window: NO_WINDOW_CONTROLS,
      invoke: async (command, payload) => {
        sent.push({ command, payload });
        return (
          command === 'skills_list'
            ? { skills: [] }
            : { kind: 'skill', name: 'a', description: 'd', body: 'B', resources: {} }
        ) as never;
      },
      listen: async () => () => {},
    };

    const repository = createSkillsRepository(recording);
    await repository.listSkills();
    expect(sent).toEqual([{ command: 'skills_list', payload: {} }]);

    await repository.readSkill('commit-messages');
    expect(sent[1]).toEqual({
      command: 'skills_read',
      payload: { name: 'commit-messages' },
    });
  });

  it('returns the instruction body for a skill that parses', async () => {
    const answer = await createSkillsRepository(new BrowserAdapter()).readSkill('commit-messages');
    expect(answer.kind).toBe('skill');
    if (answer.kind !== 'skill') throw new Error('unreachable');
    expect(answer.body).toContain('Say what changed and why');
    expect(answer.resources.scripts).toEqual([]);
  });

  it('answers a broken skill rather than rejecting on it', async () => {
    // The host's rule: the request was well formed and was answered truthfully.
    // Making this a rejection would split "this skill is broken" across a catch
    // block and a branch.
    const answer = await createSkillsRepository(new BrowserAdapter()).readSkill('half-written');
    expect(answer).toEqual({ kind: 'invalid', problem: 'missingDescription' });
  });

  it('rejects a name that is not one path segment, before anything is joined', async () => {
    const repository = createSkillsRepository(new BrowserAdapter());
    for (const attempt of ['../elsewhere', '..', 'sub/dir', 'sub\\dir', 'C:x', '']) {
      const failure = await repository.readSkill(attempt).catch((error: unknown) => error);
      expect(failure, attempt).toBeInstanceOf(PlatformError);
      expect(failure, attempt).toMatchObject({ code: 'INVALID_PAYLOAD' });
    }
  });

  it('rejects a skill the store does not have', async () => {
    const failure = await createSkillsRepository(new BrowserAdapter())
      .readSkill('never-installed')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlatformError);
    expect(failure).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('calls commands that are really on the allowlist', () => {
    // Cheap insurance that the two names above are the declared ones. A typo
    // would otherwise show up as `UNKNOWN_COMMAND` at runtime in the packaged
    // app and nowhere else.
    expect(isAllowedCommand('skills_list')).toBe(true);
    expect(isAllowedCommand('skills_read')).toBe(true);
  });
});
