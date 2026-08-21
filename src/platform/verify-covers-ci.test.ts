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
 * ## The question this file has to answer, and the four times it asked a
 * ## narrower one
 *
 * The wide question is **"what can make `pnpm verify` weaker than CI while every
 * string this file looks for is still present?"** Four rounds of fixes each
 * answered a narrower one and each shipped the same defect with a smaller mouth:
 *
 * 1. *One filename out of a directory the runner reads whole.* Every assertion
 *    derived from a single `readFileSync` of `.github/workflows/ci.yml`. GitHub
 *    Actions does not run a filename; it runs **every** file in that directory.
 *    Measured, not assumed: a second workflow carrying an unlisted gate, the
 *    crash-retry wrapper on a second job, and `cargo build` on a runner with no
 *    Tauri system dependencies left this file 16/16 green. Fixed by enumerating
 *    the directory, asserting over the union, and pinning the file list by name
 *    — see {@link WORKFLOW_FILES}.
 * 2. *A refusal that YAML quoting walked straight past.* The `uses:` refusals
 *    took the value as `(\S+)`, and a raw token carries its quotes, so
 *    `uses: "./.github/actions/foo"` matched no arm and was allowed. 17/17 green
 *    with the line added; refused with the quotes removed.
 * 3. *The same hole, one YAML spelling over.* `uses:` with the value on the next
 *    line, or as a block scalar (`>-`, `|-`), read as *not a `uses:` line at
 *    all*. 36/36 green, three spellings.
 * 4. *The key's spelling, not the value's.* Every fix above moved rightwards
 *    along the line — the value's quoting, the value's position, the value's
 *    block indicator. Nobody moved **leftwards**. The reader's key patterns
 *    demanded the bare bytes `run:` / `uses:` at that position, so
 *
 *        - name: Probe gate behind a quoted key
 *          "run": pnpm probe-unlisted-gate
 *        - "uses": ./.github/actions/probe-composite
 *
 *    returned `undefined` — *"this is not a `uses:` key"*, the one claim the
 *    reader was entitled to make — and no refusal fired. Measured on this tree
 *    at `run-start-2026-08-17`: 42/42 green with the quotes, and the identical
 *    two steps with **bare** keys take the file down at module load. A flow
 *    mapping, `- { run: pnpm probe-unlisted-gate }`, was invisible to the same
 *    two patterns for the same reason, and also 42/42 green. The
 *    `inJobs !== inFile` net under the old `jobsIn` could not catch either:
 *    both counts missed the step equally, so the arithmetic still balanced.
 *
 * ### Defect five: the setup exemption was a prefix test, not a whole-command test
 *
 * No unusual YAML at all. An existing step gains a shell `&&`:
 *
 *     - run: pnpm install --frozen-lockfile && pnpm probe-smuggled-gate
 *
 * The old reader read the whole line correctly; the escape was downstream, in an
 * exemption that dropped any command where `command.startsWith('pnpm install')`.
 * Everything after the `&&` rode in on the prefix. Applied to all three jobs
 * that install: 42/42 green. The second spelling used the apt block scalar's own
 * backslash continuation —
 *
 *           libssl-dev libsecret-1-dev \
 *           && ./scripts/probe-smuggled-gate.sh
 *
 * — where the rejoin that exists to make the reader see *more* (so a wrapped
 * `apt-get install` reads as one command instead of a list of package names) is
 * what made it see less: the rejoined string begins `sudo apt-get`, so
 * `startsWith('sudo apt-get')` exempted the script chained onto its end. Also
 * 42/42 green. **Note that a perfect YAML parser does not touch this one.** It
 * hands back the identical single scalar. The fix is that a `run:` value is now
 * split into the simple commands the shell would run, and **every one of them**
 * must be accounted for; the setup exemptions are exact whole-command strings in
 * {@link SETUP_COMMANDS}, not prefixes.
 *
 * ### Defect six: a mention in the verify chain is not an execution
 *
 * The larger surface, and the one no previous round touched. This guard compares
 * two documents, and every fix so far re-read only one of them. The `verify`
 * side was never framed as a reader at all: `matches.test(VERIFY)` asked *does
 * this gate's text occur anywhere in the concatenation of the `verify` script
 * body with the bodies of every script whose name is textually mentioned in it?*
 * It never asked whether the occurrence was a command, whether it was on the
 * success path, or whether its failure could fail `verify`. The expansion was a
 * `String.replace` over `/pnpm (?:run )?([\w:-]+)/g`, which follows a name
 * inside an echoed string exactly as it follows a name in a real command. So,
 * with the workflow left byte-identical:
 *
 *     "verify": "echo \"verify is temporarily a no-op. CI still runs: pnpm
 *      typecheck pnpm lint:rust pnpm test … cargo test --workspace --locked\""
 *
 * was 42/42 green, and the **same** no-op with the gate names deleted from the
 * echoed string was 13 failed / 29 passed. The two runs execute exactly the same
 * amount of verification — none. The only difference between 13 red and 42 green
 * was the presence of a string inside an `echo`. A file whose top line is
 * "`pnpm verify` must be a superset of CI" certified a `verify` that was the
 * empty set. The milder construction this repository practically invites, and
 * which was also 42/42 green, leaves the chain intact and suppresses one gate's
 * failure — `ci.yml`'s own comments record `test:harness` crashing on ~14% of
 * Windows runs, so a developer writing
 *
 *     … && (pnpm test:harness || echo "::warning:: flaky here") && …
 *
 * is the realistic version of this, not a contrived one. `verify` is then looser
 * than CI, which is the one relationship this file exists to forbid.
 *
 * ## Defects seven to ten: the fix for five and six carried the class down
 *
 * Measured on the tree that already carried the fixes above, each twice. Every
 * one of the four is the same shape as everything before it — **a question
 * asked about one spelling, one position or one half, and not about the
 * equivalent one next door.** Three of them are literally "this is refused
 * here, and the identical thing is admitted there".
 *
 * ### Defect seven: a gate row's two halves were never checked against each other
 *
 * A {@link CiGate} row is two halves answering two different questions. `ci` is
 * compared with the workflows by equality, so `unaccounted` forces it to track
 * whatever CI runs. `runs` is a predicate asked of the verify chain. Nothing
 * asked whether they were still about the same command. So: strengthen CI's
 * build gate to `cargo build --workspace --locked --all-targets`, update the
 * row's `ci` because the accounting check makes you, leave `runs` describing the
 * command CI stopped running — **91/91 green**, with `pnpm verify` running
 * strictly less than CI. Note what this needed: no unusual YAML, no shell trick,
 * no quoting. It is the ordinary consequence of strengthening a CI gate, which
 * is a thing people do. The fix is {@link rowDrift}: a row's predicate must
 * accept the row's own command, and the one row where the halves are meant to
 * differ says so with `delegatesTo` and has to earn it three ways.
 *
 * ### Defect eight: `run:` refused a GitHub expression and `uses:` did not
 *
 * `run:` has refused `${{ … }}` since defect four, on the stated grounds that
 * "what it runs is not in this file". The identical unreadable value in a
 * `uses:` was admitted without comment — it starts with neither `./` nor `../`
 * and matches no `.yml@`, so every arm of {@link refuseUses} decided a target it
 * had never read. `uses: ${{ env.PROBE_ACTION }}` on two steps: **91/91 green**.
 * Whether GitHub would run that step is not the question, for the same reason
 * given for the quoted key below: the value is not in the file, so a reader that
 * cannot see it must refuse rather than report that it found nothing harmful.
 *
 * ### Defect nine: the shell was refused on the step and admitted as a default
 *
 * A step whose `shell:` this reader cannot split is refused, because `&&` and
 * `;` mean nothing in a Python body. `defaults:` was listed in
 * {@link TOP_LEVEL_KEYS} as a key this reader "knows" — and never read. Three
 * lines at the top of the file:
 *
 *     defaults:
 *       run:
 *         shell: python
 *
 * set that same shell for every step in the workflow and left the file **91/91
 * green**, while the identical three lines *inside a job* are refused, because
 * {@link JOB_KEYS} has no `defaults`. Listing a key as known is not knowing what
 * it does. The reader now resolves the shell a step actually runs under, and
 * takes `defaults:` apart the way it takes jobs and steps apart.
 *
 * ### Defect ten: `continue-on-error:` was refused and `|| …` was not
 *
 * `modelOf` refuses a step with `continue-on-error: true`, saying a step whose
 * failure cannot fail the job "is therefore not a gate, and listing it as one
 * would overstate what CI proves". It asked only whether a *YAML key* said so,
 * never whether a *shell operator* said the same thing about the same step. The
 * flag was even computed — {@link shellCommands} returns it — and then dropped
 * by a `.map(c => c.text)`, an unread write. So `run: pnpm test:harness || pnpm
 * test:harness` was **91/91 green**: `unaccounted` stayed empty because both
 * halves are listed gates, and every row went on asserting that CI runs the
 * harness gate while CI would ignore its failure. Its reader is now *every CI
 * gate can actually fail the job it is listed in*.
 *
 * ## Defect eleven: the fix for eight was fixed one spelling at a time
 *
 * Measured on the tree carrying the fixes for seven to ten, each construction
 * twice. Defect eight said that `uses:` admitted a value it could not read.
 * The fix refused the `${{ … }}` spelling of that value — and left the *shape*
 * of the reader, which decided what a target was by testing the raw bytes for
 * `./`, `../` and `.yml@`. A target that missed all three patterns fell off the
 * end of {@link refuseUses} and was classified, in silence, as a third-party
 * action whose contents are out of reach on purpose.
 *
 * The same composite action, four spellings, each **117/117 green** while the
 * control `uses: ./.github/actions/probe-composite` was red twice on the same
 * tree:
 *
 *     - uses: ./.github/workflows/../actions/probe-composite/action.yml
 *     - uses: " ./.github/actions/probe-composite"
 *     - uses: .github/actions/probe-composite
 *
 * and at job level `uses: ./.github/workflows/../../shared-ci/gates.yml` with
 * `secrets: inherit`, which imports a whole reusable workflow whose jobs are in
 * no model here and contribute no commands to {@link COMMANDS}.
 *
 * Two things about this are worth keeping rather than the four inputs. First,
 * the reader asked a **textual** question ("does this string begin with `./`?")
 * where it owed a **referential** one ("which file does this name, and did I
 * read it?"), which is the same substitution as defect five's prefix test and
 * defect six's `matches.test(VERIFY)`. Second, the old doc comment stated the
 * allow-branch's justification outright — "enumerating the directory already
 * read it" — and that sentence was false for every input above. A justification
 * that is false for the branch's actual acceptance set is the defect, not a
 * description of it, so the fix is to make the sentence *checked*:
 * {@link readWorkflowSurface} now hands {@link modelOf} the set of files it
 * enumerated, and a local `uses:` is admitted only when it normalises onto a
 * member of that set. Everything else is refused by name, including targets a
 * more knowledgeable reader could probably classify.
 *
 * ## What the reader is now, on both sides
 *
 * Both documents are read as **structure**, and both readers are *total*: every
 * line of a workflow and every character of a script body is either consumed by
 * a construct the reader understands or **refused by name**. Silence about
 * something it could not take apart is the failure mode of every defect above,
 * and it is now unreachable rather than merely unlikely.
 *
 * - **The workflow is parsed as YAML** (a block subset — see
 *   {@link parseWorkflowYaml}), so a key is a key whatever its quoting, and a
 *   construct outside the subset throws instead of being skipped. Keys are
 *   normalised, so `"run":` and `run:` are one thing; flow mappings, anchors,
 *   aliases, tags, tabs and multi-document files are refused. Job and step keys
 *   are then checked against a list of what this reader knows how to reason
 *   about, and an unknown key is refused rather than ignored — that is the
 *   general form of defect four, which was one particular unknown spelling.
 * - **Commands are parsed as shell** (see {@link shellCommands}), so a `run:`
 *   value is a *list* of simple commands rather than one string, and each of
 *   them has to be accounted for. Constructs whose effect this reader cannot
 *   compute — command substitution, subshells, background jobs, any `$`
 *   expansion — are refused, not guessed at.
 * - **`verify` is read as commands that execute**, not as text that mentions
 *   them. {@link VERIFY_CHAIN} is built by following real invocations: a
 *   segment whose program is `pnpm` and whose script name is a key in
 *   `package.json` expands to *that script's* commands. An argument inside an
 *   `echo` is an argument. And each command carries whether it is **gating** —
 *   whether its failure fails `verify` — computed from the shell operators
 *   around it, so a gate behind `||` or after `;` or `|` is present but does not
 *   count. Each row of {@link CI_GATES} says what it needs as a predicate over a
 *   *parsed* command, so the row for `pnpm typecheck` asks for a command whose
 *   program is `pnpm` and whose script is `typecheck` — a question `echo` cannot
 *   answer however its arguments are spelled.
 *
 * ### What this still cannot see, stated so nobody over-reads a green
 *
 * It compares *invocations at the command level*. It does not know what an
 * invocation does, and it does not read anything an invocation reads. All of
 * these keep every assertion here green:
 *
 * - **Rewriting what a gate is.** `"test": "vitest run --passWithNoTests
 *   --exclude src"` is still the `pnpm test` gate to this file. So is a change
 *   to `vite.config.ts`'s `test.include`, or to a vitest config a gate points
 *   at, or to `scripts/run-bash.mjs`, `scripts/check-transcripts.sh` or
 *   `scripts/secret-scan.sh`. The *argument list* of a gate is now pinned; the
 *   *definition* of the gate is not, and pinning it is a different guard.
 * - **`working-directory:` and `env:` on a step.** Both change what a command
 *   does without changing its text. They are read as known step keys and their
 *   values are not compared with anything. `defaults.run.working-directory` is
 *   the same, and is admitted for the same reason; `defaults.run.shell` is not,
 *   because that one changes how this reader may split a body at all — defect
 *   nine. This is the boundary to watch: it is drawn at *what changes how the
 *   reader reads*, not at *what changes what runs*, and the second of those is
 *   the wider question. A `working-directory` that moves a gate to a tree with a
 *   different `Cargo.toml` would not be seen here.
 * - **`strategy:` on a job.** A matrix can multiply a job; the `run:` text it
 *   multiplies is fixed, because a `run:` carrying `${{ matrix.… }}` is refused.
 *   The multiplication itself is not modelled.
 * - **CI getting weaker.** The invariant is one-directional — `verify` may not
 *   be looser than CI — so a step behind `if: false`, or a job removed
 *   entirely, is not something this file objects to.
 * - **A third-party `uses:`.** `owner/repo[/path]@ref` is admitted and what
 *   `actions/checkout@v4` runs is out of reach on purpose. That is now the only
 *   admission {@link refuseUses} makes without consulting something it read, so
 *   what {@link isThirdPartyAction} accepts is the size of the remaining hole,
 *   and it is checked segment by segment for that reason.
 *
 * ### Two claims this file does not make
 *
 * 1. **Defects one, two and three are inherited, not re-measured.** The counts
 *    quoted for them (16/16, 17/17, 36/36) are what the previous header
 *    recorded; this round did not reproduce them. Defects four, five and six
 *    were measured on this tree at `run-start-2026-08-17`, each twice, and the
 *    counts quoted for those are what the runs printed. Defects seven to ten
 *    were measured, each twice, on the tree carrying the fix for four, five and
 *    six; every count quoted for them is 91/91, which was that tree's full
 *    suite. Defect eleven was measured, each construction twice, on the tree
 *    carrying the fix for seven to ten, whose full suite was 117; the counts
 *    quoted for the mutations that hold this round's fix in place (1 failed |
 *    140 passed, 18 failed | 123 passed, 141/141) were measured twice each on
 *    the tree this comment ships in, whose full suite is 141. **These are exact totals of one file's cases at one commit, not a
 *    range and not a bound** — the number moves whenever a case is added, and
 *    nothing about it is evidence for anything but the run that printed it.
 * 2. **Whether GitHub's own parser accepts `"run":` as a quoted mapping key was
 *    not established.** No YAML parser was run against GitHub. It does not
 *    matter here, and that is by construction rather than by luck: if GitHub
 *    accepts it, the step is a gate and this file now demands it be in `verify`;
 *    if GitHub rejects it, this file demands a gate CI does not run, which is an
 *    over-report costing a review. The `"uses":` half refuses either way. The
 *    error is in the safe direction under both answers, which is the only reason
 *    the question can be left open.
 *
 *    The same is true, and left open the same way, of whether GitHub accepts an
 *    expression in a `uses:` (defect eight). Under either answer the refusal is
 *    an over-report at worst. Neither question was closed, and closing either
 *    means running GitHub's parser, not reasoning about the specification.
 *
 *    Defect eleven's four spellings are the same open question and **not** the
 *    same shape of safe, which is worth stating plainly because it is what
 *    decided the fix. Whether GitHub resolves a target that hops out of the
 *    workflows directory with a parent segment, or one with a leading space,
 *    was not established here either — but the two answers
 *    are not symmetric. If the runner rejects them, refusing costs a review; if
 *    it accepts any single one of them, *admitting* them lets a gate reach CI
 *    unread with this file green. An error that is unsafe under one answer
 *    cannot be left to the answer, so every one of them is refused. This is the
 *    general rule the file now follows: an allow-branch must name a fact the
 *    reader established, and where there is no such fact the answer is a
 *    refusal, not a guess in the direction that happens to be quiet.
 * 3. **A newline in a workflow `run:` block is read as ending the gating
 *    chain.** Whether it does depends on the shell's `errexit`, which is not
 *    written in this file, and this reader does not assume the answer it would
 *    prefer. The consequence is that a gate on any line but the last of a
 *    `run: |` block reddens *every CI gate can actually fail the job it is
 *    listed in*. That is a false red if the shell does have `errexit`, and a
 *    false red is what this file trades for; the opposite choice would be a
 *    silent green on a genuinely suppressed gate. `ci.yml` today puts no gate in
 *    a multi-line block, so the choice costs nothing at the moment it is made,
 *    which is the honest reason it was affordable to make it this way.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const WORKFLOW_DIRECTORY = ['.github', 'workflows'] as const;

