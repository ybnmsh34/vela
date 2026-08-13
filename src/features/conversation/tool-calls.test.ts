/**
 * The tool-call view model, driven by shapes that were **measured**, not
 * imagined.
 *
 * The fixtures below are transcribed from the Phase B gate evidence in
 * `docs/regression-baseline/phase-b-matrix/`, which drove Vela's own provider
 * stack against the mock harness over real TCP:
 *
 *  - `hostile/02p-parallel-tool-calls.txt` — a batch of three, of which the
 *    middle one is broken: `MALFORMED index=Some(1) id=MISSING name=get_time
 *    reason=UnknownDiscriminator raw="{\"timezone\":\""`. Both transports agree
 *    call by call, and the two good calls stay executable. If this list renders
 *    as two cards, or as one, the surface has lost what the core kept.
 *  - `small-local/02-tool-calling.txt` — `OK id=call_emulated_0 name=echo_tool
 *    emulated=true args={"text":"ok"}` with `ToolCallingEmulated { tool_count: 1 }`.
 *
 * VERIFIED-BY-FAKE: those runs met a deterministic mock, never a model. What is
 * verified here is narrower still — that given those shapes, this file derives
 * the right presentation.
 */

import { describe, expect, it } from 'vitest';

import type { ContentPart, MalformedToolCallReason, ToolCallOutcome } from '@/platform/contract';

import {
  buildToolCallViews,
  collectToolResults,
  emulationSentence,
  formatArguments,
  isLive,
  previewArguments,
  statusLabel,
  summariseToolCalls,
  type ToolCallStatus,
} from './tool-calls';

/** The hostile profile's parallel batch, exactly as the gate recorded it. */
const HOSTILE_BATCH: readonly ToolCallOutcome[] = [
  {
    status: 'ok',
    callId: 'call_36cb7766',
    name: 'get_weather',
    arguments: { city: 'alpha' },
    emulated: false,
  },
  {
    status: 'malformed',
    index: 1,
    callId: null,
    name: 'get_time',
    rawArguments: '{"timezone":"',
    reason: 'unknownDiscriminator',
  },
  {
    status: 'ok',
    callId: 'call_36cb7766_2',
    name: 'get_quote',
    arguments: { ticker: 'eastward' },
    emulated: false,
  },
];

/** The small-local profile's emulated call. */
const EMULATED_CALL: ToolCallOutcome = {
  status: 'ok',
  callId: 'call_emulated_0',
  name: 'echo_tool',
  arguments: { text: 'ok' },
  emulated: true,
};

const ALL_REASONS: readonly MalformedToolCallReason[] = [
  'missingName',
  'unparseableArguments',
  'argumentsNotAnObject',
  'unknownDiscriminator',
  'recoveredFromUnterminatedReasoning',
];

const ALL_STATUSES: readonly ToolCallStatus[] = [
  'arriving',
  'running',
  'succeeded',
  'failed',
  'awaitingResult',
  'unreadable',
  'notCommitted',
];

describe('a batch of parallel calls', () => {
  it('keeps every call in the measured hostile batch, in order, distinctly', () => {
    const views = buildToolCallViews({ outcomes: HOSTILE_BATCH, progress: [] });

    expect(views).toHaveLength(3);
    expect(views.map((view) => view.title)).toEqual(['get_weather', 'get_time', 'get_quote']);
    expect(views.map((view) => view.status)).toEqual([
      'awaitingResult',
      'unreadable',
      'awaitingResult',
    ]);
    // Distinct keys, or React folds two cards into one and the batch shrinks.
    expect(new Set(views.map((view) => view.key)).size).toBe(3);
  });

  it('never repairs, re-prints or splices the broken call in the middle', () => {
    const [, broken] = buildToolCallViews({ outcomes: HOSTILE_BATCH, progress: [] });

    expect(broken?.args).toEqual({ kind: 'raw', text: '{"timezone":"' });
    expect(broken?.problem).toBe(
      'Vela could not read this call: the call was tagged as something other than a function. It was not run.',
    );
    // The neighbours' arguments are nowhere near it.
    expect(broken?.args.kind === 'raw' ? broken.args.text : '').not.toContain('alpha');
    expect(broken?.args.kind === 'raw' ? broken.args.text : '').not.toContain('eastward');
  });

  it('summarises the batch and says how much of it was unreadable', () => {
    expect(summariseToolCalls(buildToolCallViews({ outcomes: HOSTILE_BATCH, progress: [] }))).toBe(
      '3 tool calls · 1 could not be read',
    );
    expect(
      summariseToolCalls(buildToolCallViews({ outcomes: [EMULATED_CALL], progress: [] })),
    ).toBe('1 tool call');
  });

  it('keeps the correlation ids that make a batch un-mixable', () => {
    const views = buildToolCallViews({ outcomes: HOSTILE_BATCH, progress: [] });
    expect(views.map((view) => view.callId)).toEqual(['call_36cb7766', null, 'call_36cb7766_2']);
  });
});

