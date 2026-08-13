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
  const close = page.getByRole('button', { name: /Close|Done|Back/u }).first();
  if ((await close.count()) > 0) await close.click();
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
