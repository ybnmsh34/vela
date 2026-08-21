/**
 * The first screen. What the user sees before they have chosen anything.
 *
 * Its job is to make the proposition legible in the time it takes to glance at
 * it: **you bring the model, Vela brings everything else.** That is a factual
 * claim about how the product is built, not a slogan, so the screen states the
 * mechanics — where the model comes from, where the data lives, what leaves the
 * machine — and then gets out of the way.
 *
 * It also carries the honesty readout the Phase A placeholder carried
 * (conventions §10): which adapter is live and which credential backend is
 * really in use. A screenshot of this screen must never be mistakable for
 * evidence that a real OS keychain or a real model endpoint was exercised.
 */

import { useEffect, useRef } from 'react';

import { VelaMark } from '@/components/VelaMark';
import { usePlatform } from '@/platform/PlatformProvider';
import { claimKeyboardIfHomeless, useFocusAnchor } from '@/state/focus-store';
import { useNavigationStore } from '@/state/navigation-store';

import { ShortcutHint } from '@/components/ShortcutHint';

import styles from './HomeSurface.module.css';
import { useConversations } from './use-conversations';

/** How many recent conversations the home screen offers to resume. */
const RECENT_LIMIT = 5;

interface HomeSurfaceProps {
  /**
   * Which credential backend the host reports, or `null` while the bridge has
   * not answered. Passed down rather than re-fetched so the bridge is probed
   * once per mount.
   */
  readonly secretBackend?: string | null;
}

const PROPOSITION: readonly { readonly heading: string; readonly body: string }[] = [
  {
    heading: 'You bring the model',
    body: 'A runtime on your own machine, an API key you already pay for, or a subscription endpoint. Vela ships no model and has no opinion about which one you use.',
  },
  {
    heading: 'Vela brings the rest',
    body: 'Conversations, projects, search, tools, and a transcript that keeps the model’s reasoning separate from its answer — the same regardless of what is answering.',
  },
  {
    heading: 'Nothing leaves except what you point it at',
    body: 'No telemetry, no analytics, no account. The only outbound request is the one going to the endpoint you configured, and everything is stored in a database on this device.',
  },
];

export function HomeSurface({ secretBackend = null }: HomeSurfaceProps) {
  const adapter = usePlatform();
  const { conversations, createConversation } = useConversations();
  const select = useNavigationStore((state) => state.select);
  const openPalette = useNavigationStore((state) => state.openPalette);

  const recent = conversations.slice(0, RECENT_LIMIT);

  /**
   * This screen is the second rung of the focus ladder. It is also a screen
   * that can appear *because* something went away — deleting the open
   * conversation closes it and lands the user here — though that is no longer
   * the only way to reach it: `select(null)` had exactly one caller in product
   * code, the delete path in `use-conversations.ts`, so until the sidebar grew a
   * **Home** control the only route back to this screen was to destroy a
   * conversation. That path is unchanged; it is no longer the only one.
   *
   * So it does two things. It registers its primary action as a destination
   * other surfaces can fall back to, and on arrival it takes the keyboard **if
   * and only if nothing else holds it**. The condition is the whole point: an
   * unconditional autofocus would yank the caret out from under a user who
   * opened this screen deliberately and is already typing somewhere.
   */
  const primary = useRef<HTMLButtonElement>(null);
  const anchor = useFocusAnchor<HTMLButtonElement>('primary');
  useEffect(() => {
    claimKeyboardIfHomeless(primary.current);
  }, []);

  return (
    <div className={styles.home}>
      <header className={styles.hero}>
        <span className={styles.mark}>
          <VelaMark size={30} title="Vela" />
        </span>
        <h1 className={styles.title}>Vela</h1>
        <p className={styles.lede}>
          A desktop workspace for any model you can reach — and only the ones you choose to reach.
        </p>
      </header>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          ref={(node) => {
            primary.current = node;
            anchor(node);
          }}
          onClick={() => void createConversation()}
        >
          Start a conversation
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => {
            openPalette('search');
          }}
        >
          Search everything
          <ShortcutHint keyName="K" className={styles.kbd} />
        </button>
      </div>

      <section className={styles.proposition} aria-label="What Vela is">
        {PROPOSITION.map((point) => (
          <article key={point.heading} className={styles.point}>
            <h2 className={styles.pointHeading}>{point.heading}</h2>
            <p className={styles.pointBody}>{point.body}</p>
          </article>
        ))}
      </section>

      {recent.length > 0 && (
        <section className={styles.recent} aria-label="Recent conversations">
          <h2 className={styles.recentHeading}>Pick up where you left off</h2>
          <ul className={styles.recentList}>
            {recent.map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  className={styles.recentItem}
                  onClick={() => {
                    select(conversation.id);
                  }}
                >
                  <span className={styles.recentTitle}>{conversation.title}</span>
                  <span className={styles.recentMeta}>
                    {conversation.messageCount === 0
                      ? 'Nothing said yet'
                      : `${conversation.messageCount} messages`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className={styles.facts}>
        <dl className={styles.factList}>
          <div className={styles.fact}>
            <dt>Platform</dt>
            <dd data-testid="adapter-kind">{adapter.kind}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Credential store</dt>
            <dd data-testid="secret-backend">
              {secretBackend === null
                ? 'checking…'
                : `${secretBackend}${secretBackend === 'os-keychain' ? '' : ' (not a real keychain)'}`}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Telemetry</dt>
            <dd>off — there is no command that can turn it on</dd>
          </div>
        </dl>
      </footer>
    </div>
  );
}
