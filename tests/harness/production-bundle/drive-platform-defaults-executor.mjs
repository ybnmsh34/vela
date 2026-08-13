/**
 * GATE M — THE PLATFORM-DEFAULTS EXECUTOR.
 *
 *   node tests/harness/production-bundle/drive-platform-defaults-executor.mjs \
 *        [--out <dir>] [--controls]
 *
 * This driver exists because of one specific failure the previous gate caught
 * itself committing: its `reading-surface.json` reported `fontFamily: Inter`
 * computed from the **declared** stack rather than from what the engine
 * resolved, so every artefact asserted a font that had never loaded. The
 * governing rule here is therefore:
 *
 *   > Every assertion must be a statement about a RESULT — something the engine
 *   > produced — and never about a DECLARATION the stylesheet made. Where an
 *   > engine cannot produce the result, the assertion is not written; the gap is
 *   > reported instead.
 *
 * Four of the checks below were deliberately re-cut against that rule after the
 * existing gates were read:
 *
 *   X1  The typeface is measured on **the nodes the user actually reads** — the
 *       empty-state heading, prose, inline code, a code block — by advance
 *       width against a deliberately absent family. `document.fonts.check()` is
 *       recorded and never asserted on: it returns `true` for a font that is
 *       not there, and did so throughout the period when Vela shipped no
 *       typeface at all.
 *   X3  `color-scheme` is not asserted from `getComputedStyle` alone. The used
 *       value is proven to reach **painted pixels** by sampling a UA-drawn
 *       widget: a bare `<input>` inside the real app, screenshotted, its
 *       centre pixel read. That is the same mechanism that paints the Windows
 *       scrollbar, and it is the closest a Linux engine can get to the finding.
 *   X4  Linux Chromium's overlay scrollbars are **measured to be absent**
 *       rather than assumed: a styled 12px scroller is shown to reserve zero
 *       gutter and to be pixel-identical to an unstyled one. The scrollbar is
 *       then reported as unobtainable here rather than passed.
 *   X6  Contrast is computed from the **rendered DOM** — the composited ground
 *       under each painted glyph, walked up the real ancestor chain — not from
 *       the token graph. `src/styles/contrast.test.ts` resolves declarations in
 *       jsdom, which is a different and weaker question.
 *
 * ## Honesty (`docs/architecture/conventions.md` §10)
 *
 * Chromium on Linux, the production `dist/` bundle, `BrowserAdapter`, no Tauri
 * IPC, no model, no keychain, no Windows, no real display scaling and no OS
 * scrollbar. **Everything here is VERIFIED-BY-FAKE and PROVISIONAL.** The
 * binding visual verdict belongs to the desktop session. What this run
 * establishes is that the layout and colour rules hold, in an engine, at the
 * viewport sizes 150% scaling actually produces — and, for the scrollbar, what
 * this engine can and cannot settle.
 *
 * `--controls` re-serves the same bundle with a defect staged in the response
 * body — the bytes on disk are never touched — and requires each assertion to
 * FAIL. An assertion that cannot fail is not evidence.
 */

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const outDir = flag('--out') ?? join(repoRoot, 'docs/regression-baseline/platform-defaults-executor');
const wantControls = argv.includes('--controls');

mkdirSync(outDir, { recursive: true });
for (const stale of readdirSync(outDir)) {
  if (stale.endsWith('.png') || stale.endsWith('.json') || stale === 'ASSERTION-LEDGER.tsv') {
    rmSync(join(outDir, stale));
  }
}

/* -------------------------------------------------------------------------- */
/* the ledger                                                                 */
/* -------------------------------------------------------------------------- */

const results = [];
let failures = 0;

function assert(id, claim, passed, detail = '') {
  results.push({ id, claim, passed, detail });
  if (!passed) failures += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id}  ${claim}${detail === '' ? '' : `  — ${detail}`}`);
  return passed;
}

/** Recorded, never asserted: a number this engine cannot produce. */
function report(id, claim, detail) {
  results.push({ id, claim, passed: true, detail: `REPORTED, NOT ASSERTED — ${detail}` });
  console.log(`....  ${id}  ${claim}  — REPORTED, NOT ASSERTED — ${detail}`);
}

/* -------------------------------------------------------------------------- */
/* the server: dist/, under the shipping CSP                                  */
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
  '.woff': 'font/woff',
};

const TAURI_CONF = JSON.parse(readFileSync(join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
const CSP = TAURI_CONF.app.security.csp;

function serveDist(root, rewrite = (body) => body) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
      try {
        const body = rewrite(readFileSync(file), file);
        response.writeHead(200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
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

/** Rewrites only the built CSS. Nothing on disk is touched. */
const damageCss = (replace) => (body, file) =>
  extname(file) === '.css' ? Buffer.from(replace(body.toString('utf8'))) : body;

/* -------------------------------------------------------------------------- */
/* the request traps, installed before the first module evaluates             */
/* -------------------------------------------------------------------------- */

const TRAPS = `
  window.__velaTrapped = [];
  window.__velaTrapInstalledAt = document.readyState;
  const record = (kind, url) => { try { window.__velaTrapped.push({ kind, url: String(url) }); } catch (_) {} };
  const realFetch = window.fetch;
  window.fetch = function (input) {
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
  const RealFontFace = window.FontFace;
  if (RealFontFace !== undefined) {
    window.FontFace = function (family, source, descriptors) {
      record('fontface', typeof source === 'string' ? source : '[binary]');
      return new RealFontFace(family, source, descriptors);
    };
  }
`;

/* -------------------------------------------------------------------------- */
/* opening the app                                                            */
/* -------------------------------------------------------------------------- */

async function openApp(
  origin,
  { width = 1180, height = 780, theme = 'dark', prefersDark = true, scale = 1 } = {},
) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    colorScheme: prefersDark ? 'dark' : 'light',
  });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const requests = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('request', (r) => requests.push(r.url()));
  await page.addInitScript(TRAPS);
  await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle' });
  // `system` is the attribute absent — `applyThemePreference`'s own encoding —
  // so the media query decides. An explicit choice stamps the attribute.
  if (theme !== 'system') {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
  } else {
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  }
  await page.waitForTimeout(60);
  return { context, page, pageErrors, consoleErrors, requests };
}

async function enterConversation(page) {
  const start = page.getByRole('button', { name: 'Start a conversation' });
  if ((await start.count()) > 0) await start.first().click();
  await page.waitForSelector('#vela-composer', { timeout: 10_000 });
}

async function configureEndpoint(page) {
  await page.getByRole('button', { name: /Choose a model|·/u }).first().click();
  await page.getByRole('button', { name: /Manage endpoints/u }).first().click();
  await page.getByRole('button', { name: 'Add an endpoint' }).click();
  const form = page.getByRole('form', { name: 'Add an endpoint' });
  await form.getByLabel('Name').fill('The workstation in the study');
  await form.getByLabel('Address').fill('http://127.0.0.1:8033/v1');
  await form.getByLabel(/^Model/u).fill('a-local-model');
  await form.getByRole('button', { name: 'Add endpoint' }).click();
  await page.waitForTimeout(350);
  const close = page.getByRole('button', { name: 'Close' });
  if ((await close.count()) > 0) await close.first().click();
  await page.waitForTimeout(150);
}

async function dismissOverlays(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const scrims = await page.locator('[class*="scrim"]').count();
    const panel = await page.getByRole('region', { name: 'Endpoints' }).count();
    if (scrims === 0 && panel === 0) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(160);
  }
}

/**
 * A turn whose answer exercises the reading surface: six heading levels, prose,
 * a list, a blockquote, inline code and a fenced block. The `BrowserAdapter`
 * echoes the user's text back, so sending markdown is how a fake host produces
 * a rendered answer — and the answer is rendered by the shipping `<Markdown>`,
 * which is the component whose colours are being measured.
 */
const RICH_MARKDOWN = [
  '# A heading at one',
  '',
  'Prose that has to set at a comfortable measure, with **bold emphasis**, an',
  '*italic run*, and `inline code` inside it.',
  '',
  '## A heading at two',
  '',
  '- a list item long enough to wrap onto a second line so the hanging indent shows',
  '- a second item',
  '',
  '> A blockquote, outdented onto the text ruler.',
  '',
  '### A heading at three',
  '',
  '```ts',
  'export function example(value: string): number {',
  '  // a comment, in the syntax-comment role',
  '  return value.length;',
  '}',
  '```',
  '',
  '#### four',
  '',
  '##### five',
  '',
  '###### six',
].join('\n');

