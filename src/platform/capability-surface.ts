/**
 * **The capability surface the built app actually loads, enumerated the way the
 * loader enumerates it.**
 *
 * ## The defect this exists to make impossible
 *
 * `src-tauri/capabilities/main.json` was read by two guards — the exact-set
 * assertion in `src/app/shell/window-controls.test.tsx` and the prefix check in
 * `src/platform/project-host-parity.test.ts` — **by filename**. The loader does
 * not read a filename. It globs the whole `src-tauri/capabilities/` directory
 * and then selects from what it found using `app.security.capabilities` in
 * `src-tauri/tauri.conf.json`. A second capability file, granting the main
 * window two more window permissions and registered in the config, left both
 * guards green: neither of them could see it, because neither of them looked
 * anywhere but at one path.
 *
 * So the unit of assertion has to be the union, and the union has to be
 * *derived* — from the directory and from the config — rather than assembled
 * from a path somebody typed. That is what this module produces. It lives here,
 * rather than being written twice, for the reason declared-commands.ts gives:
 * the two callers hold different properties of the same set, and a parse copied
 * into two files is two parses, one of which is eventually a refactor behind and
 * quietly reads less than its caller believes.
 *
 * ## Where the rules below come from
 *
 * Not from the documentation site and not from memory. From the pinned sources
 * in `src-tauri/Cargo.lock`: tauri-utils 2.9.3, tauri-build 2.6.3, tauri-codegen
 * 2.6.3 and tauri 2.11.5, read out of the cargo registry checkout.
 *
 * 1. **The directory is globbed, always.** tauri-build 2.6.3, src/acl.rs, in fn
 *    build: with no capabilities_path_pattern attribute set — and this crate's
 *    `src-tauri/build.rs` sets none, it calls tauri_build::build() bare — the
 *    pattern is the literal `./capabilities/**` + `/*`, relative to the crate
 *    directory. Files are kept when the extension is one of tauri-utils'
 *    CAPABILITY_FILE_EXTENSIONS and dropped when their immediate parent
 *    directory is named `schemas`.
 * 2. **The extensions are `json` and `toml` here.** tauri-utils 2.9.3,
 *    src/acl/build.rs: the list is json, toml, and json5 *only* behind the
 *    crate's config-json5 feature. `src-tauri/Cargo.toml` takes tauri with
 *    `features = []` and no json5 crate appears anywhere in `src-tauri/Cargo.lock`,
 *    so the feature is off and a `json5` capability file would be ignored by the
 *    build entirely.
 * 3. **The key is the identifier, not the filename.** tauri-utils 2.9.3,
 *    src/acl/build.rs, in fn parse_capabilities: every parsed capability is
 *    inserted under its own `identifier` field, and a second capability claiming
 *    an identifier already taken is a build error. A file named `main.json`
 *    whose identifier is `something-else` registers as `something-else`.
 * 4. **A file holds one capability, a list of them, or a `capabilities` key
 *    holding a list.** tauri-utils 2.9.3, src/acl/capability.rs, enum
 *    CapabilityFile.
 * 5. **An empty or absent config list means *all* of them.** tauri-utils 2.9.3,
 *    src/acl/mod.rs, in fn get_capabilities: `if config.app.security.capabilities.is_empty()`
 *    the whole parsed map is used. The field carries serde's `#[serde(default)]`,
 *    so a missing key is an empty list, which is the same branch. Removing the
 *    key from `src-tauri/tauri.conf.json` therefore *widens* the app to every
 *    file in the directory — it does not narrow it to none.
 * 6. **A non-empty list selects, and every entry is a string or an object.**
 *    tauri-utils 2.9.3, src/config.rs, enum CapabilityEntry: a JSON string is a
 *    reference to an identifier, a JSON object is a capability written inline in
 *    the config with no file behind it at all. A reference naming an identifier
 *    that was not parsed out of the directory is an error — "capability with
 *    identifier {id} not found" — raised inside the `generate_context!` expansion,
 *    so it fails the compile rather than shipping an empty grant.
 * 7. **A capability reaches a window when one of its globs matches.** tauri
 *    2.11.5, src/ipc/authority.rs, in fn resolve_access: a command is permitted
 *    when the origin matches *and* (`webviews` matches the webview label **or**
 *    `windows` matches the window label). Both lists empty therefore grants
 *    nothing to anyone. tauri-utils 2.9.3, src/acl/resolved.rs, in fn
 *    resolve_command, compiles both lists as glob patterns.
 *
 * ## What this reader does *not* model, said plainly
 *
 * Three of the loader's narrowings are deliberately not implemented, and the
 * reader errs **wide** at each — it will report a permission as granted that the
 * real app might not grant, and never the reverse. A guard that over-reports
 * costs a review; a guard that under-reports is the defect above again.
 *
 * - **`platforms`.** tauri-utils 2.9.3, src/acl/capability.rs, fn is_active:
 *   a capability listing target platforms is inert on every other target. This
 *   reader ignores the field, so a capability scoped to another platform is
 *   still counted.
 * - **`local` and `remote`.** tauri-utils 2.9.3, src/acl/resolved.rs, in fn
 *   resolve_command: the execution contexts come from `local` (defaulting true)
 *   and each URL in `remote`; with `local` false and no `remote`, the capability
 *   resolves to no context and grants nothing. This reader ignores both, so such
 *   a capability is still counted.
 * - **Glob metacharacters in `windows` and `webviews`.** Matching is exact here.
 *   A pattern containing `*`, `?` or a bracket is treated as reaching **every**
 *   label rather than being matched, because a half-right glob implementation is
 *   how this repo's tokeniser guard was wrong six times running. So `admin-*` is
 *   counted against the main window even though it does not reach it.
 *
 * Two inputs are *not* modelled wide either, because there is no wide reading of
 * them. {@link readCapabilitySurface} throws on each rather than reading past
 * it, which is the choice this tree makes everywhere about evidence it cannot
 * read:
 *
 * - **A `.toml` capability file.** The build loads it and this repo has no TOML
 *   parser in `package.json`.
 * - **A second config file.** tauri-utils 2.9.3, src/config/parse.rs, fn
 *   read_platform: the base config is merged with a per-target overlay — named
 *   tauri.windows.conf.json on Windows, with a sibling for each other target —
 *   and the base itself can be tauri.conf.json5 or Tauri.toml depending on
 *   which format features the graph turns on. An overlay may set
 *   `app.security.capabilities`, so reading only `src-tauri/tauri.conf.json`
 *   while one exists would be exactly the defect at the top of this file, one
 *   file further out. {@link unreadableConfigsIn} names every such file, for
 *   every target and every format, whether or not the feature behind it is on
 *   here; none of them exists in this tree today.
 *
 * Nothing outside a test imports this, so it is not in the shipped bundle.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** One capability, normalised out of a file or out of an inline config entry. */
