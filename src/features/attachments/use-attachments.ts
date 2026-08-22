/**
 * Files staged for the next message.
 *
 * ## Where the bytes go
 *
 * Nowhere, until the message is sent. The `File` handle is held; nothing is
 * read, copied or uploaded when it is staged. On send, {@link toContentParts}
 * reads it locally and produces `ContentPartInput`s — the shape
 * `ChatMessageInput.parts` carries across the IPC bridge — which travel to the
 * Rust core with the turn.
 *
 * **`ContentPartInput`, not `ContentPart`.** The two differ in exactly one
 * field and it is this one: an image is raw bytes in the provider model and
 * **standard base64** at the boundary (`src-tauri/src/ipc/content.rs`). This
 * hook used to produce the provider shape — a byte array — which no caller
 * could have handed to `chat_send` without the host refusing it. Producing the
 * wrong one of two nearly identical types, in a function nothing called, is how
 * a feature stays broken while its own tests pass.
 *
 * There is no `fetch` in this file and there must never be one. Every byte that
 * reaches a model leaves this process through the core (conventions §1: anything
 * that talks HTTP to a model is Rust, never the renderer). An image preview uses
 * `URL.createObjectURL`, which addresses the blob already in memory and makes no
 * request at all.
 *
 * ## Capability gating
 *
 * The `vision` flag comes in as a plain boolean off the capability struct. When
 * it is `false` an image cannot be staged by any route, including a drag from
 * the desktop — and the refusal says which model would have to change, because
 * "unsupported file" would send the user hunting for a converter that cannot
 * help.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ContentPartInput } from '@/platform/contract';
import { base64FromBytes } from '@/lib/base64';

import {
  classify,
  formatBytes,
  rejectionFor,
  IMAGE_MIME_TYPES,
  TEXT_EXTENSIONS,
  type AttachmentKind,
  type AttachmentRejection,
} from './attachment-rules';

const TEXT_ACCEPT = TEXT_EXTENSIONS.map((extension) => `.${extension}`).join(',');
const IMAGE_AND_TEXT_ACCEPT = `${IMAGE_MIME_TYPES.join(',')},${TEXT_ACCEPT}`;

export interface StagedAttachment {
  readonly id: string;
  readonly name: string;
  readonly kind: AttachmentKind;
  readonly mimeType: string;
  readonly size: number;
  /** An object URL for images, or `null` where the runtime cannot make one. */
  readonly previewUrl: string | null;
  readonly file: File;
}

export interface RefusedAttachment {
  readonly name: string;
  readonly reason: AttachmentRejection;
}

export interface AttachmentsController {
  readonly attachments: readonly StagedAttachment[];
  readonly refused: readonly RefusedAttachment[];
  readonly totalBytes: number;
  /** Whether images may be staged at all. Straight off the capability struct. */
  readonly vision: boolean;
  /**
   * The `accept` list any picker into this holder should offer.
   *
   * Published by the holder rather than recomputed per picker: a second picker
   * with its own idea of what is acceptable is a picker that offers a file type
   * {@link rejectionFor} then refuses, which reads to the user as the file
   * being broken.
   */
  readonly accept: string;
  add: (files: Iterable<File>) => void;
  remove: (id: string) => void;
  clear: () => void;
  dismissRefusals: () => void;
  /**
   * Reads the staged files and produces the parts a message carries.
   *
   * Rejects with an {@link AttachmentReadError} if any staged file cannot be
   * read. It deliberately does **not** skip the unreadable one and return the
   * rest: a message that quietly leaves out the picture the user attached is
   * the failure this whole path exists to make impossible.
   */
  toContentParts: () => Promise<readonly ContentPartInput[]>;
}

/**
 * A staged file could not be read off the disk.
 *
 * Carries a sentence already fit to show, because the surface that catches it
 * is in another feature and must not have to know how to describe an
 * attachment. `name` is kept separately for anything that wants to act on the
 * file rather than talk about it.
 */
