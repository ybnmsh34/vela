/**
 * Adapter parity — the TypeScript half.
 *
 * Its Rust twin is `src-tauri/tests/adapter_parity_fixture.rs`; both read
 * `tests/parity/adapter-parity.json`, iterate the same rows, and compare
 * against the same expected values. The command *names* have been pinned
 * across the two languages since Phase A
 * (`ipc::tests::rust_and_typescript_allowlists_are_identical`); this pair pins
 * the *semantics* of `settings_put_provider` — endpoint parsing and
 * normalisation, network-scope classification, the security posture, the
 * `AuthMode -> ProviderAuth` binding, the credential check and the field
 * label — including the rejection paths.
 *
 * Rows are driven through the **real command surface**, not by calling the
 * adapter's internals: a fake that is only correct when poked from inside
 * teaches the UI nothing.
 *
 * **The Rust host is the specification.** When the two disagree, the fake is
 * wrong (`docs/architecture/conventions.md` §8). Never edit a row to make this
 * suite go green.
 *
 * **VERIFIED-BY-FAKE.** Configuration and derivation only. No socket is opened;
 * nothing here is evidence about a real endpoint or a real keychain.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from './browser-adapter';
import { PlatformError, toPlatformError } from './errors';
import type {
  AuthMode,
  AuthRequirement,
  Concern,
  CredentialCheck,
  NetworkScope,
  ProviderAuth,
  ProviderKind,
  RiskLevel,
} from './contract';

interface CaseInput {
  readonly baseUrl: string;
  readonly authMode: AuthMode;
  readonly credentialStored: boolean;
  readonly authRequirement: AuthRequirement;
  /** Only present on rows that deliberately break the id. */
  readonly id?: string;
  /** Only present on rows that deliberately break the display name. */
  readonly displayName?: string;
}

interface AcceptedExpectation {
  readonly accepted: true;
  readonly baseUrl: string;
  readonly auth: ProviderAuth;
  readonly scope: NetworkScope;
  readonly riskLevel: RiskLevel;
  readonly concerns: readonly Concern[];
  readonly leavesDevice: boolean;
  readonly trafficIsPlaintext: boolean;
  readonly credentialSentInPlaintext: boolean;
  readonly endpointIsUnauthenticated: boolean;
  readonly credentialPresent: boolean;
  readonly usable: boolean;
  readonly credentialCheck: CredentialCheck;
  readonly credentialFieldLabel: string | null;
}

interface RejectedExpectation {
  readonly accepted: false;
  /** The field named by the host's `invalid <field>: <reason>` message. */
  readonly invalidField: string;
}

interface FixtureCase {
  readonly id: string;
  /** Documentation for humans; deliberately unused by the assertions. */
  readonly why: string;
  readonly input: CaseInput;
  readonly expect: AcceptedExpectation | RejectedExpectation;
}

interface Fixture {
  readonly providerId: string;
  readonly displayName: string;
  readonly kind: ProviderKind;
  readonly credentialValue: string;
  readonly cases: readonly FixtureCase[];
}

// From the repo root, as `security-posture-parity.test.ts` does: under jsdom,
// `import.meta.url` is an http: URL served by Vite, not a file: one.
const FIXTURE_PATH = join(process.cwd(), 'tests', 'parity', 'adapter-parity.json');

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;

/**
 * The host renders every rejection as `invalid <field>: <reason>` (see
 * `SettingsError`/`CoreError`). The renderer never parses a message — but a
 * *test* may, and doing so is what lets both languages agree on which field was
 * at fault without inventing a new wire field.
 */
function invalidField(error: PlatformError): string {
  const match = /^invalid ([^:]+):/.exec(error.message);
  if (match === null) {
    throw new Error(`a rejection message must read \`invalid <field>: …\`, got: ${error.message}`);
  }
  return match[1] as string;
}

/** Run one fixture row through the fake and reduce it to the fixture's shape. */
async function observe(
  testCase: FixtureCase,
): Promise<AcceptedExpectation | RejectedExpectation> {
  // A fresh adapter per row: no state leaks from one row to the next.
  const adapter = new BrowserAdapter({ now: () => 0 });
  const id = testCase.input.id ?? fixture.providerId;
  const displayName = testCase.input.displayName ?? fixture.displayName;

  if (testCase.input.credentialStored) {
    await adapter.invoke('secrets_set', { providerId: id, value: fixture.credentialValue });
  }

  try {
    const view = await adapter.invoke('settings_put_provider', {
      id,
      displayName,
      kind: fixture.kind,
      baseUrl: testCase.input.baseUrl,
      auth: testCase.input.authMode,
      authRequirement: testCase.input.authRequirement,
    });
    return {
      accepted: true,
      baseUrl: view.baseUrl,
      auth: view.auth,
      scope: view.security.scope,
      riskLevel: view.security.level,
      concerns: view.security.concerns,
      leavesDevice: view.security.leavesDevice,
      trafficIsPlaintext: view.security.trafficIsPlaintext,
      credentialSentInPlaintext: view.security.credentialSentInPlaintext,
      endpointIsUnauthenticated: view.security.endpointIsUnauthenticated,
      credentialPresent: view.credentialPresent,
      usable: view.usable,
      credentialCheck: view.credentialCheck,
      credentialFieldLabel: view.credentialFieldLabel,
    };
  } catch (thrown) {
    const error = toPlatformError(thrown, 'settings_put_provider');
    expect(error.code, `${testCase.id}: a rejected configuration must be INVALID_PAYLOAD`).toBe(
      'INVALID_PAYLOAD',
    );
    return { accepted: false, invalidField: invalidField(error) };
  }
}

describe('adapter parity fixture', () => {
  it('is the same file the Rust half reads', () => {
    // The mirror of the Rust-side `both_languages_read_the_same_fixture_file`:
    // two halves that quietly diverge onto two files prove nothing.
    expect(FIXTURE_PATH.endsWith(join('tests', 'parity', 'adapter-parity.json'))).toBe(true);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(60);
  });

  it('has unique rows that each say why they exist', () => {
    const ids = fixture.cases.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of fixture.cases) {
      expect(row.why.length, `${row.id}: every row explains what it protects`).toBeGreaterThan(20);
    }
  });

  for (const testCase of fixture.cases) {
    it(`matches the host: ${testCase.id}`, async () => {
      const observed = await observe(testCase);
      // Compared whole. `concerns` order is part of it, and so is the
      // normalised `baseUrl` the UI echoes back to the user.
      expect(observed, testCase.why).toEqual(testCase.expect);
    });
  }
});
