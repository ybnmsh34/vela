import { describe, expect, it } from 'vitest';

import { flushGuard, guardDelta, GUARD_START, type GuardState } from './reasoning-guard';

/** Feeds a whole stream through the guard, one frame at a time. */
function run(frames: readonly string[]): {
  answer: string;
  reasoning: string;
  unterminated: boolean;
} {
  let state: GuardState = GUARD_START;
  let answer = '';
  let reasoning = '';
  for (const frame of frames) {
    const out = guardDelta(state, frame);
    state = out.state;
    answer += out.answer;
    reasoning += out.reasoning;
  }
  const end = flushGuard(state);
  return {
    answer: answer + end.answer,
    reasoning: reasoning + end.reasoning,
    unterminated: end.unterminated,
  };
}

describe('the reasoning-markup guard', () => {
  it('passes ordinary text through untouched', () => {
    expect(run(['Hello, ', 'world.'])).toEqual({
      answer: 'Hello, world.',
      reasoning: '',
      unterminated: false,
    });
  });

  it('routes a complete block to reasoning and keeps the answer clean', () => {
    const result = run(['<think>weighing it up</think>The answer is 4.']);
    expect(result.answer).toBe('The answer is 4.');
    expect(result.reasoning).toBe('weighing it up');
  });

  /**
   * MEASURED-3, restated as a renderer property: no single frame contains a
   * whole tag. A guard that only looked inside one frame would print `<thi`.
   */
  it('recognises a tag split across frame boundaries', () => {
    const result = run(['before <', 'thi', 'nk>hidden</', 'thin', 'k> after']);
    expect(result.answer).toBe('before  after');
    expect(result.reasoning).toBe('hidden');
    expect(result.answer).not.toContain('<');
  });

  it('splits the closing tag across frames too', () => {
    const result = run(['<think>a', 'b</thi', 'nk>visible']);
    expect(result.answer).toBe('visible');
    expect(result.reasoning).toBe('ab');
  });

  it('treats a second opener inside an open block as no-op, so the first closer closes', () => {
    // The hostile profile's shape: opened twice, closed once.
    const result = run(['<think>one <think>two</think>the answer']);
    expect(result.answer).toBe('the answer');
    expect(result.reasoning).toBe('one two');
  });

  it('reports an unterminated block instead of silently swallowing its text', () => {
    const result = run(['<think>still going and going']);
    expect(result.unterminated).toBe(true);
    expect(result.answer).toBe('');
    // Nothing is lost: it is all still available, in the subordinate channel.
    expect(result.reasoning).toBe('still going and going');
  });

  it('never leaks markup even when the block is opened twice and never closed', () => {
    const result = run(['<think>a', '<think>b', ' and c']);
    expect(result.answer).toBe('');
    expect(result.reasoning).toBe('ab and c');
    expect(result.reasoning + result.answer).not.toContain('<think>');
    expect(result.unterminated).toBe(true);
  });

  it('drops a stray closing tag rather than printing it', () => {
    expect(run(['all done</think> tail']).answer).toBe('all done tail');
  });

  it('releases a held-back fragment that turns out not to be a tag', () => {
    // `<` is ambiguous when the frame ends; it must not be eaten.
    expect(run(['2 <', ' 3']).answer).toBe('2 < 3');
    expect(run(['a <thing>']).answer).toBe('a <thing>');
  });

  it('emits a lone trailing `<` at end of stream rather than dropping it', () => {
    expect(run(['ends with <']).answer).toBe('ends with <');
  });

  it('handles the `<thinking>` spelling as well as `<think>`', () => {
    const result = run(['<thinking>deliberating</thinking>done']);
    expect(result.answer).toBe('done');
    expect(result.reasoning).toBe('deliberating');
  });

  it('holds back no more than one tag is long, however many `<` arrive', () => {
    let state: GuardState = GUARD_START;
    for (let index = 0; index < 200; index += 1) {
      state = guardDelta(state, '<').state;
    }
    expect(state.pending.length).toBeLessThanOrEqual('<thinking>'.length - 1);
  });

  /* -- code is content, not markup -------------------------------------- */

  it('leaves a tag quoted in an inline code span exactly as the model wrote it', () => {
    // The bug that earned this rule: an answer *about* reasoning tags had its
    // second half eaten and resumed mid-sentence.
    const result = run(['Use `<think>` to open and `</think>` to close it.']);
    expect(result.answer).toBe('Use `<think>` to open and `</think>` to close it.');
    expect(result.reasoning).toBe('');
    expect(result.unterminated).toBe(false);
  });

  it('leaves a tag inside a fenced block alone', () => {
    const source = 'Example:\n\n```\n<think>hidden</think>\n```\n\nDone.';
    expect(run([source]).answer).toBe(source);
  });

  it('applies the backtick rule across frame boundaries too', () => {
    const result = run(['A `<thi', 'nk>` is an opener.']);
    expect(result.answer).toBe('A `<think>` is an opener.');
    expect(result.reasoning).toBe('');
  });

  it('still strips a real tag that follows a balanced code span', () => {
    const result = run(['See `<think>`. <think>now deliberating</think>Answer.']);
    expect(result.answer).toBe('See `<think>`. Answer.');
    expect(result.reasoning).toBe('now deliberating');
  });

  it('is frame-size independent: character-by-character equals one big frame', () => {
    const source =
      'intro <think>hmm <think>more</think> tail `<think>quoted</think>` more <think>open';
    const whole = run([source]);
    const perCharacter = run([...source]);
    expect(perCharacter).toEqual(whole);
  });
});
