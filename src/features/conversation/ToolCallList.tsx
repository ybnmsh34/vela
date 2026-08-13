/**
 * Tool use, drawn.
 *
 * ## What the shape is arguing
 *
 * A tool call is *subordinate* to the answer — it is how the model got there,
 * not what it said — so it sits in a quiet card, one per call, collapsed once
 * it has settled. A call you are watching is open; a call that finished is a
 * line you can skip. The user's own click always wins after that: a panel that
 * shuts under the cursor is worse than one that never moves.
 *
 * ## The malformed card
 *
 * It is a card like any other. Same size, same place, no red banner, no icon
 * shouting — a model producing an unreadable call is a Tuesday, not an
 * incident. What it must never be is *absent*: the core kept the bytes instead
 * of executing a guess, and this is where that decision pays out. The state and
 * the reason are in the open; the raw text sits behind one click, because most
 * people want to know *that* it happened and only some want to read the bytes.
 *
 * ## What is not here
 *
 * No backend name, and nowhere to put one. Emulation is announced from the
 * `emulated` flag the core sets when the capability probe found no native tool
 * calling — a capability fact, not an identity.
 */

import { useId, useState } from 'react';

import {
  buildToolCallViews,
  emulationSentence,
  isLive,
  statusLabel,
  summariseToolCalls,
  type ToolCallInputs,
  type ToolCallView,
} from './tool-calls';
import styles from './ToolCallList.module.css';

export function ToolCallList(inputs: ToolCallInputs) {
  const views = buildToolCallViews(inputs);
  if (views.length === 0) return null;

  const emulated = emulationSentence(views);

  return (
    <section className={styles.group} aria-label="Tool calls">
      <p className={styles.summary}>{summariseToolCalls(views)}</p>

      {emulated === null ? null : (
        <p className={styles.emulation}>
          <span className={styles.emulationTag}>Emulated</span>
          {emulated}
        </p>
      )}

      <ol className={styles.list}>
        {views.map((view) => (
          <li key={view.key}>
            <ToolCallCard view={view} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function ToolCallCard({ view }: { readonly view: ToolCallView }) {
  const uid = useId();
  const [choice, setChoice] = useState<boolean | null>(null);
  const [rawShown, setRawShown] = useState(false);

  const live = isLive(view.status);
  const refused = view.problem !== null;
  // A call that arrived as nothing but a name has nothing to open. Rendering a
  // toggle over an empty panel is a promise the card cannot keep.
  const hasBody =
    refused || view.args.kind !== 'none' || view.result !== null || view.callId !== null;
  // Open by default while it moves, when it went wrong, and when the tool
  // itself failed — a refusal nobody expands is a refusal nobody reads.
  // Settled and fine collapses to one line.
  const open = hasBody && (choice ?? (live || refused || view.status === 'failed'));

  const label = (
    <>
      <span className={styles.name}>{view.title}</span>
      <span className={styles.state} data-status={view.status}>
        {live ? <span className={styles.pulse} aria-hidden="true" /> : null}
        {statusLabel(view.status)}
      </span>
      {view.emulated ? <span className={styles.tag}>emulated</span> : null}
      {view.preview === null || open ? null : (
        <span className={styles.preview}>{view.preview}</span>
      )}
    </>
  );

  return (
    <div className={styles.card} data-status={view.status}>
      <h4 className={styles.headingReset}>
        {hasBody ? (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={open}
            aria-controls={`${uid}-body`}
            onClick={() => {
              setChoice(!open);
            }}
          >
            <span
              className={styles.chevron}
              data-open={open ? 'true' : undefined}
              aria-hidden="true"
            />
            {label}
          </button>
        ) : (
          <span className={styles.static}>{label}</span>
        )}
      </h4>

      <div id={`${uid}-body`} className={styles.body} hidden={!open}>
        {view.problem === null ? null : <p className={styles.problem}>{view.problem}</p>}

        {view.args.kind === 'none' ? null : view.args.kind === 'json' ? (
          <>
            <p className={styles.label}>Arguments</p>
            <pre className={styles.block}>{view.args.text}</pre>
          </>
        ) : refused ? (
          <>
            {/* On demand, and unmodified. Re-printing bytes Vela could not
                parse would show the user Vela's guess, not the model's call. */}
            <button
              type="button"
              className={styles.reveal}
              aria-expanded={rawShown}
              aria-controls={`${uid}-raw`}
              onClick={() => {
                setRawShown(!rawShown);
              }}
            >
              {rawShown ? 'Hide what arrived' : 'Show what arrived'}
            </button>
            <pre id={`${uid}-raw`} className={styles.block} data-raw="true" hidden={!rawShown}>
              {view.args.text}
            </pre>
          </>
        ) : (
          <>
            <p className={styles.label}>Arguments so far</p>
            <pre className={styles.block} data-raw="true">
              {view.args.text}
            </pre>
          </>
        )}

        {view.result === null ? null : (
          <>
            <p className={styles.label}>{view.result.isError ? 'Error' : 'Result'}</p>
            <pre className={styles.block} data-error={view.result.isError ? 'true' : undefined}>
              {view.result.content}
            </pre>
          </>
        )}

        {view.callId === null ? null : (
          <p className={styles.callId}>
            {/* The correlation id, shown because it is what makes a batch of
                parallel calls impossible to mix up — a result belongs to one. */}
            id <code>{view.callId}</code>
          </p>
        )}
      </div>
    </div>
  );
}
