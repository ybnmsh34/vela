/**
 * GATE M Part 1 (Phase C) — the UI matrix driver.
 *
 * Drives the shipping renderer in Chromium, once per capability profile,
 * against the real provider core against a real mock endpoint, and writes the
 * evidence to `docs/regression-baseline/phase-c-matrix/<profile>/`.
 *
 *   node tests/harness/ui-bridge/drive-matrix.mjs --profile hostile
 *
 * Requires: a Vite dev server on 127.0.0.1:1420 (`pnpm dev`), a built
 * `src-tauri/target/debug/examples/ui_matrix_bridge`, and Playwright with
 * PLAYWRIGHT_BROWSERS_PATH set (see README.md). It starts and stops its own
 * relays and mock endpoints.
 *
 * ## Two relays, on purpose
 *
 * `fast` runs the endpoint with no inter-frame delay: that is where
 * time-to-first-token is measured, because a harness-imposed delay would be
 * measuring the harness. `slow` runs it at 60 ms per frame, which is where the
 * incremental-rendering evidence comes from — at full speed the whole turn
 * lands inside one animation frame and a renderer that could only draw finished
 * answers would look identical to one that streams.
 *
 * ## Honesty
 *
 * Every screenshot here is **VERIFIED-BY-FAKE**: a deterministic mock endpoint,
 * a memory credential store, a browser instead of the Tauri webview, on Linux
 * rather than the platforms Vela ships to. It is evidence about the renderer,
 * the core, and the seam between them. It is not evidence about any real model,
 * about the OS keychain, or about the packaged binary.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as check from './checks.mjs';

/**
 * Playwright is installed globally in this container, not as a project
 * dependency — the app must not grow a browser-automation dependency to be
 * gate-able. `VELA_PLAYWRIGHT` points at it; bare `playwright` is the fallback
 * for a machine where it is a normal local install.
 */
const playwright = await import(process.env.VELA_PLAYWRIGHT ?? 'playwright');
const { chromium } = playwright.chromium === undefined ? playwright.default : playwright;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PAGE = 'http://127.0.0.1:1420/tests/harness/ui-bridge/index.html';

const argv = process.argv.slice(2);
const profile = value('--profile') ?? 'frontier';
const outDir =
  value('--out') ?? join(repoRoot, 'docs/regression-baseline/phase-c-matrix', profile);
const fastPort = Number(value('--fast-port') ?? 8431);
const slowPort = Number(value('--slow-port') ?? 8432);

function value(flag) {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

const expected = check.EXPECTED[profile];
if (expected === undefined) throw new Error(`unknown profile ${profile}`);

// A run replaces its evidence rather than layering on top of it: a stale
// screenshot from an earlier code state is worse than no screenshot.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/* -------------------------------------------------------------------------- */
/* relays                                                                     */
/* -------------------------------------------------------------------------- */

async function startRelay(port, chunkDelay) {
  const child = spawn(
    'node',
    [
      join(repoRoot, 'tests/harness/ui-bridge/server.mjs'),
      '--profile',
      profile,
      '--port',
      String(port),
      '--chunk-delay',
      String(chunkDelay),
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start')), 60_000);
    createInterface({ input: child.stdout }).on('line', (text) => {
      if (text.includes('ui-bridge listening')) {
        clearTimeout(timer);
        resolve(text);
      }
    });
  });
  const endpoint = /endpoint (\S+)\)/u.exec(line)?.[1] ?? '';
  return { child, base: `http://127.0.0.1:${String(port)}`, endpoint };
}

/* -------------------------------------------------------------------------- */
/* evidence bookkeeping                                                       */
/* -------------------------------------------------------------------------- */

const rows = [];
const console_ = [];
const requests = [];
let shotIndex = 0;

function record(id, step, assertion, result) {
  rows.push({ id, step, assertion, verdict: result.pass ? 'PASS' : 'FAIL', detail: result.detail });
  process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${id}  ${assertion}\n`);
  if (!result.pass) process.stdout.write(`      ${result.detail}\n`);
}

async function shot(page, name) {
  shotIndex += 1;
  const file = join(outDir, `${String(shotIndex).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/* -------------------------------------------------------------------------- */
/* page helpers                                                               */
/* -------------------------------------------------------------------------- */

async function newPage(browser, relay) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (message) => {
    console_.push({ type: message.type(), text: message.text() });
  });
  page.on('pageerror', (error) => {
    console_.push({ type: 'pageerror', text: error.message });
  });
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`${PAGE}?relay=${relay.base}`);
  await page.waitForSelector('[data-testid="status-line"]', { timeout: 20_000 });
  return page;
}

async function openConversation(page) {
  await page.getByRole('button', { name: 'Start a conversation' }).click();
  await page.waitForSelector('#vela-composer', { timeout: 10_000 });
}

/**
 * Puts the app in a named theme **through its own control**, and confirms the
 * document agreed.
 *
 * Not `page.emulateMedia`, and not a hand-set `data-theme`: the title bar's
 * button is the only way a user has, and driving it is what makes a capture in
 * the other theme evidence about the app rather than about the harness. It
 * cycles system -> light -> dark, so up to three presses settle it.
 *
 * The desktop session's standing finding — that the preference is never
 * persisted — is untouched by this and is not what these captures are for.
 */
