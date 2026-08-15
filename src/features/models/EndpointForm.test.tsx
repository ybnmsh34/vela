/**
 * The protocol chooser, and the rule it is most likely to break.
 *
 * An endpoint's wire dialect is the one piece of backend identity a user has to
 * be able to state, because the address does not say it and Vela is not allowed
 * to guess (`docs/architecture/conventions.md` §0.3: the UI branches on
 * capability flags, never on a backend identity, and adding a backend must
 * require zero changes under `src/`).
 *
 * The shape that satisfies both halves is: the host sends a list, this form
 * renders it, and the renderer never learns a name. These tests hold that down
 * from both directions — that every word on screen came off the wire, and that
 * whichever entry was chosen goes back out verbatim.
 *
 * Scope note: `EndpointsPanel.test.tsx` is claimed by another session in
 * `docs/desktop-gate/OWNERSHIP.md`, so the chooser is tested at the form rather
 * than through the panel. The panel's job here is one prop, forwarded twice.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type {
  ProviderView,
  SecurityPosture,
  SettingsPutProviderReq,
  WireProtocolOption,
} from '@/platform/contract';

import { EndpointForm } from './EndpointForm';

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

/**
 * Three options with **invented** ids and labels.
 *
 * Deliberately not the host's real ones. If this fixture had to spell what the
 * host actually offers, the test would be asserting that the renderer knows the
 * catalogue — which is the opposite of the property. Nonsense ids passing
 * through unchanged is the proof that nothing here reads them.
 */
const OFFERED: readonly WireProtocolOption[] = [
  { id: 'firstThingTheHostListed', label: 'The first thing', summary: 'What the host said first.' },
  { id: 'secondThing', label: 'The second thing', summary: 'What the host said second.' },
  { id: 'thirdThing', label: 'The third thing', summary: 'What the host said third.' },
];

