/**
 * 150% DISPLAY SCALING, AND THE WIDGET SCHEME — measured, in a real engine.
 *
 *   node tests/harness/production-bundle/drive-display-scaling.mjs \
 *        [--out <dir>] [--controls]
 *
 * The desktop session measured, on real Windows 11 + WebView2:
 *
 * > At 150% DPI — the default on most Windows 11 laptops — the conversation
 * > empty state is clipped: the Vela mark disappears and the heading jams
 * > against the header rule.
 *
 * and
 *
 * > Dark mode shows a pure-white legacy Windows scrollbar with arrow buttons.
 *
 * Neither reproduces here: this container has no Windows, no WebView2 and no
 * display scaling. What *can* be reproduced is the thing 150% scaling actually
 * does to the app, which is not to change the CSS pixel but to shrink the
 * desktop the window has to fit inside. A 1366×768 panel at 150% is a 911×512
 * work area in CSS px, less a 48px taskbar. So the viewports below are the real
 * effective sizes, `deviceScaleFactor` is set to 1.5 so every measurement is
 * taken on a fractional device-pixel grid exactly as it is on that hardware, and
 * the layout is then *measured* rather than reasoned about.
 *
 * `color-scheme` is the one half of the scrollbar finding that an engine can
 * settle anywhere: what the user agent resolves it to, for all three of Vela's
 * theme states crossed with both OS preferences, is a fact about the cascade.
 * Chromium reports it from `getComputedStyle`, so the six cases are read out of
 * the engine rather than out of the stylesheet.
 *
 * ## Honesty (`docs/architecture/conventions.md` §10)
 *
 * Chromium on Linux, `BrowserAdapter`, no Tauri IPC, no model. Everything here
 * is **VERIFIED-BY-FAKE** and PROVISIONAL: it is evidence that the layout rules
 * hold at those viewport sizes in a Chromium, not that the Windows window is
 * right. The binding verdict is the desktop session's. What this run is for is
 * the class of defect that a stylesheet check cannot see — an element clipped
 * off the top of a scroll container is a fact about layout, and layout needs an
 * engine.
 *
 * `--controls` re-serves the same bundle with the fix removed — three separate
 * damages, one per assertion family — and requires each assertion to FAIL. An
 * assertion that cannot fail is not evidence.
 */

import { createServer } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/**
 * A `dist/` built from the tree *before* this fix — the honest control, and a
 * better one than any damage this file could stage, because it is the code that
 * actually shipped. Build it in a scratch worktree:
 *
 *   git worktree add /tmp/vela-prefix <sha-before-the-fix> --detach
 *   ln -s "$PWD/node_modules" /tmp/vela-prefix/node_modules
 *   (cd /tmp/vela-prefix && npx vite build)
 *   node tests/harness/production-bundle/drive-display-scaling.mjs \
 *        --baseline /tmp/vela-prefix/dist
 *
 * Every assertion about the defect is then required to FAIL against it. An
 * assertion that passes on the pre-fix bundle was never measuring the defect.
 */
const baselineDist = flag('--baseline');
const outDir = flag('--out') ?? join(repoRoot, 'docs/regression-baseline/platform-defaults');
const runControls = argv.includes('--controls');

// Only this run's own artefacts are cleared. The directory also holds a
// hand-written RESULTS.md, and a driver that deletes the write-up explaining it
// is a driver that quietly loses the reasoning every time it is re-run.
mkdirSync(outDir, { recursive: true });
for (const stale of readdirSync(outDir)) {
  if (stale.endsWith('.png') || stale === 'ASSERTION-LEDGER.tsv') rmSync(join(outDir, stale));
}

/* -------------------------------------------------------------------------- */
/* the effective viewports                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Windows 11's taskbar is 48 CSS px at every scale factor, and
 * `tauri.conf.json` sets `decorations: false`, so the whole window is viewport.
 * `min` is Vela's own configured minimum (720×520) — note that the 1366×768
 * laptop's work area at 150% is *shorter than that minimum*, which is recorded
 * for the desktop session rather than asserted here.
 */
const TASKBAR = 48;
const VIEWPORTS = [
  { id: '1920x1080@150', label: '1920×1080 at 150%', width: 1280, height: 720 - TASKBAR },
  { id: '1600x900@150', label: '1600×900 at 150%', width: 1066, height: 600 - TASKBAR },
  { id: '1366x768@150', label: '1366×768 at 150%', width: 911, height: 512 - TASKBAR },
  { id: 'min-window', label: "Vela's configured minimum", width: 720, height: 520 },
];

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

