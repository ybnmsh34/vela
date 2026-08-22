/**
 * **Does a staged file actually reach the wire?**
 *
 * ## Why this file exists, separately from every other attachment test
 *
 * The attachment feature had a hook that staged files, a picker that could not
 * be reached without the vision capability, a tray that listed what was staged,
 * and `toContentParts()` — all built, all tested. The IPC boundary had
 * `ChatMessageInput.parts` and a `ContentPartDto` that carries an image, proved
 * against a real llama.cpp in GATE M Part 2. Both halves worked.
 *
 * Nothing joined them. `useSelectedModel().attachments` was read by nobody, so
 * pressing Send discarded the user's picture without a word. Every test that
 * existed passed, because every test asked a component about its own state:
 * "did the hook stage it", "did the tray show it", "does `toContentParts`
 * produce a part". None asked the only question that matters — *is it in the
 * payload* — and that question can only be asked from outside.
 *
 * So these tests render the real `<App/>`, click the real attach control, and
 * read the argument the renderer handed the host. The assertion is on the
 * outgoing `chat_send` request and nothing else. A component's internal state
 * is not evidence.
 *
 * **Honesty (conventions §10): VERIFIED-BY-FAKE.** The host is
 * `BrowserAdapter`. What is proved is that the renderer's parts are connected
 * to each other and that the payload has the shape the Rust host validates —
 * `BrowserAdapter` mirrors `src-tauri/src/ipc/content.rs`'s rules, so a byte
 * array where base64 belongs is refused here exactly as the host refuses it.
 * Nothing here proves anything about a real endpoint.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@/app/App';
import { BrowserAdapter } from '@/platform/browser-adapter';
import {
  NO_CAPABILITIES,
  type ChatSendReq,
  type CommandName,
  type CommandReq,
  type CommandRes,
  type ModelCapabilityReport,
} from '@/platform/contract';
import { resetModelStore } from '@/state/model-store';
import { resetNavigationStore } from '@/state/navigation-store';

/**
 * A PNG header, byte for byte, and its standard base64 — written out rather
 * than computed, so this test does not agree with the code under test by using
 * the same encoder it uses.
 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUg==';

/**
 * The real fake host, with one addition: it keeps the requests it was given.
 * A subclass rather than a mock — every command still runs the fake's own
 * validation, so a payload this test calls "sent" is one the host accepted.
 */
class RecordingHost extends BrowserAdapter {
  readonly sent: ChatSendReq[] = [];

  override async invoke<C extends CommandName>(
    command: C,
    payload: CommandReq<C>,
  ): Promise<CommandRes<C>> {
    if (command === 'chat_send') this.sent.push(payload as ChatSendReq);
    return super.invoke(command, payload);
  }
}

function report(vision: boolean): ModelCapabilityReport {
  return {
    providerId: 'workstation',
    modelId: 'local-model',
    capabilities: { ...NO_CAPABILITIES, streaming: true, vision },
    structuredOutput: false,
    toolCallsEmulated: false,
    contextWindowTokens: 200_000,
    maxOutputTokens: null,
    probed: true,
    findings: [],
  };
}

async function host(vision = true): Promise<RecordingHost> {
  const adapter = new RecordingHost();
  await adapter.invoke('settings_put_provider', {
    id: 'workstation',
    displayName: 'The workstation',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelId: 'local-model',
  });
  adapter.seedCapabilities(report(vision));
  return adapter;
}

function composer(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Message' });
}

async function openConversation(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Start a conversation' }));
  await screen.findByRole('region', { name: 'Conversation' });
}

function imageFile(name = 'shot.png'): File {
  return new File([PNG_BYTES], name, { type: 'image/png' });
}

function textFile(name = 'notes.md', body = 'the body'): File {
  return new File([body], name, { type: 'text/markdown' });
}