describe('the malformed case', () => {
  it('produces a view for every reason the contract can carry', () => {
    for (const reason of ALL_REASONS) {
      const [view] = buildToolCallViews({
        outcomes: [
          { status: 'malformed', index: null, callId: null, name: null, rawArguments: '{', reason },
        ],
        progress: [],
      });
      expect(view, `${reason} rendered as nothing`).toBeDefined();
      expect(view?.problem).not.toBeNull();
      expect(view?.title).toBe('Unnamed tool call');
      expect(view?.args).toEqual({ kind: 'raw', text: '{' });
    }
  });

  it('still renders a call that arrived with no name and no arguments at all', () => {
    // The `missingName` shape from the hostile profile: a fragment with a name
    // and nothing else, or an id and nothing else. Neither may vanish.
    const [view] = buildToolCallViews({
      outcomes: [
        {
          status: 'malformed',
          index: null,
          callId: null,
          name: null,
          rawArguments: '',
          reason: 'missingName',
        },
      ],
      progress: [],
    });

    expect(view?.status).toBe('unreadable');
    expect(view?.args).toEqual({ kind: 'none' });
    expect(view?.problem).toContain('no tool name ever arrived');
  });

  it('does not call a well-formed rescued call unreadable', () => {
    // `recoveredFromUnterminatedReasoning` parsed perfectly; the core refused it
    // because the model was still thinking. Calling that "could not be read"
    // would be a lie in the user's favour, which is still a lie.
    const [view] = buildToolCallViews({
      outcomes: [
        {
          status: 'malformed',
          index: null,
          callId: null,
          name: 'get_weather',
          rawArguments: '{"city":"alpha"}',
          reason: 'recoveredFromUnterminatedReasoning',
        },
      ],
      progress: [],
    });

    expect(view?.status).toBe('notCommitted');
    expect(statusLabel('notCommitted')).toBe('Not sent');
    expect(view?.problem).toContain('never closed');
  });

  it('counts only the unreadable ones as unreadable in the summary', () => {
    const views = buildToolCallViews({
      outcomes: [
        {
          status: 'malformed',
          index: null,
          callId: null,
          name: null,
          rawArguments: '{',
          reason: 'recoveredFromUnterminatedReasoning',
        },
      ],
      progress: [],
    });
    expect(summariseToolCalls(views)).toBe('1 tool call');
  });
});

describe('emulated tool calling', () => {
  it('marks the measured small-local call as emulated and says so once', () => {
    const views = buildToolCallViews({ outcomes: [EMULATED_CALL], progress: [] });

    expect(views[0]?.emulated).toBe(true);
    expect(emulationSentence(views)).toBe(
      'This model has no built-in tool calling. Vela described the tools in the prompt and read the call back out of the reply.',
    );
  });

  it('says nothing when the endpoint called the tool natively', () => {
    expect(emulationSentence(buildToolCallViews({ outcomes: HOSTILE_BATCH, progress: [] }))).toBeNull();
  });

  it('names no backend anywhere in what it says', () => {
    const said = [
      emulationSentence(buildToolCallViews({ outcomes: [EMULATED_CALL], progress: [] })) ?? '',
      ...ALL_STATUSES.map(statusLabel),
      ...ALL_REASONS.map((reason) =>
        buildToolCallViews({
          outcomes: [
            { status: 'malformed', index: null, callId: null, name: null, rawArguments: '', reason },
          ],
          progress: [],
        })[0]?.problem ?? '',
      ),
    ].join(' ');

    expect(said).not.toMatch(/ollama|llama|lm ?studio|vllm|openai|anthropic|gemini|claude|gpt/i);
  });
});

describe('a call while it is still arriving', () => {
  it('shows the fragments it has, keyed by the host slot and never by position', () => {
    const views = buildToolCallViews({
      outcomes: [],
      // The hostile profile jumps index 0 → 7 and re-orders fragments; the host
      // hands over slots, and slot order is the order to draw.
      progress: [
        { slot: 1, callId: null, name: 'get_time', argumentsText: '{"timezone":' },
        { slot: 0, callId: 'call_36cb7766', name: 'get_weather', argumentsText: '{"city":"al' },
      ],
    });

    expect(views.map((view) => view.title)).toEqual(['get_weather', 'get_time']);
    expect(views.map((view) => view.status)).toEqual(['arriving', 'arriving']);
    expect(views.map((view) => view.key)).toEqual(['slot-0', 'slot-1']);
    expect(views[0]?.args).toEqual({ kind: 'raw', text: '{"city":"al' });
  });

  it('shows a nameless fragment rather than waiting for a name', () => {
    const [view] = buildToolCallViews({
      outcomes: [],
      progress: [{ slot: 0, callId: null, name: null, argumentsText: '' }],
    });
    expect(view?.title).toBe('Tool call');
    expect(view?.args).toEqual({ kind: 'none' });
  });

  it('never previews a half-arrived argument string', () => {
    const [view] = buildToolCallViews({
      outcomes: [],
      progress: [{ slot: 0, callId: null, name: 'get_weather', argumentsText: '{"city":"al' }],
    });
    // A prefix of JSON read as a summary is a summary that is wrong for as long
    // as it is on screen.
    expect(view?.preview).toBeNull();
  });

  it('drops the fragments the moment the settled outcomes arrive', () => {
    const views = buildToolCallViews({
      outcomes: HOSTILE_BATCH,
      progress: [
        { slot: 0, callId: 'call_36cb7766', name: 'get_weather', argumentsText: '{"city":"al' },
      ],
    });
    expect(views).toHaveLength(3);
    expect(views.every((view) => view.status !== 'arriving')).toBe(true);
  });
});

