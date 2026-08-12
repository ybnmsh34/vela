# Vela Spec Part — Artifacts

Ingestion notes for the **Artifacts** surface of Claude Desktop / claude.ai / Claude Code,
and the concrete plan for reimplementing every part of it in Vela against an **arbitrary,
user-supplied model backend** (local llama.cpp / Ollama / LM Studio / vLLM, any third-party
API key, or a subscription provider).

Everything below marked as fetched was retrieved with WebFetch during this session.
Anything not fetched is either labelled `SOURCE UNREACHABLE` or `[FROM MEMORY, UNVERIFIED]`.

---

## 0. Sources

### Fetched successfully

| URL | What it gave |
| --- | --- |
| https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them | Artifact definition, creation criteria, type list, versioning, gallery, storage (20 MB, personal/shared), MCP-in-artifacts, AI-powered artifacts, inline edit |
| https://support.claude.com/en/articles/9547008-publish-and-share-artifacts | Publish/unpublish, embed code + Allowed domains, remix removal, Team/Enterprise internal sharing, storage deletion on unpublish |
| https://code.claude.com/docs/en/artifacts | **The single richest source.** Full Claude Code artifact mechanics: publish flow, versions, share model, editor role, MCP connectors, CSP/page constraints, availability matrix, org admin controls, viewer origin, compliance endpoints, disable switches |
| https://code.claude.com/docs/en/whats-new/2026-w25.md | Launch note (v2.1.178→v2.1.183), beta status |
| https://code.claude.com/docs/llms.txt | Doc index |
| https://claude.com/blog/artifacts-in-claude-code | Live in-place refresh, gallery, version restore, org-only default |
| https://claude.com/docs/claude-science/artifacts | A *different* artifact model (desktop, local files): provenance, diff view, edit-content, ~/.claude-science storage |
| https://claude.com/docs/llms.txt | Doc index |
| https://claude.com/docs/claude-tag/users/use-cases/create-artifacts | Hosted-page artifacts from Slack |
| https://claude.com/docs/claude-tag/concepts/security-and-data | Artifact visibility model for channel-published pages; sandbox + egress model |
| https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork | Cowork "live artifacts": local execution, connector refresh, cache, viewer's-access sharing, local-only storage |
| https://claude.com/blog/claude-powered-artifacts | AI-powered artifact economics: viewer authenticates with own account, viewer's subscription billed |
| https://claude.com/blog/build-artifacts | MCP + persistent storage announcement, plan rollout dates |
| https://claude.com/resources/tutorials/use-artifacts-to-visualize-and-create-ai-apps-without-ever-writing-a-line-of-code | (redirected from support.claude.com/…/11649427) — marketing only, no mechanics |
| https://claude.com/resources/tutorials/prototype-ai-powered-apps-with-claude-artifacts | (redirected from support article 11649438) — marketing only, no mechanics |
| https://claude.com/resources/tutorials/intro-to-artifacts | Video page, no extractable mechanics |
| https://platform.claude.com/docs/en/api/compliance/apps/artifacts | **Chat-artifact data model**: `artifact_type` is a MIME-like `application/vnd.ant.*`, version ids, md5/size, `claude_chat_id` |
| https://platform.claude.com/docs/en/api/compliance/code/artifacts | **Code-artifact data model**: `read_mode` enum (`owner`/`users`/`org`/`public`), `published_version_id`, ~20 retained versions, list/download/delete endpoints |
| https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude | The sandbox that artifacts now require: isolated container, 30 MB/file, network-egress tiers |
| https://claude.com/blog/improving-frontend-design-through-skills | `web-artifacts-builder` skill: multi-file React/Tailwind/shadcn dev, Parcel bundle to a single HTML file |

### Local first-party material (not a web fetch — labelled as such)

- `/tmp/claude-0/bundled-skills/2.1.228/011bd9a6715d7e0f7cb21e8402932694/artifact-capabilities/0.1.29/downloads.d.ts`
- `/tmp/claude-0/bundled-skills/2.1.228/011bd9a6715d7e0f7cb21e8402932694/artifact-capabilities/0.1.29/mcp.d.ts`

These are the **platform-served `window.claude` TypeScript contract files for runtime contract
0.1.29**, shipped inside the `artifact-capabilities` skill bundle in this environment. They are
first-party and authoritative for the runtime call envelope, but they were read from disk, not
fetched from docs.claude.com. Treated here as primary source with that provenance noted.

### Not found / not publicly documented

- **`window.claude.complete` for chat artifacts.** No official page documents the signature.
  The mcp.d.ts file does confirm chat artifacts exist and use *"a different, flat
  `window.claude`"* whose members do not overlap the Claude Code artifact runtime. Every
  public description of `complete()` I could locate is third-party. Treat the exact signature
  as **unverified**; Vela should define its own and not try to be bug-compatible.
- **The full `application/vnd.ant.*` MIME enumeration.** Only `application/vnd.ant.code` is
  shown, in the compliance API example.
- **The chat-artifact persistent-storage JS API surface** (key/value method names). The
  20 MB limit and personal/shared semantics are documented; the API is not.

---

## 1. The three (really four) different things called "artifacts"

This is the first thing an engineer must internalise. Anthropic ships at least four distinct
systems under the name, with different storage, different runtimes, and different sharing:

1. **Chat artifacts** (claude.ai / Claude Desktop / mobile). Created inline in a conversation,
   rendered in a right-hand side panel. Types: markdown/text, code, single-page HTML, SVG,
   Mermaid, React components. Stored server-side, keyed to a chat (`claude_chat_id`).
   Publishable to a public URL; can have persistent storage and MCP and an AI-completion API.
2. **Claude Code artifacts** (CLI / desktop app sessions). A single HTML or Markdown *file in
   your repo* that gets published to `claude.ai/code/artifact/<uuid>`, wrapped in a document
   shell and served from a sandboxed `*.claudeusercontent.com` origin under a strict CSP.
   Runtime capabilities (`downloads`, `mcp`) are declared at publish time.
3. **Cowork live artifacts** (Claude Desktop, "Cowork" label). Persistent interactive HTML
   dashboards that **execute locally on your device**, pull fresh data from connected apps on
   open, cache briefly, and are stored locally (no cross-device sync).
4. **Claude Science artifacts** (a separate desktop product). Not web pages at all — *files*
   (figures, datasets, reports, notebooks) saved into a project folder under `~/.claude-science`,
   with per-version **provenance** (messages, reproducible code, execution log, environment,
   reviewer findings) and an in-app diff viewer.

Vela is a desktop app, so it should implement a **union**: the chat-artifact UX (side panel,
live render, versions), the Claude Code publish/capability model (declared runtime powers,
CSP-hardened frame), the Cowork execution model (**runs locally, pulls live data locally**),
and the Claude Science provenance model (which is strictly better than anything Anthropic ships
on the web side, and is cheap for a local app because the sandbox is on the same machine).

---

## 2. Feature-by-feature

### 2.1 Automatic artifact creation (the "should this be an artifact?" heuristic)

**Documented behaviour** (support 9487310): Claude creates an artifact when the content is
*"significant and self-contained, typically over 15 lines"*, is a *"complex piece of content
that stands on its own"*, and is something you are *"likely to want to edit, iterate on, or
reuse outside the conversation"* / *"refer back to or use later."*

**Dependency:** ANTHROPIC_SERVER_SIDE in practice. The decision is made by the model, steered
by an Anthropic system prompt, and the emission channel (a structured block the client parses
out of the stream) is proprietary.

**Vela reimplementation.** Do not rely on the model volunteering a custom XML tag — arbitrary
local models are unreliable at that. Implement **two paths and always run both**:

