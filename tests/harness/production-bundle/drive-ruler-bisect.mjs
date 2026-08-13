/**
 * THE CONV-1 RULER, BISECTED AGAINST `scrollbar-gutter`.
 *
 *   node tests/harness/production-bundle/drive-ruler-bisect.mjs
 *
 * The Phase C matrix went from `40/38/36/33, 0 failures` to two failures on
 * **every** profile — `C29b` (the transcript's text and the composer's box stay
 * on one vertical ruler when the window narrows) and `C30` (the sidebar gives
 * way to the reading column rather than the column giving way). Both are the
 * same regression, and this file establishes its cause rather than reasoning
 * about it.
 *
 * ## Why it is a separate driver, and why it re-implements nothing
 *
 * `layoutRuler`, `oneVerticalRuler` and `sidebarTracksTheWindow` are **imported
 * from the Phase C harness** and called on the production bundle. A probe that
 * re-implemented the measurement could reproduce the numbers and still be
 * measuring something else — and a first cut of this file did exactly that:
 * it read the column's border box instead of its content box, and reported a
 * ruler broken by 24px at every width including the ones the matrix passes.
 *
 * The bundle is then re-served with `scrollbar-gutter` stripped from the built
 * CSS — the state before `0f83c71` — and the same three checks are run again.
 * A cause that is not the cause does not flip a verdict.
 *
 * ## The reading the matrix takes, which a single viewport cannot
 *
 * Two widths, with the **sidebar dragged to its maximum**. A sidebar left at its
 * default sits under its cap at both sizes and would prove nothing, and the wide
 * reading alone is exactly why this regression reached the tree: at 1400px the
 * column reaches its `--vela-measure` and both boxes are 480px, which is what
 * the desktop session measured and correctly reported as a delta of zero.
 *
 * ## Honesty (`docs/architecture/conventions.md` §10)
 *
 * Chromium on Linux, `BrowserAdapter`, no Tauri IPC, no model. Note that Linux
 * Chromium OVERLAYS its scrollbars, so the reserved gutter here comes entirely
 * from the `scrollbar-gutter` declaration rather than from a widget — which is
 * what makes this the right engine to bisect the declaration in, and the wrong
 * engine to judge the painted scrollbar in.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  layoutRuler,
  oneVerticalRuler,
  sidebarTracksTheWindow,
} from '../ui-bridge/checks.mjs';

const playwright = await import(process.env.VELA_PLAYWRIGHT ?? 'playwright');
const { chromium } = playwright.chromium === undefined ? playwright.default : playwright;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const argv = process.argv.slice(2);
const flagAt = argv.indexOf('--dist');
const distDir = flagAt === -1 ? join(repoRoot, 'dist') : argv[flagAt + 1];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serve(rewrite = (body) => body) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      const file = join(distDir, normalize(path === '/' ? '/index.html' : path));
      try {
        const body = rewrite(readFileSync(file), file);
        response.writeHead(200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        });
        response.end(body);
      } catch {
        response.writeHead(404).end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const browser = await chromium.launch();

async function readRuler(origin, width) {
  const context = await browser.newContext({ viewport: { width, height: 780 } });
  const page = await context.newPage();
  await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle' });
  const start = page.getByRole('button', { name: 'Start a conversation' });
  if ((await start.count()) > 0) await start.first().click();
  await page.waitForSelector('#vela-composer');
  // The sidebar's resize handle is a real `role="separator"` with arrow-key
  // resizing, so the maximum is reachable without a synthetic drag.
  await page.evaluate(() => {
    document.querySelector('[role="separator"]')?.focus();
  });
  for (let step = 0; step < 40; step += 1) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  const ruler = await layoutRuler(page);
  await context.close();
  return ruler;
}

const VARIANTS = [
  ['SHIPPING — `scrollbar-gutter: stable both-edges` (landed at 0f83c71)', (body) => body],
  [
    'WITHOUT the gutter — the declaration removed from the built CSS',
    (body, file) =>
      extname(file) === '.css'
        ? Buffer.from(String(body).replace(/scrollbar-gutter:[^;}]*;?/gu, ''))
        : body,
  ],
];

let anyBroken = false;

for (const [label, rewrite] of VARIANTS) {
  const server = await serve(rewrite);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const wide = await readRuler(origin, 1440);
  const narrow = await readRuler(origin, 880);
  const checks = [
    ['C29a  wide  ', oneVerticalRuler(wide)],
    ['C29b  narrow', oneVerticalRuler(narrow)],
    ['C30   both  ', sidebarTracksTheWindow(wide, narrow)],
  ];
  console.log(`\n== ${label} ==`);
  for (const [id, result] of checks) {
    console.log(`  ${id} : ${result.pass ? 'PASS' : 'FAIL'}  ${result.detail}`);
    if (!result.pass) anyBroken = true;
  }
  server.close();
}

await browser.close();
console.log(
  `\n${anyBroken ? 'At least one variant broke the ruler — compare the two blocks above.' : 'Both variants held the ruler.'}`,
);
