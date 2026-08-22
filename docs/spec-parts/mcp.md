# MCP and Connectors — ingestion notes for Vela

Area owner: MCP / Connectors (client side of the Model Context Protocol, plus the Claude
product surface built on it).

All content below was fetched live on 2026-08-12. Every claim is traceable to a URL in
the "Sources fetched" list. Nothing here is reconstructed from memory; anything I could
not fetch is listed under "Sources unreachable" (currently empty).

**Framing for Vela.** Vela is a model-agnostic desktop app. MCP is the single largest
*genuinely portable* subsystem in the Claude Desktop feature set: the protocol is an open
standard, the SDKs are open source, and nothing about `tools/list` or `tools/call`
depends on which model is behind the agent loop. The parts that are **not** portable are
(a) Anthropic's *hosted* MCP client — claude.ai reaches remote connectors from Anthropic's
cloud egress range, not the user's machine — and (b) the Connectors Directory, which is
Anthropic's curated catalog, plus the review/verification pipeline behind it. Vela
reimplements (a) as a *local* MCP client in the desktop process, which is strictly more
capable (it can reach `localhost`, private IPs, VPN-only hosts), and (b) as a local
registry/catalog with an optional community index.

---

## Sources fetched

Spec (modelcontextprotocol.io, revision `2026-07-28`):

- https://modelcontextprotocol.io/llms.txt
- https://modelcontextprotocol.io/specification/2026-07-28/basic/index.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/index.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md
- https://modelcontextprotocol.io/specification/2026-07-28/server/resources.md
- https://modelcontextprotocol.io/specification/2026-07-28/server/prompts.md
- https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/index.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery.md
- https://modelcontextprotocol.io/docs/2026-07-28/learn/client-concepts.md
- https://modelcontextprotocol.io/docs/develop/connect-local-servers

Product surface (claude.com/docs):

- https://claude.com/docs/llms.txt
- https://claude.com/docs/connectors/overview.md
- https://claude.com/docs/connectors/getting-started.md
- https://claude.com/docs/connectors/directory.md
- https://claude.com/docs/connectors/verification.md
- https://claude.com/docs/connectors/custom/remote-mcp.md
- https://claude.com/docs/connectors/custom/desktop-extensions.md
- https://claude.com/docs/connectors/building/mcp.md
- https://claude.com/docs/connectors/building/mcpb.md
- https://claude.com/docs/connectors/building/authentication.md
- https://claude.com/docs/connectors/building/lazy-authentication.md
- https://claude.com/docs/connectors/building/enterprise-managed-auth.md
- https://claude.com/docs/connectors/building/directory-vs-custom.md
- https://claude.com/docs/connectors/building/submission.md
- https://claude.com/docs/connectors/building/troubleshooting.md
- https://claude.com/docs/connectors/building/mcp-apps/getting-started.md

Claude Code / platform:

- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/managed-mcp
- https://platform.claude.com/docs/en/agents-and-tools/mcp-connector

Support:

- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop

## Sources unreachable

None. All URLs above returned content.

---

## 1. The base protocol as of revision `2026-07-28` — and why this matters a lot

Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/index.md

The current revision made **breaking architectural changes** that a new client
implementation must get right, and which most tutorial material on the internet predates.
Vela should implement the new model *and* the legacy fallback, because the vast majority
of deployed servers in the wild still speak `2025-06-18` / `2025-11-25`.

Key points:

- **MCP is now a stateless protocol.** "All the information needed to process a request is
  contained in the request itself. A server processes each request independently; no state
  should be inferred from previous requests, even those on the same connection or stream."
  There is no `initialize` handshake in the modern era. A stdio process is explicitly
  *not* a session: "clients may interleave unrelated requests on the same transport, and a
  server must not treat connection or process identity as a proxy for conversation
  continuity."
- **Per-request metadata replaces the handshake.** Every client request MUST carry, in
  `params._meta`:
  - `io.modelcontextprotocol/protocolVersion` (string, **required**, e.g. `"2026-07-28"`)
  - `io.modelcontextprotocol/clientCapabilities` (**required**, may be `{}`)
  - `io.modelcontextprotocol/clientInfo` (optional but SHOULD be sent; `{name, version}`)
  - `io.modelcontextprotocol/logLevel` (optional)
  A request missing a required field is malformed → server MUST return `-32602`, and on
  HTTP a `400`.
- **Server capability discovery** is now `server/discover`, returning a `DiscoverResult`
  with `supportedVersions` and a `capabilities` object (`tools.listChanged`,
  `resources.{listChanged,subscribe}`, `prompts.listChanged`).
- **`resultType` on every result.** `"complete"` = final. `"input_required"` = an
  `InputRequiredResult` (see MRTR below). Unrecognized `resultType` MUST be treated as
  invalid. **Absent `resultType` MUST be treated as `"complete"`** — that is the
  compatibility hook for older servers.
- **Server→client requests no longer exist.** "servers do not initiate JSON-RPC requests
  and clients do not send JSON-RPC responses." Sampling/elicitation/roots are now folded
  into MRTR (below).
- **Error code partitioning.** Standard JSON-RPC codes plus: `-32000..-32019` legacy (do
  not allocate), `-32020..-32099` reserved for the spec. Defined: `-32020`
  `HeaderMismatch`, `-32021` `MissingRequiredClientCapability`, `-32022`
  `UnsupportedProtocolVersion`. `-32002` (resource-not-found) is retired but clients
  SHOULD still accept it from older servers. `-32042` (URL elicitation required, 2025-11-25
  only) is retired.
- **`_meta` key namespacing.** Prefix is reverse-DNS + `/`. Any prefix whose second label
  is `modelcontextprotocol` or `mcp` is reserved. `traceparent` / `tracestate` / `baggage`
  are reserved for W3C Trace Context (an explicit exception to the prefix rule).
- **JSON Schema rules.** Default dialect is 2020-12 when `$schema` is absent. Clients MUST
  support 2020-12. Crucially: **implementations MUST NOT auto-dereference `$ref` values
  that resolve to a network URI**; an opt-in mode may exist but must be off by default,
  must reject loopback/link-local/private addresses, and must apply timeouts and size
  limits. Schemas failing validation due to an unresolved external `$ref` SHOULD be
  rejected rather than treated permissively. Also: bound composition-keyword depth
  (`anyOf`/`oneOf`/`allOf`/`$defs`) to avoid schema-validation DoS.
- **`icons`** on Implementation/Tool/Prompt/Resource: array of `{src, mimeType, sizes,
  theme}`. Clients that render icons MUST support `image/png` and `image/jpeg`, SHOULD
  support `image/svg+xml` and `image/webp`. Security rules are strict and worth copying
  verbatim into Vela: only `https:` or `data:` URIs; reject `javascript:`, `file:`, `ftp:`,
  `ws:`, local-app schemes; disallow cross-origin redirects; fetch **without credentials**
  (no cookies, no `Authorization`); verify same-origin with the server; detect content type
  by magic bytes and reject mismatches; cap image and content size; SVG may contain
  executable content, so sanitize or disallow.

### Vela implementation note

Write the MCP client as a standalone Rust/TypeScript crate/package inside Vela with a
transport-agnostic core (`JsonRpcPeer`) and pluggable bindings. Represent protocol era as
an enum (`Modern2026_07_28`, `Legacy2025_11_25`, `Legacy2025_06_18`, `LegacyHttpSse2024_11_05`)
and negotiate per server, persisting the detected era so startup is one round trip.

---

## 2. Transports

Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/index.md

"Protocol semantics are identical on every transport. A transport is a **binding**." Two
standard bindings — stdio and Streamable HTTP — plus explicitly permitted custom
transports. Custom transports over a reliable bidirectional byte stream (Unix domain
sockets, TCP) **SHOULD reuse the stdio framing** rather than inventing a new one; only the
process-lifecycle rules are specific to standard streams. That is a direct green light for
Vela to run MCP over a Unix socket to a sandboxed helper process.

### 2.1 stdio

Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio.md

- Client launches the server as a subprocess. Server reads JSON-RPC from `stdin`, writes
  to `stdout`. **One message per line; messages MUST NOT contain embedded newlines.**
- Server MAY write arbitrary UTF-8 to `stderr` for logging. Client MAY capture, forward, or
  ignore it and **SHOULD NOT assume stderr output indicates an error** (many stdio servers
  log everything to stderr).
- Server MUST NOT write anything to `stdout` that is not a valid MCP message. Client MUST
  NOT write anything to `stdin` that is not a valid MCP message.
- Client MUST NOT write JSON-RPC *responses*; server MUST NOT write JSON-RPC *requests*.
- All messages share one channel — there are no per-request streams. Notifications arriving
  for a `subscriptions/listen` stream MUST be correlated via
  `_meta["io.modelcontextprotocol/subscriptionId"]`.
- **Cancellation** on stdio = send `notifications/cancelled` referencing the request ID.
  Server SHOULD stop work ASAP and MUST NOT send further messages for that request.
- **Shutdown**: client SHOULD (1) close the child's stdin, (2) wait for exit, (3) force-kill
  if it doesn't exit in reasonable time — POSIX escalate `SIGTERM`→`SIGKILL`; Windows use
  `TerminateProcess` or Job Objects. Servers SHOULD exit promptly on stdin EOF — "the
  primary graceful-shutdown signal and the only portable one."
- **Unexpected termination**: client SHOULD restart the process. Because the protocol is
  stateless, in-flight requests are simply lost and can be retried against the fresh
  process. Active `subscriptions/listen` streams must be re-established after restart.
- **Backward-compat probe**: a client supporting both eras SHOULD send `server/discover`
  *first*, with its preferred modern version in `_meta`. Three outcomes: (a) a
  `DiscoverResult` → modern server, pick a mutually supported version from
  `supportedVersions`; (b) a recognized modern JSON-RPC error such as
  `UnsupportedProtocolVersionError` → modern server, use a version from its `supported`
  list, **do not fall back to `initialize`**; (c) any other error, or no response within a
  reasonable timeout → legacy server, fall back to the `initialize` handshake. The fallback
  MUST NOT be keyed to one error code — legacy servers reply with implementation-defined
  errors (commonly `-32601` or `-32602`) or nothing at all.

**Vela**: this is 100% portable and is Vela's *primary* transport. Spawn with an explicit
argv (never a shell string), a clean environment plus an explicit allowlist of inherited
vars, line-buffered pipes, a bounded line-length guard (a hostile server can emit an
unbounded line), and a per-process log file capturing stderr — mirror Claude Desktop's
`mcp-server-<NAME>.log` convention. Use process groups / Job Objects so orphaned
grandchildren (`npx` spawning node) die with the parent.

