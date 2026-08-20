# `src/features/code/` — the code workspace

The Code surface from `docs/spec-parts/claude-code-desktop.md`: panes you arrange, sessions
isolated by worktree, and diff review with line comments.

## What is here

| Thing | State |
| --- | --- |
| Pane system — columns of stacked panes, drag a header to move, drag an edge to resize | built |
| Keyboard equivalents for every pointer gesture (F6, `Ctrl/Cmd+\`, arrow-key splitters, a move menu) | built |
| Diff review — file list, `+N/-N` per file, click a line to comment, submit the round with `Ctrl/Cmd+Enter` | built |
| Session setup gate — environment, folder, model and permission mode before the first message | built |
| Worktree isolation — one session per worktree, compared case-insensitively, work kept per session | built in the registry only; see below |
| Chat pane — model, context readout, the session's queue, a composer | built |
| Editor pane — open a file, edit it, Save | built against session memory, not disk |

## What is NOT here, and what each one needs first

**Five of the spec's eight panes.** Browser/preview, terminal, file tree, plan, tasks and
subagent are not built, and are deliberately absent from `PaneKind` rather than present and
empty — the Views menu is drawn from that union, so a pane in it is a pane that works. The
pane system itself is generic (`src/lib/pane-layout.ts` is generic over the pane id), so
adding one is a union member, a title in `PANE_TITLES` and a component.

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

## The rules this feature is built under

- A feature may not import another feature (`src/features/README.md`). That is why the line
  diff moved out of the canvas feature and into `src/lib/text-diff.ts`, and why the
  pane layout is a `lib/` module rather than a component's state.
- No colour, radius, type size or leading is written here. `src/styles/design-system.test.ts`
  reads every `*.module.css` under `src/` and fails on any of them.
- Everything under `src/` must be reachable from `src/main.tsx`
  (`src/runtime/reachable.test.ts`). The joint is the Code button in
  `src/features/navigation/Sidebar.tsx` and `<CodeWorkspaceSurface />` in `src/app/App.tsx`;
  `src/app/code-workspace-wiring.test.tsx` fails if the two stop meeting. The reachability
  guard alone does not: it walks import specifiers, so deleting the mount and keeping the
  import leaves it green (`pnpm typecheck` is what catches that, with TS6133). Deleting the
  import as well makes it report thirteen unreachable modules. Both measured.