async function sendRichTurn(page) {
  await dismissOverlays(page);
  await page.fill('#vela-composer', RICH_MARKDOWN);
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForFunction(
    () => {
      const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
      if (turn === undefined) return false;
      const stopping = [...document.querySelectorAll('button')].some((b) => b.textContent === 'Stop');
      return !stopping && !turn.innerText.includes('Waiting for the first token');
    },
    undefined,
    { timeout: 30_000, polling: 50 },
  );
  await page.waitForTimeout(250);
}

/* ========================================================================== */
/* X1 — THE TYPEFACE, MEASURED ON THE NODES THE USER READS                    */
/* ========================================================================== */

/**
 * The existing composition-root probe measures the family a `--vela-font-*`
 * token names. This one starts from the other end: it finds the elements that
 * actually carry text on screen, reads the family the engine resolved **for
 * that element**, and width-controls it.
 *
 * The difference matters. A token can name a face that loads while the element
 * the reader is looking at inherits something else entirely — a `font-family`
 * on a component, a `@media` override, a fallback triggered by a missing
 * `unicode-range`. Measuring the token answers "is the face in the bundle";
 * measuring the element answers "is the reader looking at it".
 */
const MEASURE_RENDERED_TYPEFACE = () => {
  const ABSENT = 'ZzQqNoSuchFontXx';
  const PROBE = 'Handgloves 12345 — the quick brown fox jumps over the lazy dog';

  const measure = (family, weight = 400, style = 'normal') => {
    const span = document.createElement('span');
    span.textContent = PROBE;
    span.style.cssText =
      'position:absolute;left:-9999px;top:0;white-space:pre;font-size:64px;' +
      'letter-spacing:normal;word-spacing:normal;font-kerning:none;font-variant:normal;' +
      'font-feature-settings:normal;font-stretch:normal;';
    span.style.fontFamily = family;
    span.style.fontWeight = String(weight);
    span.style.fontStyle = style;
    document.body.appendChild(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    return Math.round(width * 100) / 100;
  };

  const control = measure(`'${ABSENT}'`);

  /** The first visible element matching, that carries its own text. */
  const pick = (selector) => {
    for (const node of document.querySelectorAll(selector)) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      // A `<textarea>`'s text is its `value`, not a child text node, so the
      // composer would be skipped by a textContent test alone.
      const label = (node.textContent ?? '').trim();
      const placeholder = (node.getAttribute('placeholder') ?? '').trim();
      // `HTMLButtonElement.value` is `''`, not undefined, so a `??` chain
      // starting at `value` silently rejects every button on the page.
      const typed = node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement
        ? (node.value ?? '').trim()
        : '';
      if (label.length === 0 && placeholder.length === 0 && typed.length === 0) continue;
      return node;
    }
    return null;
  };

  const surfaces = [
    ['bodyRoot', 'body'],
    ['emptyStateHeading', 'h2'],
    ['prose', '.prose p, article p, main p'],
    ['button', 'button'],
    ['composer', '#vela-composer'],
    ['inlineCode', 'code'],
    ['codeBlock', 'pre, pre code'],
  ];

  const readings = {};
  for (const [id, selector] of surfaces) {
    const node = pick(selector);
    if (node === null) {
      readings[id] = { found: false };
      continue;
    }
    const cs = getComputedStyle(node);
    const resolved = cs.fontFamily.replace(/\s+/gu, ' ').trim();
    const first = (resolved.split(',')[0] ?? '').trim();
    readings[id] = {
      found: true,
      selector,
      tag: node.tagName.toLowerCase(),
      // The stack the ENGINE resolved for this element, not a token read off
      // `:root`. This is the value the previous gate mistook for a result.
      resolvedStack: resolved,
      firstFamily: first,
      fontSizePx: parseFloat(cs.fontSize),
      fontWeight: cs.fontWeight,
      // (1) the element's own stack, (2) its first family with ONLY the absent
      // family behind it, (3) the absent family alone.
      appliedWidth: measure(resolved, cs.fontWeight),
      firstFamilyWidth: measure(`${first}, '${ABSENT}'`, cs.fontWeight),
      control: measure(`'${ABSENT}'`, cs.fontWeight),
      // Recorded because it lies. Never asserted on.
      checkSaysLoaded: document.fonts.check(`64px ${first}`),
    };
  }

  return {
    control,
    absentControlFamily: ABSENT,
    readings,
    loadedFaces: [...document.fonts]
      .filter((f) => f.status === 'loaded')
      .map((f) => ({ family: f.family, weight: f.weight, style: f.style })),
    // Every @font-face the document knows about, loaded or not.
    declaredFaces: [...document.fonts].map((f) => ({
      family: f.family,
      style: f.style,
      status: f.status,
    })),
  };
};