### 2.2 Streamable HTTP (current shape)

Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md

The 2026-07-28 revision **changed this transport significantly**:

- **Removed**: the GET stream endpoint, protocol-level sessions (`Mcp-Session-Id`),
  `Last-Event-ID` resumability, and server-initiated JSON-RPC requests on SSE streams.
- Server exposes **one endpoint** that accepts POST. Every JSON-RPC message is its own POST.
- Client MUST send `Accept: application/json, text/event-stream` and MUST include the
  request-metadata headers.
- Body is a single JSON-RPC request or notification (never a response). For a
  *notification*, the server MUST return `202 Accepted` with no body, or an HTTP error.
- For a *request*, the server returns either `Content-Type: application/json` (one JSON
  object) or `Content-Type: text/event-stream` (an SSE stream scoped to that request,
  carrying `notifications/progress` / `notifications/message` and then the final response,
  which SHOULD terminate the stream). **The client MUST support both.**
- **Cancellation on HTTP = closing the SSE response stream.** No `notifications/cancelled`
  is expected on HTTP.
- Long-lived change notifications come from the response stream of a
  `subscriptions/listen` request, not a standalone GET stream. Servers SHOULD send
  `X-Accel-Buffering: no` and periodic SSE comment keep-alives (`:\r\n`); clients MUST
  ignore comment lines.
- **Resumable SSE via `Last-Event-ID` is not supported** in this revision.

**Required request headers (mirrored from the body, and validated against it):**

| Header | Source field | Required for |
|---|---|---|
| `MCP-Protocol-Version` | `_meta` protocolVersion | all requests |
| `Mcp-Method` | `method` | all requests |
| `Mcp-Name` | `params.name` or `params.uri` | `tools/call`, `resources/read`, `prompts/get` |
| `Mcp-Param-{Name}` | annotated `x-mcp-header` params | when the value is present |

Mismatch between header and body → server MUST return `400` + JSON-RPC `-32020`
`HeaderMismatch`. Unknown method → `404` + `-32601`. Unsupported version → `400` +
`UnsupportedProtocolVersionError` listing supported versions.

**Value encoding**: header values must be visible ASCII. Anything else (non-ASCII, control
chars, leading/trailing whitespace, or a literal that itself matches the sentinel) MUST be
sent as `=?base64?{b64}?=`, lowercase markers, exactly. Booleans lowercase `true`/`false`;
integers as decimal; `number` type is **not permitted** for `x-mcp-header`.

**`x-mcp-header` client obligations (this one is easy to miss):** clients on Streamable
HTTP **MUST** support the extension. They MUST reject tool definitions whose
`x-mcp-header` value violates the constraints — "rejection means the client MUST exclude
the invalid tool from the result of `tools/list`" — and SHOULD log a warning naming the
tool and reason, so one bad tool doesn't kill the server's other tools. Constraints:
non-empty; RFC 9110 token syntax; no CR/LF; case-insensitively unique within the
`inputSchema`; primitive types only (integer/string/boolean, integers within ±2^53−1); and
**statically reachable from the schema root through `properties` chains only** — never
through `items`, `oneOf`/`anyOf`/`allOf`/`not`, `if`/`then`/`else`, or `$ref`. Clients on
other transports (stdio) MAY ignore `x-mcp-header` entirely.

**Security & endpoint rules:** servers MUST validate the `Origin` header (DNS-rebinding
defense) and respond `403` if present and invalid; when running locally SHOULD bind only
to `127.0.0.1`, not `0.0.0.0`; SHOULD implement authentication.

**Backward compatibility a client must implement:**

- Modern-first probe: attempt a modern POST. On `400`, inspect the body — if it's a
  recognized modern JSON-RPC error (`UnsupportedProtocolVersion`,
  `MissingRequiredClientCapability`, header validation), the server is modern: retry with a
  supported version or fix the request. If the body is empty or unrecognized, fall back to
  `initialize` and stay legacy.
- Servers speaking only this revision should answer GET/DELETE with `405`, ignore
  `Mcp-Session-Id`, and ignore `Last-Event-ID`.
- **Legacy HTTP+SSE (protocol `2024-11-05`), deprecated since `2025-03-26`**: client
  attempts POST; on `400`/`404`/`405` *and* an unrecognized body, issue a **GET** to the
  server URL expecting an SSE stream whose first event is an `endpoint` event naming the
  POST URL; then use that transport for everything.
- **Sessioned Streamable HTTP (`2025-03-26` … `2025-11-25`)**: servers may assign
  `Mcp-Session-Id` (terminated via HTTP `DELETE`), clients may open a standalone GET SSE
  stream for server-initiated messages, servers may send JSON-RPC *requests* on SSE, and
  streams are resumable via `Last-Event-ID`. Vela must implement this shape too — it is
  what almost every deployed remote server speaks today.

**Vela**: implement three HTTP sub-modes behind one `HttpBinding`: `Modern2026`,
`Sessioned2025` (with session ID persistence, GET listen-stream, `Last-Event-ID` resume,
and server→client request handling for `sampling/createMessage`, `elicitation/create`,
`roots/list`), and `LegacySse2024` (GET-then-endpoint-event). Persist the negotiated mode
per server URL so subsequent launches skip probing.

### 2.3 WebSocket (Claude Code only, not in the spec)

Source: https://code.claude.com/docs/en/mcp

Claude Code supports a fourth transport, `"type": "ws"`, for "remote MCP servers that push
events to Claude unprompted." It accepts the same `url`, `headers`, `headersHelper`,
`timeout`, `alwaysLoad` fields as `http`. **Auth is header-only** — no OAuth, and
`claude mcp add --transport` does not accept `ws`. WebSocket servers do not appear in
`claude mcp list` (only `claude mcp get` / `/mcp`) and have no per-request timer.

**Vela**: worth supporting as an opt-in custom transport; the spec explicitly permits
custom transports as long as JSON-RPC framing, message patterns, and per-request metadata
are preserved.

---

## 3. Tools

Source: https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md

- Capability: `{"capabilities": {"tools": {"listChanged": true}}}`.
- `tools/list` supports pagination (`cursor` / `nextCursor`) and caching (`ttlMs`,
  `cacheScope`). The tool set **MUST NOT vary per-connection or as a side effect of other
  requests**, but **MAY vary by the authorization presented on the request** — credentials
  are per-request input, not connection state.
- Servers SHOULD return tools in a deterministic order, explicitly so clients can cache and
  so LLM prompt-cache hit rates stay high.
- Tool definition: `name`, optional `title`, `description`, `icons`, `inputSchema`
  (required, must be a valid JSON Schema *object*, not `null`), optional `outputSchema`,
  optional `annotations`.
- **Tool names**: SHOULD be 1–128 chars, case-sensitive, only `[A-Za-z0-9_.-]`, unique
  within a server. Uniqueness is **only** scoped to one server; aggregating clients SHOULD
  prefix with a server identifier, and the server's self-reported `name` from `serverInfo`
  is **not** guaranteed unique and SHOULD NOT be used for disambiguation.
- **Tool annotations are untrusted.** "clients MUST consider tool annotations to be
  untrusted unless they come from trusted servers."
- **Results.** Unstructured `content[]` of `text` / `image` / `audio` / `resource_link` /
  `resource` (embedded), each supporting `annotations` (`audience`, `priority`,
  `lastModified`). Structured results go in `structuredContent` (any JSON value) and, if
  `outputSchema` is declared, servers MUST conform and **clients SHOULD validate**. For
  backwards compat a structured tool SHOULD also emit the serialized JSON as a text block.
  `structuredContent` is *not* related to LLM "structured outputs."
- **Two error channels.** Protocol errors (unknown tool, malformed request, server error)
  come back as JSON-RPC errors and are "less likely to result in successful recovery";
  clients MAY pass them to the model. Tool *execution* errors come back as a normal result
  with `isError: true` and actionable text; clients **SHOULD** feed these to the model so
  it can self-correct.
- **Stateful tools** are explicitly non-protocol: there is no session, so servers must
  return an explicit opaque handle from a creation tool and accept it as an argument later.
  Guidance: validate authorization against the handle on every call; use high-entropy
  opaque IDs with bounded lifetime when unauthenticated; state retention policy in the
  creation tool's description; expired handle → tool execution error so the model recovers.
- **Client security duties**: prompt for confirmation on sensitive operations; **show tool
  inputs to the user before calling the server** (exfiltration defense); validate results
  before passing to the LLM; follow the `$ref` resolution restrictions; implement timeouts;
  log tool usage for audit.

### Anthropic's product-level tool rules

Source: https://claude.com/docs/connectors/building/mcp.md and
https://claude.com/docs/connectors/building/submission.md

claude.com states "All MCP tools must declare" `readOnlyHint` and `destructiveHint`, and
directory submission requires "All tools must include a `title` and the applicable
`readOnlyHint` or `destructiveHint`." The submission portal groups a server's tools by
read-only vs write vs unannotated and flags missing titles/annotations before you can
submit.

### Anthropic `_meta` extensions on tools (Claude Code)

Source: https://code.claude.com/docs/en/mcp

- `_meta["anthropic/maxResultSizeChars"]` — raises the persist-to-disk threshold for that
  tool's text output, hard ceiling 500,000 characters. Without it, oversized results are
  written to disk and replaced by a file reference in the conversation.
- `_meta["anthropic/requiresUserInteraction"]: true` — forces a permission prompt on every
  call, even in `acceptEdits` / `auto` / `bypassPermissions` modes, with no
  "don't ask again" option; allow-rules don't skip it; in `dontAsk` mode the call is
  denied. Designed for consent/access-grant tools "where auto-approval would mean no human
  ever agreed." Non-interactive `--permission-prompt-tool` approvals for such tools are
  converted to denies.
- `_meta["anthropic/alwaysLoad"]: true` — exempt a single tool from tool-search deferral.

### Vela reimplementation

Fully portable. Vela's agent loop converts `tools/list` entries into whatever tool-schema
shape the active backend wants:

- **Anthropic-format backends** (Claude API, or a local server exposing an Anthropic-shaped
  endpoint): pass `inputSchema` through nearly unchanged.
- **OpenAI-format backends** (vLLM, llama.cpp `--jinja` with tool templates, LM Studio,
  Ollama `/api/chat` tools): wrap as `{"type":"function","function":{name,description,parameters}}`.
