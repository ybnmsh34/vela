/**
 * THE STORE'S REFUSALS.
 *
 * Every action in `code-workspace-store.ts` that declines an input declines it
 * with one clause, and until this round not one of those clauses was bitten by
 * a test. A measurer deleted seven of them — three conjuncts of `isComplete`,
 * `addFile`'s empty-path guard, `addComment`'s and `queueMessage`'s empty-text
 * guards, and `submitComments`'s empty-round arm — and `npx tsc --build --force`
 * exited 0 with the whole suite green on each. The surfaces above them are
 * tested through the DOM, and a form that never submits a half-filled draft
 * cannot see the clause that would have refused it.
 *
 * ## Why the drafts are built by subtraction from one complete draft
 *
 * The only committed test that exercised a refusal (`refuses a half-filled form
 * and says which half`, in `CodeWorkspace.test.tsx`) leaves five of the six
 * fields empty at once, so it passes with any one conjunct deleted — five
 * others still refuse it. The shape that isolates a clause is one draft per
 * field, complete except for that field, checked against an enumerated list of
 * the fields; deleting a conjunct then names the field that stopped being read
 * rather than reddening a test about forms in general.
 *
 * The list is the type's own, not a copy: {@link EMPTIED} is
 * `Record<keyof SessionDraft, SessionDraft>`, so a seventh field added to
 * `SessionDraft` fails `pnpm typecheck` in this file until it has a row. That is
 * the same discipline `PANE_TITLES` uses for `PaneKind`, applied to the reason a
 * draft can be refused.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  resetCodeWorkspaceStore,
  useCodeWorkspaceStore,
  workOf,
  type SessionDraft,
} from './code-workspace-store';

const COMPLETE: SessionDraft = {
  worktree: 'fix-a',
  folder: 'C:/code/vela',
  environment: 'local',
  providerId: 'workstation',
  modelId: 'local-model',
  permissionMode: 'default',
};

/**
 * One draft per field of {@link SessionDraft}, complete except for that field.
 *
 * `null` for the two enumerations, whitespace rather than `''` for the four
 * strings — a name of three spaces is what a user actually types, and it is the
 * input that tells a `trim()` guard apart from a `=== ''` one.
 */
const EMPTIED: Record<keyof SessionDraft, SessionDraft> = {
  worktree: { ...COMPLETE, worktree: '   ' },
  folder: { ...COMPLETE, folder: '   ' },
  environment: { ...COMPLETE, environment: null },
  providerId: { ...COMPLETE, providerId: '   ' },
  modelId: { ...COMPLETE, modelId: '   ' },
  permissionMode: { ...COMPLETE, permissionMode: null },
};

function store() {
  return useCodeWorkspaceStore.getState();
}

function work(sessionId: string) {
  return workOf(useCodeWorkspaceStore.getState(), sessionId);
}

/** A started session, so the actions below have somewhere to write. */
function started(): string {
  const result = store().startSession(COMPLETE);
  expect(result).toEqual({ ok: true, id: 'fix-a' });
  return 'fix-a';
}

beforeEach(() => {
  resetCodeWorkspaceStore();
});

describe('what a session draft has to have', () => {
  it('refuses a draft missing any one of its six fields, one field at a time', () => {
    // The enumerated list is the point: each row is the only thing wrong with
    // its draft, so a conjunct that stops being read names its own field here
    // instead of hiding behind the other five.
    const refused = Object.entries(EMPTIED)
      .filter(([, draft]) => store().startSession(draft).ok)
      .map(([field]) => field);
    expect(
      refused,
      'this field is no longer required, so a session can start without it',
    ).toEqual([]);
  });

  it('accepts the draft those six were emptied from', () => {
    // Without this, a guard that refused everything would pass the test above.
    expect(store().startSession(COMPLETE)).toEqual({ ok: true, id: 'fix-a' });
    expect(store().sessions).toHaveLength(1);
  });

  it('reads each field as trimmed, so a name of spaces is not a name', () => {
    // `!== ''` and `.trim() !== ''` are one character apart and only whitespace
    // tells them apart. Four of the six clauses trim.
    expect(store().startSession({ ...COMPLETE, worktree: '  fix-b  ' })).toEqual({
      ok: true,
      id: 'fix-b',
    });
    expect(store().sessions[0]?.worktree).toBe('fix-b');
  });
});

describe('the store declines an empty input rather than storing it', () => {
  it('adds no file for a path that is only whitespace, and trims the ones it does add', () => {
    const id = started();
    store().addFile(id, '   ');
    expect(work(id).files).toEqual([]);
    store().addFile(id, '  src/a.ts  ');
    expect(work(id).files.map((file) => file.path)).toEqual(['src/a.ts']);
  });

  it('stores no comment for a body that is only whitespace', () => {
    const id = started();
    const anchor = { path: 'src/a.ts', side: 'right', line: 1, text: 'ALPHA' } as const;
    store().addComment(id, anchor, '   ');
    expect(work(id).comments).toEqual([]);
    store().addComment(id, anchor, '  nit  ');
    expect(work(id).comments.map((comment) => comment.body)).toEqual(['nit']);
  });

  it('queues no message for text that is only whitespace', () => {
    const id = started();
    store().queueMessage(id, '   ');
    expect(work(id).queue).toEqual([]);
    store().queueMessage(id, '  hello  ');
    expect(work(id).queue).toEqual(['hello']);
  });

  it('queues no round when there are no comments to send', () => {
    // The docblock on `queueMessage` says why the two actions are separate:
    // folding them into one means "a review round with no comments queues a
    // blank turn". `will not queue a blank round` in DiffPane.test.tsx is
    // satisfied by the pane's disabled button and `composeReviewMessage`'s
    // null, so it never reaches this arm — this is the arm.
    const id = started();
    store().submitComments(id, 'a message nobody composed');
    expect(work(id).queue).toEqual([]);

    store().addComment(id, { path: 'src/a.ts', side: 'right', line: 1, text: 'ALPHA' }, 'nit');
    store().submitComments(id, 'the real round');
    expect(work(id).queue).toEqual(['the real round']);
    expect(work(id).comments).toEqual([]);
  });
});
