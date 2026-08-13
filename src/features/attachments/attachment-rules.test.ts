import { describe, expect, it } from 'vitest';

import {
  classify,
  extensionOf,
  formatBytes,
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  rejectionFor,
  type FileFacts,
  type StagingContext,
} from './attachment-rules';

function file(overrides: Partial<FileFacts> = {}): FileFacts {
  return { name: 'notes.md', type: '', size: 1024, ...overrides };
}

function context(overrides: Partial<StagingContext> = {}): StagingContext {
  return { vision: true, stagedCount: 0, stagedBytes: 0, stagedNames: [], ...overrides };
}

describe('classify', () => {
  it('recognises the image types a vision model can actually be handed', () => {
    expect(classify(file({ name: 'shot.png', type: 'image/png' }))).toBe('image');
    expect(classify(file({ name: 'photo.jpg', type: 'image/jpeg' }))).toBe('image');
  });

  it('refuses an image type no endpoint agreed to take', () => {
    // "The OS called it an image" is not a reason to hand it to a model and
    // produce a refusal the user cannot act on.
    expect(classify(file({ name: 'scan.tiff', type: 'image/tiff' }))).toBeNull();
  });

  it('reads a source file the OS could not name', () => {
    // Browsers report '' for .md, .rs, .toml and friends. A MIME-only rule
    // would reject exactly the files a developer wants to attach.
    expect(classify(file({ name: 'main.rs', type: '' }))).toBe('text');
    expect(classify(file({ name: 'Cargo.toml', type: '' }))).toBe('text');
    expect(classify(file({ name: 'notes.md', type: '' }))).toBe('text');
  });

  it('trusts a text MIME type over the name', () => {
    expect(classify(file({ name: 'no-extension', type: 'text/plain' }))).toBe('text');
    expect(classify(file({ name: 'data', type: 'application/json' }))).toBe('text');
  });

  it('has no idea what to do with a binary', () => {
    expect(classify(file({ name: 'app.bin', type: 'application/octet-stream' }))).toBeNull();
    expect(classify(file({ name: 'sheet.xlsx', type: '' }))).toBeNull();
  });

  it('reads the extension the way a filename actually works', () => {
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
    expect(extensionOf('none')).toBe('');
  });
});

describe('rejectionFor', () => {
  it('refuses an image for a model with no vision, and says which it is', () => {
    // The second line of defence: the picker is not rendered at all, but a drag
    // from the desktop can carry anything.
    expect(
      rejectionFor(file({ name: 'shot.png', type: 'image/png' }), context({ vision: false })),
    ).toBe('noVision');
  });

  it('still takes a text file for a model with no vision', () => {
    // A text file is inlined into the prompt. Every model that reads a message
    // reads one, and gating it on vision would forbid a plain .md on a perfectly
    // capable local model.
    expect(rejectionFor(file(), context({ vision: false }))).toBeNull();
  });

  it('blames vision before size, because shrinking the image would not help', () => {
    expect(
      rejectionFor(
        file({ name: 'huge.png', type: 'image/png', size: MAX_FILE_BYTES + 1 }),
        context({ vision: false }),
      ),
    ).toBe('noVision');
  });

  it('refuses a file larger than one message may carry', () => {
    expect(rejectionFor(file({ size: MAX_FILE_BYTES + 1 }), context())).toBe('tooLarge');
    expect(rejectionFor(file({ size: MAX_FILE_BYTES }), context())).toBeNull();
  });

  it('refuses a file that would push the message over its total', () => {
    expect(
      rejectionFor(file({ size: 1024 }), context({ stagedBytes: MAX_TOTAL_BYTES - 512 })),
    ).toBe('wouldExceedTotal');
  });

  it('refuses the same file twice', () => {
    expect(rejectionFor(file({ name: 'notes.md' }), context({ stagedNames: ['notes.md'] }))).toBe(
      'alreadyAttached',
    );
  });

  it('refuses more files than a message can carry', () => {
    expect(rejectionFor(file(), context({ stagedCount: MAX_ATTACHMENTS }))).toBe('tooMany');
  });

  it('refuses what it cannot read at all', () => {
    expect(rejectionFor(file({ name: 'app.bin', type: 'application/octet-stream' }), context())).toBe(
      'unsupportedType',
    );
  });
});

describe('formatBytes', () => {
  it('reads the way a person says it', () => {
    expect(formatBytes(96)).toBe('96 bytes');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1_500_000)).toBe('1.4 MB');
  });
});
