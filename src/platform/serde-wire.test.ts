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
 *   string literal ending `.rs`, with the comments removed, *and* gets hold of
 *   the filesystem". A reader that assembles its filenames by concatenation is
 *   invisible to it. That is a real hole, and it is why {@link RUST_READERS}
 *   carries a reason per entry rather than a bare list: the reasons are what a
 *   later reader checks against.
 * - **Reading through a local helper.** The second half of the detector is
 *   {@link READS_THE_FILESYSTEM}, which matches the `node:fs` import and the
 *   read-call names. A file that imports a reader from another module under
 *   `src/` and names neither is not selected. That is written out at the
 *   detector rather than only here, because the first version of it was two
 *   function names and a probe walked around it in one import.
 * - **`tests/`.** Out of scope, and not by choice: `no-app-import.test.ts`
 *   forbids any file under `src/` from naming the harness outside a comment, so
 *   a register living here cannot list a harness path.
 *   `tests/harness/mock-provider/no-app-import.test.ts` does read Rust — every
 *   `.rs` file under `src-tauri` that is not Rust test infrastructure, tested
 *   against `/tests\/harness|mock-provider/` after comments and `#[cfg(test)]`
 *   bodies are stripped, which is a substring scan for harness references and
 *   not a parse of anything — and this file does not see it. A wire-key reader
 *   written under `tests/` would be outside this question entirely.
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
 * Getting hold of the filesystem at all.
 *
 * Required alongside {@link NAMES_A_RUST_SOURCE} because naming a Rust file is
 * not reading one: `attachment-rules.test.ts` classifies a fabricated
 * `main.rs` upload, and `window-controls.test.tsx` names `build.rs` as the
 * negative control in `expect(unreadableConfigsIn(['tauri.conf.json',
 * 'Cargo.toml', 'build.rs'])).toEqual([])` — a `.rs` filename written down in
 * order to assert it is *not* a config the loader refuses over. Neither opens
 * anything, and putting
 * them on the register would make it a list of files that mention Rust — which
 * churns on every new fixture, and a register that churns is a register that
 * gets weakened.
 *
 * **This used to be two function names**, `readFileSync` and `readdirSync`, and
 * that was the hole. A probe wrote a fourth reader of the crate carrying the
 * exact old `rename_all` regex and reached the bytes with `readFile` from
 * `node:fs/promises`; this file stayed green, and switching that one import
 * back to `readFileSync` turned it red — so the detector, not the register, was
 * the single point of narrowness. Two function names are a literal standing in
 * for a capability. The **import** is the capability: nothing under `src/` can
 * open a file without asking `node:fs` for the means, so that is matched first,
 * with read-call names kept as a second alternative so a module that gets its
 * reader from somewhere else is still caught at the call site.
 *
 * Measured while swapping it, on the tree this is committed in: both the old
 * detector and this one select the same nine files out of 268 TypeScript files
 * under `src/`, so the widening costs no register entry today.
 *
 * The residual hole, stated rather than implied: a file that imports a *local*
 * helper which does the reading, and itself names neither `node:fs` nor a read
 * call, is invisible here. So is anything outside `src/` — see the header. The
 * pair is also over-inclusive in one direction, deliberately: a `.rs` written in
 * prose *inside a string literal* survives the comment strip, which is why
 * `reachable.test.ts` is registered below. Over-inclusion costs an entry;
 * under-inclusion costs a miss, and a miss is the failure this file exists to
 * prevent.
 */
