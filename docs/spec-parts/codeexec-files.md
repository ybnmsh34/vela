# Code execution, file creation, upload/download, extended thinking

Ingestion notes for Vela (model-agnostic desktop app). Every feature below is
recorded as: what it does → concrete mechanics → where it runs (client vs
Anthropic server) → how Vela reimplements it against an arbitrary local/BYO-key
model backend.

## Sources actually fetched (2026-08-12)

All pages below were retrieved with WebFetch and read in full. Nothing in this
document is reconstructed from memory.

1. https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool
2. https://platform.claude.com/docs/en/build-with-claude/extended-thinking
3. https://platform.claude.com/docs/en/build-with-claude/thinking
4. https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost
5. https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows
6. https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
7. https://platform.claude.com/docs/en/build-with-claude/effort
8. https://platform.claude.com/docs/en/build-with-claude/files
9. https://platform.claude.com/docs/en/build-with-claude/skills-guide
10. https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
11. https://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool
12. https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool
13. https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes
14. https://code.claude.com/docs/en/sandboxing
15. https://code.claude.com/docs/en/sandbox-environments
16. https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude
17. https://support.claude.com/en/articles/8241126-upload-files-to-claude

Redirect note: `docs.claude.com/en/docs/build-with-claude/extended-thinking`
302s to `platform.claude.com/docs/en/build-with-claude/extended-thinking`.
No source in this area was unreachable.

---

# PART 1 — Code execution (the hosted sandbox)

## 1.1 The `code_execution` server tool

**What it does.** A single tool declaration gives Claude a Linux container in
which it can run bash and create/view/edit files. Anthropic runs the container
server-side; the API client never executes anything and never sends back
`tool_result` blocks for it.

**Tool declaration** (both fields fixed; `name` must be `code_execution`):

```json
{ "type": "code_execution_20250825", "name": "code_execution" }
```

**Versions** (all GA, no `anthropic-beta` header required; legacy beta headers
still accepted):

| Version | Adds |
|---|---|
| `code_execution_20250522` | legacy, Python-only, beta header `code-execution-2025-05-22`, result block `code_execution_result` |
| `code_execution_20250825` | Bash commands + file operations |
| `code_execution_20260120` | REPL state persistence + programmatic tool calling |
| `code_execution_20260521` | same runtime as `_20260120`; tool description tells Claude about the 90 s per-Python-cell wall clock |

Web search / web fetch `..._20260209` and later require code execution
`_20260120` or later as their code-execution version. Code execution is *free*
when `web_search_20260209+` or `web_fetch_20260209+` is in the request, because
those tools use it for "dynamic filtering" (results are filtered inside the
container before entering the context window). Haiku 4.5 accepts the newer type
strings but has no PTC/REPL persistence, so they degrade to `_20250825`
behaviour.

**Sub-tools.** Declaring `code_execution` implicitly exposes two sub-tools:

- `bash_code_execution` — run shell commands
- `text_editor_code_execution` — `view` / `create` / `str_replace` on files

**Runtime environment (verbatim from the docs):**

- Python 3.11, Linux container, x86_64 (AMD64)
- 5 GiB RAM, 5 GiB workspace disk, 1 CPU
- **No internet access at all.** No outbound requests. Cannot pip install.
- Full isolation from host and other containers; file access limited to workspace
- Containers scoped to the API key's *workspace*
- Containers expire **30 days** after creation; checkpointed after ~5 min idle
- Per-invocation max execution time → `execution_time_exceeded` error;
  with PTC each REPL cell also has a **90 s** wall clock, which returns a normal
  result with non-zero `return_code` and a `detection_timeout` status message

**Pre-installed libraries** (this list is the whole reason file creation works):

- Data science: pandas, numpy, scipy, scikit-learn, statsmodels
- Visualization: matplotlib, seaborn
- File processing: pyarrow, openpyxl, xlsxwriter, xlrd, pillow, **python-pptx**,
  **python-docx**, pypdf, pdfplumber, pypdfium2, pdf2image, pdfkit, tabula-py,
  reportlab[pycairo], Img2pdf
- Math: sympy, mpmath
- Utilities: tqdm, python-dateutil, pytz, joblib
- CLI tools: unzip, unrar, 7zip, bc, rg (ripgrep), fd, sqlite

**Response format.** `server_tool_use` blocks interleaved with result blocks:

```json
{ "type": "server_tool_use", "id": "srvtoolu_01B3...", "name": "bash_code_execution",
  "input": { "command": "ls -la | head -5" } },
{ "type": "bash_code_execution_tool_result", "tool_use_id": "srvtoolu_01B3...",
  "content": { "type": "bash_code_execution_result",
    "stdout": "...", "stderr": "", "return_code": 0, "content": [] } }
```

`content` in the result is a list with one entry per file the command created;
each entry carries a `file_id` for the Files API.

File-op results:

- view → `text_editor_code_execution_view_result` with `file_type`, `content`,
  `num_lines`, `start_line`, `total_lines`
- create → `text_editor_code_execution_create_result` with `is_file_update`
- str_replace → `text_editor_code_execution_str_replace_result` with
  `old_start`, `old_lines`, `new_start`, `new_lines`, `lines` (unified-diff lines)

**Errors** (`{"type":"bash_code_execution_tool_result_error","error_code":"..."}`):
`unavailable`, `execution_time_exceeded`, `invalid_tool_input`,
`too_many_requests` (all tools); `output_file_too_large` (bash);
`file_not_found` (text editor).

**`pause_turn` stop reason** for long-running turns — echo the response back to
continue.

**Container reuse.** Response carries a top-level `container` object with `id`
and `expires_at`. Pass `container: "<id>"` as a top-level request parameter to
reuse it. `expires_at` is a short rolling value and does *not* report the 30-day
limit. Expired containers error; retry without the parameter.

**Streaming.** Sub-tool input streams as `input_json_delta`; each *result* block
arrives whole in a single `content_block_start`:

```
event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srvtoolu_xyz789","name":"bash_code_execution"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\": \"python analyze.py\"}"}}

event: content_block_start
data: {"type":"content_block_start","index":2,"content_block":{"type":"bash_code_execution_tool_result","tool_use_id":"srvtoolu_xyz789","content":{"type":"bash_code_execution_result","stdout":"...","stderr":"","return_code":0,"content":[]}}}
```

**Pricing.** Billed by execution time, min 5 minutes; 1,550 free hours/org/month;
then $0.05/hour/container. If files are attached, execution time bills even if
the tool is never called (files are preloaded onto the container). Tracked as
`usage.server_tool_use.code_execution_requests`.

**Multicomputer hazard.** If you also give Claude a client-side bash tool,
Claude sees two execution environments with no shared state and will confuse
them. Docs recommend explicit system-prompt text saying variables/files do not
persist across environments. Also: when Claude calls a client tool *alongside*
code execution, the API returns the code execution call **without** its result;
the result arrives in a later response after you return your `tool_result`s.

**Classification: ANTHROPIC_SERVER_SIDE.** The container, its filesystem, its
library set, its lifecycle and its billing are entirely Anthropic infrastructure.

### Vela reimplementation

Vela must ship its own sandbox because there is no server to lean on. Design:

