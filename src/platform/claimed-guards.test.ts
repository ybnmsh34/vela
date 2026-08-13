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
 *    repo must exist on disk.
 * 3. **Named tests.** Test names here are sentences — `every_variant_is_listed_in_all`.
 *    Every backticked sentence-shaped identifier must resolve to a Rust item or
 *    a shell test label.
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
 */
function wireTokensAndMethods(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const text of CONTENTS.values()) {
    for (const name of captured(text, /"([a-z][a-z0-9]*(?:_[a-z0-9]+){3,})"/g)) names.add(name);
    for (const name of captured(text, /\.([a-z][a-z0-9]*(?:_[a-z0-9]+){3,})\s*\(/g))
      names.add(name);
  }
  return names;
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
const COMMENT_LINE = /^\s*(\/\/[/!]?|\*|\/\*|#|\|)/;
const PATH_TOKEN =
  /^[\w.@-]+(?:\/[\w.@-]+)*\.(?:rs|ts|tsx|css|md|sh|mjs|js|json|yml|yaml|html|toml)$/;
const SENTENCE_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){3,}$/;

/** Every claim in one file, in source order. */
export function claimsIn(path: string, text: string): readonly Claim[] {
  const claims: Claim[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const at = index + 1;
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
      if (PATH_TOKEN.test(token)) {
        claims.push({ kind: 'path', file: path, line: at, token });
      } else if (SENTENCE_NAME.test(token.split('::').pop() ?? '')) {
        claims.push({ kind: 'named-test', file: path, line: at, token });
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
      return (
        FILE_SET.has(cleaned) ||
        BASENAMES.has(cleaned.slice(cleaned.lastIndexOf('/') + 1)) ||
        ALL_FILES.some((path) => path.endsWith(`/${cleaned}`))
      );
    }
    case 'named-test':
      if (EXTERNAL_CRATES.has(claim.token.split('::')[0] ?? '')) return true;
      // An integration test is a whole file, not an item: `cargo test` compiles
      // `tests/<name>.rs` as its own crate, so naming one is naming a file.
      if (BASENAMES.has(`${tail}.rs`)) return true;
      return (
        RUST_ITEMS.has(tail) ||
        SHELL_LABELS.has(tail) ||
        TS_NAMES.has(tail) ||
        WIRE_TOKENS.has(tail)
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
});
