/**
 * ASSERTION CONTROLS for the GATE M Part 1 (Phase C) UI matrix.
 *
 * Every assertion in `checks.mjs` is applied here to a case where it must come
 * out the other way. An assertion that cannot fail is worthless: it does not
 * matter how many green lines a gate run prints if none of them was ever at
 * risk. Each control below imports the *same function* the matrix run used —
 * not a copy, not a re-implementation — and states in advance which verdict it
 * expects.
 *
 *   node tests/harness/ui-bridge/controls.mjs
 *
 * A control that produces the verdict it was supposed to produce is `EXPECTED`.
 * Anything else is `UNEXPECTED` and means the assertion, not the app, needs
 * looking at.
 */

import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as check from './checks.mjs';

const playwright = await import(process.env.VELA_PLAYWRIGHT ?? 'playwright');
const { chromium } = playwright.chromium === undefined ? playwright.default : playwright;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PAGE = 'http://127.0.0.1:1420/tests/harness/ui-bridge/index.html';
const outDir = join(repoRoot, 'docs/regression-baseline/phase-c-matrix');
mkdirSync(outDir, { recursive: true });

const results = [];

function control(id, description, expected, observed, detail) {
  const verdict = observed ? 'PASS' : 'FAIL';
  const asExpected = verdict === expected;
  results.push({ id, description, expected, verdict, asExpected, detail });
  process.stdout.write(
    `${asExpected ? 'EXPECTED  ' : 'UNEXPECTED'}  ${id}  wanted ${expected}, got ${verdict}  — ${description}\n`,
  );
  if (!asExpected) process.stdout.write(`            ${detail}\n`);
}

async function startRelay(profile, port, { chunkDelay = 0, register = true } = {}) {
  const args = [
    join(repoRoot, 'tests/harness/ui-bridge/server.mjs'),
    '--profile',
    profile,
    '--port',
    String(port),
    '--chunk-delay',
    String(chunkDelay),
  ];
  if (!register) args.push('--no-register');
  const child = spawn('node', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start')), 60_000);
    createInterface({ input: child.stdout }).on('line', (text) => {
      if (text.includes('ui-bridge listening')) {
        clearTimeout(timer);
        resolve(text);
      }
    });
  });
  return { child, base: `http://127.0.0.1:${String(port)}`, endpoint: /endpoint (\S+)\)/u.exec(line)?.[1] ?? '' };
}