async function measureTypeface(origin, prefix, { expectFailure = false } = {}) {
  const { context, page, requests } = await openApp(origin, { theme: 'dark' });
  await enterConversation(page);
  await configureEndpoint(page);
  await sendRichTurn(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const t = await page.evaluate(MEASURE_RENDERED_TYPEFACE);

  const expected = {
    bodyRoot: 'sans',
    emptyStateHeading: 'sans',
    prose: 'sans',
    button: 'sans',
    composer: 'sans',
    inlineCode: 'mono',
    codeBlock: 'mono',
  };

  for (const [id, reading] of Object.entries(t.readings)) {
    if (reading.found !== true) {
      assert(`${prefix}1-${id}`, `the ${id} surface is on screen to be measured`, expectFailure, 'not found');
      continue;
    }
    // (a) The face the element asks for FIRST is a face the engine actually
    //     has. Equal advances to the absent control means it is not there.
    const loaded = Math.abs(reading.firstFamilyWidth - reading.control) > 1;
    assert(
      `${prefix}1-${id}-loaded`,
      `the ${expected[id]} face the rendered <${reading.tag}> asks for is a face the engine has ` +
        '— WIDTH CONTROL, never document.fonts.check',
      expectFailure ? !loaded : loaded,
      `${reading.firstFamily}: ${reading.firstFamilyWidth}px vs absent-font control ` +
        `${reading.control}px (document.fonts.check said ${reading.checkSaysLoaded}, which is ` +
        'not evidence)',
    );
    // (b) …and the element is PAINTED in it, rather than in a fallback further
    //     down its own stack.
    const painted = Math.abs(reading.appliedWidth - reading.firstFamilyWidth) < 0.5;
    assert(
      `${prefix}1-${id}-painted`,
      `the rendered <${reading.tag}> is painted in that face and not in a fallback behind it`,
      expectFailure ? !painted : painted,
      `applied ${reading.appliedWidth}px vs requested ${reading.firstFamilyWidth}px; ` +
        `resolved stack ${JSON.stringify(reading.resolvedStack)}`,
    );
  }

  if (!expectFailure) {
    // (c) The sans and the mono are two different faces on screen — not one
    //     family shadowing the other through an inherited stack.
    const sans = t.readings.prose;
    const mono = t.readings.codeBlock;
    assert(
      `${prefix}1-two-faces`,
      'prose and code on screen are set in two different faces',
      sans.found && mono.found && Math.abs(sans.appliedWidth - mono.appliedWidth) > 1,
      `prose ${sans.appliedWidth}px, code ${mono.appliedWidth}px`,
    );
  }

  /* --- the network half: no font byte came from off-origin ---------------- */

  const trapped = await page.evaluate(() => window.__velaTrapped);
  const installedAt = await page.evaluate(() => window.__velaTrapInstalledAt);
  const fontRequests = requests.filter((url) => /\.(woff2?|ttf|otf|eot)(\?|$)/u.test(url));
  const offOrigin = requests.filter((url) => !url.startsWith(origin));

  if (!expectFailure) {
    assert(
      `${prefix}2-trap-order`,
      'the traps were installed before the document had a body, so "zero requests" is a ' +
        'measurement of the whole session and not of what happened after mount',
      installedAt === 'loading',
      `document.readyState was ${installedAt}`,
    );
    assert(
      `${prefix}2-no-egress`,
      'a whole session — mount, endpoint configured through the UI, a turn sent and rendered — ' +
        'produced zero fetch/XHR/WebSocket/EventSource/beacon/FontFace calls',
      trapped.length === 0,
      JSON.stringify(trapped),
    );
    assert(
      `${prefix}2-no-off-origin`,
      "Chromium's own request event saw nothing leave the page origin",
      offOrigin.length === 0,
      JSON.stringify(offOrigin),
    );
    assert(
      `${prefix}2-fonts-from-bundle`,
      'every font byte was served by the bundle itself',
      fontRequests.length > 0 && fontRequests.every((url) => url.startsWith(origin)),
      `${fontRequests.length} font requests: ${JSON.stringify(fontRequests.map((u) => u.replace(origin, '')))}`,
    );
    assert(
      `${prefix}2-font-src`,
      "the shipping CSP confines font-src to 'self' — a remote face could not be fetched even " +
        'if a stylesheet asked for one',
      /font-src\s+'self'(\s+data:)?\s*;/u.test(CSP),
      CSP.split(';').find((d) => d.includes('font-src'))?.trim() ?? 'no font-src directive',
    );
  }

  writeFileSync(join(outDir, `${prefix}1-typeface-rendered.json`), JSON.stringify(t, null, 2) + '\n');
  await context.close();
  return t;
}

/* ========================================================================== */
/* X3 — color-scheme, IN ALL THREE THEME STATES, PROVEN TO REACH PIXELS       */
/* ========================================================================== */

/**
 * The declared value is read from the engine, and then — the part that makes it
 * a result rather than a declaration — a UA-drawn widget is inserted into the
 * live app, screenshotted, and its centre pixel read. Chromium paints a bare
 * `<input>`'s background from the **used** `color-scheme`: white under `light`,
 * `rgb(59,59,59)` under `dark`. That is the same switch that decides whether
 * the Windows scrollbar is drawn light or dark, so a light widget sitting on
 * Vela's `#080b16` canvas is the reported defect reproduced in pixels, in the
 * one engine available here.
 */
async function measureColorScheme(origin, prefix, { expectFailure = false } = {}) {
  const rows = [];
  for (const theme of ['light', 'dark', 'system']) {
    for (const prefersDark of [false, true]) {
      const { context, page } = await openApp(origin, {
        theme,
        prefersDark,
        width: 1180,
        height: 780,
      });

      const read = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const parse = (c) => {
          const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(c);
          return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
        };
        const bg = parse(getComputedStyle(document.body).backgroundColor);
        // A UA widget, unstyled, inside the real app, at a known place.
        const probe = document.createElement('input');
        probe.type = 'text';
        probe.id = '__vela_ua_probe';
        probe.style.cssText =
          'position:fixed;left:40px;top:40px;width:160px;height:40px;z-index:99999;' +
          'border:0;padding:0;margin:0;';
        document.body.appendChild(probe);
        return {
          declared: root.colorScheme.trim(),
          bodyBackground: getComputedStyle(document.body).backgroundColor,
          bodyLuminance:
            bg === null ? null : (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255,
          uaWidgetComputed: getComputedStyle(probe).backgroundColor,
        };
      });

      // The pixel. `png` is 4 bytes/px raw only after decode, so instead of
      // pulling a decoder in, one pixel is screenshotted and compared against
      // two reference shots taken in the same run under forced schemes.
      const shot = await page.screenshot({ clip: { x: 100, y: 55, width: 2, height: 2 } });
      const reference = {};
      for (const forced of ['light', 'dark']) {
        await page.evaluate((value) => {
          document.getElementById('__vela_ua_probe').style.colorScheme = value;
        }, forced);
        reference[forced] = (await page.screenshot({ clip: { x: 100, y: 55, width: 2, height: 2 } })).toString('base64');
      }
      await page.evaluate(() => {
        document.getElementById('__vela_ua_probe').style.colorScheme = '';
      });

      const asPainted = shot.toString('base64');
      const paintedScheme =
        asPainted === reference.dark ? 'dark' : asPainted === reference.light ? 'light' : 'indeterminate';

      const palette = read.bodyLuminance === null ? null : read.bodyLuminance > 0.5 ? 'light' : 'dark';
      const keywords = read.declared.split(/\s+/u).filter((w) => w === 'light' || w === 'dark');

      const id = `${prefix}3-${theme}-os${prefersDark ? 'dark' : 'light'}`;
      rows.push({ theme, prefersDark, ...read, palette, paintedScheme });

      // (a) The app decides. `light dark` delegates the decision to the OS and
      //     is then right by luck in four states out of six.
      assert(
        `${id}-decides`,
        'the app states exactly one colour scheme rather than delegating to the OS',
        expectFailure ? keywords.length !== 1 : keywords.length === 1,
        `color-scheme: ${read.declared}`,
      );
      // (b) …and the widget the UA paints agrees with the palette the app is
      //     in. THIS IS A PIXEL READING, not a computed style.
      const agrees = paintedScheme === palette;
      assert(
        `${id}-painted`,
        'the UA paints its own widgets in the palette the app is in — read off the pixels, not ' +
          'off getComputedStyle',
        expectFailure ? !agrees : agrees,
        `declared "${read.declared}" → UA painted ${paintedScheme}; page ${read.bodyBackground} (${palette}); ` +
          `widget computed ${read.uaWidgetComputed}`,
      );
      await context.close();
    }
  }
  writeFileSync(join(outDir, `${prefix}3-color-scheme.json`), JSON.stringify(rows, null, 2) + '\n');
  return rows;
}