export class AttachmentReadError extends Error {
  readonly fileName: string;

  constructor(fileName: string, options?: { cause?: unknown }) {
    super(
      `${fileName} could not be read, so nothing was sent. It is still attached — try again, or remove it and send without it.`,
      options as ErrorOptions | undefined,
    );
    this.name = 'AttachmentReadError';
    this.fileName = fileName;
  }
}

interface UseAttachmentsOptions {
  /** From the capability report. `false` means images cannot be staged at all. */
  readonly vision: boolean;
}

/**
 * Releases a preview. Guarded for the same reason {@link previewFor} is: a
 * runtime that cannot mint object URLs cannot revoke them either, and a cleanup
 * that throws takes the unmount down with it.
 */
function revokePreview(url: string | null): void {
  if (url === null) return;
  if (typeof URL.revokeObjectURL !== 'function') return;
  URL.revokeObjectURL(url);
}

function previewFor(file: File, kind: AttachmentKind): string | null {
  if (kind !== 'image') return null;
  // jsdom has no object-URL support, and neither does every webview under every
  // sandbox. A missing preview is a smaller failure than a thrown render.
  if (typeof URL.createObjectURL !== 'function') return null;
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

/**
 * Reads a file, preferring `Blob.text`/`Blob.arrayBuffer` and falling back to
 * `FileReader`.
 *
 * The fallback is not defensive padding: jsdom implements `FileReader` and not
 * the promise methods, so without it every test of this path would exercise a
 * stub instead of the real one. `FileReader` is also the only route available in
 * older webviews, and reading the file is exactly where a difference between
 * environments must not become a difference in behaviour.
 */
function readWith<T extends string | ArrayBuffer>(
  file: File,
  start: (reader: FileReader) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as T);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error(`could not read ${file.name}`));
    };
    start(reader);
  });
}

function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return readWith<string>(file, (reader) => {
    reader.readAsText(file);
  });
}

function readArrayBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return readWith<ArrayBuffer>(file, (reader) => {
    reader.readAsArrayBuffer(file);
  });
}

