# Vela Spec Part — Agent Skills & Plugins

Ingestion notes for the Agent Skills format, progressive disclosure, skill scoping/discovery,
and the plugin + marketplace bundle format. Every claim below is traced to a page that was
actually fetched during this pass. Nothing here is reconstructed from memory.

**Target:** Vela is a model-agnostic desktop app. The brain is swappable (local llama.cpp /
Ollama / LM Studio / vLLM, any third-party API key, or a subscription provider). Everything in
this document must therefore be reimplemented **in the Vela harness process**, not in the model.
That is mostly good news: skills and plugins are overwhelmingly a *harness* feature, not a
*model* feature. The model only ever sees text.

---

## Sources fetched (all successfully retrieved)

| URL | What it gave |
| --- | --- |
| https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview | Skill concept, 3-level progressive disclosure table, frontmatter validation rules, surface matrix, runtime constraints, security model |
| https://code.claude.com/docs/en/skills | The full Claude Code skill reference: every frontmatter field, skill locations & precedence, command naming, string substitutions, dynamic context injection, `context: fork`, `allowed-tools`, skill content lifecycle, `skillOverrides`, listing budget |
| https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices | Authoring guidance: description writing, degrees of freedom, progressive disclosure patterns, workflows/feedback loops, script guidance, eval format |
| https://code.claude.com/docs/en/plugins-reference | Complete `plugin.json` schema, component types, path behavior rules, env vars, persistent data dir, plugin cache, node dep install, CLI commands |
| https://code.claude.com/docs/en/plugin-marketplaces | Complete `marketplace.json` schema, plugin entries, all source types, `strict` mode, reserved names, managed restrictions |
| https://code.claude.com/docs/en/discover-plugins | Install/discovery UX, `/plugin` tabs, scopes, auto-update, `extraKnownMarketplaces`, reload semantics |
| https://agentskills.io | The open standard's overview + progressive disclosure definition + client showcase (proof of portability) |
| https://agentskills.io/specification | **The authoritative open spec**: 6 frontmatter fields with exact constraints, directory conventions, file-reference rules, `skills-ref validate` |
| https://platform.claude.com/docs/en/build-with-claude/skills-guide | Skills API: `/v1/skills` endpoints, zip upload, versioning, `container.skills` shape, beta headers, limits |
| https://support.claude.com/en/articles/12512176-what-are-skills | Consumer-app skills: Customize > Skills, skill categories, plan availability, code-execution requirement |
| https://support.claude.com/en/articles/12512198-creating-custom-skills | claude.ai/Desktop zip upload flow, folder-root requirement, runtime, restrictions |
| https://code.claude.com/docs/en/desktop | Desktop app: `+` menu → Skills/Plugins, plugin browser, Customize sidebar syncs via claude.ai account (not `~/.claude`) |
| https://github.com/anthropics/skills | Open-source skills repo layout (`skills/`, `spec/`, `template/`, `.claude-plugin/`) and install commands |

No source in scope was unreachable.

---

## 1. The Agent Skills open standard (agentskills.io/specification)

This is the load-bearing document for Vela, because **the standard is deliberately vendor-neutral
and already implemented by ~40 non-Anthropic clients** (Gemini CLI, OpenCode, Cursor, Goose,
Copilot/VS Code, Codex, Roo Code, Letta, Mistral Vibe, Hermes Agent, OpenClaw, nanobot, and
others listed in the agentskills.io client showcase). Vela implementing this standard means Vela
inherits an existing ecosystem of skills for free, with **zero Anthropic dependency**.

### Directory structure (normative)

```
skill-name/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
├── assets/           # Optional: templates, resources
└── ...               # Any additional files or directories
```

### Frontmatter — the complete spec table, verbatim

| Field | Required | Constraints |
| --- | --- | --- |
| `name` | Yes | Max 64 characters. Lowercase letters, numbers, and hyphens only. Must not start or end with a hyphen. |
| `description` | Yes | Max 1024 characters. Non-empty. Describes what the skill does and when to use it. |
| `license` | No | License name or reference to a bundled license file. |
| `compatibility` | No | Max 500 characters. Indicates environment requirements (intended product, system packages, network access, etc.). |
| `metadata` | No | Arbitrary key-value mapping for additional metadata (a map from string keys to string values). |
| `allowed-tools` | No | Space-separated string of pre-approved tools the skill may use. (Experimental) |

Additional `name` rules spelled out in the spec:
- Must be 1–64 characters
- Only unicode lowercase alphanumerics (`a-z`, `0-9`) and hyphens (`-`)
- Must not start or end with a hyphen
- **Must not contain consecutive hyphens (`--`)**
- **Must match the parent directory name**

The platform docs add two Anthropic-specific validations on top of the open spec: `name` cannot
contain XML tags and cannot contain the reserved words "anthropic" or "claude"; `description`
cannot contain XML tags. Vela should not inherit the reserved-word rule (it is brand protection,
not a technical constraint) but **should** inherit the XML-tag rejection, since skill metadata is
injected into a system prompt and XML tags are a prompt-injection vector.

`allowed-tools` example from the spec: `allowed-tools: Bash(git:*) Bash(jq:*) Read`

### Progressive disclosure — the three stages (normative, from the spec)

1. **Metadata** (~100 tokens): `name` and `description` loaded at startup for *all* skills
2. **Instructions** (< 5000 tokens recommended): full `SKILL.md` body loaded when the skill activates
3. **Resources** (as needed): files in `scripts/`, `references/`, `assets/` loaded only when required

Keep `SKILL.md` under 500 lines. File references should be **one level deep** from `SKILL.md` —
the best-practices page explains why: when references are nested, the agent tends to preview with
`head -100` rather than reading whole files, producing incomplete information.

### Validation tooling

`skills-ref validate ./my-skill` — reference library at
`github.com/agentskills/agentskills/tree/main/skills-ref`. Vela should ship an equivalent
validator (or vendor this one) so authors get the same errors.

### Vela implementation

Implement the open spec **exactly**, byte-for-byte on frontmatter validation. A `SKILL.md`
authored for Cursor or Goose must load in Vela unchanged, and a Vela skill must load elsewhere.
This is the single highest-leverage compatibility decision in this area: it is a pure
client-side file format with no server component whatsoever.

---

## 2. Progressive disclosure mechanics (the actual machinery)

From the platform overview, the cost model is explicit:

| Level | When loaded | Token cost | Content |
| --- | --- | --- | --- |
| Level 1: Metadata | Always (at startup) | ~100 tokens per Skill | `name` and `description` from YAML frontmatter |
| Level 2: Instructions | When Skill is triggered | Under 5k tokens | SKILL.md body with instructions and guidance |
| Level 3+: Resources | As needed | None until accessed | Bundled files. Reference files load into context when read. Scripts run through bash, and only their output enters context |

The mechanism, stated plainly by the overview: *"When a Skill is triggered, Claude uses bash to
read SKILL.md from the filesystem, bringing its instructions into the context window."* Scripts
are **executed**, never read — "the script's code never loads into the context window. Only its
output ... consumes tokens."

The worked trace from the overview:
1. Startup: system prompt includes `pdf-processing - Extract text and tables from PDF files, ...`
2. User: "Extract the text from this PDF and summarize it"
3. Claude invokes `bash: cat pdf-processing/SKILL.md` → instructions loaded
4. Claude determines FORMS.md is not needed → not read
5. Claude executes using SKILL.md instructions

**This is 100% client-side.** There is no server-side skill matcher. The "matching" is the model
reading a list of names+descriptions in its system prompt and deciding. That works with any model.

### Vela implementation

- **Skill registry**: at session start Vela walks its skill roots, parses every `SKILL.md`
  frontmatter (YAML front-matter parse only — never read the body at startup), and builds an
  in-memory index of `{name, description, when_to_use, path, source, scope}`.
- **Listing injection**: render the index into the system prompt as a compact block. Claude Code
  budgets this at **1% of the model's context window** by default (setting
  `skillListingBudgetFraction`, env `SLASH_COMMAND_TOOL_CHAR_BUDGET` for a fixed char count), and
  caps each entry's combined `description` + `when_to_use` at **1,536 characters**
  (`skillListingMaxDescChars`). When the listing overflows, descriptions are dropped **starting
  with the least-invoked skills**, so frequently used skills keep their full text; names are always
  kept. Vela must implement the same budget-with-usage-ranking, and it matters *more* for Vela than
  for Claude Code because a local 8k- or 32k-context model has a tiny absolute budget. Vela should
  compute the budget from the *configured* context length of whatever backend is active, and
  degrade to name-only listings automatically on small-context models.
- **Loading**: expose a `Skill` tool (name + optional arguments). On call, Vela reads the file,
  renders substitutions, and injects the rendered body as a message. Do **not** make the model
  `cat` the file — a first-class tool is more reliable across weak models, and it gives Vela the
  hook point for permissions and lifecycle.
- **Weak-model fallback**: small local models are bad at spontaneous tool selection. Vela should
  offer a per-skill "eager" mode where a skill whose `paths` glob matches the files in play, or
  whose description embeds-matches the user turn above a threshold, is auto-injected. A local
  embedding model (e.g. bge-small via ONNX runtime, ~30MB) over skill descriptions is a cheap,
  fully-offline retrieval layer that compensates for weak instruction-following. Keep it optional
  and off for strong models.

