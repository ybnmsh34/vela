# Vela — Phase 0 Repository Inventory

**Date:** 2026-08-12
**Branch:** `claude/new-session-tgl1ut`
**Status:** COMPLETE — with a null result.

---

## Headline finding

**The `vela` repository is empty. It contains no commits, no files, and no history.**

Phase 0 as briefed ("read and comprehend the existing `vela` repository in full") has no
subject matter. This is not a fetch failure or a shallow clone — it was verified four ways:

```
$ git log --oneline -15
fatal: your current branch 'claude/new-session-tgl1ut' does not have any commits yet

$ git ls-remote origin
(no output — zero refs on the remote)

$ git count-objects -v
count: 0
size: 0
in-pack: 0
packs: 0

$ ls -la
total 12
drwxr-xr-x 3 root root 4096 Aug 12 17:25 .
drwxr-xr-x 3 root root 4096 Aug 12 17:25 ..
drwxr-xr-x 7 root root 4096 Aug 12 18:05 .git
```

Remote is `https://github.com/ybnmsh34/vela` and it has **zero refs** — the repository was
created but never pushed to.

---

## Consequences for each Phase 0 deliverable

| Deliverable | Result |
|---|---|
| File/module tree with per-module purpose | **N/A** — no files exist |
| Dependency graph and actual tech stack | **N/A** — no manifest, no lockfile, no source |
| Every existing test + real pass/fail output | **N/A** — no test suite exists to run |
| Established architectural conventions | **N/A** — none established |
| What already works vs stubbed/partial/broken | **Nothing works; nothing is stubbed. The set is empty.** |
| Existing provider integrations / MCP / artifacts / persistence | **None present** |

## Consequences for `docs/regression-baseline/`

The regression baseline cannot be populated as briefed:

- **Current test output** — no suite exists.
- **List of working user-facing flows** — the set is empty.
- **Screenshots of every currently-working screen** — there are no screens.

The Phase 0 baseline is therefore **the empty set**, recorded here deliberately rather than
fabricated. This is a meaningful, usable result: it means the **Regression Critic has no
prior art to protect** until Phase A lands its first working flow. From that point forward
the baseline becomes live and the regression rules apply normally.

## Consequences for the HARD RULE

> "Do not break, delete, or rewrite anything that already works."

Vacuously satisfied. Nothing works yet, so nothing can be broken. The rule becomes binding
the moment Phase A produces its first passing flow.

---

## Resolved architectural decision: runtime

The brief specifies:

> Default to Tauri v2 … BUT if Phase 0 shows the repo is already committed to Electron with
> meaningful working code, STAY on Electron and record the decision.

**The conditional does not fire.** There is no existing code, therefore no Electron
commitment, therefore no working runtime to preserve.

**DECISION: Tauri v2 (Rust core + web frontend).** This is a clean greenfield choice made on
the brief's stated default and its stated rationale — small footprint, low idle RAM,
OS-keychain access, least-privilege native APIs, matching a local-first, data-sovereign
product. Recorded here as the binding architectural decision for the run.

---

## What Phase 0 actually establishes

1. This is a **greenfield build**, not a remediation or extension of existing work.
2. Every premise in the brief predicated on "existing working code" is void — there is no
   inventory to split into working-vs-stubbed, no conventions to conform to, no runtime
   commitment to honour.
3. The regression baseline starts empty and accumulates from Phase A onward.
4. Tauri v2 is settled without contest.
