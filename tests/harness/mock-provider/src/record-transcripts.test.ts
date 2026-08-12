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