---

## 3. Skill scopes, discovery, and precedence (Claude Code semantics)

From code.claude.com/docs/en/skills:

| Location | Path | Applies to |
| --- | --- | --- |
| Enterprise | See managed settings | All users in your organization |
| Personal | `~/.claude/skills/<skill-name>/SKILL.md` | All your projects |
| Project | `.claude/skills/<skill-name>/SKILL.md` | This project only |
| Plugin | `<plugin>/skills/<skill-name>/SKILL.md` | Where plugin is enabled |

Precedence rules, verbatim in substance:
- Same name across levels: **enterprise overrides personal, and personal overrides project**.
- A skill at any of these levels **overrides a bundled skill** with the same name (a project
  `code-review` replaces the bundled `/code-review`).
- Plugin skills use a `plugin-name:skill-name` namespace, so they cannot conflict.
- `.claude/commands/*.md` files work the same way, but **if a skill and a command share a name,
  the skill wins**.

Discovery details worth copying:
- Project skills load from `.claude/skills/` in the start directory **and every parent directory
  up to the repo root**.
- **Nested** `.claude/skills/` below the start dir are *not* loaded at startup. They load the
  first time the agent reads or edits a file in that subtree, and stay available for the session.
  On a name clash the nested one appears as a **directory-qualified name**, e.g. `apps/web:deploy`,
  and its description states which directory it applies to. Invoking the unqualified `/deploy`
  runs the project-root one and appends a list of qualified variants with an instruction to also
  invoke any variant whose directory holds the files in play.
- `--add-dir` / `/add-dir` are an explicit **exception** to the "additional directories grant file
  access, not configuration" rule: `.claude/skills/` inside an added directory *is* loaded. The
  `permissions.additionalDirectories` setting is not — it grants file access only.
- **Live change detection**: skill directories are watched. Add/edit/remove a `SKILL.md` under
  `~/.claude/skills/`, the project `.claude/skills/`, or an `--add-dir` directory and the change
  is picked up mid-session with no restart. Creating a *new top-level* skills directory that
  didn't exist at startup requires a restart. Live detection covers `SKILL.md` text only — for a
  skill folder that is also a plugin, changes to `hooks/`, `.mcp.json`, `agents/`,
  `output-styles/` need `/reload-plugins`.
- A `<skill-name>` entry may be a **symlink** to a directory elsewhere; the link is followed and
  `SKILL.md` read from the target. If the same target is reachable from more than one location it
  loads once.
- The folder name `synced` is **reserved** in enterprise/personal/project locations, in any
  capitalization — it's where claude.ai-synced skills land.

### Vela implementation

Reproduce the whole model with Vela-local paths, and add one scope Claude Code doesn't have:

| Vela scope | Path | Notes |
| --- | --- | --- |
| Managed | `/etc/vela/skills/` (POSIX) / `%PROGRAMDATA%\Vela\skills\` | For orgs deploying Vela; optional |
| Personal | `~/.vela/skills/<name>/SKILL.md` | |
| Project | `<project>/.vela/skills/<name>/SKILL.md` | |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | namespaced `plugin:skill` |
| **Compat** | `~/.claude/skills/`, `<project>/.claude/skills/`, `.github/skills/`, `.agent/skills/` | read-only import so existing skills work day one |

The compat scope is a differentiator and costs almost nothing: the format is identical, only the
directory differs. Vela should scan a configurable list of "foreign skill roots" and surface them
in the UI marked with their origin. Use `fsnotify`/`chokidar`-class watchers for live detection,
debounced ~200ms, re-parsing frontmatter only.

Precedence: implement exactly the documented order (managed > personal > project, plugin
namespaced, skill beats command). Store the resolved registry with the losing entries retained so
the UI can show "shadowed by ~/.vela/skills/deploy".

---

## 4. SKILL.md frontmatter — the full Claude Code superset

The open spec allows six fields. Claude Code accepts a much larger superset. Vela should accept
the superset **in its own scopes** while validating strictly against the six-field spec when
exporting/packaging for portability. The Claude Code table, reproduced with mechanics:

| Field | Required | Behavior |
| --- | --- | --- |
| `name` | No | Display name in listings. Defaults to the directory name. In personal/project skills, `name` sets only the *display label* — the invocation command still comes from the directory/file name. In a **plugin** skill, `name` sets the last segment of the command and the plugin prefix stays. |
| `description` | Recommended | What it does and when to use it. If omitted, the first paragraph of the body is used. Combined `description` + `when_to_use` truncated at 1,536 chars in the listing. |
| `when_to_use` | No | Extra trigger phrases / example requests. Appended to `description` in the listing, counts toward the 1,536 cap. |
| `argument-hint` | No | Autocomplete hint, e.g. `[issue-number]` or `[filename] [format]`. |
| `arguments` | No | Named positional arguments enabling `$name` substitution. Space-separated string or YAML list; names map to positions in order. |
| `disable-model-invocation` | No | `true` = model can't auto-load it; only the user can invoke. Also prevents preloading into subagents and prevents a scheduled task firing it. Default `false`. |
| `user-invocable` | No | `false` = hidden from the `/` menu; only the model can invoke. Default `true`. |
| `allowed-tools` | No | Tools usable **without a permission prompt during the turn that invoked the skill**. Grant clears on the next user message. Space/comma-separated string or YAML list. Does **not** restrict — everything else stays callable under normal permission settings. |
| `disallowed-tools` | No | Tools *removed from the pool* while the skill is active. Clears on next user message. Can't remove `EndConversation` while any other tool remains. |
| `model` | No | Model for the rest of the current turn; not persisted. Accepts `/model` values or `inherit`. With `context: fork`, sets the forked subagent's model instead. |
| `effort` | No | `low`/`medium`/`high`/`xhigh`/`max`, overrides session effort. |
| `context` | No | `fork` → run in a forked subagent context. |
| `agent` | No | Which subagent type when `context: fork` (built-ins `Explore`, `Plan`, `general-purpose`, or a custom one). Defaults to `general-purpose`. |
| `background` | No | Only with `context: fork`. `false` = block the invoking turn for the result instead of backgrounding. Default `true`. |
| `hooks` | No | Hooks scoped to this skill's lifecycle. |
| `paths` | No | Glob patterns limiting *automatic* activation to work touching matching files. Comma-separated string or YAML list. |
| `shell` | No | `bash` (default) or `powershell` — which shell runs `` !`cmd` `` injections. |
| `metadata` | No | Free-form YAML map for your own tooling. Non-map values are dropped. |
| `license` | No | Part of the open spec; accepted but not acted on. |
| `compatibility` | No | Part of the open spec; string ≤500 chars; accepted but not acted on. |

**All fields are optional; only `description` is recommended.** Booleans accept
`yes`/`no`/`on`/`off`/`1`/`0` in any case, in addition to `true`/`false`.

### The portability constraint (important for Vela)

Claude Code documents an explicit split:

| Distribution path | Frontmatter fields allowed |
| --- | --- |
| Claude Code skills at any level, including plugin skills | Every field above |
| claude.ai skill uploads, the Skills API, and `package_skill.py` from anthropics/skills | `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools` |

Including a disallowed field makes packaging/upload **fail with a hard error**, e.g.:

```
Unexpected key(s) in SKILL.md frontmatter: argument-hint. Allowed properties are: allowed-tools, compatibility, description, license, metadata, name
```

### Vela implementation

Accept the full superset. Add a `vela validate --portable` mode that enforces the six-field spec
and reports which extension fields would break portability, with the same error shape. Two fields
need real engineering, the rest are trivial config:
- `hooks` → requires Vela's hook system (covered by the hooks spec part).
- `context: fork` → requires Vela's subagent system.
Everything else (`model`, `effort`, `paths`, `allowed-tools`, `disallowed-tools`,
`disable-model-invocation`, `user-invocable`) is harness bookkeeping around a text injection and
is fully model-agnostic. Note `model` is where Vela's model-agnosticism has to be smarter: instead
of Anthropic model IDs, Vela's `model` field should accept a **backend profile alias** the user
defines (`fast-local`, `big-cloud`, `ollama:qwen3-coder:30b`), plus `inherit`. Ship a mapping so
a skill written with `model: haiku` resolves via a user-editable alias table to whatever they've
designated as their small/fast model, rather than erroring.

---

## 5. Command naming, arguments, and string substitution

### How a skill gets its command name

| Skill location | Command name source | Example |
| --- | --- | --- |
| Directory under `~/.claude/skills/` or `.claude/skills/` | Directory name | `.claude/skills/deploy-staging/SKILL.md` → `/deploy-staging` |
| Nested `.claude/skills/`, when the name clashes | Subdirectory path relative to cwd, then skill dir name | `apps/web/.claude/skills/deploy/SKILL.md` → `/apps/web:deploy` |
| File under `.claude/commands/` | File name without extension | `.claude/commands/deploy.md` → `/deploy` |
| Plugin `skills/` subdirectory | Frontmatter `name` or directory name, namespaced by plugin | `my-plugin/skills/review/SKILL.md` → `/my-plugin:review`, or `/my-plugin:fancy` with `name: fancy` |
| Plugin root `SKILL.md` | Frontmatter `name`, plugin directory name as fallback | `my-plugin/SKILL.md` with `name: review` → `/my-plugin:review` |

A plugin skill's bare `/fancy` also works unless another command already claims that name.

### Substitutions

| Variable | Meaning |
| --- | --- |
| `$ARGUMENTS` | All arguments as typed. If absent from the body, arguments are appended as `ARGUMENTS: <value>`. |
| `$ARGUMENTS[N]` | 0-based positional argument |
| `$N` | Shorthand for `$ARGUMENTS[N]` |
| `$name` | Named argument declared in the `arguments` frontmatter list, mapped by position |
| `${CLAUDE_SESSION_ID}` | Current session ID |
| `${CLAUDE_EFFORT}` | Current effort level |
| `${CLAUDE_SKILL_DIR}` | Directory containing this `SKILL.md` (for plugin skills, the skill subdir, not the plugin root) |
| `${CLAUDE_PROJECT_DIR}` | Project root |
| `${CLAUDE_PLUGIN_ROOT}` | Plugin install directory (plugin skills only) |
| `${CLAUDE_PLUGIN_DATA}` | Plugin persistent data directory (plugin skills only) |

Quoting/escaping rules: indexed arguments use **shell-style quoting**, so
`/my-skill "hello world" second` gives `$0` = `hello world`, `$1` = `second`. `$ARGUMENTS` always
expands to the full raw string. An indexed placeholder with no matching argument (`$2` when one
argument was passed) is **left unchanged**; a *named* placeholder with no match expands to the
**empty string**. Escape a literal `$` before a digit / `ARGUMENTS` / a declared name with a
backslash: `\$1.00`. A backslash before any other `$` is left as-is. Doubling (`\\$1`) leaves both
backslashes and still expands. The escape does **not** apply to `${CLAUDE_*}` variables.

`${CLAUDE_SKILL_DIR}` and `${CLAUDE_PROJECT_DIR}` are substituted in **two** places: the skill
body **and Bash rules inside `allowed-tools`**. That's the key trick for prompt-free script
execution — the canonical example:

```yaml
---
name: render-chart
description: Render a chart from a CSV file
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)
---

