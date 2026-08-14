/**
 * The panel, driven the way a user drives it: from an assistant message.
 *
 * These mount `CanvasSurface` rather than `CanvasPanel`, so the whole chain is
 * under test — parse, detect, version, submit, approve, draw. A test that
 * constructed a track by hand would prove the panel renders and prove nothing
 * about whether a model's answer ever reaches it, which is the connection this
 * repo keeps discovering it did not have.
 *
 * The load-bearing assertion is the first one: **no frame before `accepted`**.
 * The contract names that as the rule a Canvas surface must follow, and a
 * surface that drew a frame without an accepted grant would be a defect in Vela
 * rather than an attack on it. Everything else here is behaviour; that one is a
 * boundary.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PROJECT_ID } from '@/platform/contract-project';

import { CanvasSurface } from './CanvasSurface';
import { LocalDocumentHost } from './document-host';

const CHART_V1 = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" fill="red"/></svg>';
const CHART_V2 = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="9" fill="red"/></svg>';

function answer(source: string, language = 'svg'): string {
  return `Here it is.\n\n\`\`\`${language}\n${source}\n\`\`\`\n`;
}

function mount(texts: readonly string[], host = new LocalDocumentHost()) {
  return render(
    <CanvasSurface assistantTexts={texts} projectId={DEFAULT_PROJECT_ID} host={host}>
      <div>transcript</div>
    </CanvasSurface>,
  );
}

describe('an artifact in an answer opens a panel', () => {
  it('draws no frame until a person has approved the run', () => {
    mount([answer(CHART_V1)]);

    expect(screen.getByRole('group', { name: 'Approve this artifact' })).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-frame')).not.toBeInTheDocument();
  });

  it('shows what the run was granted, not a reassuring sentence about it', () => {
    mount([answer(CHART_V1)]);

    expect(screen.getByText('Drawn in an isolated frame with no access to Vela')).toBeInTheDocument();
    expect(screen.getByText('No network access')).toBeInTheDocument();
    expect(screen.getByText('No filesystem access')).toBeInTheDocument();
    expect(screen.getByText('Will not execute')).toBeInTheDocument();
  });

  it('draws the frame once the person says yes, with the model’s bytes inside it', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1)]);

    await user.click(screen.getByRole('button', { name: 'Render once' }));

    const frame = screen.getByTestId('canvas-frame');
    expect(frame).toBeInTheDocument();
    expect(frame.getAttribute('srcdoc')).toContain('<circle r="4" fill="red"/>');
  });

  it('never hands the frame Vela’s own origin', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1)]);
    await user.click(screen.getByRole('button', { name: 'Render once' }));

    const sandbox = screen.getByTestId('canvas-frame').getAttribute('sandbox');
    expect(sandbox).toBe('');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('draws nothing at all when the person says no', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1)]);

    await user.click(screen.getByRole('button', { name: 'Don’t render' }));

    expect(screen.queryByTestId('canvas-frame')).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas-notice')).toHaveTextContent('Not rendered.');
  });
});

describe('the source is always reachable, including where nothing can run', () => {
  it('shows the code behind a tab beside the preview', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1)]);

    await user.click(screen.getByRole('tab', { name: 'Code' }));
    expect(screen.getByTestId('canvas-code')).toHaveTextContent('circle r="4" fill="red"');
  });

  it('still shows the code when running artifacts is switched off', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1)], new LocalDocumentHost({ permission: 'off' }));

    expect(screen.queryByTestId('canvas-frame')).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas-notice')).toHaveTextContent('switched off');

    await user.click(screen.getByRole('tab', { name: 'Code' }));
    expect(screen.getByTestId('canvas-code')).toHaveTextContent('circle r="4" fill="red"');
  });

  it('shows the source of a language this build cannot draw, and says so', async () => {
    const user = userEvent.setup();
    mount([answer('graph TD;\n  Alpha-->Beta;\n  Beta-->Gamma;', 'mermaid')]);

    expect(screen.getByTestId('canvas-notice')).toHaveTextContent('cannot draw this kind');
    await user.click(screen.getByRole('tab', { name: 'Code' }));
    expect(screen.getByTestId('canvas-code')).toHaveTextContent('Alpha-->Beta');
  });
});

describe('a revision is a version of the same artifact', () => {
  it('opens one panel with two versions, showing the newest', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1), answer(CHART_V2)]);

    expect(screen.getAllByRole('button', { name: /^v\d$/ })).toHaveLength(2);
    await user.click(screen.getByRole('tab', { name: 'Code' }));
    expect(screen.getByTestId('canvas-code')).toHaveTextContent('r="9"');
  });

  it('lets the reader go back to an earlier one and stay there', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1), answer(CHART_V2)]);

    await user.click(screen.getByRole('button', { name: 'v1' }));
    await user.click(screen.getByRole('tab', { name: 'Code' }));
    expect(screen.getByTestId('canvas-code')).toHaveTextContent('r="4"');
  });

  it('offers no comparison for the first version, because there is nothing before it', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1), answer(CHART_V2)]);

    await user.click(screen.getByRole('button', { name: 'v1' }));
    expect(screen.getByRole('tab', { name: 'Changes' })).toBeDisabled();
  });

  it('shows what the revision changed', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1), answer(CHART_V2)]);

    await user.click(screen.getByRole('tab', { name: 'Changes' }));
    const diff = screen.getByTestId('canvas-diff');
    expect(diff).toHaveTextContent('v1 → v2');
    expect(diff).toHaveTextContent('1 added, 1 removed');
    expect(diff).toHaveTextContent('r="9"');
  });
});

describe('closing the panel sticks to the artifact, not to the panel', () => {
  it('leaves a way back in', async () => {
    const user = userEvent.setup();
    mount([answer(CHART_V1)]);

    await user.click(screen.getByRole('button', { name: 'Close the artifact panel' }));
    expect(screen.queryByRole('tab', { name: 'Preview' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'SVG image' }));
    expect(screen.getByRole('tab', { name: 'Preview' })).toBeInTheDocument();
  });
});

describe('script is a decision, taken once, per program', () => {
  it('is denied until the reader asks, and asking asks again', async () => {
    const user = userEvent.setup();
    mount([answer('<p>a paragraph long enough to be an artifact</p>', 'html')]);

    await user.click(screen.getByRole('button', { name: 'Render once' }));
    expect(screen.getByTestId('canvas-frame').getAttribute('sandbox')).toBe('');

    await user.click(screen.getByRole('checkbox'));
    // A different program is a different run, so the approval is asked again
    // rather than inherited — which is the reason `scripts` is on the program.
    expect(screen.queryByTestId('canvas-frame')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Render once' }));
    expect(screen.getByTestId('canvas-frame').getAttribute('sandbox')).toBe('allow-scripts');
  });
});
