#!/usr/bin/env node
/**
 * Did the bundler produce installers, or did it merely exit 0?
 *
 *   node scripts/check-bundle.mjs [--target-dir <dir>] [--since <epoch-ms>]
 *                                 [--root <dir>] [--json]
 *
 * WHY AN EXIT CODE IS NOT THE ANSWER — THIS IS NOT HYPOTHETICAL
 *
 * `src-tauri/tauri.conf.json` carried `"bundle": { "active": true, "targets":
 * "all" }` while `bundle.icon` listed four PNGs and no `.ico`. The Windows
 * bundler needs an `.ico` in that list, so `pnpm tauri build` compiled the whole
 * Rust release tree, printed `Built application at: ...\vela.exe`, and then
 * died with `Error failed to bundle project: Couldn't find a .ico icon`. **No
 * installer of either kind was produced, and `cargo build` stayed green
 * throughout**, because `tauri-build` embeds the application icon by a
 * different path. That defect could sit behind a green build indefinitely.
 * `docs/release-posture.md` §6 is the record.
 *
 * So this guard asserts the ARTEFACT, on disk, and never a command's exit
 * status. That distinction is the whole reason the file exists.
 *
 * WHAT "THE ARTEFACT IS THERE" HAS TO MEAN, AND WHY EACH WEAKER VERSION FAILS
 *
 * Each of these passes the version above it while the tree is broken:
 *
 *  1. `exists`                — a zero-byte file left by a bundler killed
 *                               mid-write satisfies it.
 *  2. `+ size > 0`            — so does a one-line error log someone named
 *                               `Vela_0.1.0_x64_en-US.msi`.
 *  3. `+ format magic`        — an MSI is an OLE2 compound file
 *                               (D0 CF 11 E0 A1 B1 1A E1). A guard that reads
 *                               the first eight bytes cannot be fooled by a
 *                               text file.
 *  3b. `+ the installer's own signature`, where the magic is not specific
 *                               enough to be the question. `MZ` says "PE
 *                               image", and the application binary this build
 *                               also produces is a PE image. MEASURED, not
 *                               argued: copying `target/release/vela.exe`
 *                               (18,095,104 bytes) into `bundle/nsis/` under
 *                               the name `Vela_0.1.0_x64-setup.exe` cleared
 *                               every check in this list up to and including
 *                               step 7 and printed `BUNDLE_OK=yes`, exit 0 —
 *                               i.e. the guard certified the application as
 *                               its own installer, which is a near neighbour
 *                               of the very defect it exists for. So the NSIS
 *                               row demands NSIS's first-header signature,
 *                               `EF BE AD DE` + `NullsoftInst` — the SIXTEEN
 *                               bytes taken together, which is what `findBytes`
 *                               below searches for. Measured on this tree, in
 *                               the real 5,444,437-byte setup: those sixteen
 *                               bytes occur exactly once, beginning at offset
 *                               52,740. Neither half would do. The ASCII
 *                               `NullsoftInst` alone begins four bytes later,
 *                               at 52,744, and `EF BE AD DE` alone occurs
 *                               twice, first at 9,732. `vela.exe` carries the
 *                               sixteen bytes nowhere, and the substring
 *                               `Nullsoft` nowhere either. The MSI row
 *                               needs no such addition; OLE2's eight-byte
 *                               magic is already specific.
 *  4. `+ newer than --since`  — LAST WEEK'S INSTALLER SATISFIES ALL THREE. A
 *                               run that skipped bundling entirely passes on
 *                               the leavings of a run that did not. This is the
 *                               same stale-evidence trap as `check-rust-tail`.
 *  5. `+ version in the name` — a stale artefact from an older `version` in
 *                               tauri.conf.json is caught by name as well as by
 *                               mtime. Two independent readings of the same
 *                               fact, because mtime is the one a copy destroys.
 *  6. `+ EVERY declared target`, not "at least one". `"targets": "all"` on
 *                               Windows means msi AND nsis. A guard satisfied
 *                               by finding an installer passes when one of the
 *                               two silently stopped building.
 *  7. `+ a non-empty expectation set`. This is the one a guard is likeliest to
 *                               ship with: derive the expected set from config,
 *                               get an empty list, and pass vacuously. So
 *                               `bundle.active: false`, an empty `targets`, or
 *                               a platform this file has never been taught
 *                               about are all REFUSALS, not passes. "I do not
 *                               know what this machine produces" is a question,
 *                               not a green tick.
 *
 * WHERE THE EXPECTATION COMES FROM, AND THE ONE WAY IT CAN BE WRONG
 *
 * The expected set is derived from `src-tauri/tauri.conf.json` and from nothing
 * else. Tauri also accepts `--bundles <list>` on the command line and merges a
 * `tauri.<platform>.conf.json` if one exists; neither is read here. Checked on
 * this tree: `src-tauri/` contains exactly one `tauri*.json`. So a caller who
 * narrows the bundle set on the command line gets a red from this guard for
 * targets they deliberately skipped. That is fail-CLOSED — it complains about a
 * missing installer rather than certifying a partial build — and it is the
 * right way round for a release gate, but it is a real limitation and not an
 * oversight.
 *
 * WHAT IT STILL DOES NOT CLAIM. A file with the right magic, size, name and
 * mtime is an installer-shaped object; it is not a proof that the installer
 * installs. That verdict belongs to running it, and on this machine it cannot
 * be reached — see `docs/release-posture.md` §12 and
 * `scripts/check-real-path.ps1`. Nor does this say anything about signing:
 * `Get-AuthenticodeSignature` reports `NotSigned`, deliberately and by
 * configuration, and that is recorded rather than gated.
 *
 * READERS: `scripts/bundle.mjs` runs it after driving the bundler;
 * `src/platform/bundle-guard.test.ts` drives it against synthetic bundle trees,
 * one per numbered failure above; `src/platform/bundle-runner.test.ts` reaches
 * it through `bundle.mjs` and reads its output from that log;
 * `package.json` exposes it as `pnpm bundle:check`.
 */

