/**
 * Window layout that survives a restart.
 *
 * Deliberately not `localStorage`: Vela's system of record is the user's own
 * database, and a sidebar width kept in webview storage lives somewhere the
 * user cannot back up and the browser profile can clear.
 *
 * The host clamps rather than rejects, so this layer never has to validate a
 * width — it reads back whatever the host decided is usable, which is the value
 * the UI must actually render.
 */

import type { PlatformAdapter } from '@/platform/adapter';
import type { UiLayout } from '@/platform/contract';

export interface LayoutRepository {
  get(): Promise<UiLayout>;
  /** Returns the layout **as the host stored it**, which may be clamped. */
  set(layout: UiLayout): Promise<UiLayout>;
}

export function createLayoutRepository(adapter: PlatformAdapter): LayoutRepository {
  return {
    get(): Promise<UiLayout> {
      return adapter.invoke('ui_get_layout', {});
    },
    set(layout: UiLayout): Promise<UiLayout> {
      return adapter.invoke('ui_set_layout', layout);
    },
  };
}
