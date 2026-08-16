/**
 * The run history table.
 *
 * **Driven with a stub repository, not the fake host, and that is forced rather
 * than chosen.** `BrowserAdapter` deliberately has no `schedule_runs` map: a run
 * is opened by the host's poll thread, a browser tab has no poll thread, and
 * faking one would mean a second copy of the cadence arithmetic with nothing
 * pinning it to the host's. So the fake answers an empty list forever, and the
 * only way to see a row rendered here is to supply the rows. The shapes supplied
 * are the wire shapes `ScheduleRunView` declares.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SchedulesRepository } from '@/data/schedules-repository';
import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import type { ScheduleRunView } from '@/platform/contract';
import { PlatformError } from '@/platform/errors';

import { RunHistory } from './RunHistory';

const STARTED = Date.UTC(2026, 7, 16, 9, 0);

function run(over: Partial<ScheduleRunView> = {}): ScheduleRunView {
  return {
    id: 'run_1',
    scheduleId: 'sched_1',
    status: 'success',
    trigger: 'schedule',
    startedAtMs: STARTED,
    finishedAtMs: STARTED + 1_200,
    durationMs: 1_200,
    conversationId: 'conv_1',
    error: null,
    ...over,
  };
}

/** A repository that answers only `listRuns`; nothing else is reached. */
function answering(listRuns: SchedulesRepository['listRuns']): SchedulesRepository {
  const unreached = (name: string) => (): never => {
    throw new Error(`RunHistory called ${name}, which it has no business calling`);
  };
  return {
    list: unreached('list'),
    create: unreached('create'),
    setEnabled: unreached('setEnabled'),
    remove: unreached('remove'),
    listRuns,
  };
}

function mount(repository: SchedulesRepository) {
  return render(
    <PlatformProvider adapter={new BrowserAdapter()}>
      <RunHistory scheduleId="sched_1" title="morning digest" repository={repository} />
    </PlatformProvider>,
  );
}

describe('the run history', () => {
  it('names the condition rather than leaving a blank rectangle', async () => {
    mount(answering(async () => []));
    expect(
      await screen.findByText(/No runs yet\. Vela starts a run when the slot comes round/u),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('draws a row per attempt, with the word the host sent', async () => {
    mount(
      answering(async () => [
        run({ id: 'run_2', status: 'failed', error: 'no provider configured', durationMs: 40 }),
        run({ id: 'run_1', status: 'success' }),
      ]),
    );

    const rows = await screen.findAllByRole('row');
    // Header plus two attempts.
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('Failed');
    expect(rows[1]).toHaveTextContent('no provider configured');
    expect(rows[1]).toHaveTextContent('40ms');
    expect(rows[2]).toHaveTextContent('Succeeded');
    expect(rows[2]).toHaveTextContent('1.2s');
  });

  it('writes the start of a run as a machine-readable instant beside the words', async () => {
    // The words are the reader's own locale and zone, which a test must not pin.
    // The attribute is UTC and says the same thing.
    const { container } = mount(answering(async () => [run()]));
    await screen.findAllByRole('row');
    expect(container.querySelector('time')).toHaveAttribute(
      'dateTime',
      new Date(STARTED).toISOString(),
    );
  });

  it('shows a dash rather than a zero for a run that has not finished', async () => {
    // `running` is the state a run stays in: the loop that would finish it has
    // no implementation in this tree. A `0` in the duration column would read as
    // "finished instantly", which is the opposite of true.
    mount(
      answering(async () => [
        run({ status: 'running', finishedAtMs: null, durationMs: null, error: null }),
      ]),
    );

    const rows = await screen.findAllByRole('row');
    expect(rows[1]).toHaveTextContent('Running');
    expect(rows[1]?.textContent).toContain('—');
    expect(rows[1]?.textContent).not.toContain('0ms');
  });

  it('says out loud that a run reaches no model yet', async () => {
    // If that ever stops being true, this sentence and this test change with it.
    mount(answering(async () => [run()]));
    expect(
      await screen.findByText(/nothing sends it to a model yet/u),
    ).toBeInTheDocument();
  });

  it('reports a history it could not read instead of drawing it as empty', async () => {
    mount(
      answering(async () => {
        throw new PlatformError('NOT_FOUND', 'no schedule with id `sched_1`', 'schedules_list_runs');
      }),
    );

    expect(await screen.findByRole('status')).toHaveTextContent(/Run history unavailable · NOT_FOUND/u);
    expect(screen.queryByText(/No runs yet/u)).not.toBeInTheDocument();
  });

  it('is labelled by the schedule it belongs to, so two open histories are distinct', async () => {
    mount(answering(async () => []));
    expect(
      await screen.findByRole('region', { name: 'Run history: morning digest' }),
    ).toBeInTheDocument();
  });
});