/** The user message this turn — the one carrying whatever was staged. */
function lastUserMessage(sent: readonly ChatSendReq[]) {
  const request = sent[sent.length - 1];
  const messages = request?.messages ?? [];
  return [...messages].reverse().find((message) => message.role === 'user');
}

beforeEach(() => {
  resetModelStore();
  resetNavigationStore();
});

describe('a staged file reaches the payload', () => {
  it('puts a staged image in the outgoing chat_send request', async () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // Stage a picture through the shipping affordance, press Send, and read
    // the bytes off the request the host was handed. Nothing about the
    // composer's state, the hook's state or the tray's contents is asserted:
    // those all passed while this silently dropped the file.
    const user = userEvent.setup();
    const adapter = await host();
    render(<App adapter={adapter} />);
    await openConversation(user);

    await user.upload(await screen.findByTestId('attachment-picker-with-images'), imageFile());
    // The tray is the user's evidence it was staged; the payload is the proof
    // it was sent. This waits for the first only so the click below is not a
    // race.
    await screen.findByTestId('attachment-tray');

    await user.click(composer());
    await user.paste('what is in this picture?');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(adapter.sent).toHaveLength(1);
    });

    const message = lastUserMessage(adapter.sent);
    expect(message?.text).toBe('what is in this picture?');
    expect(message?.parts).toEqual([
      { kind: 'image', mimeType: 'image/png', data: PNG_BASE64 },
    ]);
  });

  it('puts a staged text file in the payload too, alongside an image', async () => {
    // The regression critic staged both. Both must arrive, in the order they
    // were staged, and the text one has to be named — a model handed bare file
    // contents cannot tell them from the question.
    const user = userEvent.setup();
    const adapter = await host();
    render(<App adapter={adapter} />);
    await openConversation(user);

    await user.upload(await screen.findByTestId('attachment-picker-with-images'), [
      textFile(),
      imageFile(),
    ]);
    await screen.findByTestId('attachment-tray');

    await user.click(composer());
    await user.paste('read these');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(adapter.sent).toHaveLength(1);
    });

    expect(lastUserMessage(adapter.sent)?.parts).toEqual([
      { kind: 'text', text: 'Attached file: notes.md\n\nthe body' },
      { kind: 'image', mimeType: 'image/png', data: PNG_BASE64 },
    ]);
  });

  it('sends a text file on a model with no vision, where that is the only picker', async () => {
    // A text file is inlined as prompt text, so it is never gated on vision.
    // The affordance that exists on a text-only model must work as completely
    // as the one that only appears with vision.
    const user = userEvent.setup();
    const adapter = await host(false);
    render(<App adapter={adapter} />);
    await openConversation(user);

    await user.upload(await screen.findByTestId('attachment-picker-text-only'), textFile());
    await screen.findByTestId('attachment-tray');

    await user.click(composer());
    await user.paste('summarise it');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(adapter.sent).toHaveLength(1);
    });
    expect(lastUserMessage(adapter.sent)?.parts).toEqual([
      { kind: 'text', text: 'Attached file: notes.md\n\nthe body' },
    ]);
  });

  it('empties the tray once the bytes are on their way, and not before', async () => {
    // The staged file is consumed by the turn it was sent with. Leaving it
    // staged would attach it again to every later message; clearing it before
    // the read finished would lose it if the read failed.
    const user = userEvent.setup();
    const adapter = await host();
    render(<App adapter={adapter} />);
    await openConversation(user);

    await user.upload(await screen.findByTestId('attachment-picker-with-images'), imageFile());
    await screen.findByTestId('attachment-tray');

    await user.click(composer());
    await user.paste('one');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(adapter.sent).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('attachment-tray')).not.toBeInTheDocument();
    });

    await user.click(composer());
    await user.paste('two');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(adapter.sent).toHaveLength(2);
    });
    // The second turn carries the first turn's image in its *history* — the
    // conversation is replayed — but its own new message carries nothing.
    const second = adapter.sent[1];
    const newest = second?.messages[second.messages.length - 1];
    expect(newest).toEqual({ role: 'user', text: 'two' });
    expect(
      second?.messages.some((message) =>
        (message.parts ?? []).some((part) => part.kind === 'image'),
      ),
    ).toBe(true);
  });

  it('tells the user when a staged file could not be read, and sends nothing', async () => {
    // Silent discard is the worst available behaviour: worse than a disabled
    // button, worse than an error. A file that cannot be read stops the turn
    // and says which file — and stays staged, so the user can retry or remove
    // it rather than reconstructing what they had attached.
    const user = userEvent.setup();
    const adapter = await host();
    render(<App adapter={adapter} />);
    await openConversation(user);

    const unreadable = imageFile('broken.png');
    Object.defineProperty(unreadable, 'arrayBuffer', {
      value: () => Promise.reject(new Error('the disk went away')),
    });

    await user.upload(await screen.findByTestId('attachment-picker-with-images'), unreadable);
    await screen.findByTestId('attachment-tray');

    await user.click(composer());
    await user.paste('look at this');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/broken\.png/);
    expect(adapter.sent).toHaveLength(0);
    // Still staged: nothing was thrown away behind the user's back.
    expect(screen.getByTestId('attachment-tray')).toBeInTheDocument();
  });
});

