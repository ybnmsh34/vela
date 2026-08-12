/**
 * A minimal OpenAI-compatible client, for tests only.
 *
 * This exists so consumers of the harness do not each rewrite fetch+SSE
 * plumbing, and so the hostile profile can be *demonstrated* rather than
 * described. {@link accumulateToolCallDeltas} in particular is written the
 * naive, obvious way on purpose: it is the implementation a developer reaches
 * for first, and the hostile profile is supposed to break it. Do not "fix" it
 * — the tests assert exactly how it fails.
 */

import { parseSseFrames, type SseEvent } from './sse.ts';

export interface RequestInitLike {
  readonly apiKey?: string;
  /** Sent verbatim, including a deliberately empty value, for auth tests. */
  readonly rawAuthorization?: string;
}

function buildHeaders(init: RequestInitLike | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init?.rawAuthorization !== undefined) {
    headers['authorization'] = init.rawAuthorization;
  } else if (init?.apiKey !== undefined) {
    headers['authorization'] = `Bearer ${init.apiKey}`;
  }
  return headers;
}

export interface JsonResult {
  readonly status: number;
  readonly raw: string;
  readonly json: unknown;
}

export async function getJson(
  baseUrl: string,
  path: string,
  init?: RequestInitLike,
): Promise<JsonResult> {
  const response = await fetch(`${baseUrl}${path}`, { headers: buildHeaders(init) });
  const raw = await response.text();
  return { status: response.status, raw, json: safeParse(raw) };
}

export async function postChat(
  baseUrl: string,
  body: unknown,
  init?: RequestInitLike,
): Promise<JsonResult> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(init),
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, raw, json: safeParse(raw) };
}

export interface StreamResult {
  readonly status: number;
  readonly contentType: string;
  /** The exact bytes of the response body. What lands in a transcript. */
  readonly raw: string;
  readonly events: readonly SseEvent[];
  /** `true` when a `data: [DONE]` sentinel arrived. */
  readonly sawDone: boolean;
  /** Frames whose payload was not valid JSON. */
  readonly unparseableFrames: readonly string[];
  /** Concatenated `choices[0].delta.content` across parseable frames. */
  readonly textContent: string;
  /** Concatenated `choices[0].delta.reasoning_content`. */
  readonly reasoningContent: string;
  readonly finishReasons: readonly string[];
}

export async function streamChat(
  baseUrl: string,
  body: unknown,
  init?: RequestInitLike,
): Promise<StreamResult> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(init),
    body: JSON.stringify({ ...(body as Record<string, unknown>), stream: true }),
  });
  const raw = await response.text();
  const events = parseSseFrames(raw);

  let textContent = '';
  let reasoningContent = '';
  const finishReasons: string[] = [];
  const unparseableFrames: string[] = [];

  for (const event of events) {
    if (event.parseError !== null) {
      unparseableFrames.push(event.data);
      continue;
    }
    const delta = deltaOf(event);
    if (delta === null) {
      continue;
    }
    const content = delta['content'];
    if (typeof content === 'string') {
      textContent += content;
    }
    const reasoning = delta['reasoning_content'];
    if (typeof reasoning === 'string') {
      reasoningContent += reasoning;
    }
    const finish = choiceOf(event)?.['finish_reason'];
    if (typeof finish === 'string') {
      finishReasons.push(finish);
    }
  }

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    raw,
    events,
    sawDone: events.some((event) => event.done),
    unparseableFrames,
    textContent,
    reasoningContent,
    finishReasons,
  };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function choiceOf(event: SseEvent): Record<string, unknown> | null {
  if (!isRecord(event.json)) {
    return null;
  }
  const choices = event.json['choices'];
  if (!Array.isArray(choices)) {
    return null;
  }
  const first: unknown = choices[0];
  return isRecord(first) ? first : null;
}

function deltaOf(event: SseEvent): Record<string, unknown> | null {
  const choice = choiceOf(event);
  if (choice === null) {
    return null;
  }
  const delta = choice['delta'];
  return isRecord(delta) ? delta : null;
}

export interface AccumulatedToolCall {
  readonly index: number;
  id: string | null;
  name: string | null;
  arguments: string;
  /** `JSON.parse(arguments)` succeeded. */
  argumentsAreValidJson: boolean;
}

/**
 * The obvious tool-call accumulator: key by `delta.tool_calls[].index`, append
 * `function.arguments`, take `id`/`name` on first sight. Deliberately naive —
 * a delta with no `index` is dropped on the floor, exactly as a first-draft
 * implementation would drop it.
 */
export function accumulateToolCallDeltas(
  events: readonly SseEvent[],
): readonly AccumulatedToolCall[] {
  const byIndex = new Map<number, AccumulatedToolCall>();
  for (const event of events) {
    const delta = deltaOf(event);
    const calls = delta?.['tool_calls'];
    if (!Array.isArray(calls)) {
      continue;
    }
    for (const rawCall of calls) {
      if (!isRecord(rawCall)) {
        continue;
      }
      const index = rawCall['index'];
      if (typeof index !== 'number') {
        continue; // no key to merge on — the fragment is lost
      }
      let entry = byIndex.get(index);
      if (entry === undefined) {
        entry = { index, id: null, name: null, arguments: '', argumentsAreValidJson: false };
        byIndex.set(index, entry);
      }
      const id = rawCall['id'];
      if (typeof id === 'string' && entry.id === null) {
        entry.id = id;
      }
      const fn = rawCall['function'];
      if (isRecord(fn)) {
        const name = fn['name'];
        if (typeof name === 'string' && entry.name === null) {
          entry.name = name;
        }
        const args = fn['arguments'];
        if (typeof args === 'string') {
          entry.arguments += args;
        }
      }
    }
  }
  const out = [...byIndex.values()].sort((a, b) => a.index - b.index);
  for (const entry of out) {
    try {
      JSON.parse(entry.arguments);
      entry.argumentsAreValidJson = true;
    } catch {
      entry.argumentsAreValidJson = false;
    }
  }
  return out;
}
