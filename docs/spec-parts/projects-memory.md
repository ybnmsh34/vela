# Vela spec part — Projects, Memory, Chat Search, Styles/Skills, Incognito

Ingestion date: 2026-08-12. Target: Vela, a model-agnostic desktop app (user supplies the
brain: local llama.cpp / Ollama / LM Studio / vLLM, any third-party API key, or a subscription
provider). Every Claude Desktop / claude.ai feature in this area must have a Vela equivalent;
only the model is swappable.

---

## 0. Sources

### Fetched successfully (content below is derived from these)

- https://support.claude.com/en/articles/9517075-what-are-projects
- https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects
- https://support.claude.com/en/articles/9519189-manage-project-visibility-and-sharing
- https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects
- https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude
- https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features
- https://support.claude.com/en/articles/12260368-use-incognito-chats
- https://support.claude.com/en/articles/15672559-see-your-monthly-recap
- https://support.claude.com/en/articles/8241126-upload-files-to-claude
- https://support.claude.com/en/articles/12512198-how-to-create-custom-skills
- https://support.claude.com/en/articles/12512180-use-skills-in-claude
- https://support.claude.com/en/articles/12138966-release-notes
- https://support.claude.com/en/collections/18031818-personalization-and-settings
- https://support.claude.com/en/collections/18031977-conversation-management
- https://support.claude.com/en/collections/4078531-claude
- https://support.claude.com/en/
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool  (full page, verbatim)
- https://code.claude.com/docs/en/memory  (full page, verbatim)
- https://claude.com/blog/memory  (redirect target of anthropic.com/news/memory)
- https://claude.com/resources/tutorials/teach-claude-your-way-of-working-using-skills

### SOURCE UNREACHABLE — fail closed, do not reconstruct

- SOURCE UNREACHABLE: https://www.anthropic.com/news/styles — 308 redirect to
  https://claude.com/blog/styles, which returned **HTTP 404 Not Found**. The original styles
  announcement is gone.
- SOURCE UNREACHABLE: https://support.claude.com/en/articles/10181068-configuring-and-using-styles
  — HTTP 404. The English "Configuring and using styles" article no longer exists at that slug.
- SOURCE UNREACHABLE: https://support.claude.com/en/articles/10181068-styles-are-becoming-skills
  and https://support.claude.com/en/articles/10181068 — both HTTP 404.
- SOURCE UNREACHABLE: https://support.claude.com/de/articles/10181068-stile-werden-zu-skills —
  HTTP 503 Service Unavailable on two attempts. This is the *only* surviving article ID for the
  styles→skills migration and its body could not be read.
- SOURCE UNREACHABLE: https://support.claude.com/en/articles/12512176-what-are-skills — HTTP 503.
- SOURCE UNREACHABLE: https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work
  — HTTP 503.
- SOURCE UNREACHABLE: https://support.claude.com/en/collections/9811072-using-claude — HTTP 404.
- SOURCE UNREACHABLE: https://support.claude.com/en/articles/9945648-intro-to-projects — 301
  redirect to https://claude.com/resources/tutorials/intro-to-projects, which is a video-tutorial
  landing page with no extractable technical substance.

**Search-snippet-only, NOT a page fetch (treat as PARTIAL):** the existence of a help-center
article titled (German) "Stile werden zu Skills" / "Styles are becoming Skills" at article ID
10181068, and the claim that migrated custom styles are invoked via `/{style-name}-style` and are
disabled by default, come from WebSearch result summaries, not from a successful page fetch. The
five preset style names (Normal, Learning, Concise, Explanatory, Formal) likewise appear only in
third-party blog results surfaced by search, not in any Anthropic page I could fetch.

---

## 1. Projects

### 1.1 What a project is

Source: https://support.claude.com/en/articles/9517075-what-are-projects

A project is a "self-contained workspace with its own chat history and knowledge base." Three
components:

1. **Project knowledge** — uploaded documents/text/code, shared by every chat in the project.
2. **Project instructions** — a free-text custom-instruction block scoped to the project.
   "Instructions apply to all chats within that project" and only to those chats.
3. **Project chat history** — conversations filed under the project, separate from the general
   chat list.

Name and description are metadata for humans: per the create/manage article, "Claude cannot access
these details" — i.e. the project name/description are NOT injected into the model context. Only
the instructions and knowledge are.

Plan gating (server-side business logic, not a technical constraint):
- Free: maximum **5** projects.
- Pro/Max/Team/Enterprise: unlimited.
- Project instructions are described as paid-plan-only in the personalization article, while the
  "what are projects" article says projects themselves are available to all users including free.

### 1.2 Project knowledge ingestion limits

Source: https://support.claude.com/en/articles/8241126-upload-files-to-claude

| | Chat upload | Project knowledge |
|---|---|---|
| Max file size | **500 MB per file** | **30 MB per file** |
| File count | **up to 20 files per chat** | unlimited (bounded by context window) |
| Processing | multimodal for images and ≤100-page PDFs | **text extraction only**, except multimodal PDFs |

Supported types: PDF, DOCX, CSV, TXT, HTML, ODT, RTF, EPUB, JSON, XLSX (XLSX requires code
execution enabled); images JPEG, PNG, GIF, WebP.

PDF rules: ≤100 pages → text *and* visual elements analyzed; 101–1000 pages → **text only, no
visual analysis**; >1000 pages → **cannot be uploaded**. Images up to 8000×8000 px; ≥1000×1000 px
recommended.

For non-PDF documents Claude extracts text only — embedded images inside a DOCX are invisible to it.

### 1.3 Retrieval: in-context mode vs RAG mode

Source: https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects

This is the single most important mechanic in this area. Project knowledge has **two distinct
modes** and the switch is automatic:

- **In-context mode (default):** the entire project knowledge base is stuffed into the context
  window of every chat in the project. No retrieval, no search tool, perfect recall.
- **RAG mode:** "When your project knowledge approaches the context window limit, Claude will
  automatically enable RAG mode." Capacity expands to "**up to 10x more content**." Instead of
  loading everything, Claude "intelligently searches and retrieves only the most relevant
  information," using a **"project knowledge search tool"** — i.e. retrieval is exposed to the
  model as a *tool call*, not as pre-injected context.
