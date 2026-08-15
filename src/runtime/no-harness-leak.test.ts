/**
 * The three rules `contract-harness.ts` states structurally and enforces
 * nowhere: no surface branches on a harness id, a model target is transported
 * and never inspected, and a harness performs no I/O of its own.
 *
 * The contract's header said the first one plainly — that the rule "has **no
 * test behind it**", and that `src/platform/no-provider-leak.test.ts` scans the
 * renderer for *backend* identities and "has never heard of a harness id". This
 * file is that test, so that sentence stopped being true when it was written;
 * amendment 5 in `src/platform/contract-harness.ts` records the correction, and
 * the sibling scan is still exactly as blind to a harness id as it was.
 *
 * All three rules here are prophylactic — the tree is clean today — and all
 * three are the kind that the next surface breaks:
 *
 *  - the settings picker the contract keeps describing is exactly where somebody
 *    writes `id === 'agent-loop' ? … : …`, and from that moment adding a harness
 *    stops being a zero-change operation under `src/` and a user who picks a new
 *    runtime silently gets a UI shaped for a different one;
 *  - `providerId === 'workstation'` is the spelling a builder reaches for when
 *    one endpoint needs a workaround, and it is invisible to the vendor-name
 *    scan because it names no vendor;
 *  - a harness that imported `@/data` or the adapter directly would be one the
 *    composition root cannot substitute in a test, and one that can write
 *    settings and delete conversations while driving a turn — the blanket grant
 *    conventions §3.4 exists to refuse.
 *
 * Written in the style of `src/platform/no-provider-leak.test.ts` and
 * `src/runtime/reachable.test.ts`, including their discipline about vacuity:
 * every emptiness check below is paired with a control that fails if the
 * machinery underneath it has stopped reading anything.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_HARNESS_DEFINITIONS } from './harness-runtime';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const RUNTIME_ROOT = join(SRC_ROOT, 'runtime');

/**
 * The ids as the registry actually holds them, not as a literal written here.
 *
 * A copy would go stale the day one is renamed, and a scan for a name nothing
 * uses is a guard that passes because it is looking for the wrong thing.
 */
const REGISTERED_IDS = DEFAULT_HARNESS_DEFINITIONS.map((definition) => definition.descriptor.id);

/**
 * The two files allowed to hold a harness id as a literal, each with its reason.
 * Both are asserted in both directions below: an exemption that has silently
 * stopped applying reads exactly like a clean tree.
 */
const MAY_NAME_AN_ID = new Map<string, string>([
  [
    'src/runtime/agent-loop-harness.ts',
    'the definitions themselves — an id has to be written down once, and this is where',
  ],
  [
    'src/runtime/run-doubles.ts',
    'the doubles this directory’s tests are built from, exempt here for the same ' +
      'reason `src/runtime/reachable.test.ts` exempts it from the import walk',
  ],
]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function sourceFiles(directory: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path, extensions));
    else if (extensions.includes(extname(entry.name))) found.push(path);
  }
  return found;
}

function asRepoPath(file: string): string {
  return relative(REPO_ROOT, file).split('\\').join('/');
}

function shippingFiles(root: string, extensions: readonly string[] = ['.ts', '.tsx']): string[] {
  return sourceFiles(root, extensions).filter((path) => !/\.test\.[a-z]+$/.test(path));
}

/** `file:line — the offending line`, so a failure names the branch, not the file. */
function offences(path: string, source: string, matches: (line: string) => boolean): string[] {
  return source
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => matches(line))
    .map(({ line, number }) => `${asRepoPath(path)}:${number} — ${line}`);
}

/* -------------------------------------------------------------------------- */

/** A registered harness id written as a literal — a `switch`, a ternary, a map key. */
function namesAHarnessId(line: string): boolean {
  return REGISTERED_IDS.some(
    (id) => line.includes(`'${id}'`) || line.includes(`"${id}"`) || line.includes(`\`${id}\``),
  );
}

/**
 * A `harnessId` treated as a value with meaning: matched against a literal, used
 * as a lookup key, or picked apart.
 *
 * Carrying one is the ordinary case and is what `RunRequest.harnessId` is for —
 * the directory resolves it through the registry, which is a `Map` lookup and
 * not a branch.
 */