Run `${CLAUDE_SKILL_DIR}/scripts/render.sh <csv-file>` to render the chart.
```

Both occurrences expand to the same absolute path, so the allow rule matches exactly the command
the body tells the model to run.

### Skill stacking

Several skills can be stacked at the start of one message: `/write-tests /fix-issue 123` loads
both and passes `123` as `$ARGUMENTS` to each. The first skill plus **up to five more** are
expanded. Expansion stops at the first token that isn't an inline user-invocable skill — a forked
skill (e.g. `/code-review`) or one whose arguments may start with a slash (e.g. `/loop`) ends the
run there, and that token plus everything after becomes the argument text for every expanded skill.

### Vela implementation

Rename the namespace: `${VELA_SKILL_DIR}`, `${VELA_PROJECT_DIR}`, `${VELA_PLUGIN_ROOT}`,
`${VELA_PLUGIN_DATA}`, `${VELA_SESSION_ID}`, `${VELA_EFFORT}` — **and alias every `CLAUDE_*` name
to its Vela equivalent** so imported skills work unmodified. This is a five-line substitution
table and buys full compatibility with the existing skill corpus. Implement the escape and
quoting rules literally; they are the kind of detail that silently corrupts skills if approximated.
Use a proper shell-words splitter (`shlex`-equivalent) for indexed arguments.

---

## 6. Dynamic context injection (`` !`command` ``) — the biggest Vela win

Syntax: `` !`<command>` `` inline, or a fenced block opened with ```` ```! ```` for multi-line.
The command runs **before the skill content reaches the model**; its output replaces the
placeholder. Quoting from the docs: *"This is preprocessing, not something Claude executes. Claude
only sees the final result."*

Mechanics that matter:
- Substitution runs **once over the original file**. Output is inserted as plain text and is
  **not re-scanned**, so a command cannot emit a placeholder for a later pass. (Injection defense.)
- The inline form is only recognized when `!` is at line start or immediately after whitespace.
  `KEY=!`cmd`` is left as literal text and does not run.
- Commands run through the Bash tool (or PowerShell tool when `shell: powershell` and the
  PowerShell tool is enabled). `shell: bash` on a machine without bash **fails the invocation
  before any command runs**.
- **Working directory** = the session shell's cwd, which moves when the agent runs `cd`. Hence the
  advice to use `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PROJECT_DIR}` for stable paths.
- **stderr is merged into stdout** under the default bash shell.
- **Timeout**: the Bash tool's default 2-minute timeout. If the command is auto-backgrounded, the
  skill still renders and the injected text reports the move plus the background task name and
  output file. If it's a command that never auto-backgrounds, it's killed and the invocation aborts.
- **Output size**: output past the inline ceiling arrives as a file path plus a short preview.
- **Failure aborts the whole invocation**, not just that placeholder — the model never sees the
  skill content for that invocation. Error shown as `Shell command failed for pattern "..."` with
  the output under `[stderr]`. Any non-zero exit is a failure, with one carveout: **exit code 1
  from search/comparison commands** (grep, diff, etc.) is treated as a normal result and its
  output injected; exit ≥2 fails even for those. Under `shell: powershell` the carveout set is
  different (includes `grep` and `git diff`, excludes `find` and `diff`). Advice: append `|| true`.
- **Injected commands never prompt for permission.** If the permission check returns anything
  other than allow — *including a rule that would normally ask* — the invocation aborts with
  `Shell command permission check failed for pattern "..."`. Pre-approve with `allowed-tools`;
  a matching ask-or-deny rule aborts regardless.
- Kill switch: `"disableSkillShellExecution": true` in settings replaces each command with
  `[shell command execution disabled by policy]` for user/project/plugin/additional-directory
  skills. Bundled and managed skills are exempt. Intended for managed settings.

### Vela implementation

This is **entirely client-side, zero model involvement, and disproportionately valuable for weak
local models** — it converts "ask the model to go find out X" into "hand the model X". A 7B model
that would fumble a multi-step `git diff` → read → summarize flow does fine when the diff is
already in the prompt. Vela should implement this faithfully, including:
- single-pass, no re-scan (security-critical: prevents an injected command's *output* from
  smuggling further command execution)
- the line-start/whitespace-only recognition rule
- merged stderr, 2-minute default timeout with configurable override, output ceiling with
  spill-to-file
- fail-closed abort semantics with the exit-1 search-command carveout
- pre-flight permission evaluation that aborts rather than prompts
- a `disableSkillShellExecution` equivalent, honored from a Vela managed-policy file
Cross-platform: Vela ships on Windows too, so implement the `shell: bash|powershell` split with
the same "bash requested but unavailable → hard fail with a clear message" behavior.

---

## 7. Skill content lifecycle and context management

- When a skill is invoked, **the rendered `SKILL.md` content enters the conversation as a single
  message and stays there for the rest of the session.** The file is **not re-read** on later
  turns — so guidance meant to apply throughout must be written as standing instructions.
- The persistence applies to *instructions*, not permissions: an `allowed-tools` grant clears on
  the next user message; re-invoking re-applies it for that turn.
- **Re-invocation dedup**: if the re-rendered content is byte-identical to the copy already in
  context, a short "already loaded" note is added instead of a second copy. If it differs (changed
  arguments, or a `` !`cmd` `` produced new output), the full content is appended again.
- **Auto-compaction carry-forward**: when the conversation is summarized, the most recent
  invocation of each skill is **re-attached after the summary**, keeping the **first 5,000 tokens**
  of each, under a **combined 25,000-token budget**, filled starting from the most recently
  invoked skill. Older skills can be dropped entirely if many were invoked.

### Vela implementation

Copy this design; it is a well-tuned answer to a real problem and is model-independent. Two
adjustments for local models:
- The 5,000/25,000 constants assume a ≥200k context. Vela should express them as **fractions of
  the active backend's context window** (e.g. per-skill cap = min(5000, 2.5% of ctx); total = min(25000, 12% of ctx)),
  with the absolutes as ceilings.
- Add an explicit "unload skill" affordance (Claude Code has none). On a 32k-context local model,
  a stale 4k-token skill sitting in context for the rest of the session is expensive. Vela's
  session view should list loaded skills with token costs and let the user evict one, rewriting
  the message as a one-line stub.

---

## 8. Invocation control and permissions

Three-way matrix, verbatim from the docs:

| Frontmatter | You can invoke | Claude can invoke | When loaded into context |
| --- | --- | --- | --- |
| (default) | Yes | Yes | Description always in context, full skill loads when invoked |
| `disable-model-invocation: true` | Yes | No | **Description not in context**, full skill loads when you invoke |
| `user-invocable: false` | No | Yes | Description always in context, full skill loads when invoked |

`disable-model-invocation` therefore doubles as a **context-cost control**: it removes the skill
from the listing entirely. If the model tries anyway, the call is blocked and the model is
instructed not to reproduce the steps another way.

