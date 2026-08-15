/**
 * **Every guard this repo's comments claim exists, resolved against the tree.**
 *
 * The project's central defect class is "the thing everyone believed was
 * connected, was not". Its documentation-shaped form is a comment naming the
 * test that supposedly holds an invariant, where no such test exists. That is
 * worse than an unguarded invariant: a missing guard is a hole, a *claimed*
 * guard is a trap, because every later builder reads the claim and builds on it.
 *
 * It has happened repeatedly. `src-tauri/src/lib.rs` said "`cargo test` enforces
 * it" when nothing did (closed by `src-tauri/tests/handler_binding.rs`). The
 * sweep for siblings that followed missed `contract.ts`, which named
 * `chat-contract-parity.test.ts` — a file that had never been written in any
 * commit. Fixing those one at a time is how the tenth one gets missed too, so
 * this file resolves the whole class mechanically:
 *
 * 1. **Rust intra-doc links.** `[`some_test_name`]` in a doc comment is this
 *    repo's house style for "and that one is held by this". Every one must name
 *    a real item. Nothing else catches these: rustdoc's broken-link lint is not
 *    part of `pnpm verify`, and `cargo test` never reads a doc link.
 * 2. **File paths.** Every backticked token that looks like a path into this
 *    repo must exist on disk. A bare filename resolves anywhere in the tree; a
 *    token that spells out a directory must match a real path or a real tail of
 *    one, because naming a directory is a stronger statement than naming a file.
 * 3. **Named tests.** Test names here are sentences — `every_variant_is_listed_in_all`.
 *    Every backticked snake_case identifier of two or more words must resolve to
 *    a Rust item, an integration-test file, a shell test label, a TypeScript
 *    declaration, a wire token this tree sends, or a name in
 *    {@link FOREIGN_NAMES} — vocabulary that belongs to somebody else's system,
 *    so nothing here could ever define it. There is no general case. Every route
 *    is a lookup into a list of things that were found, or written down by hand.
 *
 * The body of a code fence is excluded from all three: it is an illustration, so
 * it makes no claim.
 *
 * ## The mechanism that used to be here, and the measurement that removed it
 *
 * Rule (3) had one more route, `codeVocabulary`: a name resolved if it was *used
 * as code* anywhere in the tree, on the theory that a fabricated name appears
 * only inside its own claim. The theory is right. Implementing "as code" is what
 * was not — it needs comments and string bodies removed first, and doing that
 * honestly meant a hand-written character scanner for six languages, some
 * hundred and fifty lines of lexing living in a test file.
 *
 * A critic failed it six times, and every finding was the same defect: a
 * construct the scanner mis-lexes flips quote parity, so a string or comment body
 * is emitted as code and a fabricated guard name resolves green. Any prose at
 * all; then line classification; then multi-line strings; then Rust char
 * literals; then nested template literals; then shell apostrophes. The blast
 * radius shrank every round and the kind never changed, and the list of open
 * cases never emptied — shell heredocs, `$'…'`, `${var//x/y}`, TOML `"""…"""`,
 * YAML block scalars and CSS `url()` were all still standing when it went.
 * Being correct there meant real lexers for six languages, in a test.
 *
 * So the branch was switched off and the guard run over the whole tree, to find
 * out what it was buying. **Exactly eleven names stopped resolving** — none of
 * them a test, and not one of them a name this file was written to catch. Three
 * `std` functions, three serde attribute keys, one GitHub Actions trigger and
 * one wire field of the mock harness are foreign vocabulary, and are now written
 * down by name in {@link FOREIGN_NAMES} with the system each belongs to. The
 * other three are ordinary Rust `let` bindings and a function parameter, and
 * {@link rustItems} now reads those as the items they are. (A different eleven
 * from the eleven-site ledger {@link SENTENCE_NAME} is about. The collision is
 * unfortunate and real.)
 *
 * A ninth name, `snake_case`, joined {@link FOREIGN_NAMES} in the same commit
 * for a different reason: not the scanner leaving, but the coarse comment strip
 * that replaced it in {@link wireTokensAndMethods}. It is written up there.
 *
 * Nine named facts and one widened item pattern, in place of a lexer that lost
 * six times out of six. Someone will want to put a cleverer version back: that
 * ledger is the price it has to beat, and the standard it has to meet is that a
 * reviewer can tell what the rule accepts by reading it. A rule that can only be
 * checked by running it is a claim about a scanner, and claims are the subject
 * of this file.
 *
 * ## This file has been wrong before
 *
 * Both of the shapes in (2) and (3) are corrections, and both were found by
 * measuring rather than reading. The name floor was four words, which would have
 * missed two of the eleven sites this file generalises; the path rule fell back
 * to the basename, so `src/app/contract.ts` resolved off the real
 * `src/platform/contract.ts`. Every one of those repairs is pinned by a control
 * in `this guard is not vacuous` below. A guard nobody has watched fail is a
 * claim, which is the thing this file exists to catch.
 *
 * ## Scope, and why it is drawn here
 *
 * Source, the harness, the scripts, and the two docs builders are told to treat
 * as binding. **Not** `docs/regression-baseline/`, `docs/desktop-gate/` or
 * `docs/spec-parts/`: the first two are records of what was true at a past
 * commit — a verdict that names the file a defect used to live in is correct
 * history, not a stale claim — and the third is an unbuilt product spec whose
 * backticks are mostly other vendors' API fields.
 *
 * ## When this fails
 *
 * Do not add to {@link ILLUSTRATIVE}, and do not add to {@link FOREIGN_NAMES}
 * unless the name really is somebody else's and you can say whose. Either the
 * named thing should exist, in which case write it, or the comment should say
 * what is actually guaranteed, in which case fix the sentence.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = process.cwd();

/** Regenerated or vendored. `src-tauri/target` alone is tens of gigabytes. */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.vite',
  'coverage',
  'dist',
  'gen',
  'node_modules',
  'target',
  'pw-browsers',
]);

