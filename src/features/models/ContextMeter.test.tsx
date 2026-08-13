import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ContextMeter } from './ContextMeter';

describe('ContextMeter', () => {
  it('shows the endpoint’s own window, and says the count is an estimate', () => {
    render(<ContextMeter windowTokens={4096} texts={['hello there']} />);
    const meter = screen.getByTestId('context-meter');
    expect(meter).toHaveTextContent(/About \d+ of 4K tokens/);
    expect(meter).toHaveAttribute('data-verdict', 'comfortable');
  });

  it('draws no bar and claims no window when the endpoint reported none', () => {
    render(<ContextMeter windowTokens={null} texts={['hello']} />);
    expect(screen.getByTestId('context-meter')).toHaveTextContent(
      /Context window not reported by this endpoint/,
    );
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('warns while there is still time to shorten the message', () => {
    // 'x' * 3400 ≈ 850 tokens against a 1000-token window.
    render(<ContextMeter windowTokens={1000} texts={['x'.repeat(3400)]} />);
    const meter = screen.getByTestId('context-meter');
    expect(meter).toHaveAttribute('data-verdict', 'tight');
    expect(meter).toHaveTextContent(/close to the limit/i);
  });

  it('says plainly what will happen when the turn is over the window', () => {
    render(<ContextMeter windowTokens={100} texts={['x'.repeat(4000)]} />);
    const meter = screen.getByTestId('context-meter');
    expect(meter).toHaveAttribute('data-verdict', 'over');
    expect(meter).toHaveTextContent(/larger than the window/i);
    expect(meter).toHaveTextContent(/drop the oldest messages, or the endpoint will refuse it/i);
  });

  it('says the use is unknown rather than printing a zero it did not measure', () => {
    // The Phase C failure, at the component's own boundary. `null` means "no
    // caller told me what this turn holds", which is not "the turn is empty" —
    // and the difference is the whole distance between a meter that informs and
    // one that tells the user they have room they do not have.
    render(<ContextMeter windowTokens={200_000} texts={null} />);
    const meter = screen.getByTestId('context-meter');
    expect(meter).toHaveTextContent(/^Context use unknown/);
    expect(meter).not.toHaveTextContent(/About 0/);
    expect(meter).toHaveAttribute('data-verdict', 'unknown');
    // The window is still the endpoint's own reported fact, so it is still said.
    expect(meter).toHaveTextContent(/200,000 token window/);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('counts an empty turn as empty, which is a different sentence', () => {
    render(<ContextMeter windowTokens={4096} texts={[]} />);
    const meter = screen.getByTestId('context-meter');
    expect(meter).toHaveAttribute('data-verdict', 'comfortable');
    expect(meter).toHaveTextContent(/About 0 of 4K tokens/);
  });

  it('exposes the estimate to assistive technology as an estimate', () => {
    render(<ContextMeter windowTokens={4096} texts={['hello']} />);
    const meter = screen.getByRole('meter', { name: 'Estimated context used' });
    expect(meter).toHaveAttribute('aria-valuemax', '4096');
    expect(meter.getAttribute('aria-valuetext')).toMatch(/^about \d+ of 4K tokens$/);
  });
});
