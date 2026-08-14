/**
 * What Canvas considers an artifact, and how one turn's fenced blocks become a
 * revision of something the user already has open.
 *
 * ## Why detection reads the block tree rather than the raw text
 *
 * `parseMarkdown` in the conversation feature already decides where a fence
 * starts, where it ends, and — the part that matters here — whether it has
 * ended at all. This module re-runs that parse rather than pattern-matching the
 * source string, because the only correct answer to "is this an artifact yet"
 * is the parser's `open` flag: a fence whose closing backticks have not arrived
 * is a document whose last line is still being typed, and submitting it would
 * mean a run per token.
 *
 * The parser used to live inside the conversation feature, and a feature may not
 * import another feature (`src/features/README.md`). Two features need it now,
 * so it moved to `src/lib/markdown-parser.ts` — which is the destination that
 * same file names for exactly this case, and where a pure, React-free, DOM-free
 * parser belonged anyway. Re-deriving "where does this fence end" here would
 * have put two answers to one question in the tree, which is the defect class
 * this repo keeps finding.
 *
 * ## Identity, and what breaks if it changes
 *
 * An artifact's identity is its **slot**: the fence language plus its ordinal
 * within the message that carried it. The second `svg` block of any assistant
 * message is `svg#1`, in every message, forever.
 *
 * That is a decision with a visible failure mode, so it is written down. A model
 * asked to "make the chart taller" replies with one `svg` block, which lands in
 * `svg#0` and becomes version 2 of the chart the user is looking at — which is
 * the behaviour the whole version rail exists for. A model that replies with two
 * charts where it previously sent one puts its second chart in `svg#1`, a new
 * track, which is right. A model that replies with a *different* chart in the
 * same position revises the first one, which is wrong and is the cost. The
 * alternative — content similarity — is a heuristic that is wrong in ways a user
 * cannot predict, and there is no id in the transcript to key on because the
 * model never sent one.
 *
 * ## Markdown is not here
 *
 * {@link DocumentLanguage} has four members and markdown is not one of them,
 * because Vela never executes markdown: it parses it to a block tree and renders
 * that tree as React elements. A markdown "artifact" would be a second copy of
 * the transcript's own reading surface with no sandbox run behind it, so this
 * module does not manufacture one.
 */

import type { Block } from '@/lib/markdown-parser';
import type { DocumentLanguage, DocumentProgram } from '@/platform/contract-sandbox';

/**
 * A stable key for one artifact across the turns that revise it.
 *
 * A string rather than a branded type for the reason `ProjectId` gives in
 * `src/platform/contract-project.ts`: it is a map key and a React key, and every
 * place it is used already knows what it is.
 */
export type ArtifactSlot = string;

/** One revision of one artifact. `index` is 0-based and dense within its track. */
export interface ArtifactVersion {
  readonly index: number;
  /** Which assistant message carried it. Shown so a user can find the turn. */
  readonly messageIndex: number;
  readonly program: DocumentProgram;
}

/** One artifact and every revision of it, oldest first. */
export interface ArtifactTrack {
  readonly slot: ArtifactSlot;
  /** Vela's own words for what this is. Never taken from the program's bytes. */
  readonly title: string;
  readonly versions: readonly ArtifactVersion[];
}

/**
 * Fence languages that name a document, and what each one maps to.
 *
 * A closed map rather than a normalise-and-guess, so a fence tagged `python`
 * cannot become a document by accident. `jsx` and `tsx` map to `react` because
 * that is what a model writes when it means a component; `react` itself is
 * accepted because models write that too.
 */
const FENCE_LANGUAGES = new Map<string, DocumentLanguage>([
  ['html', 'html'],
  ['htm', 'html'],
  ['svg', 'svg'],
  ['mermaid', 'mermaid'],
  ['jsx', 'react'],
  ['tsx', 'react'],
  ['react', 'react'],
]);

