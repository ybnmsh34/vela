/**
 * The tool-call surface as a user meets it.
 *
 * The fixtures are the same measured ones the view-model test uses — the
 * hostile profile's partially broken batch of three and the small-local
 * profile's emulated call — because the presentation's whole job is to survive
 * those two shapes without hiding either.
 *
 * The assertion that matters most in this file is the dullest one: a malformed
 * call is **on screen**. The core kept those bytes instead of executing a guess
 * at what they meant; a card that renders as nothing throws that away and
 * leaves the user believing the model never asked for anything.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { ToolCallOutcome } from '@/platform/contract';

import { ToolCallList } from './ToolCallList';

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

const EMULATED_CALL: ToolCallOutcome = {
  status: 'ok',
  callId: 'call_emulated_0',
  name: 'echo_tool',
  arguments: { text: 'ok' },
  emulated: true,
};

/** The one card whose header contains this name. */
function card(name: string): HTMLElement {
  const toggle = screen.getByRole('button', { name: new RegExp(name) });
  const found = toggle.closest('[data-status]');
  if (!(found instanceof HTMLElement)) throw new Error(`no card around ${name}`);
  return found;
}

describe('a batch of parallel calls', () => {
  it('draws three distinct calls when the endpoint asked for three', () => {
    render(<ToolCallList outcomes={HOSTILE_BATCH} progress={[]} />);

    const group = screen.getByRole('region', { name: 'Tool calls' });
    expect(within(group).getAllByRole('listitem')).toHaveLength(3);
    expect(within(group).getByText('3 tool calls · 1 could not be read')).toBeInTheDocument();
    for (const name of ['get_weather', 'get_time', 'get_quote']) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toBeInTheDocument();
    }
  });

  it('shows each call its own correlation id, so a result cannot be misread', async () => {
    const user = userEvent.setup();
    render(<ToolCallList outcomes={HOSTILE_BATCH} progress={[]} />);

    await user.click(screen.getByRole('button', { name: /get_weather/ }));
    await user.click(screen.getByRole('button', { name: /get_quote/ }));

    expect(screen.getByText('call_36cb7766')).toBeVisible();
    expect(screen.getByText('call_36cb7766_2')).toBeVisible();
  });
});