export interface CapabilityRecord {
  /** Where it was read from, for a failure message a reader can act on. */
  readonly source: string;
  readonly identifier: string;
  readonly windows: readonly string[];
  readonly webviews: readonly string[];
  /** Permission identifiers, with any scope object flattened to its identifier. */
  readonly permissions: readonly string[];
}

/** Everything the loader would see, and what it would do with it. */
export interface CapabilitySurface {
  /**
   * Every file under `src-tauri/capabilities/` the loader's glob would keep,
   * relative to that directory, with `/` separators, sorted. Files whose
   * immediate parent directory is named `schemas` are absent, exactly as they
   * are absent from the loader's list — see rule 1 above.
   */
  readonly files: readonly string[];
  /** Files present but with an extension the loader ignores, same form. */
  readonly ignoredFiles: readonly string[];
  /** Every capability parsed out of {@link CapabilitySurface.files}. */
  readonly onDisk: readonly CapabilityRecord[];
  /**
   * `app.security.capabilities` as written, or `null` when the key is absent.
   * Both `null` and `[]` mean "load everything on disk" — see rule 5.
   */
  readonly registration: readonly unknown[] | null;
  /** What the loader would end up with, keyed in insertion order. */
  readonly loaded: readonly CapabilityRecord[];
}

const CAPABILITY_DIRECTORY = ['src-tauri', 'capabilities'] as const;
const CONFIG_FILE = ['src-tauri', 'tauri.conf.json'] as const;
const SCHEMA_FOLDER_NAME = 'schemas';
/** Rule 2. `json5` is absent because the config-json5 feature is off here. */
const LOADED_EXTENSIONS = ['.json', '.toml'] as const;

/**
 * Every config file tauri would read besides `src-tauri/tauri.conf.json`: the
 * two alternate base formats and the per-target overlay of each of the three
 * formats, from tauri-utils 2.9.3, src/config/parse.rs, fn into_file_name and fn
 * into_platform_file_name. Listed for all five targets and all three formats
 * rather than for this build's target and enabled features, because which of
 * them is live is a question about a feature graph and being wrong about it
 * costs the whole guard.
 */
