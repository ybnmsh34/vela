/**
 * The empty conversation — the first thing a new user sees.
 *
 * It does one job no other screen can do: say plainly **what this model can
 * actually do**, before the user asks it for something it cannot. That list is
 * read from the capability struct, so it is honest for a 1.5B local model and
 * for a frontier API alike, and it needs no change when a new backend is added.
 *
 * What it deliberately does not do is suggest prompts. Vela does not know which
 * model is behind the seam or what it is good at, and a suggestion the endpoint
 * fumbles is a worse first impression than no suggestion at all.
 *
 * ## The lede, and the claim it is no longer allowed to make
 *
 * It read: *"This conversation runs on X. Nothing leaves your machine except the
 * request you send it."* Failover falsifies both halves. The router tries the
 * endpoint the user chose and then every other configured one behind it, so the
 * conversation does not necessarily *run on* `X`, and a request that moves to a
 * hosted fallback does leave the machine — which is precisely the reassurance a
 * privacy-motivated user reads this screen for before deciding to trust the app.
 *
 * The replacement asserts only things that stay true when a turn fails over, and
 * that are properties of Vela rather than guesses about a network it cannot
 * observe:
 *
 * * **"addressed to"**, not "runs on". Addressing is what the user did; where
 *   the answer came from is a fact about the turn, and the turn reports it
 *   itself (`TurnNotices`'s `AnsweredByNote`).
 * * **"never contacts an endpoint you have not configured"** — true *because* of
 *   how failover works, not in spite of it: `ProviderHost::router_for` builds
 *   its candidate list out of `installed` configurations and skips any that are
 *   not usable, so there is no reachable path to an endpoint the user did not
 *   set up. Together with conventions §0 rule 1, that is the whole of Vela's
 *   outbound behaviour.
 * * **"sends nothing of its own alongside your turns"** — §0 rule 1 again: no
 *   telemetry, no analytics, not behind a flag.
 *
 * What it deliberately still does not say is where the bytes go. The renderer
 * cannot observe that, and inventing a claim it cannot verify is the same fault
 * as the sentence it replaced.
 */

import { VelaMark } from '@/components/VelaMark';
import type { ChatCapabilities } from '@/platform/contract';

import styles from './EmptyConversation.module.css';

interface EmptyConversationProps {
  readonly capabilities: ChatCapabilities;
  /** What the user chose, as they named it. Never a backend identity. */
  readonly modelLabel: string | null;
}

interface CapabilityLine {
  readonly label: string;
  readonly available: boolean;
}

/**
 * Capabilities worth stating up front, as flags — never as a provider name.
 *
 * Absence is shown, not hidden: "no image input" is information, and a user who
 * can see it will not spend a minute wondering why there is no attach button.
 */
function capabilityLines(capabilities: ChatCapabilities): CapabilityLine[] {
  return [
    { label: 'Streams token by token', available: capabilities.streaming },
    { label: 'Shows its reasoning', available: capabilities.reasoning },
    { label: 'Accepts images', available: capabilities.vision },
    { label: 'Calls tools', available: capabilities.toolCalls },
    { label: 'Reports token usage', available: capabilities.usageReporting },
  ];
}

export function EmptyConversation({ capabilities, modelLabel }: EmptyConversationProps) {
  const lines = capabilityLines(capabilities);
  const known = lines.filter((line) => line.available);

  return (
    <div className={styles.empty}>
      <div className={styles.mark}>
        <VelaMark size={34} title="Vela" />
      </div>

      <h2 className={styles.title}>
        {modelLabel === null ? 'No model chosen yet' : `Ready when you are`}
      </h2>

      <p className={styles.lede}>
        {modelLabel === null
          ? 'Vela runs on whatever model you point it at — something on this machine, or an endpoint you hold the key to. Choose one to start.'
          : `This conversation is addressed to ${modelLabel}. Vela never contacts an endpoint you have not configured, and sends nothing of its own alongside your turns. If one of your other endpoints answers a turn, that turn says so.`}
      </p>

      <ul className={styles.capabilities} aria-label="What this model can do">
        {lines.map((line) => (
          <li key={line.label} className={styles.capability} data-available={String(line.available)}>
            <span className={styles.tick} aria-hidden="true">
              {line.available ? '✓' : '—'}
            </span>
            <span>{line.label}</span>
          </li>
        ))}
      </ul>

      {known.length === 0 ? (
        <p className={styles.note}>
          Nothing has been established about this model yet. Vela does not guess: an affordance
          appears once the endpoint has proved it works, and not before.
        </p>
      ) : null}
    </div>
  );
}