- **Backends with no native tool calling** (a plain GGUF instruct model): fall back to a
  prompted ReAct/JSON protocol — Vela renders tool schemas into the system prompt and
  parses a fenced JSON block, with grammar-constrained decoding (GBNF for llama.cpp,
  `response_format` / xgrammar for vLLM) built from the tool's `inputSchema` when the
  backend supports it. This is the key model-agnostic trick: MCP already hands you a JSON
  Schema, which is exactly what a GBNF/xgrammar constraint needs.

Concrete client tasks:
- Namespaced tool IDs: `mcp__<serverKey>__<toolName>`, with the same character
  sanitization Claude Code uses (anything outside `[A-Za-z0-9_-]` → `_`), and a collision
  table so two servers exposing `search` don't clash.
- Sanitize schemas for backend limits: many local runtimes reject root-level
  `anyOf`/`oneOf`/`allOf`. Copy Claude Code's mitigation — flatten the union into one
  object, merge branch properties, and *describe* each branch's `required` list in the
  tool description rather than skipping the tool. Keep server-side validation as the real
  gate.
- Validate `structuredContent` against `outputSchema` locally (ajv / jsonschema) and
  surface violations as a warning, not a hard failure.
- Implement `isError: true` → feed the text to the model verbatim; JSON-RPC error →
  surface in UI and optionally feed a condensed form.
- Treat annotations as untrusted: use `readOnlyHint` only to *relax* the UI (e.g. default
  auto-allow read-only tools), never to *escalate*.

---

## 4. Resources

Source: https://modelcontextprotocol.io/specification/2026-07-28/server/resources.md

- Capability `{"resources": {"listChanged": bool, "subscribe": bool}}`; both optional and
  independent; `{}` is valid.
- `resources/list` (paginated, cacheable), `resources/templates/list` (RFC 6570 URI
  templates, arguments auto-completable via the completion API), `resources/read`
  (cacheable; MAY return multiple `contents` — e.g. a directory resource returning several
  files; MAY return `InputRequiredResult`).
- Resource fields: `uri`, `name`, `title`, `description`, `icons`, `mimeType`, `size`.
  Contents are `{uri, mimeType, text}` or `{uri, mimeType, blob}` (base64).
- Annotations: `audience` (`["user","assistant"]`), `priority` (0.0–1.0), `lastModified`
  (ISO 8601).
- URI schemes: `https://` (only when the *client* can fetch it directly, otherwise use
  another scheme), `file://` (need not map to a real filesystem; MAY use XDG MIME types
  like `inode/directory` for non-regular files), `git://`, plus custom RFC 3986 schemes.
- Errors: non-existent resource → `-32602`; internal → `-32603`; accept `-32002` from older
  servers. Servers MUST NOT return an empty `contents` array for a non-existent resource
  because it's ambiguous.
- Subscriptions moved: `resources/subscribe` is gone; you now list URIs in
  `subscriptions/listen`'s `notifications.resourceSubscriptions`.
- Security: servers MUST validate URIs and MUST sanitize file paths against directory
  traversal for `file://`.

**Vela**: resources are the natural backing for Vela's `@`-mention / context-picker UI.
Build a unified attachment picker that merges local files with `resources/list` and
`resources/templates/list` across all connected servers, fuzzy-searchable, exactly as
Claude Code does with `@server:protocol://path`. Cache reads per `ttlMs`/`cacheScope`.
Since Vela runs locally, `file://` resources can be rendered inline with a real file
preview. Enforce the client-side security rules yourself: never auto-fetch an `https://`
resource with credentials, and treat `blob` size limits explicitly.

---

## 5. Prompts

Source: https://modelcontextprotocol.io/specification/2026-07-28/server/prompts.md

- Capability `{"prompts": {"listChanged": bool}}`, declared in `DiscoverResult`.
- Prompts are **user-controlled**: "exposed from servers to clients with the intention of
  the user being able to explicitly select them." The canonical UI is a slash command.
- `prompts/list` (paginated, cacheable — the example shows `ttlMs: 600000`,
  `cacheScope: "public"`). Prompt: `name`, `title`, `description`, `icons`, `arguments[]`
  (`{name, description, required}`).
- `prompts/get` with `arguments` returns `{description, messages[]}` where each message is
  `{role: "user"|"assistant", content: text|image|audio|resource_link|resource}`. Arguments
  may be autocompleted via the completion API. MAY return `InputRequiredResult`.
- Errors: invalid name / missing required argument → `-32602`; internal → `-32603`.

**Vela**: surface MCP prompts as slash commands using Claude Code's naming convention
(`/mcp__<server>__<prompt>`), normalizing spaces to underscores, with space-separated
positional argument parsing driven by the declared `arguments[]` order. The returned
`messages[]` are injected directly into the conversation — this is model-agnostic because
the roles are just `user`/`assistant`. Multimodal prompt content (image/audio) must be
gated on backend capability: if the local model is text-only, degrade gracefully (describe
the attachment, or run it through a local captioner/ASR side model) rather than failing.

---

## 6. Subscriptions and list-changed notifications

Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md

`subscriptions/listen` is a long-lived request that opens a notification stream. It
replaces both `resources/subscribe` and the HTTP GET endpoint.

Filter object (`params.notifications`), all fields optional:

| Field | Type | Effect |
|---|---|---|
| `toolsListChanged` | boolean | receive `notifications/tools/list_changed` |
| `promptsListChanged` | boolean | receive `notifications/prompts/list_changed` |
| `resourcesListChanged` | boolean | receive `notifications/resources/list_changed` |
| `resourceSubscriptions` | string[] | receive `notifications/resources/updated` for these URIs |

- **The server MUST NOT send notification types the client did not request.**
- The server MUST send `notifications/subscriptions/acknowledged` first, carrying the
  subscription ID in `_meta["io.modelcontextprotocol/subscriptionId"]`, and MUST NOT send
  any subscription notification before it. The acknowledgment's `notifications` field
  reflects **the subset the server agreed to honor** — unsupported types are omitted, and
  the client SHOULD diff that against what it asked for.
- The subscription ID **is the JSON-RPC `id` of the `subscriptions/listen` request**. On
  stdio all subscriptions share one channel, so the client MUST demultiplex on this field.
- Multiple concurrent subscriptions are allowed.
- Cancellation: HTTP → close the SSE stream; stdio → `notifications/cancelled` with the
  listen request's ID; server teardown → SHOULD send an *empty result response* to the
  original `subscriptions/listen` request (correlated by `id`, `resultType: "complete"`)
  before closing, which signals a graceful end. A transport close **without** that response
  is an unexpected disconnect and MAY trigger reconnect.
- On stdio, after a reconnect the client **MUST** re-send `subscriptions/listen` — "the
  server holds no subscription state across reconnections."

**Vela**: one `subscriptions/listen` per server, opened right after discovery, requesting
whatever the server's advertised capabilities say it supports. On acknowledgment, store
the honored filter. On `*_list_changed`, invalidate the corresponding cache entry and
re-fetch (see caching below). On graceful-close-response, don't reconnect; on abrupt close,
reconnect with jitter+backoff. Legacy servers that don't support `subscriptions/listen`
send bare `notifications/*/list_changed` over the shared channel (stdio) or the GET SSE
stream (sessioned HTTP) — handle both.

---

## 7. Caching and tool-list cache invalidation

Source: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching.md

Servers **MUST** include caching hints on `resultType: "complete"` results from:
`server/discover`, `tools/list`, `prompts/list`, `resources/list`,
`resources/templates/list`, `resources/read`.

- `ttlMs`: integer ms of freshness, semantics of HTTP `Cache-Control: max-age`. `0` =
  immediately stale. Absent → treat as `0` (only expected from older servers). Negative →
  ignore, treat as `0`. Servers MUST provide `>= 0`.
- Freshness: `now < t_received + ttlMs`. Clients **SHOULD NOT** treat TTL as a polling
  interval; check freshness on access and re-fetch only when stale. If you do poll, you
  **MUST** apply jitter and backoff.
- Clients MAY re-fetch early on evidence of change (e.g. a tool call failing with
  method-not-found or invalid-params) and MAY serve stale data on refetch failure.
- `cacheScope`: `"public"` (no user-specific data; any client/gateway/proxy may share it
  across users) vs `"private"` (may be reused **only within the same authorization
  context**; a different access token requires a different cache). Security note: a
  `"public"` result from an authenticated `tools/list` may legitimately be shared across
  tokens, so servers must not rely on `cacheScope` for access control.
- **Cache key** = method + the parameters that affect the result (`uri` for
  `resources/read`, `cursor` for paginated lists). Results produced through MRTR retries
  (carrying `inputResponses` or `requestState`) **MUST NOT be cached**.
- **Interaction with notifications**: complementary. A server may send `ttlMs` without
  `listChanged`, or both. **"When a relevant notification is received while a cached
  response is still fresh, the notification invalidates the cached response and it should
  be considered immediately stale."** That is the tool-list cache invalidation rule.
- **Pagination**: each page is independently cacheable with its own `ttlMs` clock; pages
  may carry different TTLs; there is **no cross-page consistency guarantee** (duplicates or
  gaps possible); a client needing a consistent snapshot SHOULD re-fetch from the beginning
  without a cursor; if a cursor becomes invalid, discard all cached pages and restart.
  Servers MUST apply the same `cacheScope` to every page of one list request.

### Anthropic's product-layer caches (different thing, same problem)

