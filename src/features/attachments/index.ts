/**
 * The attachments feature's public face.
 *
 * A surface stages files with {@link useAttachments}, offers
 * {@link AttachmentControls} (which render *nothing image-shaped* when the model
 * has no vision), wraps its content region in {@link AttachmentDropZone}, and
 * shows {@link AttachmentTray}. On send it calls `toContentParts()` and hands
 * the result to the core — the renderer never talks to a model.
 */

export { AttachmentControls } from './AttachmentControls';
export { AttachmentDropZone } from './AttachmentDropZone';
export { AttachmentTray } from './AttachmentTray';
export {
  useAttachments,
  refusalText,
  type AttachmentsController,
  type RefusedAttachment,
  type StagedAttachment,
} from './use-attachments';
export {
  classify,
  formatBytes,
  rejectionFor,
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  type AttachmentKind,
  type AttachmentRejection,
} from './attachment-rules';
