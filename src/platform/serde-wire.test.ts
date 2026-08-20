/**
 * **The floor on how many readers of Rust source there are.**
 *
 * `src/platform/serde-wire.ts` exists because three guards each carried their
 * own copy of one parse, and two of them were a refactor behind. Sharing the
 * parse fixes the two that were behind. It does not fix the thing that let them
 * fall behind, which is that **nothing anywhere counted the copies** — the same
 * shape as the defect the parity guards themselves had, one level up.
 *
 * The narrow question the extraction alone answers is *"do the three files I
 * remembered import the shared reader?"* — and *"the three I remembered"* is
 * exactly the phrasing that failed before. The wide question, and the one this
 * file asks, is:
 *
 * > **Which TypeScript files in this repository read a Rust source off disk,
 * > and does each of them get its wire keys from the one reader?**
 *
 * It is an **equality against what is on disk**, not a threshold. A fourth
 * guard that reads a `.rs` file and hand-rolls its own `rename_all` regex fails
 * here on the day it is written, before it has had a chance to fall behind. So
 * does deleting one: {@link RUST_READERS} names files that must exist, and the
 * scan names files that must be registered, and the two must match exactly. A
 * `toBeGreaterThan` here would pass for any register long enough and could name
 * neither.
 *
 * ## What this cannot see, stated rather than implied
 *
 * - **`.mjs` and shell.** `scripts/` holds `.sh`, `.ps1` and `.mjs`; none is
 *   checked by `tsc` and none is scanned here. A wire-key reader written in
 *   `.mjs` is outside this question.
 * - **Reading Rust without naming a `.rs` file.** The detector is "names a
 *   string literal ending `.rs`, with the comments removed". A reader that
 *   assembles its filenames by concatenation is invisible to it. That is a real
 *   hole, and it is why {@link RUST_READERS} carries a reason per entry rather
 *   than a bare list: the reasons are what a later reader checks against.
 * - **`tests/`.** Out of scope, and not by choice: `no-app-import.test.ts`
 *   forbids any file under `src/` from naming the harness outside a comment, so
 *   a register living here cannot list a harness path.
 *   `tests/harness/mock-provider/no-app-import.test.ts` does read Rust — for
 *   `use` lines, not for wire keys — and this file does not see it. A wire-key
 *   reader written under `tests/` would be outside this question entirely.
 * - **Whether a registered reason is true.** RULE T applies to this file too. A
 *   `because` saying "scans for forbidden literals" is prose, and prose is not
 *   evidence that the file does that.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();

/**
 * Directories holding TypeScript that could read the crate.
 *
 * `src/` only, and the reason is a gate rather than a preference. The harness
 * suite forbids any file under `src/` from naming the harness outside a
 * comment, and the first draft of this file scanned `tests/` too, put a harness
 * path in the register below as a string literal, and turned that gate red. The
 * consequence is written down under "what this cannot see" rather than worked
 * around, because working around it would mean spelling a path so as not to
 * match another guard's detector, which is the same move this file exists to
 * stop.
 */
const ROOTS = ['src'];

/**
 * Source with `//` and block comments removed.
 *
 * Every detector below runs on the output. A `.rs` filename written in prose —
 * and this repository's guards write a great many of them — is a claim about
 * the tree, not a read of it, and counting those would make the register a list
 * of files that mention Rust rather than a list of files that open it.
 */
function stripComments(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === '//') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

/** A string literal naming a file with a `.rs` extension. */
const NAMES_A_RUST_SOURCE = /['"`][A-Za-z0-9_@./-]*\.rs['"`]/;

/**
 * A call that opens the tree.
 *
 * Required alongside {@link NAMES_A_RUST_SOURCE} because naming a Rust file is
 * not reading one: `attachment-rules.test.ts` classifies a fabricated
 * `main.rs` upload and `window-controls.test.tsx` lists `build.rs` among
 * filenames a config reader must refuse. Neither opens anything, and putting
 * them on the register would make it a list of files that mention Rust — which
 * churns on every new fixture, and a register that churns is a register that
 * gets weakened.
 *
 * The pair is still over-inclusive in one direction, deliberately: a `.rs`
 * written in prose *inside a string literal* survives the comment strip, which
 * is why `reachable.test.ts` is registered below. Over-inclusion costs an
 * entry; under-inclusion costs a miss, and a miss is the failure this file
 * exists to prevent.
 */
const READS_THE_FILESYSTEM = /\breadFileSync\s*\(|\breaddirSync\s*\(/;

function typescriptFilesUnder(directory: string, prefix: string, found: string[]): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) typescriptFilesUnder(join(directory, entry.name), name, found);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) found.push(name);
  }
  return found;
}

