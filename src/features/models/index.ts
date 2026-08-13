/**
 * The models feature's public face.
 *
 * A shell mounts {@link ModelWorkspace} with the transcript surface as its
 * child. The transcript reads {@link useSelectedModel} for the endpoint to
 * address, the capability struct to render affordances from, and the staged
 * attachments. Everything else — the switcher, probing, the endpoint editor, the
 * context meter, the degradation list — is internal.
 */

export { ModelWorkspace, useSelectedModel, type SelectedModel } from './ModelWorkspace';
export { ModelBar } from './ModelBar';
export { ModelSwitcher } from './ModelSwitcher';
export { CapabilitySummary } from './CapabilitySummary';
export { ContextMeter } from './ContextMeter';
export { EndpointForm } from './EndpointForm';
export { EndpointsPanel } from './EndpointsPanel';
export { SecurityNotice } from './SecurityNotice';
export { capabilityRows, degradations, type CapabilityRow } from './capability-rows';
export {
  defaultSelection,
  entryKey,
  isSelectable,
  modelEntries,
  selectionOf,
  stillExists,
  type EntryBlock,
  type ModelEntry,
} from './catalogue';
export { useModelSelection } from './use-model-selection';
export { useProviders, type ProvidersState } from './use-providers';
