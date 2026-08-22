# Vela Spec Part — Cowork, Scheduled Tasks, Dispatch, Background Runs

Area owner: documentation ingestion (Cowork / agentic knowledge work / scheduling / background execution).
Ingestion date: 2026-08-12.

**Ground rule compliance.** Everything below marked as fact was fetched live from the URLs listed in
"Sources fetched". Nothing here is reconstructed from model memory. Two pages returned HTTP 503 on the
first attempt and succeeded on retry; one page (`support.claude.com/en/collections/19667525-claude-cowork`,
the collection index) never returned and is recorded under "Sources unreachable". Where a fetched page
was silent on a question I care about, I say "not documented" rather than filling the gap.

---

## Sources fetched

Support (support.claude.com):

- https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork
- https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview
- https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-cowork
- https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork  (Dispatch)
- https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork
- https://support.claude.com/en/articles/13364135-use-claude-cowork-safely
- https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile
- https://support.claude.com/en/articles/14116274-organize-your-tasks-with-projects-in-claude-cowork
- https://support.claude.com/en/articles/13837440-use-plugins-in-cowork
- https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork
- https://support.claude.com/en/articles/14477985-monitor-claude-cowork-activity-with-opentelemetry

Claude Code docs (code.claude.com):

- https://code.claude.com/docs/en/agent-view
- https://code.claude.com/docs/en/claude-code-on-the-web
- https://code.claude.com/docs/en/cloud-environments
- https://code.claude.com/docs/en/routines
- https://code.claude.com/docs/en/desktop-scheduled-tasks
- https://code.claude.com/docs/en/scheduled-tasks   (`/loop`, CronCreate/CronList/CronDelete)
- https://code.claude.com/docs/en/remote-control
- https://code.claude.com/docs/en/channels
- https://code.claude.com/docs/en/desktop          (Dispatch → Code routing)
- https://code.claude.com/docs/en/skills           (§ Skills in Cowork and cloud sessions)

Platform / product:

- https://platform.claude.com/docs/en/api/claude-code/routines-fire
- https://claude.com/product/cowork   (redirected from https://www.anthropic.com/product/claude-cowork, 308)
- https://claude.com/blog/cowork-research-preview

## Sources unreachable

- SOURCE UNREACHABLE: https://support.claude.com/en/collections/19667525-claude-cowork — HTTP 503
  Service Unavailable on repeated attempts. The article list was recovered instead from the
  "Related Articles" block of the Get-started article, and each article fetched individually.

---

## 1. The single most important architectural fact

Anthropic ships **three distinct execution substrates** for agentic work, and they are not
interchangeable. Vela must reimplement all three, because features are split across them:

| Substrate | Where compute runs | Local files? | Machine must be on? |
|---|---|---|---|
| **Cloud session** | Anthropic-managed, ephemeral sandbox VM (Ubuntu 24.04 x86_64), created at session start, destroyed at session end, no cross-session or cross-org state sharing | Only via a **desktop bridge** back to the user's machine | No |
| **Local session (Desktop)** | Agent loop runs natively on the device; *code execution* runs in a dedicated Linux VM isolated by the host hypervisor — Apple Virtualization.framework on macOS, Hyper-V on Windows | Yes, direct | Yes |
| **Self-hosted environment** | The organization's own runners (Team/Enterprise) | Repo clone only | Org's problem |

Direct quote from the architecture overview: *"the agent loop and code execution run in an isolated,
temporary sandbox on Anthropic-managed infrastructure. Each session gets its own sandbox, created when
the session starts and destroyed when it ends, and sandboxes don't share state with each other or across
organizations."* And for local: *"Shell commands and any code Claude writes execute inside a dedicated
Linux VM, isolated from the host operating system by the platform's hypervisor."*

The **desktop bridge** is the load-bearing mechanism for the hybrid: *"when a session in the cloud needs
something on the user's device, like a local file or the browser, the request goes through the Claude
Desktop app on that device over an Anthropic-brokered connection."* Access is *"limited to folders the
member has connected on the desktop, and each local tool call is checked against the member's permissions
before it runs."*

**Vela consequence.** Vela is a desktop app with the user's own model backend. It gets the local
substrate essentially for free and must *build* the cloud substrate itself if it wants
laptop-closed execution. There are exactly three honest options, and the spec should pick one
explicitly rather than hand-wave:

1. **Local-only** (default, and the honest one for a privacy-first product). Everything is the local
   substrate. "Laptop closed" simply is not offered; instead Vela offers wake-locks, catch-up runs, and
   a headless daemon. This matches the Desktop-scheduled-task and agent-view model, which Anthropic
   itself documents as local.
2. **User-supplied remote runner.** Vela ships a small agent binary (`vela-runner`) the user installs on
   any box they control — a homelab NUC, a VPS, a work desktop. Vela's desktop UI talks to it over a
   user-configured transport. This reproduces cloud sessions without Anthropic, and reproduces
   self-hosted environments as the *only* remote flavour.
3. **Vela-hosted** — out of scope for a model-agnostic app; do not build.

Recommendation: build (1) as the product, (2) as an opt-in "remote runner" with the *same* session
protocol so the UI is identical. Never build (3).

---

## 2. Cowork — the agentic knowledge-work surface

### What it is

Cowork extends agentic execution beyond coding to knowledge work. The product page frames it as:
*"Claude Cowork completes tasks you can steer from anywhere. Give it a goal, and it works across your
files and tools… You come back to polished work for your review."* Get-started frames the loop as:
describe an outcome, step away, come back to *"formatted documents, organized files, synthesized
research, and more."*

Concrete mechanics from Get-started:

1. Claude analyzes the request and creates a plan.
2. Breaks complex work into subtasks when needed.
3. Runs code and shell commands in the isolated environment.
4. Coordinates multiple workstreams in parallel (sub-agents).
5. Delivers finished outputs to the session.

Product page adds: *"Big projects are split into chunks that run together. While it drafts, it researches
and organizes at the same time."* And on transparency: *"Claude shows each step: the files it opens, tools
it uses, and choices it makes."*

Capabilities enumerated: work continues without the user present; sub-agent coordination; direct local
file access on desktop; professional outputs (**Excel with formulas, PowerPoint, formatted documents**);
long-running tasks without timeouts; scheduled tasks running automatically in the cloud; browser actions
via Claude in Chrome; in-place document editing ("Edit with Claude").

Surfaces: Claude Desktop for macOS and Windows (plus Linux beta and ChromeOS per the product page), web
at claude.ai, mobile iOS/Android. Web and mobile are beta. Paid plans only (Pro, Max, Team, Enterprise).

Known limitations documented: chat memory does not carry into Cowork (projects only); no session sharing;
live artifacts and local MCP plugins are desktop-only. Cowork *"consumes more of your usage allocation
than chatting with Claude"* because multi-step tasks are compute-intensive; and auto-approval mode
consumes **more** than manual because of the extra safety-review passes.

### Vela reimplementation — the Cowork session engine

This is the core of Vela and deserves a real design, not a bullet.

**Session model.** A Vela session is a durable record on the local disk (SQLite + a per-session
directory), not an in-memory chat. Minimum schema per session: id, project id, title, created/updated,
status enum (`planning | working | needs_input | idle | completed | failed | stopped`), working
directory, permission mode, model backend id, and an append-only event log (JSONL) of every
user/assistant turn, tool call, tool result, approval decision, and file mutation. The event log is what
makes "come back to finished work", peek, resume-after-crash, and the audit trail all fall out of one
mechanism.