Note the subtlety the docs call out: *"The `user-invocable` field only controls menu visibility,
not Skill tool access. Use `disable-model-invocation: true` to block programmatic invocation."*

Permission-rule control over skills:
- Deny the whole `Skill` tool to disable all skills.
- `Skill(commit)` for exact match; `Skill(review-pr *)` for prefix-with-arguments match. Allow and
  deny rules both supported.
- Subagents with preloaded skills behave differently: **full skill content is injected at startup**
  rather than description-only.

`skillOverrides` in settings controls visibility without editing the skill (useful for skills
checked into a shared repo). Four states:

| Value | Listed to the model | In `/` menu |
| --- | --- | --- |
| `"on"` | Name and description | Yes |
| `"name-only"` | Name only | Yes |
| `"user-invocable-only"` | Hidden | Yes |
| `"off"` | Hidden | Hidden |

```json
{
  "skillOverrides": {
    "legacy-context": "name-only",
    "deploy": "off"
  }
}
```

Absent = `"on"`. Plugin skills are **not** affected by `skillOverrides` (manage those via
`/plugin`). `"off"` also hides the skill from Remote Control clients and SDK callers; invoking a
hidden skill by full name returns the override error.

Trust gate: for skills checked into a project's `.claude/skills/`, `allowed-tools` takes effect
only **after the workspace trust dialog is accepted**, the same as permission rules in
`.claude/settings.json`. *"Review project skills before trusting a repository, since a skill can
grant itself broad tool access."*

### Vela implementation

All client-side. Implement `Skill(name)` / `Skill(name *)` permission rules, the four-state
override map in Vela's settings, and — critically — **the workspace trust gate**. Vela is a
desktop app that users will point at cloned repos; a project `SKILL.md` with
`allowed-tools: Bash(*)` is a remote-code-execution primitive. Vela's trust dialog must enumerate
what a repo's skills would grant (list every `allowed-tools` rule across project skills) before
the user accepts, which is stronger than the current Claude Code dialog and cheap to build.

---

## 9. Skills running as subagents (`context: fork`)

- `context: fork` runs the skill in an isolated subagent context; **the skill content becomes the
  subagent's prompt**, and it has no access to conversation history.
- Runs in the **background** by default: the user keeps working and the result arrives when
  complete. `background: false` blocks the invoking turn instead.
