/**
 * THE ASYMMETRY GUARD, and the ordering it depends on.
 *
 * The defect this file exists to catch is not "the style text is wrong". It is
 * "the style reaches one of the two send paths". That failure is invisible from
 * inside either path — each one is internally correct — and it is the failure
 * `ProjectPanel.tsx` already discloses for project instructions. So the checks
 * below quantify over `SendPath` rather than testing a path.
 *
 * ## What is NOT here, and where it is instead
 *
 * The **ordering** half of the precedence claim — that the text this file
 * composes is placed ahead of the project's chunk — is a fact about
 * `composeSystemMessage` in `agent-loop-harness.ts` and about the wiring in
 * `use-conversation.ts`, and neither is visible from a pure function. Asserting
 * it here against a restatement of the join would stay green through a change
 * that reversed the real one. It is asserted in
 * `src/app/instructions-and-incognito.test.tsx`, off the `chat_send` payload the
 * host is actually handed.
 */

import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_STYLES,
  composeInstructionText,
  DEFAULT_STYLE_ID,
  PROJECT_WINS_SENTENCE,
  resolveInstructionLayers,
  styleById,
  type SendPath,
  type StyleId,
} from './instruction-layers';

const PATHS: readonly SendPath[] = ['chat', 'agent'];
const CONCISE: StyleId = 'concise';

function layerOf(layers: ReturnType<typeof resolveInstructionLayers>, id: string) {
  const found = layers.find((layer) => layer.id === id);
  if (found === undefined) throw new Error(`no \`${id}\` layer — the resolution dropped one`);
  return found;
}

describe('the style and the user’s instructions reach both send paths', () => {
  it.each(PATHS)('a chosen style applies on the %s path', (path) => {
    const layers = resolveInstructionLayers({
      styleId: CONCISE,
      customInstructions: '',
      project: { kind: 'none' },
      path,
    });
    expect(layerOf(layers, 'style').applies).toBe(true);
    expect(composeInstructionText(layers)).toContain(styleById(CONCISE).directive);
  });

  it.each(PATHS)('the user’s own instructions apply on the %s path', (path) => {
    const layers = resolveInstructionLayers({
      styleId: DEFAULT_STYLE_ID,
      customInstructions: 'Always answer in French.',
      project: { kind: 'none' },
      path,
    });
    expect(layerOf(layers, 'custom').applies).toBe(true);
    expect(composeInstructionText(layers)).toContain('Always answer in French.');
  });

  it('composes the same text for both paths when nothing else differs', () => {
    // The paths are allowed to differ in exactly one thing — the precedence
    // sentence — and that difference is driven by the project layer. With no
    // project on either side, two different strings would mean one path had
    // grown its own composition.
    const input = { styleId: CONCISE, customInstructions: 'Be blunt.', project: { kind: 'none' } as const };
    const chat = composeInstructionText(resolveInstructionLayers({ ...input, path: 'chat' }));
    const agent = composeInstructionText(resolveInstructionLayers({ ...input, path: 'agent' }));
    expect(chat).toBe(agent);
    expect(chat).not.toBeNull();
  });
});

describe('the default style puts no words in front of a turn', () => {
  it('contributes nothing, and an empty resolution composes to null', () => {
    expect(styleById(DEFAULT_STYLE_ID).directive).toBeNull();
    const layers = resolveInstructionLayers({
      styleId: DEFAULT_STYLE_ID,
      customInstructions: '   ',
      project: { kind: 'none' },
      path: 'chat',
    });
    expect(layerOf(layers, 'style').applies).toBe(false);
    expect(layerOf(layers, 'custom').applies).toBe(false);
    // `null`, not `''`. A system message with an empty body is a message some
    // endpoints reject, and `toMessages` branches on exactly this value.
    expect(composeInstructionText(layers)).toBeNull();
  });

  it('every style in the table is reachable by its own id', () => {
    // A picker renders `BUILT_IN_STYLES` and hands back an id. A style in the
    // table that `styleById` cannot find is one the picker offers and the
    // composer throws on.
    for (const style of BUILT_IN_STYLES) expect(styleById(style.id)).toBe(style);
  });
});