**Agent loop.** Standard ReAct-style loop over the user's model backend via a thin provider
adapter layer (`llama.cpp` server, Ollama `/api/chat`, LM Studio and vLLM via OpenAI-compatible
`/v1/chat/completions`, plus raw Anthropic/OpenAI/OpenRouter keys). Because the backend is arbitrary,
Vela cannot assume native tool-calling. Ship **two tool-invocation transports** and probe at model
registration time:
  - *Native*: OpenAI-style `tools` / `tool_calls`, or Anthropic-style `tool_use` blocks.
  - *Fallback*: a constrained-decoding harness. With llama.cpp/vLLM, use GBNF grammar or JSON-schema
    guided decoding to force a well-formed tool call. With backends offering neither, fall back to a
    strict XML block (`<vela:tool name="..."><vela:arg .../></vela:tool>`) plus a repair-retry loop that
    re-prompts on parse failure up to N times before surfacing an error. Store the detected capability
    on the backend record so the loop does not re-probe every turn.
  Weak local models will fail long-horizon plans. Mitigate with an explicit plan artifact: force the
  model to emit a checklist to `.vela/plan.md` before acting, re-inject the checklist each turn with
  completed items struck, and let a small model act as a "did that step actually succeed?" verifier.
  This is a compensating control for the fact that Anthropic gets to assume a frontier model.

**Subtask decomposition / parallel workstreams.** Reimplement sub-agents as child sessions sharing the
parent's project and permission grants but with fresh context windows. Run them on a bounded worker pool
sized from available RAM/VRAM — with local single-GPU inference the pool is often *one*, so the scheduler
must degrade gracefully from parallel to sequential without changing the UX. Where the user has pointed
Vela at a remote API, allow real parallelism. Results return as structured summaries appended to the
parent's event log, never as raw transcripts (context blowup).

**Code/shell execution isolation.** This is where Vela must match Anthropic's hypervisor-grade isolation,
and the platform primitives differ:
  - **macOS**: `Virtualization.framework` via a small Swift/Obj-C helper, booting a minimal Linux image
    (Alpine or Debian slim) with a virtiofs share mounting only the session's working directory. This is
    literally the same primitive Anthropic names. Lighter-weight fallback: `sandbox-exec` (Seatbelt)
    profiles restricting file and network access, plus App Sandbox entitlements.
  - **Windows**: Hyper-V, ideally via WSL2 with a dedicated distro instance per session, or Windows
    Sandbox for a throwaway. Fallback: a restricted-token job object with a filesystem-redirected temp.
  - **Linux**: `bubblewrap`/`firejail` for a namespace sandbox (recommended default: cheap, no daemon),
    or `podman`/Docker rootless for a full container, or `crosvm`/Firecracker microVM when the user wants
    true hypervisor isolation.
  Ship one abstraction, `vela::sandbox::Sandbox`, with `spawn(cmd, mounts, net_policy, limits)` and
  per-platform backends. Default the network policy to **deny**, matching Anthropic's *"No access to your
  network by default. The sandbox can't reach private, internal, link-local, or cloud-metadata
  addresses."* Enforce it with a per-sandbox network namespace plus an egress proxy (see §7).
  Enforce CPU/RAM/disk ceilings via cgroups v2 (Linux), job objects (Windows), or the VM's own config —
  Anthropic's numbers are 4 vCPU / 16 GB RAM / 30 GB disk, which is a reasonable default ceiling but
  should be user-tunable since Vela runs on the user's own iron.

**Professional document outputs.** Anthropic's Excel-with-formulas / PowerPoint / Word generation is
*server-side file creation* inside their sandbox. Vela's substitute is a **local document toolchain
preinstalled into the sandbox image**: `python-docx` (Word), `openpyxl` or `xlsxwriter` (Excel with real
formulas, not values), `python-pptx` (PowerPoint), `reportlab`/`weasyprint` (PDF), `pypdf`/`pdfplumber`
(PDF read), `pandas` (tabular), `markitdown` or `pandoc` (conversion), and headless LibreOffice
(`soffice --headless --convert-to`) for format fidelity and rendering previews. Bake these into the
sandbox base image at build time so the user is not waiting on a first-run `pip install` and so the
sandbox can stay network-denied. Expose them to the model as *skills* (procedural markdown + helper
scripts), which is exactly Anthropic's own packaging, rather than as bespoke tools — this keeps the
surface model-agnostic and lets the user extend it.

**Transparency UI.** "Claude shows each step" is a straightforward render of the event log: a
chronological activity feed with file-open, tool-call, and decision rows, each expandable to raw
args/results, with a diff view for file mutations. Build it as a projection over the event log so it works
retroactively on resumed and completed sessions.

**Long-running tasks without timeouts.** Never bind session lifetime to a UI window. The agent loop lives
in a background process (see §6) with the UI as a client; killing the window must not kill the run.

---

## 3. Permissions, approval modes, and the safety layer

Cowork ships three approval modes:

- **Manual** — Claude *"pauses and asks for approval for actions"* before proceeding.
- **Auto** — Claude *"keeps working without stopping to ask about every step."* Crucially, this is not
  "no checks": the system performs safety reviews (checking for **data exfiltration** and **prompt
  injection**) and *"automatically blocks anything it determines to be unsafe."* This mode consumes more
  usage because of the extra checking.
- **Skip** — *"doesn't pause to ask and nothing checks its actions automatically."* Recommended only
  *"when you completely trust every action, connector, file, app, etc. involved in the task."*

The safety article adds the defense stack: model training via RL to *"recognize and refuse malicious
instructions"*; content classifiers that *"scan all untrusted content entering Claude's context"*;
action screening in auto mode; **deletion protection requiring explicit user permission** (survives even
Skip mode); per-application permission gates for computer use. It is candid that *"the chances of an
attack are still non-zero."*

Notably: *"Network egress permissions don't apply to the web fetch or web search tools or MCPs."* — web
fetch runs **server-side**, outside the sandbox's egress policy. That is an important asymmetry to
replicate deliberately or deliberately reject.

Claude Code's parallel model is a per-task permission mode plus persisted allow-rules: desktop scheduled
tasks each carry their own permission mode, `~/.claude/settings.json` allow rules apply, "always allow"
decisions persist per-task and are reviewable/revocable from the task's detail page, and connector tools
an org set to `ask` or MCP tools marked `requiresUserInteraction` **prompt on every call with no
always-allow option** — so unattended runs that touch them stall every time.

### Vela reimplementation — permissions

Three-mode enum on both session and scheduled task: `manual | auto | skip`. Manual and Skip are trivial.
**Auto is the hard one**, because Anthropic's auto mode is backed by server-side classifiers Vela does not
have and cannot call. Vela's substitute must be a local, layered, mostly-deterministic policy engine
rather than a pretend classifier:

1. **Deterministic policy first (does most of the work).** A declarative rule file
   (`~/.vela/policy.toml`) with allow/ask/deny matchers on tool name, argument shape, path glob, command
   binary + argv pattern, and destination host. Ship a sane default deny-list: `rm -rf` at `/` or `$HOME`,
   `dd` to a block device, `mkfs`, `chmod -R 777`, curl-pipe-to-shell, writes outside the session's
   connected folders, git force-push, credential-file reads (`~/.ssh/*`, `~/.aws/credentials`,
   `*.pem`, keychain/DPAPI access), package publishing, and any egress to a non-allowlisted host. This
   is *deletion protection* and then some: make destructive filesystem ops require an explicit
   confirmation that Skip mode cannot waive, exactly mirroring Anthropic keeping deletion protection
   alive in Skip mode.
2. **Provenance tracking / taint for prompt injection.** This is the highest-value and most portable
   piece and does not need a model at all. Tag every context segment with its origin
   (`user | local_file | web | connector | tool_output | model`). Wrap all non-user content in explicit
   delimiters that state it is data, not instructions — Anthropic does exactly this for routine fire
   payloads with a `<routine-fire-payload>` block that *"labels it as untrusted data and tells Claude not
   to follow instructions inside it unless the routine's own prompt says to."* Copy that verbatim in
   spirit: `<vela:untrusted source="web" url="...">…</vela:untrusted>`. Then enforce a **taint rule at
   the tool boundary**: if the current turn's context contains untrusted content, any tool call that (a)
   sends data outbound, (b) writes outside the working dir, or (c) executes a shell command, escalates
   from auto to ask. This catches the exfiltration case structurally rather than probabilistically.