const TYPESCRIPT_FILES: readonly string[] = ROOTS.flatMap((root) =>
  typescriptFilesUnder(join(REPO_ROOT, root), root, []).sort(),
);

const CODE: ReadonlyMap<string, string> = new Map(
  TYPESCRIPT_FILES.map((file) => [
    file,
    stripComments(readFileSync(join(REPO_ROOT, ...file.split('/')), 'utf8')),
  ]),
);

function readsRustSource(file: string): boolean {
  const code = CODE.get(file) ?? '';
  return NAMES_A_RUST_SOURCE.test(code) && READS_THE_FILESYSTEM.test(code);
}

/**
 * What each reader of Rust source does with the bytes.
 *
 * `wire-keys` means *this file turns a Rust identifier into the JSON key that
 * crosses the bridge*, and those are the files that must not have a parse of
 * their own. Everything else says what it reads instead, because a register of
 * bare paths would let a wire-key reader be added as though it were a text scan
 * with nothing to notice the difference.
 */
type Reader = { readonly role: 'wire-keys' } | { readonly role: 'text'; readonly because: string };

const RUST_READERS: ReadonlyMap<string, Reader> = new Map<string, Reader>([
  ['src/platform/chat-contract-parity.test.ts', { role: 'wire-keys' }],
  ['src/platform/skill-store-parity.test.ts', { role: 'wire-keys' }],
  ['src/platform/project-host-parity.test.ts', { role: 'wire-keys' }],
  [
    'src/platform/serde-wire.test.ts',
    {
      role: 'text',
      because:
        'this file. Its fixtures name `.rs` paths so the detectors can be shown failing, ' +
        'which puts it inside its own scan — registered rather than special-cased, because ' +
        'a scanner that exempts itself is the first place a hole hides',
    },
  ],
  [
    'src/runtime/reachable.test.ts',
    {
      role: 'text',
      because:
        'walks `src/` for TypeScript modules and follows their imports. It opens no Rust at ' +
        'all; the `.rs` names in it are prose inside the reasons on its own exemption ' +
        'registers, which the comment strip cannot remove because they are string literals',
    },
  ],
  [
    'src/platform/claimed-guards.test.ts',
    {
      role: 'text',
      because:
        'resolves backticked names in comments against the tree. It reads Rust for the ' +
        'identifiers declared in it, never for the keys serde emits from them',
    },
  ],
  [
    'src/platform/no-provider-leak.test.ts',
    {
      role: 'text',
      because:
        'scans for forbidden provider literals appearing anywhere in the tree. A vocabulary ' +
        'scan over bytes, with no notion of a member or of a wire key',
    },
  ],
  [
    'src/platform/control-characters.test.ts',
    {
      role: 'text',
      because:
        'scans source bytes for control characters and confusable spellings. It cares what ' +
        'the characters are, not what any of them names',
    },
  ],
  [
    'src/features/diagnostics/dead-pointer.test.ts',
    {
      role: 'text',
      because:
        'checks that the debug log the correlation id points into can be switched on from a ' +
        'registered command. It reads Rust for call sites, not for serialised shapes',
    },
  ],
]);

/**
 * Definitions that would mean a file had grown its own parse again.
 *
 * The last is the exact regex the two copies carried — `rename_all\s*=` — whose
 * two-literal alternation read every other serde rule as "no rule at all".
 */
const OWN_PARSE = [
  /function\s+parseRustItem\b/,
  /function\s+wireName\b/,
  /function\s+scanSerialisable\b/,
  /rename_all\\s\*=/,
];