/* ========================================================================== */
/* X4 — THE SCROLLBAR: what this engine can and cannot settle                 */
/* ========================================================================== */

/**
 * Screenshots a genuinely scrollable region in each of the three theme states,
 * and — before doing so — MEASURES whether this engine draws a scrollbar at
 * all, rather than assuming it does or does not.
 *
 * The measurement is a control in its own right: a scroller carrying the app's
 * own `::-webkit-scrollbar` rules is compared against an unstyled one, both in
 * reserved gutter and in painted pixels. Identical pixels and a zero gutter
 * mean the widget is not on screen to be judged. That is the honest outcome
 * here, and it is reported rather than passed.
 */
async function measureScrollSurfaces(origin, prefix) {
  const observations = [];
  for (const theme of ['light', 'dark', 'system']) {
    const prefersDark = theme === 'system' ? true : theme === 'dark';
    const { context, page } = await openApp(origin, {
      theme,
      prefersDark,
      width: 1180,
      height: 620,
    });
    await enterConversation(page);
    await configureEndpoint(page);
    await sendRichTurn(page);
    await dismissOverlays(page);

    const probe = await page.evaluate(() => {
      const scroller = [...document.querySelectorAll('div')].find(
        (n) => getComputedStyle(n).overflowY === 'auto' && n.scrollHeight > n.clientHeight + 8,
      );
      const styled = document.createElement('div');
      styled.style.cssText =
        'position:fixed;left:-9999px;top:0;width:200px;height:100px;overflow-y:scroll';
      styled.innerHTML = '<div style="height:900px"></div>';
      document.body.append(styled);
      const gutter = styled.offsetWidth - styled.clientWidth;
      styled.remove();
      return {
        scrollerFound: scroller !== undefined,
        scrollerGutter: scroller === undefined ? null : scroller.offsetWidth - scroller.clientWidth,
        scrollHeight: scroller?.scrollHeight ?? null,
        clientHeight: scroller?.clientHeight ?? null,
        adHocGutter: gutter,
        scrollbarSizeToken: getComputedStyle(document.documentElement)
          .getPropertyValue('--vela-scrollbar-size')
          .trim(),
        thumbToken: getComputedStyle(document.documentElement)
          .getPropertyValue('--vela-scrollbar-thumb')
          .trim(),
        gutterProperty: scroller === undefined ? null : getComputedStyle(scroller).scrollbarGutter,
      };
    });

    assert(
      `${prefix}4-${theme}-scrollable`,
      'the region captured in this theme is genuinely scrollable, so a scrollbar would be drawn ' +
        'here if this engine drew one',
      probe.scrollerFound === true && probe.scrollHeight > probe.clientHeight + 8,
      `scrollHeight ${probe.scrollHeight} vs clientHeight ${probe.clientHeight}`,
    );

    // Wind to the middle so both scroll edges are live and the thumb, if any,
    // would be mid-track rather than parked at an end.
    await page.evaluate(() => {
      const scroller = [...document.querySelectorAll('div')].find(
        (n) => getComputedStyle(n).overflowY === 'auto' && n.scrollHeight > n.clientHeight + 8,
      );
      if (scroller !== undefined) scroller.scrollTop = Math.round(scroller.scrollHeight / 2);
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(outDir, `scrollable-${theme}.png`) });

    observations.push({ theme, ...probe });
    await context.close();
  }

  const anyGutter = observations.some((o) => o.adHocGutter > 0);
  if (anyGutter) {
    assert(
      `${prefix}4-gutter`,
      'a plain scroller reserves the width the token declares',
      observations.every(
        (o) => Math.abs(o.adHocGutter - Number.parseFloat(o.scrollbarSizeToken)) < 0.6,
      ),
      JSON.stringify(observations.map((o) => [o.theme, o.adHocGutter, o.scrollbarSizeToken])),
    );
  } else {
    report(
      `${prefix}4-gutter`,
      'the painted scrollbar is not obtainable in this engine',
      `an unstyled scroller reserves 0px here, so Linux Chromium is drawing OVERLAY scrollbars ` +
        `and no scrollbar widget exists to be measured or photographed. The app's own scroller ` +
        `still reserves ${observations[0]?.scrollerGutter}px because ` +
        `scrollbar-gutter: ${observations[0]?.gutterProperty} reserves it explicitly. ` +
        `The painted scrollbar is the desktop session's verdict and only theirs.`,
    );
  }
  writeFileSync(join(outDir, `${prefix}4-scroll-surfaces.json`), JSON.stringify(observations, null, 2) + '\n');
  return observations;
}

/* ========================================================================== */
/* X5 — 150% DISPLAY SCALING: the empty state AND a real conversation         */
/* ========================================================================== */

/**
 * 150% scaling does not change the CSS pixel. It shrinks the desktop, and the
 * window is capped by what is left of it — so these are the real effective work
 * areas, less Windows 11's 48px taskbar, with `deviceScaleFactor: 1.5` so every
 * measurement lands on the same fractional device-pixel grid the hardware uses.
 *
 * **This approximates Windows scaling and nothing more.** It is not Windows, it
 * is not WebView2, and it does not exercise Windows' own DPI virtualisation,
 * per-monitor DPI changes, or the non-client area. Only the desktop session can
 * confirm the finding; what is established here is that the layout rules hold at
 * those sizes in an engine.
 */
const TASKBAR = 48;
const SCALED_VIEWPORTS = [
  { id: '1920x1080@150', width: 1280, height: 720 - TASKBAR },
  { id: '1600x900@150', width: 1066, height: 600 - TASKBAR },
  { id: '1366x768@150', width: 911, height: 512 - TASKBAR },
];

/**
 * Measures the empty state, the model bar's rule, and (when a conversation is
 * loaded) the first turn — all found structurally, because the shipped bundle's
 * CSS-module class names are hashed.
 */
