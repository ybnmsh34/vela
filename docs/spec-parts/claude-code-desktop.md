# Vela Spec Part — Claude Code Integration & Desktop App Tabs

Area owner: documentation-ingestion pass over `code.claude.com/docs`, `claude.com/docs/cowork`,
`support.claude.com`.
Date of ingestion: 2026-08-12.

**Ground rule compliance:** every feature below was read from a page actually fetched in this
session. URLs fetched are listed in [Sources fetched](#sources-fetched). Nothing here is recalled
from training memory. One URL failed and is recorded under
[Sources unreachable](#sources-unreachable).

---

## 0. Framing for Vela

Vela is a model-agnostic desktop app. The user supplies the brain: local llama.cpp / Ollama /
LM Studio / vLLM, any third-party API key, or a subscription provider. Everything Claude Desktop
does must have a Vela equivalent; only the model is swappable.

Reading the Claude Desktop docs end-to-end, the product splits cleanly into three layers:

1. **A local agent runtime** (the Claude Code engine): tool loop, permission gate, worktree
   isolation, transcripts, hooks, MCP, sandboxing. This is ~90% client-side and fully portable.
   Vela reimplements this as its own agent core.
2. **A desktop shell** (Electron app with Chat / Cowork / Code tabs, pane layout, diff viewer,
   browser pane, terminal, iOS simulator pane, sidebar session manager). Entirely client-side
   presentation over the runtime. Vela reimplements as its own shell.
3. **Anthropic-hosted services** bolted on: cloud sessions (hosted VMs), Cowork cloud sandboxes,
   Remote Control relay, routines scheduler, hosted connectors (server-side MCP OAuth), the auto-mode
   safety classifier, server-managed settings, Dispatch. These are the only genuinely
   server-dependent pieces, and each has a concrete local substitute described below.

A recurring theme worth internalizing: **Anthropic's "safety classifier" and "hosted sandbox" are
the two server-side dependencies that gate the most desirable UX (auto mode, autonomous cloud runs).
Vela must replace the classifier with a locally-run small model + deterministic policy engine, and
replace the hosted sandbox with a local container/microVM.** Both are tractable.

---

## 1. The three-tab desktop structure

**Source:** `https://code.claude.com/docs/en/desktop.md`,
`https://code.claude.com/docs/en/desktop-quickstart.md`,
`https://claude.com/resources/tutorials/navigating-the-claude-desktop-app`

The Claude Desktop app has three tabs:

| Tab | What it is (verbatim sense from docs) |
| --- | --- |
| **Chat** | "General conversation with no file access, similar to claude.ai." Plus desktop-native affordances: Quick Entry (double-tap Option on macOS to summon Claude over any app), screenshot/window capture, dictation, and connectors. |
| **Cowork** | "An autonomous background agent that works on tasks in a sandboxed virtual machine with its own environment, running independently while you do other work. On-device Cowork sessions run the VM on your computer; remote Cowork sessions run on an Anthropic-managed VM instead." Home of Dispatch. Produces documents/spreadsheets/decks. |
| **Code** | "An interactive coding assistant with direct access to your local files. You review and approve each change in real time." This is Claude Code with a desktop UI. |

On latest builds, **Chat and Cowork share one Home**: chats, coworks, projects, and artifacts live in
one sidebar and you can start either from the same place. Code keeps its own sidebar of sessions.

Cross-tab configuration split (important, and a trap):

- The **Code** tab reads CLI config: `~/.claude/settings.json`, `.claude/settings.json`,
  `~/.claude.json`, `.mcp.json`, `CLAUDE.md`, `~/.claude/skills/`, plugins from marketplaces.
- The **Cowork** tab does **not** read `~/.claude`. It sources skills, plugins and connectors from
  the **Customize** page in the sidebar, which syncs through the claude.ai account. Docs are
  explicit: "Cowork loads the ones enabled for your claude.ai account, synced at session start, and
  doesn't read the Claude Code CLI's `~/.claude` directory on your machine."
- The two permission systems are separate: "The Cowork tab doesn't use these modes. Cowork has its
  own permission modes, enabled separately, and the Cowork tab shows no mode selector at all until a
  mode beyond its default is enabled for your account."

### Vela reimplementation

Ship the same three-surface split, but unify the config plane — Anthropic's split is an artifact of
Cowork being account-synced and Code being disk-synced. Vela has no account, so:

- One on-disk config root, e.g. `~/.vela/` (`settings.json`, `skills/`, `agents/`, `plugins/`,
  `mcp.json`, `VELA.md` project memory), read by all three surfaces. Add a per-surface `enabled`
  filter so a skill can be Cowork-only if the user wants.
- **Chat tab**: plain conversation, no tool loop except optional connectors. Same model backend
  abstraction as the others. Quick Entry = a global hotkey (Tauri/Electron `globalShortcut`;
  on Wayland use the GlobalShortcuts XDG portal, exactly the caveat Anthropic hit on Linux).
  Screenshot capture = platform screencapture API. Dictation = local Whisper (whisper.cpp) so it
  works with any backend and offline.
- **Cowork tab**: long-horizon autonomous agent whose tools run inside a local microVM/container
  (see §9). Deliverable generation (docx/xlsx/pptx/pdf) runs inside that sandbox with
  `python-docx`, `openpyxl`, `python-pptx`, `reportlab`/`weasyprint` — no hosted file-creation
  service needed.
- **Code tab**: the coding agent over a project folder, with worktree isolation, diffs, terminal,
  preview browser.

---

## 2. Starting a session (Code tab)

**Source:** `https://code.claude.com/docs/en/desktop.md` §Start a session

Before the first message the user configures four things in the prompt area:

1. **Environment** — Local / Cloud / an SSH connection / (Windows) a WSL distribution.
2. **Project folder** — the folder or repository Claude works in. Cloud sessions can add multiple
   repositories via a **+** next to the repo pill, each with its own branch selector.
3. **Model** — dropdown next to the send button, changeable mid-session.
4. **Permission mode** — mode selector next to the send button, changeable mid-session.

"Each session tracks its own context and changes independently."

Additional prompt-area mechanics:

- **Interrupt/steer**: stop button interrupts immediately; alternatively type a correction and press
  Enter — it is *not* an interrupt; "Claude reads the correction as soon as the current action
  completes and adjusts before its next step." (A queued-steering channel, distinct from abort.)
- **`+` button**: file attachments, skills, connectors, plugins.
- **`@mention` files** with autocomplete — local and SSH sessions only, not cloud or WSL.
- **Attachments**: images, PDFs, and other files, via button or drag-and-drop into the prompt.

### Vela reimplementation

- Environment selector becomes: **Local**, **Container** (Docker/Podman/microVM on this machine),
  **SSH**, **WSL**. Drop "Cloud" or make it "Remote runner" — a user-supplied box (their own VPS,
  a homelab machine) reached over SSH, which gives the "keeps running when I close the laptop"
  property without Anthropic infrastructure. Implement it as a persistent agent daemon on the remote
  host (tmux/systemd-user unit) that the Vela UI attaches to.
- Model dropdown enumerates configured backends. Because Vela is model-agnostic, the dropdown must
  be a two-level picker: **provider** (llama.cpp server, Ollama, LM Studio, vLLM, OpenAI-compatible
  endpoint, Anthropic, OpenRouter, …) × **model id**, with per-model capability flags the agent core
  reads: `supports_tools`, `supports_parallel_tool_calls`, `supports_vision`, `supports_prefill`,
  `context_window`, `native_reasoning`. Mid-session model switching must re-serialize the transcript
  into the new model's prompt format — keep the transcript in a **canonical internal message
  format** and render to provider format at request time. Never store provider-shaped messages.
- Steering channel: implement as an mpsc queue the agent loop drains between tool calls, exactly as
  described. Two distinct user actions: `abort` (cancel in-flight tool + turn) and `steer` (enqueue).
- `@mention` autocomplete: local FS index (ignore-aware, respects `.gitignore`), fuzzy match.
  This must also work in the remote/SSH case — run a tiny index server on the remote side.
- Attachments: for a text-only local model, degrade gracefully — PDFs → text extraction
  (pdfminer/pypdf) client-side; images → either send to a vision-capable backend, or run a local
  captioner (e.g. a small VLM via llama.cpp) and inject the caption plus a note that the model is
  seeing a description, not the pixels. Make this degradation *visible* in the UI.

---

## 3. Permission modes and the permission system

**Sources:** `https://code.claude.com/docs/en/permission-modes.md`,
`https://code.claude.com/docs/en/desktop.md` §Choose a permission mode

### The modes

| Mode | Settings key | What runs without asking |
| --- | --- | --- |
| Manual | `default` | Reads only |
| Accept edits | `acceptEdits` | Reads, file edits, and common filesystem commands (`mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`) |
| Plan | `plan` | Reads, plus classifier-approved commands when auto mode is available |
| Auto | `auto` | Everything, with background safety checks (classifier) |
| Don't ask | `dontAsk` | Only pre-approved tools; everything else auto-denied. CLI only, not in Desktop |
| Bypass permissions | `bypassPermissions` | Everything |

Desktop specifics:

- Mode selector sits next to the send button; `Cmd+Shift+M` opens it.
- Desktop reads the same settings files as the CLI; `permissions.defaultMode` sets the default for
  new local sessions. **A mode picked in the selector is remembered per folder and takes precedence
  over `defaultMode` for that folder — except Plan, which applies to the current session only.**
- Bypass permissions requires a Settings toggle ("Allow bypass permissions mode") on Pro/Max; on
  Team/Enterprise it's org policy. Equivalent to `--dangerously-skip-permissions`.
- Cloud sessions support only Accept edits / Plan / Auto. "Accept edits corresponds to `default`
  mode: cloud sessions pre-approve file edits."
- Earlier Code-tab labels were Ask permissions / Auto accept edits / Plan mode.

### `acceptEdits` fine print (very implementable)

- Auto-approves `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`.
- Also auto-approved when prefixed with safe env vars (`LANG=C`, `NO_COLOR=1`) or process wrappers
  (`timeout`, `nice`, `nohup`).
- Auto-approval applies **only to paths inside the working directory or `additionalDirectories`**.
- PowerShell equivalents: `Set-Content`, `Add-Content`, `Clear-Content`, `Remove-Item` and aliases.
  A positional argument containing a quote character still prompts, "because Claude Code can't
  statically validate an argument whose quoted and unquoted readings differ."

### Protected paths (never auto-approved except in bypass)

Per-mode outcome table from the docs:

| Mode | Protected-path writes |
| --- | --- |
| `default`, `acceptEdits` | Prompted |
| `plan` | Prompted; allowed with bypass available; routed to classifier with auto available |
| `auto` | Routed to the classifier |
| `dontAsk` | Denied |
| `bypassPermissions` | Allowed |

Critically: "`permissions.allow` rules in settings files do not pre-approve protected-path writes.
The safety check runs **before** Claude Code evaluates allow rules."

Protected directories: `.git`, `.config/git`, `.vscode`, `.idea`, `.husky`, `.cargo`,
`.devcontainer`, `.yarn`, `.mvn`, `.claude` (except `.claude/worktrees`).

Protected files: `.gitconfig`, `.gitmodules`; `.bashrc`, `.bash_profile`, `.bash_login`,
`.bash_aliases`, `.bash_logout`, `.zshrc`, `.zprofile`, `.zshenv`, `.zlogin`, `.zlogout`,
`.profile`, `.envrc`; `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnp.cjs`, `.pnp.loader.mjs`,
`.pnpmfile.cjs`, `bunfig.toml`, `.bunfig.toml`; `.bazelrc`, `.bazelversion`, `.bazeliskrc`;
`.pre-commit-config.yaml`, `lefthook.yml`/`.yaml` and dotted variants; `gradle-wrapper.properties`,
`maven-wrapper.properties`; `.devcontainer.json`; `.ripgreprc`, `pyrightconfig.json`;
`.mcp.json`, `.claude.json`.

The rationale is exactly right and Vela must copy it: these are the files that, if written, let the
agent grant itself permissions or arrange for code to run outside the gate (hooks, MCP servers,
shell rc, git hooks, package-manager lifecycle hooks).

In prompting modes, the `.claude/` write prompt offers a third option: **"Yes, and allow Claude to
edit its own settings for this session."**

### Rule layering (applies in every mode, including bypass)

- Deny rules and explicit ask rules apply to every tool (but can't block `EndConversation` while any
  other tool remains).
- Org `ask` setting on connector tools.
- MCP tools marked `requiresUserInteraction` (`_meta["anthropic/requiresUserInteraction"]`).
- Allow rules have no effect in `bypassPermissions` (everything is already approved).

### Auto mode — the classifier

**This is the single most important ANTHROPIC_SERVER_SIDE dependency in the whole area.**

Mechanics as documented:

- "A separate classifier model reviews actions before they run, blocking anything that escalates
  beyond your request, targets unrecognized infrastructure, or appears driven by hostile content
  Claude read."
- **Decision order** (first match wins):
  1. Allow/ask/deny rules resolve immediately. *Except*: protected-path writes route to the
     classifier even when an allow rule matches; org-`ask` connector tools and
     `requiresUserInteraction` MCP tools prompt directly even when an allow rule matches;
     content-scoped ask rules fall back to a permission prompt.
  2. Read-only actions and working-directory file edits are auto-approved (except protected paths).
  3. Everything else goes to the classifier.
  4. If the classifier blocks, Claude receives the reason and tries an alternative. In most sessions
     the reason is the fixed text `Blocked by classifier`.
- **On entering auto mode, broad allow rules that grant arbitrary code execution are dropped**:
  blanket `Bash(*)`/`PowerShell(*)`, wildcarded interpreters like `Bash(python*)`, package-manager
  run commands, and `Agent` allow rules. Narrow rules like `Bash(npm test)` carry over. Dropped
  rules are restored on leaving auto mode. — *Excellent design, copy verbatim.*
- **The classifier sees user messages, tool calls, and CLAUDE.md content. Tool results are
  stripped**, so hostile content in a file or web page can't manipulate it directly. "A separate
  server-side probe scans incoming tool results and flags suspicious content before Claude reads
  it."
- Classifier also reviews each `SendMessage` to another agent before delivery, and decides removals
  targeting `/` or `~` (including inside command/process substitution).
- **Boundaries stated in conversation** are treated as block signals ("don't push", "wait until I
  review before deploying") and stay in force until lifted. "Boundaries are not stored as rules. The
  classifier re-reads them from the transcript on each check, so a boundary can be lost if context
  compaction removes the message that stated it."
- **Fallback behavior**: if the classifier blocks an action 3 times in a row or 20 times total, auto
  mode pauses and Claude Code resumes prompting. Approving the prompted action resumes auto mode.
  Thresholds are not configurable. Any allowed action resets the consecutive counter; the total
  counter persists for the session.
- **Subagent handling** — three checkpoints: (1) the delegated task description is evaluated before
  spawn; (2) each subagent action goes through the classifier with the parent's rules, and any
  `permissionMode` in the subagent frontmatter is ignored; (3) on finish, the classifier reviews the
  subagent's full action history and prepends a security warning to results if it flags a concern.
- **Sandbox network requests** route through the classifier, with verdict caching per host+port:
  an allow is reused until new content enters the conversation; in the interactive CLI a deny is
  dropped at turn end; in headless/SDK a deny is reused for the run; changing mode or rules drops
  all cached verdicts.
- **Cost/latency**: classifier runs on Claude Sonnet 5 by default (a server-configured model takes
  precedence); falls back to the session model, or an Opus model when the session runs Fable 5.
  Classifier calls count toward token usage on Enterprise and API accounts. "Reads and
  working-directory edits outside protected paths skip the classifier, so the overhead comes mainly
  from shell commands and network operations."
- `claude auto-mode defaults` prints the full rule lists as JSON. `autoMode.environment` in settings
  defines trusted infrastructure. Notably, `autoMode` is read from user settings, `--settings`, and
  managed settings — **but not** from `.claude/settings.json` or `.claude/settings.local.json`,
  "so a cloned repo or build step can't inject its own classifier rules."

**Default block list** (abridged but concrete — Vela should ship an equivalent ruleset):
`curl | bash`-style download-and-execute; sending sensitive data to external endpoints; production
deploys and migrations; mass deletion on cloud storage; granting IAM/repo permissions; modifying
shared infrastructure; irreversibly destroying pre-existing files; force push; commits/pushes that
would send secrets outside the repo or widen what a deploy exposes; `git reset --hard`,
`git checkout -- .`, `git restore .`, `git clean -fd`, `git stash drop`, `git stash clear`;
`git commit --amend` on a HEAD not created in this session or already pushed;
`terraform/pulumi/cdk/terragrunt destroy`; writing to a secret manager; changing DNS or TLS certs;
merging an unapproved PR or approving Claude's own PR or disabling CI; comment-triggered automation
(`atlantis apply`, `/deploy`); production feature-flag toggles; protected IaC scopes; draining
cluster nodes; DaemonSets and admission webhooks; interactive shells/port-forwards into sensitive
targets; tunnels/reverse shells exposing local services publicly; printing live credentials into the
transcript or a file; routing package installs around an internal registry; flags that disarm safety
guards (`--insecure`); launching autonomous agent loops without approval or sandbox
(`--dangerously-skip-permissions`, `--no-sandbox`, `--yes-always`); wildcard deletion in
`/tmp`/`$TMPDIR`; leaking sensitive details into PR/issue bodies, commit messages, comments;
commenting out or force-passing security-guarding tests; deleting stateful resources Claude didn't
create; repointing API base URLs / proxies / webhook receivers / registry mirrors;
`git remote set-url`/`add` to an unnamed remote; pushing secrets or private-repo content to a public
repo; opening PRs against a different repo/org, `gh repo fork`, pushing to a third-party repo;
content from sensitive local stores (session transcripts, `~/.ssh`, cloud credentials, browser
profiles, shell history) entering a commit/push/PR/gist/package publish; **writing to Claude Code's
own `.jsonl` session transcripts** ("a tampered entry reaches every later check once you resume the
session, so auto mode blocks these writes as defense in depth. Reading a transcript isn't blocked");
recursive forced deletes whose target is an unresolved shell variable.

**Default allow list**: local file operations in the working directory; installing dependencies
declared in lock files/manifests; reading `.env` and sending credentials to their matching API;
read-only HTTP; pushing to any branch of the repository you're working in (including default),
except branches whose name marks them as deploy targets like `production` or `gh-pages`; deleting
jobs Claude created earlier in the session; reading/writing security code as part of the task;
messages between agents in the same multi-agent session; sending data to trusted domains/buckets
listed in `environment`.

### Vela reimplementation of the permission system

**Dependency: MIXED. The rule engine is fully portable; the classifier is the server-side piece.**

Build a three-stage gate in the agent core, in this order (mirroring the documented decision order):

1. **Deterministic policy engine (pure client-side, no model).**
   - Rule syntax `Tool(specifier)` with allow/ask/deny, layered across scopes:
     managed (a system-level file an admin can drop, e.g. `/etc/vela/managed-settings.json`) >
     CLI/`--settings` > project-local > project > user. Deny beats allow at equal specificity;
     managed deny is unoverridable.
   - Hard-coded **protected paths** check that runs *before* allow-rule evaluation, with the exact
     list above (rename `.claude` → `.vela`, keep everything else — those are ecosystem files, not
     Anthropic files, and they are exactly the escape hatches).
   - Read-only Bash command classifier: a static allowlist of argv shapes (`ls`, `cat`, `rg`,
     `git status`, `git log`, `git diff`, …) parsed with a real shell parser (`tree-sitter-bash` or
     `bashlex`), **not** regex. Refuse to classify anything you can't statically trace — that is the
     same posture Anthropic takes for the worktree "command shape" check.
   - `acceptEdits` filesystem-command allowlist with the safe-prefix/wrapper handling described
     above, scoped to cwd + `additionalDirectories`.
2. **Local safety classifier (replaces the Anthropic server-side classifier).**
   - Run a *small, fast, local* model as the judge — this is exactly the right job for a 4–8B
     instruct model on llama.cpp with a constrained-grammar (GBNF/JSON-schema) output so the verdict
     always parses: `{"verdict":"allow"|"block","reason":string}`.
   - **Config key `judge`**, independent of the session model: `judge.provider`, `judge.model`,
     `judge.enabled`. Default to the same backend if the user has only one, but strongly recommend a
     separate small model so the judge is cheap and can't be swayed by the main model's context.
   - **Input discipline is the security property, not the model quality.** Copy Anthropic exactly:
     feed the judge user messages, the pending tool call, and project memory (`VELA.md`). **Strip
     tool results.** This is what prevents a malicious README from talking the judge into approving
     `curl | bash`. Document it loudly.
   - Ship the default block/allow ruleset above as a **declarative YAML policy file** shipped with
     Vela (`policies/default.yaml`), rendered into the judge prompt. Users/admins extend it with an
     `environment` block naming trusted remotes, buckets, registries, and sensitive data locations —
     same shape as `autoMode.environment`. Expose `vela policy dump` (≈ `claude auto-mode defaults`).
   - **Read `judge`/policy config from user + managed settings only, never from the project
     directory.** Anthropic learned this the hard way (`autoMode` is not read from
     `.claude/settings.json`) — a cloned repo must not be able to write its own judge rules.
   - Implement the **allow-rule dropping on entering auto mode**: strip `Bash(*)`,
     `Bash(<interpreter>*)`, package-manager run rules, and `Agent(*)` while auto is active; restore
     on exit.
   - Implement **verdict caching** for network hosts (host+port), invalidated when new content
     enters the conversation or rules/mode change.
   - Implement **the 3-consecutive / 20-total fallback** to prompting. This is what makes auto mode
     survivable when the local judge is weaker than Sonnet: a bad judge degrades into a prompting
     session rather than into a stuck agent.
   - Implement **conversational boundaries** as a first-class object instead of re-reading the
     transcript: when the judge or a lightweight extractor detects "don't X", store it in a session
     `boundaries[]` list that survives compaction, and inject it into every judge call. This is a
     strict improvement over the documented behavior, which admits boundaries can be lost to
     compaction.
   - Subagent handling: same three checkpoints (pre-spawn task-description check, per-action check
     with parent rules and ignored child `permissionMode`, post-run history review).
3. **Prompt injection probe on tool results.** Anthropic runs this server-side ("a separate
   server-side probe scans incoming tool results"). Vela runs it locally: a cheap classifier pass
   (small model or even a heuristic scanner for imperative-instruction patterns in fetched
   content/file reads) that tags results with `untrusted: true` and wraps them in a delimiter block
   the system prompt tells the model to treat as data. Cheap and high-value.

Mode set for Vela: **Manual / Accept edits / Plan / Auto / Don't ask / Bypass**, with the same
per-folder memory of the selector choice and Plan-is-session-only rule. Ship `dontAsk` in the GUI too
(Anthropic omits it from Desktop for no good reason; it's the right mode for a headless local run).

Bypass gating without an Anthropic account: gate it behind a one-time typed confirmation dialog
persisted to user settings (Anthropic does exactly this), plus refuse to start bypass as root/sudo
on Linux/macOS unless inside a recognized sandbox — copy that check verbatim, it's free safety.

Keep the circuit breakers that fire **even in bypass**: `rm -rf /` and `rm -rf ~` (including inside
`$( )`, backticks, `<( )`), explicit ask rules, and `requiresUserInteraction` MCP tools.

---

## 4. Session management

**Sources:** `https://code.claude.com/docs/en/sessions.md`,
`https://code.claude.com/docs/en/desktop.md` §Manage sessions

### Storage and identity

- "A session is a saved conversation tied to a project directory."
- Transcripts stored as **JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`**, where
  `<project>` is the working directory path with non-alphanumeric characters replaced by `-`. If the
  converted name exceeds 200 chars it is truncated to 200 and a hash of the full path appended.
- "Each line is a JSON object for a message, tool use, or metadata entry. The entry format is
  internal to Claude Code and changes between versions."
- Configurable: `CLAUDE_CONFIG_DIR` moves storage; `cleanupPeriodDays` changes the 30-day retention;
  `CLAUDE_CODE_SKIP_PROMPT_HISTORY` suppresses transcript writes; `--no-session-persistence` for one
  non-interactive run.
- **The desktop app, the CLI, Claude Code on the web, and the VS Code extension each maintain their
  own session history.** They share configuration and project memory (CLAUDE.md) but not sessions.
  `/desktop` in the CLI hands a session over to the desktop app (macOS + x64 Windows,
  subscription auth only).

### What a resume restores

Conversation history (including tool calls and results); model; agent (with its system prompt, tool
restrictions, model); permission mode — **but `plan` and `bypassPermissions` are never restored**,
and `auto` only if the account still qualifies; active goal (turn count/timer/token baseline reset);
unexpired scheduled tasks (background Bash and monitor tasks are *not* restored).

Not restored: `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model`, `--add-dir`
directories, and mid-session `/add-dir` directories. Settings files are re-read at launch.

### Resume-from-summary dialog

On Pro/Max, resuming a session inactive >~1 hour and >100,000 tokens shows a dialog before the first
message, because "the session's prompt cache has expired by then." Three options: **Resume from
summary** (runs `/compact` immediately: one summarization request over the full history, then
replaces history with the summary + most recent exchanges + up to five recently read files);
**Resume full session as-is**; **Don't ask me again**.

### Naming

- `claude -n <name>` at startup; `/rename <name>` during; `Ctrl+R` in the picker; auto-named from
  plan content on plan accept; renameable from claude.ai/Remote Control (propagates to the CLI);
  renameable in the desktop app.
- Unnamed interactive sessions get a **default display name**: working-directory name + a
  two-character suffix, e.g. `my-app-3f`. **Not a resume handle.**
- If unnamed, an **AI-generated session title** is produced by a background request to a small/fast
  model (Haiku-class) summarizing the first prompt. Also not a resume handle.

### Session picker (CLI)

`↑`/`↓` navigate; `→`/`←` expand/collapse groups; `Enter` resume; `Space` preview; `Ctrl+R` rename;
`/` or any printable char to search (**paste a GitHub/GHE/GitLab/Bitbucket PR/MR URL to find the
session that created it**); `Ctrl+A` all projects; `Ctrl+W` all worktrees of the repo; `Ctrl+B`
filter to current git branch; `Esc` exit.

Rows show name-or-title, summary/first prompt, time since last activity, git branch, file size.

Scope rules: current worktree by default (background sessions marked `bg`), plus sessions that added
the current directory with `/add-dir`. Selecting a session from another worktree of the same repo
resumes it in place; selecting one from an unrelated project copies a `cd`+resume command to the
clipboard instead.

Cross-project resume by ID "resolves the ID only when exactly one other project holds a transcript
with messages for it, so a hand-copied duplicate makes Claude Code report not-found rather than
resume an arbitrary copy."

### Branching

`/branch [name]` copies the conversation so far and switches you into it; the original is unchanged
on disk and stays in the picker. `claude --continue --fork-session` does it from the CLI. What
carries over:

| State | After `/branch` |
| --- | --- |
| Conversation history | Copied up to the branch point |
| "Allow for this session" grants | Carried over (same process). With `--fork-session` into a separate process, **not** carried over |
| In-flight background subagents and background Bash | Keep running; their output appears in the **new** branch |
| Remote Control connection | Stays connected and follows you into the branch |

"If you resume the same session in two terminals without forking, messages from both interleave into
one transcript."

### Context management within a session

`/clear` (previous conversation saved and resumable; a name set with `--name`/`/rename` is kept, an
AI-generated title is not), `/compact [instructions]`, `/context`.

### Export

`/export` copies to clipboard or writes a plain-text file with messages and tool outputs rendered as
readable text. Script-facing interfaces: `claude -p --output-format json|stream-json`;
`claude -p --resume <id>` for a follow-up; the `transcript_path` field passed to hooks and
statusline commands; the Agent SDK.

### Desktop-specific session UX

- `+ New session` / `Cmd+N`; `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle; `Cmd+Shift+]` / `Cmd+Shift+[` also
  cycle; `Cmd+W` close.
- **Split view**: `Cmd`-click (macOS) / `Ctrl`-click (Windows) a sidebar session to open it in a
  second pane. While split, clicking another sidebar session replaces whichever pane has focus.
  `Cmd+\` closes the focused pane.
- Sidebar controls filter sessions by status, project, or environment, and group by project.
- Rename by clicking the session title in the toolbar.
- **Auto-archive after PR merge or close** (Settings → Claude Code); only applies to local sessions
  that have finished running.
- "The desktop app sends an OS notification when a Code session finishes a task and you aren't
  currently viewing that session."

### Vela reimplementation

**Dependency: CLIENT_SIDE_PORTABLE** (except the AI-generated title and resume-summary, which just
need *a* model — any model).

- Storage: same shape. `~/.vela/projects/<slugified-abs-path>/<session-id>.jsonl`, with the
  200-char + hash truncation rule (it's a real filesystem constraint, keep it). Append-only JSONL
  gives crash-safe incremental writes for free. **Version every line** with a `v` field — Anthropic
  explicitly warns their format churns; Vela should instead commit to a documented, versioned
  transcript schema so third-party tooling is viable. That's a differentiator.
- Store the **canonical internal message format** (see §2) in the JSONL, plus a `provider_render`
  cache if needed. This is what makes mid-session model switching and resume-under-a-different-model
  work — a capability Claude Desktop does *not* have (it pins the session's model).
- One transcript store shared by all Vela surfaces (desktop shell, CLI, remote attach). Anthropic's
  per-surface split is a UX bug users complain about; Vela should make one session resumable from
  any surface. Concretely: sessions are rows in a small SQLite index (`~/.vela/sessions.db`:
  id, name, title, project_path, worktree, branch, created, last_active, size, mode, model,
  archived, parent_session_id) pointing at JSONL files. SQLite gives the picker's filtering
  (`Ctrl+A`/`Ctrl+W`/`Ctrl+B` equivalents) for free without scanning the FS.
- Resume restore semantics: copy exactly, including **never restoring `plan` or `bypass`**. That's a
  well-reasoned safety default.
- Resume-from-summary: Vela has no prompt cache, but the same "long-idle + huge context" heuristic
  still matters for local models where prefill is expensive. Offer the same three-way dialog, with a
  fourth local-specific option: **"Resume as-is and re-prefill in background"** (kick off the prefill
  so the first message isn't slow), which llama.cpp/vLLM prefix caching makes cheap.
- Session titles: generate with the configured **small/fast model** (`judge`/`titler` slot). If the
  user has only a large local model, make title generation opt-in — don't burn 30s of GPU on a title.
- Default display name `<folder>-<2 char suffix>`: keep, it's genuinely useful in listings.
- Branching: implement as transcript copy + switch, with the exact inheritance table above. The
  "in-flight background work follows the branch" rule falls out naturally if the branch is a
  transcript switch inside the same process.
- Picker: keep the PR-URL search (index PR URLs when the agent creates one).
- `/export`: render to Markdown as well as plain text; also expose `vela session export --json` with
  the versioned schema.

---

## 5. Parallel sessions and git worktree isolation

**Sources:** `https://code.claude.com/docs/en/worktrees.md`,
`https://code.claude.com/docs/en/desktop.md` §Work in parallel with sessions

Desktop behavior: "For Git repositories, each session gets its own isolated copy of your project
using Git worktrees, so changes in one session don't affect other sessions until you commit them."

- Worktrees stored in `<project-root>/.claude/worktrees/` by default; configurable in
  Settings → Claude Code → "Worktree location". A **branch prefix** can be set, prepended to every
  worktree branch name.
- Default branch name from the CLI is `worktree-<name>`; unnamed worktrees get a generated name like
  `bright-running-fox`.
- Remove a worktree by hovering the session in the sidebar and clicking the archive icon.
- **Session isolation requires Git.** On Windows, Git is required for the Code tab to work at all.
- `.worktreeinclude` at project root (gitignore syntax) copies gitignored files like `.env` into
  every new worktree. "Only files that match a pattern **and are also gitignored** are copied, so
  tracked files are never duplicated."

**Base branch**: `worktree.baseRef` = `"fresh"` (default; branch from the remote default branch,
fetching `origin/HEAD` if not fetched in 24h, capped at 5 seconds, falling back to the local cache
then to local HEAD) or `"head"` (branch from current local HEAD). Cannot be set to a branch name.

**Branch from a PR**: `claude --worktree "#1234"` fetches `pull/<number>/head` from origin and
creates the worktree at `.claude/worktrees/pr-<number>`.

**Reuse**: passing an existing name opens that worktree. With `"fresh"`, a reopened worktree resets
to the default branch only when it has no uncommitted changes or untracked files, is still on the
branch Claude created, and has no commits of its own *or* its PR was merged and its remote branch
deleted (detected from git state alone). Anything else reopens at the old tip.

**Enforcement while isolated** — four checks, applied to the session and every subagent it spawns:

1. **File edits**: block `Edit`/`Write`/`NotebookEdit` targeting a path in the main checkout.
2. **Command working directory**: block a Bash/PowerShell/Monitor command whose cwd resolves to the
   main checkout, or whose cwd it can't verify stays outside it.
3. **Git redirects**: block commands redirecting git into the main checkout via `git -C`,
   `--git-dir`, `GIT_DIR`/`GIT_WORK_TREE`, or a `cd` into the main checkout before running git.
4. **Command shape**: block any Bash/Monitor command it can't verify stays inside the worktree —
   "the block applies even when the command runs no git at all. Claude Code refuses shell constructs
   it can't statically trace, such as brace expansion and heredocs with unquoted delimiters. It
   tells Claude to break the command into plain, separate commands. **You can't turn this check
   off.**"

**Subagent worktrees**: `isolation: worktree` in subagent frontmatter, or ask Claude to "use
worktrees for your agents". Each gets a temporary worktree removed automatically when the subagent
finishes without changes. While an agent runs, Claude Code runs `git worktree lock` on its worktree
so concurrent cleanup can't remove it; the lock releases on finish, and a periodic sweep releases
locks left by exited processes (but never locks the user set themselves).

**Periodic sweep** removes subagent/background-session worktrees older than `cleanupPeriodDays`,
skipping any that hold changed/untracked files or unpushed commits. Never removes `--worktree`
worktrees.

**What worktrees share with the main checkout**: the repository's `.git` directory (and sandboxing
allows those writes so `git commit` works from inside a sandboxed worktree); project-scope plugins;
and **permission approvals** — "Yes, don't ask again" in a worktree session saves to the *main
checkout's* `.claude/settings.local.json`, so it applies everywhere and survives worktree removal.

**Non-git VCS**: `WorktreeCreate` / `WorktreeRemove` hooks replace the git logic entirely (documented
SVN example). `.worktreeinclude` is not processed when a `WorktreeCreate` hook is used.

**Refusal check**: before adopting a directory as an isolation worktree, Claude Code checks its git
identity and refuses when the metadata resolves into the main checkout (a `.git` file pointing at
the main repo's `.git`, a `core.worktree` redirect), when the `.git` entry is unreadable, when the
directory contains the protected checkout, or when its recorded path has a network spelling.
Symlinked `.claude`, `.claude/worktrees`, or worktree paths are refused outright.

### Vela reimplementation

**Dependency: CLIENT_SIDE_PORTABLE.** Pure git + filesystem. Nothing here touches Anthropic.

- Shell out to `git worktree add/list/remove/lock/unlock` — do not reimplement. Store under
  `<project-root>/.vela/worktrees/<name>`, configurable, with a branch-prefix setting. Auto-append
  `.vela/worktrees/` to `.git/info/exclude` (better than telling the user to edit `.gitignore`).
- Implement the **four isolation checks**. Check 4 (command shape) is the one people will be tempted
  to skip — don't. Implement it with a real bash parser (`tree-sitter-bash`); on a parse failure or
  on constructs you can't trace (brace expansion, unquoted heredoc delimiters, `eval`, dynamic
  `$VAR` paths), refuse and return a tool error instructing the model to split the command. This is
  cheap, deterministic, and works with any backend model.
- Implement `.worktreeinclude` with gitignore-syntax matching (`pathspec`/`ignore` crate), and the
  "must also be gitignored" precondition.
- Implement `worktree.baseRef` fresh/head with the 24h fetch heuristic and 5s cap.
- Implement PR-based worktrees generically: `--worktree "#1234"` for GitHub, plus GitLab MR refs
  (`merge-requests/<n>/head`) and Gerrit changes. Vela shouldn't be GitHub-only.
- Implement the periodic sweep and the `git worktree lock` protocol including stale-lock release for
  dead PIDs (read the lock reason to distinguish Vela's locks from user locks).
- Implement the adoption **refusal check**: resolve `.git`, reject `core.worktree` redirects, reject
  paths that contain the main checkout, reject UNC/network paths, reject symlinked components.
- Implement approval-scope sharing: session-level "don't ask again" writes to the *main checkout's*
  `.vela/settings.local.json`.
- Non-git projects: ship `WorktreeCreate`/`WorktreeRemove` hooks, and additionally offer a
  **copy-on-write fallback** for non-VCS folders — on macOS `cp -c` (APFS clonefile), on Linux
  `cp --reflink=auto` (btrfs/XFS), else a plain copy. Claude Desktop simply refuses to isolate
  non-git projects; Vela can do better and this matters for the Cowork-style document work where the
  folder isn't a repo.

---

## 6. Diff review, code review, and PR monitoring

**Source:** `https://code.claude.com/docs/en/desktop.md`

**Diff view**: a diff-stats indicator appears when files change (e.g. `+12 -1`); clicking opens a
viewer with a file list on the left and changes on the right. Click any line to open a comment box;
type feedback and press Enter to add. Submit all comments at once with `Cmd+Enter` / `Ctrl+Enter`.
"Claude reads your comments and makes the requested changes, which appear as a new diff."
`Cmd+Shift+D` toggles the diff pane.

**Review code**: a button in the diff view's top-right asks Claude to evaluate the changes before
commit; Claude leaves comments directly in the diff view and you can respond or ask for revisions.
"The review focuses on high-signal issues: compile errors, definite logic errors, security
vulnerabilities, and obvious bugs. It does not flag style, formatting, pre-existing issues, or
anything a linter would catch."

**PR monitoring**: after opening a PR, a CI status bar appears. **Claude Code uses the GitHub CLI
(`gh`) to poll check results and surface failures** — so this is client-side polling, not a webhook.
Toggles: **Auto-fix** (Claude reads failure output and iterates) and **Auto-merge** (squash;
repository auto-merge must be enabled in GitHub settings first). Desktop notification when CI
finishes. Requires `gh` installed and authenticated; Desktop prompts to install it the first time
you create a PR.

(Contrast: cloud "Auto-fix pull requests" at claude.ai *is* webhook-driven via the Claude GitHub App
— that one is server-side. The Desktop CI bar is `gh` polling.)

### Vela reimplementation

**Dependency: CLIENT_SIDE_PORTABLE.**

- Diff viewer: compute diffs from git (`git diff`, and for uncommitted-before-session state use the
  checkpoint snapshots from §8 as the base). Note Anthropic's cloud implementation computes diffs
  "from raw git blob content, so diff drivers and `textconv` filters configured in the repository
  don't apply" — Vela should do the same for determinism, but surface a banner when a `textconv`
  driver exists so the user isn't confused.
- Line comments: collect into a pending set, then inject as a single structured user message
  (`file:line` + comment text) on submit. Bind `Cmd/Ctrl+Enter`.
- "Review code": a built-in skill/prompt, not a service. Ship it as `skills/code-review` with the
  same scope discipline (high-signal only, explicitly not lint/style). Works with any backend.
- PR monitoring: poll via `gh` when present, and via `glab` for GitLab, plus a generic REST poller
  configured with a token — Vela must not be GitHub-only. Auto-fix = loop { fetch failing job logs →
  prompt → patch → push }. Auto-merge = `gh pr merge --squash --auto`. Fire an OS notification via
  the desktop shell's notification API.
- Everything here works identically with a local model; PR auto-fix quality is model-dependent, so
  gate the toggles behind a per-model capability hint and default them off for small models.

---

## 7. Panes, terminal, file editor, browser preview, iOS simulator

**Source:** `https://code.claude.com/docs/en/desktop.md`,
`https://code.claude.com/docs/en/desktop-ios-simulator.md`

### Pane system

"The Code tab is built around panes you can arrange in any layout: chat, diff, browser, terminal,
file, plan, tasks, and subagent, along with the iOS Simulator on macOS." Drag a pane by its header to
reposition; drag an edge to resize. `Cmd+\` closes the focused pane. Additional panes open from the
**Views** menu. (Requires Claude Desktop v1.2581.0+.)

### Integrated terminal

Opens with `Ctrl+\``. "The terminal opens in your session's working directory and shares the same
environment as Claude, so commands like `npm test` or `git status` see the same files Claude is
editing." `+` in the pane header for a second tab; right-click a folder in the chat → **Open in
terminal**. **Local sessions only** (not SSH, not WSL, not cloud).

### File editor pane

Click a file path in chat or the diff viewer to open it. HTML, PDF, image and video paths open in the
Browser pane instead. Spot edits + **Save**. "If the file changed on disk since you opened it, the
pane warns you and lets you override or discard." **Discard** reverts your edits; clicking the path
in the header copies the absolute path. Available in local and SSH sessions.

Right-click context menu on any file path: **Attach as context**, **Open in** (VS Code, Cursor, Zed),
**Show in Finder/Explorer**, **Copy path**.

### View modes (transcript verbosity)

`Ctrl+O` cycles; also a **Transcript view** dropdown.

| Mode | What it shows |
| --- | --- |
| Normal | Tool calls collapsed into summaries, with full text responses |
| Verbose | Every tool call, file read, and intermediate step |
| Summary | Only Claude's final responses and the changes it made |

### Browser pane / app preview

- Claude can start a dev server and open it in the Browser pane, for frontend *and* backend
  ("Claude can test API endpoints, view server logs, and iterate"). Usually starts automatically
  after editing project files.
- The pane also opens static HTML, PDFs, images, and videos from the project.
- From the pane: interact with the app; watch Claude verify its own changes (**takes screenshots,
  inspects the DOM, clicks elements, fills forms, fixes issues**); start/stop servers from the server
  dropdown; **Persist sessions** to keep cookies and localStorage across restarts; edit the server
  config; stop all servers.
- **Tabbed browser** for external sites. `Cmd+Shift+B` toggles. Clicking an external link in chat
  offers **Open in app** vs **Default browser**; `Cmd`/`Ctrl`-click goes straight to the system
  browser. Sign-in flows including Google OAuth popups work.
- **Two extra safety checks on external pages**: (a) safety classifiers review Claude's *write*
  actions (clicking, typing) in **every** permission mode, and a flag forces a permission prompt
  regardless of mode; (b) outside Auto and Bypass, a **domain allowlist check** applies before
  navigating to a new site.
- Per-site approval card: **Allow once** / **Always allow** (saved on device, revocable in Settings)
  / **Deny**. Each site needs its own approval, including subdomains. Local dev servers and project
  files need no approval.
- "Even on an approved site, Claude won't purchase items, create accounts, or bypass CAPTCHAs
  without your input."
- **The Browser pane uses a clean browser profile, separate from your personal browser, with none of
  your saved logins or history.** (The Chrome extension is the "act as me" path.)
- `Cmd+Shift+S` = select an element in the Browser.
- Org controls: `browserExternalPageTools: "disabled"` removes Claude's tools on external pages
  (users can still browse); `disableBrowserExternalNavigation: true` blocks all external navigation
  for both users and Claude (localhost and file previews unaffected; **must be the JSON boolean
  `true`, the string `"true"` is ignored**).

### `.claude/launch.json` — preview server configuration

Stored at the root of the folder selected when starting the session. "Preview uses this folder as its
working directory, so if you selected a parent folder, subfolders with their own dev servers won't be
detected automatically." Supports JSON with comments.

```json
{
  "version": "0.0.1",
  "autoVerify": false,
  "configurations": [
    {
      "name": "my-app",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev"],
      "port": 3000
    }
  ]
}
```

Fields: `name`, `runtimeExecutable`, `runtimeArgs`, `port` (default 3000), `cwd` (supports
`${workspaceFolder}`), `env` (docs warn: don't put secrets here since the file is committed — use the
local environment editor instead), `autoPort`, `program` (a script run with `node`), `args`, `url`.

- **`autoVerify`** (default **on**): "Claude automatically verifies code changes after editing files.
  It takes screenshots, checks for errors, and confirms changes work before completing its response."
  Disable per-project with `"autoVerify": false` or from the server dropdown.
- **`url`**: opens something other than `http://localhost:<port>`. Localhost addresses
  (`localhost`, `*.localhost`, `127.0.0.1`, `::1`) open directly, but "a localhost `url` must be just
  your server's origin — no path or query, and the port must match the entry's port." A localhost URL
  with a path/query/mismatched port is a configuration error that names the url and shows the fix.
  Any other address prompts for permission the first time. Setting `url` **without a command**
  attaches the preview to a server you already run. Must be http/https, no username/password.
- **`autoPort`**: `true` = find a free port; `false` = fail with an error (for OAuth callbacks, CORS
  allowlists); unset = ask once and save the answer. "When Claude picks a different port, it passes
  the assigned port to your server via the `PORT` environment variable."

### iOS Simulator pane (macOS)

- Opens automatically when Claude builds/installs/launches/checks the app in a simulator; streams the
  device screen live. **Drives the simulator directly, so it doesn't need computer use and never
  takes over your screen.** (From the CLI, Claude reaches the simulator via computer use instead.)
- Requirements: Claude Desktop v1.24012.0+, a Mac, Xcode **26.x** with the iOS platform (the pane
  does not work with Xcode 27, which replaces the Simulator app with Device Hub). Local sessions
  only.
- Interactive: click/drag to tap and swipe; `Cmd+Shift+H` Home, `Cmd+L` lock, `Cmd+Up/Down` volume,
  `Cmd+Right` rotate; `Cmd+S` screenshot, `Cmd+R` screen recording (saved to Desktop); frame rate /
  resolution / encoding (H.264 or JPEG) / FPS controls; **Attach simulator** / **Detach simulator**.
- "You and Claude drive the same device… While Claude is driving the device, the pane shows a
  **Claude is using this device** badge."
- Device ownership per session; up to **4 panes per session**. Desktop shuts down simulators it
  booted when you quit the app, archive the session, or 10 minutes after detaching. Devices you
  booted yourself are never auto-shut-down.
- **Consent**: once per device, not per session, covering control + screenshots. "Claude's
  screenshots of the device are sent to Anthropic and kept under your normal conversation retention
  settings, so don't sign in to real accounts on a device Claude uses." Declining still lets you use
  the pane yourself.
- Two actions follow the session's permission mode rather than the one-time consent: **opening a URL
  on the device** (a URL can carry data off the device) and **building the app** (`xcodebuild` runs
  your project's build scripts on your Mac).
- Org kill switches: `disableMobileSimulatorTools` (blocks Claude's tools, pane stays usable);
  `requireCoworkFullVmSandbox` (runs Claude's tools inside an isolated VM, disabling the pane
  entirely).
- Not available to Enterprise orgs with HIPAA configuration or ZDR.

### Vela reimplementation

**Dependency: CLIENT_SIDE_PORTABLE** across the board. Nothing in this section requires Anthropic.

- **Pane system**: a dockable/splittable layout (golden-layout, dockview, or a custom flexbox tree)
  persisted per session. Same pane types: chat, diff, browser, terminal, file, plan, tasks, subagent,
  simulator. Same shortcuts.
- **Terminal**: `xterm.js` + a PTY (`node-pty` / `portable-pty`), spawned with the session's cwd and
  the exact env the agent uses (see §11 env-var handling — this is the whole point of "shares the
  same environment as Claude"). Extend beyond Anthropic: make the terminal work in SSH and container
  sessions too by tunnelling the PTY, since there's no reason to restrict it to local.
- **File editor**: CodeMirror 6 or Monaco. Implement the on-disk-change detection with an mtime+hash
  stamp taken at open, and offer override/discard. "Open in" should shell out to detected editors
  (`code`, `cursor`, `zed`, `subl`, `idea`) discovered on PATH plus user-configured entries.
- **View modes**: purely a render filter over the transcript. Trivial and high value; ship all three.
- **Browser pane**: an embedded Chromium view (Electron `<webview>`/`BrowserView`, or Tauri +
  a bundled WebView2/WKWebView; for full CDP control, an embedded Playwright-driven Chromium is the
  more capable option). Give the agent CDP-backed tools: `browser_navigate`, `browser_screenshot`,
  `browser_snapshot` (accessibility tree — cheaper and more reliable than screenshots for local
  models), `browser_click`, `browser_type`, `browser_eval`, `browser_console_logs`,
  `browser_network_log`. **Prefer the accessibility snapshot over screenshots** since many local
  backends are text-only; screenshots become an optional vision path.
  - Use a **dedicated, isolated browser profile** by default, exactly as Anthropic does, with a
    "Persist sessions" toggle that maps to a named persistent profile directory.
  - Reimplement the **two extra checks** on external pages: (a) route write-actions
    (click/type/eval/navigate-with-credentials) through the local judge (§3) in every mode; (b) a
    per-site allowlist with Allow once / Always allow / Deny, stored per-device, revocable in
    Settings, subdomain-exact. Skip both for `localhost`, `127.0.0.1`, `::1`, `*.localhost`, and
    `file://` paths under the project.
  - Reimplement the two org kill switches as managed settings:
    `browserExternalPageTools: "disabled"` and `disableBrowserExternalNavigation: true`.
- **`launch.json` equivalent** — `.vela/launch.json`, same schema (it's basically VS Code's
  `launch.json` subset, so users already know it). Implement `autoPort` (bind-probe a free port and
  export `PORT`), `url` with the localhost origin-only validation rule, and command-less `url`
  entries that attach to an already-running server. Support JSONC.
- **`autoVerify`**: an after-edit hook in the agent loop that, when a preview server is configured
  and running, takes a snapshot + console/network errors and feeds them back before the turn ends.
  Default on, per-project toggle. For text-only local models, feed the accessibility snapshot and
  console errors rather than an image.
- **iOS simulator pane**: entirely local Apple tooling — `xcrun simctl list/boot/install/launch`,
  `simctl io booted recordVideo` / screenshot, and `xcodebuild`. Stream via an H.264 pipe into the
  UI. Agent tools: `sim_list`, `sim_boot`, `sim_install`, `sim_launch`, `sim_tap`, `sim_type`,
  `sim_screenshot`, `sim_accessibility_tree` (via `simctl`'s accessibility APIs / XCUITest bridge —
  again preferable for text-only models). Per-device consent, `Claude is using this device`-style
  badge, 4-pane cap, 10-minute auto-shutdown for Vela-booted devices only. Route `open URL on device`
  and `xcodebuild` through the permission mode rather than the one-time consent — that distinction
  is correct and worth copying. **Add an Android equivalent** (`adb`, `emulator`,
  `uiautomator dump` for the view hierarchy); Anthropic has no Android story and it is symmetric.
  Since Vela runs the model locally, the retention warning ("screenshots are sent to Anthropic")
  disappears entirely — that's a genuine selling point to state in the UI.

---

## 8. Checkpointing / rewind

**Source:** `https://code.claude.com/docs/en/checkpointing.md`

- "Checkpointing automatically captures the state of your code before each user prompt."
- **Every user prompt creates a new checkpoint.** File snapshots kept for the **100 most recent
  checkpoints** in a session. "Discarding an older checkpoint deletes the snapshot files that no
  remaining checkpoint references, except each file's first snapshot, which the VS Code extension
  uses as the baseline for its session diffs."
- Checkpoints are saved with the conversation, so `/rewind` works after a resume. Deleted with
  sessions after 30 days (`cleanupPeriodDays`).
- `/rewind`, or **Esc Esc** on an empty prompt input. Actions: **Restore code and conversation**,
  **Restore conversation**, **Restore code**, **Summarize from here**, **Summarize up to here**,
  **Never mind**. The code-restore options appear only when the checkpoint has tracked file changes.
- After restoring the conversation or "Summarize from here", the original prompt is restored into the
  input field. "Summarize up to here" leaves you at the end with an empty input. Either summarize
  option leaves a **Summarized conversation** marker in the conversation.
- **Rewind past a cleared conversation**: if `/clear` ran earlier in the same process, the menu shows
  a top entry `/resume <session-id> (previous session)`.
- **Guide a summary**: highlight a Summarize option and type instructions in the
  **add context (optional)** row.
- Limitations, all important:
  - **Bash-command changes are not tracked.** `rm`, `mv`, `cp` are unrecoverable via rewind.
  - **Subagent edits are usually not restored.** Exception: a foreground forked skill
    (`context: fork`, `background: false`) edits during your own turn so its edits *are* restored.
  - **External changes not tracked** (manual edits, other concurrent sessions), unless they touch the
    same files.
  - **Symlinked and hard-linked paths are not restored** — a restore skips them and warns
    `Restored the code, but skipped N files`. Dotfile-manager symlinks and pnpm hard-links fall here.
  - "Not a replacement for version control."

### Vela reimplementation

**Dependency: CLIENT_SIDE_PORTABLE.**

Implement checkpoints as a **shadow git repository** — this is both the natural implementation and
strictly better than snapshot files:

- `~/.vela/checkpoints/<session-id>/` holding a bare repo with `GIT_DIR` pointed there and
  `GIT_WORK_TREE` pointed at the project/worktree. Before each user prompt: `git add -A` (respecting
  a checkpoint-specific ignore list) + `git commit` → the commit SHA is the checkpoint id, recorded
  in the transcript. Restore = `git checkout <sha> -- .` scoped to tracked paths. Content-addressed
  storage dedupes automatically, so the "100 most recent" cap and the reference-counted pruning
  Anthropic describes become unnecessary — just prune by `cleanupPeriodDays`.
- This also **fixes the Bash-changes limitation for free**: a shadow-repo snapshot captures whatever
  is on disk at prompt time, including changes made by shell commands. Vela should advertise that.
  (Keep an explicit "only files under the project root" bound; do not snapshot `node_modules`,
  `.venv`, build output — ship a default checkpoint ignore list and let `.veladiff-ignore` extend it.)
- Keep the symlink/hardlink behavior explicit: detect them at restore, skip, and warn with the file
  list. Do **not** silently write through links (Anthropic's pre-v2.1.216 behavior was a bug).
- Ship all six menu actions including both summarize directions, the restored-prompt-into-input
  behavior, and the "rewind past `/clear`" entry.
- Summarization uses whatever backend is configured; for a small local model, chunk the summarization
  (map-reduce over message windows) rather than one giant request.
- Debug affordance: log skipped paths to `~/.vela/debug/<session-id>.txt` like Anthropic does.

---

## 9. Environments: Local, Cloud, SSH, WSL — and the Cowork VM

**Sources:** `https://code.claude.com/docs/en/desktop.md` §Environment configuration,
`https://code.claude.com/docs/en/claude-code-on-the-web.md`,
`https://code.claude.com/docs/en/desktop-wsl.md`,
`https://code.claude.com/docs/en/desktop-linux.md`,
`https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview`,
`https://support.claude.com/en/articles/13364135-use-claude-cowork-safely`

### Local sessions — environment variable handling (subtle and important)

"The desktop app does not always inherit your full shell environment. On macOS, when you launch the
app from the Dock or Finder, it reads your shell profile, such as `~/.zshrc` or `~/.bashrc`, to
extract `PATH` and a fixed set of Claude Code variables, but other variables you export there are not
picked up. On Windows, the app inherits user and system environment variables but does not read
PowerShell profiles."

The fix Anthropic ships: a **local environment editor** — environment dropdown → hover **Local** →
gear icon. "Variables you save here are stored **encrypted on your machine** and apply to every local
session and preview server you start." Variables in `~/.claude/settings.json`'s `env` key reach Claude
sessions only, **not** dev servers.

Thinking config lives here too: `MAX_THINKING_TOKENS=0` disables extended thinking (no effect on
Fable 5); `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` for a fixed budget on Opus 4.6 / Sonnet 4.6.

### Cloud sessions — ANTHROPIC_SERVER_SIDE

- "Cloud sessions run on Anthropic-managed infrastructure by default and continue even if you close
  the app or shut down your computer." Monitorable from claude.ai/code and the mobile app.
- Multiple repositories per session, each with its own branch selector.
- Isolation layers: **isolated, Anthropic-managed VM per session**; network access limited by default
  and can be disabled ("When running with network access disabled, Claude Code can still communicate
  with the Anthropic API, which may allow data to exit the VM"); **credential protection** — "git
  credentials or signing keys are never inside the sandbox with Claude Code; authentication is
  handled through a secure proxy using scoped credentials."
- The cloud VM **clones your GitHub remote at your current branch, not your local checkout.**
- Repos without GitHub can be **bundled and uploaded**: full history across all branches plus
  uncommitted changes to tracked files, under **100 MB** (degrading to current-branch-only, then to a
  squashed working-tree snapshot). Untracked files are not included. Bundled sessions can't push back
  without GitHub auth.
- Cloud limitations: no `@mention`, no `+` connector button (routines configure connectors instead),
  no plugin browser (declare plugins in the repo's `.claude/settings.json` `enabledPlugins`), no
  file pane, no terminal, no iOS simulator, no bypass permissions, `/clear` unavailable,
  `defaultMode: "bypassPermissions"` and `"dontAsk"` are silently ignored.
- Sessions stop after inactivity and the VM is reclaimed; reopening provisions a fresh VM with
  conversation history restored.
- **Organization IP allowlisting breaks cloud sessions entirely** ("cloud sessions call the Anthropic
  API from Anthropic-managed infrastructure, not your network").
- **Continue in another surface** (VS Code icon, bottom-right of the session toolbar): **Claude Code
  on the Web** pushes your branch, generates a conversation summary, and creates a cloud session with
  full context (requires a clean working tree; not available for SSH); or **Your IDE**.

### SSH sessions

- Add via environment dropdown → **+ Add SSH connection**. Fields: **Name**, **SSH Host**
  (`user@hostname` or a `~/.ssh/config` host), **SSH Port** (default 22 or from config), **Identity
  File**.
- "The remote machine must run Linux or macOS. Desktop installs Claude Code on the remote machine
  automatically the first time you connect." SSH sessions support permission modes, connectors,
  plugins, and MCP servers. The file pane works; the terminal pane does not.
- **Personal skills**: an SSH session reads `~/.claude/skills/` from the **remote host's** home
  directory, not your machine's.
- Admin controls: `sshConfigs` in managed settings pre-configures connections (`id`, `name`,
  `sshHost` required; `sshPort`, `sshIdentityFile`, `startDirectory` optional) shown as managed and
  uneditable; `sshHostAllowlist` restricts which hosts are reachable (patterns are case-insensitive,
  `*` matches any host, `*.example.com` matches the apex and subdomains, anything else is exact; the
  check runs against the hostname **after `~/.ssh/config` resolution via `ssh -G`**, so `Host`
  aliases and `ProxyCommand`/`ProxyJump` work as long as the resolved `HostName` matches). Empty
  array disables SSH entirely. Managed-settings only. Explicitly *not* a network boundary — "it
  governs which hosts the Desktop app connects to, not network egress."

### WSL sessions (Windows)

- "The session's Claude Code process, its tools, and git all execute inside the distribution, using
  its Linux toolchain and native Linux paths."
- Requires WSL 2 (not WSL 1), at least one distribution, `git` inside the distribution.
- Environment picker lists installed WSL 2 distributions under a **WSL** section. Folder browsing
  happens inside the distribution with Linux paths. **Workspace trust is granted per distribution and
  folder** — "A folder you trust in one distribution isn't trusted in another distribution or at the
  same path on Windows." `\\wsl.localhost\...` folders opened from the normal picker reopen inside
  that distribution.
- Works: parallel sessions, side chats, diff review, branch/PR status, worktrees; "Open in editor"
  opens VS Code via Remote-WSL.
- **Not available in WSL sessions**: the integrated terminal, connectors and plugins, session
  forking, the file browser pane, and `@` file suggestions.

### Linux desktop (beta)

apt repo at `downloads.claude.ai/claude-desktop/apt/stable`, signing key fingerprint
`31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`, `amd64`/`arm64` only, Ubuntu 22.04+/Debian 12+. No
self-update (apt only). **Not in the Linux beta**: Computer Use, dictation, Quick Entry global hotkey
on native Wayland (needs the GlobalShortcuts portal; X11 works). Desktop does **not** accept a
Console API key — subscription or SSO only.

### Cowork's execution model — the two-layer story

From the Cowork architecture article:

- **Cloud sessions (default & beta)**: Anthropic-managed infrastructure, "Each session gets its own
  sandbox, created when the session starts and destroyed when it ends." No shared state across
  sessions or orgs.
- **Local sessions (Desktop)**: "the agent loop runs natively with application-layer permission
  controls, while **code execution occurs in an isolated virtual machine using the platform's
  hypervisor (Apple Virtualization.framework on macOS, Hyper-V on Windows)**."
- Cloud network: "The sandbox can't reach private, internal, link-local, or cloud-metadata
  addresses." Egress passes through a **mandatory, non-reconfigurable proxy** restricted to
  allow-listed destinations. Credentials are temporary and session-scoped, expiring within hours.
  **Connector authorization tokens never enter the sandbox — connector calls execute server-side.**
- **Desktop file access from cloud sessions** routes through the Claude Desktop app over "an
  Anthropic-brokered connection," limited to member-connected folders, with permission checks before
  each tool execution. If the desktop app is offline, cloud sessions cannot reach your computer.
- Cowork permission modes: **Manually approve**, **Automatically approve** (safety checks in the
  background; "consumes more of your usage limit than the other modes"), **Skip all approvals**.
  "Claude always asks before permanently deleting files, in any mode."
- Folder scoping advice: "You control which local files Claude can access… consider creating a
  dedicated working folder for Claude rather than granting broad access."
- Key honesty from the docs: **"Isolation limits where Claude's code runs. It doesn't limit what
  Claude reads or does."**
- MDM keys: `isLocalDevMcpEnabled`, `isDesktopExtensionEnabled` restrict plugin servers and
  extensions on managed devices. Admin toggles: org-wide Cowork on/off, cloud sessions separately
  from desktop Cowork, network-access policies, permission-gating, trusted-device enrollment.
- "Host-based EDR tools cannot inspect VM-isolated activity."

### Vela reimplementation

**Dependency: MIXED — Local/SSH/WSL are CLIENT_SIDE_PORTABLE; Cloud is ANTHROPIC_SERVER_SIDE.**

**server_side_detail:** cloud sessions and Cowork cloud sandboxes are Anthropic-managed VMs with an
Anthropic-operated egress proxy, Anthropic-minted scoped git credentials, and server-side connector
execution (OAuth tokens never enter the sandbox). None of that is reachable or reproducible from a
third-party desktop app.

**Local substitutes:**

- **Environment editor**: ship it, and fix Anthropic's split. Vela reads the user's login shell
  environment properly at startup — spawn `$SHELL -l -i -c 'export -p'` (or `-l -c` to avoid
  interactive-shell side effects) once and cache the result, rather than grepping rc files for a
  fixed variable set. Surface an editable env table in Settings, persisted **encrypted at rest**
  using the OS keychain (macOS Keychain via `security`, Windows DPAPI/Credential Manager, Linux
  Secret Service / `libsecret`, with an age/passphrase fallback for headless). Apply the same env to
  agent sessions, the terminal pane, and preview servers — do not repeat Anthropic's split where
  `settings.json.env` reaches sessions but not dev servers.
- **"Cloud" → "Remote runner"**: a Vela daemon (`vela-agentd`) the user installs on any box they
  control — a VPS, a homelab server, a work desktop. It runs under systemd/launchd, persists across
  disconnects, exposes a local-only API, and the desktop attaches over SSH port-forward or a
  user-supplied WireGuard/Tailscale address. This delivers the actual user-visible property of cloud
  sessions ("keeps running when I close the laptop") with zero Anthropic dependency and no
  third-party data custody. Multi-repo support and per-repo branch selectors are just config.
- **Cowork's VM**: reimplement locally with tiered isolation, selected by a `sandbox.backend` setting:
  1. **Container** (default, cross-platform): Docker or Podman, rootless where possible, with the
     project folder bind-mounted, a read-only root, dropped capabilities, a seccomp profile, and a
     user namespace.
  2. **MicroVM** (strongest, matches Anthropic): `krunvm`/`libkrun` or Apple
     `Virtualization.framework` on macOS, `Hyper-V`/WSL2 on Windows, `cloud-hypervisor`/`firecracker`
     or `systemd-vmspawn` on Linux.
  3. **OS sandbox** (lightest, matches Claude Code's Bash sandbox — see §10): Seatbelt on macOS,
     bubblewrap on Linux.
  Expose the tier in the UI, because the tradeoff (startup latency vs. isolation strength) is real.
- **Egress proxy**: run a local HTTP/SOCKS proxy the sandbox is forced through (no direct network
  namespace route), enforcing a domain allowlist and **blocking RFC1918, link-local `169.254.0.0/16`,
  and cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`)** — copy Anthropic's
  rule exactly. Log every request. Optional TLS termination with a locally generated CA for
  inspection, mirroring `network.tlsTerminate`.
- **Credential protection**: keep secrets out of the sandbox the same way — the agent never gets the
  raw git credential. Run a **credential-helper shim** outside the sandbox: the sandboxed git talks
  to a Unix socket that the host-side helper answers, so pushes work without the token ever being
  readable inside. Same pattern for connector OAuth tokens: MCP connectors run **host-side**, and the
  sandbox only sees the tool call/result over a socket. This is a direct, faithful local analogue of
  "connector calls execute server-side."
- **Deliverable generation** (Cowork's docx/xlsx/pptx output) runs inside the sandbox image with
  `python-docx`, `openpyxl`, `python-pptx`, `pypdf`/`reportlab`, `pandoc`, `libreoffice --headless`
  for conversions. Prebake this into the default Vela sandbox image so the agent doesn't spend a turn
  pip-installing.
- **SSH sessions**: implement exactly as documented — a connection registry (`sshConfigs`) with
  name/host/port/identity/startDirectory, auto-bootstrap of `vela-agentd` on the remote on first
  connect (scp a static binary; no Node/Python requirement on the remote), and `sshHostAllowlist` in
  managed settings validated against `ssh -G` resolution (that detail is the correct way to do it and
  a naive hostname compare would be bypassable via `Host` aliases). Unlike Anthropic, **make the
  terminal pane work over SSH** — it's just another PTY over the same channel.
- **WSL sessions**: same model (a `vela-agentd` inside the distribution). Copy the **per-distribution
  workspace trust** rule — same path in two distributions is two different trust grants. Unlike
  Anthropic, there is no reason to disable connectors, plugins, forking, the file pane, or `@`
  suggestions in WSL; those gaps are implementation debt, not design.
- **Linux**: ship a real Linux build from day one (AppImage + .deb + .rpm + Flatpak), with computer
  use implemented via the XDG portals (`org.freedesktop.portal.ScreenCast` for capture,
  `RemoteDesktop` for input) so Wayland works rather than being a "not yet" footnote. Global hotkey
  via `org.freedesktop.portal.GlobalShortcuts` on Wayland, X11 grab otherwise.
- **Folder scoping**: adopt Cowork's model as Vela's default for the Cowork-equivalent surface —
  explicitly connected folders, not whole-home access, with the "make a dedicated working folder"
  guidance surfaced in onboarding. And copy the honest framing verbatim in the UI: isolation limits
  where code runs, not what the agent reads or does.
- Keep **"always ask before permanently deleting files, in any mode"** — a hard circuit breaker
  independent of mode, alongside the `rm -rf /` and `rm -rf ~` breakers from §3.

---

## 10. The Bash sandbox (filesystem + network isolation)

**Source:** `https://code.claude.com/docs/en/sandboxing.md`

Distinct from the Cowork VM: this is a per-command OS sandbox for the Bash tool, built into Claude
Code, on macOS, Linux, and WSL2. **Native Windows is not supported.**

- **OS primitives**: macOS = **Seatbelt**; Linux and WSL2 = **bubblewrap**. Plus `socat` on Linux as
  "the relay used to route network traffic through the sandbox proxy," and an optional seccomp filter
  (`npm install -g @anthropic-ai/sandbox-runtime`) that adds **Unix domain socket blocking**. Ripgrep
  is bundled. "These OS-level restrictions ensure that all child processes spawned by Claude Code's
  commands inherit the same security boundaries." The same primitives ship standalone as
  `@anthropic-ai/sandbox-runtime`.
- Ubuntu 24.04+ needs an AppArmor profile granting `bwrap` `userns` (documented profile in the docs).
- **Filesystem isolation**:
  - Default write: cwd and subdirectories, plus the session temp directory `$TMPDIR` points to.
  - Default read: the entire computer except denied directories — **"this default still allows
    reading credential files such as `~/.aws/credentials` and `~/.ssh/`."** Use `sandbox.credentials`
    or `denyRead` to block them.
  - Blocked: modifying anything outside cwd + session temp, including `~/.bashrc` and `/bin/`.
  - **Git worktrees**: writes to the main repository's shared `.git` directory are allowed so
    `git commit` works, but `hooks/` and `config` inside it remain denied.
- **Sandbox protected paths** (distinct from the permission system's protected paths — "the
  permission system's protected paths control what Claude Code approves before a tool runs; the
  sandbox's list applies to a command that is already running"):
  - In cwd and directories above it: `.claude` settings files, `.claude/skills`, `.claude/agents`,
    `.claude/commands`, `.claude/hooks`, `.mcp.json`, `.claude/workflows`,
    `.claude/scheduled_tasks.json`.
  - In cwd only: shell startup files, `.gitconfig`, `.vscode`, `.idea`, `hooks` and `config` inside
    `.git`.
  - Files that would turn cwd into a bare git repository: `HEAD`, `objects`, `refs` at top level,
    plus `config`/`hooks` when they already exist. **"On Linux and WSL2, the sandbox deletes a
    top-level `HEAD` file or `objects` or `refs` directory that appears while a sandboxed command is
    running."**
  - In `~/.claude` (or `CLAUDE_CONFIG_DIR`): most contents, plus `~/.claude.json` and
    `.credentials.json`.
  - "If a symlink appears at a protected settings file's path during the session, the sandbox also
    denies writes to the file it points to, starting with the next command."
  - **No exemptions**: an `allowWrite` entry or `Edit` allow rule does not lift the protection. Only
    `filesystem.disabled` turns it off, and that turns off filesystem isolation entirely.
- **Network isolation**: "Network access is controlled through a proxy server running outside the
  sandbox." No domains pre-allowed by default; first use of a new domain prompts, and Yes allows that
  host for the rest of the session. `allowedDomains` pre-allows; `WebFetch(domain:...)` allow rules
  also pre-allow. `strictAllowlist: true` denies instead of prompting (user/managed/`--settings`
  only; **has no effect from `.claude/settings.json`**). `allowManagedDomainsOnly` in managed
  settings blocks non-allowed domains and honors only managed allowlist entries. Custom proxy via
  `sandbox.network.httpProxyPort` / `socksProxyPort`. **"The built-in proxy enforces the allowlist
  based on the requested hostname and, by default, does not terminate or inspect TLS traffic."**
  `network.tlsTerminate` (experimental) makes it terminate TLS, which credential `mask` entries
  require.
- **Modes**: **auto-allow** (sandboxed commands run without prompting; non-sandboxable commands fall
  back to the regular permission flow) and **regular permissions** (all commands go through the
  normal flow even when sandboxed). Even in auto-allow: explicit deny rules always apply; `rm`/`rmdir`
  targeting `/`, home, or critical system paths still prompt (or hit the classifier in auto mode);
  content-scoped ask rules like `Bash(git push *)` still force a prompt; a bare `Bash`/`Bash(*)` ask
  rule is skipped for sandboxed commands but applies to fallbacks — **except in plan mode, where it
  isn't skipped**.
- Mode selection saved to `.claude/settings.local.json` (added to the global gitignore).
  `sandbox.enabled: true` in user settings enables it everywhere.
- `sandbox.failIfUnavailable: true` makes a missing sandbox a hard failure instead of a warning
  ("intended for managed deployments that require sandboxing as a security gate").
- `sandbox.credentials` blocks reads of credential files and unsets secret env vars; `mask` entries
  can mask env vars and credential files and re-sign AWS requests.
- `/sandbox` panel: **Mode**, **Overrides** (`allowUnsandboxedCommands`), **Config** (resolved
  settings; "Denied within allowed" lists the protected paths), plus a **Dependencies** tab.

### Vela reimplementation

**Dependency: CLIENT_SIDE_PORTABLE.** This is the single most directly copyable subsystem in the
entire product — it uses only OS primitives and an open-source runtime.

- Use the **exact same primitives**: Seatbelt (`sandbox-exec` with a generated `.sb` profile) on
  macOS, bubblewrap on Linux/WSL2, plus an optional seccomp-BPF filter for Unix socket blocking.
  `@anthropic-ai/sandbox-runtime` is public on GitHub
  (`anthropic-experimental/sandbox-runtime`) — evaluate vendoring or reimplementing its profile
  generation rather than starting from scratch.
- **Native Windows**: Anthropic simply doesn't support it. Vela should do better with an AppContainer
  / Job Object + restricted-token sandbox, or default Windows users into the WSL2 path with a clear
  banner. Even a partial Windows sandbox (Job Object with `JOB_OBJECT_LIMIT_*`, a restricted token,
  and a filesystem-redirection layer) is worth more than "unsupported."
- Copy the **two-tier protected-paths design** verbatim, adapted to `.vela`: a *permission-system*
  list (checked before a tool runs, before allow rules) and a *sandbox* list (enforced against
  already-running commands). The subtle ones matter and are non-obvious:
  - deny `hooks/` and `config` inside `.git` even while allowing the rest of `.git` for worktrees;
  - deny writes that would turn cwd into a bare repo (`HEAD`, `objects`, `refs`, and existing
    `config`/`hooks`), and actively delete such entries that appear mid-command on Linux;
  - follow symlinks that appear at a protected path and deny the target from the next command on;
  - make the protection **unexemptable** — no allow rule lifts it.
- **Network proxy**: run the allowlisting proxy outside the sandbox, route the sandbox's traffic
  through it with `socat`/`redsocks` or a network namespace with a single veth to the proxy. Support
  `allowedDomains`, `strictAllowlist`, `allowManagedDomainsOnly`, custom proxy ports, and optional TLS
  termination with a locally-generated CA. **Never read `strictAllowlist` from project settings** —
  Anthropic's restriction is a real anti-supply-chain-attack measure.
- **Credential masking**: implement `sandbox.credentials` — deny-read `~/.ssh`, `~/.aws`, `~/.config/gcloud`,
  `~/.kube`, `~/.docker/config.json`, browser profiles, `.netrc`, plus unsetting secret-looking env
  vars, all on by default (Anthropic's default of "read access to the entire computer including
  `~/.aws/credentials`" is the wrong default and they say so themselves — Vela should invert it and
  make deny-by-default the shipped behavior for credential paths).
- Ship the `/sandbox` panel equivalent: Mode / Overrides / resolved Config / Dependencies, with a
  dependency checker that detects missing `bwrap`, `socat`, seccomp filter, and the Ubuntu 24.04
  AppArmor `userns` restriction (`sysctl kernel.apparmor_restrict_unprivileged_userns`) and offers
  the fix.
- Ship `sandbox.failIfUnavailable` — an org deploying Vela needs sandboxing to be a gate, not a hint.

---

## 11. Extending: connectors, skills, plugins, MCP

**Source:** `https://code.claude.com/docs/en/desktop.md` §Extend Claude Code

- **Customize** in the sidebar manages connectors, skills, and plugins in one place. **The Cowork tab
  sources its skills, plugins and connectors from this Customize configuration, which syncs through
  your claude.ai account, not from the CLI's `~/.claude` directory.**
- **Connectors** are "MCP servers with a graphical setup flow." Added via the `+` button →
  **Connectors**, before or during a session. Managed at Settings → Connectors. **Not available in
  cloud or WSL sessions** — routines configure connectors at routine creation time instead. For
  services not listed, add MCP servers manually via settings files; custom remote-MCP connectors are
  supported.
- **Skills**: loaded automatically when relevant, or invoked with `/` or `+` → **Slash commands**.
  Covers built-in commands, custom skills, project skills from the codebase, and plugin skills.
  Selecting one highlights it in the input; you then type the task after it. "You can send a command
  while Claude is working, the same as any other message."
  - `~/.claude/skills/` applies to local sessions; **SSH sessions read the remote host's**
    `~/.claude/skills/`; cloud sessions load the skills enabled for the claude.ai account.
- **Plugins**: "reusable packages that add skills, agents, hooks, MCP servers, and LSP configurations."
  Installable from the desktop app; browser shows marketplaces including the official Anthropic
  marketplace; scoped to user account, project, or local-only. Not available in cloud sessions (use
  `enabledPlugins` in the repo's `.claude/settings.json`) and not in WSL sessions.
- **MCP config precedence in the desktop app** (documented deviations from the CLI):
  - Desktop loads MCP servers from `claude_desktop_config.json` into **local Code tab sessions**,
    alongside `~/.claude.json` and `.mcp.json`.
  - Same server name in `claude_desktop_config.json` and `~/.claude.json`/`.mcp.json` → the Code tab
    "connects once and uses the `claude_desktop_config.json` definition."
  - The app re-delivers stdio servers from `~/.claude.json` to the embedded CLI in local sessions;
    when the top level of `~/.claude.json` (user scope) and `.mcp.json` define the same stdio server
    name, **the Code tab uses the `~/.claude.json` definition, departing from the CLI scope
    hierarchy.**
  - The standalone CLI does **not** read `claude_desktop_config.json`;
    `claude mcp add-from-claude-desktop` imports them.
- Shared config between CLI and Desktop: `CLAUDE.md` / `CLAUDE.local.md`, MCP servers in
  `~/.claude.json` or `.mcp.json`, hooks and skills, settings in `~/.claude.json` and
  `~/.claude/settings.json`, and the model list.

### Vela reimplementation

**Dependency: MIXED.** MCP itself is an open protocol (CLIENT_SIDE_PORTABLE). Anthropic's *hosted*
connectors — the ones with an OAuth flow terminating at Anthropic and tokens held server-side, where
"connector calls execute server-side" — are ANTHROPIC_SERVER_SIDE.

- **MCP**: implement a full MCP client (stdio + SSE + streamable HTTP). One config plane:
  `~/.vela/mcp.json` (user), `.vela/mcp.json` (project, requires trust), `--mcp-config`. **Do not
  reproduce Anthropic's precedence weirdness** — pick one documented scope hierarchy
  (managed > CLI flag > project-local > project > user, or the inverse for stdio; whichever, document
  it once) and never deviate per-surface. Their desktop-vs-CLI divergence is a documented footgun.
- **Connectors** = a GUI over MCP with a **local OAuth broker**. Vela runs the OAuth dance itself:
  open the system browser, receive the callback on `127.0.0.1:<ephemeral>`, store the refresh token
  in the OS keychain, and refresh it locally. Ship a curated catalog (`connectors/*.json` manifests:
  name, icon, transport, auth type, scopes, server URL or stdio command) so setup is one click, but
  every connector is a plain MCP server the user could add by hand. Where a service only offers a
  hosted remote-MCP endpoint, Vela connects to it directly with the user's own OAuth grant — no
  Anthropic intermediary.
  - Keep tokens **out of the sandbox** by running MCP clients host-side and proxying tool calls in
    (see §9), which reproduces the security property of Anthropic's server-side connector execution
    without a server.
  - Reproduce the org control surface: a `toolPolicy` map per server (`allow`/`ask`/`deny` per tool),
    and honor a `requiresUserInteraction` marker on individual tools that forces a prompt in every
    mode including bypass.
- **Skills**: Markdown-with-frontmatter files (`SKILL.md`) in `~/.vela/skills/`, `.vela/skills/`, and
  plugin-provided directories. Progressive disclosure: the model sees name + description, and loads
  the body on invocation. Support `context: fork` / `background` subagent execution and
  `isolation: worktree`. Path resolution must follow the environment — a remote/SSH session reads the
  **remote** skills directory, matching Anthropic's behavior, which is the correct semantics.
- **Plugins**: a manifest format bundling skills, agents, hooks, MCP servers, and LSP configs, plus a
  marketplace resolver pointing at **git repositories** (not a proprietary registry). `vela plugin
  add <git-url>`, lockfile with commit pins, signature verification optional. Scopes: user, project,
  local. For remote sessions, honor a repo-declared `enabledPlugins` list installed at session start
  (Anthropic's cloud pattern) — the same mechanism works for Vela's remote runner.
- One `Customize` page over all three, backed by the single on-disk config plane described in §1.

---

## 12. Side chats, background tasks, cross-session work

**Sources:** `https://code.claude.com/docs/en/desktop.md`,
`https://code.claude.com/docs/en/cross-session-messaging.md`

### Side chat

`Cmd+;` / `Ctrl+;` or `/btw` in the prompt box. "A side chat lets you ask Claude a question that uses
your session's context but **doesn't add anything back to the main conversation**." The side chat can
read everything in the main thread up to that point. Available in local, SSH, and WSL sessions. **The
desktop app doesn't save side chats to disk**, so you can't return to one after closing the app.

### Tasks pane

Shows background work inside the current session: subagents, background shell commands, and dynamic
workflows. Click an entry to see its output in the subagent pane or stop it.

### Work across sessions (desktop surface)

Claude can list your other Code tab sessions, read what each has been doing, send messages between
them, and rename or archive them. Plain-language addressing: "which session touched the auth
refactor?", "tell the payments session the schema changed".

Scope: **only the sessions the desktop app runs itself** — local, SSH, and WSL Code-tab sessions.
Not cloud sessions, not terminal-CLI sessions, not VS Code sessions, "even in worktrees of the same
project." Claude never lists the session you're asking from. By default it sees the **20 most
recently active** sessions and skips archived ones.

Delivery: a message shows in the receiving session as "a card labeled with the sending session's
title and a link back." If the receiver is mid-task, the message is held and read once the current
work finishes. Archived sessions can't receive.

Three safety behaviors:

1. **Before archiving any session, Claude asks you first — in every permission mode, including Auto
   and Bypass permissions.**
2. Claude can't send cross-session messages from a session nobody is watching (e.g. a scheduled-task
   run), and can't deliver into one.
3. Each incoming message is quoted and attributed to its sender, and the receiving session's own
   permission settings still apply.

**Task chips**: "When it notices something worth fixing that's out of scope for the current task, it
offers the work as a task chip in the chat. Click the chip to start that work in a new session with
its own worktree; Claude continues your current session uninterrupted."

### Cross-session messaging (the CLI-level mechanism, v2.1.224+, macOS and Linux)

- Tools: `ListAgents` (discovery) and `SendMessage` (delivery by name). `/list-agents` (alias
  `/peers`) shows the roster.
- **Transport table — this is the key server-side boundary:**

  | Where the other session runs | How the message travels |
  | --- | --- |
  | On this machine | **Over a per-session Unix socket, never through Anthropic servers** |
  | On another of your machines | **Through Anthropic servers**, arriving over that machine's Remote Control connection |
  | On Claude Code on the web | **Through Anthropic servers**, straight to the cloud session |

- Same-machine mechanics: "Each session registers itself in files on disk and binds its inbox socket
  there." Two sessions can reach each other only when they see the same files, so a container and the
  host cannot. The socket is **restricted to the OS user**. Path is exposed in `/status` as
  `Peer address` (prefixed `uds:`) and to hooks/Bash as `CLAUDE_CODE_MESSAGING_SOCKET`, exported
  before any hook runs including `SessionStart`.
- "A message is a piece of text one Claude writes to another, **never conversation history or
  files**."
- **What an incoming message cannot do**: it never counts as your consent, so it can't answer a
  pending permission prompt; the receiver is instructed never to change permission settings,
  `CLAUDE.md`, or configuration because another session asked; a command in the message text (e.g.
  `/compact`) "arrives as plain text. Claude Code never executes it"; permission prompts still fire
  for anything the message asks for.
- `crossSessionInbound`: `accept` / `hold` / `refuse`. When no value applies, the default is decided
  from the two sessions' permission-mode classes (bypass-class vs prompting-class): a prompting
  receiver delivers unless the sender is bypass-class; a bypass receiver holds unless the sender is
  also bypass. Held messages open an approval dialog with `dialogExpiry` (default 5 min); at most 100
  held messages, oldest dropped.
- `isolatePeerMachines: true` requires explicit approval before any message leaves the machine, **even
  in `bypassPermissions`**. "A `true` from any settings scope applies, so a checked-in project file
  can turn the requirement on but not off."
- Own-child verification: a message from the session's own child process (a hook or Bash command
  posting to its own socket) is delivered when no `crossSessionInbound` applies. On Linux this can be
  verified even after the child exits; on macOS only while the posting process is alive; in
  containers where the agent is PID 1 it can't be verified at all.
- Loop protection: rate-limits repeated messages per sender, drops identical repeats in a short
  window, caps accepted-but-unread at 50 per session.
- Turn off: `crossSessionInbound: "refuse"` plus deny rules on `SendMessage` and `ListAgents`
  (bare tool names, no specifier).

### Vela reimplementation

**Dependency: MIXED.** Same-machine messaging is CLIENT_SIDE_PORTABLE (Unix sockets + on-disk
registry). Cross-machine messaging is ANTHROPIC_SERVER_SIDE in Claude's implementation because it
piggybacks on the Remote Control relay.

**server_side_detail:** Anthropic routes cross-machine and cloud-session messages through their API,
arriving over the target machine's Remote Control connection. Vela cannot use that relay.

- **Same machine**: copy the design exactly. Each session writes a registry entry to
  `$XDG_RUNTIME_DIR/vela/sessions/<id>.json` (fall back to `~/.vela/run/`) and binds
  `.../<id>.sock` with mode `0600`, owner-only. Export `VELA_MESSAGING_SOCKET` to hooks and Bash
  before any hook runs. Implement `ListAgents`/`SendMessage`. Note the container caveat and surface it
  in the UI rather than letting it be a mystery. Windows: use a named pipe with a matching DACL.
- **Cross-machine**: replace the Anthropic relay with **direct, user-owned transport**. Options, in
  order of preference: (1) the SSH channel Vela already has to a remote runner — messages ride the
  existing multiplexed connection; (2) a user-supplied mesh address (Tailscale/WireGuard/Nebula) with
  mTLS between `vela-agentd` instances using a user-generated CA; (3) a self-hosted relay the user
  runs (a ~200-line WebSocket broker) for NAT-traversal cases. Never a Vela-operated service — that
  would recreate exactly the dependency this project exists to remove.
- **Copy every safety property verbatim, they are all cheap and all correct:**
  - a message is plain text only, never history or files;
  - a message is never consent — it cannot satisfy a pending permission prompt;
  - the receiver is instructed never to change permissions/`VELA.md`/config because a peer asked;
  - slash commands in a message body are inert text;
  - the receiver's own permission rules still gate any resulting action;
  - `crossSessionInbound` accept/hold/refuse with the permission-class default;
  - `isolatePeerMachines` as a one-way ratchet (any scope can turn it on, none can turn it off) that
    holds even in bypass mode;
  - loop throttling: per-sender rate limit, identical-repeat dedup in a short window, 50-message
    unread cap, 100-message held cap with oldest-dropped;
  - **ask before archiving another session in every mode, including bypass.**
- **Side chat**: a forked read-only view of the transcript that writes to a separate ephemeral
  transcript and never merges back. Anthropic doesn't persist these; **Vela should**, optionally —
  write to `~/.vela/projects/<p>/sidechats/<id>.jsonl` behind a setting. Losing a good side-chat
  answer on app quit is a real papercut.
- **Tasks pane**: a live view over the agent's background registry — subagents, background
  shell commands, workflows — with per-entry output and a stop button. Model-agnostic.
- **Task chips**: an out-of-scope-finding affordance. Implement as a structured tool
  (`SuggestTask(title, rationale, prompt)`) the model can call; the UI renders a chip that spawns a
  new session in a fresh worktree. Works with any backend that supports tool calls.

---

## 13. Scheduled tasks (local) and routines (cloud)

**Sources:** `https://code.claude.com/docs/en/desktop-scheduled-tasks.md`,
`https://code.claude.com/docs/en/routines.md`

### Comparison table (from the docs)

| | Cloud (routines) | Desktop (local tasks) | `/loop` |
| --- | --- | --- | --- |
| Runs on | Cloud, Anthropic-managed by default | Your machine | Your machine |
| Requires machine on | No | Yes | Yes |
| Requires open session | No | No | Yes |
| Persistent across restarts | Yes | Yes | Restored on `--resume` if unexpired |
| Access to local files | No (fresh clone) | Yes | Yes |
| MCP servers | Connectors configured per task | Config files and connectors | Inherits from session |
| Permission prompts | No (runs autonomously) | Configurable per task | Inherits from session |
| Minimum interval | 1 hour | 1 minute | 1 minute |

### Desktop local scheduled tasks — CLIENT_SIDE_PORTABLE

- Created from the **Routines** page → **New routine** → **Local**. Fields: **Name** (converted to
  lowercase kebab-case and **used as the folder name on disk**, must be unique), **Description**,
  **Instructions** (with pickers for permission mode and model, plus working folder and an
  isolated-worktree toggle), **Schedule**.
- A folder is required; untrusted folders prompt for trust before saving.
- Creatable conversationally: "set up a daily code review that runs every morning at 9am";
  "remind me at 3pm tomorrow to check the deploy" creates a one-time task that disables itself.
- Schedule presets: **Manual** (Run now only), **Hourly**, **Daily** (time picker, default 9:00 AM
  local), **Weekdays**, **Weekly** (time + day). Custom intervals via natural language to Claude.
- Execution: "Desktop checks the schedule every minute while the app is open and starts a fresh
  session when a task is due." **Each task gets a deterministic delay of a few minutes after the
  scheduled time to stagger API traffic — the same task always starts at the same offset.**
- A fired task produces a desktop notification and a session under a **Scheduled** section in the
  sidebar. It can edit files, run commands, commit, and open PRs, **but can't send or receive
  cross-session messages** through the desktop session surface.
- Runs only while the app is running and the computer is awake; sleeping through a scheduled time
  skips the run. **Keep computer awake** setting under Desktop app → General. Closing the lid still
  sleeps.
- **Missed runs**: on app start or wake, Desktop checks the last **seven days**; if a task missed
  runs it starts **exactly one catch-up run for the most recently missed time** and discards older
  ones, with a notification. Docs give the right warning: "A task scheduled for 9am might run at 11pm
  if your computer was asleep all day."
- **Permissions**: per-task permission mode; allow rules from `~/.claude/settings.json` apply. In
  Manual mode a missing permission **stalls the run until you approve**, and the session stays open
  in the sidebar. Recommended flow: **Run now**, watch for prompts, choose "always allow" — future
  runs auto-approve. Reviewable/revocable from the task's **Always allowed** panel. Org-`ask`
  connector tools and `requiresUserInteraction` MCP tools prompt every time and stall every run.
- Management: Run now, Active/Paused toggle, Edit, run history (including skipped runs with reasons:
  computer asleep, previous run still in progress, other scheduled tasks already running), review and
  revoke allowed permissions, Delete (with an **Also delete files on disk** checkbox).
- **On-disk representation**: `~/.claude/scheduled-tasks/<task-name>/SKILL.md` (or under
  `CLAUDE_CONFIG_DIR`), **YAML frontmatter for `name` and `description`, prompt as the body**.
  Changes take effect next run. **Schedule, folder, model, and enabled state are not in this file.**
- A running task can modify its own schedule or prompt via the `update_scheduled_task` MCP tool
  ("rescheduling a code review to run earlier when it detects a release branch has been created").

### Routines (cloud) — ANTHROPIC_SERVER_SIDE

- "Routines execute on Anthropic-managed cloud infrastructure… so they keep working when your laptop
  is closed." Three trigger types: **Scheduled** (min interval 1 hour), **API** (HTTP POST to a
  per-routine `/fire` endpoint with a bearer token), **GitHub** (pull_request and release events with
  filters on author/title/body/base/head/labels/is-draft/is-merged, operators equals/contains/starts
  with/is one of/is not one of/matches regex — regex tests the **entire** field).
- "Routines run autonomously as full Claude Code cloud sessions: there is no permission-mode picker
  and no approval prompts during a run."
- Each repo is cloned per run from the default branch; Claude pushes to `claude/`-prefixed branches,
  which "are always accepted". Pushes elsewhere are rejected if the branch is protected, someone else
  has an open PR from it, or it carries commits authored by someone else.
- **Fire payload security model, worth copying:** `text` supplied to `/fire` or **Run now** "doesn't
  reach the routine as a bare message. It arrives wrapped in a `<routine-fire-payload>` block that
  labels it as untrusted data and tells Claude not to follow instructions inside it unless the
  routine's own prompt says to." Meanwhile the routine's **saved prompt** is treated as an assigned
  task, "not live user input and can't act as approval or consent for actions during the run."
- Environments control network access, env vars, and setup scripts; the **Default** environment has
  **Trusted** network access (a default allowlist of package registries, cloud APIs, container
  registries, dev domains). Blocked hosts fail with `403` and `x-deny-reason: host_not_allowed`.
  **Connector traffic is routed through Anthropic's servers rather than that path**, so connectors
  work without allowlist changes.
- Daily per-account run cap on top of subscription limits; one-off runs don't count against it.

### Vela reimplementation

**Dependency: local tasks CLIENT_SIDE_PORTABLE; routines ANTHROPIC_SERVER_SIDE.**

**server_side_detail:** routines run on Anthropic-managed VMs with an Anthropic-hosted scheduler, an
Anthropic-hosted `/fire` HTTP endpoint with Anthropic-issued bearer tokens, Anthropic's GitHub App
receiving webhooks, and server-side connector execution.

**Local substitutes:**

- **Local scheduled tasks**: a scheduler inside the Vela app process, ticking every minute, plus —
  and this is where Vela should beat Claude Desktop — an **optional OS-level scheduler registration**
  so tasks fire even when the GUI is closed: `launchd` `LaunchAgent` plist on macOS, a systemd user
  timer on Linux, Task Scheduler on Windows, each invoking `vela run-task <name>` headlessly. That
  removes the single biggest limitation Anthropic documents ("only fires while the app is open and
  your computer is awake").
- On-disk format: keep `~/.vela/scheduled-tasks/<kebab-name>/TASK.md` with YAML frontmatter, but put
  **all** of it in frontmatter (schedule, folder, model, permission mode, worktree flag, enabled) —
  Anthropic's split, where the prompt is a file but the schedule isn't, makes tasks non-portable and
  non-version-controllable. A single file the user can commit is strictly better.
- Copy the **deterministic stagger** (hash the task name → a stable 0–5 minute offset). With local
  models the reason is different but just as real: it prevents three tasks from contending for the
  same GPU at 9:00:00.
- Copy the **missed-run policy**: look back 7 days, run exactly one catch-up for the most recent
  missed slot, notify. Also copy the prompt-writing guidance into the UI as a hint under the
  instructions box.
- Copy the **run history with skip reasons** (asleep, previous run in progress, other tasks running,
  and add: model backend unavailable, GPU busy) — this is what makes scheduled agents debuggable.
- Copy the **per-task "always allowed" store** with a review/revoke panel, and the Manual-mode stall
  behavior with a resumable session in the sidebar.
- Expose an `update_scheduled_task` equivalent as a built-in tool so tasks can reschedule themselves.
- **Routine equivalents without Anthropic:**
  - *Scheduled* → the local scheduler above, or the same on a user-owned remote runner (§9), which
    gives the "laptop closed" property.
  - *API trigger* → `vela-agentd` exposes a local HTTP endpoint bound to `127.0.0.1` (or the mesh
    address), with per-task bearer tokens generated and stored in the OS keychain, shown once. Same
    `/fire` shape, same JSON response with session id + URL. **Copy the `<routine-fire-payload>`
    wrapping verbatim** — labelling caller-supplied text as untrusted data that must not be followed
    as instructions is the single most important detail in this section, and it applies identically
    to a local endpoint since anyone holding the token can post text.
  - *GitHub trigger* → two options: (a) a repo-side GitHub Action/webhook that POSTs to the user's
    own endpoint (works if the runner is reachable), or (b) **polling** from `vela-agentd` via
    `gh`/`glab`/generic REST with an ETag-aware poller — no inbound reachability required, works
    behind NAT, and works for GitLab/Gitea/Forgejo which Anthropic doesn't support at all.
  - *Autonomous no-prompt runs* → allowed, but require the run to be in a sandbox tier (container or
    microVM) and to have a policy file; refuse fully-unattended bypass on the host filesystem.
  - *Network allowlist* → the local egress proxy from §10 with a shipped default allowlist of package
    registries and dev domains, returning `403` with a `x-deny-reason` header so the agent gets a
    legible error.
  - *Branch-push guardrails* → reimplement verbatim: allow `vela/`-prefixed branches freely; reject
    pushes to protected branches, branches with someone else's open PR, or branches carrying commits
    authored by someone else.

---

## 14. Computer use (screen control)

**Sources:** `https://code.claude.com/docs/en/desktop.md` §Let Claude use your computer,
`https://code.claude.com/docs/en/computer-use.md`,
`https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork`

- Research preview on **macOS and Windows** in Desktop (**macOS only** from the CLI, where it's a
  built-in MCP server named `computer-use` enabled via `/mcp`). Requires Pro or Max; **not available
  on Team or Enterprise**. The Desktop app must be running. Off by default.
- macOS requires two system permissions: **Accessibility** (click, type, scroll) and **Screen
  Recording** (see the screen). Windows: the toggle takes effect immediately.
- **Tool-selection precedence** — Claude tries the most precise tool first: connector → Bash → Claude
  in Chrome → iOS Simulator pane → computer use. "Screen control is reserved for things nothing else
  can reach, like native apps, hardware control panels, or proprietary tools without an API."
- **Per-app approval**, prompted the first time Claude needs an app in a session: **Allow for this
  session** / **Deny**. Approvals last the session, or **30 minutes in Dispatch-spawned sessions**.
- **Fixed access tiers by app category, not user-configurable:**

  | Tier | What Claude can do | Applies to |
  | --- | --- | --- |
  | View only | See the app in screenshots | Browsers, trading platforms |
  | Click only | Click and scroll, but not type or use keyboard shortcuts | Terminals, IDEs |
  | Full control | Click, type, drag, and use keyboard shortcuts | Everything else |

  Sentinel warnings on broad-reach apps: "Equivalent to shell access" (terminals/IDEs), "Can read or
  write any file" (Finder), "Can change system settings" (System Settings).
- Settings: **Denied apps** (rejected without prompting; "Claude may still affect a denied app
  indirectly through actions in an allowed app, but it can't interact with the denied app directly")
  and **Unhide apps when Claude finishes**.
- **Window hiding**: while Claude works, other visible apps are hidden so it interacts only with
  approved apps; hidden windows are restored when it finishes. "Your terminal window stays visible
  and is excluded from screenshots, so you can watch the session and Claude never sees its own
  output."
- **Screenshots downscaled automatically** before being sent to the model — a 16" MacBook Pro at
  native Retina captures 3456×2234 and downscales to ~1372×887, preserving aspect ratio. No setting
  to change the target size.
- **Machine-wide lock**: only one session at a time can use the computer. The lock is taken on the
  first computer-use action and **released when that session exits, not when the task finishes**.
- **Global escape**: `Esc` anywhere aborts, and "the key press is consumed so prompt injection can't
  use it to dismiss dialogs." A macOS notification announces "Claude is using your computer · press
  Esc to stop" and a second when done.
- Trust boundary, stated plainly: "Unlike the sandboxed Bash tool, computer use runs on your actual
  desktop with access to whatever you approve. Claude checks each action and flags potential prompt
  injection from on-screen content, but the trust boundary is different." And from the Cowork
  article: "there's no sandbox between Claude and what's on your screen"; a default blocklist covers
  sensitive apps like investment platforms and cryptocurrency exchanges; "these safeguards aren't
  perfect."
- Not available in the Linux desktop app.

### Vela reimplementation

**Dependency: CLIENT_SIDE_PORTABLE.** Everything here is OS API work; the only model requirement is
either vision or an accessibility-tree path.

- **Capture**: macOS `ScreenCaptureKit` (fall back to `CGWindowListCreateImage`); Windows
  `Windows.Graphics.Capture` / DXGI Desktop Duplication; Linux **XDG portals** —
  `org.freedesktop.portal.ScreenCast` for capture and `org.freedesktop.portal.RemoteDesktop` for
  synthetic input, which makes Vela work on Wayland where Claude Desktop simply doesn't ship the
  feature.
- **Input**: macOS `CGEvent`; Windows `SendInput`; Linux via the RemoteDesktop portal or `uinput`.
- **Accessibility tree as the primary modality.** This is the biggest divergence Vela should make.
  Anthropic sends downscaled screenshots because their models are vision-strong. Vela must work with
  text-only local models, so the primary representation should be a **structured UI tree**: macOS
  `AXUIElement`, Windows UI Automation, Linux AT-SPI2. Emit a numbered, clickable element list
  (`[12] button "Save" at (410,880)`) and let the model act by index. Screenshots become an optional
  augmentation for vision-capable backends. This is faster, cheaper, more reliable, and far more
  accessible to small models than pixel-coordinate clicking.
- Keep screenshot downscaling for the vision path, with the same aspect-preserving behavior — but
  make the target size configurable, since local VLM context budgets vary wildly (Anthropic's "no
  setting" is a limitation, not a feature).
- **Copy the entire safety envelope verbatim; it is well-designed and costs nothing:**
  - per-app approval per session, with a Dispatch-equivalent 30-minute expiry for
    unattended/delegated sessions;
  - the three fixed tiers (view-only for browsers and financial apps, click-only for terminals and
    IDEs, full control otherwise) as a shipped, extensible category map. The reasoning is sound:
    capping terminals at click-only steers the model back to the Bash tool, and capping browsers at
    view-only steers it to the Browser pane's CDP tools;
  - sentinel warnings for shell-equivalent / filesystem-wide / system-settings apps;
  - a user **denied-apps** list plus a shipped default blocklist (banking, brokerage, crypto,
    password managers, `Keychain Access`, `System Settings`);
  - hide other windows while working, restore after, with a toggle;
  - **exclude Vela's own window from screenshots** — otherwise the agent reads its own transcript and
    on-screen text becomes a prompt-injection channel back into itself. Non-obvious and essential;
  - a machine-wide lock file (`~/.vela/run/computer-use.lock` with the holding PID), released on
    session exit and reclaimed when the PID is dead;
  - a global `Esc` abort whose keypress is **consumed**, not forwarded — so injected content can't use
    it to dismiss a dialog;
  - OS notifications on acquire and release;
  - route every computer-use action through the local judge (§3) with the on-screen text marked
    untrusted.
- Tool precedence must be enforced in the system prompt *and* structurally: don't even expose the
  computer-use tools when an MCP connector, a Bash path, or the browser pane can do the job. Small
  local models will reach for the screen if you let them.

---

## 15. Dispatch (mobile → desktop task delegation)

**Source:** `https://code.claude.com/docs/en/desktop.md` §Sessions from Dispatch

- "Dispatch is a persistent conversation with Claude that lives in the Cowork tab. You message
  Dispatch a task, and it decides how to handle it."
- A task becomes a Code session either because you asked ("open a Claude Code session and fix the
  login bug") or because **Dispatch decided the task is development work and spawned one on its own**.
  Routes to Code: fixing bugs, updating dependencies, running tests, opening PRs. Stays in Cowork:
  research, document editing, spreadsheet work.
- The session appears in the Code sidebar with a **Dispatch** badge; a push notification arrives when
  it finishes or needs approval.
- Dispatch-spawned sessions can use computer use, but **app approvals expire after 30 minutes and
  re-prompt** rather than lasting the full session.
- Requires Pro or Max; not available on Team or Enterprise.

### Vela reimplementation

**Dependency: MIXED — the router is portable; the mobile push transport is server-mediated in
Anthropic's implementation.**

**server_side_detail:** Dispatch's phone↔desktop pairing and push notifications go through
Anthropic's account infrastructure and APNs/FCM via Anthropic's push service.

**Local substitute:**

- The **router** is just an agent with a classification prompt plus tools
  `spawn_code_session(folder, prompt)` and `handle_in_cowork(prompt)`. Fully local, works with any
  backend. Ship the same routing heuristic (dev work → Code surface; research/documents/spreadsheets
  → Cowork surface) as an editable policy.
- The **transport** from a phone: three no-Anthropic options, in preference order:
  1. **Self-hosted push**: `vela-agentd` exposes an authenticated endpoint on the user's mesh
     (Tailscale/WireGuard) and a small PWA on the phone talks to it directly. Notifications via
     **ntfy.sh** (self-hostable), **Gotify** (self-hosted), or Web Push with the user's own VAPID keys.
  2. **Chat bridge**: a Telegram/Matrix/Signal bot the user owns, forwarding messages into a Vela
     session — this is exactly Anthropic's "channels" pattern and needs no mobile app at all.
  3. **Email/IMAP poll** as a lowest-common-denominator fallback.
- Copy the **badge** (mark sessions spawned by the router) and the **30-minute computer-use approval
  expiry for delegated/unattended sessions** — a session nobody is watching should have shorter
  approval lifetimes than one you're sitting in front of. Generalize it: any session with no attached
  UI gets short-lived approvals.

---

## 16. Remote Control (drive a local session from a phone/browser)

**Source:** `https://code.claude.com/docs/en/remote-control.md`

- Connects claude.ai/code or the Claude mobile app to a session running on your machine. "Claude
  keeps running locally the entire time, so your code execution and filesystem access stay on your
  machine." The web/mobile UI "is a window into that local session."
- Start: `claude remote-control` (server mode, stays running, shows a session URL, spacebar toggles a
  QR code), `claude --remote-control` / `--rc` (interactive session with RC enabled), `/remote-control`
  from inside a session (carries over conversation history), or `/remote-control` in the VS Code
  extension. Desktop equivalent toggle: **Settings > Claude Code > Enable remote control by default**.
- Server-mode flags: `--name`, `--remote-control-session-name-prefix` (defaults to hostname, giving
  names like `myhost-graceful-unicorn`), `-c`/`--continue`, `--session-id`, `--spawn`
  (`same-dir` | `worktree` | `session`), `--capacity <N>` (default **32**),
  `--[no-]create-session-in-dir`, `--verbose`, `--sandbox`/`--no-sandbox`.
- **Transport (the key detail):** "Your local Claude Code session makes **outbound HTTPS requests
  only and never opens inbound ports** on your machine. When you start Remote Control, it registers
  with the Anthropic API and polls for work. When you connect from another device, the server routes
  messages between the web or mobile client and your local session over a streaming connection."
  Multiple short-lived credentials, each scoped to a single purpose.
- **"While Remote Control is connected, the session transcript, including your messages, Claude's
  responses, and tool activity, is stored on Anthropic servers."** That's what keeps devices in sync
  and enables reconnect after a drop.
- Capabilities: `@` autocompletes local file paths; subagent and workflow progress stays in sync
  across devices; photos attach directly, other files are downloaded to your machine and passed as
  `@` references; automatic reconnect after sleep/network loss, with queued status updates delivered
  on recovery.
- **Auto-connect setting precedence**, worth copying: `remoteControlAtStartup` — a `false` in project
  or local settings turns auto-connect off **even over a managed `true`**, but a `true` in project or
  local settings is **ignored**, "so a checked-in file can't turn on Remote Control for everyone who
  opens the repository."
- Limitations: one remote session per interactive process (server mode for more); the local process
  must keep running (use tmux/screen over SSH); **~10 minutes of network unreachability ends the
  session**; forwarded dialogs expire after `dialogExpiry` (default 5 min) and continue with the
  dialog's no-action default — except permission prompts and `AskUserQuestion`, which stay open.
- **Mobile push**: Claude decides when to push (typically when a long task finishes or a decision is
  needed); you can request one in the prompt ("notify me when the tests finish"). Two toggles: **Push
  when Claude decides** and **Push when actions required**. Pushes are skipped while you're typing in
  or focused on the connected terminal; `CLAUDE_CLIENT_PRESENCE_FILE` extends that to a marker file
  so a screen-lock listener can suppress notifications whenever you're at the machine.
- **Trusted Devices** (Team/Enterprise beta): requires an enrolled device credential plus a sign-in
  no more than **18 hours** old, refreshed with Face ID / Touch ID / Windows Hello / passkey.
  "Biometric checks run on the device through the operating system or browser… Anthropic never
  receives or stores fingerprints, face data, or any other biometric information. Only the device's
  public key and basic metadata."
- `disableRemoteControl` setting turns it off entirely. ZDR orgs can't enable it.

### Vela reimplementation

**Dependency: ANTHROPIC_SERVER_SIDE as implemented — MIXED in principle.**

**server_side_detail:** the local session registers with the Anthropic API and long-polls; Anthropic's
servers relay messages between phone/browser and the local process, and **store the full transcript
server-side while connected**.

**Local substitute** — and this is a case where Vela is strictly better on privacy:

- Ship a **local HTTP/WebSocket server inside `vela-agentd`**, bound to `127.0.0.1` plus optionally a
  mesh interface, serving a responsive **PWA** that renders the session (transcript, diffs, permission
  prompts, `@` file autocomplete via a remote index endpoint, attachment upload). No transcript ever
  leaves the user's machines.
- **Reachability** without inbound ports, in preference order:
  1. **Tailscale / WireGuard / Nebula** — the phone is on the same overlay; direct connection, no
     relay, no port forwarding. This should be the documented happy path.
  2. **SSH reverse tunnel** to a box the user owns.
  3. **A self-hosted relay** (~200 lines of WebSocket broker on a $5 VPS) for users behind CGNAT who
     don't want a mesh, using the same outbound-only, long-poll design Anthropic uses.
  Never a Vela-operated relay.
- **Auth**: device pairing via QR containing a one-time code + the endpoint; on pair, the device gets
  an mTLS client cert or a scoped bearer token stored in the phone's keystore. Copy **Trusted
  Devices** wholesale using **WebAuthn/passkeys** — platform authenticator, public key + metadata
  stored locally, biometrics never leaving the device, and a configurable step-up interval (Anthropic
  uses 18 hours). This is a pure standards implementation with no server dependency.
- Copy the operational details that matter: QR display, hostname-prefixed generated session names,
  `--spawn same-dir|worktree|session`, a concurrency cap, auto-reconnect with queued status updates,
  the ~10-minute unreachable timeout, and `dialogExpiry` semantics where permission prompts and
  questions never auto-expire but other dialogs continue with their no-action default.
- Copy the **`remoteControlAtStartup` asymmetric precedence** exactly (project settings may disable,
  never enable). It's a small rule that prevents a real supply-chain attack.
- **Push notifications** without Anthropic: **ntfy** (self-hosted or public), **Gotify**, or Web Push
  with user-generated VAPID keys straight from `vela-agentd`. Ship the same two toggles (push when
  the agent decides / push when action is required) and the presence-file suppression
  (`VELA_CLIENT_PRESENCE_FILE`), which is a genuinely thoughtful detail.
- Expose a `disableRemoteControl` managed setting.

---

## 17. Enterprise/managed configuration, network, and deployment

**Source:** `https://code.claude.com/docs/en/desktop.md` §Enterprise configuration

**Admin console** (claude.ai/admin-settings/claude-code): Code in the desktop; Code in the web;
Remote Control; Disable Bypass permissions mode.

**Managed settings keys** (override project and user settings):

| Key | Effect |
| --- | --- |
| `permissions.disableBypassPermissionsMode` | `"disable"` prevents enabling Bypass permissions |
| `disableAutoMode` | `"disable"` removes Auto from the mode selector (also accepted under `permissions`) |
| `autoMode` | Customize what the classifier trusts and blocks org-wide |
| `browserExternalPageTools` | `"disabled"` removes Claude's tools on external pages |
| `disableMobileSimulatorTools` | `true` blocks Claude's iOS simulator tools |
| `disableBrowserExternalNavigation` | `true` blocks external browsing entirely (must be JSON boolean `true`; the string `"true"` is ignored) |
| `sshConfigs` | Pre-configure SSH connections, uneditable by users |
| `sshHostAllowlist` | Restrict SSH targets by resolved hostname pattern; empty array disables SSH. Managed-settings only |
| `managedMcpServers` | Push MCP server configs (transport `http`/`sse`/`stdio`, plus an optional per-tool `toolPolicy`). Third-party deployments only, delivered via managed settings file or MDM |

**Where managed settings reach**: local sessions get the on-disk managed file (plus remotely pushed
admin-console settings when authenticating with an org login or configured API key); **cloud sessions
get server-managed settings** and device-deployed files do *not* reach them; **SSH sessions read the
managed settings file from the remote host** (Desktop reads `sshConfigs`/`sshHostAllowlist` from the
local machine).

**Device management**: macOS via the `com.anthropic.claudefordesktop` preference domain (Jamf,
Kandji); Windows via registry at `SOFTWARE\Policies\Claude`. Policies include enabling/disabling the
Claude Code feature, controlling auto-updates, and a custom deployment URL.

**Network hosts** the app requires: `anthropic.com`, `*.anthropic.com`, `claude.ai`, `*.claude.ai`,
`claude.com`, `*.claude.com`, `claude.app`, `*.claude.app`, `*.claudeusercontent.com`,
`*.claudemcpcontent.com`. HTTPS/443 unless a custom port is configured for OTLP, an LLM gateway, or
an MCP server.

**Deployment**: macOS `.dmg` via MDM; Windows MSIX with silent installation.

**Data handling**: "Claude Code processes your code locally in local sessions, or in cloud sessions on
Anthropic-managed infrastructure… Cloud sessions send conversations and code context to Anthropic's
API for processing; local and SSH sessions send them to whichever model provider your deployment
configures, Anthropic's API by default."

**Third-party providers**: "Desktop connects to Anthropic's API by default." Amazon Bedrock, Google
Cloud's Agent Platform, Microsoft Foundry, or a self-hosted LLM gateway require the separate
"Claude Desktop on 3P" configuration; the CLI supports them natively.

### Vela reimplementation

**Dependency: CLIENT_SIDE_PORTABLE** (the settings mechanism), with the admin console being
ANTHROPIC_SERVER_SIDE.

- **Settings precedence**: managed > CLI `--settings` > project-local > project > user. Managed
  settings live at a system path an admin can deploy: `/Library/Application Support/Vela/managed-settings.json`
  (macOS), `/etc/vela/managed-settings.json` (Linux), `%ProgramData%\Vela\managed-settings.json`
  (Windows), plus MDM/registry equivalents (`com.vela.desktop` preference domain,
  `HKLM\SOFTWARE\Policies\Vela`).
- Implement equivalents for every managed key above, renamed to Vela's surfaces, plus the ones Vela
  needs that Anthropic doesn't: **`allowedModelProviders`** and **`allowedModelEndpoints`** (an org
  may want to force all inference to an internal vLLM cluster and forbid third-party API keys), and
  **`requireSandboxTier`**.
- Keep the managed-only restrictions: `sshHostAllowlist`, `strictAllowlist`, and the judge/policy
  config must be **unreadable from project settings**. Keep `allowManagedPermissionRulesOnly` /
  `allowManagedHooksOnly` equivalents.
- Replace the admin console with a **config-as-code** distribution model: managed settings are a JSON
  file an admin ships via MDM/Ansible/Intune, optionally **signed** (Ed25519) with the public key
  pinned at install so a tampered file is rejected. This is better than a hosted console for the
  audiences Vela targets and needs no server.
- **Network requirements collapse to whatever the user's chosen model backend needs.** In the fully
  local case (llama.cpp/Ollama/vLLM on `localhost`) Vela requires **zero outbound network access** —
  which should be stated prominently in the enterprise docs, since it's the single strongest argument
  against every hosted alternative in this document. Document the optional egress list per configured
  provider instead of a fixed vendor list.
- **Telemetry**: OTLP export like Anthropic's `monitoring-usage`, but **off by default** and pointed
  at the org's own collector. Compliance-API equivalent = a local audit log (JSONL: every tool call,
  permission decision, judge verdict, file write, network host) that an org can ship to SIEM.
  Note Anthropic's own caveat that host-based EDR can't see inside VM-isolated activity — Vela's
  audit log solves that by logging from the supervisor, outside the sandbox.
- **Auto-update policy** control, and a fully offline install path (no telemetry ping, no license
  check, no phone-home).

---

## 18. Keyboard shortcuts (Code tab)

**Source:** `https://code.claude.com/docs/en/desktop.md` §Keyboard shortcuts

`Cmd+/` show shortcuts · `Cmd+N` new session · `Cmd+W` close session ·
`Ctrl+Tab` / `Ctrl+Shift+Tab` next/previous session · `Cmd+Shift+]` / `Cmd+Shift+[` next/previous
session · `Esc` stop Claude's response · `Cmd+Shift+D` toggle diff pane · `Cmd+Shift+B` toggle
Browser pane · `Cmd+Shift+S` select an element in the Browser · ``Ctrl+` `` toggle terminal pane ·
`Cmd+\` close focused pane · `Cmd+;` open side chat · `Ctrl+O` cycle view modes · `Cmd+Shift+M`
permission mode menu · `Cmd+Shift+I` model menu · `Cmd+Shift+E` effort menu · `1`–`9` select an item
in an open menu.

Windows uses `Ctrl` in place of `Cmd`. Session cycling, terminal toggle, and view-mode toggle use
`Ctrl` on every platform. "These shortcuts apply only to the Code tab. The terminal-based interactive
mode shortcuts, such as `Shift+Tab` to cycle modes, do not apply in Desktop."

**Vela**: adopt this map verbatim — it's a good map and matching muscle memory lowers switching cost.
Make it fully rebindable via a `keybindings.json` (Anthropic's Desktop shortcuts are fixed; the CLI
has a keybindings file). `Cmd+Shift+E` "effort menu" maps to Vela's per-request generation controls
(temperature/top-p/reasoning budget/`num_predict`) exposed per backend.

---

## 19. What Desktop deliberately does *not* do (and what Vela should)

**Source:** `https://code.claude.com/docs/en/desktop.md` §What's not available in Desktop

- **Third-party providers**: Desktop connects to Anthropic's API by default; Bedrock/Agent
  Platform/Foundry/self-hosted gateway need a separate "Claude Desktop on 3P" build.
  **This is the single biggest gap and the reason Vela exists.** Vela's provider layer is the product.
- **Scripting and automation**: `--print` / `--output-format` / Agent SDK are CLI-only.
  "Desktop is interactive only." → **Vela should ship a first-class headless mode from the same
  binary**: `vela -p "prompt" --output-format json|stream-json`, plus an embeddable agent library.
  There's no reason a desktop app can't also be a CLI.
- **Inline code suggestions**: no autocomplete-style suggestions. → optional for Vela; if added, it
  should use a separate small FIM-capable local model (`qwen2.5-coder`-class), not the chat model.
- **Agent teams**: coordinated multi-session teams are CLI-only; Desktop gets dynamic workflows and
  cross-session messaging instead. → Vela can ship teams in the GUI; the tasks pane and session
  sidebar are the natural UI for it.
- **Terminal-dialog commands**: `/permissions` replies "isn't available in this environment";
  `/config` opens Settings and ignores arguments. → Vela should build real GUI panels for permissions
  and config rather than degrading these commands.
- `--allowedTools` / `--disallowedTools` have no per-session Desktop equivalent. → Vela should expose
  a per-session tool toggle panel.
- **Linux**: no computer use, no dictation, Wayland global-hotkey gap. → §9/§14 cover the portal-based
  fixes.

---

## 20. Consolidated dependency ledger

| Feature | Dependency | Substitute summary |
| --- | --- | --- |
| Three-tab shell, panes, layout | CLIENT_SIDE_PORTABLE | Straight reimplementation |
| Permission modes + rule engine + protected paths | CLIENT_SIDE_PORTABLE | Deterministic policy engine |
| Auto-mode classifier | ANTHROPIC_SERVER_SIDE | Local small-model judge with grammar-constrained verdicts + declarative policy; tool results stripped from judge input |
| Tool-result injection probe | ANTHROPIC_SERVER_SIDE | Local classifier/heuristic tagging results as untrusted |
| Sessions, transcripts, branching, resume | CLIENT_SIDE_PORTABLE | JSONL + SQLite index, canonical message format |
| Session titles / summaries | CLIENT_SIDE_PORTABLE | Any configured small model |
| Worktree isolation + 4 enforcement checks | CLIENT_SIDE_PORTABLE | git worktree + tree-sitter-bash static checks |
| Checkpointing / rewind | CLIENT_SIDE_PORTABLE | Shadow git repo (also fixes the bash-changes gap) |
| Diff view, line comments, code review | CLIENT_SIDE_PORTABLE | git diff + a built-in review skill |
| PR monitoring / auto-fix / auto-merge (Desktop) | CLIENT_SIDE_PORTABLE | `gh`/`glab`/REST polling |
| Browser pane + app preview + autoVerify | CLIENT_SIDE_PORTABLE | Embedded Chromium + CDP; a11y snapshot first |
| `launch.json` preview servers | CLIENT_SIDE_PORTABLE | Same schema, `.vela/launch.json` |
| Integrated terminal | CLIENT_SIDE_PORTABLE | xterm.js + PTY (extend to SSH/WSL) |
| File editor pane | CLIENT_SIDE_PORTABLE | CodeMirror/Monaco + mtime conflict detection |
| iOS Simulator pane | CLIENT_SIDE_PORTABLE | `simctl` + `xcodebuild`; add Android via `adb` |
| Computer use | CLIENT_SIDE_PORTABLE | OS capture/input APIs + XDG portals; a11y tree primary |
| Bash sandbox (Seatbelt/bubblewrap + proxy) | CLIENT_SIDE_PORTABLE | Same primitives; add a Windows story |
| Local scheduled tasks | CLIENT_SIDE_PORTABLE | In-app scheduler + OS timer registration |
| Routines (cloud scheduler, `/fire` API, GitHub webhooks) | ANTHROPIC_SERVER_SIDE | Local/remote-runner scheduler, local `/fire` endpoint with keychain tokens, webhook-or-poll GitHub/GitLab triggers |
| Cloud sessions (hosted VMs) | ANTHROPIC_SERVER_SIDE | User-owned remote runner (`vela-agentd`) over SSH/mesh |
| Cowork sandbox VM | MIXED | On-device: same hypervisor approach (Virtualization.framework / Hyper-V / krun); cloud tier replaced by remote runner |
| Cowork server-side file creation | ANTHROPIC_SERVER_SIDE | Local sandbox image with python-docx / openpyxl / python-pptx / reportlab / pandoc / libreoffice |
| Hosted connectors (server-side OAuth + execution) | ANTHROPIC_SERVER_SIDE | Local OAuth broker, keychain token storage, host-side MCP execution proxied into the sandbox |
| MCP protocol itself | CLIENT_SIDE_PORTABLE | Full MCP client |
| Skills / plugins / marketplaces | MIXED | Local dirs + git-repo marketplaces instead of a hosted registry |
| Same-machine cross-session messaging | CLIENT_SIDE_PORTABLE | Unix socket + on-disk registry, owner-only perms |
| Cross-machine / cloud messaging | ANTHROPIC_SERVER_SIDE | SSH channel, user mesh, or self-hosted relay |
| Remote Control (phone/browser steering) | ANTHROPIC_SERVER_SIDE | Local PWA over mesh/tunnel; WebAuthn Trusted Devices; ntfy/Gotify/Web Push |
| Dispatch | MIXED | Local router agent + chat bridge or PWA |
| Managed settings / MDM | CLIENT_SIDE_PORTABLE | Signed managed JSON via MDM |
| Admin console | ANTHROPIC_SERVER_SIDE | Config-as-code + local audit log to SIEM |
| Compliance API / OTLP monitoring | MIXED | OTLP to the org's own collector, off by default; local audit log |

---

## Sources fetched

All of the following were fetched with WebFetch during this session and are the sole basis for the
notes above:

1. `https://code.claude.com/docs/en/desktop.md`
2. `https://code.claude.com/docs/en/desktop-quickstart.md`
3. `https://code.claude.com/docs/en/sessions.md`
4. `https://code.claude.com/docs/en/permission-modes.md`
5. `https://code.claude.com/docs/en/worktrees.md`
6. `https://code.claude.com/docs/en/sandboxing.md`
7. `https://code.claude.com/docs/en/checkpointing.md`
8. `https://code.claude.com/docs/en/desktop-scheduled-tasks.md`
9. `https://code.claude.com/docs/en/desktop-ios-simulator.md`
10. `https://code.claude.com/docs/en/desktop-wsl.md`
11. `https://code.claude.com/docs/en/desktop-linux.md`
12. `https://code.claude.com/docs/en/claude-code-on-the-web.md`
13. `https://code.claude.com/docs/en/cross-session-messaging.md`
14. `https://code.claude.com/docs/en/remote-control.md`
15. `https://code.claude.com/docs/en/routines.md`
16. `https://code.claude.com/docs/en/computer-use.md`
17. `https://claude.com/docs/cowork/overview`
18. `https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview`
19. `https://support.claude.com/en/articles/13364135-use-claude-cowork-safely`
20. `https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork`
21. `https://claude.com/resources/tutorials/navigating-the-claude-desktop-app`

## Sources unreachable

- **SOURCE UNREACHABLE: `https://claude.com/docs/cowork/sandboxing` — HTTP 404 Not Found.** No such
  page exists at that path. Cowork sandbox mechanics in §9 come instead from the Cowork architecture
  and safety support articles (#18, #19), which were fetched successfully. Anything Cowork-specific
  not covered by those two articles is *not* recorded here rather than guessed.

## Notes on gaps not covered by this ingestion pass

These are referenced by the pages above but were not fetched in this pass, so they are named here
rather than described: `/docs/en/hooks`, `/docs/en/skills`, `/docs/en/plugins`,
`/docs/en/plugin-marketplaces`, `/docs/en/mcp`, `/docs/en/settings`, `/docs/en/env-vars`,
`/docs/en/sub-agents`, `/docs/en/agent-teams`, `/docs/en/agent-view`, `/docs/en/workflows`,
`/docs/en/cloud-environments`, `/docs/en/self-hosted-environments`, `/docs/en/auto-mode-config`,
`/docs/en/channels`, `/docs/en/chrome`, `/docs/en/context-window`, `/docs/en/model-config`.
Several are core to other spec parts; `auto-mode-config` and `hooks` in particular deserve their own
pass, since the local-judge design in §3 and the `WorktreeCreate`/`PreToolUse` extension points in
§5/§3 depend on their exact schemas.