const READS_THE_FILESYSTEM =
  /(?:from|import|require)\s*\(?\s*['"]node:fs(?:\/promises)?['"]|\bread(?:File|dir)(?:Sync)?\s*\(|\bcreateReadStream\s*\(|\bglobSync\s*\(/;

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
  ['src/platform/serde-wire-positions.test.ts', { role: 'wire-keys' }],
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

/** The one reader, whose definitions are the ones a guard may not restate. */
const SHARED_READER = 'src/platform/serde-wire.ts';

/**
 * **The spellings a definition can be written in, each with the four things
 * that make it a checkable spelling rather than a filter nobody looks at.**
 *
 * The list this replaces derived its names from one pattern —
 * `/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)/` — under a sentence promising that
 * *"a list read off the definition site cannot be short by an entry somebody
 * forgot"*. It was short by twenty-seven entries, and short **structurally**
 * rather than by forgetfulness, which is the one failure that sentence claims
 * cannot happen. Measured on the shared reader's own bytes: the `function`
 * pattern yields forty names, and the file defines eighteen further top-level
 * `const`s — `FIELD_DECLARATION`, `VARIANT_DECLARATION`, `CLOSING_PUNCTUATION`,
 * `CHAR_LITERAL`, `DECLARATION`, `RUST_IDENTIFIER`, `IDENTIFIER_CHARACTER`,
 * `IDENTIFIER_CONTINUE`, `CONTAINER_KEYS`, `FIELD_KEYS`, `INERT_ATTRIBUTES`,
 * `RENAME_RULES`, `CLOSERS`, `LONGEST_CHAR_LITERAL` and the four this round
 * adds — plus nine `const … = (…) =>` helpers, `atItemStart`, `pathStartAt`,
 * `bangBelongsToWord`, `readFieldAttribute`, `refuseField`, `refuseContainer`,
 * `rule`, `blank` and `quote`.
 *
 * Both directions were live and an adversary measured both. A working second
 * copy of `topLevelParts` written `const topLevelParts = (code: string) => …`
 * ran green in `skill-store-parity.test.ts` where the byte-identical
 * restatement spelled with `function` reds two named tests — because
 * `OWN_PARSE` compiled each name into `new RegExp('function\\s+' + name)`, so
 * even a name on the list escaped in the spelling the shared reader itself
 * prefers. And `FIELD_DECLARATION`, copied verbatim out of the shared reader
 * into `project-host-parity.test.ts`, was permitted, because a `const` could
 * not be on the list at all. **That is the historical failure mode, not a
 * hypothetical one:** the two stale copies this whole file exists to prevent
 * carried `rename_all\s*=`, a `const` regex.
 *
 * The fix that would have failed the same way is a wider pattern. What is here
 * instead is a **register of spellings**, and each row is asserted:
 *
 * - `derives` is what reads names out of the shared reader;
 * - `forbids` is what a guard restating one of those names is caught by, in
 *   *this* spelling;
 * - `restate` fabricates a definition in this spelling, so
 *   `forbids every definition the shared reader has, in every spelling it has
 *   one` can require the catch;
 * - `floor` is a name the shared reader really defines this way, so a spelling
 *   that stopped selecting anything is a named failure here rather than a
 *   silently empty half of a union.
 *
 * That last row is the thing the previous version had no equivalent of, and it
 * is the whole of the difference: a derived list is only as wide as its filter,
 * and a filter nothing asserts is the same defect one level down.
 */
interface DefinitionSpelling {
  readonly spelling: string;
  readonly derives: RegExp;
  readonly forbids: (name: string) => RegExp;
  readonly restate: (name: string) => string;
  readonly floor: string;
}

const DEFINITION_SPELLINGS: readonly DefinitionSpelling[] = [
  {
    spelling: 'a `function` declaration',
    derives: /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    forbids: (name) => new RegExp(`function\\s+${name}\\b`),
    restate: (name) => `function ${name}(source: string) { return source; }`,
    floor: 'parseRustItem',
  },
  {
    spelling: 'a top-level `const`',
    derives: /^(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
    forbids: (name) => new RegExp(`const\\s+${name}\\s*(?::[^=;\\n]*)?=`),
    restate: (name) => `const ${name} = /^(?:pub\\s+)?([a-z_][a-z0-9_]*)\\s*:/;`,
    floor: 'FIELD_DECLARATION',
  },
  {
    spelling: 'a `const` bound to an arrow function',
    derives:
      /\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]*)?=\s*(?:\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]*?)?=>/g,
    forbids: (name) => new RegExp(`const\\s+${name}\\s*(?::[^=;\\n]*)?=`),
    restate: (name) => `const ${name} = (source: string): string => source;`,
    floor: 'atItemStart',
  },
];

