# mock-provider — the GATE M Part 1 capability-matrix harness

A small OpenAI-compatible HTTP server with **configurable capability profiles**.
It exists to give Vela endpoints that *cannot do what it asks*, so graceful
degradation can be asserted rather than hoped for.

This is **test infrastructure**. Nothing under `src/` or `src-tauri/` may import
it, and `no-app-import.test.ts` fails the suite if anything tries. It has no
dependencies beyond Node built-ins (vitest is used only by its own tests).

> **This harness is not a model, and its output is not evidence about any
> model.** Every byte is a deterministic function of the request. Any claim
> resting on it is **VERIFIED-BY-FAKE** — see `docs/architecture/conventions.md` §10.

---

## The matrix

| profile | tool-calling | vision | context | structured output | reasoning |
|---|---|---|---|---|---|
| `frontier` | native, valid JSON args | yes | 200 000 | `json_schema` honoured | separate `reasoning_content` field |
| `mid-local` | native, valid JSON args | **no — 400** | 32 768 | accepted, then **ignored** | inline `<think>…</think>` |
| `small-local` | **none** — 400 by default | **no — 400** | 8 192 | accepted, then **ignored** | none |
| `hostile` | **malformed / partial** | **no — 400** | 4 096 | accepted, then **ignored** | unterminated `<think>` with junk |

Two choices in that table are deliberate and worth stating, because the obvious
alternative is weaker evidence:

- **`response_format` is ignored, not rejected**, everywhere it is unsupported.
  A clean 400 is easy to handle. Silently returning prose to a caller that asked
  for JSON is the failure that actually ships, so that is the one modelled.
- **`small-local` rejects tools by default**, but
  `overrides: { unsupportedToolsBehaviour: 'ignore' }` gives the other real
  behaviour — accept the `tools` field and answer with prose anyway. Both are in
  the wild; both are tested.

### Parallel tool calls

**Offer one tool and you get one call; offer several and you get one call per
tool.** That second shape — two or more complete, valid calls in a single turn —
is the commonest tool-calling shape in the wild, and it is emitted by both
profiles with native tools (`frontier`, `mid-local`).

It is available in **both transports, carrying the same logical answer**, and
that pairing is the point:

| | streamed `delta.tool_calls[]` | non-streamed `message.tool_calls[]` |
|---|---|---|
| an element is | a *fragment* of a call | a *whole* call |
| `index` | on every fragment; the only join key | **absent — not part of this shape** |
| arguments | split across frame boundaries | complete |

GATE M Part 1 (Phase B) FINDING 1 was exactly a consumer that applied the
streaming rule to the non-streamed shape and concatenated a batch into one
call. No profile could express the shape, so the harness could not see it; the
executor had to script it by hand. `parallel-tool-calls.test.ts` now pins it,
and `13-tools-parallel.json` / `14-tools-parallel.sse` record it per profile.

`hostile` sends a **partly** broken batch: three calls, of which only the middle
one is malformed (no `id`, `type: "funktion"`, arguments truncated mid-JSON),
its indices are `0, 1, 4`, and the streamed fragments arrive **round-robin**
across all three. So a consumer that merges the batch reports one call where the
socket carried three, and the two well-formed survivors are visibly missing
rather than merely absent.

### What `hostile` actually does

- `tool_calls[].function.arguments` is truncated mid-JSON and will never parse.
- Asked for several tools at once it answers with a **partly** broken batch —
  see *Parallel tool calls* above — instead of failing every call, because a
  batch that is uniformly broken hides call loss.
- A second tool call arrives with **no `id`**, `type: "funktion"`, and `index: 7`
  — indices are non-contiguous, so anything treating them as array offsets breaks.
- In the stream, the tool *name* arrives in a delta with **no `index`**, so an
  index-keyed accumulator drops it and the call ends up nameless.
- Some SSE frames are **not valid JSON** (one truncated mid-string, one plain
  text), and one is valid JSON with `"choices": "not-an-array"`.