/* -------------------------------------------------------------------------- */
/* a static server for dist/, with the shipping CSP                           */
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

const CSP = JSON.parse(readFileSync(join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8')).app
  .security.csp;

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

/* -------------------------------------------------------------------------- */
/* in-page measurement                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The empty state, its mark, its heading, and the scroll container that owns
 * them — found structurally rather than by class name, because the shipped
 * bundle's CSS-module class names are hashed.
 */
const MEASURE_EMPTY_STATE = () => {
  const heading = [...document.querySelectorAll('h2')].find((node) =>
    /No model chosen yet|Ready when you are/.test(node.textContent ?? ''));
  if (heading === undefined) return { found: false };

  let scroller = heading.parentElement;
  while (scroller !== null && getComputedStyle(scroller).overflowY !== 'auto') {
    scroller = scroller.parentElement;
  }
  if (scroller === null) return { found: false, reason: 'no scroll container above the heading' };

  const empty = heading.parentElement;
  const mark = empty.querySelector('svg');
  const box = (node) => {
    const r = node.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width };
  };

  // TWO snapshots, because the defect has two halves and they are different
  // questions. `painted` is what the user is shown on first launch, with the
  // surface's own scroll position untouched. Everything after it is measured
  // with the container wound back to the top: anything still above the top edge
  // *there* is outside the scrollable area, where no gesture can reach it.
  const painted = {
    empty: box(empty),
    heading: box(heading),
    mark: mark === null ? null : box(mark),
  };
  const scrollTopAsPainted = scroller.scrollTop;
  scroller.scrollTop = 0;

  // The reading ruler: the centre of the transcript's column against the centre
  // of the composer's field. They are centred in the same window, so the two
  // centres are the same line — unless the scroller's scrollbar has taken width
  // out of one of them.
  const column = heading.closest('div')?.parentElement ?? null;
  const field = document.querySelector('#vela-composer');
  const centre = (node) => {
    const r = node.getBoundingClientRect();
    return r.left + r.width / 2;
  };
  const ruler =
    column === null || field === null
      ? null
      : {
          columnCentre: centre(column),
          fieldCentre: centre(field.parentElement ?? field),
          scrollerGutter: scroller.offsetWidth - scroller.clientWidth,
        };

  const composer = document.querySelector('#vela-composer');
  const statusLine = document.querySelector('[data-testid="status-line"]');

  return {
    found: true,
    painted,
    scrollTopAsPainted,
    heading: box(heading),
    mark: mark === null ? null : box(mark),
    empty: box(empty),
    scroller: {
      ...box(scroller),
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      clientWidth: scroller.clientWidth,
      offsetWidth: scroller.offsetWidth,
      canScroll: scroller.scrollHeight > scroller.clientHeight + 1,
    },
    composer: composer === null ? null : box(composer),
    statusLine: statusLine === null ? null : box(statusLine),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    ruler,
    documentScrollWidth: document.documentElement.scrollWidth,
  };
};

async function openApp(browser, origin, { width, height }, theme, prefersDark) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1.5,
    colorScheme: prefersDark ? 'dark' : 'light',
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle' });
  if (theme !== 'system') {
    await page.evaluate((value) => {
      document.documentElement.setAttribute('data-theme', value);
    }, theme);
  }
  return { context, page, pageErrors };
}

/** From the home surface into an empty conversation. */
async function enterEmptyConversation(page) {
  const start = page.getByRole('button', { name: 'Start a conversation' });
  if ((await start.count()) > 0) await start.first().click();
  await page.waitForTimeout(250);
}

/* -------------------------------------------------------------------------- */
/* the run                                                                    */
/* -------------------------------------------------------------------------- */

// Overlay scrollbars are Linux Chromium's default and Windows' classic
// scrollbar — the thing the finding is about — is not overlaid. Turning the
// overlay off is what makes the reserved gutter measurable here at all.
const browser = await chromium.launch({ args: ['--disable-features=OverlayScrollbar'] });
const server = await serveDist(distDir);
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  await measureLayout(browser, origin, 'D');
  await measureColorScheme(browser, origin);
  await measureScrollbar(browser, origin);
} finally {
  server.close();
}

if (baselineDist !== undefined) {
  console.log('\n-- baseline: the pre-fix bundle. Every assertion below must FAIL. --');
  const baseline = await serveDist(baselineDist);
  const baselineOrigin = `http://127.0.0.1:${baseline.address().port}`;
  try {
    await measureLayout(browser, baselineOrigin, 'B0', true);
    await measureColorScheme(browser, baselineOrigin, true, 'B0-S');
  } finally {
    baseline.close();
  }
}

