/**
 * React binding for the platform seam.
 *
 * Components call `usePlatform()`. They never construct an adapter and never
 * import `@tauri-apps/api`. Tests wrap the component under test in
 * `<PlatformProvider adapter={new BrowserAdapter()}>` — that is the whole
 * substitution mechanism.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { PlatformAdapter } from './adapter';
import { createPlatformAdapter } from './index';

const PlatformContext = createContext<PlatformAdapter | null>(null);

export interface PlatformProviderProps {
  /** Omit in the app root to auto-select; pass a fake in tests. */
  readonly adapter?: PlatformAdapter;
  readonly children: ReactNode;
}

export function PlatformProvider({ adapter, children }: PlatformProviderProps): ReactNode {
  const value = useMemo(() => adapter ?? createPlatformAdapter(), [adapter]);
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): PlatformAdapter {
  const adapter = useContext(PlatformContext);
  if (adapter === null) {
    throw new Error(
      'usePlatform() called outside <PlatformProvider>. Wrap the tree (or, in a test, the component under test) in a PlatformProvider.',
    );
  }
  return adapter;
}