- `<think>` is opened, junk-filled, opened *again*, and never closed.
- **No `data: [DONE]`.** The stream just stops. A consumer that waits for the
  sentinel before finalising hangs; one that treats end-of-body as terminal does not.

---

## Endpoints

`GET /health` · `GET /props` · `GET /v1/models` · `POST /v1/chat/completions`
(streaming SSE and non-streaming). The `/v1` prefix is optional, as on llama.cpp.

`/health` and `/props` carry a `vela_mock` block. No real endpoint emits it, so a
transcript can never be mistaken for a real capture. **App code must never read it.**

### Authentication

**Off by default, on purpose.** Most local runtimes have no auth at all, and "no
API key" is a first-class valid state in Vela — so the default configuration here
is the no-auth one. Pass `apiKey` to require `Authorization: Bearer <key>`.

One rule applies either way: an `Authorization` header that is *present but
empty* (`Bearer`, `Bearer `, whitespace) is always a **401
`empty_authorization_header`**. Vela must send no header at all when it holds no
credential; this makes the mistake loud instead of silent.

---

## Programmatic use

```ts
import { startMockProvider, streamChat, accumulateToolCallDeltas } from './tests/harness/mock-provider/src/index.ts';

const mock = await startMockProvider({ profile: 'hostile' }); // ephemeral port
try {
  const stream = await streamChat(mock.url, { messages: [{ role: 'user', content: 'hi' }] });
  expect(stream.sawDone).toBe(false);
  expect(stream.unparseableFrames.length).toBeGreaterThan(0);
} finally {
  await mock.close();
}
```

`startMockProvider(options)` → `Promise<MockProviderHandle>`

| option | default | meaning |
|---|---|---|
| `profile` | required | `frontier` \| `mid-local` \| `small-local` \| `hostile` |
| `port` | `0` | `0` asks the OS for a free port |
| `host` | `127.0.0.1` | bind address |
| `seed` | fixed | base seed; combined with the request |
| `apiKey` | *(none)* | when set, a bearer token is required |
| `overrides` | `{}` | `Partial<CapabilityProfile>` — vary one axis at a time |
| `chunkDelayMs` | `0` | delay between SSE frames; tests must never sleep |
| `now` | fixed clock | supply one only if you want a moving `created` |

`MockProviderHandle`: `url`, `port`, `profile`, `requests` (every request seen,
including whether an `Authorization` header was sent), `clearRequests()`, `close()`.

Also exported: `postChat`, `streamChat`, `getJson`, `parseSseFrames`,
`accumulateToolCallDeltas`, `PROFILES`, `resolveProfile`, `ERROR_CODES`.

`accumulateToolCallDeltas` is written the **naive** way on purpose — key by
`index`, append `arguments`. It is the implementation a developer reaches for
first, and the hostile profile is meant to break it. Do not "fix" it; the tests
assert exactly how it fails.

---

## Determinism

Responses are a pure function of `(seed, profile, canonical request)`. Ids and
`created` are derived from the seed, not the clock, so **identical requests give
byte-identical responses** — across processes, ports and machines.

The canonical request deliberately excludes `stream` and `stream_options`: the
same question streamed and unstreamed returns the same words, and
`capability-matrix.test.ts` asserts it on every profile.

---

## CLI

```
pnpm mock-provider --profile hostile --port 8033
node tests/harness/mock-provider/src/cli.ts --help
```

Node 22 strips TypeScript types natively — no build step, no runner dependency.

---

## Tests and evidence

```
pnpm test:harness     # this harness only
pnpm verify           # typecheck → app vitest → harness vitest → cargo test
```

Raw transcripts for all four profiles live in
`docs/regression-baseline/mock-matrix/`, regenerated by:

```
node tests/harness/mock-provider/src/record-transcripts.ts
```

`record-transcripts.test.ts` replays every recorded request and compares it to
the committed bytes, so the evidence cannot silently go stale. If it fails,
re-record — never hand-edit a transcript.
