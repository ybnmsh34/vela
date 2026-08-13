/**
 * The TypeScript half of `tests/parity/navigation.json`.
 *
 * The Rust half is `src-tauri/tests/navigation_parity_fixture.rs`. Both read
 * every row from the same file, so a row added there is asserted here without
 * touching this file — and a rule that drifts in one language fails by name in
 * the other. See `tests/parity/README.md`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  deriveTitle,
  ftsQuery,
  isPlaceholderTitle,
  MAX_TITLE_CHARS,
  UNTITLED_TITLE,
} from './navigation-text';

interface Case {
  readonly name: string;
  readonly why: string;
  readonly input: string;
  readonly expect: string | null;
}

interface Fixture {
  readonly maxTitleChars: number;
  readonly untitledTitle: string;
  readonly titleDerivation: readonly Case[];
  readonly searchQuery: readonly Case[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'tests', 'parity', 'navigation.json'), 'utf8'),
) as Fixture;

describe('navigation text rules, against the shared fixture', () => {
  it('agrees with the fixture about its own constants', () => {
    expect(fixture.maxTitleChars).toBe(MAX_TITLE_CHARS);
    expect(fixture.untitledTitle).toBe(UNTITLED_TITLE);
    expect(isPlaceholderTitle(fixture.untitledTitle)).toBe(true);
  });

  it('has not lost its rows — the fixture is the specification, not a sample', () => {
    expect(fixture.titleDerivation.length).toBeGreaterThanOrEqual(15);
    expect(fixture.searchQuery.length).toBeGreaterThanOrEqual(8);
  });

  describe.each(fixture.titleDerivation)('deriveTitle: $name', (testCase) => {
    it(`${testCase.why}`, () => {
      expect(deriveTitle(testCase.input)).toEqual(testCase.expect);
    });
  });

  describe.each(fixture.searchQuery)('ftsQuery: $name', (testCase) => {
    it(`${testCase.why}`, () => {
      expect(ftsQuery(testCase.input)).toEqual(testCase.expect);
    });
  });

  it('never derives a blank, over-long or multi-line title', () => {
    // The rows assert specific answers; this asserts the property they are all
    // instances of, so a new row cannot quietly relax it.
    for (const testCase of fixture.titleDerivation) {
      const title = deriveTitle(testCase.input);
      if (title === null) continue;
      expect(title.trim(), testCase.name).not.toBe('');
      expect([...title].length, testCase.name).toBeLessThanOrEqual(MAX_TITLE_CHARS + 1);
      expect(title, testCase.name).not.toContain('\n');
    }
  });
});

describe('placeholder recognition', () => {
  it('treats blank and the host placeholder as "not yet named"', () => {
    expect(isPlaceholderTitle('')).toBe(true);
    expect(isPlaceholderTitle('   ')).toBe(true);
    expect(isPlaceholderTitle(UNTITLED_TITLE)).toBe(true);
    expect(isPlaceholderTitle(`  ${UNTITLED_TITLE}  `)).toBe(true);
  });

  it('treats anything the user chose as named, including a lookalike', () => {
    expect(isPlaceholderTitle('New conversations')).toBe(false);
    expect(isPlaceholderTitle('Star charts')).toBe(false);
  });
});