describe('there is one reader of Rust wire keys, and it is known how many there are', () => {
  it('accounts for every TypeScript file that reads a Rust source off disk', () => {
    const scanned = TYPESCRIPT_FILES.filter(readsRustSource).sort();
    expect(scanned, 'a file reads a .rs source and is not on the register').toEqual(
      [...RUST_READERS.keys()].sort(),
    );
  });

  it('finds enough TypeScript to have been looking', () => {
    // Anti-vacuity for the scan itself, paired with named paths so a skip rule
    // that emptied `src/platform/**` could not satisfy it with a count alone.
    expect(TYPESCRIPT_FILES.length).toBeGreaterThan(100);
    expect(TYPESCRIPT_FILES).toContain('src/platform/serde-wire.test.ts');
    expect(TYPESCRIPT_FILES).toContain('src/platform/chat-contract-parity.test.ts');
  });

  it('every guard that reads wire keys gets them from the one reader', () => {
    const wireKeyReaders = [...RUST_READERS]
      .filter(([, reader]) => reader.role === 'wire-keys')
      .map(([file]) => file)
      .sort();
    // Named, not counted. A count cannot say which one stopped importing it.
    expect(wireKeyReaders).toEqual([
      'src/platform/chat-contract-parity.test.ts',
      'src/platform/project-host-parity.test.ts',
      'src/platform/skill-store-parity.test.ts',
    ]);
    for (const file of wireKeyReaders) {
      const code = CODE.get(file) ?? '';
      expect(code, `${file} does not import the shared reader`).toContain("from './serde-wire'");
      for (const pattern of OWN_PARSE) {
        expect(pattern.test(code), `${file} has grown its own parse again: ${pattern}`).toBe(false);
      }
    }
  });

  it('every other reader says what it reads Rust for', () => {
    for (const [file, reader] of RUST_READERS) {
      if (reader.role === 'wire-keys') continue;
      expect(reader.because.length, `${file} has no reason`).toBeGreaterThan(40);
    }
  });
});

describe('the detectors can fail', () => {
  // Controls. Every assertion above is only as good as the two functions
  // underneath it, and a `stripComments` that returned '' or a regex that
  // matched nothing would make this whole file pass while measuring nothing.

  it('does not count a .rs filename that only appears in prose', () => {
    const prose = [
      '/** Mirrors `src-tauri/crates/vela-providers/src/model.rs`. */',
      "// see 'store.rs' for the listing shape",
      'export const NOTHING = 1;',
    ].join('\n');
    expect(NAMES_A_RUST_SOURCE.test(prose)).toBe(true);
    expect(NAMES_A_RUST_SOURCE.test(stripComments(prose))).toBe(false);
  });

  it('does count a .rs filename the code actually opens', () => {
    const code = "const source = readFileSync(join(CRATE, 'model.rs'), 'utf8');";
    expect(NAMES_A_RUST_SOURCE.test(stripComments(code))).toBe(true);
  });

  it('does not mistake a neighbouring extension for a Rust source', () => {
    for (const literal of ["'README.rst'", "'notes.rs.md'", "'rs'", "'model.rust'"]) {
      expect(NAMES_A_RUST_SOURCE.test(literal), literal).toBe(false);
    }
  });

  it('strips a block comment without eating the code after it', () => {
    expect(stripComments('const a = 1; /* x */ const b = 2;')).toBe('const a = 1;  const b = 2;');
    expect(stripComments('const a = 1; // x\nconst b = 2;')).toBe('const a = 1; \nconst b = 2;');
  });

  it('reports a wire-key reader that grew its own parse', () => {
    // The fabricated regression, so the loop above is known to be able to fail.
    const fabricated = [
      "import { readFileSync } from 'node:fs';",
      'const rename = /rename_all\\s*=\\s*"(camelCase|snake_case)"/.exec(text);',
      'function parseRustItem(source: string) { return source; }',
    ].join('\n');
    expect(fabricated).not.toContain("from './serde-wire'");
    expect(OWN_PARSE.filter((pattern) => pattern.test(fabricated))).toHaveLength(2);
  });

  it('reports a real guard as clean under the same patterns', () => {
    // The other half of the control: the patterns must not fire on the files
    // that really are clean, or the loop above would be unfalsifiable.
    const real = CODE.get('src/platform/skill-store-parity.test.ts') ?? '';
    expect(real.length).toBeGreaterThan(1000);
    expect(OWN_PARSE.some((pattern) => pattern.test(real))).toBe(false);
  });
});