- **Claude Code discovery cache** (https://code.claude.com/docs/en/mcp): a remote server
  you've used before can show `cached 2h ago · connects on first use · 5 tools`. The tool
  list is loaded from a previous session and the server is connected lazily on first tool
  call. `MCP_DISCOVERY_CACHE=0` forces connect-at-startup.
- **Claude Code `list_changed` handling**: on notification, Claude Code refreshes tools,
  prompts, and resources automatically; if the refresh *fails*, it keeps the previously
  discovered lists rather than blanking them (a bug fixed in v2.1.214).
- **Anthropic OAuth discovery cache** (https://claude.com/docs/connectors/building/lazy-authentication.md):
  PRM and AS metadata are cached **globally, keyed by URL**, staleness window ~5 minutes,
  shared across all Claude users hitting the same URL; refresh is lazy and best-effort, and
  a failed refresh serves stale rather than breaking connections.
- **Anthropic scope-challenge cache**: a `403` challenge's `scope` value is cached **per
  user, per server** for up to 15 minutes, consumed by the next re-authorization, and
  overwritten by a newer `403`.

**Vela**: implement a `PrimitiveCache` keyed by `(serverId, method, normalizedParams)`
storing `{value, receivedAt, ttlMs, cacheScope, authContextHash}`. Never serve a `private`
entry across a different `authContextHash` (hash of the access token / header set). Wire
`notifications/*/list_changed` to an explicit `invalidate(serverId, kind)`. Persist the
cache to disk (SQLite) so Vela can offer Claude Code's "connect on first use" behavior:
show a server's tools at startup from cache and only spawn the stdio process or open the
HTTP connection when a tool is actually invoked — a big win for cold-start time on a
desktop app with a dozen servers. Copy the keep-previous-on-refresh-failure behavior.

---

## 8. MRTR — Multi Round-Trip Requests (elicitation, sampling, roots)

Sources: https://modelcontextprotocol.io/docs/2026-07-28/learn/client-concepts.md,
https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md

The old model (server sends a JSON-RPC request to the client) is gone. Now:

1. Client POSTs `tools/call` (id 1).
2. Server needs something → returns `result.resultType: "input_required"` with
   `inputRequests: { "<key>": { method: "elicitation/create" | "sampling/createMessage" |
   "roots/list", params: {...} } }` and an opaque `requestState` string.
3. Client gathers the input and **retries the original request with a different JSON-RPC
   id**, adding `inputResponses: { "<key>": { action: "accept"|..., content: {...} } }` and
   echoing back `requestState`.
4. Server returns the final result.

Note: "the JSON-RPC `id` MUST be different between the initial request and the retry," and
MRTR retries are never cacheable.

### Elicitation (current, not deprecated)

Two modes:
- **Form mode**: server sends `message` + `requestedSchema` (JSON Schema object). Client
  builds an input form, validates the response against the schema before returning it.
- **URL mode**: server supplies a URL for the user to open; the interaction happens
  out-of-band and its data **never passes through the client**. Client MUST show the full
  URL and get explicit consent, and **never fetch the URL automatically**; it only learns
  whether the user consented.

Privacy rule with teeth: "Servers must not use form mode to request sensitive information
such as passwords, API keys, access tokens, or payment credentials. Those interactions
belong in URL mode." Clients warn about suspicious requests and let users review form data
before sending. Users can accept, decline (with optional explanation), or cancel.

### Roots — DEPRECATED as of 2026-07-28

"Roots are deprecated as of protocol version `2026-07-28` and scheduled for removal. New
implementations should pass directories or files via tool parameters, resource URIs, or
server configuration instead." Roots were always advisory, never a security boundary: the
spec says servers "SHOULD respect root boundaries," not MUST enforce, "because servers run
code the client cannot control. Actual security must be enforced at the operating system
level, via file permissions and/or sandboxing."

Claude Code still answers `roots/list` with the session launch directory plus every
`--add-dir` / `/add-dir` / `additionalDirectories` entry, and sends
`notifications/roots/list_changed` when that set changes (v2.1.203+).

### Sampling — DEPRECATED as of 2026-07-28

"Sampling is deprecated as of protocol version `2026-07-28` and scheduled for removal. New
implementations should integrate directly with LLM provider APIs instead." While it lasts:
server sends `sampling/createMessage` with `messages`, `modelPreferences` (`hints[].name`,
`costPriority`, `speedPriority`, `intelligencePriority`), `systemPrompt`, `maxTokens`, and
optionally `tools` + `toolChoice` (scoped to that sampling request only; requires the
client to declare the `sampling.tools` capability). Human-in-the-loop at two points:
approve/modify the request, then approve/modify the response.

### Vela reimplementation

- **Elicitation is the one to build well.** It is fully client-side and portable. Vela
  renders `requestedSchema` into a native form (react-jsonschema-form or a hand-rolled
  renderer for the primitive subset), validates locally, and returns
  `{action: "accept"|"decline"|"cancel", content}`. URL mode: show the full URL, host
  highlighted, require an explicit click, open in the system browser, never prefetch.
  Enforce the "no secrets in form mode" rule client-side too: heuristically flag fields
  named `password`/`token`/`api_key`/`secret`/`cvv` in a form-mode request and warn.
  Provide a scriptable auto-response hook (Claude Code has an `Elicitation` hook) for
  headless/automated runs.
- **Sampling is where Vela's model-agnosticism actually shines.** Claude Desktop's sampling
  routes to Anthropic's models. Vela routes `sampling/createMessage` to *the user's own
  backend* — the same local llama.cpp/Ollama/vLLM endpoint or third-party key already
  configured. `modelPreferences.hints[].name` becomes a soft match against Vela's
  configured model registry (fuzzy match on model id/alias); `costPriority` /
  `speedPriority` / `intelligencePriority` map to a routing policy that picks among the
  user's configured models (e.g. a 3B local model for speed-priority, a 70B or a
  cloud key for intelligence-priority). Implement it even though it's deprecated: existing
  servers use it, and Vela can support it for free since it already owns a model router.
  Keep the two human-in-the-loop checkpoints, plus per-server "auto-approve sampling"
  settings and a token budget cap.
- **Roots**: implement `roots/list` + `notifications/roots/list_changed` for legacy servers
  (Vela's open folders / workspace dirs), but do not build new features on it; use OS-level
  sandboxing for the actual boundary (see §14).

---

## 9. OAuth for remote MCP servers

Sources: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/index.md,
.../authorization-server-discovery.md, .../client-registration.md,
https://claude.com/docs/connectors/building/authentication.md

Authorization is **OPTIONAL** and applies to **HTTP transports only**. "Implementations
using an STDIO transport SHOULD NOT follow this specification, and instead retrieve
credentials from the environment." That single sentence is why local MCP is so much
simpler than remote MCP.

### The flow a client must implement

1. Make an MCP request with no token → server returns `401` with
   `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`.
2. Fetch the **Protected Resource Metadata** (RFC 9728). Clients MUST support both
   discovery mechanisms: the `resource_metadata` pointer in `WWW-Authenticate` when
   present, else construct well-known URIs **in this order**:
   `https://host/.well-known/oauth-protected-resource/<mcp-path>` then
   `https://host/.well-known/oauth-protected-resource`.
3. PRM MUST include `authorization_servers` with ≥1 entry. Multiple entries are
   independent ASes; the client picks (RFC 9728 §7.6) and **MUST keep separate
   registration state and tokens per AS**.
4. Fetch **AS metadata**. Clients MUST try, in priority order — for an issuer *with* a path
   component (`https://auth.example.com/tenant1`):
   1. `https://auth.example.com/.well-known/oauth-authorization-server/tenant1`
   2. `https://auth.example.com/.well-known/openid-configuration/tenant1`
   3. `https://auth.example.com/tenant1/.well-known/openid-configuration`
   and for an issuer without a path: `/.well-known/oauth-authorization-server` then
   `/.well-known/openid-configuration`.
   After retrieval the client **MUST validate that the document's `issuer` is identical to
   the issuer used to construct the URL**, else reject (mix-up defense).
5. Obtain a `client_id` — three mechanisms, with this client priority order:
   1. pre-registered credentials the client already has for that server;
   2. **Client ID Metadata Documents (CIMD)** if the AS advertises
      `"client_id_metadata_document_supported": true`;
   3. **Dynamic Client Registration** (RFC 7591) if the AS advertises a
      `registration_endpoint` — **DCR is deprecated**, retained only for backwards
      compatibility;
   4. prompt the user to enter client info manually.
6. Generate PKCE (S256), include the **`resource` parameter (RFC 8707) on BOTH the
   authorization request and the token request**, set to the canonical MCP server URI
   (https scheme, no fragment, most specific path you can, conventionally no trailing
   slash). "MCP clients MUST send this parameter regardless of whether authorization
   servers support it."
7. Record the AS's `issuer` alongside the PKCE verifier and `state`. On the callback,
   apply RFC 9207 validation: if `authorization_response_iss_parameter_supported` is true
   and `iss` is absent → **reject**; if `iss` is present (regardless of the metadata flag)
   → simple string comparison against the recorded issuer, **with no normalization** (no
   case folding, no default-port elision, no trailing-slash or percent-encoding
   normalization). Applies to error responses too — on mismatch, do not act on or display
   `error`/`error_description`/`error_uri`.
8. Exchange code + verifier + `resource` for tokens. Send `Authorization: Bearer <token>`
   on **every** HTTP request; **never** put tokens in the query string.

### CIMD specifics

`client_id` is itself an HTTPS URL with a path component, e.g.
`https://app.example.com/oauth/client-metadata.json`, serving a self-referential JSON
document that MUST contain at least `client_id`, `client_name`, `redirect_uris`, with
`client_id` exactly equal to the document URL. Typical document also has `grant_types`,
`response_types`, `token_endpoint_auth_method: "none"`. CIMD client IDs are **portable
across authorization servers** — no re-registration when the AS changes. Because the
document is self-asserted, the consent screen must display the **host of the `client_id`
URL**, not `client_name`.

Loopback redirect matching (RFC 8252 §7.3): compare `http://127.0.0.1/…` and `http://[::1]/…`
**with the port ignored**, because native apps bind an ephemeral port. Claude Code declares
both `http://localhost/callback` and `http://127.0.0.1/callback` in its CIMD and asks ASes
to apply port-agnostic matching to `localhost` too. Note the spec's warning: a CIMD can't
prevent loopback impersonation on its own, so the AS must display the redirect hostname
clearly and warn when the only registered redirects are loopback.

### DCR specifics

`application_type` matters: omitting it defaults to `"web"` under OIDC, which conflicts
with native-style redirect URIs. Native/desktop/CLI/localhost clients SHOULD send
`application_type: "native"`. `/register` uses `application/json` (RFC 7591 §3.1) while
`/token` uses `application/x-www-form-urlencoded` (RFC 6749 §4.1.3) — different parsers.

### Scopes and step-up

- Server SHOULD include `scope` in the `WWW-Authenticate` challenge; the client MUST treat
  the challenged scopes as authoritative for the current operation and MUST NOT assume any
  set relationship with `scopes_supported`.
- Client scope priority: (1) `scope` from the initial 401; (2) otherwise all of
  `scopes_supported` from PRM, omitting `scope` entirely if undefined.
- Runtime insufficient scope: server SHOULD return `403` with
  `WWW-Authenticate: Bearer error="insufficient_scope", scope="…", resource_metadata="…"`.
  Client computes the **union** of previously requested scopes and the challenged scopes,
  re-authorizes, retries "no more than a few times," and tracks attempts to avoid loops.
- Refresh tokens: clients SHOULD include `refresh_token` in `grant_types`, MAY add
  `offline_access` when the AS lists it in `scopes_supported`, and MUST NOT assume refresh
  tokens will be issued. Servers SHOULD NOT advertise `offline_access` in the PRM.

### Anthropic's product-specific behavior (a good spec for Vela to match or beat)

From https://claude.com/docs/connectors/building/authentication.md:

- Supported auth types: `oauth_dcr`, `oauth_cimd`, `oauth_anthropic_creds` (Anthropic holds
  your client_id/secret; requires emailing `mcp-review@anthropic.com`), `custom_connection`
  (user supplies URL/credentials at connect time, e.g. Snowflake), `static_headers` (beta),
  `none`.
- **Pure `client_credentials` machine-to-machine is NOT supported. "Every connection
  requires user consent."**
- Claude selects CIMD **only** when the AS metadata advertises *both*
  `client_id_metadata_document_supported: true` *and* `"none"` in
  `token_endpoint_auth_methods_supported` — because Claude's CIMD client authenticates as a
  public client. Otherwise it falls back to DCR.
- Claude always sends PKCE `S256`. The AS must advertise
  `"code_challenge_methods_supported": ["S256"]`.
- Claude appends `offline_access` when the AS lists it, to obtain a refresh token.
- Redirect URI for hosted surfaces: **`https://claude.ai/api/mcp/auth_callback`**. Claude
  Code instead uses an RFC 8252 loopback on an ephemeral port
  (e.g. `http://localhost:3118/callback`).
- **Token refresh**: reactive on `401`, plus a proactive refresh up to **5 minutes** before
  stored expiry. Servers must return RFC 6749-compliant `invalid_grant` (not
  `invalid_request` or a custom code) and should rotate refresh tokens for public clients.
- **Endpoint latency budget**: Claude waits **10 s** for discovery, registration, and token
  endpoints, and **30 s** for refresh requests.
- PRM `resource` must match the MCP URL **exactly as the user typed it**, including path.
  If `authorization_servers` lists more than one entry, **Claude uses the first and does
  not fall back**.
- The AS host must also be reachable from Anthropic's egress range — a WAF in front of the
  IdP breaks the flow even when the MCP server is reachable.

### Vela reimplementation

Everything here is **CLIENT_SIDE_PORTABLE** — it's an OAuth 2.1 public client, which is
exactly what a desktop app is supposed to be, and Vela is structurally better positioned
than claude.ai because it runs on the user's machine.

- Use a loopback redirect (`http://127.0.0.1:<ephemeral>/callback`), which is the RFC 8252
  best practice; also register `http://localhost:<port>/callback` for AS compatibility.
  Offer a `--callback-port`-equivalent setting for servers requiring a pre-registered URI.
- Host a **Vela CIMD** at a stable HTTPS URL under the project's domain (e.g.
  `https://vela.app/oauth/client-metadata.json`) declaring
  `redirect_uris: ["http://127.0.0.1/callback", "http://localhost/callback"]`,
  `token_endpoint_auth_method: "none"`, `grant_types: ["authorization_code","refresh_token"]`.
  This is the one piece of Vela's OAuth story that needs an internet-hosted static file —
  it's a static JSON blob on a CDN, not a service. Fall back to DCR, then to a manual
  client_id/secret dialog.
- Implement the discovery cascade exactly as specified, including the three path-insertion
  variants and the issuer-identity validation. Cache PRM/AS metadata **per URL with a short
  TTL** (Anthropic uses ~5 min) but, unlike Anthropic, key it per-profile so a user's
  staging and prod servers don't share.
- Store tokens in the **OS keychain** (macOS Keychain, Windows Credential Manager /
  DPAPI, Linux Secret Service / `libsecret`, with an encrypted-file fallback behind a
  passphrase). Never in plaintext JSON. Store per `(serverUrl, issuer, accountProfile)`.
- Implement reactive-on-401 + proactive-5-min-before-expiry refresh, refresh-token
  rotation handling, and step-up on `403 insufficient_scope` with scope union and a retry
  cap.
- Implement `resource` (RFC 8707) canonicalization and RFC 9207 `iss` validation with **no
  URI normalization** — this is a real security control, not boilerplate.
- Provide a per-server "pinned scopes" setting (Claude Code's `oauth.scopes`) and an
  "override AS metadata URL" setting (`authServerMetadataUrl`) for corporate proxies.
- Provide the `static_headers` equivalent: a fixed set of request headers with values in
  the keychain. Copy Anthropic's UX details — the value is sent **verbatim** with no scheme
  prefix added (`Bearer <token>` must include the word `Bearer` and the space), headers can
  be marked Required vs Optional, and `Authorization` is mutually exclusive with an OAuth
  connection on the same server. Unlike Anthropic, Vela need not restrict header names to
  an allowlist (that restriction exists because Anthropic's cloud sends the header on the
  user's behalf); but Vela SHOULD warn loudly for unusual names.
- Provide a `headersHelper` equivalent (run a user command, parse a JSON object of headers
  from stdout, 10 s timeout, re-run on 401/403 and retry once) for Kerberos/SSO/short-lived
  token shops. Gate it behind a workspace-trust prompt, since it executes a shell command.

---

## 10. Lazy / mixed authentication

Source: https://claude.com/docs/connectors/building/lazy-authentication.md

A server can let anonymous clients `initialize`, `tools/list`, and call *public* tools, and
only challenge when a *protected* tool is invoked. The mechanism is precise and worth
implementing on the client side:

- The refusal MUST be a transport-level **`401` with `WWW-Authenticate`**. A `200` carrying
  `{"result":{"isError":true,"content":[{"type":"text","text":"Please sign in"}]}}` is an
  application-level tool failure — the client hands the text to the model and moves on,
  with no auth prompt. "If users are seeing 'please sign in' text in the chat instead of a
  Connect button, the server is returning the wrong one."
- `403` triggers re-authentication **only** when accompanied by
  `WWW-Authenticate: Bearer error="insufficient_scope"`; any other `403` is a terminal
  error.
- Because the refusal must be an HTTP status, the server has to gate **before** the JSON-RPC
  body reaches the MCP SDK — once a tool handler is running, its return value is already
  destined for a `200`.
- In Claude the challenge surfaces as an inline **Connect** card; after auth, Claude
  **retries the same tool call automatically** and the turn continues with no context lost.

**Vela**: implement the same client behavior. On a tool call returning `401` with
`WWW-Authenticate`, pause the agent turn, render an inline "Connect to <server>" card in the
transcript, run the OAuth flow in the system browser, then transparently retry the tool
call and resume the loop — no context loss, no new user turn. Same for `403 insufficient_scope`
with scope union. Distinguish clearly in the UI between "auth required" and "tool errored."

---

## 11. Enterprise Managed Auth (silent SSO token exchange)

Source: https://claude.com/docs/connectors/building/enterprise-managed-auth.md

Beta, Team/Enterprise only. Instead of an OAuth consent screen, Claude presents the
server's AS with an **identity assertion**: a signed JWT issued by the customer's IdP,
exchanged at the token endpoint via the **JWT bearer grant, RFC 7523**
(`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`), following the Identity
Assertion JWT Authorization Grant draft. The request is form-encoded and carries
`assertion`, `client_id`, `scope`, and (when the IdP can forward it) `resource`. No browser
redirect, no consent page. The AS must advertise the grant in `grant_types_supported`,
maintain a **per-tenant allowlist of trusted issuer URLs**, fetch the IdP's JWKS, and
validate signature/iss/aud/exp/sub/client_id — rejecting with `invalid_grant` if the issuer
isn't allowlisted even when the signature is valid.

**DCR is explicitly not supported with EMA** because the IdP stamps a fixed `client_id`
into every assertion, so the AS must already recognize the client. EMA also composes with
lazy auth: a `401` triggers the silent exchange instead of the Connect card. A fully
authless server never returns `401`, so EMA doesn't apply. Claude keeps a long-lived IdP
refresh token from SSO login and mints fresh assertions as needed. Okta's Cross App Access
(XAA) is the reference integration; https://xaa.dev is a playground.

**Classification**: MIXED. The *protocol* (RFC 7523 JWT-bearer) is portable; the *plumbing*
(Anthropic obtains the assertion because the user's SSO session lives in Anthropic's
identity layer) is Anthropic-server-side.

**Vela**: Vela has no hosted identity layer, so it substitutes **local OIDC**. Vela signs
the user in to their corporate IdP directly via an OIDC authorization-code + PKCE flow in
the system browser (Vela is a public native client), receives an ID token / refresh token,
stores the refresh token in the OS keychain, and then performs exactly the same RFC 7523
exchange against the MCP server's AS using the IdP-issued ID token as the `assertion`.
Configuration surface: per-connector `{idpIssuer, idpClientId, assertionAudience, clientId,
scopes, resource}` in an enterprise policy file that IT can ship via MDM/GPO (see §16).
This is arguably *better* than Anthropic's version for security-conscious orgs, since the
assertion never transits a third party. Where an IdP refuses to issue assertions to a
native client, fall back to standard interactive OAuth.

---

## 12. The Connectors Directory, verification, and custom connectors

Sources: https://claude.com/docs/connectors/directory.md,
https://claude.com/docs/connectors/verification.md,
https://claude.com/docs/connectors/building/directory-vs-custom.md,
https://claude.com/docs/connectors/custom/remote-mcp.md,
https://claude.com/docs/connectors/overview.md

### Directory (ANTHROPIC_SERVER_SIDE)

- One catalog serving Claude.ai, Cowork, Desktop, mobile, and Claude Code.
- Contains **Verified** (reviewed by Anthropic for quality/security, shows a checkmark) and
  **Community** (passed automated checks only, shows a "Community" label plus a reminder
  before connecting) entries. **The label is purely a quality signal — "once connected, a
  community connector works the same way as a verified one."**
- Every directory entry is automatically eligible for **Suggested Connectors** (in-chat
  recommendations). Custom connectors are never suggested. Ranking is usage-based.
- No domain-ownership proof (DNS or `.well-known`) required — that applies to the open MCP
  Registry, not the Anthropic Directory. **The Anthropic Directory is independent of
  https://registry.modelcontextprotocol.io and the `modelcontextprotocol/servers` repo;
  publishing there does not surface a server in Claude.**
- Permanent slug URL: `https://claude.ai/directory/connectors/SLUG`.
- Submission requires a Team/Enterprise org and Directory/Libraries permission; portal at
  `claude.ai/admin-settings/directory/submissions/new`. Requirements: security standards,
  **tool `title` + `readOnlyHint`/`destructiveHint` on every tool**, OAuth 2.0 for
  authenticated services, privacy policy (local connectors must have a "Privacy Policy"
  README section, a `privacy_policies` array in `manifest.json` at manifest_version 0.2+,
  and HTTPS URLs — "Missing or incomplete privacy policies result in immediate rejection"),
  documentation. Listing limits: name ≤100 chars, tagline ≤55, description ≤2,000, 1–5
  categories. MCP Apps additionally need 3–5 PNG screenshots ≥1000px wide, cropped to the
  app response only.
- **`ui/open-link` allowed link URIs**: a submitted list of HTTPS origins (scheme+host only;
  subdomains not implied) or custom URI schemes you own, used to suppress the "Open
  external link" confirmation for those destinations. Directory connectors can allowlist;
  custom connectors always show the modal.
- Team members without connector permission see a **Request** button; requests surface in
  Organization settings → Connectors ("Requested by your team") and → Notifications.
- Endpoint-change gotcha: if a provider changes the listing URL, existing connections keep
  working but re-classify as "Custom," and re-adding from the directory creates a second
  connection.

### Directory vs custom (identical runtime)

"Directory connectors and custom connectors run on the **same MCP infrastructure**. The
runtime, transport, authentication, and tool-calling code paths are identical. The
difference is review, discoverability, and distribution." Only differences: Anthropic
review, in-product discovery/suggestions, availability of Anthropic-held client
credentials, external-link allowlisting, and whether it renders as a named card with a logo
or as "Custom."

**Install links** are a neat, fully copyable idea:
`https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=NAME&connectorUrl=ENCODED_URL`
opens the add dialog prefilled, with a notice that the values came from an external link;
the user must still confirm. Admin variant on `/admin-settings/connectors`.

### Adding custom connectors (product UX to mirror)

- Free/Pro/Max: Customize → Connectors → "Add custom connector" → URL → optional OAuth
  Client ID/Secret under Advanced settings. **Free users are limited to one custom
  connector.**
- Team/Enterprise: Owner adds under Organization settings → Connectors → Add → Custom →
  Web; members then individually authenticate under Customize → Connectors.
- Per-conversation enable/disable via the "+" button → Connectors.
- **Per-tool permission**: "Block individual tools you don't need under Customize →
  Connectors by selecting the connector and setting the tool's permission to **Blocked**."
  Org admins can additionally set a tool to **ask**. Claude Code reads these at startup and
  enforces them locally: `ask` → prompt on every call with "Your organization requires
  approval for this tool," even in `acceptEdits`/`auto`/`bypassPermissions`, never
  offering a remember option, and denying outright in `dontAsk`; `blocked` → the tool is
  filtered out before the model sees it.

**Crucial architectural fact for Vela**: "Connections originate from Anthropic's cloud
infrastructure, not local devices. Servers hosted on a private corporate network, behind a
VPN, or blocked by a firewall won't connect." Private servers require allowlisting
Anthropic's IP range `160.79.104.0/21`. The troubleshooting page details the consequences:
Claude resolves the hostname and rejects the connection *before any HTTP request leaves
Anthropic's network* if **any** resolved address is private (`10/8`, `172.16/12`,
`192.168/16`), CGNAT (`100.64/10`), loopback, or link-local; a mix of public and non-public
addresses is rejected; **connectors are IPv4-only** and a hostname publishing only `AAAA`
records is unreachable. Also: a `301/302/307/308` redirect to a different host drops the
`Authorization` header, which is why "works in Claude Code/curl but not claude.ai" is a
common report.

### Vela reimplementation

- **Registry**: ship a local catalog as a signed JSON index (name, description, homepage,
  icon, transport, URL or install command, declared tool annotations, publisher, category)
  hosted as a static file with an offline-bundled fallback, plus the ability to point Vela
  at additional index URLs (self-hosted enterprise catalogs). Support the open MCP
  Registry (`registry.modelcontextprotocol.io`) as a *first-class* source — the thing
  Anthropic deliberately does not do — and a GitHub-repo source for
  `modelcontextprotocol/servers`.
- **Trust labels** without a review team: derive them mechanically. `publisher-verified`
  = domain ownership proved via DNS TXT or `/.well-known/mcp-publisher`; `signed` = the
  bundle/index entry is signed by a key in Vela's trust store; `community` = present in an
  index with no proof; `unverified` = pasted URL. Show a first-connect interstitial for
  anything below `publisher-verified`, mirroring Claude's Community reminder. Optionally
  layer a community rating/report feed.
- **Install links**: register a `vela://` URI scheme handler and support
  `vela://add-connector?name=…&url=…&transport=…` (and a `command=` form for stdio), always
  opening a prefilled *confirmation* dialog that shows the exact URL/argv and never
  auto-adds. Same for a `claude.ai`-style web landing page if Vela ships one.
- **Per-tool permissions**: implement the three-state model (`allow` / `ask` / `blocked`)
  at the tool level, per server, per profile, plus a per-conversation on/off toggle for the
  whole server. Store as policy so an enterprise file (§16) can force `ask` or `blocked`
  and the local user cannot relax it.
- **The big win**: because Vela's MCP client runs in the desktop process, none of the
  network restrictions apply. `http://localhost:3000/mcp`, `https://mcp.internal.corp/mcp`
  behind a VPN, IPv6-only hosts, split-horizon DNS — all just work. Vela should advertise
  this explicitly and should *not* replicate Anthropic's private-IP rejection; instead show
  a clear badge ("this server is on your local network") and apply the DNS-rebinding
  protections from the client side (validate that a hostname's resolved address doesn't
  change between the auth flow and the request, pin the resolved IP for the connection).

---

## 13. Local MCP servers on Claude Desktop

Sources: https://modelcontextprotocol.io/docs/develop/connect-local-servers,
https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop

Concrete mechanics Vela should match or exceed:

- Config file `claude_desktop_config.json`:
  - macOS `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Windows `%APPDATA%\Claude\claude_desktop_config.json`
  Edited via Settings → Developer → "Edit Config" (a separate window from account
  settings). Schema:
  ```json
  { "mcpServers": { "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Desktop"],
      "env": { "APPDATA": "C:\\Users\\me\\AppData\\Roaming\\", "BRAVE_API_KEY": "..." }
  }}}
  ```
- **Requires a full app restart** to pick up config changes.
- Servers are surfaced via the "Add files, connectors, and more" control → Connectors →
  Manage connectors, showing each server's tools.
- **Every tool call requires explicit user approval** before execution; Claude shows an
  approval dialog and the user can deny.
- **Logs**: `~/Library/Logs/Claude` (macOS) / `%APPDATA%\Claude\logs` (Windows).
  `mcp.log` = general connection logging and failures; `mcp-server-<SERVERNAME>.log` =
  that server's stderr (and stdio servers commonly log *everything* to stderr, so these
  aren't only errors). `tail -n 20 -f ~/Library/Logs/Claude/mcp*.log`.
- Troubleshooting canon: restart fully; validate JSON syntax; **paths must be absolute, not
  relative**; run the server manually in a terminal to see errors; on Windows, `${APPDATA}`
  in a path may need to be added explicitly to `env`, and `npx` fails unless npm is
  installed globally (`%APPDATA%\npm` must exist).
- Security warning: "the server runs with your user account permissions, so it can perform
  any file operations you can perform manually."

**Vela**: this is Vela's home turf. Improvements over the Claude Desktop baseline that are
cheap and obviously right:
- Hot-reload config without an app restart (watch the file, diff the server map, start/stop
  only changed entries — Claude Code already does the equivalent for plugin reloads).
- A built-in config editor with JSON-schema validation and inline errors, plus a "Test
  connection" button that spawns the process, runs discovery, and shows stderr live.
- Per-server log viewer in-app, tailing the same `mcp-server-<name>.log` files.
- Resolve `command` against PATH *and* common runtime managers (nvm, fnm, volta, pyenv,
  asdf, uv) — the #1 support burden for stdio servers is a GUI app not inheriting the
  shell's PATH. Optionally launch through the user's login shell to source their profile.
- Ship bundled runtimes: Claude Desktop ships Node on macOS and Windows so MCPB extensions
  need no separate runtime (see §14). Vela should bundle Node and a Python (or `uv`) for
  the same reason, and prefer them when a server declares a runtime requirement.
- Secrets: never store API keys in a world-readable JSON file. Store them in the OS
  keychain and inject them into the child's environment at spawn time, with the config file
  holding only a reference (`"env": {"BRAVE_API_KEY": {"$secret": "brave-api-key"}}`).

---

## 14. Desktop Extensions / MCP Bundles (MCPB)

Sources: https://claude.com/docs/connectors/custom/desktop-extensions.md,
https://claude.com/docs/connectors/building/mcpb.md,
https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop

- An `.mcpb` file is **a zip archive containing a local MCP server plus a `manifest.json`**,
  enabling single-click install like a browser extension. Runs locally, communicates over
  **stdio**, bundles all dependencies, works offline, **no OAuth required**.
- Spec + tooling live at https://github.com/modelcontextprotocol/mcpb (MANIFEST.md, CLI.md,
  examples). CLI: `npm install -g @anthropic-ai/mcpb`, then `mcpb init`, `mcpb pack`.
- **Node.js is strongly recommended because it ships with Claude Desktop on macOS and
  Windows**, so users need no separate runtime. Claude Desktop runs on `darwin` and `win32`
  only; supported platforms are declared in the manifest's `compatibility` section.
  Supported server types include Node.js, Python, and binary servers.
- `manifest.json` describes what it does, how to run it, which tools it provides, and what
  configuration it needs. A `user_config` section makes Claude Desktop **automatically
  generate a settings UI** for the extension. Fields marked `"sensitive": true` are
  **automatically encrypted using the operating system's secure storage**.
- Icons: `icon.png`, 512×512 recommended (256×256 minimum), PNG with transparency, with
  light/dark and multi-size variants supported.
- Install paths: double-click the `.mcpb`; drag-and-drop onto the window; or Settings →
  Extensions → Advanced settings → Install Extension…. All three open an installation UI
  where the user reviews details and permissions, configures required settings, grants
  permissions, and completes install. **Installation is per-user.**
- Directory install: Settings → Extensions for the official gallery; "Advanced settings" →
  "Extension Developer" for custom ones.
- Positioned as "the secondary distribution path" (remote MCP is preferred for directory
  listing) but as the right answer for: systems behind a firewall (JIRA/Confluence/internal
  wikis/private DBs), auth via existing SSO and browser sessions with no token management,
  zero-trust compliance inside corporate boundaries, direct filesystem access for code
  editing and git, integration with locally installed tools (Docker, IDEs, databases),
  hardware integration and desktop app control, privacy-sensitive operations, one-click
  install with bundled Node, and org-level admin controls (custom uploads, allowlists).
  Marked Team/Enterprise for the enterprise-deployment features.
- Also note: "Local MCP servers distributed through third-party package registries like npm
  or PyPI cannot be listed directly in the Connectors Directory" — you must package as MCPB
  or bundle in a plugin with `.mcp.json`.

**Vela reimplementation**: adopt MCPB **as-is**. It is an open format in an open repo with
an open CLI; there is nothing Anthropic-specific in a zip of a stdio server plus a
manifest. Vela should:
- Implement an MCPB installer: verify the zip, parse `manifest.json`, check
  `compatibility` against the host platform *and extend it to `linux`* (Claude Desktop is
  macOS/Windows only — Linux support is free differentiation), render the `user_config`
  schema into a settings form, write `sensitive: true` values to the OS keychain, and
  register the resulting stdio server.
- Verify code signatures where present and show the signer; refuse silently-unsigned
  bundles by default in enterprise policy mode.
- **Sandbox the extension process.** This is the biggest gap in the Claude Desktop model
  ("runs with user permissions"). Vela should run stdio servers under an OS sandbox by
  default: macOS `sandbox-exec` profile or an App Sandbox helper; Linux `bubblewrap`
  (preferred) or `firejail`, or a rootless Podman/Docker container with only the declared
  roots bind-mounted; Windows AppContainer / restricted token + Job Object. Derive the
  filesystem allowlist from the extension's declared config (the directories the user
  granted) and default network access to deny unless the manifest declares it. Expose the
  sandbox profile in the install dialog so the permission grant is real, not advisory —
  which is precisely what the spec says roots cannot provide.
- Support the same three install gestures (double-click via file association, drag-and-drop,
  Settings → Extensions), plus a CLI (`vela ext install foo.mcpb`).
- Bundle a Node runtime and a `uv`/CPython so `.mcpb` bundles targeting either work
  out-of-the-box, and set the child's PATH to prefer bundled runtimes.

---

## 15. MCP Apps (interactive UI from a connector)

Sources: https://claude.com/docs/connectors/overview.md,
https://claude.com/docs/connectors/building/mcp-apps/getting-started.md,
https://claude.com/docs/connectors/building/directory-vs-custom.md,
https://claude.com/docs/connectors/building/submission.md

- MCP Apps let a server "display interactive UI elements in conversational MCP clients" —
  charts, maps, forms, 3D globes, shader canvases, sheet music with audio playback —
  rendered **inline in the chat** rather than returning only text.
- It is an **MCP extension**, developed in the open at
  https://github.com/modelcontextprotocol/ext-apps, with an SDK
  (https://modelcontextprotocol.github.io/ext-apps/api/index.html), a Quickstart, examples
  in vanilla JS/React/Vue/Svelte, a migration reference from the OpenAI Apps SDK, and an
  Agent-Skills plugin (`/plugin marketplace add modelcontextprotocol/ext-apps`).
- Delivery in Claude Desktop is via an ordinary local stdio server in
  `claude_desktop_config.json` (e.g. `npx -y @modelcontextprotocol/qr-server --stdio`).
  "Claude will prompt you for permission to display the App. Click 'Always allow', and
  you'll see the MCP App render inline in the conversation."
- Related sub-features documented in the index: design guidelines, **transparent theming**
  (blend with the host's theme), **instance supersession** (supersede older widget
  instances), **cross-platform compatibility**, **external links** (`ui/open-link`
  capability with an allowed-URI list to suppress the confirmation modal).
- Remote MCP Apps can be tested locally through a proxy such as `mcp-remote`.

**Vela reimplementation**: CLIENT_SIDE_PORTABLE — this is a rendering surface, not a model
feature. Vela renders MCP Apps in a locked-down webview per widget instance:
- Electron `<webview>`/`BrowserView` with `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, or a Tauri webview with an equivalent isolation pattern.
- A strict CSP with **no remote origins**; the widget's HTML/JS is served from the MCP
  server as a `ui://` resource and injected, so it must be self-contained.
