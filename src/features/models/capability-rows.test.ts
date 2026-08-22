import { describe, expect, it } from 'vitest';

import { NO_CAPABILITIES, type ModelCapabilityReport } from '@/platform/contract';

import { capabilityRows, degradations, formatTokens } from './capability-rows';

function report(overrides: Partial<ModelCapabilityReport> = {}): ModelCapabilityReport {
  return {
    providerId: 'workstation',
    modelId: 'some-model',
    capabilities: NO_CAPABILITIES,
    structuredOutput: false,
    toolCallsEmulated: false,
    contextWindowTokens: null,
    maxOutputTokens: null,
    probed: true,
    findings: [],
    ...overrides,
  };
}

function row(rows: readonly { id: string }[], id: string) {
  const found = rows.find((one) => one.id === id);
  if (found === undefined) throw new Error(`no row \`${id}\``);
  return found as (typeof rows)[number] & { value: string; detail: string | null; tone: string };
}

describe('capabilityRows', () => {
  it('says every capability is unestablished when nothing has been probed', () => {
    const rows = capabilityRows(null);
    for (const id of ['vision', 'tools', 'structuredOutput', 'streaming']) {
      expect(row(rows, id).tone).toBe('unknown');
    }
    // And it says why, rather than leaving a blank the user has to interpret.
    expect(row(rows, 'vision').detail).toMatch(/nothing is offered/i);
  });

  it('states the absence of vision as a consequence, not as a missing row', () => {
    // The whole point: a model that cannot see says so, in a sentence, in the
    // same list as everything it can do.
    const rows = capabilityRows(report({ capabilities: { ...NO_CAPABILITIES, streaming: true } }));
    const vision = row(rows, 'vision');
    expect(vision.value).toBe('Not accepted');
    expect(vision.tone).toBe('absent');
    expect(vision.detail).toMatch(/no way to attach an image/i);
  });

  it('distinguishes native tools from emulated ones', () => {
    const native = row(
      capabilityRows(report({ capabilities: { ...NO_CAPABILITIES, toolCalls: true } })),
      'tools',
    );
    expect(native.value).toBe('Native');

    const emulated = row(capabilityRows(report({ toolCallsEmulated: true })), 'tools');
    expect(emulated.value).toBe('Emulated');
    expect(emulated.tone).toBe('emulated');
    expect(emulated.detail).toMatch(/shown to you rather than run/i);
  });

  it('explains why structured output is withdrawn rather than merely absent', () => {
    // MEASURED-5: the failure mode is 200 OK with prose. The sentence has to
    // carry that, or "not offered" reads as an arbitrary restriction.
    const structured = row(capabilityRows(report()), 'structuredOutput');
    expect(structured.value).toBe('Not offered');
    expect(structured.detail).toMatch(/no sign anything was ignored/i);
  });

  it('reports the window the endpoint gave, and says so when it gave none', () => {
    expect(row(capabilityRows(report({ contextWindowTokens: 8192 })), 'context').value).toBe(
      '8K tokens',
    );
    const absent = row(capabilityRows(report()), 'context');
    expect(absent.value).toBe('Not reported');
    expect(absent.detail).toMatch(/Nothing is assumed/i);
  });

  it('mentions the reply budget only when the endpoint reported one', () => {
    expect(
      row(capabilityRows(report({ contextWindowTokens: 4096, maxOutputTokens: 1024 })), 'context')
        .detail,
    ).toMatch(/1K/);
    expect(row(capabilityRows(report({ contextWindowTokens: 4096 })), 'context').detail).toBeNull();
  });

  it('warns that token counts are Vela estimates when the endpoint reports none', () => {
    const usage = row(capabilityRows(report()), 'usage');
    expect(usage.detail).toMatch(/its own estimate/i);
  });

  it('counts the things that are missing or emulated, for the bar to show', () => {
    const rows = capabilityRows(report({ toolCallsEmulated: true }));
    const limits = degradations(rows);
    expect(limits.length).toBeGreaterThan(0);
    expect(limits.every((one) => one.tone === 'absent' || one.tone === 'emulated')).toBe(true);
  });

  it('has no limits to report for a model that does everything', () => {
    const rows = capabilityRows(
      report({
        capabilities: {
          streaming: true,
          vision: true,
          toolCalls: true,
          reasoning: true,
          modelListing: true,
          usageReporting: true,
          promptCaching: true,
        },
        structuredOutput: true,
        contextWindowTokens: 200_000,
      }),
    );
    expect(degradations(rows)).toEqual([]);
  });
});

describe('formatTokens', () => {
  it('uses K only where it is exact', () => {
    expect(formatTokens(4096)).toBe('4K');
    expect(formatTokens(200_000)).toBe('200,000');
    expect(formatTokens(512)).toBe('512');
  });
});
