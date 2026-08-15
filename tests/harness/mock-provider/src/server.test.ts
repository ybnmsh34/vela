import { afterEach, describe, expect, it } from 'vitest';

import { getJson, postChat } from './client.ts';
import { PROFILE_NAMES } from './profiles.ts';
import { startMockProvider, type MockProviderHandle } from './server.ts';

const running: MockProviderHandle[] = [];

async function start(
  options: Parameters<typeof startMockProvider>[0],
): Promise<MockProviderHandle> {
  const handle = await startMockProvider(options);
  running.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((handle) => handle.close()));
});

const ask = { messages: [{ role: 'user', content: 'hello' }] };

describe('the server surface', () => {
  it('binds an ephemeral port by default and reports it', async () => {
    const mock = await start({ profile: 'frontier' });
    expect(mock.port).toBeGreaterThan(0);
    expect(mock.url).toBe(`http://127.0.0.1:${String(mock.port)}`);
  });

  it('runs two servers on different ports at once', async () => {
    const a = await start({ profile: 'frontier' });
    const b = await start({ profile: 'hostile' });
    expect(a.port).not.toBe(b.port);
  });

  it('releases the port on close', async () => {
    const mock = await startMockProvider({ profile: 'frontier' });
    const { url } = mock;
    await mock.close();
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });

  it('serves /health, /props and /v1/models on every profile', async () => {
    for (const name of PROFILE_NAMES) {
      const mock = await start({ profile: name });

      const health = await getJson(mock.url, '/health');
      expect(health.status).toBe(200);
      expect((health.json as { status: string }).status).toBe('ok');

      const props = await getJson(mock.url, '/props');
      expect(props.status).toBe(200);
      expect(
        (props.json as { default_generation_settings: { n_ctx: number } })
          .default_generation_settings.n_ctx,
      ).toBe(mock.profile.contextWindow);

      const models = await getJson(mock.url, '/v1/models');
      expect(models.status).toBe(200);
      expect((models.json as { data: { id: string }[] }).data.map((m) => m.id)).toEqual([
        mock.profile.modelId,
      ]);
    }
  });

  it('accepts the /v1 prefix as optional, like llama.cpp', async () => {
    const mock = await start({ profile: 'frontier' });
    const withPrefix = await getJson(mock.url, '/v1/models');
    const withoutPrefix = await getJson(mock.url, '/models');
    expect(withoutPrefix.status).toBe(200);
    expect(withoutPrefix.raw).toBe(withPrefix.raw);
  });

  it('404s an unknown route with an OpenAI-shaped error', async () => {
    const mock = await start({ profile: 'frontier' });
    const response = await getJson(mock.url, '/v1/embeddings');
    expect(response.status).toBe(404);
    expect((response.json as { error: { code: string } }).error.code).toBe('unknown_url');
  });

  it('405s the wrong method rather than pretending it worked', async () => {
    const mock = await start({ profile: 'frontier' });
    const response = await fetch(`${mock.url}/v1/chat/completions`, { method: 'GET' });
    expect(response.status).toBe(405);
  });

  it('404s /v1/models when the endpoint cannot enumerate models', async () => {
    // Not an error state for the user: the UI is expected to fall back to
    // free-text model entry.
    const mock = await start({ profile: 'frontier', overrides: { modelListing: false } });
    const response = await getJson(mock.url, '/v1/models');
    expect(response.status).toBe(404);
    expect((response.json as { error: { code: string } }).error.code).toBe(
      'model_listing_not_supported',
    );
    // …while chat still works.
    expect((await postChat(mock.url, ask)).status).toBe(200);
  });

  it('records every request it saw, including the absent Authorization header', async () => {
    const mock = await start({ profile: 'frontier' });
    await getJson(mock.url, '/health');
    await postChat(mock.url, ask);

    expect(mock.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /health',
      'POST /v1/chat/completions',
    ]);
    expect(mock.requests.every((r) => r.authorization === undefined)).toBe(true);
    mock.clearRequests();
    expect(mock.requests).toHaveLength(0);
  });
});

describe('authentication — "no API key" is a first-class state', () => {
  it('serves every endpoint with no credential at all, by default', async () => {
    for (const name of PROFILE_NAMES) {
      const mock = await start({ profile: name });
      expect((await getJson(mock.url, '/health')).status).toBe(200);
      expect((await getJson(mock.url, '/v1/models')).status).toBe(200);
      expect((await postChat(mock.url, ask)).status).toBe(200);
      expect(mock.requests.every((r) => r.authorization === undefined)).toBe(true);
    }
  });

  it('rejects a present-but-empty Authorization header, even with auth off', async () => {
    // Vela must send NO header when it holds no credential. An empty bearer is
    // a bug, and this makes it loud instead of silent.
    const mock = await start({ profile: 'frontier' });
    for (const header of ['Bearer ', 'Bearer', '  ']) {
      const response = await postChat(mock.url, ask, { rawAuthorization: header });
      expect(response.status).toBe(401);
      expect((response.json as { error: { code: string } }).error.code).toBe(
        'empty_authorization_header',
      );
    }
  });

  it('requires the bearer token when one is configured', async () => {
    const mock = await start({ profile: 'frontier', apiKey: 'sk-test-123' });

    expect((await postChat(mock.url, ask)).status).toBe(401);
    expect((await postChat(mock.url, ask, { apiKey: 'wrong' })).status).toBe(401);

    const ok = await postChat(mock.url, ask, { apiKey: 'sk-test-123' });
    expect(ok.status).toBe(200);
  });
});

