# The local endpoint

Vela can serve one of the endpoints you have configured back out over HTTP, on a port of your
own machine, so that other tools can send turns through Vela to the same model. One port answers
**two wire formats** — the Anthropic Messages API and the OpenAI Chat Completions API — routed by
path, under one shared key.

It is **off unless you turn it on**, at every launch, and turning it on is a decision with a
security consequence. Read [Gotchas](#gotchas) before you point anything at it; every entry there
is a thing that will otherwise cost you an afternoon.

---

## Turn it on

### From the window

Open **Endpoints** (the model bar's menu), scroll to **Local endpoint**, and fill in three things:

| Field | What to put in it |
|---|---|
| **Listen on** | `127.0.0.1:8034`. An IP address and a port — not a hostname (see gotcha 3). |
| **Key callers must send** | Invent one. Vela will not open the port without a key. |
| **Which endpoint to serve** | One of the endpoints listed above the section. |

Press **Enable**. The section then reports the address that was actually bound, which endpoint is
answering, and what the tool policy resolved to — for a loopback address, *"Tools on — only this
machine can reach the port."* **Disable** closes the port; the panel and the port agree, and both
change immediately, with no restart.

Nothing here is remembered. Close Vela and the endpoint is off again, and the key is gone — it is
held in the running process and is never written to disk or to the keychain. That is a deliberate
limitation and not an oversight; see [What is not built](#what-is-not-built).

### From the environment, at startup

The same thing, decided before the window appears. Useful for a machine that should come up
serving. **These five variables are read once, at startup, and never again** — changing one while
Vela is running does nothing, and the settings surface above is what you want instead.

| Variable | Required | Value |
|---|---|---|
| `VELA_LOCAL_ENDPOINT` | yes | `host:port` to bind, e.g. `127.0.0.1:8034`. Unset or empty means **no listener at all**. |
| `VELA_LOCAL_ENDPOINT_KEY` | yes | The bearer key callers must present. Missing is a refusal, not a fallback. |
| `VELA_LOCAL_ENDPOINT_PROVIDER` | yes | The id of one of your configured endpoints. Missing is a refusal — Vela will not pick one for you. |
| `VELA_LOCAL_ENDPOINT_TOOLS` | no | Exactly `on` or `off`. **Anything else, including a typo, means "not set"** and lets the bind address decide. |
| `VELA_LOCAL_ENDPOINT_TOOLS_CONFIRM` | no | `yes`. Only consulted with `..._TOOLS=on` on a non-loopback bind; see gotcha 4. |

```powershell
$env:VELA_LOCAL_ENDPOINT          = '127.0.0.1:8034'
$env:VELA_LOCAL_ENDPOINT_KEY      = 'sk-vela-something-you-invented'
$env:VELA_LOCAL_ENDPOINT_PROVIDER = 'study-box'
```

Vela prints one line to stderr at startup saying what it did — `vela: local endpoint on
127.0.0.1:8034 (tools on, loopback-default)`, or `vela: local endpoint not started (no-key)`, or
`vela: local endpoint off`. If the endpoint is not doing what you expected, that line says why.

---

## Point something at it

**The two base URLs are different, and the difference is not a typo.**

| Client speaks | Base URL |
|---|---|
| Anthropic Messages API | `http://127.0.0.1:8034` — the bare origin, **no** `/v1` |
| OpenAI Chat Completions API | `http://127.0.0.1:8034/v1` — origin **plus** `/v1` |

The asymmetry is the SDKs', not Vela's: the Anthropic SDK appends the whole path itself, and the
OpenAI SDK does not append `/v1`. Get it wrong in either direction and you get a `404` from a
server that is running perfectly.

Both take the same key, in the same header:

```
Authorization: Bearer <your key>
```

### Check it with curl

```
$ curl -sS -i -H "Authorization: Bearer sk-vela-doc-key" http://127.0.0.1:8034/v1/models
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 105
Connection: close

{"data":[{"created":1786832143,"id":"fixture-model","object":"model","owned_by":"vela"}],"object":"list"}
```

`GET /v1/models` is the first call most OpenAI-compatible clients make. An **empty** `data` list is
not a failure: it means the endpoint you are serving cannot enumerate its models, which is a normal
state. You can still name a model in a turn.

A turn, in the Anthropic dialect (note the path — no `/v1` prefix is added by you, because the
suffix is already in the path here):

```
$ curl -sS -H "Authorization: Bearer sk-vela-doc-key" -H "Content-Type: application/json" \
       -d '{"model":"fixture-model","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}' \
       http://127.0.0.1:8034/v1/messages
{"content":[…],"id":"msg_…","model":"fixture-model","role":"assistant","stop_reason":"end_turn",…}
```

Four paths are served, and nothing else:

| Path | Method | |
|---|---|---|
| `/v1/messages` | POST | Anthropic dialect |
| `/v1/chat/completions` | POST | OpenAI dialect |
| `/v1/models` | GET | OpenAI shape, both dialects' clients use it |
| `/v1/responses` | POST | **Routed and deliberately not implemented** — answers `501`. It is routed rather than 404'd so that a `404` still means "your base URL is wrong". |

Streaming works on both turn paths (`"stream": true`). There is **no TLS**, which is correct for
loopback and is a stated limitation anywhere else. There is **no keep-alive**: one request per
connection, on purpose.

---

## Gotchas

These are the four that will actually bite you.

### 1. `x-api-key` is not accepted. It must be `Authorization: Bearer`.

This is the one that costs the most time, because the failure looks like a wrong key rather than a
wrong header. A stock Anthropic SDK client configured with `ANTHROPIC_API_KEY` sends `x-api-key`,
and Vela's endpoint does not accept that header at all — one credential header is documented, and a
second way in is a second thing to get wrong.

Configure the client with an **auth token**, not an API key:

```powershell
$env:ANTHROPIC_BASE_URL  = 'http://127.0.0.1:8034'
$env:ANTHROPIC_AUTH_TOKEN = 'sk-vela-doc-key'
$env:ANTHROPIC_API_KEY   = ''          # must be empty, or the SDK sends x-api-key
```

What you see if you get this wrong is a `401` whose body says
`a valid Authorization: Bearer key is required` — and, measured with `curl` on Windows, sometimes
not even that: the connection is closed fast enough that curl reports
`curl: (56) Recv failure: Connection was aborted` and never shows you the body. Either way it is
not a wrong key.

The same `401`, with the same words, is returned for a **missing** key, a **wrong** key and a
**non-bearer** scheme. That is deliberate: a caller that could tell those apart has been handed an
oracle.

### 2. Binding anything other than loopback turns tools off.

The bind address decides whether the model may be offered tools:

| Bound address | Tools | Reported as |
|---|---|---|
| `127.0.0.0/8`, `[::1]` | **on** | `loopback-default` |
| `0.0.0.0`, `[::]`, or any real interface address | **off** | `exposed-default` |

`0.0.0.0` is **not** loopback — it binds every interface the machine has. A leaked key on a
network-exposed server that can run tools is arbitrary code execution on your machine, so the
default fails closed.

Forcing tools on such an address needs a second, explicit statement — the checkbox in the settings
section, or `VELA_LOCAL_ENDPOINT_TOOLS_CONFIRM=yes`. Without it, `..._TOOLS=on` on an exposed bind
resolves to **tools off**, reported as `exposed-enable-unconfirmed`. This is the state that
surprises people: they asked for tools, and got none.

The policy is resolved from **the address the listener actually bound**, not the one you typed, and
it is re-resolved on every change. Rebinding from `127.0.0.1` to `0.0.0.0` in a running Vela
therefore turns tools off; the previous answer is never carried forward.

`enable_tools: true` in a request body cannot bypass any of this. There is no code path from that
field to the decision.

### 3. The address is an IP and a port. `localhost:8034` will not parse.

`127.0.0.1:8034` and `[::1]:8034` are addresses; `localhost:8034` is a name, and Vela refuses it
rather than resolving it, because which address a name resolves to is exactly what the tool policy
above depends on. Port `0` is legal and means "let the operating system choose" — the settings
section then reports the port you actually got.

### 4. There is no `/v1` on the Anthropic base URL, and there must be one on the OpenAI base URL.

Repeated here because it is the second most common way to get a `404` from a working server. See
[Point something at it](#point-something-at-it).

---

## What is not built

**Nothing is persisted.** A configuration entered in the settings section lives in the running
process: close Vela and the endpoint is off, with no key stored anywhere. Making it survive a
restart needs a settings row for the address, the endpoint id and the tool flag — and, the part
that is a decision rather than a schema, somewhere for the bearer key to live. `secrets_set` files
credentials in the OS keychain under an *endpoint* id, so the local endpoint would need its own
namespace there; putting the key in the database in plaintext is not an option. Until that is
decided, "off at every launch unless the environment says otherwise" is the honest default, and the
environment path above is what a machine that should come up serving uses.

**Vela does not tell you the base URLs in the window.** The settings section reports the bound
address; the `/v1` asymmetry above is documentation, because the renderer deliberately holds no
vocabulary for which wire formats exist.

---

## Where this lives in the source

| | |
|---|---|
| The listener, the router, both dialects | `src-tauri/crates/vela-endpoint/` |
| The bind-address tool policy | `src-tauri/crates/vela-endpoint/src/policy.rs` |
| Start/stop/rebind, and the startup environment path | `src-tauri/src/endpoint_host.rs` |
| The three IPC commands | `src-tauri/src/ipc/endpoint.rs` |
| The settings section | `src/features/models/LocalEndpointSection.tsx` |
| Socket-probe evidence that the port opens and closes | `src-tauri/tests/endpoint_runtime_control.rs` |