describe('the malformed call', () => {
  it('is on screen, named, and says what happened without being expanded', () => {
    render(<ToolCallList outcomes={HOSTILE_BATCH} progress={[]} />);

    const broken = card('get_time');
    expect(broken).toHaveAttribute('data-status', 'unreadable');
    expect(within(broken).getByText('Could not be read')).toBeVisible();
    expect(
      within(broken).getByText(/Vela could not read this call: the call was tagged as something/),
    ).toBeVisible();
  });

  it('keeps the raw text one click away, and shows it unmodified', async () => {
    const user = userEvent.setup();
    render(<ToolCallList outcomes={HOSTILE_BATCH} progress={[]} />);
    const broken = card('get_time');

    expect(within(broken).queryByText('{"timezone":"')).not.toBeVisible();

    const reveal = within(broken).getByRole('button', { name: 'Show what arrived' });
    expect(reveal).toHaveAttribute('aria-expanded', 'false');
    await user.click(reveal);

    // Exactly the bytes the gate recorded — not re-serialised, not completed.
    expect(within(broken).getByText('{"timezone":"')).toBeVisible();
    expect(
      within(broken).getByRole('button', { name: 'Hide what arrived' }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('is not dressed as an alarm', () => {
    render(<ToolCallList outcomes={HOSTILE_BATCH} progress={[]} />);

    // No alert role, nothing shouting: a model producing an unreadable call is
    // ordinary. It has to be visible, not frightening.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(card('get_time').textContent ?? '').not.toMatch(/!|ERROR|FAILED/);
  });

  it('renders a call with no name, no id and no arguments at all', () => {
    render(
      <ToolCallList
        outcomes={[
          {
            status: 'malformed',
            index: null,
            callId: null,
            name: null,
            rawArguments: '',
            reason: 'missingName',
          },
        ]}
        progress={[]}
      />,
    );

    expect(screen.getByRole('button', { name: /Unnamed tool call/ })).toBeInTheDocument();
    expect(screen.getByText(/no tool name ever arrived/)).toBeVisible();
    // Nothing arrived, so there is nothing to offer to reveal.
    expect(screen.queryByRole('button', { name: 'Show what arrived' })).not.toBeInTheDocument();
  });

  it('presents a rescued call as an offer rather than a defect', () => {
    render(
      <ToolCallList
        outcomes={[
          {
            status: 'malformed',
            index: null,
            callId: null,
            name: 'get_weather',
            rawArguments: '{"city":"alpha"}',
            reason: 'recoveredFromUnterminatedReasoning',
          },
        ]}
        progress={[]}
      />,
    );

    expect(card('get_weather')).toHaveAttribute('data-status', 'notCommitted');
    expect(screen.getByText('Not sent')).toBeVisible();
    expect(screen.getByText(/never closed/)).toBeVisible();
  });
});

describe('emulated tool calling', () => {
  it('says the model is not doing this natively, and tags the call', () => {
    render(<ToolCallList outcomes={[EMULATED_CALL]} progress={[]} />);

    expect(screen.getByText(/This model has no built-in tool calling/)).toBeVisible();
    expect(screen.getByRole('button', { name: /emulated/ })).toBeInTheDocument();
  });

  it('says it once for a batch, not once per call', () => {
    render(
      <ToolCallList
        outcomes={[EMULATED_CALL, { ...EMULATED_CALL, callId: 'call_emulated_1' }]}
        progress={[]}
      />,
    );
    expect(screen.getAllByText(/This model has no built-in tool calling/)).toHaveLength(1);
  });

  it('stays silent when the endpoint called the tool itself', () => {
    render(<ToolCallList outcomes={HOSTILE_BATCH} progress={[]} />);
    expect(screen.queryByText(/no built-in tool calling/)).not.toBeInTheDocument();
  });
});

describe('collapsing', () => {
  it('opens a call that is still arriving, and shows the fragments so far', () => {
    render(
      <ToolCallList
        outcomes={[]}
        progress={[{ slot: 0, callId: null, name: 'get_weather', argumentsText: '{"city":"al' }]}
      />,
    );

    expect(screen.getByRole('button', { name: /get_weather/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('{"city":"al')).toBeVisible();
    expect(screen.getByText('Arriving')).toBeVisible();
  });

  it('collapses a settled call to one line, with its arguments in the header', () => {
    render(<ToolCallList outcomes={[HOSTILE_BATCH[0] as ToolCallOutcome]} progress={[]} />);

    const toggle = screen.getByRole('button', { name: /get_weather/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('city: "alpha"');
    expect(screen.getByText(/"city": "alpha"/)).not.toBeVisible();
  });

  it('offers no toggle for a call that has nothing to show yet', () => {
    // The first fragment of a hostile call is a bare name, or a bare id. A
    // chevron over an empty panel is a promise the card cannot keep.
    render(
      <ToolCallList
        outcomes={[]}
        progress={[{ slot: 0, callId: null, name: null, argumentsText: '' }]}
      />,
    );

    expect(screen.getByText('Tool call')).toBeVisible();
    expect(screen.getByText('Arriving')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('opens a failed call, because the reason is the point of it', () => {
    render(
      <ToolCallList
        outcomes={[EMULATED_CALL]}
        progress={[]}
        results={[{ callId: 'call_emulated_0', content: 'ENOENT', isError: true }]}
      />,
    );

    expect(screen.getByRole('button', { name: /echo_tool/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('ENOENT')).toBeVisible();
  });

  it('opens on a click and keeps that choice when a result lands', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ToolCallList outcomes={[EMULATED_CALL]} progress={[]} />);

    await user.click(screen.getByRole('button', { name: /echo_tool/ }));
    expect(screen.getByText(/"text": "ok"/)).toBeVisible();

    rerender(
      <ToolCallList
        outcomes={[EMULATED_CALL]}
        progress={[]}
        results={[{ callId: 'call_emulated_0', content: '21C', isError: false }]}
      />,
    );

    // Still open — a panel that shuts under the cursor is worse than one that
    // never moves.
    expect(screen.getByRole('button', { name: /echo_tool/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('21C')).toBeVisible();
  });
});

describe('results', () => {
  it('shows a result against the call it answers', () => {
    render(
      <ToolCallList
        outcomes={HOSTILE_BATCH}
        progress={[]}
        results={[{ callId: 'call_36cb7766', content: '21C', isError: false }]}
      />,
    );

    expect(card('get_weather')).toHaveAttribute('data-status', 'succeeded');
    expect(card('get_quote')).toHaveAttribute('data-status', 'awaitingResult');
    expect(within(card('get_weather')).getByText('Done')).toBeVisible();
  });

  it('shows a failing result as failed, with what it said', () => {
    render(
      <ToolCallList
        outcomes={[EMULATED_CALL]}
        progress={[]}
        results={[{ callId: 'call_emulated_0', content: 'ENOENT: no such file', isError: true }]}
      />,
    );

    expect(card('echo_tool')).toHaveAttribute('data-status', 'failed');
    // No click: a failure the user has to go looking for is a failure they will
    // not find.
    expect(screen.getByText('ENOENT: no such file')).toBeVisible();
    expect(screen.getByText('Error')).toBeVisible();
  });

  it('says a call has no result yet rather than pretending it is running', () => {
    render(<ToolCallList outcomes={[EMULATED_CALL]} progress={[]} />);
    expect(screen.getByText('No result yet')).toBeVisible();
    expect(screen.queryByText('Running')).not.toBeInTheDocument();
  });

  it('says running only when something says it is running', () => {
    render(<ToolCallList outcomes={[EMULATED_CALL]} progress={[]} running={['call_emulated_0']} />);
    expect(card('echo_tool')).toHaveAttribute('data-status', 'running');
    expect(screen.getByText('Running')).toBeVisible();
  });
});

describe('a turn that used no tools', () => {
  it('draws nothing at all', () => {
    const { container } = render(<ToolCallList outcomes={[]} progress={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