- The host↔widget bridge is `postMessage` carrying JSON-RPC; the host mediates every
  request, so a widget's `tools/call` goes through Vela's *same* permission engine as a
  model-initiated call (never a bypass).
- Implement theme tokens (CSS custom properties) injected into the widget so transparent
  theming works, instance supersession (replace-in-place when a newer instance for the same
  tool arrives), and `ui/open-link` gated behind a confirmation modal with a per-connector
  allowed-origins list stored locally (matching Anthropic's semantics: HTTPS origin =
  scheme+host only, subdomains not implied; custom scheme = scheme only).
- Because Vela is model-agnostic, an MCP App works identically regardless of backend — the
  widget is driven by tool results, not by the model.

---

## 16. Claude Code's MCP surface (the richest client implementation, and the best blueprint)

Source: https://code.claude.com/docs/en/mcp

This page is effectively a spec for a serious MCP client. The details Vela should copy:

**Configuration and scopes**

| Scope | Loads in | Shared | Stored in |
|---|---|---|---|
| local (default) | current project only | no | `~/.claude.json` under the project path |
| project | current project only | yes, via VCS | `.mcp.json` in project root |
| user | all projects | no | `~/.claude.json` |

Precedence when the same server is defined more than once (one connection, whole entry
from the winner, **no field merging**): local → project → user → plugin-provided →
claude.ai connectors. The three scopes match duplicates **by name**; plugins and connectors
match **by endpoint** (same URL or command).

