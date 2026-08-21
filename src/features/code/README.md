# `src/features/code/` — the code workspace

The Code surface from `docs/spec-parts/claude-code-desktop.md`: panes you arrange, sessions
isolated by worktree, and diff review with line comments.

## What is here

| Thing | State |
| --- | --- |
| Pane system — columns of stacked panes, drag a header to move, drag an edge to resize | built |
| Keyboard equivalents for every pointer gesture (F6, `Ctrl/Cmd+\`, arrow-key splitters, a move menu) | built |
| Diff review — file list, `+N/-N` per file, click a line to comment, submit the round with `Ctrl/Cmd+Enter` | built |
| Session setup gate — worktree name, environment, folder, model and permission mode before the first message | built |
| Worktree isolation — one session per worktree, compared case-insensitively, work kept per session | built in the registry only; see below |
| Chat pane — model, context readout, the session's queue, a composer | built |
| Editor pane — open a file, edit it, Save | built against session memory, not disk |

## What is NOT here, and what each one needs first

**Five of the spec's eight panes.** `docs/spec-parts/claude-code-desktop.md` names eight, twice:
"panes you can arrange in any layout: chat, diff, browser, terminal, file, plan, tasks, and
subagent". Chat, diff and file are built (the last as the Editor pane in the table above).
Browser, terminal, plan, tasks and subagent are not, and are deliberately absent from
`PaneKind` rather than present and empty, so nothing can open a pane with nothing behind it.

The pane arithmetic is generic (`src/lib/pane-layout.ts` is generic over the pane id), so the
layout side of a sixth pane is free. The wiring side is not, and only one of its three sites is
enforced by the compiler. Adding `'terminal'` to `PaneKind` and running
`pnpm exec tsc --build --force` exits 2 with exactly one distinct diagnostic, twice measured. It
names `PANE_TITLES` in `src/features/code/PaneFrame.tsx` and says:
`error TS2741: Property 'terminal' is missing in type '{ chat: string; diff: string; editor:
string; }' but required in type 'Record<PaneKind, string>'.` (The compiler prefixes that with the
file and the line and column of `PANE_TITLES`; the coordinate is cut here rather than quoted,
because a line number in prose is wrong the first time anything above it moves.)
Nothing at all is said about the other two, and both would be wrong:

- `ALL_PANES` in `CodeWorkspace.tsx` is a hand-written `readonly PaneKind[]`, which does not
  have to be exhaustive — a fourth kind silently never appears in the Views menu;
- `renderPane` in the same file ends `return <DiffPane … />` with no branch for an unknown
  kind, so a fourth pane would render the diff.

So the recipe is five steps, not three: the union member, the title, the component, and **both
of those two sites** — of which the compiler names only the title.

**Anything that touches a real worktree.** `src/platform/contract.ts` declares no filesystem
and no git command — there is no `git_*`, no `fs_*`, nothing that can `git worktree add`, read
a file or compute `git diff`. So:

- the worktree is a *name the session owns*, enforced in this renderer's registry, not a
  directory that exists;
- the editor pane's baseline is the session's own last Save, not the bytes on disk;
- none of the spec's four isolation checks (file edits, command working directory, git
  redirects, command shape) are implemented, because nothing here runs a command.

The seam where that changes is small and named: `SessionFile.baseline` in
`src/state/code-workspace-store.ts` stops meaning "what Save last wrote" and starts meaning
"what the host read". `src/lib/text-diff.ts` takes two strings either way, and nothing in the
diff review moves.

**The permission-approval cards** — allow once / always / deny. The permission *mode* is
chosen before the first message, recorded on the session and shown; the cards are the prompt
that appears when a tool asks, and there is no tool loop behind this workspace to ask. Building
the cards now would mean shipping a control that can never appear.

**Anything that contacts a model.** The chat pane queues. It says so on screen.

## What is approximate, and known to be

**Where a review comment points after the file is edited under it.** A comment is stored
against the line it was written on and quotes that line verbatim. Editing the file above it
renumbers the diff, so `anchorComments` in `review-comments.ts` re-finds the quoted line by
its **text and side** rather than trusting the stored number. That is a heuristic and it has a
known limit: it cannot tell two identical lines apart, and picks the one nearest to where the
comment was written. A comment whose quoted line is nowhere in the diff is shown apart and
submitted without a coordinate rather than being attached to whatever now occupies its old
line number — shown apart **on its own file's diff**, because that file is still in the
changed list and has a row to select, so this arm waits for the reviewer to go there rather
than following them onto every other file. `DiffPane.tsx`'s `drifted` states the same
qualifier as `entry.comment.path === current.file.path`.

So is a comment whose **file** has left the changed-file list, and that is a different case
rather than a special case of the first: editing a file back to its baseline
does not take its rows away — `diffText('alpha', 'alpha')` returns one `same` row — so a
comment on a context line keeps a perfectly good anchor while its file has no row on screen
at all. Round 2 treated the two as one condition, and that comment was invisible,
un-removable and still submitted with its coordinate; `DiffPane.tsx`'s `drifted` now takes
either, and each card says which of the two it is. What would remove the heuristic altogether
is a diff the host computes and identities that survive an edit — neither exists while
`src/platform/contract.ts` declares no `git_*`.

## The rules this feature is built under

- A feature may not import another feature (`src/features/README.md`). That is why the line
  diff moved out of the canvas feature and into `src/lib/text-diff.ts`, and why the
  pane layout is a `lib/` module rather than a component's state.
- No colour, radius, type size or leading is written here. `src/styles/design-system.test.ts`
  reads every `*.module.css` under `src/` and fails on any of them.
- Everything under `src/` must be reachable from `src/main.tsx`
  (`src/runtime/reachable.test.ts`). The joint is the Code button in
  `src/features/navigation/Sidebar.tsx` — there are **two** of them, the collapsed rail's
  icon and the expanded list's row, calling the same action, and each is bitten on its own:
  removing the expanded row reddens three of the four tests in
  `src/app/code-workspace-wiring.test.tsx` (`3 failed | 9 passed (12)` run beside the
  reachability guard), and removing the rail's icon reddens the fourth,
  `opens it from the collapsed rail too` (`1 failed | 11 passed (12)`). Both measured twice.
  Round 2's text here said removing either one alone "changes nothing", which was false for
  the expanded row and untested for the rail — the rail's guard was written to make the
  claim true rather than to restate it. The other half of the joint is
  `<CodeWorkspaceSurface />` in `src/app/App.tsx`;
  `src/app/code-workspace-wiring.test.tsx` fails if the two stop meeting. The reachability
  guard alone does not: it walks import specifiers, so deleting the mount and keeping the
  import leaves it green (`pnpm typecheck` is what catches that, with TS6133). Deleting the
  import as well makes it report thirteen unreachable modules. Both measured.
