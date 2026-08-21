/**
 * WHAT THE MODEL IS TOLD BEFORE THE USER SAYS ANYTHING — resolved once, in one
 * place, for both of the paths a turn can travel on.
 *
 * Three layers can put instructions in front of a turn, and until this file
 * existed only one of them did:
 *
 * | Layer | Where the text comes from | Reaches the model via |
 * |---|---|---|
 * | style | {@link BUILT_IN_STYLES}, picked by the user | this file |
 * | custom instructions | typed by the user | this file |
 * | project instructions | `ProjectView.instructions` | `src/runtime/project-context.ts` |
 *
 * ## The asymmetry this file must not repeat, and the check that says so
 *
 * A turn leaves `src/features/conversation/use-conversation.ts` on one of two
 * paths. `start` calls `ChatRepository.streamTurn`, which is one `chat_send`.
 * `startRun` calls `HarnessRuntime.runs.start`, which drives the agent loop.
 *
 * **Project instructions ride only the second one.** That is not a guess:
 * `startRun` fills `RunContextRequest.preload` from `contextFor(projectId).index()`
 * and `composeSystemMessage` in `src/runtime/agent-loop-harness.ts` joins the
 * loaded chunks into the system message, while `start` builds its messages with
 * `toMessages(history, userText, parts, memoryRef.current, instructionsRef.current.chat)`
 * — history, the new message, the memory preamble, and the text this file
 * composes for the `chat` path. `toMessages` takes those five and no more:
 * there is no argument carrying a project.
 * `src/features/projects/ProjectPanel.tsx` discloses this in a
 * footnote, which is honesty about the hole and not a repair of it.
 *
 * So the obvious way to add a style — put it in `RunContextRequest.systemPrompt`
 * — would ship the identical defect a second time: a user picks "be concise",
 * sends an ordinary message, and gets six paragraphs. {@link SendPath} is
 * therefore a required input to {@link resolveInstructionLayers}, every layer
 * answers `applies` **per path**, and `instruction-layers.test.ts` asserts that
 * the style and custom layers apply on *both* paths. A future edit that reaches
 * only one of them reddens that test by name.
 *
 * ## Precedence: what is enforced, and what is merely said
 *
 * Project instructions win over custom instructions. Two things implement that,
 * and they are not the same strength:
 *
 * 1. **Ordering, which is mechanical.** `composeSystemMessage` puts
 *    `systemPrompt` first and the loaded chunks after it, so the text this file
 *    produces always precedes the project's. That is a fact about
 *    `agent-loop-harness.ts` and not about this module, and
 *    `instruction-layers.test.ts` deliberately does **not** assert it: that
 *    function is module-private, so the only thing a pure-function test could
 *    assert is a restatement of the join, which would stay green through a
 *    change that reversed the real one. It is asserted in
 *    `src/app/instructions-and-incognito.test.tsx`, which reads the order off
 *    the `chat_send` payload the host is handed.
 * 2. **A sentence, which is not.** {@link composeInstructionText} appends
 *    {@link PROJECT_WINS_SENTENCE} when — and only when — a project layer is
 *    actually going to be there to conflict with.
 *
 * **I cannot prove a model obeys either one.** Nothing in this repository can:
 * there is no assertion available over a remote model's behaviour, and a test
 * that sent a prompt and read the reply would be measuring the endpoint, not the
 * code. What is provable is that the text is composed, ordered and labelled as
 * described, and that is the whole of the claim. {@link ResolvedLayer.why} is
 * the same statement in the words the user reads, so the surface cannot promise
 * more than this comment does.
 *
 * ## Why `default` contributes no text
 *
 * A style the user never chose must not put words in front of their turn. The
 * `default` entry's `directive` is `null`, {@link composeInstructionText}
 * answers `null` when every layer is empty, and both call sites treat `null` as
 * "send exactly what you sent before this feature existed". Otherwise every
 * user on this build silently starts paying for a paragraph they did not write.
 */

/** The styles this build ships. Ids are stable; labels are what a user reads. */
export type StyleId = 'default' | 'concise' | 'explanatory' | 'formal';

export interface StyleDefinition {
  readonly id: StyleId;
  /** Painted in the picker. */
  readonly label: string;
  /** One line under the label, so a picker is not four bare nouns. */
  readonly blurb: string;
  /**
   * The text sent to the model, or `null` for a style that sends nothing.
   *
   * `null` rather than `''` because the two mean different things to a reader:
   * an empty string looks like a directive somebody forgot to write, and this
   * one is deliberately absent.
   */
  readonly directive: string | null;
}

