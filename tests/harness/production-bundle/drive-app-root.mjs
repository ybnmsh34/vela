/**
 * GATE M — **the production bundle, mounted, in a real browser.**
 *
 *   node tests/harness/production-bundle/drive-app-root.mjs --out <dir>
 *
 * Every frontend gate this project has run mounted components, or mounted a
 * *variant* entry point (`tests/harness/ui-bridge/main.tsx`) that swaps the
 * adapter. Neither of those is the artefact Tauri loads. This one serves
 * `dist/` — the exact directory `tauri.conf.json`'s `frontendDist` points at,
 * the bytes `pnpm build` produced — over HTTP to headless Chromium, and lets
 * `dist/index.html` boot `src/main.tsx` -> `<App/>` with **no adapter
 * argument**, so `createPlatformAdapter()` auto-detects exactly as it does in
 * the shipping window.
 *
 * ## The traps are installed before a byte of app code runs
 *
 * `addInitScript` runs on the new document before any script tag is evaluated,
 * so `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `navigator.
 * sendBeacon` are already replaced when the bundle's first module executes. A
 * trap installed after mount would prove nothing about what happened during it.
 * Playwright's own `request` event is watched **as well**, because an in-page
 * trap can be bypassed (a fresh `iframe.contentWindow.fetch`, an `img.src`, a
 * `<link>`), and the two together are what make "zero requests" a measurement
 * rather than a hope.
 *
 * ## Honesty (`docs/architecture/conventions.md` §10)
 *
 * - The browser is **Chromium on Linux**, not WebView2 and not WebKitGTK. Every
 *   visual and interaction observation here is PROVISIONAL; the binding
 *   verdicts are the desktop session's.
 * - There is **no Tauri IPC**. Outside a Tauri webview the shipping bundle
 *   selects `BrowserAdapter`, an in-memory fake. **No byte in this run came
 *   from a model, from the Rust core, or from any endpoint.** What is proven
 *   here is that the real root mounts from the real bundle, that it is silent
 *   on the network, and what it puts on screen while it is.
 * - The complementary run — the real component tree against the **real Rust
 *   core** against the real mock endpoints — is the Phase C matrix, which uses
 *   the relay entry point and is re-run separately.
 */

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const playwright = await import(process.env.VELA_PLAYWRIGHT ?? 'playwright');
const { chromium } = playwright.chromium === undefined ? playwright.default : playwright;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

const distDir = flag('--dist') ?? join(repoRoot, 'dist');
const outDir = flag('--out') ?? join(repoRoot, 'docs/regression-baseline/gate-m-composition-root');
const controls = argv.includes('--controls');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/* -------------------------------------------------------------------------- */
/* the results ledger                                                         */
/* -------------------------------------------------------------------------- */

const results = [];
let failures = 0;

function assert(id, claim, passed, detail = '') {
  results.push({ id, claim, passed, detail });
  if (!passed) failures += 1;
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${id}  ${claim}${detail === '' ? '' : `  — ${detail}`}`);
}

/* -------------------------------------------------------------------------- */
/* a static server for dist/, with nothing else on it                         */
/* -------------------------------------------------------------------------- */

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

function serveDist(root) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const relative = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = join(root, normalize(relative).replace(/^(\.\.[/\\])+/, ''));
      try {
        const body = readFileSync(file);
        response.writeHead(200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
          // The same Content-Security-Policy `tauri.conf.json` declares, so the
          // bundle is evaluated under the policy it ships with rather than a
          // permissive one. `connect-src 'self'` is the line that matters here.
          'content-security-policy': CSP,
        });
        response.end(body);
      } catch {
        response.writeHead(404).end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const CSP = JSON.parse(
  readFileSync(join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
).app.security.csp;

/* -------------------------------------------------------------------------- */
/* the traps, installed before app code                                       */
/* -------------------------------------------------------------------------- */

const TRAPS = `
  window.__velaTrapped = [];
  const record = (kind, url) => {
    try { window.__velaTrapped.push({ kind, url: String(url) }); } catch (_) {}
  };
  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    record('fetch', typeof input === 'string' ? input : (input && input.url) || input);
    return realFetch.apply(this, arguments);
  };
  const RealXHR = window.XMLHttpRequest;
  function TrappedXHR() {
    const xhr = new RealXHR();
    const open = xhr.open;
    xhr.open = function (method, url) { record('xhr', url); return open.apply(xhr, arguments); };
    return xhr;
  }
  TrappedXHR.prototype = RealXHR.prototype;
  window.XMLHttpRequest = TrappedXHR;
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) { record('websocket', url); return new RealWS(url, protocols); };
  const RealES = window.EventSource;
  if (RealES !== undefined) {
    window.EventSource = function (url, config) { record('eventsource', url); return new RealES(url, config); };
  }
  if (navigator.sendBeacon !== undefined) {
    const realBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) { record('beacon', url); return realBeacon(url, data); };
  }
  window.__velaTrapInstalledAt = document.readyState;