/**
 * Every definition the shared reader has, in every spelling it has one,
 * **read out of it** rather than listed here.
 */
const SHARED_DEFINITIONS: readonly string[] = [
  ...new Set(
    DEFINITION_SPELLINGS.flatMap((entry) =>
      [...(CODE.get(SHARED_READER) ?? '').matchAll(entry.derives)].map(
        (match) => match[1] as string,
      ),
    ),
  ),
].sort();

/**
 * Definitions in the shared reader a guard **may** restate, each with why.
 *
 * The default is forbidden and this is the exemption, so a definition added to
 * the shared reader is forbidden from the commit that adds it and stays that
 * way until somebody writes a sentence here. The one entry is the distinction
 * the shared reader's own header draws: *"a type-level helper has no
 * behaviour, so a second copy is the same helper by construction. That is the
 * exact opposite of the parse below, which is why this file exists and this
 * eight-line helper does not need to."*
 */
const RESTATABLE: ReadonlyMap<string, string> = new Map([
  [
    'everyVariantOf',
    'a type-level helper. It has no behaviour, so a second copy cannot be a refactor behind ' +
      'a first one; and exporting it would make one file type-level surface of another. All ' +
      'three guards restate it deliberately, and the shared reader says so in its header',
  ],
]);

const FORBIDDEN_DEFINITIONS: readonly string[] = SHARED_DEFINITIONS.filter(
  (name) => !RESTATABLE.has(name),
);

/**
 * Definitions that would mean a file had grown its own parse again.
 *
 * The last is the exact regex the two copies carried — `rename_all\s*=` — whose
 * two-literal alternation read every other serde rule as "no rule at all". It
 * is not a definition name, so it is written here rather than derived.
 */