export const DEFAULT_STYLE_ID: StyleId = 'default';

export const BUILT_IN_STYLES: readonly StyleDefinition[] = Object.freeze([
  Object.freeze({
    id: 'default' as const,
    label: 'Default',
    blurb: 'No style instructions are added.',
    directive: null,
  }),
  Object.freeze({
    id: 'concise' as const,
    label: 'Concise',
    blurb: 'Short answers. No preamble, no recap.',
    directive:
      'Answer in as few words as the question honestly allows. Do not restate the question, do not summarise your answer afterwards, and do not offer follow-up suggestions unless asked.',
  }),
  Object.freeze({
    id: 'explanatory' as const,
    label: 'Explanatory',
    blurb: 'Works through the reasoning, not just the result.',
    directive:
      'Show the reasoning that leads to the answer, not only the answer. Name the assumptions you are making and say which parts you are unsure of.',
  }),
  Object.freeze({
    id: 'formal' as const,
    label: 'Formal',
    blurb: 'Neutral register, complete sentences.',
    directive:
      'Write in a neutral, professional register. Use complete sentences, avoid contractions, and avoid figures of speech.',
  }),
]);

export function styleById(id: StyleId): StyleDefinition {
  const found = BUILT_IN_STYLES.find((style) => style.id === id);
  // Not a fallback to `default`: an id that is not in the table is a caller
  // holding a value from a build that shipped a different table, and silently
  // answering "Default" would send the user's chosen style nowhere while the
  // picker still showed it selected. The type makes this unreachable; the throw
  // is what keeps it unreachable if the type ever stops being the whole story.
  if (found === undefined) throw new Error(`instruction-layers: unknown style \`${id}\``);
  return found;
}

/**
 * Which of the two routes a turn is about to take.
 *
 * `chat` is `ChatRepository.streamTurn` — one `chat_send`, the composer's
 * ordinary send. `agent` is `HarnessRuntime.runs.start` — the agent toggle.
 * A caller that does not know which it is has not decided yet and must not ask
 * this file, because the answer genuinely differs.
 */
export type SendPath = 'chat' | 'agent';

/**
 * What the renderer knows about this project's instructions at compose time.
 *
 * Five arms rather than `string | null`, because the surface has to be able to
 * say five different things and four of them are not "there are none":
 *
 * - `none` — the project exists and its instructions column is empty.
 * - `text` — the project has instructions, and here they are. What the panel
 *   holds, because the panel read `project_get` itself in order to show them.
 * - `indexed` — `contextFor(projectId).index()` produced a ref, so a chunk is
 *   going to be loaded, and **the text is not in this process**. What the send
 *   path holds: `use-conversation.ts` has the index result and deliberately does
 *   not read the body, because a body in the request is material reaching the
 *   model with no `contextLoaded` event to say it did.
 * - `unreadable` — `project_get` was asked and rejected. The run will still
 *   carry the ref and report `contextUnavailable`; see `project-context.ts`.
 * - `unknown` — nothing has asked yet, or there is no project. Distinct from
 *   `none` for the reason `projects-repository.ts` gives for not collapsing
 *   `NOT_FOUND` into a null.
 */
export type ProjectInstructionsState =
  | { readonly kind: 'none' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'indexed' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'unknown' };

export type LayerId = 'style' | 'custom' | 'project';

export interface ResolvedLayer {
  readonly id: LayerId;
  /** The heading a user reads for this layer. */
  readonly label: string;
  /** Whether this layer's text reaches the model on the path that was asked about. */
  readonly applies: boolean;
  /**
   * One sentence, shown verbatim, saying why it does or does not.
   *
   * Written here rather than in the component so that the surface cannot claim
   * more than the resolution does — the panel renders this string and composes
   * no sentence of its own.
   */
  readonly why: string;
  /** The layer's own text. `''` when the layer is empty. */
  readonly text: string;
}

export interface InstructionLayerInput {
  readonly styleId: StyleId;
  readonly customInstructions: string;
  readonly project: ProjectInstructionsState;
  readonly path: SendPath;
}

/**
 * The heading each layer's text is filed under in the composed message.
 *
 * Headings rather than bare concatenation: two paragraphs of directives run
 * together read as one voice, and the whole point of the precedence sentence is
 * that the model can tell which block is which.
 */
