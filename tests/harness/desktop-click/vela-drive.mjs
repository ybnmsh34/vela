#!/usr/bin/env node
/**
 * # vela-drive — launch Vela, click it, read what it shows
 *
 *     node tests/harness/desktop-click/vela-drive.mjs <command> [flags]
 *
 * See `tests/harness/desktop-click/README.md`. `--help` prints the same command
 * list. Every command writes one JSON object to stdout and a one-line human
 * summary to stderr, so a script can pipe stdout into `jq` and a person reading
 * a transcript can still see what happened.
 *
 * ## The three things this file exists to get right
 *
 * **1. Attaching to the process we started.** Vela has no single-instance guard
 * and every instance shares the identifier `dev.vela.desktop`. WebView2 keys its
 * browser process on the user-data folder, so a second window on a shared
 * profile is served by the first browser process and its
 * `--remote-debugging-port` is ignored entirely. `up` therefore refuses if any
 * `vela.exe` is already running, gives the app a private profile, and then
 * proves the listening socket belongs to the pid it spawned (see
 * `assertPortBelongsTo` in `cdp.mjs`).
 *
 * **2. Saying which kind of click was delivered.** `--via os` (the default) is a
 * real `SendInput` press and release into the system input queue, aimed at a
 * screen point. `--via message` posts `WM_LBUTTONDOWN`/`UP` to the WebView2
 * window: the target window's own message loop, but not the input queue.
 * `--via cdp` is `Input.dispatchMouseEvent`, which enters the browser's input
 * pipeline before hit-testing and produces trusted events, but is not OS input.
 * Every click result carries `via` and `isOsInput` so no verdict can hide which
 * it used. None is `element.click()`, which this harness never does.
 *
 * **And a click is only "clicked" if the window says the queried element was
 * hit** — decided from the node the `mousedown` was dispatched at, never from a
 * later `elementFromPoint`, and never by an ancestor relation. See `pointerHit`
 * in `page.mjs` for the two ways that went wrong and what each of them graded
 * as present.
 *
 * **3. Reporting absence.** A harness that cannot say "not there" grades every
 * unwired feature as present. `find` and `click` exit 3 when nothing matches and
 * print `{ "found": false }`, and `--expect N` turns a count into an assertion.
 *
 * ## Where the app writes
 *
 * Tauri resolves the application-data directory with
 * `dirs::data_dir().join(identifier)`, and on Windows `dirs` calls
 * `SHGetKnownFolderPath(FOLDERID_RoamingAppData)` — the `%APPDATA%` environment
 * variable is not consulted and cannot redirect it. The only lever is the
 * identifier, which `tauri-build` and `generate_context!` both read from the
 * `TAURI_CONFIG` merge patch at **build** time. `--app-data isolated` (the
 * default) builds with a different identifier so the run cannot touch
 * `%APPDATA%\dev.vela.desktop`; `--app-data real` builds the shipping
 * identifier and says so loudly on every launch. `appdata` resolves whichever
 * one is live with `GetFinalPathNameByHandle` rather than assuming.
 */

import { spawn, execFile } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import {
  CdpSession,
  EXIT,
  HarnessError,
  assertPortBelongsTo,
  cdpHttp,
  listenerPid,
  pickPage,
  powershell,
  runningVelaProcesses,
  waitForEndpoint,
} from './cdp.mjs';
import { BOOTSTRAP, literal } from './page.mjs';

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, '..', '..', '..');
const SRC_TAURI = join(REPO_ROOT, 'src-tauri');
const EXE = join(SRC_TAURI, 'target', 'debug', 'vela.exe');
const BUILD_MARKER = join(SRC_TAURI, 'target', 'debug', '.vela-drive-build.json');

const HARNESS_ROOT = process.env.VELA_HARNESS_ROOT ?? join(tmpdir(), 'vela-desktop-click');
const SESSION_FILE = join(HARNESS_ROOT, 'session.json');

const SHIPPING_IDENTIFIER = 'dev.vela.desktop';
const ISOLATED_IDENTIFIER = 'dev.vela.harness';
const DEFAULT_PORT = 9222;
const VITE_PORT = 1420;

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const command = argv[0];
  const flags = {};
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, flags, positional };
}

function flagNumber(flags, name, fallback) {
  if (flags[name] === undefined) return fallback;
  const value = Number(flags[name]);
  if (!Number.isFinite(value)) {
    throw new HarnessError(EXIT.USAGE, `--${name} must be a number, got ${flags[name]}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// session state
// ---------------------------------------------------------------------------

function readSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeSession(session) {
  mkdirSync(HARNESS_ROOT, { recursive: true });
  writeFileSync(SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

function clearSession() {
  if (existsSync(SESSION_FILE)) rmSync(SESSION_FILE, { force: true });
}

async function requireSession() {
  const session = readSession();
  if (!session) {
    throw new HarnessError(
      EXIT.NO_SESSION,
      `no session recorded at ${SESSION_FILE}. Run \`up\` first.`,
    );
  }
  const alive = (await runningVelaProcesses()).some((p) => p.pid === session.pid);
  if (!alive) {
    throw new HarnessError(
      EXIT.NO_SESSION,
      `the recorded session pid ${session.pid} is gone. Run \`down\` then \`up\`.`,
      { session },
    );
  }
  return session;
}