/** Where a *live* claim can live. See the scope note above. */
const CLAIM_ROOTS = [
  'src',
  'src-tauri',
  'tests',
  'scripts',
  '.github',
  join('docs', 'architecture'),
  join('docs', 'vela-progress.md'),
];

const SCANNED_EXTENSIONS = [
  '.rs',
  '.ts',
  '.tsx',
  '.css',
  '.md',
  '.sh',
  '.mjs',
  '.js',
  '.yml',
  '.toml',
];

/**
 * Backticked tokens that are deliberately not files.
 *
 * Two kinds, and both are narrow on purpose. **Shapes**: a naming pattern or a
 * worked example, where writing the file would not make the sentence true.
 * **History**: a filename that a comment names *because it is gone* — the
 * removed half of the `Markdown.tsx`/`markdown.ts` case collision is discussed
 * by five files that would be unreadable if they could not say the old name.
 *
 * A claim about a guard is never in here. If a test is named, it exists.
 */
const ILLUSTRATIVE = new Set([
  // shapes
  'PascalCase.tsx',
  'kebab-case.ts',
  'use-thing.ts',
  'ComponentName.module.css',
  'Component.module.css',
  'foo.ts',
  'foo.json',
  '.module.css',
  'src/tests_helper.rs',
  // history
  'Markdown.ts',
  'markdown.ts',
]);

/** Crate roots that live outside this workspace, so no local item can match. */
const EXTERNAL_CRATES = new Set([
  'std',
  'core',
  'alloc',
  'serde',
  'serde_json',
  'tokio',
  'reqwest',
  'thiserror',
  'tauri',
  'rusqlite',
  'keyring',
  'url',
  'http',
  'syn',
  'chrono',
  'uuid',
  'hyper_util',
  'futures',
  'gtk',
  'char',
]);

/**
 * **Sentence-shaped vocabulary this tree does not own.**
 *
 * {@link EXTERNAL_CRATES} covers a foreign *root*, where the `::` says whose the
 * name is. These have no root to give them away: they are bare names that read
 * exactly like one of this repo's test sentences and belong to somebody else's
 * system, so no item here could ever define one and no corpus will ever find it.
 *
 * Every entry is one reviewable decision with its owner stated. That is the
 * trade this file made when it deleted the scanner that used to resolve these by
 * inference — see the header. Eight of the names below are the whole measured
 * cost of that deletion, and the point is that you can audit them by reading.
 *
 * A claim about a guard is never in here. If a test is named, it exists.
 */