const STYLE_HEADING = 'Response style:';
const CUSTOM_HEADING = "The user's standing instructions:";

/**
 * The precedence, in the words that are sent.
 *
 * Emitted only when a project layer actually applies — see the header. A
 * sentence deferring to instructions that are not present is a sentence about
 * nothing, and on the `chat` path there are never any.
 */
export const PROJECT_WINS_SENTENCE =
  "Where the above conflicts with this project's instructions, follow the project's instructions.";

/**
 * The three layers, in the order their text appears, each with the reason it
 * does or does not apply on this path.
 *
 * Always three entries, always in this order, whether or not any of them has
 * text. A resolution that omitted empty layers would let the surface show two
 * rows and leave the user to wonder whether the third exists.
 */
export function resolveInstructionLayers(
  input: InstructionLayerInput,
): readonly ResolvedLayer[] {
  const style = styleById(input.styleId);
  const styleText = style.directive ?? '';
  const customText = input.customInstructions.trim();

  return [
    {
      id: 'style',
      label: `Style · ${style.label}`,
      applies: styleText !== '',
      why:
        styleText === ''
          ? 'The Default style adds nothing to the prompt.'
          : 'Sent with every turn, on both the ordinary send and an agent run.',
      text: styleText,
    },
    {
      id: 'custom',
      label: 'Your instructions',
      applies: customText !== '',
      why:
        customText === ''
          ? 'Nothing written yet.'
          : 'Sent with every turn, on both the ordinary send and an agent run.',
      text: customText,
    },
    projectLayer(input.project, input.path),
  ];
}

function projectLayer(project: ProjectInstructionsState, path: SendPath): ResolvedLayer {
  const label = 'Project instructions';
  if (path === 'chat') {
    // The disclosed hole, stated to the user at the moment it costs them
    // something rather than in a footnote in another pane. `text` still carries
    // what the project holds when it is known, so the panel can show the user
    // exactly which words are being left behind.
    return {
      id: 'project',
      label,
      applies: false,
      why: 'Not sent on an ordinary message — only an agent run carries them.',
      text: project.kind === 'text' ? project.text : '',
    };
  }
  switch (project.kind) {
    case 'text':
      return {
        id: 'project',
        label,
        applies: true,
        why: 'Sent after the two above, and takes precedence where they conflict.',
        text: project.text,
      };
    case 'indexed':
      // The same `applies` as `text`, and no body. The send path knows a chunk
      // is coming and must not carry its words; see `ProjectInstructionsState`.
      return {
        id: 'project',
        label,
        applies: true,
        why: 'Sent after the two above, and takes precedence where they conflict.',
        text: '',
      };
    case 'none':
      return { id: 'project', label, applies: false, why: 'This project has none.', text: '' };
    case 'unreadable':
      return {
        id: 'project',
        label,
        applies: false,
        why: 'Could not be read. The run will say so rather than run without them silently.',
        text: '',
      };
    case 'unknown':
      return {
        id: 'project',
        label,
        applies: false,
        why: 'Not read yet.',
        text: '',
      };
  }
}

/**
 * The text this file contributes to the prompt, or `null` for "nothing".
 *
 * **It never includes the project layer.** That text is not this file's to
 * send: `src/runtime/project-context.ts` loads it through the context resolver
 * so that the load produces a `contextLoaded` event and a failure produces a
 * `contextUnavailable` degradation. Copying it in here would put the same words
 * in front of the model twice on the agent path and — worse — put them there
 * with no record that they were loaded, which is the property
 * `RunContextRequest` exists to hold ("a request that carried bodies would let
 * material reach the model with no record that it did").
 *
 * `null` rather than `''`: `RunContextRequest.systemPrompt` is `string | null`
 * and `composeSystemMessage` treats both the same, but `toMessages` on the chat
 * path takes a `ChatMessageInput | null`, and a system message with an empty
 * body is a message some endpoints reject.
 */
export function composeInstructionText(layers: readonly ResolvedLayer[]): string | null {
  const segments: string[] = [];
  for (const layer of layers) {
    if (layer.id === 'project') continue;
    if (!layer.applies) continue;
    segments.push(`${layer.id === 'style' ? STYLE_HEADING : CUSTOM_HEADING}\n${layer.text}`);
  }
  if (segments.length === 0) return null;
  const project = layers.find((layer) => layer.id === 'project');
  if (project?.applies === true) segments.push(PROJECT_WINS_SENTENCE);
  return segments.join('\n\n');
}
