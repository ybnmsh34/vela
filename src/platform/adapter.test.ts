import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BrowserAdapter } from './browser-adapter';
import { createPlatformAdapter, isTauriRuntime } from './index';
import { TauriAdapter } from './tauri-adapter';

const SRC_ROOT = join(process.cwd(), 'src');

/** The one file allowed to import `@tauri-apps/api`, relative to `src/`. */
const TAURI_IMPORT_OWNER = 'platform/tauri-adapter.ts';

/** Comments mention the forbidden import on purpose (to explain the rule), so
 * strip them before scanning. Crude but sufficient for TS/TSX sources. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (['.ts', '.tsx'].includes(extname(entry.name))) {
      found.push(path);
    }
  }
  return found;
}

describe('adapter seam', () => {
  it('is the only place the frontend touches @tauri-apps/api', () => {
    // This guard is what keeps the app runnable in a plain browser. If it
    // fails, a component has reached past the seam and the frontend can no
    // longer be rendered or screenshotted headlessly.
    const offenders = sourceFiles(SRC_ROOT)
      .filter((path) =>
        /(?:from|import\(|require\()\s*['"]@tauri-apps\/api/.test(
          stripComments(readFileSync(path, 'utf8')),
        ),
      )
      .map((path) => relative(SRC_ROOT, path).split('\\').join('/'))
      .filter((path) => path !== TAURI_IMPORT_OWNER);

    expect(offenders, `only ${TAURI_IMPORT_OWNER} may import @tauri-apps/api`).toEqual([]);
  });

  it('selects the browser fake when Tauri internals are absent', () => {
    expect(isTauriRuntime({})).toBe(false);
    expect(createPlatformAdapter({})).toBeInstanceOf(BrowserAdapter);
    expect(createPlatformAdapter({}).kind).toBe('browser');
  });

  it('selects the real bridge when Tauri internals are present', () => {
    const tauriScope = { __TAURI_INTERNALS__: {} };
    expect(isTauriRuntime(tauriScope)).toBe(true);
    expect(createPlatformAdapter(tauriScope)).toBeInstanceOf(TauriAdapter);
    expect(createPlatformAdapter(tauriScope).kind).toBe('tauri');
  });

  it('gives both implementations the same command surface', () => {
    const browser = new BrowserAdapter();
    const tauri = new TauriAdapter();
    for (const method of ['invoke', 'listen'] as const) {
      expect(typeof browser[method]).toBe('function');
      expect(typeof tauri[method]).toBe('function');
    }
  });
});
