/**
 * The local endpoint's settings surface.
 *
 * The rules under test: off is the default and a state rather than a gap; what
 * the panel reports comes from the host and is never derived from the address
 * the user typed; and the exposed-tools question is asked in words a user can
 * act on.
 *
 * **VERIFIED-BY-FAKE.** `BrowserAdapter` opens no socket, so nothing here is
 * evidence that a port answers. It is evidence that every state the host can
 * report has somewhere to be drawn, which is what a panel is for.
 *
 * `delay: null` on every `userEvent.setup`, for the reason
 * `EndpointsPanel.test.tsx` measures at length: the default yields a scheduler
 * tick per input step, nothing here asserts on typing timing, and the cost is
 * seconds.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';
import type { ProviderView } from '@/platform/contract';

import { LocalEndpointSection, toolPolicyText } from './LocalEndpointSection';

function providerView(id: string, displayName: string): ProviderView {
  return {
    id,
    displayName,
    kind: 'local',
    // Deliberately not a real protocol id. `wave2/provider-selection` made this
    // field required after this file was written, and the convention the other
    // fixtures follow (`ModelSwitcher.test.tsx:27`, `catalogue.test.ts:31`) is a
    // made-up name — a real one would put a dialect into `src/`, which is what
    // `no-provider-leak.test.ts` exists to keep out.
    protocol: 'someProtocolTheHostNamed',
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelId: null,
    authMode: { type: 'none' },
    authRequirement: 'notRequired',
    auth: { type: 'none' },
    credentialPresent: false,
    credentialCheck: 'satisfiedWithoutCredential',
    credentialFieldLabel: null,
    usable: true,
    security: {
      level: 'none',
      scope: 'loopback',
      leavesDevice: false,
      trafficIsPlaintext: false,
      credentialSentInPlaintext: false,
      credentialInQueryString: false,
      endpointIsUnauthenticated: false,
      concerns: [],
    },
  };
}

const PROVIDERS = [providerView('study-box', 'The workstation in the study')];

function mount(providers: readonly ProviderView[] = PROVIDERS) {
  return render(
    <PlatformProvider adapter={new BrowserAdapter()}>
      <LocalEndpointSection providers={providers} />
    </PlatformProvider>,
  );
}

async function enable(
  user: ReturnType<typeof userEvent.setup>,
  address: string,
  options: { readonly tools?: string; readonly confirm?: boolean } = {},
): Promise<void> {
  const bind = screen.getByLabelText('Listen on');
  await user.clear(bind);
  await user.type(bind, address);
  await user.type(screen.getByLabelText('Key callers must send'), 'sk-vela-test');
  if (options.tools !== undefined) {
    await user.selectOptions(screen.getByLabelText('Tools'), options.tools);
  }
  if (options.confirm === true) {
    await user.click(screen.getByLabelText(/I understand what offering tools means/i));
  }
  await user.click(screen.getByRole('button', { name: 'Enable' }));
}

describe('the local endpoint section', () => {
  it('starts off, says so, and offers no way to stop something that is not running', async () => {
    mount();
    expect(await screen.findByText(/Not serving/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeEnabled();
    // Nothing is prefilled with a key: a switch that opens with a credential in
    // it is a switch that can be thrown by accident.
    expect(screen.getByLabelText('Key callers must send')).toHaveValue('');
  });

  it('will not offer to start a port with nothing behind it', async () => {
    mount([]);
    expect(await screen.findByText(/Not serving/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeDisabled();
    expect(screen.getByText(/Add an endpoint above first/)).toBeInTheDocument();
  });

  it('reports the bound address, the endpoint serving it, and the tool policy', async () => {
    const user = userEvent.setup({ delay: null });
    mount();
    await screen.findByText(/Not serving/);
    await enable(user, '127.0.0.1:0');

    // The port the host chose, not the `0` that was asked for.
    const address = await screen.findByTestId('local-endpoint-address');
    expect(address.textContent ?? '').not.toMatch(/:0$/);
    expect(screen.getByText(/reachable only from this machine/)).toBeInTheDocument();
    // The id, because that is what the host reports back — and the menu above
    // carries both spellings so the two can be matched up.
    expect(screen.getByText('study-box')).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'The workstation in the study (study-box)' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Tools on — only this machine can reach the port/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  it('stops when disabled, and stops offering to stop', async () => {
    const user = userEvent.setup({ delay: null });
    mount();
    await screen.findByText(/Not serving/);
    await enable(user, '127.0.0.1:0');
    await screen.findByTestId('local-endpoint-address');

    await user.click(screen.getByRole('button', { name: 'Disable' }));
    expect(await screen.findByText(/Not serving/)).toBeInTheDocument();
    expect(screen.queryByTestId('local-endpoint-address')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
  });

  /**
   * **The security rule, as a user meets it.** A wildcard bind must be drawn as
   * reachable from the network with tools off, and it must say so without the
   * user having asked anything about tools.
   */
  it('says tools are off on an address the network can reach', async () => {
    const user = userEvent.setup({ delay: null });
    mount();
    await screen.findByText(/Not serving/);
    await enable(user, '0.0.0.0:0');

    await screen.findByTestId('local-endpoint-address');
    expect(screen.getByText(/reachable from your network/)).toBeInTheDocument();
    expect(screen.getByText(/Tools off — this address can be reached/)).toBeInTheDocument();
  });

  it('demands an explicit confirmation before offering tools on an exposed address', async () => {
    const user = userEvent.setup({ delay: null });
    mount();
    await screen.findByText(/Not serving/);
    await enable(user, '0.0.0.0:0', { tools: 'on' });

    const refusal = await screen.findByRole('alert');
    expect(refusal).toHaveTextContent(/Tools off\./);
    expect(refusal).toHaveTextContent(/tick the box below and apply again/);

    // …and taking the user at their word once they answer it.
    await user.click(screen.getByLabelText(/I understand what offering tools means/i));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Tools on — you asked for them.')).toBeInTheDocument();
  });

  it('renders the host refusal rather than guessing at an address itself', async () => {
    const user = userEvent.setup({ delay: null });
    mount();
    await screen.findByText(/Not serving/);
    // `localhost` is a hostname, and the host parses an IP literal and a port.
    // The panel does not know that rule and must not learn it — it submits and
    // shows what came back.
    await enable(user, 'localhost:8034');

    expect(await screen.findByRole('alert')).toHaveTextContent(/host:port/);
    expect(screen.getByText(/Not serving/)).toBeInTheDocument();
  });

  it('words every reason the host can give', () => {
    // The closed set, exhaustively. A code with no sentence would render as
    // nothing at all, which is the state a user cannot act on.
    expect(toolPolicyText(true, 'loopback-default')).toMatch(/Tools on/);
    expect(toolPolicyText(false, 'exposed-default')).toMatch(/Tools off/);
    expect(toolPolicyText(true, 'forced-on')).toMatch(/Tools on/);
    expect(toolPolicyText(false, 'exposed-enable-unconfirmed')).toMatch(/tick the box/);
    expect(toolPolicyText(false, 'forced-off')).toMatch(/Tools off/);
    expect(toolPolicyText(false, null)).toBe('Tools off.');
  });
});