async function useTheme(page, wanted) {
  // `system` is the absence of the attribute, not a value of it — the store
  // removes it rather than writing "system", so that the media query decides.
  const expected = wanted === 'system' ? null : wanted;
  const read = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const button = page.getByRole('button', { name: /^Theme: / }).first();
  for (let press = 0; press < 4; press += 1) {
    if ((await read()) === expected) return wanted;
    await button.click();
    await page.waitForTimeout(120);
  }
  return (await read()) ?? 'system';
}

/**
 * Captures the frame in both themes and puts the app back on `system`.
 *
 * Both, because CONV-1 raised two token defects that are each invisible in one
 * theme — `--vela-code-bg` equals the page background in dark, and
 * `--vela-thinking-bg` equals it in light. A one-theme capture of a thinking
 * block is exactly the artifact that cannot show that.
 */
async function shotInBothThemes(page, name) {
  const files = [];
  for (const theme of ['dark', 'light']) {
    const settled = await useTheme(page, theme);
    if (settled !== theme) throw new Error(`could not reach the ${theme} theme (got ${settled})`);
    await page.waitForTimeout(150);
    files.push(await shot(page, `${name}-${theme}`));
  }
  // Back to `system`, which is what the app boots on and what every other
  // capture in this directory was taken under. A run that left the theme
  // pinned would silently re-theme the screenshots that follow it.
  await useTheme(page, 'system');
  await page.waitForTimeout(120);
  return files;
}

async function probeCapabilities(page) {
  await page.getByRole('button', { name: /limit|Capabilities unknown/u }).first().click();
  const probeButton = page.getByRole('button', { name: /^(Check|Check again)$/u });
  await probeButton.click();
  await page.waitForFunction(
    () => !document.body.innerText.includes('Asking the endpoint…'),
    undefined,
    { timeout: 20_000 },
  );
}

/** Types into the composer and sends, then waits for the turn to settle. */
async function sendAndSettle(page, text, { timeout = 30_000 } = {}) {
  await page.fill('#vela-composer', text);
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForFunction(
    () => {
      const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
      if (turn === undefined) return false;
      const stop = [...document.querySelectorAll('button')].some((b) => b.textContent === 'Stop');
      return !stop && !turn.innerText.includes('Waiting for the first token');
    },
    undefined,
    { timeout, polling: 50 },
  );
  // One frame for the terminal commit to paint.
  await page.waitForTimeout(120);
}

