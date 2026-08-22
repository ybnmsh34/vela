import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderView, SecurityPosture } from '@/platform/contract';

import { ModelSwitcher } from './ModelSwitcher';
import { modelEntries } from './catalogue';

const QUIET: SecurityPosture = {
  level: 'none',
  scope: 'loopback',
  leavesDevice: false,
  trafficIsPlaintext: true,
  credentialSentInPlaintext: false,
  credentialInQueryString: false,
  endpointIsUnauthenticated: true,
  concerns: [],
};

function view(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: 'workstation',
    displayName: 'The workstation',
    kind: 'local',
    // An opaque token the host chose; this feature only ever carries it.
    protocol: 'someProtocolTheHostNamed',
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelId: 'some-model',
    auth: { type: 'none' },
    authRequirement: 'notRequired',
    credentialPresent: false,
    usable: true,
    credentialCheck: 'satisfiedWithoutCredential',
    authMode: { type: 'none' },
    credentialFieldLabel: null,
    security: QUIET,
    ...overrides,
  };
}

describe('ModelSwitcher', () => {
  it('says which model is active without opening anything', () => {
    render(
      <ModelSwitcher
        entries={modelEntries([view()])}
        selection={{
          providerId: 'workstation',
          modelId: 'some-model',
          providerLabel: 'The workstation',
          modelLabel: 'some-model',
        }}
        hasHistory={false}
        onSelect={() => undefined}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'The workstation · some-model' }),
    ).toBeInTheDocument();
  });

  it('asks for a model when none is chosen', () => {
    render(
      <ModelSwitcher entries={[]} selection={null} hasHistory={false} onSelect={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: 'Choose a model' })).toBeInTheDocument();
  });

  it('lists an unusable endpoint, unselectable, with the reason on the row', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ModelSwitcher
        entries={modelEntries([
          view({ usable: false, credentialCheck: 'missingRequired', credentialFieldLabel: 'API key' }),
        ])}
        selection={null}
        hasHistory={false}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Choose a model' }));
    const option = screen.getByRole('option', { name: /some-model/ });
    expect(option).toBeDisabled();
    expect(option).toHaveTextContent('Needs a key before it can be used');

    await user.click(option);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('tells the truth about an empty configuration instead of showing a blank list', async () => {
    const user = userEvent.setup();
    render(
      <ModelSwitcher entries={[]} selection={null} hasHistory={false} onSelect={() => undefined} />,
    );
    await user.click(screen.getByRole('button', { name: 'Choose a model' }));
    expect(screen.getByText(/No endpoints configured yet/i)).toBeInTheDocument();
  });

  it('passes the conversation state through to the switch, so consequences can be stated', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ModelSwitcher
        entries={modelEntries([view()])}
        selection={null}
        hasHistory
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Choose a model' }));
    await user.click(screen.getByRole('option', { name: /some-model/ }));

    expect(onSelect).toHaveBeenCalledWith(
      {
        providerId: 'workstation',
        modelId: 'some-model',
        providerLabel: 'The workstation',
        modelLabel: 'some-model',
      },
      true,
    );
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <ModelSwitcher
        entries={modelEntries([view()])}
        selection={null}
        hasHistory={false}
        onSelect={() => undefined}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Choose a model' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