- Forced to wait regardless of `background` in: non-interactive/`-p`/SDK mode; when
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`; when an earlier invocation of the same forked skill is
  still running; when a scheduled task fires with the skill as its prompt.
- A backgrounded fork runs with the **narrower background-subagent tool set**; if the skill needs a
  tool outside it, set `background: false`.
- A backgrounded fork applies edits **outside session checkpoints**, so `/rewind` won't undo them —
  use git.
- Warning from the docs: `context: fork` *"only makes sense for skills with explicit instructions"*.
  A guidelines-only skill forked into a subagent gets guidance and no task, and returns nothing useful.

Two directions of skill/subagent interaction:

| Approach | System prompt | Task | Also loads |
| --- | --- | --- | --- |
| Skill with `context: fork` | From agent type | SKILL.md content | CLAUDE.md, except when the agent is Explore or Plan |
| Subagent with `skills` field | Subagent's markdown body | Claude's delegation message | Preloaded skills + CLAUDE.md |

### Vela implementation

Requires Vela's subagent runtime; the skill side is just "route this rendered text to a subagent
of type X instead of the main loop." Model-agnostic. Note this is where Vela's multi-backend story
shines: a forked skill can specify a *different, cheaper* backend (`model: fast-local`) so
background exploration runs on a local 7B while the main loop uses a frontier API model. That's a
capability Claude Code structurally cannot offer.

---

## 10. Skill authoring guidance worth encoding in Vela's tooling

From the best-practices page — these are the rules Vela's skill-creator/validator should check:

- **Concise is key.** "The context window is a public good." Only add context the model doesn't
  already have. The doc contrasts a ~50-token good example against a ~150-token verbose one.
- **Degrees of freedom must match task fragility.** High freedom (prose instructions) when many
  approaches are valid; medium (parameterized scripts/pseudocode) when a preferred pattern exists;
  low (exact scripts, "Do not modify the command or add additional flags") when operations are
  fragile. Analogy: narrow bridge with cliffs vs. open field.
- **Descriptions in third person, always.** "Processes Excel files and generates reports", never
  "I can help you..." or "You can use this to...". The description is injected into the system
  prompt and inconsistent POV causes discovery problems.
- **Naming**: gerund form preferred (`processing-pdfs`, `analyzing-spreadsheets`); noun phrases and
  action forms acceptable; avoid `helper`, `utils`, `tools`, `documents`, `data`, `files`.
- **One level deep references.** Nested reference chains cause partial reads.
- **Reference files >100 lines need a table of contents** at the top so partial previews still show
  the full scope.
- **No Windows-style paths** — forward slashes everywhere.
- **Don't offer too many options** — give a default with an escape hatch.
- **Avoid time-sensitive information**; use a collapsed "Old patterns" `<details>` section instead.
- **Consistent terminology** — pick one term and keep it.
- **Workflows with copyable checklists** for multi-step tasks; **feedback loops**
  (run validator → fix → repeat) for quality-critical work.
- **Scripts should solve, not defer**: handle `FileNotFoundError`/`PermissionError` inside the
  script rather than failing and letting the model figure it out. No "voodoo constants" — every
  magic number gets a justifying comment (Ousterhout's law).
- **Make execution intent explicit**: "Run `analyze_form.py` to extract fields" (execute) vs.
  "See `analyze_form.py` for the extraction algorithm" (read).
- **Plan-validate-execute** for batch/destructive operations: produce a structured plan file,
  validate it with a script, then execute.
- **MCP tool references must be fully qualified**: `ServerName:tool_name`.
- **Test across model tiers** — what works for a big model may under-specify for a small one.
- **Build evaluations first.** Eval record format given verbatim:

```json
{
  "skills": ["pdf-processing"],
  "query": "Extract all text from this PDF file and save it to output.txt",
  "files": ["test-files/document.pdf"],
  "expected_behavior": [
    "Successfully reads the PDF file using an appropriate PDF processing library or command-line tool",
    "Extracts text content from all pages in the document without missing any pages",
    "Saves the extracted text to a file named output.txt in a clear, readable format"
  ]
}
```

The docs note explicitly: *"There is not currently a built-in way to run these evaluations."* The
`skill-creator` plugin (in `anthropics/claude-plugins-official`) automates the loop in Claude Code:
test cases in `evals/evals.json` inside the skill directory, one subagent per case for clean
context, `grading.json` for pass/fail with evidence, `benchmark.json` aggregating pass rate/time/
tokens with-skill vs. without-skill, blind A/B version comparison, description tuning that
generates should-trigger and should-not-trigger prompts and measures hit rate, and an HTML review
viewer.

### Vela implementation

- Ship a **skill validator** enforcing the mechanical rules (frontmatter constraints, ≤500 lines,
  reference depth ≤1, no backslash paths, ToC present in >100-line reference files, third-person
  description heuristic).
- Ship a **local eval runner** — this is the part Anthropic explicitly doesn't ship in the API/
  claude.ai path, and it's trivially local: run N prompts through the configured backend twice
  (skill enabled / disabled), grade with a rubric, write `grading.json` + `benchmark.json` in the
  documented shapes. Because Vela is model-agnostic, the eval runner has an extra job Anthropic's
  doesn't: **re-run the same skill across the user's configured backends** and report a
  per-backend trigger rate and pass rate, so an author learns "this skill triggers 95% on the API
  model and 40% on qwen3:8b — tighten the description." That's a genuinely new capability.
- Ship a **description tuner**: generate should-trigger/should-not-trigger prompts, measure hit
  rate against the active backend, propose description edits.

---

## 11. Bundled skills and built-in commands

Claude Code ships "bundled skills" — prompt-based skills that give the model detailed instructions
and let it orchestrate with its tools, as opposed to built-in commands that execute fixed logic.
Examples named: `/doctor`, `/code-review`, `/batch`, `/debug`, `/loop`, `/claude-api`, `/run`,
`/verify`, `/run-skill-generator`, `/init`, `/security-review`. Some are auto-invoked by the model;
others (`/verify`) are user-only to keep control over long/expensive runs.

Kill switch: `disableBundledSkills` disables every bundled skill except `/doctor`; `/doctor` is
further suppressible via `DISABLE_DOCTOR_COMMAND` or a `skillOverrides` entry of `"doctor": "off"`.

Notable self-recording pattern: `/run-skill-generator` gets an app running from a clean
environment, captures the working install commands / env vars / launch script, and **commits it as
a per-project skill at `.claude/skills/run-<name>/`**. `/verify` similarly writes what worked to
`.claude/skills/verify/SKILL.md` at the repo root (or the touched package dir in a monorepo), and
that recorded skill replaces the bundled `/verify`. The file is edited **only when a run was
steered wrong**, so it can be committed without per-session diffs.

### Vela implementation

Vela's own bundled skills are just skills in a read-only `<app>/resources/skills/` root, lowest
precedence so users can shadow any of them. The self-recording pattern is worth stealing wholesale
— it's a model-agnostic way to make weak local models competent at project-specific tasks: the
first (possibly frontier-model-assisted) run discovers the recipe, and every subsequent local-model
run follows it deterministically. Vela should make "promote this session's discovered procedure to
a project skill" a one-click action in the UI.

---

## 12. Plugins — the bundle format

A plugin is *"a self-contained directory of components that extends Claude Code with custom
functionality. Plugin components include skills, agents, hooks, MCP servers, LSP servers, and
monitors."* Themes and monitors are `experimental.*`.

### Standard layout (verbatim)

```
enterprise-plugin/
├── .claude-plugin/           # Metadata directory (optional)
│   └── plugin.json             # plugin manifest
├── skills/                   # Skills
│   ├── code-reviewer/
│   │   └── SKILL.md
│   └── pdf-processor/
│       ├── SKILL.md
│       └── scripts/
├── commands/                 # Skills as flat .md files
├── agents/                   # Subagent definitions
├── workflows/                # Workflow scripts
├── output-styles/            # Output style definitions
├── themes/                   # Color theme definitions
├── monitors/                 # Background monitor configurations
│   └── monitors.json
├── hooks/                    # Hook configurations
│   ├── hooks.json
│   └── security-hooks.json
├── bin/                      # Plugin executables added to PATH
├── settings.json            # Default settings for the plugin
├── .mcp.json                # MCP server definitions
├── .lsp.json                # LSP server configurations
├── scripts/                 # Hook and utility scripts
├── LICENSE
└── CHANGELOG.md
```

**Only `plugin.json` goes in `.claude-plugin/`.** Everything else must be at the plugin root — the
docs flag this as the #1 "skills not appearing" cause. A `CLAUDE.md` at the plugin root is **not**
loaded as project context; plugins contribute context through skills/agents/hooks.

### File locations reference (verbatim)

| Component | Default Location | Purpose |
| --- | --- | --- |
| Manifest | `.claude-plugin/plugin.json` | Plugin metadata and configuration (optional) |
| Skills | `skills/` | Skills with `<name>/SKILL.md` structure |
| Commands | `commands/` | Skills as flat Markdown files. Use `skills/` for new plugins |
| Agents | `agents/` | Subagent Markdown files |
| Workflows | `workflows/` | Workflow script files |
| Output styles | `output-styles/` | Output style definitions |
| Themes | `themes/` | Color theme definitions |
| Hooks | `hooks/hooks.json` | Hook configuration |
| MCP servers | `.mcp.json` | MCP server definitions |
| LSP servers | `.lsp.json` | Language server configurations |
| Monitors | `monitors/monitors.json` | Background monitor configurations |
| Executables | `bin/` | Executables added to the Bash tool's `PATH`; invokable as bare commands while the plugin is enabled |
| Settings | `settings.json` | Default configuration applied when the plugin is enabled. Only the `agent` and `subagentStatusLine` keys are supported |

### plugin.json — complete schema (verbatim)

```json
{
  "name": "plugin-name",
  "displayName": "Plugin Name",
  "version": "1.2.0",
  "description": "Brief plugin description",
  "author": {
    "name": "Author Name",
    "email": "author@example.com",
    "url": "https://github.com/author"
  },
  "homepage": "https://docs.example.com/plugin",
  "repository": "https://github.com/author/plugin",
  "license": "MIT",
  "keywords": ["keyword1", "keyword2"],
  "metadata": { "catalogId": "cat-123", "tier": "pro" },
  "skills": "./custom/skills/",
  "commands": ["./custom/commands/special.md"],
  "agents": ["./custom/agents/reviewer.md"],
  "hooks": "./config/hooks.json",
  "mcpServers": "./mcp-config.json",
  "outputStyles": "./styles/",
  "lspServers": "./.lsp.json",
  "experimental": {
    "themes": "./themes/",
    "monitors": "./monitors.json"
  },
  "dependencies": [
    "helper-lib",
    { "name": "secrets-vault", "version": "~2.1.0" }
  ]
}
```

**The manifest is optional.** Without it, components are auto-discovered in default locations and
the plugin name is derived from the directory name. If present, `name` is the only required field
(kebab-case, no spaces), and it's used for namespacing: agent `agent-creator` in plugin
`plugin-dev` shows as `plugin-dev:agent-creator`.

Other documented fields: `$schema` (ignored at load), `displayName`, `defaultEnabled` (boolean,
default true — ship a plugin that installs disabled), `userConfig`, `channels`, `workflows`.

**Unrecognized fields are ignored**, deliberately: *"You can keep metadata from another ecosystem
in `plugin.json` and the plugin still loads,"* making one manifest double as a VS Code/Cursor
extension manifest, an npm `package.json`, or an MCPB/DXT bundle manifest. `claude plugin validate`
reports them as warnings with did-you-mean suggestions; `--strict` promotes warnings to errors.
Wrong-typed *recognized* fields are load errors, except `experimental` and `metadata` which are
ignored with a warning.

### Path behavior rules

- **Replaces the default**: `commands`, `agents`, `workflows`, `outputStyles`,
  `experimental.themes`, `experimental.monitors`. To keep the default and add more, list it
  explicitly: `"commands": ["./commands/", "./extras/"]`.
- **Adds to the default**: `skills`. The default `skills/` is always scanned. Exception: for a
  marketplace entry whose `source` resolves to the marketplace root, declaring subdirectories
  replaces the default scan.
- **Own merge rules**: hooks, MCP servers, LSP servers.
- All paths relative to plugin root and start with `./`, **except `skills` also accepts `"."`**
  (both `"."` and `"./"` mean the plugin root).
- A plugin with a root `SKILL.md`, no `skills/` subdir, and no `skills` manifest field is
  auto-loaded as a **single-skill plugin**.
- **Path traversal is blocked**: `../shared-utils` will not work after installation, because
  external files aren't copied into the cache.

### Environment variables

| Variable | Resolves to | Use for |
| --- | --- | --- |
| `${CLAUDE_PLUGIN_ROOT}` | Absolute path to the plugin's installation directory | Bundled scripts, binaries, config |
| `${CLAUDE_PLUGIN_DATA}` | Persistent directory surviving plugin updates, created on first reference | `node_modules`, venvs, generated code, caches |
| `${CLAUDE_PROJECT_DIR}` | Project root | Project-local scripts and config |

All three are exported as env vars to hook processes and to MCP/LSP subprocesses. Inline
substitution scope per component:

| Plugin component | Fields where placeholders resolve |
| --- | --- |
| Skill and agent content | Anywhere the placeholder appears |
| Hook and monitor commands | Anywhere the placeholder appears |
| MCP `stdio` servers | `command`, `args`, `env` |
| MCP `http`, `sse`, `ws` servers | `url`, `headers`, `headersHelper` |
| LSP servers | `command`, `args`, `env`, `workspaceFolder` |

`${CLAUDE_PLUGIN_ROOT}` **changes on update**; the old directory lingers briefly but is ephemeral —
never write state there.

**Persistent data directory**: `${CLAUDE_PLUGIN_DATA}` resolves to `~/.claude/plugins/data/{id}/`
where `{id}` is the plugin identifier with characters outside `a-zA-Z0-9_-` replaced by `-`. For
`formatter@my-marketplace` → `~/.claude/plugins/data/formatter-my-marketplace/`. Deleted on
uninstall from the last scope unless `--keep-data`. The documented dependency-install idiom:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "diff -q \"${CLAUDE_PLUGIN_ROOT}/package.json\" \"${CLAUDE_PLUGIN_DATA}/package.json\" >/dev/null 2>&1 || (cd \"${CLAUDE_PLUGIN_DATA}\" && cp \"${CLAUDE_PLUGIN_ROOT}/package.json\" . && npm install) || rm -f \"${CLAUDE_PLUGIN_DATA}/package.json\""
          }
        ]
      }
    ]
  }
}
```

### Plugin caching

Marketplace plugins are **copied** into `~/.claude/plugins/cache` rather than used in place, "for
security and verification purposes". Each installed version is its own directory grouped by
marketplace and plugin, named for the resolved version. On update/uninstall the old version
directory is marked orphaned and swept ~14 days later (grace period for concurrent sessions); the
sweep only runs while at least one plugin is installed. Glob and Grep skip orphaned directories.
A symlinked development checkout in the cache is never orphaned or removed.

**Node.js dependency install**: when caching a plugin, if the root has both a `package.json` and a
supported lockfile, deps are installed into the cached copy:

| Lockfile | Command |
| --- | --- |
| `bun.lock` or `bun.lockb` | `bun install --frozen-lockfile --ignore-scripts` |
| `npm-shrinkwrap.json` or `package-lock.json` | `npm ci --ignore-scripts` |

Order of preference: `bun.lock`, `bun.lockb`, `npm-shrinkwrap.json`, `package-lock.json`.
`yarn.lock` and `pnpm-lock.yaml` are **skipped** because Yarn and pnpm support resolution-time
configuration hooks that bypass `--ignore-scripts`. Constraints: frozen resolution, no lifecycle
scripts, **60-second timeout**. Failures never block the plugin. Cannot be disabled.