describe('project instructions, and what each path says about them', () => {
  it('never applies on the chat path, whatever the project holds', () => {
    // The disclosed asymmetry, pinned. `startRun` fills `preload` and `start`
    // does not; if that ever changes, this is the test that has to be changed
    // with it, deliberately, rather than a surface quietly starting to promise
    // something the sender does not do.
    const layers = resolveInstructionLayers({
      styleId: DEFAULT_STYLE_ID,
      customInstructions: 'x',
      project: { kind: 'text', text: 'Answer in French.' },
      path: 'chat',
    });
    const project = layerOf(layers, 'project');
    expect(project.applies).toBe(false);
    expect(project.why).toBe('Not sent on an ordinary message — only an agent run carries them.');
    // The words are still carried to the surface, so the pane can show the user
    // exactly what is being left behind rather than only that something is.
    expect(project.text).toBe('Answer in French.');
  });

  it('applies on the agent path both when the text is known and when only the ref is', () => {
    for (const project of [{ kind: 'text' as const, text: 'a' }, { kind: 'indexed' as const }]) {
      const layers = resolveInstructionLayers({
        styleId: DEFAULT_STYLE_ID,
        customInstructions: 'x',
        project,
        path: 'agent',
      });
      expect(layerOf(layers, 'project').applies).toBe(true);
    }
  });

  it('keeps “could not be read” apart from “there are none”', () => {
    const unreadable = resolveInstructionLayers({
      styleId: DEFAULT_STYLE_ID,
      customInstructions: '',
      project: { kind: 'unreadable' },
      path: 'agent',
    });
    const none = resolveInstructionLayers({
      styleId: DEFAULT_STYLE_ID,
      customInstructions: '',
      project: { kind: 'none' },
      path: 'agent',
    });
    expect(layerOf(unreadable, 'project').why).not.toBe(layerOf(none, 'project').why);
  });

  it('resolves all three layers always, in one order', () => {
    // A resolution that dropped empty layers would let the pane draw two rows
    // and leave the user to guess whether the third exists.
    const layers = resolveInstructionLayers({
      styleId: DEFAULT_STYLE_ID,
      customInstructions: '',
      project: { kind: 'unknown' },
      path: 'chat',
    });
    expect(layers.map((layer) => layer.id)).toEqual(['style', 'custom', 'project']);
  });
});

describe('precedence: the half that is mechanical, and the half that is a sentence', () => {
  it('names the project as authoritative only when a project layer is actually coming', () => {
    const withProject = composeInstructionText(
      resolveInstructionLayers({
        styleId: CONCISE,
        customInstructions: '',
        project: { kind: 'indexed' },
        path: 'agent',
      }),
    );
    const without = composeInstructionText(
      resolveInstructionLayers({
        styleId: CONCISE,
        customInstructions: '',
        project: { kind: 'none' },
        path: 'agent',
      }),
    );
    expect(withProject).toContain(PROJECT_WINS_SENTENCE);
    // A sentence deferring to instructions that cannot arrive is a sentence
    // about nothing, and on the chat path there are never any.
    expect(without).not.toContain(PROJECT_WINS_SENTENCE);
  });

  it('never carries the project’s own words: those are the resolver’s to load', () => {
    // `RunContextRequest` holds refs and not bodies so that every load produces
    // a `contextLoaded` event. Copying the body in here would put the same words
    // in front of the model twice on the agent path, with no record of the
    // second.
    const text = composeInstructionText(
      resolveInstructionLayers({
        styleId: DEFAULT_STYLE_ID,
        customInstructions: 'mine',
        project: { kind: 'text', text: 'THE-PROJECT-BODY' },
        path: 'agent',
      }),
    );
    expect(text).not.toContain('THE-PROJECT-BODY');
    expect(text).toContain('mine');
  });
});
