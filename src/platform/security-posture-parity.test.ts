/**
 * The TypeScript half of the `tests/parity/security-posture.json` fixture.
 *
 * Its Rust twin is
 * `src-tauri/crates/vela-settings/tests/security_posture_parity.rs`. Both read
 * the same file, iterate the same rows and compare against the same expected
 * values, so `BrowserAdapter` and the real host cannot drift apart without a
 * red test naming the row that moved.
 *
 * Rows are driven through the **real command surface** — `secrets_set` then
 * `settings_put_provider` — rather than by calling `assessSecurity` directly.
 * A fake that is only correct when poked internally teaches the UI nothing.
 *
 * See `tests/parity/README.md` for the format and for how to add a row.
 *
 * **VERIFIED-BY-FAKE.** Configuration and derivation only; no socket is opened
 * and no row is evidence about a real model endpoint.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from './browser-adapter';
import type { AuthMode, Concern, NetworkScope, RiskLevel, SecurityPosture } from './contract';

interface FixtureCase {
  readonly name: string;
  /** Documentation for humans; deliberately unused by the assertions. */
  readonly why: string;
  readonly baseUrl: string;
  readonly auth: AuthMode;
  readonly credentialPresent: boolean;
  readonly credentialRequired: boolean;
  readonly expect: {
    readonly level: RiskLevel;
    readonly scope: NetworkScope;
    readonly leavesDevice: boolean;
    readonly trafficIsPlaintext: boolean;
    readonly credentialSentInPlaintext: boolean;
    readonly credentialInQueryString: boolean;
    readonly endpointIsUnauthenticated: boolean;
    readonly concerns: readonly Concern[];
  };
}

interface Fixture {
  readonly concerns: readonly Concern[];
  readonly cases: readonly FixtureCase[];
}

// From the repo root, as `adapter.test.ts` does: under jsdom, `import.meta.url`
// is an http: URL served by Vite, not a file: one.
const FIXTURE_PATH = join(process.cwd(), 'tests', 'parity', 'security-posture.json');

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;

/**
 * Mirrors `Concern::ALL`. Written out rather than derived from the fixture so
 * that the fixture is checked against this file, not against itself — a variant
 * dropped from the union has to fail somewhere, and this is where.
 */
const ALL_CONCERNS: readonly Concern[] = [
  'credentialSentInPlaintext',
  'plaintextTrafficLeavesDevice',
  'queryParamCredentialIsLogged',
  'remoteEndpointIsUnauthenticated',
  'requiredCredentialMissing',
];

/** Drives one fixture row through the adapter and returns the posture it produced. */
async function postureFor(testCase: FixtureCase): Promise<SecurityPosture> {
  const adapter = new BrowserAdapter({ now: () => 0 });
  const id = 'fixture-provider';

  if (testCase.credentialPresent) {
    await adapter.invoke('secrets_set', { providerId: id, value: 'placeholder-not-a-real-key' });
  }

  const view = await adapter.invoke('settings_put_provider', {
    id,
    displayName: 'Fixture provider',
    kind: 'remoteApi',
    baseUrl: testCase.baseUrl,
    auth: testCase.auth,
    authRequirement: testCase.credentialRequired ? 'required' : 'notRequired',
  });

  expect(view.credentialPresent, `${testCase.name}: fixture row set itself up wrong`).toBe(
    testCase.credentialPresent,
  );
  return view.security;
}

describe('security-posture parity fixture', () => {
  it('lists every Concern variant, in wire order', () => {
    // Runs before the cases matter: a variant added in one language and not the
    // other fails here with a clear message, rather than as a confusing array
    // mismatch three rows down.
    expect(fixture.concerns).toEqual(ALL_CONCERNS);
    expect([...ALL_CONCERNS].sort()).toEqual(ALL_CONCERNS);
  });

  it('has unique, non-trivial rows', () => {
    const names = fixture.cases.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const row of fixture.cases) {
      expect(row.why.length, `${row.name}: every row explains what it protects`).toBeGreaterThan(20);
    }
  });

  for (const testCase of fixture.cases) {
    it(`matches the fake host: ${testCase.name}`, async () => {
      const posture = await postureFor(testCase);
      // Compared whole, and `concerns` order is part of it. Rust sorts by the
      // derived Ord and this side sorts strings; the fixture is where those two
      // orderings are pinned to each other.
      expect(posture).toEqual(testCase.expect);
    });
  }
});

describe('the query-string credential finding', () => {
  // Phase A security critic, finding 1. These assert the shape of the fixture
  // itself, so the rows that close the finding cannot quietly be deleted.
  const httpsQuery = fixture.cases.find(
    (row) =>
      row.auth.type === 'apiKeyQuery' &&
      row.baseUrl.startsWith('https://') &&
      row.expect.scope !== 'loopback',
  );
  const httpsHeader = fixture.cases.find(
    (row) => row.auth.type === 'apiKeyHeader' && row.baseUrl.startsWith('https://'),
  );
  const loopbackQuery = fixture.cases.find(
    (row) => row.auth.type === 'apiKeyQuery' && row.expect.scope === 'loopback',
  );

  it('is covered by an https row, because TLS is what does not help here', async () => {
    expect(httpsQuery, 'no https + query-param row: the finding is unguarded').toBeDefined();
    const row = httpsQuery as FixtureCase;
    expect(row.expect.trafficIsPlaintext).toBe(false);
    expect(row.expect.concerns).toContain('queryParamCredentialIsLogged');
    expect(row.expect.level).not.toBe('none');

    const posture = await postureFor(row);
    expect(posture.credentialInQueryString).toBe(true);
    expect(posture.concerns).toContain('queryParamCredentialIsLogged');
  });

  it('has a header-bound control row that stays clean', async () => {
    expect(httpsHeader, 'no https + header-key control row').toBeDefined();
    const row = httpsHeader as FixtureCase;
    // Without this control the concern could degenerate into "a credential
    // exists" and every other assertion would still pass.
    expect(row.expect.level).toBe('none');
    expect((await postureFor(row)).credentialInQueryString).toBe(false);
  });

  it('stays silent on loopback', async () => {
    expect(loopbackQuery, 'nothing stops this becoming a false positive').toBeDefined();
    const row = loopbackQuery as FixtureCase;
    expect(row.expect.level).toBe('none');
    expect((await postureFor(row)).credentialInQueryString).toBe(false);
  });
});
