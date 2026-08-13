/**
 * Every icon `tauri.conf.json` promises must actually be on disk.
 *
 * The second guard for a cloud-blind class. `src-tauri/icons/icon.ico` was
 * missing from this repo entirely until `a50ee9f`, and no run in this container
 * could see it: `tauri-build` only reaches for the `.ico` when the target OS is
 * windows, so on Linux the missing file is not an error, not a warning, not
 * anything. `cargo build` was green the whole time. On Windows the same build
 * fails outright with
 *
 *     `icons/icon.ico` not found; required for generating a Windows Resource
 *     file during tauri-build
 *
 * — a hard `Err` from `tauri_build::build()`, raised before a single line of
 * Vela's own Rust is compiled. Same shape as the case-collision defect next
 * door: green here by construction, fatal there.
 *
 * The `.ico` path is not hard-coded below, because `tauri-build` does not
 * hard-code it either. Its rule (tauri-build 2.6.3, `src/lib.rs`) is: take the
 * **first entry in `bundle.icon` ending in `.ico`**, and fall back to
 * `icons/icon.ico` when the list has none. This file re-implements that
 * resolution, so adding an `.ico` to the config moves what gets checked instead
 * of leaving this test guarding a path the build no longer uses.
 *
 * Regeneration: **`pnpm tauri icon <source.png>` is the preferred path.** It
 * takes one square source image and writes the whole set — the PNGs,
 * `icon.ico` for Windows, `icon.icns` for macOS — at the sizes and colour
 * depths each platform's bundler expects. Hand-authoring or hand-converting a
 * single member is how the set drifts out of sync in the first place.
 *
 * The detectors are parameterised on a root directory, so the tests proving
 * they can fail build a broken icon set in a throwaway temp directory. Nothing
 * here writes to, or removes from, the tree other builders are working in.
 *
 * What this cannot do is prove the `.ico` is a *valid* Windows resource — only
 * that it is present, non-empty and carries an ICO header. Compiling it is
 * `tauri-build`'s job, on Windows.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const TAURI_ROOT = join(process.cwd(), 'src-tauri');

interface TauriConfig {
  readonly bundle?: { readonly icon?: readonly string[] };
}

const config = JSON.parse(readFileSync(join(TAURI_ROOT, 'tauri.conf.json'), 'utf8')) as TauriConfig;

/** Paths as written in `bundle.icon`: relative to `src-tauri/`, `/`-separated. */
const DECLARED_ICONS = config.bundle?.icon ?? [];

/** Contents, or an empty view when the path cannot be read at all. */
function readBytes(root: string, relativePath: string): Uint8Array {
  try {
    return readFileSync(join(root, relativePath));
  } catch {
    return new Uint8Array();
  }
}

