/**
 * What may be attached, and why something was refused.
 *
 * Pure and dependency-free, so every rule below is testable without a DOM, a
 * file, or a model.
 *
 * ## The rule that matters most
 *
 * **An image is refusable before it is ever staged, and only because the
 * capability struct says the model has no vision.** Not because of a provider
 * id, not because of a model name, not because of a URL. When vision is absent
 * the picker for images is not rendered at all — this file is the second line,
 * for the drag-and-drop path where the user can drop anything they like onto the
 * window and something has to say what happened.
 *
 * ## Text files are a different question
 *
 * A text file is not an attachment in the model's sense: it is inlined into the
 * prompt as text. Every model that can read a message can read one, so it is
 * never gated on vision. Conflating the two would either forbid a plain `.md`
 * on a local model that handles it perfectly well, or imply that a text-only
 * model can see a screenshot.
 */

/** Per file. Generous enough for a photograph, bounded so one drop cannot wedge the app. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Across everything staged for one message. */
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** Most staged files at once, so a dropped directory cannot produce a thousand chips. */
export const MAX_ATTACHMENTS = 10;

/**
 * Image types Vela will hand to a vision model. A closed list: an endpoint that
 * accepts images accepts *some* images, and offering it a TIFF because the OS
 * called it an image is a refusal the user cannot act on.
 */
export const IMAGE_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/**
 * Extensions treated as text when the OS supplies no useful type. Browsers
 * routinely report `''` for `.md`, `.rs`, `.toml` and friends, so a rule that
 * only trusted the MIME type would reject exactly the files a developer wants
 * to attach.
 */
export const TEXT_EXTENSIONS: readonly string[] = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'log', 'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'java', 'kt', 'rb',
  'php', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'sh', 'bash', 'zsh', 'sql', 'diff', 'patch',
];

export type AttachmentKind = 'image' | 'text';

/** Why something was refused. Enumerable so the UI owns the sentence. */
export type AttachmentRejection =
  | 'noVision'
  | 'unsupportedType'
  | 'tooLarge'
  | 'wouldExceedTotal'
  | 'tooMany'
  | 'alreadyAttached';

/** The bits of a `File` any of these rules needs. Keeps them DOM-free. */
export interface FileFacts {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * What kind of thing is this, as far as Vela is concerned? `null` means Vela
 * has no way to put it in a prompt — a binary it cannot read and the model
 * cannot see.
 */
export function classify(file: FileFacts): AttachmentKind | null {
  const type = file.type.toLowerCase();
  if (IMAGE_MIME_TYPES.includes(type)) return 'image';
  if (type.startsWith('text/')) return 'text';
  if (type === 'application/json' || type === 'application/xml') return 'text';
  // The OS said nothing useful; fall back to the name.
  if (type === '' && TEXT_EXTENSIONS.includes(extensionOf(file.name))) return 'text';
  return null;
}

export interface StagingContext {
  /** Straight off the capability struct. Never a provider id. */
  readonly vision: boolean;
  readonly stagedCount: number;
  readonly stagedBytes: number;
  readonly stagedNames: readonly string[];
}

/**
 * May this file be staged? `null` means yes.
 *
 * Order is deliberate and is part of the contract: the *reason* a user is given
 * must be the one they can act on. "This model cannot see images" outranks "that
 * file is too big", because shrinking the image would not have helped.
 */
export function rejectionFor(file: FileFacts, context: StagingContext): AttachmentRejection | null {
  const kind = classify(file);
  if (kind === 'image' && !context.vision) return 'noVision';
  if (kind === null) return 'unsupportedType';
  if (context.stagedNames.includes(file.name)) return 'alreadyAttached';
  if (context.stagedCount >= MAX_ATTACHMENTS) return 'tooMany';
  if (file.size > MAX_FILE_BYTES) return 'tooLarge';
  if (context.stagedBytes + file.size > MAX_TOTAL_BYTES) return 'wouldExceedTotal';
  return null;
}

/** `1.4 MB`, `812 KB`, `96 bytes`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
