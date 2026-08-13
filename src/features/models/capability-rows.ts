/**
 * The capability report, turned into sentences.
 *
 * Every word a user reads about what their model can do is written here. The
 * host sends closed enums and integers; the renderer owns the prose. That split
 * is the same one `Concern` and `Cause` use, and it is what makes it impossible
 * for an endpoint to put text on Vela's screen.
 *
 * ## The rule these rows encode
 *
 * Degradation must be **explicit**. There is no "absent" row that renders as
 * blank and no capability that is simply not mentioned: every one of them says
 * either what you have or what you do not have, in the same list, in the same
 * order. A user has to be able to tell what their model can do without reading
 * documentation — and "the attach button isn't there" is not telling them.
 */

import type { ModelCapabilityReport } from '@/platform/contract';

/**
 * How loudly the row reads. Not a colour — the stylesheet decides that — but a
 * claim: what this row says about whether the affordance is offered.
 */
export type CapabilityTone = 'available' | 'emulated' | 'absent' | 'unknown';

export interface CapabilityRow {
  readonly id: string;
  readonly label: string;
  /** Short enough for a chip. */
  readonly value: string;
  /** The consequence, spelled out. `null` when the value says it all. */
  readonly detail: string | null;
  readonly tone: CapabilityTone;
}

/** Renders a token count the way a person says it: 8,192 or 128K. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1000 && tokens % 1024 === 0) return `${String(tokens / 1024)}K`;
  return tokens.toLocaleString('en-US');
}

const UNPROBED_DETAIL =
  'Nothing has been established about this model yet, so nothing is offered. Check it to find out.';

export function capabilityRows(report: ModelCapabilityReport | null): readonly CapabilityRow[] {
  const probed = report?.probed ?? false;
  const capabilities = report?.capabilities;
  const unknown = (label: string, id: string): CapabilityRow => ({
    id,
    label,
    value: 'Not established',
    detail: UNPROBED_DETAIL,
    tone: 'unknown',
  });

  const rows: CapabilityRow[] = [];

  /* -- images ------------------------------------------------------------- */
  rows.push(
    !probed
      ? unknown('Images', 'vision')
      : capabilities?.vision === true
        ? {
            id: 'vision',
            label: 'Images',
            value: 'Accepted',
            detail: 'You can attach images to a message.',
            tone: 'available',
          }
        : {
            id: 'vision',
            label: 'Images',
            value: 'Not accepted',
            detail:
              'This model takes text only, so there is no way to attach an image to it. Switch to a model that reads images if you need one.',
            tone: 'absent',
          },
  );

  /* -- tools -------------------------------------------------------------- */
  rows.push(
    !probed
      ? unknown('Tools', 'tools')
      : capabilities?.toolCalls === true
        ? {
            id: 'tools',
            label: 'Tools',
            value: 'Native',
            detail: 'The endpoint understands tool calls directly.',
            tone: 'available',
          }
        : report?.toolCallsEmulated === true
          ? {
              id: 'tools',
              label: 'Tools',
              value: 'Emulated',
              detail:
                'This endpoint has no tool calling of its own. Vela describes the tools in the prompt and reads the call back out of the reply, so a call the model gets wrong is shown to you rather than run.',
              tone: 'emulated',
            }
          : {
              id: 'tools',
              label: 'Tools',
              value: 'Unavailable',
              detail: 'Neither native nor emulated tool calling was established for this model.',
              tone: 'absent',
            },
  );

  /* -- structured output --------------------------------------------------- */
  rows.push(
    !probed
      ? unknown('Structured output', 'structuredOutput')
      : report?.structuredOutput === true
        ? {
            id: 'structuredOutput',
            label: 'Structured output',
            value: 'Available',
            detail: 'The endpoint honours a response schema.',
            tone: 'available',
          }
        : {
            id: 'structuredOutput',
            label: 'Structured output',
            value: 'Not offered',
            detail:
              'Asking this endpoint for a schema returns ordinary prose with no sign anything was ignored, so Vela does not offer it at all rather than hand you output that is quietly the wrong shape.',
            tone: 'absent',
          },
  );

  /* -- context window ------------------------------------------------------ */
  const window = report?.contextWindowTokens ?? null;
  rows.push(
    window === null
      ? {
          id: 'context',
          label: 'Context window',
          value: 'Not reported',
          detail:
            'This endpoint does not say how much it can hold, so Vela cannot warn you before a conversation outgrows it. Nothing is assumed.',
          tone: 'unknown',
        }
      : {
          id: 'context',
          label: 'Context window',
          value: `${formatTokens(window)} tokens`,
          detail:
            report?.maxOutputTokens == null
              ? null
              : `Up to ${formatTokens(report.maxOutputTokens)} of that can be the reply.`,
          tone: 'available',
        },
  );

  /* -- streaming ----------------------------------------------------------- */
  rows.push(
    !probed
      ? unknown('Streaming', 'streaming')
      : capabilities?.streaming === true
        ? {
            id: 'streaming',
            label: 'Streaming',
            value: 'Token by token',
            detail: null,
            tone: 'available',
          }
        : {
            id: 'streaming',
            label: 'Streaming',
            value: 'Whole replies',
            detail: 'The reply appears when it is finished rather than as it is written.',
            tone: 'absent',
          },
  );

  /* -- reasoning ----------------------------------------------------------- */
  if (probed && capabilities?.reasoning === true) {
    rows.push({
      id: 'reasoning',
      label: 'Thinking',
      value: 'Shown separately',
      detail: 'Reasoning is kept out of the answer and folded away.',
      tone: 'available',
    });
  }

  /* -- usage --------------------------------------------------------------- */
  if (probed && capabilities?.usageReporting !== true) {
    rows.push({
      id: 'usage',
      label: 'Token counts',
      value: 'Not reported',
      detail: 'This endpoint sends no usage figures, so any count Vela shows is its own estimate.',
      tone: 'absent',
    });
  }

  return rows;
}

/** The rows that describe something the model cannot do. */
export function degradations(rows: readonly CapabilityRow[]): readonly CapabilityRow[] {
  return rows.filter((row) => row.tone === 'absent' || row.tone === 'emulated');
}