const FOREIGN_NAMES = new Set([
  // Rustdoc's own code-fence directive. `` ```compile_fail `` is an instruction
  // to the doctest compiler, and it is discussed by eight comments across the
  // repo. Named here rather than rescued by an exception wherever fences are
  // recognised, because an exception is a hole a fabricated name can climb
  // through and a name here is just a fact about rustdoc.
  //
  // Its five siblings — `should_panic`, `no_run`, `ignore` and the two edition
  // directives — were here too, and are gone. No claim in the tree used them, so
  // they were a guess about what a future comment might say. A critic that had
  // just passed this list flagged them as the one place it departed from
  // "written down because it was found", and an allowlist entry nobody needs is
  // a standing invitation to add the next one on the same reasoning. If a
  // comment ever names one, the guard says so and it comes back with evidence.
  'compile_fail',

  // `std`. Comments name these to say what a call does — `create_dir_all` for
  // the recursive mkdir, `set_var`/`remove_var` for the process environment the
  // provider tests manipulate.
  'create_dir_all',
  'set_var',
  'remove_var',

  // serde's attribute keys, written inside `#[serde(…)]` and then discussed in
  // the prose around it. serde defines them; a derive expands them.
  'rename_all',
  'rename_all_fields',
  'skip_serializing_if',

  // GitHub Actions' manual workflow trigger, at `.github/workflows/ci.yml:9`.
  // A key in GitHub's schema, not a name this workspace declares.
  'workflow_dispatch',

  // The mock harness's own wire field. `tests/harness/mock-provider` puts a
  // `vela_mock` block into `/health` and `/props` so a recorded transcript says
  // which profile served it. It is a JSON key in a response body — data on a
  // socket — even though the server on the other end is ours.
  'vela_mock',

  // A naming convention, not an identifier. `conventions.md:136` writes
  // "Modules `snake_case`, types `PascalCase`" and `wire-types.ts:4` says its
  // fields are `snake_case` on purpose; both mean the shape of a name, and
  // neither is claiming a test. serde owns it as a `rename_all` value too.
  //
  // This is the ninth name, and it is here for an honest reason worth writing
  // down. It is *not* one of the eleven the header measured: until this commit
  // it resolved because `#[serde(rename_all = "snake_case")]` exists in
  // `diagnostic.rs` and the wire-token collector read that attribute line. The
  // aggressive comment strip in {@link wireTokensAndMethods} now drops every
  // line beginning `#`, attributes included, so the accident stopped happening
  // and the claim went loud — which is the asymmetry working exactly as
  // described. Vouched by a serde attribute's spelling was never a fact anyone
  // had decided; this line is.
  'snake_case',

  // The Linux kernel's. `cgroup.subtree_control` is the cgroup-v2 interface
  // file a parent writes `+pids` into so `pids.max` exists in its children at
  // all; `vela-sandbox/src/wsl.rs:213,404` names it twice while stating what
  // the sandbox costs the host. Documented at
  // `Documentation/admin-guide/cgroup-v2.rst` in the kernel tree, which is the
  // whole point: nothing in this workspace could ever declare it, and the
  // comments naming it are describing somebody else's filesystem.
  //
  // The tenth name, and the first that arrived by merge rather than by the
  // measurement in the header. It went loud the moment `fix/sandbox-process-
  // limit` landed, which is the asymmetry working: a kernel filename spelled in
  // backticks is indistinguishable from a claimed test until someone says whose
  // it is.
  'subtree_control',
]);

/** Trait and derive names that resolve in rustdoc via the prelude, not this tree. */
const PRELUDE_ITEMS = new Set([
  'Default',
  'Ord',
  'Eq',
  'Serialize',
  'Deserialize',
  'Debug',
  'Display',
  'From',
  'Into',
]);

/* -------------------------------------------------------------------------- */
/* the tree                                                                   */
/* -------------------------------------------------------------------------- */

function walk(directory: string, found: string[]): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      walk(join(directory, entry.name), found);
    } else if (entry.isFile()) {
      found.push(join(directory, entry.name));
    }
  }
  return found;
}

const ALL_FILES = walk(REPO, []).map((path) => relative(REPO, path).split(sep).join('/'));
const FILE_SET = new Set(ALL_FILES);
const BASENAMES = new Set(ALL_FILES.map((path) => path.slice(path.lastIndexOf('/') + 1)));
const DIRECTORIES = new Set(
  ALL_FILES.flatMap((path) => {
    const parts = path.split('/');
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
  }),
);

