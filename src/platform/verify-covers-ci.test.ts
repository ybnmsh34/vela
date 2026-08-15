/**
 * `pnpm verify` must be a superset of CI.
 *
 * This is the guard for a failure that already happened. Three builders each
 * finished green locally and each shipped a problem that CI caught, because
 * `pnpm verify` was quietly narrower than the workflow: it ran the tests but
 * not `pnpm build`, not `cargo build`, not `--locked`, and not the transcript
 * reproducibility check, which at the time existed only as an inline block in
 * `ci.yml` and so could not be run locally at all.
 *
 * A local gate that is weaker than the remote one does not save a round trip;
 * it hides the failure until the round trip is expensive. So the relationship
 * is asserted rather than maintained by hand: every gate command in `ci.yml`
 * must be reachable from the `verify` script. Adding a step to the workflow and
 * forgetting `verify` now fails here, at the cheapest possible moment.
 *
 * Deliberately *not* asserted: that the two run the same commands in the same
 * order, or that `verify` runs nothing extra. `verify` may be stricter. It may
 * never be looser.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const WORKFLOW = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/**
 * Expands `pnpm <name>` references in a script body, recursively, so a command
 * CI runs directly is still found when `verify` reaches it through a chain like
 * `verify` → `lint:rust` → `cargo clippy …`.
 */
function expand(script: string, seen = new Set<string>()): string {
  return script.replace(/pnpm (?:run )?([\w:-]+)/g, (match, name: string) => {
    if (seen.has(name) || PACKAGE.scripts[name] === undefined) return match;
    seen.add(name);
    return `${match} ${expand(PACKAGE.scripts[name], seen)}`;
  });
}

const VERIFY = expand(PACKAGE.scripts.verify ?? '');

/**
 * Every command in `ci.yml` that is a *gate* — something that can fail the
 * build on the state of the tree. Setup steps (installing apt packages, fetching
 * toolchains) are not gates and are not listed.
 *
 * The `matches` value is what must appear somewhere in the expanded `verify`
 * chain. It is the command's distinguishing part, so that reformatting either
 * side does not produce a false failure.
 */
const CI_GATES: ReadonlyArray<{ readonly ci: string; readonly matches: RegExp }> = [
  { ci: 'pnpm typecheck', matches: /pnpm (?:run )?typecheck/ },
  { ci: 'cargo fmt --all --check', matches: /cargo fmt --all --check/ },
  { ci: 'cargo clippy --workspace --all-targets -- -D warnings', matches: /cargo clippy --workspace --all-targets -- -D warnings/ },
  { ci: 'pnpm test', matches: /pnpm (?:run )?test(?![\w:-])/ },
  { ci: 'pnpm test:harness', matches: /pnpm (?:run )?test:harness/ },
  { ci: 'pnpm build', matches: /pnpm (?:run )?build/ },
  { ci: './scripts/check-transcripts.sh', matches: /check-transcripts\.sh/ },
  { ci: 'cargo build --workspace --locked', matches: /cargo build --workspace --locked/ },
  { ci: 'cargo test --workspace --locked', matches: /cargo test --workspace --locked/ },
  { ci: './scripts/secret-scan.test.sh', matches: /secret-scan\.test\.sh/ },
  { ci: './scripts/secret-scan.sh', matches: /secret-scan\.sh/ },
];