async function invoke(relay, command, payload) {
  const response = await fetch(`${relay.base}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, payload }),
  });
  return response.json();
}

async function session(browser, relay, { probe = true } = {}) {
  const seen = { console: [], requests: [] };
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (message) => seen.console.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', (error) => seen.console.push({ type: 'pageerror', text: error.message }));
  page.on('request', (request) => seen.requests.push(request.url()));
  await page.goto(`${PAGE}?relay=${relay.base}`);
  await page.waitForSelector('[data-testid="status-line"]');
  await page.getByRole('button', { name: 'Start a conversation' }).click();
  await page.waitForSelector('#vela-composer');
  if (probe) {
    await page.getByRole('button', { name: /limit|Capabilities unknown/u }).first().click();
    await page.getByRole('button', { name: /^(Check|Check again)$/u }).click();
    await page.waitForFunction(() => !document.body.innerText.includes('Asking the endpoint…'));
    await page.getByRole('button', { name: /limit|Capabilities unknown/u }).first().click();
  }
  return { page, seen };
}

async function send(page, text) {
  await page.fill('#vela-composer', text);
  await page.getByRole('button', { name: 'Send' }).click();
  try {
    await waitForSettled(page);
  } catch (error) {
    // A control that hangs must say what it was looking at, or the next reader
    // has to reconstruct it from nothing.
    process.stderr.write(`send("${text}") never settled:\n${await page.locator('body').innerText()}\n`);
    throw error;
  }
  await page.waitForTimeout(120);
}

async function waitForSettled(page) {
  await page.waitForFunction(
    () => {
      const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
      const stop = [...document.querySelectorAll('button')].some((b) => b.textContent === 'Stop');
      return turn !== undefined && !stop && !turn.innerText.includes('Waiting for the first token');
    },
    undefined,
    { timeout: 30_000, polling: 50 },
  );
  await page.waitForTimeout(120);
}

const browser = await chromium.launch();
const frontier = await startRelay('frontier', 8441);
const hostile = await startRelay('hostile', 8442);
const slowHostile = await startRelay('hostile', 8443, { chunkDelay: 120 });

try {
  /* ---- the vision assertion, applied both ways round --------------------- */
  const f = await session(browser, frontier);
  const h = await session(browser, hostile);

  const frontierImages = await check.imageAffordances(f.page);
  const hostileImages = await check.imageAffordances(h.page);

  control(
    'K1',
    'the "no image affordance" assertion, applied to the one profile that HAS vision',
    'FAIL',
    check.visionAffordanceMatchesCapability(frontierImages, false).pass,
    check.visionAffordanceMatchesCapability(frontierImages, false).detail,
  );
  control(
    'K2',
    'the "offers an image affordance" assertion, applied to a profile with no vision',
    'FAIL',
    check.visionAffordanceMatchesCapability(hostileImages, true).pass,
    check.visionAffordanceMatchesCapability(hostileImages, true).detail,
  );
  control(
    'K3',
    'the same reader, on the profile it does hold for (the check is not stuck on one answer)',
    'PASS',
    check.visionAffordanceMatchesCapability(hostileImages, false).pass,
    check.visionAffordanceMatchesCapability(hostileImages, false).detail,
  );

  /* ---- the context-window assertion -------------------------------------- */
  const hostileMeter = await check.contextMeterText(h.page);
  control(
    'K4',
    'the context-window assertion, told to expect another endpoint\'s window',
    'FAIL',
    check.contextWindowIsTheEndpoints(hostileMeter, check.EXPECTED.frontier.windowTexts, []).pass,
    check.contextWindowIsTheEndpoints(hostileMeter, check.EXPECTED.frontier.windowTexts, []).detail,
  );
  control(
    'K5',
    'the foreign-window half: a meter carrying the right number AND a wrong one',
    'FAIL',
    check.contextWindowIsTheEndpoints(`${hostileMeter} 200,000`, check.EXPECTED.hostile.windowTexts, ['200,000']).pass,
    'synthesised text: the real meter string with another profile\'s figure appended',
  );

  /* ---- the overflow warning ---------------------------------------------- */
  await h.page.setInputFiles('input[type="file"]', {
    name: 'tiny.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('four bytes of nothing much'),
  });
  await h.page.waitForTimeout(300);
  const tinyMeter = await check.contextMeterText(h.page);
  control(
    'K6',
    'the overflow warning, with a staged file that fits comfortably',
    'FAIL',
    check.contextOverflowWarns(tinyMeter).pass,
    check.contextOverflowWarns(tinyMeter).detail,
  );
  const removeTiny = h.page.getByRole('button', { name: /Remove/u }).first();
  if ((await removeTiny.count()) > 0) await removeTiny.click();

  /* ---- the unprobed floor ------------------------------------------------ */
  const chipAfterProbe = await check.limitsChipText(h.page);
  control(
    'K7',
    'the "unprobed model claims nothing" assertion, applied after a probe',
    'FAIL',
    check.unprobedOffersNothing(chipAfterProbe, 0).pass,
    check.unprobedOffersNothing(chipAfterProbe, 0).detail,
  );

  /* ---- reasoning markup, on a real DOM that really contains it ------------ */
  await send(h.page, 'Say something.');
  const hostileTurn = await check.lastAssistantTurn(h.page);
  control(
    'K8',
    'the markup check on the turn as rendered (it passed in the matrix run)',
    'PASS',
    check.noReasoningMarkup(await check.transcriptText(h.page)).pass,
    'baseline for K9',
  );
  // Put the tag on screen the way a broken splitter would: as literal text
  // inside the answer paragraph, in the live DOM, then read it back through the
  // same reader the matrix used.
  await h.page.evaluate(() => {
    const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
    const paragraph = turn?.querySelector('p');
    if (paragraph !== null && paragraph !== undefined) paragraph.append('<think>leaked</think>');
  });
  const leakedText = await check.transcriptText(h.page);
  control(
    'K9',
    'the same check, once reasoning markup is genuinely on screen',
    'FAIL',
    check.noReasoningMarkup(leakedText).pass,
    check.noReasoningMarkup(leakedText).detail,
  );
  await h.page.reload();

  /* ---- tool calls: each assertion against the wrong profile --------------- */
  await f.page.fill('#vela-composer', '#tools weather please');
  await send(f.page, '#tools weather please');
  const frontierTools = await check.lastAssistantTurn(f.page);
  control(
    'K10',
    'the malformed-call assertion, applied to a well-formed native call',
    'FAIL',
    check.malformedToolCallVisible(frontierTools).pass,
    check.malformedToolCallVisible(frontierTools).detail,
  );
  control(
    'K11',
    'the emulation-disclosure assertion, applied to a natively-supported call',
    'FAIL',
    check.emulationDisclosed(frontierTools).pass,
    check.emulationDisclosed(frontierTools).detail,
  );

  /* ---- usage ------------------------------------------------------------- */
  control(
    'K12',
    'the usage assertion, told the endpoint reports nothing when it does',
    'FAIL',
    check.usageOnlyWhenReported(frontierTools.whole, false).pass,
    check.usageOnlyWhenReported(frontierTools.whole, false).detail,
  );

  /* ---- error state ------------------------------------------------------- */
  control(
    'K13',
    'the error-state assertion, applied to a turn that succeeded',
    'FAIL',
    check.errorStateVisible(frontierTools).pass,
    check.errorStateVisible(frontierTools).detail,
  );

  /* ---- no credential ----------------------------------------------------- */
  // Configured through the real settings command, so `credentialCheck` is the
  // host's own verdict rather than a hand-made object.
  const needsKey = await invoke(frontier, 'settings_put_provider', {
    id: 'needs-a-key',
    displayName: 'Remote endpoint that requires a key',
    kind: 'remoteApi',
    baseUrl: 'https://example.invalid/v1',
    authRequirement: 'required',
    auth: { type: 'bearerToken' },
  });
  control(
    'K14',
    'the no-credential assertion, applied to an endpoint that genuinely requires one',
    'FAIL',
    check.noCredentialIsClean(needsKey.ok, '').pass,
    check.noCredentialIsClean(needsKey.ok, '').detail,
  );
  await invoke(frontier, 'settings_delete_provider', { providerId: 'needs-a-key' });

  /* ---- console ----------------------------------------------------------- */
  const before = check.consoleIsClean(f.seen.console);
  control('K15', 'the console assertion on the run as it stood (it was clean)', 'PASS', before.pass, before.detail);
  await f.page.evaluate(() => {
    console.error('control: a deliberate console error');
  });
  await f.page.waitForTimeout(200);
  const after = check.consoleIsClean(f.seen.console);
  control('K16', 'the same assertion, after one deliberate console.error', 'FAIL', after.pass, after.detail);

  /* ---- browser-side egress ------------------------------------------------ */
  // The page really does try to reach the model endpoint. Two things are being
  // shown at once: the assertion notices, and the browser is refused — the mock
  // sends no CORS headers, which is why all provider HTTP has to live in the
  // core in the first place.
  const corsOutcome = await f.page.evaluate(async (endpoint) => {
    try {
      const response = await fetch(`${endpoint}/v1/models`);
      return `unexpectedly reached the endpoint: ${String(response.status)}`;
    } catch (error) {
      return `refused: ${String(error)}`;
    }
  }, frontier.endpoint);
  await f.page.waitForTimeout(300);
  const egress = check.noBrowserSideModelRequest(f.seen.requests, frontier.endpoint);
  control(
    'K17',
    `the egress assertion, after the page really did request the endpoint (${corsOutcome})`,
    'FAIL',
    egress.pass,
    egress.detail,
  );

  /* ---- incremental rendering --------------------------------------------- */
  // The matrix measures this against a 60 ms-per-frame endpoint. If the same
  // measurement passed against an endpoint with no delay, it would be measuring
  // nothing: the whole turn lands inside one animation frame.
  const fastFrames = await (async () => {
    const { page } = await session(browser, frontier, { probe: false });
    await page.evaluate(() => {
      window.__frames = [];
      new MutationObserver(() => {
        const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
        if (turn === undefined) return;
        const whole = turn.innerText.trim().length;
        const last = window.__frames.at(-1);
        if (last === undefined || last.whole !== whole) window.__frames.push({ t: performance.now(), whole });
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await send(page, 'Answer immediately.');
    const frames = await page.evaluate(() => window.__frames);
    await page.close();
    return frames;
  })();
  control(
    'K18',
    'the incremental-paint assertion, against an endpoint with no inter-frame delay',
    'FAIL',
    check.paintedIncrementally(fastFrames).pass,
    check.paintedIncrementally(fastFrames).detail,
  );

  const slowFrames = await (async () => {
    const { page } = await session(browser, slowHostile, { probe: false });
    await page.evaluate(() => {
      window.__frames = [];
      new MutationObserver(() => {
        const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
        if (turn === undefined) return;
        const whole = turn.innerText.trim().length;
        const last = window.__frames.at(-1);
        if (last === undefined || last.whole !== whole) window.__frames.push({ t: performance.now(), whole });
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await send(page, 'Answer slowly.');
    const frames = await page.evaluate(() => window.__frames);
    await page.close();
    return frames;
  })();
  control(
    'K19',
    'and against the 120 ms endpoint, where it must hold',
    'PASS',
    check.paintedIncrementally(slowFrames).pass,
    check.paintedIncrementally(slowFrames).detail,
  );

  /* ---- the settled-turn assertion, applied mid-flight -------------------- */
  const midFlight = await (async () => {
    const { page } = await session(browser, slowHostile, { probe: false });
    await page.fill('#vela-composer', 'Take your time.');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.waitForTimeout(80);
    const turn = await check.lastAssistantTurn(page);
    await page.close();
    return turn;
  })();
  control(
    'K20',
    'the "turn is settled" assertion, applied while the turn is still in flight',
    'FAIL',
    check.turnSettled(midFlight).pass,
    check.turnSettled(midFlight).detail,
  );

  /* ---- the reading surface ------------------------------------------------ *
   * The three new assertions, each against a DOM that must break it. The
   * breakage is applied to the *live page* rather than to a hand-made object,
   * so what is being tested is the same reader running over the same engine —
   * and each one is restored by a reload before the next.                     */
  const r = await session(browser, frontier);
  await send(r.page, '#markdown which model should I run?');
  const readingBefore = await check.readingSurface(r.page);
  control(
    'K22',
    'the hierarchy assertion on the surface as it ships (it held in the matrix run)',
    'PASS',
    check.headingHierarchyIsVisible(readingBefore).pass,
    check.headingHierarchyIsVisible(readingBefore).detail,
  );

  // The defect exactly as the critic found it: every heading level at one size.
  await r.page.evaluate(() => {
    const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
    for (const heading of turn?.querySelectorAll('[data-level]') ?? []) {
      heading.style.fontSize = getComputedStyle(document.body).fontSize;
    }
  });
  const flattened = await check.readingSurface(r.page);
  control(
    'K23',
    'the same assertion once every heading level is set at one size — the defect as found',
    'FAIL',
    check.headingHierarchyIsVisible(flattened).pass,
    check.headingHierarchyIsVisible(flattened).detail,
  );

  // …and the other direction: a scale that runs backwards is not a scale.
  await r.page.evaluate(() => {
    const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
    for (const heading of turn?.querySelectorAll('[data-level]') ?? []) {
      heading.style.fontSize = `${String(8 + Number(heading.getAttribute('data-level')) * 4)}px`;
    }
  });
  const inverted = await check.readingSurface(r.page);
  control(
    'K24',
    'the same assertion against a scale that grows as the level deepens',
    'FAIL',
    check.headingHierarchyIsVisible(inverted).pass,
    check.headingHierarchyIsVisible(inverted).detail,
  );

  // A reload returns the app to the home surface — a conversation selection is
  // process state, not a URL — so the composer has to be reopened the way a
  // user would. K25/K26 were added in `81b1b12` and had never actually run:
  // the reload landed on the home surface and the wait for `#vela-composer`
  // timed out, taking K25 and K26 with it. Recorded rather than quietly fixed,
  // because it is one more instance of this wave's own defect class — something
  // written and never executed.
  await r.page.reload();
  await r.page.waitForSelector('[data-testid="status-line"]');
  await r.page.getByRole('button', { name: 'Start a conversation' }).click();
  await r.page.waitForSelector('#vela-composer');
  await send(r.page, '#markdown which model should I run?');
  const reflowBefore = await check.readingSurface(r.page);
  control(
    'K25',
    'the reflow assertion on the surface as it ships',
    'PASS',
    check.proseReflows(reflowBefore).pass,
    check.proseReflows(reflowBefore).detail,
  );

  // The pre-fix rendering, reproduced: `white-space: pre-wrap` on a paragraph
  // whose text still holds the model's own line endings.
  await r.page.evaluate(() => {
    const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
    for (const paragraph of turn?.querySelectorAll('p') ?? []) {
      paragraph.style.whiteSpace = 'pre-wrap';
    }
  });
  const preWrapped = await check.readingSurface(r.page);
  control(
    'K26',
    'the same assertion once paragraphs preserve the source line endings again',
    'FAIL',
    check.proseReflows(preWrapped).pass,
    check.proseReflows(preWrapped).detail,
  );

  control(
    'K27',
    'the sideways-scroll assertion on the surface as it ships',
    'PASS',
    check.readingSurfaceFitsItsColumn(reflowBefore).pass,
    check.readingSurfaceFitsItsColumn(reflowBefore).detail,
  );
  // A table that is not in its own scroll container is the commonest way this
  // breaks, so the control widens the content the same way one would.
  await r.page.evaluate(() => {
    const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
    const prose = turn?.querySelector('[data-level]')?.parentElement;
    const wide = document.createElement('div');
    wide.style.width = '4000px';
    wide.textContent = 'control: content wider than its column';
    prose?.append(wide);
  });
  const overflowing = await check.readingSurface(r.page);
  control(
    'K28',
    'the same assertion with content four thousand pixels wide in the column',
    'FAIL',
    check.readingSurfaceFitsItsColumn(overflowing).pass,
    check.readingSurfaceFitsItsColumn(overflowing).detail,
  );
  await r.page.close();

  /* ---- the reading surface, second pass ---------------------------------- *
   * Eight more assertions, each against the DOM the CONV-1 visual FAIL
   * described. The breakages are not inventions: every one of them reproduces
   * the state the operator actually saw on a real machine, applied to the live
   * page so the reader under test is the reader that ran in the matrix.       */
  const s = await session(browser, frontier);

  /* the type scale below h3, and the emphasis that outranked it */
  await send(s.page, '#headings show me every heading level');
  const scaleBefore = await check.readingSurface(s.page);
  control(
    'K29',
    'structure-outranks-emphasis on the surface as it ships',
    'PASS',
    check.headingsOutrankEmphasis(scaleBefore).pass,
    check.headingsOutrankEmphasis(scaleBefore).detail,
  );

  // The defect exactly as found: `<strong>` back on the user agent's 700 while
  // every heading sits at 600.
  await s.page.evaluate(() => {
    const prose = document.querySelector('[data-scale="answer"]');
    for (const run of prose?.querySelectorAll('strong') ?? []) run.style.fontWeight = '700';
    for (const heading of prose?.querySelectorAll('[data-level]') ?? []) heading.style.fontWeight = '600';
  });
  const outweighed = await check.readingSurface(s.page);
  control(
    'K30',
    'the same assertion with a bold run at 700 over headings at 600 — the inversion as found',
    'FAIL',
    check.headingsOutrankEmphasis(outweighed).pass,
    check.headingsOutrankEmphasis(outweighed).detail,
  );

  // The other half: h5 and h6 set smaller than the prose they head.
  await s.page.evaluate(() => {
    const prose = document.querySelector('[data-scale="answer"]');
    for (const run of prose?.querySelectorAll('strong') ?? []) run.style.fontWeight = '';
    for (const heading of prose?.querySelectorAll('[data-level="5"], [data-level="6"]') ?? []) {
      heading.style.fontSize = '13px';
      heading.style.fontWeight = '';
    }
  });
  const undersized = await check.readingSurface(s.page);
  control(
    'K31',
    'the same assertion with h5 and h6 set smaller than body text — the other half as found',
    'FAIL',
    check.headingsOutrankEmphasis(undersized).pass,
    check.headingsOutrankEmphasis(undersized).detail,
  );

  /* the reading measure */
  control(
    'K32',
    'the characters-per-line assertion on the column as it ships',
    'PASS',
    check.readingMeasureIsComfortable(scaleBefore).pass,
    check.readingMeasureIsComfortable(scaleBefore).detail,
  );
  // 46rem, restored: the column as the operator measured it, where the same
  // document sets ~95–105 characters per line on Windows and ~88 here.
  await s.page.evaluate(() => {
    const prose = document.querySelector('[data-scale="answer"]');
    if (prose !== null) prose.style.width = '688px';
  });
  await s.page.waitForTimeout(100);
  const tooWide = await check.readingSurface(s.page);
  control(
    'K33',
    'the same assertion with the column back at the 688px it shipped with',
    'FAIL',
    check.readingMeasureIsComfortable(tooWide).pass,
    check.readingMeasureIsComfortable(tooWide).detail,
  );

  /* the thinking block */
  await s.page.reload();
  await s.page.waitForSelector('[data-testid="status-line"]');
  await s.page.getByRole('button', { name: 'Start a conversation' }).click();
  await s.page.waitForSelector('#vela-composer');
  await send(s.page, '#thinkmd which local model should I run?');

  const settled = await check.lastAssistantTurn(s.page);
  control(
    'K34',
    'the settled-thought-is-closed assertion on the block as it ships',
    'PASS',
    check.settledThoughtIsClosed(settled).pass,
    check.settledThoughtIsClosed(settled).detail,
  );

  const thinkToggle = s.page.locator('article[data-role="assistant"]').last().locator('section h3 button').first();
  await thinkToggle.click();
  await s.page.waitForTimeout(150);
  const opened = await check.lastAssistantTurn(s.page);
  control(
    'K35',
    'the same assertion against a settled block that is open — the pre-fix default',
    'FAIL',
    check.settledThoughtIsClosed(opened).pass,
    check.settledThoughtIsClosed(opened).detail,
  );

  const asideBefore = await check.reasoningSurface(s.page);
  control(
    'K36',
    'the thinking block renders markdown, on the block as it ships',
    'PASS',
    check.reasoningRendersAsMarkdown(asideBefore).pass,
    check.reasoningRendersAsMarkdown(asideBefore).detail,
  );

  // `<p>{text}</p>` with `white-space: pre-wrap` — the shipped renderer, put
  // back byte for byte, with the same reasoning text flowing into it.
  await s.page.evaluate(() => {
    const body = document.querySelector('section [id$="-reasoning"]');
    const source = [
      '**Deconstruct the requirements:**',
      '',
      '*   The user wants a *model-agnostic* client, so the answer',
      '    cannot name a vendor.',
      '*   They mentioned `llama-server`, which means the endpoint is',
      '    OpenAI-compatible.',
    ].join('\n');
    if (body === null) return;
    body.replaceChildren();
    const paragraph = document.createElement('p');
    paragraph.setAttribute('data-scale', 'aside');
    paragraph.style.whiteSpace = 'pre-wrap';
    paragraph.textContent = source;
    body.append(paragraph);
  });
  const printedRaw = await check.reasoningSurface(s.page);
  control(
    'K37',
    'the same assertion against `<p>{text}</p>` with pre-wrap — the defect as it shipped',
    'FAIL',
    check.reasoningRendersAsMarkdown(printedRaw).pass,
    check.reasoningRendersAsMarkdown(printedRaw).detail,
  );

  control(
    'K38',
    'the aside-stays-subordinate assertion on the block as it ships',
    'PASS',
    check.asideStaysSubordinate(asideBefore).pass,
    check.asideStaysSubordinate(asideBefore).detail,
  );
  // The question routing reasoning through the answer's renderer creates: an
  // `h1` the model wrote inside its own reasoning, at the answer's display size.
  await s.page.evaluate(() => {
    const body = document.querySelector('section [id$="-reasoning"]');
    const prose = body?.querySelector('[data-scale]') ?? body?.firstElementChild ?? null;
    if (prose === null) return;
    prose.setAttribute('data-scale', 'aside');
    const heading = document.createElement('h2');
    heading.setAttribute('data-level', '1');
    heading.style.fontSize = '24px';
    heading.textContent = 'control: an answer-sized heading inside the aside';
    prose.append(heading);
  });
  const loudAside = await check.reasoningSurface(s.page);
  control(
    'K39',
    'the same assertion with a 24px heading inside the aside',
    'FAIL',
    check.asideStaysSubordinate(loudAside).pass,
    check.asideStaysSubordinate(loudAside).detail,
  );

  /* the vertical ruler, the sidebar and the scroll edge */
  await s.page.reload();
  await s.page.waitForSelector('[data-testid="status-line"]');
  await s.page.getByRole('button', { name: 'Start a conversation' }).click();
  await s.page.waitForSelector('#vela-composer');
  await send(s.page, '#markdown which model should I run?');

  const rulerShipped = await check.layoutRuler(s.page);
  control(
    'K40',
    'the one-ruler assertion on the layout as it ships',
    'PASS',
    check.oneVerticalRuler(rulerShipped).pass,
    check.oneVerticalRuler(rulerShipped).detail,
  );
  // 736px of composer box under 688px of text: the two rulers, restored.
  await s.page.evaluate(() => {
    const field = document.querySelector('#vela-composer')?.closest('div');
    if (field !== null && field !== undefined) field.style.maxWidth = '736px';
  });
  await s.page.waitForTimeout(100);
  const twoRulers = await check.layoutRuler(s.page);
  control(
    'K41',
    'the same assertion with the composer back on its own ruler',
    'FAIL',
    check.oneVerticalRuler(twoRulers).pass,
    check.oneVerticalRuler(twoRulers).detail,
  );

  const separator = s.page.getByRole('separator', { name: /Resize sidebar/u });
  await separator.focus();
  for (let press = 0; press < 20; press += 1) await separator.press('ArrowRight');
  await s.page.waitForTimeout(200);
  const wideWindow = await check.layoutRuler(s.page);
  await s.page.setViewportSize({ width: 880, height: 800 });
  await s.page.waitForTimeout(250);
  const narrowWindow = await check.layoutRuler(s.page);
  control(
    'K42',
    'the sidebar-gives-way assertion on the layout as it ships',
    'PASS',
    check.sidebarTracksTheWindow(wideWindow, narrowWindow).pass,
    check.sidebarTracksTheWindow(wideWindow, narrowWindow).detail,
  );
  // The constant it used to be, pinned inline so no rule can respond.
  await s.page.evaluate(() => {
    const sidebar = document.querySelector('nav[aria-label="Primary"]');
    if (sidebar !== null) sidebar.style.width = '480px';
  });
  await s.page.waitForTimeout(150);
  const pinnedNarrow = await check.layoutRuler(s.page);
  control(
    'K43',
    'the same assertion with the sidebar pinned at 480px — the constant as it shipped',
    'FAIL',
    check.sidebarTracksTheWindow(wideWindow, pinnedNarrow).pass,
    check.sidebarTracksTheWindow(wideWindow, pinnedNarrow).detail,
  );
  await s.page.evaluate(() => {
    const sidebar = document.querySelector('nav[aria-label="Primary"]');
    if (sidebar !== null) sidebar.style.width = '';
  });
  await s.page.setViewportSize({ width: 1440, height: 900 });
  await s.page.waitForTimeout(250);

  const maskShipped = await check.layoutRuler(s.page);
  control(
    'K44',
    'the scroll-edge assertion on the transcript as it ships',
    'PASS',
    check.scrollEdgeIsMasked(maskShipped).pass,
    check.scrollEdgeIsMasked(maskShipped).detail,
  );
  // The guillotine: content hidden above the edge and no fade towards it.
  await s.page.evaluate(() => {
    const scroller = document.querySelector('section[aria-label="Conversation"] > div');
    if (scroller !== null) scroller.style.maskImage = 'none';
  });
  await s.page.waitForTimeout(100);
  const guillotined = await check.layoutRuler(s.page);
  control(
    'K45',
    'the same assertion with the mask removed while content is still hidden above the edge',
    'FAIL',
    check.scrollEdgeIsMasked(guillotined).pass,
    check.scrollEdgeIsMasked(guillotined).detail,
  );
  await s.page.close();

  /* ---- the finding, demonstrated rather than argued ---------------------- */
  // With `--no-register` the bridge behaves exactly as the shipping host does:
  // a provider row in settings, and nothing in the ProviderRegistry.
  const unregistered = await startRelay('frontier', 8444, { register: false });
  const settings = await invoke(unregistered, 'settings_get', {});
  const turn = await invoke(unregistered, 'chat_send', {
    turnId: 'control-turn',
    providerId: 'matrix',
    modelId: 'mock-frontier',
    messages: [{ role: 'user', text: 'hello' }],
  });
  control(
    'K21',
    'FINDING 1 reproduced: settings has the endpoint, and chat_send still cannot find it',
    'PASS',
    settings.ok.providers.length === 1 && turn.err?.code === 'NOT_FOUND',
    `providers=${String(settings.ok.providers.length)} chat_send=${JSON.stringify(turn.err ?? turn.ok)}`,
  );
  unregistered.child.kill();

  /* ---- C6b, controlled against evidence this repo actually committed ----- */
  //
  // `nothingWasDroppedBeforeTheReader` exists because for four gate runs the
  // recorded transcript began mid-word and every assertion passed. The control
  // for it is therefore not a synthetic object: it is those very artifacts,
  // read out of git, put through the same function the matrix run uses. If the
  // assertion cannot fail on the evidence that motivated it, it is worthless.
  const gitJson = (rev, path) =>
    JSON.parse(execSync(`git -C ${repoRoot} show ${rev}:${path}`, { maxBuffer: 1 << 28 }).toString());

  for (const [id, rev, profile] of [
    ['K46', '4647556', 'mid-local'],
    ['K47', 'a936bad', 'small-local'],
  ]) {
    const recorded = gitJson(rev, `docs/regression-baseline/phase-c-matrix/${profile}/streamed-turn.json`);
    const emitted = check.emittedTextFor(
      gitJson(rev, `docs/regression-baseline/phase-c-matrix/${profile}/core-events.json`),
    );
    const verdict = check.nothingWasDroppedBeforeTheReader(recorded, emitted);
    control(
      id,
      `the dropped-opening assertion, on the transcript recorded at ${rev} (${profile})`,
      'FAIL',
      verdict.pass,
      verdict.detail,
    );
  }

  // The same reader on a turn that is whole, so the control above is not just
  // an assertion that always fails.
  const wholeTurn = gitJson('4647556', 'docs/regression-baseline/phase-c-matrix/small-local/streamed-turn.json');
  const wholeEmitted = check.emittedTextFor(
    gitJson('4647556', 'docs/regression-baseline/phase-c-matrix/small-local/core-events.json'),
  );
  const wholeVerdict = check.nothingWasDroppedBeforeTheReader(wholeTurn, wholeEmitted);
  control(
    'K48',
    'the same reader on a turn that did arrive whole (the check is not stuck on FAIL)',
    'PASS',
    wholeVerdict.pass,
    wholeVerdict.detail,
  );

  /* ---- the staged attachment, at both boundaries ------------------------ *
   * The assertions that matter most here are the ones that were absent when
   * the defect shipped, so their controls are the defect itself: a payload
   * with the parts stripped out (Send discarding the picture), a wire with the
   * bytes missing (a core that accepts parts and forwards none), and an image
   * pasted into the prompt as prose instead of offered as an image part.       */
  {
    const a = await session(browser, frontier);
    const PNG_BYTES = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ]);
    const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUg==';
    const NOTE_NAME = 'control-notes.md';
    const NOTE_BODY = 'a note staged by the control run';

    // A control for "the button opens a chooser" that is the pre-fix state
    // rather than a simulation of it: `cloneNode` copies the markup and drops
    // every listener, so the replacement is the same button with no handler —
    // which is exactly what `Composer.tsx` shipped.
    const dead = await a.page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(
        (node) => node.getAttribute('aria-label') === 'Attach an image',
      );
      if (button === undefined || button === null) return false;
      button.replaceWith(button.cloneNode(true));
      return true;
    });
    // The promise is created BEFORE the click, and awaited after it — an
    // awaited wait placed first would time out no matter what the button did,
    // and would report the control's own ordering bug as a passing control.
    const deadChooser = a.page.waitForEvent('filechooser', { timeout: 2_500 }).catch(() => null);
    await a.page.getByRole('button', { name: 'Attach an image', exact: true }).click();
    const deadOn =
      (await deadChooser) === null ? null : await (await deadChooser).element().getAttribute('data-testid');
    control(
      'K49',
      "the composer's attach button opens its own picker — with the handler removed from that button",
      'FAIL',
      dead && deadOn === 'composer-attachment-picker',
      `handler removed=${String(dead)} chooser opened on=${String(deadOn)}`,
    );

    // Now the real thing, through the picker the reload restores.
    await a.page.reload();
    await a.page.waitForSelector('[data-testid="status-line"]');
    await a.page.getByRole('button', { name: 'Start a conversation' }).click();
    await a.page.waitForSelector('#vela-composer');
    await a.page.setInputFiles('input[type="file"]', {
      name: NOTE_NAME,
      mimeType: 'text/markdown',
      buffer: Buffer.from(NOTE_BODY),
    });
    await a.page.waitForTimeout(300);
    await send(a.page, 'read the attached note');
    const textInvokes = await (await fetch(`${frontier.base}/invokes.json`)).json();
    const textEndpoint = await (await fetch(`${frontier.base}/endpoint-requests.json`)).json();
    const textVerdict = check.stagedTextReachedTheWire(
      textInvokes,
      textEndpoint,
      NOTE_NAME,
      NOTE_BODY,
    );
    control('K50', 'a staged text file reaches the wire, on the app as it ships', 'PASS', textVerdict.pass, textVerdict.detail);

    // The degradation that is easy to ship and hard to see: the contents
    // arrive, the name does not, and the model cannot tell the file from the
    // question.
    const unnamed = JSON.parse(JSON.stringify(textInvokes));
    for (const entry of unnamed) {
      for (const message of entry.payload?.messages ?? []) {
        for (const part of message.parts ?? []) {
          if (part.kind === 'text') part.text = NOTE_BODY;
        }
      }
    }
    const unnamedVerdict = check.stagedTextReachedTheWire(unnamed, textEndpoint, NOTE_NAME, NOTE_BODY);
    control('K51', 'the same assertion when the file arrives unnamed — bare contents in the prompt', 'FAIL', unnamedVerdict.pass, unnamedVerdict.detail);

    await a.page.setInputFiles('[data-testid="composer-attachment-picker"]', {
      name: 'control.png',
      mimeType: 'image/png',
      buffer: PNG_BYTES,
    });
    await a.page.waitForTimeout(300);
    await send(a.page, 'what is in this picture?');
    const invokes = await (await fetch(`${frontier.base}/invokes.json`)).json();
    const endpointRequests = await (await fetch(`${frontier.base}/endpoint-requests.json`)).json();

    const shipped = check.stagedImageReachedTheWire(invokes, endpointRequests, PNG_BASE64);
    control('K52', 'a staged image reaches the wire, on the app as it ships', 'PASS', shipped.pass, shipped.detail);

    // THE DEFECT ITSELF: `useSelectedModel().attachments` had no reader, so the
    // payload went out with no parts at all and the user was told nothing.
    const stripped = JSON.parse(JSON.stringify(invokes));
    for (const entry of stripped) {
      for (const message of entry.payload?.messages ?? []) delete message.parts;
    }
    const strippedVerdict = check.stagedImageReachedTheWire(stripped, endpointRequests, PNG_BASE64);
    control('K53', 'the same assertion against a payload with the parts dropped — the defect as it shipped', 'FAIL', strippedVerdict.pass, strippedVerdict.detail);

    // The same defect one storey down: the renderer's payload is right and the
    // core forwards no image. Only the second boundary can see this.
    const blanked = endpointRequests.map((request) => ({ ...request, body: '{"messages":[]}' }));
    const blankedVerdict = check.stagedImageReachedTheWire(invokes, blanked, PNG_BASE64);
    control('K54', 'the same assertion when the payload is right and the wire carries no image', 'FAIL', blankedVerdict.pass, blankedVerdict.detail);

    const sawImage = check.endpointSawAnImagePart(endpointRequests);
    control('K55', 'the endpoint was offered an image part, on the app as it ships', 'PASS', sawImage.pass, sawImage.detail);

    // Base64 pasted into the prompt text. It contains the bytes, so a check
    // that only searched the body would pass on it; this is why A27 parses.
    const asProse = endpointRequests.map((request) =>
      request.path.includes('/chat/completions')
        ? {
            ...request,
            body: JSON.stringify({
              messages: [{ role: 'user', content: `here is my picture: ${PNG_BASE64}` }],
            }),
          }
        : request,
    );
    const proseVerdict = check.endpointSawAnImagePart(asProse);
    control('K56', 'the same assertion when the image was pasted into the prompt as text', 'FAIL', proseVerdict.pass, proseVerdict.detail);

    await a.page.close();
  }

  writeFileSync(
    join(outDir, 'ASSERTION-CONTROL.tsv'),
    `id\texpected\tobserved\tas_expected\tdescription\tdetail\n${results
      .map((row) => `${row.id}\t${row.expected}\t${row.verdict}\t${row.asExpected ? 'yes' : 'NO'}\t${row.description}\t${String(row.detail).replace(/\s+/gu, ' ')}`)
      .join('\n')}\n`,
  );

  const unexpected = results.filter((row) => !row.asExpected);
  process.stdout.write(
    `\ncontrols: ${String(results.length - unexpected.length)}/${String(results.length)} behaved as expected\n`,
  );
  process.exitCode = unexpected.length === 0 ? 0 : 1;
} finally {
  await browser.close();
  frontier.child.kill();
  hostile.child.kill();
  slowHostile.child.kill();
}