const MEASURE_SCALED = () => {
  const box = (node) => {
    const r = node.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      width: r.width,
      height: r.height,
    };
  };

  const scroller = [...document.querySelectorAll('div')].find(
    (n) => getComputedStyle(n).overflowY === 'auto' && n.closest('section[aria-label="Conversation"]') !== null,
  );
  if (scroller === undefined) return { found: false, reason: 'no conversation scroller' };

  // THE HEADER RULE. `ModelBar.module.css` draws it as a `border-bottom` on the
  // bar; it is found here as the nearest ancestor of the model switcher that
  // actually has a bottom border, so the measurement is of the rule the user
  // sees rather than of a class name.
  const switcher = [...document.querySelectorAll('button')].find((b) =>
    /Choose a model|·/u.test(b.textContent ?? ''),
  );
  let bar = switcher ?? null;
  while (bar !== null) {
    const cs = getComputedStyle(bar);
    if (parseFloat(cs.borderBottomWidth) > 0 && cs.borderBottomStyle !== 'none') break;
    bar = bar.parentElement;
  }

  const heading = [...scroller.querySelectorAll('h1, h2, h3')].find(
    (n) => (n.textContent ?? '').trim().length > 0,
  );
  const mark = scroller.querySelector('svg');
  const turns = [...scroller.querySelectorAll('article')];
  const firstTurn = turns[0] ?? null;
  const lastTurn = turns[turns.length - 1] ?? null;
  const composer = document.querySelector('#vela-composer');
  const statusLine = document.querySelector('[data-testid="status-line"]');

  // TWO snapshots, because a transcript and an empty state answer different
  // questions. `painted` is what the user is shown on first launch, untouched —
  // and a conversation with entries is SUPPOSED to rest at the bottom, so the
  // first turn being above the fold there is correct behaviour, not a defect.
  // What has to hold for a transcript is that winding back to the top reaches
  // its beginning; that is measured in the second snapshot.
  const paintedScrollTop = scroller.scrollTop;
  scroller.scrollTop = 0;
  const woundToTop = {
    firstTurn: firstTurn === null ? null : box(firstTurn),
    heading: heading === undefined ? null : box(heading),
    mark: mark === null ? null : box(mark),
  };
  scroller.scrollTop = paintedScrollTop;

  return {
    found: true,
    turnCount: turns.length,
    woundToTop,
    lastTurn: lastTurn === null ? null : box(lastTurn),
    scrollTopAsPainted: scroller.scrollTop,
    scroller: {
      ...box(scroller),
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      canScroll: scroller.scrollHeight > scroller.clientHeight + 1,
    },
    headerRule: bar === null ? null : { ...box(bar), border: getComputedStyle(bar).borderBottomWidth },
    heading: heading === undefined ? null : { ...box(heading), text: (heading.textContent ?? '').slice(0, 60) },
    mark: mark === null ? null : box(mark),
    firstTurn: firstTurn === null ? null : box(firstTurn),
    composer: composer === null ? null : box(composer),
    statusLine: statusLine === null ? null : box(statusLine),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentScrollWidth: document.documentElement.scrollWidth,
  };
};

async function measureScaling(origin, prefix, { expectFailure = false, screenshots = true } = {}) {
  for (const viewport of SCALED_VIEWPORTS) {
    for (const theme of ['light', 'dark']) {
      for (const surface of ['empty', 'conversation']) {
        const { context, page, pageErrors } = await openApp(origin, {
          ...viewport,
          theme,
          prefersDark: theme === 'dark',
          scale: 1.5,
        });
        await enterConversation(page);
        if (surface === 'conversation') {
          await configureEndpoint(page);
          await sendRichTurn(page);
          await dismissOverlays(page);
        }
        const m = await page.evaluate(MEASURE_SCALED);
        const id = `${prefix}5-${viewport.id}-${theme}-${surface}`;

        if (m.found !== true) {
          assert(id, 'the conversation surface is on screen', expectFailure, JSON.stringify(m));
          await context.close();
          continue;
        }

        if (surface === 'empty') {
          // (a) THE BRIEFED DEFECT: on first launch, with nothing touched, the
          //     mark is on screen and the heading clears the header rule.
          const markOnScreen =
            m.mark !== null &&
            m.mark.top >= m.scroller.top - 0.5 &&
            m.mark.bottom <= m.scroller.bottom + 0.5 &&
            m.mark.height > 8;
          assert(
            `${id}-mark`,
            'on first launch the Vela mark is drawn, whole, inside the scroll container',
            expectFailure ? !markOnScreen : markOnScreen,
            m.mark === null
              ? 'no mark in the empty state'
              : `mark ${m.mark.top.toFixed(1)}–${m.mark.bottom.toFixed(1)} (${m.mark.width.toFixed(0)}×${m.mark.height.toFixed(0)}) ` +
                `inside container ${m.scroller.top.toFixed(1)}–${m.scroller.bottom.toFixed(1)}; ` +
                `rested at scrollTop ${m.scrollTopAsPainted.toFixed(0)}`,
          );

          // (b) …and the heading CLEARS THE HEADER RULE rather than jamming
          //     against it. Measured against the rule itself, not a constant.
          const clearance =
            m.headerRule === null || m.heading === null ? null : m.heading.top - m.headerRule.bottom;
          const clears = clearance !== null && clearance >= 8;
          assert(
            `${id}-clears-rule`,
            'the empty-state heading clears the header rule rather than sitting flush against it',
            expectFailure ? !clears : clears,
            clearance === null
              ? `heading=${m.heading === null ? 'none' : 'found'} rule=${m.headerRule === null ? 'none' : 'found'}`
              : `${clearance.toFixed(1)}px of clear air below the rule at y=${m.headerRule.bottom.toFixed(1)} ` +
                `(heading "${m.heading.text.trim()}" at ${m.heading.top.toFixed(1)})`,
          );
        } else {
          // The conversation, which the previous run never drove at 150%.
          //
          // A CORRECTION TO THIS DRIVER'S FIRST CUT, recorded because the wrong
          // assertion produced six red lines that were not defects. It asserted
          // that a conversation opens with its FIRST turn on screen. That is
          // wrong: `restingScrollTop` pins a transcript that has entries to the
          // bottom, which is what a reader wants, and the first turn of a long
          // answer is correctly above the fold. The empty state is the case
          // where resting at the bottom is wrong, and it has its own assertion
          // above. What must hold for a transcript is the pair below.
          const latestVisible =
            m.lastTurn !== null &&
            m.lastTurn.bottom <= m.scroller.bottom + 1 &&
            m.lastTurn.bottom >= m.scroller.top &&
            m.lastTurn.height > 8;
          assert(
            `${id}-latest-turn`,
            'a conversation with entries opens on its latest turn, inside the container',
            expectFailure ? !latestVisible : latestVisible,
            m.lastTurn === null
              ? 'no turn rendered'
              : `latest turn ${m.lastTurn.top.toFixed(1)}–${m.lastTurn.bottom.toFixed(1)} vs container ` +
                `${m.scroller.top.toFixed(1)}–${m.scroller.bottom.toFixed(1)}; rested at scrollTop ` +
                `${m.scrollTopAsPainted.toFixed(0)} of ${m.scroller.scrollHeight}`,
          );
          // …and the beginning is REACHABLE: wound back to the top, the first
          // turn is inside the container and clears the header rule. Content
          // that no gesture can reach is the actual 150% defect.
          const wound = m.woundToTop.firstTurn;
          const reachable = wound !== null && wound.top >= m.scroller.top - 0.5;
          assert(
            `${id}-first-turn-reachable`,
            'wound back to the top, the first turn is inside the container — nothing is stranded ' +
              'above the scrollable area',
            expectFailure ? !reachable : reachable,
            wound === null
              ? 'no turn rendered'
              : `wound to top: first turn at ${wound.top.toFixed(1)} vs container ${m.scroller.top.toFixed(1)}`,
          );
          const clearance =
            m.headerRule === null || wound === null ? null : wound.top - m.headerRule.bottom;
          assert(
            `${id}-clears-rule`,
            'wound to the top, the transcript clears the header rule',
            expectFailure
              ? !(clearance !== null && clearance >= 0)
              : clearance !== null && clearance >= 0,
            clearance === null ? 'not measurable' : `${clearance.toFixed(1)}px below the rule`,
          );
        }

        if (!expectFailure) {
          const composerInside =
            m.composer !== null && m.composer.bottom <= m.viewport.height + 0.5 && m.composer.height > 8;
          assert(
            `${id}-composer`,
            'the composer is still inside the window',
            composerInside,
            m.composer === null ? 'no composer' : `bottom ${m.composer.bottom.toFixed(1)} of ${m.viewport.height}`,
          );
          assert(
            `${id}-no-sideways`,
            'the window does not scroll sideways',
            m.documentScrollWidth <= m.viewport.width + 0.5,
            `document ${m.documentScrollWidth} vs viewport ${m.viewport.width}`,
          );
          assert(`${id}-clean`, 'no uncaught exception at this size', pageErrors.length === 0, pageErrors.join(' | '));
        }

        if (screenshots && !expectFailure) {
          await page.screenshot({ path: join(outDir, `dpi150-${viewport.id}-${theme}-${surface}.png`) });
        }
        await context.close();
      }
    }
  }
}