1. **Sandbox provider abstraction.** One interface,
   `Sandbox { start(spec) -> Handle; exec(cmd, timeout) -> {stdout,stderr,code};
   read(path); write(path, bytes); list_created_files(); snapshot(); destroy() }`.
   Three concrete backends, selectable per workspace:
   - **Docker/Podman** (default when a daemon is present). Base image pinned by
     digest, `python:3.11-slim` + the exact library list above. Run with
     `--network none`, `--memory 5g`, `--cpus 1`, `--pids-limit`, `--read-only`
     root with a writable `/workspace` tmpfs/volume, `--cap-drop ALL`,
     `--security-opt no-new-privileges`, non-root uid. This reproduces the
     documented limits (5 GiB RAM, 5 GiB disk, 1 CPU, no internet) exactly.
   - **OS-native sandbox, no Docker required.** macOS: `sandbox-exec` (Seatbelt)
     profile. Linux: `bubblewrap` (`bwrap --unshare-all --die-with-parent
     --ro-bind / / --bind $WORKDIR $WORKDIR --tmpfs /tmp`) plus the optional
     seccomp filter. Windows: require WSL2 and use bubblewrap there, or fall back
     to Docker. This is precisely what Claude Code does, and Anthropic publishes
     the primitives as `@anthropic-ai/sandbox-runtime` — Vela can either vendor
     that package or reimplement the same two primitives.
   - **microVM** (Firecracker / krun) for the "untrusted repo" tier.
2. **Bundled Python runtime.** Ship (or first-run download) a pinned Python 3.11
   environment containing pandas, numpy, scipy, scikit-learn, statsmodels,
   matplotlib, seaborn, pyarrow, openpyxl, xlsxwriter, xlrd, pillow, python-pptx,
   python-docx, pypdf, pdfplumber, pypdfium2, pdf2image, pdfkit, tabula-py,
   reportlab, img2pdf, sympy, mpmath, tqdm, python-dateutil, pytz, joblib, plus
   unzip, 7z, bc, ripgrep, fd, sqlite3. Vendoring this is non-negotiable: the
   whole file-creation feature is "python-docx/pptx/openpyxl/reportlab already
   installed in an offline container."
3. **Tool schema parity.** Vela synthesises the tool *as a normal client tool*
   for the backing model, because arbitrary models have no server-side tool. Emit
   a JSON-schema tool named `code_execution` with a `command` discriminator
   covering `bash`, `view`, `create`, `str_replace`, so a small local model has a
   flat, unambiguous surface. Internally, normalise the model's call into the
   same result block shapes Anthropic uses
   (`bash_code_execution_result` etc.) so Vela's transcript format, UI and
   persistence layer are provider-independent.