describe('a request body over the 8 MiB cap', () => {
  const MAX_BODY_BYTES = 8 * 1024 * 1024;
  const OVERSIZE_DRAIN_BYTES = 8 * 1024 * 1024;

  /** A syntactically valid chat request whose serialised form is `bytes` long. */
  function bodyOfSize(bytes: number): string {
    const envelope = JSON.stringify({ messages: [{ role: 'user', content: '' }] });
    return envelope.replace('""', `"${'x'.repeat(bytes - envelope.length)}"`);
  }

  async function post(
    url: string,
    body: string,
  ): Promise<{ status: number; raw: string; connection: string | null }> {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      // undici would otherwise keep the pooled socket open past the test.
      keepalive: false,
    });
    return {
      status: response.status,
      raw: await response.text(),
      connection: response.headers.get('connection'),
    };
  }

  it('answers 413 with the documented invalid_json code — not a connection reset', async () => {
    // REGRESSION (GATE M Part 1, EDGE-PROBES probe 1): this used to produce no
    // HTTP response at all. readBody() destroyed the socket in the same turn it
    // rejected, so the client saw `ECONNRESET`, zero bytes, and the 413 branch
    // was unreachable dead code.
    const mock = await start({ profile: 'hostile' });
    const oversized = bodyOfSize(9 * 1024 * 1024);
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(MAX_BODY_BYTES);

    const response = await post(mock.url, oversized);

    expect(response.status).toBe(413);
    expect(JSON.parse(response.raw)).toEqual({
      error: {
        message: 'request body too large',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_json',
      },
    });
  });

  it('still answers a body that reaches the drain cap, then closes the connection', async () => {
    // Past MAX + DRAIN the server stops reading. It must still deliver the
    // response before the socket goes away.
    //
    // WINDOWS. This is the case the sibling test above does not reach, and it
    // failed here — `TypeError: fetch failed / read ECONNRESET`, zero response
    // bytes — for the whole life of this file, on the platform Vela ships on.
    // The cause was in the server, not here: it closed the socket abortively
    // (`request.destroy()`) with the client's refused upload still unread, TCP
    // answered that with RST, and RST makes the peer throw away a response it
    // had already received. Linux usually lost that race slowly enough for the
    // client to read the bytes first, so CI never saw it. The expectation below
    // is therefore left exactly as it was — it was right, and asserting only
    // "413 or a reset" would have made the platform bug permanent. See
    // `sendBodyTooLarge` in server.ts for the measurements and the fix.
    const mock = await start({ profile: 'hostile' });
    const enormous = bodyOfSize(MAX_BODY_BYTES + OVERSIZE_DRAIN_BYTES + 1024 * 1024);

    const response = await post(mock.url, enormous);

    expect(response.status).toBe(413);
    expect((JSON.parse(response.raw) as { error: { code: string } }).error.code).toBe(
      'invalid_json',
    );
    // The connection is being closed rather than reused, and the client is told
    // so in the response instead of finding out from a reset. Pins the
    // hand-written header block that the half-close fix introduced.
    expect(response.connection).toBe('close');
  });

  it('leaves the server serving afterwards', async () => {
    const mock = await start({ profile: 'hostile' });
    await post(mock.url, bodyOfSize(9 * 1024 * 1024));

    expect((await getJson(mock.url, '/health')).status).toBe(200);
    expect((await postChat(mock.url, ask)).status).toBe(200);
  });

  it('leaves a body under the cap answered exactly as before', async () => {
    // The fix must be invisible everywhere except over the cap. 7 MiB is the
    // byte class the edge probe used as its control: it overflows the hostile
    // profile's 4k context and so answers 400 context_length_exceeded.
    const mock = await start({ profile: 'hostile' });
    const under = bodyOfSize(7 * 1024 * 1024);
    expect(Buffer.byteLength(under)).toBeLessThan(MAX_BODY_BYTES);

    const response = await post(mock.url, under);

    expect(response.status).toBe(400);
    expect((JSON.parse(response.raw) as { error: { code: string } }).error.code).toBe(
      'context_length_exceeded',
    );
  });
});

describe('determinism', () => {
  it('answers identical requests with byte-identical bodies', async () => {
    const mock = await start({ profile: 'frontier' });
    const first = await postChat(mock.url, ask);
    const second = await postChat(mock.url, ask);
    expect(second.raw).toBe(first.raw);
  });

  it('is stable across separate server instances and ports', async () => {
    const a = await start({ profile: 'hostile' });
    const b = await start({ profile: 'hostile' });
    const fromA = await postChat(a.url, ask);
    const fromB = await postChat(b.url, ask);
    expect(fromB.raw).toBe(fromA.raw);
  });

  it('changes output when the base seed changes', async () => {
    const a = await start({ profile: 'frontier', seed: 1 });
    const b = await start({ profile: 'frontier', seed: 2 });
    expect((await postChat(b.url, ask)).raw).not.toBe((await postChat(a.url, ask)).raw);
  });
});