**Symlinks within a marketplace**: target inside the plugin's own directory → preserved as a
relative symlink; target elsewhere in the same marketplace → **dereferenced** (content copied),
which is how a meta-plugin's `skills/` can link to skills from sibling plugins; target outside the
marketplace → **skipped for security**. For `--plugin-dir`/local installs, only within-plugin
symlinks are preserved.

### userConfig

Declares values prompted at enable time instead of hand-edited settings.

```json
{
  "userConfig": {
    "api_endpoint": { "type": "string", "title": "API endpoint", "description": "Your team's API endpoint" },
    "api_token":   { "type": "string", "title": "API token", "description": "API authentication token", "sensitive": true }
  }
}
```

Option fields: `type` (required — `string`, `number`, `boolean`, `directory`, `file`), `title`
(required), `description` (required), `sensitive`, `required`, `default`, `multiple` (string only),
`min`/`max` (number only).

Values substitute as `${user_config.KEY}` in MCP/LSP configs and hook commands; **non-sensitive**
values also substitute in skill and agent content. All values are exported to hook processes as
`CLAUDE_PLUGIN_OPTION_<KEY>`. Fields that run in a shell **reject** `${user_config.*}` — because
substituting a user value into a shell command would let the shell run whatever it contains — so
shell-form hook commands, monitor commands, and MCP `headersHelper` fail with an error instead;
use exec form with `args`, or read the env var, or read a config file. Non-sensitive values are
stored under `pluginConfigs[<plugin-id>].options` in user `settings.json`; sensitive values go to
the macOS Keychain or `~/.claude/.credentials.json` (~2 KB total keychain budget shared with OAuth
tokens). `pluginConfigs` is read **only** from user settings, `--settings`, and managed settings —
**never from project `.claude/settings.json` or `.claude/settings.local.json`**, precisely because
a cloned repo could otherwise inject values into hook commands and server configs.

### Skills-directory plugins (`@skills-dir`)

Any folder under a skills directory containing `.claude-plugin/plugin.json` loads as a plugin named
`<name>@skills-dir` on the next session — no marketplace, no install step, **discovered in place**
rather than copied to the cache. Scaffold with `claude plugin init`.

| What you have | What it is |
| --- | --- |
| `<skills-dir>/foo/SKILL.md` with no manifest | A plain skill named `foo` |
| `<skills-dir>/foo/.claude-plugin/plugin.json` | A plugin `foo@skills-dir`, which can bundle its own skills, agents, hooks, and more |
| `<plugin>/skills/bar/SKILL.md` | A skill `bar` packaged inside a plugin |

Scope: `~/.claude/skills/` → personal, loads in every project, no restrictions.
`<cwd>/.claude/skills/` → project, loads only after workspace trust, and further restricted: MCP
servers go through per-server approval, LSP servers start only after trust, **background monitors
do not load at all**. Project-scope `@skills-dir` plugins load only from the `.claude/skills/` of
the directory where the session started — they do **not** walk up to the repo root the way plain
skills do.

### CLI surface

`claude plugin init|install|uninstall|prune|enable|disable|update|list|details|validate|tag`.

- `init <name> [--description --author --author-email --with <components...> --force]`, components:
  `skills`, `agents`, `hooks`, `mcp`, `lsp`, `output-style`, `channel`. Alias `new`.
- `install <plugin> [-s|--scope user|project|local] [--config key=value ...]`
- `uninstall <plugin> [-s --scope] [--keep-data] [--prune] [-y]` (aliases `remove`, `rm`)
- `prune [-s --scope] [--dry-run] [-y]` (alias `autoremove`) — removes auto-installed dependencies
  no longer required; never touches directly-installed plugins.
- `enable` / `disable` — enable pulls dependencies transitively at the same scope; disable fails
  when another enabled plugin depends on the target, and the error includes a chained command.
- `list [--json] [--available]`
- `details <name>` — component inventory plus a **projected token cost** split into "Always-on"
  (listing text added every session) and "On-invoke" (per component). The always-on total is
  computed via the `count_tokens` API for the active model; per-component numbers are scaled
  proportionally; falls back to a character estimate if the API is unreachable.
- `validate ./my-plugin [--strict]`
- `tag [path] [--push --dry-run --force --message --remote]`

### Installation scopes

| Scope | Settings file | Use case |
| --- | --- | --- |
| `user` | `~/.claude/settings.json` | Personal plugins across all projects (default) |
| `project` | `.claude/settings.json` | Team plugins shared via version control |
| `local` | `.claude/settings.local.json` | Project-specific, gitignored |
| `managed` | Managed settings | Read-only, update only |

### Vela implementation

The plugin bundle is a **pure filesystem + JSON format with zero server dependency**. Vela should:

- Adopt the layout wholesale, with `.vela-plugin/plugin.json` as the primary manifest name **and
  `.claude-plugin/plugin.json` accepted as a fallback**, so the entire existing plugin corpus
  installs into Vela unmodified. The "unrecognized fields are ignored" rule means Vela can add
  `velaBackends` / `velaMinVersion` keys to the same file without breaking Claude Code, and vice
  versa. This is the intended design — the docs explicitly bless one manifest serving several
  ecosystems.
- Alias `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}`/`${CLAUDE_PROJECT_DIR}` to the `VELA_*`
  names in both directions.
- Reimplement the cache: `~/.vela/plugins/cache/<marketplace>/<plugin>/<version>/`, copy-on-install
  (never load in place from a marketplace), orphan-then-sweep with the same grace period, and the
  same "skip orphaned dirs in Glob/Grep" rule.
- Reimplement the dependency install with the same safety constraints: frozen lockfile,
  `--ignore-scripts`, hard timeout, skip yarn/pnpm for the documented reason. Add `uv`/`pip`
  support for Python plugins installing into `${VELA_PLUGIN_DATA}` — many local-first plugins will
  be Python, and Anthropic's version punts on this by telling authors to do it from a hook.
- Reimplement the symlink policy exactly (in-plugin preserved, in-marketplace dereferenced,
  outside skipped). It is a real sandbox boundary.
- Reimplement `userConfig`, including the **shell-rejection rule** — that rule is a genuine
  injection defense, not bureaucracy. Sensitive values go to the OS keyring (Keychain / Windows
  Credential Manager / libsecret) with an encrypted-file fallback; and the `pluginConfigs`
  source restriction (never read from project settings) must be preserved.
- `plugin details` token estimation: Vela has no `count_tokens` API to lean on for local models.
  Use the backend's own tokenizer where available (llama.cpp `/tokenize`, tiktoken/HF tokenizers
  for known models), and fall back to a chars/4 estimate. Show the estimate as a fraction of the
  *active model's* context window, which is far more actionable than a raw token count when the
  user is on a 32k local model.

---

## 13. Plugin components other than skills (summary, for cross-referencing)

- **Agents** (`agents/*.md`): frontmatter `name`, `description`, `model`, `effort`, `maxTurns`,
  `tools`, `disallowedTools`, `skills`, `memory`, `background`, `isolation` (only valid value
  `"worktree"`). **For security, `hooks`, `mcpServers`, and `permissionMode` are not supported in
  plugin-shipped agents.** Namespaced as `my-plugin:code-reviewer` in @-mention typeahead.
- **Hooks** (`hooks/hooks.json` or inline): 30+ lifecycle events documented
  (`SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`,
  `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`,
  `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`,
  `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`,
  `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`,
  `PostCompact`, `Elicitation`, `ElicitationResult`, `SessionEnd`). Hook types: `command`, `http`,
  `mcp_tool`, `prompt`, `agent`. Hooks targeting the plugin's own MCP server must use scoped names
  `mcp__plugin_<plugin-name>_<server-name>__<tool>` and `server: plugin:<plugin>:<server>`.
- **MCP servers** (`.mcp.json` or inline `mcpServers`): standard MCP config; start automatically
  when the plugin is enabled; `/reload-plugins` keeps live connections for unchanged servers.
- **LSP servers** (`.lsp.json` or inline `lspServers`): required `command` + `extensionToLanguage`;
  optional `args`, `transport` (`stdio` default; `socket` accepted but everything runs over stdio),
  `env`, `initializationOptions`, `settings`, `workspaceFolder`, `startupTimeout`,
  `shutdownTimeout`, `restartOnCrash` (default true), `maxRestarts`, `diagnostics` (default true).
  First server registered for an extension wins; others never start. Stdout is protocol-only —
  headers ≤64 KiB, body ≤32 MiB; violating it disconnects the server and counts as a crash. **The
  binary must be installed separately.**
- **Monitors** (`monitors/monitors.json`, experimental): each runs a shell command for the session
  lifetime and delivers every stdout line to the model as a notification. Fields: `name`,
  `command`, `description` required; `when` optional (`"always"` default, or
  `"on-skill-invoke:<skill-name>"`). Interactive CLI sessions only, unsandboxed at hook trust
  level. Cannot reference `${user_config.*}`; don't receive `CLAUDE_PLUGIN_OPTION_*`. Disabling a
  plugin mid-session does not stop already-running monitors.
- **Themes** (`themes/*.json`, experimental): `name`, `base` preset, sparse `overrides` color-token
  map. Saved as `custom:<plugin-name>:<slug>`; read-only, copied to `~/.claude/themes/` on edit.