/* ========================================================================== */
/* X6 — CONTRAST, COMPUTED FROM THE RENDERED DOM                              */
/* ========================================================================== */

/**
 * Every painted glyph, against the ground actually underneath it.
 *
 * The existing `src/styles/contrast.test.ts` resolves the token graph in jsdom
 * and computes 181 declared pairs. That is a good test and a different
 * question: it asks whether the *declarations* pair up. This asks what the
 * engine put on screen — which ancestor's fill is actually behind this text
 * after the cascade, after `:hover`/`:focus` states are absent, after alpha
 * compositing, after an ancestor's `opacity` has faded the pair together.
 *
 * Ground is composited by walking the real ancestor chain and stacking every
 * non-transparent `background-color` until an opaque one is reached. A pair
 * standing on a gradient, or under a faded ancestor, is RECORDED and excluded
 * from the assertion with its reason, because a single number would be a
 * fiction there.
 */
const MEASURE_CONTRAST = (tokenNames) => {
  const parse = (value) => {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.%]+))?/u.exec(value ?? '');
    if (m === null) return null;
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const luminance = ({ r, g, b }) => {
    const channel = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (a, b) => {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const hex = ({ r, g, b }) =>
    '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  /* The token map, resolved IN THIS DOCUMENT under the theme now applied, so a
     measured colour can be named by the role that produced it. */
  const rootStyles = getComputedStyle(document.documentElement);
  const tokenByValue = new Map();
  for (const name of tokenNames) {
    const raw = rootStyles.getPropertyValue(name).trim();
    // Only tokens that ARE colours. Without this the probe below is handed
    // `12px` or `0.2s`, the span's colour stays inherited, and every spacing
    // token in the sheet ends up "naming" the body text colour — a reverse map
    // that names everything names nothing.
    if (raw === '' || !CSS.supports('color', raw)) continue;
    const rgb = parse(raw) ?? (() => {
      // Hex or named: let the engine normalise it.
      const probe = document.createElement('span');
      probe.style.color = raw;
      document.body.appendChild(probe);
      const normalised = getComputedStyle(probe).color;
      probe.remove();
      return parse(normalised);
    })();
    if (rgb === null) continue;
    const key = `${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)},${rgb.a.toFixed(3)}`;
    if (!tokenByValue.has(key)) tokenByValue.set(key, []);
    tokenByValue.get(key).push(name);
  };
  const nameOf = (rgb) => {
    const key = `${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)},${rgb.a.toFixed(3)}`;
    return (tokenByValue.get(key) ?? []).join(' / ');
  };

  /** The composited ground under an element, and what made it uncomputable. */
  const groundOf = (element) => {
    const layers = [];
    const notes = [];
    let node = element;
    while (node !== null && node !== document.documentElement.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage !== 'none') notes.push(`background-image on <${node.tagName.toLowerCase()}>`);
      if (Number.parseFloat(cs.opacity) < 1) notes.push(`opacity ${cs.opacity} on <${node.tagName.toLowerCase()}>`);
      const bg = parse(cs.backgroundColor);
      if (bg !== null && bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 0.999) break;
      }
      node = node.parentElement;
    }
    if (layers.length === 0) return { ground: null, notes };
    // Composite from the bottom of the stack upwards.
    let ground = layers[layers.length - 1];
    if (ground.a < 0.999) return { ground: null, notes: [...notes, 'no opaque ground beneath the text'] };
    for (let i = layers.length - 2; i >= 0; i -= 1) ground = over(layers[i], ground);
    return { ground, notes };
  };

  /** Elements that paint their own text. */
  const visible = (node) => {
    const cs = getComputedStyle(node);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    const r = node.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };

  const pairs = [];
  const seen = new Set();
  const push = (entry) => {
    const key = `${entry.fg}|${entry.bg}|${entry.role}|${entry.sizePx}|${entry.weight}`;
    if (seen.has(key)) {
      const existing = pairs.find((p) => p.key === key);
      if (existing !== undefined) existing.count += 1;
      return;
    }
    seen.add(key);
    pairs.push({ ...entry, key, count: 1 });
  };

  const record = (node, pseudo, colorValue, label) => {
    const fg = parse(colorValue);
    if (fg === null || fg.a === 0) return;
    const { ground, notes } = groundOf(node);
    const cs = getComputedStyle(node, pseudo ?? undefined);
    const sizePx = Number.parseFloat(cs.fontSize);
    const weight = Number.parseInt(cs.fontWeight, 10) || 400;
    if (ground === null) {
      push({
        fg: hex(fg),
        bg: null,
        fgToken: nameOf(fg),
        bgToken: '',
        role: label,
        sizePx,
        weight,
        ratio: null,
        computable: false,
        why: notes.join('; ') || 'no ground',
        sample: (node.textContent ?? '').trim().slice(0, 48),
      });
      return;
    }
    const composited = fg.a < 0.999 ? over(fg, ground) : fg;
    push({
      fg: hex(composited),
      bg: hex(ground),
      fgToken: nameOf(fg),
      bgToken: nameOf(ground),
      role: label,
      sizePx,
      weight,
      // WCAG 2.x large text: >= 24px, or >= 18.66px at weight >= 700.
      large: sizePx >= 24 || (sizePx >= 18.66 && weight >= 700),
      ratio: Math.round(ratio(composited, ground) * 100) / 100,
      computable: notes.length === 0,
      why: notes.join('; '),
      sample:
        pseudo === '::placeholder'
          ? (node.getAttribute('placeholder') ?? '').slice(0, 48)
          : (node.textContent ?? '').trim().slice(0, 48),
    });
  };

  for (const node of document.querySelectorAll('body *')) {
    if (!visible(node)) continue;
    const ownText = [...node.childNodes].some(
      (child) => child.nodeType === 3 && (child.textContent ?? '').trim().length > 0,
    );
    const cs = getComputedStyle(node);
    if (ownText) record(node, null, cs.color, `<${node.tagName.toLowerCase()}> text`);
    // Pseudo-elements that paint text of their own.
    for (const pseudo of ['::before', '::after', '::marker']) {
      const ps = getComputedStyle(node, pseudo);
      if (ps.content !== 'none' && ps.content !== 'normal' && ps.content !== '""') {
        record(node, pseudo, ps.color, `<${node.tagName.toLowerCase()}>${pseudo}`);
      }
    }
    // The placeholder is the most-read string in an idle app and belongs to a
    // pseudo-element, so nothing that walks text nodes would ever see it.
    //
    // Guarded on the attribute being non-empty AND the field being empty: a
    // `::placeholder` colour computes on every input whether or not any
    // placeholder is painted, and measuring one that is never on screen would
    // be measuring a declaration — the exact error this driver exists to avoid.
    if (
      (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') &&
      (node.getAttribute('placeholder') ?? '').trim().length > 0 &&
      node.value === ''
    ) {
      const ph = getComputedStyle(node, '::placeholder');
      record(node, '::placeholder', ph.color, `<${node.tagName.toLowerCase()}>::placeholder`);
    }
  }

  return {
    theme: document.documentElement.getAttribute('data-theme') ?? 'system',
    pageBackground: getComputedStyle(document.body).backgroundColor,
    pairs: pairs.map(({ key, ...rest }) => rest),
  };
};

