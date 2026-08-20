/**
 * A minimal Chrome DevTools Protocol client for WebView2, with the one check
 * that makes attaching safe on this machine.
 *
 * ## Why the ownership check is the important part of this file
 *
 * Every instance of Vela shares the bundle identifier `dev.vela.desktop`, and
 * there is no single-instance guard in the tree. WebView2 keys its browser
 * process on the **user-data folder**, so a second window opened against the
 * same profile is served by the *first* browser process and the
 * `--remote-debugging-port` argument on the second one is simply ignored. The
 * observable result is a CDP endpoint that answers perfectly while belonging to
 * a process you did not start, driving a window you cannot see.
 *
 * `assertPortBelongsTo()` therefore resolves the pid that actually holds the
 * listening socket and walks its parent chain. WebView2 opens the port from
 * `msedgewebview2.exe`, a *descendant* of the host `vela.exe`, so ancestry —
 * not equality — is the correct relation. If our pid is not on that chain we
 * refuse rather than measure the wrong window.
 *
 * No dependencies: Node 22+ ships a global `WebSocket` and `fetch`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Exit codes the CLI maps onto process.exit; see README. */
export const EXIT = {
  OK: 0,
  USAGE: 2,
  NOT_FOUND: 3,
  AMBIGUOUS: 4,
  NO_SESSION: 5,
  WRONG_PROCESS: 6,
  FAILED: 7,
};

export class HarnessError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** `powershell -NoProfile -Command <script>`, returning trimmed stdout. */
export async function powershell(script) {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  return stdout.trim();
}

/** Every `vela.exe` currently running, with its full image path. */
export async function runningVelaProcesses() {
  const out = await powershell(
    "Get-CimInstance Win32_Process -Filter \"Name = 'vela.exe'\" | " +
      'Select-Object ProcessId, ParentProcessId, ExecutablePath | ConvertTo-Json -Compress -Depth 3',
  );
  if (!out) return [];
  const parsed = JSON.parse(out);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
    pid: p.ProcessId,
    parentPid: p.ParentProcessId,
    path: p.ExecutablePath ?? null,
  }));
}

/**
 * The pid holding the listening socket on `port`, or `null`.
 *
 * `Get-NetTCPConnection` is used rather than `netstat -ano` because it returns
 * the owning pid as a number in a structured object, with no locale-dependent
 * column parsing.
 */
export async function listenerPid(port) {
  const out = await powershell(
    `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
      'Select-Object -First 1; if ($c) { $c.OwningProcess } else { "" }',
  );
  const pid = Number.parseInt(out, 10);
  return Number.isFinite(pid) ? pid : null;
}

/** `[pid, parent, grandparent, ...]` walking up from `pid`, cycle-safe. */
export async function ancestryOf(pid) {
  const out = await powershell(
    `$chain = @(); $p = ${pid}; $seen = @{}; ` +
      'for ($i = 0; $i -lt 12; $i++) { ' +
      '  if ($seen.ContainsKey($p)) { break }; $seen[$p] = $true; ' +
      '  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $p" -ErrorAction SilentlyContinue; ' +
      '  if (-not $proc) { break }; ' +
      '  $chain += [pscustomobject]@{ pid = $proc.ProcessId; name = $proc.Name }; ' +
      '  $p = $proc.ParentProcessId; if (-not $p -or $p -eq 0) { break } ' +
      '} ' +
      'ConvertTo-Json -Compress -Depth 3 -InputObject @($chain)',
  );
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Refuses unless the process holding `port` is `expectedPid` or one of its
 * descendants. Returns the evidence so a caller can print it.
 */
export async function assertPortBelongsTo(port, expectedPid) {
  const owner = await listenerPid(port);
  if (owner === null) {
    throw new HarnessError(EXIT.WRONG_PROCESS, `nothing is listening on port ${port}`, {
      port,
      expectedPid,
    });
  }
  const chain = await ancestryOf(owner);
  const owned = chain.some((entry) => entry.pid === expectedPid);
  if (!owned) {
    throw new HarnessError(
      EXIT.WRONG_PROCESS,
      `port ${port} is held by pid ${owner}, which is not pid ${expectedPid} nor a descendant of it. ` +
        'Refusing to attach: this is what a shared WebView2 profile looks like.',
      { port, expectedPid, listenerPid: owner, ancestry: chain },
    );
  }
  return { listenerPid: owner, ancestry: chain };
}

/** `GET http://127.0.0.1:<port><path>` as JSON, with a short timeout. */
export async function cdpHttp(port, path, timeoutMs = 5000) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new HarnessError(EXIT.FAILED, `CDP ${path} answered ${response.status}`);
  }
  return response.json();
}

