import { describe, expect, it } from 'vitest';

import { MockHttpError } from './errors.ts';
import { enforceProfile, parseChatRequest } from './parse-request.ts';
import { resolveProfile } from './profiles.ts';

function expectMockError(fn: () => unknown): MockHttpError {
  try {
    fn();
  } catch (error) {
    if (error instanceof MockHttpError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a MockHttpError, none was thrown');
}

const userTurn = { messages: [{ role: 'user', content: 'hello' }] };

describe('request shape validation', () => {
  it('rejects a body that is not JSON', () => {
    const error = expectMockError(() => parseChatRequest('{not json'));
    expect(error.status).toBe(400);
    expect(error.body.error.code).toBe('invalid_json');
  });

  it('requires a non-empty messages array', () => {
    expect(expectMockError(() => parseChatRequest('{}')).body.error.param).toBe('messages');
    expect(expectMockError(() => parseChatRequest('{"messages":[]}')).body.error.param).toBe(
      'messages',
    );
  });

  it('rejects an unknown role rather than guessing one', () => {
    const error = expectMockError(() =>
      parseChatRequest(JSON.stringify({ messages: [{ role: 'wizard', content: 'x' }] })),
    );
    expect(error.body.error.message).toContain('role');
  });

  it('accepts both content shapes', () => {
    const parsed = parseChatRequest(
      JSON.stringify({
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
      }),
    );
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.imageParts).toBe(0);
  });

  it('defaults tool_choice to auto and stream to false', () => {
    const parsed = parseChatRequest(JSON.stringify(userTurn));
    expect(parsed.toolChoice).toBe('auto');
    expect(parsed.stream).toBe(false);
    expect(parsed.maxTokens).toBeNull();
    expect(parsed.responseFormat).toBeNull();
  });

  it('refuses a tool_choice that names a tool the request did not supply', () => {
    const error = expectMockError(() =>
      parseChatRequest(
        JSON.stringify({
          ...userTurn,
          tools: [{ type: 'function', function: { name: 'get_weather' } }],
          tool_choice: { type: 'function', function: { name: 'send_email' } },
        }),
      ),
    );
    expect(error.body.error.param).toBe('tool_choice');
  });

  it('accepts max_completion_tokens as an alias for max_tokens', () => {
    const parsed = parseChatRequest(JSON.stringify({ ...userTurn, max_completion_tokens: 32 }));
    expect(parsed.maxTokens).toBe(32);
  });
});

describe('capability enforcement', () => {
  it('accepts a request that names no model at all', () => {
    const profile = resolveProfile('frontier');
    expect(() => {
      enforceProfile(profile, parseChatRequest(JSON.stringify(userTurn)));
    }).not.toThrow();
  });

  it('404s a model id this endpoint does not serve', () => {
    const profile = resolveProfile('frontier');
    const error = expectMockError(() => {
      enforceProfile(profile, parseChatRequest(JSON.stringify({ ...userTurn, model: 'gpt-4o' })));
    });
    expect(error.status).toBe(404);
    expect(error.body.error.code).toBe('model_not_found');
  });

  it('applies capability checks in a fixed order, so transcripts are reproducible', () => {
    // A request that violates vision, tools AND context at once always reports
    // the vision failure first.
    const profile = resolveProfile('small-local');
    const request = parseChatRequest(
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'x'.repeat(100_000) },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
            ],
          },
        ],
        tools: [{ type: 'function', function: { name: 'noop' } }],
      }),
    );
    const error = expectMockError(() => {
      enforceProfile(profile, request);
    });
    expect(error.body.error.code).toBe('vision_not_supported');
  });

  it('counts the requested completion against the context window', () => {
    const profile = resolveProfile('small-local'); // 8192
    const request = parseChatRequest(
      JSON.stringify({ ...userTurn, max_tokens: profile.contextWindow }),
    );
    const error = expectMockError(() => {
      enforceProfile(profile, request);
    });
    expect(error.body.error.code).toBe('context_length_exceeded');
    expect(error.body.error.message).toContain('8192');
  });
});