4. **Container reuse → session-scoped sandbox.** Vela keys a sandbox to a
   conversation, not a request. Pause = container `stop`; resume = `start`.
   Persist a `container_id` in the conversation record and expose the same
   `expires_at` semantics (configurable, default "keep until conversation is
   deleted" — a desktop app has no reason to impose the 30-day rule).
5. **Egress policy, since Vela's box does have a network.** Default `--network
   none` to match Anthropic. Offer the tiered policy the Claude apps expose:
   (a) no network, (b) package managers only (pypi.org, files.pythonhosted.org,
   registry.npmjs.org, github.com, crates.io, Ubuntu archives, yarn), (c) package
   managers + user-listed domains, (d) all domains. Implement with a userspace
   HTTP/CONNECT proxy plus `socat` relay (the Claude Code design) rather than
   iptables, so it works unprivileged on all three OSes. Record explicitly that
   hostname-based allowlisting without TLS termination is defeatable by domain
   fronting — Anthropic documents this limitation for its own sandbox.
6. **Streaming parity.** Vela's own agent loop emits synthetic
   `server_tool_use` / `*_tool_result` events onto its internal event bus so the
   renderer shows "running command…" then a whole result block, identical to the
   hosted behaviour, regardless of whether the backing model streamed tool input
   incrementally (llama.cpp grammars often will not).
7. **Timeouts.** Per-invocation timeout (configurable, default 5 min) mapping to
   `execution_time_exceeded`; per-cell 90 s wall clock for the REPL mode, with a
   `detection_timeout` marker so behaviour matches what models were trained on.

## 1.2 REPL state persistence

`code_execution_20260120+` keeps the Python interpreter state (variable
bindings) alive across requests that reuse the container, not just the
filesystem.

**MIXED / ANTHROPIC_SERVER_SIDE.** Server-held interpreter process.

**Vela:** run a long-lived Jupyter kernel (`ipykernel` over ZeroMQ) or a plain
`code.InteractiveConsole` subprocess inside the sandbox, one per conversation.
Cells execute against that kernel; `stdout`/`stderr`/`display_data` are captured
and mapped to the result block. Kernel restart = the `restart` semantics of the
bash tool. Because Vela owns the process, it can also checkpoint via CRIU or
simply persist a `dill` snapshot of the globals dict on conversation suspend.

## 1.3 Programmatic tool calling (PTC)

**What it does.** Claude writes Python inside the sandbox that calls *your*
tools as async functions, so a 20-call workflow costs one model round trip
instead of twenty, and intermediate results never enter the context window.

**Mechanics.**

- Opt a tool in by adding to its definition:
  ```json
  { "name": "query_database", "description": "...", "input_schema": {},
    "allowed_callers": ["code_execution_20260120"] }
  ```
  Values: `["direct"]` (default if omitted), `["code_execution_20260120"]`, or
  both. `_20260120` and `_20260521` are interchangeable in this field, and
  responses always tag the caller as `code_execution_20260120`.
- Tools with a code-execution caller are exposed to Claude's code as **async
  Python functions taking one dict and returning a string** (the text of the
  `tool_result` you send back). Claude uses top-level `await` and
  `asyncio.gather` for parallelism, e.g.
  `rows = json.loads(await query_database({"sql": "<sql>"}))`.
- When the code calls a tool, execution **pauses**; the API returns
  `stop_reason: "tool_use"` and a `tool_use` block whose `caller` is:
  ```json
  { "type": "code_execution_20260120", "tool_id": "srvtoolu_abc123" }
  ```
  (direct calls carry `"caller": {"type": "direct"}`). `tool_id` matches the
  `server_tool_use` block that made the call.
- You return `tool_result` for every pending programmatic call in **one** user
  message, and **must** include the `container` id on that request — it is
  required, not optional, while a call is pending.
- The paused call raises `TimeoutError` inside the code after **~4 minutes**.
  Idle containers reclaimed after ~5 min; nothing reusable past 30 days.
- Completion emits `code_execution_tool_result` / `code_execution_result` with
  `stdout`, `stderr`, `return_code`, `content`.
- `allowed_callers` is **guidance, not a security boundary** (docs say so
  explicitly). `tool_choice` naming a tool whose `allowed_callers` omits
  `"direct"` → HTTP 400 `invalid_request_error`. Recursive `$ref` in an
  `input_schema` → 400 with `Circular $ref detected`.
- Reported benefit: +11% on BrowseComp/DeepSearchQA with 24% fewer input tokens.

**ANTHROPIC_SERVER_SIDE** (the pause/resume protocol is implemented in the API).

**Vela:** this is the single highest-leverage feature to reimplement locally,
because local models are token-starved and slow. Implementation:

- Inject a generated `tools.py` shim into the sandbox exposing every Vela tool
  the user has marked "callable from code" as an `async def name(args: dict) ->
  str`. The shim RPCs out of the sandbox over a **unix domain socket bind-mounted
  into the container** (or a vsock for the microVM backend) to Vela's tool
  dispatcher on the host. No Anthropic-style pause/resume round trip is needed at
  all: Vela is both sides of the wire, so the call is a blocking local RPC and the
  model is never re-sampled.
- Keep the `allowed_callers` field in Vela's tool descriptor purely as *prompt
  shaping*: tools marked code-only are described to the model as Python functions
  in the system prompt / tool description rather than as JSON tools, which is
  exactly what Anthropic does.
- Apply the same guardrails: 4-minute per-call timeout, cancel-on-abort, and a
  hard rule that the host dispatcher re-validates arguments (never trust the
  sandbox), since Anthropic explicitly says `allowed_callers` is not a boundary.
- Because Vela owns the loop, it can go further than the API: stream partial
  stdout from the running cell into the UI live.

## 1.4 Client-side bash tool (`bash_20250124`)

**What it does.** The *other* half: an Anthropic-schema tool where **your**
application runs the command. Schema-less (`input_schema` is baked into the
model and cannot be modified).

```json
{ "type": "bash_20250124", "name": "bash" }
```

Input fields Claude sets: `command` (required unless restarting) and
`restart: true`. On `restart`, kill the shell, start a fresh one, return a
`tool_result` confirming it — working dir, env vars and running processes are
gone. Your app keeps **one bash process alive across tool calls**, so state
persists; the API itself is stateless and knows nothing about the session.
Multiple `tool_use` blocks in one response → run in order in the same session,
return all results in one `user` message. `bash_20250124` needs no beta header
and is accepted by every model from Sonnet 3.7 onward. The legacy
`bash_20241022` needs `anthropic-beta: computer-use-2024-10-22`.

**CLIENT_SIDE_PORTABLE.** This is the model Vela should copy for its *local*
shell.

**Vela:** ship exactly this — a persistent PTY-backed shell per conversation,
`restart` supported, stdout+stderr merged into the `tool_result`. Two shells
exist in Vela: the sandboxed "analysis" shell (§1.1) and, optionally, an
unsandboxed "your machine" shell gated by permissions. Vela must inject the
same disambiguating system-prompt text Anthropic recommends, because a local
model will confuse the two even more readily than Claude does.

## 1.5 Client-side text editor tool (`text_editor_20250728`)

```json
{ "type": "text_editor_20250728", "name": "str_replace_based_edit_tool",
  "max_characters": 10000 }
```

`max_characters` (truncation when viewing large files) only exists on
`text_editor_20250728` and later. Commands and their inputs:

- `view` — `path`, optional `view_range: [start, end]` (1-indexed; `-1` = EOF;
  files only, not directories). Works on directories too (lists them).
- `str_replace` — `path`, `old_str` (must match exactly incl. whitespace),
  `new_str`
- `create` — `path`, `file_text`
- `insert` — `path`, `insert_line` (0 = beginning), `insert_text`
- (`undo_edit` existed in older versions; not in the 20250728 command list)

**CLIENT_SIDE_PORTABLE.** Vela implements it verbatim against the host FS with
path-allowlist enforcement, plus an in-memory undo stack so `undo_edit` can be
offered to models that were trained on it. Note the deliberate design choice:
`str_replace` requiring an exact unique match is what makes edits safe without a
diff-apply engine, and Vela should keep the "fail if 0 or >1 matches" semantics.

## 1.6 Self-hosted sandboxes (Managed Agents)

Anthropic's own answer to "I don't want the sandbox on your infrastructure."
Orchestration stays at Anthropic; tool execution moves to a worker you run.

- The `self_hosted` environment is a **work queue**. Your **environment worker**
  claims work items (always-on polling, or webhook-triggered on
  `session.status_run_started`), spawns an execution context per item, downloads
  the agent's skills, runs the tool calls, posts results back.
- Tool inputs/outputs still flow to Anthropic's control plane so the model can
  see them.
- Filesystem convention: `/workspace` is the default working dir; skills land in
  `<workdir>/skills/<name>/`. On self-hosted, the system prompt omits the
  `/mnt/session/outputs` instruction used on Anthropic-managed sandboxes, so
  deliverables land wherever the agent writes them.
- Requirements: a Linux host with `/bin/bash` at that exact path (invoked
  directly, ignoring `PATH`); `ant` CLI or an SDK; an environment key for the
  worker plus an API key for session creation. TS SDK also needs `unzip`, `tar`,
  Node 22+.
- Pre-built workers exist for AWS Lambda MicroVMs, Blaxel, Cloudflare, Daytona,
  E2B, Fly.io, GKE Agent Sandbox, Modal, Namespace, Superserve, Vercel.

**MIXED.** Confirms the architecture Vela wants, inverted: Vela keeps
*orchestration* local too.

**Vela:** the worker/queue split is worth copying for one specific case — a
"remote sandbox" provider so a laptop can offload heavy analysis to a homelab
box or an E2B/Daytona account. Same `Sandbox` interface (§1.1), different
transport. Also copy the `/workspace` + "final deliverables go here" convention,
and make the outputs directory a first-class, watched folder that Vela surfaces
in the UI as "files this conversation produced."

## 1.7 Claude Code's sandboxed Bash tool (the closest existing analogue)

This is the reference implementation Vela should mirror, because it is the only
one that runs on an end user's own machine.

**OS-level enforcement:** macOS → Seatbelt. Linux → `bubblewrap`. WSL2 →
bubblewrap (WSL1 unsupported: bubblewrap needs kernel features only in WSL2).
Native Windows unsupported. Linux/WSL2 deps: `bubblewrap`, `socat`, plus bundled
`ripgrep` and an *optional* seccomp filter (`npm i -g
@anthropic-ai/sandbox-runtime`) that adds Unix-domain-socket blocking. Ubuntu
24.04+ needs an AppArmor profile granting `bwrap` `userns`.

**Filesystem model (defaults):**

- Write: cwd + subdirs, plus the session temp dir (`$TMPDIR` is redirected there)
- Read: the entire computer minus denied dirs — **including `~/.aws/credentials`
  and `~/.ssh/` by default**
- Blocked: writes outside cwd/tmp, incl. `~/.bashrc` and `/bin/`
- Linked git worktrees also get write access to the main repo's shared `.git`,
  except `hooks/` and `config`

**Protected paths (cannot be re-allowed by any `allowWrite` or Edit rule; only
`filesystem.disabled` lifts them):** `.claude` settings files and the
`skills`/`agents`/`commands`/`hooks` dirs, `.mcp.json`, `.claude/workflows`,
`.claude/scheduled_tasks.json` in cwd and ancestors; shell startup files,
`.gitconfig`, `.vscode`, `.idea`, `.git/hooks`, `.git/config` in cwd; files that
would turn cwd into a bare repo (`HEAD`, `objects`, `refs`, and `config`/`hooks`
when they already exist) — on Linux/WSL2 the sandbox *deletes* a top-level `HEAD`
/`objects`/`refs` that appears mid-command; and most of `~/.claude` plus
`~/.claude.json` and `.credentials.json`. A symlink appearing at a protected path
extends the deny to its target from the next command.

**Network model:** a proxy running *outside* the sandbox. **No domains
pre-allowed.** First use of a domain prompts; approval lasts the session.
`allowedDomains` pre-allows; `WebFetch(domain:...)` allow rules also pre-allow.
`strictAllowlist: true` denies instead of prompting. `allowManagedDomainsOnly`
(managed settings only) locks the list. The proxy allows by client-supplied
hostname and **does not terminate TLS by default** — explicitly vulnerable to
domain fronting. `network.tlsTerminate` (experimental) makes it terminate TLS,
which credential masking requires.

**Credential protection** (`sandbox.credentials`):

```json
{ "sandbox": { "enabled": true, "credentials": {
    "files": [ {"path": "~/.aws/credentials", "mode": "deny"},
               {"path": "~/.ssh", "mode": "deny"} ],
    "envVars": [ {"name": "GITHUB_TOKEN", "mode": "deny"},
                 {"name": "NPM_TOKEN", "mode": "deny"} ] } } }
```

`mode: "mask"` is the interesting one: the sandboxed command sees a per-session
**sentinel**, and the proxy swaps in the real value on egress to `injectHosts`
(each of which must be inside `allowedDomains`). Requires `network.tlsTerminate`
since the proxy must see request contents; substitution covers headers and
bodies. On macOS, masked *files* are simply blocked (no sentinel copy); on
Linux/WSL2 a sentinel copy is served. Extras: `extract` regex (group 1 is the
secret; `onExtractNoMatch: warn|deny|error`), `decode: "jwt"` with `maskClaims`,
and `credentials.awsPairs` + SigV4 re-signing at the proxy (three forms cannot be
re-signed: aws-chunked streaming, presigned URLs, SigV4A — `credentials.sigv4`
can set each to `passthrough`). `mask`, `tlsTerminate`, `allowPlaintextInject`,
`awsPairs`, `sigv4`, `strictAllowlist`, `allowAppleEvents` and
`filesystem.disabled` are honoured **only** from user/managed/`--settings`
scopes, never from a repo's `.claude/settings.json`.

**Modes.** *Auto-allow*: sandboxable commands run without prompting; deny rules
still apply; `rm`/`rmdir` on `/`, `$HOME` or critical paths still prompt;
content-scoped ask rules like `Bash(git push *)` still prompt; a bare `Bash` ask
rule is skipped for sandboxed commands (but not in plan mode). *Regular
permissions*: everything still goes through the permission flow.

**Escape hatch.** When a command fails because the sandbox denied it, Claude
Code appends the violation details (which path / which host) to the command
output so the model can see it, and the model may retry with
`dangerouslyDisableSandbox`, which then goes through the normal permission flow.
`allowUnsandboxedCommands: false` ("Strict sandbox mode") ignores the parameter
entirely.

**Config shape:**

```json
{ "sandbox": { "enabled": true,
    "filesystem": { "allowWrite": ["~/.kube", "/tmp/build"],
                    "denyRead": ["~/"], "allowRead": ["."], "disabled": false },
    "network": { "allowedDomains": ["github.com", "*.npmjs.org"],
                 "tlsTerminate": {} } } }
```

Path prefixes: `/` absolute; `~/` home; `./` or bare = project root for project
settings, `~/.claude` for user settings. Overlapping read rules: the more
specific path wins (an exact `denyRead` holds inside a wider `allowRead`). Arrays
from multiple settings scopes are **merged**, not replaced, and edits apply to
the running session.

**Known incompatibilities:** `watchman` (use `jest --no-watchman`); Go CLIs
(`gh`, `gcloud`, `terraform`) fail TLS verification under Seatbelt → put in
`excludedCommands`; `open`/`osascript` fail with `-600` because Apple Events are
blocked (`allowAppleEvents: true` fixes it but removes code-execution isolation);
`docker` is incompatible; `git merge`/`checkout` fail with `unable to unlink old`
when they must replace a protected file; bubblewrap can't mount a fresh `/proc`
in an unprivileged container → `enableWeakerNestedSandbox`.

**Scope caveats:** the sandbox isolates **Bash subprocesses only**. Read/Edit/
Write use the permission system directly. MCP servers and hooks run
unconstrained on the host. Sandboxed commands inherit the parent environment
including credentials unless scrubbed. Subagents share the parent's sandbox
config.

**CLIENT_SIDE_PORTABLE** — this is all local OS machinery.

**Vela:** adopt essentially wholesale. Concretely:
- Two-layer sandbox (filesystem + network) with independent disable switches.
- Same OS primitives (Seatbelt / bubblewrap / WSL2), or vendor
  `@anthropic-ai/sandbox-runtime`.
- Same default boundary: write = cwd + session tmp; read = broad but with a
  **better default than Anthropic's** — Vela should deny-read `~/.ssh`,
  `~/.aws`, `~/.config/gh`, browser profiles and keychain files out of the box,
  since Anthropic itself flags that its default leaves them readable.
- Copy the protected-paths concept verbatim onto Vela's own config surface:
  a sandboxed command must never be able to write Vela's settings, skills,
  hooks, MCP config or credential store — otherwise the sandbox is a one-command
  privilege escalation.
- Copy the out-of-sandbox proxy with per-session domain approval prompts, and
  ship the credential-masking design (sentinel + egress substitution) because it
  is the only way to let `gh`/`npm` work without handing the model a token.
  Document the same TLS/domain-fronting caveat.
- Copy the escape hatch: surface *why* the sandbox denied something into the
  tool output so the model can self-correct, and offer a permission-gated
  unsandboxed retry.
- Copy the "whole-process" tier: Vela should offer running its *own* agent
  process inside the sandbox so MCP servers and hooks are covered too, which is
  what `sandbox-runtime` exists for.

---

# PART 2 — File creation, upload and download

## 2.1 Files API

**Compatibility:** Beta. Header `anthropic-beta: files-api-2025-04-14`. Not ZDR
eligible. Claude API / Claude Platform on AWS / Microsoft Foundry (Hosted on
Anthropic deployment only). **Not** on Amazon Bedrock or Google Cloud.

**Operations:** `POST /v1/files` (multipart upload), `GET /v1/files` (paginated,
`limit` default 20, `before_id`/`after_id`), `GET /v1/files/{id}` (metadata),
`GET /v1/files/{id}/content` (download), `DELETE /v1/files/{id}`.

Upload response:

```json
{ "id": "file_011CNha8iCJcU1wXNR6q4V8w", "type": "file",
  "filename": "document.pdf", "mime_type": "application/pdf",
  "size_bytes": 1024000, "created_at": "2025-01-01T00:00:00Z",
  "downloadable": false }
```

**The download asymmetry is the key mechanic:** `downloadable` is `false` for
everything you upload. Only files created by **skills** or the **code execution
tool** are downloadable. Downloading a file you uploaded returns 400.

**Content blocks** that consume a `file_id`:

```json
{ "type": "document", "source": {"type": "file", "file_id": "file_..."},
  "title": "...", "context": "...", "citations": {"enabled": true} }
{ "type": "image", "source": {"type": "file", "file_id": "file_..."} }
{ "type": "container_upload", "file_id": "file_..." }
```

`document` = PDF (`application/pdf`) and plain text (`text/plain`);
`image` = jpeg/png/gif/webp; `container_upload` = everything else, routed to the
code execution container. The code execution page lists CSV, Excel (.xlsx/.xls),
JSON, XML, images, and text files (.txt/.md/.py) as processable there.
For .docx/.xlsx outside the container, the docs say convert to plain text
yourself; for .docx with images, convert to PDF first so PDF image parsing and
citations work.

**Limits:** 500 MB per file; 500 GB per organization. Files cannot be modified
or renamed after upload (upload new + delete old). Persist until deleted;
deletion is irreversible; may persist briefly in in-flight Messages calls.
Filenames must be 1–255 chars and exclude `< > : " | ? * \ /` and U+0000–U+001F.

**Errors:** 404 not found; 400 invalid file type for the block; 400 not
downloadable; 400 exceeds context window; 400 invalid filename; 413 too large;
400 storage limit exceeded.

**Security warning (verbatim in the docs):** uploaded files are accessible to the
**entire workspace**, not scoped to a user, conversation or session. Never accept
`file_id` values from end users.

**Billing:** all Files API operations are free; file content in Messages requests
is priced as input tokens. Beta rate limit ~100 file-related requests/minute.

**ANTHROPIC_SERVER_SIDE.**

### Vela reimplementation

Vela replaces the entire Files API with a **local content-addressed blob store**:

- `~/Library/Application Support/Vela/blobs/<sha256>` (or XDG equivalent), with a
  SQLite `files` table: `id` (`file_<ulid>` to keep the same shape),
  `sha256`, `filename`, `mime_type`, `size_bytes`, `created_at`,
  `origin` (`uploaded` | `generated`), `conversation_id`, `sandbox_path`.
- Deliberately **fix the two flaws Anthropic documents**: scope files to a
  conversation/project rather than a workspace-wide bag (their own warning says
  workspace scoping is a cross-user leak vector), and drop the
  upload-is-not-downloadable asymmetry, which only exists because Anthropic does
  not want to be a file host. In Vela the user's own file is obviously
  downloadable — it is already on their disk.
- Keep `origin` anyway, because the UI genuinely wants to distinguish "you gave
  me this" from "I made this," and because the sandbox output-directory watcher
  needs it.
- No 500 MB / 500 GB limits; instead a configurable per-conversation disk quota
  matching the sandbox's 5 GiB workspace so a runaway script can't fill the disk.
- Mirror the content-block vocabulary internally (`document` / `image` /
  `container_upload`) so prompt assembly is provider-independent, then lower it
  per backend at send time: an OpenAI-compatible endpoint gets base64 image parts
  and extracted text; a local llama.cpp vision model gets raw image tensors; a
  text-only local model gets a text extraction with a note.
- **Ingestion pipeline is Vela's job, not the model's.** Because a local model
  may not accept PDFs at all, Vela must run extraction itself: pypdf/pdfplumber
  for text, pdf2image + the vision model (if any) for page rasters, python-docx /
  openpyxl / python-pptx for Office formats, and OCR (tesseract) for scans. This
  runs in the same sandbox, reusing the same bundled library set.

## 2.2 File creation via Agent Skills (docx / pptx / xlsx / pdf)

**This is how "Claude creates a Word document" actually works on the API.** It
is not a model capability; it is a Skill that runs Python in the code execution
container.

```json
{ "container": { "skills": [
      { "type": "anthropic", "skill_id": "pptx", "version": "latest" },
      { "type": "anthropic", "skill_id": "xlsx", "version": "latest" } ] },
  "tools": [ { "type": "code_execution_20250825", "name": "code_execution" } ] }
```

- Up to **8 skills per request**.
- Anthropic skills: `type: "anthropic"`, short ids `pptx`, `xlsx`, `docx`, `pdf`,
  date versions like `20251013` or `latest`.
- Custom skills: `type: "custom"`, generated ids like
  `skill_01AbCdEfGhIjKlMnOpQrStUv`, epoch versions like `1759178010641129`.
- Beta headers: `anthropic-beta: code-execution-2025-08-25,skills-2025-10-02`
  (plus `files-api-2025-04-14` for file I/O).
- **The code execution tool is mandatory.** Skills run *in the code execution
  environment.* Generated documents come back as `file_id`s inside
  `bash_code_execution_tool_result` blocks and are fetched with the Files API.

The mechanism is therefore: skill = prompt/instructions + bundled scripts →
Claude writes Python → the container's pre-installed `python-docx`,
`python-pptx`, `openpyxl`/`xlsxwriter`, `reportlab`/`pypdf` produce the file →
the file is registered in the Files API → the client downloads it.

**ANTHROPIC_SERVER_SIDE** (hosted skill registry + hosted container), but the
*substance* is ordinary open-source Python.

### Vela reimplementation

This is the easiest high-value win in the whole area, because the ingredients are
all MIT/BSD-licensed and already required by §1.1:

1. Ship the four document skills as local skill folders
   (`~/.vela/skills/{docx,pptx,xlsx,pdf}/SKILL.md` + `scripts/`). Same shape as
   Anthropic's: a markdown instruction file the agent reads, plus helper Python.
2. Loading a skill = copying its folder into `<workspace>/skills/<name>/` in the
   sandbox and appending its instruction text (or just its name + description,
   progressive-disclosure style) to the system prompt. Cap at 8 concurrently
   loaded, as Anthropic does, or better: name+description always, full body on
   demand — local context windows are smaller.
3. The generated file lands in `<workspace>/outputs/`. A watcher registers each
   new file in the blob store with `origin=generated` and emits the same
   "file created" event the UI renders as a download chip.
4. Because Vela is a desktop app it can go further than the API: write directly
   to a user-chosen folder, register with the OS file associations, and offer
   "open in Word/Excel/PowerPoint/Preview." No download step at all.
5. Model-agnostic caveat: a 7B local model will not reliably drive `python-pptx`
   from scratch. Vela's skills must therefore be **script-heavy rather than
   prose-heavy** — expose narrow, well-documented helper functions
   (`build_deck(outline_json)`, `write_report(sections_json)`) so the model only
   has to produce JSON, not library calls. This is the single most important
   adaptation for the model-agnostic requirement.

## 2.3 File creation in the Claude consumer apps (web / Desktop / mobile)

**What it does.** Claude creates and edits **.xlsx, .pptx, .docx and .pdf**, plus
Python scripts, PNG data visualizations, and CSV/TSV processing, inside a
"private computing environment" — a sandboxed environment in which it writes and
runs code (Python or JavaScript) with standard packages. Available on web,
Claude Desktop and mobile (iOS/Android).

**Limits:** 30 MB max per file for both upload and download in this feature.
PDFs over 30 MB can still be processed *through the computing environment*
without loading them into the context window.

**Enablement:** Settings → Capabilities → "Code execution and file creation."
Mobile: initials/name → Settings → Capabilities.

**Network access tiers** (org-configurable — this is the productised version of
§1.7's proxy):

1. Network access disabled (most secure): pre-installed packages only, no
   internet.
2. Package managers only — **default for Team/Enterprise**: npm, PyPI, GitHub,
   etc.
3. Package managers + specific allowlisted domains.
4. All domains except Anthropic's legal blocklist.

Approved domains when enabled: Anthropic services, GitHub, NPM, PyPI, Rust
crates, Ubuntu repositories, Yarn.

**Plan defaults:** Free/Pro/Max — enabled by default *with network access
enabled*. Team — enabled by default, owners can disable, *network access
disabled by default*. Enterprise — enabled by default for new orgs, network
access disabled by default.

**Security posture, stated in the docs:** a bad actor can inconspicuously add
instructions via external files or websites that trick Claude into downloading
and running untrusted code, or into reading sensitive data from a connected
knowledge source and making an external network request to leak it. Mitigations
listed: user can disable anytime; user-friendly summaries of Claude's actions;
ability to stop Claude mid-execution; sandbox isolation with no shared
environments between users; a **prompt injection classifier**; limited network,
container and storage resources; and **public sharing of conversations
containing file artifacts is disabled** for Free/Pro/Max.

**Output:** download from the conversation, or save directly to Google Drive. On
mobile, "Download" opens the OS preview or the relevant app. Usage draws from
plan limits and costs more than normal chat.

**ANTHROPIC_SERVER_SIDE** (hosted container + hosted classifier + Drive
connector), though the UX is what Vela must match.

### Vela reimplementation

- Same capability toggle in Vela Settings, defaulting **off**, with the four
  network tiers implemented by the §1.1/§1.7 proxy. Vela's honest default for a
  personal machine is tier 1 or 2.
- The 30 MB cap is an Anthropic serving constraint; Vela drops it and uses the
  sandbox disk quota instead.
- Replace "download from conversation / save to Drive" with: files are already on
  disk, so the UI shows Reveal in Finder/Explorer, Open With, and an optional
  per-conversation output folder. Cloud save becomes a generic
  "export destination" plugin (Drive, Dropbox, S3, or nothing).
- **Take the prompt-injection warning seriously and design for it, since Vela has
  no server-side classifier.** Concrete substitutes: (a) network off by default
  for the sandbox; (b) a visible, non-collapsible action log of every command
  run and every domain contacted; (c) a hard stop button that SIGKILLs the
  container; (d) an optional local classifier pass (a small model, or heuristics)
  over tool-result text that entered the context from web/file sources; (e)
  taint-tracking: mark content that came from an untrusted source and require
  explicit confirmation before a sandbox command runs while tainted content is in
  context. (e) is the strongest and is genuinely implementable locally.
- Mirror the "no shared environments between users" property trivially (one
  desktop user), but do isolate **per conversation**, so a script from
  conversation A cannot read conversation B's files.

## 2.4 Upload limits in the consumer apps

- Document types accepted: PDF, DOCX, CSV, TXT, HTML, ODT, RTF, EPUB, JSON,
  XLSX (XLSX requires code execution enabled).
- Images: JPEG, PNG, GIF, WebP.
- Chat uploads: **500 MB per file, up to 20 files per chat**; images max
  8000×8000 px; PDFs max 1000 pages.
- Project files: **30 MB per file**, unlimited count but must fit the context
  window; text extraction only (except multimodal PDFs).
- PDFs ≤100 pages: text **and** visual elements analyzed. 101–1000 pages: text
  only, no visual analysis. Images: ≥1000×1000 px recommended.
- No stated per-plan differences on these limits.

**ANTHROPIC_SERVER_SIDE.**

**Vela:** no server, so limits become resource decisions. Enforce a soft
per-message attachment budget derived from the *actual* backing model's context
length (queried from llama.cpp `/props`, Ollama `/api/show`, or the provider's
model metadata) rather than a fixed constant. Reproduce the page-count tiering as
a cost heuristic: rasterize and vision-encode the first N pages, text-extract the
rest, where N is derived from the model's image budget and whether it is
multimodal at all. Show the user the token cost of each attachment before
sending — something the hosted apps do not do and a local app can.

---

# PART 3 — Thinking

Thinking is now split across two modes and five doc pages. The vocabulary:
**adaptive thinking** (`thinking.type: "adaptive"`, model decides) is current;
**extended thinking** (`thinking.type: "enabled"` + `budget_tokens`) is the
legacy manual mode.

## 3.1 What a thinking block is

Thinking arrives as content blocks *before* the text blocks:

```json
{ "content": [
    { "type": "thinking",
      "thinking": "Let me break this down...",
      "signature": "WaUjzkypQ2mUEVM36O2Txu...." },
    { "type": "text", "text": "Based on my analysis..." } ] }
```

The `thinking` text is **never the raw chain of thought** — it is a summary
produced by a *different model* from the one you targeted, and the thinking model
never sees the summary. No `display` setting returns raw CoT. `signature` is an
encrypted copy of the full reasoning used to verify the block was generated by
Claude when you pass it back; it is opaque, must not be parsed, is much longer on
Claude 4+, and is portable across the Claude API, Bedrock and Vertex.

## 3.2 Adaptive thinking

```json
{ "model": "claude-opus-4-8", "max_tokens": 16000,
  "thinking": { "type": "adaptive", "display": "summarized" } }
```

Claude decides **per request** whether to think and how much. The same
conversation can contain turns with and without thinking, and a non-thinking turn
contains **no thinking block at all** — the docs say explicitly: don't build
logic assuming every assistant turn starts with one. Interleaved thinking is
automatic; no beta header.

Depth is steered with `output_config.effort`, not a token budget:

```json
{ "output_config": { "effort": "medium" } }
```

| Effort | Thinking behaviour |
|---|---|
| `max` | always thinks, no constraints on depth |
| `xhigh` | always thinks deeply, extended exploration |
| `high` (default) | almost always thinks; deep reasoning on complex tasks |
| `medium` | moderate thinking; may skip for simple queries |
| `low` | minimizes thinking; skips for simple tasks |

Effort affects **all** tokens (text, tool calls, thinking), not just thinking, and
works with thinking off. `high` ≡ omitting the parameter. Effort is a behavioral
signal, not a token budget. `adaptive` is a *thinking mode*, never an effort
value.

## 3.3 Extended (manual) thinking

```json
{ "thinking": { "type": "enabled", "budget_tokens": 10000 } }
```

Rules:

- **Minimum 1,024 tokens**; smaller values rejected.
- Must be **less than `max_tokens`** — thinking counts toward `max_tokens`.
  The one exception: with interleaved thinking, `budget_tokens` may exceed
  `max_tokens` because the budget spans all thinking blocks in one assistant turn.
- Consequently **incompatible with `max_tokens: 0`** cache pre-warming.
- The budget is a **target, not a cap**; `max_tokens` is the hard ceiling.
- Above 32k thinking tokens, use batch processing to avoid timeouts / open
  connection limits.
- On Opus 4.5 (the only extended-only model with effort), set both: effort shapes
  the whole response, `budget_tokens` sets thinking depth.

Interleaved thinking in manual mode needs `anthropic-beta:
interleaved-thinking-2025-05-14` on Opus 4.5 / Sonnet 4.5 / Opus 4.1 / Opus 4 /
Sonnet 4. On Sonnet 4.6 the header still functions but is deprecated. On **Opus
4.6 manual mode has no interleaved thinking at all**. Haiku 4.5 does not support
interleaved thinking (header accepted and ignored). Bedrock/Vertex accept the
header on any model and ignore it where unsupported.

Manual mode adds one structural requirement adaptive drops: **the final assistant
turn of a thinking-enabled request must begin with a thinking block.**

## 3.4 Per-model support matrix (verbatim)

| Model | Thinking types | Default | Rejected with 400 |
|---|---|---|---|
| Claude Fable 5 | Adaptive only | Always on | `"enabled"`, `"disabled"` |
| Claude Mythos 5 | Adaptive only | Always on | `"enabled"`, `"disabled"` |
| Claude Mythos Preview | Adaptive, extended | Always on | `"disabled"` |
| Claude Opus 5 | Adaptive only | On | `"enabled"`, `"disabled"`* |
| Claude Opus 4.8 | Adaptive only | Off | `"enabled"` |
| Claude Opus 4.7 | Adaptive only | Off | `"enabled"` |
| Claude Sonnet 5 | Adaptive only | On | `"enabled"` |
| Claude Opus 4.6 | Adaptive, extended (deprecated) | Off | None |
| Claude Sonnet 4.6 | Adaptive, extended (deprecated) | Off | None |
| Claude Opus 4.5 | Extended only | Off | `"adaptive"` |
| Claude Haiku 4.5 | Extended only | Off | `"adaptive"` |
| Claude Sonnet 4.5 | Extended only | Off | `"adaptive"` |

*Opus 5 accepts `"disabled"` only at effort `high` or below; `xhigh`/`max` + 
disabled → 400.

Exact 400 messages:

- `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.`
- `"thinking.type.disabled" is not supported for this model. Thinking defaults to adaptive mode when not specified; use "thinking.type.enabled" with "budget_tokens" for extended thinking.`
- `adaptive thinking is not supported on this model`
- `` `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified ``

## 3.5 `display`: how thinking is surfaced

`display` works in both modes, set inside the `thinking` object:

- `"summarized"` — returns summary text. Default on Opus 4.6, Sonnet 4.6 and
  earlier.
- `"omitted"` — thinking blocks come back with an **empty `thinking` field**;
  `signature` still populated. Default on Fable 5, Mythos 5, Opus 5, Sonnet 5,
  Opus 4.8, Opus 4.7, Mythos Preview.

```json
{ "content": [
    { "type": "thinking", "thinking": "", "signature": "EosnCkYICxIMMb3LzNrMu..." },
    { "type": "text", "text": "The answer is 12,231." } ] }
```

Key facts: you're billed identically either way — omitting reduces **latency**,
not cost. Its real benefit is faster time-to-first-*text*-token when streaming,
because the server skips streaming thinking tokens entirely. `display` is invalid
with `type: "disabled"`. The `signature` is identical under both values, and
switching `display` between turns is supported. Text you put into an omitted
block's empty `thinking` field on round-trip is **ignored, not rejected** (the
only exception to the modification ban).

On Opus 4.6/Sonnet 4.6 and earlier, the first few lines of summarized thinking
are deliberately more verbose (useful for prompt engineering); Mythos Preview
summarizes from the first token, so no verbose preamble. On Fable 5 and Mythos 5
raw CoT is never returned; the blocks are ordinary `thinking` blocks, not
`redacted_thinking`. On Fable 5, a request that tries to elicit internal
reasoning as response text can be refused with
`stop_details.category: "reasoning_extraction"`.

## 3.6 Streaming thinking

Thinking deltas stream inside `content_block_delta` as `thinking_delta`, followed
by exactly one `signature_delta` immediately before `content_block_stop`:

```
event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "I need to find the GCD of 1071 and 462..."}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "EqQBCgIYAhIM1gbcDa9GJwZA2b..."}}