/** The two extensions GitHub Actions loads. */
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
 * Commands CI runs that are **setup**, not gates: they fetch or install
 * something and cannot fail on the state of the tree.
 *
 * **Exact whole strings, matched by equality.** This list used to be two
 * `startsWith` prefixes, which is defect five in the header: everything after a
 * `&&` rode in on the prefix of the command in front of it. Commands are now
 * split before they get here, so a chained command is its own entry and has to
 * be accounted for on its own — but the exemptions are still written as whole
 * commands rather than prefixes, because a prefix test is the shape that failed
 * and there is no reason to keep one.
 *
 * The cost is that changing the apt package list reddens this file. That is the
 * intended price: the package list is the thing the "every job that runs cargo
 * can actually build the dependency graph" case below is about, and a change to
 * it deserves the two seconds it takes to read.
 *
 * Read by the `unaccounted` filter in *every gate command in the workflows is
 * accounted for above*, and by nothing else.
 */
const SETUP_COMMANDS: readonly string[] = [
  'pnpm install --frozen-lockfile',
  'sudo apt-get update',
  'sudo apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev ' +
    'libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev libsoup-3.0-dev ' +
    'libjavascriptcoregtk-4.1-dev libssl-dev libsecret-1-dev',
];

/**
 * Every command in the workflows that is a *gate* — something that can fail the
 * build on the state of the tree.
 *
 * `ci` is the exact command text the workflow runs, and is matched against the
 * workflows by equality. `runs` is the **verify side**, and it is a predicate
 * over a {@link ParsedCommand} rather than a regular expression over a text
 * splat — defect six in the header. `matches: /pnpm (?:run )?typecheck/` tested
 * against a bag of concatenated script bodies is satisfied by
 * `echo "… pnpm typecheck …"`; `pnpmScript(c) === 'typecheck'` is not, because
 * `echo`'s program is `echo` whatever its arguments say.
 */
interface CiGate {
  /** Exactly what the workflow runs. */
  readonly ci: string;
  /** Whether one command in the verify chain *is* this gate. */
  readonly runs: (command: ParsedCommand) => boolean;
  /**
   * Set only on a row whose `ci` *wraps* another listed gate, so that `runs`
   * deliberately does not describe `ci`. Its value is the `ci` of the row being
   * delegated to.
   *
   * The two halves of a row answer two different questions — `ci` is checked
   * against the workflows, `runs` against the verify chain — and defect seven
   * was that nothing checked they were still about the same command. See
   * *the gate row for $ci describes the command it names*, which is what makes
   * this field an exemption that has to be earned rather than a comment.
   */
  readonly delegatesTo?: string;
}

