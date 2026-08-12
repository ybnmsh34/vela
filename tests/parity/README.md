# Cross-language parity fixtures

A fixture in this directory is a JSON file of **cases with their expected answers**, read from
disk by a test in *each* language. Neither implementation owns the truth; the file does. When
the Rust host and the `BrowserAdapter` disagree, the fixture is what tells you which one moved.

Why this shape rather than two hand-written test suites: `docs/architecture/conventions.md` §4
says the fake must mirror the host "*including its failure modes*", and a rule stated in prose
drifts. A rule stated as data cannot — both readers fail on the same row.

## Files

| File | Covers | Asserted by |
|---|---|---|
| `adapter-parity.json` | the whole `settings_put_provider` derivation — endpoint parsing, scope, auth binding, usability, posture, and the rejection paths | `src-tauri/tests/adapter_parity_fixture.rs`, `src/platform/adapter-parity.test.ts` |
| `security-posture.json` | `SecurityPosture::assess` alone, field by field | `src-tauri/crates/vela-settings/tests/security_posture_parity.rs`, `src/platform/security-posture-parity.test.ts` |

### Why there are two, and when there should be one

`adapter-parity.json` is the broad one and the one to add to by default. `security-posture.json`
exists because the posture fix that added `queryParamCredentialIsLogged` needed two things the
broad fixture's projection does not carry:

* the **`credentialInQueryString` boolean** — `observe()` in `adapter_parity_fixture.rs` reduces
  a `ProviderView` to a named subset of fields, and that subset does not include it;
* the **order of `concerns`** — Rust sorts by the derived `Ord` and TypeScript sorts strings, so
  the arrays only agree while the `Concern` variants stay in camelCase-alphabetical order.
  `security-posture.json` compares the array ordered, which is what pins those two sorts to each
  other.

Fold `security-posture.json` into `adapter-parity.json` and delete it the moment `observe()`
projects `credentialInQueryString`. Until then the overlap is deliberate: both files fail loudly
and by name, so this is redundancy, not the silent drift the fixtures exist to prevent.

## `security-posture.json`

```jsonc
{
  "concerns": ["credentialSentInPlaintext", ...],  // every Concern variant, in wire order
  "cases": [
    {
      "name": "unique, kebab-case",
      "why": "what this row protects — read this before deleting a row",
      "baseUrl": "https://api.example.test/v1",
      "auth": { "type": "none" | "bearerToken"
                      | "apiKeyHeader", "header": "x-api-key"
                      | "apiKeyQuery",  "param": "key" },
      "credentialPresent": bool,
      "credentialRequired": bool,
      "expect": {
        "level": "none" | "notice" | "elevated" | "high",
        "scope": "loopback" | "privateNetwork" | "publicNetwork",
        "leavesDevice": bool,
        "trafficIsPlaintext": bool,
        "credentialSentInPlaintext": bool,
        "credentialInQueryString": bool,
        "endpointIsUnauthenticated": bool,
        "concerns": [ ... ]   // exact array, sorted; order is asserted
      }
    }
  ]
}
```

`auth` is the **`AuthMode`** the user picks in the UI, not the stored binding — both languages
derive the binding themselves (`Auth::for_provider` / `bindAuth`), so the derivation is under
test too.

`expect.concerns` is compared as an ordered array on purpose. Rust sorts by the derived `Ord`
(variant declaration order) and TypeScript sorts strings lexicographically; those agree only
while the variants stay in camelCase-alphabetical order, and asserting the order here is what
catches it if they stop. `concerns` at the top level is the full variant list, so a variant
added in one language and not the other fails before any case is even evaluated.

## Adding a row

Add it to the JSON. Do not add a matching assertion to either test — both tests iterate every
row, so a new row is picked up by both languages automatically. If a row passes in one language
and fails in the other, that is the fixture doing its job: fix the implementation, not the row.

**VERIFIED-BY-FAKE.** These fixtures exercise configuration and derivation logic. No endpoint is
contacted; no claim here is evidence about a real model server.