describe('results', () => {
  it('pairs a result with its call by correlation id, not by position', () => {
    const views = buildToolCallViews({
      outcomes: HOSTILE_BATCH,
      progress: [],
      results: [{ callId: 'call_36cb7766_2', content: '41.20', isError: false }],
    });

    expect(views.map((view) => view.status)).toEqual([
      'awaitingResult',
      'unreadable',
      'succeeded',
    ]);
    expect(views[2]?.result?.content).toBe('41.20');
  });

  it('reads a failing result as failed, and shows what it said', () => {
    const [view] = buildToolCallViews({
      outcomes: [EMULATED_CALL],
      progress: [],
      results: [{ callId: 'call_emulated_0', content: 'ENOENT', isError: true }],
    });
    expect(view?.status).toBe('failed');
    expect(view?.result).toEqual({ callId: 'call_emulated_0', content: 'ENOENT', isError: true });
  });

  it('says running only for a call something is actually running', () => {
    const views = buildToolCallViews({
      outcomes: HOSTILE_BATCH,
      progress: [],
      running: ['call_36cb7766'],
    });
    expect(views[0]?.status).toBe('running');
    expect(views[2]?.status).toBe('awaitingResult');
    expect(isLive('running')).toBe(true);
    expect(isLive('awaitingResult')).toBe(false);
  });

  it('lets a result that has come back outrank a stale running flag', () => {
    const [view] = buildToolCallViews({
      outcomes: [EMULATED_CALL],
      progress: [],
      results: [{ callId: 'call_emulated_0', content: 'ok', isError: false }],
      running: ['call_emulated_0'],
    });
    expect(view?.status).toBe('succeeded');
  });

  it('claims nothing is running when nobody said anything is', () => {
    // Vela has no tool runtime yet. Every well-formed call must therefore
    // settle at "no result yet" — a spinner here would be a fabrication.
    const views = buildToolCallViews({ outcomes: HOSTILE_BATCH, progress: [] });
    expect(views.filter((view) => view.status === 'running')).toEqual([]);
  });

  it('collects results out of stored content parts and ignores everything else', () => {
    const parts: readonly ContentPart[] = [
      { kind: 'text', text: 'hello' },
      { kind: 'reasoning', text: 'thinking', signature: null, redacted: false },
      { kind: 'toolCall', callId: 'c1', name: 'get_weather', arguments: { city: 'alpha' } },
      { kind: 'toolResult', callId: 'c1', content: '21C', isError: false },
      { kind: 'toolResult', callId: 'c2', content: 'boom', isError: true },
    ];
    expect(collectToolResults(parts)).toEqual([
      { callId: 'c1', content: '21C', isError: false },
      { callId: 'c2', content: 'boom', isError: true },
    ]);
  });
});

describe('arguments', () => {
  it('prints an object as indented JSON', () => {
    expect(formatArguments({ city: 'alpha' })).toBe('{\n  "city": "alpha"\n}');
  });

  it('prints nothing rather than the word undefined', () => {
    expect(formatArguments(undefined)).toBe('');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(formatArguments(cyclic)).toBe('');
  });

  it('previews the fields, so a short call never needs opening', () => {
    expect(previewArguments({ city: 'alpha' })).toBe('city: "alpha"');
    expect(previewArguments({ city: 'alpha', unit: 'c' })).toBe('city: "alpha", unit: "c"');
  });

  it('clips a preview instead of letting one argument take the whole header', () => {
    const preview = previewArguments({ body: 'x'.repeat(400) });
    expect(preview).not.toBeNull();
    expect((preview ?? '').length).toBeLessThanOrEqual(96);
    expect(preview).toContain('…');
  });

  it('has no preview for a call with no arguments', () => {
    expect(previewArguments({})).toBeNull();
    expect(previewArguments(undefined)).toBeNull();
  });
});

describe('status labels', () => {
  it('gives every status a plain, non-alarming word', () => {
    for (const status of ALL_STATUSES) {
      const label = statusLabel(status);
      expect(label, status).not.toBe('');
      expect(label, `${status} shouts`).not.toMatch(/!|ERROR|FATAL/);
    }
    expect(new Set(ALL_STATUSES.map(statusLabel)).size).toBe(ALL_STATUSES.length);
  });
});

describe('nothing at all', () => {
  it('renders no group when a turn used no tools', () => {
    expect(buildToolCallViews({ outcomes: [], progress: [] })).toEqual([]);
  });
});
