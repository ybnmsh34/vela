/**
 * Guards the committed GATE M evidence.
 *
 * A verdict that cites a stale transcript is worthless, and the failure mode is
 * silent: someone changes the harness, forgets to re-record, and the bytes in
 * `docs/regression-baseline/mock-matrix/` now describe a server that no longer
 * exists. This test replays every recorded request and compares the response
 * to the file on disk, byte for byte.
 *
 * If it fails, do not edit the transcripts. Re-run:
 *   node tests/harness/mock-provider/src/record-transcripts.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PROFILE_NAMES } from './profiles.ts';
import { captures, outputRoot } from './record-transcripts.ts';
import { startMockProvider, type MockProviderHandle } from './server.ts';

const running: MockProviderHandle[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((handle) => handle.close()));
});

describe('the committed mock-matrix transcripts', () => {
  it('exist for every profile in the matrix', () => {
    expect(existsSync(join(outputRoot, 'README.md'))).toBe(true);
    for (const name of PROFILE_NAMES) {
      expect(existsSync(join(outputRoot, name, 'manifest.json')), name).toBe(true);
    }
  });

  it('still match what the harness produces today, byte for byte', async () => {
    for (const name of PROFILE_NAMES) {
      const mock = await startMockProvider({ profile: name });
      running.push(mock);

      for (const capture of captures(mock.profile.contextWindow)) {
        const response = await fetch(`${mock.url}${capture.path}`, {
          method: capture.method,
          ...(capture.body === undefined
            ? {}
            : {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(capture.body),
              }),
        });
        const fresh = await response.text();
        const committed = readFileSync(join(outputRoot, name, capture.file), 'utf8');

        // Two different faults reach this assertion, and they have opposite
        // remedies — so name which one before advising anything.
        //
        // If the only difference is CRLF, the capture is *not* stale: git
        // converted it on checkout. `.gitattributes` marks this directory
        // `-text` to stop that, but an attribute added after a file is already
        // in the working tree does not rewrite it, and git's stat cache means
        // `git status` keeps reporting clean while the bytes on disk differ
        // from the blob. Measured here: 58 of 106 files in that state, all
        // CRLF on disk and pure LF in the object store.
        //
        // Re-recording would "fix" it by overwriting a baseline that was
        // correct, replacing evidence recorded at a known past moment with a
        // capture taken now — which is the one property a regression baseline
        // has. The remedy is to restore the bytes git already holds.
        if (fresh !== committed && fresh === committed.replaceAll('\r\n', '\n')) {
          expect.fail(
            `${name}/${capture.file} differs from the harness only in line endings, so it is ` +
              `NOT stale — your working tree was converted on checkout. Do not re-record. ` +
              `Restore the committed bytes:\n` +
              `    rm -rf docs/regression-baseline/mock-matrix\n` +
              `    git checkout -- docs/regression-baseline/mock-matrix`,
          );
        }

        expect(fresh, `${name}/${capture.file} is stale — re-run record-transcripts.ts`).toBe(
          committed,
        );
      }
    }
  });

  it('says plainly that it is not evidence about a real model', () => {
    const readme = readFileSync(join(outputRoot, 'README.md'), 'utf8');
    expect(readme).toContain('not evidence about any real model');
    expect(readme).toContain('VERIFIED-BY-FAKE');
  });
});
