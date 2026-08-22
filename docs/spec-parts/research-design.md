# Vela Spec Part — Web Search, Research Modes, Design/Canvas, Notifications, Desktop Shell

Ingestion area: web search & web fetch; research / deep-research modes (source gathering, citation,
long-run surfacing); design / canvas / visual-creation surfaces; desktop notifications; desktop app
navigation shell.

**Ground rule compliance:** every claim below is traced to a URL that was actually fetched in this
session with WebFetch. Anything not fetched is marked explicitly. No content was reconstructed from
training memory.

---

## 0. Sources

### Fetched successfully

| # | URL |
|---|-----|
| S1 | https://support.claude.com/en/articles/10684626-enable-and-use-web-search |
| S2 | https://support.claude.com/en/articles/11088861-use-research-on-claude |
| S3 | https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool |
| S4 | https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool |
| S5 | https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools |
| S6 | https://support.claude.com/en/articles/11095361-when-should-i-use-web-search-extended-thinking-and-research |
| S7 | https://support.claude.com/en/articles/14503775-mcp-web-search |
| S8 | https://support.claude.com/en/articles/12489464-use-enterprise-search |
| S9 | https://support.claude.com/en/articles/14604416-get-started-with-claude-design |
| S10 | https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design |
| S11 | https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans |
| S12 | https://www.anthropic.com/news/claude-design-anthropic-labs |
| S13 | https://claude.com/product/design |
| S14 | https://support.claude.com/en/articles/13979539-custom-visuals-in-chat-and-cowork |
| S15 | https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them |
| S16 | https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork |
| S17 | https://code.claude.com/docs/en/desktop |
| S18 | https://code.claude.com/docs/en/desktop-scheduled-tasks |
| S19 | https://claude.com/resources/tutorials/navigating-the-claude-desktop-app |
| S20 | https://www.anthropic.com/engineering/multi-agent-research-system |
| S21 | https://claude.com/blog/research (via 308 redirect from https://www.anthropic.com/news/research) |

### Unreachable / redirected

- `https://www.anthropic.com/news/research` — HTTP 308 Permanent Redirect to `https://claude.com/blog/research`.
  Cross-host redirect was not auto-followed; refetched at the redirect target (S21). **Not a failure.**

No source in this area failed outright.

---

## 1. Web search

### 1.1 Consumer surface (S1)

Claude.ai / Desktop exposes web search as a **per-chat toggle** reached from the slider icon in the
chat input dropdown. On Team/Enterprise an Owner or Primary Owner must first enable it workspace-wide
in **Admin settings → Capabilities**; only then can members toggle it per chat.

Concrete behaviours documented:

