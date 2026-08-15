/**
 * `HarnessRuntime.contextFor`, and the one property it says must hold.
 *
 * The contract spends a long comment on why the resolver became a per-project
 * function rather than an app-wide instance, and ends with the rule the repair
 * had to keep: **two resolvers for the same `projectId` must be
 * interchangeable** — the same refs out of `index`, the same bodies out of
 * `load` — with memoising and returning a fresh object per call both conforming.
 * That rule had nothing behind it. It does now.
 *
 * The second test here is the other half of the same seam: `HarnessServices`
 * says `context` **is** `contextFor(request.projectId)`, "the same resolver the
 * caller indexed `RunContextRequest.preload` against, which is what makes those
 * refs load". A run below indexes through the runtime, preloads what it found,
 * and the loop reports `contextLoaded` — which it can only do if the two are in
 * fact the same reader.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_PROJECT_ID } from '@/platform/contract-project';
import type { ContextRef, RunEvent } from '@/platform/contract-harness';

import { createHarnessRuntime } from './harness-runtime';
import { createProjectContextResolver } from './project-context';
import { FakeTurnDriver, recordingTranscript, runRequest } from './run-doubles';

const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000ff';

function reader(byProject: Readonly<Record<string, string | null>>) {
  return (projectId: string): Promise<string | null> =>
    Promise.resolve(byProject[projectId] ?? null);
}

describe('the project instructions resolver', () => {
  it('indexes one ref for a project that has instructions', async () => {
    const resolver = createProjectContextResolver(
      DEFAULT_PROJECT_ID,
      reader({ [DEFAULT_PROJECT_ID]: 'be brief' }),
    );
    const refs = await resolver.index();
    expect(refs).toHaveLength(1);
    expect(refs[0]?.source).toBe('projectInstructions');
    // "Never substitute a zero: a budget computed from a guessed zero silently
    // overruns the context window."
    expect(refs[0]?.estimatedTokens).toBeNull();
  });

  it('indexes nothing for a project with no instructions', async () => {
    const resolver = createProjectContextResolver(DEFAULT_PROJECT_ID, reader({}));
    expect(await resolver.index()).toEqual([]);
  });

  it('serves only the sources it can actually load', async () => {
    // "no command reads a skill's body, so a resolver cannot serve that source
    // yet and must not pretend to by returning refs it cannot load."
    const resolver = createProjectContextResolver(
      DEFAULT_PROJECT_ID,
      reader({ [DEFAULT_PROJECT_ID]: 'be brief' }),
    );
    const sources = (await resolver.index()).map((ref) => ref.source);
    expect(sources).toEqual(['projectInstructions']);

    const invented: ContextRef = {
      source: 'skill',
      id: 'skills/whatever',
      title: 'Whatever',
      estimatedTokens: null,
    };
    expect(await resolver.load(invented)).toBeNull();
  });

  it('refuses a ref indexed against another project, rather than guessing', async () => {
    // "Refs indexed against a *different* project's resolver do not load. They
    // come back `null` and produce a `contextUnavailable` degradation."
    const instructions = { [DEFAULT_PROJECT_ID]: 'mine', [OTHER_PROJECT]: 'theirs' };
    const mine = createProjectContextResolver(DEFAULT_PROJECT_ID, reader(instructions));
    const theirs = createProjectContextResolver(OTHER_PROJECT, reader(instructions));

    const theirRef = (await theirs.index())[0];
    expect(theirRef).toBeDefined();
    if (theirRef === undefined) return;
    expect(await mine.load(theirRef)).toBeNull();
    expect((await mine.load((await mine.index())[0] ?? theirRef))?.text).toBe('mine');
  });

  it('makes two resolvers for one project interchangeable', async () => {
    const read = reader({ [DEFAULT_PROJECT_ID]: 'be brief' });
    const first = createProjectContextResolver(DEFAULT_PROJECT_ID, read);
    const second = createProjectContextResolver(DEFAULT_PROJECT_ID, read);

    expect(await first.index()).toEqual(await second.index());

    const ref = (await first.index())[0];
    expect(ref).toBeDefined();
    if (ref === undefined) return;
    // A ref out of one, loaded by the other. This is the whole rule: the
    // property the one-instance draft was protecting was never identity.
    expect(await second.load(ref)).toEqual(await first.load(ref));
    expect((await second.load(ref))?.text).toBe('be brief');
  });
});

describe('contextFor on the runtime', () => {
  it('hands back a reader without reading anything itself', async () => {
    // "Pure and cheap, like `select`: it hands back a reader, it does not read.
    // A caller may hold the result across runs in the same project."
    //
    // `select`'s purity is held in `harness-registry.test.ts`; this neighbour
    // was not. A resolver that read at construction turns a settings surface
    // calling `contextFor` on every render into a host read per render — and the
    // runtime memoises one resolver per project, so that first read becomes the
    // answer every later run gets.
    let reads = 0;
    const runtime = createHarnessRuntime({
      turns: new FakeTurnDriver(),
      transcript: recordingTranscript().writer,
      toolsFor: () => ({ execute: () => Promise.reject(new Error('no tools')) }),
      readProjectInstructions: (projectId: string) => {
        reads += 1;
        return Promise.resolve(projectId === DEFAULT_PROJECT_ID ? 'be brief' : null);
      },
    });

    for (let call = 0; call < 5; call += 1) {
      runtime.contextFor(DEFAULT_PROJECT_ID);
      runtime.contextFor(OTHER_PROJECT);
    }
    expect(reads, 'contextFor hands back a reader; it does not read').toBe(0);

    // …and the reader it handed back does read, so the count above is not
    // measuring a reader nobody wired up.
    await runtime.contextFor(DEFAULT_PROJECT_ID).index();
    expect(reads).toBe(1);
  });

  it('never serves a snapshot taken when the resolver was first asked for', async () => {
    // The other half of the same rule, and the one a user would feel: the
    // runtime memoises a resolver per project, so a resolver that read once at
    // construction would answer every later run with the instructions as they
    // were the first time anything asked. The user edits them, sends again, and
    // gets the old ones with nothing to say so.
    let instructions = 'the first version';
    const runtime = createHarnessRuntime({
      turns: new FakeTurnDriver(),
      transcript: recordingTranscript().writer,
      toolsFor: () => ({ execute: () => Promise.reject(new Error('no tools')) }),
      readProjectInstructions: () => Promise.resolve(instructions),
    });

    const ref = (await runtime.contextFor(DEFAULT_PROJECT_ID).index())[0];
    expect(ref).toBeDefined();
    if (ref === undefined) return;
    expect((await runtime.contextFor(DEFAULT_PROJECT_ID).load(ref))?.text).toBe('the first version');

    instructions = 'the edited version';
    expect(
      (await runtime.contextFor(DEFAULT_PROJECT_ID).load(ref))?.text,
      'a memoised resolver must re-read, not replay what it read once',
    ).toBe('the edited version');
  });

  it('answers with a resolver interchangeable with a directly built one', async () => {
    const read = reader({ [DEFAULT_PROJECT_ID]: 'be brief' });
    const runtime = createHarnessRuntime({
      turns: new FakeTurnDriver(),
      transcript: recordingTranscript().writer,
      toolsFor: () => ({ execute: () => Promise.reject(new Error('no tools')) }),
      readProjectInstructions: read,
    });

    const fromRuntime = runtime.contextFor(DEFAULT_PROJECT_ID);
    const built = createProjectContextResolver(DEFAULT_PROJECT_ID, read);
    expect(await fromRuntime.index()).toEqual(await built.index());

    const ref = (await built.index())[0];
    expect(ref).toBeDefined();
    if (ref === undefined) return;
    expect(await fromRuntime.load(ref)).toEqual(await built.load(ref));
  });

  it('hands the run the same reader the caller indexed against', async () => {
    // The seam that makes `RunContextRequest.preload` work at all. If the run
    // were built over a different resolver, this ref would come back null and
    // the run would report `contextUnavailable` for material that is present.
    const turns = new FakeTurnDriver();
    turns.scriptText('ok');
    const runtime = createHarnessRuntime({
      turns,
      transcript: recordingTranscript().writer,
      toolsFor: () => ({ execute: () => Promise.reject(new Error('no tools')) }),
      readProjectInstructions: reader({ [DEFAULT_PROJECT_ID]: 'be brief' }),
    });

    const refs = await runtime.contextFor(DEFAULT_PROJECT_ID).index();
    const ref = refs[0];
    expect(ref).toBeDefined();
    if (ref === undefined) return;

    const events: RunEvent[] = [];
    const finished = new Promise<void>((resolve) => {
      const start = runtime.runs.start(
        runRequest({ context: { systemPrompt: null, preload: [ref] } }),
      );
      if (start.outcome !== 'started') throw new Error(`rejected: ${start.reason}`);
      start.handle.subscribe(
        (envelope) => {
          events.push(envelope.event);
          if (envelope.event.type === 'runFinished') resolve();
        },
        { fromSeq: 0 },
      );
    });
    await finished;

    expect(events).toContainEqual({ type: 'contextLoaded', ref });
    expect(events).not.toContainEqual({
      type: 'degraded',
      degradation: { kind: 'contextUnavailable', ref },
    });
    const sent = turns.sent[0];
    expect(sent?.messages[0]).toEqual({ role: 'system', text: 'be brief' });
  });
});