/**
 * Connects to the window the session recorded, after re-proving the port still
 * belongs to it. The proof is repeated on every command, not just on `up`,
 * because the failure it guards against — a second `vela.exe` appearing and the
 * port ending up somewhere else — can happen between two commands.
 */
async function attach(session) {
  const ownership = await assertPortBelongsTo(session.port, session.pid);
  const targets = await cdpHttp(session.port, '/json/list');
  const page = pickPage(targets);
  if (!page) {
    throw new HarnessError(EXIT.FAILED, `no page target on port ${session.port}`, { targets });
  }
  const cdp = await CdpSession.connect(page.webSocketDebuggerUrl);
  await cdp.evaluate(BOOTSTRAP);
  return { cdp, page, ownership };
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function readBuildMarker() {
  if (!existsSync(BUILD_MARKER)) return null;
  try {
    return JSON.parse(readFileSync(BUILD_MARKER, 'utf8'));
  } catch {
    return null;
  }
}

async function run(command, args, options = {}) {
  const started = Date.now();
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    shell: options.shell ?? false,
  });
  return { stdout, stderr, ms: Date.now() - started };
}

/**
 * Builds the debug binary for the requested flavour.
 *
 * `--bundle prod` enables `tauri/custom-protocol`, which is what flips
 * `tauri-macros`' `dev` flag off: the context macro then embeds `dist/` and the
 * window loads the bundled bytes over the custom protocol instead of `devUrl`.
 * That is the *frontend* production artefact inside a *debug-profile* host —
 * see the README on what that licenses.
 */
async function build({ bundle, identifier }) {
  const steps = [];
  const cargoBin = join(process.env.USERPROFILE ?? '', '.cargo', 'bin');
  const env = { PATH: `${cargoBin};${process.env.PATH}` };
  if (identifier !== SHIPPING_IDENTIFIER) {
    env.TAURI_CONFIG = JSON.stringify({ identifier });
  } else {
    env.TAURI_CONFIG = '{}';
  }

  if (bundle === 'prod') {
    // `.cmd` shims need a shell on Node 20+, which refuses to exec them directly.
    const pnpm = await run('pnpm.cmd', ['build'], { env, shell: true });
    steps.push({ step: 'pnpm build', ms: pnpm.ms, tail: tail(pnpm.stdout, 6) });
  }

  const cargoArgs = ['build', '--bin', 'vela'];
  if (bundle === 'prod') cargoArgs.push('--features', 'tauri/custom-protocol');
  const cargo = await run(join(cargoBin, 'cargo.exe'), cargoArgs, { cwd: SRC_TAURI, env });
  steps.push({ step: `cargo ${cargoArgs.join(' ')}`, ms: cargo.ms, tail: tail(cargo.stderr, 4) });

  const marker = {
    bundle,
    identifier,
    builtAt: new Date().toISOString(),
    exeMtimeMs: statSync(EXE).mtimeMs,
    exeSha256: sha256OfFile(EXE),
  };
  writeFileSync(BUILD_MARKER, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  return { steps, marker };
}

function tail(text, lines) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-lines);
}

function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ---------------------------------------------------------------------------
// the vite dev server, for `--bundle dev` only
// ---------------------------------------------------------------------------

async function vitePortHolder() {
  const pid = await listenerPid(VITE_PORT);
  if (pid === null) return null;
  const out = await powershell(
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
      'if ($p) { ConvertTo-Json -Compress -Depth 3 -InputObject ([ordered]@{ pid = $p.ProcessId; name = $p.Name; commandLine = $p.CommandLine }) }',
  );
  return out ? JSON.parse(out) : { pid, name: null, commandLine: null };
}

async function startVite(runDir) {
  const existing = await vitePortHolder();
  if (existing) return { started: false, holder: existing };
  const logPath = join(runDir, 'vite.log');
  const fd = openSync(logPath, 'a');
  const child = spawn('pnpm.cmd', ['dev'], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    shell: true,
  });
  child.unref();
  closeSync(fd);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const holder = await vitePortHolder();
    if (holder) return { started: true, holder, launcherPid: child.pid, logPath };
    await sleep(300);
  }
  throw new HarnessError(EXIT.FAILED, `vite did not bind ${VITE_PORT} within 60s; see ${logPath}`);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function queryFrom(flags) {
  const query = {};
  if (flags.selector !== undefined) query.selector = String(flags.selector);
  if (flags.role !== undefined) query.role = String(flags.role);
  if (flags.name !== undefined) query.name = String(flags.name);
  if (flags.text !== undefined) query.text = String(flags.text);
  if (flags.exact) query.exact = true;
  if (flags['include-hidden']) query.includeHidden = true;
  if (Object.keys(query).length === 0) {
    throw new HarnessError(
      EXIT.USAGE,
      'a query needs at least one of --selector, --role, --name, --text',
    );
  }
  return query;
}

