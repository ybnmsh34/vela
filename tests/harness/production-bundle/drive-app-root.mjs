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
 * the `index.html` that `pnpm build` emits into `dist/` boot `src/main.tsx`
 * -> `<App/>` with **no adapter argument**, so `createPlatformAdapter()`
 * auto-detects exactly as it does in the shipping window.
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
 * ## The typeface probe (`P17`–`P20`, controls `K6a`–`K6d`, `K7`, `K8a`–`K8c`)
 *
 * Serving `dist/` is what makes this the right place for it. Whether a font
 * loads is a question about the **built artefact** — whether Vite emitted the
 * `.woff2`, whether the `@font-face` survived into the bundled CSS, whether the
 * shipping `font-src` policy permits it — and none of that exists in `src/`.
 * The question is settled by advance width against a deliberately absent
 * family, never by `document.fonts.check()`, which returns `true` for fonts the
 * engine cannot draw and did so throughout the period when Vela shipped no
 * typeface at all. See `measureTypeface()` and `src/styles/typeface.css`.
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
/** The real run's typeface reading, so the controls can be compared against it. */
let liveReading = null;

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

/**
 * @param root      the directory to serve
 * @param rewrite   optional `(body, file) => body`, applied to every response.
 *                  Used by the controls to serve a *deliberately damaged* copy
 *                  of the real bundle — the pre-fix state, staged on demand —
 *                  without touching the bytes on disk that the real run reads.
 */