event: content_block_stop
data: {"type": "content_block_stop", "index": 0}

event: content_block_start
data: {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}
```

With `display: "omitted"` there are **no `thinking_delta` events at all** — the
block opens, one `signature_delta` arrives, the block closes, text begins.

Two practical notes from the docs: reassemble blocks with the SDK accumulator
(`stream.get_final_message()` / `stream.finalMessage()`) rather than concatenating
deltas yourself; and thinking content streams "chunky" (batched) by design.

## 3.7 Preserving thinking blocks

- **Required:** within a tool-use turn, thinking blocks must be passed back
  complete and unmodified alongside the `tool_use` block they accompanied.
- **Recommended:** across turns, pass everything back.
- **Allowed:** outside tool use, omit prior turns' thinking.

Within the latest assistant message the sequence of consecutive `thinking` blocks
must match what the model generated — no rearranging, editing, or partial
dropping, **including `redacted_thinking` blocks**. Filtering on
`block.type == "thinking"` silently drops `redacted_thinking` and breaks the
protocol → 400.

A tool-use loop is **one assistant turn**; you cannot change thinking config
mid-turn. Mid-turn config changes **degrade gracefully**: the API doesn't error,
it silently disables thinking for that request and may strip blocks that would
create an invalid turn structure. Detect by checking whether thinking blocks are
present in the response.

**Preservation by model:**

- Keep all prior turns: Opus 4.5 and later Opus, Sonnet 4.6 and later Sonnet,
  Fable 5, Mythos 5, Mythos Preview.
- Keep last turn only: earlier Opus/Sonnet and **all Haiku through 4.5** — the
  API strips older blocks automatically when you pass them back.

You never need to prune yourself: pass everything, the API filters and bills
input tokens only for blocks actually shown to the model. Override with the
`clear_thinking_20251015` context-editing strategy. **When switching models
mid-conversation, strip `thinking` and `redacted_thinking` from prior turns** —
blocks are tied to the model that produced them; other models silently ignore
them but still bill the input tokens.

## 3.8 Redacted thinking

```json
{ "type": "redacted_thinking", "data": "..." }
```

Encrypted, opaque, no readable text; returned when portions of reasoning are
safety-redacted. Pass back unchanged. Distinct from `display: "omitted"`.

## 3.9 Cost, caching, context window

- Thinking tokens are billed as **output** tokens, always the full internal
  count, never the visible summary count. Summary generation is free.
- `usage.output_tokens_details.thinking_tokens` reports how many billed output
  tokens were reasoning; ≤ `output_tokens`. When streaming this appears **only on
  the final `message_delta` event**.
  ```json
  { "usage": { "input_tokens": 25, "output_tokens": 348,
      "output_tokens_details": { "thinking_tokens": 312 } } }
  ```
- Prior-turn thinking retained in context bills as **input** tokens.
- A specialized system prompt is auto-injected when thinking is active.
- **Any thinking-config change invalidates prompt caching**: switching between
  `adaptive`/`enabled`/`disabled`, changing `budget_tokens`, or changing `effort`.
  The config and resolved effort are rendered into the prompt. Message-level
  breakpoints always miss; tool/system breakpoints may. Setting a parameter
  explicitly to its default ≡ omitting it (no invalidation).
- Thinking blocks are cached with tool results automatically, even without
  `cache_control`, and count as input tokens when read back.
- On last-turn-only models, once a non-tool-result user message arrives, all
  previous thinking blocks are stripped from context.
- Tip: use the 1-hour cache duration for thinking-heavy multistep work, since
  those exceed the 5-minute default.
- Context window: on 4.5+ models, `input + max_tokens > context window` is
  accepted, and generation stops with
  `stop_reason: "model_context_window_exceeded"` rather than erroring; earlier
  models return a validation error.

## 3.10 Compatibility limits

- **Sampling parameters:** on Fable 5, Mythos 5, Mythos Preview, Opus 5, Opus
  4.8, Opus 4.7, Sonnet 5 — non-default `temperature`, `top_p` or `top_k` return
  400 on **every** request regardless of thinking. On older models the
  restriction applies only while thinking is on: `temperature` and `top_k`
  incompatible, `top_p` allowed in 0.95–1.
- **No assistant response prefill** while thinking is on.
- **Forced tool use** (`tool_choice: {"type":"any"}` or `{"type":"tool",...}`)
  is incompatible with *manual* extended thinking (error) but **works with
  adaptive thinking**. Manual mode allows only `auto` or `none`.
- **Output limits:** 128k output tokens on Fable 5, Mythos 5, Mythos Preview,
  Opus 5, Opus 4.8, Opus 4.7, Sonnet 5, Opus 4.6, Sonnet 4.6; 64k on Haiku 4.5,
  Sonnet 4.5, Opus 4.5. Batches API + `output-300k-2026-03-24` header → 300k on
  Opus 5, Opus 4.8, Opus 4.7, Sonnet 5, Opus 4.6, Sonnet 4.6.
- **SDK client-side rule:** streaming required when `max_tokens > 21,333` to
  avoid HTTP timeouts. Not an API restriction.

## 3.11 Interleaved thinking, concretely

Without interleaving, Claude thinks once at the start of the turn and subsequent
post-tool-result responses have no thinking blocks. With interleaving:

```
Response 1: [thinking] "I need to calculate 150 * $50 first..."
            [tool_use: calculator]
  ↓ tool result: "7500"