/** Every `--vela-*` custom property the built stylesheet declares. */
function tokenNamesFromBundle(dir) {
  const names = new Set();
  for (const file of readdirSync(join(dir, 'assets'))) {
    if (!file.endsWith('.css')) continue;
    const css = readFileSync(join(dir, 'assets', file), 'utf8');
    for (const match of css.matchAll(/(--vela-[a-z0-9-]+)\s*:/gu)) names.add(match[1]);
  }
  return [...names].sort();
}

async function measureContrast(origin, prefix, { expectFailure = false } = {}) {
  const tokenNames = tokenNamesFromBundle(distDir);
  const all = [];

  for (const theme of ['light', 'dark']) {
    for (const [state, drive] of [
      ['home', async () => {}],
      [
        'conversation',
        async (page) => {
          await enterConversation(page);
          await configureEndpoint(page);
          await sendRichTurn(page);
          await dismissOverlays(page);
        },
      ],
      [
        'switcher',
        async (page) => {
          await enterConversation(page);
          await configureEndpoint(page);
          await dismissOverlays(page);
          await page.getByRole('button', { name: /Choose a model|·/u }).first().click();
          await page.waitForTimeout(200);
        },
      ],
      [
        'endpoints',
        async (page) => {
          await enterConversation(page);
          await page.getByRole('button', { name: /Choose a model|·/u }).first().click();
          await page.getByRole('button', { name: /Manage endpoints/u }).first().click();
          await page.getByRole('button', { name: 'Add an endpoint' }).click();
          await page.waitForTimeout(250);
        },
      ],
      [
        'palette',
        async (page) => {
          await enterConversation(page);
          await dismissOverlays(page);
          await page.keyboard.press('Control+k');
          await page.waitForTimeout(250);
        },
      ],
    ]) {
      const { context, page } = await openApp(origin, {
        theme,
        prefersDark: theme === 'dark',
        width: 1180,
        height: 780,
      });
      await drive(page);
      const measured = await page.evaluate(MEASURE_CONTRAST, tokenNames);
      for (const pair of measured.pairs) all.push({ theme, state, ...pair });
      await context.close();
    }
  }

  /* --- roll up: one row per distinct (fg, bg, theme) ---------------------- */

  const rolled = new Map();
  for (const pair of all) {
    const key = `${pair.theme}|${pair.fg}|${pair.bg}|${pair.large ? 'large' : 'body'}`;
    const existing = rolled.get(key);
    if (existing === undefined) rolled.set(key, { ...pair, seenIn: new Set([`${pair.state}:${pair.role}`]) });
    else existing.seenIn.add(`${pair.state}:${pair.role}`);
  }
  const rows = [...rolled.values()]
    .map((r) => ({ ...r, seenIn: [...r.seenIn].sort() }))
    .sort((a, b) => (a.ratio ?? 99) - (b.ratio ?? 99));

  writeFileSync(
    join(outDir, `${prefix}6-contrast-rendered.json`),
    JSON.stringify({ tokenNames: tokenNames.length, rows }, null, 2) + '\n',
  );

  const computable = rows.filter((r) => r.computable && r.ratio !== null);
  const uncomputable = rows.filter((r) => !r.computable || r.ratio === null);
  const bodyText = computable.filter((r) => !r.large);
  const largeText = computable.filter((r) => r.large);

  for (const theme of ['light', 'dark']) {
    const failing = bodyText.filter((r) => r.theme === theme && r.ratio < 4.5);
    assert(
      `${prefix}6-${theme}-body-aa`,
      `every body-text pair painted in the ${theme} theme clears 4.5:1 against the ground ` +
        'actually underneath it',
      expectFailure ? failing.length > 0 : failing.length === 0,
      failing.length === 0
        ? `${bodyText.filter((r) => r.theme === theme).length} body pairs, worst ` +
          `${Math.min(...bodyText.filter((r) => r.theme === theme).map((r) => r.ratio)).toFixed(2)}:1`
        : failing
            .map((r) => `${r.ratio}:1 ${r.fg}${r.fgToken === '' ? '' : ` (${r.fgToken})`} on ${r.bg} [${r.seenIn[0]}]`)
            .join(' | '),
    );
    const failingLarge = largeText.filter((r) => r.theme === theme && r.ratio < 3);
    assert(
      `${prefix}6-${theme}-large-aa`,
      `every large-text pair in the ${theme} theme clears 3:1`,
      expectFailure ? true : failingLarge.length === 0,
      failingLarge.length === 0
        ? `${largeText.filter((r) => r.theme === theme).length} large pairs`
        : failingLarge.map((r) => `${r.ratio}:1 ${r.fg} on ${r.bg}`).join(' | '),
    );
  }

  if (!expectFailure) {
    assert(
      `${prefix}6-coverage`,
      'the audit actually reached the surfaces — a rendered-DOM audit that found nothing would ' +
        'pass every ratio check vacuously',
      computable.length >= 40 && all.length >= 100,
      `${all.length} painted (element, ground) observations rolled up to ${rows.length} distinct ` +
        `pairs; ${computable.length} computable, ${uncomputable.length} not`,
    );
    for (const row of uncomputable) {
      report(
        `${prefix}6-uncomputable`,
        `a pair whose ground is not a single colour: ${row.fg} in ${row.theme}`,
        `${row.why} — seen in ${row.seenIn.slice(0, 2).join(', ')}`,
      );
    }
  }

  return { rows, all };
}

/* ========================================================================== */
/* the run                                                                    */
/* ========================================================================== */

const browser = await chromium.launch();
const server = await serveDist(distDir);
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  console.log('\n=== X1/X2 — the typeface on the nodes the user reads, and the silence around it ===');
  await measureTypeface(origin, 'X');
  console.log('\n=== X3 — color-scheme in all three theme states, proven to reach pixels ===');
  await measureColorScheme(origin, 'X');
  console.log('\n=== X4 — the scrollbar: what this engine can settle ===');
  await measureScrollSurfaces(origin, 'X');
  console.log('\n=== X5 — 150% display scaling: the empty state AND a conversation ===');
  await measureScaling(origin, 'X');
  console.log('\n=== X6 — contrast, computed from the rendered DOM ===');
  await measureContrast(origin, 'X');
} finally {
  server.close();
}