function inClaimScope(path: string): boolean {
  return CLAIM_ROOTS.some((root) => {
    const posix = root.split(sep).join('/');
    return path === posix || path.startsWith(`${posix}/`);
  });
}

/**
 * This file is excluded from its own scan: its control corpus contains
 * deliberately fabricated names, which is the whole point of a control. The
 * resolver still runs over that corpus — see the last test — it just does not
 * run over it *as tree content*.
 */
const SELF = 'src/platform/claimed-guards.test.ts';

const SCANNED = ALL_FILES.filter(
  (path) =>
    path !== SELF && inClaimScope(path) && SCANNED_EXTENSIONS.some((ext) => path.endsWith(ext)),
);

const CONTENTS = new Map(SCANNED.map((path) => [path, readFileSync(join(REPO, path), 'utf8')]));

/* -------------------------------------------------------------------------- */
/* what actually exists                                                       */
/* -------------------------------------------------------------------------- */

/** First capture group of every match. `matchAll` types groups as optional. */
function* captured(text: string, pattern: RegExp): Generator<string> {
  for (const match of text.matchAll(pattern)) {
    const value = match[1];
    if (value !== undefined) yield value;
  }
}

/** Every Rust item a doc link could legitimately point at. */
function rustItems(): ReadonlySet<string> {
  const items = new Set<string>();
  for (const [path, text] of CONTENTS) {
    if (!path.endsWith('.rs')) continue;
    for (const name of captured(text, /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g)) items.add(name);
    for (const name of captured(
      text,
      /\b(?:struct|enum|trait|type|const|static|union|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    )) {
      items.add(name);
    }
    // Enum variants and struct fields: both are things a doc comment names.
    for (const name of captured(text, /^\s{4,}([A-Z][A-Za-z0-9]*)\s*[,({]/gm)) items.add(name);
    for (const name of captured(
      text,
      /^\s{4,}(?:pub(?:\([a-z]+\))?\s+)?([a-z_][a-z0-9_]*)\s*:/gm,
    )) {
      items.add(name);
    }
    // Local bindings and function parameters, which a comment names as freely as
    // it names a field: `wire.rs:183` binds `may_force` and then explains it
    // fifty lines later, `wire_redirect_egress.rs:236` writes a paragraph about
    // why `asked_for` is called that, and `zz_gate_m_round4_executor_probe.rs`
    // documents the `fragment_at` parameter of its echo server. Those three are
    // the local half of the eleven in the header. They are real Rust items, so
    // reading them as items is the truthful route — the alternative was calling
    // them foreign, which they are not.
    for (const name of captured(text, /\blet\s+(?:mut\s+)?([a-z_][a-z0-9_]*)\s*[:=;]/g)) {
      items.add(name);
    }
    for (const parameters of captured(
      text,
      /\bfn\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:<[^(]*>)?\s*\(([^)]*)\)/g,
    )) {
      for (const name of captured(parameters, /(?:^|,)\s*(?:mut\s+)?([a-z_][a-z0-9_]*)\s*:/g)) {
        items.add(name);
      }
    }
  }
  return items;
}

/**
 * A line that is prose rather than code, by its first non-space characters.
 * Declared here because both the corpus below and the claim scan further down
 * need it, and the corpora are built first.
 */
const COMMENT_LINE = /^\s*(\/\/[/!]?|\*|\/\*|#|\|)/;

/** Whatever follows `//`, in any language where `//` opens a comment. */
const TRAILING_SLASH_COMMENT = /\/\/.*$/;

/** Whatever follows `#`, in the languages where `#` opens one. */
const TRAILING_HASH_COMMENT = /#.*$/;

/**
 * Sentence-shaped tokens that are *data*, not claims: a wire token an endpoint
 * sends (`"model_context_window_exceeded"` is Anthropic's), or a method this
 * tree calls on somebody else's type (`url.port_or_known_default()`). Both look
 * exactly like a test name and neither is one.
 *
 * The floor here is one word, matching {@link SENTENCE_NAME}. The two were
 * coupled and both sat at four: lowering the claim detector without lowering
 * this would have turned every three-word wire token into a fresh false
 * positive.
 *
 * **Code lines only, and that is the whole of it.** This repo's convention for a
 * name that does *not* exist is to write it in straight quotes rather than
 * backticks — the eleven-site ledger does it on nine rows. Collecting quoted
 * strings out of prose therefore meant every deliberately-dead name became
 * evidence that it was alive, and the next comment to backtick it would resolve
 * green. The convention for retiring a name cannot also be the mechanism that
 * revives it.
 *
 * ## Two regexes, and both err aggressive on purpose
 *
 * A line whose first non-space characters are a comment marker is dropped
 * whole; whatever follows `//` — or `#`, in `.sh`, `.yml` and `.toml` — is cut
 * off the rest. That is not a lexer and does not pretend to be one. It cuts at
 * the `//` inside a URL, it cuts at a `#` inside a quoted string, and because
 * `#` is a leading marker it throws away every Rust attribute line, `#[serde(…)]`
 * included.
 *
 * All of that is affordable because the two failures do not cost the same.
 * Over-stripping loses a wire token, so some claim stops resolving and this
 * guard says so by name. Under-stripping lets a comment's own quoted name vouch
 * for the name that comment claims — which is exactly how `#[doc = "…"]`, a
 * comment written as an attribute, once laundered a fabricated name past here —
 * and the guard says nothing whatsoever. One failure argues with you; the other
 * lies to you. When the errors are that asymmetric, precision is not worth
 * buying, and buying it is what put a six-language scanner in this file for six
 * rounds. See the header.
 */
function wireTokensAndMethods(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [path, text] of CONTENTS) {
    if (path.endsWith('.md')) continue;
    const hashComments = /\.(sh|yml|toml)$/.test(path);
    for (const raw of text.split(/\r?\n/)) {
      if (COMMENT_LINE.test(raw)) continue;
      const stripped = raw.replace(TRAILING_SLASH_COMMENT, '');
      const line = hashComments ? stripped.replace(TRAILING_HASH_COMMENT, '') : stripped;
      if (line.trim() === '') continue;
      // Both quote characters, because this repo's TypeScript writes its string
      // literals in single quotes and its Rust in double. Reading only double
      // quotes meant every command name in `contract.ts` and the three frozen
      // contracts — `'sandbox_submit'`, `'project_create'` — was invisible here
      // while being a perfectly real declaration one line away, and the guard
      // reported thirty-four of them the moment those contracts merged. The rule
      // is unchanged and it is the rule that matters: the **entire** quoted
      // content must be one snake_case token, which is what a wire name, a
      // config key and a shell `pass "label"` look like, and which a sentence
      // never is. Comment lines and trailing comments are already gone above, so
      // this reads string literals in code and nothing else.
      for (const name of captured(line, /"([a-z][a-z0-9]*(?:_[a-z0-9]+){1,})"/g)) names.add(name);
      for (const name of captured(line, /'([a-z][a-z0-9]*(?:_[a-z0-9]+){1,})'/g)) names.add(name);
      for (const name of captured(line, /\.([a-z][a-z0-9]*(?:_[a-z0-9]+){1,})\s*\(/g))
        names.add(name);
    }
  }
  return names;
}

/**
 * ` ```rust `, ` ```compile_fail `, or a bare ` ``` ` — inside a doc comment or
 * not, since Rust writes its fences inside `///`.
 *
 * A line carrying an **even** number of ` ``` ` opens and closes on itself: it is
 * prose *about* a fence, not a fence. `emulation.rs:354` is exactly that —
 * `/// \`\`\`json { … } \`\`\` or the same object bare.` — and reading it as an
 * opener left the claim scan believing it was inside a code block for the
 * remaining three hundred lines of the file, which were then silently exempt
 * from every check here.
 */
const FENCE_MARKER = /^\s*(?:\/\/[/!]?|\*|#)?\s*```/;

/** Shell test labels — `pass "name: …"` / `fail "name" …` in the script tests. */
function shellLabels(): ReadonlySet<string> {
  const labels = new Set<string>();
  for (const [path, text] of CONTENTS) {
    if (!path.endsWith('.sh')) continue;
    for (const name of captured(text, /\b(?:pass|fail)\s+"([a-z_][a-z0-9_]*)/g)) labels.add(name);
  }
  return labels;
}

/** TypeScript declarations and vitest case names. */
function typescriptNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [path, text] of CONTENTS) {
    if (!/\.(ts|tsx|mjs|js)$/.test(path)) continue;
    for (const name of captured(
      text,
      /\b(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    )) {
      names.add(name);
    }
    for (const name of captured(text, /\b(?:it|test|describe)\(\s*['"]([^'"]+)/g)) names.add(name);
  }
  return names;
}

const RUST_ITEMS = rustItems();
const SHELL_LABELS = shellLabels();
const TS_NAMES = typescriptNames();
const WIRE_TOKENS = wireTokensAndMethods();

/* -------------------------------------------------------------------------- */
/* the claims                                                                 */
/* -------------------------------------------------------------------------- */

export interface Claim {
  readonly kind: 'doc-link' | 'path' | 'named-test';
  readonly file: string;
  readonly line: number;
  readonly token: string;
}

const BACKTICKED = /`([^`\n]{2,160})`/g;
const DOC_LINK = /\[`([^`\]\n]+)`\]/g;
const PATH_TOKEN =
  /^[\w.@-]+(?:\/[\w.@-]+)*\.(?:rs|ts|tsx|css|md|sh|mjs|js|json|yml|yaml|html|toml)$/;
/**
 * A snake_case token of **two or more words**.
 *
 * This floor was four, and four had a measured hole. Of the eleven sites in the
 * sweep this file generalises, two are name-shaped and shorter than four words:
 * "audit_closed_vocabulary" (three) and "into_parts" (two). **The guard written
 * to make sure the eleventh never happened again would have caught nine of the
 * eleven.** The ledger in `docs/vela-progress.md` shows the shape of the
 * problem: it writes a name that does not exist in straight quotes rather than
 * backticks, precisely so the row does not become a fresh claim — and the only
 * two rows that use backticks anyway are those same two, because at three words
 * and two they were beneath this regex and nothing would have noticed.
 *
 * Lowering the floor alone was not affordable and was measured too: at two
 * words the scan goes from 102 claims to 799, and resolving them by the corpora
 * of the day left 76 unresolved, almost all foreign vocabulary
 * (`"json_encode"`, `set_var`, `workflow_dispatch`). What made the floor payable
 * was going through that residue one site at a time — most of them comments to
 * correct rather than names to excuse — and what finally survived is the eleven
 * described in the header: the foreign names in {@link FOREIGN_NAMES} and three
 * local Rust bindings {@link rustItems} reads. A list, not a rule.
 */
const SENTENCE_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}$/;

/** Every claim in one file, in source order. */
export function claimsIn(path: string, text: string): readonly Claim[] {
  const claims: Claim[] = [];
  const lines = text.split(/\r?\n/);
  let insideFence = false;
  for (const [index, line] of lines.entries()) {
    const at = index + 1;
    // The body of a code fence is an illustration, not a claim. `answer.rs`
    // carries a `compile_fail` example whose expected output is rustc's own
    // *"no method named `push_salvaged`"*: the entire point of the example is
    // that the method does not exist, and reading that as a claim would demand
    // rustc's error text be edited into a falsehood. Rust writes its fences
    // inside doc comments, so the marker is found after the comment lead-in.
    if (FENCE_MARKER.test(line) && (line.match(/```/g) ?? []).length % 2 === 1) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
    if (path.endsWith('.rs') && COMMENT_LINE.test(line)) {
      for (const token of captured(line, DOC_LINK)) {
        claims.push({
          kind: 'doc-link',
          file: path,
          line: at,
          token: (token.split('(')[0] ?? token).trim(),
        });
      }
    }
    for (const raw of captured(line, BACKTICKED)) {
      const token = raw.trim();
      // `into_parts()` is the same claim as `into_parts` — the parens are just
      // how a sentence says "the function". Left unnormalised they were a hole
      // in this hole's own repair: `docs/vela-progress.md:1554` names the method
      // that ledger #3 renamed away, and wore a pair of brackets past the check.
      const named = token.replace(/\(\)$/, '');
      if (PATH_TOKEN.test(token)) {
        claims.push({ kind: 'path', file: path, line: at, token });
      } else if (SENTENCE_NAME.test(named.split('::').pop() ?? '')) {
        claims.push({ kind: 'named-test', file: path, line: at, token: named });
      }
    }
  }
  return claims;
}

/**
 * Whether the thing a claim names actually exists.
 *
 * Every route below is a lookup into a corpus of things that were *found*: items
 * parsed out of the Rust, labels parsed out of the shell tests, declarations
 * parsed out of the TypeScript, wire tokens read off code lines, files walked
 * off disk. The single exception is {@link FOREIGN_NAMES}, which is a list of
 * names that exist in somebody else's system, written down by hand with the
 * owner beside each one.
 *
 * **Nothing here infers existence.** A `named-test` claim used to have a route
 * that did — a name resolved if it was used as code anywhere in the tree — and
 * the header records the six rounds and the eleven names that ended it. What is
 * left can be audited by reading: if a claim resolves, some named corpus holds
 * the token, and you can go and look at what put it there. If a claim does not
 * resolve, the answer is to make the sentence true, not to widen a route.
 */
function resolves(claim: Claim): boolean {
  const tail = claim.token.split('::').pop() ?? claim.token;
  switch (claim.kind) {
    case 'doc-link': {
      if (EXTERNAL_CRATES.has(claim.token.split('::')[0] ?? '')) return true;
      if (PRELUDE_ITEMS.has(tail)) return true;
      // A link may name a sibling integration-test file rather than an item.
      if (BASENAMES.has(`${tail}.rs`)) return true;
      return RUST_ITEMS.has(tail) || DIRECTORIES.has(`src-tauri/crates/${tail}`);
    }
    case 'path': {
      if (ILLUSTRATIVE.has(claim.token)) return true;
      const cleaned = claim.token.replace(/^\.?\//, '');
      // A bare filename is a legitimate shorthand — `tokens.css`, `Markdown.tsx`
      // — so it resolves anywhere in the tree. A token that spells out a
      // *directory* is making a stronger statement and is held to it: it must
      // match a real path, or a real tail of one for a partial like
      // `ipc/diagnostics.rs`.
      //
      // Falling back to the basename for those too was a hole with the same
      // shape as everything else in this file. `src/app/contract.ts` resolved
      // green while the file is at `src/platform/contract.ts`: the claim names a
      // directory the file has never been in, and the guard agreed with it
      // because *some* `contract.ts` exists. Three sites relied on that; all
      // three were wrong, and all three are corrected.
      if (!cleaned.includes('/')) return BASENAMES.has(cleaned);
      return FILE_SET.has(cleaned) || ALL_FILES.some((path) => path.endsWith(`/${cleaned}`));
    }
    case 'named-test':
      if (EXTERNAL_CRATES.has(claim.token.split('::')[0] ?? '')) return true;
      if (FOREIGN_NAMES.has(tail)) return true;
      // An integration test is a whole file, not an item: `cargo test` compiles
      // `tests/<name>.rs` as its own crate, so naming one is naming a file.
      if (BASENAMES.has(`${tail}.rs`)) return true;
      return (
        RUST_ITEMS.has(tail) || SHELL_LABELS.has(tail) || TS_NAMES.has(tail) || WIRE_TOKENS.has(tail)
      );
  }
}

const ALL_CLAIMS = SCANNED.flatMap((path) => claimsIn(path, CONTENTS.get(path) ?? ''));
const UNRESOLVED = ALL_CLAIMS.filter((claim) => !resolves(claim));

function describeClaim(claim: Claim): string {
  return `${claim.file}:${claim.line} names \`${claim.token}\`, which does not exist`;
}

/* -------------------------------------------------------------------------- */

describe('the guards this repo says it has', () => {
  it('names only Rust items that exist', () => {
    const broken = UNRESOLVED.filter((claim) => claim.kind === 'doc-link').map(describeClaim);
    expect(broken).toEqual([]);
  });

  it('names only files that exist', () => {
    const broken = UNRESOLVED.filter((claim) => claim.kind === 'path').map(describeClaim);
    expect(broken).toEqual([]);
  });

  it('names only tests that exist', () => {
    // The `contract.ts` shape: a comment naming the test that holds an
    // invariant, where the test was never written.
    const broken = UNRESOLVED.filter((claim) => claim.kind === 'named-test').map(describeClaim);
    expect(broken).toEqual([]);
  });
});

describe('this guard is not vacuous', () => {
  // Every assertion above is an emptiness check, which is exactly the kind that
  // passes when the machinery underneath it silently reads nothing.

  it('found the tree', () => {
    expect(SCANNED.length).toBeGreaterThan(200);
    expect(RUST_ITEMS.size).toBeGreaterThan(1000);
    expect(SHELL_LABELS.size).toBeGreaterThanOrEqual(2);
  });

  it('found claims of every kind, in quantity', () => {
    const counted = (kind: Claim['kind']) => ALL_CLAIMS.filter((c) => c.kind === kind).length;
    expect(counted('doc-link')).toBeGreaterThan(300);
    expect(counted('path')).toBeGreaterThan(300);
    expect(counted('named-test')).toBeGreaterThan(50);
  });

  it('resolves the guards that really are wired up', () => {
    // Named explicitly, so a resolver that started returning `true` for
    // everything would still have to keep these particular claims meaningful.
    expect(RUST_ITEMS.has('every_command_takes_exactly_one_argument_and_it_is_named_payload')).toBe(
      true,
    );
    expect(RUST_ITEMS.has('rust_and_typescript_allowlists_are_identical')).toBe(true);
    expect(RUST_ITEMS.has('no_error_in_the_whole_taxonomy_carries_an_unexplained_string')).toBe(
      true,
    );
    expect(SHELL_LABELS.has('scan_scans_itself_and_stays_clean')).toBe(true);
    expect(FILE_SET.has('src/platform/chat-contract-parity.test.ts')).toBe(true);
  });

  it('reports a claim with nothing behind it, in each of the three shapes', () => {
    // The control. Fabricated corpus, run through the same resolver — including
    // the exact claim that survived the last sweep.
    const corpus = [
      '//! [`a_guard_that_was_never_written`] holds this.',
      '//! see `src/platform/chat-contract-parity.test.ts` and `src/platform/no-such-file.test.ts`',
      '/// `every_variant_is_listed_in_all` and `a_test_nobody_ever_wrote_at_all`',
    ].join('\n');

    const reported = claimsIn('src-tauri/src/probe.rs', corpus)
      .filter((claim) => !resolves(claim))
      .map((claim) => `${claim.kind}:${claim.token}`);

    expect(reported).toEqual([
      'doc-link:a_guard_that_was_never_written',
      'named-test:a_guard_that_was_never_written',
      'path:src/platform/no-such-file.test.ts',
      'named-test:a_test_nobody_ever_wrote_at_all',
    ]);
  });

  // The controls for the two holes this file was repaired for. Each names a
  // shape that used to resolve green, so a later widening of the floor, of the
  // path rule, or of any route in {@link resolves} fails here rather than
  // quietly going back to excusing the thing it was written to catch.

  it('reports a short name, which is how two of the eleven sites got past', () => {
    // Four-plus words was the old floor. "audit_closed_vocabulary" is three and
    // "into_parts" is two; both are real ledger entries, and neither was
    // checked. The bracketed form is the same claim wearing parens.
    const corpus = [
      '/// `never_written_here` and `no_such_guard` hold this.',
      '/// so does `also_never_written()`',
    ].join('\n');

    const reported = claimsIn('src-tauri/src/probe.rs', corpus)
      .filter((claim) => !resolves(claim))
      .map((claim) => `${claim.kind}:${claim.token}`);

    expect(reported).toEqual([
      'named-test:never_written_here',
      'named-test:no_such_guard',
      'named-test:also_never_written',
    ]);
  });

  it('reports a real filename under a directory it has never been in', () => {
    // The path rule used to fall back to the basename for every claim, so
    // `src/app/contract.ts` resolved off the real `src/platform/contract.ts`.
    // A bare filename is still a legitimate shorthand and must still resolve.
    const corpus = [
      '// `src/app/contract.ts` and `src/nowhere/at/all/App.tsx`',
      '// but `contract.ts` and `src/platform/contract.ts` are fine',
    ].join('\n');

    const reported = claimsIn('src-tauri/src/probe.rs', corpus)
      .filter((claim) => !resolves(claim))
      .map((claim) => claim.token);

    expect(reported).toEqual(['src/app/contract.ts', 'src/nowhere/at/all/App.tsx']);
  });
});
