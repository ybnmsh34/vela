/**
 * SSE framing, both directions.
 *
 * The encoder is deliberately dumb — it will happily emit a frame that is not
 * valid JSON, because that is one of the things the hostile profile must do.
 * The decoder is deliberately forgiving — it hands back the raw payload plus a
 * parse *attempt*, so a consumer can see exactly what arrived rather than
 * having the harness hide the damage.
 */

export const SSE_DONE_FRAME = 'data: [DONE]\n\n';

export function encodeSseData(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

/** Emits a payload verbatim, valid JSON or not. */
export function encodeSseRaw(payload: string): string {
  return `data: ${payload}\n\n`;
}

/** An SSE comment. Real servers use these as keepalives; parsers must skip them. */
export function encodeSseComment(text: string): string {
  return `: ${text}\n\n`;
}

export interface SseEvent {
  /** Everything after `data: `, concatenated across multi-line data fields. */
  readonly data: string;
  /** `JSON.parse(data)` when it worked, otherwise `null`. */
  readonly json: unknown;
  /** The parse failure message, when `data` was not valid JSON. */
  readonly parseError: string | null;
  /** `true` for the `[DONE]` sentinel. */
  readonly done: boolean;
}

/**
 * Splits a raw SSE body into events. Comment lines (`:`) and blank separators
 * are dropped, matching the EventSource spec; everything else is preserved
 * exactly, including payloads that are not JSON.
 */
export function parseSseFrames(raw: string): readonly SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of raw.split('\n\n')) {
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).replace(/^ /u, ''));
      }
    }
    if (dataLines.length === 0) {
      continue;
    }
    const data = dataLines.join('\n');
    if (data === '[DONE]') {
      events.push({ data, json: null, parseError: null, done: true });
      continue;
    }
    try {
      events.push({ data, json: JSON.parse(data) as unknown, parseError: null, done: false });
    } catch (error) {
      events.push({
        data,
        json: null,
        parseError: error instanceof Error ? error.message : String(error),
        done: false,
      });
    }
  }
  return events;
}
