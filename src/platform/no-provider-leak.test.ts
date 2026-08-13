/**
 * Conventions §0 rule 3, enforced instead of narrated.
 *
 * > No provider-specific detail may leak into UI code. The UI branches on
 * > capability flags, never on a provider id. Adding a provider must require
 * > zero changes under `src/`.
 *
 * Phase B is the first phase where that rule can actually be broken: until now
 * there were no adapters to leak from. Three landed at once — OpenAI-compatible,
 * Anthropic, Google — and each of them knows things (`x-api-key`, `?key=`,
 * `anthropic-version`, Ollama's `owned_by: library` tell) that the renderer must
 * never learn. This scans the assembled tree for those names on both sides of
 * the boundary.
 *
 * Scope, and why it is drawn here:
 *
 *  - **Shipping renderer source** (`src/`, excluding `*.test.*`). Zero mentions.
 *  - **The IPC command layer** (`src-tauri/src/ipc/`, outside `#[cfg(test)]`).
 *    This is the literal boundary: whatever a command's response type can carry
 *    is whatever the UI can branch on.
 *
 * Tests are excluded on purpose, in both languages. A vendor name in a *fixture*
 * is a user-configured provider id — `{ id: 'ollama', displayName: 'Ollama' }`
 * is data a user typed, not a branch the UI took — and forbidding it would only
 * teach builders to spell fixtures in code names.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const IPC_ROOT = join(REPO_ROOT, 'src-tauri', 'src', 'ipc');

/**
 * Backend identities and their wire tells. A name here is one the adapter layer
 * is allowed to know and the boundary is not.
 */
const PROVIDER_SPECIFIC =
  /ollama|llama[.-]?cpp|lm[ -]?studio|vllm|openai|anthropic|gemini|claude|gpt-[0-9o]|mistral|cohere|x-api-key|anthropic-version|owned_by/i;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Removes brace-balanced `#[cfg(test)] mod … { … }` bodies from Rust source. */
function stripRustTestModules(source: string): string {
  let out = '';
  let cursor = 0;
  for (const match of source.matchAll(/#\[cfg\(test\)\]/g)) {
    const start = match.index;
    if (start === undefined || start < cursor) continue;
    const open = source.indexOf('{', start);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) break;
    out += source.slice(cursor, start);
    cursor = end;
  }
  return out + source.slice(cursor);
}

function sourceFiles(directory: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path, extensions));
    } else if (extensions.includes(extname(entry.name))) {
      found.push(path);
    }
  }
  return found;
}

/** `file:line — the offending line`, so a failure names the leak, not the file. */
function offendingLines(path: string, source: string): string[] {
  return source
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => PROVIDER_SPECIFIC.test(line))
    .map(({ line, number }) => `${relative(REPO_ROOT, path)}:${number} — ${line}`);
}

