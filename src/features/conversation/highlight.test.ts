import { describe, expect, it } from 'vitest';

import { languageLabel, tokenize, type TokenKind } from './highlight';

function kinds(source: string, language: string | null): TokenKind[] {
  return [...new Set(tokenize(source, language).map((token) => token.kind))];
}

function textOf(source: string, language: string | null): string {
  return tokenize(source, language)
    .map((token) => token.text)
    .join('');
}

describe('the highlighter', () => {
  it('never loses or reorders a character, whatever the language', () => {
    const source = 'const x = "a\\"b"; // note\n/* block */ 0xff\n';
    for (const language of ['typescript', 'rust', 'python', 'sql', null, 'brainfuck']) {
      expect(textOf(source, language)).toBe(source);
    }
  });

  it('marks strings, comments, numbers and keywords in a known language', () => {
    const tokens = tokenize('const total = 42; // sum', 'typescript');
    expect(tokens).toContainEqual({ kind: 'keyword', text: 'const' });
    expect(tokens).toContainEqual({ kind: 'number', text: '42' });
    expect(tokens).toContainEqual({ kind: 'comment', text: '// sum' });
  });

  it('resolves aliases the way a model writes them', () => {
    expect(tokenize('fn main() {}', 'rs')).toContainEqual({ kind: 'keyword', text: 'fn' });
    expect(tokenize('def go():', 'py')).toContainEqual({ kind: 'keyword', text: 'def' });
    expect(tokenize('echo hi', 'bash')).toContainEqual({ kind: 'plain', text: 'echo hi' });
  });

  /**
   * The honesty rule for this file: an unknown language gets structure, never
   * an invented keyword set. A wrongly highlighted word reads as a bug in the
   * model's answer.
   */
  it('highlights no keywords at all in an unknown language', () => {
    expect(kinds('const function class = 1', 'some-dsl')).not.toContain('keyword');
    expect(kinds('"still a string" /* and a comment */', 'some-dsl')).toEqual(
      expect.arrayContaining(['string', 'comment']),
    );
  });

  it('stops a single-quoted string at end of line, so an unbalanced quote cannot bleed', () => {
    // Half a line, mid-stream: everything after must not turn into a string.
    const tokens = tokenize('name = "unclosed\nconst after = 1;', 'typescript');
    expect(tokens).toContainEqual({ kind: 'string', text: '"unclosed' });
    expect(tokens).toContainEqual({ kind: 'keyword', text: 'const' });
  });

  it('does not treat a digit inside an identifier as a number', () => {
    const tokens = tokenize('let sha256 = 1', 'typescript');
    // The identifier survives whole — not `sha` plus a `256` painted as a number.
    expect(tokens.filter((token) => token.kind === 'plain').map((token) => token.text)).toContain(
      ' sha256 ',
    );
    expect(tokens.filter((token) => token.kind === 'number')).toEqual([
      { kind: 'number', text: '1' },
    ]);
  });

  it('labels a language only when one was given', () => {
    expect(languageLabel(null)).toBeNull();
    expect(languageLabel('  ')).toBeNull();
    expect(languageLabel('rust')).toBe('rust');
  });
});