const CI_GATES: readonly CiGate[] = [
  { ci: 'pnpm typecheck', runs: (c) => runsPnpm(c, 'typecheck') },
  { ci: 'cargo fmt --all --check', runs: (c) => invokes(c, 'cargo', 'fmt', '--all', '--check') },
  {
    ci: 'cargo clippy --workspace --all-targets -- -D warnings',
    runs: (c) => invokes(c, 'cargo', 'clippy', '--workspace', '--all-targets', '--', '-D', 'warnings'),
  },
  { ci: 'pnpm test', runs: (c) => runsPnpm(c, 'test') },
  { ci: 'pnpm test:harness', runs: (c) => runsPnpm(c, 'test:harness') },
  // The same gate, wrapped for the Windows job only. The wrapper re-runs a
  // vitest worker-pool CRASH — a run that printed no verdict — and passes a real
  // test failure straight through; see `scripts/ci-retry-vitest-crash.mjs`. It
  // is listed rather than exempted so that the harness gate cannot be swapped
  // for something else behind the wrapper without this file noticing, and `runs`
  // still demands that `verify` reach the unwrapped gate.
  {
    ci: 'node scripts/ci-retry-vitest-crash.mjs pnpm test:harness',
    runs: (c) => runsPnpm(c, 'test:harness'),
    delegatesTo: 'pnpm test:harness',
  },
  { ci: 'pnpm build', runs: (c) => runsPnpm(c, 'build') },
  { ci: './scripts/check-transcripts.sh', runs: (c) => runsScript(c, 'scripts/check-transcripts.sh') },
  // The same script, reached the way a Windows developer reaches it. The Linux
  // job runs the file directly; `test-windows` runs it through `pnpm`, because
  // pnpm hands script bodies to `cmd.exe` and that is the hop that was broken.
  { ci: 'pnpm test:transcripts', runs: (c) => runsPnpm(c, 'test:transcripts') },
  { ci: 'cargo build --workspace --locked', runs: (c) => invokes(c, 'cargo', 'build', '--workspace', '--locked') },
  { ci: 'cargo test --workspace --locked', runs: (c) => invokes(c, 'cargo', 'test', '--workspace', '--locked') },
  // Two rows, two different scripts. The old `matches: /secret-scan\.sh/` was
  // satisfied by the `.test.sh` command as well, so one of these rows was
  // proving nothing. `runsScript` compares the script path exactly.
  { ci: './scripts/secret-scan.test.sh', runs: (c) => runsScript(c, 'scripts/secret-scan.test.sh') },
  { ci: './scripts/secret-scan.sh', runs: (c) => runsScript(c, 'scripts/secret-scan.sh') },
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

  it.each(CI_GATES)('verify reaches the CI gate: $ci', ({ ci, runs }) => {
    expect(
      COMMANDS.some(({ command }) => command === ci),
      `this test's list is stale: no workflow under .github/workflows/ runs "${ci}"`,
    ).toBe(true);

    // Two questions, kept apart on purpose, because the answers want different
    // fixes. "Is it there at all?" was the only one the old text search could
    // ask. "Does its failure fail `verify`?" is defect six: a gate wrapped in
    // `|| echo`, or trailing a `;` or a `|`, is present and gates nothing.
    const suppressed = VERIFY_CHAIN.filter((entry) => !entry.gating && runs(entry.command));
    const reached = VERIFY_CHAIN.filter((entry) => entry.gating && runs(entry.command));

    expect(
      reached.length,
      suppressed.length > 0
        ? `"pnpm verify" runs "${ci}" but its failure cannot fail the run: ` +
          suppressed.map((entry) => `${entry.script} -> ${entry.command.text}`).join(', ') +
          '. A gate whose failure is swallowed is not a gate, and a green local ' +
          'run would not mean a green CI run. Put it back on the && chain.'
        : `CI runs "${ci}" but "pnpm verify" does not. A green local run would ` +
          `not mean a green CI run. Add it to the verify chain in package.json. ` +
          `The commands verify actually runs are: ` +
          VERIFY_CHAIN.map((entry) => entry.command.text).join(' | '),
    ).toBeGreaterThan(0);
  });

  it.each(CI_GATES)('the gate row for $ci describes the command it names', (gate) => {
    // Defect seven. A row is two halves answering two different questions: `ci`
    // is compared with the workflows by equality, and `runs` is asked of the
    // verify chain. Every check above holds one half still and varies the other,
    // so nothing noticed when the halves stopped being about the same command.
    //
    // Measured on this tree, twice: change CI's build gate to `cargo build
    // --workspace --locked --all-targets`, update this row's `ci` to match —
    // which `unaccounted` forces you to do — and leave `runs` describing the old
    // command, and the file was 91/91 green while `pnpm verify` ran strictly
    // less than CI. That is the one relationship this file exists to deny.
    //
    // The gate stays a hand-written predicate rather than a string comparison —
    // `invokes` is what makes `--no-run` a different command instead of a longer
    // one — but a hand-written predicate now has to survive being pointed at its
    // own `ci`.
    expect(rowDrift(gate, CI_GATES), `the CI_GATES row for "${gate.ci}" is inconsistent`).toEqual([]);
  });

  it('every gate command in the workflows is accounted for above', () => {
    // Catches the other direction: a *new* CI step that nobody listed here, and
    // which therefore silently escapes the check above. Over the union, so a
    // step added in a second workflow is caught the same as one added to
    // `ci.yml`; and over *simple commands*, so a gate chained onto the end of a
    // setup step with `&&` is its own entry rather than part of the setup
    // command's prefix. That is defect five.
    expect(COMMANDS.length).toBeGreaterThanOrEqual(CI_GATES.length);

    expect(
      unaccounted(COMMANDS),
      'a new CI command appeared. Add it to CI_GATES and to "pnpm verify", or ' +
        'add it to SETUP_COMMANDS with a reason if it is setup rather than a ' +
        'gate. Note that this is one *simple command*: if it arrived chained ' +
        'onto another with && then the step that carries it is doing two things.',
    ).toEqual([]);
  });

  it('every CI gate can actually fail the job it is listed in', () => {
    // Defect ten, and the exact mirror of the `continue-on-error: true` refusal
    // in `modelOf`. That refusal says a step whose failure cannot fail the job
    // "is therefore not a gate, and listing it as one would overstate what CI
    // proves" — and then asked only whether a *YAML key* said so, never whether
    // a *shell operator* said the same thing about the same step.
    //
    // Measured on this tree, twice: `run: pnpm test:harness || pnpm test:harness`
    // left the file 91/91 green. `unaccounted` stayed empty because both halves
    // are listed gates, and every row above went on asserting "CI runs pnpm
    // test:harness" about a step whose failure CI would ignore.
    //
    // The reader of `WorkflowCommand.gating` is this case and only this case.
    //
    // A newline counts as ending the chain, so a gate on any line but the last
    // of a `run: |` block reddens here. That is deliberate and it is the safe
    // direction: whether a newline ends the chain depends on the shell's errexit
    // setting, which is not written in this file, and this reader does not get
    // to assume the answer it prefers. The fix is one gate per step, or an `&&`.
    expect(
      swallowedGates(COMMANDS, CI_GATES),
      'a command listed in CI_GATES is written in CI so that its failure cannot ' +
        'fail the job — it is on the left of a "||", in front of a ";" or a "|", ' +
        'or on a line of a block scalar that is not the last. A gate whose ' +
        'failure is swallowed is not a gate, and every row above would go on ' +
        'claiming CI runs it. Put it on its own step, or on the "&&" chain.',
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

    const wrappingJobs = [
      ...new Set(
        COMMANDS.filter(({ command }) => command.includes(WRAPPER)).map(
          ({ file, job }) => `${file}:${job}`,
        ),
      ),
    ];
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
    // It also asks it of every job in the directory rather than of one file's.
    //
    // `usesCargo` reads the *program* of each simple command rather than
    // searching the job's text for the word. `cd src-tauri && cargo build` is
    // two commands and the second one's program is `cargo`; a job that merely
    // mentions cargo in a comment has no such command.
    for (const job of JOBS) {
      const name = `${job.file}:${job.name}`;
      const commands = job.commands.map(({ text }) => text);
      if (!commands.some((command) => parseCommand(command).program === 'cargo')) continue;

      expect(job.runsOn, `CI job "${name}" has no runs-on this test can read`).not.toBe('');

      if (job.runsOn.startsWith('ubuntu')) {
        expect(
          commands.some((command) => command.includes('libwebkit2gtk-4.1-dev')),
          `CI job "${name}" runs cargo on Linux but never installs the Tauri ` +
            'system dependencies. It will fail in a build script before linting ' +
            'or testing anything. Copy the "Install Tauri system dependencies" step.',
        ).toBe(true);
      } else if (job.runsOn.startsWith('windows') || job.runsOn.startsWith('macos')) {
        // Assert the absence of the Linux step as well. Copying it here would
        // fail on a runner with no apt, so its absence should read as a decision
        // rather than as something nobody got round to.
        expect(
          commands.some((command) => command.includes('apt-get')),
          `CI job "${name}" runs on ${job.runsOn} and installs Linux packages. The ` +
            'webview ships with the OS there; apt-get does not exist on it.',
        ).toBe(false);
      } else {
        expect.fail(
          `CI job "${name}" runs cargo on "${job.runsOn}", which this guard cannot ` +
            'reason about. Teach it what that runner provides before trusting a ' +
            'green run from it.',
        );
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* the workflow, read as YAML                                                 */
/* -------------------------------------------------------------------------- */

describe('the workflow is read as a document, not as lines', () => {
  // `readWorkflowSurface` runs this same reader over every real workflow at
  // module load, so a refusal that misfires takes the whole file down and the
  // tests above never run. That is the control for every "refuses" row here.

  /** A one-job workflow carrying whatever step lines a case wants to try. */
  const probeText = (...stepLines: readonly string[]): string =>
    ['jobs:', '  probe:', '    runs-on: ubuntu-latest', '    steps:', ...stepLines].join('\n');

  /**
   * What a probe's enumeration is taken to have read: the probe file itself, and
   * nothing else.
   *
   * Every `uses:` case below is really a question about this set. A target that
   * lands in it is a file whose jobs are in the model; a target that does not is
   * a file nobody read, whatever it looks like. A second, plausible-looking
   * workflow name is deliberately absent from the set — before defect eleven a
   * name like that was admitted on its spelling alone.
   */
  const PROBE_READ_WORKFLOWS: ReadonlySet<string> = new Set(['.github/workflows/probe.yml']);

  function probe(...stepLines: readonly string[]): () => WorkflowModel {
    return () => modelOf({ file: 'probe.yml', text: probeText(...stepLines) }, PROBE_READ_WORKFLOWS);
  }

  /** The same one-job workflow with a top-level `defaults:` block in front. */
  function withDefaults(
    defaultsLines: readonly string[],
    ...stepLines: readonly string[]
  ): () => WorkflowModel {
    const text = ['defaults:', ...defaultsLines, probeText(...stepLines)].join('\n');
    return () => modelOf({ file: 'probe.yml', text }, PROBE_READ_WORKFLOWS);
  }

  /**
   * What the YAML parser resolved the first step's `uses:` to — read off the
   * tree, *before* any refusal.
   *
   * Deliberately not `modelOf(...).jobs[0].steps[0].uses`: the refusing cases
   * throw, and "it threw" is also what a reader that understood nothing would
   * report. Asserting the resolved string separately is what makes the eight
   * spellings a test of the parse rather than eight copies of one refusal arm.
   */
  function usesTargetOf(...stepLines: readonly string[]): string | undefined {
    const root = parseWorkflowYaml('probe.yml', probeText(...stepLines));
    const jobs = root.kind === 'mapping' ? entry(root.entries, 'jobs') : undefined;
    const job = jobs !== undefined && jobs.kind === 'mapping' ? jobs.entries[0]?.value : undefined;
    const steps = job !== undefined && job.kind === 'mapping' ? entry(job.entries, 'steps') : undefined;
    const first = steps !== undefined && steps.kind === 'sequence' ? steps.items[0] : undefined;
    return first !== undefined && first.kind === 'mapping'
      ? scalarOf(entry(first.entries, 'uses'))
      : undefined;
  }

  describe('a key is a key whatever its quoting — defect four', () => {
    it.each([
      { spelling: 'bare', key: 'run' },
      { spelling: 'double-quoted', key: '"run"' },
      { spelling: 'single-quoted', key: "'run'" },
    ])('reads a $spelling run: key', ({ key }) => {
      // The whole of defect four. Every fix before this one hardened how the
      // VALUE may be written; the KEY was never a variable, and two double-quote
      // characters were the difference between a module-load refusal and 42/42
      // green. A YAML parser has no such notion: it unquotes the key and hands
      // back `run`.
      const model = probe(`      - ${key}: pnpm probe-unlisted-gate`)();
      expect(model.jobs[0]?.steps[0]?.run).toBe('pnpm probe-unlisted-gate');
    });

    it.each([
      { spelling: 'bare', key: 'uses' },
      { spelling: 'double-quoted', key: '"uses"' },
      { spelling: 'single-quoted', key: "'uses'" },
    ])('refuses a composite action behind a $spelling uses: key', ({ key }) => {
      expect(probe(`      - ${key}: ./.github/actions/probe-composite`)).toThrow(
        'has a "uses:" this reader cannot place: "./.github/actions/probe-composite"',
      );
    });

    it('refuses a step written as a flow mapping', () => {
      // The second spelling of the same frame, and the one a line reader misses
      // for the same reason: `- { run: … }` has no line that begins `run:`. It
      // is refused rather than parsed, because this reader does not implement
      // flow mappings and the alternative to refusing is to skip it in silence.
      expect(probe('      - { run: pnpm probe-unlisted-gate }')).toThrow(
        'a flow mapping',
      );
    });
  });

  describe('a uses: is refused on what it names, not on how it is written', () => {
    it.each([
      { spelling: 'unquoted', written: ['      - uses: ./.github/actions/foo'] },
      { spelling: 'double-quoted', written: ['      - uses: "./.github/actions/foo"'] },
      { spelling: 'single-quoted', written: ["      - uses: './.github/actions/foo'"] },
      {
        spelling: 'double-quoted with a trailing comment',
        written: ['      - uses: "./.github/actions/foo" # bundle'],
      },
      {
        spelling: 'unquoted with a trailing comment',
        written: ['      - uses: ./.github/actions/foo # bundle'],
      },
      {
        spelling: 'a plain scalar continued on the next line',
        written: ['      - uses:', '          ./.github/actions/foo'],
      },
      {
        spelling: 'a folded block scalar',
        written: ['      - uses: >-', '          ./.github/actions/foo'],
      },
      {
        spelling: 'a literal block scalar',
        written: ['      - uses: |-', '          ./.github/actions/foo'],
      },
    ])('resolves and refuses a composite action written as $spelling', ({ written }) => {
      // Defects two and three, and the promise the old header made but could not
      // keep. The off-the-line spellings used to be refused for the *wrong*
      // reason — "this reader cannot see the value" — which is the right verdict
      // from a line reader and a worse one than the truth. A YAML parser
      // resolves all eight of these to one string, so they now refuse on what
      // they name, and the parse is asserted rather than inferred from a throw.
      expect(usesTargetOf(...written)).toBe('./.github/actions/foo');
      expect(probe(...written)).toThrow(
        'has a "uses:" this reader cannot place: "./.github/actions/foo"',
      );
    });

    it('refuses a composite action reached by a parent-relative path', () => {
      // `../` is not how GitHub spells a reference into this repository, and it
      // is not an `owner/repo@ref` either, so this reader has no reading of it
      // to trust. It says so instead of picking one.
      expect(probe("      - uses: '../actions/foo'")).toThrow(
        'has a "uses:" this reader cannot place: "../actions/foo"',
      );
    });

    it.each([
      { spelling: 'unquoted', written: 'org/repo/.github/workflows/x.yml@main' },
      { spelling: 'double-quoted', written: '"org/repo/.github/workflows/x.yml@main"' },
      { spelling: 'single-quoted', written: "'org/repo/.github/workflows/x.yml@main'" },
    ])('refuses a remote reusable workflow written $spelling', ({ written }) => {
      expect(probe(`      - uses: ${written}`)).toThrow(
        'calls "org/repo/.github/workflows/x.yml@main", a reusable workflow in another repository',
      );
    });

    it('refuses a remote reusable workflow called at job level', () => {
      // A job may be a `uses:` with no steps at all. The old line reader saw
      // the key wherever it sat, which was right by accident; this one has to
      // look for it on purpose, so the case is pinned.
      const text = ['jobs:', '  probe:', '    uses: org/repo/.github/workflows/x.yml@main'].join('\n');
      expect(() => modelOf({ file: 'probe.yml', text }, PROBE_READ_WORKFLOWS)).toThrow(
        'calls "org/repo/.github/workflows/x.yml@main", a reusable workflow in another repository',
      );
    });

    it.each([
      { spelling: 'unquoted', written: './.github/workflows/probe.yml', names: './.github/workflows/probe.yml' },
      { spelling: 'double-quoted', written: '"./.github/workflows/probe.yml"', names: './.github/workflows/probe.yml' },
      { spelling: 'single-quoted', written: "'./.github/workflows/probe.yml'", names: './.github/workflows/probe.yml' },
    ])('reads a local reusable workflow written $spelling and allows it', ({ written, names }) => {
      // Two assertions, because "it did not throw" on its own is also what a
      // reader that understood nothing would report. The first says what was
      // read; the second says the admission is a decision.
      //
      // The target is the probe's own file and not some second, plausible name,
      // for the whole of defect eleven: the admission is now a membership test
      // against the files this run enumerated, and PROBE_READ_WORKFLOWS holds
      // exactly one. The case below feeds it a target spelled identically and
      // absent from that set.
      expect(usesTargetOf(`      - uses: ${written}`)).toBe(names);
      expect(
        probe(`      - uses: ${written}`),
        'a local reusable workflow that the enumeration read is a file whose ' +
          'jobs are already in JOBS under its own name.',
      ).not.toThrow();
    });

    it('refuses a local reusable workflow the enumeration never read — defect eleven', () => {
      // The control for the row above, and the reason that row is not simply
      // "./ paths ending .yml are fine". Same directory, same extension, same
      // spelling; the only difference is that no such file was enumerated, so
      // nothing here has read its jobs.
      expect(probe('      - uses: ./.github/workflows/reusable.yml')).toThrow(
        'has a "uses:" this reader cannot place: "./.github/workflows/reusable.yml"',
      );
    });

    it.each([
      {
        shape: 'a parent hop back out of the workflows directory',
        written: './.github/workflows/../actions/probe-composite/action.yml',
        resolves: '.github/actions/probe-composite/action.yml',
      },
      {
        shape: 'two parent hops, landing outside .github entirely',
        written: './.github/workflows/../../shared-ci/gates.yml',
        resolves: 'shared-ci/gates.yml',
      },
      {
        shape: 'a dot segment in the middle',
        written: './.github/workflows/./reusable.yml',
        resolves: '.github/workflows/reusable.yml',
      },
    ])('resolves $shape before deciding — defect eleven', ({ written, resolves }) => {
      // Each of these was 117/117 green before this fix, measured twice each on
      // the tree carrying the fixes for seven to ten, and not by missing the old
      // reader's patterns: each one *matched* them. The old arm tested the
      // unresolved bytes, so anything beginning `./.github/workflows/` and
      // ending `.yml` was returned as a local reusable workflow — including
      // these three, none of which names a file in that directory. The message
      // names the resolved path, so the case asserts that the resolution
      // happened rather than only that something threw.
      expect(probe(`      - uses: ${written}`)).toThrow(
        `has a "uses:" this reader cannot place: "${written}", which as a path resolves to "${resolves}"`,
      );
    });

    it('refuses a uses: padded with whitespace rather than trimming it — defect eleven', () => {
      // One leading space, inside double quotes so the YAML parser keeps it, was
      // enough to walk past every prefix test in the old reader. Trimming would
      // be this file deciding what the runner does with the space.
      expect(usesTargetOf('      - uses: " ./.github/actions/probe-composite"')).toBe(
        ' ./.github/actions/probe-composite',
      );
      expect(probe('      - uses: " ./.github/actions/probe-composite"')).toThrow(
        'has a "uses:" padded with whitespace',
      );
    });

    it.each([
      { shape: 'a repository path with no leading ./', written: '.github/actions/probe-composite' },
      { shape: 'a bare directory name', written: 'probe-composite' },
      { shape: 'an owner and repo with no ref', written: 'some-org/probe-composite' },
      { shape: 'a docker image', written: 'docker://alpine:3.19' },
      { shape: 'a ref with nothing in front of it', written: '@v4' },
      { shape: 'an owner beginning with a dot', written: '.github/actions/probe@v1' },
    ])('refuses $shape, which it cannot place — defect eleven', ({ written }) => {
      // The default is refusal. Before this fix every one of these fell off the
      // end of `refuseUses` and was silently classified as a third-party action;
      // `.github/actions/probe-composite` was measured 117/117 green twice. Some
      // of these the runner may well reject outright — that costs a review, and
      // the alternative costs a gate.
      expect(probe(`      - uses: ${written}`)).toThrow('this reader cannot place');
    });

    it.each([
      { shape: 'a dot segment', written: './.github/workflows/./probe.yml' },
      { shape: 'a trailing slash', written: './.github/workflows/probe.yml/' },
      { shape: 'a doubled separator', written: './.github/workflows//probe.yml' },
      { shape: 'a hop out and back', written: './.github/workflows/../workflows/probe.yml' },
    ])('refuses $shape onto a file it did read, rather than picking a reading', ({ written }) => {
      // The other half of the membership test. All four normalise onto the
      // probe's own file, which IS in PROBE_READ_WORKFLOWS, so the set alone
      // would admit every one of them; the admission also requires the bytes to
      // be the plain path to that file.
      // Refusing costs whoever writes one of these a review. Admitting one costs
      // whatever the runner does with a spelling this reader guessed at.
      expect(probe(`      - uses: ${written}`)).toThrow(
        'a file this run did read, but not written as the plain path to it',
      );
    });

    it.each([
      {
        level: 'step',
        lines: ['      - uses:', '          repository: probe/composite'],
        message: 'has a "uses:" that is not one value this reader can resolve',
      },
    ])('refuses a $level uses: whose value is not one scalar', ({ lines, message }) => {
      expect(probe(...lines)).toThrow(message);
    });

    it('refuses a job whose uses: is not one scalar, instead of dropping it', () => {
      // At job level this one had a silent reading: `scalarOf` returns undefined
      // for a mapping, which was indistinguishable from "this job has no uses:",
      // so a job carrying both was modelled as an ordinary steps job with the
      // `uses:` gone. The same class as everything else here — a value it could
      // not take apart, skipped rather than named.
      const text = [
        'jobs:',
        '  probe:',
        '    uses:',
        '      repository: probe/composite',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: pnpm typecheck',
      ].join('\n');
      expect(() => modelOf({ file: 'probe.yml', text }, PROBE_READ_WORKFLOWS)).toThrow(
        'with a "uses:" that is not one value this reader can resolve',
      );
    });

    it('refuses a job-level uses: that resolves outside the workflows directory — defect eleven', () => {
      // The job-level arm, which is where a whole reusable workflow is imported
      // and where the escape brought in jobs contributing no commands at all.
      const text = [
        'jobs:',
        '  probe:',
        '    uses: ./.github/workflows/../../shared-ci/gates.yml',
        '    secrets: inherit',
      ].join('\n');
      expect(() => modelOf({ file: 'probe.yml', text }, PROBE_READ_WORKFLOWS)).toThrow(
        'resolves to "shared-ci/gates.yml"',
      );
    });

    it.each([
      { shape: 'a segment that is a parent hop', written: 'some-org/../probe/action@v1' },
      { shape: 'a segment that is a dot', written: 'some-org/./action@v1' },
      { shape: 'an empty ref', written: 'some-org/action@' },
      { shape: 'whitespace inside the ref', written: '"some-org/action@v1 v2"' },
    ])('refuses $shape rather than reading it as a third-party action', ({ written }) => {
      // `isThirdPartyAction` is the only remaining allow-arm that does not
      // consult the enumeration, so what it accepts is the size of the hole. It
      // is checked segment by segment for that reason.
      expect(probe(`      - uses: ${written}`)).toThrow('this reader cannot place');
    });

    it.each([
      { spelling: 'alone', written: '${{ env.PROBE_ACTION }}' },
      { spelling: 'as a prefix', written: '${{ env.OWNER }}/action@v1' },
      { spelling: 'inside a quoted value', written: '"${{ matrix.action }}"' },
    ])('refuses a uses: whose target is an expression written $spelling — defect eight', ({ written }) => {
      // `run:` has refused an expression since defect four. `uses:` did not, so
      // the identical unreadable value was refused in one key and admitted in
      // the other, and the arms below it decided a target nobody had read.
      //
      // Two assertions again: the first says the parse resolved the value to the
      // expression text, so the refusal is about what it names and not about a
      // spelling the reader failed to take apart.
      expect(usesTargetOf(`      - uses: ${written}`)).toContain('${{');
      expect(probe(`      - uses: ${written}`)).toThrow('is a GitHub expression');
    });

    it('refuses a relative path into the workflows directory that is not a workflow', () => {
      // It lands in the right directory and is still not a file the enumeration
      // read, which is now the only question asked of it.
      expect(probe('      - uses: "./.github/workflows/helper.sh"')).toThrow(
        'has a "uses:" this reader cannot place: "./.github/workflows/helper.sh"',
      );
    });

    it('refuses a uses: whose opening quote never closes', () => {
      // Unquoted this exact target is *allowed* — it is the local reusable
      // workflow above, and it is in `PROBE_READ_WORKFLOWS` — so neither guess
      // is safe.
      expect(probe('      - uses: "./.github/workflows/probe.yml')).toThrow(
        'quote never closes',
      );
    });

    it.each([
      { spelling: 'unquoted', written: 'actions/checkout@v4', names: 'actions/checkout@v4' },
      { spelling: 'double-quoted', written: '"pnpm/action-setup@v4"', names: 'pnpm/action-setup@v4' },
      { spelling: 'single-quoted', written: "'dtolnay/rust-toolchain@stable'", names: 'dtolnay/rust-toolchain@stable' },
      { spelling: 'unquoted with a trailing comment', written: 'Swatinem/rust-cache@v2 # cache', names: 'Swatinem/rust-cache@v2' },
    ])('reads a third-party action written $spelling and allows it', ({ written, names }) => {
      // The refusal is the default and the *admission* is two named shapes, one
      // of which is this: enumerating what a third-party action runs is neither
      // this file's business nor within its reach, and every workflow in this
      // directory is full of them. That direction was reversed by defect eleven,
      // where the default was admission and refusal was the enumerated case.
      // Narrowing this arm until it stops covering these is caught by `ci.yml`
      // itself at module load, so the arm cannot quietly close either.
      expect(usesTargetOf(`      - uses: ${written}`)).toBe(names);
      expect(probe(`      - uses: ${written}`)).not.toThrow();
    });
  });

  describe('a construct it cannot take apart is refused, never skipped', () => {
    // The general form of defect four. Every escape so far has been a spelling
    // nobody thought of, so the rule is no longer "recognise these spellings"
    // but "account for everything, and name what you cannot".

    it('marks a workflow command whose failure a shell operator swallows — defect ten', () => {
      // `modelOf` computed this flag and a `.map(c => c.text)` threw it away, so
      // a step could suppress its own gate and every row above went on claiming
      // CI ran it. Asserted on the model rather than only through `ci.yml`,
      // because `ci.yml` contains no such step and never will if this holds.
      expect(probe('      - run: pnpm test:harness || pnpm test:harness')().jobs[0]?.commands).toEqual([
        { text: 'pnpm test:harness', gating: false },
        { text: 'pnpm test:harness', gating: true },
      ]);

      // The control: the same step without the operator. Without it the row
      // above passes for a reader that calls everything non-gating.
      expect(probe('      - run: pnpm test:harness')().jobs[0]?.commands).toEqual([
        { text: 'pnpm test:harness', gating: true },
      ]);
    });

    it('carries the gating flag from the parsed step into the command list', () => {
      // The step above proves `modelOf` computes the flag; the cases for
      // `swallowedGates` prove the rule reads it. Neither says the flag survives
      // the trip between them, and that trip is where defect ten actually lived.
      // Measured: reintroducing the drop here was 116/116 green with both of
      // those in place.
      expect(commandsOf(probe('      - run: pnpm test:harness || pnpm test:harness')().jobs)).toEqual([
        { file: 'probe.yml', job: 'probe', command: 'pnpm test:harness', gating: false },
        { file: 'probe.yml', job: 'probe', command: 'pnpm test:harness', gating: true },
      ]);
    });

    it('refuses a step key it does not know how to reason about', () => {
      expect(probe('      - run: pnpm test', '        surprise: yes')).toThrow(
        'has a step key this reader does not know: "surprise"',
      );
    });

    it('refuses a job key it does not know how to reason about', () => {
      const text = ['jobs:', '  probe:', '    runs-on: ubuntu-latest', '    surprise: yes'].join('\n');
      expect(() => modelOf({ file: 'probe.yml', text }, PROBE_READ_WORKFLOWS)).toThrow(
        'has a job key this reader does not know: "surprise"',
      );
    });

    it('refuses a step that is neither a run: nor a uses:', () => {
      expect(probe('      - name: nothing at all')).toThrow(
        'is a step with neither a "run:" nor a "uses:"',
      );
    });

    it('refuses a step that is both a run: and a uses:', () => {
      expect(probe('      - run: pnpm test', '        uses: actions/checkout@v4')).toThrow(
        'is a step with both a "run:" and a "uses:"',
      );
    });

    it('refuses a run: whose shell is not one this reader can split', () => {
      // `shell: python` means the body is not shell at all, so every `&&` and
      // `;` this reader relies on means nothing there.
      expect(probe('      - run: print("hi")', '        shell: python')).toThrow(
        'runs under "shell: python"',
      );
    });

    it('refuses the same shell set as a workflow default — defect nine', () => {
      // The step spells out no shell at all. The refusal above asked whether
      // *this step* declared one it could not split; the question is what shell
      // the step actually runs under, and a workflow default answers it just as
      // completely. Listing `defaults` in TOP_LEVEL_KEYS and never reading it
      // was 91/91 green with these three lines in the file.
      expect(
        withDefaults(['  run:', '    shell: python'], '      - run: print("hi")'),
      ).toThrow('runs under "shell: python", set as the workflow default,');
    });

    it('lets a step override a workflow default with a shell it can split', () => {
      // Without this the case above passes for a reader that refuses any file
      // carrying a `defaults:` at all.
      expect(
        withDefaults(['  run:', '    shell: python'], '      - run: pnpm test', '        shell: bash'),
      ).not.toThrow();
    });

    it('refuses a defaults: key it does not know how to reason about', () => {
      // Same rule as jobs and steps, in the one place it was not applied. A
      // default reaches every step in the file.
      expect(withDefaults(['  surprise: yes'], '      - run: pnpm test')).toThrow(
        'has a "defaults:" key this reader does not know: "surprise"',
      );
      expect(
        withDefaults(['  run:', '    surprise: yes'], '      - run: pnpm test'),
      ).toThrow('has a "defaults.run:" key this reader does not know: "surprise"');
    });

    it('reads a defaults.run it does understand without refusing', () => {
      expect(
        withDefaults(['  run:', '    working-directory: src-tauri'], '      - run: pnpm test'),
      ).not.toThrow();
    });

    it('refuses a run: whose value is a GitHub expression', () => {
      // `run: ${{ matrix.command }}` is a gate whose text is not in the file.
      expect(probe('      - run: ${{ matrix.command }}')).toThrow(
        'is not a command this reader can see',
      );
    });

    it('refuses a step whose failure does not fail the job', () => {
      expect(probe('      - run: pnpm test', '        continue-on-error: true')).toThrow(
        'cannot fail the job',
      );
    });

    it('refuses a YAML anchor', () => {
      expect(probe('      - run: &base pnpm test')).toThrow('an anchor, alias or tag');
    });

    it('refuses a tab in the indentation', () => {
      expect(probe('      - run: pnpm test', '\t\tname: tabbed')).toThrow('a tab');
    });

    it('refuses a second YAML document in one file', () => {
      const text = ['jobs:', '  probe:', '    runs-on: ubuntu-latest', '    steps:', '      - run: pnpm test', '---', 'jobs: {}'].join('\n');
      expect(() => modelOf({ file: 'probe.yml', text }, PROBE_READ_WORKFLOWS)).toThrow('a document separator');
    });

    it('refuses a document with anything left unread after it', () => {
      // The totality net, and it is a *backstop*, not the main defence: a
      // mapping rooted at column zero — which every workflow is — can only
      // consume to the end of the file or refuse, so the net cannot fire on
      // one. It fires on a document whose root node ends early, and it exists
      // so that "the parser walked past something" is a failure rather than a
      // quiet subset. Stated rather than assumed, because a net nobody can trip
      // is a net nobody should count on.
      expect(() => parseWorkflowYaml('probe.yml', '- a: 1\nb: c\n')).toThrow('was left unread');
    });

    it('refuses a file with no jobs: key', () => {
      expect(() => modelOf({ file: 'probe.yml', text: 'name: nothing\n' }, PROBE_READ_WORKFLOWS)).toThrow(
        'has no "jobs:" mapping',
      );
    });

    it('reads a steps: sequence written at the key’s own indent', () => {
      // Legal YAML that a stricter reader would skip in silence. Asserted rather
      // than assumed, because "found no steps" and "there are no steps" are the
      // two outcomes this whole file exists to keep apart.
      const text = ['jobs:', '  probe:', '    runs-on: ubuntu-latest', '    steps:', '    - run: pnpm test'].join('\n');
      expect(modelOf({ file: 'probe.yml', text }, PROBE_READ_WORKFLOWS).jobs[0]?.steps[0]?.run).toBe('pnpm test');
    });

    it('reads a run: whose value is written on the next line', () => {
      // The `uses:` half of this spelling was defect three. The `run:` half was
      // never separately probed, and a line reader misses it the same way.
      const model = probe('      - run:', '          pnpm probe-unlisted-gate')();
      expect(model.jobs[0]?.commands).toEqual([{ text: 'pnpm probe-unlisted-gate', gating: true }]);
    });

    it('reads a key written with a space before its colon', () => {
      // Ordinary YAML, and one more position along the line that nothing had
      // varied. `run : x` is the key `run`.
      expect(probe('      - run : pnpm probe-unlisted-gate')().jobs[0]?.commands).toEqual([
        { text: 'pnpm probe-unlisted-gate', gating: true },
      ]);
    });

    it('refuses a step key that differs from a known one only in case', () => {
      // `RUN:` is not `run:` to the runner either, so a step spelled this way
      // runs nothing — but a reader that lower-cased keys to be helpful would
      // report a gate that does not exist. Refused, and named.
      expect(probe('      - RUN: pnpm probe-unlisted-gate')).toThrow(
        'has a step key this reader does not know: "RUN"',
      );
    });

    it('reads a run: block scalar as the commands it contains', () => {
      const model = probe(
        '      - run: |',
        '          sudo apt-get update',
        '          sudo apt-get install -y \\',
        '            libssl-dev',
      )();
      // The gating flags are asserted here rather than only in the workflow,
      // because this is where they are produced: a newline ends the chain, so
      // only the last line of a block scalar is read as able to fail the job.
      expect(model.jobs[0]?.commands).toEqual([
        { text: 'sudo apt-get update', gating: false },
        { text: 'sudo apt-get install -y libssl-dev', gating: true },
      ]);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* the enumeration, wired to the reader that depends on it                    */
/* -------------------------------------------------------------------------- */

describe('a local uses: is judged against the files the enumeration really read', () => {
  // Defect ten's lesson, applied before it costs anything: *the rule being
  // testable is not the wiring being testable*. Every `uses:` case above hands
  // `modelOf` a set assembled by hand, so all of them stay green under a
  // `readWorkflowSurface` that passes the wrong set. Measured on this tree,
  // twice each: replacing the enumeration with `new Set<string>()` is 1 failed |
  // 140 passed, and the one red is the first case here; dropping the membership
  // test so that any `./` path is admitted is 18 failed | 123 passed, and the
  // second case here is among them. Neither mutation is visible to any case
  // above.
  //
  // These two run the real `readWorkflowSurface` over a real directory, which is
  // why they build one rather than mocking `node:fs`: a mock would be a third
  // hand-made set.

  function inTemporaryRepository(
    files: Readonly<Record<string, string>>,
    body: (root: string) => void,
  ): void {
    const root = mkdtempSync(join(tmpdir(), 'verify-covers-ci-'));
    try {
      mkdirSync(join(root, ...WORKFLOW_DIRECTORY), { recursive: true });
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(root, ...WORKFLOW_DIRECTORY, name), text);
      }
      body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  /** A workflow whose only job is a call to a local reusable workflow. */
  const callerOf = (target: string): string =>
    ['jobs:', '  call:', `    uses: ./.github/workflows/${target}`].join('\n');

  /** The callee: one real gate, so its arrival in the model is observable. */
  const CALLEE = [
    'jobs:',
    '  gate:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: pnpm typecheck',
  ].join('\n');

  it('admits the call when the directory really contains the target', () => {
    inTemporaryRepository({ 'main.yml': callerOf('helper.yml'), 'helper.yml': CALLEE }, (root) => {
      const surface = readWorkflowSurface(root);
      expect(surface.files).toEqual(['helper.yml', 'main.yml']);
      // Not just "it did not throw": the allow-branch's justification is that
      // the target's own jobs are already in the model, so that is what is
      // asserted. The callee's gate is here, under the callee's own name.
      expect(surface.models.flatMap((model) => model.jobs).flatMap((job) => job.commands)).toEqual([
        { text: 'pnpm typecheck', gating: true },
      ]);
      expect(surface.models.flatMap((model) => model.jobs).map((job) => `${job.file}:${job.name}`)).toEqual([
        'helper.yml:gate',
        'main.yml:call',
      ]);
    });
  });

  it('refuses the identical call when the target is not a file it read', () => {
    inTemporaryRepository({ 'main.yml': callerOf('missing.yml') }, (root) => {
      expect(() => readWorkflowSurface(root)).toThrow(
        'has a "uses:" this reader cannot place: "./.github/workflows/missing.yml"',
      );
    });
  });
});

/* -------------------------------------------------------------------------- */
/* commands, read as shell                                                    */
/* -------------------------------------------------------------------------- */

describe('a command line is read as the commands it runs', () => {
  const texts = (source: string): string[] => shellCommands(source, 'probe').map((c) => c.text);
  const gating = (source: string): string[] =>
    shellCommands(source, 'probe')
      .filter((c) => c.gating)
      .map((c) => c.text);

  it('splits a && chain into its simple commands — defect five', () => {
    // `pnpm install --frozen-lockfile && pnpm probe-smuggled-gate` was 42/42
    // green three times over, because the exemption asked whether the command
    // *began* with setup and never whether it was *only* setup.
    expect(texts('pnpm install --frozen-lockfile && pnpm probe-smuggled-gate')).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm probe-smuggled-gate',
    ]);
  });

  it('splits the command a backslash continuation rejoins', () => {
    // The second spelling of defect five, and the one a YAML parser does not
    // touch: the parser hands back one correct scalar and the hole is here.
    expect(
      texts('sudo apt-get install -y \\\n  libssl-dev libsecret-1-dev \\\n  && ./scripts/probe.sh'),
    ).toEqual(['sudo apt-get install -y libssl-dev libsecret-1-dev', './scripts/probe.sh']);
  });

  it.each([
    { shape: 'a && b', source: 'a && b', expected: ['a', 'b'] },
    { shape: 'a || b', source: 'a || b', expected: ['b'] },
    { shape: 'a && b || c', source: 'a && b || c', expected: ['c'] },
    { shape: 'a && b || c && d', source: 'a && b || c && d', expected: ['c', 'd'] },
    { shape: 'a ; b', source: 'a ; b', expected: ['b'] },
    { shape: 'a | b', source: 'a | b', expected: ['b'] },
    { shape: 'a\\nb', source: 'a\nb', expected: ['b'] },
  ])('knows which commands in $shape can fail the run', ({ source, expected }) => {
    // Defect six's other half. `a && b || c` is `((a && b) || c)`: if `a` fails
    // the `||` catches it, so neither `a` nor `b` can fail the run. This is why
    // wrapping one flaky gate in `|| echo` takes the gates in front of it out
    // of the chain too, and why the message for that case says so.
    expect(gating(source)).toEqual(expected);
  });

  it.each([
    { construct: 'a subshell', source: 'a && (b || c)', names: 'a subshell or group' },
    { construct: 'a command substitution', source: 'a $(b)', names: 'a command substitution' },
    { construct: 'a backtick substitution', source: 'a `b`', names: 'a command substitution' },
    { construct: 'a background job', source: 'a & b', names: 'a background job' },
    { construct: 'a shell expansion', source: 'a $B', names: 'a shell expansion' },
  ])('refuses $construct rather than guessing what it runs', ({ source, names }) => {
    // Refusal, not a best guess. Each of these can put a command into the run
    // whose text is not in the file, and this reader's one job is never to
    // report a clean read of something it did not read.
    expect(() => shellCommands(source, 'probe')).toThrow(names);
  });

  it('reads text inside quotes as an argument, never as a command', () => {
    // Defect six in one line. `echo "… pnpm typecheck …"` used to satisfy the
    // typecheck gate. It is one command whose program is `echo`.
    const commands = shellCommands('echo "pnpm typecheck && pnpm build"', 'probe');
    expect(commands.map((c) => c.text)).toHaveLength(1);
    expect(parseCommand(commands[0]?.text ?? '').program).toBe('echo');
  });
});

describe('verify is read as commands that execute, not as text that mentions them', () => {
  it('follows a pnpm script invocation into the script it invokes', () => {
    // The chain is real: `cargo fmt --all --check` is nowhere in `verify`'s own
    // body and reaches it through `pnpm lint:rust`.
    expect(
      VERIFY_CHAIN.some((entry) => entry.gating && invokes(entry.command, 'cargo', 'fmt', '--all', '--check')),
      'verify -> lint:rust -> cargo fmt is the expansion this test is about',
    ).toBe(true);
    expect(VERIFY_CHAIN.some((entry) => entry.script === 'lint:rust')).toBe(true);
  });

  it.each([
    { program: 'echo', text: 'echo "pnpm typecheck"' },
    { program: 'echo', text: 'echo pnpm typecheck' },
  ])('does not read $program’s arguments as an invocation', ({ text }) => {
    // Both spellings. The quoted one is the construction that was measured
    // 42/42 green; the unquoted one is what a second agent would reach for once
    // the quoted one stopped working, and it is the reason the fix cannot be
    // "strip quoted spans".
    expect(pnpmScript(parseCommand(text))).toBeUndefined();
    expect(CI_GATES.every(({ runs }) => !runs(parseCommand(text)))).toBe(true);
  });

  it('does not read a gate name in a script body as an invocation of it', () => {
    // The whole of defect six, driven through the real expander against a
    // synthetic package.json shape.
    const chain = chainOf('probe', {
      probe: 'echo "CI still runs: pnpm typecheck pnpm lint:rust cargo test --workspace --locked"',
      typecheck: 'tsc --build --force',
      'lint:rust': 'cd src-tauri && cargo fmt --all --check',
    });
    expect(chain.map((entry) => entry.command.text)).toEqual([
      'echo "CI still runs: pnpm typecheck pnpm lint:rust cargo test --workspace --locked"',
    ]);
    expect(CI_GATES.filter(({ runs }) => chain.some((e) => e.gating && runs(e.command)))).toEqual([]);
  });

  it('marks a gate whose failure is caught as reached but not gating', () => {
    const chain = chainOf('probe', {
      probe: 'pnpm test:harness || echo "flaky here" && pnpm build',
      'test:harness': 'vitest run',
      build: 'vite build',
    });
    expect(chain.filter((e) => e.gating).map((e) => e.command.text)).not.toContain('pnpm test:harness');
    expect(chain.some((e) => !e.gating && e.command.text === 'pnpm test:harness')).toBe(true);
  });

  it('stops following a script chain that refers back to itself', () => {
    expect(chainOf('a', { a: 'pnpm b', b: 'pnpm a' }).map((e) => e.command.text)).toEqual([
      'pnpm b',
      'pnpm a',
    ]);
  });

  it.each([
    { neutered: 'cargo test --workspace --locked --no-run' },
    { neutered: 'pnpm test --passWithNoTests' },
    { neutered: 'pnpm test:harness --reporter=dot --passWithNoTests' },
    { neutered: 'node scripts/run-bash.mjs scripts/secret-scan.sh --dry-run' },
  ])('does not accept $neutered as the gate it starts with', ({ neutered }) => {
    // The route out of this fix that a leading-argument test would have left
    // open, and the reason {@link invokes} and {@link runsPnpm} are exact. Each
    // of these still *contains* its gate and still *begins* with it; none of
    // them still runs it. There is no reading of the string that separates a
    // strengthening flag from an emptying one, so the row reddens and a person
    // decides.
    const command = parseCommand(neutered);
    expect(CI_GATES.filter(({ runs }) => runs(command))).toEqual([]);
  });

  it('accepts the unflagged form of each of those', () => {
    // The control. Without it the case above passes for a matcher that accepts
    // nothing at all.
    for (const exact of [
      'cargo test --workspace --locked',
      'pnpm test',
      'pnpm test:harness',
      'node scripts/run-bash.mjs scripts/secret-scan.sh',
    ]) {
      expect(
        CI_GATES.some(({ runs }) => runs(parseCommand(exact))),
        `"${exact}" is a gate this file must still recognise`,
      ).toBe(true);
    }
  });

  it('does not exempt a command that merely begins with a setup command', () => {
    // Defect five, asked of the exemption directly rather than through the real
    // workflow. The tree contains no such command, so a code change here is
    // invisible to every other case in this file — which is exactly how a
    // prefix test survived three rounds of review.
    const one = (command: string): WorkflowCommand[] => [
      { file: 'probe.yml', job: 'probe', command, gating: true },
    ];

    expect(unaccounted(one('pnpm install --frozen-lockfile && pnpm probe-smuggled-gate'))).toEqual([
      'probe.yml:probe: pnpm install --frozen-lockfile && pnpm probe-smuggled-gate',
    ]);
    expect(unaccounted(one('cargo test --workspace --locked --no-run'))).toEqual([
      'probe.yml:probe: cargo test --workspace --locked --no-run',
    ]);

    // The controls, without which the two rows above pass for a filter that
    // exempts nothing at all.
    expect(unaccounted(one('pnpm install --frozen-lockfile'))).toEqual([]);
    expect(unaccounted(one('cargo test --workspace --locked'))).toEqual([]);
  });

  it('a gate row is checked against itself — defect seven', () => {
    // The real list is consistent, so this rule is invisible to every other case
    // in this file unless it is asked about rows the tree does not contain.
    const ok: CiGate = { ci: 'pnpm test', runs: (c) => runsPnpm(c, 'test') };
    expect(rowDrift(ok, [ok])).toEqual([]);

    // The measured escape: CI's command was strengthened, the `ci` string was
    // updated because `unaccounted` forces it, and `runs` still describes the
    // command CI stopped running.
    const drifted: CiGate = {
      ci: 'cargo build --workspace --locked --all-targets',
      runs: (c) => invokes(c, 'cargo', 'build', '--workspace', '--locked'),
    };
    expect(rowDrift(drifted, [drifted])).toHaveLength(1);
    expect(rowDrift(drifted, [drifted])[0]).toContain('drifted apart');
  });

  it('a wrapper row has to earn its exemption — defect seven', () => {
    const inner: CiGate = { ci: 'pnpm test:harness', runs: (c) => runsPnpm(c, 'test:harness') };
    const wrapper: CiGate = {
      ci: 'node scripts/ci-retry-vitest-crash.mjs pnpm test:harness',
      runs: (c) => runsPnpm(c, 'test:harness'),
      delegatesTo: 'pnpm test:harness',
    };
    expect(rowDrift(wrapper, [inner, wrapper])).toEqual([]);

    // Without the inner row listed, the delegation points at a gate nothing
    // checks — which is how a wrapper would become the only record of a gate.
    expect(rowDrift(wrapper, [wrapper])).toHaveLength(1);
    expect(rowDrift(wrapper, [wrapper])[0]).toContain('not itself a listed gate');

    // `delegatesTo` is not a way to switch the check off: a row whose predicate
    // already accepts its own `ci` does not need one, and is told to delete it.
    const needless: CiGate = { ...inner, delegatesTo: 'pnpm test:harness' };
    expect(rowDrift(needless, [inner, needless])).toHaveLength(1);
    expect(rowDrift(needless, [inner, needless])[0]).toContain('exemption is not needed');

    // And a predicate that describes neither half is caught rather than excused.
    const neither: CiGate = { ...wrapper, runs: (c) => runsPnpm(c, 'build') };
    expect(rowDrift(neither, [inner, neither])).toEqual([
      expect.stringContaining('does not accept that command either'),
    ]);
  });

  it('a suppressed gate is caught wherever CI writes it — defect ten', () => {
    // Asked of the rule directly. `ci.yml` contains no suppressed gate, so with
    // this rule written inline it asserted nothing about itself: dropping the
    // `gating` flag on the way into COMMANDS — which is defect ten put straight
    // back — was measured at 115/115 green, twice, and only reddened once a
    // mutated `ci.yml` supplied the input the tree does not have.
    const gates: CiGate[] = [{ ci: 'pnpm test', runs: (c) => runsPnpm(c, 'test') }];
    const at = (command: string, gating: boolean): WorkflowCommand[] => [
      { file: 'probe.yml', job: 'probe', command, gating },
    ];

    expect(swallowedGates(at('pnpm test', false), gates)).toEqual(['probe.yml:probe: pnpm test']);

    // Two controls. A gate that can fail is not reported, or the rule would be
    // satisfied by one that reports everything; and a *non-gate* that cannot
    // fail is not reported either, because setup is allowed to be suppressed and
    // a rule that objected to it would be red on this tree's apt steps.
    expect(swallowedGates(at('pnpm test', true), gates)).toEqual([]);
    expect(swallowedGates(at('sudo apt-get update', false), gates)).toEqual([]);
  });

  it('reads pnpm run <script> as the same invocation as pnpm <script>', () => {
    expect(runsPnpm(parseCommand('pnpm run typecheck'), 'typecheck')).toBe(true);
    expect(runsPnpm(parseCommand('pnpm run typecheck --incremental'), 'typecheck')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* the YAML reader                                                            */
/* -------------------------------------------------------------------------- */

/** One node of the block-YAML subset this reader implements. */
type YamlNode =
  | { readonly kind: 'mapping'; readonly entries: readonly YamlEntry[]; readonly line: number }
  | { readonly kind: 'sequence'; readonly items: readonly YamlNode[]; readonly line: number }
  | { readonly kind: 'scalar'; readonly value: string; readonly line: number };

interface YamlEntry {
  readonly key: string;
  readonly value: YamlNode;
  readonly line: number;
}

/**
 * A block-YAML subset, parsed **totally**: every non-blank, non-comment line is
 * consumed by a construct this reader implements, or the file is refused by
 * name and line.
 *
 * That totality is the fix for defect four and its whole class. The old reader
 * scanned for lines matching `/^[ \t]*-?[ \t]*run:/` and said nothing about
 * every other line, so any spelling outside that pattern — a quoted key, a flow
 * mapping, anything a fourth agent thinks of next — was invisible *and silent*.
 * A parser that must account for every line cannot be silent: it either
 * understands the line or throws.
 *
 * Implemented: block mappings (keys bare, `'…'` or `"…"`), block sequences,
 * plain / quoted / literal / folded scalars, flow sequences kept as opaque text
 * (`branches: [main]` — nothing here looks inside one), and comments.
 *
 * Refused: flow mappings, anchors, aliases, tags, document separators,
 * directives, tabs in indentation, an unterminated quote, and anything left over
 * after the document ends.
 *
 * Not a general YAML implementation and not trying to be. A construct outside
 * the subset costs a review, which is the trade rule 2 of this file has always
 * made; the alternative — reading past it — is the defect.
 */
function parseWorkflowYaml(file: string, text: string): YamlNode {
  const lines = text.split(/\r?\n/u);
  let index = 0;

  const at = (line: number): string => `.github/workflows/${file}:${String(line + 1)}`;
  function refuse(line: number, what: string): never {
    throw new Error(
      `${at(line)} ${what}. This reader parses a block-YAML subset and refuses ` +
        'what it cannot take apart, because reading past a construct is how a ' +
        'gate reaches CI unseen. Rewrite it in the subset, or teach this reader.',
    );
  }

  const isSkippable = (line: string): boolean => {
    const trimmed = line.trim();
    return trimmed === '' || trimmed.startsWith('#');
  };

  /** A bare mapping key, ending at the first `:` that is followed by space or EOL. */
  const PLAIN_KEY = /^([^\s#'"{}[\]&*!|>%@`,][^:#]*?)[ \t]*:(?=[ \t]|$)(.*)$/u;

  /**
   * Whether a line opens a mapping entry — asked without refusing, because the
   * caller is deciding *what shape* follows a key, not judging the line.
   */
  const isKeyLine = (trimmed: string): boolean => {
    const quote = trimmed[0];
    if (quote === '"' || quote === "'") {
      const close = trimmed.indexOf(quote, 1);
      return close !== -1 && trimmed.slice(close + 1).startsWith(':');
    }
    return PLAIN_KEY.test(trimmed);
  };

  function indentOf(line: number): number {
    const raw = lines[line] ?? '';
    if (raw.slice(0, raw.length - raw.trimStart().length).includes('\t')) {
      refuse(line, 'is indented with a tab');
    }
    return raw.length - raw.trimStart().length;
  }

  function nextContent(from: number): number {
    let cursor = from;
    while (cursor < lines.length && isSkippable(lines[cursor] ?? '')) cursor += 1;
    return cursor;
  }

  for (const [line, raw] of lines.entries()) {
    const trimmed = raw.trim();
    if (trimmed === '---' || trimmed === '...') refuse(line, 'is a document separator');
    if (raw.startsWith('%')) refuse(line, 'is a YAML directive');
  }

  /** The scalar text of a block scalar (`|`, `>`) whose key sits at `indent`. */
  function blockScalar(from: number, indent: number, folded: boolean): { value: string; next: number } {
    const body: string[] = [];
    let cursor = from;
    let strip = -1;
    while (cursor < lines.length) {
      const raw = lines[cursor] ?? '';
      if (raw.trim() === '') {
        body.push('');
        cursor += 1;
        continue;
      }
      const depth = indentOf(cursor);
      if (depth <= indent) break;
      if (strip === -1) strip = depth;
      body.push(raw.slice(strip));
      cursor += 1;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    // Folding joins continuation lines with a space, which is what the runner's
    // shell then sees as one command; a literal block keeps the newlines, which
    // is what makes each line its own command.
    return { value: folded ? body.join(' ').trim() : body.join('\n'), next: cursor };
  }

  /** The value written after a key, on the line or below it. */
  function parseValue(line: number, rest: string, indent: number): YamlNode {
    const value = rest.trim();

    const block = /^([|>])[-+]?[0-9]*[ \t]*(?:#.*)?$/u.exec(value);
    if (block !== null) {
      const { value: scalar, next } = blockScalar(line + 1, indent, block[1] === '>');
      index = next;
      return { kind: 'scalar', value: scalar, line };
    }

    if (value === '' || value.startsWith('#')) {
      const below = nextContent(line + 1);
      if (below < lines.length) {
        const depth = indentOf(below);
        const trimmed = (lines[below] ?? '').trim();
        const isItem = trimmed === '-' || trimmed.startsWith('- ');
        if (depth > indent) {
          if (isItem || isKeyLine(trimmed)) {
            index = below;
            return parseNode(depth);
          }
          // A plain scalar written below its key, which YAML folds into one
          // string with spaces. This is one of the spellings defect three was
          // about, and the only reason it reached this reader as a *refusal*
          // before was that a line reader could not see it at all.
          const parts: string[] = [];
          let cursor = below;
          while (cursor < lines.length) {
            const raw = lines[cursor] ?? '';
            if (isSkippable(raw)) {
              cursor += 1;
              continue;
            }
            const text = raw.trim();
            if (indentOf(cursor) <= indent) break;
            if (text === '-' || text.startsWith('- ') || isKeyLine(text)) break;
            parts.push(text);
            cursor += 1;
          }
          index = cursor;
          return { kind: 'scalar', value: parts.join(' '), line };
        }
        // A sequence may sit at its key's own indent. Legal, common, and a
        // reader that treated it as "no value" would drop every step in the job.
        if (depth === indent && isItem) {
          index = below;
          return parseSequence(indent);
        }
      }
      index = line + 1;
      return { kind: 'scalar', value: '', line };
    }

    index = line + 1;

    if (value.startsWith('{')) refuse(line, 'is a flow mapping');
    if (value.startsWith('&') || value.startsWith('*') || value.startsWith('!')) {
      refuse(line, 'is an anchor, alias or tag');
    }
    if (value.startsWith('[')) {
      if (!value.includes(']')) refuse(line, 'is a flow sequence that does not close on its line');
      if (value.includes('{')) refuse(line, 'is a flow mapping inside a flow sequence');
      // Kept as opaque text: nothing here looks inside one (`branches: [main]`).
      return { kind: 'scalar', value, line };
    }

    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.includes('\\')) refuse(line, 'is a quoted scalar containing a backslash escape');
      const close = value.indexOf(quote, 1);
      if (close === -1) refuse(line, 'is a scalar whose quote never closes');
      const after = value.slice(close + 1).trim();
      if (after !== '' && !after.startsWith('#')) {
        refuse(line, 'has text after the closing quote of its value');
      }
      return { kind: 'scalar', value: value.slice(1, close), line };
    }

    // A plain scalar ends at ` #`, which starts a comment. Anchors and aliases
    // are refused above, so what is left is text.
    const comment = value.search(/[ \t]#/u);
    return { kind: 'scalar', value: (comment === -1 ? value : value.slice(0, comment)).trim(), line };
  }

  function parseMapping(indent: number): YamlNode {
    const startLine = index;
    const entries: YamlEntry[] = [];
    const seen = new Set<string>();

    for (;;) {
      const line = nextContent(index);
      if (line >= lines.length) break;
      const depth = indentOf(line);
      if (depth < indent) break;
      const raw = lines[line] ?? '';
      const trimmed = raw.trim();
      if (depth > indent) refuse(line, 'is indented deeper than the mapping it belongs to');
      if (trimmed === '-' || trimmed.startsWith('- ')) {
        refuse(line, 'is a sequence item where this reader expects a mapping key');
      }
      // `- { run: pnpm x }` — defect four's second spelling. A line reader has
      // no line beginning `run:` to find here, and neither has this one; the
      // difference is that this one says so.
      if (trimmed.startsWith('{')) refuse(line, 'is a flow mapping');

      let key: string;
      let rest: string;
      const quote = trimmed[0];
      if (quote === '"' || quote === "'") {
        const close = trimmed.indexOf(quote, 1);
        if (close === -1) refuse(line, 'has a key whose quote never closes');
        if (trimmed.slice(0, close).includes('\\')) {
          refuse(line, 'has a quoted key containing a backslash escape');
        }
        const after = trimmed.slice(close + 1);
        if (!after.startsWith(':')) refuse(line, 'is a quoted scalar where a mapping key belongs');
        key = trimmed.slice(1, close);
        rest = after.slice(1);
      } else {
        const parsed = PLAIN_KEY.exec(trimmed);
        if (parsed === null) refuse(line, `is at mapping depth but is not a key this reader can read: "${trimmed}"`);
        key = parsed[1] ?? '';
        rest = parsed[2] ?? '';
      }

      // Last-wins is YAML's rule and first-wins is what a reader like this
      // naturally does, so the two can disagree about what runs. Refused.
      if (seen.has(key)) refuse(line, `repeats the key "${key}" in one mapping`);
      seen.add(key);

      index = line + 1;
      entries.push({ key, value: parseValue(line, rest, depth), line });
    }

    return { kind: 'mapping', entries, line: startLine };
  }

  function parseSequence(indent: number): YamlNode {
    const startLine = index;
    const items: YamlNode[] = [];

    for (;;) {
      const line = nextContent(index);
      if (line >= lines.length) break;
      if (indentOf(line) !== indent) break;
      const raw = lines[line] ?? '';
      const trimmed = raw.trim();
      if (trimmed !== '-' && !trimmed.startsWith('- ')) break;

      const after = raw.slice(indent + 1);
      if (after.trim() === '' || after.trimStart().startsWith('#')) {
        index = line + 1;
        const below = nextContent(index);
        if (below >= lines.length || indentOf(below) <= indent) {
          items.push({ kind: 'scalar', value: '', line });
          continue;
        }
        index = below;
        items.push(parseNode(indentOf(below)));
        continue;
      }

      // The dash becomes indentation, so the columns of everything on and under
      // this line line up with the node that starts here.
      const column = indent + 1 + (after.length - after.trimStart().length);
      lines[line] = ' '.repeat(column) + after.trimStart();
      index = line;
      items.push(parseNode(column));
    }

    return { kind: 'sequence', items, line: startLine };
  }

  function parseNode(indent: number): YamlNode {
    const line = nextContent(index);
    index = line;
    if (line >= lines.length) return { kind: 'scalar', value: '', line };
    const trimmed = (lines[line] ?? '').trim();
    if (trimmed === '-' || trimmed.startsWith('- ')) return parseSequence(indent);
    return parseMapping(indent);
  }

  const first = nextContent(0);
  if (first >= lines.length) throw new Error(`.github/workflows/${file} has nothing in it to read`);
  if (indentOf(first) !== 0) refuse(first, 'starts the document indented');
  index = first;
  const root = parseNode(0);

  // The totality net. If anything is left, the parser walked past a construct
  // instead of refusing it, and that is the bug this whole file is about.
  const leftover = nextContent(index);
  if (leftover < lines.length) refuse(leftover, 'was left unread after the document ended');

  return root;
}

/* -------------------------------------------------------------------------- */
/* the shell reader                                                           */
/* -------------------------------------------------------------------------- */

/** One simple command, and whether its failure fails the run it is part of. */
interface ShellCommand {
  readonly text: string;
  /**
   * False when a shell operator swallows this command's exit status: it is on
   * the left of a `||`, or in front of a `;`, or upstream in a `|`. Read by the
   * `verify reaches the CI gate` case, which is the whole of defect six.
   */
  readonly gating: boolean;
}

/**
 * A command line, split into the simple commands the shell would run.
 *
 * Two things this has to get right, and the old reader got neither:
 *
 * 1. **Every command, not the first one.** `pnpm install --frozen-lockfile &&
 *    pnpm probe-smuggled-gate` is two commands. Reading it as one string and
 *    asking whether it *begins* with setup is defect five.
 * 2. **Which of them can fail the run.** `a && b || c` is `((a && b) || c)`, so
 *    a failure of `a` or `b` is caught by the `||` and only `c` can fail the
 *    line. That is defect six: a gate wrapped in `|| echo` is present in the
 *    script and gates nothing.
 *
 * Refusals, not guesses: command substitution, subshells and brace groups,
 * background jobs, and any `$` expansion outside single quotes. Each of them can
 * make the text of the command differ from what runs, and this file's one rule
 * is that a reader which cannot see a value must say so.
 */
function shellCommands(source: string, where: string): ShellCommand[] {
  const refuse = (what: string): never => {
    throw new Error(
      `${where} contains ${what}, which this reader cannot evaluate. It refuses ` +
        'rather than guess: a command whose text is not in the file is a gate ' +
        'nobody here is checking. Write the chain out, or teach this reader.',
    );
  };

  // A backslash-newline is a line continuation: rejoin before splitting, so a
  // wrapped `apt-get install` reads as the one command it is.
  const text = source.replace(/[ \t]*\\\r?\n[ \t]*/gu, ' ');

  const out: ShellCommand[] = [];
  let group: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  const endSegment = (): void => {
    const trimmed = current.trim();
    current = '';
    if (trimmed !== '') group.push(trimmed);
  };
  const flush = (gating: boolean): void => {
    for (const command of group) out.push({ text: command, gating });
    group = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    const next = text[i + 1] ?? '';

    if (quote !== null) {
      if (quote === '"' && char === '$') refuse('a shell expansion inside double quotes');
      if (quote === '"' && char === '`') refuse('a command substitution');
      if (char === quote) quote = null;
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '`') refuse('a command substitution');
    if (char === '$') refuse(next === '(' ? 'a command substitution' : 'a shell expansion');
    if ((char === '<' || char === '>') && next === '(') refuse('a process substitution');
    if (char === '(' || char === ')' || char === '{' || char === '}') refuse('a subshell or group');

    if (char === '&' && next === '&') {
      endSegment();
      i += 1;
      continue;
    }
    if (char === '&') refuse('a background job');
    if (char === '|' && next === '|') {
      endSegment();
      flush(false);
      i += 1;
      continue;
    }
    if (char === '|' || char === ';' || char === '\n') {
      endSegment();
      flush(false);
      continue;
    }

    current += char;
  }

  if (quote !== null) refuse('a quote that never closes');
  endSegment();
  flush(true);
  return out;
}

/** One simple command, split into what it runs and what it runs it on. */
interface ParsedCommand {
  readonly text: string;
  readonly program: string;
  readonly args: readonly string[];
}

/**
 * Split a simple command into its program and arguments, with quoting removed.
 *
 * The point of separating the program from the arguments is defect six: a gate
 * name that appears in an argument is a *word*, and a gate name in the program
 * position is an *invocation*. `echo "pnpm typecheck"` has program `echo`.
 */
function parseCommand(text: string): ParsedCommand {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);

  return { text, program: tokens[0] ?? '', args: tokens.slice(1) };
}

/**
 * True when `command` is exactly `program` with exactly these arguments.
 *
 * **Exact, not a leading-argument prefix.** The prefix version is one more
 * instance of defect five in a different place, and it has a working exploit:
 * `cargo test --workspace --locked --no-run` satisfies a prefix test, runs zero
 * tests, and leaves this file green while `verify` has stopped verifying. There
 * is no way to tell a flag that strengthens a gate (`--no-fail-fast`) from one
 * that empties it (`--no-run`, `--passWithNoTests`) by looking at the string, so
 * this reader does not try: an argument list that differs from CI's reddens and
 * asks for a human.
 *
 * The alternative considered and rejected: an allowlist of flags known to be
 * harmless. It is the same shape as the exemption that failed — a list of
 * spellings someone thought of — and the failure mode is a silent green rather
 * than a review. Exactness is noisier and cannot be wrong in that direction.
 */
function invokes(command: ParsedCommand, program: string, ...args: readonly string[]): boolean {
  return (
    command.program === program &&
    command.args.length === args.length &&
    args.every((argument, at) => command.args[at] === argument)
  );
}

/**
 * True when `command` is `pnpm <script>` with nothing after the script name.
 *
 * Same argument as {@link invokes}. `pnpm test --passWithNoTests` is a `pnpm
 * test` invocation and is not the `pnpm test` gate.
 */
function runsPnpm(command: ParsedCommand, script: string): boolean {
  if (pnpmScript(command) !== script) return false;
  return command.args.length === (command.args[0] === 'run' ? 2 : 1);
}

/**
 * The `package.json` script a command invokes through pnpm, or `undefined`.
 *
 * The name has to be a key in `scripts` — `pnpm install --frozen-lockfile`
 * invokes no script — and it has to be in the *program's argument* position, not
 * merely somewhere in the text. That last clause is defect six.
 */
function pnpmScript(command: ParsedCommand): string | undefined {
  if (command.program !== 'pnpm') return undefined;
  const at = command.args[0] === 'run' ? 1 : 0;
  const name = command.args[at];
  if (name === undefined || name.startsWith('-')) return undefined;
  return Object.hasOwn(PACKAGE.scripts, name) ? name : undefined;
}

/**
 * True when `command` executes the repository script at `path`.
 *
 * Two ways this tree reaches one, both named rather than pattern-matched: the
 * script as the program (`./scripts/secret-scan.sh`), and the script handed to
 * `scripts/run-bash.mjs`, which is the hop a Windows developer takes because
 * pnpm runs script bodies through `cmd.exe`. Anything else is not an execution
 * as far as this reader is concerned, and it will say the gate is missing rather
 * than accept a mention of the filename.
 */
function runsScript(command: ParsedCommand, path: string): boolean {
  if (command.program.replace(/^\.\//u, '') === path) return command.args.length === 0;
  return (
    command.program === 'node' &&
    command.args.length === 2 &&
    command.args[0] === 'scripts/run-bash.mjs' &&
    command.args[1] === path
  );
}

/* -------------------------------------------------------------------------- */
/* the workflow surface                                                       */
/* -------------------------------------------------------------------------- */

/** One workflow file the runner would load. */
interface Workflow {
  /** Relative to `.github/workflows/`, `/` separators. */
  readonly file: string;
  readonly text: string;
}

/** One step, as much of it as this reader reasons about. */
interface WorkflowStep {
  readonly line: number;
  /** `undefined` on a `uses:` step. Read by `commands` and by two cases above. */
  readonly run: string | undefined;
  // No `uses` field. It was here, written on every step and read by nothing:
  // `refuseUses` consumes the target at parse time and the assertions above
  // never ask a step what it uses. A field written with no reader is a defect
  // of its own — it looks like coverage and is not — so it is gone rather than
  // kept for a caller that does not exist. Anything that needs the target reads
  // it off the parse tree, which is what `usesTargetOf` does.
}

/** One job, with the simple commands its steps run. */
interface WorkflowJob {
  readonly file: string;
  readonly name: string;
  readonly runsOn: string;
  readonly steps: readonly WorkflowStep[];
  /**
   * Every simple command the job's `run:` steps execute, each carrying whether
   * its failure can fail the job. The flag used to be computed here and dropped
   * on the floor by a `.map(c => c.text)`; keeping it is defect ten, and its
   * reader is *every CI gate can actually fail the job it is listed in*.
   */
  readonly commands: readonly ShellCommand[];
}

/** What this reader made of one workflow file. */
interface WorkflowModel {
  readonly file: string;
  readonly jobs: readonly WorkflowJob[];
}

/** One simple command CI runs, carrying the file and job that run it. */
interface WorkflowCommand {
  readonly file: string;
  readonly job: string;
  readonly command: string;
  /** Whether this command's failure can fail the job CI runs it in. */
  readonly gating: boolean;
}

/**
 * The commands CI runs that are neither a listed setup command nor a listed
 * gate, named by file and job.
 *
 * A named function rather than an inline filter so that its rule can be tested
 * on inputs the real tree does not contain. Mutating an inline filter that only
 * ever sees clean input changes nothing observable, which makes it look tested
 * when it is not — measured: turning the equality below back into a `startsWith`
 * left this file 89/89 green until the case *does not exempt a command that
 * merely begins with a setup command* existed.
 *
 * Both halves are **equality**, deliberately. `startsWith` on the setup side is
 * defect five verbatim; `startsWith` on the gate side is the same shape, and
 * would let `cargo test --workspace --locked --no-run` pass as the `cargo test`
 * gate.
 */
/**
 * The ways one {@link CiGate} row can have stopped being about one command,
 * named rather than merely asserted.
 *
 * A named function for the same reason {@link unaccounted} is one: every row in
 * the real list is consistent, so a rule written inline here would only ever see
 * input that satisfies it, and weakening the rule would change nothing
 * observable. The cases in *a gate row is checked against itself* feed it rows
 * this tree does not contain.
 *
 * `delegatesTo` is the one shape where the halves are meant to differ — CI runs
 * the harness gate through `ci-retry-vitest-crash.mjs` and `verify` must reach
 * the unwrapped gate. Three conditions make that an exemption that has to be
 * earned: the target must be a listed gate, the predicate must accept the
 * target, and it must *not* accept the wrapper, so a row cannot buy silence by
 * declaring a delegation it does not need.
 */
function rowDrift(gate: CiGate, rows: readonly CiGate[]): string[] {
  const { ci, runs, delegatesTo } = gate;
  if (delegatesTo === undefined) {
    return runs(parseCommand(ci))
      ? []
      : [
          `its "runs" predicate does not accept "${ci}" itself. The two halves of the ` +
            'row have drifted apart: CI runs one command and "pnpm verify" is being ' +
            'checked for another. Either update "runs", or say why the row is a ' +
            'wrapper by giving it "delegatesTo".',
        ];
  }

  const out: string[] = [];
  if (!rows.some((row) => row.ci === delegatesTo)) {
    out.push(
      `it delegates to "${delegatesTo}", which is not itself a listed gate. A ` +
        'delegation target that no row covers is a gate nobody checks.',
    );
  }
  if (!runs(parseCommand(delegatesTo))) {
    out.push(
      `it delegates to "${delegatesTo}" but its "runs" predicate does not accept ` +
        'that command either, so it describes neither half.',
    );
  }
  if (runs(parseCommand(ci))) {
    out.push(
      'it claims to be a wrapper, but its "runs" predicate accepts the wrapping ' +
        'command directly. The exemption is not needed, and an unneeded exemption ' +
        'is somewhere the next drift can hide. Delete "delegatesTo".',
    );
  }
  return out;
}

/**
 * The commands CI lists as gates and then writes so their failure cannot fail
 * the job, named by file and job.
 *
 * A named function for the reason {@link unaccounted} gives, and it was needed:
 * with the rule written inline, dropping the `gating` flag on the way into
 * {@link COMMANDS} — reintroducing defect ten's `.map(c => c.text)` exactly —
 * left this file 115/115 green, because no command in `ci.yml` is suppressed and
 * an inline rule over clean input asserts nothing. That measurement is the whole
 * argument for this function existing.
 */
function swallowedGates(
  commands: readonly WorkflowCommand[],
  gates: readonly CiGate[],
): string[] {
  return commands
    .filter(({ command, gating }) => !gating && gates.some(({ ci }) => command === ci))
    .map(({ file, job, command }) => `${file}:${job}: ${command}`);
}

function unaccounted(commands: readonly WorkflowCommand[]): string[] {
  return commands
    .filter(
      ({ command }) =>
        !SETUP_COMMANDS.includes(command) && !CI_GATES.some(({ ci }) => command === ci),
    )
    .map(({ file, job, command }) => `${file}:${job}: ${command}`);
}

/**
 * The keys this reader knows how to reason about.
 *
 * An unrecognised key is **refused**, and that is the general form of defect
 * four. Every escape so far was a spelling nobody had listed; a reader that only
 * looks for spellings it knows will always be one spelling behind, while a
 * reader that must classify every key it meets is behind on nothing. GitHub
 * rejects unknown keys too, so the list costs nothing a real workflow needs.
 */
const TOP_LEVEL_KEYS = ['name', 'run-name', 'on', 'env', 'defaults', 'concurrency', 'permissions', 'jobs'];
const JOB_KEYS = [
  'name', 'needs', 'if', 'runs-on', 'permissions', 'environment', 'concurrency',
  'outputs', 'env', 'steps', 'timeout-minutes', 'strategy', 'continue-on-error',
  'uses', 'with', 'secrets',
];
const STEP_KEYS = [
  'id', 'if', 'name', 'uses', 'run', 'working-directory', 'shell', 'with', 'env',
  'continue-on-error', 'timeout-minutes',
];
/** Shells whose `&&`, `||`, `;` and `|` mean what {@link shellCommands} assumes. */
const SPLITTABLE_SHELLS = ['bash', 'sh', 'pwsh', 'powershell', 'cmd'];
/**
 * The `defaults:` shape this reader can reason about. Anything else is refused
 * rather than skipped, for the reason in {@link TOP_LEVEL_KEYS}: a default
 * applies to every step in the file, so a default it cannot read is every step
 * read wrong.
 */
const DEFAULTS_KEYS = ['run'];
const DEFAULTS_RUN_KEYS = ['shell', 'working-directory'];

const mappingOf = (node: YamlNode): readonly YamlEntry[] | undefined =>
  node.kind === 'mapping' ? node.entries : undefined;
const scalarOf = (node: YamlNode | undefined): string | undefined =>
  node !== undefined && node.kind === 'scalar' ? node.value : undefined;
const entry = (entries: readonly YamlEntry[], key: string): YamlNode | undefined =>
  entries.find((candidate) => candidate.key === key)?.value;

/**
 * Turn one workflow's YAML into the jobs, steps and commands the rest of this
 * file asserts over — refusing, by name, anything it cannot account for.
 *
 * `readWorkflows` is the repo-root-relative path of every workflow file this run
 * enumerated, and it exists for exactly one reader: {@link refuseUses}, which
 * may admit a local `uses:` only when the target is a file already in that set.
 * It is a parameter rather than a module constant so that the admission is a
 * fact about *this* run's enumeration rather than about the repository the test
 * process happens to sit in — and so that a case can vary it.
 */
function modelOf(workflow: Workflow, readWorkflows: ReadonlySet<string>): WorkflowModel {
  const where = `.github/workflows/${workflow.file}`;
  const at = (line: number): string => `${where}:${String(line + 1)}`;
  const root = parseWorkflowYaml(workflow.file, workflow.text);

  const top = mappingOf(root);
  if (top === undefined) throw new Error(`${where} is not a mapping at its top level`);
  for (const { key, line } of top) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      throw new Error(
        `${at(line)} has a top-level key this reader does not know: "${key}". ` +
          'Teach it what that key does before trusting a green run.',
      );
    }
  }

  // Defect nine. The step-level `shell:` below is refused when this reader
  // cannot split its body — and the identical setting written as a workflow
  // default was listed in TOP_LEVEL_KEYS as a key this reader "knows" and then
  // never read. Measured on this tree, twice: a top-level `defaults: run: shell:
  // python` left the file 91/91 green, while the same three lines inside a job
  // are refused, because JOB_KEYS has no `defaults`. Listing a key as known is
  // not knowing what it does; that gap is the whole class this file is about.
  //
  // So `defaults` is taken apart the way jobs and steps are — every key under it
  // must be one this reader can reason about — and the shell it sets becomes the
  // step's shell wherever the step does not set its own.
  const defaultsNode = entry(top, 'defaults');
  let defaultShell: string | undefined;
  if (defaultsNode !== undefined) {
    const defaults = mappingOf(defaultsNode);
    if (defaults === undefined) throw new Error(`${where} has a "defaults:" that is not a mapping`);
    for (const { key, line } of defaults) {
      if (!DEFAULTS_KEYS.includes(key)) {
        throw new Error(
          `${at(line)} has a "defaults:" key this reader does not know: "${key}". ` +
            'A default it cannot reason about applies to every step in the file.',
        );
      }
    }
    const runDefaultsNode = entry(defaults, 'run');
    if (runDefaultsNode !== undefined) {
      const runDefaults = mappingOf(runDefaultsNode);
      if (runDefaults === undefined) throw new Error(`${where} has a "defaults.run:" that is not a mapping`);
      for (const { key, line } of runDefaults) {
        if (!DEFAULTS_RUN_KEYS.includes(key)) {
          throw new Error(
            `${at(line)} has a "defaults.run:" key this reader does not know: ` +
              `"${key}". A default it cannot reason about applies to every "run:" ` +
              'step in the file.',
          );
        }
      }
      defaultShell = scalarOf(entry(runDefaults, 'shell'));
    }
  }

  const jobsNode = entry(top, 'jobs');
  const jobsMap = jobsNode === undefined ? undefined : mappingOf(jobsNode);
  if (jobsMap === undefined) {
    throw new Error(
      `${where} has no "jobs:" mapping this reader can find, so it would ` +
        'contribute no jobs and no gates to checks that are meant to cover every ' +
        'workflow. A file the runner loads and this guard reads as empty is the ' +
        'defect this guard exists to catch.',
    );
  }

  const jobs = jobsMap.map(({ key: name, value, line }): WorkflowJob => {
    const job = mappingOf(value);
    if (job === undefined) throw new Error(`${at(line)} declares job "${name}" as something other than a mapping`);
    for (const { key, line: keyLine } of job) {
      if (!JOB_KEYS.includes(key)) {
        throw new Error(
          `${at(keyLine)} has a job key this reader does not know: "${key}". ` +
            'A key it cannot reason about may be a set of gates it cannot see.',
        );
      }
    }

    // A `uses:` whose value this reader cannot resolve to one string is refused
    // rather than skipped. `scalarOf` returns `undefined` for a mapping or a
    // sequence, and at job level that `undefined` used to be indistinguishable
    // from "this job has no uses:" — so a job with both a non-scalar `uses:` and
    // `steps:` was modelled as an ordinary job with the `uses:` dropped in
    // silence. Silence about a value it could not take apart is the failure mode
    // of every defect in the header.
    const jobUsesNode = entry(job, 'uses');
    const jobUses = scalarOf(jobUsesNode);
    if (jobUsesNode !== undefined && jobUses === undefined) {
      throw new Error(
        `${at(line)} declares job "${name}" with a "uses:" that is not one value ` +
          'this reader can resolve, so it cannot say what that job runs.',
      );
    }
    if (jobUses !== undefined) refuseUses(where, line, jobUses, readWorkflows);

    const stepsNode = entry(job, 'steps');
    if (stepsNode === undefined) {
      if (jobUses !== undefined) return { file: workflow.file, name, runsOn: '', steps: [], commands: [] };
      throw new Error(`${at(line)} declares job "${name}" with neither "steps:" nor "uses:"`);
    }
    if (stepsNode.kind !== 'sequence') {
      throw new Error(`${at(stepsNode.line)} has a "steps:" that is not a sequence this reader can walk`);
    }

    const steps = stepsNode.items.map((item): WorkflowStep => {
      const step = mappingOf(item);
      if (step === undefined) throw new Error(`${at(item.line)} is a step this reader cannot read as a mapping`);
      for (const { key, line: keyLine } of step) {
        if (!STEP_KEYS.includes(key)) {
          throw new Error(
            `${at(keyLine)} has a step key this reader does not know: "${key}". ` +
              'A key it cannot reason about may be a gate it cannot see.',
          );
        }
      }

      const run = scalarOf(entry(step, 'run'));
      const usesNode = entry(step, 'uses');
      const uses = scalarOf(usesNode);
      if (usesNode !== undefined && uses === undefined) {
        throw new Error(
          `${at(item.line)} has a "uses:" that is not one value this reader can ` +
            'resolve, so it cannot say what steps that brings in.',
        );
      }
      if (run !== undefined && uses !== undefined) {
        throw new Error(`${at(item.line)} is a step with both a "run:" and a "uses:", which the runner would reject`);
      }
      if (run === undefined && uses === undefined) {
        throw new Error(`${at(item.line)} is a step with neither a "run:" nor a "uses:", so this reader cannot say what it does`);
      }
      if (scalarOf(entry(step, 'continue-on-error')) === 'true') {
        throw new Error(
          `${at(item.line)} is a step whose failure cannot fail the job. It is ` +
            'therefore not a gate, and listing it as one would overstate what CI ' +
            'proves. Say so here before adding it.',
        );
      }
      // The shell this step actually runs under, which is its own `shell:` if it
      // has one and the workflow default otherwise — not merely the one it
      // spells out. That widening is defect nine.
      const ownShell = scalarOf(entry(step, 'shell'));
      const shell = ownShell ?? defaultShell;
      if (shell !== undefined && !SPLITTABLE_SHELLS.includes(shell)) {
        throw new Error(
          `${at(item.line)} runs under "shell: ${shell}"` +
            (ownShell === undefined ? ', set as the workflow default,' : '') +
            ' whose body is not a shell command line. This reader would split it ' +
            'on operators that mean nothing there, so it refuses instead.',
        );
      }
      if (run !== undefined && run.includes('${{')) {
        throw new Error(
          `${at(item.line)} has a "run:" whose text is a GitHub expression, so ` +
            'what it runs is not in this file and is not a command this reader ' +
            'can see. Write the command out.',
        );
      }
      if (uses !== undefined) refuseUses(where, item.line, uses, readWorkflows);
      return { line: item.line, run };
    });

    return {
      file: workflow.file,
      name,
      runsOn: scalarOf(entry(job, 'runs-on')) ?? '',
      steps,
      commands: steps.flatMap((step) =>
        step.run === undefined ? [] : shellCommands(step.run, `${at(step.line)} run:`),
      ),
    };
  });

  return { file: workflow.file, jobs };
}

/**
 * Where these bytes land when they are read as a repository path: a `/`-joined
 * path relative to the repository root, or `undefined` when they climb out of
 * it.
 *
 * `.` segments vanish, `..` pops, and a `..` with nothing left to pop is
 * `undefined` rather than a guess. This answers *which file do these bytes
 * name*, which is the question {@link refuseUses} owes and used to answer with
 * a prefix test — defect eleven.
 */
function normaliseUsesPath(target: string): string | undefined {
  const out: string[] = [];
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.pop() === undefined) return undefined;
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/**
 * Whether these bytes are a reference to an action in *another* repository —
 * `owner/repo[/path…]@ref`.
 *
 * Checked segment by segment, and the `@ref` is required. Every reference to
 * another repository carries one, which is what makes this a question about
 * what the target *is* rather than about how it is spelled:
 * `.github/actions/foo` has no `@ref`, so it cannot reach this arm however it
 * is written.
 *
 * The owner must start alphanumeric, so a first segment beginning with a dot is
 * not an owner. A segment that is empty, `.` or `..` is refused by name: those
 * are what make bytes a path, and a path is the other arm's business.
 */
function isThirdPartyAction(target: string): boolean {
  const split = target.indexOf('@');
  if (split <= 0) return false;
  const ref = target.slice(split + 1);
  if (ref === '' || ref.includes('@') || /\s/u.test(ref)) return false;
  const segments = target.slice(0, split).split('/');
  if (segments.length < 2) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(segments[0] ?? '')) return false;
  return segments
    .slice(1)
    .every((segment) => segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/u.test(segment));
}

/**
 * A `uses:` that reaches commands this reader cannot see, refused by name.
 *
 * `uses:` is how a workflow runs somebody else's steps, so the whole of this
 * function is one question: **can this reader say what the target is, and has
 * it read the steps?** It is written as a default refusal with two allow-arms,
 * and each arm now names a fact instead of a spelling. That inversion is defect
 * eleven.
 *
 * The two shapes that are allowed through:
 *
 * - `owner/repo[/path…]@ref`, an action in another repository. What it runs is
 *   out of reach on purpose, and every workflow in this directory is full of
 *   these — see {@link isThirdPartyAction}.
 * - a `./…` path that **normalises onto a file this run actually enumerated**.
 *   That is the local reusable workflow case, and the admission rests on a set
 *   membership rather than on a sentence: every member of `readWorkflows` is a
 *   file {@link readWorkflowSurface} read and handed to {@link modelOf}, so its
 *   jobs reach {@link JOBS} under their own file's name.
 *
 * A remote reusable workflow (`….yml@ref`) would match the first shape, and is
 * refused ahead of it: its jobs run as part of this CI and are in no model here.
 *
 * ### Defect eleven: the arms decided a target they had never resolved
 *
 * The previous version asked a *textual* question — "does this string start
 * with `./` or `../`, or match `.yml@`?" — in place of the real one, and so
 * classified as a harmless third-party action every target that missed all
 * three patterns. Measured on the tree that carried the fixes for seven to ten,
 * each construction twice, each **117/117 green**, while the control spelling
 * `./.github/actions/probe-composite` was red twice on that same tree:
 *
 *     - uses: ./.github/workflows/../actions/probe-composite/action.yml
 *     - uses: " ./.github/actions/probe-composite"
 *     - uses: .github/actions/probe-composite
 *
 * and, at job level, `uses: ./.github/workflows/../../shared-ci/gates.yml` with
 * `secrets: inherit` — an entire reusable workflow whose jobs contribute no
 * commands to any model here.
 *
 * It is defect eight's shape one level down. Eight was `run:` refusing an
 * unreadable value while `uses:` admitted it; eleven is `uses:` refusing one
 * spelling of a target while admitting four other spellings of the same target.
 * The old doc comment stated the admission's justification outright —
 * "enumerating the directory already read it" — and that sentence was false for
 * every input above. The fix is therefore to *check* the sentence, not to
 * soften it.
 *
 * The value arriving here is what the YAML parser resolved, so quoting, a value
 * written on the next line and a block scalar are all one string by the time
 * this is asked. Defects two, three and four are all upstream of here now.
 * Surrounding whitespace is refused rather than trimmed: whether the runner
 * trims it is not written in this file, and a single leading space is what
 * defeated the old `startsWith('./')`.
 */
function refuseUses(
  where: string,
  line: number,
  target: string,
  readWorkflows: ReadonlySet<string>,
): void {
  const at = `${where}:${String(line + 1)}`;
  if (target === '') throw new Error(`${at} has a "uses:" with no target this reader can read`);

  // Defect eleven's cheapest spelling: `uses: " ./.github/actions/probe"` is a
  // double-quoted scalar whose value keeps the leading space, which is enough to
  // defeat any prefix test. Trimming it here would be this reader deciding what
  // the runner does with the space; refusing says it does not know.
  if (target !== target.trim()) {
    throw new Error(
      `${at} has a "uses:" padded with whitespace: "${target}". Whether the ` +
        'runner trims that is not written in this file, and the two readings ' +
        'name different targets, so this reader refuses rather than pick one.',
    );
  }

  // Defect eight. `run:` has refused a GitHub expression since defect four —
  // "what it runs is not in this file" — and `uses:` did not, so the identical
  // unreadable value was refused in one key and admitted in the other. Measured
  // on this tree, twice: `uses: ${{ env.PROBE_ACTION }}` added to two steps left
  // the file 91/91 green, and the arms below decided a target they had not read.
  //
  // Whether GitHub's own parser would run that step is not the question this
  // reader gets to answer, and deliberately so: the value is not in the file, so
  // there is nothing here to read, and a reader that cannot see a value must
  // refuse rather than report that it found nothing harmless.
  if (target.includes('${{')) {
    throw new Error(
      `${at} has a "uses:" whose target is a GitHub expression: ${target}. What it ` +
        'names is not in this file, so this reader cannot tell a third-party ' +
        'action from a composite action in this repository whose own steps would ' +
        'go unread. Write the target out.',
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

  if (isThirdPartyAction(target)) return;

  // The only other thing a `uses:` may be is a reference into this repository,
  // which GitHub spells `./path/from/the/repository/root`. So: resolve the path
  // and ask the enumeration whether it read that file, instead of asking the
  // bytes what they look like. Both halves matter. Without the `./` test a
  // target that merely *resolves* onto a workflow file would be admitted as
  // local when it is not spelled as a local reference; without the set the `./`
  // test admits any path at all, which is defect eleven.
  const resolved = target.startsWith('./') ? normaliseUsesPath(target) : undefined;
  if (resolved !== undefined && readWorkflows.has(resolved)) {
    // Two facts, not one. The set says the file was read; this says the bytes
    // are the plain path to it, so a target carrying a redundant dot segment,
    // a trailing slash or a doubled separator is refused even though every one
    // of those normalises onto a file that was read. Measured on this tree,
    // twice each: all three, pointed at the real workflow, take the file down at
    // module load, while the plain path leaves it 141/141 green. The reader has
    // no way to know which reading the
    // runner takes, and the cost of asking for the plain spelling is a review
    // while the cost of guessing is a gate.
    if (target === `./${resolved}`) return;
    throw new Error(
      `${at} names "${target}", which resolves onto "${resolved}" — a file this ` +
        'run did read, but not written as the plain path to it. This reader will ' +
        'not decide which of the two readings the runner takes. Write the plain ' +
        'path.',
    );
  }

  throw new Error(
    `${at} has a "uses:" this reader cannot place: "${target}"` +
      (resolved === undefined ? '' : `, which as a path resolves to "${resolved}"`) +
      '. It is neither a well-formed owner/repo[/path]@ref nor a "./" path onto ' +
      'one of the workflow files this run enumerated, so whatever steps or jobs ' +
      'it brings in have gone unread. Teach this reader to read that target, or ' +
      'put the gate in a workflow step; do not let it go unread.',
  );
}

/** Everything in `.github/workflows/`, split into what runs and what does not. */
interface WorkflowSurface {
  /** Loadable files, relative to the directory, sorted. */
  readonly files: readonly string[];
  /** Present but with an extension the runner ignores, same form. */
  readonly ignoredFiles: readonly string[];
  readonly models: readonly WorkflowModel[];
}

/** Every file under a directory, recursively, as `/`-joined relative paths. */
function filesUnder(absolute: string, prefix: string, into: string[]): void {
  for (const item of readdirSync(absolute, { withFileTypes: true })) {
    const relative = prefix === '' ? item.name : `${prefix}/${item.name}`;
    if (item.isDirectory()) filesUnder(join(absolute, item.name), relative, into);
    else into.push(relative);
  }
}

/**
 * Read the whole directory.
 *
 * `readdirSync` throws when `repoRoot` is wrong, which is the behaviour wanted:
 * the failure that must never happen here is the one where a mis-rooted read
 * finds no workflows and every assertion above passes over an empty union.
 *
 * GitHub picks up workflows at the top level of `.github/workflows/` only; this
 * recurses, so a nested `.yml` is parsed and counted even though the runner
 * would ignore it. Over-reporting costs a review; under-reporting is the defect.
 */
function readWorkflowSurface(repoRoot: string): WorkflowSurface {
  const directory = join(repoRoot, ...WORKFLOW_DIRECTORY);
  const found: string[] = [];
  filesUnder(directory, '', found);

  const files: string[] = [];
  const ignoredFiles: string[] = [];
  for (const path of found.sort()) {
    const extension = path.slice(path.lastIndexOf('.'));
    if (LOADED_EXTENSIONS.includes(extension as (typeof LOADED_EXTENSIONS)[number])) files.push(path);
    else ignoredFiles.push(path);
  }

  // The set of files the enumeration read, in the form a `uses:` names them:
  // relative to the repository root. Built before any parse, so every file in
  // the directory is in it by the time the first `uses:` is judged, and read by
  // `refuseUses` through `modelOf`. This is the whole of the fix for defect
  // eleven at the wiring: the old allow-branch asserted that the enumeration had
  // read the target, and nothing carried the enumeration to the place that
  // asserted it.
  const readWorkflows: ReadonlySet<string> = new Set(
    files.map((file) => `${WORKFLOW_DIRECTORY.join('/')}/${file}`),
  );

  const models = files.map((file) =>
    modelOf({ file, text: readFileSync(join(directory, ...file.split('/')), 'utf8') }, readWorkflows),
  );

  return { files, ignoredFiles, models };
}

const SURFACE = readWorkflowSurface(REPO_ROOT);

/** Every job CI runs, across every workflow. */
const JOBS: readonly WorkflowJob[] = SURFACE.models.flatMap((model) => model.jobs);

/** Every simple command CI runs, across every workflow. */
/**
 * Every simple command of every job, tagged with where it runs.
 *
 * A named function because the *rule* being testable is not the same as the
 * *wiring* being testable, and that distinction was measured too: after
 * {@link swallowedGates} was extracted and given cases of its own, putting
 * defect ten straight back here — dropping `gating` on the way through, exactly
 * as the old `.map(c => c.text)` did — was still 116/116 green, twice. A rule
 * with no path from the document to its input asserts nothing about the
 * document. Its cases are in *carries the gating flag from the parsed step into
 * the command list*.
 */
function commandsOf(jobs: readonly WorkflowJob[]): WorkflowCommand[] {
  return jobs.flatMap((job) =>
    job.commands.map(
      ({ text, gating }): WorkflowCommand => ({ file: job.file, job: job.name, command: text, gating }),
    ),
  );
}

const COMMANDS: readonly WorkflowCommand[] = commandsOf(JOBS);

/* -------------------------------------------------------------------------- */
/* the verify chain                                                           */
/* -------------------------------------------------------------------------- */

/** One command `pnpm verify` runs, and the script whose body carries it. */
interface VerifyCommand {
  readonly script: string;
  readonly command: ParsedCommand;
  readonly gating: boolean;
}

/**
 * Every command reachable from a script, by **invocation** rather than by
 * mention.
 *
 * The old expander was `String.replace(/pnpm (?:run )?([\w:-]+)/g, …)` over the
 * concatenated bodies, which walks into an echoed string exactly as it walks
 * into a real command; see defect six. This follows the same edge the shell
 * follows: a *gating* simple command whose program is `pnpm` and whose script
 * name is a key in `scripts`. A name inside an argument is an argument.
 *
 * Non-gating commands are collected too, and marked. They are what lets the
 * failure message tell "you never added this gate" apart from "you added it and
 * something swallows its exit status", which want different fixes.
 */
function chainOf(script: string, scripts: Record<string, string>, seen = new Set<string>([script])): VerifyCommand[] {
  const body = scripts[script];
  if (body === undefined) return [];
  const out: VerifyCommand[] = [];
  for (const segment of shellCommands(body, `package.json scripts.${script}`)) {
    const command = parseCommand(segment.text);
    out.push({ script, command, gating: segment.gating });
    if (!segment.gating) continue;
    if (command.program !== 'pnpm') continue;
    const at = command.args[0] === 'run' ? 1 : 0;
    const name = command.args[at];
    if (name === undefined || name.startsWith('-') || !Object.hasOwn(scripts, name) || seen.has(name)) continue;
    seen.add(name);
    out.push(...chainOf(name, scripts, seen));
  }
  return out;
}

/**
 * What `pnpm verify` actually runs.
 *
 * Read by the `verify reaches the CI gate` case, once per row of
 * {@link CI_GATES}, and by nothing else.
 */
const VERIFY_CHAIN: readonly VerifyCommand[] = (() => {
  if (PACKAGE.scripts.verify === undefined) {
    throw new Error('package.json has no "verify" script, so there is no local gate to compare against CI');
  }
  return chainOf('verify', PACKAGE.scripts);
})();