Response 2: [thinking] "Got $7,500. Now I should query the database to compare..."
            [tool_use: database_query]
  ↓ tool result: "5200"
Response 3: [thinking] "$7,500 vs $5,200 average - that's a 44% increase..."
            [text] "The total revenue is $7,500, which is 44% above..."
```

Docs are careful: consecutive tool calls do **not** require interleaved thinking.
Interleaving changes *where thinking blocks appear*, not whether tool calls can
chain. Interleaved thinking is only supported for tools used through the Messages
API.

## 3.12 Classification and Vela reimplementation

**Classification: MIXED, leaning ANTHROPIC_SERVER_SIDE for the *specific
mechanics*.** Three parts are unreproducible against an arbitrary model and must
be re-architected rather than ported:

1. **Summarization by a second model.** Anthropic never returns raw CoT and pays
   for a separate summarizer. Local reasoning models (DeepSeek-R1 family,
   QwQ/Qwen3-thinking, gpt-oss, Magistral) emit raw CoT in `<think>…</think>` or
   in an OpenAI-style `reasoning_content` field. Vela therefore *has* the raw
   trace and must decide policy, not extraction.
2. **`signature` / encrypted thinking.** Pure server-side crypto with no local
   analogue and no purpose locally: its job is letting a stateless API verify
   that thinking it did not store was genuinely its own.
3. **`redacted_thinking`.** Server-side safety redaction.

### Vela's design

**A. Normalize reasoning from every backend into one internal `thinking` block.**

| Backend | Where reasoning comes from |
|---|---|
| llama.cpp / Ollama / LM Studio / vLLM with a reasoning model | inline `<think>…</think>` (parse and split), or `message.reasoning_content` on OpenAI-compatible endpoints that expose it (vLLM `--reasoning-parser`, Ollama `think`) |
| Anthropic API | native `thinking` / `redacted_thinking` blocks; keep `signature` verbatim |
| OpenAI o-series / GPT-5 | `reasoning` summary items; opaque `reasoning.encrypted_content` when requested |
| Google Gemini | `thought: true` parts, `thoughtSignature` |
| Any non-reasoning model | no thinking block, ever — mirror adaptive's "some turns have none" |

Internal shape, deliberately a superset:
`{type: "thinking", text: string, raw: string|null, opaque: bytes|null,
 provider: string, token_count: int|null}`.
`opaque` carries whatever the provider needs echoed back (Anthropic `signature`,
Gemini `thoughtSignature`, OpenAI `encrypted_content`) and is never interpreted.

**B. Streaming.** Vela's internal event stream reuses the Anthropic shape —
`content_block_start(thinking)` → `thinking_delta`* → optional `signature_delta`
→ `content_block_stop` — because it is the cleanest existing contract and lets
one renderer serve all backends. For a local model emitting `<think>`, the
adapter is a streaming state machine on the token stream: on `<think>` open a
thinking block, on `</think>` close it and open a text block. Handle the
pathological cases explicitly: model never emits `</think>` (timeout →
close block, mark truncated), model emits `<think>` mid-text, and models that
open the tag implicitly (some R1 distills start *inside* the reasoning channel).

**C. The `display` control, reproduced faithfully and improved.**
- `omitted` — do not render thinking. Locally this saves **rendering** cost, not
  streaming cost, since the tokens are generated on the user's own GPU either
  way. Vela should say so honestly in the UI rather than implying a saving.
- `summarized` — Vela can offer a genuine local summarizer: run a small fast
  model (or the same model at low effort) over the raw trace. Optional and off by
  default, since it doubles compute.
- `raw` — **a value Anthropic cannot offer and Vela can.** Show the actual chain
  of thought, collapsed by default with a token count and a duration, expandable.
  This is a real differentiator for a local-first app and should be the default
  for local backends.

**D. Budgets and effort against arbitrary backends.**
- Implement **both** control surfaces, since the model zoo needs both:
  - `effort: low|medium|high|xhigh|max` as the user-facing knob, mapped per
    backend: Anthropic → `output_config.effort`; OpenAI → `reasoning.effort`;
    Gemini → `thinkingConfig.thinkingBudget`; local models → prompt-level
    steering plus the mechanisms below.
  - `budget_tokens` as the mechanical enforcement for local models, where Vela
    controls sampling directly. Enforce it three ways: (i) a **logit bias /
    grammar constraint** that raises the probability of `</think>` as the budget
    is approached; (ii) a hard **stop-token injection** — append `</think>` to
    the KV cache and continue generation when the budget is hit, which is exactly
    the "budget forcing" technique and is only possible because Vela owns the
    sampler; (iii) as a last resort, truncate. Keep Anthropic's "budget is a
    target, `max_tokens` is the cap" semantics.
- Reproduce the validation rules that models were trained against, since they
  leak into behaviour: min 1,024; `budget_tokens < max_tokens` unless
  interleaved.
- Prompt-level steering exactly as Anthropic documents it, because it works on
  every model: system-prompt guidance ("Extended thinking adds latency and should
  only be used when it will meaningfully improve answer quality…" / "This task
  involves multistep reasoning. Think carefully before responding.") and
  per-message suffixes ("Please think hard before responding." /
  "Answer directly without deliberating."). Vela's agent harness should append
  these automatically on planning vs routine steps — the docs describe precisely
  this pattern.

**E. Round-trip rules.** Vela must implement per-backend preservation policy,
because the rules differ and getting them wrong is a 400 or a silent quality loss:
- Anthropic backend: echo assistant turns **verbatim**, never rebuild them, never
  filter by `block.type == "thinking"` (that drops `redacted_thinking`). Keep
  `signature` and `data` byte-identical.
- Local backend: reasoning is not verifiable, so Vela chooses. Default: **strip
  prior-turn thinking on the next user turn, keep it within a tool-use turn** —
  i.e. replicate the "keep last turn only" regime, which is right for small
  context windows. Make it configurable to "keep all" for long agentic sessions
  on large-context models.
- **On model switch, always strip thinking blocks from prior turns** — Anthropic
  documents that other models ignore them but still pay input tokens. In a
  model-agnostic app where switching backends mid-conversation is a headline
  feature, this rule must be enforced automatically, not left to the user.

**F. Turn-structure validation.** Adopt adaptive's relaxed rule as Vela's own
invariant: **never require an assistant turn to begin with a thinking block**,
and never assume one exists. This makes mixed histories (assembled from different
backends, or resumed after a model switch) valid without rewriting, which is
exactly the property a model-agnostic app needs. Also copy graceful degradation:
if the history is incompatible with thinking, disable thinking for that request
rather than erroring.

**G. Accounting.** Expose `thinking_tokens` in Vela's own usage record and
surface it in the UI, computed locally by counting tokens between the `<think>`
delimiters. For local models the "cost" is wall-clock and watts rather than
dollars, so Vela should show **seconds spent thinking** alongside token count —
the metric that actually matters on a laptop.

**H. Caching.** Vela's equivalent of prompt caching is the **KV cache** of the
local runtime (llama.cpp prompt reuse / `--cache-reuse`, vLLM prefix caching).
The Anthropic lesson transfers exactly: anything rendered into the prompt prefix
invalidates it. So Vela must keep thinking-mode/effort text (if it injects any
system-prompt text for steering) **at the end** of the system prompt or, better,
in the newest user message — per-message steering leaves earlier prefix intact,
which is precisely the trick the docs recommend. This is a concrete, actionable
design constraint for Vela's prompt assembler.

**I. Interleaved thinking.** No header, no flag: Vela's agent loop simply permits
a thinking block at the start of every assistant response within a tool-use turn,
which is the default for reasoning models anyway. The only work is making sure
the `<think>` parser is armed on *every* continuation, not just the first
response of a turn.

---

# Cross-cutting summary for the Vela engineer

Three things Vela must build that have no shortcut:

1. **A local sandbox with the bundled Python document stack.** Docker/Podman
   preferred, Seatbelt/bubblewrap fallback, `--network none` default, 5 GiB
   quotas, and the exact library list from §1.1. Without this there is no code
   execution, no file creation, no data analysis, and no skills.
2. **A local blob store + ingestion pipeline** replacing the Files API, with
   conversation scoping (fixing Anthropic's documented workspace-wide leak) and
   Vela-side extraction (PDF/Office/OCR) because arbitrary models cannot ingest
   binary formats.
3. **A reasoning normalizer** turning `<think>` tags, `reasoning_content`,
   Anthropic `thinking` blocks and Gemini `thought` parts into one internal
   block type, with an opaque passthrough field, a streaming state machine, and
   per-backend round-trip policy — plus sampler-level budget forcing, which is
   the one thing Vela can do that the hosted API cannot.

Two things Vela should deliberately *not* copy:

- The upload-is-not-downloadable asymmetry and workspace-wide file scoping.
- `signature`/encrypted-thinking machinery: it solves a stateless-server
  verification problem Vela does not have.

One thing Vela must add that Anthropic gets for free:

- **Prompt-injection defense without a server-side classifier.** Network-off
  default, a visible action log, hard kill, and taint-tracking on content that
  entered context from web/file sources.
