/**
 * The endpoint configuration surface.
 *
 * The rule under test throughout: **"no API key" is a first-class valid
 * state.** Most local runtimes have no auth at all, and a settings screen that
 * treats that as a gap tells the majority of Vela's users they have done
 * something wrong.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from '@/platform/browser-adapter';
import { PlatformProvider } from '@/platform/PlatformProvider';

import { EndpointsPanel } from './EndpointsPanel';
import { useProviders } from './use-providers';

/**
 * ## Why every `userEvent.setup` here passes `delay: null`
 *
 * `userEvent`'s default is `delay: 0`, which is not "no delay": it yields to the
 * event loop once per simulated input step — per keystroke, and twice more per
 * click for pointer down and up. On Windows a `setTimeout(0)` turn costs one
 * scheduler tick, and this box measures that tick at **14.3–15.1ms** whether the
 * machine is idle or loaded (100 turns: 1490ms idle, 1449/1509/1432ms under
 * three concurrent full `vitest` runs). So the default charges roughly a tick
 * per character to type a URL, and nothing in this file asserts anything about
 * typing *timing* — the delay buys these tests nothing and costs them seconds.
 *
 * Measured on this tree, same box, `https://api.example.test/v1` (27 chars):
 *
 * | | idle | under 3× load |
 * |---|---|---|
 * | `user.type`, default | 18.9 ms/char | 73.8 / 110.1 / 109.5 ms/char |
 * | `user.type`, `delay: null` | 2.2 ms/char | 10.8 / 15.7 / 31.0 ms/char |
 * | ten `user.click` | 584ms | 2894 / 4070 / 2553ms |
 * | ten `user.click`, `delay: null` | 138ms | 619 / 898 / 1276ms |
 *
 * Six of the nine tests this file held at the time failed at least once across
 * six full-suite runs under that load before this change; the two that never
 * did are the two that type nothing, and they pay the same per-click tick.
 * (The count is the file's as it stood then — it has gained tests since, and
 * the measurement was not repeated for them.) A per-test `timeout`
 * override treats the symptom and, worse, raises the ceiling that catches a real
 * hang. `delay: null` removes the cost instead.
 */

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

/**
 * Two endpoints the user called one thing.
 *
 * Seeded through the host rather than typed. `EndpointForm` derives the
 * identifier from the display name but leaves the field editable, so this state
 * is reachable in the shipping UI with no store poke at all — and it is reached
 * that way, through the form, in `src/app/accessible-names.test.tsx`. What is
 * under test here is not how the state is arrived at; it is what one Remove
 * click does once two buttons answer to one name.
 *
 * The identifier is a pure function of the port so a test can name the row it
 * clicked without the row having to display an id.
 */
const TWIN_PORTS = { workstation: 8080, 'study-box': 8081 } as const;

async function twinNamedHost(): Promise<BrowserAdapter> {
  const adapter = new BrowserAdapter();
  for (const [id, port] of Object.entries(TWIN_PORTS)) {
    await adapter.invoke('settings_put_provider', {
      id,
      displayName: 'The workstation',
      kind: 'local',
      baseUrl: `http://127.0.0.1:${String(port)}/v1`,
      modelId: 'local-model',
    });
  }
  return adapter;
}

/** The address stated by the row a given Remove button sits in. */
function addressOf(button: HTMLElement): string {
  const row = button.closest('li');
  if (!(row instanceof HTMLElement)) throw new Error('a Remove button outside any endpoint row');
  const address = within(row).getByText(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u).textContent;
  if (address === null) throw new Error('an endpoint row that states no address');
  return address;
}

/** Which of the two twins an address belongs to. */
function identifierOf(address: string): string {
  const found = Object.entries(TWIN_PORTS).find(([, port]) =>
    address.includes(`:${String(port)}/`),
  );
  if (found === undefined) throw new Error(`no seeded endpoint at ${address}`);
  return found[0];
}

/**
 * A literal, as a pattern. `toHaveAccessibleDescription` takes a string only as
 * an exact whole-description match, and what is wanted here is a substring of a
 * sentence — so the address has to go through a `RegExp`, and an address is full
 * of characters a `RegExp` reads as syntax.
 */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
}

