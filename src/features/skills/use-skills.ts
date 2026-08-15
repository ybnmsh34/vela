/**
 * The skills pane's state: what is installed, and the one skill being read.
 *
 * ## Two states, because there are two levels of disclosure
 *
 * `src/data/skills-repository.ts` is deliberately two methods: the listing
 * carries a name and a description for every installed skill, and the
 * instruction body is a second, separate call for exactly one of them. A hook
 * that read every body on mount would satisfy every test below and quietly undo
 * the whole loading model, so the body lives in its own state and is only ever
 * filled by {@link SkillsController.select}.
 *
 * ## A broken skill is a row, not a hole
 *
 * `SkillListing` in `src/platform/contract.ts` is a union whose `invalid` arm
 * carries a `SkillProblem` instead of a description, and nothing here filters on
 * `kind`. That is the load-bearing omission: a skill the user installed that
 * disappears from every surface with no sentence saying why is how somebody
 * loses work without being told. The host models it — the store's own
 * `a_broken_skill_is_listed_with_its_problem_rather_than_dropped` proves it
 * against real directories — and this is where the renderer could still throw it
 * away.
 *
 * ## Failure is a state, not a swallow
 *
 * An empty skill store is the normal state for a new installation, and a store
 * that could not be read looks identical on screen unless somebody keeps them
 * apart. So the refusal is kept and rendered, the same distinction
 * `src/features/memory/use-memory.ts` draws for an unreadable memory.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createSkillsRepository, type SkillsRepository } from '@/data/skills-repository';
import { usePlatform } from '@/platform/PlatformProvider';
import type { SkillListing, SkillsReadRes } from '@/platform/contract';
import { toPlatformError } from '@/platform/errors';

export type SkillsListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly skills: readonly SkillListing[] }
  | { readonly status: 'error'; readonly code: string; readonly message: string };

/**
 * The second level, for at most one skill.
 *
 * `directory` rather than `name`, on every arm: a skill that could not be parsed
 * has no name to be keyed by, and the directory is what the host was asked for.
 */
export type SkillDetailState =
  | { readonly status: 'none' }
  | { readonly status: 'loading'; readonly directory: string }
  | { readonly status: 'ready'; readonly directory: string; readonly detail: SkillsReadRes }
  | {
      readonly status: 'error';
      readonly directory: string;
      readonly code: string;
      readonly message: string;
    };

export interface SkillsController {
  readonly list: SkillsListState;
  readonly detail: SkillDetailState;
  /** Read one skill's body and resource names. The only call that costs them. */
  select: (directory: string) => Promise<void>;
  /** Back to the list, without re-reading it. */
  clearSelection: () => void;
}

export function useSkills(repository?: SkillsRepository): SkillsController {
  const adapter = usePlatform();
  const skills = useMemo(
    () => repository ?? createSkillsRepository(adapter),
    [repository, adapter],
  );

  const [list, setList] = useState<SkillsListState>({ status: 'loading' });
  const [detail, setDetail] = useState<SkillDetailState>({ status: 'none' });
  const mounted = useRef(true);
  /**
   * Which read is the current one. Two clicks in flight resolve in whatever
   * order the host answers, and without this the slower answer wins — showing
   * one skill's body under another skill's heading.
   */
  const request = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const listed = await skills.listSkills();
        if (!cancelled && mounted.current) setList({ status: 'ready', skills: listed });
      } catch (error: unknown) {
        const failure = toPlatformError(error);
        if (!cancelled && mounted.current) {
          setList({ status: 'error', code: failure.code, message: failure.message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skills]);

  const select = useCallback(
    async (directory: string): Promise<void> => {
      request.current += 1;
      const ticket = request.current;
      setDetail({ status: 'loading', directory });
      try {
        const answer = await skills.readSkill(directory);
        // `invalid` arrives here, not in the catch: the host answered the
        // question truthfully and the answer is "this directory is not a
        // skill". Rendering that is the pane's job, not the error path's.
        if (mounted.current && request.current === ticket) {
          setDetail({ status: 'ready', directory, detail: answer });
        }
      } catch (error: unknown) {
        const failure = toPlatformError(error);
        if (mounted.current && request.current === ticket) {
          setDetail({ status: 'error', directory, code: failure.code, message: failure.message });
        }
      }
    },
    [skills],
  );

  const clearSelection = useCallback((): void => {
    // Bumped so an answer already in flight cannot land on the closed view.
    request.current += 1;
    setDetail({ status: 'none' });
  }, []);

  return { list, detail, select, clearSelection };
}