- **`bin/`**: executables added to the Bash tool's `PATH`, invokable as bare commands while the
  plugin is enabled.

### Vela implementation

All of these are harness features, none are model features. `bin/` on PATH and monitors deserve
the same trust gating as hooks. The LSP piece is a straight port. The agent-security carve-out
(no `hooks`/`mcpServers`/`permissionMode` from plugin-shipped agents) should be preserved verbatim
— it exists so an installed plugin can't silently escalate its own permissions.

---

## 14. Marketplaces

### marketplace.json — required fields

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Marketplace identifier (kebab-case, no spaces). Public-facing. **One marketplace per name per user** — adding a second with the same name replaces the first. |
| `owner` | object | Maintainer info: `name` (required), `email`, `url` |
| `plugins` | array | List of available plugins |

Optional: `$schema` (ignored at load), `description`, `version`, `metadata.pluginRoot` (base dir
prepended to relative plugin source paths), `allowCrossMarketplaceDependenciesOn` (array of other
marketplaces whose plugins may be depended on; anything else is blocked at install), `renames`
(map from a former plugin name to its current name, or `null` if removed, so existing users migrate
automatically). `description` and `version` are also accepted under `metadata` for back-compat.

Canonical example:

```json
{
  "name": "company-tools",
  "owner": { "name": "DevTools Team", "email": "devtools@example.com" },
  "plugins": [
    {
      "name": "code-formatter",
      "source": "./plugins/formatter",
      "description": "Automatic code formatting on save",
      "version": "2.1.0",
      "author": { "name": "DevTools Team" }
    },
    {
      "name": "deployment-tools",
      "source": { "source": "github", "repo": "company/deploy-plugin" },
      "description": "Deployment automation tools"
    }
  ]
}
```

**Reserved marketplace names** (blocked for third parties, re-checked on every load, not just on
add): `claude-code-marketplace`, `claude-code-plugins`, `claude-plugins-official`,
`claude-plugins-community`, `claude-community`, `anthropic-marketplace`, `anthropic-plugins`,
`agent-skills`, `anthropic-agent-skills`, `knowledge-work-plugins`, `life-sciences`,
`claude-for-legal`, `claude-for-financial-services`, `financial-services-plugins`,
`first-party-plugins`, `healthcare`. Names that impersonate official marketplaces
(`official-claude-plugins`, `anthropic-plugins-v2`) are also blocked.

### Plugin entries

Required: `name`, `source`. A plugin entry may carry **any field from the plugin manifest schema**
plus these marketplace-specific ones: `source`, `category`, `tags`, `strict`, `relevance`. Also
documented: `displayName`, `description`, `version`, `author`, `homepage`, `repository`, `license`,
`keywords`, `metadata`, `defaultEnabled`, and the component config fields `skills`, `commands`,
`agents`, `hooks`, `mcpServers`, `lspServers`.

### Source types (verbatim table)

| Source | Type | Fields | Notes |
| --- | --- | --- | --- |
| Relative path | `string` (e.g. `"./my-plugin"`) | none | Local directory within the marketplace repo. Must start with `./`. Resolved relative to the marketplace root, not the `.claude-plugin/` directory |
| `github` | object | `repo`, `ref?`, `sha?` | |
| `url` | object | `url`, `ref?`, `sha?` | Git URL source |
| `git-subdir` | object | `url`, `path`, `ref?`, `sha?` | Subdirectory within a git repo. Clones sparsely to minimize bandwidth for monorepos |
| `npm` | object | `package`, `version?`, `registry?` | Installed via `npm install` |
| `archive` | object | `url`, `sha256?` | Zip archive downloaded over HTTPS. Works without git or npm on the user's machine |

When both `ref` and `sha` are set on a git source, **`sha` is the effective pin**. `sha256` on an
archive is 64 hex chars, verified on every download, install refused on mismatch. Marketplace
sources (where the catalog itself lives) support `ref` but **not** `sha`; plugin sources support
both.

Relative paths resolve against a **local copy** of the marketplace, so they work for git-source and
local-directory marketplaces but **break for URL-only marketplaces** (only the single JSON file is
downloaded). For URL distribution use github/npm/git/archive sources.

### Strict mode

`strict` (default `true`) controls whether `plugin.json` is the authority for component
definitions (skills, agents, hooks, MCP servers, output styles).
- `strict: true` — the plugin has its own `plugin.json` and manages its own components; the
  marketplace entry may add extra skills or hooks on top.
- `strict: false` — the plugin needs no `plugin.json`; the marketplace entry defines everything.
  For marketplace operators who want to restructure or curate a plugin's components differently
  than its author intended.

Conflict error: `Plugin my-plugin has conflicting manifests: both plugin.json and marketplace entry
specify components.`

### Version management

Resolved from the first of these that is set:
1. `version` in the plugin's `plugin.json`
2. `version` in the marketplace entry
3. The git commit SHA of the source (for `github`, `url`, `git-subdir`, and relative-path sources
   in a git-hosted marketplace)
4. The SHA-256 digest for `archive` sources — the `sha256` pin, or the digest of the downloaded
   file if unpinned; shortened to the first 12 characters
5. `unknown`, for `npm` sources or local directories not inside a git repository

Three resulting strategies: **explicit version** (updates only on bump — published plugins),
**commit-SHA version** (updates whenever the source commit changes — internal/team plugins under
development), **digest version** (updates when the zip bytes or the pin change).

### Discovery / install UX

`/plugin` opens a four-tab panel: **Discover**, **Installed**, **Marketplaces**, **Errors**. The
detail pane shows a **Context cost** estimate, **Last updated**, and a **Will install** section
listing commands, agents, skills, hooks, and MCP/LSP servers — *before* installing. Marketplaces
are added from GitHub `owner/repo`, any git URL (with `#ref` suffix for branch/tag), local
directory, local `marketplace.json` path, or a remote `marketplace.json` URL.

Auto-update: refreshed in the background after session start with a **random delay of up to ten
minutes**, so the running session keeps its loaded versions. Official Anthropic marketplaces
default to auto-update on; third-party and local development marketplaces default to off.
`DISABLE_AUTOUPDATER` kills everything; `FORCE_AUTOUPDATE_PLUGINS=1` alongside it keeps plugin
auto-updates while disabling app auto-update.

Team config in `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "my-team-tools": {
      "source": { "source": "github", "repo": "your-org/claude-plugins" }
    }
  }
}
```

Admins can set `"autoUpdate": true` per `extraKnownMarketplaces` entry in managed settings.
`strictKnownMarketplaces` in managed settings restricts which marketplaces can be added (`[]` =
none allowed; a list = allowlist; undefined = no restriction). Pair with `disableSideloadFlags` to
reject the CLI flags that sideload plugins/agents/MCP servers for a single run.
`pluginSuggestionMarketplaces` allowlists which marketplaces may surface contextual install
suggestions.

**Removing a marketplace uninstalls any plugins installed from it.**

Security posture, verbatim: *"Plugins and marketplaces are highly trusted components that can
execute arbitrary code on your machine with your user privileges. Only install plugins and add
marketplaces from sources you trust."*

`/reload-plugins` applies changes without restart; when the reload would invalidate the prompt
cache it warns and skips until rerun with `--force`.

### Vela implementation

A marketplace is **a static JSON file in a git repo**. There is no Anthropic server in this loop at
all — `/plugin marketplace add owner/repo` is a `git clone`. Vela reimplements it as:

- A `MarketplaceRegistry` reading `.vela-plugin/marketplace.json` **or** `.claude-plugin/marketplace.json`
  from: git clone (any host, `#ref`), local dir, local JSON path, remote JSON URL, npm package, or
  HTTPS zip. Use a Go/Rust/Node git client or shell out to `git`; use the OS keyring / existing git
  credential helpers for private repos exactly as Claude Code does.
- Implement `sha256` archive pinning and refuse on mismatch. Implement `sha` > `ref` precedence.
  Implement the five-step version resolution ladder verbatim so update semantics match.
