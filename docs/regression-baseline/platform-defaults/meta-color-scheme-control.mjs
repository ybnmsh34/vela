/**
 * CONTROL: does `<meta name="color-scheme" content="light dark">` in index.html
 * still govern anything, now that tokens.css narrows `color-scheme` per theme?
 *
 * Run against the REAL production bundle in real Chromium (the engine family
 * WebView2 is), with the OS preference emulated in both directions and all
 * three in-app theme states, twice: once with the meta served as authored, once
 * with it deleted from the served HTML. Twelve readings; the counterfactual is
 * the whole point.
 *
 * Scope, stated because the obvious next question is out of it: this measures
 * the USED value once the stylesheet has applied. It says nothing about the
 * frame painted BEFORE the stylesheet applies, which is what the meta is
 * actually for. That attempt is written up in the companion .txt and is not
 * implemented here, because the instrument it needs is a screencast rather than
 * a screenshot -- `page.screenshot()` waits for the load to settle and hands
 * back the styled frame, which measures the wrong moment while looking like it
 * worked. Read the .txt before extending this file.
 *
 * Usage:
 *   PLAYWRIGHT_BROWSERS_PATH=... VELA_PLAYWRIGHT=... node meta-color-scheme-control.mjs <dist>
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const DIST = process.argv[2] ?? '';
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** `strip` removes the meta element from the served HTML and changes nothing else. */
function makeServer(strip) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const relative = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = join(DIST, relative);
    if (!existsSync(file)) {
      response.writeHead(404).end('nope');
      return;
    }
    let body = readFileSync(file);
    if (relative === '/index.html' && strip) {
      body = Buffer.from(
        body.toString('utf8').replace(/<meta name="color-scheme"[^>]*>\s*/u, ''),
        'utf8',
      );
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  });
}

const playwright = await import(process.env.VELA_PLAYWRIGHT ?? 'playwright');
const { chromium } = playwright.chromium === undefined ? playwright.default : playwright;

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const browser = await chromium.launch();
const rows = [];

/* ---- Q1: the used value once the stylesheet has applied ------------------ */
for (const strip of [false, true]) {
  const server = makeServer(strip);
  const origin = await listen(server);
  for (const osPrefersDark of [false, true]) {
    for (const theme of ['system', 'light', 'dark']) {
      const context = await browser.newContext({
        colorScheme: osPrefersDark ? 'dark' : 'light',
      });
      const page = await context.newPage();
      await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle' });
      await page.evaluate((choice) => {
        if (choice === 'system') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', choice);
      }, theme);
      const reading = await page.evaluate(() => {
        const root = document.documentElement;
        const style = getComputedStyle(root);
        return {
          usedColorScheme: style.colorScheme,
          pageBackground: getComputedStyle(document.body).backgroundColor,
          metaPresent: document.querySelector('meta[name="color-scheme"]')?.content ?? null,
        };
      });
      rows.push({ q: 'Q1', metaStripped: strip, osPrefersDark, theme, ...reading });
      await context.close();
    }
  }
  server.close();
}

await browser.close();

for (const row of rows) {
  const label = `${row.q} meta=${row.metaStripped ? 'STRIPPED' : 'present'} os=${
    row.osPrefersDark ? 'dark ' : 'light'
  } theme=${row.theme.padEnd(9)}`;
  console.log(`${label} used color-scheme=${row.usedColorScheme.padEnd(11)} body=${row.pageBackground}`);
}
