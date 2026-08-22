/**
 * The window title bar.
 *
 * The Tauri window is created with `decorations: false`, so this element *is*
 * the title bar — including the caption buttons at the right, which the OS is
 * not drawing for us. `data-tauri-drag-region` makes the spacer draggable; in a
 * browser it is inert, which is exactly what we want when the app is rendered
 * headlessly.
 *
 * ## The three caption buttons
 *
 * Order is the Windows order — minimise, maximise/restore, close — and they sit
 * in the top-right corner because that is where a Windows user's cursor goes.
 * They are `<button>`s *outside* the drag region: Tauri's drag script treats a
 * clickable element as blocking a drag, and anything inside a drag region has
 * its clicks swallowed by the window drag instead.
 *
 * The maximise control's icon is derived from what the window says, never from
 * what was clicked — see `use-window-controls.ts`, which owns that rule.
 *
 * ## Close, and not reaching it by accident
 *
 * Closing is the one control here that loses work. Four things keep it from
 * being hit by mistake, and all four are asserted in `window-controls.test.tsx`:
 * it is **last** in the tab order, so nothing tabs *through* it on the way
 * somewhere else; nothing focuses it at mount; it is outside the drag region,
 * so the double-click-to-maximise gesture can never land on it; and it acts on
 * a real click — press it and slide off and nothing happens, unlike the drag
 * region's deliberately `mousedown`-driven double click.
 */

import type { MouseEvent } from 'react';

import { VelaMark } from '@/components/VelaMark';
import type { ThemePreference } from '@/state/theme-store';

import styles from './TitleBar.module.css';
import { useTheme } from './use-theme';
import { useWindowControls } from './use-window-controls';

const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'Theme: system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

interface TitleBarProps {
  /** Short context string shown next to the wordmark, e.g. the open workspace. */
  readonly context?: string;
}

/**
 * The caption glyphs, drawn rather than typed.
 *
 * Windows draws these from Segoe Fluent Icons, which a webview cannot rely on
 * and the strict CSP would not let us fetch anyway. Hairlines on the half-pixel
 * so a 1px stroke lands on a device pixel rather than across two.
 */
function CaptionGlyph({ shape }: { readonly shape: 'minimise' | 'maximise' | 'restore' | 'close' }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      aria-hidden="true"
      focusable="false"
    >
      {shape === 'minimise' && <path d="M0.5 5.5 H9.5" />}
      {shape === 'maximise' && <rect x="0.5" y="0.5" width="9" height="9" />}
      {shape === 'restore' && (
        <>
          {/* the window behind, and the one in front — restore-down */}
          <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" />
          <rect x="0.5" y="2.5" width="7" height="7" />
        </>
      )}
      {shape === 'close' && <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" />}
    </svg>
  );
}

export function TitleBar({ context }: TitleBarProps) {
  // Through the hook rather than straight into the store: the store is client
  // state with no IPC in it (conventions §5), and the preference has somewhere
  // to be *kept*. Reading the store directly is what left `settings_set_theme`
  // without a caller and the user's choice discarded at every restart.
  const { preference, cycle: cyclePreference } = useTheme();
  const { maximized, minimize, toggleMaximize, close } = useWindowControls();

  /**
   * Double-click the title bar to maximise — the Windows convention.
   *
   * On `mousedown` with `detail === 2`, not on `dblclick`, and that is not a
   * stylistic choice. The first click of the pair has already handed the window
   * to the OS drag loop (`"start_dragging"`), which consumes the mouse-up; a
   * `dblclick` may therefore never be dispatched, while the second `mousedown`
   * always is. Tauri's own drag script does exactly this, for exactly that
   * reason.
   *
   * `stopPropagation` is what keeps it to *one* toggle. Tauri's script listens
   * on `document` and, on this same event, invokes `"internal_toggle_maximize"`
   * — two toggles on one gesture reads as a control that does nothing. Stopping
   * here means the renderer owns the gesture: one call, through the seam, with
   * a re-read of the window behind it. `capabilities/main.json` withholds
   * `core:window:allow-internal-toggle-maximize` for the same reason, and
   * `window-controls.test.tsx` fails if either half of that is undone.
   */
  const onDragRegionMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.detail !== 2) return;
    event.stopPropagation();
    // Suppresses the text-selection cursor the double click would otherwise
    // leave behind. It does not affect the single-click drag, which is not
    // handled here at all.
    event.preventDefault();
    toggleMaximize();
  };

  return (
    <header className={styles.bar}>
      <div className={styles.identity}>
        <span className={styles.mark}>
          <VelaMark size={16} title="Vela" />
        </span>
        <span className={styles.wordmark}>Vela</span>
      </div>
      {context !== undefined && <span className={styles.context}>{context}</span>}

      <div className={styles.drag} data-tauri-drag-region onMouseDown={onDragRegionMouseDown} />

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          onClick={cyclePreference}
          aria-label={THEME_LABEL[preference]}
        >
          {THEME_LABEL[preference]}
        </button>
      </div>

      <div className={styles.caption} role="group" aria-label="Window">
        <button
          type="button"
          className={styles.captionButton}
          onClick={minimize}
          aria-label="Minimise"
          title="Minimise"
        >
          <CaptionGlyph shape="minimise" />
        </button>
        <button
          type="button"
          className={styles.captionButton}
          onClick={toggleMaximize}
          aria-label={maximized ? 'Restore' : 'Maximise'}
          title={maximized ? 'Restore' : 'Maximise'}
        >
          <CaptionGlyph shape={maximized ? 'restore' : 'maximise'} />
        </button>
        <button
          type="button"
          className={`${styles.captionButton} ${styles.closeButton}`}
          onClick={close}
          aria-label="Close"
          title="Close"
        >
          <CaptionGlyph shape="close" />
        </button>
      </div>
    </header>
  );
}