3. **Optional local classifier as a third layer, never the only layer.** A small local model
   (Qwen/Llama 3B-class, or a fine-tuned DeBERTa/ModernBERT injection detector run under ONNX Runtime)
   scores each untrusted segment for injection and each proposed action for exfiltration. Because Vela is
   model-agnostic, the classifier must be a *separately configured* small model, not the user's main
   backend — running the judge on the same model that was just injected is worthless. Make it optional
   and clearly labelled as best-effort. Cache scores by content hash so repeated context is not rescored.
4. **Persisted per-scope grants.** "Always allow" decisions stored keyed by
   (scope, tool, normalized-arg-pattern), where scope is session, project, scheduled-task, or global.
   Surface them in a reviewable/revocable list per scope, matching the "Always allowed" panel. Mirror
   Anthropic's `requiresUserInteraction` escape hatch: let an MCP server or a policy rule mark a tool as
   always-prompting, immune to always-allow — needed for anything irreversible or money-moving.
5. **Egress policy is enforced at the sandbox, not by the model.** See §7. Do *not* copy Anthropic's
   carve-out where web fetch/search bypass egress policy; in a local product the honest design is that
   web fetch is a tool subject to the same host allowlist, with the UI making the allowlist obvious.

---

## 4. Scheduled and recurring tasks

Anthropic has **four** distinct schedulers. Vela needs to understand all four because they trade off
differently and Vela must offer the union.

### 4a. Cowork scheduled tasks (support article 13854387)

- Created via **"New task" → "Create with Claude"** (Claude interviews you with multiple-choice
  questions, then outputs the task name, schedule, and what it does) or **"Set up manually"** in a modal.
- Cadences: **hourly, daily, weekly, weekdays, or manual (on-demand)**.
- Execution: *"Scheduled tasks run remotely, so they run on their cadence even when your computer is
  asleep."* Consequence: they work with *"connectors and the files saved to your Claude account"* but
  **cannot access folders on your computer**. Tasks requiring local files or apps only run locally.
- Management from a **Scheduled** dashboard: pause, resume, delete, run-on-demand, edit instructions or
  cadence. Results reviewed *"just like any other task."*
- Available on all paid plans. Failure handling, retries, and notification specifics are **not
  documented** on that page.

### 4b. Claude Code cloud **routines** (code.claude.com/docs/en/routines)

The most fully specified scheduler, and the best blueprint.

- A routine = a saved prompt + one or more repos + connectors + a cloud environment + one or more
  triggers. *"Routines execute on Anthropic-managed cloud infrastructure… so they keep working when your
  laptop is closed."*
- **Three trigger types, combinable on one routine**: Scheduled, API (HTTP POST to a per-routine endpoint
  with a bearer token), GitHub (pull_request and release events, with filters).
- **Schedule mechanics**: presets hourly / daily / weekdays / weekly, or a one-off at a timestamp. Times
  entered in local zone and converted, *"so the routine runs at that wall-clock time regardless of where
  the cloud infrastructure is located."* **Stagger**: *"Runs may start a few minutes after the scheduled
  time due to stagger. The offset is consistent for each routine."* Custom cron via `/schedule update`.
  **Minimum interval is one hour; more frequent expressions are rejected.**
- **One-off runs** auto-disable after firing and are marked "Ran". They do **not** count against the
  daily routine cap.
- **Autonomy**: *"Routines run autonomously as full Claude Code cloud sessions: there is no
  permission-mode picker and no approval prompts during a run."* Reach is bounded instead by repo
  selection, environment network policy/vars, and included connectors.
- **Prompt trust semantics** (important, and subtle): *"When a trigger fires, the session receives the
  routine's saved prompt as its assigned task and carries it out, rather than treating it as untrusted
  content that arrived mid-conversation. The trigger attests only that the prompt was stored ahead of time
  by an authorized session on your account, so the fired prompt is not live user input and can't act as
  approval or consent for actions during the run."*
- **Fire payload trust**: the optional `text` field arrives *"wrapped in a `<routine-fire-payload>` block
  that labels it as untrusted data and tells Claude not to follow instructions inside it unless the
  routine's own prompt says to."* So the saved prompt must explicitly opt in to acting on it. Same
  wrapping applies to "Run now" text.
- **API trigger**: `POST https://api.anthropic.com/v1/claude_code/routines/{routine_id}/fire`, headers
  `Authorization: Bearer sk-ant-oat01-…`, `anthropic-beta: experimental-cc-routine-2026-04-01`,
  `anthropic-version: 2023-06-01`, `Content-Type: application/json`. Body: optional `text`, freeform,
  **max 65,536 characters**, unparsed. Response 200: `{type:"routine_fire", claude_code_session_id,
  claude_code_session_url}`. Errors: 400 (missing beta header / oversize text / routine paused), 401
  (no/mismatched token), 403 (no access), 404 (no routine), 429 (run or usage limit, with `Retry-After`),
  500, 503. **No idempotency key** — retries create multiple sessions. Token scoped to one routine,
  no read access, shown once, regenerate revokes the previous.
- Branch discipline: repos cloned fresh each run from the default branch; Claude pushes to `claude/`-
  prefixed branches which are always accepted; pushes to other branches are **rejected** if the branch is
  protected, someone else has an open PR from it, or it carries commits authored by someone else.
- **A green run status means the session started and exited without an infrastructure error. It does not
  mean the task succeeded.**
- GitHub webhook events are subject to per-routine and per-account hourly caps; excess events are dropped.
- Routines are per-individual-account, not shared; actions appear as the user (their GitHub identity,
  their Slack/Linear accounts).

### 4c. Desktop scheduled tasks — **local** (code.claude.com/docs/en/desktop-scheduled-tasks)

This is the closest analogue to what Vela should build, and it is fully local.

- Created from the Desktop **Routines** page → New routine → **Local** (vs **Cloud** for a routine).
- Fields: Name (lowercased to kebab-case, used as the **folder name on disk**, must be unique),
  Description, Instructions (with permission-mode and model pickers, working-folder selection, and an
  isolated-worktree toggle), Schedule.
- Schedule presets: **Manual, Hourly, Daily (time picker, default 9:00 AM local), Weekdays, Weekly (time
  + day)**. Anything else — "every 15 minutes", "first of each month", a one-off — is set by *asking
  Claude in natural language*, which writes the underlying cron.
- **Scheduler mechanics**: *"Desktop checks the schedule every minute while the app is open and starts a
  fresh session when a task is due, independent of any manual sessions you have open. Each task gets a
  small delay of a few minutes after the scheduled time to stagger API traffic. The delay is
  deterministic: the same task always starts at the same offset."*
- **Minimum interval: 1 minute** (vs 1 hour for cloud).
- Requires the app running and the machine awake; a sleep through the window **skips** the run. A
  **"Keep computer awake"** setting exists under Desktop app → General (lid close still sleeps).
- **Missed-run catch-up**: on app start or machine wake, Desktop checks whether each task missed runs in
  the last **seven days**; if so it starts **exactly one catch-up run for the most recently missed time**
  and discards older ones, with a notification. The docs explicitly warn that a 9am task can therefore run
  at 11pm and tell you to write guardrails into the prompt.
- On fire: desktop notification + a new session under a **Scheduled** section in the sidebar.
- Permissions per task; allow rules from `~/.claude/settings.json` apply; Manual-mode tasks **stall**
  until approved and the session stays open so you can answer later; "Run now then always-allow" is the
  documented way to avoid stalls.
- Management: Run now, Active/Paused toggle, Edit, **run history including skipped runs with the reason**
  (asleep / previous run still in progress / other scheduled tasks already running), review+revoke
  saved approvals, Delete (archives created sessions; optional "Also delete files on disk").
- **On-disk format**: `~/.claude/scheduled-tasks/<task-name>/SKILL.md` — YAML frontmatter with `name` and
  `description`, prompt as the body; edits take effect next run. Schedule, folder, model, and enabled
  state live **outside** that file.