**Transports and config JSON**: `type` is `stdio` | `http` (alias `streamable-http`) |
`sse` (deprecated) | `ws`. "A JSON entry that has a `url` but no `type` is a configuration
error, because Claude Code reads an entry with no `type` as a stdio server" — the error is
`MCP server "<name>" has a "url" but no "type"`.

**Environment variable expansion** in `.mcp.json`: `${VAR}` and `${VAR:-default}`, expanded
in `command`, `args`, `env`, `url`, and `headers`. An unset variable with no default does
not fail the load — it warns and leaves the literal `${VAR}` text.

**Project trust**: project-scoped `.mcp.json` servers require interactive approval
(`claude mcp reset-project-choices` resets), and approvals from repo-checked-in settings are
ignored until the workspace is trusted. `claude -p`, SDK, and cloud sessions can't prompt, so
they load project servers without asking unless `disabledMcpjsonServers` blocks them.

**Timeouts (all concrete numbers worth copying)**
- `MCP_TIMEOUT` — server startup timeout.
- Per-server `timeout` (ms) in the config — hard wall-clock limit per tool call; progress
  notifications do **not** extend it; values `<1000` are ignored and fall through to
  `MCP_TOOL_TIMEOUT`, whose default is ~28 hours.
- A second **per-request timer** for HTTP/SSE/connector servers covering each request
  through to the first response byte: 60 s by default; raising `timeout`/`MCP_TOOL_TIMEOUT`
  to ≥60 s raises it, a lower value doesn't shorten it. Stdio and WebSocket have no
  per-request timer.
