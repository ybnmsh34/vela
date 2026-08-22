# `src/features/` — vertical slices

One folder per user-facing capability. A feature owns its components, its hooks, and its local
types:

```
src/features/providers/
├── ProviderList.tsx
├── ProviderList.module.css
├── ProviderList.test.tsx
├── use-providers.ts
└── types.ts            (only types nobody outside this feature needs)
```

Rules:

- A feature may import from `@/components`, `@/data`, `@/state`, `@/lib`, `@/platform`, `@/runtime`.
  `@/runtime` is the agent runtime behind `src/platform/contract-harness.ts` — a peer of `@/data`,
  not a feature. A feature reaches it for its types and its tool catalogue; it is *built* once at
  the composition root (`src/app/App.tsx`) and handed down, never constructed in a feature.
- A feature must **not** import from another feature. If two features need the same thing, it
  moves to `components/`, `data/`, `state/` or `lib/`.
- A feature must **not** import `@tauri-apps/api` — call `usePlatform()` (see
  `docs/architecture/conventions.md` §4).
- The app shell (`src/app/shell/`) must not import a feature; features are mounted into the
  content region by routing.
