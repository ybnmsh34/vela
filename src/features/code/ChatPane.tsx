/**
 * The chat pane: the session's model, how much of its window the next turn
 * would use, what has been queued for it, and the box you type into.
 *
 * ## The context readout beside the model picker
 *
 * It measures the queued turns plus what is in the composer right now, against
 * whatever window `models_capabilities` has on record. Three things it will not
 * do, all of them from `src/lib/context-budget.ts` and all of them defects this
 * repo has already shipped once:
 *
 *  - It never invents a window. `null` from the host reads as "window unknown",
 *    not as 200,000.
 *  - It never prints "about 0" for "nothing was measured". The two are different
 *    absences and the meter that conflated them told a user with 880,000
 *    characters typed that they had room.
 *  - It says "about", because a renderer cannot tokenise the way an arbitrary
 *    endpoint does.
 *
 * ## Sending queues; it does not run
 *
 * There is no agent loop behind this pane. Pressing Send appends the message to
 * the session's queue, which is what the list above the composer shows, and the
 * footnote says so. The alternative — a Send that appears to work and silently
 * discards the message — is the exact shape of the staged-attachment defect
 * `src/app/App.tsx` describes: "the attach button staged a file, the tray showed
 * it, and pressing Send sent the message without it".
 */

import { useMemo, useState } from 'react';

import { contextBudget } from '@/lib/context-budget';
import { useCodeWorkspaceStore, workOf, type CodeSession } from '@/state/code-workspace-store';

import { useContextWindow } from './use-code-models';
import styles from './CodeWorkspace.module.css';

export function ChatPane({ session }: { readonly session: CodeSession }) {
  const work = useCodeWorkspaceStore((state) => workOf(state, session.id));
  const queueMessage = useCodeWorkspaceStore((state) => state.queueMessage);
  const [message, setMessage] = useState('');

  const windowTokens = useContextWindow(session.providerId, session.modelId);
  const budget = useMemo(
    () => contextBudget(windowTokens, [...work.queue, message]),
    [windowTokens, work.queue, message],
  );

  return (
    <div className={styles.chatPane}>
      <div className={styles.modelBar}>
        <span className={styles.modelName}>{session.modelId}</span>
        <span className={styles.contextReadout} data-verdict={budget.verdict}>
          {/* Branched on the nulls themselves rather than on the verdict, and
              with no `??` anywhere. The previous form read
              `budget.approxUsedTokens ?? 0`, which puts back in one character
              the "about 0" conflation the header above forbids — `null` there
              means *nothing was measured*, and rendering it as zero is how a
              user with a full window is told they have room. It printed the
              same three strings this does, because this call site always hands
              `contextBudget` an array and so can never see the null; that is
              precisely the sort of unreachable that stops being unreachable
              when a caller changes. Nothing bites the null arm: `Context
              unknown` occurs once in the whole of `src/`, on the line below,
              and no test asserts it. This pane's one call to `contextBudget`
              is above and always passes an array, so nothing renders the arm
              from here; another caller of `contextBudget`
              (`src/features/models/ContextMeter.tsx`) is not this component and
              cannot reach this line at all. */}
          {budget.approxUsedTokens === null
            ? 'Context unknown'
            : budget.windowTokens === null
              ? `About ${budget.approxUsedTokens} tokens · window unknown`
              : `About ${budget.approxUsedTokens} of ${budget.windowTokens} tokens`}
        </span>
      </div>

      <div className={styles.queue} role="log" aria-label="Queued for this session">
        {work.queue.length === 0 ? (
          <p className={styles.empty}>Nothing queued yet.</p>
        ) : (
          work.queue.map((entry, index) => (
            <pre key={index} className={styles.queued}>
              {entry}
            </pre>
          ))
        )}
      </div>

      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          const text = message.trim();
          if (text === '') return;
          // The same queue the review round lands on, so a comment and a typed
          // instruction arrive in the order they were sent. A different action,
          // because sending a message must not empty a review the user has not
          // submitted — see `queueMessage` in the store.
          queueMessage(session.id, text);
          setMessage('');
        }}
      >
        <label className={styles.fieldLabel} htmlFor={`composer-${session.id}`}>
          Message
        </label>
        <textarea
          id={`composer-${session.id}`}
          className={styles.textarea}
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <button type="submit" className={styles.primary} disabled={message.trim() === ''}>
          Send
        </button>
      </form>

      <p className={styles.footnote}>
        Vela queues what you send here for this worktree. No model is contacted: this build has no
        agent loop behind the Code workspace, and a Send that pretended otherwise would be worse
        than one that says so.
      </p>
    </div>
  );
}