function inspectsAHarnessId(line: string): boolean {
  return (
    /\bharnessId\b\s*(?:===|!==)\s*['"`]/.test(line) ||
    /['"`]\s*(?:===|!==)\s*\bharnessId\b/.test(line) ||
    /\[\s*\w*\.?\bharnessId\b\s*\]/.test(line) ||
    /\bharnessId\b\s*\.\s*(?!length\b|trim\b)\w/.test(line)
  );
}

/** A model target's id compared against a hard-coded name. */
function comparesATargetToALiteral(line: string): boolean {
  return (
    /\b(?:provider|model)Id\b\s*(?:===|!==)\s*['"`]/.test(line) ||
    /['"`]\s*(?:===|!==)\s*\b\w*(?:provider|model)Id\b/i.test(line)
  );
}

/**
 * A model target's id used as a lookup key or picked apart. `trim` and `length`
 * are exempt for the reason the sibling guard gives: normalising or measuring a
 * string the user typed says nothing about which backend it names.
 */
function readsATargetId(line: string): boolean {
  return (
    /\[\s*\w*\.?\b(?:provider|model)Id\b\s*\]/.test(line) ||
    /\b(?:provider|model)Id\b\s*\.\s*(?!length\b|trim\b)\w/.test(line)
  );
}

/** An import that reaches the host directly rather than through the seam. */
function reachesTheHost(line: string): boolean {
  if (/^\s*import\s+type\b/.test(line)) return false;
  if (/from\s+['"]@\/data\//.test(line)) return true;
  return /from\s+['"]@\/platform\/adapter['"]/.test(line);
}

/* -------------------------------------------------------------------------- */

describe('no surface branches on a harness id', () => {
  it('finds the ids from the registry rather than from a literal here', () => {
    // The control for every scan below: an empty or stale id list would make all
    // of them pass by looking for nothing.
    expect(REGISTERED_IDS.length).toBeGreaterThan(1);
    for (const id of REGISTERED_IDS) expect(id).toMatch(/^[a-z][a-z-]+$/);
  });

  it('never writes a registered id as a literal outside the definitions', () => {
    const offenders = shippingFiles(SRC_ROOT, ['.ts', '.tsx', '.css'])
      .filter((path) => !MAY_NAME_AN_ID.has(asRepoPath(path)))
      .flatMap((path) => offences(path, stripComments(readFileSync(path, 'utf8')), namesAHarnessId));

    expect(
      offenders,
      'adding a harness must be a zero-change operation under src/; a literal id is where that stops',
    ).toEqual([]);
  });

  it('never inspects a harness id, wherever it is carried', () => {
    const offenders = shippingFiles(SRC_ROOT).flatMap((path) =>
      offences(path, stripComments(readFileSync(path, 'utf8')), inspectsAHarnessId),
    );

    expect(
      offenders,
      'the UI branches on capability flags, never on an identity — conventions §0 rule 3',
    ).toEqual([]);
  });

  it('names its exemptions, and each is still earning its place', () => {
    for (const [path, reason] of MAY_NAME_AN_ID) {
      const source = stripComments(readFileSync(join(REPO_ROOT, path), 'utf8'));
      expect(
        offences(join(REPO_ROOT, path), source, namesAHarnessId).length,
        `${path} no longer names an id (${reason}); delete the exemption rather than leaving it open`,
      ).toBeGreaterThan(0);
    }
  });

  it('the scan catches the branch it exists for', () => {
    const id = REGISTERED_IDS[0] ?? '';
    expect(namesAHarnessId(`if (definition.descriptor.id === '${id}') return <StepList />;`)).toBe(
      true,
    );
    expect(namesAHarnessId(`case "${id}":`)).toBe(true);
    expect(inspectsAHarnessId("if (request.harnessId === 'whatever') return null;")).toBe(true);
    expect(inspectsAHarnessId('const icon = ICONS[request.harnessId];')).toBe(true);
    expect(inspectsAHarnessId('const family = harnessId.split("-")[0];')).toBe(true);

    // …and stays quiet on the vocabulary the seam is built out of.
    expect(namesAHarnessId('const definition = registry.find(request.harnessId);')).toBe(false);
    expect(inspectsAHarnessId('readonly harnessId: HarnessId;')).toBe(false);
    expect(inspectsAHarnessId('harnessId: definition.descriptor.id,')).toBe(false);
    expect(inspectsAHarnessId('if (harnessId.trim() === selected) return;')).toBe(false);
  });
});

describe('a model target is transported, never inspected', () => {
  // "`ModelTarget`: transported, never inspected. A harness passes these through
  // to `chat_send` and must not read either string for anything else — the
  // moment one is compared against a literal, adding a backend stops being a
  // zero-change operation under `src/`."
  //
  // The sibling guard scans the whole renderer for *vendor* names and the model
  // and app surfaces for id inspection. A comparison against a user-configured
  // provider id names no vendor and lives in neither of those directories, so
  // the runtime — the layer that holds a `ModelTarget` on every turn — was
  // covered by nothing.

  it('is held over a directory with model targets in it', () => {
    const files = shippingFiles(RUNTIME_ROOT);
    expect(files.length, 'the runtime moved; fix this path').toBeGreaterThan(5);
    const mentions = files.filter((path) => /\bproviderId\b/.test(readFileSync(path, 'utf8')));
    expect(
      mentions.length,
      'nothing here carries a provider id any more; this scan is looking at the wrong tree',
    ).toBeGreaterThan(0);
  });

  it('never compares or picks apart a provider or model id', () => {
    const offenders = shippingFiles(RUNTIME_ROOT).flatMap((path) => {
      const source = stripComments(readFileSync(path, 'utf8'));
      return [
        ...offences(path, source, comparesATargetToALiteral),
        ...offences(path, source, readsATargetId),
      ];
    });

    expect(
      offenders,
      'a harness passes a target through to chat_send and reads neither string for anything else',
    ).toEqual([]);
  });

  it('the scan catches the workaround it exists for', () => {
    expect(comparesATargetToALiteral("if (target.providerId === 'workstation') retryOnce();")).toBe(
      true,
    );
    expect(comparesATargetToALiteral('if (modelId !== "local") return;')).toBe(true);
    expect(readsATargetId('const quirks = QUIRKS[target.providerId];')).toBe(true);
    expect(readsATargetId('const family = modelId.split(":")[0];')).toBe(true);

    // The shapes the loop is actually built out of.
    expect(comparesATargetToALiteral('providerId: target.providerId,')).toBe(false);
    expect(readsATargetId('await this.services.turns.send({ providerId, modelId, messages });')).toBe(
      false,
    );
    expect(readsATargetId('readonly providerId: string;')).toBe(false);
  });
});

describe('a harness performs no I/O of its own', () => {
  // "A harness performs no I/O of its own. It calls `chat_send` through the seam
  // and consumes `chat:event`" — and it is never given a `PlatformAdapter` and
  // never closure-captures one. Today that is held by nothing but the shape of
  // `HarnessServices`, which a harness can step around by importing `@/data` or
  // the adapter directly.
  //
  // One exemption, and it is the composition root: `src/runtime/app-runtime.ts`
  // is the file whose whole job is to hold the adapter and hand the seam its
  // three functions. A type-only import is not I/O and is not counted — the
  // loop imports `Unsubscribe` from the adapter module and cannot call anything
  // through a type.
  const COMPOSITION_ROOT = 'src/runtime/app-runtime.ts';

  it('reaches the host from the composition root and from nowhere else', () => {
    const offenders = shippingFiles(RUNTIME_ROOT)
      .filter((path) => asRepoPath(path) !== COMPOSITION_ROOT)
      .flatMap((path) => offences(path, readFileSync(path, 'utf8'), reachesTheHost));

    expect(
      offenders,
      'a harness that imports the host is one the composition root cannot substitute, ' +
        'and one that can write settings while driving a turn',
    ).toEqual([]);
  });

  it('the exemption is still the file that holds the adapter', () => {
    const root = join(REPO_ROOT, COMPOSITION_ROOT);
    expect(
      offences(root, readFileSync(root, 'utf8'), reachesTheHost).length,
      'the composition root no longer reaches the host; delete the exemption instead',
    ).toBeGreaterThan(0);
  });

  it('the scan tells a value import from a type', () => {
    expect(reachesTheHost("import { createTurnDriver } from '@/data/turn-driver';")).toBe(true);
    expect(reachesTheHost("import { invoke } from '@/platform/adapter';")).toBe(true);
    expect(reachesTheHost("import type { PlatformAdapter } from '@/platform/adapter';")).toBe(false);
    expect(reachesTheHost("import type { Unsubscribe } from '@/platform/adapter';")).toBe(false);
    expect(reachesTheHost("import type { ChatError } from '@/platform/contract';")).toBe(false);
  });
});
