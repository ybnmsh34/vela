/**
 * The boundary, checked.
 *
 * Everything a `SandboxBackendReport` could truthfully call `kernel` for the
 * document family is a claim about two attributes on one element, and this is the
 * file that makes those claims true rather than merely written down. If any
 * assertion here goes red, the correct response is to fix the frame, not to
 * soften a report — a report that says `network: 'kernel'` over a frame with no
 * CSP is the exact shape of defect the contract's reference study is about.
 *
 * The only report in this tree that does say it is the fake host in
 * `document-host-double.ts`; the shipped host says `unenforced`, because it draws
 * no frame. The assertions below are about the frame itself and hold regardless
 * of which host is on the other side of the seam.
 */

import { describe, expect, it } from 'vitest';

import type { DocumentProgram } from '@/platform/contract-sandbox';

import { frameFor, svgFailsToParse } from './document-frame';

const HTML_DENIED: DocumentProgram = {
  kind: 'document',
  language: 'html',
  source: '<p>hello</p>',
  scripts: 'denied',
};

const HTML_SCRIPTED: DocumentProgram = {
  kind: 'document',
  language: 'html',
  source: '<script>document.title = "x";</script>',
  scripts: 'sandboxedNullOrigin',
};

const SVG: DocumentProgram = {
  kind: 'document',
  language: 'svg',
  source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle r="4"/></svg>',
};

const REACT: DocumentProgram = {
  kind: 'document',
  language: 'react',
  source: 'export default () => <p>hi</p>;',
  scripts: 'denied',
};

const MERMAID: DocumentProgram = {
  kind: 'document',
  language: 'mermaid',
  source: 'graph TD; A-->B;',
};

const EVERY_PROGRAM = [HTML_DENIED, HTML_SCRIPTED, SVG, REACT, MERMAID];

describe('the frame never gets Vela’s origin', () => {
  it('omits allow-same-origin from every program shape there is', () => {
    // The single worst line of code that could be written in this repo would be
    // adding this token beside `allow-scripts`. There is no program, no
    // language, and no script setting for which it is correct.
    for (const program of EVERY_PROGRAM) {
      expect(frameFor(program).sandbox).not.toContain('allow-same-origin');
    }
  });

  it('grants nothing at all when script is denied', () => {
    expect(frameFor(HTML_DENIED).sandbox).toBe('');
    expect(frameFor(SVG).sandbox).toBe('');
    expect(frameFor(MERMAID).sandbox).toBe('');
  });

  it('grants exactly one token when script is allowed', () => {
    expect(frameFor(HTML_SCRIPTED).sandbox).toBe('allow-scripts');
  });
});

describe('the policy is first, because a policy that is not first is not a policy', () => {
  it('puts the CSP meta ahead of anything the model wrote', () => {
    for (const program of EVERY_PROGRAM) {
      const html = frameFor(program).html;
      const policyAt = html.indexOf('http-equiv="Content-Security-Policy"');
      const bodyAt = html.indexOf('<body>');
      expect(policyAt).toBeGreaterThan(-1);
      expect(policyAt).toBeLessThan(bodyAt);
    }
  });

  it('denies everything by default, and closes the two holes default-src leaves', () => {
    for (const program of EVERY_PROGRAM) {
      const html = frameFor(program).html;
      expect(html).toContain("default-src 'none'");
      // Neither of these is covered by `default-src`, and both are navigations
      // — the one way out of a document that can reach nothing.
      expect(html).toContain("form-action 'none'");
      expect(html).toContain("base-uri 'none'");
    }
  });

  it('does not permit script in the policy when script is denied', () => {
    expect(frameFor(HTML_DENIED).html).not.toContain('script-src');
    expect(frameFor(SVG).html).not.toContain('script-src');
  });

  it('permits inline script only for the program that asked for it', () => {
    expect(frameFor(HTML_SCRIPTED).html).toContain("script-src 'unsafe-inline'");
  });
});

describe('the bridge exists only where something can run', () => {
  it('is injected ahead of the model’s own script', () => {
    const html = frameFor(HTML_SCRIPTED).html;
    const bridgeAt = html.indexOf('vela:canvas:diagnostic');
    const modelAt = html.indexOf('document.title');
    expect(bridgeAt).toBeGreaterThan(-1);
    expect(bridgeAt).toBeLessThan(modelAt);
  });

  it('is absent from every frame that cannot execute it', () => {
    for (const program of [HTML_DENIED, SVG, REACT, MERMAID]) {
      expect(frameFor(program).html).not.toContain('vela:canvas:diagnostic');
    }
  });
});

describe('the model’s source is the body, verbatim', () => {
  it('inlines HTML without rewriting it', () => {
    expect(frameFor(HTML_DENIED).html).toContain('<body><p>hello</p></body>');
  });

  it('strips an XML prologue off an SVG so it can be inlined at all', () => {
    const prologued: DocumentProgram = {
      kind: 'document',
      language: 'svg',
      source: `<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n${SVG.source}`,
    };
    const html = frameFor(prologued).html;
    expect(html).not.toContain('<?xml');
    expect(html).not.toContain('<!DOCTYPE svg');
    expect(html).toContain('<circle r="4"/>');
  });
});

describe('an SVG that does not parse is found before the frame is drawn', () => {
  it('accepts a well-formed one', () => {
    expect(svgFailsToParse(SVG.source)).toBe(false);
  });

  it('rejects an unclosed one', () => {
    // The only route to `sourceRejectedByParser` this build has: a frame with an
    // opaque origin cannot be read, so a document that died inside it is
    // invisible and Vela's `load` handler fires exactly as for a good one.
    expect(svgFailsToParse('<svg><circle r="4"></svg>')).toBe(true);
  });
});