function view(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: 'workstation',
    displayName: 'The workstation',
    kind: 'local',
    protocol: 'secondThing',
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

function chooser(): HTMLSelectElement {
  return screen.getByLabelText('What it speaks') as HTMLSelectElement;
}

describe('the protocol chooser is drawn from the host and never from here', () => {
  it('offers exactly what the host listed, in the order the host listed it', () => {
    render(<EndpointForm protocols={OFFERED} onSave={vi.fn()} />);

    const options = [...chooser().options];
    expect(options.map((option) => option.value)).toEqual(OFFERED.map((choice) => choice.id));
    expect(options.map((option) => option.textContent)).toEqual(
      OFFERED.map((choice) => choice.label),
    );
    // Not "an option per entry, plus a blank one Vela added": a chooser with a
    // meaningless row in it is a question the user cannot answer.
    expect(options).toHaveLength(OFFERED.length);
  });

  it('shows the host words for whichever entry is selected', () => {
    render(<EndpointForm protocols={OFFERED} onSave={vi.fn()} />);
    expect(screen.getByText(OFFERED[0]!.summary)).toBeInTheDocument();

    fireEvent.change(chooser(), { target: { value: 'thirdThing' } });
    expect(screen.getByText(OFFERED[2]!.summary)).toBeInTheDocument();
  });

  it('sends back the entry the user picked, verbatim', async () => {
    const onSave = vi.fn<(config: SettingsPutProviderReq) => Promise<unknown>>(() =>
      Promise.resolve(undefined),
    );
    render(<EndpointForm protocols={OFFERED} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Study box' } });
    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: 'http://127.0.0.1:8080/v1' },
    });
    fireEvent.change(chooser(), { target: { value: 'thirdThing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave.mock.calls[0]![0].protocol).toBe('thirdThing');
  });

  it('opens a new endpoint on whatever the host put first, not on a name of its own', async () => {
    // Which protocol is the safe starting point is a question about what Vela
    // can build, so the host answers it by ordering the list. A default written
    // here would be a second opinion, and the wrong one the moment the host's
    // list changes.
    const onSave = vi.fn<(config: SettingsPutProviderReq) => Promise<unknown>>(() =>
      Promise.resolve(undefined),
    );
    render(<EndpointForm protocols={OFFERED} onSave={onSave} />);
    expect(chooser().value).toBe(OFFERED[0]!.id);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Study box' } });
    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: 'http://127.0.0.1:8080/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave.mock.calls[0]![0].protocol).toBe(OFFERED[0]!.id);
  });

  it('opens an existing endpoint on its own protocol rather than resetting it', async () => {
    // The failure this pins is silent and destructive: open an endpoint to fix
    // a typo in its name, and saving quietly repoints it at a different dialect
    // because the form reset the chooser to the top of the list.
    const onSave = vi.fn<(config: SettingsPutProviderReq) => Promise<unknown>>(() =>
      Promise.resolve(undefined),
    );
    render(<EndpointForm editing={view()} protocols={OFFERED} onSave={onSave} />);
    expect(chooser().value).toBe('secondThing');

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave.mock.calls[0]![0].protocol).toBe('secondThing');
  });

  it('draws no chooser at all when the host offered nothing, and claims nothing on the wire', async () => {
    // A host older than this renderer sends no list. An empty dropdown would be
    // a question with no answers; sending a protocol Vela made up would be
    // worse, because the host's own default is the right answer and this layer
    // does not know what it is.
    const onSave = vi.fn<(config: SettingsPutProviderReq) => Promise<unknown>>(() =>
      Promise.resolve(undefined),
    );
    render(<EndpointForm onSave={onSave} />);
    expect(screen.queryByLabelText('What it speaks')).toBeNull();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Study box' } });
    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: 'http://127.0.0.1:8080/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('protocol');
  });
});

/**
 * The §0.3 guard for this field specifically.
 *
 * `src/platform/no-provider-leak.test.ts` already forbids vendor *names* in
 * renderer source, and it would catch `protocol === 'anthropicMessages'`
 * because of the substring. It would **not** catch `protocol === 'someName'`
 * for a protocol whose id happens to contain no vendor word — and the shape,
 * not the spelling, is what the rule is about. That file is claimed by another
 * session in `docs/desktop-gate/OWNERSHIP.md`, so the narrower guard lives here
 * next to the feature it is about.
 */
describe('no renderer file decides anything from which protocol it is', () => {
  const REPO_ROOT = process.cwd();
  const ROOTS = [join(REPO_ROOT, 'src', 'features', 'models'), join(REPO_ROOT, 'src', 'platform')];

  /**
   * `URL.protocol` is the *scheme* — `http:` / `https:` — and the renderer is
   * not merely allowed to branch on that, it is required to: refusing `file:`
   * and telling the user their traffic is plaintext are both scheme decisions.
   * A different thing that happens to share a word.
   *
   * Found by this guard failing on three real lines in `browser-adapter.ts` the
   * first time it ran, which is also the answer to whether it looks at anything.
   */
  const isUrlScheme = (line: string): boolean => /\w*[Uu]rl\s*\.\s*protocol\b/.test(line);

  /** A wire-protocol id tested against a literal, or used as a lookup key. */
  const inspects = (line: string): boolean =>
    !isUrlScheme(line) &&
    (/\bprotocol\b\s*(?:===|!==)\s*['"`]/.test(line) ||
      /['"`]\s*(?:===|!==)\s*\bprotocol\b/.test(line) ||
      /\[\s*\w*\.?\bprotocol\b\s*\]/.test(line) ||
      /\bprotocol\b\s*\.\s*(?!length\b|trim\b)\w/.test(line));

  function sourceFiles(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...sourceFiles(path));
      else if (['.ts', '.tsx'].includes(extname(entry.name))) found.push(path);
    }
    return found;
  }

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  }

  it('never compares one to a literal or indexes anything with one', () => {
    const offenders = ROOTS.flatMap(sourceFiles)
      .filter((path) => !/\.test\.[a-z]+$/.test(path))
      .flatMap((path) =>
        stripComments(readFileSync(path, 'utf8'))
          .split('\n')
          .map((line, index) => ({ line: line.trim(), number: index + 1 }))
          .filter(({ line }) => inspects(line))
          .map(({ line, number }) => `${relative(REPO_ROOT, path)}:${number} — ${line}`),
      );

    expect(
      offenders,
      'a protocol id is a token the renderer carries; deciding anything from which one it is ' +
        'is the branch on backend identity §0.3 forbids',
    ).toEqual([]);
  });

  it('the guard catches what it is for, and leaves the vocabulary alone', () => {
    expect(inspects("if (protocol === 'anthropicMessages') return <Special />;")).toBe(true);
    expect(inspects("if ('openAiCompatible' !== protocol) hide();")).toBe(true);
    expect(inspects('const icon = ICONS[view.protocol];')).toBe(true);
    expect(inspects('const family = protocol.split("-")[0];')).toBe(true);

    // …and stays quiet on everything the feature is actually built out of.
    expect(inspects('readonly protocol?: WireProtocolId;')).toBe(false);
    expect(inspects('protocols.find((choice) => choice.id === protocol)')).toBe(false);
    expect(inspects('setProtocol(event.target.value);')).toBe(false);
    expect(inspects('...(protocol === null ? {} : { protocol }),')).toBe(false);

    // …and stays off the URL scheme, which is a different thing with the same
    // word and one the renderer must go on branching on.
    expect(inspects("if (url.protocol !== 'http:' && url.protocol !== 'https:') {")).toBe(false);
    expect(inspects("const trafficIsPlaintext = url.protocol === 'http:';")).toBe(false);
    expect(inspects("const scheme = endpointUrl.protocol.replace(':', '');")).toBe(false);
    // The exemption is narrow: it is about a parsed URL, not about the word.
    expect(inspects("if (view.protocol === 'somethingTheHostNamed') return null;")).toBe(true);
  });
});