/** A page target's URL is blank when nothing has navigated it yet. */
export function isBlankTarget(target) {
  return !target || !target.url || target.url === 'about:blank';
}

/** The application page among the CDP targets, preferring a navigated one. */
export function pickPage(targets) {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  return pages.find((t) => t.url && t.url !== 'about:blank') ?? pages[0];
}

/**
 * Waits for `/json/version` to answer, then for a `page` target to exist.
 * Returns `{ version, target, targets, acceptedBecause }`.
 *
 * **`acceptedBecause` is the field that matters, and it did not exist.** The
 * last-resort branch below admits an `about:blank` page target once the
 * deadline is within 3s, and said nothing about having done so. Everything
 * downstream then measured a blank document: `about:blank` reports
 * `document.readyState === 'complete'` on its first sample and forever, so any
 * readiness wait over that target is vacuous, and `mountReport()` describes a
 * document that is not Vela. The caller now gets told which branch fired, and
 * `mount-grade.mjs`'s `target-provenance` criterion fails on the fallback.
 *
 * The fallback is kept rather than removed: attaching to a blank target and
 * reporting a blank document is still a better answer than throwing "no page
 * target", because it distinguishes "the window never navigated" from "the
 * debug port never came up". It just may no longer be silent.
 */
export async function waitForEndpoint(port, { timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const version = await cdpHttp(port, '/json/version', 2000);
      const targets = await cdpHttp(port, '/json/list', 2000);
      // The first page target appears as `about:blank` before Tauri navigates
      // it. Attaching there reports a blank window and calls it a mount
      // failure, which is the most expensive wrong answer this harness could
      // give — so a blank target is only accepted once the deadline is near.
      const page = pickPage(targets);
      if (page && !isBlankTarget(page)) {
        return { version, target: page, targets, acceptedBecause: 'navigated' };
      }
      if (page && Date.now() > deadline - 3000) {
        return {
          version,
          target: page,
          targets,
          acceptedBecause: 'blank-fallback-at-deadline',
          acceptedBecauseMeans:
            `no page target on port ${port} had navigated within ${timeoutMs}ms, so the last ` +
            'page target was accepted even though its url is about:blank. Nothing measured over ' +
            'this target is about Vela: about:blank is readyState "complete" from the first ' +
            'sample, so a readiness wait over it waits zero times and succeeds.',
        };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new HarnessError(
    EXIT.FAILED,
    `no CDP page target on port ${port} within ${timeoutMs}ms` +
      (lastError ? ` (last error: ${lastError.message})` : ''),
  );
}

/** One CDP session over one WebSocket. Command ids are per-connection. */
export class CdpSession {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #events = [];

  static async connect(webSocketDebuggerUrl, { timeoutMs = 10_000 } = {}) {
    const session = new CdpSession();
    await session.#open(webSocketDebuggerUrl, timeoutMs);
    return session;
  }

  #open(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.#socket = socket;
      const timer = setTimeout(() => {
        reject(new HarnessError(EXIT.FAILED, `CDP websocket did not open within ${timeoutMs}ms`));
        try {
          socket.close();
        } catch {
          /* the connection never opened; nothing to close cleanly */
        }
      }, timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new HarnessError(EXIT.FAILED, `CDP websocket error: ${event.message ?? 'unknown'}`));
      });
      socket.addEventListener('message', (event) => this.#receive(event.data));
      socket.addEventListener('close', () => {
        for (const { reject: rejectPending } of this.#pending.values()) {
          rejectPending(new HarnessError(EXIT.FAILED, 'CDP websocket closed mid-command'));
        }
        this.#pending.clear();
      });
    });
  }

  #receive(raw) {
    const message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    if (message.id === undefined) {
      this.#events.push(message);
      if (this.#events.length > 500) this.#events.shift();
      return;
    }
    const waiter = this.#pending.get(message.id);
    if (!waiter) return;
    this.#pending.delete(message.id);
    if (message.error) {
      waiter.reject(
        new HarnessError(EXIT.FAILED, `CDP ${waiter.method} failed: ${message.error.message}`),
      );
    } else {
      waiter.resolve(message.result);
    }
  }

  send(method, params = {}, { timeoutMs = 30_000 } = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HarnessError(EXIT.FAILED, `CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * `Runtime.evaluate` with the settings that make results usable: the
   * expression is awaited if it returns a promise, and the value comes back by
   * value rather than as a remote handle.
   */
  async evaluate(expression, { timeoutMs = 30_000 } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
        includeCommandLineAPI: false,
      },
      { timeoutMs },
    );
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'unknown page exception';
      throw new HarnessError(EXIT.FAILED, `page threw: ${text}`);
    }
    return result.result?.value;
  }

  close() {
    try {
      this.#socket.close();
    } catch {
      /* already closed; the process is going away either way */
    }
  }
}
