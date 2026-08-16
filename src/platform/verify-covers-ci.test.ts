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
 * is asserted rather than maintained by hand: every gate command CI runs must be
 * reachable from the `verify` script. Adding a step to the workflow and
 * forgetting `verify` now fails here, at the cheapest possible moment.
 *
 * Deliberately *not* asserted: that the two run the same commands in the same
 * order, or that `verify` runs nothing extra. `verify` may be stricter. It may
 * never be looser.
 *
 * ## The second defect: one filename out of a directory the runner reads whole
 *
 * Every assertion below used to derive from a single `readFileSync` of
 * `.github/workflows/ci.yml`. GitHub Actions does not run a filename. It runs
 * **every** workflow file in `.github/workflows/`, so a second file there was
 * invisible to all three of the checks that scan the workflow — measured, not
 * assumed, by adding one: a second workflow carrying an unlisted gate command,
 * the crash-retry wrapper on a second job, and `cargo build` on a runner with no
 * Tauri system dependencies left this file 16/16 green.
 *
 * That is the same shape as the capability defect fixed alongside it, and takes
 * the same fix — see the header of `src/platform/capability-surface.ts`, which
 * is the worked example. Enumerate the directory, derive the union, assert over
 * the union, and pin the file list by name so that a new file is either counted
 * or reported. It is not extracted into a module the way the capability reader
 * was, because that reader has two callers and this one has none but this file;
 * a parse is worth sharing when it is otherwise written twice.
 *
 * ### What the runner loads, and where each rule errs
 *
 * 1. **Both YAML extensions, and nothing else.** A workflow file is `.yml` or
 *    `.yaml`; any other file in the directory is inert. Inert files are listed
 *    in {@link IGNORED_WORKFLOW_FILES} rather than passed over, so "GitHub does
 *    not load this" is a decision on the record and not an assumption.
 * 2. **Subdirectories are read anyway — deliberately wide.** GitHub picks up
 *    workflows at the top level of `.github/workflows/` only. This reader
 *    recurses, so a nested `.yml` is parsed and counted even though the runner
 *    would ignore it. Over-reporting costs a review; under-reporting is the
 *    defect above. The pinned list keeps the over-report from being silent.
 * 3. **A job's identity is its file *and* its name.** Two workflows may each
 *    hold a `test-windows`; they are two jobs. Every message below names a job
 *    as `file:job` for that reason, and the wrapper assertion pins the file too.
 *
 * ### Inputs this reader refuses rather than reading past
 *
 * Each of these can put a gate command into CI that no amount of scanning this
 * directory would find. There is no wide reading of them, so they throw:
 *
 * - **A local composite action** — a step whose `uses:` is a relative path to an
 *   action directory. Its own steps run commands, and they live in a definition
 *   file outside this directory that this reader never opens. There is no such
 *   directory in this tree today.
 * - **A remote reusable workflow** — a job whose `uses:` names a `.yml` in
 *   another repository. Its jobs are not in this directory at all. A *local*
 *   reusable workflow is fine and is not refused: it is a file in this
 *   directory, so enumerating the directory already reads it.
 * - **A workflow this reader cannot take apart** — no `jobs:` block it can find,
 *   no job headers under it, or a `run:` step that landed outside every job it
 *   found. A parser that quietly extracts nothing from a file reports the same
 *   green as a parser that read it and found nothing wrong, which is precisely
 *   the failure being fixed. A mis-rooted read throws out of `readdirSync` for
 *   the same reason.
 *
 * ### The third defect: a refusal that YAML quoting walked straight past
 *
 * The two refusals above took the `uses:` value as `(\S+)`, the raw token, and a
 * raw token carries its quotes. `uses: "./.github/actions/foo"` captured
 * `"./.github/actions/foo"` — a string beginning `"`, not `./` — so it matched
 * neither `startsWith('./')` nor `/\.ya?ml@/u`, fell off the end of
 * {@link refuseUnreadableUses}, and was allowed. Measured, not assumed: with
 * that one line added to `ci.yml`'s `static` job, this file was 17/17 green
 * twice over, and green again with `'…'`. Unquoted, the same line is refused.
 * A composite action in this repository, whose `run:` steps this reader cannot
 * see, got past the guard for it purely because somebody quoted the path.
 *
 * The value is now parsed rather than tokenised — see {@link usesValue}. Nothing
 * about which targets are refused changed; only whether the quoting could hide
 * one from the arms that refuse it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const WORKFLOW_DIRECTORY = ['.github', 'workflows'] as const;