- **Automatic and reversible:** "RAG automatically activates when your project approaches or
  exceeds the context window limits," and projects revert to "context-based processing" if
  "project knowledge later drops below the context window threshold."
- Availability: "RAG for projects is available for all Claude plans (free, Pro, Max, Team, and
  Enterprise)." (Note: the older "what are projects" article says the 10x RAG expansion is
  paid-plans-only; the dedicated RAG article — newer — says all plans. Contradiction recorded, not
  resolved.)

The docs explicitly do **not** disclose chunking strategy, embedding model, vector store, or search
algorithm. Do not claim otherwise.

### 1.4 Project management operations

Source: https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects

- Create at claude.ai/projects → "+ New Project", name + description.
- Knowledge: "+" button uploads documents, text files, code snippets.
- Instructions: "Set project instructions" button.
- Move chats in/out: dropdown next to chat name → "Add to project" / "Remove from project";
  bulk-select checkboxes on the chat-history page to move many at once.
- **Star** a project (Projects page or star icon inside the project).
- **Archive** a project: three-dot menu; "everything is restored exactly as it was when you
  unarchive."
- **Delete**: an archived project must be unarchived first, then confirmed.
- Project memory: "Each project has its own memory, kept separate from your non-project chats."
  Listed as Pro/Max/Team/Enterprise.

### 1.5 Sharing and visibility (Team/Enterprise)

Source: https://support.claude.com/en/articles/9519189-manage-project-visibility-and-sharing

- Two permission levels: **"Can view"** (see contents, knowledge, instructions; can chat in the
  project; cannot edit) and **"Can edit"** (modify instructions, knowledge, membership).
- Two visibility states: **Public** ("Everyone in your organization can view and use the project",
  discoverable via the Team tab) and **Private** (explicit invite only). Toggleable at any time via
  the Share button.
- Bulk invite by pasting a list of email addresses into "Add people".
- Enterprise admins can enable/disable group project sharing; group shares are in beta; **access
  changes propagate within five minutes**.
- A **"Shared with you"** tab surfaces projects others shared.
- Critical privacy rule: invited members get the knowledge base, instructions, and the ability to
  start chats, plus **snapshot** access to chat messages/artifacts that were explicitly shared —
  but "your chats within that project will be private and inaccessible to other members" unless
  separately shared. So project membership ≠ chat visibility.

---

## 2. Memory

Two *entirely different* memory systems exist under the Anthropic umbrella and Vela must not
conflate them.

### 2.1 claude.ai / Claude Desktop consumer memory

Sources:
- https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- https://claude.com/blog/memory
- https://support.claude.com/en/articles/12138966-release-notes

Mechanics:
- Claude "generates memory based on your chats." Writes are **real time**: "Claude reads, writes
  and updates these entries in real time as you chat rather than on a fixed daily schedule."