import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The bundle targets each platform's bundler produces for `"targets": "all"`,
 * and the shape of what each one leaves on disk.
 *
 * `magic` is the leading byte sequence of the format, as hex.
 *
 * `signature` is a byte sequence that must appear SOMEWHERE in the file, for
 * the formats whose leading magic is not specific enough to answer the
 * question. Only `nsis` has one, and step 3b of the header is the measurement
 * that says why.
 *
 * `minBytes` is a deliberate sanity FLOOR, not a measurement of the artefacts.
 * Re-measured on this tree at the commit this line ships in, from
 * `src-tauri/target/release/bundle/`: the MSI is 7,360,512 bytes and the NSIS
 * setup is 5,444,437 bytes. Those are two observations of one build on one
 * machine, not a range the artefacts are known to stay inside; the floor sits
 * an order of magnitude below the smaller of them so that a legitimate shrink
 * is not a false red while a truncation still is.
 */
const TARGET_SHAPES = {
  msi: { dir: 'msi', ext: '.msi', magic: 'd0cf11e0a1b11ae1', signature: null, minBytes: 262144, what: 'MSI (OLE2 compound file)' },
  // `EF BE AD DE` (0xDEADBEEF little-endian) immediately followed by the ASCII
  // `NullsoftInst`: the first-header signature NSIS writes ahead of its
  // compressed payload. See step 3b.
  nsis: {
    dir: 'nsis',
    ext: '.exe',
    magic: '4d5a',
    signature: { hex: 'efbeadde4e756c6c736f6674496e7374', what: "NSIS's first-header signature (DEADBEEF + NullsoftInst)" },
    minBytes: 262144,
    what: 'NSIS setup (PE image carrying an NSIS payload)',
  },
  deb: { dir: 'deb', ext: '.deb', magic: '213c617263683e', signature: null, minBytes: 65536, what: 'Debian package (ar archive)' },
  rpm: { dir: 'rpm', ext: '.rpm', magic: 'edabeedb', signature: null, minBytes: 65536, what: 'RPM package' },
  appimage: { dir: 'appimage', ext: '.AppImage', magic: '7f454c46', signature: null, minBytes: 262144, what: 'AppImage (ELF)' },
  dmg: { dir: 'dmg', ext: '.dmg', magic: null, signature: null, minBytes: 262144, what: 'macOS disk image' },
  app: { dir: 'macos', ext: '.app', magic: null, signature: null, minBytes: 0, what: 'macOS application bundle' },
};

/** What `"targets": "all"` expands to, per platform. */
const ALL_TARGETS = {
  win32: ['msi', 'nsis'],
  linux: ['deb', 'rpm', 'appimage'],
  darwin: ['app', 'dmg'],
};