/** Rule 1. The two extensions GitHub Actions loads. */
const LOADED_EXTENSIONS = ['.yml', '.yaml'] as const;

/**
 * **Every workflow file this guard has read**, pinned by name.
 *
 * The pin is the point. Everything below asserts a property of the *union* of
 * these files, and a union silently absorbs a new member: a second workflow adds
 * its gates to what CI runs, and an assertion over the union is still satisfied
 * by the first file. So the membership itself is asserted. Adding a workflow
 * fails here, and the fix is to read the new file, decide what it is, and add
 * its name — which is the review that a second workflow deserves.
 */
const WORKFLOW_FILES = ['ci.yml'] as const;

/**
 * Files in `.github/workflows/` that GitHub Actions does **not** load, because
 * their extension is not one of {@link LOADED_EXTENSIONS}.
 *
 * Empty, and listed rather than skipped: a file sitting in the workflows
 * directory that nothing runs is either a mistake or a decision, and this is
 * where the decision gets written down.
 */
const IGNORED_WORKFLOW_FILES: readonly string[] = [];

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
 * Every command in the workflows that is a *gate* — something that can fail the
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
  // The same gate, wrapped for the Windows job only. The wrapper re-runs a
  // vitest worker-pool CRASH — a run that printed no verdict — and passes a real
  // test failure straight through; see `scripts/ci-retry-vitest-crash.mjs`. It
  // is listed rather than exempted so that the harness gate cannot be swapped
  // for something else behind the wrapper without this file noticing, and
  // `matches` still demands that `verify` reach the unwrapped gate.
  {
    ci: 'node scripts/ci-retry-vitest-crash.mjs pnpm test:harness',
    matches: /pnpm (?:run )?test:harness/,
  },
  { ci: 'pnpm build', matches: /pnpm (?:run )?build/ },
  { ci: './scripts/check-transcripts.sh', matches: /check-transcripts\.sh/ },
  // The same script, reached the way a Windows developer reaches it. The Linux
  // job runs the file directly; `test-windows` runs it through `pnpm`, because
  // pnpm hands script bodies to `cmd.exe` and that is the hop that was broken.
  { ci: 'pnpm test:transcripts', matches: /pnpm (?:run )?test:transcripts/ },
  { ci: 'cargo build --workspace --locked', matches: /cargo build --workspace --locked/ },
  { ci: 'cargo test --workspace --locked', matches: /cargo test --workspace --locked/ },
  { ci: './scripts/secret-scan.test.sh', matches: /secret-scan\.test\.sh/ },
  { ci: './scripts/secret-scan.sh', matches: /secret-scan\.sh/ },
];

