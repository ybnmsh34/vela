/**
 * Client state for the cowork surface: the tasks in flight, and which panel is
 * showing.
 *
 * Rules from conventions §5, followed here: state and actions only, **no IPC**.
 * Nothing read from the host is cached here — the project's layout and the MCP
 * servers are read by the hooks that render them, for the reason
 * `src/state/memory-store.ts` gives: a cached copy in a store is a cache with no
 * invalidation story and two readers who disagree.
 *
 * ## Why the tasks are keyed by conversation id
 *
 * Because that is already the key everything else in this app uses for the same
 * thing. `LiveRuns` in `src/platform/contract-harness.ts` permits **at most one
 * live run per conversation** and `forConversation` is how a view finds it;
 * `src/app/App.tsx` remounts the transcript on `key={conversationId}`; the
 * sidebar's selection is a conversation id. "Parallel tasks, each its own
 * conversation" is therefore not a new concept needing a new identifier — it is
 * the identifier this app already has, with a plan hung off it.
 *
 * A second id — a `taskId` of our own — would be a second answer to "which task
 * is this", and the first thing anyone would have to write is the map between
 * the two.
 *
 * ## What survives a conversation switch, and what does not
 *
 * The plans do. That is the point of holding them here rather than in the
 * surface: `App.tsx` remounts the transcript on every sidebar click, so a plan
 * held in component state would be destroyed by looking at another task and
 * coming back — which is the same defect the transcript itself had before it was
 * persisted, one layer up.
 *
 * They die with the renderer process, and that is a limitation rather than a
 * design: there is no command in `COMMAND_ALLOWLIST` that stores a plan, and
 * inventing one is a host change this track may not make. Said plainly here
 * because a panel that looks persistent and is not is worse than one that
 * admits it.
 */

import { create } from 'zustand';

import {
  advanceTo,
  clearRedirect,
  planOf,
  recordDelivery,
  redirect,
  stop,
  type DirectiveDelivery,
  type Plan,
  type RedirectResult,
  type ReleasedDirective,
} from '@/lib/task-plan';

/** Which of the three panels the dock is showing. */
export type CoworkPanel = 'progress' | 'project' | 'context';

export const COWORK_PANELS: readonly CoworkPanel[] = ['progress', 'project', 'context'];

interface CoworkState {
  /** Whether the dock is up. */
  readonly open: boolean;
  readonly panel: CoworkPanel;
  /** One plan per conversation that has one. Conversations without a plan are absent. */
  readonly plans: Readonly<Record<string, Plan>>;

  setOpen: (open: boolean) => void;
  showPanel: (panel: CoworkPanel) => void;
  /** Give a conversation a plan, replacing any it had. */
  setPlan: (conversationId: string, titles: readonly string[]) => void;
  /** Forget a conversation's plan — it was deleted, or the task was discarded. */
  clearPlan: (conversationId: string) => void;
  /**
   * Move a task to a step and hand back the comments that arrival released.
   *
   * The directives are **returned rather than stored**, because acting on one is
   * not something a store may do — it is an await across a seam, and conventions
   * §5 keeps IPC out of here. The caller reads them: `use-cowork.ts` passes each
   * to a `TaskDirector` and writes the answer back through
   * {@link CoworkState.recordDelivery}. A directive parked here with nothing
   * taking it out again would be the unread write the whole feature is built to
   * avoid — so would one handed back to a caller that ignored it, which is what
   * an earlier draft of that hook did.
   */
  advance: (conversationId: string, step: number) => readonly ReleasedDirective[];
  /**
   * Record what became of a directive this store released. See
   * {@link CoworkState.advance} for who calls this and why it is a second trip
   * rather than a return value.
   */
  recordDelivery: (conversationId: string, step: number, outcome: DirectiveDelivery) => void;
  stopTask: (conversationId: string) => void;
  /** Attach a comment to an upcoming step. The refusal is the caller's to render. */
  comment: (conversationId: string, step: number, text: string) => RedirectResult;
  uncomment: (conversationId: string, step: number) => void;
}

/** A conversation with no plan. Stable identity, so selectors do not thrash. */
const NO_PLAN: Plan = { steps: [], currentStep: 0, state: 'idle' };

export const useCoworkStore = create<CoworkState>((set, get) => ({
  open: false,
  panel: 'progress',
  plans: {},

  setOpen: (open) => set({ open }),
  showPanel: (panel) => set({ panel }),

  setPlan: (conversationId, titles) =>
    set({ plans: { ...get().plans, [conversationId]: planOf(titles) } }),

  clearPlan: (conversationId) => {
    const next = { ...get().plans };
    delete next[conversationId];
    set({ plans: next });
  },

  advance: (conversationId, step) => {
    const plan = get().plans[conversationId];
    if (plan === undefined) return [];
    const moved = advanceTo(plan, step);
    set({ plans: { ...get().plans, [conversationId]: moved.plan } });
    return moved.directives;
  },

  recordDelivery: (conversationId, step, outcome) => {
    const plan = get().plans[conversationId];
    if (plan === undefined) return;
    set({ plans: { ...get().plans, [conversationId]: recordDelivery(plan, step, outcome) } });
  },

  stopTask: (conversationId) => {
    const plan = get().plans[conversationId];
    if (plan === undefined) return;
    set({ plans: { ...get().plans, [conversationId]: stop(plan) } });
  },

  comment: (conversationId, step, text) => {
    const plan = get().plans[conversationId];
    if (plan === undefined) return { ok: false, refusal: 'noSuchStep' };
    const result = redirect(plan, step, text);
    if (result.ok) set({ plans: { ...get().plans, [conversationId]: result.plan } });
    return result;
  },

  uncomment: (conversationId, step) => {
    const plan = get().plans[conversationId];
    if (plan === undefined) return;
    set({ plans: { ...get().plans, [conversationId]: clearRedirect(plan, step) } });
  },
}));

/** The plan for one conversation, or an empty one. Never `undefined`, so callers need no branch. */
export function planFor(plans: Readonly<Record<string, Plan>>, conversationId: string | null): Plan {
  if (conversationId === null) return NO_PLAN;
  return plans[conversationId] ?? NO_PLAN;
}

/**
 * Every conversation that has a plan, running ones first.
 *
 * This is the parallel-task list the switcher renders. Order is *state then
 * insertion*: a user with four tasks wants the two that are working at the top,
 * and within a state the order they created them is the only order that does not
 * move under them while they look at it.
 */
export function tasksIn(
  plans: Readonly<Record<string, Plan>>,
): readonly { readonly conversationId: string; readonly plan: Plan }[] {
  const entries = Object.entries(plans).map(([conversationId, plan]) => ({ conversationId, plan }));
  const rank = (plan: Plan): number => (plan.state === 'running' ? 0 : plan.state === 'idle' ? 1 : 2);
  return entries.sort((left, right) => rank(left.plan) - rank(right.plan));
}

/** Test helper: put the store back to its initial values between renders. */
export function resetCoworkStore(): void {
  useCoworkStore.setState({ open: false, panel: 'progress', plans: {} });
}