function parseArgs(argv) {
  const options = { root: REPO_ROOT, targetDir: null, since: null, json: false, platform: process.platform };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--json') {
      options.json = true;
      continue;
    }
    const value = argv[i + 1];
    if (flag === '--root') {
      options.root = value;
    } else if (flag === '--target-dir') {
      options.targetDir = value;
    } else if (flag === '--since') {
      options.since = Number(value);
    } else if (flag === '--platform') {
      // So the platform table above can be exercised from any host. Vela's own
      // unit suite runs on `ubuntu-latest` as well as `windows-latest`, and a
      // test of the Windows expectations that only runs on Windows is a test of
      // the Windows expectations that CI mostly does not run. Default is the
      // real platform; nothing in the product passes this.
      options.platform = value;
    } else {
      process.stderr.write('check-bundle: unknown argument ' + String(flag) + '\n');
      process.exit(2);
    }
    i += 1;
  }
  if (options.since !== null && !Number.isFinite(options.since)) {
    process.stderr.write('check-bundle: --since needs a number of milliseconds\n');
    process.exit(2);
  }
  return options;
}

/**
 * Where `needle` first appears in the file, or -1.
 *
 * Read whole rather than streamed on purpose. The artefacts this is pointed at
 * are installers and, in the failure case step 3b was written for, an
 * application binary — 18,095,104 bytes was the largest measured on this tree.
 * A chunked scan would need overlap handling to avoid missing a needle that
 * straddles a boundary, and getting that wrong is a silent false GREEN, which
 * is the one direction this file must not fail in. The guard runs once per
 * build.
 */
function findBytes(path, needleHex) {
  const body = readFileSync(path);
  return body.indexOf(Buffer.from(needleHex, 'hex'));
}

function leadingBytesHex(path, count) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(count);
    const read = readSync(fd, buffer, 0, count, 0);
    return buffer.subarray(0, read).toString('hex');
  } finally {
    closeSync(fd);
  }
}

/**
 * The set of installers this configuration says it will produce. Refuses rather
 * than returning an empty list; see point 7 in the header.
 */
function expectedTargets(config, platform) {
  const bundle = config.bundle ?? {};
  if (bundle.active !== true) {
    return { error: 'tauri.conf.json has bundle.active !== true, so no installer is produced at all. That is a configuration decision, not a passing build.' };
  }
  const declared = bundle.targets;
  const known = ALL_TARGETS[platform];
  if (known === undefined) {
    return { error: 'this guard has not been taught what platform "' + platform + '" produces. Teach it before trusting a green run from it.' };
  }
  let names;
  if (declared === 'all' || declared === undefined) {
    names = known;
  } else if (typeof declared === 'string') {
    names = [declared];
  } else if (Array.isArray(declared)) {
    // A cross-platform list; keep only what this platform's bundler makes.
    names = declared.filter((name) => known.includes(name));
  } else {
    return { error: 'bundle.targets is neither a string nor an array; this guard cannot read it.' };
  }
  names = names.filter((name) => TARGET_SHAPES[name] !== undefined);
  if (names.length === 0) {
    return { error: 'bundle.targets resolves to no installer on ' + platform + '. An empty expectation set passes every check ever written against it, so it is refused.' };
  }
  return { names };
}

