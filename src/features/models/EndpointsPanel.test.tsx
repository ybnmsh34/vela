/**
 * The endpoint configuration surface.
 *
 * The rule under test throughout: **"no API key" is a first-class valid
 * state.** Most local runtimes have no auth at all, and a settings screen that
 * treats that as a gap tells the majority of Vela's users they have done
 * something wrong.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';

import { EndpointsPanel } from './EndpointsPanel';
import { useProviders } from './use-providers';

function Harness() {
  const providers = useProviders();
  return (
    <EndpointsPanel
      state={providers.state}
      onSave={providers.save}
      onRemove={providers.remove}
      onStoreCredential={providers.storeCredential}
      onClearCredential={providers.clearCredential}
    />
  );
}

function mount(adapter: BrowserAdapter) {
  return render(
    <PlatformProvider adapter={adapter}>
      <Harness />
    </PlatformProvider>,
  );
}

async function addEndpoint(
  user: ReturnType<typeof userEvent.setup>,
  fields: { readonly name: string; readonly address: string; readonly model?: string },
): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Add an endpoint' }));
  await user.type(screen.getByLabelText('Name'), fields.name);
  await user.type(screen.getByLabelText('Address'), fields.address);
  if (fields.model !== undefined) {
    await user.type(screen.getByLabelText(/^Model/), fields.model);
  }
}

describe('adding an endpoint with no authentication', () => {
  it('renders no credential field at all, because there is no credential', async () => {
    // Not an empty optional input. Absent. A field that is rendered and ignored
    // is a question the user still has to answer in their head.
    const user = userEvent.setup();
    mount(new BrowserAdapter());
    await user.click(await screen.findByRole('button', { name: 'Add an endpoint' }));

    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument();
    // And the choice is worded as a choice, not as an absence.
    expect(screen.getByLabelText('Authentication')).toHaveValue('none');
    expect(screen.getByText(/not something left unfinished/i)).toBeInTheDocument();
  });

  it('saves, with no error, no warning badge and no nagging about loopback', async () => {
    const user = userEvent.setup();
    const adapter = new BrowserAdapter();
    mount(adapter);

    await addEndpoint(user, {
      name: 'The workstation',
      address: 'http://127.0.0.1:8080/v1',
      model: 'some-model',
    });
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));

    expect(await screen.findByText('The workstation')).toBeInTheDocument();
    expect(screen.getByText('No key needed')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Plain HTTP to 127.0.0.1 with no credential is the normal, correct way to
    // run a model. Warning here would train the user to ignore the warnings
    // that matter.
    expect(screen.queryByTestId('security-notice')).not.toBeInTheDocument();

    const snapshot = await adapter.invoke('settings_get', {});
    expect(snapshot.providers[0]?.usable).toBe(true);
    expect(snapshot.providers[0]?.credentialCheck).toBe('satisfiedWithoutCredential');
  });

  it('does surface the risk when a keyless endpoint is out on the network', async () => {
    // The signal that matters: reachable by others, no door. The host computes
    // it; this asserts the UI shows it.
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await addEndpoint(user, { name: 'Lab box', address: 'http://192.168.1.50:8080/v1' });
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));

    const notice = await screen.findByTestId('security-notice');
    expect(notice).toHaveTextContent(/takes no credential/i);
    expect(notice).toHaveTextContent(/cross the network in the clear/i);
    // Still usable. A risk is something to tell the user, not a veto.
    expect(screen.getByText('No key needed')).toBeInTheDocument();
  });
});

describe('adding an endpoint that does take a key', () => {
  it('reveals the credential field only once a credential shape is chosen', async () => {
    const user = userEvent.setup();
    mount(new BrowserAdapter());
    await user.click(await screen.findByRole('button', { name: 'Add an endpoint' }));

    expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Authentication'), 'bearerToken');
    expect(screen.getByLabelText('Access token')).toBeInTheDocument();
  });

  it('stores the key out of reach and reports only that one exists', async () => {
    const user = userEvent.setup();
    const adapter = new BrowserAdapter();
    mount(adapter);

    await addEndpoint(user, { name: 'Hosted', address: 'https://api.example.test/v1' });
    await user.selectOptions(screen.getByLabelText('Authentication'), 'bearerToken');
    await user.type(screen.getByLabelText('Access token'), 'sk-live-canary-DO-NOT-LOG');
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));

    expect(await screen.findByText('Key stored')).toBeInTheDocument();
    const snapshot = await adapter.invoke('settings_get', {});
    expect(JSON.stringify(snapshot)).not.toContain('sk-live-canary');
  });

  it('distinguishes "does not insist on one" from "waiting for one"', async () => {
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await addEndpoint(user, { name: 'Optional', address: 'https://api.example.test/v1' });
    await user.selectOptions(screen.getByLabelText('Authentication'), 'bearerToken');
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));
    expect(await screen.findByText(/does not insist on one/i)).toBeInTheDocument();

    // The form stays open after a save and clears its identity fields, so the
    // next endpoint is typed straight into it.
    await user.type(screen.getByLabelText('Name'), 'Strict');
    await user.type(screen.getByLabelText('Address'), 'https://api.example.test/v2');
    await user.click(screen.getByLabelText(/refuses requests without the key/i));
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));

    expect(await screen.findByText('Waiting for a key')).toBeInTheDocument();
  });
});

describe('the endpoint list', () => {
  it('reports the host’s refusal without inventing its own validation', async () => {
    const user = userEvent.setup();
    mount(new BrowserAdapter());

    await addEndpoint(user, { name: 'Broken', address: 'file:///etc/passwd' });
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/baseUrl/);
  });

  it('removes an endpoint and its key together', async () => {
    const user = userEvent.setup();
    const adapter = new BrowserAdapter();
    mount(adapter);

    await addEndpoint(user, { name: 'Temporary', address: 'http://127.0.0.1:9999/v1' });
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));
    await screen.findByText('Temporary');

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(screen.queryByText('Temporary')).not.toBeInTheDocument();
    });
    expect((await adapter.invoke('settings_get', {})).providers).toEqual([]);
  });

  it('names the credential store it is actually using, rather than implying one', async () => {
    mount(new BrowserAdapter());
    expect(await screen.findByText('memory-fake')).toBeInTheDocument();
  });
});