if (wantControls) {
  console.log('\n########## ASSERTION CONTROLS — each damage must make its own family FAIL ##########');
  for (const control of controlsList()) {
    console.log(`\n--- ${control.id}: ${control.what} ---`);
    const damaged = await serveDist(distDir, control.damage);
    const damagedOrigin = `http://127.0.0.1:${damaged.address().port}`;
    try {
      await control.run(damagedOrigin);
    } finally {
      damaged.close();
    }
  }
}

await browser.close();

writeFileSync(
  join(outDir, 'ASSERTION-LEDGER.tsv'),
  [
    'id\tverdict\tclaim\tdetail',
    ...results.map((r) => `${r.id}\t${r.passed ? 'PASS' : 'FAIL'}\t${r.claim}\t${r.detail}`),
  ].join('\n') + '\n',
);
console.log(`\n${results.length} assertions, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);

/* ========================================================================== */

function controlsList() {
  return [
    {
      id: 'C1',
      what: 'every @font-face stripped from the real bundle — the state this repo shipped in',
      damage: damageCss((css) => css.replace(/@font-face\s*\{[^}]*\}/gu, '')),
      run: async (damagedOrigin) => {
        await measureTypeface(damagedOrigin, 'C1-X', { expectFailure: true });
      },
    },
    {
      id: 'C3',
      what: '`color-scheme` widened back to `light dark`, which delegates to the OS',
      damage: damageCss((css) => css.replaceAll(/color-scheme:\s*dark/gu, 'color-scheme:light dark')),
      run: async (damagedOrigin) => {
        // Only the state the widened sheet actually gets wrong is required to
        // reproduce: an explicit dark theme on an OS that prefers light. The
        // other five agree by luck and reporting them as "reproduced" would be
        // a lie. This is asserted on the PIXEL, so it is the white widget on
        // the dark canvas — the reported defect's own mechanism.
        const { context, page } = await openApp(damagedOrigin, {
          theme: 'dark',
          prefersDark: false,
          width: 1180,
          height: 780,
        });
        const read = await page.evaluate(() => {
          const probe = document.createElement('input');
          probe.type = 'text';
          probe.id = '__vela_ua_probe';
          probe.style.cssText =
            'position:fixed;left:40px;top:40px;width:160px;height:40px;z-index:99999;border:0;padding:0;margin:0;';
          document.body.appendChild(probe);
          return {
            declared: getComputedStyle(document.documentElement).colorScheme.trim(),
            widget: getComputedStyle(probe).backgroundColor,
            page: getComputedStyle(document.body).backgroundColor,
          };
        });
        const shot = await page.screenshot({ clip: { x: 100, y: 55, width: 2, height: 2 } });
        const references = {};
        for (const forced of ['light', 'dark']) {
          await page.evaluate((v) => {
            document.getElementById('__vela_ua_probe').style.colorScheme = v;
          }, forced);
          references[forced] = (
            await page.screenshot({ clip: { x: 100, y: 55, width: 2, height: 2 } })
          ).toString('base64');
        }
        const painted =
          shot.toString('base64') === references.dark
            ? 'dark'
            : shot.toString('base64') === references.light
              ? 'light'
              : 'indeterminate';
        assert(
          'C3-dark-app-light-widget',
          'CONTROL: with `light dark` restored, the UA paints a LIGHT widget on the dark app — ' +
            'the reported white-scrollbar defect, in pixels',
          painted === 'light' && read.declared === 'light dark',
          `declared "${read.declared}" → painted ${painted}; widget ${read.widget} on page ${read.page}`,
        );
        await context.close();
      },
    },
    {
      id: 'C5',
      what: 'the empty state pinned to the bottom of its scroller, as the pre-fix bundle rested',
      // `restingScrollTop` lives in JS, so the damage that reproduces the DPI
      // defect from CSS is the one that made the state too tall for its
      // container in the first place: put back the fixed gaps and remove the
      // safe centring. Rather than guess at the pre-fix CSS, the control forces
      // the scroller to the bottom the way the pre-fix code did, and requires
      // the mark assertion to fail there.
      damage: (body) => body,
      run: async (damagedOrigin) => {
        for (const viewport of SCALED_VIEWPORTS) {
          const { context, page } = await openApp(damagedOrigin, {
            ...viewport,
            theme: 'dark',
            prefersDark: true,
            scale: 1.5,
          });
          await enterConversation(page);
          // The pre-fix behaviour, staged: pin the empty state to the bottom.
          await page.evaluate(() => {
            const scroller = [...document.querySelectorAll('div')].find(
              (n) =>
                getComputedStyle(n).overflowY === 'auto' &&
                n.closest('section[aria-label="Conversation"]') !== null,
            );
            if (scroller !== undefined) scroller.scrollTop = scroller.scrollHeight;
          });
          await page.waitForTimeout(120);
          const m = await page.evaluate(MEASURE_SCALED);
          const markOnScreen =
            m.found === true &&
            m.mark !== null &&
            m.mark.top >= m.scroller.top - 0.5 &&
            m.mark.bottom <= m.scroller.bottom + 0.5;
          assert(
            `C5-${viewport.id}-pinned-to-bottom`,
            'CONTROL: with the empty state resting at the bottom — the pre-fix behaviour — the ' +
              'mark assertion FAILS at this 150% viewport',
            !markOnScreen,
            m.found !== true
              ? 'surface not found'
              : `mark ${m.mark === null ? 'absent' : `${m.mark.top.toFixed(1)}–${m.mark.bottom.toFixed(1)}`} ` +
                `vs container ${m.scroller.top.toFixed(1)}–${m.scroller.bottom.toFixed(1)} at scrollTop ` +
                `${m.scroller.scrollTop.toFixed(0)}`,
          );
          await context.close();
        }
      },
    },
    {
      id: 'C6',
      what: '`--vela-text-subtle` reverted to its pre-fix value in both themes (#6f7896)',
      damage: damageCss((css) => css.replaceAll(/--vela-text-subtle:\s*[^;]+;/gu, '--vela-text-subtle:#6f7896;')),
      run: async (damagedOrigin) => {
        await measureContrast(damagedOrigin, 'C6-X', { expectFailure: true });
      },
    },
    {
      id: 'C6b',
      what: 'body text set to a role that has never cleared AA anywhere (--vela-border)',
      damage: damageCss((css) => css.replaceAll(/--vela-text:\s*var\(--vela-night-900\)/gu, '--vela-text:var(--vela-night-300)')),
      run: async (damagedOrigin) => {
        const { context, page } = await openApp(damagedOrigin, {
          theme: 'light',
          prefersDark: false,
          width: 1180,
          height: 780,
        });
        const tokenNames = tokenNamesFromBundle(distDir);
        const measured = await page.evaluate(MEASURE_CONTRAST, tokenNames);
        const body = measured.pairs.filter((p) => p.computable && !p.large && p.ratio !== null);
        const failing = body.filter((p) => p.ratio < 4.5);
        assert(
          'C6b-damaged-body-text',
          'CONTROL: with --vela-text damaged the rendered-DOM audit FAILS on real painted text, ' +
            'so X6 is reading the page rather than the token file',
          failing.length > 0,
          `${failing.length} of ${body.length} body pairs under 4.5:1; worst ` +
            `${Math.min(...body.map((p) => p.ratio)).toFixed(2)}:1`,
        );
        await context.close();
      },
    },
  ];
}