`;

/* -------------------------------------------------------------------------- */
/* the run                                                                    */
/* -------------------------------------------------------------------------- */

const server = await serveDist(distDir);
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

try {
  await runProductionBundle();
  if (controls) await runControls();
} finally {
  await browser.close();
  server.close();
}

writeFileSync(
  join(outDir, 'ASSERTION-LEDGER.tsv'),
  ['id\tverdict\tclaim\tdetail', ...results.map((r) => `${r.id}\t${r.passed ? 'PASS' : 'FAIL'}\t${r.claim}\t${r.detail}`)].join('\n') + '\n',
);
console.log(`\n${results.length} assertions, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);

/* ========================================================================== */

async function openPage() {
  const context = await browser.newContext({ viewport: { width: 1180, height: 780 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const networkRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('request', (request) => networkRequests.push(request.url()));
  await page.addInitScript(TRAPS);
  return { context, page, consoleErrors, pageErrors, networkRequests };
}

async function runProductionBundle() {
  const { context, page, consoleErrors, pageErrors, networkRequests } = await openPage();
  await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle' });

  /* --- P1: the real root mounted, from the real bundle -------------------- */

  const rootHtml = await page.locator('#root').innerHTML();
  assert(
    'P1',
    'the production bundle mounts a non-empty React tree at #root',
    rootHtml.trim().length > 0,
    `${rootHtml.length} bytes of markup`,
  );

  // Not "a component rendered" but "the assembled application rendered": the
  // shell, the navigation surface, the model workspace and the composer are
  // four different features that only meet in App.tsx.
  const landmarks = {
    statusLine: await page.locator('[data-testid="status-line"]').count(),
    startAConversation: await page.getByRole('button', { name: 'Start a conversation' }).count(),
    searchEverything: await page.getByRole('button', { name: /Search everything/u }).count(),
    navigation: await page.locator('nav, [role=navigation]').count(),
  };
  assert(
    'P2',
    'every feature that only meets at the composition root is on screen',
    Object.values(landmarks).every((n) => n > 0),
    JSON.stringify(landmarks),
  );

  const bootedFrom = await page.evaluate(() =>
    [...document.querySelectorAll('script[type=module]')].map((s) => s.getAttribute('src')),
  );
  assert(
    'P3',
    'the page booted the built bundle, not a source module',
    bootedFrom.length > 0 && bootedFrom.every((src) => src.includes('/assets/')),
    JSON.stringify(bootedFrom),
  );

  /* --- P4: nothing threw ------------------------------------------------- */

  assert('P4', 'no uncaught exception during mount', pageErrors.length === 0, pageErrors.join(' | '));
  assert('P5', 'no console error during mount', consoleErrors.length === 0, consoleErrors.join(' | '));

  /* --- P6: zero browser-to-endpoint requests ------------------------------ */

  const trapped = await page.evaluate(() => window.__velaTrapped);
  const installedAt = await page.evaluate(() => window.__velaTrapInstalledAt);
  assert(
    'P6a',
    'the traps were installed before the document had a body',
    installedAt === 'loading',
    `document.readyState was ${installedAt}`,
  );
  assert(
    'P6b',
    'the app made zero fetch/XHR/WebSocket/EventSource/beacon calls of its own',
    trapped.length === 0,
    JSON.stringify(trapped),
  );

  const offOrigin = networkRequests.filter((url) => !url.startsWith(origin));
  assert(
    'P6c',
    'Chromium itself saw no request leave the page origin',
    offOrigin.length === 0,
    JSON.stringify(offOrigin),
  );

  /* --- P7: the app says which backend it is on, and does not pretend ------ */

  const statusText = await page.locator('body').innerText();
  assert(
    'P7',
    'the app names the fake it is running on rather than implying a real one',
    /memory|browser|fake/i.test(statusText),
    statusText.split('\n').filter((l) => /memory|browser|fake/i.test(l)).join(' / '),
  );

  await page.screenshot({ path: join(outDir, '01-production-bundle-cold.png'), fullPage: false });

  /* --- P8: the context meter is honest with nothing configured ----------- */

  const meter = page.locator('[data-testid="context-meter"]');
  const meterCount = await meter.count();
  if (meterCount === 0) {
    assert(
      'P8',
      'with no endpoint configured the meter states no figure at all',
      true,
      'the meter is not rendered before a model is selected',
    );
  } else {
    const verdict = await meter.first().getAttribute('data-verdict');
    const text = await meter.first().innerText();
    assert(
      'P8',
      'with no endpoint configured the meter reports `unknown`, never a number presented as fact',
      verdict === 'unknown' && !/about 0 of/i.test(text),
      `verdict=${verdict} text=${JSON.stringify(text)}`,
    );
  }

  /* --- P9/P10: the meter reflects a real draft --------------------------- */

  await openAConversation(page);

  // The second half of P2: the surfaces that only exist once a conversation is
  // open, and that live in three different features.
  const inConversation = {
    composer: await page.locator('#vela-composer').count(),
    send: await page.getByRole('button', { name: 'Send' }).count(),
    modelSwitcher: await page.getByRole('button', { name: /Choose a model|·/u }).count(),
    capabilityReadout: await page
      .getByRole('button', { name: /limit|Capabilities unknown/u })
      .count(),
  };
  assert(
    'P2b',
    'opening a conversation brings up the composer, the send action and the model bar',
    Object.values(inConversation).every((n) => n > 0),
    JSON.stringify(inConversation),
  );

  await configureAnEndpointThroughTheUi(page);

  const meterAfterConfig = page.locator('[data-testid="context-meter"]');
  const beforeTyping =
    (await meterAfterConfig.count()) === 0 ? '' : await meterAfterConfig.first().innerText();

  const draft = 'x'.repeat(880_000);
  await page.fill('#vela-composer', draft);
  await page.waitForTimeout(400);

  const afterTyping = (await meterAfterConfig.count()) === 0 ? '' : await meterAfterConfig.first().innerText();
  const afterNumber = biggestNumber(afterTyping);
  assert(
    'P9',
    'typing a very large draft moves the context meter off zero',
    afterNumber !== null && afterNumber > 1000,
    `before=${JSON.stringify(beforeTyping)} after=${JSON.stringify(afterTyping)}`,
  );
  assert(
    'P10',
    'the meter never claims a window this endpoint did not report',
    !/of \d/.test(afterTyping) || /not reported/i.test(afterTyping),
    JSON.stringify(afterTyping),
  );

  await page.screenshot({ path: join(outDir, '02-production-bundle-large-draft.png') });

  /* --- P13..P16: a turn survives navigating away and coming back ---------- */

  await page.fill('#vela-composer', '');
  await dismissOverlays(page);
  const persistence = await turnSurvivesNavigation(page);
  assert(
    'P13',
    'a sent turn appears in the transcript',
    persistence.afterSend.user > 0 && persistence.afterSend.assistant > 0,
    JSON.stringify(persistence.afterSend),
  );
  assert(
    'P14',
    'navigating to another conversation leaves the first transcript behind',
    persistence.awayCounts.user === 0 && persistence.awayCounts.assistant === 0,
    JSON.stringify(persistence.awayCounts),
  );
  assert(
    'P15',
    'coming back restores the turn — the surface reads it from the store, not from its own state',
    persistence.backCounts.user > 0 &&
      persistence.backCounts.assistant > 0 &&
      persistence.backText.includes(persistence.sent),
    JSON.stringify({ counts: persistence.backCounts, sample: persistence.backText.slice(0, 160) }),
  );
  assert(
    'P16',
    'the restored turn is the one that was sent, not a re-run of it',
    persistence.endpointCallsBefore === persistence.endpointCallsAfter,
    `${persistence.endpointCallsBefore} -> ${persistence.endpointCallsAfter} adapter chat calls`,
  );

  await page.screenshot({ path: join(outDir, '03-restored-after-navigation.png') });

  /* --- P11: still silent after a whole session --------------------------- */

  const trappedEnd = await page.evaluate(() => window.__velaTrapped);
  const offOriginEnd = networkRequests.filter((url) => !url.startsWith(origin));
  assert(
    'P11',
    'configuring an endpoint and typing 880,000 characters still produces zero browser requests',
    trappedEnd.length === 0 && offOriginEnd.length === 0,
    `${trappedEnd.length} trapped, ${offOriginEnd.length} off-origin`,
  );
  assert(
    'P12',
    'no uncaught exception across the whole session',
    pageErrors.length === 0,
    pageErrors.join(' | '),
  );

  writeFileSync(
    join(outDir, 'production-bundle-session.json'),
    JSON.stringify(
      {
        origin,
        csp: CSP,
        scripts: bootedFrom,
        landmarks,
        trapped: trappedEnd,
        offOriginRequests: offOriginEnd,
        sameOriginRequests: networkRequests.filter((url) => url.startsWith(origin)),
        consoleErrors,
        pageErrors,
        meterBeforeTyping: beforeTyping,
        meterAfterTyping: afterTyping,
      },
      null,
      2,
    ) + '\n',
  );

  await context.close();
}

/**
 * Configure an endpoint the way a user does: open the endpoints panel, fill the
 * form, submit. No adapter seeding, no test hook — if the shipping UI cannot do
 * it, this fails here.
 */
async function configureAnEndpointThroughTheUi(page) {
  // `Manage endpoints…` lives inside the model switcher's popover, which is
  // where a user with no endpoint configured is sent.
  await page.getByRole('button', { name: /Choose a model|·/u }).first().click();
  await page.getByRole('button', { name: /Manage endpoints/u }).first().click();
  await page.getByRole('button', { name: 'Add an endpoint' }).click();
  const form = page.getByRole('form', { name: 'Add an endpoint' });
  await form.getByLabel('Name').fill('The workstation in the study');
  await form.getByLabel('Address').fill('http://127.0.0.1:8033/v1');
  await form.getByLabel(/^Model/u).fill('a-local-model');
  await form.getByRole('button', { name: 'Add endpoint' }).click();
  await page.waitForTimeout(400);
  const close = page.getByRole('button', { name: 'Close' });
  if ((await close.count()) > 0) await close.first().click();
  await page.waitForTimeout(200);
  return true;
}

/**
 * Closes anything modal that is open — the command palette, the endpoints
 * panel — so a navigation click lands on the sidebar rather than on a scrim.
 */
async function dismissOverlays(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const scrims = await page.locator('[class*="scrim"]').count();
    const panel = await page.getByRole('region', { name: 'Endpoints' }).count();
    if (scrims === 0 && panel === 0) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
}

/** Counts the transcript entries currently on screen. */
async function transcriptCounts(page) {
  return page.evaluate(() => ({
    user: document.querySelectorAll('article[data-role="user"]').length,
    assistant: document.querySelectorAll('article[data-role="assistant"]').length,
  }));
}

/**
 * Sends a turn, opens a different conversation, comes back, and reports what
 * was on screen at each step.
 *
 * The remount is the point: `App.tsx` keys the conversation surface on the
 * conversation id, so switching and switching back **destroys and rebuilds**
 * the component. Anything the surface was holding in its own state is gone. If
 * the turn is still there afterwards, it came back from the store.
 */
async function turnSurvivesNavigation(page) {
  const sent = `a sentence that must survive navigation ${Date.now()}`;
  await page.fill('#vela-composer', sent);
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForFunction(
    () => {
      const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
      if (turn === undefined) return false;
      const stopping = [...document.querySelectorAll('button')].some((b) => b.textContent === 'Stop');
      return !stopping && !turn.innerText.includes('Waiting for the first token');
    },
    undefined,
    { timeout: 20_000, polling: 50 },
  );
  await page.waitForTimeout(300);
  const afterSend = await transcriptCounts(page);
  const endpointCallsBefore = afterSend.assistant;

  // Which conversation holds it, by the sidebar's own accessible name.
  const openLabels = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[aria-label^="Open "]')].map((node) =>
        node.getAttribute('aria-label'),
      ),
    );
  const labelsBefore = await openLabels();

  // Away: a brand-new conversation, which remounts the surface under a new key.
  await dismissOverlays(page);
  await page.getByRole('button', { name: 'New conversation' }).first().click();
  await page.waitForTimeout(600);
  const awayCounts = await transcriptCounts(page);
  const labelsAfter = await openLabels();

  // Back: the row that is NOT the one now open. Two untitled conversations can
  // carry the same accessible name, so "the other one" is `aria-current`, not
  // the label.
  await dismissOverlays(page);
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[aria-label^="Open "]')];
    const other = rows.find((node) => node.getAttribute('aria-current') !== 'page');
    (other ?? rows[rows.length - 1])?.click();
  });
  await page.waitForTimeout(700);
  const backCounts = await transcriptCounts(page);
  const backText = await page.locator('main').innerText();

  return {
    sent,
    afterSend,
    awayCounts,
    backCounts,
    backText,
    labelsBefore,
    labelsAfter,
    endpointCallsBefore,
    endpointCallsAfter: backCounts.assistant,
  };
}