- *Path A — tool call (preferred).* Expose real tools to backends that support function
  calling: `artifact_create({id, type, title, language?, content})`,
  `artifact_update({id, content | patch})`, `artifact_rewrite({id, content})`. Map to the
  backend's native tool schema (OpenAI `tools`, Anthropic `tools`, Ollama `tools`, or a
  grammar-constrained JSON schema via llama.cpp GBNF for models without tool support).
- *Path B — stream sniffer (fallback).* A streaming parser over the raw token stream that
  recognises `<vela:artifact id="…" type="…" title="…">…</vela:artifact>` **and** plain fenced
  code blocks. Deterministic client-side promotion rule that needs no model cooperation at all:
  a fenced block with a recognised language tag and `>= 15` non-blank lines becomes an artifact
  automatically; shorter blocks stay inline. This is the floor of quality for a 7B model.
- *Capability probe at model-registration time.* On first use of a backend, run a one-shot
  probe (does it emit valid tool calls? does it respect the artifact tag?) and store a
  `model_profile` record selecting Path A or B. Ship per-family system-prompt variants.
- *Repair loop.* After extraction, validate before rendering (see 2.3). On failure, feed the
  compiler/parser error back for up to N repair turns, then fall back to showing raw code.

### 2.2 Supported artifact types

**Documented list** (support 9487310, and the type list is stable across sources): Markdown or
plain-text documents; code snippets (search results say "30+ languages" but the support page
itself only says "code snippets"); single-page HTML websites (HTML+CSS+JS); SVG images;
diagrams and flowcharts (Mermaid); interactive React components. The compliance API models the
type as a MIME-like string, e.g. `application/vnd.ant.code`.