async function invoke(relay, command, payload) {
  const response = await fetch(`${relay.base}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, payload }),
  });
  return response.json();
}

/* -------------------------------------------------------------------------- */
/* the run                                                                    */
/* -------------------------------------------------------------------------- */

const fast = await startRelay(fastPort, 0);
const slow = await startRelay(slowPort, 60);
const browser = await chromium.launch();
const timings = {};

try {
  /* ---- STEP 1 — empty states, before anything has been established ------- */
  const page = await newPage(browser, fast);
  await shot(page, 'empty-no-conversations');

  await openConversation(page);
  await shot(page, 'empty-conversation-unprobed');

  const chipBefore = await check.limitsChipText(page);
  const affordancesBefore = await check.imageAffordances(page);
  record(
    'C1',
    'unprobed floor',
    'an unprobed model claims nothing and offers no capability-gated control',
    check.unprobedOffersNothing(chipBefore, affordancesBefore.length),
  );

  /* ---- STEP 2 — the capability probe (loading state included) ------------ */
  await page.getByRole('button', { name: /limit|Capabilities unknown/u }).first().click();
  await shot(page, 'capabilities-before-probe');
  const probeButton = page.getByRole('button', { name: /^(Check|Check again)$/u });
  await probeButton.click();
  // The loading state. Best-effort: the probe usually settles in single-digit
  // milliseconds, so this sometimes catches the settled panel instead.
  await shot(page, 'probe-in-flight');
  await page.waitForFunction(() => !document.body.innerText.includes('Asking the endpoint…'), undefined, { timeout: 20_000 });
  await shot(page, 'capabilities-after-probe');

  const report = (await invoke(fast, 'models_capabilities', { providerId: 'matrix', modelId: expected.modelId })).ok;
  writeFileSync(join(outDir, 'capability-report.json'), `${JSON.stringify(report, null, 2)}\n`);

  record(
    'C2',
    'capability truth',
    'the vision flag the UI branches on equals the endpoint\'s real vision support',
    { pass: report.capabilities.vision === expected.vision, detail: `report.vision=${String(report.capabilities.vision)} endpoint=${String(expected.vision)}` },
  );

  /* ---- STEP 3 — VISION: affordance existence, not disabled state --------- */
  const affordances = await check.imageAffordances(page);
  writeFileSync(
    join(outDir, 'attach-affordances.json'),
    `${JSON.stringify({ imageAffordances: affordances, everyAttachControl: await check.attachAffordances(page) }, null, 2)}\n`,
  );
  record(
    'C3',
    'vision',
    expected.vision
      ? 'a model with vision offers an image affordance'
      : 'a model without vision has NO image affordance in the DOM',
    check.visionAffordanceMatchesCapability(affordances, expected.vision),
  );
  await shot(page, expected.vision ? 'composer-with-attach' : 'composer-without-attach');
  // Fold the capability panel away, so the transcript screenshots that follow
  // show what a user reading a conversation actually sees.
  await page.getByRole('button', { name: /limit|Capabilities unknown/u }).first().click();

  /* ---- STEP 4 — CONTEXT: the endpoint's own window ----------------------- */
  const meter = await check.contextMeterText(page);
  record(
    'C4',
    'context',
    "the meter shows the endpoint's real window, and no other endpoint's",
    check.contextWindowIsTheEndpoints(meter, expected.windowTexts, check.foreignWindowTexts(profile)),
  );

  await page.fill('#vela-composer', 'x'.repeat(Math.ceil(expected.contextWindow * 4.4)));
  await page.waitForTimeout(300);
  const overflowMeter = await check.contextMeterText(page);
  record('C5', 'context', 'the meter warns BEFORE the turn is sent, for a draft that will not fit', check.contextOverflowWarns(overflowMeter));
  await shot(page, 'context-overflow-warning');
  await page.fill('#vela-composer', '');

  // The meter's other input. Separating the two answers "is the meter broken,
  // or is it simply not being told about the draft?" — which is the difference
  // between a component bug and a wiring gap, and they need different fixes.
  await page.setInputFiles('input[type="file"]', {
    name: 'oversized.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('x'.repeat(Math.ceil(expected.contextWindow * 4.4))),
  });
  await page.waitForTimeout(400);
  const stagedMeter = await check.contextMeterText(page);
  record('C5b', 'context', 'the meter counts a staged text file and warns on it', check.contextOverflowWarns(stagedMeter));
  await shot(page, 'context-overflow-staged-file');
  const removeStaged = page.getByRole('button', { name: /Remove/u }).first();
  if ((await removeStaged.count()) > 0) await removeStaged.click();
  await page.waitForTimeout(200);

  /* ---- STEP 5 — a complete streamed turn, and TTFT ----------------------- */
  await page.evaluate(() => {
    window.__mark = { start: null, firstAny: null, firstAnswer: null, samples: [] };
    const answerOf = (turn) => {
      const clone = turn.cloneNode(true);
      for (const node of clone.querySelectorAll('section, footer, [data-kind], ul[aria-label]')) node.remove();
      return (clone.innerText ?? '').replace('Waiting for the first token…', '').trim();
    };
    new MutationObserver(() => {
      const mark = window.__mark;
      if (mark.start === null) return;
      const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
      if (turn === undefined) return;
      const now = performance.now();
      const answer = answerOf(turn);
      const whole = turn.innerText.replace('Waiting for the first token…', '').trim();
      if (mark.firstAny === null && whole.length > 0) mark.firstAny = now;
      if (mark.firstAnswer === null && answer.length > 0) mark.firstAnswer = now;
      const last = mark.samples.at(-1);
      if (last === undefined || last.answer !== answer.length) {
        mark.samples.push({ t: now, answer: answer.length, whole: whole.length });
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });

  await page.fill('#vela-composer', 'Summarise what this endpoint can do.');
  await page.evaluate(() => {
    window.__mark.start = performance.now();
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')?.click();
  });
  await page.waitForFunction(
    () => {
      const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
      const stop = [...document.querySelectorAll('button')].some((b) => b.textContent === 'Stop');
      return turn !== undefined && !stop && !turn.innerText.includes('Waiting for the first token');
    },
    undefined,
    { timeout: 30_000, polling: 50 },
  );
  await page.waitForTimeout(150);

  const mark = await page.evaluate(() => window.__mark);
  timings.ttftAnyMs = mark.firstAny === null ? null : Math.round((mark.firstAny - mark.start) * 100) / 100;
  timings.ttftAnswerMs = mark.firstAnswer === null ? null : Math.round((mark.firstAnswer - mark.start) * 100) / 100;
  timings.paints = mark.samples.length;
  timings.turnMs = mark.samples.length === 0 ? null : Math.round(mark.samples.at(-1).t - mark.start);

  const streamed = await check.lastAssistantTurn(page);
  await shot(page, 'streamed-turn-complete');
  record('C6', 'streamed turn', 'the turn reaches a settled, readable state', check.turnSettled(streamed));
  record('C7', 'reasoning', 'no reasoning markup reaches any visible text', check.noReasoningMarkup(await check.transcriptText(page)));
  record('C8', 'reasoning', 'the answer is not swallowed by the reasoning channel', check.answerNotSwallowed(streamed));
  record('C9', 'usage', 'token usage is shown only where the endpoint reported it', check.usageOnlyWhenReported(streamed.whole, expected.usageReported));
  // Read from the core's own log, mid-run, so the comparison is against what
  // this turn actually produced rather than against a string written here.
  const emittedSoFar = check.emittedTextFor(await (await fetch(`${fast.base}/events.json`)).json());
  record(
    'C6b',
    'streamed turn',
    'everything the core produced for this turn reached the reader',
    check.nothingWasDroppedBeforeTheReader(streamed, emittedSoFar),
  );

  writeFileSync(join(outDir, 'streamed-turn.json'), `${JSON.stringify(streamed, null, 2)}\n`);

  /* ---- STEP 6 — the thinking block, collapsed and expanded --------------- */
  if (streamed.reasoning !== null) {
    const toggle = page.locator('article[data-role="assistant"]').last().locator('section h3 button').first();
    const stateA = await check.lastAssistantTurn(page);
    await shot(page, `thinking-${stateA.reasoning.expanded ? 'expanded' : 'collapsed'}`);
    await toggle.click();
    await page.waitForTimeout(150);
    const stateB = await check.lastAssistantTurn(page);
    await shot(page, `thinking-${stateB.reasoning.expanded ? 'expanded' : 'collapsed'}`);
    record(
      'C10',
      'reasoning',
      'the thinking block toggles, and its hidden state follows aria-expanded',
      {
        pass: stateA.reasoning.expanded !== stateB.reasoning.expanded && stateB.reasoning.hiddenAttribute === !stateB.reasoning.expanded,
        detail: `first expanded=${String(stateA.reasoning.expanded)} then=${String(stateB.reasoning.expanded)} hidden=${String(stateB.reasoning.hiddenAttribute)} summary="${stateB.reasoning.summary}"`,
      },
    );
    // Leave it expanded for the tool-call screenshots.
    if (!stateB.reasoning.expanded) await toggle.click();
  } else {
    record('C10', 'reasoning', 'a profile with no reasoning renders no thinking block', {
      pass: expected.reasoning === false,
      detail: expected.reasoning ? 'expected a thinking block and found none' : 'no thinking block, as expected',
    });
  }

  /* ---- STEP 6b — THE READING SURFACE ------------------------------------ *
   * The primary thing a Vela user looks at, and until now the one thing this
   * matrix never rendered. Every profile answers a plain prompt with a single
   * paragraph of filler, so no run had ever painted a heading, a list, a block
   * quote, a table or a fenced code block — which is why a critic, not a gate,
   * had to be the one to notice that all six heading levels were the same size.
   *
   * `#markdown` makes the endpoint answer with
   * `tests/fixtures/rich-markdown-answer.md`, the same document
   * `src/features/conversation/Markdown.test.tsx` asserts against, so the
   * screenshot and the unit test are about one artifact.                      */
  await sendAndSettle(page, '#markdown Which local model should I run on this machine?', {
    timeout: 60_000,
  });
  const reading = await check.readingSurface(page);
  writeFileSync(join(outDir, 'reading-surface.json'), `${JSON.stringify(reading, null, 2)}\n`);

  // Two frames, because the whole point is a document too long for one: the top
  // where the hierarchy is establishing itself, and the middle where a table, a
  // block quote and a fenced block sit next to each other.
  await page.evaluate(() => {
    const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
    (turn?.querySelector('[data-level]') ?? turn)?.scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(200);
  await shot(page, 'rendered-markdown-answer');
  await page.evaluate(() => {
    const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
    (turn?.querySelector('table') ?? turn?.querySelector('pre') ?? turn)?.scrollIntoView({
      block: 'center',
    });
  });
  await page.waitForTimeout(200);
  await shot(page, 'rendered-markdown-answer-blocks');

  if (expected.answerChannelIsClean) {
    record('C22', 'reading surface', 'the rendered answer has a type hierarchy a reader can use', check.headingHierarchyIsVisible(reading));
    record('C23', 'reading surface', "wrapped prose reflows to the reader's column, not the model's", check.proseReflows(reading));
    record('C24', 'reading surface', 'nothing in the answer makes the reading column scroll sideways', check.readingSurfaceFitsItsColumn(reading));
  } else {
    // `hostile` never closes its thinking block, so this document is salvaged
    // rather than answered. Where salvaged text lands is the core's business
    // and is already judged by C8; judging the *typography* of a channel this
    // endpoint never opened would be judging the wrong thing. The screenshots
    // are still taken, because what a hostile endpoint does to a long document
    // is worth looking at even where there is nothing to assert.
    record('C22', 'reading surface', 'a long document from an endpoint with no answer channel still settles readably', check.turnSettled(await check.lastAssistantTurn(page)));
  }

  /* ---- STEP 6c — THE TYPE SCALE, ALL SIX LEVELS ------------------------- *
   * The gap the previous pass disclosed and could not close: **no artifact in
   * the evidence set rendered h1, h3, h4, h5 or h6**, so "the scale collapses
   * below h3 — h4 at body size, h5 and h6 smaller than the prose they head,
   * and an unclassed `<strong>` at 700 outweighing every one of them" was a
   * reading of a stylesheet rather than an observation of a screen. That is the
   * same shape of gap that let the raw-markdown thinking block survive a full
   * cloud review.
   *
   * `#headings` answers with `tests/fixtures/heading-scale-answer.md`, which
   * puts every level and a bold run beside it in one frame.                    */
  await sendAndSettle(page, '#headings show me every heading level', { timeout: 60_000 });
  const scale = await check.readingSurface(page);
  writeFileSync(join(outDir, 'heading-scale.json'), `${JSON.stringify(scale, null, 2)}\n`);
  // Two frames, because the six levels do not fit in one at a readable size and
  // the point of the capture is that a human can compare them. The first holds
  // `h1` and the top of the scale; the second holds the levels that collapsed —
  // `h4`, `h5`, `h6` — beside the bold runs that used to outweigh them.
  await page.evaluate(() => {
    const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
    (turn?.querySelector('[data-level="1"]') ?? turn)?.scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(200);
  await shotInBothThemes(page, 'heading-scale-from-h1');
  await page.evaluate(() => {
    const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
    (turn?.querySelector('[data-level="4"]') ?? turn)?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(200);
  // Both themes. The heading scale is a token question and the tokens are
  // re-authored per theme; a capture in one of them is half the evidence, and
  // this is the artifact the CONV-1 verdict said did not exist at all.
  await shotInBothThemes(page, 'heading-scale-deep-levels');

  if (expected.answerChannelIsClean) {
    record(
      'C22b',
      'reading surface',
      'all six heading levels are rendered, and none is smaller or lighter than a bold run',
      check.headingsOutrankEmphasis(scale),
    );
    record(
      'C22c',
      'reading surface',
      'every heading level from one to six reached the answer channel',
      {
        pass: new Set((scale?.headings ?? []).map((heading) => heading.level)).size === 6,
        detail: `levels present: ${[...new Set((scale?.headings ?? []).map((h) => h.level))].sort().join(',')}`,
      },
    );
    record(
      'C25',
      'reading surface',
      'the reading column sets a comfortable number of characters per line',
      check.readingMeasureIsComfortable(scale),
    );
  }

  /* ---- STEP 6d — THE THINKING BLOCK AS A READING SURFACE ---------------- *
   * It is one, and nothing here ever treated it as one. `#thinkmd` puts a bold
   * lead-in, a bulleted plan and inline code in the *reasoning* channel — which
   * is what real reasoning models put there and what the narration in this
   * harness never did, which is why the block printing
   * `**Deconstruct the requirements:**` at the user was invisible from here.   */
  if (expected.reasoning !== false) {
    await sendAndSettle(page, '#thinkmd which local model should I run?', { timeout: 60_000 });
    // Measured on the settled turn, which is the state this screenshot shows;
    // the streaming default is pinned by `ConversationSurface.test.tsx`, which
    // can hold a turn mid-stream and this driver cannot.
    record(
      'C26',
      'reasoning',
      'a settled thought is closed, unless closing it would hide the only text the turn produced',
      check.settledThoughtIsClosed(await check.lastAssistantTurn(page)),
    );
    await shotInBothThemes(page, 'thinking-markdown-collapsed');

    // Open it if it is not already: the unterminated case starts open on
    // purpose, and clicking there would close the one block that must not be.
    const toggle = page.locator('article[data-role="assistant"]').last().locator('section h3 button').first();
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
      await page.waitForTimeout(150);
    }
    const reasoning = await check.reasoningSurface(page);
    writeFileSync(join(outDir, 'reasoning-surface.json'), `${JSON.stringify(reasoning, null, 2)}\n`);
    await page.evaluate(() => {
      const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
      turn?.querySelector('section')?.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(200);
    await shotInBothThemes(page, 'thinking-markdown-expanded');

    record('C27', 'reasoning', 'the thinking block renders markdown instead of printing its source', check.reasoningRendersAsMarkdown(reasoning));
    record('C28', 'reasoning', 'nothing inside the aside sets larger than the answer it is about', check.asideStaysSubordinate(reasoning));
  } else {
    record('C27', 'reasoning', 'a profile with no reasoning channel renders no thinking block to judge', {
      pass: (await check.lastAssistantTurn(page)).reasoning === null,
      detail: 'no reasoning channel on this endpoint',
    });
  }

  /* ---- STEP 6e — THE RULER, AT TWO WINDOW SIZES ------------------------- *
   * The transcript's text and the composer's box sat on two rulers (688px over
   * 736px), and the sidebar was a constant that took half of a 1000px window.
   * Both are properties of the assembled layout at a particular size, so both
   * are read at two — a single reading cannot tell a responsive width from a
   * constant that happens to look right where you measured.                    */
  // Dragged to its maximum first, through the separator a keyboard user would
  // use. At the stored default the sidebar is under the cap at every window
  // size this run visits, so measuring it there would prove nothing at all —
  // which is exactly how a constant width survives a responsive check.
  const separator = page.getByRole('separator', { name: /Resize sidebar/u });
  await separator.focus();
  for (let press = 0; press < 20; press += 1) await separator.press('ArrowRight');
  await page.waitForTimeout(200);
  const draggedTo = await separator.getAttribute('aria-valuenow');

  const rulerWide = await check.layoutRuler(page);
  await shot(page, 'layout-ruler-1440');
  await page.setViewportSize({ width: 880, height: 800 });
  await page.waitForTimeout(250);
  const rulerNarrow = await check.layoutRuler(page);
  await shot(page, 'layout-ruler-880');
  writeFileSync(
    join(outDir, 'layout-ruler.json'),
    `${JSON.stringify({ sidebarDraggedTo: Number(draggedTo), wide: rulerWide, narrow: rulerNarrow }, null, 2)}\n`,
  );

  record('C29', 'layout', 'the transcript and the composer stand on one vertical ruler', check.oneVerticalRuler(rulerWide));
  record('C29b', 'layout', 'they stay on it when the window narrows', check.oneVerticalRuler(rulerNarrow));
  record('C30', 'layout', 'the sidebar gives way to the reading column as the window narrows', check.sidebarTracksTheWindow(rulerWide, rulerNarrow));
  record('C31', 'layout', 'the transcript fades into a scroll edge that hides content, and only into one that does', check.scrollEdgeIsMasked(rulerNarrow));

  await page.setViewportSize({ width: 1440, height: 900 });
  for (let press = 0; press < 20; press += 1) await separator.press('ArrowLeft');
  await page.waitForTimeout(250);

  /* ---- STEP 7 — TOOL CALLS ---------------------------------------------- */
  await sendAndSettle(page, '#tools What is the weather in Lisbon?');
  const toolTurn = await check.lastAssistantTurn(page);
  writeFileSync(join(outDir, 'tool-turn.json'), `${JSON.stringify(toolTurn, null, 2)}\n`);
  // Put the tool section in the middle of the frame: a screenshot of a card
  // that is half off the top proves less than one a reader can check.
  await page.evaluate(() => {
    const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
    const tools = [...(turn?.querySelectorAll('section') ?? [])].find((node) => node.getAttribute('aria-label') === 'Tool calls');
    (tools ?? turn)?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(200);
  await shot(page, 'tool-calls');

  if (profile === 'hostile') {
    record('C11', 'tool calls', 'a malformed tool call is VISIBLE, never silently dropped', check.malformedToolCallVisible(toolTurn));
  } else if (profile === 'small-local') {
    record('C11', 'tool calls', 'prompt emulation is disclosed', check.emulationDisclosed(toolTurn));
  } else {
    record('C11', 'tool calls', 'a native tool call is rendered as a call', {
      pass: (toolTurn.tools?.cards.length ?? 0) > 0,
      detail: `cards=[${(toolTurn.tools?.cards ?? []).join(',')}]`,
    });
  }
  record('C12', 'tool calls', 'no reasoning markup in the tool turn either', check.noReasoningMarkup(await check.transcriptText(page)));

  /* ---- STEP 7b — A STAGED ATTACHMENT, AT BOTH BOUNDARIES ---------------- *
   * The eighth instance of this project's defect class: a staging hook, a
   * picker, a tray and a `toContentParts()` — all built, all tested, joined to
   * nothing. `useSelectedModel().attachments` had no reader, so Send discarded
   * the user's picture silently and every component test still passed.
   *
   * Asked here at the two places the bytes have to arrive, because a payload
   * that leaves the browser and dies in the Rust layer is the same defect one
   * storey down:
   *
   *   renderer -> host      the `chat_send` payload, read off the relay
   *   core     -> endpoint  the HTTP body, read off the endpoint's own record
   *
   * The base64 is written out here rather than computed from the same file the
   * app read: a check that shares an encoder with the code it checks agrees
   * with it about the wrong answer just as readily as about the right one.     */
  const NOTE_NAME = 'endpoint-notes.md';
  const NOTE_BODY = 'the study workstation answers on port 8033';
  const PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUg==';

  const boundaries = async () => ({
    invokes: await (await fetch(`${fast.base}/invokes.json`)).json(),
    endpoint: await (await fetch(`${fast.base}/endpoint-requests.json`)).json(),
  });

  // -- a text file, on every profile: it is inlined as prompt text and so is
  //    never gated on vision.
  await page.setInputFiles('input[type="file"]', {
    name: NOTE_NAME,
    mimeType: 'text/markdown',
    buffer: Buffer.from(NOTE_BODY),
  });
  await page.waitForTimeout(400);
  await shot(page, 'staged-text-file');
  await sendAndSettle(page, 'read the attached note', { timeout: 60_000 });
  const afterText = await boundaries();
  record(
    'C32',
    'attachments',
    'a staged text file reaches the outgoing payload AND the endpoint, carrying its name',
    check.stagedTextReachedTheWire(afterText.invokes, afterText.endpoint, NOTE_NAME, NOTE_BODY),
  );

  // -- an image, where the endpoint can read one. On a model without vision the
  //    affordance is absent by design (C3), so there is nothing to drive: that
  //    is the invariant, not a gap in this step.
  if (expected.vision) {
    // Through the composer's own paperclip, which is the control that shipped
    // with no `onClick` at all — a button sitting exactly where a user looks
    // for it, opening nothing.
    // Driven the way a user drives it: press the button and answer the file
    // chooser the browser opens. Waiting for the chooser is the assertion — a
    // button with no handler opens nothing, and the wait times out. Reading the
    // hidden input directly would have passed against the broken version, which
    // is precisely how that control shipped dead.
    const chooser = page
      .waitForEvent('filechooser', { timeout: 5_000 })
      .catch(() => null);
    // `exact: true`. The model bar's control is named "Attach an image or a
    // file", which a substring match also selects — and the first run of this
    // step did exactly that, reporting the composer's button as working while
    // measuring a different one. The composer's paperclip is the control that
    // shipped with no handler, so it has to be the one that is clicked.
    await page.getByRole('button', { name: 'Attach an image', exact: true }).click();
    const fileChooser = await chooser;
    const openedOn =
      fileChooser === null ? null : await fileChooser.element().getAttribute('data-testid');
    record('C33', 'attachments', "the composer's attach button opens the composer's own picker", {
      pass: openedOn === 'composer-attachment-picker',
      detail:
        fileChooser === null
          ? 'no filechooser event within 5 s — the control opens nothing'
          : `chooser opened on ${String(openedOn)}`,
    });
    if (fileChooser === null) {
      await page
        .locator('[data-testid="composer-attachment-picker"]')
        .setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG_BYTES });
    } else {
      await fileChooser.setFiles({
        name: 'shot.png',
        mimeType: 'image/png',
        buffer: PNG_BYTES,
      });
    }
    await page.waitForTimeout(400);
    await shot(page, 'staged-image');
    await sendAndSettle(page, 'what is in this picture?', { timeout: 60_000 });
    const afterImage = await boundaries();
    writeFileSync(
      join(outDir, 'staged-attachment-wire.json'),
      `${JSON.stringify(
        {
          expectedBase64: PNG_BASE64,
          rendererToHost: (afterImage.invokes ?? [])
            .filter((entry) => entry.command === 'chat_send')
            .map((entry) => ({
              messages: (entry.payload.messages ?? []).map((message) => ({
                role: message.role,
                text: String(message.text ?? '').slice(0, 60),
                parts: (message.parts ?? []).map((part) => ({
                  kind: part.kind,
                  mimeType: part.mimeType,
                  bytes: part.data === undefined ? undefined : part.data.length,
                  data: part.data,
                  text: part.text === undefined ? undefined : part.text.slice(0, 80),
                })),
              })),
            })),
          coreToEndpoint: (afterImage.endpoint ?? [])
            .filter((request) => request.path.includes('/chat/completions'))
            .map((request) => ({ path: request.path, bytes: request.body.length })),
        },
        null,
        2,
      )}\n`,
    );
    record(
      'C34',
      'attachments',
      'a staged image reaches the outgoing payload AND the bytes arrive at the endpoint',
      check.stagedImageReachedTheWire(afterImage.invokes, afterImage.endpoint, PNG_BASE64),
    );
    record(
      'C35',
      'attachments',
      'the endpoint was asked to look at an image part, not handed base64 as prose',
      check.endpointSawAnImagePart(afterImage.endpoint),
    );
    await shot(page, 'image-turn-sent');
  } else {
    record('C34', 'attachments', 'a model without vision offers no image to stage', {
      pass: (await check.imageAffordances(page)).length === 0,
      detail: 'no image affordance, as C3 requires',
    });
  }

  /* ---- STEP 8 — NO CREDENTIAL ------------------------------------------- */
  const snapshot = (await invoke(fast, 'settings_get', {})).ok;
  const providerView = snapshot.providers[0];
  writeFileSync(join(outDir, 'provider-view.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  await page.getByRole('button', { name: new RegExp(expected.modelId, 'u') }).first().click();
  await page.getByRole('button', { name: 'Manage endpoints…' }).click();
  await page.waitForTimeout(300);
  await shot(page, 'endpoints-no-credential');
  record(
    'C13',
    'no credential',
    'an endpoint with no API key is a working state, with no error and no warning',
    check.noCredentialIsClean(providerView, await page.locator('body').innerText()),
  );
  // Back to the transcript.
  // Not `/Close|Done|Back/u`. That matched the title bar's caption control as
  // well — `aria-label="Close"` before this branch renamed it — and the title
  // bar is the first thing in the shell, so `.first()` selected the control
  // that quits the application rather than the one that dismisses this panel.
  // `docs/audit/REPORT.md` records what that looked like from outside.
  const close = page.getByRole('button', { name: 'Close the endpoints panel', exact: true });
  if ((await close.count()) > 0) await close.first().click();
  await page.waitForTimeout(200);

  /* ---- STEP 9 — the error state ----------------------------------------- */
  await fetch(`${fast.base}/control/stop-endpoint`);
  await page.waitForTimeout(300);
  await page.waitForSelector('#vela-composer');
  await sendAndSettle(page, 'Is anyone there?', { timeout: 60_000 });
  const failed = await check.lastAssistantTurn(page);
  writeFileSync(join(outDir, 'error-turn.json'), `${JSON.stringify(failed, null, 2)}\n`);
  await shot(page, 'error-endpoint-unreachable');
  record('C14', 'error state', 'a turn that could not run says so, in Vela\'s own words', check.errorStateVisible(failed));
  record('C15', 'error state', 'the failed turn is settled, not a stuck spinner', check.turnSettled(failed));

  /* ---- STEP 10 — the slow endpoint: incremental rendering ---------------- */
  const slowPage = await newPage(browser, slow);
  await openConversation(slowPage);
  await probeCapabilities(slowPage);
  await slowPage.getByRole('button', { name: /limit|Capabilities unknown/u }).first().click();
  await slowPage.fill('#vela-composer', 'Stream this slowly so the renderer can be watched.');
  await slowPage.evaluate(() => {
    window.__frames = [];
    const answerOf = (turn) => {
      const clone = turn.cloneNode(true);
      for (const node of clone.querySelectorAll('section, footer, [data-kind], ul[aria-label]')) node.remove();
      return (clone.innerText ?? '').replace('Waiting for the first token…', '').trim();
    };
    new MutationObserver(() => {
      const turn = [...document.querySelectorAll('article[data-role="assistant"]')].at(-1);
      if (turn === undefined) return;
      const answer = answerOf(turn).length;
      const whole = turn.innerText.replace('Waiting for the first token…', '').trim().length;
      const last = window.__frames.at(-1);
      if (last === undefined || last.answer !== answer || last.whole !== whole) {
        window.__frames.push({ t: Math.round(performance.now()), answer, whole });
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send')?.click();
  });
  await slowPage.waitForTimeout(700);
  await shot(slowPage, 'mid-stream');
  const midStream = await check.lastAssistantTurn(slowPage);
  record('C16', 'streaming', 'the transcript shows a partial turn while it is still streaming', {
    pass: (midStream.answer.length > 0 || (midStream.reasoning?.text.length ?? 0) > 0),
    detail: `answer=${String(midStream.answer.length)} reasoning=${String(midStream.reasoning?.text.length ?? 0)}`,
  });
  record('C17', 'reasoning', 'no reasoning markup mid-stream, when a tag may be split across frames', check.noReasoningMarkup(await check.transcriptText(slowPage)));

  await slowPage.waitForFunction(
    () => ![...document.querySelectorAll('button')].some((b) => b.textContent === 'Stop'),
    undefined,
    { timeout: 60_000, polling: 50 },
  );
  const frames = await slowPage.evaluate(() => window.__frames);
  writeFileSync(join(outDir, 'incremental-frames.json'), `${JSON.stringify(frames, null, 2)}\n`);
  // Measured on the turn as a whole, not on the answer channel alone. Under the
  // hostile profile the model never closes its thinking block, so every token
  // arrives as reasoning and the answer is only salvaged at the end — the user
  // still watches text arrive, and demanding it arrive in the answer channel
  // would be demanding the renderer guess earlier than the core can.
  record('C18', 'streaming', 'the turn is painted incrementally, not in one lump', check.paintedIncrementally(frames));
  await shot(slowPage, 'slow-turn-complete');

  /* ---- STEP 11 — the whole-run assertions -------------------------------- */
  record('C19', 'console', 'zero console errors and zero uncaught exceptions', check.consoleIsClean(console_));
  record(
    'C20',
    'network',
    'the browser never requested the model endpoint',
    check.noBrowserSideModelRequest(requests, fast.endpoint),
  );
  record(
    'C21',
    'network',
    'the browser never requested the slow endpoint either',
    check.noBrowserSideModelRequest(requests, slow.endpoint),
  );

  /* ---- write the evidence ------------------------------------------------ */
  const events = await (await fetch(`${fast.base}/events.json`)).json();
  writeFileSync(join(outDir, 'core-events.json'), `${JSON.stringify(events, null, 2)}\n`);
  writeFileSync(join(outDir, 'console.txt'), `${console_.map((e) => `${e.type}\t${e.text}`).join('\n')}\n`);
  writeFileSync(join(outDir, 'network.txt'), `${[...new Set(requests)].sort().join('\n')}\n`);
  writeFileSync(
    join(outDir, 'timings.json'),
    `${JSON.stringify({ profile, endpoint: fast.endpoint, ...timings }, null, 2)}\n`,
  );
  writeFileSync(
    join(outDir, 'assertions.tsv'),
    `id\tstep\tverdict\tassertion\tdetail\n${rows
      .map((row) => `${row.id}\t${row.step}\t${row.verdict}\t${row.assertion}\t${String(row.detail).replace(/\s+/gu, ' ')}`)
      .join('\n')}\n`,
  );

  const failures = rows.filter((row) => row.verdict === 'FAIL');
  process.stdout.write(`\n${profile}: ${String(rows.length - failures.length)}/${String(rows.length)} passed\n`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
  await browser.close();
  fast.child.kill();
  slow.child.kill();
}