- **Drop the reserved-name list** (it's Anthropic brand protection) but **keep the mechanism** —
  Vela should reserve its own official marketplace names and re-check on every load, since the
  attack it prevents (a third-party catalog presenting itself as first-party) applies equally.
- Ship a default Vela marketplace, and **also ship `anthropics/claude-plugins-official` and
  `anthropics/claude-plugins-community` as optional pre-registered read-only catalogs**. Their
  plugins are plain files; the ones whose value is skills/agents/hooks/LSP will work in Vela
  directly. Plugins whose value is an Anthropic-hosted MCP connector will not — Vela's plugin
  detail view should statically analyze the bundle and warn "this plugin's MCP server requires an
  Anthropic-hosted endpoint" before install.
- The **Will install** pre-install inventory is a security feature, not a nicety: parse the bundle
  and enumerate every hook command, every `bin/` executable, every MCP server command line, and
  every skill `allowed-tools` rule, and show them before the user consents. Vela should go further
  than Claude Code here and show the actual command strings.
- Auto-update with the random-delay-after-start behavior; default **off** for all third-party
  marketplaces in Vela (Claude Code only defaults on for its own).

---

## 15. What is genuinely Anthropic-server-side (and the local substitute)

Almost nothing in this area is server-side. The exceptions, stated explicitly:

### 15.1 The pre-built document skills (`pptx`, `xlsx`, `docx`, `pdf`)

**ANTHROPIC_SERVER_SIDE.** On the API these are referenced by `skill_id` inside the `container`
parameter and execute inside Anthropic's **code execution tool container**. From the overview:
Skills on the API run in a sandboxed container with **no network access and no runtime package
installation** — only pre-installed packages. On claude.ai they're active automatically when
creating documents, and network access varies by user/admin settings. Claude Code **does not have
them** (only the open-source `claude-api` skill ships bundled).

**Vela substitute:** ship the equivalents as ordinary local skills. Anthropic open-sources the
document skills in `github.com/anthropics/skills` under `skills/` (the README lists PDF, DOCX,
PPTX, XLSX as "source-available, production-used"), so Vela can vendor them and point them at
locally installed libraries — `python-docx`, `openpyxl`, `python-pptx`, `pdfplumber`/`pypdf`,
`reportlab`. Run them in a **local sandbox**, not the host: Docker/Podman container on
desktop-with-Docker, or `bubblewrap`/`firejail` on Linux, `sandbox-exec`/App Sandbox on macOS, and
a restricted job object / AppContainer on Windows. Mount only the session's working directory and
the skill's own directory; deny network by default with a per-skill opt-in. Ship a bundled
Python runtime (or use `uv` to create a per-skill venv under `${VELA_PLUGIN_DATA}`) so users don't
need a system Python. This is strictly *more* capable than the API path, which forbids runtime
package installation entirely.

### 15.2 The Skills API (`/v1/skills`) and `container.skills`

**ANTHROPIC_SERVER_SIDE.** Endpoints: `POST /v1/skills`, `GET /v1/skills`,
`GET /v1/skills/{skill_id}`, `DELETE /v1/skills/{skill_id}`,
`POST /v1/skills/{skill_id}/versions`, `GET /v1/skills/{skill_id}/versions`,
`DELETE /v1/skills/{skill_id}/versions/{version}`. Upload is a multipart zip (skill directory as
the top-level entry) or path-qualified individual files. Limits: total upload **< 30 MB
uncompressed**, `SKILL.md` at top level, top-level directory name matching `name`
(case/underscore-insensitive), **max 8 skills per request**. Versions are date-based for Anthropic
skills (`20251013`) and epoch-timestamp for custom (`1759178010641129`), plus `latest`. Wire shape:

```json
{
  "container": {
    "skills": [
      { "type": "anthropic", "skill_id": "pptx", "version": "latest" },
      { "type": "custom", "skill_id": "skill_01AbCdEfGhIjKlMnOpQrStUv", "version": "1759178010641129" }
    ]
  }
}
```

Beta headers: `code-execution-2025-08-25,skills-2025-10-02`, plus `files-api-2025-04-14` when
using the Files API. **The code execution tool is required.** Custom skills are workspace-wide on
the API; individual-user on claude.ai; and Skills do **not** sync across surfaces at all. Agent
Skills are **not covered by ZDR**.

**Vela substitute:** the entire API is replaced by the local filesystem. There is nothing to
upload, no versioning service, no container to provision, no beta header, no 30 MB cap, no
8-skills-per-request cap, and no cross-surface sync problem — because there is only one surface.
Vela's equivalent of "skill versions" is git: a skill directory in a repo, versioned by the user's
own VCS, with the plugin/marketplace version ladder above for distribution. Vela's equivalent of
`container.skills` is the local skill registry plus the `Skill` tool. If a user *has* an Anthropic
API key and selects that backend, Vela should still prefer local skills over `container.skills`,
because using the server-side path would make behavior differ between backends — the one thing a
model-agnostic app must never do. Optionally offer a one-way **export** (`vela skill export --zip`)
producing a spec-compliant zip that validates against the six-field frontmatter rule, for users who
also use claude.ai.

### 15.3 claude.ai / Claude Desktop skill sync and the Customize panel

**ANTHROPIC_SERVER_SIDE.** Custom skills are uploaded as zips through **Customize > Skills** on
claude.ai or in the Desktop app; the zip's root must be the skill folder itself, not a subfolder.
Skill categories in the consumer app: Anthropic pre-built, custom, **partner skills** (Notion,
Figma, Atlassian), and **organization-provisioned skills** for Team/Enterprise, which admins
distribute and can set enabled-or-disabled by default; Enterprise can enable **skill scanning for
malicious content**. Available on Free, Pro, Max, Team, Enterprise; **requires code execution
enabled**. The Desktop docs state the Cowork tab sources its skills, plugins, and connectors from
the Customize configuration, which **syncs through the claude.ai account, not from the CLI's
`~/.claude` directory** — and cloud sessions/routines therefore cannot see a skill that exists only
in `~/.claude/skills/`. Claude Code can pull account skills down into `~/.claude/skills/synced/`
when `CLAUDE_CODE_SYNC_SKILLS` is set in non-interactive mode.

**Vela substitute:** Vela has no account, so this whole split disappears — one skill store, always
local, always available to every session including scheduled/background ones. Where Vela wants
multi-device sync, do it **without a server**: a user-designated git repo (`vela skills sync`
commits and pushes `~/.vela/skills/`) or a folder the user already syncs (Dropbox/iCloud/Syncthing).
That gives versioning and conflict resolution for free and keeps the data on the user's
infrastructure. For the org-provisioning story, Vela's equivalent is a managed-policy file plus an
org marketplace pinned by `sha`. For "skill scanning for malicious content", implement a **local
static scanner** that runs on install and flags: network calls in bundled scripts, `curl|sh`
patterns, credential-file reads, `allowed-tools` grants broader than `Bash(<specific> *)`,
`` !`cmd` `` injections that touch the network, and base64/eval obfuscation. Present findings in
the install dialog. This is a heuristic linter, not a guarantee, and should be labeled as such.

### 15.4 `plugin details` token counting via the `count_tokens` API

**MIXED.** The always-on total is computed via Anthropic's `count_tokens` API for the active model,
falling back to a character estimate when unreachable.

**Vela substitute:** use the active backend's own tokenizer. llama.cpp and vLLM both expose a
`/tokenize` endpoint; Ollama exposes token counts in responses; for API backends use the provider's
counting endpoint if one exists. Fall back to a tokenizer library keyed on the model family
(tiktoken for GPT-family, HF `tokenizers` for open models), then chars/4. Always express the result
as **percentage of the active context window**.

### 15.5 Curated marketplaces and the community submission pipeline

**ANTHROPIC_SERVER_SIDE (as a service, not as a protocol).** `claude-plugins-official` is curated
at Anthropic's discretion; `claude-plugins-community` hosts third-party plugins that passed
"automated validation and safety screening", each pinned to a specific commit SHA; the in-app
submission forms feed the community marketplace.

**Vela substitute:** the *protocol* (a JSON catalog in a git repo) is fully portable and needs no
service. Vela should run its own curated catalog as a public git repo with CI that runs
`vela plugin validate --strict` plus the static scanner on every PR and pins each entry to a commit
SHA — reproducing the community marketplace's security properties with GitHub Actions and no
bespoke backend. Submission is a pull request.

---

## 16. Consolidated Vela build order for this area

1. **Skill loader + registry + open-spec validator.** Parse frontmatter only at startup; watch for
   changes; implement scope precedence and the compat roots (`~/.claude/skills` etc.). Pure
   client-side, no model involvement. This alone makes Vela compatible with the whole existing
   skill ecosystem.
2. **Listing budget with usage-ranked degradation**, computed from the active backend's context
   window. Critical for small local models, where a naive listing eats the whole prompt.
3. **`Skill` tool + rendered-content lifecycle** (single message, persists, dedup on identical
   re-render, compaction carry-forward with fractional budgets, plus a Vela-only unload action).
4. **Substitutions + dynamic context injection.** Faithful port including single-pass no-rescan,
   quoting/escape rules, merged stderr, timeouts, fail-closed abort with the exit-1 carveout, and
   pre-flight permission evaluation that aborts rather than prompts. Highest value-per-line for
   weak backends.
5. **Invocation control + permissions + `skillOverrides` + workspace trust gate** that enumerates
   what project skills would grant.
6. **Plugin loader**: manifest (both `.vela-plugin` and `.claude-plugin`), path behavior rules,
   env vars with two-way aliasing, `@skills-dir` in-place plugins, `bin/` on PATH.
7. **Plugin cache + dependency install** with the documented safety constraints, extended with
   `uv`/pip for Python, plus the symlink policy.
8. **Marketplace registry** with all six source types, sha256 pinning, `sha`>`ref`, the version
   ladder, and the pre-install inventory dialog showing actual command strings.
9. **Local sandboxed document skills** (docx/xlsx/pptx/pdf) replacing Anthropic's hosted container
   skills, with a bundled Python runtime and a deny-network-by-default sandbox.
10. **Local eval runner + description tuner**, with the Vela-specific twist of reporting per-backend
    trigger and pass rates. Genuinely new capability, only possible because Vela is multi-backend.