Claude Code artifacts are narrower: the published file **must be `.html`, `.htm`, or `.md`**;
Markdown renders as styled HTML. Mermaid is rendered natively by the viewer (```mermaid fences
in Markdown, `<pre class="mermaid">` in HTML) — no external library involved.

**Dependency:** MIXED. The type taxonomy is client-side; the *rendering* is Anthropic's viewer.

**Vela reimplementation.** One `type` enum persisted with each artifact:
`text/markdown`, `text/plain`, `application/vnd.vela.code` (+ `language`), `text/html`,
`image/svg+xml`, `application/vnd.vela.mermaid`, `application/vnd.vela.react`. Renderers, all
offline, all vendored into the app bundle:

- Markdown → `markdown-it` (+ `shiki` or `highlight.js` for fences, with the grammar/theme
  files bundled, **never** a CDN).
- Code → same highlighter, read-only editor (CodeMirror 6) with copy/download.
- HTML → sandboxed WebView (§2.3).
- SVG → sanitise with DOMPurify (`svg` profile, strip `<script>`, `<foreignObject>`, event
  attrs, external `href`) then inline.
- Mermaid → vendored `mermaid` ESM, rendered *inside* the sandboxed frame, never in the app's
  own document (mermaid has had XSS history).
- React → compile in-process (§2.3).

### 2.3 Live rendering + the side panel

**Documented behaviour:** artifacts *"appear in a dedicated window to the right of the main
chat"*; edits *"appear directly in the artifact window."* Claude Science: click a linked file
to *"open it in a tab beside the chat"*, HTML artifacts get **zoom controls including fit to
width**, images zoom to native resolution.

**Dependency:** MIXED — the panel is client UI; the HTML/React execution environment for chat
artifacts is Anthropic's hosted sandboxed iframe.

**Vela reimplementation.**

- *Panel.* Resizable split pane; artifact opens on first emission and **streams**: the parser
  pushes partial content, the markdown/code renderer re-renders on a rAF-throttled tick. For
  HTML/React, do **not** re-execute on every token — buffer until the block closes, then a
  debounced hot rebuild (~250 ms). Show a skeleton + "building…" while streaming.
- *Sandbox.* Register a custom protocol `vela-artifact://<artifact-id>/` in Electron/Tauri so
  each artifact gets a **distinct opaque origin** (never `file://`, never the app origin).
  Electron `<webview>`/`BrowserView` with `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, `webSecurity: true`, `allowRunningInsecureContent: false`. Serve with a CSP
  header mirroring Anthropic's:
  `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' vela-artifact:; style-src 'unsafe-inline' vela-artifact:; img-src data: blob: vela-artifact:; font-src data: vela-artifact:; connect-src 'none'; frame-ancestors 'self'`.
  `connect-src 'none'` is the important one: it reproduces Anthropic's "no external requests"
  guarantee, so an artifact cannot exfiltrate anything even if the model was prompt-injected.
  All host powers arrive over a `postMessage` bridge instead (§2.10–2.12).
  Tauri equivalent: a custom `vela-artifact` protocol handler plus a per-window CSP; Tauri
  windows are already isolated processes.
- *React compilation, fully offline.* Bundle `esbuild-wasm` (or a vendored platform `esbuild`
  binary) plus a vendored `node_modules` snapshot of `react`, `react-dom`, and the standard
  artifact library set (recharts, lucide-react, d3, three, papaparse, lodash, mathjs, tone,
  and a **precompiled** Tailwind stylesheet — the Tailwind JIT needs a scan pass; ship a full
  build or run the Tailwind CLI locally against the artifact source). Compile JSX/TSX to a
  single IIFE, inject as an inline `<script>`. Compile errors go to the repair loop (§2.1).
  This is Vela's local answer to `web-artifacts-builder` (which does exactly this with Parcel).
- *Zoom.* Fit-to-width / 50–400% zoom on the frame via CSS transform on the container, plus
  native-resolution zoom for images. Cheap, and Claude Science documents it as expected.

### 2.4 Editing and iteration

**Documented behaviour:** ask Claude in chat to revise; for **Markdown** there is inline
editing — *"highlight the text you want changed, click 'Edit with Claude,' and type your
request."* Claude Science additionally has direct human editing: **Edit content → Save**
creates a new version, available for Markdown/code/plain text; *"Images, PDFs, HTML, and tables
can't be edited in place."*

**Dependency:** CLIENT_SIDE_PORTABLE (the UI) + model call.

**Vela reimplementation.** Two edit affordances:
1. *Edit with the model.* Selection in the artifact → floating "Edit with model" → the selected
   range + a short instruction are sent as a scoped edit request. Prefer a **patch protocol**
   over full rewrite for local models: ask for a search/replace block
   (`<<<<<<< SEARCH … ======= … >>>>>>> REPLACE`) and apply it client-side, retrying with a
   full rewrite if the search text does not match uniquely. Full-rewrite-only wastes context
   and is the main reason small models "lose" parts of long artifacts.
2. *Direct human edit.* A real editor (CodeMirror) for text-ish types, Save → new version.
   Vela should extend this to HTML too (Claude Science refuses; there's no good reason to).

### 2.5 Versioning

**Documented behaviour:**
- Chat artifacts: *"Switch between different versions using the version selector."*
- Claude Code: *"Each publish becomes a version"*, at the **same URL**; from the Share control
  you *"choose which version viewers see"*; there is an **"Always share latest version"**
  toggle and a version picker ("Sharing version 2"); the blog adds *"version history so you can
  restore at any time."* The compliance API exposes `published_version_id` = the version a
  non-owner renders (the owner's pin if set, else the owner's latest), and retains only
  *"roughly 20 most-recently-published versions."*
- Claude Science: a **version stepper plus a diff toggle** with a selectable comparison base;
  older versions are read-only ("to restore one, ask Claude to save it again"); links in the
  conversation point to the *specific version that existed at the time*.

**Dependency:** ANTHROPIC_SERVER_SIDE (storage + the served-version pin).

**Vela reimplementation.** SQLite, content-addressed:

```sql
CREATE TABLE artifact (
  id TEXT PRIMARY KEY, title TEXT, type TEXT, language TEXT,
  favicon TEXT, chat_id TEXT, created_at INT, updated_at INT,
  pinned_version_id TEXT,          -- NULL = always-latest
  always_share_latest INT DEFAULT 1,
  read_mode TEXT DEFAULT 'owner'   -- owner|users|org|public
);
CREATE TABLE artifact_version (
  id TEXT PRIMARY KEY, artifact_id TEXT, seq INT, name TEXT,
  blob_sha256 TEXT, size_bytes INT, created_at INT, label TEXT
);
CREATE TABLE blob (sha256 TEXT PRIMARY KEY, bytes BLOB);
```

Content-addressing means unchanged republishes cost nothing. **Keep all versions** (disk is the
user's; do not copy Anthropic's ~20-version truncation) but expose a retention setting.
Ship the Claude Science diff view — `jsdiff` word-diff for text, a rendered side-by-side
iframe pair for HTML — because it is the single highest-value artifact feature and is trivial
locally. Message links must resolve to the version-at-time (`vela://artifact/<id>@<seq>`).

### 2.6 The Artifacts gallery / sidebar

**Documented behaviour:** *"a dedicated Artifacts section in your Claude sidebar"* — "View all
your creations in one organized location". Claude Code has a gallery at
`claude.ai/code/artifacts` listing every artifact you created, showing the title and the
emoji favicon, with the author named in the viewer header. Claude Science has a **Files** panel:
a searchable grid, with per-artifact menu actions **Open, Open beside session, View in context,
Provenance, Versions, Copy link, Star, Rename, Download, Delete** — and *"Renaming doesn't
break links"*, *"Delete removes all versions permanently."*

**Dependency:** MIXED — a list view over server-side records.

**Vela reimplementation.** A local library view backed by the tables above: grid + list,
full-text search over title and content (SQLite FTS5 over the latest version's text), filters
by type/date/starred/source-chat, and the exact Claude Science action menu. "View in context"
jumps back to the originating message. Titles are mutable and independent of the stable
`artifact.id`, so renaming never breaks a link — mirror that.

### 2.7 Copy, download, export

**Documented behaviour:** *"Copy content to your clipboard"*, *"Download files to use outside
the conversation."* Claude Science: **Download** for one file, or open the project folder under
`~/.claude-science` and copy directly.

**Dependency:** CLIENT_SIDE_PORTABLE.

**Vela reimplementation.** Copy-to-clipboard; Download → native save dialog. **Export
self-contained HTML** is the most important one and is Vela's substitute for public publishing
(§2.8): inline every stylesheet and script, convert images to `data:` URIs, emit a single
`.html` under 16 MiB, which is exactly the shape Anthropic's own published pages take. Also:
"Reveal in file manager" on `~/.vela/artifacts/<id>/`, and an "Export all" that writes the
whole gallery as a static site with an index page.

### 2.8 Publishing to a public link, embedding, unpublishing

**Documented behaviour** (support 9547008):
- Free/Pro/Max: a **Publish** button makes the artifact publicly available; anyone with the
  link can view and interact **without signing up**. Non-users are only prompted to sign up for
  *"advanced features like using AI-powered capabilities."*
- **Embedding:** a **"Get embed code"** button generates iframe code; you must list permitted
  hosts in an **Allowed domains** field (comma-separated).
- **Unpublish** revokes access — and, importantly, *"once you unpublish an artifact, you cannot
  publish that same artifact again"*, and unpublishing **permanently deletes associated storage
  data**.
- **Remix is gone.** The Remix button "is no longer available"; you now copy the code into a new
  chat. Your copy is independent of the original.
- Team/Enterprise: internal only — *"can be shared within your organization but cannot be
  published publicly"*; **Share → "Share & copy link"**; only authenticated org members can
  open it; project artifacts require project access; **Unshare** from the same modal.

**Dependency:** ANTHROPIC_SERVER_SIDE. Hosting, the public URL, the auth wall, and the
embed-domain enforcement all live on Anthropic infrastructure.

**Server-side detail:** Anthropic stores artifact content on its own infrastructure, serves it
from a sandboxed `*.claudeusercontent.com` origin, and gates reads on claude.ai session auth
(for org mode) or not at all (for public mode).

**Vela reimplementation — four tiers, user picks per artifact:**
1. **File export (default, zero infra).** Self-contained `.html` (§2.7). Covers "send someone
   the thing" for most users. AirDrop/email/Slack it.
2. **LAN share.** Vela runs an embedded HTTP server (bind to LAN interface, off by default)
   serving `http://<host>:<port>/a/<id>?k=<capability-token>`. Token is a 128-bit random per
   artifact, revocable, stored in SQLite. Serve the same CSP headers as the local viewer, plus
   `Content-Security-Policy: frame-ancestors <allowed-domains>` — that is the *exact* local
   equivalent of the Allowed domains field, enforced by the browser. Emit the `<iframe>` snippet
   in a "Get embed code" dialog, same as Anthropic.
3. **Bring-your-own host.** One-click deploy to a target the user owns, using **their** creds
   stored in the OS keychain: GitHub Pages / Gist, S3 + CloudFront, Netlify, Vercel, Cloudflare
   Pages, or plain `scp`/rsync to a box. Publishing writes the single-file HTML; the artifact
   record stores `{host, url, deployed_version_id}` so redeploy hits the same URL — which is how
   Vela reproduces "every publish is a new version at the same link."
4. **Self-hosted `vela-share` server (org mode).** A small Go/Node service the user or their
   company runs: stores artifact versions, serves them from a **separate origin** from the app,
   and gates access behind OIDC/SAML. Implements the full `read_mode` enum from the compliance
   API — `owner` | `users` | `org` | `public` — plus `published_version_id` pinning and an
   "always latest" toggle.

Two deliberate divergences: **allow republishing after unpublish** (Anthropic's one-way door is
a data-model artefact, not a feature), and **keep local storage on unpublish** unless the user
explicitly asks to purge. Also implement remix properly — "Duplicate as new artifact" is one
row insert; there is no reason to remove it.

### 2.9 Claude Code artifacts: the publish flow and file model

**Documented behaviour** (code.claude.com/docs/en/artifacts, verbatim-faithful):
- Claude writes the page to an `.html`/`.htm`/`.md` file **in your project**, then publishes it.
- Before publishing a *new* artifact Claude Code **asks permission** — e.g. `Claude wants to
  publish "Deploy failures by service" (deploy-failures.html) to a private page on claude.ai`.
  **Republishing an already-approved artifact does not prompt again.**
- On approval, Claude prints the URL and the browser opens the page. **`Ctrl+]`** reopens the
  most recent artifact from the terminal. **`CLAUDE_CODE_ARTIFACT_AUTO_OPEN=0`** stops the
  auto-open.
- Claude picks the **title** and an **emoji browser-tab icon**; both show in the gallery and in
  shared links. You can ask for specific ones.
- **Updating from a different session requires passing the URL** — *"Without the URL, a new
  session always creates a new artifact rather than updating an existing one."*
- **Live update:** *"Anyone with the page open sees the update in place."*

**Dependency:** MIXED — file authoring is local, publishing/hosting/live-push is server-side.

**Vela reimplementation.**
- Same file-first model: the artifact's source of truth is a file on disk under the project (or
  `~/.vela/artifacts/<id>/index.html` for chat-originated ones). This matters — it makes
  artifacts diffable, git-committable, and editable in the user's own editor.
- A **publish permission prompt** in the same shape, wired into Vela's permission system, with
  "always allow for this project" and per-tier gating (file export needs no prompt; network
  publish always prompts).
- Identity keying: `artifact.id` is derived from the **file path** for the same-path-redeploys-
  same-URL rule; a new path claims a new artifact. Store the mapping in
  `.vela/artifacts.json` in the project so a fresh session on the same repo can update the
  existing artifact **without** being handed a URL — strictly better than Anthropic's behaviour,
  and free once the mapping is in the repo.
- **Live in-place refresh:** local viewer subscribes to a file watcher (chokidar) → instant
  reload. For shared artifacts, the `vela-share` server holds an SSE/WebSocket channel per
  artifact; on redeploy it pushes `{version_id}` and open pages reload. Fall back to a polling
  `ETag` check for the static-host tiers (3) where no server logic exists.
- `Ctrl+]` equivalent global shortcut; `VELA_ARTIFACT_AUTO_OPEN=0` env var.
- Title + favicon emoji: ask the model for both in the artifact tool call; validate the emoji is
  1–2 codepoints; render it into the tab/gallery card. Keep it stable across redeploys.

### 2.10 Page constraints (CSP, no backend, single page, size)

**Documented behaviour** — the constraint table, verbatim-faithful:

| Constraint | Effect |
| --- | --- |
| No external requests | CSP blocks scripts, stylesheets, fonts, images from any other host, plus `fetch`, XHR and WebSocket. Claude inlines CSS/JS and embeds images as data URIs. Connector calls are the only exception: *"the page hands them to claude.ai, which makes the network call itself."* |
| No backend | Static page. Cannot store form input or authenticate viewers itself. |
| Single page | *"Relative links do not resolve, because nothing is deployed alongside the page."* Use in-page anchors. |
| Source file types | `.html`, `.htm`, `.md`. Markdown renders as styled HTML. |
| Rendered size | **16 MiB or smaller.** Large embedded images are the usual cause of a size failure. |

Also documented: the published file is **wrapped in an HTML document shell** at publish time, so
the author writes page content only. And a **token-cost** note: styled pages are more
token-intensive than terminal text; prefer SVG/HTML/CSS over embedded raster images, omit
unneeded interactivity, summarise large datasets rather than inlining them.

**Dependency:** ANTHROPIC_SERVER_SIDE (the CSP is served by their edge).

**Vela reimplementation.** Reproduce all of it locally, because the threat model is identical
and arguably worse (the model may be an untrusted local GGUF):
- Serve the artifact from the custom protocol handler with the CSP in §2.3. `connect-src 'none'`
  gives you "no external requests" for free.
- Provide the same **document shell** (doctype, `<head>`, minimal CSS reset, theme tokens,
  `<body>`) so the model only writes page content — this measurably improves output from small
  models, which otherwise emit half a document.
- Enforce a **16 MiB rendered-size cap** at publish, with a helpful error naming the largest
  embedded data URI.
- Reject relative links at lint time and rewrite to anchors, or resolve them against a per-
  artifact asset directory if Vela decides to support multi-file artifacts (a legitimate
  divergence: `vela-artifact://<id>/assets/…` makes multi-file trivially safe).
- **Token-cost guardrails matter far more for Vela than for Anthropic**, because a local 8B
  model at 20 tok/s takes minutes to emit a 200 KB page. Ship: an artifact size budget setting,
  a "prefer SVG over raster" system-prompt clause, automatic image downscaling before data-URI
  embedding, and a rule that datasets over N rows are written to a sidecar JSON the page fetches
  from `vela-artifact://<id>/data.json` (same-origin, allowed) rather than inlined.

### 2.11 Runtime capability: `downloads`

**Source:** local platform contract file `0.1.29/downloads.d.ts` (first-party, read from disk).

Declared as `capabilities: {downloads: true}`; the page calls
`window.claude.downloads.save({filename, data})`. Concrete mechanics from the contract:

- Returns `Promise<{status: "saved"}>`; **resolves only when the viewer accepts** a confirmation
  showing the final filename and size. *"Frame code never downloads directly."*
- `data` is `string | Blob | ArrayBuffer | ArrayBufferView`. Strings encode UTF-8. **An
  `ArrayBuffer` is transferred and detached** after the call; views and Blobs are copied. MIME
  comes from the extension — **a Blob's own type is ignored.**
- Extension allowlist, base set: `gif png jpg jpeg webp mp4 webm txt json md`. Extended set
  (when enabled for the view): `docx pptx epub csv ttf html svg`.
- Size cap **16 MiB**. Filename must be a string ≤ 512 chars.
- One undecided prompt at a time (first-wins).
- Error codes: `rejected_extension`, `extension_not_enabled`, `too_large`, `declined`
  (never auto-retry), `rate_limited`, `bad_request`, `unavailable`, `not_granted`,
  `capability_disabled`, `capability_removed`, `transform_error`.
- Presence is **per-view**: check `window.claude.downloads === undefined` before first use.

**Dependency:** MIXED — the API shape is portable; the grant plumbing is Anthropic's runtime.

**Vela reimplementation.** `window.vela.downloads.save(...)` with a **byte-identical contract**
(same field names, same error-code strings, same 16 MiB cap, same allowlists). Implementation:
`postMessage` from the frame → preload bridge → main process → `dialog.showSaveDialog` →
`fs.writeFile`. The native save dialog *is* the viewer confirmation, and it naturally produces
`declined` on cancel. Enforce the extension allowlist in the main process, not the frame.
Keeping the contract identical means artifacts authored in Claude run unmodified in Vela after a
`window.claude → window.vela` shim — worth shipping that shim as a two-line polyfill injected
into the document shell.

### 2.12 Runtime capability: `mcp` — connector calls from a published page

**Sources:** code.claude.com/docs/en/artifacts (behaviour, consent, plan gating) and the local
`0.1.29/mcp.d.ts` contract file (API shape).

**Documented behaviour (fetched):**
- A page can call MCP connectors *"each time someone views it"*, so it shows current data rather
  than a snapshot. Pro/Max/Team/Enterprise, **Claude Code v2.1.209+**; older versions publish a
  static snapshot instead.
- Claude **declares which connectors the page may call** as part of publishing; the page cannot
  call anything outside that declaration.
- **Only claude.ai account connectors qualify.** Local MCP servers from `.mcp.json` can feed
  data while *building* the page, but the published page cannot call them.
- **Calls run as the viewer, not the author.** *"two people opening the same dashboard can see
  different data"*; *"The page never sees anyone's credentials; claude.ai makes the calls on the
  page's behalf."* Viewers **approve access before the first call**; a decliner still sees the
  page minus its live sections. Actions with side effects also run under the viewer's account.
- Fetch on load; refresh on an interval or via a page control; **responses cached in the
  viewer's browser** so a reopened page renders from cache then updates.
- **A connector-backed artifact cannot be shared to a public link on any plan.**
- Failure triage documented: viewer hasn't connected the connector; viewer declined (denial
  lasts the page load, reload re-asks); org disabled the **Enable artifact connectors** toggle.

**API shape (from the local contract file, runtime 0.1.29).** Two arms:
- **Display →** `watchTool(server, tool, input, handler, opts?) : Unsubscribe`. Replays the
  cached entry immediately, executes when missing/stale, and delivers every newer result:
  its own executions, `refetchInterval` polls (**clamped to a ~30 s floor**, paused while the
  page is hidden with a catch-up refetch on return, **coalesced per identity** so N sections
  cost one flight), other cached callers of the same identity, and `invalidate()`. Read-only
  tools only — tools with a wire-explicit `readOnlyHint: false` reject. Returns a *synchronous*
  unsubscribe; first delivery is no earlier than a microtask later. **All** failures arrive as
  `{type:"error"}` handler events, registration failures included.
- **Action →** `callTool(server, tool, input?, options?) : Promise<CallToolResult>`. Read
  `result.payload` (structuredContent if present, else first text block parsed as JSON, else
  that text verbatim). Tool-level failure **rejects** with `code:"tool_error"` carrying the full
  envelope on `.result`.
- Plus `listTools()` → `{servers: [{server, authStatus, tools:[{name, description, annotations}]}]}`
  (the manifest ∩ what this viewer actually connected), and
  `invalidate(server?, tool?, input?)` to drop cached results.
- `server` is the connector **display name** (e.g. `"Google Calendar"`), never an id — settled
  design, because a published page runs for many viewers.
- **Caching:** `cache: false | {staleTime, gcTime, refresh}`. Tools with wire-explicit
  `readOnlyHint: true` default to `{staleTime: 0, gcTime: 5 min}`. `staleTime` capped at
  **300 000 ms**, `gcTime` default 300 000 / cap **86 400 000**. Call identity is
  **order-insensitive** over `input` keys. Cached per viewer + artifact, successful results
  only, cleared on logout/account change/denial.
- `result.cache = {storedAt, revalidating}` is present **only** on cache-served results and is
  shell-attested (inbound `cache` fields are stripped). Drive "last updated" UI from `storedAt`,
  **never** `Date.now()`.
- `signal?: AbortSignal` per call (there is deliberately **no `timeoutMs`**); `cancelled` is an
  outcome-**unknown** state — the tool may still have run.
- Error codes: `needs_reauth`, `server_not_connected`, `selection_required`, `server_not_found`,
  `server_unavailable` (retryable), `not_in_manifest`, `blocked_by_policy`, `approval_required`,
  `tool_error`, `bad_request` (also: duplicate watch registration, **per-view watch limit 64**),
  `cancelled`, `rate_limited` (reserved), `upstream_error` (also the unanswered-call shape after
  the shell's ~130 s reply budget), plus lifecycle codes `not_granted`, `capability_disabled`,
  `capability_removed`, `transform_error`.
- Retry doctrine: only `retryable: true` errors, at most once per user-visible refresh, honouring
  `retryAfterMs` (shell-clamped to 60 s), **reads only** — `server_unavailable`/`upstream_error`
  on a *write* is an ambiguous outcome, not proof the write didn't land.
- Consent is readable/requestable per connector as scoped permission names `"mcp:<server>"`;
  bare `"mcp"` is the whole-manifest aggregate. `window.claude.mcp !== undefined` is the
  canonical availability gate.

**Dependency:** ANTHROPIC_SERVER_SIDE. The page hands the call to claude.ai, which holds the
OAuth tokens, runs the connector, enforces the manifest and org policy, and caches per viewer.
Nothing about it works without Anthropic's broker.

**Vela reimplementation.** This is the one place where Vela is structurally *better*, because
Vela already runs MCP clients locally.

- `window.vela.mcp` with **the same two-arm API and the same error-code strings**. Port the
  `.d.ts` verbatim; it is a genuinely well-designed contract and reimplementing it from scratch
  will produce a worse one.
- **Broker in the main process.** The frame never sees a token — it `postMessage`s
  `{server, tool, input}`; the main process looks up the MCP client (stdio or SSE/HTTP), checks
  the artifact's published **manifest**, checks consent, calls, and posts the result back.
  Same guarantee as claude.ai, minus the network.
- **Manifest.** `artifact_capability(artifact_id, name, config_json)`, declared at publish time
  by the model via the artifact tool's `capabilities` argument. Same declaration gestures:
  omitting on redeploy carries forward; `{}` clears; a non-empty object is a full-set
  declaration (unrestated entries revoked).
- **Consent.** Per-`server` grants (`mcp:<server>`) stored per (artifact, viewer-profile), with a
  first-call modal naming the connector and the tools. Denial persists for the session.
- **Cache layer.** Implement `staleTime`/`gcTime`/`refresh` and order-insensitive call identity
  in the main process (a small keyed-promise map — or literally TanStack Query's core, which is
  where these semantics come from). Persist across restarts in SQLite so reopen-renders-from-
  cache works. Stamp `cache.storedAt` yourself and strip any inbound `cache` field, exactly as
  the contract requires.
- **`watchTool` mechanics** to copy exactly: ~30 s poll floor, pause on `document.hidden` with a
  catch-up refetch, per-identity coalescing, 64-watch per-view limit, synchronous unsubscribe,
  read-only enforcement via the tool's `readOnlyHint` annotation.
- **Vela's divergence:** *local* MCP servers (`.mcp.json`, stdio) **are** callable from a Vela
  artifact, because there is no multi-tenant hosting problem. And a connector-backed artifact
  *can* be exported/LAN-shared — but with an explicit warning, since a LAN-shared page will run
  connector calls **through the host machine's** MCP clients unless the viewer runs Vela too.
  Safe default: connector-backed artifacts are `read_mode = owner` and export is blocked unless
  the user opts in per artifact (mirrors Anthropic's "cannot be shared publicly" rule).
- **Viewer-identity semantics.** When the viewer *does* run Vela (tier 2/4 sharing), calls
  resolve against **their** MCP config and **their** credentials — reproducing Anthropic's
  "each viewer uses their own connectors" property without any hosted broker.
- Ship the documented **degraded-state doctrine** in the artifact-authoring system prompt:
  branch on `code`, never a single generic banner, name the connector in the fallback copy,
  keep last-good data on transient errors and retract it on authz denials.

### 2.13 AI-powered artifacts (the artifact calls the model)

**Documented behaviour:** artifacts can *"embed AI capabilities"*; *"Users of your artifacts can
access Claude's intelligence through a text-based API"* without providing API keys; **usage
counts against each user's own Claude subscription, not yours** — *"You pay nothing for their
usage… Whether your artifact helps 10 people or 10,000, sharing is free."* Viewers authenticate
with their existing Claude account. Non-users viewing a published artifact are prompted to sign
up specifically to use *"AI-powered capabilities."* Documented limitations at announcement time:
no external API calls, text-based completion only.

The exact JS signature (`window.claude.complete`) is **not** in any page I could fetch — see the
"Not found" list in §0. The local mcp.d.ts does confirm chat artifacts use *"a different, flat
`window.claude`"*.

**Dependency:** ANTHROPIC_SERVER_SIDE. The completion runs on Anthropic's inference, metered to
the viewer's subscription.

**Vela reimplementation.** This is the feature that most directly justifies Vela's premise.

- Expose `window.vela.complete(prompt: string): Promise<string>` (keep the flat, dead-simple
  shape — it is what makes non-programmers able to build these) **plus** a richer
  `window.vela.chat({messages, system?, temperature?, max_tokens?, json_schema?, signal?})` and
  a streaming `window.vela.stream(...)` returning an async iterator.
- Bridge → main process → **the user's configured backend**, via a provider adapter layer:
  - llama.cpp `llama-server` → `POST /v1/chat/completions` (OpenAI-compatible)
  - Ollama → `POST /api/chat` (or its `/v1` compatibility shim)
  - LM Studio → `POST /v1/chat/completions`
  - vLLM / TGI / any OpenAI-compatible endpoint → same
  - Anthropic / OpenAI / Google / OpenRouter / Groq with the user's key from the OS keychain
  The frame **never** sees a base URL or a key — same "your code never sees tokens" guarantee.
- **Billing/consent inversion.** There is no hosted subscription to charge, so replace it with:
  a per-artifact **token/spend budget** (`max_calls`, `max_tokens_per_call`, `max_spend_usd`),
  a first-call consent modal naming the model that will run, live token accounting in the
  artifact panel header, and a hard stop when the budget is exhausted (`code: "budget_exceeded"`).
  For a shared artifact, the *viewer's* Vela and the *viewer's* budget apply — which reproduces
  "their usage counts against their subscription, not yours" exactly, with the user's own
  hardware or key instead of a plan.
- **Model-capability negotiation.** An artifact written against a 200k-context frontier model
  will fail on a local 8B. Expose read-only `window.vela.model = {id, family, context_window,
  supports_json_schema, supports_tools, supports_vision}` so pages can degrade, and add a
  system-prompt clause telling the model to write artifacts that check it.
- **Structured output.** Local models are bad at "return JSON" freeform. Route `json_schema`
  through llama.cpp GBNF grammars / Ollama `format` / vLLM guided decoding / provider-native
  JSON mode. This turns unreliable AI-powered artifacts into reliable ones and is the single
  highest-leverage thing Vela can add here.
- **Beyond Anthropic:** because inference is local, drop the "no external API calls" and
  "text-only" limitations — expose vision (`images: [...]`) and embeddings
  (`window.vela.embed(texts)`) where the backend supports them.

### 2.14 Persistent storage for artifacts

**Documented behaviour** (support 9487310, blog build-artifacts): available Pro/Max/Team/
Enterprise on web and desktop. **20 MB storage limit per artifact.** Two modes:
- **Personal storage** — *"Each user maintains their own private data"* (a journal artifact: your
  entries are visible only to you).
- **Shared storage** — *"All users see and interact with the same data"* (a leaderboard: everyone
  sees the same scores).
The artifact's creator chooses which data uses which mode when building it.
**Storage only works for published artifacts** — *"During development and testing, storage
operations will not succeed until the artifact is published."* Unpublishing **permanently
deletes the associated storage data**.

The key/value API surface is not publicly documented (see §0).

**Dependency:** ANTHROPIC_SERVER_SIDE — especially *shared* storage, which is a multi-tenant
database behind the viewer's auth.

**Vela reimplementation.**
- `window.vela.storage` with an async, `localStorage`-shaped API:
  `get(key)`, `set(key, value)`, `delete(key)`, `list(prefix?)`, `clear()`, each taking
  `{scope: "personal" | "shared"}`. Async because it crosses the postMessage bridge.
- Backing store: SQLite table `artifact_storage(artifact_id, scope, owner_id, key, value_json,
  updated_at)` with a **20 MB per-artifact quota** enforced in the main process
  (`code: "quota_exceeded"`), matching Anthropic's number so ported artifacts behave the same.
- **Personal scope** = keyed by the local profile id. Trivial, fully offline.
- **Shared scope** needs a rendezvous point, which is exactly the multi-user problem Vela cannot
  solve locally. Three honest options, in order:
  1. *Single-user default* — shared ≡ personal when the artifact is not shared. Do **not** fail;
     silently unify, so a leaderboard artifact still works for one person.
  2. *`vela-share` server (tier 4)* — the self-hosted server owns a real shared KV table with
     per-artifact namespacing and optimistic concurrency (`If-Match` on a version counter).
     This is the true equivalent.
  3. *User-supplied sync backend* — a Gist, a git repo, an S3 bucket, a CouchDB/Turso/Supabase
     URL the user configures. Last-write-wins with a conflict log.
- **Divergence worth making:** do *not* require publishing before storage works. Anthropic's
  "storage silently fails until published" is a genuinely bad developer experience that the
  docs themselves call out; Vela should have storage work identically in the local preview.

### 2.15 The "Code execution and file creation" prerequisite

**Documented behaviour:** *"We no longer support artifacts without **Code execution and file
creation** enabled in Settings > Capabilities"* (Free/Pro/Max) or Organization settings
(Team/Enterprise). The capability is *"a private computing environment"* — an isolated,
sandboxed container on Anthropic infrastructure, **not** on your machine. It creates `.xlsx`,
`.pptx`, `.docx`, PDF and PNG outputs; **30 MB per file** for uploads and downloads; files are
available for download in the conversation and can be saved to Google Drive; usage draws on the
plan's normal limits and *"creating files will use more of your limit compared to normal chats."*
Network egress tiers: **disabled** / **package managers only** (npm, PyPI, …) / **package
managers + specific domains** / **all domains**. Free/Pro/Max default to network on;
Team/Enterprise default to network off (Enterprise) or package-managers-only (Team). Documented
risk: with network access on, Claude could be *"tricked into exfiltrating data via network
requests."*

**Dependency:** ANTHROPIC_SERVER_SIDE (hosted container).

**Server-side detail:** a hosted, per-user-isolated Linux container with a Python/Node toolchain,
fronted by an egress proxy implementing the four network tiers.

**Vela reimplementation — the local substitute is the whole point:**
- **Sandbox:** Docker or Podman container by default (`vela/exec:latest`), preloaded with
  Python + `python-docx`, `python-pptx`, `openpyxl`, `reportlab`/`weasyprint`, `matplotlib`,
  `pandas`, `pillow`, plus Node + `sharp`/`puppeteer-core`. Run with `--network=none` by default,
  read-only rootfs, a tmpfs `/work`, a dropped-capability profile, `--pids-limit`, memory and CPU
  caps, and a wall-clock timeout.
- **No-Docker fallback:** `bubblewrap` (Linux), `sandbox-exec`/App Sandbox (macOS), or a
  Windows AppContainer / WSL2 container. Ship a bundled Python (or use `uv` with a pinned,
  vendored wheel cache) so the sandbox works offline on first run.
- **Egress tiers, reimplemented exactly:** attach the container to a network namespace whose only
  route is a local **allowlist proxy** (mitmproxy/`tinyproxy` with an ACL). Ship the same four
  levels — off / package registries only (pypi.org, files.pythonhosted.org, registry.npmjs.org,
  crates.io) / registries + user domains / all — with **off** as the default and a per-project
  override. This is materially safer than Anthropic's Free/Pro default.
- **File mounting:** artifacts and attachments bind-mount into `/work`; outputs are copied back
  into `~/.vela/artifacts/<id>/` and surfaced as downloadable files in the conversation. Enforce
  a per-file size cap (30 MB, matching).
- Vela should **not** make artifacts *depend* on the sandbox the way Anthropic does — HTML,
  React, Markdown, SVG and Mermaid artifacts need no container at all. Only file-producing
  artifacts (docx/pptx/xlsx/pdf/png-from-code) do.

### 2.16 Availability, gating, and kill switches

**Documented behaviour (Claude Code artifacts)** — every condition must hold:
- **Plan:** Pro, Max, Team, Enterprise. Pro/Max: private until shared, no admin management.
  Team: on by default. Enterprise: an Owner must enable.
- **Authentication:** the session must be backed by a claude.ai account (`/login`). **Sessions
  using an API key, an LLM-gateway token, or a cloud-provider credential cannot publish.**
- **Model provider: Anthropic API only.** Not available on Amazon Bedrock, Google Cloud's Agent
  Platform, or Microsoft Foundry.
- **Org policy:** unavailable when CMEK, HIPAA, or Zero Data Retention are enabled.
- **Surface:** Claude Code CLI **v2.1.183+** or desktop app **v1.13576.0+**; Claude Tag when
  enabled org-wide. **Off by default** in the Agent SDK, GitHub Action and MCP-server contexts,
  and when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.
- **Per-user disable:** settings `"disableArtifact": true`, env `CLAUDE_CODE_DISABLE_ARTIFACT=1`,
  or a permission rule adding `Artifact` to `permissions.deny`.
- Chat artifacts: Free, Pro, Max, Team, Enterprise; in Claude, Claude Desktop, and Claude Code.

**Dependency:** ANTHROPIC_SERVER_SIDE (entitlement checks) — and note the "Anthropic API only"
line is precisely the coupling Vela exists to remove.

**Vela reimplementation.** No plans, no entitlements, no provider restriction — artifacts work
on every backend, which is the product thesis. Keep the *shape* of the controls, because they
are what makes the feature deployable in a company:
- `~/.vela/settings.json` / `.vela/settings.json`: `"artifacts": {"enabled": true,
  "publish": "export" | "lan" | "host" | "share-server" | "off", "connectors": true,
  "publicSharing": false, "maxRenderedBytes": 16777216}`.
- Env overrides `VELA_DISABLE_ARTIFACT=1`, `VELA_ARTIFACT_AUTO_OPEN=0`.
- Permission-system rule `deny: ["Artifact"]`, and a policy file an MDM can drop for managed
  fleets (the equivalent of "an Owner enables it").
- Machine-local kill switch for network publishing that a policy file can pin (the local
  equivalent of the CMEK/HIPAA/ZDR exclusion).

### 2.17 Org administration, retention, audit

**Documented behaviour:** artifact content is *"stored on Anthropic-operated infrastructure and
is visible only to authenticated members of the publishing organization"* unless shared publicly.
Owners get, in claude.ai admin settings:
- **Settings > Claude Code > Capabilities → Artifacts** toggle (whole org), plus **Enterprise
  RBAC**: Settings > Roles → a role's **Artifacts** permission under the **Claude Code** group.
- **Settings > Capabilities → Enable artifact connectors** — a *separate* toggle from the
  artifacts toggle, governing connector calls from both Claude Code and claude.ai artifacts.
- **External sharing** under the Artifacts toggle: public sharing is **off by default** on
  Team/Enterprise. Turning it back off *"blocks access through existing public links without
  changing each artifact's audience; access resumes if you re-enable it."*
- **Settings > Data & privacy controls → retention policy**, with **separate retention periods
  for still-private artifacts vs shared artifacts**.
- **Audit log** events under `claude_artifact_*` for publish, share and delete.
- **Viewer domain allowlist:** the viewer loads each artifact from a sandboxed
  `*.claudeusercontent.com` origin; orgs restricting egress must allowlist it alongside
  `claude.ai`.

**Dependency:** ANTHROPIC_SERVER_SIDE.

**Vela reimplementation.**
- Local `artifact_audit(ts, event, artifact_id, version_id, actor, detail_json)` table with the
  same event vocabulary — `vela_artifact_published`, `vela_artifact_shared`,
  `vela_artifact_unshared`, `vela_artifact_deleted` — exportable as JSONL/CSV.
- **Retention job** on app start and daily: two configurable windows, private vs shared, deleting
  versions and blobs past the window. Mirrors Anthropic's split exactly.
- Managed-fleet policy file (`/etc/vela/policy.json`, `%ProgramData%\Vela\policy.json`, or an
  MDM-delivered profile) that pins `artifacts.enabled`, `artifacts.publicSharing`,
  `artifacts.connectors`, retention windows, and the allowed publish tiers — read-only from the
  app UI. This is the local equivalent of admin settings.
- The **"External sharing off blocks existing links without changing each artifact's audience"**
  behaviour is worth copying precisely: the `vela-share` server checks the org flag at request
  time rather than rewriting per-artifact `read_mode`, so flipping it back restores access.
- Vela's `*.claudeusercontent.com` analogue is the `vela-artifact://` protocol origin locally and
  a **distinct hostname** (never the app's own) for `vela-share` — same-origin separation is the
  security property, not the specific domain.

### 2.18 Programmatic listing / export / deletion (Compliance API)

**Documented behaviour.** Two families:

*Code artifacts* — `GET /v1/compliance/apps/code/artifacts` (list),
`GET /v1/compliance/apps/code/artifacts/{artifact_id}/versions/{version_id}` (stream one
version's content), `DELETE /v1/compliance/apps/code/artifacts/{artifact_id}` (permanent,
async content removal, returns `{id, type:"code_artifact_deleted"}`). Object fields:
`id` (tagged, `cart_…`), `organization_uuid`, `owner_user_id` (*"Always set, so attribution
survives after the owner's account is deleted"*), `published_version_id`,
`read_mode ∈ {owner, users, org, public}`, `updated_at`, `user {id, email_address}`,
`versions[] {id, created_at, name}` — *"Up to roughly 20 most-recently-published versions
(older versions are not retained)"*. Filters: `organization_ids`, `user_ids`, `updated_at`
(gt/gte/lt/lte), `limit` (default 20, max 100), opaque `page` cursor. Documented consistency
caveats: sorted by identifier not creation time, pages may be short or empty while `next_page`
is set, the time index is eventually consistent so *"omit the time filter for compliance-complete
enumeration."*

*Chat artifacts* — `GET /v1/compliance/apps/artifacts/{artifact_version_id}` (metadata:
`id`, `artifact_type` = MIME-like e.g. `application/vnd.ant.code`, `claude_chat_id`,
`created_at`, `md5` (lowercase hex, over the UTF-8 content), `size_bytes`, `title`,
`version_id`) and `…/content` (full text). The md5/size are there so *"a DLP consumer can dedupe
or match hashes without downloading every artifact."*

**Dependency:** ANTHROPIC_SERVER_SIDE.

**Vela reimplementation.** The whole point of a local app is that this is just the database.
- Ship a **local HTTP admin API** on `127.0.0.1` (token-gated) with the same routes and the same
  field names — `GET /v1/artifacts`, `GET /v1/artifacts/{id}/versions/{vid}`,
  `DELETE /v1/artifacts/{id}` — so any DLP tooling written against Anthropic's compliance API
  points at Vela with a base-URL change.
- Store `md5`/`sha256` and `size_bytes` per version (you already content-address blobs, so this
  is free) for the same dedupe/DLP use.
- Mirror `read_mode` and `published_version_id` semantics verbatim (§2.5, §2.8).
- **Retain all versions** rather than ~20, and note the divergence in the API docs so a consumer
  written against Anthropic's 20-version assumption doesn't break.
- A CLI: `vela artifacts ls|show|open|export|rm|prune`.

### 2.19 Design quality (the built-in design skill)

**Documented behaviour:** *"Claude applies a built-in design skill when it builds an artifact,
so pages get a deliberate palette, typography, and layout without extra prompting"* (Claude Code
v2.1.182+). The skill *"looks for an existing design system in your project before choosing its
own"*, reading design tokens recorded somewhere findable such as `CLAUDE.md` or a theme file:

```markdown
## Design system
- Colors: primary #1a4d8f, accent #f59e0b, surface #f8fafc
- Typography: Inter for body, JetBrains Mono for code
- Spacing: 8px scale, 6px border radius
```

Precedence, stated explicitly: **prompt > project design system > the skill's own choices.**
Separately, the `web-artifacts-builder` skill lets Claude develop with React + Tailwind +
shadcn/ui across multiple files and then **bundle to a single HTML file with Parcel**, because
artifacts must render as one file.

**Dependency:** CLIENT_SIDE_PORTABLE — it is prompt material plus a local bundler.

**Vela reimplementation.**
- Ship an equivalent **artifact design skill** as bundled prompt material (palette rules, type
  scale, spacing, dark/light token discipline, chart conventions), injected into the artifact
  system prompt. Because local models are weaker at aesthetics than frontier models, lean
  harder: give them a **prebuilt CSS token sheet** in the document shell (`--bg`, `--fg`,
  `--accent`, `--surface`, `--radius`, …) and instruct the model to *use tokens only*. That
  converts a taste problem into a lookup problem, which small models handle fine.
- **Theme awareness**, which Anthropic's shell requires: define the full light palette on bare
  `:root`, redefine tokens under `@media (prefers-color-scheme: dark)` guarded as
  `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]`, and give `body`
  an explicit token background. Bake this into the Vela document shell so the model can't get it
  wrong.
- **Project design tokens:** read `.vela/design-tokens.md`, `CLAUDE.md`, `VELA.md`, or a
  `tailwind.config.*` / `theme.css` in the project and inject them ahead of the default skill.
  Implement the same precedence: prompt > project > default.
- **Multi-file authoring + bundle:** the local esbuild path in §2.3 already does what Parcel does
  for `web-artifacts-builder`. Expose it as an explicit mode: the model may write
  `src/App.tsx` + components, and Vela bundles to a single inlined HTML before render/publish.

### 2.20 Cowork "live artifacts" — the local-execution precedent

**Documented behaviour** (support 14729249): *"persistent, interactive HTML dashboards"* in the
Artifacts view of Claude Desktop (macOS, Windows, Linux beta), labelled **Cowork** to distinguish
them from chat artifacts. They **execute locally on your device** and pull from connected apps
and **local files**. On open they *"pull fresh data from your connected apps"*; a short cache
prevents constant re-querying, with a manual refresh button in the artifact header. Each
iteration is a **saved version** you can review and restore. **Sharing is Team/Enterprise only**,
org-internal — *"Anyone in your organization who has the link can open the artifact"*, no public
links. *"Shared artifacts use the viewer's access, not yours."* Storage is **local-only —
artifacts don't sync across devices**. Live artifacts use **pre-approved connectors without
asking per use** (unlike Claude Code artifacts, which prompt each viewer).

**Dependency:** MIXED — local execution and local storage, Anthropic-side connectors and sharing.

**Vela reimplementation.** This is essentially the Vela design already: local execution, local
storage, viewer's own access. Concretely:
- Make **every** Vela artifact a "live artifact": a refresh button in the panel header, an
  on-open data fetch through local MCP clients, and a short (30–60 s) cache with the freshness
  timestamp drawn from `cache.storedAt` (§2.12).
- Match the **consent divergence** deliberately: for *locally-viewed* artifacts, pre-approved
  connectors run without a per-use prompt (Cowork behaviour — the user already trusts their own
  machine); for *shared/exported* artifacts, require explicit per-viewer consent (Claude Code
  behaviour). Encode this as a `trust` field on the artifact record.
- Accept "no cross-device sync" as the default, and offer opt-in sync via the user's own store
  (git repo, S3, Syncthing folder) rather than a Vela cloud.

### 2.21 Provenance (Claude Science model) — Vela should adopt this

**Documented behaviour** (claude.com/docs/claude-science/artifacts): *"Every artifact version
records how it was made."* The **Provenance** view has five tabs:
**Messages** (the conversation around the save), **Code** (a reproducible script, downloadable as
a script or a notebook), **Execution Log** (every command that ran), **Environment** (environment
name, language version, and every installed package with its version), **Review** (reviewer
findings). And the authority rule: *"The Execution Log is the authoritative record of what ran.
If the Code tab and the log disagree, trust the log."*
Also: artifacts persist until deleted, while other session files *"are cleared a few hours after
the session ends"*; deleting a session keeps its artifacts and provenance; deleting a project
deletes everything.

**Dependency:** CLIENT_SIDE_PORTABLE — it is all local recording.

**Vela reimplementation.** Adopt wholesale; it costs almost nothing on a local app and it is the
strongest answer to "can I trust what a local model produced":
- Per version, record: the message range that produced it, the extracted generating code, the
  full sandbox execution log (argv, exit code, stdout/stderr, wall time), and an environment
  fingerprint (`pip freeze` / `npm ls --json`, interpreter versions, container image digest).
- **Also record the model fingerprint** — this is Vela-specific and essential given the premise:
  `{backend, model_id, quantisation, context_window, temperature, top_p, seed, prompt_sha256,
  system_prompt_sha256}`. Two artifacts from "the same prompt" are not comparable across a
  Q4_K_M and a Q8_0 of the same weights, and the provenance panel is where you learn that.
- Emit a one-click **reproduce** button: re-run the recorded code in a fresh sandbox with the
  recorded environment and diff the output against the stored version.
- Same lifecycle rules: artifacts survive session deletion; scratch files are GC'd on a timer;
  deleting a project cascades.

### 2.22 Removed/absent capabilities worth noting

- **Remix is gone.** *"The Remix button is no longer available"*; you copy code into a new chat.
  Vela should implement Duplicate/Fork properly (one row insert, parent pointer for lineage).
- **Unpublish is a one-way door** — you can never republish that artifact, and its storage is
  permanently deleted. Vela should not copy this.
- **No backend, ever.** Anthropic is explicit: an artifact *"is a capture of work, not an
  application"* — no routes, no form persistence, no viewer auth of its own. *"For a hosted
  internal tool with a backend, deploy it on your own infrastructure instead."* Vela should
  state the same boundary, but its ceiling is higher: a local artifact has a local model, local
  MCP servers and local storage, so a genuinely useful single-page tool is achievable without
  any backend.
- **Public-link + connectors is forbidden** on every plan. Vela's analogue: connector-backed
  artifacts default to `read_mode = owner`, export gated behind an explicit warning.

---

## 3. Implementation checklist for Vela (ordered)

1. `artifact` / `artifact_version` / `blob` schema + content-addressed store.
2. Dual extraction (tool-call path + stream-sniffer path) + per-model capability profile.
3. Sandboxed viewer: custom protocol origin, hard CSP, document shell, theme tokens.
4. Renderers: markdown, code, HTML, SVG (sanitised), Mermaid (in-frame), React via bundled
   esbuild + vendored library set.
5. Streaming live render + debounced rebuild + compile-error repair loop.
6. Version stepper + diff view + restore; version-pinned links.
7. Gallery: FTS search, the Claude Science action menu, star/rename/delete.
8. Copy / download / **export self-contained HTML** (the default share path).
9. `window.vela` bridge + `window.claude` compatibility shim.
10. `window.vela.downloads` — contract-identical to `downloads.d.ts` 0.1.29.
11. `window.vela.complete` / `.chat` / `.stream` over the provider-adapter layer, with budgets,
    consent, structured output via grammars, and `window.vela.model` capability introspection.
12. `window.vela.storage` — personal + shared scopes, 20 MB quota, works unpublished.
13. `window.vela.mcp` — port the 0.1.29 contract, broker in main process, manifest + consent,
    cache with staleTime/gcTime/order-insensitive identity, watch with 30 s floor / hidden-pause
    / coalescing / 64-watch cap.
14. Local exec sandbox (Docker/podman → bubblewrap fallback) with the four egress tiers, for
    docx/pptx/xlsx/pdf/png artifacts.
15. Publish tiers: export → LAN + capability token + `frame-ancestors` → BYO host → `vela-share`.
16. Live update: file watcher locally, SSE/WebSocket on `vela-share`, ETag polling on static hosts.
17. Provenance recorder (incl. model fingerprint) + reproduce button.
18. Policy file, audit log, retention job, local compliance-shaped HTTP API + CLI.
19. Design skill prompt material + project design-token discovery + precedence.

## 4. Explicit server-side dependencies and their local substitutes (summary)

| Anthropic server-side thing | Local substitute in Vela |
| --- | --- |
| Hosted artifact page at `claude.ai/code/artifact/<uuid>` on `*.claudeusercontent.com` | `vela-artifact://<id>` custom protocol locally; self-contained HTML export; LAN server; BYO static host; self-hosted `vela-share` |
| Hosted iframe runtime + CSP | Electron/Tauri WebView, distinct opaque origin, `connect-src 'none'` CSP, postMessage bridge |
| `window.claude.complete` on Anthropic inference, billed to the viewer's subscription | `window.vela.complete/chat/stream` → provider adapters (llama.cpp, Ollama, LM Studio, vLLM, any OpenAI-compatible endpoint, or a BYO key), with per-artifact token/spend budgets |
| Server-side connector broker holding OAuth tokens | Main-process MCP broker over the user's local + remote MCP servers; tokens in the OS keychain, never in the frame |
| Server-side per-viewer response cache | SQLite-backed cache in the main process implementing the same staleTime/gcTime/identity semantics |
| Server-side 20 MB artifact storage, personal + shared | SQLite `artifact_storage` for personal; `vela-share` server or a user-supplied sync backend for shared |
| Hosted code-execution container (docx/pptx/xlsx/pdf) with egress tiers | Docker/Podman `vela/exec` image (python-docx, python-pptx, openpyxl, reportlab, matplotlib) with `--network=none` default and a local allowlist egress proxy; bubblewrap/sandbox-exec fallback |
| Org admin toggles, RBAC, retention, audit log | MDM-deployable `policy.json`, local audit table, scheduled retention job |
| Compliance API (list/download/delete) | Token-gated `127.0.0.1` HTTP API with identical routes and field names, plus a `vela artifacts` CLI |
| Plan/entitlement and "Anthropic API only" gating | Removed — every backend works; only local policy can restrict |