- **Self-modification**: a running task can change its own schedule or prompt via the
  `update_scheduled_task` MCP tool — e.g. reschedule a code review earlier when a release branch appears.
- Default: runs against the working directory as-is, including uncommitted changes; a worktree toggle
  gives each run its own isolated git worktree.

### 4d. `/loop` — session-scoped, in-CLI (code.claude.com/docs/en/scheduled-tasks)

- Tasks live in the current conversation and die with it; `--resume`/`--continue` restores unexpired ones.
- `/loop 5m <prompt>` = fixed interval; `/loop <prompt>` = **self-paced**, Claude picks a delay between
  1 minute and 1 hour after each iteration based on what it saw, printing the delay and its reason;
  `/loop` alone = built-in maintenance prompt (finish unfinished work → tend the branch's PR → cleanup
  passes), overridable via `.claude/loop.md` (project) or `~/.claude/loop.md` (user), 25,000-byte cap.
- Under the hood: `CronCreate` (5-field cron + prompt + recurs/once), `CronList`, `CronDelete`. **8-char
  task IDs. Max 50 scheduled tasks per session.**
- **Scheduler runs every second**, enqueues at low priority; *"A scheduled prompt fires between your
  turns, not while Claude is mid-response."* All times local, not UTC.
- **Jitter**: recurring tasks fire up to 30 minutes late (or up to half the interval for sub-hourly);
  one-shots at :00 or :30 fire up to 90 seconds early. The offset is derived from the task ID so it is
  stable. Documented workaround: schedule at `3 9 * * *` instead of `0 9 * * *`.
- **Seven-day expiry**: recurring tasks fire one final time then delete themselves, bounding forgotten
  loops.
- No catch-up: a missed fire fires once when idle, not once per missed interval.
- Cron dialect: 5-field, wildcards / values / steps / ranges / lists. Day-of-week 0 or 7 = Sunday.
  **No `L`, `W`, `?`, or name aliases like `MON`.** When both DOM and DOW are constrained, a date matches
  if **either** matches (vixie-cron semantics).
- Kill switch: `CLAUDE_CODE_DISABLE_CRON=1`.
- Task list stored in the project's `.claude` directory; scheduling **fails** if that dir or the task file
  is a symlink.

### Anthropic's own comparison table (reproduced verbatim in structure)

|  | Cloud (routines) | Desktop | `/loop` |
|---|---|---|---|
| Runs on | Cloud, Anthropic-managed by default | Your machine | Your machine |
| Requires machine on | No | Yes | Yes |
| Requires open session | No | No | Yes |
| Persistent across restarts | Yes | Yes | Restored on `--resume` if unexpired |
| Access to local files | No (fresh clone) | Yes | Yes |
| MCP servers | Connectors configured per task | Config files and connectors | Inherits from session |
| Permission prompts | No (runs autonomously) | Configurable per task | Inherits from session |
| Minimum interval | 1 hour | 1 minute | 1 minute |

### Vela reimplementation — scheduling

Build **one** scheduler with a target selector, rather than four features. Data model:

```
Task {
  id, name (kebab, unique, = on-disk dir), description,
  prompt            -> ~/.vela/tasks/<name>/TASK.md   (frontmatter + body, hot-reloaded)
  schedule          -> { kind: manual|cron|once, cron: "m h dom mon dow", tz: IANA, at: RFC3339 }
  target            -> local | remote_runner:<id>
  working_dir, use_worktree: bool
  permission_mode, model_backend_id,
  enabled, created_at,
  triggers[]        -> schedule | webhook | fs_watch | git_event
}
Run { id, task_id, session_id, started, ended, status, skip_reason }
```