describe('no provider-specific detail crosses the adapter boundary', () => {
  it('never appears in shipping renderer source', () => {
    const offenders = sourceFiles(SRC_ROOT, ['.ts', '.tsx', '.css'])
      .filter((path) => !/\.test\.[a-z]+$/.test(path))
      .flatMap((path) => offendingLines(path, stripComments(readFileSync(path, 'utf8'))));

    expect(
      offenders,
      'the UI must branch on capability flags, never on a provider identity',
    ).toEqual([]);
  });

  it('never appears in the IPC command layer, which is the boundary itself', () => {
    const offenders = sourceFiles(IPC_ROOT, ['.rs'])
      .flatMap((path) =>
        offendingLines(path, stripRustTestModules(stripComments(readFileSync(path, 'utf8')))),
      );

    expect(
      offenders,
      'a command response that can carry a provider name is a leak the UI will eventually read',
    ).toEqual([]);
  });

  it('adding a provider requires no renderer change: the contract names none', () => {
    // The narrower, sharper form of the same rule. `contract.ts` is the entire
    // vocabulary the renderer has; if no backend is nameable in it, no component
    // can branch on one however carelessly it is written.
    const contract = stripComments(readFileSync(join(SRC_ROOT, 'platform', 'contract.ts'), 'utf8'));
    expect(offendingLines(join(SRC_ROOT, 'platform', 'contract.ts'), contract)).toEqual([]);
  });

  it('the navigation surface has no vocabulary for a backend at all', () => {
    // The sharper form of the rule for the one wire type most likely to grow a
    // leak by accident. A stored `Conversation` carries `provider_id` and
    // `model_id` — the backend that last answered in it — and
    // `ConversationSummary` deliberately drops both. If those fields ever reach
    // the renderer, the sidebar can group, colour or badge by backend without
    // anybody deciding to, and the `PROVIDER_SPECIFIC` scan above would not
    // notice: `providerId` is not a vendor name.
    const contract = stripComments(readFileSync(join(SRC_ROOT, 'platform', 'contract.ts'), 'utf8'));
    const navigationTypes = contract.slice(
      contract.indexOf('export interface ConversationSummary'),
      contract.indexOf('export interface IpcContract'),
    );
    expect(navigationTypes.length, 'the navigation wire types moved; fix this slice').toBeGreaterThan(
      400,
    );
    expect(
      navigationTypes.split('\n').filter((line) => /\bprovider|\bmodelId/i.test(line)),
      'a conversation summary that names a backend is a leak the sidebar will eventually branch on',
    ).toEqual([]);
  });

  it('no navigation component reads a backend identity off anything', () => {
    const offenders = sourceFiles(join(SRC_ROOT, 'features', 'navigation'), ['.ts', '.tsx', '.css'])
      .filter((path) => !/\.test\.[a-z]+$/.test(path))
      .flatMap((path) => {
        const source = stripComments(readFileSync(path, 'utf8'));
        return source
          .split('\n')
          .map((line, index) => ({ line: line.trim(), number: index + 1 }))
          .filter(({ line }) => /\bproviderId\b|\bmodelId\b/.test(line))
          .map(({ line, number }) => `${relative(REPO_ROOT, path)}:${number} — ${line}`);
      });

    expect(offenders, 'navigation is about which conversation, never about what answered').toEqual(
      [],
    );
  });

  it('the conversation surface carries a backend id without ever reading one', () => {
    // The conversation surface is the first feature that *must* handle a
    // `providerId`: it is what `chat_send` addresses. So the rule for it cannot
    // be "never mentions one" — it is the sharper one, that the id is only ever
    // **passed through**, never inspected.
    //
    // Two files may hold it: the repository that puts it on the wire, and the
    // hook that carries it from a prop to that repository. A *component*
    // touching it means the surface has started to look at what answered, and
    // the next step from there is always a branch.
    const CARRIERS = new Set(['use-conversation.ts']);
    const offenders = sourceFiles(join(SRC_ROOT, 'features', 'conversation'), ['.ts', '.tsx', '.css'])
      .filter((path) => !/\.test\.[a-z]+$/.test(path))
      .filter((path) => !CARRIERS.has(path.split('/').at(-1) ?? ''))
      .flatMap((path) => {
        const source = stripComments(readFileSync(path, 'utf8'));
        return source
          .split('\n')
          .map((line, index) => ({ line: line.trim(), number: index + 1 }))
          // A comparison, a lookup, a template — anything but declaring the
          // prop and forwarding it verbatim.
          .filter(({ line }) => /\bproviderId\b\s*(?:===|!==|\?\.|\[|\.)/.test(line))
          .map(({ line, number }) => `${relative(REPO_ROOT, path)}:${number} — ${line}`);
      });

    expect(
      offenders,
      'the conversation surface addresses a backend; it must never inspect one',
    ).toEqual([]);

    // The guard proves it can fail. Both shapes a component would actually
    // reach for, and neither of the two that are fine.
    const inspects = (line: string): boolean => /\bproviderId\b\s*(?:===|!==|\?\.|\[|\.)/.test(line);
    expect(inspects("if (providerId === 'x') return null;")).toBe(true);
    expect(inspects('const badge = BADGES[providerId.toLowerCase()];')).toBe(true);
    expect(inspects('readonly providerId: string | null;')).toBe(false);
    expect(inspects('await repository.streamTurn({ providerId, modelId });')).toBe(false);
  });

  it('every user-visible chat state is reachable from capability flags alone', () => {
    // The positive form of the rule, checked against the vocabulary rather than
    // the code: if the renderer can describe what a model can do without
    // naming one, no component ever needs a provider id to decide what to
    // offer. `ChatCapabilities` is that vocabulary, and `NO_CAPABILITIES` is
    // its floor — an unprobed endpoint offers nothing.
    const contract = stripComments(readFileSync(join(SRC_ROOT, 'platform', 'contract.ts'), 'utf8'));
    const start = contract.indexOf('export interface ChatCapabilities');
    const end = contract.indexOf('export const NO_CAPABILITIES');
    expect(start, 'ChatCapabilities moved; fix this slice').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const flags = contract.slice(start, end);
    expect(offendingLines('contract.ts', flags)).toEqual([]);
    // Every field is a plain boolean. A string here would be somewhere to put
    // a backend name, and a component would eventually read it.
    const fields = flags.split('\n').filter((line) => line.includes('readonly '));
    expect(fields.length).toBeGreaterThan(4);
    for (const field of fields) expect(field.trim()).toMatch(/: boolean;$/);
  });

  it('the scan actually catches a leak', () => {
    // A guard whose pattern silently stopped matching is worse than no guard.
    expect(offendingLines('x.tsx', "if (provider.id === 'ollama') return <OllamaPanel />;")).toEqual(
      ["x.tsx:1 — if (provider.id === 'ollama') return <OllamaPanel />;"],
    );
    expect(offendingLines('x.rs', 'headers.insert("x-api-key", key);')).toHaveLength(1);
    // …and does not fire on the vocabulary the UI is supposed to use.
    expect(
      offendingLines('x.tsx', 'if (capabilities.streaming === Support.Yes) return <Stream />;'),
    ).toEqual([]);
  });
});