- Release notes, **July 10, 2026 — "Updated memory for Claude"**: memory is now "a set of
  individual, categorized entries that Claude reads and updates during your conversations." This
  supersedes the earlier single free-text "memory summary" model described in the Sept/Oct 2025
  blog post ("Claude uses a memory summary to capture all its memories in one place for you to view
  and edit").
- What gets captured: "Your role, projects, and professional context"; "Communication preferences
  and working style"; "Technical preferences and coding style"; "Project details and ongoing work."
  Scope bias is explicitly **work-related**: the import article warns "Claude's memory is designed
  to focus on work-related topics... Claude may not retain imported personal details unrelated to
  work."
- **Selectivity:** Claude "doesn't save something every session. It decides what's worth
  remembering based on whether the information would be useful in a future conversation."
- **Project isolation:** "Each project has its own separate memory space and dedicated project
  summary, so the context within each of your projects is focused, relevant, and separate."
  Blog: "Claude creates a separate memory for each project. This ensures that your product launch
  planning stays separate from client work."
- **Editing:** Settings > Memory. Per-entry "Tell Claude what to change or remove" box, plus
  "Delete" per entry. Also editable conversationally — "tell Claude what you'd like it to remember,
  and it will update Claude's memory of you without needing to leave the conversation."
- **Disabling:** the toggle offers two options —
  - *Pause memory*: keeps existing memories but stops reading and writing; "Conversations with
    Claude while memory is paused will not be summarized into its memory should you turn the
    feature back on" (i.e. the pause window is permanently lost, not backfilled).
  - *Reset memory*: "Permanently deletes all memories including project memories."
- Rollout: Sept 2025 Team/Enterprise → Oct 23 2025 Max then Pro → **March 2, 2026 free users**.
  Enterprise admins can disable memory org-wide.
- There is also a settings toggle **"Generate memory from chat history"** under Settings >
  Capabilities (referenced by the monthly-recap article).

### 2.2 Memory import/export

Source: https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude

- **Export**: "export your memory as a Markdown file."
- **Interchange format**: a single fenced code block, one entry per line, shaped
  `[date saved, if available] - memory content`.
- **Import flow**: (1) run the supplied extraction prompt against your other AI provider,
  (2) Settings > Memory → "Start import", (3) paste the text, (4) "Add to memory". "Claude will
  extract key information and store it as individual memory entries" — i.e. import is itself an
  LLM extraction pass, not a literal load.
- The suggested extraction prompt asks the other provider for: instructions about how to respond
  (tone, format, style, "always do X"/"never do Y"); personal details (name, location, job, family,
  interests); projects, goals, recurring topics; tools, languages, frameworks; preferences and
  corrections.
- Availability: "Memory imports are available for Free, Pro, Max, and Team plans on the web and
  Claude Desktop." (Enterprise not listed.)
- Explicit caveat: "**Memory imports are experimental and still in active development**, and at
  this stage, Claude may not always successfully incorporate imported memories."

### 2.3 API memory tool (`memory_20250818`) — the portable contract

Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool (fetched in full)

**This is the piece Vela should copy verbatim, because Anthropic themselves designed it to be
client-side.** Quote: "The memory tool operates client-side: Claude requests file operations, and
your application executes them. You control where and how the data is stored through your own
infrastructure." And: "The `/memories` path is a prefix that your handler maps onto real storage,
such as a per-user directory or keys in a database. Memory lives entirely in your application."

Declaration is a single line, no input schema:
`{"type": "memory_20250818", "name": "memory"}` — GA on the Messages API, no beta header, all
Claude 4+ models.

Six commands your handler must implement:

| command | params | success string |
|---|---|---|
| `view` | `path`, optional `view_range: [start, end]` (`-1` = to EOF) | dir listing header or numbered file contents |
| `create` | `path`, `file_text` | `File created successfully at: {path}` |
| `str_replace` | `path`, `old_str`, optional `new_str` (omitted ⇒ delete) | `The memory file has been edited.` + numbered snippet |
| `insert` | `path`, `insert_line` (0 = top; inserted *after* the line), `insert_text` | `The file {path} has been edited.` |
| `delete` | `path` | `Successfully deleted {path}` |
| `rename` | `old_path`, `new_path` | `Successfully renamed {old_path} to {new_path}` |

Exact return formats:
- Directory: `Here're the files and directories up to 2 levels deep in {path}, excluding hidden items and node_modules:` then `{size}\t{path}` lines. Two levels deep, human-readable sizes (`5.5K`, `1.2M`), excludes dotfiles and `node_modules`, **tab** between size and path.
- File: `Here's the content of {path} with line numbers:` then lines of `{6-char right-aligned line number}\t{content}`, 1-indexed. Files >999,999 lines → error `File {path} exceeds maximum line limit of 999,999 lines.`
- `view` also renders `.jpg/.jpeg/.png` and truncates text views past **16,000 characters**; expect ranged follow-up views.
- First `view` of an empty `/memories` is **not** an error; the reference SDK creates the root first and returns the header plus one line for the empty dir.
- `create` "creates or overwrites" per Claude's own tool description, so expect creates on existing paths; returning `Error: File {path} already exists` is reference behavior, overwriting is a valid choice.
- `str_replace` duplicate match → `No replacement was performed. Multiple occurrences of old_str `{old_str}` in lines: {line_numbers}. Please ensure it is unique`
- `delete`/`rename` must **reject the memory root itself**.
- Errors go back as a `tool_result` with `is_error: true`.

Auto-injected system prompt (the API adds this for you when the tool is present):
```
IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE.
MEMORY PROTOCOL:
1. Use the `view` command of your `memory` tool to check for earlier progress.
2. ... (work on the task) ...
   - As you make progress, record status / progress / thoughts etc in your memory.
ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk losing any progress that is not recorded in your memory directory.
```

Security obligations that are **the client's**, per the doc:
- Path traversal: `/memories/../../secrets.env` must be rejected. Validate every path starts with
  `/memories`; canonicalize and re-verify containment; reject `../`, `..\\`, and URL-encoded
  `%2e%2e%2f`; use `pathlib.Path.resolve()`/`relative_to()`-style utilities.
- Cap file sizes and cap how many characters `view` returns, letting the model page with
  `view_range`.
- Expire memory files not accessed in a long time.
- Strip sensitive data before writing ("Claude usually refuses to write sensitive information to
  memory files. For stronger guarantees, add validation").

Pairing: memory + **context editing** (client-side clearing of specific tool results) and memory +
**compaction** (server-side whole-conversation summarization near the context limit). "compaction
keeps the active context small without client-side bookkeeping, and memory preserves the
information that must survive summarization."

Multi-session pattern the doc recommends: an *initializer* session writes a progress log, a feature
checklist, and a pointer to the startup script; each later session opens by reading them and closes
by updating the progress log; work one feature at a time and mark it done only after end-to-end
verification.

### 2.4 Claude Code memory (CLAUDE.md + auto memory)

Source: https://code.claude.com/docs/en/memory (fetched in full)

Two mechanisms, both loaded at the start of every session, both **context, not enforced config**
("To block an action regardless of what Claude decides, use a PreToolUse hook instead").

**CLAUDE.md scopes, in load order (broadest → most specific):**

| Scope | Location |
|---|---|
| Managed policy | macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`; Linux/WSL `/etc/claude-code/CLAUDE.md`; Windows `C:\Program Files\ClaudeCode\CLAUDE.md` |
| User | `~/.claude/CLAUDE.md` |
| Project | `./CLAUDE.md` or `./.claude/CLAUDE.md` |
| Local | `./CLAUDE.local.md` (gitignore it) |

Resolution: walk **up** the directory tree from cwd, collecting `CLAUDE.md` and `CLAUDE.local.md`
at each level. All discovered files are **concatenated, not overridden**. Ordering is filesystem
root → cwd, so nearer files are read last; within a directory `CLAUDE.local.md` is appended after
`CLAUDE.md`. Files in **sub**directories are discovered but load **lazily**, only when Claude reads
a file in that subdirectory.

Imports: `@path/to/import` syntax, relative (to the importing file, not cwd) or absolute,
recursive to a **maximum depth of four hops**. Import parsing skips code spans and fenced blocks —
`` `@README` `` stays literal. Imports resolving outside the working directory trigger a one-time
approval dialog for project-scope files; user-scope imports load without a dialog.

Size guidance: target **under 200 lines** per CLAUDE.md; longer files consume context and reduce
adherence. Block-level HTML comments are stripped before injection (free maintainer notes).
CLAUDE.md is delivered "as a user message after the system prompt, not as part of the system prompt
itself."

`.claude/rules/`: modular markdown, recursively discovered. Without `paths` frontmatter they load
at launch with the same priority as `.claude/CLAUDE.md`. With YAML frontmatter
`paths: ["src/api/**/*.ts"]` they load **only when Claude reads a matching file**. Brace expansion
budget: 1,000 expanded patterns and 4 MiB per rule's whole `paths` list. `~/.claude/rules/` is the
user-level equivalent, loaded before project rules.

`claudeMdExcludes` (glob array, any settings layer, arrays merge) skips ancestor files in
monorepos; managed-policy CLAUDE.md **cannot** be excluded. `claudeMd` key inside
`managed-settings.json` inlines managed content.

`AGENTS.md`: Claude Code reads CLAUDE.md only; the recommended bridge is a `CLAUDE.md` containing
`@AGENTS.md` plus Claude-specific additions, or a symlink.

**Auto memory** (Claude writes it, you don't):
- On by default. Toggle in `/memory`, persisted as `autoMemoryEnabled` in `~/.claude/settings.json`;
  per-project override in that project's settings; env kill switch
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- Storage: `~/.claude/projects/<project>/memory/`, `<project>` derived from the **git repository**
  so all worktrees and subdirectories of one repo share one memory dir; outside a repo the project
  root is used. Overridable with `autoMemoryDirectory` (absolute or `~/`-prefixed; honored from a
  project settings file only after the workspace trust dialog).
- Layout: `MEMORY.md` index + arbitrary topic files (`debugging.md`, `api-conventions.md`, …).
- Load rule: **the first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first**, are
  loaded at every session start. Anything past that is silently dropped on load. Topic files are
  **not** loaded at startup — read on demand with normal file tools.
- Enforcement loop: after each write Claude Code measures `MEMORY.md`; near a limit it reminds
  Claude to shorten (one line per entry, move detail to topic files, merge/drop stale entries);
  over a limit the write succeeds but an error tells Claude to rewrite the index. Frontmatter and
  block-level HTML comments are stripped before measuring.
- `modified` frontmatter field: an ISO 8601 write timestamp added on write to files that already
  have frontmatter (never added to files without any).
- Memory files are **excluded from the `cleanupPeriodDays` transcript retention sweep**.
- Auto memory is machine-local; not synced across machines or cloud environments. Not inherited by
  subagents (except a fork); subagents get their own directory via the `memory` field.
- UI feedback strings: "Saved 2 memories", "Recalled 2 memories".
- `/memory` lists CLAUDE.md / CLAUDE.local.md across user and project scopes (including files that
  don't exist yet — selecting creates them), toggles auto memory, opens the auto memory folder.
  `/context` shows what actually loaded, under **Memory files**. `/init` generates a starting
  CLAUDE.md (suggests improvements rather than overwriting if one exists); `CLAUDE_CODE_NEW_INIT=1`
  makes it an interactive multi-phase flow that also reads `AGENTS.md`, `.cursor/rules/`,
  `.cursorrules`, `.github/copilot-instructions.md`, `.devin/rules/`, `.windsurf/rules/`,
  `.windsurfrules`, `.clinerules`.
- Compaction interaction: **project-root CLAUDE.md survives `/compact`** (re-read from disk and
  re-injected). Nested CLAUDE.md and `paths:`-scoped rules are **not** re-injected; they reload the
  next time a matching file is read.

---

## 3. Chat search across past conversations

Source: https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context

- Invoked **conversationally**, not through a UI search box: "What did we discuss about [topic]?",
  "Can you find our conversation about [subject]?"
- Mechanism: "These searches use Retrieval-Augmented Generation (RAG) and will appear as **tool
  calls** during your conversations." Results carry "citations linking back to the original chats,
  along with the option to delete specific conversations" inline.
- **Scope partitioning is strict:** searches cover "All chats outside of projects" *or*
  "Individual project conversations (searches are limited to within each specific project)."
  A project chat cannot reach non-project history and vice versa.
- Distinct from memory: this is a searchable archive, not persistent recall — nothing is
  pre-loaded into context.
- Control: Settings > Memory → **"Search and reference chats"** toggle (new experience), or
  Settings > Capabilities (legacy).
- Availability: paid plans (Pro, Max, Team, Enterprise) on web, Desktop, Mobile. Shipped
  Aug 11, 2025.
- [PARTIAL — search-snippet only, not confirmed by a fetched Anthropic page] The underlying tools
  are commonly reported as `conversation_search` (keyword/topic search across history) and
  `recent_chats` (recent conversation titles + last-active times). Treat the names as unverified.

---

## 4. Styles → Skills, and profile instructions

### 4.1 Profile instructions ("Instructions for Claude")

Source: https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features

Account-wide free text applied to **all** conversations. Accessed via the initials menu in the
lower-left. Intended contents per the docs: "Your preferred approaches or methods"; "Common terms
or concepts you use"; "Typical scenarios you encounter"; "General communication instructions."

### 4.2 Layering

Same source. Three (formerly) distinct layers, explicitly composable: "Use profile instructions for
account-wide settings... use project instructions when you need specific guidance... use styles
when you want to customize how Claude formats and delivers its responses. You can use these
features independently or in combination." **The docs give no explicit precedence order when the
layers conflict.** Do not invent one.

### 4.3 Styles have been replaced by Skills

The current personalization article no longer documents styles at all; where styles used to be it
now says **Skills**: "Skills add specific behaviors or capabilities to your conversations with
Claude," used to "Adjust the tone and format of Claude's responses" and "Apply communication
patterns based on your own writing or preferences."

[PARTIAL — from search snippets, article body unreachable] Help-center article 10181068 (formerly
"Configuring and using styles") is now titled "Styles are becoming Skills" / DE "Stile werden zu
Skills". Reported behavior: custom styles were auto-migrated into skills; **migrated skills are
disabled by default**; a migrated style is invoked in chat with `/{style-name}-style`; users who
don't want skills are told to describe the same tone/format/approach in their custom instructions
instead. The five preset styles (Normal, Learning, Concise, Explanatory, Formal) and the old
creation flow ("Use style" dropdown → "Create & edit styles" → "Create custom style" → "Add Writing
Example", i.e. style synthesis from a pasted writing sample) appear only in third-party pages.

### 4.4 Skills as the current styling/behavior mechanism

Sources: https://support.claude.com/en/articles/12512198-how-to-create-custom-skills,
https://support.claude.com/en/articles/12512180-use-skills-in-claude,
https://claude.com/resources/tutorials/teach-claude-your-way-of-working-using-skills

- Format: a folder containing `skill.md` with YAML frontmatter. Required fields: `name`
  (human-friendly, **max 64 characters**) and `description` (**max 200 characters**, explains
  purpose and when it applies). "The markdown body is the second level of detail after the
  metadata, so Claude will access this if needed after reading the metadata" — progressive
  disclosure: metadata always in context, body loaded on demand.
- Optional: resource files (e.g. `REFERENCE.md`) and executable `scripts/` (Python, JS/Node) with
  dependencies declared in metadata as e.g. `python>=3.8, pandas>=1.5.0`.
- Packaging: a ZIP whose **root is the skill folder**, not loose files.
  ```
  skill-name.zip
  └── skill-name/
      ├── skill.md
      ├── REFERENCE.md (optional)
      └── scripts (optional)
  ```
- **Skills require code execution to be enabled.** Free/Pro/Max: Settings > Capabilities, then
  Customize > Skills. Team/Enterprise: an owner enables it in Organization settings > Skills, then
  each user toggles in Customize > Skills.
- Invocation: automatic, matched against the `description` field ("Claude uses descriptions to
  decide when to invoke your skill. Be specific about when it applies"), or explicit ("Use my brand
  guidelines skill to create a presentation"). In M365 add-ins, typing `/` lists them.
- Management surface: Customize > Skills, split into Personal / Shared / Organization skills.
- Scope: "available in any conversation—regular chats, inside Projects, across all your work with
  Claude." Account-level, **not** per-project. No documented size or count limits.
- Warning in the docs: "Only install skills from trusted sources" — prompt-injection and
  data-exfiltration risk.
- Release notes: skills introduced **December 18, 2025**.

---

## 5. Incognito chats

Source: https://support.claude.com/en/articles/12260368-use-incognito-chats

- Entry: a **ghost icon** in the upper right when starting a new chat. UI while active: a **black
  border** around the chat and an "Incognito chat" label in the upper left. An "x" closes it.
- **Only available outside projects** — the ghost icon does not appear inside a project.
- Excluded from: chat history, memory entries, monthly recap, model training (all plans), and
  past-conversation search.
- Memory semantics are bidirectional: existing memory is **not loaded into** an incognito chat, and
  the incognito chat is **never written back** to memory.
- Profile-level settings (styles/skills, custom instructions) **still apply**.
- **Retention is not zero:** incognito chats "are retained for either 30 days (default), or longer
  in accordance with your organization's custom data retention setting (available for Enterprise
  plans)." They are hidden, not deleted.
- Once closed, an incognito chat **cannot be reopened**. Save anything you need first.
- All plans: Free, Pro, Max, Team, Enterprise.

---

## 6. Monthly recap (adjacent, memory-powered)

Source: https://support.claude.com/en/articles/15672559-see-your-monthly-recap

- Shows "how you've been using Claude—the topics you spent time on, when you tend to reach for it,"
  built "from your recent chats."
- **Depends on memory being on**; it disables automatically when "Generate memory from chat
  history" is toggled off in Settings > Capabilities.
- Includes web, Desktop, and mobile conversations, plus content Claude generated about connected
  services (e.g. Gmail/Drive summaries) — **not** the raw connected files.
- Excludes: incognito chats, health-integration conversations, Claude Cowork, Claude Code.
- Viewed at Settings > Reflect; ranges "this month so far, past 3 months, past 6 months, past year."
- Free, Pro, Max only, web + Desktop. Not on Team/Enterprise.

---

## 7. Vela reimplementation architecture

Vela's advantage: nearly all of this is client-side logic wrapped around an LLM. The only genuinely
Anthropic-server-side pieces in this area are (a) the RAG-mode retrieval index for project
knowledge, (b) the memory-generation pipeline that decides what to remember, (c) the past-chat RAG
index, (d) server-side compaction, (e) skill script execution in Anthropic's hosted code-execution
sandbox, and (f) org/plan gating. Each has a clean local substitute.

### 7.1 Storage substrate

One SQLite database plus a content-addressed blob dir under the Vela data directory:

```
~/.vela/
├── vela.db                     # SQLite + sqlite-vec (or FTS5-only if no embedder configured)
├── blobs/<sha256[0:2]>/<sha256>        # original uploaded files, deduped
├── projects/<project_id>/
│   ├── instructions.md                 # project instructions, plain markdown, user-editable
│   ├── knowledge/                      # extracted text per source doc
│   └── memory/                         # per-project memory dir (see 7.4)
│       ├── MEMORY.md
│       └── <topic>.md
├── memory/                             # global (non-project) memory dir
│   ├── MEMORY.md
│   └── <topic>.md
├── instructions.md                     # profile-level "Instructions for Vela"
└── skills/<skill-name>/SKILL.md        # + resources/, scripts/
```

Everything user-facing is **plain markdown on disk**. This is a hard design rule: it makes memory
auditable, editable in any editor, diffable, git-backupable, and syncable via the user's own
Dropbox/Syncthing — which is strictly better than Anthropic's Settings > Memory panel. SQLite holds
only derived data (chunks, embeddings, FTS index, chat transcripts, metadata) so it can be rebuilt
from disk at any time.

Encryption at rest: optional SQLCipher + age-encrypted blobs, keyed from the OS keychain. Needed
because Vela stores the same class of data Anthropic stores server-side, but on a laptop.

### 7.2 Projects — knowledge with a dual-mode retrieval planner

Reimplement the in-context/RAG switch faithfully, because it is the mechanic that makes projects
work well at small scale and survive at large scale.

**Ingestion pipeline (all local, no network):**
- PDF → PyMuPDF/pdfium text; page images rendered to PNG for the multimodal branch.
- DOCX/ODT/RTF/EPUB → python-docx / odfpy / pandoc → text.
- XLSX/CSV → openpyxl/pandas → markdown tables (do **not** gate this behind "code execution
  enabled" the way Anthropic does; there is no reason to).
- HTML → readability + html2text. JSON → pretty-printed.
- Images → keep as blobs; only send to the model if the configured backend advertises vision.
- Emit `{source_id, ordinal, text, page/sheet/heading anchor}` chunks, ~800–1200 tokens with
  ~15% overlap, split on heading/paragraph boundaries.

**Mirror the documented limits but make them settings, not constants.** Ship defaults matching
Claude (30 MB per project file, 500 MB per chat file, 20 files per chat, PDF multimodal ≤100 pages,
PDF hard stop at 1000 pages) and let the user raise them — a local machine has no per-tenant cost
model. Surface the file-type matrix in the UI so failures are predictable.

**Mode selection.** Compute `T_knowledge` (token count of all project knowledge, via the active
backend's tokenizer — llama.cpp `/tokenize`, tiktoken, or HF tokenizers, falling back to a
chars/3.6 estimate) against the *backend's actual context window* `C` (discovered from
`/v1/models`, the GGUF `n_ctx_train`, Ollama `/api/show`, or user override) minus a reserve for
system prompt, instructions, memory, live conversation, and `max_tokens`.

- If `T_knowledge <= 0.5 * C_available` → **in-context mode**: concatenate all knowledge into a
  single cached prefix block. Perfect recall, zero retrieval latency.
- Else → **RAG mode**: expose a `project_knowledge_search(query, top_k)` tool and inject only a
  manifest (filenames, sizes, one-line summaries) so the model knows what it can search for.
- Hysteresis: switch to RAG at 50%, switch back only below 40%, so editing one document doesn't
  thrash the prompt cache.
- Show the user a **capacity meter** ("Project knowledge: 62% of context — RAG mode active") and a
  manual override (Force in-context / Force RAG / Auto). Anthropic hides this; exposing it is a
  differentiator, since a local user with a 200K-context model and a 2K-context model needs
  different behavior from the same project.

**Local retrieval engine.** Hybrid, because pure vector search on a small local corpus is worse
than BM25:
- SQLite **FTS5** BM25 over chunk text.
- **sqlite-vec** (or usearch/hnswlib) over embeddings from a local embedder — bge-small-en-v1.5 /
  nomic-embed-text / gte-small via llama.cpp, Ollama `/api/embeddings`, or ONNX Runtime, all
  running fully offline. If the user's backend exposes `/v1/embeddings`, use it; if no embedder is
  available at all, **degrade to BM25-only** rather than failing — the whole feature must work with
  a bare llama.cpp completion endpoint.
- Fuse with Reciprocal Rank Fusion, optionally rerank top-50→top-8 with a local cross-encoder
  (bge-reranker-base) when the machine can afford it.
- Return chunks with `{source filename, page/heading anchor}` so Vela can render clickable
  citations back into the original document, matching Anthropic's citation UX.

**Prompt-cache preservation** matters far more locally than it does for Anthropic. Order the prompt
as: [profile instructions] → [project instructions] → [project knowledge or manifest] → [memory] →
[conversation]. Everything above the conversation is stable, so llama.cpp/vLLM prefix caching keeps
the KV cache warm and a 40K-token knowledge base costs prefill **once**. Re-ingesting one document
must invalidate only the tail of the block: keep documents in a stable sort order and append new
ones.

**Model-agnostic fallback for weak backends.** If the backend has no tool-calling support, RAG mode
must still work: run retrieval *before* the turn (query = the user's message, optionally rewritten
by a cheap local model) and inject the top-k chunks as context, i.e. classic pre-retrieval RAG. The
tool-calling path is an optimization, not a requirement. Detect capability by probing the backend
once and caching the result in the model profile.

**Project instructions**: a plain `instructions.md`. Do NOT send project name/description to the
model (matching Claude), but make that a visible checkbox since some users will want it.

**Project chat scoping**: chats carry a nullable `project_id`. Moving a chat in/out is an UPDATE
plus a reindex of its search partition.

**Archive/star/delete**: archive = a flag that hides the project and excludes it from search but
touches nothing on disk, so "everything is restored exactly as it was" is trivially true. Delete
requires unarchive first (copy Claude's guard rail) and offers "delete knowledge blobs too?".

**Sharing** is the one project feature with no local analogue — there is no org, no server, no
five-minute ACL propagation. Vela's substitute: **export a project as a portable bundle** —
`project.velaproj`, a ZIP containing `instructions.md`, `knowledge/` originals, a manifest, and
optionally `memory/` and selected chat transcripts, with a `permissions` hint (view/edit) that the
importing Vela honors as a UI default. For teams that want live sharing, point the project
directory at a shared folder or a git repo: git gives you history, diffs, and conflict resolution,
which is more than "Can view"/"Can edit" offers. Explicitly reproduce Claude's privacy rule in the
export dialog: knowledge and instructions are included by default, **chats are not** unless
individually selected.

### 7.3 Consumer-style memory on an arbitrary backend

Claude's memory is server-side because it runs a background extraction model over your chats. Vela
runs that same extraction against **whatever backend the user configured**, or optionally against a
small dedicated local model so memory extraction never burns paid API tokens.

**Data model** — match the July 2026 redesign: individual categorized entries, not one blob.

```sql
CREATE TABLE memory_entry(
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,          -- 'global' | 'project:<id>'
  category TEXT NOT NULL,       -- role_context | comms_prefs | tech_prefs | project_details | other
  content TEXT NOT NULL,
  created_at TEXT, updated_at TEXT,
  source_chat_id TEXT, source_message_id TEXT,   -- provenance -> "why do you know this?"
  confidence REAL, pinned INTEGER DEFAULT 0, embedding BLOB
);
```

Projection to disk: render entries into `memory/MEMORY.md` grouped by category after every write,
and parse that file back on external edit (watch it with a filesystem watcher). Disk is the source
of truth for the user; SQLite is the index.

**Capture — two interchangeable strategies, user-selectable per backend:**

1. **Tool-driven (strong backends).** Expose the exact `memory_20250818` command surface
   (`view`/`create`/`str_replace`/`insert`/`delete`/`rename`) over the `/memories` virtual root
   mapped to the scope's memory dir. Implement the documented return strings byte-for-byte,
   including the 6-char right-aligned line numbers, the `up to 2 levels deep` listing header, the
   16,000-character view truncation, and the 999,999-line error. Two reasons to be literal: any
   model fine-tuned on Anthropic's format works out of the box, and the strings are already
   battle-tested prompts. Inject Anthropic's MEMORY PROTOCOL text yourself (Vela is the API client,
   so nothing auto-injects it).
2. **Post-turn extraction (weak/small/no-tool backends).** After a turn completes, run an
   asynchronous second pass: feed the last N messages plus the current entry list to the extraction
   model with a strict JSON-schema-constrained output (GBNF grammar on llama.cpp, `format: json` on
   Ollama, `response_format` on OpenAI-compatible servers) producing
   `{add: [...], update: [{id, content}], delete: [id]}`. This makes memory work on a 3B model.
   Run it on a background thread; never block the UI.

Either way, apply Claude's selectivity rule explicitly in the extraction prompt: save only what
would be useful in a *future* conversation, not everything mentioned. Dedupe new entries against
existing ones by embedding cosine similarity (>0.9 → merge/update instead of insert).

**Scoping** matches Claude exactly: a chat inside project P reads/writes `project:P` memory only;
a chat outside projects reads/writes `global` only. No leakage in either direction. Add a Vela
extra: an optional per-entry "promote to global" action, since local users often want one fact
everywhere.

**Editing surfaces** — three, all equivalent:
- Settings > Memory list, per entry: inline edit, a "Tell Vela what to change" natural-language box
  (routed to the extraction model with the entry as context), Delete, Pin.
- Conversational: "remember that I use pnpm" writes immediately and shows a "Saved 1 memory" chip.
- Direct file edit of `MEMORY.md` in any editor; the watcher reparses.

**Disable semantics** — copy both options precisely:
- **Pause**: stop reading *and* writing; the paused window is deliberately not backfilled when
  resumed (match Claude, and say so in the UI so behavior isn't surprising).
- **Reset**: delete all entries in all scopes including project memory. Because this is destructive
  and local, Vela should first write a timestamped `memory-backup-<ts>.md` next to the store and
  tell the user where it is — a strict improvement over an irreversible server-side wipe.
- Per-project toggle as well, since projects have separate memory.

**Injection budget.** Never let memory eat the context of a 4K-context local model. Enforce
Claude Code's rule: load at most **the first 200 lines or 25KB of `MEMORY.md`**, whichever comes
first, scaled down proportionally for small context windows (e.g. cap memory at 5% of `C`). When
the index exceeds the budget, run the same self-maintenance loop Claude Code uses: tell the model
to compress to one line per entry and move detail into topic files, which are read on demand via
the memory tool. For scoring which entries to include when over budget, rank by
`pinned > recency > embedding similarity to the current turn`.

**Import/export.** Implement Claude's exact interchange format so users can move both directions:
export a Markdown file whose entries are a single fenced code block of
`[YYYY-MM-DD] - memory content` lines; import accepts that same paste (or a file) and runs it
through the extraction model into individual entries. Ship the same extraction prompt Anthropic
publishes so users can pull memory out of ChatGPT/Gemini/etc. Additionally offer a lossless
JSON export (full `memory_entry` rows with provenance), which Anthropic does not offer and which
makes Vela the better custodian of the user's own data. Drop Anthropic's work-only bias: it is a
server-side content policy, not a technical constraint, and a local-first app should keep whatever
the user asks it to keep. Make the bias a toggle ("work context only") rather than a hardcode.

### 7.4 Project-scoped agent memory (the Claude Code model)

For Vela's coding/agent mode, mirror Claude Code's split directly, since it is already fully
client-side and therefore 1:1 portable:

- **VELA.md** files (accept `CLAUDE.md` and `AGENTS.md` as aliases — reading a repo's existing
  `AGENTS.md` is free interop) at four scopes: managed policy path, `~/.vela/VELA.md`,
  `./VELA.md` or `./.vela/VELA.md`, and `./VELA.local.md`. Walk up from cwd, concatenate root→cwd,
  append `.local.md` after the base file at each level, lazy-load subdirectory files when a file in
  that subdirectory is read.
- `@path` imports, relative-to-importing-file, **max depth 4**, skipping code spans and fenced
  blocks, with the one-time approval dialog for project-scope imports that resolve outside the
  working directory.
- `.vela/rules/*.md` with optional `paths:` glob frontmatter for lazy, path-scoped loading; bound
  brace expansion (1,000 patterns / 4 MiB) so a pathological pattern can't hang startup.
- Strip block-level HTML comments before injection.
- Auto memory at `~/.vela/projects/<repo-hash>/memory/` keyed on the **git repo root** so worktrees
  share one store; `MEMORY.md` index + topic files; 200-line/25KB load cap with the post-write
  measure-and-nag loop; `modified:` ISO-8601 frontmatter stamp on write.
- Commands: `/memory` (browse, open in `$EDITOR`, toggle auto memory), `/context` (show what
  actually loaded), `/init` (generate VELA.md from a codebase scan, importing `.cursorrules`,
  `.github/copilot-instructions.md`, `.windsurfrules`, `.clinerules`, `AGENTS.md`).
- Exclude memory files from any transcript-retention cleanup sweep.
- Re-inject project-root VELA.md after compaction; do not re-inject nested/path-scoped files.
- Say the quiet part in the docs, as Anthropic does: these files are **context, not enforcement**.
  For hard guarantees Vela needs a PreToolUse-equivalent hook layer.

### 7.5 Chat search across past conversations

Fully local and, honestly, better than the hosted version because there is no plan gate and no
30-day anything.

- Index every message into FTS5 at write time; embed messages (or per-conversation rolling
  summaries, cheaper) into sqlite-vec on a background queue.
- Expose two tools mirroring the reported Anthropic surface:
  `conversation_search(query, scope, limit)` and `recent_chats(n, before, after)`. Keep those exact
  names — if a model has seen Anthropic's schema, it will call them correctly with no prompting.
- **Enforce the same partitioning:** a chat inside project P searches only project P's chats; a
  chat outside projects searches only non-project chats. Add a user-visible "search everything"
  escape hatch, off by default.
- Return `{chat_id, title, timestamp, snippet}` and render inline citations that deep-link to the
  message, plus an inline delete affordance — Claude does this and it is cheap.
- Hybrid BM25 + vector with RRF, same engine as project knowledge; reuse the code path.
- No-tool-calling fallback: a real search box in the UI, plus optional automatic pre-retrieval when
  the user's message contains referential language ("what did we decide about…", "the thing from
  last week") detected by a cheap classifier or regex heuristic.
- Never index incognito chats (see 7.7).
- Settings toggle "Search and reference chats", matching Claude's control, plus per-project opt-out.

### 7.6 Styles / skills / instruction layering

- **Profile instructions**: `~/.vela/instructions.md`, injected into every conversation's system
  prompt.
- **Project instructions**: `projects/<id>/instructions.md`, injected only for that project's chats.
- **Styles**: Vela should implement styles as *presets over a skill-like file*, honoring both the
  old and new Anthropic worlds. Ship built-in presets (Normal/Concise/Explanatory/Formal/Learning
  are reasonable defaults, though note their names are unverified from official docs) as editable
  markdown files in `~/.vela/styles/`, and implement **style synthesis from a writing sample**:
  paste 1–3 samples, run a local extraction prompt that produces an explicit style rubric
  (sentence length, vocabulary register, formatting habits, hedging, use of lists/headers), save it
  as an editable file. Doing this locally is a real win — the sample never leaves the machine.
- **Skills**: adopt Anthropic's exact `SKILL.md` format — YAML frontmatter with `name` (≤64 chars)
  and `description` (≤200 chars), markdown body, optional `resources/` and `scripts/`, distributed
  as a ZIP rooted at the skill folder. Compatibility with the published format means the entire
  public skills ecosystem works in Vela unmodified.
  - **Progressive disclosure**: inject only `name` + `description` for every enabled skill into the
    system prompt; load the body only when triggered. On a small local model, cap the number of
    advertised skills and let the user pin which are visible per project, because 40 descriptions
    will drown a 4K context.
  - **Triggering**: description-matched automatic invocation for tool-calling backends; explicit
    `/skill-name` slash commands always available (this also covers the migrated-style
    `/{name}-style` convention); and for weak backends, a pre-turn local embedding match between
    the user message and skill descriptions that injects the top-1 body.
  - **Script execution is where Anthropic is server-side.** Anthropic runs skill scripts in a
    hosted code-execution sandbox (and gates skills behind "code execution enabled"). Vela's
    substitute: a **local sandbox** — Docker/Podman container, or `bubblewrap`/`firejail` on Linux,
    Seatbelt (`sandbox-exec`) on macOS, and a restricted job object / AppContainer on Windows — with
    no network by default, a read-only skill directory, a writable scratch mount, and CPU/memory/
    wall-clock limits. Dependencies declared in skill metadata resolve into a per-skill `uv`/venv or
    a prebuilt image. Same substitute covers document-producing skills: `python-docx`, `openpyxl`,
    `python-pptx`, `pypdf`/`reportlab` run locally instead of in Anthropic's file-creation sandbox.
    Show the user exactly what a skill will execute before first run, and require explicit
    per-skill approval — Anthropic's own docs warn about prompt injection and exfiltration, and a
    local sandbox with filesystem access raises the stakes.
- **Precedence**: Anthropic never documents a conflict order. Vela should document one explicitly
  (managed policy > project instructions > profile instructions > active style/skill > memory) and
  show the assembled system prompt in a "Show context" inspector. A local app can afford total
  transparency here; a hosted one can't.

### 7.7 Incognito

Purely client-side, and Vela can be strictly stronger than Claude, whose incognito chats are still
**retained 30 days server-side**.

- Ghost-icon toggle on a new chat; distinct chrome (border + "Incognito" label) so the state is
  never ambiguous. Match Claude's restriction of "not inside a project", or relax it to
  "incognito-within-project" (reads project knowledge/instructions, writes nothing) — a genuine
  improvement, but make it an explicit, clearly-labelled mode.
- Behavior: memory not read, memory not written, chat not persisted to `vela.db`, not indexed into
  FTS5/vec, excluded from recap/analytics. Profile instructions and styles still apply, matching
  Claude.
- **Vela's stronger guarantee**: hold the transcript in memory only, back it with an encrypted
  ephemeral tmpfs/OS-temp file if it must spill, and shred on close. Retention is genuinely **zero**,
  not 30 days. Say so in the UI — it is a concrete privacy advantage of local-first.
- Preserve the "cannot be reopened" semantics and warn before close, with a one-click "Save this
  chat to history" escape hatch that Claude lacks.
- Also suppress: telemetry, crash-report inclusion, and any backend that logs (warn the user if
  their configured backend is a remote API with a retention policy Vela cannot control — incognito
  protects Vela's storage, not a third-party provider's).

### 7.8 Recap

Trivial locally: a scheduled local job that aggregates chat metadata (counts, timestamps, per-topic
clustering over conversation-summary embeddings) and asks the configured model for a narrative
summary. Excludes incognito chats by construction. No plan gate. Available offline. Render as a
local HTML page rather than a server-hosted view.

### 7.9 Explicit server-side → local substitution table

| Anthropic capability | Where it runs | Vela local substitute |
|---|---|---|
| Project knowledge RAG index and `project knowledge search` tool | ANTHROPIC_SERVER_SIDE (undisclosed embedder + vector store) | SQLite FTS5 + sqlite-vec, local embedder (bge/nomic/gte via llama.cpp/Ollama/ONNX), RRF hybrid, optional local cross-encoder rerank; BM25-only degradation when no embedder exists |
| Automatic in-context ↔ RAG mode switch at the context limit | ANTHROPIC_SERVER_SIDE | Local token counter against the *backend's discovered* context window, 50%/40% hysteresis, user-visible capacity meter + manual override |
| Memory generation ("decides what's worth remembering") | ANTHROPIC_SERVER_SIDE background pipeline | Local post-turn extraction pass with JSON-schema/GBNF-constrained output, or the client-side `memory_20250818` tool loop for tool-capable backends |
| Memory storage / Settings > Memory panel | ANTHROPIC_SERVER_SIDE | Plain markdown `MEMORY.md` + topic files on disk, indexed in SQLite; editable in any editor |
| Memory import extraction | ANTHROPIC_SERVER_SIDE | Same extraction pass, run locally; identical `[date] - content` interchange format for portability |
| Past-chat RAG index | ANTHROPIC_SERVER_SIDE | Local FTS5 + vec over the transcript store, same `conversation_search`/`recent_chats` tool names |
| Server-side compaction near the context limit | ANTHROPIC_SERVER_SIDE | Local rolling summarization + client-side context editing (drop old tool results), with memory as the durable spillover |
| Skill script execution / file creation sandbox | ANTHROPIC_SERVER_SIDE | Docker/Podman, bubblewrap/firejail, macOS `sandbox-exec`, Windows AppContainer; no network by default; python-docx / openpyxl / python-pptx / reportlab locally |
| Project sharing, org visibility, group ACLs, 5-minute propagation | ANTHROPIC_SERVER_SIDE | `.velaproj` export bundles; shared folder or git-backed project directories; permission hints as UI defaults |
| 30-day incognito retention | ANTHROPIC_SERVER_SIDE | Zero retention: RAM-only transcript, shredded on close |
| Plan gates (5 projects free, paid-only chat search, etc.) | ANTHROPIC_SERVER_SIDE billing | Not reimplemented. All features unconditional. |
| CLAUDE.md / auto memory (Claude Code) | CLIENT_SIDE_PORTABLE already | Port 1:1 as VELA.md + `~/.vela/projects/<repo>/memory/`, with `CLAUDE.md`/`AGENTS.md` read compatibility |
| `memory_20250818` tool contract | CLIENT_SIDE_PORTABLE by design | Implement the six commands and the exact return strings; add path-traversal validation, size caps, and expiry as the docs require |