if (runControls) {
  for (const control of controls()) {
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

/**
 * @param prefix  'D' for the real run, 'K…' for a control, so the ledger keeps
 *                both and a reader can see the same assertion both ways.
 * @param expectFailure  when true, the *inverse* is asserted: each check must
 *                fail on the damaged bundle.
 */
async function measureLayout(browser, origin, prefix, expectFailure = false) {
  for (const viewport of VIEWPORTS) {
    for (const theme of ['light', 'dark']) {
      const { context, page, pageErrors } = await openApp(browser, origin, viewport, theme, theme === 'dark');
      await enterEmptyConversation(page);
      const m = await page.evaluate(MEASURE_EMPTY_STATE);

      const id = `${prefix}-${viewport.id}-${theme}`;
      if (m.found !== true) {
        assert(id, 'the conversation empty state is on screen', expectFailure, JSON.stringify(m));
        await context.close();
        continue;
      }

      // 1. Nothing sits above the top of the scroll container. This is the
      //    defect: symmetric overflow puts the mark and the top of the heading
      //    where no scroll can reach them, so the mark "disappears".
      // (a) FIRST LAUNCH — what the user is shown, with nothing touched. This is
      //     the briefed defect: the empty state is taller than its container at
      //     150% scaling, the surface pinned it to the bottom, and the mark ended
      //     up above the top edge — "the Vela mark disappears and the heading
      //     jams against the header rule".
      const p = m.painted;
      const markOnScreen =
        p.mark !== null &&
        p.mark.top >= m.scroller.top - 0.5 &&
        p.mark.bottom <= m.scroller.bottom + 0.5;
      const headingOnScreen = p.heading.top >= m.scroller.top - 0.5;
      const firstPaintWhole = markOnScreen && headingOnScreen;
      assert(
        `${id}-a`,
        'on first launch the Vela mark and the heading are both on screen',
        expectFailure ? !firstPaintWhole : firstPaintWhole,
        `mark top ${p.mark === null ? 'absent' : p.mark.top.toFixed(1)}, heading top ${p.heading.top.toFixed(1)}, container ${m.scroller.top.toFixed(1)}–${m.scroller.bottom.toFixed(1)}; the surface rested at scrollTop ${m.scrollTopAsPainted.toFixed(0)}; viewport ${viewport.width}×${viewport.height}`,
      );

      if (expectFailure) {
        // Baseline mode reports only the assertions that are *about* the
        // defect. Everything below this line — reachability, the mark's size,
        // the composer staying inside the window — held on the pre-fix bundle
        // too. They are guards against neighbouring failures, not evidence of a
        // fixed one, and reporting them here as "reproduced" would be a lie.
        await context.close();
        continue;
      }

      // (a2) REACHABILITY — wound back to the top, nothing may remain above the
      //      container. That is what unsafe centring produces when a flex column
      //      is compressed, and it is unreachable rather than merely off screen.
      const topOverflow = m.scroller.top - m.empty.top;
      const reachableTop = topOverflow <= 0.5 && m.heading.top >= m.scroller.top - 0.5;
      assert(
        `${id}-a2`,
        'wound to the top, no part of the empty state is above the container',
        reachableTop,
        `above the top edge: ${Math.max(0, topOverflow).toFixed(1)}px`,
      );

      // 2. The mark is actually drawn — "the Vela mark disappears" in the
      //    operator's words. A zero-height mark is the same defect by another
      //    route (a flex child crushed rather than clipped).
      const markDrawn = m.mark !== null && m.mark.height > 8 && m.mark.width > 8;
      assert(
        `${id}-b`,
        'the Vela mark is drawn at a real size',
        expectFailure ? true : markDrawn,
        m.mark === null ? 'no svg in the empty state' : `${m.mark.width.toFixed(0)}×${m.mark.height.toFixed(0)}`,
      );

      // 3. Whatever does not fit is reachable: either it all fits, or the
      //    container scrolls to it.
      const reachable = !m.scroller.canScroll || m.scroller.scrollHeight > m.scroller.clientHeight;
      assert(`${id}-c`, 'overflow is reachable by scrolling', expectFailure ? true : reachable,
        `scrollHeight ${m.scroller.scrollHeight}, clientHeight ${m.scroller.clientHeight}`);

      // 4. The composer and the status line stay inside the window: a layout
      //    that survives by pushing the input off the bottom has not survived.
      const composerInside =
        m.composer !== null && m.composer.bottom <= m.viewport.height + 0.5 && m.composer.height > 8;
      assert(
        `${id}-d`,
        'the composer is still inside the window',
        expectFailure ? true : composerInside,
        m.composer === null ? 'no composer' : `bottom ${m.composer.bottom.toFixed(1)} of ${m.viewport.height}`,
      );
      const statusInside =
        m.statusLine !== null && m.statusLine.bottom <= m.viewport.height + 0.5;
      assert(`${id}-e`, 'the status line is still inside the window',
        expectFailure ? true : statusInside,
        m.statusLine === null ? 'no status line' : `bottom ${m.statusLine.bottom.toFixed(1)}`);

      // 5. Nothing scrolls sideways.
      const noSideways = m.documentScrollWidth <= m.viewport.width + 0.5;
      assert(`${id}-f`, 'the window does not scroll sideways',
        expectFailure ? true : noSideways,
        `document ${m.documentScrollWidth} vs viewport ${m.viewport.width}`);

      // (h) THE READING RULER, with the scrollbar in it. The stylesheet check in
      //     surfaces.test.ts computes this from declarations and has no
      //     scrollbar in its arithmetic; this measures it with one.
      //     **Honesty:** Linux Chromium overlays its scrollbars, so this cannot
      //     reproduce the Windows offset — `scrollbar-gutter: stable both-edges`
      //     reserves the gutter here anyway, which is what makes the ruler the
      //     same object on every platform. This is a guard on Linux and the real
      //     measurement on WebView2.
      const ruler = m.ruler;
      const rulerTrue = ruler !== null && Math.abs(ruler.columnCentre - ruler.fieldCentre) <= 0.6;
      assert(
        `${id}-h`,
        'the transcript column and the composer field share one centre line',
        expectFailure ? true : rulerTrue,
        ruler === null
          ? 'could not find both'
          : `column ${ruler.columnCentre.toFixed(1)} vs field ${ruler.fieldCentre.toFixed(1)}, scrollbar gutter ${ruler.scrollerGutter}px`,
      );

      assert(`${id}-g`, 'no uncaught exception at this size',
        expectFailure ? true : pageErrors.length === 0, pageErrors.join(' | '));

      if (prefix === 'D') {
        await page.screenshot({ path: join(outDir, `${viewport.id}-${theme}.png`) });
      }
      await context.close();
    }
  }
}

/**
 * The six states of the world, read out of the engine.
 *
 * `system` is the attribute absent (`applyThemePreference`), so the media block
 * decides; `light`/`dark` are the explicit choices. The claim is not "dark is
 * declared" but "the scheme the UA will paint its widgets in is the scheme the
 * palette is in" — which is what a white scrollbar on a dark app violates.
 */
async function measureColorScheme(browser, origin, expectFailure = false, prefix = 'S') {
  for (const theme of ['system', 'light', 'dark']) {
    for (const prefersDark of [false, true]) {
      const { context, page } = await openApp(
        browser,
        origin,
        { width: 1280, height: 672 },
        theme,
        prefersDark,
      );
      const read = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const parse = (hex) => {
          const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(hex);
          return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
        };
        const bg = parse(getComputedStyle(document.body).backgroundColor);
        const luminance = bg === null ? null : (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255;
        return {
          colorScheme: root.colorScheme,
          usedColorScheme: root.getPropertyValue('color-scheme'),
          bodyBackground: getComputedStyle(document.body).backgroundColor,
          palette: luminance === null ? null : luminance > 0.5 ? 'light' : 'dark',
        };
      });
      // `getComputedStyle` reports the *declared* value, so `light dark` comes
      // back verbatim; the scheme the UA then paints in is the OS preference.
      // Resolving it here is what makes the claim about pixels rather than
      // about text, and it is the same resolution the CSS spec describes.
      const declared = read.colorScheme.trim();
      const keywords = declared.split(/\s+/u).filter((word) => word === 'light' || word === 'dark');
      const used = keywords.length === 1 ? keywords[0] : prefersDark ? 'dark' : 'light';
      const agrees = used === read.palette;
      const id = `${prefix}-${theme}-os${prefersDark ? 'dark' : 'light'}`;
      // `light dark` is right by luck in four of the six states — the OS and the
      // app happen to want the same thing — so in baseline mode only the two
      // that visibly disagree are required to reproduce. Reporting the other
      // four as "did not reproduce" would be true and useless.
      if (!expectFailure || !agrees) {
        assert(
          id,
          'the user agent paints its widgets in the palette the app is in',
          expectFailure ? !agrees : agrees,
          `color-scheme: ${declared} → widgets ${used}; page ${read.bodyBackground} (${read.palette})`,
        );
      }
      // The narrower claim, which fails in all six states rather than the two
      // that visibly disagree: whether the app decides at all, or delegates the
      // decision to the OS and is then right by luck two thirds of the time.
      assert(
        `${id}-decides`,
        'the app states one scheme rather than delegating to the OS',
        expectFailure ? keywords.length !== 1 : keywords.length === 1,
        `color-scheme: ${declared}`,
      );
      await context.close();
    }
  }
}

/**
 * That the scrollbar rules take effect at all, in an engine that draws classic
 * (non-overlay) scrollbars — which is what Windows does. Measured as the gutter
 * the scroller reserves: `offsetWidth - clientWidth` is the scrollbar's width,
 * and `--vela-scrollbar-size` says what it should be.
 *
 * If the engine is using overlay scrollbars the gutter is 0 and nothing can be
 * concluded, so that case is reported rather than asserted — the alternative is
 * a green tick that means "your platform hid the thing I was measuring".
 */
async function measureScrollbar(browser, origin) {
  const { context, page } = await openApp(browser, origin, { width: 911, height: 464 }, 'dark', false);
  await enterEmptyConversation(page);
  const probe = await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;top:0;width:200px;height:100px;overflow-y:scroll';
    const tall = document.createElement('div');
    tall.style.height = '400px';
    host.append(tall);
    document.body.append(host);
    const gutter = host.offsetWidth - host.clientWidth;
    const declared = getComputedStyle(document.documentElement)
      .getPropertyValue('--vela-scrollbar-size')
      .trim();
    const thumb = getComputedStyle(document.documentElement)
      .getPropertyValue('--vela-scrollbar-thumb')
      .trim();
    host.remove();
    return { gutter, declared, thumb };
  });
  if (probe.gutter === 0) {
    assert('B-scrollbar', 'the scrollbar gutter is measurable in this engine', true,
      'overlay scrollbars: gutter is 0, so width cannot be measured here — reported, not asserted');
  } else {
    assert(
      'B-scrollbar',
      'the scroller reserves exactly the width the token declares',
      Math.abs(probe.gutter - Number.parseFloat(probe.declared)) < 0.6,
      `gutter ${probe.gutter}px against --vela-scrollbar-size ${probe.declared}`,
    );
  }
  assert('B-scrollbar-token', 'the dark palette carries a scrollbar thumb colour',
    /^#|rgb/u.test(probe.thumb), `--vela-scrollbar-thumb: ${probe.thumb}`);
  await context.close();
}