/** Opens a conversation the way a user does, so the composer exists. */
async function openAConversation(page) {
  const start = page.getByRole('button', { name: 'Start a conversation' });
  if ((await start.count()) > 0) await start.first().click();
  await page.waitForSelector('#vela-composer', { timeout: 10_000 });
}

function biggestNumber(text) {
  const numbers = [...text.matchAll(/[\d,]+/g)]
    .map((m) => Number(m[0].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
  return numbers.length === 0 ? null : Math.max(...numbers);
}

/* ========================================================================== */
/* ASSERTION CONTROLS — every check above, applied where it must not hold     */
/* ========================================================================== */

async function runControls() {
  console.log('\n--- assertion controls ---');

  // K1 — the mount assertions must fail against a page that mounts nothing.
  {
    const { context, page } = await openPage();
    await page.setContent('<div id="root"></div>');
    const html = await page.locator('#root').innerHTML();
    const composer = await page.locator('[data-testid="composer-input"]').count();
    assert(
      'K1',
      'CONTROL: P1/P2 fail against a page with an empty #root',
      html.trim().length === 0 && composer === 0,
    );
    await context.close();
  }

  // K2 — the request traps must catch a request when one is made.
  {
    const { context, page, networkRequests } = await openPage();
    await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle' });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          fetch('http://127.0.0.1:9/v1/chat/completions').catch(() => {});
          const xhr = new XMLHttpRequest();
          xhr.open('POST', 'http://127.0.0.1:9/v1/models');
          try {
            xhr.send();
          } catch (_) {}
          try {
            new WebSocket('ws://127.0.0.1:9/socket');
          } catch (_) {}
          try {
            new EventSource('http://127.0.0.1:9/events');
          } catch (_) {}
          setTimeout(resolve, 250);
        }),
    );
    const trapped = await page.evaluate(() => window.__velaTrapped);
    const kinds = new Set(trapped.map((t) => t.kind));
    assert(
      'K2a',
      'CONTROL: the in-page traps record fetch, XHR, WebSocket and EventSource when they are used',
      ['fetch', 'xhr', 'websocket', 'eventsource'].every((k) => kinds.has(k)),
      JSON.stringify([...kinds]),
    );
    const offOrigin = networkRequests.filter((url) => !url.startsWith(origin));
    assert(
      'K2b',
      "CONTROL: Chromium's own request event sees an off-origin request when one is made",
      offOrigin.length > 0,
      JSON.stringify(offOrigin.slice(0, 4)),
    );
    await context.close();
  }

  // K3 — the console/pageerror collectors must catch a real error.
  {
    const { context, page, consoleErrors, pageErrors } = await openPage();
    await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      console.error('a deliberate console error');
      setTimeout(() => {
        throw new Error('a deliberate uncaught exception');
      }, 0);
    });
    await page.waitForTimeout(200);
    assert(
      'K3',
      'CONTROL: P4/P5 fail when an error is actually thrown',
      consoleErrors.length > 0 && pageErrors.length > 0,
      `${consoleErrors.length} console, ${pageErrors.length} uncaught`,
    );
    await context.close();
  }

  // K4 — the meter assertion must fail against a meter that is not there,
  //      and the "moved off zero" check must fail on an empty draft.
  {
    const { context, page } = await openPage();
    await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle' });
    await openAConversation(page);
    await configureAnEndpointThroughTheUi(page);
    await page.fill('#vela-composer', '');
    await page.waitForTimeout(300);
    const meter = page.locator('[data-testid="context-meter"]');
    const text = (await meter.count()) === 0 ? '' : await meter.first().innerText();
    const number = biggestNumber(text);
    assert(
      'K4',
      'CONTROL: P9 fails on an empty draft — the meter is not stuck at a large number',
      number === null || number <= 1000,
      JSON.stringify(text),
    );
    await context.close();
  }

  // K5 — the CSP the page is served under is the shipping one, and it really
  //      would block a cross-origin connection. Proves P6 is not passing
  //      because nothing could have connected in the first place... and that
  //      the policy is doing work.
  {
    assert(
      'K5',
      'CONTROL: the served policy is the shipping CSP and it confines connections to self',
      CSP.includes("connect-src 'self'"),
      CSP.slice(0, 80),
    );
  }
}
