/**
 * The composition root of the UI tree. The only place that mounts the platform
 * provider. Keep it boring: wiring, not logic.
 */

import { PlatformProvider } from '@/platform/PlatformProvider';
import type { PlatformAdapter } from '@/platform/adapter';

import { AppShell } from './shell/AppShell';

interface AppProps {
  /** Injected by tests. Left undefined in production so the runtime is auto-detected. */
  readonly adapter?: PlatformAdapter;
}

export function App({ adapter }: AppProps) {
  return (
    <PlatformProvider {...(adapter === undefined ? {} : { adapter })}>
      <AppShell />
    </PlatformProvider>
  );
}