const OWN_PARSE = [
  ...FORBIDDEN_DEFINITIONS.flatMap((name) =>
    DEFINITION_SPELLINGS.map((entry) => entry.forbids(name)),
  ),
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
      'src/platform/serde-wire-positions.test.ts',
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
    expect(READS_THE_FILESYSTEM.test(stripComments(code))).toBe(true);
  });

  it('counts a reader that never spells readFileSync', () => {
    // The evasion this detector was widened for, as a fixture. A fourth guard
    // that reads the crate with the promises API was invisible to a detector
    // made of two function names, and the register cannot fail for a file the
    // scan never selects.
    const promises = [
      "import { readFile } from 'node:fs/promises';",
      "const source = await readFile(join(CRATE, 'store.rs'), 'utf8');",
      'const rename = /rename_all\\s*=\\s*"(camelCase|snake_case)"/.exec(source);',
    ].join('\n');
    expect(NAMES_A_RUST_SOURCE.test(promises)).toBe(true);
    expect(READS_THE_FILESYSTEM.test(promises)).toBe(true);
    // Both halves of the detector select it on their own, so removing either
    // one would not reopen this specific hole — which is the point of matching
    // the capability and the call site rather than one of them.
    expect(/(?:from|import|require)\s*\(?\s*['"]node:fs(?:\/promises)?['"]/.test(promises)).toBe(
      true,
    );
    expect(/\bread(?:File|dir)(?:Sync)?\s*\(/.test(promises)).toBe(true);
    // And the detector it replaced does not.
    expect(/\breadFileSync\s*\(|\breaddirSync\s*\(/.test(promises)).toBe(false);
  });

  it('does not count a file that names a .rs source but opens nothing', () => {
    const inert = ["const FIXTURE = 'main.rs';", 'export const UPLOAD = { name: FIXTURE };'].join(
      '\n',
    );
    expect(NAMES_A_RUST_SOURCE.test(inert)).toBe(true);
    expect(READS_THE_FILESYSTEM.test(inert)).toBe(false);
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

  it('reads a definition out of the shared reader in every spelling it has one', () => {
    // **The filter, asserted.** A derived list is exactly as wide as the
    // pattern that derives it, and the previous version's pattern was one
    // third of the file's definitions under a sentence saying the list could
    // not be short. Each spelling has to select a non-empty set out of the
    // shared reader and has to select the name it is floored on, so a spelling
    // that stops seeing anything — because the file's style moved, or because
    // somebody widened a character class by mistake — names itself here rather
    // than quietly halving the law two tests down.
    const code = CODE.get(SHARED_READER) ?? '';
    expect(code.length, 'the shared reader was not loaded').toBeGreaterThan(1000);
    for (const entry of DEFINITION_SPELLINGS) {
      const found = [...code.matchAll(entry.derives)].map((match) => match[1] as string);
      expect(found.length, `${entry.spelling} selects nothing in the shared reader`).toBeGreaterThan(
        0,
      );
      expect(found, `${entry.spelling} no longer sees ${entry.floor}`).toContain(entry.floor);
      expect(SHARED_DEFINITIONS, `${entry.floor} is not on the derived list`).toContain(entry.floor);
    }
    // And the three floors are three different definitions, so a register of
    // three rows that had collapsed onto one pattern would fail here too.
    expect(new Set(DEFINITION_SPELLINGS.map((entry) => entry.floor)).size).toBe(
      DEFINITION_SPELLINGS.length,
    );
  });

  it('forbids every definition the shared reader has, in every spelling it has one', () => {
    // What the hand-written list could not say. A count of matches against one
    // fabricated source says nothing about the entries that source does not
    // match, so an entry could be deleted — and one was, in the probe that
    // produced this test — with everything green. Here each forbidden name is
    // fabricated in turn, **in each spelling**, and the list has to fire on
    // every one of them. One spelling per name was the previous version, and
    // an adversary landed a working second copy of `topLevelParts` through the
    // spelling it did not fabricate.
    for (const name of FORBIDDEN_DEFINITIONS) {
      for (const entry of DEFINITION_SPELLINGS) {
        const restated = entry.restate(name);
        expect(
          OWN_PARSE.some((pattern) => pattern.test(restated)),
          `${name} restated as ${entry.spelling} is not forbidden`,
        ).toBe(true);
      }
    }
    // The floor, named rather than counted: these are the definitions the two
    // stale copies actually carried, so a refactor that moved one *out* of the
    // shared reader — which is how a name leaves a derived list without
    // anybody deciding to let it — fails here.
    expect(SHARED_DEFINITIONS).toEqual(
      expect.arrayContaining([
        'parseRustItem',
        'payloadRecord',
        'payloadWireKeys',
        'readAttributeText',
        'scanSerialisable',
        'wireName',
      ]),
    );
    // And the exemption is real, current, and small: every name excused has to
    // be a definition that is really there, or it is a hole with a reason
    // attached to nothing.
    for (const [name, because] of RESTATABLE) {
      expect(SHARED_DEFINITIONS, `${name} is excused and the shared reader does not define it`)
        .toContain(name);
      expect(because.length, `${name} has no reason`).toBeGreaterThan(40);
      expect(FORBIDDEN_DEFINITIONS).not.toContain(name);
    }
  });

  it('reports a real guard as clean under the same patterns', () => {
    // The other half of the control: the patterns must not fire on the files
    // that really are clean, or the loop above would be unfalsifiable.
    const real = CODE.get('src/platform/skill-store-parity.test.ts') ?? '';
    expect(real.length).toBeGreaterThan(1000);
    expect(OWN_PARSE.some((pattern) => pattern.test(real))).toBe(false);
  });
});
