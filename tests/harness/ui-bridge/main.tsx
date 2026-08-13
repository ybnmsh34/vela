/**
 * The GATE M UI-matrix entry point.
 *
 * It is `src/main.tsx` with exactly one line changed: the adapter passed to
 * `<App/>`. Everything rendered from here — shell, navigation, model workspace,
 * conversation surface, composer — is the shipping component tree, imported
 * from `src/`, with the shipping stylesheet.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/App';
import '@/styles/base.css';

import { RelayAdapter } from './relay-adapter';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App adapter={new RelayAdapter(relayBase())} />
  </StrictMode>,
);

/**
 * Where the relay is listening. Passed as `?relay=` by the driver so the page
 * and the bridge can be on different ports without a build-time constant.
 */
function relayBase(): string {
  const configured = new URLSearchParams(window.location.search).get('relay');
  return configured ?? 'http://127.0.0.1:8420';
}
