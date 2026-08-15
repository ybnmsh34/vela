/**
 * The composition root of the UI tree. The only place that mounts the platform
 * provider. Keep it boring: wiring, not logic.
 */

import { useMemo, useState } from 'react';

import { ConversationSurface } from '@/features/conversation';
import { ModelWorkspace, useSelectedModel } from '@/features/models';
import { PlatformProvider, usePlatform } from '@/platform/PlatformProvider';
import type { PlatformAdapter } from '@/platform/adapter';
import type { HarnessRuntime } from '@/platform/contract-harness';
import { createAgentRuntime } from '@/runtime/app-runtime';
import { useNavigationStore } from '@/state/navigation-store';

import { AppShell } from './shell/AppShell';
import { KeyboardProvider } from '@/platform/KeyboardProvider';

interface AppProps {
  /** Injected by tests. Left undefined in production so the runtime is auto-detected. */
  readonly adapter?: PlatformAdapter;
}

export function App({ adapter }: AppProps) {
  return (
    <PlatformProvider {...(adapter === undefined ? {} : { adapter })}>
      <KeyboardProvider>
        <AppShell>
          <Workspace />
        </AppShell>
      </KeyboardProvider>
    </PlatformProvider>
  );
}

/**
 * Joins the three features that meet here: navigation says *which* conversation,
 * the models feature says *where it runs and what that model can do*, and the
 * conversation surface draws *what is in it*. None of the three imports another.
 *
 * The models feature wraps rather than sits beside the transcript, because the
 * transcript needs what it chose: an endpoint to address and a capability struct
 * to render affordances from. Both arrive through `useSelectedModel`.
 *
 * ## The one thing that travels back up, and why it lives here
 *
 * `ModelWorkspace` draws the context meter and the transcript is in its slot,
 * so the meter cannot see what the turn holds — a parent cannot read its
 * children. Something has to carry it, and a composition root is exactly the
 * place: `ConversationSurface` reports what pressing send would put on the
 * wire, this holds it, and `ModelWorkspace` measures it.
 *
 * That connection did not exist. `<ModelWorkspace>` was mounted with no
 * `turnTexts` at all, so the meter measured a permanently empty array: typing
 * 880,000 characters left it reading "About 0 of 200,000 tokens", and the
 * transcript already on screen was never counted either. Both components were
 * correct and separately tested. Nothing joined them, and the joint is here.
 *
 * `null` is the honest initial value, not `[]`: until the surface in the slot
 * has reported, this root does not know what the turn holds, and the meter says
 * "unknown" for that frame rather than "about 0".
 *
 * ## The other joint, and the same lesson twice
 *
 * The staged attachments travel the *other* way down the same seam: the models
 * workspace owns the picker and the tray, the transcript owns the send, and
 * `useSelectedModel().attachments` is how the one reaches the other.
 *
 * That property was on the context, populated, and read by nobody. So the
 * attach button staged a file, the tray showed it, and pressing Send sent the
 * message without it — no error, no warning, nothing. The IPC could carry an
 * image (GATE M Part 2 proved it against a real model) and the hook could
 * produce one; the renderer never put one in the payload. Both halves worked.
 * The joint is here, and it is one line.
 *
 * ## The third joint: the agent runtime
 *
 * `src/runtime/` is a whole agent loop — a registry, a live-run directory with
 * replay, a harness that executes tool calls and feeds them back, and real
 * parallel subagents. It shipped reachable from **nothing but its own tests**,
 * which is the same defect as the two above with a bigger blast radius.
 *
 * It is built **here**, once, and handed down. Not inside the surface that uses
 * it: `App` remounts the transcript on `key={conversationId}`, so a runtime
 * built down there would take its directory — and every run in flight — with it
 * every time the user clicked another conversation. Not a module singleton
 * either (conventions §4). One runtime per adapter, above the remount, which is
 * what `HarnessRuntime` in `src/platform/contract-harness.ts` means by "built
 * once at the composition root and passed down".
 */
function Workspace() {
  const conversationId = useNavigationStore((state) => state.selectedConversationId);
  const [turnTexts, setTurnTexts] = useState<readonly string[] | null>(null);
  const adapter = usePlatform();
  const runtime = useMemo<HarnessRuntime>(() => createAgentRuntime(adapter), [adapter]);

  return (
    <ModelWorkspace hasHistory={conversationId !== null} turnTexts={turnTexts}>
      <Transcript onPendingTurn={setTurnTexts} runtime={runtime} />
    </ModelWorkspace>
  );
}

/**
 * The `key` is the load-bearing part. Switching conversations must not leave the
 * previous transcript's streaming state attached to the new one, and remounting
 * on the id is the cheapest way to make that impossible rather than merely
 * unlikely.
 *
 * Remounting is also what made the *other* half of this necessary. A remount
 * discards the surface's state, so for as long as the transcript lived only in
 * that state, clicking another conversation and clicking back was enough to
 * lose everything said in it — with `transcript.rs`, `store_append_message`,
 * their contract types and their fake all written, tested, and called by
 * nothing. Handing the id down is the whole connection: given one, the surface
 * reads the conversation back and writes each settled turn to it.
 */
function Transcript({
  onPendingTurn,
  runtime,
}: {
  readonly onPendingTurn: (texts: readonly string[]) => void;
  readonly runtime: HarnessRuntime;
}) {
  const conversationId = useNavigationStore((state) => state.selectedConversationId);
  const { selection, capabilities, attachments } = useSelectedModel();

  return (
    <ConversationSurface
      key={conversationId ?? 'none'}
      conversationId={conversationId}
      providerId={selection?.providerId ?? null}
      modelId={selection?.modelId ?? null}
      modelLabel={selection?.modelLabel ?? null}
      capabilities={capabilities}
      attachments={attachments}
      runtime={runtime}
      onPendingTurn={onPendingTurn}
    />
  );
}
