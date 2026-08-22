/**
 * The skill store, as the renderer asks for it.
 *
 * A repository over the two `skills_*` commands, following the rules in
 * `src/data/host-repository.ts`: no React, the adapter arrives as an argument,
 * and nothing here invents data the host did not send.
 *
 * ## Progressive disclosure is why there are two methods and not one
 *
 * The public Agent Skills format loads a name and a description for every
 * installed skill, and the instruction body only for a skill that is actually
 * being used. That is a token budget, and a budget survives only if the cheap
 * call cannot accidentally become the expensive one — so {@link listSkills}
 * returns entries with no body on them at all, and {@link readSkill} is a
 * second, deliberate call for exactly one skill.
 *
 * A convenience that fetched every body "so the caller does not have to think
 * about it" would quietly undo the whole model, which is why there is none.
 *
 * ## What this cannot do
 *
 * Read. There is no write, upload or delete command to wrap: a skill is a
 * directory of files the user owns and edits with their own editor, and
 * `src-tauri/src/ipc/skills.rs` exposes no way for Vela to change one.
 *
 * Nothing here knows what a project is. Enabling a skill *into* a project is
 * the mount, which lives in `src-tauri/crates/vela-projects/src/mount.rs`, and
 * `project_reconcile_skills` is the command in front of it. This sentence used
 * to name a `mount.rs` in the *skills* crate and say it had no command yet:
 * both halves were wrong, that module had no caller in any commit, and it has
 * been deleted. There is no repository in this directory for the project side;
 * the renderer reaches those commands through `src/platform/adapter.ts`.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import type { SkillListing, SkillsReadRes } from '@/platform/contract';

export interface SkillsRepository {
  /**
   * Every skill directory in the canonical store, in name order.
   *
   * Includes the ones that could not be parsed, each carrying its problem
   * instead of a description. A caller that filters those out is choosing to
   * make a skill the user installed invisible, and should do it on purpose.
   */
  listSkills(): Promise<readonly SkillListing[]>;
  /**
   * One skill's instruction body, plus the names of its resource files.
   *
   * Rejects with `INVALID_PAYLOAD` when the name is not a single path segment
   * and with `NOT_FOUND` when the store has no such directory. A directory that
   * exists and is not a valid skill is **not** a rejection: it resolves to the
   * `invalid` arm, because the host answered the question truthfully.
   */
  readSkill(name: string): Promise<SkillsReadRes>;
}

export function createSkillsRepository(adapter: PlatformAdapter): SkillsRepository {
  return {
    async listSkills(): Promise<readonly SkillListing[]> {
      const answer = await adapter.invoke('skills_list', {});
      return answer.skills;
    },

    readSkill(name: string): Promise<SkillsReadRes> {
      return adapter.invoke('skills_read', { name });
    },
  };
}
