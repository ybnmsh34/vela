/**
 * The cowork dock: the parallel-task switcher, and one of three panels.
 *
 * ## Why this is a modal sheet and not a persistent right-hand dock
 *
 * A dock alongside the transcript is the better surface and it is not what this
 * builds. The four panes this app already has — memory, skills, schedules,
 * projects — are all `ModalSurface` dialogs, and going through that component is
 * what buys the containment: it is the only place `aria-modal` is written, next
 * to the Tab wrap that makes the claim true, plus focus capture on open and the
 * `returnFocusTo` ladder on close. A hand-rolled dock gets none of that and,
 * per that component's own header, "two hand-rolled traps would be the third
 * dialog waiting to be wrong".
 *
 * The persistent dock also needs the shell's grid changed — `AppShell.tsx` and
 * `NavigationSurface.module.css` — and I could not verify the resulting layout
 * at 100/125/150% without launching Vela, which this track is forbidden to do.
 * Choosing the shape I can actually check over the shape I would prefer is the
 * trade, and it is recorded rather than quietly made.
 *
 * ## The task switcher is the sidebar's list, filtered to tasks
 *
 * Selecting a row calls `navigation-store`'s `select`, which is the same action
 * the sidebar's conversation rows call — so switching tasks here and switching
 * conversations there are one operation with one piece of state, not two that
 * can disagree. `aria-current="page"` marks the active one, matching
 * `ConversationRow.tsx` exactly.
 */

import { useRef } from 'react';

import { ModalSurface } from '@/components/ModalSurface';
import type { HarnessRuntime } from '@/platform/contract-harness';
import type { ProjectId } from '@/platform/contract-project';
import { COWORK_PANELS, tasksIn, useCoworkStore, type CoworkPanel } from '@/state/cowork-store';
import { useNavigationStore } from '@/state/navigation-store';

import { ContextPanel } from './ContextPanel';
import { ProgressPanel } from './ProgressPanel';
import { ProjectFilesPanel } from './ProjectFilesPanel';
import styles from './CoworkPanel.module.css';
import { useConnectors } from './use-connectors';
import { useCowork } from './use-cowork';
import { useProjectLayout } from './use-project-layout';

const PANEL_LABEL: Readonly<Record<CoworkPanel, string>> = {
  progress: 'Progress',
  project: 'Project',
  context: 'Context',
};

interface CoworkPanelProps {
  readonly onClose: () => void;
  readonly runtime: HarnessRuntime | null;
  readonly projectId: ProjectId | null;
}

export function CoworkDock({ onClose, runtime, projectId }: CoworkPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  const panel = useCoworkStore((store) => store.panel);
  const showPanel = useCoworkStore((store) => store.showPanel);
  const plans = useCoworkStore((store) => store.plans);

  const conversationId = useNavigationStore((store) => store.selectedConversationId);
  const select = useNavigationStore((store) => store.select);

  const cowork = useCowork(runtime, conversationId);
  // Both reads run for as long as the dock is open, not per tab. Switching to
  // the project tab and back would otherwise re-read the layout — and reading a
  // layout *repairs*, so a tab click would be a write.
  const layout = useProjectLayout(projectId);
  const connectors = useConnectors();

  const tasks = tasksIn(plans);

  return (
    <ModalSurface
      label="Cowork"
      scrimClassName={styles.scrim}
      className={styles.dialog}
      initialFocus={closeRef}
      onDismiss={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className={styles.head}>
        <h2 className={styles.title}>Cowork</h2>
        <button type="button" ref={closeRef} className={styles.close} onClick={onClose}>
          Close
        </button>
      </div>

      {tasks.length > 0 && (
        <ul className={styles.tasks} aria-label="Tasks">
          {tasks.map((task) => (
            <li key={task.conversationId}>
              <button
                type="button"
                className={styles.taskRow}
                data-testid={`cowork-task-${task.conversationId}`}
                aria-current={task.conversationId === conversationId ? 'page' : undefined}
                onClick={() => {
                  select(task.conversationId);
                }}
              >
                <span>{task.conversationId}</span>
                <span className={styles.taskCount}>
                  {task.plan.state === 'running'
                    ? `step ${task.plan.currentStep} of ${task.plan.steps.length}`
                    : task.plan.state === 'stopped'
                      ? 'stopped'
                      : 'not started'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* A tablist, so one Tab enters it and the arrow keys move within — the
          same keyboard economy the sidebar's roving tabindex buys, and the
          pattern a screen reader already knows. */}
      <div className={styles.tabs} role="tablist" aria-label="Cowork panels">
        {COWORK_PANELS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`cowork-tab-${name}`}
            aria-selected={panel === name}
            aria-controls={`cowork-panel-${name}`}
            tabIndex={panel === name ? 0 : -1}
            className={styles.tab}
            onClick={() => {
              showPanel(name);
            }}
            onKeyDown={(event) => {
              const at = COWORK_PANELS.indexOf(name);
              const to =
                event.key === 'ArrowRight'
                  ? (at + 1) % COWORK_PANELS.length
                  : event.key === 'ArrowLeft'
                    ? (at - 1 + COWORK_PANELS.length) % COWORK_PANELS.length
                    : null;
              if (to === null) return;
              event.preventDefault();
              const next = COWORK_PANELS[to];
              if (next === undefined) return;
              showPanel(next);
              // The arrows move focus with the selection, which is what
              // `aria-activedescendant`-free tablists do; without it the
              // keyboard is left on a tab that is no longer selected.
              document.getElementById(`cowork-tab-${next}`)?.focus();
            }}
          >
            {PANEL_LABEL[name]}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`cowork-panel-${panel}`}
        aria-labelledby={`cowork-tab-${panel}`}
        // Focusable but not tabbable, so a panel with no controls in it — the
        // empty progress panel — is still somewhere the keyboard can land.
        tabIndex={-1}
        className={styles.commentForm}
      >
        {panel === 'progress' && <ProgressPanel cowork={cowork} />}
        {panel === 'project' && <ProjectFilesPanel layout={layout} />}
        {panel === 'context' && <ContextPanel connectors={connectors} />}
      </div>
    </ModalSurface>
  );
}