describe('every attach affordance in the app is a real one', () => {
  it('stages and sends through the composer button, which used to do nothing at all', async () => {
    // ── THE SECOND HALF OF THE SAME DEFECT ─────────────────────────────────
    // `Composer.tsx` rendered an image button with **no `onClick`**. It opened
    // no picker, staged nothing and sent nothing, while sitting exactly where a
    // user looks for the paperclip. A control that looks like the route to
    // something and is not costs the user the thing they were trying to do.
    //
    // Driven the whole way: pick a file through the composer's own input, then
    // read the bytes off the outgoing request.
    const user = userEvent.setup();
    const adapter = await host();
    render(<App adapter={adapter} />);
    await openConversation(user);

    // The button opens the picker. Asserted directly, because "no handler at
    // all" is precisely what was wrong with it, and a test that drives the
    // hidden input instead would have passed against the broken version — as
    // this one did, until the control run caught it.
    const picker = await screen.findByTestId('composer-attachment-picker');
    const opened = vi.fn();
    picker.addEventListener('click', opened);
    await user.click(screen.getByRole('button', { name: 'Attach an image' }));
    expect(opened).toHaveBeenCalled();

    await user.upload(picker, imageFile());
    // It stages into the same holder the model bar and the drop zone use —
    // one tray, one list, one thing that gets sent.
    await screen.findByTestId('attachment-tray');

    await user.click(composer());
    await user.paste('through the composer');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(adapter.sent).toHaveLength(1);
    });
    expect(lastUserMessage(adapter.sent)?.parts).toEqual([
      { kind: 'image', mimeType: 'image/png', data: PNG_BASE64 },
    ]);
  });

  it('offers the composer picker only where the capability is, and never as a dead control', async () => {
    // The invariant that already held and must keep holding: no vision, no
    // image affordance in the DOM at all. And where it is in the DOM, it has a
    // picker behind it with a real accept list — not a button that opens
    // nothing.
    const user = userEvent.setup();
    render(<App adapter={await host(false)} />);
    await openConversation(user);

    expect(screen.queryByRole('button', { name: 'Attach an image' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('composer-attachment-picker')).not.toBeInTheDocument();
  });

  it('gives the composer picker the same accept list the staging rules enforce', async () => {
    const user = userEvent.setup();
    render(<App adapter={await host()} />);
    await openConversation(user);

    const picker = await screen.findByTestId('composer-attachment-picker');
    // Published by the holder, so a second picker cannot offer a type the
    // rules would then refuse — which reads to the user as a broken file.
    expect(picker.getAttribute('accept')).toMatch(/image\/png/);
    expect(picker.getAttribute('accept')).toMatch(/\.md/);
  });
});
