/**
 * What the conversation needs from whatever is holding the user's staged files.
 *
 * ## Why this is an interface and a context rather than an import
 *
 * The files are staged by the attachments feature and owned by the models
 * workspace, which is where the tray and the drop zone live. The conversation
 * feature imports neither — the feature boundary points one way, through the
 * composition root, and this is the shape that travels down it.
 * `AttachmentsController` satisfies it structurally; nothing has to be adapted.
 *
 * It travels by **context** rather than prop-drilling because the two places
 * that need it — {@link useConversation}, which builds the payload, and the
 * composer, which offers the picker — are two and four levels apart, and the
 * view between them is presentational and has no business knowing about files.
 *
 * ## Why it is this small
 *
 * Four members, and they are one sequence: offer what may be staged, take it,
 * put it on the wire, forget it. A wider port would let this feature start
 * making decisions about attachments — which is how two owners of one piece of
 * state appear, and how the tray and the payload start disagreeing about what
 * was sent.
 */

import { createContext, useContext } from 'react';

import type { ContentPartInput } from '@/platform/contract';

/** The one fact the conversation needs about a staged file: that it is there. */
export interface StagedFile {
  readonly id: string;
  readonly name: string;
}

export interface TurnAttachments {
  /** Empty when nothing is staged, which is the overwhelmingly common turn. */
  readonly attachments: readonly StagedFile[];
  /**
   * The `accept` list for a picker — the holder's own answer, so a second
   * picker cannot offer a file type the rules would then refuse. It already
   * reflects the vision capability.
   */
  readonly accept: string;
  /** Stage files the user chose. Refusals are the holder's to report. */
  add: (files: Iterable<File>) => void;
  /**
   * Read the staged files and produce the parts to send.
   *
   * Rejects rather than returning a partial list when a file cannot be read.
   * The rejection's `message` is already a sentence to show the user.
   */
  toContentParts: () => Promise<readonly ContentPartInput[]>;
  /** Called once the bytes are safely in hand — never before, never on failure. */
  clear: () => void;
}

/**
 * `null` means *nothing is holding attachments for this surface* — which is a
 * different statement from "the tray is empty", and the reason this is not
 * defaulted to a no-op object. A surface mounted on its own in a test is in
 * that state; the assembled application never is.
 */
const TurnAttachmentsContext = createContext<TurnAttachments | null>(null);

export const TurnAttachmentsProvider = TurnAttachmentsContext.Provider;

export function useTurnAttachments(): TurnAttachments | null {
  return useContext(TurnAttachmentsContext);
}