/**
 * Shorter than this and it is an illustration, not an artifact.
 *
 * A model writing prose about HTML writes ```` ```html\n<b>bold</b>\n``` ````,
 * and opening a side panel for it would take the reader's window away to show
 * them nine characters. The floor is on the trimmed source and is deliberately
 * low: an SVG that draws one circle is a real artifact and is about sixty
 * characters.
 */
export const MINIMUM_ARTIFACT_CHARS = 40;

/** Vela's word for each language. The version rail shows this, never the source. */
const TITLES: Readonly<Record<DocumentLanguage, string>> = {
  html: 'HTML page',
  react: 'React component',
  svg: 'SVG image',
  mermaid: 'Mermaid diagram',
};

/**
 * Build the program for one detected block.
 *
 * **Script is denied here and there is no argument to change it.** The contract
 * offers two values and calls `denied` "the honest choice for previewing
 * untrusted HTML"; escalating to `sandboxedNullOrigin` changes the program, and
 * a changed program is a different run with its own approval — see
 * `withScripts` in `document-run.ts`, which is the only thing that produces the
 * other value. Detection cannot decide that on the user's behalf, because
 * detection has read nothing but a fence tag.
 */
function programFor(language: DocumentLanguage, source: string): DocumentProgram {
  return language === 'html' || language === 'react'
    ? { kind: 'document', language, source, scripts: 'denied' }
    : { kind: 'document', language, source };
}

export interface DetectedArtifact {
  readonly slot: ArtifactSlot;
  readonly title: string;
  readonly program: DocumentProgram;
}

/**
 * Every artifact in one assistant message, in source order.
 *
 * An unclosed fence is skipped entirely rather than emitted with a flag: a
 * caller that received one would have to decide whether to submit it, and the
 * two callers would decide differently.
 */
export function detectArtifacts(blocks: readonly Block[]): readonly DetectedArtifact[] {
  const found: DetectedArtifact[] = [];
  const ordinals = new Map<DocumentLanguage, number>();

  for (const block of blocks) {
    if (block.kind !== 'code' || block.open) continue;
    const language = FENCE_LANGUAGES.get((block.language ?? '').toLowerCase());
    if (language === undefined) continue;
    const source = block.text.trim();
    if (source.length < MINIMUM_ARTIFACT_CHARS) continue;

    const ordinal = ordinals.get(language) ?? 0;
    ordinals.set(language, ordinal + 1);
    found.push({
      slot: `${language}#${String(ordinal)}`,
      title: ordinal === 0 ? TITLES[language] : `${TITLES[language]} ${String(ordinal + 1)}`,
      program: programFor(language, source),
    });
  }

  return found;
}

/**
 * Fold a whole transcript's assistant messages into one track per slot.
 *
 * **A revision whose source is byte-identical to the version before it is not a
 * new version.** Without that rule the rail would grow every time React
 * re-rendered a restored transcript, and "version 4 of 4" would mean nothing at
 * all. Identical text arriving in a *later* message is still the same document;
 * the user did not get a new one because the model repeated itself.
 */
export function collectArtifacts(
  messageBlocks: readonly (readonly Block[])[],
): readonly ArtifactTrack[] {
  const order: ArtifactSlot[] = [];
  const bySlot = new Map<ArtifactSlot, { title: string; versions: ArtifactVersion[] }>();

  messageBlocks.forEach((blocks, messageIndex) => {
    for (const detected of detectArtifacts(blocks)) {
      let track = bySlot.get(detected.slot);
      if (track === undefined) {
        track = { title: detected.title, versions: [] };
        bySlot.set(detected.slot, track);
        order.push(detected.slot);
      }
      const previous = track.versions[track.versions.length - 1];
      if (previous !== undefined && previous.program.source === detected.program.source) continue;
      track.versions.push({
        index: track.versions.length,
        messageIndex,
        program: detected.program,
      });
    }
  });

  return order.map((slot) => {
    const track = bySlot.get(slot);
    return {
      slot,
      title: track?.title ?? slot,
      versions: track?.versions ?? [],
    };
  });
}
