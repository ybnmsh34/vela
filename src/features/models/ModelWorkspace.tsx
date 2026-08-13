/**
 * The workspace around a transcript: which model, what it can do, what is
 * attached — and the transcript itself in the slot.
 *
 * The transcript surface is a `children` slot rather than an import, so this
 * feature does not depend on the conversation feature (or the other way round).
 * What the two share travels through {@link SelectedModelContext}: the chosen
 * endpoint, its capability struct, and the staged attachments. That is the whole
 * interface between them.
 *
 * ## What the context meter can and cannot see
 *
 * It measures what this surface holds: the staged files, plus whatever the host
 * surface passes as `turnTexts`. It cannot reach into the transcript, and it
 * does not pretend to — the readout says "this turn". The *window* it measures
 * against is the endpoint's own number, and when the endpoint reports none, the
 * meter says so and draws no bar.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import {
  AttachmentControls,
  AttachmentDropZone,
  AttachmentTray,
  useAttachments,
  type AttachmentsController,
} from '@/features/attachments';
import type { ChatCapabilities, ModelCapabilityReport } from '@/platform/contract';
import { NO_CAPABILITIES } from '@/platform/contract';
import type { ModelSelection } from '@/state/model-store';

import { EndpointsPanel } from './EndpointsPanel';
import { ModelBar } from './ModelBar';
import styles from './ModelWorkspace.module.css';
import { useModelSelection } from './use-model-selection';
import { useProviders } from './use-providers';

/**
 * What a transcript surface needs from the model feature.
 *
 * Deliberately small: an address to send to, a flag set to render affordances
 * from, and the files staged for the next message. No provider identity beyond
 * the id the user chose, and nothing a component could branch a backend on.
 */
export interface SelectedModel {
  readonly selection: ModelSelection | null;
  readonly capabilities: ChatCapabilities;
  readonly report: ModelCapabilityReport | null;
  readonly attachments: AttachmentsController;
}

const SelectedModelContext = createContext<SelectedModel | null>(null);

/**
 * The chosen model, for anything mounted inside a {@link ModelWorkspace}.
 *
 * Outside one it returns the pessimistic floor rather than throwing: a surface
 * rendered on its own in a test should offer nothing, not crash.
 */
export function useSelectedModel(): SelectedModel {
  const value = useContext(SelectedModelContext);
  return value ?? EMPTY_SELECTION;
}

const EMPTY_ATTACHMENTS: AttachmentsController = {
  attachments: [],
  refused: [],
  totalBytes: 0,
  vision: false,
  add: () => undefined,
  remove: () => undefined,
  clear: () => undefined,
  dismissRefusals: () => undefined,
  toContentParts: () => Promise.resolve([]),
};

const EMPTY_SELECTION: SelectedModel = {
  selection: null,
  capabilities: NO_CAPABILITIES,
  report: null,
  attachments: EMPTY_ATTACHMENTS,
};

const NO_PROVIDERS = [] as const;

interface ModelWorkspaceProps {
  readonly children?: ReactNode;
  /** Whether a conversation is open, which is what makes a switch consequential. */
  readonly hasHistory?: boolean;
  /** Anything else this turn will send, for the context estimate. */
  readonly turnTexts?: readonly string[];
}

export function ModelWorkspace({
  children,
  hasHistory = false,
  turnTexts = [],
}: ModelWorkspaceProps) {
  const providers = useProviders();
  const providerList = providers.state.status === 'ready' ? providers.state.providers : NO_PROVIDERS;
  const models = useModelSelection(providerList);
  const attachments = useAttachments({ vision: models.capabilities.vision });
  const [endpointsOpen, setEndpointsOpen] = useState(false);

  const value = useMemo<SelectedModel>(
    () => ({
      selection: models.selection,
      capabilities: models.capabilities,
      report: models.report,
      attachments,
    }),
    [models.selection, models.capabilities, models.report, attachments],
  );

  // A staged text file is charged at its byte count, which for text is close
  // enough to a character count. Images are deliberately *not* charged: what an
  // endpoint spends on one is model-specific and unknowable here, and a made-up
  // number in a budget is worse than an acknowledged gap.
  const texts = useMemo(
    () => [
      ...turnTexts,
      ...attachments.attachments
        .filter((attachment) => attachment.kind === 'text')
        .map((attachment) => 'x'.repeat(attachment.size)),
    ],
    [turnTexts, attachments.attachments],
  );

  return (
    <SelectedModelContext.Provider value={value}>
      <div className={styles.workspace}>
        <ModelBar
          entries={models.entries}
          selection={models.selection}
          report={models.report}
          hasHistory={hasHistory}
          probing={models.probing}
          probeFailure={models.probeFailure}
          switchedFrom={models.switchedFrom}
          texts={texts}
          onSelect={models.select}
          onProbe={() => {
            void models.probe();
          }}
          onAcknowledgeSwitch={models.acknowledgeSwitch}
          onDiscover={(providerId) => {
            void models.discover(providerId);
          }}
          onConfigure={() => {
            setEndpointsOpen(true);
          }}
          attachments={
            <AttachmentControls
              vision={models.capabilities.vision}
              onFiles={(files) => {
                attachments.add(files);
              }}
            />
          }
        />

        <AttachmentTray
          attachments={attachments.attachments}
          refused={attachments.refused}
          onRemove={attachments.remove}
          onDismissRefusals={attachments.dismissRefusals}
        />

        {endpointsOpen ? (
          <div className={styles.endpoints}>
            <EndpointsPanel
              state={providers.state}
              onSave={providers.save}
              onRemove={providers.remove}
              onStoreCredential={providers.storeCredential}
              onClearCredential={providers.clearCredential}
              onClose={() => {
                setEndpointsOpen(false);
              }}
            />
          </div>
        ) : (
          <AttachmentDropZone
            vision={models.capabilities.vision}
            onFiles={(files) => {
              attachments.add(files);
            }}
          >
            {children}
          </AttachmentDropZone>
        )}
      </div>
    </SelectedModelContext.Provider>
  );
}
