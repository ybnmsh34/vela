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

## `adapter-parity.json`

Each row is one `settings_put_provider` call, driven through the **real command surface** on
both sides — `secrets_set` first when the row stores a credential, then `settings_put_provider`.
Neither half calls an internal helper: a fake that is only correct when poked from inside
teaches the UI nothing.

```jsonc
{
  "providerId": "parity",            // the id every row uses, unless it overrides it
  "displayName": "Parity fixture",
  "kind": "local",
  "credentialValue": "…",            // stored when a row sets credentialStored
  "cases": [
    {
      "id": "unique, kebab-case",
      "why": "what this row protects — read this before deleting a row",
      "input": {
        "baseUrl": "http://127.0.0.1:11434/v1",   // as typed, not as normalised
        "authMode": { "type": "none" | "bearerToken"
                            | "apiKeyHeader", "header": "X-Api-Key"
                            | "apiKeyQuery",  "param": "key" },
        "credentialStored": bool,     // is there an entry in the credential store
        "authRequirement": "notRequired" | "optional" | "required",
        "id": "…",                    // optional, only for rows that break the id
        "displayName": "…"            // optional, only for rows that break the label
      },
      "expect": {
        "accepted": true,
        "baseUrl": "…",               // the NORMALISED url echoed back to the renderer
        "auth": { … },                // the derived binding, incl. its SecretRef
        "scope": "loopback" | "privateNetwork" | "publicNetwork",
        "riskLevel": "none" | "notice" | "elevated" | "high",
        "concerns": [ … ],            // exact array, camelCase-alphabetical; order is asserted
        "leavesDevice": bool, "trafficIsPlaintext": bool,
        "credentialSentInPlaintext": bool, "endpointIsUnauthenticated": bool,
        "credentialPresent": bool,    // NOT the same as input.credentialStored
        "usable": bool,
        "credentialCheck": "satisfied" | "satisfiedWithoutCredential" | "missingRequired",
        "credentialFieldLabel": "Access token" | "API key" | null
      }
    },
    {
      "id": "reject-…",
      "input": { … },
      "expect": { "accepted": false, "invalidField": "baseUrl" }   // INVALID_PAYLOAD is asserted too
    }
  ]
}
```

Notes on the sharp edges:

* **`input.credentialStored` is not `expect.credentialPresent`.** The first says an entry exists
  in the credential store; the second is what the host *derives*. They differ whenever the auth
  mode sends nothing — a stored key for an `authMode: none` provider is not "present", and the
  endpoint is still unauthenticated.
* **`expect.baseUrl` is the normalised URL**, so IDNA, default-port removal, IPv6 compression and
  IPv4 shorthand expansion are all pinned. A fake that echoes the raw input fails here.
* **Rejection rows carry one fault each**, except the two `reject-order-*` rows, which carry two
  on purpose: the host binds auth before parsing the URL and parses the URL before validating the
  id, and those rows pin that order so both sides blame the same field.
* **Adversarial hosts are the point.** `127.evil.example`, `10.example.test`, `fdn.example.test`,
  `localhost.localdomain`, `[::ffff:127.0.0.1]`, `0.0.0.0`, `[::]`, `gpu-box.local..` — each one
  is a host a prefix/substring test classifies wrongly, and each one caught a real drift in
  `browser-adapter.ts` when the fixture first ran.

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
