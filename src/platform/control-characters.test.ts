/**
 * No shipping source file may contain a raw control character.
 *
 * ## The defect that produced this file
 *
 * `src/features/models/catalogue.ts` built a React key by joining two ids with
 * a **NUL typed literally into the template string** rather than written as the
 * escape `\u0000`. It worked. That is the problem: a byte that no editor draws,
 * no diff shows and no reviewer can see was load-bearing behaviour, and every
 * tool between the author and the running app was free to eat it — a copy-paste
 * through a terminal, a `sed` pass, an editor that strips controls on save, a
 * patch applied through a web UI, `git apply --whitespace=fix`. Any of those
 * turns the separator into nothing at all, and two different endpoints silently
 * start sharing a key.
 *
 * The rule is therefore about *representation*, not about the value: a control
 * character a program needs is written as an escape, where it is visible,
 * greppable, and survives every transport a diff can take.
 *
 * ## What is checked
 *
 * C0 controls (`U+0000`–`U+001F`) except tab, newline and carriage return; DEL
 * (`U+007F`); the two Unicode line separators `U+2028`/`U+2029`, which end a
 * line for a JavaScript parser but not for a human or for `grep`; and `U+FEFF`,
 * a byte-order mark that breaks a parser wherever it lands and is invisible
 * everywhere.
 *
 * The detector is a pure function over a string, so the tests that prove it can
 * fail pass it literals rather than writing a defect into a tree four other
 * builders are working in. Every one of those literals is spelled with escapes
 * — writing them as themselves would put the bytes this file forbids into the
 * file that forbids them, and the guard would have to exempt itself.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();

/** Everything authored by hand that a build, a gate or a reader consumes. */
const ROOTS = ['src', 'src-tauri', 'tests', 'scripts', 'docs'] as const;

/** Single files at the repo root that are just as much shipping source. */
const ROOT_FILES = ['index.html', 'package.json', 'vite.config.ts'] as const;

/** Generated or vendored. Regenerated, not authored — and `target` is enormous. */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.vite',
  'coverage',
  'dist',
  'gen',
  'node_modules',
  'target',
]);

/**
 * Text formats only. A `.png` is not source, and a screenshot full of NUL bytes
 * is simply a screenshot.
 */
const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.rs',
  '.sh',
  '.toml',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

/**
 * Built from a string of escapes on purpose, for the reason in the module doc:
 * the character class must not be written with the characters it names.
 */
const FORBIDDEN = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u2028\\u2029\\uFEFF]',
  'u',
);

export interface ControlCharacterFinding {
  /** 1-based, so a failure message can be pasted into an editor's go-to-line. */
  readonly line: number;
  /** 1-based column of the offender on that line. */
  readonly column: number;
  /** `U+0000` — the only readable way to name something invisible. */
  readonly codePoint: string;
}

/** Every raw control character in `text`, named and located. */
export function controlCharacterFindings(text: string): readonly ControlCharacterFinding[] {
  const findings: ControlCharacterFinding[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!FORBIDDEN.test(line)) continue;
    let column = 0;
    for (const character of line) {
      column += 1;
      if (!FORBIDDEN.test(character)) continue;
      findings.push({
        line: index + 1,
        column,
        codePoint: `U+${(character.codePointAt(0) ?? 0)
          .toString(16)
          .toUpperCase()
          .padStart(4, '0')}`,
      });
    }
  }
  return findings;
}

function walk(absoluteDirectory: string, into: string[] = []): string[] {
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const absolute = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(absolute, into);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) {
      into.push(absolute);
    }
  }
  return into;
}

const FILES = [
  ...ROOTS.flatMap((root) => walk(join(REPO_ROOT, root))),
  ...ROOT_FILES.map((name) => join(REPO_ROOT, name)),
].map((absolute) => relative(REPO_ROOT, absolute).split(sep).join('/'));

describe('no shipping source carries a raw control character', () => {
  it('scans a tree that is actually there', () => {
    // The same insurance `case-collision.test.ts` carries: a typo in ROOTS or an
    // over-eager skip list would leave every assertion below vacuously green,
    // and a guard that cannot fail is worse than no guard, because it is
    // believed.
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES).toContain('src/features/models/catalogue.ts');
    expect(FILES).toContain('src-tauri/src/lib.rs');
  });

  it.each(FILES.map((path) => ({ path })))('%s', ({ path }) => {
    const findings = controlCharacterFindings(readFileSync(join(REPO_ROOT, path), 'utf8'));
    expect(
      findings,
      `${path} contains raw control characters at ` +
        `${findings
          .map((finding) => `${String(finding.line)}:${String(finding.column)} ${finding.codePoint}`)
          .join(', ')}. ` +
        'Write the character as an escape, where it is visible in a diff and ' +
        'survives every editor and patch tool between here and the build — or ' +
        'choose a separator that is printable.',
    ).toEqual([]);
  });
});

/**
 * The characters under test, built rather than typed. Naming them is also the
 * only way a reader can tell which one a case is about.
 */
const NUL = String.fromCodePoint(0);
const BEL = String.fromCodePoint(7);
const ESC = String.fromCodePoint(0x1b);
const BOM = String.fromCodePoint(0xfeff);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);

describe('the detector can fail', () => {
  it('catches the NUL that shipped in a template string', () => {
    // The literal defect, reconstructed from an escape: `entryKey` joined a
    // provider id and a model id with a raw NUL at column 13.
    expect(controlCharacterFindings(`return \`\${a}${NUL}\${b}\`;`)).toEqual([
      { line: 1, column: 13, codePoint: 'U+0000' },
    ]);
  });

  it('names the line and the code point of every offender', () => {
    expect(controlCharacterFindings(`ok\nx${BEL}y${ESC}`)).toEqual([
      { line: 2, column: 2, codePoint: 'U+0007' },
      { line: 2, column: 4, codePoint: 'U+001B' },
    ]);
  });

  it('catches the invisible ones that are not C0 at all', () => {
    // A byte-order mark in the middle of a file and a Unicode line separator:
    // both end a construct for a parser, and neither is visible to a reviewer.
    expect(controlCharacterFindings(`a${BOM}b`).map((finding) => finding.codePoint)).toEqual([
      'U+FEFF',
    ]);
    expect(
      controlCharacterFindings(`a${LINE_SEPARATOR}b`).map((finding) => finding.codePoint),
    ).toEqual(['U+2028']);
  });

  it('leaves the whitespace real source is made of alone', () => {
    expect(controlCharacterFindings('\tif (x) {\r\n\t\treturn 1;\r\n\t}\n')).toEqual([]);
    // …and the *escape* is what the fix looks like, so it must never be
    // flagged: six printable characters, not one invisible one.
    expect(controlCharacterFindings(String.raw`return \u0000;`)).toEqual([]);
  });
});