function serveDist(root, rewrite = (body) => body) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const relative = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = join(root, normalize(relative).replace(/^(\.\.[/\\])+/, ''));
      try {
        const body = rewrite(readFileSync(file), file);
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

  /* --- P17..P19: the typeface the design was authored against ------------- */

  const typeface = await measureTypeface(page);
  liveReading = typeface.reading;

  for (const [role, id] of [
    ['sans', 'P17'],
    ['mono', 'P18'],
  ]) {
    const reading = typeface.stacks[role];
    assert(
      `${id}a`,
      `the family --vela-font-${role} names first (${reading.requested}) actually loads — ` +
        `WIDTH CONTROL, not document.fonts.check`,
      Math.abs(reading.requestedWidth - typeface.control) > 1,
      `requested=${reading.requestedWidth} absent-font control=${typeface.control} ` +
        `(document.fonts.check said ${reading.checkSaysLoaded}, which is not evidence)`,
    );
    assert(
      `${id}b`,
      `--vela-font-${role} as the app applies it resolves to that same face, not to a fallback`,
      Math.abs(reading.appliedWidth - reading.requestedWidth) < 0.5,
      `applied=${reading.appliedWidth} requested=${reading.requestedWidth} ` +
        `stack=${JSON.stringify(reading.stack)}`,
    );
    // Markdown emphasis and code comments both ask for italic, and an italic
    // the bundle does not carry is drawn by shearing the roman.
    //
    // Width is deliberately NOT the assertion here, and this is the one place
    // in the probe where it is the wrong instrument. For the mono it cannot
    // work at all: a monospaced italic carries the roman's advances by
    // definition, so equal widths are the correct result and prove nothing. For
    // the sans it technically works — Inter's italic runs about 6px wider over
    // a 2009px string — but a 0.3% margin is a rasterisation rounding away from
    // a coin flip, and an assertion that thin would eventually fail on WebView2
    // for reasons having nothing to do with the font being there.
    //
    // So both roles are settled by the document's own font set: is there an
    // `@font-face` entry for this family with `style: italic`, and did its
    // bytes arrive. The width delta is reported beside it as corroboration —
    // and control K8a shows it collapsing to exactly zero when the italic faces
    // are stripped, which is the shape of a synthesised oblique.
    assert(
      `${id}c`,
      `the italic of ${reading.requested} is a real cut in the bundle, not the engine shearing ` +
        'the roman',
      reading.italicFace.present && reading.italicFace.status === 'loaded',
      `@font-face italic entry: present=${reading.italicFace.present} ` +
        `status=${reading.italicFace.status}; advances italic=${reading.italicWidth} ` +
        `roman=${reading.requestedWidth}` +
        (role === 'mono' ? ' (equal is CORRECT for a monospaced face)' : ''),
    );
  }

  assert(
    'P19a',
    'the sans and mono faces are two different faces, not one stack shadowing the other',
    Math.abs(typeface.stacks.sans.appliedWidth - typeface.stacks.mono.appliedWidth) > 1,
    `sans=${typeface.stacks.sans.appliedWidth} mono=${typeface.stacks.mono.appliedWidth}`,
  );

  const fontRequests = networkRequests.filter((url) => /\.(woff2?|ttf|otf|eot)(\?|$)/.test(url));
  assert(
    'P19b',
    'every font byte came from the bundle itself — no request left the origin for a face',
    fontRequests.length > 0 && fontRequests.every((url) => url.startsWith(origin)),
    `${fontRequests.length} font requests: ${JSON.stringify(
      fontRequests.map((url) => url.replace(origin, '')),
    )}`,
  );

  const cpl = typeface.reading.charactersPerLine;
  assert(
    'P20',
    'the reading measure still sets 65–75 characters per line IN THE FACE THAT NOW RENDERS — ' +
      'the token was back-calculated from a Segoe UI reading and Inter is narrower',
    cpl >= 65 && cpl <= 75,
    `${cpl} characters per line: --vela-measure=${typeface.reading.measureToken} ` +
      `= ${typeface.reading.columnPx}px at ${typeface.reading.bodyPx}px body, ` +
      `mean advance ${typeface.reading.meanAdvancePx}px`,
  );

  writeFileSync(join(outDir, 'typeface-probe.json'), JSON.stringify(typeface, null, 2) + '\n');

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

/* -------------------------------------------------------------------------- */
/* THE WIDTH CONTROL — the only honest way to ask "did this font load?"        */
/* -------------------------------------------------------------------------- */

/**
 * Renders a probe string in three things and reports the advance width of each:
 *
 *   1. a family that is **deliberately absent** — the control;
 *   2. the family a `--vela-font-*` stack names first, with that absent family
 *      as its **only** fallback, so a face that did not load measures *exactly*
 *      the control rather than something merely similar;
 *   3. the whole stack as the app applies it.
 *
 * Loaded ⇔ (2) differs from (1). Actually painted with it ⇔ (3) equals (2).
 *
 * ## Why not `document.fonts.check()`
 *
 * Because it lies. On the operator's Windows 11 / WebView2 machine, with no
 * Inter installed anywhere and no `@font-face` in the bundle,
 * `document.fonts.check('16px Inter')` returned **true** while the same probe
 * string rendered at 481.72px in `Inter` and 481.72px in `ZzQqNoSuchFontXx` —
 * identical to the digit. The app's body text rendered at 523.91px: Segoe UI.
 * A boolean that says "yes" about a font the engine cannot draw is worse than
 * no check at all, so it is *recorded* here as a data point and never asserted
 * on. Advance width is a fact about glyphs the engine actually has.
 *
 * The probe is set at 64px with kerning, ligatures and letter-spacing pinned
 * off: at body size the difference between two faces can round into the same
 * layout unit, and an inherited `--vela-tracking-*` would move both readings
 * together and hide it.
 */
async function measureTypeface(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    return true;
  });
  return page.evaluate(async () => {
    const ABSENT = 'ZzQqNoSuchFontXx';
    const PROBE = 'Handgloves 12345 — the quick brown fox jumps over the lazy dog';

    const measure = (family, weight, style = 'normal') => {
      const span = document.createElement('span');
      span.textContent = PROBE;
      span.style.cssText =
        'position:absolute;left:-9999px;top:0;white-space:pre;font-size:64px;' +
        'letter-spacing:normal;word-spacing:normal;font-kerning:none;' +
        'font-variant:normal;font-feature-settings:normal;font-stretch:normal;';
      span.style.fontFamily = family;
      span.style.fontStyle = style;
      span.style.fontWeight = String(weight);
      document.body.appendChild(span);
      const width = span.getBoundingClientRect().width;
      span.remove();
      return Math.round(width * 100) / 100;
    };

    const rootStyles = getComputedStyle(document.documentElement);
    const roles = [
      ['sans', '--vela-font-sans'],
      ['mono', '--vela-font-mono'],
    ].map(([role, token]) => {
      const stack = rootStyles.getPropertyValue(token).replace(/\s+/g, ' ').trim();
      return { role, token, stack, requested: (stack.split(',')[0] ?? '').trim() };
    });

    /**
     * Forces the faces this probe is about to measure to finish loading.
     *
     * WITHOUT THIS THE ITALIC READINGS ARE WORTHLESS, and silently so. A face
     * is fetched on first *use*, and `font-display: block` renders the block
     * period with an invisible placeholder whose metrics are the fallback's.
     * The first version of this probe measured that placeholder and reported
     * 1701.09px for **both** Inter Italic and JetBrains Mono Italic — the same
     * number for a proportional face and a monospaced one, which is impossible,
     * and the assertion passed anyway because 1701.09 ≠ the roman.
     *
     * It walks `document.fonts` — the set built from the document's **own
     * `@font-face` rules** — and loads the exact entry it wants by identity.
     *
     * Two nearby APIs cannot do this job and both were tried:
     *
     *   `document.fonts.check()` speculates about what the system might have
     *   installed, and returns `true` for fonts the engine cannot draw. It is
     *   the reason this defect survived three phases.
     *
     *   `document.fonts.load('italic 400 64px X')` looks safer, and is not: CSS
     *   font matching permits **style fallback**, so on a bundle with every
     *   italic face stripped out it happily resolves — with the *roman* face,
     *   reporting `matched: 1, status: ["loaded"]`. It answers "something can
     *   serve this request", which is a different question.
     *
     * Enumerating the set and matching on `family` and `style` has no fallback
     * in it. The entry is there or it is not.
     */
    const italicEntry = async (family) => {
      const name = family.replace(/^['"]|['"]$/g, '');
      const face = [...document.fonts].find((f) => f.family === name && f.style === 'italic');
      if (face === undefined) return { present: false, status: 'absent' };
      try {
        await face.load();
      } catch {
        /* status carries the outcome */
      }
      return { present: true, status: face.status };
    };

    const styleStatus = {};
    for (const { role, requested } of roles) {
      // The roman is loaded by the page itself; the italic is only fetched on
      // first use, so it is loaded here by identity before anything is measured.
      styleStatus[role] = { italic: await italicEntry(requested) };
    }
    await document.fonts.ready;

    const stacks = {};
    for (const { role, token, stack, requested } of roles) {
      stacks[role] = {
        token,
        stack,
        requested,
        requestedWidth: measure(`${requested}, '${ABSENT}'`, 400),
        appliedWidth: measure(stack, 400),
        // A *synthesised* oblique is a shear transform: it leans the upright
        // glyphs and leaves every advance width exactly as it was. A real
        // italic cut is drawn, and its advances differ — FOR A PROPORTIONAL
        // FACE. For a monospaced one they are equal by definition, so width
        // cannot answer the question there and the assertion does not ask it;
        // `italicFace` below is what settles mono.
        italicWidth: measure(`${requested}, '${ABSENT}'`, 400, 'italic'),
        italicFace: styleStatus[role].italic,
        // Recorded, never asserted on. See the note above.
        checkSaysLoaded: document.fonts.check(`64px ${requested}`),
        // Each weight the tokens ask for, so a face that covers only 400 and
        // leaves the engine to fake the rest is visible in the evidence.
        byWeight: Object.fromEntries(
          [400, 500, 600, 700].map((w) => [w, measure(`${requested}, '${ABSENT}'`, w)]),
        ),
      };
    }

    /* --- the reading measure, in the face that now renders ---------------- *
     * `--vela-measure` is a *character count expressed as a length*, and the
     * count depends entirely on the face. The 30rem in `tokens.css` was
     * back-calculated from a reading taken on Windows in **Segoe UI**, which is
     * the font this app was never supposed to be set in. Inter's set widths are
     * narrower, so the same column holds more characters — the fix to the
     * typeface moves this number, and if nothing re-measures it the column
     * silently drifts out of the 65–75 band the token exists to hold.
     *
     * Characters per line is computed as column ÷ mean advance rather than
     * characters ÷ line boxes: the last line of a paragraph is partial, and
     * that bias runs ~8% on a document of any length. The prose sample is real
     * English so the letter frequencies — and therefore the mean advance — are
     * the ones a reader actually meets.                                       */
    const PROSE =
      'The question of which model to run is not a question about intelligence so much as ' +
      'a question about custody. A workspace that keeps the conversation on the machine it ' +
      'was typed on can afford to be dull about it; one that does not has to be persuasive. ' +
      'Vela takes the first position, and the whole of its design follows from there: the ' +
      'endpoint is yours, the transcript is yours, and nothing leaves without you asking.';

    const readingColumn = document.createElement('div');
    readingColumn.style.cssText =
      'position:absolute;left:-9999px;top:0;width:var(--vela-measure);' +
      'font-size:var(--vela-text-base);';
    document.body.appendChild(readingColumn);
    const columnStyles = getComputedStyle(readingColumn);
    const columnPx = readingColumn.getBoundingClientRect().width;
    const bodyPx = parseFloat(columnStyles.fontSize);
    readingColumn.remove();

    const oneLine = document.createElement('span');
    oneLine.textContent = PROSE;
    oneLine.style.cssText =
      'position:absolute;left:-9999px;top:0;white-space:pre;font-weight:400;';
    oneLine.style.fontFamily = stacks.sans.stack;
    oneLine.style.fontSize = `${bodyPx}px`;
    document.body.appendChild(oneLine);
    const proseWidth = oneLine.getBoundingClientRect().width;
    oneLine.remove();

    const meanAdvance = proseWidth / PROSE.length;

    return {
      probe: PROBE,
      absentControlFamily: ABSENT,
      control: measure(`'${ABSENT}'`, 400),
      stacks,
      reading: {
        measureToken: rootStyles.getPropertyValue('--vela-measure').trim(),
        columnPx: Math.round(columnPx * 100) / 100,
        bodyPx,
        meanAdvancePx: Math.round(meanAdvance * 1000) / 1000,
        charactersPerLine: Math.round((columnPx / meanAdvance) * 10) / 10,
      },
      // What the element carrying body text is actually set in, measured the
      // same way — the reading the desktop session took.
      bodyStack: getComputedStyle(document.body).fontFamily.replace(/\s+/g, ' ').trim(),
      bodyWidth: measure(getComputedStyle(document.body).fontFamily, 400),
      loadedFaces: [...document.fonts]
        .filter((face) => face.status === 'loaded')
        .map((face) => ({ family: face.family, weight: face.weight, style: face.style })),
    };
  });
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

  // K6 — the width control, controlled.
  //
  // P17/P18 pass when two numbers differ, and a probe that can only ever report
  // "differs" would pass on a tree with no font in it. Two halves:
  //
  //   K6a  a family that is definitely absent must measure *exactly* the
  //        control, so the equality the probe treats as "did not load" is a
  //        reading the probe can actually produce;
  //   K6b  the real bundle, served with every `@font-face` rule stripped out of
  //        its CSS — the state this repository shipped in until this commit —
  //        must make P17a FAIL. This is the one that matters: it stages the
  //        defect and shows the assertion catching it, rather than asserting
  //        that the assertion would.
  {
    const { context, page } = await openPage();
    await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle' });
    const absent = await page.evaluate(() => {
      const measure = (family) => {
        const span = document.createElement('span');
        span.textContent = 'Handgloves 12345 — the quick brown fox jumps over the lazy dog';
        span.style.cssText =
          'position:absolute;left:-9999px;top:0;white-space:pre;font-size:64px;' +
          'letter-spacing:normal;word-spacing:normal;font-style:normal;font-kerning:none;' +
          'font-variant:normal;font-feature-settings:normal;font-stretch:normal;font-weight:400;';
        span.style.fontFamily = family;
        document.body.appendChild(span);
        const width = span.getBoundingClientRect().width;
        span.remove();
        return Math.round(width * 100) / 100;
      };
      return {
        control: measure(`'ZzQqNoSuchFontXx'`),
        alsoAbsent: measure(`'QqZzDefinitelyNotInstalledWw', 'ZzQqNoSuchFontXx'`),
      };
    });
    assert(
      'K6a',
      'CONTROL: a family that is not there measures exactly the absent-font control',
      Math.abs(absent.alsoAbsent - absent.control) < 0.5,
      `absent=${absent.alsoAbsent} control=${absent.control}`,
    );
    await context.close();
  }
  {
    // The same dist/, with `@font-face { … }` removed on the way out of the
    // server. Nothing on disk changes.
    const stripped = serveDist(distDir, (body, file) =>
      extname(file) === '.css'
        ? Buffer.from(String(body).replace(/@font-face\s*\{[^}]*\}/g, ''))
        : body,
    );
    const server2 = await stripped;
    const origin2 = `http://127.0.0.1:${server2.address().port}`;
    try {
      const { context, page } = await openPage();
      await page.goto(`${origin2}/index.html`, { waitUntil: 'networkidle' });
      const damaged = await measureTypeface(page);
      const sans = damaged.stacks.sans;
      const mono = damaged.stacks.mono;
      assert(
        'K6b',
        'CONTROL: with every @font-face stripped from the real bundle, P17a/P18a FAIL — ' +
          'the probe catches the defect this commit closes',
        Math.abs(sans.requestedWidth - damaged.control) < 0.5 &&
          Math.abs(mono.requestedWidth - damaged.control) < 0.5,
        `sans=${sans.requestedWidth} mono=${mono.requestedWidth} control=${damaged.control} ` +
          `(document.fonts.check said sans=${sans.checkSaysLoaded} mono=${mono.checkSaysLoaded})`,
      );
      assert(
        'K6c',
        'CONTROL: and the stack then paints in a platform fallback instead — which is what ' +
          'Windows saw as Segoe UI',
        Math.abs(sans.appliedWidth - sans.requestedWidth) > 1,
        `applied=${sans.appliedWidth} requested=${sans.requestedWidth} loaded faces=` +
          `${JSON.stringify(damaged.loadedFaces)}`,
      );
      // Why P20 had to be re-measured at all: the same column, in the fallback
      // face, is a different number of characters. A reading measure is a
      // property of the pair (width, face), and changing the face without
      // re-reading it is how a column tuned for one typeface ends up used for
      // another — which is the state this commit found the tree in.
      assert(
        'K6d',
        'CONTROL: characters-per-line moves when the face does — so P20 is a measurement of ' +
          'this typeface, not a constant',
        Math.abs(damaged.reading.charactersPerLine - liveReading.charactersPerLine) > 1,
        `fallback face: ${damaged.reading.charactersPerLine} cpl ` +
          `(mean advance ${damaged.reading.meanAdvancePx}px) vs bundled Inter: ` +
          `${liveReading.charactersPerLine} cpl (${liveReading.meanAdvancePx}px)`,
      );
      writeFileSync(
        join(outDir, 'typeface-probe-control.json'),
        JSON.stringify(damaged, null, 2) + '\n',
      );
      await context.close();
    } finally {
      server2.close();
    }
  }

  // K8 — the italic assertions, controlled. The same bundle with only the
  //      `font-style: italic` faces stripped: P17c/P18c must FAIL while
  //      P17a/P18a still PASS, which is what makes them a check on the italic
  //      cut specifically rather than on the family in general.
  {
    const server3 = await serveDist(distDir, (body, file) =>
      extname(file) === '.css'
        ? Buffer.from(
            String(body).replace(/@font-face\s*\{[^}]*\}/g, (rule) =>
              /font-style:\s*italic/.test(rule) ? '' : rule,
            ),
          )
        : body,
    );
    const origin3 = `http://127.0.0.1:${server3.address().port}`;
    try {
      const { context, page } = await openPage();
      await page.goto(`${origin3}/index.html`, { waitUntil: 'networkidle' });
      const noItalic = await measureTypeface(page);
      const sans = noItalic.stacks.sans;
      const mono = noItalic.stacks.mono;
      assert(
        'K8a',
        'CONTROL: with the italic faces stripped, P17c/P18c FAIL — the font set has no italic ' +
          'entry for either family',
        !sans.italicFace.present && !mono.italicFace.present,
        `sans=${JSON.stringify(sans.italicFace)} mono=${JSON.stringify(mono.italicFace)}`,
      );
      assert(
        'K8b',
        'CONTROL: and the engine falls back to shearing the roman — the sans italic advances ' +
          'collapse to exactly the roman, which is the signature of a synthesised oblique',
        Math.abs(sans.italicWidth - sans.requestedWidth) < 0.5,
        `stripped: italic=${sans.italicWidth} roman=${sans.requestedWidth} (delta 0); ` +
          `bundled, for comparison: the same pair differ`,
      );
      assert(
        'K8c',
        'CONTROL: …while P17a/P18a still PASS, so both italic checks judge the italic cut ' +
          'and not the family',
        Math.abs(sans.requestedWidth - noItalic.control) > 1 &&
          Math.abs(mono.requestedWidth - noItalic.control) > 1,
        `sans roman=${sans.requestedWidth} mono roman=${mono.requestedWidth} ` +
          `absent-font control=${noItalic.control}`,
      );
      await context.close();
    } finally {
      server3.close();
    }
  }

  // K7 — P20 must also move with the *token*, not only with the face. 46rem is
  //      the width the reading column actually had before Phase C, and it is
  //      the reading that was judged too wide; the band must reject it.
  {
    const { context, page } = await openPage();
    await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: ':root { --vela-measure: 46rem; }' });
    const wide = await measureTypeface(page);
    assert(
      'K7',
      'CONTROL: P20 fails at the pre-Phase-C 46rem column — the band is judging the width, ' +
        'not passing on anything it is handed',
      wide.reading.charactersPerLine > 75,
      `46rem gives ${wide.reading.charactersPerLine} characters per line, ` +
        `against a 65–75 band and ${liveReading.charactersPerLine} at the shipping 30rem`,
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