describe('the local gate is a superset of the remote one', () => {
  it.each(CI_GATES)('verify reaches the CI gate: $ci', ({ ci, matches }) => {
    expect(
      WORKFLOW.includes(ci),
      `this test's list is stale: ci.yml no longer runs "${ci}"`,
    ).toBe(true);
    expect(
      matches.test(VERIFY),
      `ci.yml runs "${ci}" but "pnpm verify" does not. A green local run would ` +
        `not mean a green CI run. Add it to the verify chain in package.json.`,
    ).toBe(true);
  });

  it('every gate command in the workflow is accounted for above', () => {
    // Catches the other direction: a *new* CI step that nobody listed here, and
    // which therefore silently escapes the check above.
    // Both spellings: `- run: x` (a step with no name) and a `run:` line under
    // a `- name:`. Missing the first form would leave a whole class of step
    // silently unchecked, which is the exact bug this file exists to prevent.
    const runLines = [...WORKFLOW.matchAll(/^[ \t]*-?[ \t]*run: (.+)$/gm)]
      .map((match) => (match[1] ?? '').trim())
      .filter((line) => line !== '|');
    expect(runLines.length).toBeGreaterThanOrEqual(CI_GATES.length);

    const unaccounted = runLines.filter(
      (line) =>
        !line.startsWith('sudo apt-get') &&
        !line.startsWith('pnpm install') &&
        !CI_GATES.some(({ ci }) => line.includes(ci)),
    );

    expect(
      unaccounted,
      'a new CI step appeared. Add it to CI_GATES and to "pnpm verify", or ' +
        'exempt it here with a reason if it is setup rather than a gate.',
    ).toEqual([]);
  });

  it('every job that runs cargo can actually build the dependency graph', () => {
    // The failure this catches, found at Phase B integration: `static` ran
    // `cargo clippy` on a bare runner. Clippy builds before it lints, the graph
    // contains glib-sys / gtk-sys / soup3-sys / javascriptcore-rs-sys /
    // webkit2gtk-sys, and each resolves its system library through pkg-config in
    // a build script. The job died at glib-sys without ever reaching Vela's
    // code — and nobody noticed, because the draft guard meant the workflow had
    // never run. `verify` passing locally says nothing here: this container has
    // the packages, so the gap is invisible from a green local run.
    //
    // The rule is "a cargo job must be able to build the graph"; the apt list is
    // only how that is true on Linux. Those were the same sentence while every
    // job ran on `ubuntu-latest`, and the first Windows job made them different
    // — this guard failed it, correctly by its own words and wrongly on the
    // facts. `webkit2gtk` IS the Linux backend for the webview; `windows-latest`
    // ships WebView2 and has no package to install, so demanding the apt step
    // there demands a step that cannot exist.
    //
    // It now asks what the runner needs, and an unrecognised runner fails:
    // "I do not know what this machine has" should be a question, not a pass.
    for (const [name, body] of ciJobs()) {
      const usesCargo = /^[ \t]*-?[ \t]*run: .*\bcargo\b/m.test(body) || /\n\s+cargo /.test(body);
      if (!usesCargo) continue;

      const runner = /runs-on:\s*(\S+)/.exec(body)?.[1] ?? '';
      expect(runner, `CI job "${name}" has no runs-on this test can read`).not.toBe('');

      if (runner.startsWith('ubuntu')) {
        expect(
          body.includes('libwebkit2gtk-4.1-dev'),
          `CI job "${name}" runs cargo on Linux but never installs the Tauri ` +
            'system dependencies. It will fail in a build script before linting ' +
            'or testing anything. Copy the "Install Tauri system dependencies" step.',
        ).toBe(true);
      } else if (runner.startsWith('windows') || runner.startsWith('macos')) {
        // Assert the absence of the Linux step as well. Copying it here would
        // fail on a runner with no apt, so its absence should read as a decision
        // rather than as something nobody got round to.
        expect(
          body.includes('apt-get'),
          `CI job "${name}" runs on ${runner} and installs Linux packages. The ` +
            'webview ships with the OS there; apt-get does not exist on it.',
        ).toBe(false);
      } else {
        expect.fail(
          `CI job "${name}" runs cargo on "${runner}", which this guard cannot ` +
            'reason about. Teach it what that runner provides before trusting a ' +
            'green run from it.',
        );
      }
    }
  });
});

/** `[jobName, jobBody]` for each job in the workflow, split on the job headers. */
function ciJobs(): Array<[string, string]> {
  const afterJobs = WORKFLOW.slice(WORKFLOW.indexOf('\njobs:'));
  const headers = [...afterJobs.matchAll(/^ {2}([\w-]+):$/gm)];
  return headers.map((header, index) => {
    const start = header.index ?? 0;
    const next = headers[index + 1]?.index;
    return [header[1] ?? '', afterJobs.slice(start, next ?? afterJobs.length)];
  });
}
