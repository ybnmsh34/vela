# Reference study: MindsHub Cowork

Study B, Phase 1. Researched 2026-08-13/14.

## What it is

MindsHub Cowork is a real, currently-shipping product. It is the flagship application of **MindsHub**, the renamed/rebranded form of **MindsDB** — a real company founded in Berkeley in 2018 by Jorge Torres and Adam Carrigan, backed by Benchmark, Y Combinator, and NVIDIA, previously known for an open-source "AI inside your database" SQL/ML product.[^1][^2][^3]

**How identity was established** (this name collides with several unrelated products, so this was done deliberately, not assumed):
- `mindsdb.com` (the well-known company's original domain) was fetched directly and it now serves the `mindshub.ai` homepage — i.e., the domain itself redirects, which is first-party evidence the two are the same company, not a look-alike.[^1]
- The GitHub organization `github.com/mindsdb` hosts the actual source repositories for the product — `mindshub` (superproject), `cowork-server` (FastAPI backend), `anton` (default agent), and states explicitly: "MindsHub is built by MindsDB, founded in 2018 in Berkeley. Same company, same team — the product surface moved from in-database ML to open-source AI agents."[^3]
- MindsHub's own blog carries a continuous publication history from "MindsDB" posts (Knowledge Bases, MCP support, product updates through Jan/Feb/April 2026) directly into a post titled "MindsDB is now MindsHub: same Minds, new shape," which is the rebrand announcement, plus a dedicated `/mindshub-vs-mindsdb` explainer page describing the 2018→2022 pivot and the reason for the later name change (the old name implied "database," which no longer fit an agent platform).[^4][^5]
- The `cowork-server` GitHub repo is genuine engineering documentation, not marketing copy: real SQLite schema (`projects`, `conversations`, `messages`, `schedules`, `artifacts`/`pins` tables), real directory layout under `~/.cowork/`, Alembic migration notes, CalVer release workflow, SSE streaming endpoints. This is strong evidence of an actual working codebase, not vaporware — confirmed further in this pass by reading real source files directly (see Technical internals below).[^6]
- A third-party, independently-published screen-recorded walkthrough (YouTube channel "Tech With Tim," a sponsored video, so treat enthusiasm with mild caution — but the recorded UI itself is firsthand visual evidence the app runs) shows the desktop app installed, signed in, and used to generate a real dashboard artifact — corroborating that the product is real and functions largely as described. It does not, however, exactly match the sidebar contents found on the first-party site; see Information architecture below for where the two sources agree and where they don't.[^7]
- `mindshub.ai/cowork` — the page named for the product itself — was fetched directly (twice, including a forced cache bypass) specifically to check it against everything written here. It did not resolve to distinct page content: both fetches returned the same rendered text as the homepage (`mindshub.ai/`), most likely because this is a client-side-routed single-page app and the fetch tool captures the same server-delivered shell regardless of path. No content unique to `/cowork` was recoverable this way, and — because the returned text is identical to what's already cited from the homepage — nothing on it contradicts any claim in this document. This is reported explicitly rather than silently treated as "checked."[^12]
- Two more named source repos, `github.com/mindsdb/mindshub` (the platform superproject) and `github.com/mindsdb/cowork` (the Electron + React frontend, developed as a separate repo from `cowork-server`), were also read directly; both are real, both contain genuine build/release engineering documentation (Makefile targets, Vite/Electron dev modes, an OTA update pipeline with a public `antontron-releases` companion repo, IPC channel tables), not marketing text.[^13][^14]

**Name collisions explicitly ruled out:**
- **Anthropic's "Claude Cowork"** is a distinct, unrelated, real product — a feature of the Claude app ("next to Chat") for handing off multi-step knowledge work, covered by CNBC and TechCrunch, with its own product page at `claude.com/product/cowork`. It is made by Anthropic, not MindsDB/MindsHub, has its own architecture (single agent, desktop/web/mobile, computer-use fallback, enterprise admin controls), and is not the subject of this study.[^8] The YouTube reviewer of MindsHub Cowork explicitly frames MindsHub as an open-source alternative to this Anthropic product, which is further confirmation the two are different things being compared, not the same thing.[^7]
- **Generic "coworking space" management software** (Cobot, Coworks, Yardi Kube, Nexudus, Optix, Archie, DeskFlex) is an unrelated category — physical shared-office booking/billing SaaS, nothing to do with AI agents.[^9]

**Concretely, what it is:** MindsHub Cowork is a desktop app (Electron + React shell, per both the `cowork-server` repo's own description of its sibling frontend repo and the frontend repo itself) for macOS and Windows, with a browser client at `console.mindshub.ai`.[^6][^14][^3] Under the hood, the Electron app spawns a local Python/FastAPI sidecar (`cowork-server`) on `127.0.0.1:26866` that owns a SQLite database and a project/artifact/vault filesystem tree — even the packaged desktop app is architecturally a local-first client talking to a local backend process, not a thin client to a remote server, though a hosted/cloud version (`console.mindshub.ai`, plus "round-the-clock cloud runs") also exists for users who sign in.[^6][^1] **Note a contradiction in the vendor's own marketing pages**: the GitHub org README says "Web — nothing to install: console.mindshub.ai" as if it's live today, while `mindshub.ai/download` and the homepage both say a browser version is "coming soon." I report this discrepancy rather than resolve it — the site appears to be mid-rollout and not fully internally consistent.[^3][^2][^1]

It is single-operator in structure (one person's workspace, one agent working at a time, one credential vault) but designed with team-facing **sharing of outputs**: finished artifacts can be published to a link, gated by password or specific users, or made fully public; a Pro tier adds per-artifact access management "across your team."[^1][^10] I found **no evidence** of real-time multi-user co-editing of the same conversation (e.g., two humans in one live thread) — this is UNVERIFIED; nothing in the sources confirms or denies it. No mobile app was found for MindsHub Cowork (desktop macOS/Windows + web only), unlike Anthropic's Claude Cowork which has a mobile beta.[^2][^8]

## Information architecture

The left-hand navigation is reconstructed from two sources that only **partially overlap** — they do not agree on one identical set, so each item below is listed with exactly where it came from, and approximated labels are marked as such.

**Confirmed first-party** (from the `mindshub.ai` homepage demo widget, in the order the copy appears):
- **Projects** — "Group work, set instructions, and keep its data and artifacts together," shown with a switchable list ("Default project," "Board metrics & dashboards," "GTM signal & feedback").
- **Scheduled Tasks** — "Cowork runs these on the cadence you set, then drops the results in the task," corroborated elsewhere on the same page ("Set a cadence and Cowork runs the work on schedule — daily briefings, weekly summaries, recurring audits"). The site never shows a literal nav-label string for this item, only descriptive copy — "Scheduled Tasks" is my paraphrase, so treat the *label* as approximated even though the *feature* itself is confirmed first-party.
- **Artifacts** — "Documents, dashboards, and apps Cowork produced. Publish to share a live URL," shown with a live count ("5 artifacts"). Label corroborated by the video's spoken narration ("artifacts").
- **Connected Apps & Data** — "Connect a source once. Secrets go into a vault, scoped per connection — the agent never sees a raw key." No literal nav label shown; "Connected Apps & Data" / "Connectors" is approximated from the descriptive copy, partially corroborated by the video's spoken "connected apps."
- **Memory** — "Rules, lessons, and saved context Cowork can reuse — yours to inspect and edit," shown with an example rules list. Video says "memory settings."
- **Skills** — "Teach a skill once; Cowork recalls it when the work fits — no relearning." Label corroborated directly by the video ("skill libraries").
- **Settings** — "Cowork configuration and workspace preferences." Corroborated by the video, which navigates into Settings → Agent.

**Video only, not found on the first-party site as fetched:**
- **Channels** — named explicitly in the YouTube walkthrough's spoken sidebar list ("you have projects, artifacts, connected apps, channels, memory settings, skill libraries") but this word does not appear anywhere in the fetched homepage text. It is plausible — the `cowork-server` backend schema has `channel_*` tables (channel installations, bindings, sessions, events) — but that is an inference from the backend data model, not a confirmed sidebar entry. Marked UNVERIFIED as a UI item specifically, even though the underlying capability (some kind of channel/integration surface) is real.[^6][^7]

Note also that the video separately says, later and independently of its spoken sidebar list, "we have the scheduled tasks too, but I'm not going to show that one right now" — this confirms scheduled tasks as a real feature from the video's own mouth, but the video's own *sidebar-narration* line doesn't include it, so the two sources don't even fully agree with themselves on one consistent enumeration. This is the reason the "agreeing sources" framing was dropped in favor of item-by-item provenance.[^1][^7]

The main pane centers on a running or completed **task**: the user briefs a goal in plain language, and the pane fills with the agent's narrated progress and a final artifact, not a raw scrolling chat transcript — the vendor is explicit about this design choice: "MindsHub turns an agent's output into things you can use — documents, dashboards, apps, code — not a scrolling transcript."[^1] I could not independently confirm the exact pixel position of the composer (top vs. bottom, persistent vs. inline) — marked UNVERIFIED; the video shows the user typing a brief and pressing Enter but doesn't linger on the input box's placement.[^7]

## The durable unit

The durable container a user returns to is the **Project**: it groups instructions, connected data sources, memory/rules, and produced artifacts together, and is explicitly the unit of organization ("Group work into projects, pin what matters, and share published artifacts with your team by link").[^1] Within a project, individual **conversations/tasks** are the work sessions (DB schema: `conversations` linked to a `project`, `messages` linked to a `conversation`), but the thing a user is described as coming back to is not the conversation log — it's the **artifact** the conversation produced (a document, dashboard, app, or piece of code), which is stored and listed independently and can be published to a durable URL.[^6][^1] There is also a `pins` table explicitly for user-pinned conversations/artifacts, i.e., a deliberate "keep this reachable" mechanism separate from chronological order.[^6] Memory (rules/lessons files) is a third durable layer, persisting across conversations and, notably, shared across different agent harnesses.[^7][^11]

## Multiple participants

MindsHub Cowork does not present multiple simultaneous AI personas in one thread. Instead it offers **two interchangeable "agent harnesses"** — **Anton** (default; a "doing agent" optimized for producing a finished artifact from an open-ended brief — research, analysis, reports, dashboards, apps) and **Hermes** (an "orchestration harness," positioned for multi-step, long-running, and scheduled workflows).[^1][^11] The user switches harness from a dropdown in Settings → Agent; switching preserves the same workspace, project data, artifacts, and memory.[^1][^7] Separately, and orthogonally, a **Model Router** lets the user pick different underlying LLMs for different roles within a single harness run — a "planning model," a "routing" model, and a "coding model" were all independently configurable per the demo, drawing from Claude, GPT, Gemini, Grok, Meta's Muse Spark, Kimi, DeepSeek, Qwen, and GLM, plus any OpenAI-compatible local endpoint (LM Studio was demonstrated live).[^1][^7][^2] So "telling agents apart" in this product means picking a harness (Anton vs. Hermes) and, underneath that, picking which model handles which step — not distinguishing between named chat participants in a shared thread. See Technical internals §1 and §9 below for what actually distinguishes a harness at the code level, and why "harness" does **not** mean "parallel agents."

## While it is working

The backend streams agent responses to the client over **Server-Sent Events** on `POST /responses/`, explicitly supports **cancellation** (`/responses/cancel`) and **late-join tailing** (`/responses/tail`) — meaning a user can navigate away mid-generation and reattach to the same in-progress stream later or from elsewhere.[^6] The demo video shows the user submitting a brief, then a task view showing "the progress" as the agent works, ending in a finished artifact the user opens separately.[^7] The product also advertises an isolated/reproducible code-execution "scratchpad" the agent uses to do work, described as a visible, inspectable step (the Anton repo calls this "the execution scratchpad, which can dynamically become whatever Anton needs for the task").[^11] I did **not** independently view a live screenshot of the in-progress state, so I cannot confirm the exact visual form (streaming text vs. a discrete step list vs. collapsed/expandable reasoning) — this is inferred from server capabilities plus the narrated video, not directly observed, and is marked UNVERIFIED for exact layout. The exact server-side mechanics behind this — request/response shapes, what a reconnect actually replays — are read from source and given in full in Technical internals §3 below.

## History and retrieval

Retrieval is structured, not (as far as I found) full-text-search-driven. Conversations live inside projects (`conversations` table scoped to `project`), artifacts are separately listed per project with a visible count ("5 artifacts"), and a dedicated `pins` table lets a user explicitly pin conversations or artifacts for quick return.[^6][^1] Memory (rules/lessons) is a further retrieval layer — described as "self-learning": the agent extracts and stores facts/preferences automatically across sessions, viewable and (per the vendor) inspectable/editable by the user, though the video's presenter notes the files "aren't really designed to be edited manually" despite being visible.[^7][^1] I found **no explicit mention of a full-text search box** across conversation history in any source fetched — this is a gap in the evidence, not a confirmed absence; I flag it as UNVERIFIED rather than assuming search doesn't exist. (There is a `cowork/api/v1/endpoints/search.py` file in the backend, confirming *some* server-side search endpoint exists — but I did not fetch that file's contents, so what it searches over is UNVERIFIED.)

## Layout specifics

- **Panel structure / sidebar contents**: see Information architecture above for the full, per-item-sourced breakdown. Confirmed first-party: Projects, Scheduled Tasks (feature confirmed, label approximated), Artifacts, Connected Apps & Data (label approximated), Memory, Skills, Settings. Confirmed only in the video, not on the fetched first-party site: Channels (plausible given backend `channel_*` tables, but not a confirmed UI item).[^1][^7][^6]
- **Composer location**: not independently confirmed (UNVERIFIED) — the video shows text entry and Enter-to-submit but not a clear still of the box's screen position.[^7]
- **Empty state**: the marketing homepage shows a pre-populated demo ("Default project" with five example finished-task cards: a KPI dashboard, a feedback memo, an expenses spreadsheet, a scheduled morning brief, a market-sizing briefing) — but this is a sales-simulated widget, not necessarily what a real first-run user sees.[^1] The actual documented first-run flow is: install → create free account (5M MindsHub Air tokens/month) → sign in → Model Router is pre-wired with a default model → "brief your first task in plain language."[^2] The literal visual of a truly empty project (no history, cursor in the composer) was not captured in any source — UNVERIFIED.
- **Density**: not addressed in any source fetched — UNVERIFIED, not found.

## Technical internals

The coordinator asked for nine specific extractions from source, with real signatures and file paths. Everything below is read from the actual `cowork-server` and `anton` source trees on GitHub (not the marketing site), file paths given exactly as found. Where the docs and the code disagree, that is stated plainly.

### 1. The `HarnessProvider` protocol

This is the actual, complete contents of `cowork/harnesses/base.py` in `mindsdb/cowork-server` (87 lines) — reproduced verbatim because a downstream interface is being frozen against it:[^16]

```python
from dataclasses import dataclass
from typing import AsyncIterator, Literal, Protocol
from typing_extensions import TypedDict
from cowork.models.conversation import Conversation
from cowork.models.skill import Skill

class TextInputBlock(TypedDict):
    type: Literal["text"]
    text: str

class FileInputBlock(TypedDict):
    type: Literal["file"]
    path: str
    filename: str

@dataclass(frozen=True)
class ChannelContext:
    """Origin of a turn that arrived via a chat channel (Telegram, Slack, ...).
    None on the harness call means the turn came from the desktop UI. Harnesses
    use it to swap desktop-oriented prompt guidance for chat/support-mode
    guidance; harnesses without channel-aware prompts accept and ignore it.
    """
    channel_type: str
    is_group: bool = False
    display_name: str | None = None
    instructions: str | None = None

class HarnessProvider(Protocol):
    id: str
    label: str
    formatter: AsyncIterator[str]
    # Whether this harness is offered in org (multi-tenant) deployments.
    supports_org_mode: bool

    async def stream_response(
        self,
        *,
        conversation: Conversation,
        input: list[TextInputBlock | FileInputBlock],
        disabled_connections: list[dict] | None = None,
        trace_tags: list[str] | None = None,
        trace_metadata: dict[str, str] | None = None,
        channel_context: ChannelContext | None = None,
    ) -> AsyncIterator[str]:
        ...

_registry: dict[str, type[HarnessProvider]] = {}

def register(cls: type[HarnessProvider]) -> type[HarnessProvider]:
    _registry[cls.id] = cls
    return cls

def get_harness(name: str) -> HarnessProvider:
    cls = _registry.get(name)
    if cls is None:
        available = ", ".join(_registry) or "none"
        raise ValueError(f"Unknown harness {name!r}. Available: {available}")
    return cls()

def available_harness_ids() -> list[str]:
    from cowork.common.settings.app_settings import get_app_settings
    org_mode = get_app_settings().tenancy_mode == "org"
    return [
        hid for hid, cls in _registry.items()
        if not org_mode or getattr(cls, "supports_org_mode", True)
    ]
```

**This is a discrepancy worth stating plainly, not smoothing over.** The `cowork-server` README describes the protocol in prose as exposing "streaming responses, skill sync, and memory operations."[^6] The actual `Protocol` class has exactly **one** abstract method — `stream_response` — plus four attributes (`id`, `label`, `formatter`, `supports_org_mode`). There is no `sync_skills(...)` or `recall_memory(...)` on the interface itself. Registration is a plain dict keyed by `cls.id`, populated via the `@register` class decorator; `get_harness(name)` looks it up and instantiates it; `available_harness_ids()` filters the registry by `supports_org_mode` when the server is running in multi-tenant ("org") mode. The `harness` **user setting** (mentioned in the README) selects which registered id `get_harness()` is called with.

Where does the "skill sync and memory operations" language come from, then? A sibling package, `cowork/harnesses/memory/` (files: `adapter.py`, `layout.py`, `migration.py`, `registry.py`, `runtime.py`, `store.py`), exists alongside `harnesses/anton_harness/` and `harnesses/hermes_harness/` in the same directory tree.[^17] The straightforward reading is that skill sync and memory are handled by this shared support package that harness implementations (e.g., `anton_harness/harness.py`) call into directly, not by a method on `HarnessProvider` itself — i.e., "agent-agnostic" in practice means "every harness happens to import the same helper module," not "the interface enforces a shared memory contract." I did not fetch the contents of those six files, so the exact shape of that shared layer is UNVERIFIED beyond its file names; only `base.py`'s actual Protocol is quoted verbatim above.

### 2. The structured/filesystem split

Confirmed directly from the `cowork-server` README and `docs/DESIGN.md`.[^6][^15] Two storage layers, split by kind of data:

- **SQLite** (`~/.cowork/cowork.db`, override `DATABASE_URI`), via **SQLModel** (SQLAlchemy + Pydantic) with **Alembic** migrations (`cowork/db/alembic/versions/`; startup runs `alembic upgrade head`, and the migration graph must have exactly one head). Tables: `projects`, `conversations`, `messages`, `message_events`, `files` (metadata only), `schedules`/`schedule_runs`, `settings` (Fernet-encrypted for secrets), `pins`, `channel_*`. All use UUID primary keys with auto-tracked `created_at`/`modified_at`.
- **The filesystem**, under `~/.cowork/`: `skills/<slug>/SKILL.md` (canonical skill store), `projects/<name>/` (working directory + `skills/` symlinks + `.anton/` private workspace, itself containing `artifacts/<slug>/{metadata.json, files}`, `memory/`, `context/`), `files/<file-id>/<filename>` (uploaded file bytes), `data-vault/<engine>/<connection-name>/` (encrypted connector credentials).

**Why the split, per `docs/DESIGN.md`** (fetched verbatim): the design explicitly moves *away* from the predecessor's purely file-based architecture toward "database storage rather than relying on a file-based storage system," specifically because SQLite (with a stated option to move to Postgres later) gives "better scalability and performance, especially as the number of users and conversations grows" — the DESIGN doc frames this as a deliberate hardening pass, alongside removing unused endpoints and adding an OpenAI-compatible Files API to replace an older `/attachments` design.[^15] The `cowork-server` README states the general rule of thumb directly: "Structured data that benefits from querying and relationships — conversations, messages, settings, schedules — lives in SQLite. Components that are inherently file-based — project working directories, agent artifacts, harness-managed memory, connector vault credentials, and skills — remain on the filesystem by design." Skills specifically **used to** live in a DB table and were deliberately moved back to canonical `SKILL.md` files "so they can be edited, uploaded, and distributed per project" — the one case of the split going the *other* direction.[^6]

### 3. SSE `POST /responses`, `/responses/cancel`, `/responses/tail`

Read directly from `cowork/api/v1/endpoints/responses.py` and `cowork/schemas/responses.py`.[^29][^30] The module docstring states the model plainly: **streaming turns run detached**. `POST /responses/` starts a background producer that writes to a per-turn in-memory buffer (owned by a `RunHandle`, tracked in a `registry`); the HTTP response is just a tail of that buffer starting at seq 0. **Closing the connection does not stop the run** — only an explicit `POST /responses/cancel` halts the producer.

Request shape (`ResponsesRequest`, Pydantic model):
```python
class ResponsesRequest(BaseModel):
    input: str | list[Message] | None
    conversation: str | None       # conversation ID; omitted → new conversation
    project: str | None            # project name, for a new conversation
    project_id: UUID | None
    model: str | None
    stream: bool | None = False
    attachment_ids: list[str] | None
    disabled_connections: list[DisabledConnection] | None
    trace_tags: list[str] | None
    trace_metadata: dict[str, str] | None
```

Response/event shapes: a `Response` object (`id="resp-{uuid}"`, `object="response"`, `created_at`, `status` ∈ {`created`, `in_progress`, `completed`}, `error`, `model`, `output: list[ResponseOutput]`); streamed deltas are `StreamingResponse{type, sequence_number, response}` where `type` is one of `response.created` / `response.in_progress` / `response.output_text.delta` / `response.completed`, and a delta's `response` field is a `ResponseDelta{item_id, type="response.output_text.delta", delta}` — i.e. the actual incremental text chunk. Separately, a `Role`-adjacent set of **thought event** types is defined for tool/scratchpad activity visible to the client: `thought.scratchpad.start/progress/result/end`, `thought.memorize.start/end`, `thought.recall.start/end`, `thought.progress`, `thought.context_compacted`, and the harness-agnostic `thought.tool_call.start/progress/end`. These are explicitly noted in source as "specific to the Anton harness at the moment" (except the generic `tool_call` ones) — i.e. what a client actually renders while something is generating is this typed event stream, not just raw text deltas.[^30]

`GET /responses/tail?conversation_id=...&from_seq=<int>` is the reconnect path: "replay from `from_seq` then live-tail to the terminal record." Every buffered SSE record with `seq >= from_seq` is replayed, then the connection continues live until the run's terminal event; `from_seq=0` (the default) replays the entire turn from the start. A companion `GET /responses/in-flight` / `in-flight-list` lets a client cheaply check whether a conversation has a live producer before opening a `/tail` connection at all — explicitly "so the renderer can decide whether to open a /tail on mount" and "sync stream state across clients/boots," implying more than one client (e.g. desktop app and a browser tab) can in principle tail the same in-flight run.[^29]

`POST /responses/cancel {conversation_id}` halts the producer and returns `{cancelled: bool, conversation_id}`; a conversation with no registered in-flight handle returns 404, deliberately indistinguishable (by design, per an in-code comment) from a foreign-tenant's conversation id, "so a foreign-org id is indistinguishable from an unknown one (no existence leak)."[^29]

One more detail worth carrying into the security discussion in §9 / "What Vela should not take": the SSE response headers are explicitly set to `Cache-Control: no-store` (not merely `no-cache`), and the in-code comment gives the reason verbatim — "a chat stream can carry secrets the model echoed (e.g. a raw API key embedded in generated scratchpad code)." The MindsHub engineers' own comment acknowledges that a secret **can** end up in model-generated output despite the credential-vault design (§8) — that's a real, code-level admission that the vault boundary is not airtight against the model itself leaking a fetched secret back out through generated code, only against the model being handed the raw key directly.[^29]

### 4. The scheduler

Model shapes, from `cowork/models/schedule.py`, read verbatim:[^18]

```python
class Schedule(BaseSQLModel, table=True):
    __tablename__ = "schedules"
    title: str
    prompt: str                          # the prompt to run on each execution
    cadence: str                         # once | hourly | daily | weekly
    timezone: str = "UTC"
    next_run_at: datetime
    enabled: bool = True
    project_id: UUID                     # FK → projects.id
    model: str                           # model identifier to use for execution
    last_run_at: datetime | None
    last_result_conversation_id: UUID | None   # FK → conversations.id
    last_error: str | None
    missed_runs: int = 0                 # count of runs missed while scheduler was offline
    org_id: str | None
    created_by: str | None

class ScheduleRun(BaseSQLModel, table=True):
    __tablename__ = "schedule_runs"
    schedule_id: UUID                    # FK → schedules.id
    started_at: datetime
    finished_at: datetime | None
    duration_ms: int | None
    status: str                          # running | success | failed
    error: str | None
    conversation_id: UUID | None         # FK → conversations.id
    is_manual: bool = False              # True if triggered via a run-now endpoint
```

**What one run does**, from `cowork/services/schedules.py`'s `ScheduleRunService`:[^19] `create_run(schedule_id, is_manual=False)` inserts a `ScheduleRun` row with `status="running"` and `started_at=now`. `set_run_conversation(run_id, conversation_id)` attaches the run's conversation as soon as it's known, explicitly "before the turn executes — so the UI can open a run that is still in flight." `finish_run(run_id, conversation_id=None, error=None, status=None)` then sets `finished_at`, computes `duration_ms`, and sets `status` to `failed` if an error was passed, else `success`. Two guard methods gate concurrency: `has_running_run` (blocks a new *cron* run from overlapping one already `running`) and `has_active_run` (any in-flight run, manual or cron — drives the UI's "running" indicator). `last_successful_finish` is a "freshness guard" so the scheduler can skip a due slot that just ran manually. `reap_orphaned_runs()` — called once on boot — marks every `ScheduleRun` still stuck in `running` as `failed` with the message "Run orphaned by a server restart before it completed," because a crash mid-run would otherwise wedge that schedule forever (the due-check skips schedules with a running run). I did **not** locate the literal 30-second polling-loop source file itself (only this service layer it presumably calls) — the cadence and existence of the loop are confirmed by the `cowork-server` README's own description, but its exact implementation file is UNVERIFIED.[^6][^19]

### 5. The Projects model

`cowork/models/project.py` — the `Project` table is small: `name` (str, ≤255 chars), `path` (str, ≤1024 chars — "Path to the project directory on the server"), `is_active` (bool, default True), `org_id`, `created_by`.[^20] The "general" default project is not a special row shape — it's a **fixed, hardcoded identity**, from `cowork/services/projects.py`:

```python
GENERAL_PROJECT = "general"
GENERAL_PROJECT_ID = UUID("00000000-0000-0000-0000-000000000001")
```

It is seeded by an init migration and cannot be renamed (`update_project` raises `ValueError("Cannot rename the General project")`) or deleted (`delete_project` raises `ValueError("Cannot delete the General project")`) via the service layer. If the currently-active project is ever deleted, the General project is reactivated as a fallback. In multi-tenant ("org") deployments, `ensure_general_for_scope()` performs a one-time conditional claim of the seeded General row (`org_id IS NULL → org_id = <this org>`) so each org effectively gets its own General project without a race on first request.[^20]

**On-disk layout and the boundary between the working directory and the private agent workspace**: a project's `path` is a direct child of `COWORK_PROJECTS_DIR` (name-sanitized: disallowed characters stripped, hyphen-runs collapsed, 48-char max, Windows-reserved names like `con`/`aux`/`com1` suffixed with `-x`, containment double-checked so a project directory can never escape the projects root).[^20] Two zones exist inside it, per the `cowork-server` README's directory tree:[^6]

```
<project>/
├── <user & agent files>        # working directory — visible to agents
├── skills/                     # symlinks to skills enabled for this project
│   └── <slug> -> ~/.cowork/skills/<slug>
└── .anton/                     # private agent workspace
    ├── artifacts/<slug>/{metadata.json, files}
    ├── memory/
    └── context/
```

The README states the access boundary explicitly: "Agents (via their harness) have read/write access to their project's working directory **and** the private `.anton/` subdirectory. They do not access the SQLite database directly — all DB interaction flows through the service layer."[^6] So the boundary is not "working dir visible, `.anton/` hidden from the agent" — the agent can read/write **both**; the boundary that actually matters is "agent touches the filesystem and the service layer; agent never touches SQLite directly." One nuance caught by reading the actual `create_project()` method: a `_scaffold()` helper that would `mkdir` the `.anton/` directory and touch `.anton/anton.md` exists in `projects.py`, but the call site is commented out (`# self._scaffold(path)`) with a `# TODO: Move this. This should only be done when using Anton` note above it — meaning, in this snapshot of the source, a newly created project's `.anton/` scaffold is **not** guaranteed to be created at project-creation time by this code path; it may be created lazily elsewhere (e.g. by Anton itself on first run) or this is a genuinely incomplete migration step. I could not verify which; flagged as UNVERIFIED rather than assumed.[^20]

### 6. Skills

The frontmatter/body format is not MindsHub-proprietary — it's the public **Agent Skills** specification at `agentskills.io`, confirmed by fetching the spec directly:[^22] a skill is a directory containing at minimum a `SKILL.md` file with YAML frontmatter followed by Markdown. Required frontmatter fields: `name` (1–64 chars, lowercase alphanumeric + hyphens only, no leading/trailing/double hyphens, **must match the parent directory name**) and `description` (1–1024 chars, should state both what the skill does and when to use it). Optional fields: `license`, `compatibility` (environment requirements), `metadata` (a free-form string→string map), `allowed-tools` (experimental, space-separated pre-approved tool list). The Markdown body is the instruction text (recommended under 500 lines, with `scripts/`, `references/`, and `assets/` as conventional optional subdirectories); the spec describes a "progressive disclosure" loading model — `name`+`description` (~100 tokens) loaded for every skill at startup, the full body loaded only when a skill activates, and `scripts/`/`references/`/`assets/` loaded only as needed.

Cowork's own `Skill` model, `cowork/models/skill.py`, is literally a subclass of that spec's reference implementation: `class Skill(AgentSkill)` where `AgentSkill` is imported from `anton.core.tools.skill_format` — the class docstring reads "Cowork's alias for the agentskills.io in-memory model."[^21] Cowork layers its own product-specific fields into the spec's generic `metadata` map rather than extending the schema: `display_name`, `created_at`, `updated_at`, `enabled` (default-on; only an explicit `metadata["enabled"] == "false"` disables a skill), and `projects` (a comma-separated list of project ids/names the skill is distributed to). A separate, explicitly archived `SkillLegacy` table (`__tablename__ = "skills"`, columns `label`, `name`, `description`, `when_to_use`, `instructions`) is kept read-only "as a backup and as the source for the one-time file migration" — the pre-file-based DB-row format described in the main README.[^21][^6]

**Exact mount point**, from the `cowork-server` README's directory tree (already partially quoted above): the canonical store is `~/.cowork/skills/<slug>/SKILL.md`; a project that has a skill enabled gets a **symlink** at `<project>/skills/<slug>` pointing at that canonical folder. `ProjectService.create_project()` and `update_project()` both call `reconcile_project(path, skills)` from `cowork/services/skill_links.py` to (re)create these symlinks — but only "when `not self.session.scope.org_mode`," i.e. the README's statement that "skill symlink distribution is desktop-only" is confirmed directly in the service code, not just asserted in prose.[^20][^6]

I could **not** locate a `docs/SKILLS.md` file anywhere in the `cowork-server` repository despite it being referenced by name in the repo's own README and directory-tree comments ("see `docs/SKILLS.md`"). Direct listing of the `docs/` folder on the `main` branch shows exactly two files — `DESIGN.md` and `SERVER_MIGRATION.md` — no `SKILLS.md`.[^6] This looks like a stale internal cross-reference in the repo's own docs (a file that was renamed, moved, or never committed), not a fabrication on my part; I'm reporting the gap rather than inventing the file's contents. Everything above about the skill format is instead sourced from the public `agentskills.io` spec plus the actual `skill.py` and `projects.py` source files.

### 7. Artifacts and publish-to-URL

**The artifact record.** Read from `cowork/services/artifacts.py` (1,037 lines; core logic quoted/paraphrased from what was fetched).[^23] An artifact is a folder — `<project>/.anton/artifacts/<slug>/` — containing a `metadata.json` plus user files; there is no separate DB table for artifacts, they are discovered by scanning the filesystem (`_scan_artifact_dirs()` walks every registered project's `.anton/artifacts/` directory). Recognized types (`ARTIFACT_TYPES`): `html-app`, `document`, `dataset`, `image`, `mixed`, `fullstack-stateless-app`, `fullstack-stateful-app`, mapped to a display `kind` (Dashboard/Document/Data/Image/Bundle/App). The card shape returned to the UI (`card_for_folder()`) includes `id`, `slug`, `title`, `description`, `type`, `kind`, `ext`, `updated` (human string), `mtime`, `live` (mtime < 300s ago), `fileCount`, `publishedUrl`, `modified` (a stale-since-publish flag), and owner-side access fields (`accessMode`, `accessProtected`, `accessEmails`, `orgAllowed`, `artifactKey`) — explicitly never including the plaintext password to non-owners. "Fullstack" artifacts (a backend + frontend app, not just a static HTML file) carry a `port` in `metadata.json`; previewing one auto-launches the backend via Anton's own launcher (`anton.core.artifacts.backend_launcher.launch_artifact_backend`) if it isn't already listening on that port, injecting only the specific datasource secrets the artifact declared (read from the vault) into that spawned subprocess's environment — not the cowork server's own process environment.

**How publishing works.** Read from `cowork/services/publish.py` (702 lines).[^24] `publish_artifact(raw_path, password=None, access=None)` resolves the publish target (the primary file for static artifacts, the whole directory for fullstack ones — Markdown is rendered to a throwaway `index.html` first via the `markdown` package), then calls `anton.publisher.publish(...)`, which POSTs the bundle to a MindsHub-hosted endpoint (resolved via `_resolve_publish_endpoint`, defaulting to the account's configured Minds URL/key, overridable by the `ANTON_PUBLISH_URL` env var) and gets back a `view_url` and `report_id`. The result is written to a per-artifact-folder `.published.json` record: `{report_id, url, artifact_key, last_md5, published_mtime, published: true, ...access fields}` — this file **never** enters the published bundle itself (kept local, owner-only). Access control is versioned: `password` and `restricted` (email-allowlist) modes each carry their own version counter (`pwd_version`/`access_version`) that bumps only when the password or list actually changes, invalidating previously issued viewer grants. Unpublishing is a **soft delete**: `entry["published"] = False` is set but `report_id` is retained so a later re-publish can reuse the same public URL. `update_artifact()` re-publishes in place, preserving the existing URL and access settings by reconstructing them from `.published.json`. `list_versions()` / `activate_version(md5)` expose a full version history and rollback against the hosted publish backend. `compute_publish_md5()` recomputes a content hash to drive the "modified since publish" badge without needing a live network round-trip for the common case (mtime-based cheap gate first, exact md5 comparison only when the mtime moved).

### 8. Connectors and the scoped credential vault

**How the boundary is actually enforced, not just asserted.** Three concrete mechanisms, read from source:

1. **Storage separation.** Connector credentials live in a filesystem vault (`~/.cowork/data-vault/<engine>/<connection-name>/`, `LocalDataVault` from `anton.core.datasources.data_vault`), separate from the `settings` DB table (which Fernet-encrypts API keys/preferences but is a different store).[^6][^26] `cowork/services/connectors/persist.py`'s `persist_connection()` is "the single place that writes a connection to the vault" — every save path (form-based connect flow, OAuth callbacks) funnels through it, and secret fields are explicitly marked via a `secure_keys` parameter passed to `vault.save(...)`, distinguishing them from non-secret fields like a human-assigned `_label`.[^26]
2. **Concurrency safety, not just intent.** `cowork/services/connectors/vault_lock.py` maintains a process-wide `dict[(engine, name), threading.Lock]` registry (`lock_for`/`discard_lock`) so every read-modify-write against a single connection's vault record — across *different* call sites that don't share a class (an OAuth callback and `persist_connection()` both use it) — serializes against each other, preventing one save from silently reverting a concurrent one.[^25]
3. **Runtime injection point, per the Anton README's own description of `handle_connect_datasource`**: when the LLM asks to use a datasource via the connect tool, the vault is read **server-side** and the credentials are injected directly into the scratchpad subprocess's **environment variables** — not into the LLM's prompt/context. The model sees only the datasource *name*, never the raw secret value.[^11][^28] This is an architectural enforcement (the secret literally never becomes part of the token stream sent to the model), not a prompt-level instruction telling the model to behave.

**A caveat the MindsHub engineers themselves flag in code**, worth stating alongside the above rather than omitting: the SSE response headers on `/responses/` are set to `Cache-Control: no-store` specifically because, per an in-source comment, "a chat stream can carry secrets the model echoed (e.g. a raw API key embedded in generated scratchpad code)."[^29] So the vault boundary stops a raw key from being *handed to* the model — it does not by itself stop the model from *re-emitting* a secret it obtained some other way (e.g. scraped from a web page, or a credential a user pasted directly into chat) inside generated code that then streams back to the client. The mitigation for that specific case is "don't cache the stream," not "the secret can't leak" — a narrower and more honest claim than "credentials never see the model."

### 9. The memory architecture: cortex, hippocampus, episodes, consolidator

This is Anton's memory system, described in unusual "brain-inspired" terminology by the project itself. Two independent sources agree closely on the module-to-concept mapping: a nested developer README inside the `anton` repo (`anton/README.md`, fetched verbatim from GitHub — note this is a *second*, more technical README living inside the top-level `anton` repo's own `anton/` package directory, distinct from the repo's top-level marketing README) and a hands-on blog tutorial published on MindsHub's own blog.[^27][^28]

The system has seven "brain-mapped" components, each a real source file under `anton/core/memory/`:[^27]

| File | Role | Anton's own brain analogy |
|---|---|---|
| `base.py` | `Engram` dataclass + `HippocampusProtocol` (structural interface) | — |
| `hippocampus.py` | `Hippocampus` class — file-backed store for one scope (global or project) | Hippocampus (episodic storage) |
| `cortex.py` | `Cortex` class — coordinates both `Hippocampus` instances, decides what loads into context | Prefrontal Cortex (executive control) |
| `episodes.py` | `Episode` + `EpisodicMemory` class | Medial Temporal Lobe (episodic) |
| `consolidator.py` | `Consolidator` class — "sleep-replay" → new Engrams | Sleep-driven memory consolidation |
| `cerebellum.py` | `Cerebellum` class — per-cell supervised error learning | Cerebellum (forward-model error correction) |
| `acc.py` | `AnteriorCingulate` class — turn-level repeated-error-pattern detection | Anterior Cingulate Cortex (error-related negativity) |

(An eighth, `skills.py` — `Skill`, `SkillStore`, `SkillStats` — is procedural memory, brain-mapped to the striatum, and lives in the same directory.) A parallel `anton/memory/` (no `core/`) directory holds legacy/orthogonal pieces explicitly *not* part of this brain-mapped system: `manage.py` (`/memory` and `/setup` command handlers), `history_store.py` (chat transcripts), `store.py` (session list), `reconsolidator.py` (one-time format migration), and `learnings.py` (a pre-Hippocampus legacy format kept only for migration).[^27]

**The Engram**, the fundamental memory-trace unit, defined in `anton/core/memory/base.py`:[^27]
```python
@dataclass
class Engram:
    text: str
    kind: "always" | "never" | "when" | "lesson" | "profile"
    scope: "global" | "project"
    confidence: "high" | "medium" | "low" = "medium"
    topic: str = ""
    source: "user" | "consolidation" | "llm" = "llm"
```
Flow: a source (user / LLM / consolidation / cerebellum / ACC) creates an Engram → `Cortex.encoding_gate()` decides whether it needs user confirmation before saving → if not, `Cortex.encode()` routes it to the correct `Hippocampus` by scope → the `Hippocampus` writes to disk under file locking (profile: atomic full rewrite; rules: inserted into the correct section of `rules.md`; lessons: appended to `lessons.md` and optionally a `topics/{slug}.md`). `base.py` also defines `HippocampusProtocol`, a `runtime_checkable` structural `typing.Protocol` — the concrete `Hippocampus` satisfies it by shape (structural sub-typing), explicitly so "alternate backends (Enterprise, cloud-synced, database-backed) can be substituted without inheriting from the file-based implementation."[^27]

**Hippocampus** retrieval/encoding methods, again read directly from the README's own method table:[^27] `recall_identity()` (reads `profile.md`), `recall_rules()` (`rules.md`), `recall_lessons(token_budget)` (`lessons.md`, budget-limited, most-recent-first), `recall_topic(slug)` (`topics/{slug}.md`), `recall_scratchpad_wisdom(token_budget)` (scratchpad-relevant "when" rules + lessons, confidence-and-recency ordered). Encoding: `encode_rule(text, kind, confidence, source)`, `encode_lesson(text, topic, source)` (both deduplicate, append-only, file-locked), `rewrite_identity(entries)` (atomic full rewrite via `.tmp` + `os.rename`).

**Cortex** methods: `build_memory_context()` assembles memories for system-prompt injection under roughly a **5,800-token budget** (about 3% of a 200K context window, per the blog tutorial's framing); `get_scratchpad_context()` combines scratchpad-relevant wisdom from both global and project scope for injection into the tool description shown to the model — "the channel the cerebellum's lessons flow through into future code generation"; `encode(engrams)` is the shared write endpoint the cerebellum and consolidator both route through.[^27][^28]

**Episodes**: every conversation turn is logged as timestamped JSONL — user input, assistant response, tool calls, scratchpad output — one file per session under `.anton/episodes/`; the LLM-facing `recall(query, max_results, days_back)` tool searches this archive.[^27][^28][^11]

**Consolidator**: described as "sleep-replay → Engrams" — runs after a scratchpad session ends, replays it via a separate, fast LLM call, and extracts durable lessons into semantic memory (routed through `Cortex.encode()`), as a fire-and-forget background task so the user isn't blocked waiting for it.[^27][^28]

**Cerebellum and ACC**, the two error-learning layers, are explicitly **not** separate storage systems — both are lesson *producers* that feed into the same Engram → Cortex.encode() pipeline. The Cerebellum observes every scratchpad cell via pre/post-execute hooks, buffers errored ones across a turn, and runs a post-mortem LLM diff at turn end (single-cell time scale). The ACC watches whole-turn event patterns (repeated tool failures, "identity sprawl" across ≥2 scratchpad names in one turn, etc.) via nine pure detector functions (turn time scale); per the README, it is "implemented as a standalone module with passing tests; not yet wired into `ChatSession`" as of the fetched snapshot — i.e. the ACC module exists in the codebase but is not confirmed to be live in the running agent loop.[^27]

**On "parallel" — and why that word does not mean parallel subagents.** The README uses "operates in parallel" repeatedly, but always to describe the Cerebellum's background post-mortem analysis running *alongside* (i.e., without blocking) the single conversational loop — never to describe multiple simultaneous task-executing agents. `ChatSession` ("the central object that everything else hangs off of... For each conversation, a new `ChatSession` is created") is a single orchestrator per conversation; it owns one `LLMClient`, one `ScratchpadManager`, and one `Cortex`.[^28] A `Scratchpad` is explicitly one **isolated reasoning environment**, "its own venv" (a long-lived Python subprocess), and the architecture diagram states a scratchpad "can request sub-scratchpads (decomposition)" — i.e. breaking one task into nested working-memory environments run in sequence by the same orchestrating loop, not spawning independent autonomous agents that act concurrently.[^27] Anton's own Windows setup instructions confirm the scratchpad subprocess has **outbound network access by design** — the installer offers to add a firewall rule, and the manual fallback is `netsh advfirewall firewall add rule name="Anton Scratchpad" dir=out action=allow program="...\.anton\scratchpad-venv\Scripts\python.exe"`.[^11] That is process isolation (a separate venv/subprocess) with permitted outbound internet access, not a security sandbox in the sense of a hardened, network-restricted boundary — see "What Vela should not take" below.

## What Vela should take

1. **A durable "Project" container above individual chat threads** — a named group that bundles a system prompt/instructions, and (optionally) which conversations belong to it, distinct from a flat, ever-growing conversation list. Concrete Vela surface: the conversation sidebar/history list, which today is presumably a flat list of chats — this would add an optional grouping/folder layer with its own per-group instructions.
2. **A transparent, user-editable memory pane, not a black box** — MindsHub stores memory as plain, inspectable rules/lessons files rather than an opaque vector store the user can't see. For a privacy-bound, single-user app this is the *safer* direction if Vela ever adds any persistent memory feature: expose it as an editable, deletable artifact in Settings, not silent background learning. Concrete Vela surface: a future "Memory" section in Settings, if built, should ship with a visible/editable file from day one.
3. **Artifacts as first-class, listable objects separate from the transcript** — code blocks, generated documents, or long outputs a model produces shouldn't only live buried in chat scrollback; giving them a name and a place to be reopened is a real usability win. Concrete Vela surface: message rendering in the conversation view — long code or document outputs could be promoted to a per-conversation "Artifacts" or "Files" list rather than only inline in the transcript.
4. **Cancel-and-reattach streaming semantics** — the `/responses/cancel` and `/responses/tail` pattern (cancel generation cleanly; be able to navigate away and back mid-stream without losing it, replaying from a `from_seq` cursor) is a concrete, low-risk backend/UI requirement worth matching in Vela's chat view and streaming indicator, regardless of anything else in this study.
5. **One dropdown to swap the "engine" without losing context** — MindsHub's harness switcher (Anton/Hermes) keeps workspace, memory, and artifacts intact across a swap, and the underlying contract for doing so is genuinely small (a single `stream_response` method, see Technical internals §1). This validates a pattern Vela's model-agnostic thesis already implies: switching the backing model/endpoint mid-conversation should not require starting over. Concrete Vela surface: the model/endpoint switcher in the composer or settings.
6. **"The agent never sees the raw key" credential handling as an explicit, user-facing promise, not just an implementation detail** — MindsHub states this outright in its UI copy, and — unlike many such claims — the enforcement is architectural (secrets are injected into a subprocess environment, never into the model's prompt; see Technical internals §8), not just a policy statement. Vela already stores credentials in the OS keychain; surfacing that guarantee in-product (e.g., in Settings copy near the endpoint/API-key fields) is a cheap trust-building win worth taking from how MindsHub communicates it — paired with the honest caveat below.

## What Vela should not take

1. **Publish-to-URL / link sharing of artifacts and per-artifact access management** — this assumes a hosted, multi-user, cloud-serving backend (a URL the artifact lives at, with password/user/public access controls, version history, and rollback). Vela is local-first and single-user; there is no "team" to share with and no server to host the link. Non-transfer.
2. **The Model Router as a hosted, billed intermediary ("MindsHub Air," provider-agnostic proxy with prepaid balances)** — this routes every request through MindsDB/MindsHub's own cloud service and account system. It directly contradicts Vela's design thesis of talking straight to llama.cpp/OpenAI-compatible endpoints the user controls, with no third party in the request path the user didn't explicitly choose.
3. **"Keeps working after you close the laptop" always-on cloud/scheduled execution** — this is explicitly server-side, cloud-resident task execution (per MindsHub's own copy: "Round-the-clock cloud runs land with the browser version"). A local-first desktop app has nothing analogous to run scheduled tasks *in the cloud* on; if Vela ever adds scheduling, it would need to be local-machine-only (app must be running), which is a materially different and much smaller feature than what MindsHub built.
4. **Third-party SaaS connectors (Gmail, Salesforce, Slack, Asana, HubSpot, BigQuery, etc.) with OAuth flows** — this is a large surface area appropriate to a "delegate your job" knowledge-work agent product, and is scope well beyond "a chat client for local and remote LLMs." Building this would be a mission change for Vela, not a UI refinement.
5. **Multi-tier commercial pricing / prepaid-balance billing UI** — a business-model concern specific to a company reselling hosted inference; not applicable to Vela, which is not described as selling inference itself.
6. **Silent, automatic ("self-learning") cross-session memory extraction as a default** — even though MindsHub frames its memory files as inspectable, the mechanism is opt-out, not opt-in: the agent decides what to remember and writes it without an explicit user action per fact. For a privacy-bound app, memory (if built at all) should default to off or explicit/user-authored, not automatically mined from every conversation.
7. **Do not import Anton's "brain-inspired" multi-module memory/scratchpad architecture as evidence that multi-agent parallelism or a hardened sandbox is already solved — neither is actually true of it, and presenting it that way would be actively misleading for a downstream sandbox design.** Two specific, code-confirmed corrections: (a) Anton is a **single-agent loop with sub-scratchpad decomposition**, not parallel subagents — one `ChatSession` per conversation, owning one `LLMClient`/`ScratchpadManager`/`Cortex`; a scratchpad "requesting sub-scratchpads" means breaking a task into nested working-memory steps run in sequence by the same orchestrator, not multiple agents acting concurrently (Technical internals §9). The Cerebellum's "runs in parallel" language describes a background *error-analysis* task, not parallel task execution. (b) Anton's scratchpad is **a venv subprocess with outbound network access by design** (the installer adds a firewall *allow* rule for it) — that is process isolation for state/dependency separation, **not a security sandbox**. Any Vela feature that runs model-generated code locally needs its own real boundary (no ambient network access, no ambient filesystem access beyond an explicit allowlist, resource limits) — Anton's scratchpad, as documented in its own source, would not itself clear that bar, and a downstream sandbox design should be built to beat it, not modeled on it.

## Evidence log

[^1]: MindsHub homepage — https://mindshub.ai/ (accessed 2026-08-14) — product description, feature copy, sidebar/demo-widget text in DOM order (Projects, Scheduled Tasks, Artifacts, Connected Apps & Data, Memory, Skills, Settings), harness and Model Router descriptions, sharing/publish language. Also fetched via `https://mindsdb.com` (same content returned — confirms domain redirect / same company) and via anchor variants `/#agents`.
[^2]: MindsHub download page — https://mindshub.ai/download (accessed 2026-08-14) — desktop app availability (macOS/Windows), "browser version coming soon," first-run flow (install → free account → 5M tokens/month → sign in → brief a task).
[^3]: GitHub org page — https://github.com/mindsdb (accessed 2026-08-14) — confirms MindsDB Inc., founded 2018 Berkeley, "same company, same team," lists real repos (mindshub, anton, cowork-server, cowork app, Query Engine legacy), backers (Benchmark, YC, NVIDIA).
[^4]: MindsHub blog index — https://mindshub.ai/blog (accessed 2026-08-14) — continuous post history from "MindsDB" branded posts through the "MindsDB is now MindsHub: same Minds, new shape" rebrand post, establishing continuity.
[^5]: MindsHub vs MindsDB explainer — https://mindshub.ai/mindshub-vs-mindsdb (accessed 2026-08-14) — origin story of the DB-embedded-ML pivot (2018→2022) and rationale for the later rebrand.
[^6]: `cowork-server` GitHub repo (root README) — https://github.com/mindsdb/cowork-server (accessed 2026-08-14) — backend architecture: FastAPI, SQLite schema (projects/conversations/messages/schedules/artifacts/pins/channel_* tables), filesystem layout under `~/.cowork/`, SSE streaming with cancel/tail endpoints, harness-adapter pattern, credential vault, scheduler loop, `docs/` directory listing (confirmed to contain only `DESIGN.md` and `SERVER_MIGRATION.md`, no `SKILLS.md`, via `https://github.com/mindsdb/cowork-server/tree/main/docs`). The `channel_*` tables are the basis for treating a "Channels" UI surface as plausible-but-unconfirmed (see Information architecture).
[^7]: YouTube: "The Open Source Claude Cowork Alternative I've Been Waiting For," channel Tech With Tim — https://www.youtube.com/watch?v=QID-QHVLYYc (accessed 2026-08-14; sponsored video, noted) — screen-recorded hands-on walkthrough: sidebar contents as spoken by the presenter ("projects, artifacts, connected apps, channels, memory settings, skill libraries"), task/progress view, artifact viewer and publish/share flow with password/user/public options, Settings → Agent harness switcher (Anton/Hermes), three-slot model configuration (planning/routing/coding), local model use via OpenAI-compatible endpoint (LM Studio), connectors (Gmail/Drive/Salesforce/Slack/Asana demoed), skill creation and slash-invocation, memory files described as self-learning and shared across harnesses, and a separate, later mention of scheduled tasks as a feature not demonstrated on screen.
[^8]: Claude Cowork product page (Anthropic) — https://claude.com/product/cowork (accessed 2026-08-14) — used only to positively rule this product OUT as a different, unrelated product from a different company (Anthropic), confirming it is not the subject of this study. Also corroborated by web-search snippets from CNBC, TechCrunch, and DataCamp headlines referencing "Claude Cowork" as an Anthropic feature (search snippets only, not separately fetched).
[^9]: Web search: "Cowork coworking space management software" — search snippets only (not fetched as full pages) returning Cobot, Coworks, Yardi Kube, Nexudus, Optix, Archie, DeskFlex — establishes the unrelated "physical coworking space" SaaS category as a name collision to rule out.
[^10]: MindsHub pricing page — https://mindshub.ai/pricing (accessed 2026-08-14) — Free vs. Pro tiers, MindsHub Air (5M free tokens/month), per-artifact access management on Pro, harness switching confirmation.
[^11]: `anton` GitHub repo (top-level README) — https://github.com/mindsdb/anton (accessed 2026-08-14; also fetched via `https://raw.githubusercontent.com/mindsdb/anton/main/README.md`) — Anton agent harness architecture: `.anton/` workspace (scratchpad, `memory/rules.md`, `memory/lessons.md`, `memory/topics/*`, `episodes/*`), credential vault, isolated code-execution scratchpad, web_search/web_fetch tool routing per provider, standalone terminal use, versioning scheme, `/connect` flow and `handle_connect_datasource` credential injection, Windows scratchpad firewall rule (outbound network access by design).
[^12]: `https://mindshub.ai/cowork` — fetched twice (accessed 2026-08-14, second fetch forced a cache bypass) — both fetches returned the same rendered text as the homepage (`mindshub.ai/`), no content unique to this path was recoverable, and it does not contradict anything cited from the homepage. Reported explicitly as an attempted, on-point fetch rather than left uninvestigated.
[^13]: `github.com/mindsdb/mindshub` (platform superproject repo) — https://github.com/mindsdb/mindshub (accessed 2026-08-14) — confirms this is the superproject pinning `frontend`, `backend/core_api`, `backend/core_agent`, `backend/data-vault` as submodules; Makefile-driven dev workflow (`make dev`, `make dev-web`, `make dist-mac`/`dist-win`, `make flush` to wipe local state); MIT license.
[^14]: `github.com/mindsdb/cowork` (Electron + React frontend repo) — https://github.com/mindsdb/cowork (accessed 2026-08-14) — confirms Electron 34 + React 19 + TypeScript + Vite 6 stack; frontend spawns `cowork-server` as a local sidecar over HTTP; dual Electron/web entrypoints sharing one component tree (`platform/host.ts` as the only sanctioned host-bridge surface); two independent OTA update channels (UI bundle via a public `mindsdb/antontron-releases` repo, Python backend via PyPI version check) so neither the desktop shell nor a new installer is required for routine updates; IPC channel table (`install:*`, `settings:*`, `auth:*`, `mindshub:login/refresh/finalize`, etc.).
[^15]: `cowork-server` `docs/DESIGN.md` — https://raw.githubusercontent.com/mindsdb/cowork-server/main/docs/DESIGN.md, fetched verbatim via WebFetch after `mcp__alex__fetch_url` returned an empty body for this specific file (confirmed consistent with the GitHub-rendered blob page at https://github.com/mindsdb/cowork-server/blob/main/docs/DESIGN.md, both accessed 2026-08-14) — architectural rationale for the app/harness separation, the move to SQLite/Postgres-capable storage from a purely file-based predecessor, and the hardened Responses/Files API design.
[^16]: `cowork/harnesses/base.py` — https://github.com/mindsdb/cowork-server/blob/main/cowork/harnesses/base.py (accessed 2026-08-14) — full verbatim source (87 lines): `TextInputBlock`, `FileInputBlock`, `ChannelContext`, the `HarnessProvider` Protocol (`id`, `label`, `formatter`, `supports_org_mode`, `stream_response(...)`), the `_registry` dict, `register`, `get_harness`, `available_harness_ids`.
[^17]: `cowork/harnesses/` directory listings — https://github.com/mindsdb/cowork-server/tree/main/cowork/harnesses (top-level: `anton_harness/`, `hermes_harness/`, `memory/`, `__init__.py`, `base.py`), https://github.com/mindsdb/cowork-server/tree/main/cowork/harnesses/memory (`adapter.py`, `layout.py`, `migration.py`, `registry.py`, `runtime.py`, `store.py`), https://github.com/mindsdb/cowork-server/tree/main/cowork/harnesses/anton_harness (`harness.py`, `scratchpad_cell_replay.py`, `settings.py`, `stream_formatter.py`, `tools.py`) (all accessed 2026-08-14) — file listings only, contents of these specific files were not fetched; used to establish that skill-sync/memory logic lives in a shared support package rather than on the `HarnessProvider` Protocol itself.
[^18]: `cowork/models/schedule.py` — https://github.com/mindsdb/cowork-server/blob/main/cowork/models/schedule.py (accessed 2026-08-14) — full verbatim `Schedule` and `ScheduleRun` SQLModel table definitions.
[^19]: `cowork/services/schedules.py` — https://github.com/mindsdb/cowork-server/blob/main/cowork/services/schedules.py (accessed 2026-08-14) — full verbatim `ScheduleService` and `ScheduleRunService` classes: `create_run`, `set_run_conversation`, `finish_run`, `has_running_run`, `has_active_run`, `last_successful_finish`, `reap_orphaned_runs`, `list_runs`.
[^20]: `cowork/models/project.py` and `cowork/services/projects.py` — https://github.com/mindsdb/cowork-server/blob/main/cowork/models/project.py and https://github.com/mindsdb/cowork-server/blob/main/cowork/services/projects.py (both accessed 2026-08-14) — `Project` table fields; `GENERAL_PROJECT`/`GENERAL_PROJECT_ID` constants; name sanitization rules; `create_project`/`update_project`/`delete_project`/`ensure_general_for_scope`; the commented-out `_scaffold()` call.
[^21]: `cowork/models/skill.py` — https://github.com/mindsdb/cowork-server/blob/main/cowork/models/skill.py (accessed 2026-08-14) — full verbatim `Skill(AgentSkill)` wrapper class and archived `SkillLegacy` table.
[^22]: Agent Skills specification — https://agentskills.io/specification (accessed 2026-08-14) — the public, third-party SKILL.md frontmatter/body spec that Cowork's `Skill` model is built on top of (per its own docstring); required/optional frontmatter fields, progressive-disclosure loading model.
[^23]: `cowork/services/artifacts.py` — https://github.com/mindsdb/cowork-server/blob/main/cowork/services/artifacts.py (accessed 2026-08-14; large file, ~700 of 1,037 lines retrieved before the response was truncated by the fetch tool) — artifact folder/metadata.json structure, `ARTIFACT_TYPES`, `card_for_folder`, preview mount (`static` vs `proxy`/fullstack-backend-launch) logic, `_ensure_backend_running`/`_launch_backend_locked` auto-launch of fullstack app backends with per-artifact datasource-secret env injection.
[^24]: `cowork/services/publish.py` — https://github.com/mindsdb/cowork-server/blob/main/cowork/services/publish.py (accessed 2026-08-14) — full publish/unpublish/version-history flow: `publish_artifact`, `unpublish_artifact` (soft-delete), `update_artifact` (in-place re-publish), `list_versions`, `activate_version` (rollback), `.published.json` record shape, access-mode versioning.
[^25]: `cowork/services/connectors/vault_lock.py` — https://github.com/mindsdb/cowork-server/blob/main/cowork/services/connectors/vault_lock.py (accessed 2026-08-14) — full verbatim per-`(engine, name)` `threading.Lock` registry (`lock_for`, `discard_lock`).
[^26]: `cowork/services/connectors/persist.py` — https://github.com/mindsdb/cowork-server/blob/main/cowork/services/connectors/persist.py (accessed 2026-08-14) — full verbatim `persist_connection` and `set_connection_label`: single write path for vault records, `secure_keys` marking of secret fields, non-destructive multi-account save behavior.
[^27]: `anton` repo, nested developer README — https://github.com/mindsdb/anton/blob/main/anton/README.md (accessed 2026-08-14; note this is a *different, more technical* file than the top-level repo README already cited as [^11] — it lives inside the repo's own `anton/` package directory) — the full brain-mapped memory architecture (seven core modules + `skills.py`, table of brain-region analogies), the `Engram` dataclass and its flow through `encoding_gate`/`encode`, `HippocampusProtocol`, Hippocampus recall/encode method signatures, Cortex method signatures, the `anton/core/memory/` vs. legacy `anton/memory/` directory split, ChatSession/Scratchpad/tool-layer architecture, the ASCII flow diagrams (including "sub-scratchpads (decomposition)"), file-locking (`fcntl.flock`) and atomic-rename concurrency notes.
[^28]: MindsHub blog: "A practical hands-on introduction to Anton" (guest post by Andriy Burkov) — https://mindshub.ai/blog/a-practical-hands-on-introduction-to-anton (accessed 2026-08-14) — independent-author walkthrough plus an appendix explicitly mapping each architectural concept to its source file (`chat.py`, `tools.py`, `scratchpad.py`/`scratchpad_boot.py`, the `memory/` module table including `cortex.py`/`hippocampus.py`/`episodes.py`/`consolidator.py`, `llm/` provider abstraction, `data_vault.py`/`datasource_registry.py`, `publisher.py`), and a step-by-step trace of "how a single turn flows" through `ChatSession` → `Cortex` → `LLMClient` → `tools.dispatch_tool` → `Scratchpad` → `episodes.py` → `consolidator.py`.
[^29]: `cowork/api/v1/endpoints/responses.py` — https://github.com/mindsdb/cowork-server/blob/main/cowork/api/v1/endpoints/responses.py (accessed 2026-08-14) — full verbatim Responses API route handlers: detached-producer/buffer/registry streaming model, `POST /responses/`, `GET /responses/in-flight` and `/in-flight-list`, `POST /responses/cancel`, `GET /responses/tail?conversation_id&from_seq`, the `Cache-Control: no-store` rationale comment, tenant-scope authorization notes (no existence leak on cancel/tail for a foreign org's conversation id).
[^30]: `cowork/schemas/responses.py` — https://github.com/mindsdb/cowork-server/blob/main/cowork/schemas/responses.py (accessed 2026-08-14) — full verbatim Pydantic schemas: `Role`, the `thought.*` streaming event-type enum, `Content`/`Message`, `Response`/`ResponseOutput`/`ResponseStatus`, `StreamingResponseEvent`/`ResponseDelta`/`StreamingResponse`, `ResponsesRequest`.

**Also fetched, low/no independent yield** (noted for completeness): `https://mindshub.ai/about` (accessed 2026-08-14 — founding story, Jorge Torres/Adam Carrigan, Culture-novels naming inspiration, $50M+ raised); `https://docs.mindshub.ai` (accessed 2026-08-14 — confirms a "Minds Cowork" docs site exists with setup/examples/API-reference sections, but subpages weren't crawled); `https://mindshub.ai/use-cases` and `https://mindshub.ai/agents` (accessed 2026-08-14 — largely client-rendered, minimal text extracted, not independently useful beyond what other pages already established); `https://github.com/mindsdb/cowork-server/tree/main/cowork/models`, `.../cowork/services`, `.../cowork/services/connectors`, `.../cowork/api/v1/endpoints`, `.../cowork/schemas`, `.../cowork/common` (accessed 2026-08-14 — directory listings only, used to locate the specific files cited above); a search for a dedicated scheduler polling-loop source file (as opposed to the `ScheduleService`/`ScheduleRunService` layer it presumably calls) did not turn one up — its exact implementation file is UNVERIFIED, only its existence and cadence (per [^6]) and the service methods it must call (per [^19]).