- Claude decides autonomously whether to search; the user can force it ("Search the web", "Use web
  search") or forbid it in the prompt.
- Responses carry **direct citations** with clickable source links, and Claude surfaces relevant
  quotes.
- **Image results** are part of web search — no separate setting — and are powered by **Bing**.
  Images render inline with source links.
- **Web fetch of a user-supplied URL** rides on the same toggle. The doc warns that "the entire
  article is retrieved into Claude's context window", which is why free users are told to toggle
  search off before pasting long articles.
- Claude "may use your location (inferred from your IP address)" for localized results.
- Search and fetch both count against daily usage limits.
- Listed model support: Opus 5, Sonnet 5, Fable 5, Opus 4.8, Opus 4.7, Sonnet 4.6, Opus 4.6,
  Haiku 4.5.

### 1.2 API surface — the `web_search` server tool (S3, S5)

Three tool versions:

- `web_search_20250305` — basic search.
- `web_search_20260209` — adds **dynamic filtering**.
- `web_search_20260318` — adds **response inclusion** control.

Tool definition (all optional except type/name):

```json
{
  "type": "web_search_20250305",
  "name": "web_search",
  "max_uses": 5,
  "allowed_domains": ["example.com", "trusteddomain.org"],
  "blocked_domains": ["untrustedsource.com"],
  "user_location": {
    "type": "approximate",
    "city": "San Francisco",
    "region": "California",
    "country": "US",
    "timezone": "America/Los_Angeles"
  }
}
```

Plus `allowed_callers` (all versions) and `response_inclusion` (`_20260318`+).

Loop: Claude decides to search → API runs the search server-side and injects results → repeat →
final answer with citations. **The caller never returns a `tool_result` for a server tool.**

Response block sequence in one assistant turn:

1. `text` — Claude narrating its decision.
2. `server_tool_use` with `id` prefixed `srvtoolu_`, `name: "web_search"`, `input: {query}`.
3. `web_search_tool_result` with `tool_use_id`, and `content` = list of `web_search_result` objects,
   each `{url, title, encrypted_content, page_age}`.
4. `text` blocks carrying `citations[]` of type `web_search_result_location` with fields
   `{url, title, encrypted_index, cited_text}`. `cited_text` is capped at **150 characters**.

Key mechanics:

- **Citations are always on** for web search (cannot be disabled).
- `cited_text`, `title`, `url` **do not count** toward input/output token usage.
- `encrypted_content` **must be echoed back verbatim** on later turns; missing/modified content →
  400 validation error. The API decrypts it to restore search results into context.
- `usage.server_tool_use.web_search_requests` counts searches. Pricing: **$10 per 1,000 searches**
  plus token cost of the retrieved content. Errors are not billed.
- Simple factual queries typically use 1–3 searches; comparative/multi-entity research 10+.
- Error shape: HTTP still 200; body carries
  `{"type":"web_search_tool_result_error","error_code":"..."}`. Codes: `too_many_requests`,
  `invalid_tool_input`, `max_uses_exceeded`, `query_too_long`, `request_too_large`, `unavailable`.
  A successful search with no hits returns an **empty `content` list**, not an error.
- `stop_reason: "pause_turn"` — the API can pause a long search turn. Resume by re-sending the
  assistant content unchanged, with the same `tools` array. Can pause repeatedly.
- If web search is called in the same parallel group as a client tool, `stop_reason` is `"tool_use"`
  and the search is **deferred**: it runs after you return the client `tool_result` blocks.

**Dynamic filtering** (`_20260209`+): instead of dumping every result into context, Claude writes and
runs code inside the code-execution sandbox that filters results first. `allowed_callers` defaults
to `["code_execution_20260120"]`; the API auto-provisions code execution. Set
`allowed_callers: ["direct"]` to disable it (required on models without programmatic tool calling,
and required for ZDR eligibility since dynamic filtering is not ZDR-eligible).

**Response inclusion** (`_20260318`+): `"response_inclusion": "excluded"` drops nested
`server_tool_use`/result pairs from the response when they were consumed by a completed code
execution call — purely an output-token saving for agentic loops. Default `"full"`.

**Domain filtering semantics (S5)** — these are precise and worth replicating exactly:

- No scheme (`example.com`, not `https://example.com`).
- Subdomains are **automatically included**: `example.com` covers `docs.example.com`.
- A specific subdomain **restricts** to only it: `docs.example.com` excludes `example.com` and
  `api.example.com`.
- Subpaths supported **for web search only** and match prefix-wise (`example.com/blog` matches
  `example.com/blog/post-1`). **Web fetch matches domain only** — a path entry never matches a fetch.
- `allowed_domains` XOR `blocked_domains` — both in one request → 400.
- Wildcards allowed **only in the path**: `example.com/*` valid; `*.example.com` invalid.
- Org-level restrictions compose: request-level allowlist must be a subset of the org allowlist;
  org-blocked domains are silently removed from a request allowlist.
- **Homograph warning**: Unicode lookalikes (`аmazon.com` with Cyrillic а) bypass filters. Use ASCII
  only and audit lists.

### 1.3 Government variant — web search as an MCP connector (S7)

In Claude for Government, web search is **not** a built-in toggle. It is a discrete MCP connector
added by an Owner at `claude.fedstart.com/admin-settings/connectors`. It runs inside the FedRAMP High
boundary but calls the external **Brave Search API**, transmitting "only the query string" — no
metadata, conversation history, or user identity. **Every search requires manual approval and this
cannot be disabled**; Claude shows the de-identified query before transmission so the user can
decline.

This is directly relevant to Vela: it is Anthropic's own demonstration that the search backend is a
swappable, approval-gated connector.

---

## 2. Web fetch (S4)

Versions: `web_fetch_20250910` (basic), `web_fetch_20260209` (dynamic filtering),
`web_fetch_20260309` (adds cache bypass), `web_fetch_20260318` (adds response inclusion).

```json
{
  "type": "web_fetch_20250910",
  "name": "web_fetch",
  "max_uses": 10,
  "allowed_domains": ["example.com"],
  "blocked_domains": ["private.example.com"],
  "citations": { "enabled": true },
  "max_content_tokens": 100000
}
```

Plus `use_cache` (`_20260309`+) and `response_inclusion` (`_20260318`+).

Result shape:

```json
{
  "type": "web_fetch_tool_result",
  "tool_use_id": "srvtoolu_...",
  "content": {
    "type": "web_fetch_result",
    "url": "https://example.com/article",
    "content": {
      "type": "document",
      "source": { "type": "text", "media_type": "text/plain", "data": "..." },
      "title": "Article Title",
      "citations": { "enabled": true }
    },
    "retrieved_at": "2025-08-25T10:30:00Z"
  }
}
```

PDFs come back as `{"type":"base64","media_type":"application/pdf","data":"JVBERi0x..."}` and are
processed like an attached PDF.

Citations for fetch are `char_location` blocks:
`{type, document_index, document_title, start_char_index, end_char_index, cited_text}`.
**Unlike search, fetch citations are OFF by default** — opt in with `citations.enabled`.

Critical security model — **URL validation**: the tool can only fetch URLs that already appeared in
conversation context (user messages, client tool results, prior search/fetch results). Claude
**cannot construct URLs dynamically**. URLs from container-based server tools (code execution, bash)
are also disallowed. This exists specifically to blunt data exfiltration via prompt injection. The
doc carries an explicit warning that enabling fetch where untrusted input meets sensitive data is an
exfiltration risk, and recommends disabling the tool, capping `max_uses`, or pinning `allowed_domains`.

Error codes: `invalid_tool_input`, `url_too_long` (URL > **250 characters**), `url_not_allowed`
(domain filter, private addresses, or `robots.txt`), `url_not_in_prior_context`, `url_not_accessible`,
`too_many_requests`, `unsupported_content_type` (only text, HTML, PDF), `max_uses_exceeded`,
`unavailable`. Failed fetches **do** count against `max_uses`.

Other mechanics: no JavaScript-rendered pages. Results are cached by default (`use_cache: true`);
bypassing increases latency. `max_content_tokens` truncates text (approximate; does not apply to
binary PDFs). **No per-fetch charge** — you pay only tokens. Documented token sizes: ~2,500 tokens for
a 10 kB page, ~25,000 for 100 kB, ~125,000 for a 500 kB PDF.

**Combined search + fetch**: with both tools enabled and a user naming a resource without a URL
("read the README from anthropics/anthropic-sdk-python"), Claude searches to locate it, then fetches
it.

---

## 3. Research mode

### 3.1 Product behaviour (S2, S6, S21)

- Paid plans only (Pro, Max, Team, Enterprise), on web, desktop, mobile.
- Enabled via the **`+` button** in the composer → **Research**. A blue indicator appears at the
  bottom of the chat window; clicking again disables it.
- **Web search must be on** for Research to function.
- Operates "agentically, conducting multiple searches that build on each other while determining
  exactly what to investigate next"; explores different angles automatically.
- Draws on both the web **and** internal context via connectors — Gmail, Google Calendar, Google Docs
  are the named ones.
- Output: a longer final report with "easy-to-check citations" / inline citations.
- Burns usage limits faster than plain chat because of the multi-source retrieval.
- Original launch (April 2025) was early beta for Max/Team/Enterprise in US, Japan, Brazil.

**Selection heuristic (S6)** — this is the routing rule Vela should encode:

| Mode | Trigger | Cost |
|---|---|---|
| Web search | straightforward factual query — weather, a company, news headlines | 1–2 tool calls |
| Extended thinking | complex reasoning with no need for fresh info — math, debugging, philosophy | 0 tool calls |
| Research | comprehensive gathering + synthesis, competitor comparison, updating internal docs | **5+ tool calls over 1–3 minutes** |

Extended thinking + Research can be combined so Claude plans then executes.

Progress surfacing during the run is **not documented on S2/S21** (explicitly noted as absent).
The nearest documented analogue is Cowork (§6.3): plan visible in the sidebar, per-step progress
indicators, sources drawn from, files taking shape.

### 3.2 Architecture (S20) — the implementable part

Anthropic's own engineering writeup of the multi-agent research system. This is the single most
actionable source for Vela's research mode.

**Orchestrator-worker:**

- **LeadResearcher** (Claude Opus 4 in the writeup): analyses the query, develops strategy, decomposes
  into subtasks, spawns subagents, synthesizes, decides whether another round is needed, then hands
  off to CitationAgent.
- **Subagents** (Claude Sonnet 4): independent web searches, interleaved thinking to evaluate results,
  return curated findings.
- **CitationAgent**: a separate pass over the documents + draft report that locates the exact source
  for each claim and attaches attribution.

**Two-level parallelism:** lead spawns **3–5 subagents at once**; each subagent issues **3+ tool calls
in parallel**. Reported up to **90% reduction in research time** for complex queries.

**Explicit effort-scaling rules embedded in the prompt:**

| Query type | Agents | Tool calls |
|---|---|---|
| Simple fact-finding | 1 | 3–10 |
| Direct comparison | 2–4 | 10–15 each |
| Complex research | 10+ | divided subtasks |

**Search strategy:** start with **short, broad** queries; survey the landscape; progressively narrow.
Avoid over-specific queries that return nothing.

**Memory / context durability:**

- Lead agent writes its research plan to **external memory** so it survives context truncation
  (200k in the writeup).
- Agents summarize completed phases before hitting limits.
- Fresh subagents get clean contexts; handoff happens via stored memory.
- Subagents write outputs to the **filesystem** rather than passing everything through the lead, to
  minimize loss through multi-stage summarization.

**Tool-selection heuristics given to agents:** examine all available tools first; match tool to user
intent; web search for broad external exploration; prefer specialized tools over generic; do not
misapply a tool (don't search Slack for web-only content).

**Eight prompt-engineering heuristics:** build a mental model by simulating; teach the lead to
delegate with objective/output format/tool guidance/boundaries; embed effort scaling; write distinct
tool descriptions (and let Claude rewrite bad ones); let the model diagnose its own failures (a
**40% task-time reduction** was observed); wide-to-narrow search; use extended thinking as a
controllable planning scratchpad; enable parallel tool calling.

**Token economics:** single-agent research ≈ **4×** chat tokens; multi-agent ≈ **15×** chat tokens.
On BrowseComp, **token usage explained 80% of performance variance**; tool call count explained more;
and **upgrading the model beat doubling the token budget**.

**Evaluation:** (1) 20-query small-sample loop — prompt changes swung success 30%→80%; (2)
LLM-as-judge with a single rubric call scoring factual accuracy, citation accuracy, completeness,
source quality, tool efficiency → 0.0–1.0 plus pass/fail; (3) human spot-checks for hallucinations
and source-selection bias (e.g. preferring SEO farms over authoritative PDFs).

**Production reliability:** checkpointed durable execution; resume from agent state rather than
restart; let agents adapt when a tool fails instead of hard-failing; rainbow deployments so running
agents aren't disrupted; full tracing of agent decision structure without logging conversation
content. Known bottleneck: the lead waits on subagent batches **synchronously**.

### 3.3 Enterprise search (S8)

A distinct, pre-configured **"Ask Your Org"** project for Team/Enterprise. Owners pick a Documents
connector and a Chat connector during setup (Email optional). Sources: Slack, Microsoft 365
(SharePoint/Teams/Outlook), Google Workspace (Gmail/Drive/Docs), custom connectors.

Crucially: **"Search results are generated by making MCP calls. No data from connected services are
indexed in our systems."** It is **permission-aware** — users only see what they can already access.
Results are cited. Disable org-wide via Admin Settings → Capabilities.

Positioning vs Research: enterprise search = quick retrieval from internal sources; Research = deep
multi-step web + internal.

---

## 4. Design / canvas surface

### 4.1 Claude Design (S9, S10, S11, S12, S13)

An Anthropic Labs product, **research preview / beta**, for Pro, Max, Team, Enterprise. Reachable at
`claude.ai/design` **or from the Claude Desktop sidebar**. Powered by **Claude Opus 4.7** (vision).
Enterprise defaults to **off**; admins enable under Organization settings → Capabilities → Anthropic
Labs.

**UI: two panes.** Chat on the left, **canvas** on the right. Describe → Claude generates a working
design on the canvas → iterate.

**Three iteration channels:**

1. **Chat** — broad structural change ("make the color scheme darker and more minimal",
   "rearrange the dashboard").
2. **Inline comments** — click a specific element on the canvas and request a targeted change
   ("make this button padding larger"). Faster than describing the location in prose. Known bug:
   comments occasionally fail to persist; workaround is to paste into chat.
3. **Direct manipulation** — drag, resize, align elements; edit text directly; **adjustment
   sliders/knobs that Claude itself creates** to tune spacing, color, and layout live.

**Inputs:** text prompts, image uploads, document imports (DOCX, PPTX, XLSX), a **web capture tool**
that grabs website elements for realistic prototyping, GitHub repos, design files, local codebases.

**Outputs / exports:** ZIP, PDF, PPTX, standalone HTML, organization-scoped shareable URLs, and
connector push to **Adobe, Base44, Canva, Gamma, Lovable, Miro, Replit, Vercel, Wix**. Also
**handoff to Claude Code** (local or web) with bundled specifications.

**Commands:** `/design-sync` to attach/import a design system (GitHub repo, design files, or local
codebase); `/design` to pull designs into Claude Code.

**Design systems (S10):** the org uploads source material — React component libraries, screenshots,
web flows, design files, PPTX/PDF brand docs, logos, palettes, typography. One source is enough to
start. Claude generates a **design system UI kit** containing colour palettes (primary/secondary/
accent), typography (fonts, sizes, weights), reusable components (buttons, cards, navigation), and
layout patterns (spacing, grids, page structures). Toggle **Published** to make it org-wide; all
member projects then inherit it automatically. A **Remix** button in org settings refines the system
conversationally. Claude **validates output against the design system before display** and corrects
deviations.

**Admin (S11):** any member with Design access can create/edit design systems; on Enterprise the
**Claude Design Admin** permission gates publishing, setting org defaults, and deleting. Multiple
design systems per org (different brands/sub-teams). Custom roles can scope access to departments.
Preview sandboxes use **short-lived signed tokens**, re-checked against sharing permissions on every
open; preview code is iframe-sandboxed and **cannot reach the Claude account, login, or editor**.
Analytics at Analytics → Claude Design (DAU/WAU/MAU); **audit logs not yet supported**; **no data
residency support**.

**Usage model:** counts against the *same* pooled usage limits as chat, Claude Code, and Cowork — no
separate allowance. Large codebases consume proportionally more.

**Known limits:** comment persistence, lag on very large repos, chat upstream errors requiring a tab
restart, unreliable simultaneous multi-person editing.

**Collaboration:** org-scoped sharing (private / view-only / edit), group conversations with Claude.

**Interactivity:** a static mockup can be turned into "a shareable, interactive prototype you can
test with real people."

### 4.2 Custom visuals in chat and Cowork (S14)

Beta. Claude generates custom diagrams, charts, and interactive visuals **inline in the response**,
rendered as **HTML** — the same technology as web pages, hence interactive rather than static images.

- Claude decides autonomously when a visual helps; the user can force it ("draw this as a diagram",
  "chart this data"). No toggle.
- **Ephemeral by default** and live inline as part of Claude's response, with no automatic
  persistence — the opposite of artifacts, which are "persistent and shareable from the start."
- Preservation: **Copy as image** (static snapshot), export as **.svg** or **.html**, or **convert to
  an artifact**.
- Web + desktop only; do **not** render on iOS or Android. Shared chats show visuals only to
  logged-in web/desktop recipients.
- "Opus performs the best at visualization tasks."

### 4.3 Artifacts (S15)

The canonical canvas in chat. Claude creates an artifact when content is "significant and
self-contained, typically **over 15 lines**" and is something the user will likely edit, iterate on,
or reuse.

Types: Markdown/plain-text documents, code snippets and full applications, single-page HTML sites,
SVG images, diagrams and flowcharts, interactive React components.

Mechanics: dedicated **right-side panel**; a dedicated **Artifacts section in the sidebar**;
**version selector** to switch between versions; chat-driven modification; for Markdown a direct
edit mode — highlight text → **"Edit with Claude"** → type the request. Artifacts must be explicitly
**Published** to appear in the Artifacts section. Published artifacts can call Claude via a
text-based API so viewers need no key of their own; **usage counts against each viewer's own
subscription**, and sharing is free regardless of viewer count. There is a **"Try fixing with
Claude"** button for runtime errors, MCP integration for paid plans, and **20 MB persistent storage**
for stateful published artifacts. View source, copy to clipboard, download.

### 4.4 Live artifacts in Cowork (S16)

Persistent, interactive **HTML pages** that live independently of the chat that produced them.

- Every live artifact appears in the **"Live artifacts" tab in the Cowork sidebar**, labelled
  "Cowork" to distinguish it from chat artifacts.
- They **pull fresh data from connected apps and local files** on open — a short cache serves the
  first paint, then it re-queries connectors on its own; a **refresh button in the artifact header**
  forces an update.
- **Each update saves a version**; history is reviewable and earlier versions restorable.
- Shared artifacts **use the viewer's access, not the author's** — they connect to the viewer's
  connectors.
- **They live on your computer**; switching devices does not bring them along.
- Paid plans, **Claude Desktop only** (macOS, Windows, Linux beta) — not web, not mobile.

---

## 5. Desktop notifications

Documented notification triggers (S17, S18):

1. **Task finished, session not focused** — "The desktop app sends an OS notification when a Code
   session finishes a task and you aren't currently viewing that session." (S17)
2. **CI finished** — "Claude Code also sends a desktop notification when CI finishes." (S17)
3. **Scheduled task fired** — "When a task fires, you get a desktop notification and a new session
   appears under a **Scheduled** section in the sidebar." (S18)
4. **Catch-up run started** — "Desktop shows a notification when a catch-up run starts." (S18)
5. **Dispatch task** — "You get a **push notification on your phone** when it finishes or needs your
   approval." (S17) — this one is a phone push, not a desktop OS notification, and is
   Anthropic-account-bound.

No user-facing enable/disable setting for these is documented; they read as built-in.

---

## 6. Desktop app navigation shell

### 6.1 Three tabs (S17, S19)

**Chat**, **Cowork**, **Code**.

- **Chat** — "the same Claude you know from claude.ai, plus quick entry, screenshots, dictation, and
  connectors."
- **Cowork** — multi-step work: thorough research and analysis, complex documents. Dispatch and
  longer agentic work live here.
- **Code** — Claude works directly in a codebase: reading, writing/modifying code, running commands.

**Sidebar model:** "Chats, coworks, projects, and artifacts live in one sidebar, and you can start
either from the same place." **Claude Code sessions and projects stay separate.** Code sessions filter
by status (Active/Archived) and environment (Local/Cloud); the Code sidebar also filters by project
and can **group by project**. Rename a session by clicking its title in the toolbar.

**Quick entry (macOS):** double-tap **Option** to summon Claude over whatever you're working on; it
responds in a compact always-on-top window.

Native desktop capabilities called out: screenshots / window sharing, dictation, desktop connectors,
folder access (Cowork).

Distribution: macOS universal DMG, Windows x64 and ARM64 installers, Linux beta via apt/.deb
(Ubuntu/Debian). Git for Windows is a prerequisite for the Code tab on Windows.

### 6.2 Code tab pane system (S17)

Panes: **chat, diff, browser, terminal, file, plan, tasks, subagent**, plus **iOS Simulator** on
macOS. Drag a pane by its header to reposition, drag an edge to resize, open more from the **Views**
menu in the session toolbar.

- **Browser pane** — Claude starts a dev server and previews the app to verify its own changes; works
  for frontend and backend (API endpoints, server logs). Also opens static HTML, PDFs, images, videos
  from the project; clicking such a path in chat opens it there. "Persist sessions" keeps cookies and
  localStorage across restarts. Server config lives in **`.claude/launch.json`**. Toggles in
  Settings → Claude Code. External browsing has safety classifiers on write actions in every
  permission mode, plus a domain allowlist check outside Auto/Bypass modes; killable entirely with
  the `disableBrowserExternalNavigation` managed setting.
- **Diff view** — a `+12 -1` stats indicator opens a viewer with the file list left, changes right.
  Click any line to open a comment box; Enter adds the comment; **Cmd/Ctrl+Enter submits all
  comments at once**. Claude then produces a new diff. A **Review code** button asks Claude to
  evaluate the diff and leave comments inline; scoped to compile errors, definite logic errors,
  security vulnerabilities, obvious bugs — explicitly **not** style, formatting, pre-existing issues,
  or lint-catchable things.
- **File pane** — click a file path in chat or the diff viewer to open it; HTML/PDF/image/video go to
  the Browser pane instead. Spot edits + **Save**. Warns on external modification with
  override/discard. Available in local and SSH sessions, **not cloud**. Right-click a path →
  **Attach as context** / **Open in** (VS Code, Cursor, Zed).
- **Terminal pane** — integrated, toggled with Ctrl+`.
- **Side chat** — `Cmd+;` or `/btw`. Reads the main thread's context but writes nothing back to it.
- **View modes** — Verbose vs Summary, cycled with `Ctrl+O`.
- **CI status bar** after a PR opens, with **Auto-fix** and **Auto-merge** toggles (squash merge;
  requires repo-level auto-merge). Requires `gh` installed and authenticated. **Auto-archive** on
  merge/close is a Settings → Claude Code option.

**Keyboard shortcuts (Code tab; Windows uses Ctrl for Cmd):**

| Shortcut | Action |
|---|---|
| `Cmd /` | Show keyboard shortcuts |
| `Cmd N` | New session |
| `Cmd W` | Close session |
| `Ctrl Tab` / `Ctrl Shift Tab` | Next / previous session |
| `Cmd Shift ]` / `Cmd Shift [` | Next / previous session |
| `Esc` | Stop Claude's response |
| `Cmd Shift D` | Toggle diff pane |
| `Cmd Shift B` | Toggle Browser pane |
| `Cmd Shift S` | Select an element in the Browser |
| ``Ctrl ` `` | Toggle terminal pane |
| `Cmd \` | Close focused pane |
| `Cmd ;` | Open side chat |
| `Ctrl O` | Cycle view modes |
| `Cmd Shift E` | Open effort menu |
| `1`–`9` | Select item in an open menu |

Session cycling, terminal toggle, and view-mode toggle use **Ctrl on every platform**. Pane layout,
terminal, file editor and view modes require Desktop **v1.2581.0+**.

Context: when it fills, Claude auto-summarizes and continues; `/compact` triggers it earlier.

**Computer use:** research preview, macOS + Windows, Pro/Max only (not Team/Enterprise), off by
default, needs Accessibility + Screen Recording on macOS. Per-app access tiers: **View only**
(browsers, trading platforms), **Click only** (terminals, IDEs — click and scroll, no typing or
keyboard shortcuts), **Full control** (everything else). Routing: prefer the Browser pane for web,
the iOS Simulator pane for iOS, computer use only as last resort for native apps and GUI-only tools.

### 6.3 Long-run surfacing in Cowork

From the Cowork/Dispatch material surfaced in search (support.claude.com Cowork collection,
claude.com/docs/cowork/guide/dispatch — **these two were surfaced by WebSearch snippets but not
individually WebFetched in this session; treat the following as PARTIAL**):

- Progress indicators show what Claude is doing at each step; Claude surfaces reasoning and approach.
- Claude builds a **plan reviewable in the sidebar**; as it works you see sources drawn from, files
  taking shape, and progress through the plan.
- The same session can be opened on another surface to monitor, answer questions, or redirect.
- Dispatch child tasks appear under a **Dispatch group** in the sidebar, each with its own status;
  selecting one opens its full transcript, the steps taken, and files produced.

Confirmed by direct fetch (S17): Dispatch-spawned Code sessions appear in the Code sidebar with a
**Dispatch** badge; app approvals in those sessions **expire after 30 minutes** and re-prompt.

### 6.4 Scheduled tasks (S18)

The Desktop **Routines** page holds both **local scheduled tasks** and remote **routines**.

| | Cloud routine | Desktop task | `/loop` |
|---|---|---|---|
| Runs on | Cloud, Anthropic-managed | Your machine | Your machine |
| Requires machine on | No | Yes | Yes |
| Requires open session | No | No | Yes |
| Persistent across restarts | Yes | Yes | Restored on `--resume` if unexpired |
| Access to local files | No (fresh clone) | Yes | Yes |
| MCP servers | Connectors per task | Config files + connectors | Inherits from session |
| Permission prompts | No (autonomous) | Configurable per task | Inherits |
| Minimum interval | 1 hour | 1 minute | 1 minute |

Creation: **Routines → New routine → Local**. Fields: **Name** (lowercased kebab-case, used as the
on-disk folder name, must be unique), **Description**, **Instructions** (with pickers for permission
mode and model, plus working folder and an isolated-worktree toggle), **Schedule**. A trusted folder
is required before saving.

Schedule presets: **Manual** (Run now only), **Hourly**, **Daily** (time picker, defaults 9:00 AM
local), **Weekdays** (Daily minus Sat/Sun), **Weekly** (time + day picker). Anything else — every 15
minutes, first of the month, one-shot at a future time — is created by **asking Claude in plain
language** in any Desktop session.

Runtime: Desktop checks the schedule **every minute** while open and starts a fresh session when due.
Each task gets a **deterministic delay of a few minutes** past the scheduled time to stagger API
traffic — same task, same offset, every time. Tasks only run while the app is running and the
computer is awake; sleeping through a slot **skips** the run. **Keep computer awake** lives in
Settings → Desktop app → General. Closing the lid still sleeps.

**Missed runs:** on app start or wake, Desktop checks the last **seven days**; if runs were missed it
starts **exactly one catch-up run for the most recently missed time** and discards older ones. Daily
task missing six days → one run on wake. Guardrails belong in the prompt itself ("Only review today's
commits. If it's after 5pm, skip the review…").

**Permissions:** per-task permission mode; allow rules from `~/.claude/settings.json` also apply. In
Manual mode a missing permission **stalls the run** with the session left open in the sidebar for
later approval. Best practice: **Run now** after creating, approve with "always allow", and future
runs auto-approve. Connector tools the org set to `ask` and MCP tools marked `requiresUserInteraction`
prompt every call with no always-allow — those runs stall each time.

**Management:** task detail page offers **Run now**, **Status** (Active/Paused), **Edit**, **Review
history** (including skipped runs, with hover reasons: computer asleep, previous run still in
progress, other scheduled tasks already running), **Review allowed permissions** ("Always allowed"
panel, revocable), **Delete** (archives all sessions it created; an **"Also delete files on disk"**
checkbox removes `SKILL.md` and data from `~/.claude/scheduled-tasks/`).

**On disk:** `~/.claude/scheduled-tasks/<task-name>/SKILL.md` (or under `CLAUDE_CONFIG_DIR`), YAML
frontmatter with `name` and `description`, prompt as the body. Changes take effect next run.
Schedule, folder, model and enabled state are **not** in that file.

**Self-modification:** a running scheduled task can change its own schedule or prompt via the
`update_scheduled_task` MCP tool — e.g. rescheduling a code review earlier when a release branch
appears.

---

## 7. Vela reimplementation plan

Vela is model-agnostic: the user supplies the brain (llama.cpp / Ollama / LM Studio / vLLM, any
third-party API key, or a subscription provider). Everything Anthropic runs server-side must become a
local process or a user-configured third-party service. The through-line for this whole area:
**Anthropic executes search, fetch, filtering, and design-preview sandboxes on their servers inside
the model turn. Vela must execute all of them in the client, as ordinary client-side tools, and
reconstruct the server-side agentic loop in Vela's own orchestrator.**

### 7.1 The fundamental architectural inversion

Anthropic's `server_tool_use` blocks never require a `tool_result` from the client — the API runs the
tool mid-turn and splices the result in. An arbitrary local model has no such facility. Therefore:

- Vela declares `web_search` and `web_fetch` as **ordinary client tools** in the tool schema it sends
  to whatever backend it's talking to.
- Vela's orchestrator runs the classic client loop: model emits `tool_use` → Vela executes →
  Vela appends `tool_result` → re-invoke. This is exactly what every local backend already supports
  via OpenAI-compatible function calling or llama.cpp grammars.
- Vela should **emit the Anthropic block shapes internally** (`server_tool_use` /
  `web_search_tool_result` / `web_search_result_location` citations) as its canonical transcript
  format, so the renderer, citation UI, and export path are identical regardless of backend. Adapt
  at the edges: an `AnthropicAdapter` can pass the real server tools straight through when the user
  happens to be on an Anthropic key; every other adapter synthesizes the same blocks locally.
- `pause_turn` has no analogue and is not needed — Vela owns the loop, so it just enforces its own
  iteration cap and surfaces a "continue?" affordance.

### 7.2 Search backend abstraction

Anthropic's own precedent (S7 — Brave via MCP for Government) is the model. Vela ships a
`SearchProvider` interface with a query string in and `{url, title, snippet, page_age}` out.
Bundled implementations:

- **SearXNG** (self-hosted or public instance) — the default zero-key option; a Docker one-liner Vela
  can offer to launch, giving fully local metasearch across many engines.
- **Brave Search API**, **Tavily**, **Serper**, **Exa**, **Bing Web Search**, **Google CSE** — all
  user-key.
- **Local index** — an offline provider over a user's own corpus (see 7.4).

Behaviours to replicate exactly, all client-side:
`max_uses` counter enforced in the orchestrator; `allowed_domains`/`blocked_domains` with Anthropic's
precise semantics (no scheme, subdomains auto-included, a specific subdomain restricts, subpath
prefix matching for search only, XOR of allow/block, wildcards in path only); **IDNA/punycode
normalization plus a non-ASCII rejection pass on every allow/block entry** to close the homograph
hole; `user_location` passed as the provider's locale/geo parameter, defaulted from the OS locale and
timezone rather than an IP guess — Vela should never do IP geolocation, and should offer a "no
location" default since it is a desktop app with no reason to leak that.

Anthropic's **$10 / 1,000 searches** vanishes; the user pays their chosen provider directly, or
nothing for SearXNG. Vela's usage meter should still count searches per conversation so `max_uses`
and cost estimates work.

**Image results** (Bing-backed at Anthropic) become a `SearchProvider.searchImages()` method,
satisfied by SearXNG's image category or the chosen API's image endpoint; results render inline with
source links from the same citation renderer.

### 7.3 Fetch backend

A local fetcher in the Vela process:

- HTTP via the app's own client with a Vela user agent, redirect cap, size cap, and timeout.
- HTML → text via Readability (Mozilla's readability, already the standard for this) then
  html-to-markdown, preserving character offsets so `char_location` citations can be computed.
- **PDF** → local extraction (pdfium / pdf.js / PyMuPDF) rather than shipping base64 to a model.
  If the local backend is genuinely vision-capable, page images can be attached; otherwise text +
  layout.
- **JavaScript-rendered pages**: Anthropic explicitly cannot do these. Vela **can and should beat
  this** — it already ships an Electron/Chromium runtime, so an offscreen `BrowserWindow` (or a
  bundled Playwright) renders the page and returns the settled DOM. This is a genuine capability win
  over the hosted product, and it needs to be behind a per-domain permission prompt because it
  executes untrusted JS.
- `retrieved_at` timestamp, and a local **fetch cache** (SQLite + on-disk blobs, keyed by URL with a
  TTL) reproducing `use_cache` semantics including `use_cache: false` bypass.
- `max_content_tokens` enforced with the **active backend's own tokenizer** (llama.cpp tokenizer,
  tiktoken, or the HF tokenizer for the loaded model) — not a fixed heuristic, because context
  budgets differ wildly between a 8k local model and a 200k hosted one.

**Security parity is mandatory, not optional.** Reimplement Anthropic's URL-validation invariant
exactly: maintain a per-conversation set of URLs that have legitimately entered context (user
messages, client tool results, prior search/fetch results) and **refuse any fetch of a URL not in
that set** with `url_not_in_prior_context`. Additionally block private/link-local/loopback addresses
and cloud metadata endpoints (169.254.169.254) — a desktop app sits inside the user's LAN, so SSRF is
strictly *more* dangerous here than in Anthropic's datacenter. Honour `robots.txt`. Enforce the
250-character URL cap, the text/HTML/PDF content-type allowlist, and count failed fetches against
`max_uses`. Reproduce every error code verbatim so prompts and UI copy port unchanged.

### 7.4 Dynamic filtering without a hosted sandbox

**ANTHROPIC_SERVER_SIDE:** dynamic filtering runs the model's filter code inside Anthropic's hosted
`code_execution` container, auto-provisioned per request; it is not ZDR-eligible for exactly that
reason.

Vela's substitute, in descending order of preference:

1. **Local sandboxed code execution** — the same sandbox Vela needs anyway for code interpreter:
   Docker/Podman container, or `firejail`/`bubblewrap` on Linux, Seatbelt on macOS, or a WASM
   runtime (Pyodide/wasmtime) for the no-Docker path. Mount fetched documents read-only into the
   sandbox, let the model write a Python filter, return only stdout to the context. Network **off**
   inside the sandbox — the fetch already happened outside it.
2. **Deterministic pre-filter, no model code at all** — for backends too weak to write reliable
   filter code: local embedding model (bge-small / all-MiniLM via ONNX Runtime, fully offline) +
   BM25 over the fetched documents, chunk, rank against the query, and admit only the top-k chunks.
   This is cheaper and more robust than code generation and should be Vela's **default** on small
   local models.
3. **No filtering** — full content into context, matching `web_search_20250305` behaviour, for tiny
   corpora.

Expose this as a single setting (`filtering: off | rank | sandbox`) rather than the version-string
mechanism Anthropic uses. `response_inclusion: excluded` becomes a transcript-storage flag: keep the
raw fetched bodies in Vela's local store but omit them from the context window and from the rendered
transcript, which is strictly better than Anthropic's version since nothing has to be re-uploaded.

### 7.5 Research mode

This is where Vela can be a faithful reimplementation because S20 documents the architecture openly.

**Orchestrator in Vela's process, not the model's head.** A `ResearchRun` object owns:

- A **lead/orchestrator** role and N **subagent** roles. Vela's model-agnosticism is an advantage
  here: the user assigns a **strong model to the lead and a cheap/fast model to subagents**
  (e.g. a 70B local or a hosted Opus as lead, an 8B local as subagents; or Sonnet-class subagents
  against an API key). This is a first-class setting, mirroring Anthropic's Opus-lead / Sonnet-subagent
  split, and it is one of the clearest places where "you supply the brain" pays off — subagent work is
  the token-hungry part and can run entirely on local hardware while the lead runs on a paid key.
- **Effort scaling table** encoded as configuration, not prose, so it can be tuned per backend:
  simple → 1 agent / 3–10 tool calls; comparison → 2–4 agents / 10–15 calls each; complex → 10+
  agents with divided subtasks. Vela should derive the tier from a cheap classifier pass by the lead
  and let the user override with a slider.
- **Parallelism**: spawn 3–5 subagents concurrently; each issues 3+ tool calls in parallel. Local
  backends need a concurrency governor here — llama.cpp with one GPU cannot run five subagents at
  once, so Vela schedules against a configured `maxConcurrentInferences` and degrades to sequential
  with a visible notice rather than thrashing. With Ollama or vLLM the batch scheduler handles it;
  with a hosted key it's just rate limits.
- **Wide-to-narrow search prompt** baked into the subagent system prompt.
- **External memory**: the lead's research plan is written to a file in the run directory
  immediately, so plan survives context truncation — critical for local models with 8k–32k contexts,
  where Anthropic's 200k assumption does not hold. Subagents write findings to files in that
  directory; the lead reads summaries, not full transcripts. Vela should make this directory a real,
  user-visible folder so the intermediate research is inspectable and salvageable.
- **Phase summarization** before context limits, with the threshold computed from the active model's
  advertised context length.
- **CitationAgent pass**: a final dedicated pass that walks the draft report and the retrieved
  documents and attaches `{url, title, cited_text, char offsets}` to each claim. Implement the
  matching with local embeddings + exact substring search so it works even when the model is too weak
  to emit precise offsets — the model proposes, the deterministic matcher verifies, and unverifiable
  claims get flagged rather than silently cited. This is a place Vela should be *stricter* than the
  hosted product, because weaker local models hallucinate citations more.
- **Durable checkpointing**: persist run state (plan, subagent statuses, retrieved docs, partial
  findings) to SQLite after every step so a crash, a model swap, or a laptop sleep resumes rather
  than restarts — Anthropic calls this out as a production requirement, and it matters far more on a
  desktop app that gets closed.

**Routing between modes (S6)** is a small classifier the lead runs first: plain answer / web search
(1–2 calls) / extended thinking / research (5+ calls). For backends without native thinking, map
"extended thinking" to a scratchpad prompt phase whose output is hidden from the final render.
Vela should expose the same three-way toggle in the composer (`+` menu) so the mental model ports.

**Evaluation harness**, since Vela's users swap models constantly and quality varies enormously:
ship S20's methodology as a built-in — a 20-query smoke set, an LLM-as-judge rubric (factual
accuracy, citation accuracy, completeness, source quality, tool efficiency → 0.0–1.0 + pass/fail)
runnable against whichever model the user has loaded, so users can empirically check whether their
local model is good enough for research mode before trusting it.

**Progress surfacing** — undocumented for hosted Research, so Vela designs it from the Cowork
pattern: a plan pane in the sidebar with per-step status, a live list of sources as they are fetched,
subagent cards showing which sub-question each is on, and a token/time meter. Because Vela owns the
loop, it can surface far more than the hosted product: exact per-subagent token spend, which model
served each step, and a cancel button per subagent.

**Enterprise search (S8)** ports as "search my stuff": the same MCP-call-not-index principle — Vela
queries local/connected sources at question time rather than building a central index. Local
equivalents: filesystem search over user-granted folders, a local mail store (Maildir/mbox/Thunderbird
profile), local Obsidian/Notion exports, and any MCP server the user has configured. Permission-aware
by construction, since everything runs as the local user. If a user *wants* an index, it should be a
local vector DB (sqlite-vec, LanceDB, Qdrant embedded) with local embeddings — never a cloud index.

### 7.6 Design / canvas surface

**Server-side pieces to replace:** the hosted preview sandbox with signed-token access control; the
hosted design-system store and its org publication model; hosted export connectors (Adobe, Canva,
Gamma, Miro, Vercel, Wix, Replit, Lovable, Base44); server-side PDF/PPTX generation.

**Vela's Design surface** is a third top-level tab beside Chat and Code, with the same two-pane
layout: conversation left, canvas right.

- **Rendering:** the canvas is an HTML/React document rendered in a **sandboxed `<iframe>` or a
  separate Electron `BrowserWindow`** with `sandbox`, no node integration, a strict CSP, and no
  access to Vela's IPC, session, or filesystem. This is the local equivalent of Anthropic's
  signed-token iframe sandbox — same trust boundary, achieved with process isolation instead of
  short-lived tokens, and simpler because there is no multi-tenant sharing to gate.
- **Inline comments:** an overlay layer over the iframe that hit-tests the rendered DOM. Clicking an
  element captures a stable selector (data-attribute injected at generation time, falling back to a
  CSS path) plus a screenshot crop, and injects `{selector, elementHTML, comment}` into the next
  prompt. The doc's known bug (comments failing to persist) is avoidable: persist comments in Vela's
  own SQLite store keyed to the artifact version, not in model context.
- **Direct manipulation** (drag / resize / align) and **adjustment sliders**: implement as a
  structured edit protocol. The model generates the design as HTML with **CSS custom properties** for
  the tunable dimensions (`--spacing-md`, `--brand-primary`, …) and declares which knobs to expose;
  Vela renders real sliders bound to those properties and writes changes back into the source. Drag/
  resize mutate concrete style values. Every direct manipulation is written back into the artifact
  source as a **deterministic patch, not a model round-trip** — this is essential, because a local
  7B model cannot reliably regenerate a whole design just to move a box 10px. Only the model handles
  semantic changes.
- **Versioning:** every model edit and every manual patch commits to a local git repo in the artifact
  directory. This gives the version selector, diffing, and restore for free, and beats the hosted
  version history because it's inspectable and exportable.
- **Design systems (`/design-sync`):** a local extractor. Point it at a GitHub repo (clone), a local
  codebase, a Figma export, screenshots, or PPTX/PDF brand docs, and run a local pipeline —
  CSS/Tailwind config parsing and computed-style scraping for code sources, palette extraction
  (k-means over pixels) and OCR-assisted font identification for image sources — producing a
  `design-system.json` of colour palettes, typography scale, components, and spacing/grid tokens,
  plus a generated UI-kit preview page. That JSON is injected into the Design system prompt.
  **Validation before display**: a deterministic linter checks generated markup against the token set
  (are all colours drawn from the palette? all spacings on the scale?) and either auto-corrects by
  snapping to the nearest token or asks the model to revise. Doing this deterministically matters
  more for Vela than for Anthropic, since a small local model will drift from a design system far
  more than Opus 4.7 does.
- **Web capture:** the offscreen-browser machinery from 7.3 doubles as the capture tool — navigate,
  screenshot, and extract computed styles / DOM subtrees for a selected element.
- **Imports:** DOCX/PPTX/XLSX parsed locally (python-docx, python-pptx, openpyxl in the local sandbox,
  or JS equivalents).
- **Exports — the hosted file-creation replacement.** PDF via the Electron/Chromium
  `printToPDF` already in-process. PPTX via **python-pptx running in the local Docker/firejail
  sandbox**. HTML and ZIP are trivial file writes. This directly substitutes Anthropic's server-side
  file creation with a local sandbox, and is strictly better for privacy since the design never
  leaves the machine.
- **Export connectors** (Adobe, Canva, Miro, Vercel, Wix…) become **user-configured MCP servers or
  OAuth integrations Vela holds keys for locally**. Vela ships none by default; each is opt-in and
  the token lives in the OS keychain. Where a service has no API, the export lands as a file in a
  watched folder.
- **Sharing:** Anthropic's org-scoped URLs have no local analogue and should not be faked. Vela
  offers: export to a self-contained HTML file, copy to clipboard, write to a user-chosen folder, or
  optionally serve on the LAN from a local HTTP server with a one-time token — explicitly opt-in and
  clearly labelled as "your machine is the server".
- **Handoff to code** (`/design`, `/design-sync` into Claude Code): trivially local — the artifact is
  already files on disk in a git repo, so "handoff" is just opening that directory as a Vela Code
  session. No upload, no bundling.
- **Model requirement:** Anthropic uses a vision model (Opus 4.7). Vela must degrade gracefully: if
  the loaded backend has no vision, disable screenshot-based iteration and image import, keep the
  text/HTML path, and say so in the UI rather than silently producing garbage. Recommend a
  vision-capable local option (Qwen-VL, Llama Vision, InternVL) in the model picker when Design is
  opened.

**Custom visuals (S14)** port directly and are pure client-side work: the model emits an HTML/SVG
block, Vela renders it inline in the message in a sandboxed frame, ephemeral by default, with
**Copy as image** (canvas rasterization), **export .svg / .html**, and **promote to artifact**. Since
the hosted version doesn't render on mobile, Vela-as-desktop has no gap. Mermaid should render
natively. Note S14's own observation that visualization quality is strongly model-dependent — Vela
should let visuals be generated by a *different, stronger* model than the conversation when the user
configures one, which the hosted product cannot do.

**Artifacts (S15) / live artifacts (S16):** the artifact panel, sidebar section, version selector,
"Edit with Claude" text-selection editing, and "Try fixing with Claude" all port as client-side UI
over the local git-backed artifact store. Two server-side pieces need substitutes:

- **Artifact-embedded model access** (hosted artifacts call Claude via a text API using the *viewer's*
  subscription). Vela's substitute: a **localhost RPC bridge** injected into the artifact frame that
  proxies to the user's own configured backend, gated by a per-artifact permission prompt and a token
  budget, with the artifact never seeing an API key. Since there is one user, "viewer's subscription"
  collapses to "your backend".
- **20 MB persistent storage** → IndexedDB or a scoped SQLite file per artifact in the artifact
  directory, with a configurable quota.

**Live artifacts** are almost native to Vela already: they are described as living on the user's
computer, desktop-only, refreshing from connectors and local files on open with a short cache and a
manual refresh button, versioned per update. Vela implements the same as a "Live artifacts" sidebar
tab; the refresh path calls Vela's local connector/MCP layer. The "shared artifacts use the viewer's
access" rule is moot locally but should be preserved in the export path: an exported live artifact
must ship without embedded credentials and re-resolve connectors on the recipient's machine.

### 7.7 Notifications

Fully **CLIENT_SIDE_PORTABLE**. Electron `Notification` (macOS Notification Center, Windows toast,
Linux libnotify) covers all five documented triggers:

| Trigger | Vela implementation |
|---|---|
| Task finished while session unfocused | Fire on run completion when `BrowserWindow.isFocused() === false` or the session tab isn't active |
| CI finished | Local `gh`/git-forge poller in the Vela process |
| Scheduled task fired | Emitted by Vela's local scheduler |
| Catch-up run started | Emitted by the missed-run recovery path |
| Dispatch task done → **phone push** | The one piece with **no local analogue**. Anthropic routes this through their account infrastructure. Vela substitutes user-owned push: ntfy.sh (self-hostable), Gotify, Pushover, a Matrix/Telegram/Slack webhook, or plain email via the user's SMTP. All optional, all user-configured, no Vela-operated relay. Default: off. |

Vela should add what the hosted product lacks: a per-trigger enable/disable matrix, quiet hours, and
click-to-focus-the-session deep links. Also a dock/taskbar badge for stalled permission prompts,
since local scheduled runs stall the same way (§6.4).

### 7.8 Navigation shell

**CLIENT_SIDE_PORTABLE in full.** Vela mirrors the three-tab model — **Chat**, **Work** (Cowork
analogue), **Code** — plus **Design** as the fourth. Unified sidebar for chats, work sessions,
projects, artifacts, and live artifacts; a separate section for code sessions with filters on status
(Active/Archived), project, and environment (Local/Remote/SSH), and group-by-project.

Port wholesale: the pane system (chat, diff, browser, terminal, file, plan, tasks, subagent) with
drag-to-reposition and drag-edge-to-resize; the diff viewer with click-a-line comments and batched
submit on Cmd/Ctrl+Enter; the file pane with external-modification detection and "Open in VS Code /
Cursor / Zed"; the browser preview pane driven by a `launch.json`-equivalent; side chat that reads
main context but writes nothing back; Verbose/Summary view modes. Adopt the exact keyboard map from
§6.2 — users moving from Claude Desktop should find their muscle memory intact.

**Quick entry**: global hotkey (double-tap Option on macOS, configurable elsewhere) summoning a
compact always-on-top window. Electron `globalShortcut` + a frameless always-on-top `BrowserWindow`.

**Local scheduler** replacing Anthropic's: a Vela process scheduler ticking every minute, with the
documented semantics reproduced exactly because they are well-designed — deterministic per-task
stagger offset, skip-on-sleep, seven-day missed-run window collapsing to **exactly one** catch-up
run, per-task permission mode, "always allow" persistence per task, run history with skip reasons,
and pause/resume. Store tasks as `~/.vela/scheduled-tasks/<name>/SKILL.md` with YAML frontmatter,
matching the on-disk format so Claude Code task definitions port directly. Add real cron expressions
alongside the presets (Anthropic makes users ask the model for anything non-preset — Vela can just
offer the field). Keep the `update_scheduled_task`-equivalent tool so a run can reschedule itself.
"Keep computer awake" via `powerSaveBlocker`.

**Cloud routines have no local analogue** by definition — they run when the machine is off. Vela
should say so plainly and offer the honest alternatives: leave the app running, use a
user-controlled always-on box (a NAS, a Raspberry Pi, a VPS the user owns) running Vela headless, or
a systemd/launchd unit. Do not pretend to offer cloud execution.

### 7.9 What Vela genuinely cannot match, and what it beats

**Cannot match:**
- Cloud routines that fire while the machine is off (no Vela-operated infrastructure by design).
- Phone push without the user standing up their own push service.
- Anthropic's search index quality out of the box — SearXNG and the key-based APIs are the ceiling.
- Bing-backed image search quality without a key.

**Beats the hosted product:**
- JavaScript-rendered page fetching, via the bundled Chromium.
- Fetched content, research intermediates, and designs never leave the machine — the whole
  ZDR/dynamic-filtering tension (§7.4) simply does not arise.
- Per-role model assignment (strong lead, cheap local subagents; a stronger model for visuals than
  for chat).
- Git-backed artifact and design versioning that the user owns and can diff, branch, and export.
- No per-search fee and no pooled usage limit shared across chat/Code/Design.
- Deterministic design-system validation and citation verification, which matter more precisely
  because local models are weaker.
