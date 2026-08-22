/**
 * No two files in one directory may collide when the filesystem folds case.
 *
 * This is the guard for a defect this container **cannot observe**. Linux is
 * case-sensitive; Windows/NTFS and macOS/APFS are not, by default. Every gate
 * this project runs is a Linux gate, so a case collision is green here and
 * fatal there — and it stays green here forever, because nothing about running
 * the suite again makes Linux fold case.
 *
 * The defect that produced this file: `src/features/conversation/` held both
 * `Markdown.tsx` (the component) and `markdown.ts` (the parser).
 * `MessageTurn.tsx` did `import { Markdown } from './Markdown'`. Vite tries
 * `.ts` before `.tsx`, so on a case-insensitive filesystem that specifier
 * resolved to the **parser**, which exports no `Markdown`. On Windows 11 the
 * result was a fully blank window under `pnpm tauri dev` — identical in
 * Chromium, so not a WebView2 bug — and `pnpm build` exiting 2 with TS1149 /
 * TS2305 / TS1261. `pnpm verify` could not pass on that machine while every
 * cloud run stayed green. 1455 passing assertions said nothing about it.
 *
 * Two distinct hazards are checked, because they fail differently:
 *
 * 1. **Checkout collision** — two paths differing only by case cannot both
 *    exist in a case-insensitive working tree. `git clone` materialises one and
 *    leaves the other permanently "modified". Nothing imports its way out of
 *    that; the file is simply not there.
 * 2. **Resolution ambush** — two *module stems* differing only by case, with
 *    different extensions, coexist fine on disk but make every extensionless
 *    import between them ambiguous. The bundler's extension order decides which
 *    file a specifier means, and that order is not case-aware. This is the one
 *    that shipped.
 *
 * The fix for either is a rename to a name that differs by **more than case**.
 * A case-only rename (`markdown.ts` → `Markdown.ts`) is not a fix: it does not
 * propagate through a case-insensitive checkout, so the collision survives the
 * commit that claims to have removed it.
 *
 * `forceConsistentCasingInFileNames` does not cover this, and is already on.
 * That flag rejects importing *one* file under two spellings; it has nothing to
 * say about two *different* files whose names fold together. It was on for the
 * entire life of the defect.
 *
 * Both detectors are pure functions over a list of names, so the tests that
 * prove they can fail construct name lists rather than writing files into the
 * shared tree.
 */

import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();

/**
 * Everything a bundler, `tsc`, `cargo` or a gate script will actually read out
 * of this repo. `tests/` is in the set because the harness is TypeScript with
 * its own vitest config, and a collision there breaks `pnpm test:harness` on a
 * developer's machine exactly as one in `src/` breaks the app.
 */
const ROOTS = ['src', 'src-tauri', 'tests', 'scripts'] as const;

/**
 * Build output and vendored trees. These are regenerated, not authored, and
 * `src-tauri/target` alone is tens of gigabytes — walking it would turn a
 * millisecond guard into a minute of I/O for no signal.
 */
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
 * Vite's default `resolve.extensions`, **in resolution order**. An
 * extensionless import is tried against each in turn, and the first hit wins.
 * On a case-folding filesystem "first hit" ignores the case of the stem, which
 * is precisely the ambush: `./Markdown` reaches `markdown.ts` before it ever
 * considers `Markdown.tsx`.
 */
const RESOLVED_EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'] as const;

/** `['Markdown.tsx', 'Markdown']` — extension included only if it is a resolved one. */
function splitResolvedStem(name: string): readonly [ext: string, stem: string] | undefined {
  const ext = RESOLVED_EXTENSIONS.find((candidate) => name.endsWith(candidate));
  if (ext === undefined) return undefined;
  return [ext, name.slice(0, -ext.length)];
}

/**
 * Names in one directory that a case-insensitive filesystem cannot tell apart.
 * Returns the offending groups, lowercase key first, so the message can name
 * every member rather than just a pair.
 */
export function caseFoldedNameGroups(names: readonly string[]): ReadonlyArray<readonly string[]> {
  const byFoldedName = new Map<string, string[]>();
  for (const name of names) {
    const key = name.toLowerCase();
    byFoldedName.set(key, [...(byFoldedName.get(key) ?? []), name]);
  }
  return [...byFoldedName.values()].filter((group) => group.length > 1);
}

/**
 * Names in one directory whose *stems* fold together while their names do not.
 * These coexist on disk; what they break is extensionless import resolution.
 *
 * `Markdown.tsx` + `markdown.ts` → reported. `Markdown.tsx` +
 * `Markdown.module.css` → not: `.module.css` is not a resolved extension, so
 * that pairing has no ambiguous specifier. `Markdown.tsx` + `Markdown.test.tsx`
 * → not: the stems are `Markdown` and `Markdown.test`, which differ.
 */
export function ambiguousStemGroups(names: readonly string[]): ReadonlyArray<readonly string[]> {
  const byFoldedStem = new Map<string, string[]>();
  for (const name of names) {
    const split = splitResolvedStem(name);
    if (split === undefined) continue;
    const key = split[1].toLowerCase();
    byFoldedStem.set(key, [...(byFoldedStem.get(key) ?? []), name]);
  }
  return [...byFoldedStem.values()].filter(
    // More than one file is fine when the stems agree exactly on case — that is
    // just `foo.ts` beside `foo.json`, which no filesystem confuses.
    (group) => new Set(group.map((name) => splitResolvedStem(name)?.[1])).size > 1,
  );
}

