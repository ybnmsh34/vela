/**
 * Staging files: the picker, the drop zone, the tray, and the capability gate
 * that decides whether images are reachable by any of them.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentControls } from './AttachmentControls';
import { AttachmentDropZone } from './AttachmentDropZone';
import { AttachmentTray } from './AttachmentTray';
import { useAttachments, type AttachmentsController } from './use-attachments';

/**
 * jsdom implements neither object URLs nor `DataTransfer`. Both are stubbed so
 * the *component's* behaviour is what is under test, not the environment's.
 */
beforeEach(() => {
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:vela/preview'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function textFile(name = 'notes.md', body = 'hello'): File {
  return new File([body], name, { type: 'text/markdown' });
}

function imageFile(name = 'shot.png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

interface HarnessProps {
  readonly vision: boolean;
}

function Harness({ vision }: HarnessProps) {
  const attachments = useAttachments({ vision });
  return (
    <div>
      <AttachmentControls
        vision={vision}
        onFiles={(files) => {
          attachments.add(files);
        }}
      />
      <AttachmentDropZone
        vision={vision}
        onFiles={(files) => {
          attachments.add(files);
        }}
      >
        <p>transcript</p>
      </AttachmentDropZone>
      <AttachmentTray
        attachments={attachments.attachments}
        refused={attachments.refused}
        onRemove={attachments.remove}
        onDismissRefusals={attachments.dismissRefusals}
      />
    </div>
  );
}

/** Fires a drop carrying files, since jsdom has no DataTransfer to build. */
function dropFiles(target: HTMLElement, files: readonly File[]): void {
  const dataTransfer = { files, items: files, types: ['Files'], dropEffect: 'none' };
  fireEvent.drop(target, { dataTransfer });
}

describe('AttachmentControls', () => {
  it('renders no image affordance whatsoever without vision', () => {
    render(<AttachmentControls vision={false} onFiles={() => undefined} />);

    expect(screen.queryByTestId('attach-image')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /image/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('attachment-picker-with-images')).not.toBeInTheDocument();
    // Not a disabled control either: nothing to click, nothing to be refused by.
    expect(screen.getByRole('button', { name: 'Attach a text file' })).toBeEnabled();
  });

  it('does not even let the OS picker show images without vision', () => {
    render(<AttachmentControls vision={false} onFiles={() => undefined} />);
    const accept = screen.getByTestId('attachment-picker-text-only').getAttribute('accept') ?? '';
    expect(accept).not.toMatch(/image\//);
    expect(accept).toMatch(/\.md/);
  });

  it('offers images once the capability struct says so', () => {
    render(<AttachmentControls vision onFiles={() => undefined} />);
    expect(screen.getByTestId('attach-image')).toBeInTheDocument();
    expect(
      screen.getByTestId('attachment-picker-with-images').getAttribute('accept'),
    ).toMatch(/image\/png/);
  });

  it('hands the chosen files up and clears itself so the same file can be picked twice', async () => {
    const onFiles = vi.fn();
    const user = userEvent.setup();
    render(<AttachmentControls vision onFiles={onFiles} />);

    const input = screen.getByTestId('attachment-picker-with-images') as HTMLInputElement;
    await user.upload(input, textFile());

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('');
  });
});

describe('staging', () => {
  it('shows a preview, a size and a way to take it back out', async () => {
    const user = userEvent.setup();
    render(<Harness vision />);

    await user.upload(screen.getByTestId('attachment-picker-with-images'), imageFile());

    expect(await screen.findByAltText('Preview of shot.png')).toHaveAttribute(
      'src',
      'blob:vela/preview',
    );
    await user.click(screen.getByRole('button', { name: 'Remove shot.png' }));
    await waitFor(() => {
      expect(screen.queryByAltText('Preview of shot.png')).not.toBeInTheDocument();
    });
  });

  it('accepts a drop onto the conversation region', async () => {
    render(<Harness vision />);
    dropFiles(screen.getByTestId('attachment-drop-zone'), [textFile('log.txt')]);

    expect(await screen.findByText('log.txt')).toBeInTheDocument();
  });

  it('refuses a dropped image for a text-only model, and says why in the tray', async () => {
    // The drop is the one route an image can reach a model with no vision, so
    // it is the route where the refusal has to be loudest — and it must stay on
    // screen, not flash past in a toast.
    render(<Harness vision={false} />);
    dropFiles(screen.getByTestId('attachment-drop-zone'), [imageFile('screenshot.png')]);

    const refusal = await screen.findByRole('status');
    expect(refusal).toHaveTextContent(/screenshot\.png was not attached/i);
    expect(refusal).toHaveTextContent(/reads text only/i);
    expect(screen.queryByAltText(/Preview of/)).not.toBeInTheDocument();
  });

  it('takes the text file out of the same drop that refused the image', async () => {
    render(<Harness vision={false} />);
    dropFiles(screen.getByTestId('attachment-drop-zone'), [imageFile(), textFile('notes.md')]);

    expect(await screen.findByText('notes.md')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/shot\.png/);
  });

  it('drops a staged image when the model loses vision under it', async () => {
    // Leaving it staged would mean it is silently discarded at send, or refused
    // by the endpoint with an error the user cannot connect to anything.
    const user = userEvent.setup();
    const view = render(<Harness vision />);
    await user.upload(screen.getByTestId('attachment-picker-with-images'), imageFile('kept.png'));
    await screen.findByText('kept.png');

    view.rerender(<Harness vision={false} />);

    await waitFor(() => {
      expect(screen.queryByText('kept.png')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent(/kept\.png was not attached/i);
  });

  it('refuses the same file twice rather than staging it twice', async () => {
    const user = userEvent.setup();
    render(<Harness vision />);
    const input = screen.getByTestId('attachment-picker-with-images');

    await user.upload(input, textFile('notes.md'));
    await screen.findByText('notes.md');
    await user.upload(input, textFile('notes.md'));

    expect(await screen.findByRole('status')).toHaveTextContent(/already attached/i);
    expect(screen.getAllByText('notes.md')).toHaveLength(1);
  });

  it('shows nothing at all when nothing is staged', () => {
    render(<Harness vision />);
    expect(screen.queryByTestId('attachment-tray')).not.toBeInTheDocument();
  });
});

describe('toContentParts', () => {
  it('produces the parts the boundary carries, and reads no URL to do it', async () => {
    // The bytes reach a model through the Rust core over IPC. There is no fetch
    // in this feature and there must never be one.
    //
    // The image is **base64**, which is what `ContentPartDto::Image.data` is
    // (`src-tauri/src/ipc/content.rs`). This used to assert a byte array — the
    // *provider* model's shape, one layer further in — and passed, while a
    // payload built from it was one the host could not deserialise. Asserting
    // the wrong of two adjacent shapes is indistinguishable from asserting the
    // right one until something actually sends it.
    const parts: unknown[] = [];
    function Capture() {
      const attachments = useAttachments({ vision: true });
      return (
        <div>
          <AttachmentControls
            vision
            onFiles={(files) => {
              attachments.add(files);
            }}
          />
          <button
            type="button"
            onClick={() => {
              void attachments.toContentParts().then((made) => parts.push(...made));
            }}
          >
            build
          </button>
        </div>
      );
    }

    const user = userEvent.setup();
    render(<Capture />);
    await user.upload(screen.getByTestId('attachment-picker-with-images'), [
      textFile('notes.md', 'the body'),
      imageFile('shot.png'),
    ]);
    await user.click(screen.getByRole('button', { name: 'build' }));

    await waitFor(() => {
      expect(parts).toHaveLength(2);
    });
    expect(parts[0]).toEqual({ kind: 'text', text: 'Attached file: notes.md\n\nthe body' });
    // `AQID` is base64 for the bytes 1, 2, 3 — written out rather than
    // computed, so this does not agree with the encoder by using it.
    expect(parts[1]).toEqual({ kind: 'image', mimeType: 'image/png', data: 'AQID' });
  });

  it('fails the whole list, naming the file, rather than quietly leaving one out', async () => {
    // The one behaviour that is never acceptable: returning the readable parts
    // and letting the caller send a message with the attachment missing. The
    // user is told which file, and the turn does not happen.
    const held: { current: AttachmentsController | null } = { current: null };
    function Capture() {
      const controller = useAttachments({ vision: true });
      held.current = controller;
      return (
        <AttachmentControls
          vision
          onFiles={(files) => {
            controller.add(files);
          }}
        />
      );
    }

    const broken = imageFile('broken.png');
    Object.defineProperty(broken, 'arrayBuffer', {
      value: () => Promise.reject(new Error('the disk went away')),
    });

    const user = userEvent.setup();
    render(<Capture />);
    await user.upload(screen.getByTestId('attachment-picker-with-images'), [
      textFile('fine.md', 'readable'),
      broken,
    ]);

    await expect(held.current?.toContentParts()).rejects.toThrow(/broken\.png/);
  });
});