function checkBundle({ root, targetDir, since, platform = process.platform }) {
  const configPath = join(root, 'src-tauri', 'tauri.conf.json');
  if (!existsSync(configPath)) {
    return { fatal: 'no tauri.conf.json at ' + configPath, rows: [], ok: false };
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const version = String(config.version ?? '');
  const expected = expectedTargets(config, platform);
  if (expected.error !== undefined) {
    return { fatal: expected.error, rows: [], ok: false, version };
  }

  const bundleRoot = join(targetDir ?? join(root, 'src-tauri', 'target'), 'release', 'bundle');
  const rows = [];

  for (const name of expected.names) {
    const shape = TARGET_SHAPES[name];
    const dir = join(bundleRoot, shape.dir);
    if (!existsSync(dir)) {
      rows.push({ target: name, verdict: 'NO-DIR', path: dir, detail: 'the bundler produced no ' + name + ' directory' });
      continue;
    }
    const candidates = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (name === 'app' ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name)
      .filter((file) => extname(file).toLowerCase() === shape.ext.toLowerCase());

    if (candidates.length === 0) {
      rows.push({ target: name, verdict: 'ABSENT', path: dir, detail: 'no ' + shape.ext + ' in ' + shape.dir + '/' });
      continue;
    }

    for (const file of candidates) {
      const path = join(dir, file);
      const stat = statSync(path);
      const row = { target: name, file, path, bytes: stat.size, mtimeMs: stat.mtimeMs };

      if (stat.size < shape.minBytes) {
        rows.push({ ...row, verdict: 'TRUNCATED', detail: String(stat.size) + ' bytes, below the ' + String(shape.minBytes) + '-byte floor' });
        continue;
      }
      if (shape.magic !== null && !stat.isDirectory()) {
        const head = leadingBytesHex(path, shape.magic.length / 2);
        if (head !== shape.magic) {
          rows.push({ ...row, verdict: 'NOT-A-' + name.toUpperCase(), detail: 'leading bytes ' + head + ', expected ' + shape.magic + ' for ' + shape.what });
          continue;
        }
      }
      if (shape.signature !== null && !stat.isDirectory()) {
        const at = findBytes(path, shape.signature.hex);
        if (at < 0) {
          rows.push({
            ...row,
            verdict: 'APP-NOT-INSTALLER',
            detail:
              'nowhere in this file is ' + shape.signature.what + '. The leading bytes ' +
              'say PE image, which the application binary also is; this is not an installer.',
          });
          continue;
        }
        // WHERE it was found, not merely that it was. Read by
        // `src/platform/bundle-guard.test.ts`, 'the --json row says WHERE the
        // NSIS signature was found', which drives this guard over a synthetic
        // tree that embeds the sequence at a known offset and asserts this
        // field equals it. Without that reader, a `findBytes` that returned any
        // non-negative number on a hit would satisfy every other assertion
        // anyone has written about this guard — measured twice: replacing the
        // `indexOf` in `findBytes` with `includes(...) ? 0 : -1` reds that one
        // test and nothing else across the five release-path test files,
        // `1 failed | 86 passed (87)`, with `expected +0 to be 52740`.
        row.signatureAt = at;
      }
      if (version !== '' && !file.includes(version)) {
        rows.push({ ...row, verdict: 'WRONG-VERSION', detail: 'name does not carry version ' + version + ' from tauri.conf.json' });
        continue;
      }
      if (since !== null && since !== undefined && stat.mtimeMs < since) {
        rows.push({ ...row, verdict: 'STALE', detail: 'written ' + new Date(stat.mtimeMs).toISOString() + ', before this build started' });
        continue;
      }
      rows.push({ ...row, verdict: 'OK', detail: String(stat.size) + ' bytes, ' + shape.what });
    }
  }

  // Every declared target must have at least one OK artefact. "Some artefact
  // somewhere is OK" is point 6 in the header and is not the question.
  const satisfied = new Set(rows.filter((row) => row.verdict === 'OK').map((row) => row.target));
  const missing = expected.names.filter((name) => !satisfied.has(name));

  return { rows, expected: expected.names, missing, version, bundleRoot, ok: missing.length === 0 };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = checkBundle(options);

  // In `--json` mode stdout is the JSON document and nothing else, so a caller
  // can parse it without stripping anything. The `BUNDLE_OK=` marker exists for
  // the human log body, where it is the line that says what happened; the JSON
  // already carries `ok`, so repeating it on stdout would only make the
  // document unparseable. Diagnostics go to stderr either way.
  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    if (result.bundleRoot !== undefined) {
      process.stdout.write('check-bundle: ' + result.bundleRoot + '\n');
      process.stdout.write('check-bundle: expecting ' + result.expected.join(', ') + ' for version ' + result.version + '\n');
    }
    for (const row of result.rows) {
      process.stdout.write('  ' + row.verdict.padEnd(18) + ' ' + String(row.file ?? row.path) + '  ' + row.detail + '\n');
    }
  }

  if (result.fatal !== undefined) {
    process.stderr.write('check-bundle: REFUSED - ' + result.fatal + '\n');
    if (!options.json) process.stdout.write('BUNDLE_OK=no\n');
    process.exit(1);
  }
  if (!result.ok) {
    process.stderr.write(
      'check-bundle: FAILED - no acceptable installer for: ' +
        result.missing.join(', ') +
        '\nA bundler exit code of 0 does not mean an installer exists; that is what\n' +
        'this guard is for. See docs/release-posture.md section 6.\n',
    );
    if (!options.json) process.stdout.write('BUNDLE_OK=no\n');
    process.exit(1);
  }

  if (!options.json) {
    process.stdout.write('check-bundle: every declared target produced an installer.\n');
    process.stdout.write('BUNDLE_OK=yes\n');
  }
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main();