const OTHER_CONFIG_FILES = [
  'tauri.conf.json5',
  'Tauri.toml',
  'tauri.macos.conf.json',
  'tauri.windows.conf.json',
  'tauri.linux.conf.json',
  'tauri.android.conf.json',
  'tauri.ios.conf.json',
  'tauri.macos.conf.json5',
  'tauri.windows.conf.json5',
  'tauri.linux.conf.json5',
  'tauri.android.conf.json5',
  'tauri.ios.conf.json5',
  'Tauri.macos.toml',
  'Tauri.windows.toml',
  'Tauri.linux.toml',
  'Tauri.android.toml',
  'Tauri.ios.toml',
] as const;

/**
 * Which of {@link OTHER_CONFIG_FILES} appear in a directory listing.
 *
 * Compared without case, because this tree is checked out on a case-insensitive
 * filesystem and a file spelled `tauri.windows.conf.JSON` would be opened by the
 * loader and missed by an exact comparison.
 */
export function unreadableConfigsIn(names: readonly string[]): readonly string[] {
  const known = new Set(OTHER_CONFIG_FILES.map((name) => name.toLowerCase()));
  return names.filter((name) => known.has(name.toLowerCase())).sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringsAt(container: Record<string, unknown>, key: string, source: string): string[] {
  const value = container[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${source}: "${key}" must be an array of strings`);
  }
  return value as string[];
}

/**
 * One capability object, normalised.
 *
 * `identifier` and `permissions` are required by the loader's own deserialiser
 * (tauri-utils 2.9.3, src/acl/capability.rs, struct Capability: neither carries
 * a serde default), so a file missing either would fail the build. It fails here
 * too, rather than being read as a capability that grants nothing.
 */
function capabilityFrom(value: unknown, source: string): CapabilityRecord {
  if (!isRecord(value)) throw new Error(`${source}: expected a capability object`);
  const identifier = value['identifier'];
  if (typeof identifier !== 'string' || identifier === '') {
    throw new Error(`${source}: capability has no "identifier"`);
  }
  const rawPermissions = value['permissions'];
  if (!Array.isArray(rawPermissions)) {
    throw new Error(`${source}: capability "${identifier}" has no "permissions" array`);
  }
  const permissions = rawPermissions.map((entry): string => {
    // A permission entry is a bare identifier or an object that names one and
    // extends its scope — tauri-utils 2.9.3, src/acl/capability.rs, enum
    // PermissionEntry. The scope is not this module's business; the identifier
    // is the grant.
    if (typeof entry === 'string') return entry;
    if (isRecord(entry) && typeof entry['identifier'] === 'string') return entry['identifier'];
    throw new Error(`${source}: capability "${identifier}" has an unreadable permission entry`);
  });
  return {
    source,
    identifier,
    windows: stringsAt(value, 'windows', source),
    webviews: stringsAt(value, 'webviews', source),
    permissions,
  };
}

/**
 * The capabilities in one file's text — rule 4.
 *
 * The order of the three shapes matches the loader's own untagged visitor: a
 * JSON array is a list, an object carrying a `capabilities` key is a named list,
 * and any other object is a single capability.
 */
export function capabilitiesInFile(text: string, source: string): readonly CapabilityRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: not valid JSON (${String(error)})`);
  }
  if (Array.isArray(parsed)) {
    return parsed.map((entry, index) => capabilityFrom(entry, `${source}[${String(index)}]`));
  }
  if (isRecord(parsed) && 'capabilities' in parsed) {
    const list = parsed['capabilities'];
    if (!Array.isArray(list)) throw new Error(`${source}: "capabilities" must be an array`);
    return list.map((entry, index) =>
      capabilityFrom(entry, `${source}.capabilities[${String(index)}]`),
    );
  }
  return [capabilityFrom(parsed, source)];
}

/**
 * Rule 6, and the empty-means-everything branch of rule 5.
 *
 * The identifier map is consumed as it is read, which is the loader's own
 * `remove`: naming the same identifier twice is "not found" the second time
 * rather than a silent duplicate.
 */