/** Bytes on disk, or `undefined` when the path is not a readable regular file. */
function fileSize(root: string, relativePath: string): number | undefined {
  try {
    const stats = statSync(join(root, relativePath));
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The declared icons that are absent or empty under `root`. A zero-byte icon is
 * reported alongside a missing one: it fails the same way, later and less
 * legibly.
 */
export function unusableIcons(root: string, icons: readonly string[]): readonly string[] {
  return icons.filter((icon) => (fileSize(root, icon) ?? 0) === 0);
}

/**
 * `tauri_build`'s own choice of Windows resource icon: first declared `.ico`,
 * else the conventional path. Mirrors the `.find(|i| i.ends_with(".ico"))
 * … .unwrap_or("icons/icon.ico")` in tauri-build's `src/lib.rs`.
 */
export function windowsResourceIcon(icons: readonly string[]): string {
  return icons.find((icon) => icon.endsWith('.ico')) ?? 'icons/icon.ico';
}

/**
 * An ICO header is `00 00` (reserved), `01 00` (type: icon), then a
 * little-endian image count of at least one. A PNG renamed to `.ico` passes
 * "the file exists" and then fails inside the resource compiler, which is a
 * much worse place to find out.
 */
export function hasIcoHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false;
  const [reserved0, reserved1, type0, type1] = bytes;
  const imageCount = (bytes[4] ?? 0) | ((bytes[5] ?? 0) << 8);
  return reserved0 === 0 && reserved1 === 0 && type0 === 1 && type1 === 0 && imageCount > 0;
}

describe('the bundle icon set is complete', () => {
  it('declares icons at all', () => {
    // Without this, the assertions below would iterate an empty list and the
    // file would pass while checking nothing.
    expect(DECLARED_ICONS.length).toBeGreaterThan(0);
  });

  it('ships every icon tauri.conf.json declares', () => {
    expect(
      unusableIcons(TAURI_ROOT, DECLARED_ICONS),
      'tauri.conf.json declares bundle.icon entries that are missing or empty ' +
        'under src-tauri/. The bundler resolves those paths relative to ' +
        'src-tauri/ and fails at package time. Regenerate the whole set with ' +
        '`pnpm tauri icon <source.png>` rather than adding one file by hand.',
    ).toEqual([]);
  });

  it('ships the .ico that tauri-build compiles into the Windows resource', () => {
    const ico = windowsResourceIcon(DECLARED_ICONS);
    expect(
      unusableIcons(TAURI_ROOT, [ico]),
      `src-tauri/${ico} is missing or empty. tauri-build requires it when the ` +
        'target OS is windows and returns a hard error before compiling any of ' +
        "Vela's code, so `cargo build` fails there while staying green on " +
        'Linux and macOS — no run in this container can observe it any other ' +
        'way. Regenerate with `pnpm tauri icon <source.png>`.',
    ).toEqual([]);
  });

  it('ships an .ico that is actually an ICO', () => {
    const ico = windowsResourceIcon(DECLARED_ICONS);
    expect(
      hasIcoHeader(readBytes(TAURI_ROOT, ico)),
      `src-tauri/${ico} is unreadable or does not begin with an ICO header. ` +
        'Something other than `pnpm tauri icon` produced it — most likely a ' +
        'PNG that was renamed rather than converted.',
    ).toBe(true);
  });
});

describe('the detectors can fail', () => {
  // A throwaway copy of the shape the repo had before a50ee9f: the PNGs
  // present, `icon.ico` absent. Built under the OS temp directory precisely so
  // that proving non-vacuity never puts a broken icon set into the shared tree.
  const scratchRoot = mkdtempSync(join(tmpdir(), 'vela-icon-guard-'));
  mkdirSync(join(scratchRoot, 'icons'), { recursive: true });
  writeFileSync(join(scratchRoot, 'icons', '32x32.png'), 'not empty');
  writeFileSync(join(scratchRoot, 'icons', 'icon.png'), '');

  afterAll(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  it('reports the icon.ico that was missing until a50ee9f', () => {
    expect(unusableIcons(scratchRoot, [windowsResourceIcon([])])).toEqual(['icons/icon.ico']);
  });

  it('reports a declared icon that is absent, and one that is empty', () => {
    expect(
      unusableIcons(scratchRoot, ['icons/32x32.png', 'icons/icon.png', 'icons/128x128.png']),
    ).toEqual(['icons/icon.png', 'icons/128x128.png']);
  });

  it('does not mistake a directory for an icon', () => {
    expect(unusableIcons(scratchRoot, ['icons'])).toEqual(['icons']);
  });

  it('rejects a PNG wearing an .ico extension', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(hasIcoHeader(png)).toBe(false);
    expect(hasIcoHeader(Uint8Array.from([0, 0, 1, 0, 0, 0])), 'no images').toBe(false);
    expect(hasIcoHeader(Uint8Array.from([0, 0, 2, 0, 1, 0])), 'cursor, not icon').toBe(false);
    expect(hasIcoHeader(Uint8Array.from([0, 0, 1, 0]))).toBe(false);
    expect(hasIcoHeader(Uint8Array.from([0, 0, 1, 0, 1, 0]))).toBe(true);
  });

  it('falls back to icons/icon.ico when the config declares no .ico', () => {
    expect(windowsResourceIcon(['icons/32x32.png', 'icons/icon.png'])).toBe('icons/icon.ico');
    expect(windowsResourceIcon([])).toBe('icons/icon.ico');
  });

  it('prefers the first declared .ico over the fallback', () => {
    expect(windowsResourceIcon(['icons/32x32.png', 'icons/brand.ico', 'icons/other.ico'])).toBe(
      'icons/brand.ico',
    );
  });
});
