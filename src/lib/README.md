# `src/lib/` — pure helpers

Dependency-free utility functions: formatting, parsing, small algorithms.

- No React, no IPC, no DOM unless the helper is explicitly a DOM helper.
- No imports from `features/`, `data/` or `state/`. `lib/` sits at the bottom of the graph.
- Every helper gets a colocated `*.test.ts`. These are the cheapest tests in the repo; there
  is no excuse for an untested helper.
