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
 *    a Rust item, a shell test label, a TypeScript declaration, a wire token, or
 *    — the general case — to a use of that name somewhere in the tree as code
 *    rather than as prose. See {@link codeVocabulary}: a name that exists is
 *    used; a name that was never written appears only in the sentence claiming
 *    it.
 *
 * The body of a code fence is excluded from all three, in both directions: it is
 * an illustration, so it neither makes a claim nor proves one.
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
 * Do not add to {@link ILLUSTRATIVE}. Either the named thing should exist, in
 * which case write it, or the comment should say what is actually guaranteed,
 * in which case fix the sentence.
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
 * Rustdoc's own code-fence directives. `` ```compile_fail `` is an instruction to
 * the doctest compiler, not a name this tree could ever define, and it is
 * discussed by eight comments across the repo. It lives here — beside the other
 * vocabulary this tree does not own — rather than being rescued by an exception
 * inside {@link vocabularyOf}, because an exception there is a hole a fabricated
 * name can climb through and a name here is just a fact about rustdoc.
 */
const RUSTDOC_DIRECTIVES = new Set([
  'compile_fail',
  'should_panic',
  'no_run',
  'ignore',
  'edition2018',
  'edition2021',
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
  }
  return items;
}

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
 */
function wireTokensAndMethods(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [path, text] of CONTENTS) {
    if (path.endsWith('.md')) continue;
    for (const line of text.split(/\r?\n/)) {
      if (withoutComments(path, line).trim() === '') continue;
      // `#[doc = "…"]` is a comment that survived being written as an attribute.
      // Its string is prose, so it must not vouch the way an endpoint's wire
      // token does — a critic used exactly this to launder a fabricated name.
      if (/^\s*#!?\[\s*doc\s*=/.test(line)) continue;
      for (const name of captured(line, /"([a-z][a-z0-9]*(?:_[a-z0-9]+){1,})"/g)) names.add(name);
      for (const name of captured(line, /\.([a-z][a-z0-9]*(?:_[a-z0-9]+){1,})\s*\(/g))
        names.add(name);
    }
  }
  return names;
}

/**
 * Every snake_case token this file uses **as code**.
 *
 * This is the discriminator the word-count floor was standing in for, and it is
 * a sharper one. A name that really exists is *used*: defined, called, imported,
 * or written in a config key. A name that was never written appears only in the
 * sentence claiming it. That is not a theory; it is the measured property of the
 * tenth false claim, whose identifier occurred exactly once in the whole tree,
 * inside its own claim.
 *
 * ## Prose is not evidence, and getting that wrong made this guard weaker
 *
 * The first version of this collected every token outside a backtick, anywhere,
 * and the doc comment above it claimed the rule was "as code rather than as
 * prose". It was not. A fabricated five-word test name mentioned once in an
 * ordinary comment — or in a markdown bullet — resolved green, and a critic
 * demonstrated it: `every_secret_is_stripped_before_the_socket`, named in a doc
 * comment as the holder of the redaction invariant and mentioned once more in a
 * naming note, passed. **That name was inside the old four-word guard's remit**,
 * so the repair was a strict regression on a class already covered — the exact
 * shape of defect this file exists to catch, introduced by the file itself.
 *
 * So comments and string bodies are removed by {@link scan}, and **there is no
 * exception to that**. A markdown file contributes nothing at all — every line
 * of it is prose. Rustdoc's fence directives are named in
 * {@link RUSTDOC_DIRECTIVES} rather than rescued here, because an exception in
 * this function is a hole a fabricated name can climb through, and a critic
 * climbed through the fence one twice.
 *
 * This paragraph replaced one describing two mechanisms that had already been
 * deleted — prose skipped per line, and a fence info string kept. It survived
 * two commits after the code it described was gone, which is a comment claiming
 * an enforcement that does not exist, in the file whose whole subject is
 * comments claiming enforcements that do not exist. A critic caught it. When
 * this function changes, this comment changes in the same commit.
 */
export function vocabularyOf(path: string, text: string): ReadonlySet<string> {
  const names = new Set<string>();
  const collect = (fragment: string): void => {
    const code = fragment
      // A quoted string is somebody's data, not this tree's vocabulary — and
      // straight quotes are specifically how this repo names something that is
      // gone. See {@link wireTokensAndMethods}: a retired name must not vouch
      // for itself just because a sentence retiring it spelled it out. All three
      // quote characters, so a name cannot slip in as `'…'` or a template.
      .replace(/`[^`\n]*`/g, ' ')
      .replace(/"[^"\n]*"/g, ' ')
      .replace(/'[^'\n]*'/g, ' ');
    for (const match of code.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  };

  // No fence handling at all, and removing it was the point. An earlier version
  // lifted fence info strings out *before* stripping comments, so that
  // ` ```compile_fail ` survived — and that lift-out never asked whether the
  // fence was itself inside a comment. A critic harvested a name straight out of
  // a `/** … *\/` block through it, and showed that ` ````code ` toggles too, so
  // a four-backtick fence opened and its inner ``` closed, exposing a body the
  // comment above swore was dropped.
  //
  // Every exception is an exploit surface. There is now one rule — comments and
  // string bodies are not vocabulary — and no exception to it. Rustdoc's own
  // directives are foreign vocabulary and are named as such in {@link resolves},
  // next to the external crates, where things this tree does not own belong.
  collect(withoutComments(path, text));
  return names;
}

/** {@link vocabularyOf}, over every scanned file. */
function codeVocabulary(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [path, text] of CONTENTS) for (const name of vocabularyOf(path, text)) names.add(name);
  return names;
}

/**
 * A line that is prose rather than code. Declared here because both the corpora
 * above and the claim scan below need it, and the corpora are built first.
 */
const COMMENT_LINE = /^\s*(\/\/[/!]?|\*|\/\*|#|\|)/;

/**
 * Everything in `text` that a compiler would read, with comments and string
 * bodies removed. A single character scan, and it is a scan on purpose.
 *
 * ## Three attempts, and why the first two were the wrong shape
 *
 * A critic failed this rule three times, each time by planting a fabricated
 * guard name where the stripper could not see it.
 *
 * 1. Any mention outside a backtick counted, so ordinary prose vouched for a
 *    name that had never been written.
 * 2. Prose was then recognised by asking whether a **line began** with a
 *    comment marker — which misses a trailing `// …` after code, and a
 *    `/* … *\/` interior whose lines do not start with `*`.
 * 3. Comments were removed by regex, which cannot see the things that actually
 *    matter: a **string that spans lines**, a Rust raw string, a nested block
 *    comment. This repo writes long English prose inside backslash-continued
 *    Rust strings — `gate_m_phase_b2.rs` narrates in them — and one such
 *    sentence was the only thing resolving four separate claims.
 *
 * Regexes were never going to close it, because every one of those is a nested
 * or multi-line construct and a regex has no state. So this walks the text once
 * with the small amount of state the job actually needs: comment depth, and
 * which quote it is inside.
 *
 * ## What it deliberately does not do
 *
 * A YAML block scalar (`run: |`) is content that is often shell, and it is kept
 * as code. A name written into one would vouch for itself. That is an open,
 * measured limit rather than an oversight — closing it means parsing YAML, and
 * `.github/` is the only place it applies.
 */
/**
 * Index just past a quoted run beginning at `from`, and whether it really closed.
 *
 * Templates are the reason this is three mutually recursive functions rather
 * than a loop. A template literal can hold `${…}`, an interpolation is ordinary
 * code, and that code can hold another template — `checks.mjs:588` writes
 * exactly that, and a scanner without the nesting state closes the outer literal
 * on the inner backtick. Everything after it is then read as code, the
 * apostrophe in `endpoint's` opens a string, and the pairing stays inverted for
 * ninety-one lines.
 */
function skipQuoted(text: string, from: number, singleLine: boolean): [number, boolean] {
  const quote = text[from];
  if (quote === '`') return [skipTemplate(text, from), true];
  let at = from + 1;
  while (at < text.length) {
    const here = text[at];
    if (here === '\\') {
      at += 2;
      continue;
    }
    if (here === quote) return [at + 1, true];
    // JavaScript forbids a raw newline in `'…'` and `"…"`. Stopping here turns
    // a mis-parse into a local one instead of letting it run to end of file —
    // and `no unterminated single-line string` below makes it audible.
    if (singleLine && here === '\n') return [at, false];
    at += 1;
  }
  return [text.length, false];
}

function skipTemplate(text: string, from: number): number {
  let at = from + 1;
  while (at < text.length) {
    const here = text[at];
    if (here === '\\') {
      at += 2;
      continue;
    }
    if (here === '`') return at + 1;
    if (here === '$' && text[at + 1] === '{') {
      at = skipInterpolation(text, at + 2);
      continue;
    }
    at += 1;
  }
  return text.length;
}

function skipInterpolation(text: string, from: number): number {
  let at = from;
  let braces = 1;
  while (at < text.length) {
    const here = text[at];
    if (here === '\\') {
      at += 2;
      continue;
    }
    if (here === '`' || here === '"' || here === "'") {
      at = skipQuoted(text, at, here !== '`')[0];
      continue;
    }
    if (here === '{') braces += 1;
    else if (here === '}') {
      braces -= 1;
      if (braces === 0) return at + 1;
    }
    at += 1;
  }
  return text.length;
}

function scan(path: string, text: string): ScanResult {
  if (path.endsWith('.md')) return { code: '', endedOpen: null, openedOnLine: null };
  const rust = path.endsWith('.rs');
  const hashComments = /\.(sh|yml|toml)$/.test(path);
  // Rust `'` is a lifetime far more often than a char literal, and a lifetime
  // has no closing quote — treating it as one would swallow the rest of the
  // line and drop real code, which manufactures false claims. Backticks are
  // only strings in TypeScript.
  // Shell backticks are command substitution, so their contents are code, not a
  // string — and a heredoc in `record.sh` writes an *escaped* backtick, which
  // opened a string that ran to the end of the file.
  const shell = path.endsWith('.sh');
  const javascript = /\.(ts|tsx|js|mjs)$/.test(path);
  const quotes = rust ? '"' : path.endsWith('.css') || shell ? '"\'' : '"\'`';

  const kept: string[] = [];
  let at = 0;
  let depth = 0;
  let openedStringAt: number | null = null;
  while (at < text.length) {
    const here = text[at] ?? '';
    const after = text[at + 1] ?? '';

    if (depth > 0) {
      // Rust block comments nest; C-family ones do not, and closing early is
      // what a real compiler does too.
      if (rust && here === '/' && after === '*') (depth += 1), (at += 2);
      else if (here === '*' && after === '/') (depth -= 1), (at += 2);
      else at += 1;
      continue;
    }
    if (here === '/' && after === '/') {
      while (at < text.length && text[at] !== '\n') at += 1;
      continue;
    }
    if (here === '/' && after === '*') {
      depth = 1;
      at += 2;
      continue;
    }
    // A JavaScript regex literal, which is where a lone quote lives without
    // opening a string: `/["']/` is four characters of pattern, not the start of
    // a string that runs to the end of the file. Eleven files in this tree stop
    // being read partway through without this, `no-provider-leak.test.ts` among
    // them — a scanner that quietly gives up on a file is how the char-literal
    // inversion hid, so it is worth the one heuristic.
    //
    // Regex-or-division is genuinely ambiguous in JavaScript and this is the
    // usual resolution: after a value you have division, after an operator or an
    // opening bracket you have a pattern. Guessing wrong costs vocabulary, never
    // laundering, because both branches only ever *remove* text.
    if (!rust && here === '/' && /\.(ts|tsx|js|mjs)$/.test(path)) {
      const before = kept.join('').trimEnd();
      const previous = before.at(-1) ?? '';
      // After a keyword you have a pattern, not division. `return /…/` is the
      // shape that got missed, and `no-provider-leak.test.ts` opens with one.
      const afterKeyword = /\b(?:return|typeof|case|in|of|new|delete|void|instanceof|yield|await|do|else)$/.test(
        before,
      );
      if (previous === '' || afterKeyword || '(,=:[!&|?{};+-*%~^<>'.includes(previous)) {
        let scan = at + 1;
        let inClass = false;
        while (scan < text.length) {
          const ch = text[scan];
          if (ch === '\\') (scan += 2), undefined;
          else if (ch === '[') (inClass = true), (scan += 1);
          else if (ch === ']') (inClass = false), (scan += 1);
          else if (ch === '\n') break;
          else if (ch === '/' && !inClass) {
            scan += 1;
            at = scan;
            kept.push(' ');
            break;
          } else scan += 1;
        }
        if (at === scan) continue;
      }
    }
    if (hashComments && here === '#') {
      while (at < text.length && text[at] !== '\n') at += 1;
      continue;
    }
    // A shell backslash escapes the next character wherever it appears, so
    // `\"` outside a string is a literal quote and must not open one.
    if (shell && here === '\\') {
      at += 2;
      continue;
    }
    // `r"…"`, `r#"…"#`, `r##"…"##` — no escapes inside, closed by the matching
    // hash count. This is where a name hides from a line-oriented stripper.
    if (rust && here === 'r' && (after === '#' || after === '"')) {
      let scan = at + 1;
      let hashes = 0;
      while (text[scan] === '#') (hashes += 1), (scan += 1);
      if (text[scan] === '"') {
        const closer = `"${'#'.repeat(hashes)}`;
        const ends = text.indexOf(closer, scan + 1);
        at = ends < 0 ? text.length : ends + closer.length;
        kept.push(' ');
        continue;
      }
    }
    // A Rust char literal, consumed whole — and this is not a nicety. `'` is not
    // a quote here, but the `"` **inside** `'"'` was still reaching the branch
    // below and opening a string. That string then closed on the next `"` in the
    // file, which is the opening quote of the next real one, so from there the
    // parity was inverted and every string body was emitted as code. Twenty such
    // literals live in this tree; `src-tauri/src/ipc/mod.rs:164` writes
    // `.trim_matches(['\'', '"', '\n', ' '])` and inverts everything to the end
    // of the file. A critic planted the same fabricated name in three files and
    // only that one laundered it.
    //
    // A lifetime is `'name` with no closing quote, so the shape is the whole
    // discriminator: a char literal always closes within a few characters.
    if (rust && here === "'") {
      const literal = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|.)|[^\\'])'/.exec(
        text.slice(at, at + 12),
      );
      if (literal) {
        at += literal[0].length;
        kept.push(' ');
        continue;
      }
    }
    if (quotes.includes(here)) {
      const from = at;
      const [next, closed] = skipQuoted(text, at, javascript && here !== '`');
      at = next;
      if (!closed && openedStringAt === null) openedStringAt = from;
      kept.push(' ');
      continue;
    }
    kept.push(here);
    at += 1;
  }
  const openedAt = depth > 0 ? 0 : openedStringAt;
  return {
    code: kept.join(''),
    endedOpen: depth > 0 ? 'block comment' : openedStringAt === null ? null : 'string',
    // Reported as a line number, because "this file stops being read" is useless
    // without "starting here" — the first version of this control said only
    // which files and left eleven of them to be found by hand.
    openedOnLine: openedAt === null ? null : text.slice(0, openedAt).split('\n').length,
  };
}

/** What {@link scan} was still inside when it ran out of text, if anything. */
interface ScanResult {
  readonly code: string;
  readonly endedOpen: 'block comment' | 'string' | null;
  readonly openedOnLine: number | null;
}

function withoutComments(path: string, text: string): string {
  return scan(path, text).code;
}

/** ` ```rust `, ` ```compile_fail `, or a bare ` ``` ` — inside a doc comment or not. */
const FENCE_LINE = /^\s*(?:\/\/[/!]?|\*|#)?\s*```(.*)$/;

/**
 * The info string if this line opens or closes a fence, otherwise `null`.
 *
 * A line carrying an **even** number of ` ``` ` opens and closes on itself: it is
 * prose *about* a fence, not a fence. `emulation.rs:354` is exactly that —
 * `/// \`\`\`json { … } \`\`\` or the same object bare.` — and reading it as an
 * opener left the scan believing it was inside a code block for the remaining
 * three hundred lines of the file, which were then silently exempt from every
 * check here. Nothing claim-shaped lived in them, so it cost nothing this time;
 * `no scanned file ends inside a fence` below makes the next one loud.
 */
function fenceToggle(line: string): string | null {
  const matched = FENCE_LINE.exec(line);
  if (matched === null) return null;
  if ((line.match(/```/g) ?? []).length % 2 === 0) return null;
  return matched[1] ?? '';
}

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
const CODE_VOCABULARY = codeVocabulary();

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
 * words the scan goes from 102 claims to 799, and resolving them by the old
 * corpora alone leaves 76 unresolved, almost all foreign vocabulary
 * (`"json_encode"`, `set_var`, `workflow_dispatch`). What makes the floor payable
 * is {@link codeVocabulary}: a real name is used somewhere as code, a fabricated
 * one exists only inside its own claim. With that, the same 799 leave a residue
 * small enough to resolve one site at a time, honestly, which is what was done.
 */
const SENTENCE_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}$/;

/** Every claim in one file, in source order. */
export function claimsIn(path: string, text: string): readonly Claim[] {
  const claims: Claim[] = [];
  const lines = text.split(/\r?\n/);
  let insideFence = false;
  for (const [index, line] of lines.entries()) {
    const at = index + 1;
    // The body of a code fence is an illustration, not a claim — the same rule
    // {@link codeVocabulary} applies from the other side, and it has to be the
    // same rule or the two disagree about what a fence is. `answer.rs` carries a
    // `compile_fail` example whose expected output is rustc's own
    // *"no method named `push_salvaged`"*: the entire point of the example is
    // that the method does not exist, and reading that as a claim would demand
    // rustc's error text be edited into a falsehood. Rust writes its fences
    // inside doc comments, so the marker is found after the comment lead-in.
    if (fenceToggle(line) !== null) {
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
      if (RUSTDOC_DIRECTIVES.has(tail)) return true;
      // An integration test is a whole file, not an item: `cargo test` compiles
      // `tests/<name>.rs` as its own crate, so naming one is naming a file.
      if (BASENAMES.has(`${tail}.rs`)) return true;
      return (
        RUST_ITEMS.has(tail) ||
        SHELL_LABELS.has(tail) ||
        TS_NAMES.has(tail) ||
        WIRE_TOKENS.has(tail) ||
        // Used somewhere as code rather than only inside its own claim.
        CODE_VOCABULARY.has(tail)
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
  // path rule, or of {@link codeVocabulary} fails here rather than quietly
  // going back to excusing the thing it was written to catch.

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

  it('does not accept prose as evidence that a name exists', () => {
    // The regression a critic found and this pins. `codeVocabulary` accepted any
    // mention outside a backtick, so a fabricated guard could be legitimised by
    // saying its name twice: once in the claim, once anywhere else. The critic's
    // own reproduction is the fixture — a five-word name that the *old* guard
    // caught and the repair excused.
    // Every syntactic form a comment takes, not the two that happened to be
    // demonstrated. The first repair pinned only a leading `//!` and a markdown
    // bullet, and a critic walked straight through the gap with a trailing
    // comment and a block-comment interior — so the control passed while the
    // rule it was named after did not hold. A control narrower than its own
    // name is the defect this file exists to catch, one level up.
    const rustProse = vocabularyOf(
      'src-tauri/src/probe.rs',
      [
        '//! zzq_leading_bang_comment_name holds this.',
        '/// zzq_leading_slash_comment_name too.',
        '// zzq_plain_line_comment_name as well.',
        'const A: u8 = 1; // zzq_trailing_comment_name holds the invariant',
        '/*',
        'zzq_block_interior_no_star_name is named in here,',
        ' * zzq_block_interior_with_star_name on a starred line,',
        '*/',
        'const B: u8 = 2; /* zzq_inline_block_name */',
      ].join('\n'),
    );
    for (const planted of [
      'zzq_leading_bang_comment_name',
      'zzq_leading_slash_comment_name',
      'zzq_plain_line_comment_name',
      'zzq_trailing_comment_name',
      'zzq_block_interior_no_star_name',
      'zzq_block_interior_with_star_name',
      'zzq_inline_block_name',
    ]) {
      expect(rustProse.has(planted), `${planted} was accepted out of a comment`).toBe(false);
    }

    // The critic's own string, from the verdict that found this class twice.
    expect(
      vocabularyOf(
        'src-tauri/src/probe.rs',
        'const C: u8 = 3; // every_secret_is_stripped_before_the_socket holds it\n/*\nand every_secret_is_stripped_before_the_socket again.\n*/\n',
      ).has('every_secret_is_stripped_before_the_socket'),
    ).toBe(false);

    // A URL is not a comment, so the code around one is still collected.
    expect(
      vocabularyOf('src/probe.ts', 'const zzq_real_binding = "https://example.test/a";').has(
        'zzq_real_binding',
      ),
    ).toBe(true);

    // The markdown half of the same attack. Every line of a `.md` is prose, so
    // a bullet mentioning a name proves nothing about whether it was written.
    const markdown = vocabularyOf(
      'docs/vela-progress.md',
      '- Naming note: zzq_bullet_beta reads well.\n\nzzq_prose_alpha is also nice.\n',
    );
    expect(markdown.has('zzq_bullet_beta')).toBe(false);
    expect(markdown.has('zzq_prose_alpha')).toBe(false);

    // And the line that is *not* prose, per language. `#` opens a comment in a
    // shell script and an attribute in Rust; treating both as comments dropped
    // real serde vocabulary and manufactured false claims out of true sentences.
    const attribute = vocabularyOf(
      'src-tauri/src/probe.rs',
      '#[serde(skip_serializing_if = "Option::is_none")]\npub struct S;\n',
    );
    expect(attribute.has('skip_serializing_if')).toBe(true);
    expect(vocabularyOf('scripts/probe.sh', '# not_a_real_name here\n').has('not_a_real_name')).toBe(
      false,
    );
    expect(
      vocabularyOf('scripts/probe.sh', 'run_it --flag  # zzq_trailing_hash_name\n').has(
        'zzq_trailing_hash_name',
      ),
    ).toBe(false);
  });

  it('is not thrown off by a char literal holding a quote', () => {
    // `'` is not a Rust quote here, for the lifetime reason. But the `"` inside
    // `'"'` still opened a string, which then closed on the next `"` in the
    // file — so from that point the parity was inverted and every string body
    // was emitted as code. `src-tauri/src/ipc/mod.rs:164` writes
    // `.trim_matches(['\'', '"', '\n', ' '])` and inverted everything to EOF; a
    // critic planted one fabricated name in three files and only that one
    // laundered it. Both directions are pinned: nothing leaks out of the string,
    // and the real code after it is still collected.
    const inverted = vocabularyOf(
      'src-tauri/src/probe.rs',
      [
        "let c = '\"';",
        'const N: &str = "prose mentioning zzq_in_string_body here";',
        'fn zzq_real_after_the_literal() {}',
      ].join('\n'),
    );
    expect(inverted.has('zzq_in_string_body')).toBe(false);
    expect(inverted.has('zzq_real_after_the_literal')).toBe(true);

    // The lifetime it was excluded for still behaves, and an escaped quote
    // char literal is the same trap wearing a backslash.
    const lifetimes = vocabularyOf(
      'src-tauri/src/probe.rs',
      ["fn f<'a>(x: &'a str) {}", "let q = '\\'';", 'const M: &str = "zzq_second_body";', 'fn zzq_still_read() {}'].join(
        '\n',
      ),
    );
    expect(lifetimes.has('zzq_second_body')).toBe(false);
    expect(lifetimes.has('zzq_still_read')).toBe(true);
  });

  it('never reads a JavaScript string as spanning a line, because none can', () => {
    // The control for the class the other two cannot see. A mis-parse that
    // *terminates* leaves no unfinished file and no unbalanced fence, so both
    // of those stay green — which is exactly how a nested template literal in
    // `checks.mjs` inverted the pairing for ninety-one lines and let a
    // fabricated name resolve out of a string body.
    //
    // JavaScript forbids a raw newline inside `'…'` and `"…"`. So if the
    // scanner ever believes one spans a line, the scanner is wrong, and that is
    // a fact about the language rather than a guess about this tree. A critic
    // used exactly this signal to find the bug by hand; it is cheaper as a test.
    const straddling: string[] = [];
    for (const [path, text] of CONTENTS) {
      if (!/\.(ts|tsx|js|mjs)$/.test(path)) continue;
      let at = 0;
      let line = 1;
      while (at < text.length) {
        const here = text[at];
        if (here === '\n') (line += 1), (at += 1);
        else if (here === '/' && text[at + 1] === '/') {
          while (at < text.length && text[at] !== '\n') at += 1;
        } else if (here === '"' || here === "'") {
          const [next] = skipQuoted(text, at, true);
          const body = text.slice(at, next);
          if (body.includes('\n')) straddling.push(`${path}:${line}`);
          line += (body.match(/\n/g) ?? []).length;
          at = next;
        } else at += 1;
      }
    }

    expect(
      [...new Set(straddling)],
      'the scanner is mis-pairing quotes here, so string bodies are leaking into the vocabulary',
    ).toEqual([]);
  });

  it('has no scanned file the scanner never finishes reading', () => {
    // An unterminated string or block comment swallows the rest of a file. Every
    // such case loses vocabulary rather than laundering a name, so none is a
    // hole — but it is the same silent-partial-exemption shape as the fence bug,
    // and a file that quietly stops contributing is exactly how the char-literal
    // inversion hid. Loud beats latent.
    const unfinished = [...CONTENTS]
      .map(([path, text]) => ({ path, ...scan(path, text) }))
      .filter((result) => result.endedOpen !== null)
      .map((result) => `${result.path}:${result.openedOnLine ?? 0} opens a ${result.endedOpen ?? ''}`);

    expect(unfinished, 'these files stop contributing vocabulary partway through').toEqual([]);
  });

  it('has no scanned file that ends inside a fence', () => {
    // An unbalanced fence marker exempts the rest of a file from every check in
    // here, silently. `emulation.rs:354` writes ` ```json { … } ``` ` inline in a
    // sentence, which opens and closes on one line; a scanner that toggled on
    // any ` ``` ` read it as an opener and skipped the next three hundred lines.
    const unbalanced = [...CONTENTS]
      .filter(([, text]) => {
        let inside = false;
        for (const line of text.split(/\r?\n/)) if (fenceToggle(line) !== null) inside = !inside;
        return inside;
      })
      .map(([path]) => path);

    expect(unbalanced, 'these files are partly exempt from this guard without saying so').toEqual(
      [],
    );
  });

  it('counts a name as evidence only where it is used as code', () => {
    // Against a fixture, not against the tree, and that is the point. This
    // control first pinned a real identifier as the negative case — one that was
    // absent because the guard had just caught it missing. Another branch then
    // went and wrote that test, which was the entire object of the exercise, and
    // the control failed for the one reason a control never should: the project
    // succeeded. A control has to be anchored to the rule, not to a fact
    // somebody is actively working to change.
    const vocabulary = vocabularyOf(
      'src-tauri/src/probe.rs',
      [
        '/// ```compile_fail',
        '/// fn zz_only_inside_a_fence() {}',
        '/// ```',
        'fn zz_defined_as_code() {}',
        'let x = zz_bare_identifier + "zz_only_in_straight_quotes";',
      ].join('\n'),
    );

    expect(vocabulary.has('zz_defined_as_code')).toBe(true);
    expect(vocabulary.has('zz_bare_identifier')).toBe(true);
    // A fence in Rust lives inside a doc comment, so it goes when the comment
    // goes — body AND info string. That is why `compile_fail` is named in
    // {@link RUSTDOC_DIRECTIVES} instead of being rescued by an exception here:
    // the exception was a hole, and a critic climbed through it.
    expect(vocabulary.has('zz_only_inside_a_fence')).toBe(false);
    expect(vocabulary.has('compile_fail')).toBe(false);
    // Straight quotes are how this repo retires a name. See the ledger.
    expect(vocabulary.has('zz_only_in_straight_quotes')).toBe(false);

    // …and the directive still resolves, through the route that names it.
    expect(
      resolves({ kind: 'named-test', file: 'src-tauri/src/probe.rs', line: 1, token: 'compile_fail' }),
    ).toBe(true);

    // A string body is not vocabulary either — not on one line, and not across
    // a line break, which is where the third failure lived. This repo narrates
    // in backslash-continued Rust strings, and one such sentence was the only
    // thing resolving a name for twelve separate claims.
    const continued = vocabularyOf(
      'src-tauri/src/probe.rs',
      'const WHY: &str = "a sentence mentioning zzq_continued_string_name \\\n across a line break";\n',
    );
    expect(continued.has('zzq_continued_string_name')).toBe(false);

    // Rust raw strings have no escapes and their own closing sequence, so a
    // stripper that does not know about them reads their contents as code.
    const raw = vocabularyOf(
      'src-tauri/src/probe.rs',
      'const R: &str = r#"zzq_raw_string_name lives in here"#;\n',
    );
    expect(raw.has('zzq_raw_string_name')).toBe(false);

    // Rust block comments nest. A stripper that stops at the first `*/` reads
    // the outer tail as code.
    const nested = vocabularyOf(
      'src-tauri/src/probe.rs',
      '/* outer /* inner */ zzq_nested_block_name still commented */\n',
    );
    expect(nested.has('zzq_nested_block_name')).toBe(false);

    // A lifetime is not a string. Treating `'` as one swallows the rest of the
    // line and drops real code, which manufactures false claims rather than
    // hiding true ones — the failure pointed the other way, and just as bad.
    expect(
      vocabularyOf('src-tauri/src/probe.rs', "fn f<'a>(x: &'a str) -> zzq_real_return { }\n").has(
        'zzq_real_return',
      ),
    ).toBe(true);
  });
});
