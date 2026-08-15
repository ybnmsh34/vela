/**
 * Detection and versioning: what becomes an artifact, and when two of them are
 * the same artifact.
 *
 * The two rules worth watching are the ones a user notices when they are wrong:
 * an unclosed fence must not become an artifact — that would be a run per token
 * while the model types — and a revision must land on the artifact it revises
 * rather than opening a second panel beside it.
 */

import { describe, expect, it } from 'vitest';

import { parseMarkdown } from '@/lib/markdown-parser';

import { MINIMUM_ARTIFACT_CHARS, collectArtifacts, detectArtifacts } from './artifacts';

const CHART_V1 = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
const CHART_V2 = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="8"/></svg>';

function detect(markdown: string) {
  return detectArtifacts(parseMarkdown(markdown));
}

describe('what becomes an artifact', () => {
  it('takes a closed fence in a language Canvas knows', () => {
    const found = detect(`Here you go.\n\n\`\`\`svg\n${CHART_V1}\n\`\`\`\n`);
    expect(found).toHaveLength(1);
    expect(found[0]?.program).toEqual({
      kind: 'document',
      language: 'svg',
      source: CHART_V1,
    });
    expect(found[0]?.title).toBe('SVG image');
  });

  it('leaves a fence that is still being typed alone', () => {
    // The parser reports the open fence; acting on it would submit a run for
    // every token, and the last one would be the only correct document.
    const found = detect(`\`\`\`svg\n${CHART_V1}`);
    expect(found).toEqual([]);
  });

  it('ignores a language that is not a document', () => {
    expect(detect('```python\nprint("a long enough line of code here")\n```')).toEqual([]);
    expect(detect('```\njust a plain fence with quite a lot of text in it\n```')).toEqual([]);
  });

  it('maps the three spellings a model uses for a component onto one language', () => {
    const body = 'export default function Chart() { return <p>enough characters here</p>; }';
    for (const tag of ['jsx', 'tsx', 'react']) {
      const found = detect(`\`\`\`${tag}\n${body}\n\`\`\``);
      expect(found[0]?.program.language).toBe('react');
    }
  });

  it('does not open a panel for an illustration', () => {
    const tiny = '<b>bold</b>';
    expect(tiny.length).toBeLessThan(MINIMUM_ARTIFACT_CHARS);
    expect(detect(`\`\`\`html\n${tiny}\n\`\`\``)).toEqual([]);
  });

  it('never carries a script decision detection did not make', () => {
    const found = detect('```html\n<p>a paragraph long enough to count as an artifact</p>\n```');
    const program = found[0]?.program;
    expect(program?.language).toBe('html');
    expect(program !== undefined && 'scripts' in program ? program.scripts : null).toBe('denied');
  });
});

describe('two blocks are the same artifact when they are in the same place', () => {
  it('gives each language its own ordinal within one message', () => {
    const found = detect(
      `\`\`\`svg\n${CHART_V1}\n\`\`\`\n\n\`\`\`svg\n${CHART_V2}\n\`\`\`\n\n\`\`\`html\n<p>a paragraph of quite sufficient length</p>\n\`\`\``,
    );
    expect(found.map((artifact) => artifact.slot)).toEqual(['svg#0', 'svg#1', 'html#0']);
    expect(found[1]?.title).toBe('SVG image 2');
  });

  it('files a later revision as a version of the artifact it revises', () => {
    const tracks = collectArtifacts([
      parseMarkdown(`\`\`\`svg\n${CHART_V1}\n\`\`\``),
      parseMarkdown(`Taller now.\n\n\`\`\`svg\n${CHART_V2}\n\`\`\``),
    ]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.versions.map((version) => version.program.source)).toEqual([
      CHART_V1,
      CHART_V2,
    ]);
    expect(tracks[0]?.versions.map((version) => version.index)).toEqual([0, 1]);
    expect(tracks[0]?.versions[1]?.messageIndex).toBe(1);
  });

  it('does not count a repetition as a revision', () => {
    // Without this the rail grows every time a restored transcript re-renders,
    // and "version 4 of 4" stops meaning anything.
    const tracks = collectArtifacts([
      parseMarkdown(`\`\`\`svg\n${CHART_V1}\n\`\`\``),
      parseMarkdown(`Unchanged.\n\n\`\`\`svg\n${CHART_V1}\n\`\`\``),
    ]);
    expect(tracks[0]?.versions).toHaveLength(1);
  });

  it('keeps a second artifact separate from the first', () => {
    const tracks = collectArtifacts([
      parseMarkdown(`\`\`\`svg\n${CHART_V1}\n\`\`\`\n\n\`\`\`svg\n${CHART_V2}\n\`\`\``),
    ]);
    expect(tracks.map((track) => track.slot)).toEqual(['svg#0', 'svg#1']);
  });

  it('reports nothing for a transcript with no artifacts in it', () => {
    expect(collectArtifacts([parseMarkdown('Just some prose, no fences at all.')])).toEqual([]);
  });
});