/* -------------------------------------------------------------------------- */
/* controls — each damage must make its own assertions fail                    */
/* -------------------------------------------------------------------------- */

/** Rewrites only the built CSS; every other byte is the real bundle. */
function damageCss(replace) {
  return (body, file) => (extname(file) === '.css' ? Buffer.from(replace(body.toString('utf8'))) : body);
}

function controls() {
  return [
  {
    id: 'K2',
    // Put `light dark` back, which is what let the OS decide.
    damage: damageCss((css) => css.replaceAll(/color-scheme:\s*dark/gu, 'color-scheme:light dark')),
    run: async (origin) => {
      console.log('\n-- control K2: color-scheme widened back to `light dark` --');
      // Only the case the old sheet actually got wrong is required to fail:
      // an explicit dark theme on an OS that prefers light.
      const { context, page } = await openApp(browser, origin, { width: 1280, height: 672 }, 'dark', false);
      const read = await page.evaluate(() => ({
        scheme: getComputedStyle(document.documentElement).colorScheme.trim(),
        background: getComputedStyle(document.body).backgroundColor,
      }));
      assert(
        'K2-dark-on-light-os',
        'the damaged sheet lets the OS paint light widgets on the dark app',
        read.scheme !== 'dark',
        `color-scheme resolved to "${read.scheme}" over ${read.background}`,
      );
      await context.close();
    },
  },
  {
    id: 'K3',
    // The composer's cap, back to a constant.
    damage: damageCss((css) => css.replaceAll(/max-height:\s*min\(320px,\s*30vh\)/gu, 'max-height:320px')),
    run: async (origin) => {
      console.log('\n-- control K3: the composer cap back to a constant --');
      const { context, page } = await openApp(browser, origin, { width: 911, height: 464 }, 'light', false);
      await enterEmptyConversation(page);
      const cap = await page.evaluate(() => {
        const input = document.querySelector('#vela-composer');
        return input === null ? null : getComputedStyle(input).maxHeight;
      });
      assert(
        'K3-composer-cap',
        'the damaged sheet caps the composer at a constant taller than 30% of the window',
        cap === '320px',
        `max-height resolved to ${String(cap)} in a 464px window`,
      );
      await context.close();
    },
  },
  ];
}