export function useAttachments({ vision }: UseAttachmentsOptions): AttachmentsController {
  const [attachments, setAttachments] = useState<readonly StagedAttachment[]>([]);
  const [refused, setRefused] = useState<readonly RefusedAttachment[]>([]);
  const sequence = useRef(0);

  // Object URLs are a process-lifetime allocation until revoked. The live set is
  // mirrored in a ref so the unmount cleanup can revoke them without the effect
  // re-running — and re-revoking — on every change.
  const live = useRef<readonly StagedAttachment[]>([]);
  live.current = attachments;
  useEffect(() => {
    return () => {
      for (const attachment of live.current) {
        revokePreview(attachment.previewUrl);
      }
    };
  }, []);

  // An image already staged when the user switches to a model with no vision
  // cannot stay: it would be silently dropped at send, or refused by the
  // endpoint with an error the user cannot connect to anything they did. So it
  // is withdrawn, loudly, at the moment the switch happens.
  useEffect(() => {
    if (vision) return;
    const images = live.current.filter((attachment) => attachment.kind === 'image');
    if (images.length === 0) return;
    for (const image of images) {
      revokePreview(image.previewUrl);
    }
    setAttachments((previous) => previous.filter((attachment) => attachment.kind !== 'image'));
    setRefused((existing) => [
      ...existing,
      ...images.map((image) => ({ name: image.name, reason: 'noVision' as const })),
    ]);
  }, [vision]);

  const add = useCallback(
    (files: Iterable<File>): void => {
      // Reads the current list rather than using the updater form: an updater
      // that also queued refusals would double them under React's double
      // invocation, and staging is a user action, never a concurrent one.
      const previous = live.current;
      const accepted: StagedAttachment[] = [];
      const rejected: RefusedAttachment[] = [];
      let bytes = previous.reduce((total, attachment) => total + attachment.size, 0);
      const names = previous.map((attachment) => attachment.name);

      for (const file of files) {
        const rejection = rejectionFor(file, {
          vision,
          stagedCount: previous.length + accepted.length,
          stagedBytes: bytes,
          stagedNames: [...names, ...accepted.map((one) => one.name)],
        });
        if (rejection !== null) {
          rejected.push({ name: file.name, reason: rejection });
          continue;
        }
        // `classify` cannot be null here — `rejectionFor` returns
        // `unsupportedType` for that case — but the type has to be narrowed.
        const kind = classify(file) ?? 'text';
        sequence.current += 1;
        accepted.push({
          id: `attachment_${String(sequence.current)}`,
          name: file.name,
          kind,
          mimeType: file.type === '' ? 'text/plain' : file.type,
          size: file.size,
          previewUrl: previewFor(file, kind),
          file,
        });
        bytes += file.size;
      }

      if (rejected.length > 0) setRefused((existing) => [...existing, ...rejected]);
      if (accepted.length > 0) setAttachments([...previous, ...accepted]);
    },
    [vision],
  );

  const remove = useCallback((id: string): void => {
    setAttachments((previous) => {
      const going = previous.find((attachment) => attachment.id === id);
      revokePreview(going?.previewUrl ?? null);
      return previous.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const clear = useCallback((): void => {
    setAttachments((previous) => {
      for (const attachment of previous) {
        revokePreview(attachment.previewUrl);
      }
      return [];
    });
  }, []);

  const dismissRefusals = useCallback((): void => {
    setRefused([]);
  }, []);

  const toContentParts = useCallback(async (): Promise<readonly ContentPartInput[]> => {
    const parts: ContentPartInput[] = [];
    for (const attachment of attachments) {
      try {
        if (attachment.kind === 'image') {
          const buffer = await readArrayBuffer(attachment.file);
          parts.push({
            kind: 'image',
            mimeType: attachment.mimeType,
            // Base64, because that is what the boundary carries. See the
            // module note and `src-tauri/src/ipc/content.rs`.
            data: base64FromBytes(new Uint8Array(buffer)),
          });
        } else {
          const text = await readText(attachment.file);
          // Named and fenced, because a model handed bare text has no way to
          // tell the file from the question that came with it.
          parts.push({
            kind: 'text',
            text: `Attached file: ${attachment.name}\n\n${text}`,
          });
        }
      } catch (error) {
        // Named, and fatal to the whole turn. The alternative — dropping this
        // one file and sending the rest — is the silent discard in a smaller
        // costume.
        throw new AttachmentReadError(attachment.name, { cause: error });
      }
    }
    return parts;
  }, [attachments]);

  const totalBytes = useMemo(
    () => attachments.reduce((total, attachment) => total + attachment.size, 0),
    [attachments],
  );

  return {
    attachments,
    refused,
    totalBytes,
    vision,
    accept: vision ? IMAGE_AND_TEXT_ACCEPT : TEXT_ACCEPT,
    add,
    remove,
    clear,
    dismissRefusals,
    toContentParts,
  };
}

/** The renderer's words for a refusal. Enumerable in, sentence out. */
export function refusalText(refusal: RefusedAttachment): string {
  switch (refusal.reason) {
    case 'noVision':
      return `${refusal.name} was not attached: the model you are using reads text only. Switch to a model that reads images to send it.`;
    case 'unsupportedType':
      return `${refusal.name} was not attached: Vela cannot turn that kind of file into part of a message.`;
    case 'tooLarge':
      return `${refusal.name} was not attached: it is larger than ${formatBytes(10 * 1024 * 1024)}.`;
    case 'wouldExceedTotal':
      return `${refusal.name} was not attached: one message can carry ${formatBytes(25 * 1024 * 1024)} of files, and this would go over.`;
    case 'tooMany':
      return `${refusal.name} was not attached: there is a limit on how many files one message can carry.`;
    case 'alreadyAttached':
      return `${refusal.name} is already attached.`;
  }
}
