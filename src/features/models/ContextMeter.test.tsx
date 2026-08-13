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

  it('exposes the estimate to assistive technology as an estimate', () => {
    render(<ContextMeter windowTokens={4096} texts={['hello']} />);
    const meter = screen.getByRole('meter', { name: 'Estimated context used' });
    expect(meter).toHaveAttribute('aria-valuemax', '4096');
    expect(meter.getAttribute('aria-valuetext')).toMatch(/^about \d+ of 4K tokens$/);
  });
});