async function resolveQuery(cdp, query) {
  return cdp.evaluate(`window.__velaHarness.resolve(${literal(query)})`);
}

/** Exactly-one-match discipline. Absence is exit 3; ambiguity is exit 4. */
function pickOne(result, query, flags) {
  if (result.count === 0) {
    throw new HarnessError(EXIT.NOT_FOUND, 'no element matched', {
      found: false,
      query,
      count: 0,
    });
  }
  if (flags.nth !== undefined) {
    const nth = Number(flags.nth);
    if (!Number.isInteger(nth) || nth < 0 || nth >= result.count) {
      throw new HarnessError(EXIT.USAGE, `--nth ${flags.nth} is outside 0..${result.count - 1}`);
    }
    return nth;
  }
  if (result.count > 1) {
    throw new HarnessError(
      EXIT.AMBIGUOUS,
      `${result.count} elements matched; narrow the query or pass --nth`,
      { query, count: result.count, matches: result.matches.slice(0, 10) },
    );
  }
  return 0;
}

const NAMED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8, text: '\b' },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };

function modifiersOf(flags) {
  if (!flags.modifiers) return 0;
  return String(flags.modifiers)
    .split(/[,+]/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .reduce((bits, name) => {
      const bit = MODIFIER_BITS[name];
      if (bit === undefined) throw new HarnessError(EXIT.USAGE, `unknown modifier "${name}"`);
      return bits | bit;
    }, 0);
}

/**
 * One key press. `Input.dispatchKeyEvent` needs `text` for anything that should
 * produce input — Enter is `"\r"`, not `"\n"` and not omitted — which has cost
 * this project time before, so the mapping is a table rather than a guess.
 */
async function pressKey(cdp, spec, modifiers = 0) {
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    modifiers,
  };
  // A modifier other than shift suppresses text input in a real browser, and
  // sending `text` anyway would make Ctrl+K type a "k".
  const wantsText = spec.text !== undefined && (modifiers & ~8) === 0;
  await cdp.send('Input.dispatchKeyEvent', {
    ...base,
    type: wantsText ? 'keyDown' : 'rawKeyDown',
    ...(wantsText ? { text: spec.text, unmodifiedText: spec.text } : {}),
  });
  await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

function keySpecFor(name) {
  if (NAMED_KEYS[name]) return NAMED_KEYS[name];
  if (name.length === 1) {
    const upper = name.toUpperCase();
    return {
      key: name,
      code: /[a-z]/i.test(name) ? `Key${upper}` : `Digit${name}`,
      keyCode: upper.charCodeAt(0),
      text: name,
    };
  }
  throw new HarnessError(
    EXIT.USAGE,
    `unknown key "${name}". Known: ${Object.keys(NAMED_KEYS).join(', ')}, or a single character.`,
  );
}

async function psJson(script, args) {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );
  const text = stdout.trim();
  if (!text) return null;
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const commands = {};

commands.help = async () => {
  process.stderr.write(USAGE);
  return { ok: true, usage: 'printed to stderr' };
};

commands.doctor = async (flags = {}) => {
  const vela = await runningVelaProcesses();
  const session = readSession();
  const port = flagNumber(flags, 'port', DEFAULT_PORT);
  const report = {
    repoRoot: REPO_ROOT,
    exePresent: existsSync(EXE),
    exeBuiltFor: readBuildMarker(),
    harnessRoot: HARNESS_ROOT,
    recordedSession: session,
    runningVelaProcesses: vela,
    debugPortHolder: await listenerPid(port),
    vitePortHolder: await vitePortHolder(),
    ready: vela.length === 0 || (session !== null && vela.every((p) => p.pid === session.pid)),
  };
  return report;
};

commands.up = async (flags) => {
  const bundle = String(flags.bundle ?? 'prod');
  if (bundle !== 'prod' && bundle !== 'dev') {
    throw new HarnessError(EXIT.USAGE, '--bundle must be prod or dev');
  }
  const appData = String(flags['app-data'] ?? 'isolated');
  if (appData !== 'isolated' && appData !== 'real') {
    throw new HarnessError(EXIT.USAGE, '--app-data must be isolated or real');
  }
  const identifier =
    flags.identifier !== undefined
      ? String(flags.identifier)
      : appData === 'real'
        ? SHIPPING_IDENTIFIER
        : ISOLATED_IDENTIFIER;
  const port = flagNumber(flags, 'port', DEFAULT_PORT);
  const scale = flags.scale === undefined ? null : Number(flags.scale);

  const existingSession = readSession();
  const running = await runningVelaProcesses();
  if (running.length > 0) {
    throw new HarnessError(
      EXIT.WRONG_PROCESS,
      `${running.length} vela.exe already running (pids ${running.map((p) => p.pid).join(', ')}). ` +
        'Refusing to launch: a second instance shares the WebView2 browser process when the profile ' +
        'is shared, and would silently ignore --remote-debugging-port. Run `down`, or stop them by hand.',
      { running, recordedSession: existingSession },
    );
  }
  const portHolder = await listenerPid(port);
  if (portHolder !== null) {
    throw new HarnessError(EXIT.WRONG_PROCESS, `port ${port} is already held by pid ${portHolder}`, {
      port,
      portHolder,
    });
  }

  const marker = readBuildMarker();
  const needsBuild =
    flags['no-build'] !== true &&
    (!existsSync(EXE) ||
      marker === null ||
      marker.bundle !== bundle ||
      marker.identifier !== identifier ||
      marker.exeMtimeMs !== statSync(EXE).mtimeMs);
  const buildReport = needsBuild ? await build({ bundle, identifier }) : { skipped: true, marker };
  if (!existsSync(EXE)) {
    throw new HarnessError(EXIT.FAILED, `no binary at ${EXE}; run without --no-build`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(HARNESS_ROOT, `run-${stamp}`);
  const profileDir = join(runDir, 'wv2');
  mkdirSync(profileDir, { recursive: true });

  let vite = null;
  if (bundle === 'dev') vite = await startVite(runDir);

  const browserArgs = [`--remote-debugging-port=${port}`];
  if (scale !== null) browserArgs.push(`--force-device-scale-factor=${scale}`);

  const logPath = join(runDir, 'vela.log');
  const fd = openSync(logPath, 'a');
  const child = spawn(EXE, [], {
    cwd: SRC_TAURI,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: false,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs.join(' '),
      // Not optional. Without a private profile a second WebView2 reuses the
      // first browser process and ignores the debugging port entirely.
      WEBVIEW2_USER_DATA_FOLDER: profileDir,
    },
  });
  child.unref();
  // The descriptor now belongs to the child. Leaving it open in this process
  // keeps a libuv handle alive that trips an assertion on abrupt exit.
  closeSync(fd);

  const pid = child.pid;
  let endpoint;
  try {
    endpoint = await waitForEndpoint(port, { timeoutMs: flagNumber(flags, 'timeout', 60_000) });
  } catch (error) {
    throw new HarnessError(error.code ?? EXIT.FAILED, `${error.message}. Log: ${logPath}`, {
      pid,
      logPath,
      logTail: existsSync(logPath) ? tail(readFileSync(logPath, 'utf8'), 20) : [],
    });
  }
  const ownership = await assertPortBelongsTo(port, pid);

  const session = {
    pid,
    port,
    bundle,
    appData,
    identifier,
    scale,
    exe: EXE,
    exeSha256: sha256OfFile(EXE),
    profileDir,
    runDir,
    logPath,
    vite,
    startedAt: new Date().toISOString(),
  };
  writeSession(session);

  const cdp = await CdpSession.connect(endpoint.target.webSocketDebuggerUrl);
  // Give the document time to finish loading before reporting the mount. This
  // waits for `complete`; it does NOT wait for the root to have children,
  // because "the renderer did not mount" must stay a reportable answer rather
  // than a timeout.
  const settleDeadline = Date.now() + 15_000;
  let readyState = null;
  while (Date.now() < settleDeadline) {
    await cdp.evaluate(BOOTSTRAP);
    readyState = await cdp.evaluate('document.readyState');
    if (readyState === 'complete') break;
    await sleep(250);
  }
  await sleep(500);
  await cdp.evaluate(BOOTSTRAP);
  const mount = await cdp.evaluate('window.__velaHarness.mountReport()');
  cdp.close();

  return {
    session,
    build: buildReport,
    version: endpoint.version,
    target: { url: endpoint.target.url, title: endpoint.target.title, id: endpoint.target.id },
    ownership,
    mount,
    appDataWarning:
      appData === 'real'
        ? `THIS RUN USES THE SHIPPING IDENTIFIER. Everything it does is written to ` +
          `%APPDATA%\\${SHIPPING_IDENTIFIER}, which is the user's real application data.`
        : `Application data goes to %APPDATA%\\${identifier}, not to ` +
          `%APPDATA%\\${SHIPPING_IDENTIFIER}. The identifier is the only config field that differs ` +
          `from the shipping build; see README "What this drives".`,
  };
};

commands.status = async () => {
  const session = await requireSession();
  const { cdp, page, ownership } = await attach(session);
  const mount = await cdp.evaluate('window.__velaHarness.mountReport()');
  const version = await cdpHttp(session.port, '/json/version');
  cdp.close();
  return { session, ownership, version, target: { url: page.url, title: page.title }, mount };
};

commands.mount = async () => {
  const session = await requireSession();
  const { cdp } = await attach(session);
  const report = await cdp.evaluate('window.__velaHarness.mountReport()');
  cdp.close();
  const mounted = report.rootPresent && report.rootDescendants > 0 && report.bodyTextChars > 0;
  return {
    mounted,
    verdict: mounted
      ? 'the renderer mounted: #root has descendants and the window has visible text'
      : 'THE RENDERER DID NOT MOUNT: #root is empty or the window has no text',
    report,
  };
};

commands.read = async (flags) => {
  const session = await requireSession();
  const { cdp } = await attach(session);
  const selector = flags.selector === undefined ? null : String(flags.selector);
  const limit = flagNumber(flags, 'limit', 0);
  const lines = await cdp.evaluate(
    `window.__velaHarness.visibleText(${literal(selector)}, ${literal(limit || null)})`,
  );
  cdp.close();
  if (lines === null) {
    throw new HarnessError(EXIT.NOT_FOUND, `no element matched selector ${selector}`, {
      found: false,
      selector,
    });
  }
  return { selector: selector ?? 'body', lineCount: lines.length, lines };
};

commands.find = async (flags) => {
  const session = await requireSession();
  const query = queryFrom(flags);
  const { cdp } = await attach(session);
  const result = await resolveQuery(cdp, query);
  cdp.close();
  const payload = { found: result.count > 0, query, count: result.count, matches: result.matches };
  if (flags.expect !== undefined) {
    const expected = Number(flags.expect);
    payload.expected = expected;
    payload.satisfied = result.count === expected;
    if (!payload.satisfied) {
      throw new HarnessError(
        result.count === 0 ? EXIT.NOT_FOUND : EXIT.AMBIGUOUS,
        `expected ${expected} match(es), found ${result.count}`,
        payload,
      );
    }
  } else if (result.count === 0) {
    throw new HarnessError(EXIT.NOT_FOUND, 'no element matched', payload);
  }
  return payload;
};

commands.click = async (flags) => {
  const session = await requireSession();
  const query = queryFrom(flags);
  // `os` by default. It is the only mechanism that is what a user's mouse does,
  // it self-tests before every use, and it works here — the earlier default of
  // `cdp` existed only because a bug in this harness made SendInput look dead.
  const via = String(flags.via ?? 'os');
  if (!['cdp', 'message', 'os'].includes(via)) {
    throw new HarnessError(EXIT.USAGE, '--via must be cdp, message or os');
  }
  const settle = flagNumber(flags, 'settle', 400);
  const digestSelector = flags.watch === undefined ? null : String(flags.watch);

  const { cdp } = await attach(session);
  const result = await resolveQuery(cdp, query);
  let index;
  try {
    index = pickOne(result, query, flags);
  } catch (error) {
    cdp.close();
    throw error;
  }
  const target = await cdp.evaluate(`window.__velaHarness.describeStored(${index})`);

  // Raising is its own step, before the click point is computed. Restoring a
  // minimised window moves it from (-32000,-32000) to where the user can see
  // it, so a screen coordinate read before the raise aims at nothing.
  let raise = null;
  if (via !== 'cdp') {
    raise = await psJson(join(HERE, 'os-input.ps1'), [
      '-Mode', 'raise',
      '-OwnerPid', String(session.pid),
    ]);
    await sleep(250);
  }

  const before = await cdp.evaluate(`window.__velaHarness.digest(${literal(digestSelector)})`);
  const point = await cdp.evaluate(`window.__velaHarness.pointFor(${index})`);
  await cdp.evaluate('window.__velaHarness.armPointerRecorder()');

  let delivery;
  if (via === 'cdp') {
    const common = { x: point.viewport.x, y: point.viewport.y, button: 'left', clickCount: 1 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...common, buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common, buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common, buttons: 0 });
    delivery = {
      mechanism: 'CDP Input.dispatchMouseEvent',
      isOsInput: false,
      note:
        'Enters the browser input pipeline ahead of hit-testing, so the page sees a trusted event ' +
        'at real coordinates. It is NOT an OS message and does not require the window to be focused.',
      at: point.viewport,
    };
  } else {
    const screenX = Math.round(point.screenCss.x * point.devicePixelRatio);
    const screenY = Math.round(point.screenCss.y * point.devicePixelRatio);
    let selfTest = null;
    if (via === 'os') {
      // SendInput returns "2 events accepted" whether or not anything is
      // delivered. Prove the mechanism works before using it, or a filtered
      // environment turns every click into a silent no-op that reads as a
      // failed feature rather than a failed harness.
      selfTest = await psJson(join(HERE, 'os-input.ps1'), ['-Mode', 'selftest']);
      if (selfTest?.sendInputSelfTest?.injectionWorks !== true) {
        cdp.close();
        throw new HarnessError(
          EXIT.FAILED,
          'SendInput is inert in this process tree: it reports success and moves nothing, so a ' +
            '--via os click would deliver nothing while looking fine. Use --via message (a Win32 ' +
            'WM_LBUTTONDOWN/UP through the window message loop) or --via cdp, and say which you used.',
          { selfTest, query, target },
        );
      }
    }
    const osReport = await psJson(join(HERE, 'os-input.ps1'), [
      '-Mode',
      via === 'os' ? 'sendinput' : 'message',
      '-X',
      String(screenX),
      '-Y',
      String(screenY),
      '-OwnerPid',
      String(session.pid),
      // A real click goes wherever the cursor is. If another application's
      // window covers that pixel, sending the buttons would click *their* UI.
      '-RequirePid',
      String(session.pid),
    ]);
    delivery =
      via === 'os'
        ? {
            mechanism: 'Win32 SendInput (MOUSEEVENTF_LEFTDOWN + LEFTUP) at a screen point',
            isOsInput: true,
            note:
              'A real press and release in the system input queue. Windows decides which window ' +
              'receives it; the harness does not tell the page anything. Preceded by a self-test ' +
              'proving injected input is not filtered here.',
            at: { screenPhysical: { x: screenX, y: screenY }, cssViewport: point.viewport },
            selfTest,
            raise,
            os: osReport,
          }
        : {
            mechanism: 'Win32 PostMessage WM_LBUTTONDOWN/WM_LBUTTONUP to the WebView2 child window',
            isOsInput: false,
            note:
              'The message goes through the target window’s own message loop and Chromium hit-tests ' +
              'the client coordinates exactly as for a user click, and the cursor really is over the ' +
              'element (SetCursorPos), so hover state is real. But the message never entered the ' +
              'system input queue and the window was chosen by the harness, not by the input stack. ' +
              'This is a Win32 message, not OS input.',
            at: { screenPhysical: { x: screenX, y: screenY }, cssViewport: point.viewport },
            raise,
            os: osReport,
          };
  }

  await sleep(settle);
  const hit = await cdp.evaluate(`window.__velaHarness.pointerHit(${index})`);
  const after = await cdp.evaluate(`window.__velaHarness.digest(${literal(digestSelector)})`);
  const afterTarget = await cdp.evaluate(`window.__velaHarness.describeStored(${index})`);
  cdp.close();

  const changed =
    before && after ? before.hash !== after.hash || before.elements !== after.elements : null;
  // `onTarget === true` is required, not merely "not false". A null answer
  // means the question could not be decided, and an undecided click is not a
  // clicked one.
  const landedOnTarget = hit.landed === true && hit.onTarget === true;
  const payload = {
    clicked: landedOnTarget,
    via,
    delivery,
    target,
    point,
    hit,
    before,
    after,
    changed,
    changedMeans:
      'the watched surface differs before and after. It is a DJB2 hash of innerText plus an ' +
      'element count, so ANY re-render moves it — including one caused by something other than ' +
      'this click, such as an overlay dismissing itself. It corroborates; it never establishes. ' +
      'Only `hit` establishes that the click reached the element.',
    targetAfter: afterTarget,
    verdict: delivery.os?.blocked
      ? `NOTHING WAS CLICKED — ${delivery.os.blockedReason}`
      : !hit.landed
        ? 'NO POINTER EVENT REACHED THE WINDOW — the click did not land'
        : hit.onTarget === false
          ? `a pointer event landed, but its target was ${hit.eventTarget?.tag ?? 'another element'}, ` +
            'not the element queried nor anything inside it. THE QUERIED ELEMENT WAS NOT CLICKED.'
          : hit.onTarget === null
            ? 'a pointer event landed but the queried element could not be re-read, so on-target is undecided'
            : changed === null
              ? 'the click landed on the queried element'
              : changed
                ? 'the click landed on the queried element, and the watched surface also changed'
                : 'the click landed on the queried element and the watched surface did not change',
  };
  if (!landedOnTarget) {
    // A click that did not land must not exit 0. This is the difference between
    // a harness and a rubber stamp.
    throw new HarnessError(EXIT.FAILED, payload.verdict, payload);
  }
  return payload;
};

commands.type = async (flags) => {
  const session = await requireSession();
  const query = queryFrom(flags);
  // `--text` is a *query* filter everywhere else in this CLI, so the string to
  // be typed is `--value`. Conflating the two silently searched for an element
  // containing the text about to be typed into it, and reported "not found".
  if (flags.value === undefined || flags.value === true) {
    throw new HarnessError(
      EXIT.USAGE,
      flags.text !== undefined
        ? 'type needs --value "..." for the text to type. --text is a query filter (match an ' +
          'element by its text), not the string to enter.'
        : 'type needs --value "..."',
    );
  }
  const text = String(flags.value);
  const { cdp } = await attach(session);
  const result = await resolveQuery(cdp, query);
  let index;
  try {
    index = pickOne(result, query, flags);
  } catch (error) {
    cdp.close();
    throw error;
  }
  const focused = await cdp.evaluate(`window.__velaHarness.focusStored(${index})`);
  if (!focused) {
    cdp.close();
    throw new HarnessError(EXIT.FAILED, 'the element did not take focus, so nothing was typed', {
      query,
      match: result.matches[index],
    });
  }
  if (flags.clear) {
    await cdp.evaluate(
      'document.activeElement && document.activeElement.select && document.activeElement.select()',
    );
    await pressKey(cdp, NAMED_KEYS.Backspace);
  }
  for (const character of text) {
    await pressKey(cdp, keySpecFor(character));
  }
  if (flags.enter) await pressKey(cdp, NAMED_KEYS.Enter);
  await sleep(flagNumber(flags, 'settle', 300));
  const value = await cdp.evaluate(
    '(() => { const el = document.activeElement; if (!el) return null; ' +
      "return { tag: el.tagName, value: 'value' in el ? el.value : el.textContent }; })()",
  );
  cdp.close();
  return {
    typed: text,
    charactersSent: [...text].length,
    enter: Boolean(flags.enter),
    mechanism:
      'CDP Input.dispatchKeyEvent per character, keyDown carrying `text` then keyUp. Enter is text "\\r".',
    isOsInput: false,
    target: result.matches[index],
    activeElementAfter: value,
  };
};

commands.key = async (flags) => {
  const session = await requireSession();
  if (flags.key === undefined || flags.key === true) {
    throw new HarnessError(EXIT.USAGE, 'key needs --key <name>');
  }
  const spec = keySpecFor(String(flags.key));
  const modifiers = modifiersOf(flags);
  const repeat = flagNumber(flags, 'repeat', 1);
  const { cdp } = await attach(session);
  const before = await cdp.evaluate('window.__velaHarness.digest(null)');
  for (let i = 0; i < repeat; i++) await pressKey(cdp, spec, modifiers);
  await sleep(flagNumber(flags, 'settle', 300));
  const after = await cdp.evaluate('window.__velaHarness.digest(null)');
  cdp.close();
  return {
    key: spec.key,
    code: spec.code,
    text: spec.text ?? null,
    modifiers,
    repeat,
    isOsInput: false,
    mechanism: 'CDP Input.dispatchKeyEvent',
    before,
    after,
    changed: before.hash !== after.hash || before.elements !== after.elements,
  };
};

commands.eval = async (flags) => {
  const session = await requireSession();
  const expression =
    flags.file !== undefined
      ? readFileSync(resolvePath(String(flags.file)), 'utf8')
      : flags.expr !== undefined && flags.expr !== true
        ? String(flags.expr)
        : null;
  if (expression === null) throw new HarnessError(EXIT.USAGE, 'eval needs --expr or --file');
  const { cdp } = await attach(session);
  const value = await cdp.evaluate(expression);
  cdp.close();
  return { value };
};

commands.screenshot = async (flags) => {
  const session = await requireSession();
  const out = resolvePath(String(flags.out ?? join(session.runDir, `shot-${Date.now()}.png`)));
  const { cdp } = await attach(session);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  cdp.close();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  return {
    path: out,
    bytes: statSync(out).size,
    note: 'Page.captureScreenshot captures the webview contents, not the OS window frame.',
  };
};

commands.appdata = async (flags) => {
  const session = readSession();
  const identifier = String(flags.identifier ?? session?.identifier ?? SHIPPING_IDENTIFIER);
  const dir = join(process.env.APPDATA ?? '', identifier);
  const listing = await powershell(
    `if (Test-Path ${JSON.stringify(dir)}) { ` +
      `Get-ChildItem -LiteralPath ${JSON.stringify(dir)} -Force -Recurse | ` +
      'ForEach-Object { [ordered]@{ path = $_.FullName; directory = $_.PSIsContainer; ' +
      'length = $(if ($_.PSIsContainer) { $null } else { $_.Length }); ' +
      'lastWrite = $_.LastWriteTimeUtc.ToString("o") } } | ' +
      'ConvertTo-Json -Compress -Depth 4 } else { "[]" }',
  );
  let entries = [];
  if (listing) {
    const parsed = JSON.parse(listing);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  }

  // EVERY entry is resolved, not only the root. MSIX redirection is
  // copy-on-write per entry: on this machine the `dev.vela.desktop` directory
  // resolves to the real path while `vela.db` inside it resolves into the
  // container. Resolving only the root reported "real" and hid exactly the
  // thing worth knowing — which is what the first version of this command did.
  const resolved = await psJson(join(HERE, 'final-path.ps1'), [
    dir,
    ...entries.map((entry) => entry.path),
  ]);
  const redirected = (resolved ?? []).filter((row) => row.inMsixContainer);
  const rootRow = (resolved ?? []).find((row) => row.expanded === dir);

  return {
    identifier,
    requestedDirectory: dir,
    method:
      'CreateFileW(FILE_FLAG_BACKUP_SEMANTICS) + GetFinalPathNameByHandleW on the directory AND ' +
      'on every entry inside it — the kernel’s answer, not the path that was asked for.',
    entryCount: entries.length,
    resolved,
    entries,
    summary: {
      rootIsReal: rootRow ? rootRow.inMsixContainer === false : null,
      entriesResolved: (resolved ?? []).length,
      entriesInContainer: redirected.length,
      note:
        redirected.length > 0 && rootRow?.inMsixContainer === false
          ? 'THE DIRECTORY IS REAL AND SOME OF ITS CONTENTS ARE NOT. Redirection is per entry, so a ' +
            'run driven from inside this container reads and writes the container copies listed above, ' +
            'not the files a human would see.'
          : redirected.length > 0
            ? 'This directory is inside the container and is invisible to the real machine.'
            : 'Nothing here resolved into a container.',
    },
  };
};

commands.down = async (flags) => {
  const session = readSession();
  const before = await runningVelaProcesses();
  const killed = [];
  const targets = flags.all
    ? before.map((p) => p.pid)
    : session
      ? [session.pid]
      : before.map((p) => p.pid);
  for (const pid of targets) {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      killed.push(pid);
    } catch (error) {
      killed.push({ pid, error: String(error.message ?? error).split('\n')[0] });
    }
  }
  if (session?.vite?.started && session.vite.holder?.pid) {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(session.vite.holder.pid), '/T', '/F'], {
        windowsHide: true,
      });
      killed.push(session.vite.holder.pid);
    } catch {
      /* the dev server was already gone; `remaining` below is the real check */
    }
  }

  const port = session?.port ?? DEFAULT_PORT;
  let holder = await listenerPid(port);
  for (let i = 0; i < 20 && holder !== null; i++) {
    await sleep(250);
    holder = await listenerPid(port);
  }
  const remaining = await runningVelaProcesses();

  // WebView2 runs the content in child processes of its own. `taskkill /T`
  // takes them with the host, but "no vela.exe" is not by itself evidence that
  // it did — so ask directly whether anything still holds this run's profile.
  let orphanedWebviews = [];
  if (session?.profileDir) {
    const out = await powershell(
      "Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" | " +
        `Where-Object { $_.CommandLine -like ${JSON.stringify(`*${session.profileDir}*`)} } | ` +
        'ForEach-Object { [ordered]@{ pid = $_.ProcessId } } | ConvertTo-Json -Compress -Depth 3',
    );
    if (out) {
      const parsed = JSON.parse(out);
      orphanedWebviews = Array.isArray(parsed) ? parsed : [parsed];
    }
  }

  clearSession();
  const clean = holder === null && remaining.length === 0 && orphanedWebviews.length === 0;
  return {
    killed,
    port,
    portClosed: holder === null,
    portHolderAfter: holder,
    remainingVelaProcesses: remaining,
    orphanedWebviews,
    profileDir: session?.profileDir ?? null,
    clean,
    verdict: clean
      ? 'stopped: the debug port is closed, no vela.exe remains, and nothing still holds the WebView2 profile'
      : 'NOT CLEAN — see portHolderAfter, remainingVelaProcesses and orphanedWebviews',
  };
};