interface Directory {
  /** Repo-relative, `/`-separated, for stable failure messages on any host. */
  readonly path: string;
  readonly fileNames: readonly string[];
  readonly directoryNames: readonly string[];
}

function walk(absoluteDir: string, into: Directory[] = []): Directory[] {
  const entries = readdirSync(absoluteDir, { withFileTypes: true });
  const directoryNames = entries
    .filter((entry) => entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name))
    .map((entry) => entry.name);

  into.push({
    path: relative(REPO_ROOT, absoluteDir).split(sep).join('/'),
    fileNames: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    directoryNames,
  });

  for (const name of directoryNames) walk(join(absoluteDir, name), into);
  return into;
}

const DIRECTORIES = ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)));

describe('the tree survives a case-insensitive checkout', () => {
  it('walks a tree that is actually there', () => {
    // Cheap insurance against the whole guard quietly degrading to a no-op: a
    // typo in ROOTS, an over-eager skip list, or a readdir that starts
    // returning nothing would otherwise leave every assertion below vacuously
    // green, which is the exact failure mode this file was written to end.
    expect(DIRECTORIES.length).toBeGreaterThan(20);
    const conversation = DIRECTORIES.find((d) => d.path === 'src/features/conversation');
    expect(conversation?.fileNames).toContain('MessageTurn.tsx');
  });

  it.each(DIRECTORIES.map((directory) => ({ directory, path: directory.path })))(
    'has no case-only duplicate names in $path',
    ({ directory }) => {
      const groups = caseFoldedNameGroups([
        ...directory.fileNames,
        ...directory.directoryNames,
      ]);
      expect(
        groups,
        `${directory.path} contains entries that differ only by case: ` +
          `${groups.map((group) => group.join(' / ')).join('; ')}. ` +
          'A case-insensitive checkout can only materialise one of them. Rename ' +
          'one so the names differ by more than case — a case-only rename does ' +
          'not propagate through such a checkout.',
      ).toEqual([]);
    },
  );

  it.each(DIRECTORIES.map((directory) => ({ directory, path: directory.path })))(
    'has no case-ambiguous module stems in $path',
    ({ directory }) => {
      const groups = ambiguousStemGroups(directory.fileNames);
      expect(
        groups,
        `${directory.path} contains module files whose stems differ only by ` +
          `case: ${groups.map((group) => group.join(' / ')).join('; ')}. ` +
          'On Windows and macOS an extensionless import of either one resolves ' +
          'by extension order (' +
          RESOLVED_EXTENSIONS.join(' before ') +
          '), not by case, so the specifier silently binds the wrong file and ' +
          'the app fails to mount. Rename one stem so they differ by more than ' +
          'case, e.g. markdown.ts -> markdown-parser.ts.',
      ).toEqual([]);
    },
  );
});

describe('the detectors can fail', () => {
  // The guard above is only worth its runtime if it is not vacuous. These drive
  // the same two functions with the shapes they exist to catch. They use
  // literal name lists rather than files, so proving non-vacuity never puts a
  // collision into a tree four other builders are working in.

  it('catches names that differ only by case', () => {
    expect(caseFoldedNameGroups(['Markdown.tsx', 'markdown.tsx'])).toEqual([
      ['Markdown.tsx', 'markdown.tsx'],
    ]);
  });

  it('catches the exact pair that blanked the window on Windows', () => {
    expect(
      ambiguousStemGroups(['Markdown.tsx', 'Markdown.module.css', 'markdown.ts', 'notices.ts']),
    ).toEqual([['Markdown.tsx', 'markdown.ts']]);
  });

  it('catches a case-only rename, which is not a fix', () => {
    // `markdown.ts` -> `Markdown.ts` looks like a fix in a diff and is not one:
    // both stems still fold to `markdown`, and on the machine that had the bug
    // the rename does not even reach the disk.
    expect(ambiguousStemGroups(['Markdown.tsx', 'Markdown.ts'])).toEqual([]);
    expect(caseFoldedNameGroups(['Markdown.tsx', 'Markdown.ts'])).toEqual([]);
    expect(ambiguousStemGroups(['MessageTurn.tsx', 'messageturn.ts']).length).toBe(1);
  });

  it('leaves legitimate neighbours alone', () => {
    // Same stem, same case, different extension: `foo.ts` beside `foo.json` is
    // unambiguous on every filesystem. Colocated tests and CSS modules carry a
    // distinct stem and are not module-resolvable respectively.
    expect(ambiguousStemGroups(['scroll.ts', 'scroll.json'])).toEqual([]);
    expect(ambiguousStemGroups(['Composer.tsx', 'Composer.test.tsx'])).toEqual([]);
    expect(ambiguousStemGroups(['Composer.tsx', 'composer.module.css'])).toEqual([]);
    expect(caseFoldedNameGroups(['Composer.tsx', 'composer.module.css'])).toEqual([]);
  });
});