export function resolveLoaded(
  onDisk: readonly CapabilityRecord[],
  registration: readonly unknown[] | null,
): readonly CapabilityRecord[] {
  const byIdentifier = new Map<string, CapabilityRecord>();
  for (const capability of onDisk) {
    if (byIdentifier.has(capability.identifier)) {
      throw new Error(
        `two capabilities claim the identifier "${capability.identifier}": ` +
          `${byIdentifier.get(capability.identifier)?.source ?? '?'} and ${capability.source}. ` +
          'The build refuses this.',
      );
    }
    byIdentifier.set(capability.identifier, capability);
  }

  if (registration === null || registration.length === 0) return [...byIdentifier.values()];

  const loaded: CapabilityRecord[] = [];
  for (const [index, entry] of registration.entries()) {
    const where = `src-tauri/tauri.conf.json app.security.capabilities[${String(index)}]`;
    if (typeof entry === 'string') {
      const capability = byIdentifier.get(entry);
      if (capability === undefined) {
        throw new Error(
          `${where}: capability with identifier "${entry}" not found. ` +
            'The build fails on this inside the generate_context! expansion.',
        );
      }
      byIdentifier.delete(entry);
      loaded.push(capability);
      continue;
    }
    loaded.push(capabilityFrom(entry, where));
  }
  return loaded;
}

/** Whether a `windows`/`webviews` pattern is a glob rather than a literal label. */
function isGlob(pattern: string): boolean {
  return /[*?[\]]/.test(pattern);
}

/**
 * The permissions a label ends up holding, over the whole loaded set — rule 7,
 * read wide as the header describes.
 *
 * Sorted and de-duplicated: two capabilities granting the same permission grant
 * it once, and the union is a set.
 */
export function permissionsReaching(
  loaded: readonly CapabilityRecord[],
  label: string,
): readonly string[] {
  const granted = new Set<string>();
  for (const capability of loaded) {
    const patterns = [...capability.windows, ...capability.webviews];
    if (!patterns.some((pattern) => pattern === label || isGlob(pattern))) continue;
    for (const permission of capability.permissions) granted.add(permission);
  }
  return [...granted].sort();
}

/** Every file under a directory, recursively, as `/`-joined relative paths. */
function filesUnder(absolute: string, prefix: string, into: string[]): void {
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      filesUnder(join(absolute, entry.name), relative, into);
    } else {
      into.push(relative);
    }
  }
}

/**
 * Read the whole surface off disk.
 *
 * `repoRoot` is the repository root — `process.cwd()` under vitest. A wrong root
 * makes {@link readCapabilitySurface} throw out of `readdirSync`, which is the
 * behaviour wanted: the failure that must never happen here is the one where a
 * mis-rooted read returns nothing and every comparison above it compares two
 * empty sets.
 */
export function readCapabilitySurface(repoRoot: string): CapabilitySurface {
  const directory = join(repoRoot, ...CAPABILITY_DIRECTORY);
  const found: string[] = [];
  filesUnder(directory, '', found);

  const files: string[] = [];
  const ignoredFiles: string[] = [];
  for (const path of found.sort()) {
    // The loader drops a file whose *immediate parent* is `schemas` — rule 1.
    const parent = path.split('/').at(-2);
    if (parent === SCHEMA_FOLDER_NAME) continue;
    const extension = path.slice(path.lastIndexOf('.'));
    if (LOADED_EXTENSIONS.includes(extension as (typeof LOADED_EXTENSIONS)[number])) {
      files.push(path);
    } else {
      ignoredFiles.push(path);
    }
  }

  const onDisk: CapabilityRecord[] = [];
  for (const file of files) {
    if (file.endsWith('.toml')) {
      throw new Error(
        `src-tauri/capabilities/${file} is a TOML capability file. The build loads it and ` +
          'this reader cannot parse it — there is no TOML parser in package.json. Write the ' +
          'capability as JSON, or give this module a parser; do not let it go unread.',
      );
    }
    const source = `src-tauri/capabilities/${file}`;
    onDisk.push(...capabilitiesInFile(readFileSync(join(directory, ...file.split('/')), 'utf8'), source));
  }

  const strays = unreadableConfigsIn(readdirSync(join(repoRoot, CONFIG_FILE[0])));
  if (strays.length > 0) {
    throw new Error(
      `src-tauri/ holds ${strays.join(', ')}, which the loader reads as well as ` +
        'tauri.conf.json — an overlay is merged over the base config and may set ' +
        'app.security.capabilities. This reader merges nothing. Teach it to, or ' +
        'do not add a second config; do not let it read half the input.',
    );
  }

  const config: unknown = JSON.parse(readFileSync(join(repoRoot, ...CONFIG_FILE), 'utf8'));
  const security =
    isRecord(config) && isRecord(config['app']) && isRecord(config['app']['security'])
      ? config['app']['security']
      : {};
  const raw = security['capabilities'];
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new Error('src-tauri/tauri.conf.json: app.security.capabilities must be an array');
  }
  const registration: readonly unknown[] | null = raw === undefined ? null : (raw as unknown[]);

  return {
    files,
    ignoredFiles,
    onDisk,
    registration,
    loaded: resolveLoaded(onDisk, registration),
  };
}