const USAGE = `
vela-drive — launch Vela, click it, read what it shows.

  node tests/harness/desktop-click/vela-drive.mjs <command> [flags]

Lifecycle
  doctor                            what is running, what is built, is it safe to launch
  up   [--bundle prod|dev] [--app-data isolated|real] [--identifier ID]
       [--port 9222] [--scale 1.5] [--no-build] [--timeout ms]
  status                            session, CDP /json/version, mount report
  down [--all]                      stop, confirm the port closed, confirm no vela.exe

Reading
  mount                             did the renderer mount? (the one question)
  read [--selector CSS] [--limit N] visible text, line by line
  find  <query> [--expect N]        locate elements; exit 3 when nothing matches
  appdata [--identifier ID]         where app data really is (GetFinalPathNameByHandle)
  screenshot --out FILE             webview contents as PNG

Driving
  click <query> [--via os|message|cdp] [--nth N] [--watch CSS] [--settle ms]
        os       Win32 SendInput into the system input queue — what a mouse does (default)
        message  Win32 WM_LBUTTONDOWN/UP posted to the WebView2 window, cursor really over it
        cdp      CDP Input domain — browser input pipeline, ahead of hit-testing
  type  <query> --value "..." [--clear] [--enter]   (--value is typed; --text queries)
  key   --key Enter|Escape|Tab|ArrowDown|<char> [--modifiers ctrl,shift] [--repeat N]
  eval  --expr "..." | --file FILE

Query flags (ANDed; at least one required)
  --selector CSS   --role ROLE   --name TEXT   --text TEXT   --exact   --include-hidden

Exit codes
  0 ok   2 usage   3 nothing matched   4 ambiguous   5 no session   6 wrong process   7 failed

Read tests/harness/desktop-click/README.md before trusting a verdict built on
this: what a click is in each mode, which bytes are being driven, and where the
application data really goes.
`;

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === undefined || command === 'help' || flags.help) {
    process.stderr.write(USAGE);
    process.exit(command === undefined || command === 'help' ? EXIT.OK : EXIT.USAGE);
  }
  const handler = commands[command];
  if (!handler) {
    process.stderr.write(`unknown command "${command}"\n${USAGE}`);
    process.exit(EXIT.USAGE);
  }
  try {
    const result = await handler(flags);
    process.stdout.write(`${JSON.stringify({ command, ok: true, ...result }, null, 2)}\n`);
    finish(EXIT.OK);
  } catch (error) {
    const code = error instanceof HarnessError ? error.code : EXIT.FAILED;
    const payload = {
      command,
      ok: false,
      error: error.message,
      ...(error instanceof HarnessError ? error.detail : {}),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.stderr.write(`vela-drive ${command}: ${error.message}\n`);
    finish(code);
  }
}

/**
 * Exit with a code without calling `process.exit()` while a detached child's
 * handles are still being torn down — libuv asserts on that, and the assert
 * replaced a clean exit code with 0xC0000409 the first time `up` ran.
 * `process.exitCode` lets the loop drain; the timer is an unref'd backstop for
 * anything that forgets to close.
 */
function finish(code) {
  process.exitCode = code;
  // Unref'd, so it never keeps the process alive on its own — but if something
  // else does, it fires and exits with the code the command earned rather than
  // hanging or reporting a signal.
  const backstop = setTimeout(() => process.exit(code), 3000);
  backstop.unref();
}

await main();