- **Idle timeout**: a call with no response and no progress notification aborts —
  5 minutes for HTTP/SSE/WS/connectors, **30 minutes for stdio**. Configurable via
  `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (ms; `0` disables).
- **Automatic backgrounding**: a main-conversation tool call still running after **2
  minutes** moves to a background task; Claude gets a task ID immediately and continues,
  and the result arrives as a task notification. `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`
  changes the threshold. Excluded: subagent calls, IDE servers, non-interactive runs, and
  calls blocked on an open elicitation dialog ("the server is blocked on your input, not
  slow").

**Reconnection**: HTTP/SSE servers that drop mid-session reconnect with exponential backoff,
up to 5 attempts starting at 1 s and doubling; then marked failed with a manual retry.
Initial connection retries up to 3 times on transient errors (5xx, connection refused,
timeout); **auth and not-found errors are not retried**. Post-connect discovery requests
(`tools/list`, `prompts/list`, `resources/list`) also retry transient errors up to 3 times;
auth errors, 4xx, and request timeouts are not retried. **Stdio servers are not
auto-reconnected** (they're local processes).

**Output limits**: warn above **10,000 tokens** of tool output (threshold fixed); hard limit
**25,000 tokens** by default via `MAX_MCP_OUTPUT_TOKENS`. Oversized text results are
persisted to disk and replaced with a file reference; `anthropic/maxResultSizeChars` (≤500k
chars) raises that per tool. Image-returning tools remain subject to the token limit.

**Tool search**: on by default. Only tool *names* and *server instructions* load at session
start; full schemas are fetched on demand via a `ToolSearch` tool. `ENABLE_TOOL_SEARCH`
values: unset/`true` (defer all), `auto` (load upfront if they fit within 10% of the context
window, defer the overflow), `auto:N` (custom percentage), `false` (all upfront).
`alwaysLoad: true` per server, or `_meta["anthropic/alwaysLoad"]` per tool, exempts from
deferral (and makes startup wait for that server, capped at a 5-second connect timeout).
Tool descriptions and server instructions are **truncated at 2 KB each**. Server
`instructions` become much more important with tool search on — they tell the model when to
go looking for your tools.

**Resources**: `@server:protocol://resource/path` mentions, fuzzy-searchable in the `@`
autocomplete, fetched and attached automatically.

**Prompts**: `/mcp__servername__promptname [args…]`, space-separated positional args,
results injected directly into the conversation, names normalized (spaces → underscores).

**Claude Code as a server**: `claude mcp serve` runs Claude Code itself as a stdio MCP
server, wired into Claude Desktop via `claude_desktop_config.json`. It "only exposes Claude
Code's tools to your MCP client, so your own client is responsible for implementing user
confirmation for individual tool calls."

**Channels**: a server can declare a `claude/channel` capability and, with `--channels`,
push messages into a live session so the agent reacts to external events (CI, alerts,
Telegram/Discord).