describe('adding an endpoint with no authentication', () => {
  it('renders no credential field at all, because there is no credential', async () => {
    // Not an empty optional input. Absent. A field that is rendered and ignored
    // is a question the user still has to answer in their head.
    const user = userEvent.setup({ delay: null });
    mount(new BrowserAdapter());
    await user.click(await screen.findByRole('button', { name: 'Add an endpoint' }));

    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument();
    // And the choice is worded as a choice, not as an absence.
    expect(screen.getByLabelText('Authentication')).toHaveValue('none');
    expect(screen.getByText(/not something left unfinished/i)).toBeInTheDocument();
  });

  it('saves, with no error, no warning badge and no nagging about loopback', async () => {
    const user = userEvent.setup({ delay: null });
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
    const user = userEvent.setup({ delay: null });
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
    const user = userEvent.setup({ delay: null });
    mount(new BrowserAdapter());
    await user.click(await screen.findByRole('button', { name: 'Add an endpoint' }));

    expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Authentication'), 'bearerToken');
    expect(screen.getByLabelText('Access token')).toBeInTheDocument();
  });

  it('stores the key out of reach and reports only that one exists', async () => {
    const user = userEvent.setup({ delay: null });
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

  // This case types two whole endpoints, 68 characters in all, and it used to
  // carry `{ timeout: 10_000 }`. The override did not work: across six
  // full-suite runs under three concurrent `vitest` runs it failed 6/6 anyway —
  // four times by running past the ten seconds (10007, 10048, 10076ms) and twice
  // by exhausting `findByText`'s own one-second budget at 4232 and 4702ms. A
  // ceiling raised to cover a cost that scales with the load is a ceiling that
  // will be raised again; it also stops the suite noticing a real hang for twice
  // as long. The cost is removed at source instead (see `delay: null` above),
  // which puts this test back under the 5000ms default with room to spare.
  it('distinguishes "does not insist on one" from "waiting for one"', async () => {
    const user = userEvent.setup({ delay: null });
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
    const user = userEvent.setup({ delay: null });
    mount(new BrowserAdapter());

    await addEndpoint(user, { name: 'Broken', address: 'file:///etc/passwd' });
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/baseUrl/);
  });

  it('removes an endpoint and its key together, once the question is answered', async () => {
    const user = userEvent.setup({ delay: null });
    const adapter = new BrowserAdapter();
    mount(adapter);

    await addEndpoint(user, { name: 'Temporary', address: 'http://127.0.0.1:9999/v1' });
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));
    await screen.findByText('Temporary');

    // Named for the row it deletes. Bare `Remove` was one name shared by every
    // configured endpoint's delete button.
    await user.click(screen.getByRole('button', { name: 'Remove: Temporary' }));
    await user.click(await screen.findByRole('button', { name: 'Remove this endpoint' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect((await adapter.invoke('settings_get', {})).providers).toEqual([]);
  });

  it('asks before it removes, and destroys nothing while the question is up', async () => {
    // The property the rename could not buy. `Remove: <endpoint>` makes the two
    // rows of a two-endpoint panel distinguishable *by name*; it cannot make
    // two rows the user called the same thing distinguishable, because the text
    // inside the name is theirs. What survives that is the consequence: this
    // click asks, and a wrong landing costs a Cancel.
    const user = userEvent.setup({ delay: null });
    const adapter = new BrowserAdapter();
    mount(adapter);

    await addEndpoint(user, { name: 'Temporary', address: 'http://127.0.0.1:9999/v1' });
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));
    await screen.findByText('Temporary');

    await user.click(screen.getByRole('button', { name: 'Remove: Temporary' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Remove this endpoint?' });
    // Nothing is gone yet, and the keyboard is on the safe control.
    expect((await adapter.invoke('settings_get', {})).providers).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    // The two fields that differ when two endpoints share a display name. The
    // dialog is the only place either of them is stated at the moment of the
    // decision.
    expect(dialog).toHaveTextContent('http://127.0.0.1:9999/v1');
    expect(dialog).toHaveTextContent('temporary');
    // And they are *announced*, not merely present: the paragraph is the
    // dialog's `aria-describedby` target, so a screen reader reads it on open
    // rather than leaving it to be found. Without this assertion the id on that
    // paragraph would be a write nothing reads.
    expect(dialog).toHaveAccessibleDescription(/http:\/\/127\.0\.0\.1:9999\/v1/u);
    expect(dialog).toHaveAccessibleDescription(/identified as temporary/u);
    // The keyless branch of the credential sentence. It is the one fact on this
    // screen that is not on the screen behind it, so it is the reason the dialog
    // exists at all — and until this assertion existed it was a string nothing
    // read: garbling it left the whole suite green.
    expect(dialog).toHaveAccessibleDescription(/No key is stored for it\./u);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect((await adapter.invoke('settings_get', {})).providers).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove: Temporary' })).toBeInTheDocument();
  });

  it('takes Escape as the answer no, and destroys nothing', async () => {
    // The dialog's own `onKeyDown` handles this; `ModalSurface` has no Escape
    // branch of its own (`grep -n Escape src/components/ModalSurface.tsx` is
    // empty). So without this test the branch is a write nothing reads —
    // measured, twice: disabling it left five test files at 59 passed, exit 0.
    const user = userEvent.setup({ delay: null });
    const adapter = new BrowserAdapter();
    mount(adapter);

    await addEndpoint(user, { name: 'Temporary', address: 'http://127.0.0.1:9999/v1' });
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));
    await screen.findByText('Temporary');

    await user.click(screen.getByRole('button', { name: 'Remove: Temporary' }));
    await screen.findByRole('alertdialog', { name: 'Remove this endpoint?' });

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect((await adapter.invoke('settings_get', {})).providers).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove: Temporary' })).toBeInTheDocument();
  });

  it('says what becomes of the stored key, in the words the dialog exists for', async () => {
    // The other branch of the same sentence. A schedule gets no dialog because
    // it is re-creatable from what is on screen; an endpoint is too, *except*
    // its credential, which `use-providers.storeCredential` can never read back.
    // That asymmetry is the whole argument in `RemoveEndpointDialog`'s docblock
    // for why this row asks and that row does not, and it was carried entirely
    // by a string with no reader.
    const user = userEvent.setup({ delay: null });
    const adapter = new BrowserAdapter();
    mount(adapter);

    await addEndpoint(user, { name: 'Hosted', address: 'https://api.example.test/v1' });
    await user.selectOptions(screen.getByLabelText('Authentication'), 'bearerToken');
    await user.type(screen.getByLabelText('Access token'), 'sk-live-canary-DO-NOT-LOG');
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));
    await screen.findByText('Key stored');

    await user.click(screen.getByRole('button', { name: 'Remove: Hosted' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove this endpoint?' });

    expect(dialog).toHaveAccessibleDescription(/The key stored for it is deleted with it/u);
    expect(dialog).toHaveAccessibleDescription(/cannot read a stored key back/u);
    // Stating that a key exists is not the same as showing it, and the dialog
    // does the first only.
    expect(dialog).not.toHaveTextContent('sk-live-canary');
  });

  it('asks about the row that was clicked, not the first row that answers to its name', async () => {
    // The property this dialog was added for, and the one thing nothing in the
    // tree guarded: with two rows the user called one thing, the question must
    // name — and the confirm must destroy — the row whose button was pressed.
    // Measured before this test existed: changing `onConfirm` to remove
    // `state.providers[0].id` instead of the clicked target left the full suite
    // at 2427 passed, exit 0. So the click below is deliberately the *second*
    // rendered row, and both the address it names and the address that survives
    // are read off the DOM rather than off the seed — a test that assumed an
    // order would start agreeing with that mutation the day the order changed.
    const user = userEvent.setup({ delay: null });
    const adapter = await twinNamedHost();
    mount(adapter);

    const buttons = await screen.findAllByRole('button', { name: 'Remove: The workstation' });
    expect(buttons).toHaveLength(2);
    const [firstRow, secondRow] = buttons;
    if (firstRow === undefined || secondRow === undefined) {
      throw new Error('two rows share this name or the premise of this test is gone');
    }

    const clicked = addressOf(secondRow);
    const untouched = addressOf(firstRow);
    expect(clicked).not.toBe(untouched);

    await user.click(secondRow);
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove this endpoint?' });

    // The address and the identifier of the row that was pressed, and not the
    // other one's — announced, not merely present.
    expect(dialog).toHaveAccessibleDescription(new RegExp(escapeForRegExp(clicked), 'u'));
    expect(dialog).toHaveAccessibleDescription(
      new RegExp(`identified as ${escapeForRegExp(identifierOf(clicked))}`, 'u'),
    );
    expect(dialog.textContent ?? '').not.toContain(untouched);

    await user.click(within(dialog).getByRole('button', { name: 'Remove this endpoint' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    const left = (await adapter.invoke('settings_get', {})).providers;
    expect(left.map((view) => view.baseUrl)).toEqual([untouched]);
    expect(left.map((view) => view.id)).toEqual([identifierOf(untouched)]);
    expect(screen.getAllByRole('button', { name: 'Remove: The workstation' })).toHaveLength(1);
  });

  it('names the credential store it is actually using, rather than implying one', async () => {
    mount(new BrowserAdapter());
    expect(await screen.findByText('memory-fake')).toBeInTheDocument();
  });
});