describe('the local gate is a superset of the remote one', () => {
  it('every workflow file the runner would load is one this guard reads', () => {
    // The membership assertion the union needs. See WORKFLOW_FILES.
    expect(
      SURFACE.files,
      'a workflow file appeared in .github/workflows/ that this guard has never ' +
        'read. GitHub Actions runs every file in that directory, so its steps are ' +
        'part of what CI gates on and every assertion in this file is now ' +
        'answering about a subset. Read it, add its gates to CI_GATES and to ' +
        '"pnpm verify", then add its name to WORKFLOW_FILES.',
    ).toEqual([...WORKFLOW_FILES]);

    expect(
      SURFACE.ignoredFiles,
      'a file is sitting in .github/workflows/ that GitHub Actions will not load, ' +
        'because its extension is neither .yml nor .yaml. If that is deliberate, ' +
        'say so by listing it in IGNORED_WORKFLOW_FILES; if it was meant to be a ' +
        'workflow, it is not running.',
    ).toEqual([...IGNORED_WORKFLOW_FILES]);
  });

  it.each(CI_GATES)('verify reaches the CI gate: $ci', ({ ci, matches }) => {
    expect(
      COMMANDS.some(({ command }) => isCommand(command, ci)),
      `this test's list is stale: no workflow under .github/workflows/ runs "${ci}"`,
    ).toBe(true);
    expect(
      matches.test(VERIFY),
      `CI runs "${ci}" but "pnpm verify" does not. A green local run would ` +
        `not mean a green CI run. Add it to the verify chain in package.json.`,
    ).toBe(true);
  });

  it('every gate command in the workflows is accounted for above', () => {
    // Catches the other direction: a *new* CI step that nobody listed here, and
    // which therefore silently escapes the check above. Over the union, so a
    // step added in a second workflow is caught the same as one added to
    // `ci.yml` — before this read the whole directory, it was not.
    expect(COMMANDS.length).toBeGreaterThanOrEqual(CI_GATES.length);

    const unaccounted = COMMANDS.filter(
      ({ command }) =>
        !command.startsWith('sudo apt-get') &&
        !command.startsWith('pnpm install') &&
        !CI_GATES.some(({ ci }) => isCommand(command, ci)),
    ).map(({ file, command }) => `${file}: ${command}`);

    expect(
      unaccounted,
      'a new CI step appeared. Add it to CI_GATES and to "pnpm verify", or ' +
        'exempt it here with a reason if it is setup rather than a gate.',
    ).toEqual([]);
  });

  it('the crash-retry wrapper is confined to the one job that needs it', () => {
    // `scripts/ci-retry-vitest-crash.mjs` re-runs a gate that crashed without
    // reporting any verdict. That is defensible exactly where the crash happens
    // and nowhere else: on a job that does not crash, the same wrapper is a
    // retry on ordinary flakiness, which is how a real intermittent failure
    // gets normalised into "just re-run it".
    //
    // Both the script and the workflow say "only here". Prose does not enforce
    // itself — spreading the wrapper to the Linux harness gate left this file
    // green, because the CI_GATES row for it is satisfied by the wrapped string
    // wherever it appears. This is what makes "only here" true.
    //
    // The job is named with its file. Confining the wrapper to a job *name* was
    // the second half of the same hole: a second workflow's `test-windows` is a
    // different job, and reading only one file could not tell them apart.
    const WRAPPER = 'ci-retry-vitest-crash.mjs';

    const wrappingJobs = JOBS.filter((job) =>
      new RegExp(`run:.*${WRAPPER}`, 'u').test(job.body),
    ).map(jobKey);
    expect(
      wrappingJobs,
      'the crash-retry wrapper belongs to `test-windows` in `ci.yml` alone. If ' +
        'another job now needs it, the crash has spread and the trigger should ' +
        'be found rather than the retry copied.',
    ).toEqual(['ci.yml:test-windows']);

    expect(
      COMMANDS.filter(({ command }) => command.includes(WRAPPER)).map(
        ({ file, command }) => `${file}: ${command}`,
      ),
      'the wrapper is for exactly one step, wrapping exactly the harness gate',
    ).toEqual(['ci.yml: node scripts/ci-retry-vitest-crash.mjs pnpm test:harness']);
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
    // It also asks it of every job in the directory rather than of one file's,
    // which is the third thing a second workflow used to walk straight past.
    for (const job of JOBS) {
      const name = jobKey(job);
      const usesCargo =
        /^[ \t]*-?[ \t]*run: .*\bcargo\b/m.test(job.body) || /\n\s+cargo /.test(job.body);
      if (!usesCargo) continue;

      const runner = /runs-on:\s*(\S+)/.exec(job.body)?.[1] ?? '';
      expect(runner, `CI job "${name}" has no runs-on this test can read`).not.toBe('');

      if (runner.startsWith('ubuntu')) {
        expect(
          job.body.includes('libwebkit2gtk-4.1-dev'),
          `CI job "${name}" runs cargo on Linux but never installs the Tauri ` +
            'system dependencies. It will fail in a build script before linting ' +
            'or testing anything. Copy the "Install Tauri system dependencies" step.',
        ).toBe(true);
      } else if (runner.startsWith('windows') || runner.startsWith('macos')) {
        // Assert the absence of the Linux step as well. Copying it here would
        // fail on a runner with no apt, so its absence should read as a decision
        // rather than as something nobody got round to.
        expect(
          job.body.includes('apt-get'),
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

describe('a uses: is refused on what it names, not on how it is quoted', () => {
  // The third defect in the header, held down. `refuseUnreadableUses` is called
  // on every real workflow by `readWorkflowSurface`, so a refusal that misfires
  // takes the whole file down at module load and the tests above never run —
  // which is exactly what the unquoted control does today, and exactly what the
  // quoted forms failed to do. These cases put single lines through the same
  // function, because whether a `uses:` is readable is a property of the line.
  //
  // Every quoting below is ordinary YAML. The runner resolves `"./x"`, `'./x'`
  // and `./x` to one target, so all three have to reach one verdict here.

  /** One step, spelled the way a workflow spells it. */
  const step = (written: string): string => `      - uses: ${written}`;

  /** The same step, put through the refusal. */
  function refuse(written: string): () => void {
    return (): void => {
      refuseUnreadableUses({
        file: 'probe.yml',
        text: ['jobs:', '  probe:', '    steps:', step(written)].join('\n'),
      });
    };
  }

  it.each([
    { quoting: 'unquoted', written: './.github/actions/foo' },
    { quoting: 'double-quoted', written: '"./.github/actions/foo"' },
    { quoting: 'single-quoted', written: "'./.github/actions/foo'" },
    { quoting: 'double-quoted, with a trailing comment', written: '"./.github/actions/foo" # bundle' },
  ])('refuses a local composite action written $quoting', ({ written }) => {
    // The message is asserted, not merely the throw, and it is asserted on the
    // *unquoted* path. A guard that threw while still holding `"./…"` would be
    // refusing something it had not managed to read.
    expect(
      refuse(written),
      'a composite action in this repository runs steps this reader never opens. ' +
        'Whether it is refused cannot depend on the quoting, which the runner ' +
        'does not see: quoting it was enough to walk past this guard.',
    ).toThrow('runs "./.github/actions/foo", a composite action in this repository');
  });

  it('refuses a composite action reached by a parent-relative path', () => {
    expect(refuse("'../actions/foo'")).toThrow(
      'runs "../actions/foo", a composite action in this repository',
    );
  });

  it.each([
    { quoting: 'unquoted', written: 'org/repo/.github/workflows/x.yml@main' },
    { quoting: 'double-quoted', written: '"org/repo/.github/workflows/x.yml@main"' },
    { quoting: 'single-quoted', written: "'org/repo/.github/workflows/x.yml@main'" },
  ])('refuses a remote reusable workflow written $quoting', ({ written }) => {
    // This arm was never blind to quoting — `/\.ya?ml@/u` is unanchored and
    // matches inside the quotes — but it *named* the quoted string back at the
    // reader. Asserting the unquoted name is what makes this row a test of the
    // parse rather than a second copy of the arm.
    expect(refuse(written)).toThrow(
      'calls "org/repo/.github/workflows/x.yml@main", a reusable workflow in another repository',
    );
  });

  it.each([
    { quoting: 'unquoted', written: './.github/workflows/reusable.yml', names: './.github/workflows/reusable.yml' },
    { quoting: 'double-quoted', written: '"./.github/workflows/reusable.yml"', names: './.github/workflows/reusable.yml' },
    { quoting: 'single-quoted', written: "'./.github/workflows/reusable.yaml'", names: './.github/workflows/reusable.yaml' },
    { quoting: 'unquoted, with a trailing comment', written: './.github/workflows/reusable.yml # local', names: './.github/workflows/reusable.yml' },
  ])('reads a local reusable workflow written $quoting and allows it', ({ written, names }) => {
    // Two assertions, because "it did not throw" on its own is also what a
    // reader that understood nothing would report — which is exactly how this
    // case passed before the parse existed: it fell off the end of every arm
    // rather than matching the one that admits it. The first assertion says
    // what was read; the case below says the admission is a decision.
    expect(usesValue(step(written))).toEqual({ kind: 'target', target: names });
    expect(
      refuse(written),
      'a local reusable workflow is a file in this directory. Enumerating the ' +
        'directory already read it and its jobs are already in JOBS.',
    ).not.toThrow();
  });

  it('refuses a relative path into the workflows directory that is not a workflow', () => {
    // The discriminator for the case above. A quoted relative path is now read
    // far enough to be *tested* against the local-reusable-workflow shape, so
    // one that does not have it is refused. Before the parse both landed in the
    // same place — allowed, unexamined — and no assertion could separate them.
    expect(refuse('"./.github/workflows/helper.sh"')).toThrow(
      'runs "./.github/workflows/helper.sh", a composite action in this repository',
    );
  });

  it('stops an unquoted uses: at the comment instead of swallowing it', () => {
    // `(\S+)` got this right and the replacement has to keep it. A parser that
    // took the rest of the line would refuse `./.github/actions/foo # bundle`,
    // naming a path that is not in the file.
    expect(refuse('./.github/actions/foo # bundle')).toThrow(
      'runs "./.github/actions/foo", a composite action in this repository',
    );
  });

  it('refuses a uses: whose opening quote never closes', () => {
    // Unquoted this exact target is *allowed* — it is the local reusable
    // workflow above — so neither guess is safe. Stripping the stray quote
    // admits a target the runner may never resolve; keeping the value raw is
    // the original defect verbatim, a leading `"` matching no arm. It is
    // refused instead, and the line is named.
    expect(
      refuse('"./.github/workflows/reusable.yml'),
      'a value this reader cannot read is not a value it may assume is harmless',
    ).toThrow('has a "uses:" whose quote never closes');
  });

  it.each([
    { quoting: 'unquoted', written: 'actions/checkout@v4', names: 'actions/checkout@v4' },
    { quoting: 'double-quoted', written: '"pnpm/action-setup@v4"', names: 'pnpm/action-setup@v4' },
    { quoting: 'single-quoted', written: "'dtolnay/rust-toolchain@stable'", names: 'dtolnay/rust-toolchain@stable' },
    { quoting: 'unquoted, with a trailing comment', written: 'Swatinem/rust-cache@v2 # cache', names: 'Swatinem/rust-cache@v2' },
  ])('reads a third-party action written $quoting and allows it', ({ written, names }) => {
    // The refusal is two named shapes, not a blanket one: enumerating what a
    // third-party action runs is neither this file's business nor within its
    // reach, and every workflow in this directory is full of them. Widening
    // either arm to cover these is caught by `ci.yml` itself at module load —
    // which is why the parse is asserted here as well. "Did not throw" is the
    // half of this case that the real file already proves; what was read is the
    // half that only these rows can say.
    expect(usesValue(step(written))).toEqual({ kind: 'target', target: names });
    expect(refuse(written)).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* the directory                                                              */
/* -------------------------------------------------------------------------- */

/** One workflow file the runner would load. */
interface Workflow {
  /** Relative to `.github/workflows/`, `/` separators. */
  readonly file: string;
  readonly text: string;
}

/** One `run:` command, carrying the file that runs it. */
interface WorkflowCommand {
  readonly file: string;
  readonly command: string;
}

/** One job, carrying the file that declares it. */
interface WorkflowJob {
  readonly file: string;
  readonly name: string;
  readonly body: string;
}

/** How every message below names a job — rule 3. */
function jobKey(job: WorkflowJob): string {
  return `${job.file}:${job.name}`;
}

/** Everything in `.github/workflows/`, split into what runs and what does not. */
interface WorkflowSurface {
  /** Loadable files, relative to the directory, sorted. */
  readonly files: readonly string[];
  /** Present but with an extension the runner ignores, same form. */
  readonly ignoredFiles: readonly string[];
  readonly workflows: readonly Workflow[];
}

/** Every file under a directory, recursively, as `/`-joined relative paths. */
function filesUnder(absolute: string, prefix: string, into: string[]): void {
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      filesUnder(join(absolute, entry.name), relative, into);
    } else {
      into.push(relative);
    }
  }
}

/**
 * What one `uses:` line names, once YAML quoting is off.
 *
 * `unterminated` is a case of its own because the alternative is to guess, and
 * both guesses are wrong in the direction that matters. This is a line reader,
 * not a YAML parser: given `uses: "./x` it cannot know whether the scalar
 * continues on the next line or the closing quote was simply dropped. Strip the
 * opening quote and it refuses a target the runner may never see; leave the
 * value raw and it is back to the defect in the header, since a leading `"`
 * matches none of the arms in {@link refuseUnreadableUses}. So the ambiguity is
 * carried out to the call site, which refuses it and says which line to fix.
 */
type UsesValue =
  | { readonly kind: 'target'; readonly target: string }
  | { readonly kind: 'unterminated'; readonly raw: string };

/**
 * The target of a `uses:` key, unquoted — or `undefined` when the line is not a
 * `uses:` key, which is most of them.
 *
 * This used to be `(\S+)` inline, and the quotes were the hole; see the third
 * defect in the header. YAML lets any scalar be quoted, `'…'` and `"…"` alike,
 * and the runner does not care which, so neither may this.
 *
 * The unquoted form still stops at the first whitespace, because that is where a
 * plain YAML scalar ends: `uses: ./x # why` names `./x`, not `./x # why`. The
 * quoted form ends at the closing quote for the same reason — the comment is
 * outside it.
 *
 * A `\"` escape inside a double-quoted scalar would cut the value short here. It
 * is not handled because no action path contains one, and the error is in the
 * safe direction: a truncated relative path is still relative, so it is still
 * refused.
 */
function usesValue(line: string): UsesValue | undefined {
  const rest = /^[ \t]*-?[ \t]*uses:[ \t]*(.*)$/u.exec(line)?.[1];
  if (rest === undefined) return undefined;

  const value = rest.trim();
  if (value === '') return undefined;

  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, 1);
    if (close === -1) return { kind: 'unterminated', raw: value };
    return { kind: 'target', target: value.slice(1, close) };
  }

  return { kind: 'target', target: /^\S+/u.exec(value)?.[0] ?? '' };
}

/**
 * A step or job that reaches commands this reader cannot see, refused by name.
 *
 * `uses:` is how a workflow runs somebody else's steps. Most of those are
 * third-party actions — checkout, the toolchain installers — and enumerating
 * what *they* run is not this file's business or within its reach. Two shapes
 * are, because in both the invisible steps are ours:
 *
 * - a relative path, which is a composite action in this repository whose own
 *   `run:` steps live in a file outside this directory;
 * - a `.yml` or `.yaml` in another repository, which is a reusable workflow
 *   whose jobs are not in this directory either.
 *
 * A relative path *to a workflow file in this directory* is the local reusable
 * workflow case and is allowed through: enumerating the directory already read
 * it, and its jobs are already in {@link JOBS} under their own file's name. That
 * is an allowance this reader decides, not one it falls into — the shape is
 * matched, then admitted.
 *
 * Every arm below judges the *unquoted* value from {@link usesValue}. Quoting is
 * invisible to the runner and used to be invisible to these arms, which is the
 * third defect in the header.
 */
function refuseUnreadableUses(workflow: Workflow): void {
  for (const [index, line] of workflow.text.split(/\r?\n/u).entries()) {
    const uses = usesValue(line);
    if (uses === undefined) continue;
    const at = `.github/workflows/${workflow.file}:${String(index + 1)}`;

    if (uses.kind === 'unterminated') {
      throw new Error(
        `${at} has a "uses:" whose quote never closes: ${uses.raw}. This reader ` +
          'cannot tell what it names, and a target it cannot read is not a target ' +
          'it may assume is harmless. Write the value on one line, with matching ' +
          'quotes or none.',
      );
    }

    const { target } = uses;

    if (target.startsWith('./') || target.startsWith('../')) {
      const local = target.replace(/^\.\//u, '');
      if (/\.ya?ml$/u.test(local) && local.startsWith('.github/workflows/')) continue;
      throw new Error(
        `${at} runs "${target}", a composite action in this repository. Its own ` +
          'steps can be gates and they are not in this directory, so this reader ' +
          'cannot see them. Teach it to read the action, or put the gate in a ' +
          'workflow step; do not let it go unread.',
      );
    }

    if (/\.ya?ml@/u.test(target)) {
      throw new Error(
        `${at} calls "${target}", a reusable workflow in another repository. Its ` +
          'jobs run as part of this CI and are not in this directory, so this ' +
          'reader cannot see them. Teach it to read them, or keep the workflow ' +
          'local; do not let it go unread.',
      );
    }
  }
}

/**
 * Read the whole directory.
 *
 * `readdirSync` throws when `repoRoot` is wrong, which is the behaviour wanted:
 * the failure that must never happen here is the one where a mis-rooted read
 * finds no workflows and every assertion above passes over an empty union.
 */
function readWorkflowSurface(repoRoot: string): WorkflowSurface {
  const directory = join(repoRoot, ...WORKFLOW_DIRECTORY);
  const found: string[] = [];
  filesUnder(directory, '', found);

  const files: string[] = [];
  const ignoredFiles: string[] = [];
  for (const path of found.sort()) {
    const extension = path.slice(path.lastIndexOf('.'));
    if (LOADED_EXTENSIONS.includes(extension as (typeof LOADED_EXTENSIONS)[number])) {
      files.push(path);
    } else {
      ignoredFiles.push(path);
    }
  }

  const workflows = files.map((file): Workflow => {
    const workflow = {
      file,
      text: readFileSync(join(directory, ...file.split('/')), 'utf8'),
    };
    refuseUnreadableUses(workflow);
    return workflow;
  });

  return { files, ignoredFiles, workflows };
}

const SURFACE = readWorkflowSurface(REPO_ROOT);

/* -------------------------------------------------------------------------- */
/* the union                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every command one workflow's text actually runs.
 *
 * Two blind spots used to live here, and both were the kind that make this file
 * report a pass it has not earned.
 *
 * 1. It read only the `run:` line itself. A step written as `run: |` yielded the
 *    literal `'|'`, which was filtered out and the block's actual commands were
 *    never looked at — so an entire gate could be added to the workflow in a
 *    block scalar and this test would say nothing. Block bodies are now read,
 *    and backslash continuations are rejoined so a wrapped `apt-get install`
 *    reads as the one command it is instead of as a list of package names.
 * 2. Accounting used `line.includes(ci)`. `'pnpm test:harness'.includes('pnpm
 *    test')` is true, so every `pnpm test:<anything>` step in the workflow was
 *    silently absorbed by the `pnpm test` gate and never had to be listed. See
 *    {@link isCommand}.
 *
 * Both spellings of a step are still handled: `- run: x` (a step with no name)
 * and a `run:` line under a `- name:`.
 */
function runCommandsIn(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  const commands: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const header = /^([ \t]*)-?[ \t]*run:[ \t]*(.*)$/u.exec(lines[index] ?? '');
    if (header === null) continue;

    const indent = (header[1] ?? '').length;
    const value = (header[2] ?? '').trim();
    if (value !== '' && !/^[|>][-+]?$/u.test(value)) {
      commands.push(value);
      continue;
    }

    // A block scalar. Every following line indented deeper than the `run:` key
    // belongs to it; the first line at or below that indent ends the block.
    let pending = '';
    for (let body = index + 1; body < lines.length; body += 1) {
      const raw = lines[body] ?? '';
      if (raw.trim() === '') continue;
      if (raw.length - raw.trimStart().length <= indent) break;

      const trimmed = raw.trim();
      const continues = trimmed.endsWith('\\');
      const piece = continues ? trimmed.slice(0, -1).trim() : trimmed;
      pending = pending === '' ? piece : `${pending} ${piece}`;
      if (!continues) {
        commands.push(pending);
        pending = '';
      }
    }
    if (pending !== '') commands.push(pending);
  }

  return commands;
}

/**
 * Whether a workflow command *is* a given gate, rather than merely containing
 * its text. A trailing-space prefix still counts, so `cargo test --workspace
 * --locked --no-fail-fast` is the `cargo test --workspace --locked` gate, while
 * `pnpm test:harness` is no longer the `pnpm test` gate.
 */
function isCommand(command: string, ci: string): boolean {
  return command === ci || command.startsWith(`${ci} `);
}

/**
 * The jobs of one workflow, split on the job headers.
 *
 * A file this reader cannot take apart throws instead of yielding nothing: an
 * empty result here is indistinguishable, at every call site above, from a file
 * with nothing wrong in it. The old version could return an empty list from a
 * file whose `jobs:` key it failed to find, and that is the whole failure mode
 * this file is being repaired for.
 *
 * **The job indent is the shallowest line in the block, not the first line that
 * looks like a job.** Inferring it from the first match was a hole found by
 * probing this very function: given a job key the header pattern declines —
 * `probe-one: # a note` carries a trailing comment, so it is not a bare key —
 * the first *matching* line in the block is the nested `steps:` four columns in.
 * The reader then read `steps` as the job name, twice, and both of the probe's
 * gates were counted under jobs that do not exist. It went green. Depth is a
 * fact about the block; the header pattern is this reader's opinion, and taking
 * the indent from the opinion let a wrong opinion choose its own evidence.
 *
 * So every line at job depth must be a job key, and one that is not throws.
 * A trailing comment is admitted because it is ordinary YAML; a flow mapping
 * (`probe: {…}`) is not, because the steps inside it are unreadable here.
 *
 * The last check is a second net under the first: every `run:` in the file has
 * to land inside some job that was found. A command in the file but in none of
 * the jobs means a job was missed some other way, and a missed job is a set of
 * gates nobody is looking at.
 */
function jobsIn(workflow: Workflow): WorkflowJob[] {
  const where = `.github/workflows/${workflow.file}`;
  const lines = workflow.text.split(/\r?\n/u);

  const start = lines.findIndex((line) => /^jobs:[ \t]*$/u.test(line));
  if (start === -1) {
    throw new Error(
      `${where} has no "jobs:" key this reader can find, so it would contribute ` +
        'no jobs and no gates to checks that are meant to cover every workflow. ' +
        'A file the runner loads and this guard reads as empty is the defect this ' +
        'guard exists to catch.',
    );
  }

  // The jobs block runs to the next line at column zero — anything less indented
  // than a job key is a sibling of `jobs:`, not part of it.
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '' || line.startsWith('#')) continue;
    if (!/^[ \t]/u.test(line)) {
      end = index;
      break;
    }
  }

  const block = lines.slice(start + 1, end);
  const depths = block.flatMap((line) =>
    line.trim() === '' || line.trimStart().startsWith('#')
      ? []
      : [line.length - line.trimStart().length],
  );
  if (depths.length === 0) {
    throw new Error(
      `${where} has a "jobs:" key with nothing under it that this reader can ` +
        'read. Its gates, if it has any, would be invisible here.',
    );
  }
  const jobIndent = Math.min(...depths);

  const isHeader = /^([ \t]+)([\w-]+):[ \t]*(?:#.*)?$/u;
  const headers = block.flatMap((line, index) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) return [];
    if (line.length - line.trimStart().length !== jobIndent) return [];
    const match = isHeader.exec(line);
    if (match === null) {
      throw new Error(
        `${where}:${String(start + 2 + index)} is at job depth but is not a job ` +
          `key this reader can split on: "${line.trim()}". Its steps would not be ` +
          'checked by anything here. Write the job as an indented block.',
      );
    }
    return [{ index, name: match[2] ?? '' }];
  });

  const jobs = headers.map(({ index, name }, position): WorkflowJob => {
    const next = headers[position + 1]?.index ?? block.length;
    return { file: workflow.file, name, body: block.slice(index, next).join('\n') };
  });

  const inJobs = jobs.reduce((total, job) => total + runCommandsIn(job.body).length, 0);
  const inFile = runCommandsIn(workflow.text).length;
  if (inJobs !== inFile) {
    throw new Error(
      `${where}: this reader found ${String(inFile)} run steps in the file but ` +
        `only ${String(inJobs)} inside the ${String(jobs.length)} jobs it could ` +
        'take apart. A job was written in a shape it does not recognise, and the ' +
        'gates in that job are not being checked by anything here.',
    );
  }

  return jobs;
}

/** Every gate command CI runs, across every workflow. */
const COMMANDS: readonly WorkflowCommand[] = SURFACE.workflows.flatMap((workflow) =>
  runCommandsIn(workflow.text).map((command): WorkflowCommand => ({ file: workflow.file, command })),
);

/** Every job CI runs, across every workflow. */
const JOBS: readonly WorkflowJob[] = SURFACE.workflows.flatMap(jobsIn);