**Managed MCP for enterprises** (https://code.claude.com/docs/en/managed-mcp):
- `managed-mcp.json` at `/Library/Application Support/ClaudeCode/` (macOS),
  `/etc/claude-code/` (Linux/WSL), `C:\Program Files\ClaudeCode\` (Windows). If present,
  **only** the servers it defines load — users cannot add, modify, or use any other server,
  including plugin servers, and claude.ai connectors are suppressed unless
  `allowAllClaudeAiMcps: true` in a managed settings source. An empty `{"mcpServers": {}}`
  disables MCP entirely.
- `allowedMcpServers` / `deniedMcpServers`: entries are `{serverUrl}` (wildcards `*`
  anywhere including the scheme; hostname matching case-insensitive, ignores trailing FQDN
  dot; **paths stay case-sensitive**), `{serverCommand}` (exact argv match, every argument
  in order), or `{serverName}` (exact, no wildcards). Evaluation order: merge lists from
  all sources → check denylist (nothing overrides a denylist match) → check allowlist.
  Type-specific rule: a remote server must match a `serverUrl` entry, and a `serverName`
  match counts *only* when the allowlist contains no `serverUrl` entries (same for stdio and
  `serverCommand`). Unset allowlist = everything allowed; empty array = **nothing** allowed.
- `serverName` is explicitly "not a security control" — the user chooses the label.
- Policy entries expand `${VAR}` from a **pinned** environment (allowlist: the environment
  Claude Code started with plus managed-settings `env`; an expansion that would change a
  URL entry's scheme/host/path scope makes Claude Code *ignore* the allowlist entry, while
  a denylist entry still matches — deny fails safe, allow fails closed).
- User-visible failure modes: `Cannot add MCP server: enterprise MCP configuration is
  active and has exclusive control over MCP servers`; `… server is explicitly blocked by
  enterprise policy`; `… not allowed by enterprise policy`; and, for a previously
  configured server newly blocked, **it silently disappears** with no warning.
- Observability: with OpenTelemetry export configured, `OTEL_LOG_TOOL_DETAILS=1` includes
  MCP server and tool names in tool events.

**Vela reimplementation**: adopt this near-wholesale — it is all client-side. Specifics:
- Scope model: `workspace` (checked-in `.vela/mcp.json`) / `workspace-local` / `user` /
  `extension-provided`, with the same "highest precedence wins, entire entry, no field
  merging" rule and the same by-name vs by-endpoint duplicate matching.
- Same `${VAR}` / `${VAR:-default}` expansion in the same five fields, with warn-not-fail
  on missing variables.
- Same trust gate for workspace-scoped configs (a `.vela/mcp.json` in a cloned repo must
  not silently run `command`), and the same hard rule that any *helper command*
  (`headersHelper` equivalent) only runs after trust is granted.
- Copy the timeout matrix verbatim; it is the product of real operational experience.
  Especially: idle-timeout distinct from wall-clock timeout, progress notifications not
  extending the wall clock, and *not* auto-reconnecting stdio.
- Output limiting must be **token-aware per backend**: Vela can't use Anthropic's tokenizer,
  so count with the active backend's tokenizer (llama.cpp `/tokenize`, HF tokenizers for
  vLLM, tiktoken for OpenAI-compatible) and fall back to a chars/4 estimate. Same
  spill-to-disk-with-file-reference behavior and the same `maxResultSizeChars` escape hatch
  (adopt the `anthropic/` key for compatibility and mirror it under a `vela/` key).
- Tool search: Vela needs this even more than Claude Code, because local models often have
  4k–32k context. Implement deferred tool loading with a local embedding index over tool
  names + descriptions + server instructions (a small local embedding model, e.g.
  bge-small/all-MiniLM via ONNX, entirely offline) and a `search_tools` tool. Provide the
  same `auto` / `auto:N` percentage-of-context threshold mode and per-server `alwaysLoad`.
  Truncate descriptions/instructions at a configurable budget (2 KB is a good default).
- Automatic backgrounding of >2-minute tool calls, with a `/tasks`-equivalent panel; skip
  backgrounding while an elicitation dialog is open.
- Enterprise policy file at the same three OS paths (renamed for Vela), with the same
  exclusive-control semantics, the same allow/deny matching rules including argv-exact
  matching and URL wildcards, the same "denylist always merges from every source, allowlist
  can be locked to managed sources" behavior, and the same pinned-environment expansion
  rule. Ship a `vela mcp policy check` command that prints why each configured server is or
  isn't loading — better than Claude Code's silent disappearance.
- OpenTelemetry tool-event export with an opt-in flag for server/tool names.

---

## 17. Anthropic's server-side MCP client in the Messages API

Source: https://platform.claude.com/docs/en/agents-and-tools/mcp-connector

Beta header `mcp-client-2025-11-20` (previous `mcp-client-2025-04-04` deprecated). Lets an
API caller attach remote MCP servers without running an MCP client:
`mcp_servers: [{type:"url", url, name, authorization_token}]` plus a
`tools: [{type:"mcp_toolset", mcp_server_name, default_config:{enabled, defer_loading},
configs:{<tool>:{...}}}]`. Precedence: per-tool `configs` → set-level `default_config` →
system defaults. Allowlist pattern = `default_config.enabled:false` + explicit enables;
denylist = enable-by-default + explicit disables. Responses carry `mcp_tool_use` and
`mcp_tool_result` content blocks. Validation: every declared server must be referenced by
exactly one toolset; unknown tool names in `configs` log a backend warning but don't error
("MCP servers may have dynamic tool availability").

Hard limits: **only tool calls are supported** — no resources, no prompts. **The server must
be publicly exposed over HTTP (Streamable HTTP or SSE); local STDIO servers cannot be
connected.** OAuth is the caller's problem — you obtain and refresh `authorization_token`
yourself. Not ZDR-eligible. Works in the Batches API. Not available on Amazon Bedrock or
Google Cloud; on Microsoft Foundry it requires a Hosted-on-Anthropic deployment.

The same page documents **client-side MCP helpers** in every Anthropic SDK
(`mcpTools`/`mcpMessages`/`mcpResourceToContent`/`mcpResourceToFile` and language
equivalents), explicitly recommended "when you need local servers, prompts, resources, or
more control over the connection."

**Classification**: ANTHROPIC_SERVER_SIDE, and it is the *inverse* of Vela's architecture.

**Vela**: Vela never needs this — its MCP client is local, so it already has the superset
(stdio + resources + prompts + private networks). Where it matters is **backend
compatibility**: if a Vela user points at the Anthropic API as their backend, Vela must
*not* use `mcp_servers`; it should keep executing tools locally and send ordinary
`tools`/`tool_use`/`tool_result` blocks, so behavior is identical across every backend.
The one thing worth borrowing is the **toolset config shape** — `default_config` +
per-tool `configs` with `enabled` and `defer_loading` is a clean model for Vela's per-server
tool enablement and tool-search deferral, and mapping onto it makes an eventual
"use the provider's hosted connector" mode trivial.

---

## 18. Cross-cutting: what is portable vs what is not

**CLIENT_SIDE_PORTABLE (Vela implements directly, no model dependency):**
JSON-RPC framing; stdio and Streamable HTTP bindings and all their legacy variants;
`server/discover` / `initialize` era detection; tools, resources, prompts; pagination;
`subscriptions/listen` and all `*_list_changed` notifications; `ttlMs`/`cacheScope` caching
and notification-driven invalidation; progress, logging, completion, cancellation;
elicitation (form and URL); roots (legacy); the entire OAuth 2.1 client (PRM discovery, AS
metadata discovery, CIMD/DCR/pre-registered, PKCE S256, RFC 8707 `resource`, RFC 9207 `iss`
validation, step-up, refresh); lazy-auth 401 handling; static header and helper-command
auth; MCPB install and manifest handling; MCP Apps rendering; per-tool permission model;
tool search / deferred loading; enterprise policy files.

**MIXED:**
Sampling (protocol is portable; the *model* behind it is the whole point — Vela routes it to
the user's configured backend). Enterprise Managed Auth (RFC 7523 grant is portable; the
identity-assertion issuance depends on an SSO integration — Vela substitutes a direct OIDC
login). Connector permissions/policy (client enforcement is portable; Anthropic's org
console that distributes them is server-side — Vela substitutes an MDM-distributed policy
file).

**ANTHROPIC_SERVER_SIDE (Vela must substitute):**
The Connectors Directory catalog, ranking, and Suggested Connectors. Verified/Community
review labels and the submission/review pipeline. Anthropic-held OAuth client credentials
(`oauth_anthropic_creds`). The hosted MCP client itself — connections originating from
`160.79.104.0/21` with IPv4-only, no-private-IP resolution, and a global 5-minute OAuth
discovery cache shared across all users. The Messages API `mcp_servers` connector.
Server-side tool-call rendering for hosted surfaces.

---

## 19. Ordered build plan for Vela's MCP subsystem

1. **Core peer**: JSON-RPC 2.0 codec, request registry, cancellation, `_meta` handling,
   `resultType` polymorphism, error-code taxonomy, schema validation with `$ref`
   network-fetch disabled by default.
2. **stdio binding**: spawn/argv/env/keychain-injected secrets, line framing with a length
   cap, stderr → per-server log file, EOF-then-SIGTERM-then-SIGKILL shutdown, process
   groups / Job Objects, restart-on-unexpected-exit with subscription re-establishment.
3. **Era negotiation**: `server/discover` probe with the three-outcome fallback; persist per
   server.
4. **Streamable HTTP binding (modern)**: per-request POST, dual `Accept`, header mirroring
   incl. `x-mcp-header` with full constraint validation and tool rejection, base64 sentinel
   encoding, SSE response-stream parsing with comment keep-alives, close-to-cancel.
5. **Legacy HTTP bindings**: sessioned Streamable HTTP (`Mcp-Session-Id`, GET listen stream,
   `Last-Event-ID` resume, server→client requests) and HTTP+SSE 2024-11-05 (GET →
   `endpoint` event).
6. **Primitives + cache**: tools/resources/prompts with pagination, `PrimitiveCache` keyed
   on method+params+authContext, notification-driven invalidation, persisted to SQLite for
   cold-start "connect on first use."
7. **Permission engine**: per-tool allow/ask/blocked, per-server per-conversation toggle,
   `requiresUserInteraction` honoring, show-inputs-before-call, audit log.
8. **OAuth client**: full flow per §9, keychain storage, loopback callback server, Vela
   CIMD document, step-up, refresh, lazy-auth Connect card with transparent retry.
9. **Elicitation UI** (form + URL), then **sampling** routed to Vela's model router.
10. **Tool search** with a local embedding index; output limiting with backend-aware token
    counting and spill-to-disk.
11. **MCPB installer** with sandboxing (bubblewrap/sandbox-exec/AppContainer), bundled Node
    and Python runtimes, Linux support.
12. **Registry/catalog** with mechanical trust labels, MCP Registry + custom index support,
    `vela://add-connector` install links.
13. **MCP Apps** webview host with theming, supersession, and mediated `ui/open-link`.
14. **Enterprise policy**: managed config file at OS paths, allow/deny matching, exclusive
    control, `vela mcp policy check` diagnostics, OTel export.