**Scheduler implementation.** Do not shell out to `cron`/`launchd`/Task Scheduler for the *timing* — you
lose the run history, skip reasons, and catch-up logic. Instead run an in-process scheduler on a 1-second
tick (matching `/loop`'s cadence and giving 1-minute minimum granularity) inside the Vela background
daemon (§6). Use a real cron parser — `croner`/`cron-parser` (JS/TS), `croniter` (Python), `cron` or
`saffron` (Rust) — and **implement vixie-cron DOM/DOW-OR semantics explicitly**, because several
libraries get it wrong. Store the timezone per task as an IANA name and compute next-fire in that zone so
DST shifts do not silently move a 9am job.

**Waking the machine — the piece Anthropic solves with cloud and Vela cannot.** Vela's honest answer is
a layered fallback:
  - Register OS-level wake timers so the machine wakes for a run rather than skipping it:
    macOS `pmset schedule wake` / `IOPMSchedulePowerEvent`; Windows Task Scheduler with
    `WakeToRun` on a thin launcher task that just pings the daemon; Linux `rtcwake` or a systemd timer
    with `WakeSystem=true`.
  - A **"keep awake"** toggle mirroring Anthropic's: `IOPMAssertionCreateWithName`
    (`PreventUserIdleSystemSleep`) on macOS, `SetThreadExecutionState(ES_SYSTEM_REQUIRED|ES_CONTINUOUS)`
    on Windows, `systemd-inhibit --what=idle:sleep` on Linux. Document honestly that closing the lid
    still sleeps, as Anthropic does.
  - **Catch-up on wake**, copying the documented semantics exactly because they are well-reasoned: on
    daemon start and on wake-from-sleep, for each task look back **7 days**, and if runs were missed
    start **exactly one** run for the most recent missed slot, discarding older ones, with a
    notification. Inject the actual scheduled-vs-actual time into the prompt context
    (`This run was scheduled for 09:00 and is executing at 23:14 as a catch-up.`) so the prompt author's
    guardrails can act on it — better than Anthropic's "write guardrails yourself and hope".
  - For genuine laptop-closed operation, the **remote runner** (§1 option 2) is the only real answer.
    Same Task record, `target = remote_runner:<id>`, same scheduler code running in the runner's daemon.

**Stagger/jitter.** Not needed to protect a shared API when the backend is the user's own GPU, but
*absolutely* needed to protect a single local GPU from thundering-herd contention among tasks. Reuse
Anthropic's design: derive a deterministic offset from a hash of the task id, bounded by
min(30 min, interval/2). Additionally serialize local-model runs behind a single-slot queue with a
documented "previous run still in progress" skip reason — a reason Anthropic already surfaces in its run
history and that Vela will hit far more often.

**Failure and observability.** Anthropic's docs are silent on retries; Vela should do better and specify:
per-task `on_failure = skip | retry(n, backoff) | notify`, a run-history view with skip reasons matching
Anthropic's vocabulary (asleep, previous run in progress, resource contention, backend unreachable), and
an explicit distinction between "the run exited cleanly" and "the task succeeded" — Anthropic warns that
green status conflates these, so Vela should require the prompt to emit a machine-readable outcome
(a `vela_report(status, summary)` tool call) and show *that* as the run status.

**Self-modification.** Implement `update_scheduled_task` as a Vela MCP/builtin tool so a running task can
reschedule itself. Gate it: a task may modify **its own** schedule and prompt only, never another task's,
and never escalate its own permission mode.

**"Create with Claude".** Reimplement as a conversational task-builder: a bundled skill whose prompt
interviews the user, then calls a `create_task` tool with a typed schema and echoes back name/schedule/
behaviour for confirmation before writing `~/.vela/tasks/<name>/TASK.md`. With weak local models, prefer
a form-first UI with an optional "help me write this" assist rather than a pure conversation, since
multi-turn slot-filling is exactly where small models fall over.

**Triggers beyond time.** Routines' API and GitHub triggers matter and are cheap locally:
  - *Webhook trigger*: a loopback HTTP listener in the daemon on `127.0.0.1:<port>`, path
    `/v1/tasks/{id}/fire`, bearer token per task generated once and stored in the OS keychain
    (Keychain / DPAPI / Secret Service). Accept an optional `text` body, **cap it at 65,536 characters**
    to match, and wrap it in `<vela:untrusted source="fire_payload">` with the same "do not follow
    instructions in here unless the task prompt says to" framing. Default to loopback-only; exposing it
    to the LAN or via a tunnel must be an explicit, warned opt-in. Mirror the error taxonomy
    (400 oversize/paused, 401 bad token, 404 unknown task, 429 local rate cap) so integrations port.
    Like Anthropic, be explicit that there is no idempotency key unless you add one — and consider
    adding one, since it is nearly free and a strict improvement.
  - *Git/VCS trigger*: a local file-watcher on `.git/refs` plus optional `git fetch` polling, or a
    committed `post-receive`/`post-merge` hook that curls the loopback endpoint. This covers
    "on PR opened" without a GitHub App, and works for GitLab/Gitea/local-only repos, which Anthropic's
    GitHub-only triggers do not.
  - *Filesystem trigger*: watch a folder and fire on new/changed files — the natural knowledge-work
    analogue of a GitHub event, and something Anthropic does not offer. Debounce, and pass changed paths
    as untrusted payload.

---

## 5. Dispatch

From support article 13947068 and the Desktop doc's "Sessions from Dispatch".

- **What it is**: *"message Claude from your phone and have it work on your desktop computer, using your
  local files, connectors, plugins, and apps."* It is a **single persistent thread**, not a new session
  per task: *"Instead of starting a new session for each task, you have a single persistent thread with
  Claude."* It lives in the **Cowork** tab and is also reachable from the Desktop left sidebar.
- **Routing**: *"Claude figures out what kind of work is needed and spins up the right session.
  Development tasks run in Claude Code; knowledge work runs in Cowork."* The Desktop doc is more precise:
  a task becomes a Code session either because you asked directly ("open a Claude Code session and fix
  the login bug") or because Dispatch decided it is development work. Typical Code routing: fixing bugs,
  updating dependencies, running tests, opening PRs. *"Research, document editing, and spreadsheet work
  stay in Cowork."* Spawned Code sessions appear in the Code tab sidebar with a **Dispatch badge**.
- **Where compute runs**: *"Dispatch runs your tasks on your desktop, so your computer needs to be awake
  and the Claude Desktop app open while Claude works."* The phone is a **remote control**, not a runtime.
- **Notifications**: *"You'll get a push notification on your phone when a task is done or when Claude
  needs your go-ahead."*
- **Computer use interaction**: Dispatch-spawned Code sessions can use computer use if enabled, but
  *"App approvals in those sessions expire after 30 minutes and re-prompt, rather than lasting the full
  session like regular Code sessions."*
- **Requirements**: latest Claude Desktop (macOS, Windows x64, or Linux), latest Claude mobile app,
  **Pro or Max plan** (explicitly *not* Team or Enterprise), active internet on both devices.
- **No QR pairing** documented for Dispatch (unlike Remote Control, which does use a QR code).

### Vela reimplementation — Dispatch

Dispatch is three separable mechanisms; build them as three:

1. **A persistent inbox thread.** A single long-lived session record per user, distinct from task
   sessions, whose job is triage. It holds continuity ("as I mentioned earlier"), and each incoming
   message either continues the thread or spawns a child session.
2. **A router.** Classify each inbound message into `knowledge_work | code | inline_answer`. Do not
   rely on a weak local model doing this zero-shot. Layered approach: (a) explicit override — if the
   message names a mode ("open a code session and…"), obey it; (b) deterministic signals — is the current
   project a git repo, does the message contain paths/stack traces/PR URLs; (c) a small classifier
   prompt with few-shot examples pinned in the system prompt, forced to emit one token from a constrained
   set. Always show the routing decision in the UI with a one-tap override, because it *will* be wrong
   sometimes and a wrong route is cheap to fix but expensive to hide.
3. **The phone→desktop transport.** This is the only Anthropic-server-side piece, and it is the hardest
   to replace honestly. Anthropic brokers it: phone → Anthropic → Desktop app. Vela's options, in
   descending order of "would I ship this":
   - **Self-hosted relay + PWA.** Vela's daemon opens an outbound WebSocket to a small relay the user
     runs (a 200-line service on a VPS, or a Tailscale/Cloudflare-Tunnel endpoint). The phone loads a PWA
     that talks to the relay. Payloads end-to-end encrypted with a key established at pairing so the
     relay is a dumb pipe and never sees content. Pair via **QR code** displaying the relay URL + a
     pre-shared key (Remote Control already proves QR pairing is the right UX; Dispatch's lack of one is
     an omission, not a design choice worth copying).
   - **LAN/VPN-only**, no relay: daemon listens on the tailnet/LAN, phone connects directly. Zero
     third-party trust, but only works on the same network or VPN. Ship this as the default because it
     requires no user infrastructure and is genuinely private.
   - **Bring-your-own chat transport** — reuse the Channels model (§8): Telegram/Discord/Signal/Matrix
     bot as the phone UI, daemon polls or holds a socket outbound. Zero inbound ports, works everywhere,
     and the user already has the app installed. Downside: the chat provider sees the content, so label
     it clearly.
   In all cases the daemon makes **outbound connections only** and opens no inbound port on the user's
   machine — precisely the property Remote Control documents (*"makes outbound HTTPS requests only and
   never opens inbound ports on your machine"*) and the one that makes this safe to ship.
4. **Push notifications.** Anthropic pushes via its own APNs/FCM app. Vela substitutes:
   Web Push from the PWA (VAPID keys generated locally, push endpoint is the browser vendor's — note this
   metadata leak in the docs), or ntfy.sh / Gotify / Pushover as a user-configured sink, or simply a
   message in the chosen chat channel. Notification triggers should match Anthropic's two: **task
   finished** and **needs your go-ahead**. Also copy Claude Code's presence suppression — do not push
   while the user is focused on the local Vela window, and support a marker-file/idle-detector so
   notifications stay quiet while the user is at the machine.
5. **Approval expiry.** Copy the 30-minute app-approval expiry for computer-use in dispatched sessions.
   The reasoning is sound: an approval granted for an unattended, remotely-initiated session should not
   last as long as one granted while the user is watching. Generalize it: grants made in a session the
   user is not attending expire on a timer; grants made while attended last the session.

---

## 6. Background runs, agent view, and the supervisor

`agent view` (`claude agents`) is the reference implementation of local background runs, and it is
**entirely local** — the single most useful precedent for Vela.

- *"Background sessions are hosted by a per-user supervisor process, separate from your terminal and from
  agent view. The supervisor starts automatically the first time you background a session or open agent
  view."*
- State on disk: `~/.claude/jobs/<id>/state.json` (per-session state), `~/.claude/jobs/<id>/tmp/`
  (scratch, **no permission prompts** for writes there), `~/.claude/daemon.log`.
- *"Not cloud-based: Sessions stop on machine shutdown (but survive sleep)."*
- **Status model**: Working (animated), Needs input (yellow), Idle (dimmed), Completed (green), Failed
  (red), Stopped (grey). Icon *shape* separately encodes process state: `✻`/`✽` process alive and replies
  immediately, `∙` process exited but you can still peek/reply/attach, `✢` a `/loop` session sleeping
  between iterations.
- **Row summaries** are one-line, generated by a small fast model (Haiku), updating *"at most every 15
  seconds during work"*, with a fresh summary at turn end. Working rows show what the session says it is
  doing; blocked rows show the question being asked.
- **Notifications** fire while agent view is open when a local background session starts needing input,
  when a session finishes or fails, and when scheduled `/loop` sessions need input (not on completion).
  Routed through a `preferedNotifChannel` setting and a `Notification` hook with `agent_needs_input` /
  `agent_completed` types.
- **Peek** (`Space`) shows the exact question / the result / the full status sentence / linked PRs, and
  lets you reply inline, press a number key for predefined choices, or `Tab` for a suggested reply —
  without leaving the list. **Attach** (`Enter`/`→`) gives the full session; Claude posts a recap of what
  happened while you were away. *"Sessions keep running after detach."*
- **Write isolation**: background sessions move into isolated git worktrees under `.claude/worktrees/`
  before editing, so parallel sessions share a read checkout but each writes its own tree. Skipped when
  already in a linked worktree, when not a git repo, or when the write is outside the working directory.
  Disable with `{"worktree": {"bgIsolation": "none"}}`.
- **Dispatch entry points**: from the view's input, from the shell (`claude --bg "…"`,
  `--bg --name "…"`), from inside a session (`/bg <prompt>`, `/background` to move the current
  conversation, `/fork` to copy it), and with a subagent override (`--agent code-reviewer --bg "…"`).
- **CLI surface**: `claude agents [--cwd|--json]`, `attach <id>`, `logs <id>`, `stop <id>`, `rm <id>`
  (transcript saved), `respawn <id>`, `daemon status`, `daemon stop --any`.
- **Settings inheritance**: a background session reads settings from the directory it runs in. Permission
  mode, model, and effort persist across restarts; config flags (`--mcp-config`, `--settings`,
  `--add-dir`, `--plugin-dir`) carry through.
- **What carries over when backgrounding**: running background shell commands, background subagents (if
  all their work can move), dynamic workflows, and scheduled `/loop` tasks. **Stopped instead**: running
  monitors and subagents that own monitors — with a confirmation dialog.
- Kill switch: `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` or `{"disableAgentView": true}`.

### Vela reimplementation — background runs

**Ship the supervisor as the product's spine, not an add-on.** `vela-daemon` is a per-user background
process that owns: the scheduler, all running sessions, the sandbox pool, the notification dispatcher,
and the local IPC/HTTP endpoint the UI attaches to. The Electron/Tauri window is a *client*. Closing it
must not stop work. Launch on demand (first background session or first UI open) and register for
login-start only if the user has scheduled tasks. Auto-restart via `launchd` KeepAlive (macOS),
a Scheduled Task or service (Windows), `systemd --user` (Linux).

**On-disk layout**, mirroring Anthropic's because it is clean and debuggable:
```
~/.vela/
  daemon.log
  daemon.sock            (unix socket; named pipe on Windows)
  jobs/<id>/state.json   (status, cwd, model, permission mode, pid)
  jobs/<id>/events.jsonl (append-only event log — source of truth)
  jobs/<id>/tmp/         (scratch; writes here never prompt)
  tasks/<name>/TASK.md
  policy.toml
```

**Status model**: copy the six states verbatim (`working / needs_input / idle / completed / failed /
stopped`) and copy the orthogonal process-liveness axis (`alive / exited-but-resumable / sleeping`) —
the separation is genuinely good design and users need to know whether a reply will be instant.

**Row summaries with an arbitrary backend.** Anthropic uses Haiku. Vela must not assume a second fast
model exists. Design: let the user optionally configure a "fast/utility model" (a 1-3B local model, or
just the same backend); if none is configured, **derive summaries deterministically** from the event log
— "Editing src/auth.ts (3 of 7 files)", "Waiting: approve `npm publish`?" — which is often *better* than a
model-written summary and always free. Rate-limit to Anthropic's 15 seconds and refresh at turn end.

**Peek / attach.** Directly portable: a list view where selecting a row shows the pending question, the
result, or the current status, with inline reply and numbered quick-choices; and an attach that swaps to
the full transcript with a generated "here's what happened while you were away" recap (build the recap
from the event log, not from a model call, so it works with any backend). Detaching must never stop work.

**Write isolation.** `git worktree add .vela/worktrees/<session-id>` before the first write in a repo, with
the same skip conditions (already in a linked worktree, not a repo, write outside cwd) and the same
`bgIsolation: none` escape hatch. For **non-git** knowledge-work folders — which is Cowork's whole domain
and where Anthropic's worktree trick does not apply — Vela needs its own answer: a **copy-on-write
overlay**. On APFS use `clonefile()`; on Btrfs/XFS use `cp --reflink=auto`; on Windows/ReFS use block
cloning, falling back to a shadow directory plus an OverlayFS-style merge on Linux. Present the result as
a reviewable diff before committing changes back to the real folder. This is a genuine improvement over
the source design and is the single most important safety feature for agentic file editing.

**Notifications.** Same three triggers (needs input, finished, failed), delivered through a pluggable
sink: OS-native (`node-notifier`/`tauri-plugin-notification`), the remote push path from §5, or a
user-defined command hook — mirroring Anthropic's `preferedNotifChannel` + `Notification` hook with the
`agent_needs_input` / `agent_completed` event types, which is a clean contract worth copying verbatim.

**Entry points.** `vela --bg "<prompt>"`, `--bg --name`, `/bg` and `/background` and `/fork` inside a
session, `--agent <subagent>` override, and a `vela agents` TUI/GUI. CLI verbs: `agents [--json]`,
`attach`, `logs`, `stop`, `rm`, `respawn`, `daemon status`, `daemon stop --any`.

---

## 7. Sandboxing, network egress, and the environment model

Cloud sandbox properties, quoted:
- *"No access to your network by default. The sandbox can't reach private, internal, link-local, or
  cloud-metadata addresses."*
- *"Short-lived credentials only. The sandbox holds only session-scoped tokens that expire within hours."*
- *"Egress is enforced outside the sandbox. All traffic leaving the sandbox passes through a mandatory
  proxy."*
- *"Connector authorization tokens never enter the sandbox; connector calls are made on the server side."*
- Tenant isolation at the data layer; every stored record scoped to org and account.

Cloud **environments** (the reusable config attached to sessions and routines):
- **Network access levels**: **None** (no outbound through the session's network), **Trusted** (default —
  allowlisted domains only: package registries, GitHub, cloud SDKs), **Custom** (your own domain list,
  optionally plus the default list), **Full** (any domain). Blocked hosts fail with `403` and
  `x-deny-reason: host_not_allowed`.
- **Connector traffic bypasses the session network entirely** — it travels through Anthropic's servers,
  so connector hosts need no allowlist entry. Security proxy also does rate limiting, abuse prevention,
  content filtering, and keeps a **DNS-level audit trail of requested hostnames**.
- **GitHub proxy**: credentials never enter the container. `GH_TOKEN`/`GITHUB_TOKEN` read as the literal
  placeholder `proxy-injected` and the proxy substitutes real credentials on outbound requests.
- **Base image**: fresh VM per session, **Ubuntu 24.04 on x86_64** regardless of the user's OS/arch, repo
  cloned, toolchains preinstalled: Python 3.x (pip, poetry, uv, black, mypy, pytest, ruff); Node 20/21/22
  at `/opt/node20|21|22` with 22 on PATH (npm, yarn, pnpm, bun, eslint, prettier, chromedriver); Ruby
  3.1/3.2/3.3; PHP 8.4 + Composer; OpenJDK 21 + Maven/Gradle; Go; Rust; GCC/Clang/cmake/ninja/conan;
  Docker + compose; PostgreSQL 16 and Redis 7.0 (installed, **not running** — `service postgresql start`);
  git, jq, yq, ripgrep, tmux, vim, nano. `gh` is **not** preinstalled.
- **Resource limits**: ~4 vCPU, 16 GB RAM, 30 GB disk.
- **Setup scripts**: Bash, run as **root**, before Claude Code launches, must **exit zero** (non-zero =
  session fails to start), must finish **within ~5 minutes**, need network for installs.
- **Environment caching**: after the setup script completes, Anthropic **snapshots the filesystem** and
  reuses it as the start point for later sessions, skipping the script. The cache keeps files (packages,
  Docker images, written files) but **not running processes**. It rebuilds when the setup script or the
  allowed-host list changes, and expires after ~7 days. Resuming an existing session never re-runs it.
- **Ordering**: setup script (only when no cache exists) → Claude Code launches → SessionStart hooks.
- **No secrets store**: env vars and setup scripts are *"visible to anyone who uses the environment"*.
- What carries over from local setup: repo `CLAUDE.md`, `.claude/settings.json` hooks, `.mcp.json`,
  `.claude/rules/`, `.claude/skills|agents|commands/`, repo-declared plugins (installed at session start),
  and server-managed org settings. What does **not**: user `~/.claude/*`, user-scoped plugins,
  `claude mcp add` at local/user scope, transport env vars like `NODE_EXTRA_CA_CERTS`, static credentials,
  interactive auth like AWS SSO.

### Vela reimplementation — environments

Introduce a first-class **Environment** record, reusable across sessions and tasks, because it is the
right abstraction and Vela needs it for reproducibility:

```
Environment {
  id, name,
  image: <OCI ref | VM image path>,     // default: vela/base:<version>
  net: none | trusted | custom(hosts[]) | full,
  env_vars: {…},        secrets_ref: <keychain handles, NOT plaintext>
  setup_script: bash,   cache: { snapshot_id, built_at, ttl }
  limits: { vcpu, ram_mb, disk_gb }
}
```

- **Network enforcement.** Run each sandbox in its own network namespace with **no default route**, and
  route all egress through a Vela-managed local proxy (mitmproxy/`http-mitm-proxy`, or a small Go/Rust
  CONNECT proxy) that enforces the host allowlist, blocks RFC1918/link-local/`169.254.169.254`
  cloud-metadata by IP after DNS resolution (defeating DNS rebinding), logs a hostname audit trail, and
  returns a `403` with a `x-vela-deny-reason: host_not_allowed` header so failures are legible to the
  model. Ship the same four levels with the same names — `none`/`trusted`/`custom`/`full` — and ship a
  default trusted allowlist covering npm, PyPI, RubyGems, crates.io, Go proxy, Maven Central, Docker Hub,
  GHCR, and the major forges. Deny-by-default is the correct posture for a local product that reads the
  user's real documents.
- **Credential isolation.** Reproduce the "tokens never enter the sandbox" property with the proxy:
  connector/API credentials live in the OS keychain, held by the **daemon**, never passed into the
  sandbox. The sandbox sees a placeholder (copy `proxy-injected` as the literal, for familiarity) and the
  daemon's proxy injects the real `Authorization` header on outbound requests to the matching host. This
  is a straight port of Anthropic's GitHub proxy and it is the single highest-leverage security control
  Vela can implement, because MCP/connector tokens are otherwise sprayed into agent context.
- **MCP/connector calls run in the daemon, not the sandbox** — matching *"connector calls are made on the
  server side"*, except "server" is the user's own daemon. The sandbox gets a narrow RPC to the daemon's
  tool broker. This also means connectors keep working under `net: none`.
- **Base image**: build and ship `vela/base` as an OCI image (podman/Docker) and, for the VM backends, as
  a prebuilt rootfs. Match Anthropic's toolchain list where cheap, but **the knowledge-work additions
  matter more for Vela**: the document toolchain from §2, plus tesseract/OCR, ffmpeg, imagemagick, and
  pandoc. Pin `Ubuntu 24.04` for parity of surprise-free `apt install`. Ship arch-native images
  (arm64 *and* x86_64) rather than forcing x86_64 — Anthropic's x86_64-only constraint is an artifact of
  their fleet, not a design goal, and Apple Silicon users would pay emulation costs for nothing.
- **Setup scripts + caching**: implement snapshotting natively. With OCI backends this is
  `podman commit` / a derived layer keyed by hash(setup_script + allowlist + base image digest). With VM
  backends, a qcow2 snapshot or an APFS/Btrfs snapshot of the rootfs. Copy the documented semantics:
  files persist, processes do not; rebuild when the script or allowlist changes; ~7-day TTL; resume never
  re-runs. Copy the constraints too (exit-zero required, ~5 min budget) but make them warnings the user
  can raise, since it is their own hardware.
- **Do ship a secrets store**, unlike Anthropic ("A dedicated secrets store is not yet available"). Vela
  has the OS keychain right there. Secrets referenced by handle in the Environment record, resolved by
  the daemon at proxy-injection time, never materialized as an env var inside the sandbox.

---

## 8. Adjacent mechanisms Vela must not miss

**Remote Control** (local session driven from web/mobile) — the cleanest precedent for Vela's phone UX.
Properties to copy: outbound-HTTPS-only with **no inbound ports**; QR-code pairing (`spacebar` toggles the
QR in server mode); automatic reconnect after sleep/network drop with queued status updates delivered on
recovery; a session-URL reminder shown on long turns and after repeated permission prompts; `--spawn`
modes (`same-dir` / `worktree` / single-`session`) and `--capacity` (default 32) for multi-session
serving; a documented ~10-minute network-outage timeout; forwarded-dialog expiry (default 5 min, then
the dialog's no-action default, tunable via `dialogExpiry`); and **Trusted Devices** — device enrollment
offered only shortly after a full sign-in, an 18-hour sign-in freshness window, biometric step-up via
platform authenticators (Face ID / Touch ID / Windows Hello / passkey) with *"Anthropic never receives or
stores fingerprints, face data, or any other biometric information"* — only public key + display name +
platform + enrollment time. Vela should implement device enrollment with WebAuthn/passkeys against the
daemon, which is entirely local and needs no server at all.

**Channels** — push external events into an *already-running* local session, as opposed to spawning a new
one. A channel is an MCP server named in `--channels`; Telegram, Discord, iMessage, and a `fakechat`
localhost demo ship as plugins. Security model worth copying wholesale: a **sender allowlist** per channel
bootstrapped by a pairing code (bot replies with a code; you approve it in-session), everyone else
silently dropped; being present in `.mcp.json` is **not** enough — the server must also be named in
`--channels`; and a **permission relay** capability lets a channel forward approval prompts to the remote
user, gated by the same allowlist (*"Anyone who can reply through the channel can approve or deny tool use
in your session"*). Vela should ship this as the low-infrastructure Dispatch transport (§5 option 3) and
as the webhook receiver for CI/alerting. Note the documented always-prompting exceptions that even
skip-permissions cannot bypass: explicit ask rules, org-`ask` connector tools, `requiresUserInteraction`
MCP tools, removals targeting `/` or `$HOME`, and cross-session-messaging safeguards.

**Skills in Cowork** — *"Cowork sessions and cloud sessions, including routines, don't read
`~/.claude/skills/` on your machine. Both interactive and scheduled Cowork sessions load the skills
enabled for your claude.ai account, synced at session start."* Cloud sessions additionally load repo
`.claude/skills/`. **Desktop scheduled tasks are the exception — they run locally and load skills from
the same locations as any other local session.** Vela inverts this cleanly: **the local filesystem is the
source of truth**, `~/.vela/skills/` plus per-project `.vela/skills/`, with optional sync to a
user-controlled git repo instead of an account. This is strictly better for a local-first product and
removes an entire class of "why can't my routine see my skill" support burden.

**Plugins in Cowork** — bundle *"skills, connectors, and sub-agents into a single package."* Hooks and
sub-agents run **only in Cowork** (greyed out in chat). Marketplaces: Knowledge Work (default), Life
Sciences, Financial Services, Legal, plus arbitrary GitHub repos. Org admins can distribute, auto-install,
require, and per-group scope plugins; org-managed plugins are not user-editable. In Cowork *"connectors
reach external services through Anthropic's cloud, not through your local network"*, so custom connectors
must be publicly reachable — **a real limitation Vela does not have**: Vela's daemon runs on the user's
machine, so it can reach `localhost`, LAN services, and firewalled internal servers that Cowork
structurally cannot. Lead with this. Vela's plugin format should be a git-installable directory
(`vela-plugin.json` + `skills/` + `agents/` + `hooks/` + `mcp.json`) resolved from user-configured
marketplace repos.

**Live artifacts** — *"persistent, interactive HTML dashboards"*, **desktop-only**, *"live on your
computer"*, do not sync, saved to an Artifacts view with **automatic version history** and restore, pull
from connected apps and local files, refresh on open via a cache with a manual refresh button, and use
connectors without re-prompting once approved. Vela reimplements this as a local HTML file per artifact
under `~/.vela/artifacts/<id>/`, versioned in a git repo for free history/restore, rendered in a
sandboxed webview with a **strict CSP that blocks all external hosts**, and given data access only
through a narrow `window.vela.*` bridge that proxies to the daemon's tool broker (so the same permission
policy and audit trail apply). Refresh-on-open with a TTL cache. This is a case where Vela is
architecturally *better positioned* than Cowork, since the data never leaves the machine.

**Computer use in Cowork** — a three-tier escalation: **connectors first, then browser navigation, then
direct screen interaction**. Screenshots to understand the interface, then clicks and keyboard input.
macOS and Windows, in Cowork and Claude Code. Per-app permission gates; some apps **off-limits by
default** (investment platforms, cryptocurrency tools); a user-definable app blocklist; "action review"
scanning for prompt injection; trained to avoid stock trading, entering sensitive data, and gathering
facial images; memory excludes passwords/financial/health data. Requires the machine awake and the app
open. Vela's substitute is fully local and needs no Anthropic anything: screenshots via
`screencapture`/`ScreenCaptureKit` (macOS), `BitBlt`/Windows.Graphics.Capture (Windows), `grim`/XCB
(Linux); input via CGEvent / SendInput / `uinput`+`ydotool`; browser control via CDP against a
user-owned Chrome/Chromium profile. Copy the escalation ladder exactly — it is a good idea and saves
tokens. Copy the default blocklist categories (finance, crypto, password managers, keychain, email
send-confirm) and make it user-editable. Note that a vision-capable model is required for the screen
tier; Vela must detect vision capability per backend and **hide** the computer-use tier for text-only
backends rather than letting the agent flail.

**Cowork projects** — *"dedicated workspaces with their own files, context, instructions, and memory"*,
bindable to an existing local folder, with per-project instructions ("tone, formatting, or rules"),
context (local folder, linked chat project, or a URL), and **memory scoped to the project** so
*"what Claude learns in one project doesn't carry over to others."* Archiving a project does not touch
local files. Vela: a Project record binding a root folder + `VELA.md` instructions (folder-level, layered
under a global `~/.vela/VELA.md` — Cowork's "global and folder instructions" split) + a project-scoped
memory store (a small SQLite table or an append-only `memory.md` the agent may edit, retrieved by
embedding search when a local embedding model is configured, plain recency otherwise).

**OpenTelemetry** — Cowork streams user prompts (full text), tool/MCP invocations (server name, tool name,
parameters, success/failure, execution time), file access paths, skills/plugins invoked, human approval
decisions (approved/rejected/auto), and API requests/errors (model, token counts, estimated cost,
duration, errors). All events from one prompt share a `prompt.id` attribute. Configured org-wide with an
OTLP endpoint, HTTP/JSON or HTTP/protobuf, optional auth headers encrypted at rest. Vela: emit the same
event taxonomy from the daemon over standard OTLP, defaulting to **off** and, when on, defaulting to a
local collector. The `prompt.id` correlation attribute is a small detail worth copying exactly. This is
also, conveniently, the same event stream that powers Vela's own run-history and audit UI — build one
emitter, two consumers.

---

## 9. Feature-by-feature portability verdict

| Feature | Anthropic dependency | Vela verdict |
|---|---|---|
| Cowork agent loop, planning, sub-agents | Client-side logic + hosted model | **Portable.** Needs a tool-calling fallback for weak backends. |
| Cowork **cloud** session execution | Server-side (ephemeral Anthropic VM) | **Replace**: local hypervisor/container sandbox; optional user-run remote runner for laptop-closed. |
| Cowork **local** session execution | Client-side (Virtualization.framework / Hyper-V) | **Portable**, same primitives. |
| Desktop bridge (cloud → local files) | Server-brokered | **Unnecessary** if local-first; else the runner's own tunnel. |
| Office/PDF file creation | Server-side sandbox tooling | **Replace**: python-docx / openpyxl / python-pptx / reportlab / LibreOffice headless in the local sandbox image. |
| Approval modes manual/auto/skip | Auto's safety review is server-side | **Mixed**: modes portable; auto's classifier replaced by deterministic policy + provenance taint + optional local small-model judge. |
| Deletion protection | Client-side | **Portable**, and should survive skip mode as it does upstream. |
| Cowork scheduled tasks | Server-side scheduler | **Replace**: daemon scheduler + OS wake timers + catch-up. |
| Cloud routines (schedule/API/GitHub triggers) | Server-side | **Replace**: daemon scheduler + loopback webhook endpoint + local git/fs watchers. |
| Desktop scheduled tasks | Client-side | **Portable** essentially verbatim, including SKILL.md-on-disk and catch-up semantics. |
| `/loop`, CronCreate/List/Delete | Client-side | **Portable** verbatim, including jitter, 7-day expiry, vixie DOM/DOW-OR, 50-task cap. |
| Dispatch persistent thread + router | Client-side | **Portable.** Router needs layered heuristics for weak models. |
| Dispatch phone↔desktop transport | Server-brokered | **Replace**: LAN/VPN direct, self-hosted E2EE relay, or a chat channel. |
| Mobile push notifications | Anthropic APNs/FCM | **Replace**: Web Push / ntfy / Gotify / chat message. |
| Agent view + supervisor + peek/attach | Client-side, `~/.claude/jobs/` | **Portable** verbatim; the best blueprint in the whole corpus. |
| Haiku-generated row summaries | Hosted small model | **Replace**: optional user-configured fast model, else deterministic event-log summaries. |
| Worktree write isolation | Client-side git | **Portable**; extend with CoW overlays for non-git knowledge-work folders. |
| Cloud environments (net levels, setup scripts, cache) | Server-side | **Replace**: local Environment record + egress proxy + OCI/VM snapshot cache. |
| Egress proxy + credential injection | Server-side | **Replace**: daemon-local MITM proxy with keychain-held secrets. Highest-leverage security port. |
| Connectors run server-side | Server-side | **Replace**: run MCP in the daemon. Bonus: Vela reaches localhost/LAN/firewalled hosts that Cowork cannot. |
| Live artifacts | Client-side, desktop-only | **Portable**; local files + git version history + CSP-locked webview + `window.vela.*` bridge. |
| Computer use | Client-side | **Portable**; needs a vision-capable backend, so gate the tier on capability detection. |
| Channels | Client-side MCP + user's own bot creds | **Portable** verbatim. |
| Skills/plugins sync | Account-synced (server-side) | **Replace**: filesystem is truth; optional git sync. |
| OpenTelemetry export | Client emits, user's collector | **Portable** verbatim. |
| Trusted Devices / biometric step-up | Server-side enrollment | **Replace**: WebAuthn/passkey enrollment against the local daemon. |
| Team/Enterprise admin toggles, org policy | Server-side | **Replace** (if ever needed): managed `policy.toml` via MDM, same precedence rules. |

---

## 10. Open questions the fetched docs did not answer

These are genuine gaps in the source material, not things I skipped:

- Cowork scheduled-task **retry/failure behaviour** and notification specifics — the support article is
  silent. Vela must specify its own.
- Whether Cowork scheduled tasks can be pinned to a **local** session when local files are needed; the
  article says such tasks "will only run locally" without describing the mechanism or the UI.
- Exact Cowork **notification trigger list** beyond "finishes a task or needs your input".
- Per-plan **limits** on the number of scheduled tasks / routines (the docs reference a daily *run* cap
  and point to the live UI, but publish no numbers).
- Dispatch **pairing mechanics** — the article documents no QR code and does not describe the handshake.
- Whether Cowork's cloud sandbox exposes the same 4 vCPU / 16 GB / 30 GB ceilings documented for Claude
  Code cloud sessions; the Cowork architecture page does not state resource limits.
