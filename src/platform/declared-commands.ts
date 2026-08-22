/**
 * **Reading a TypeScript interface's members back out of its own source.**
 *
 * An interface has no runtime value, so a test that wants to compare "every
 * command the contract declares" against "every command some list names" cannot
 * do it with `Object.keys` of anything. The only enumerable form of an
 * `export interface` at test time is the text it is written in — the same
 * position `src-tauri/src/ipc/mod.rs` is already in, where
 * `typescript_allowlist` reads `src/platform/contract.ts` as a string because no
 * TypeScript toolchain exists inside `cargo test`.
 *
 * Two files need it: `src/platform/contract.test.ts`, over `IpcContract`, and
 * `src/platform/project-host-parity.test.ts`, over `ProjectCommands`. It lives
 * here rather than being restated in both, which is the opposite of what
 * `everyVariantOf` does three files over. The difference is what could drift: a
 * type-level helper has no behaviour, so a second copy is the same helper by
 * construction, while this has a parse and two copies are two parses — and the
 * copy that is one refactor behind is the one that quietly reads fewer members
 * and turns its caller's comparison green.
 *
 * Nothing outside a test imports this, so it is not in the shipped bundle.
 */

/**
 * The member names of one `export interface` in a TypeScript source, in
 * declaration order.
 *
 * Line-oriented, and **without a formatter behind it**: `pnpm verify` runs
 * `cargo fmt --all --check` over the crate, so the Rust shapes this repo parses
 * elsewhere are machine-enforced, but there is no formatter or linter for
 * TypeScript here at all — `package.json` declares neither, and `pnpm verify`
 * is `tsc`, `cargo`, vitest and two shell test scripts. So this assumes only
 * what it must and catches
 * itself when the assumption breaks: the interface's closing `}` is in column 0
 * and each member begins its own line. Brace depth is tracked, so a member whose
 * payload type is written across several lines is read as one member and its
 * inner field names are not read as commands; doc-comment lines are dropped,
 * because both interfaces this reads carry some.
 *
 * If the shape ever stops holding, this throws or returns fewer members. Every
 * caller must therefore pin what it read — that a known member is present, that
 * the count is not zero — or the comparison it feeds degrades into two empty
 * lists agreeing, which is the failure this whole function exists to prevent.
 */
export function declaredCommandsIn(source: string, name: string): readonly string[] {
  const at = source.search(new RegExp(`^export interface ${name} \\{$`, 'm'));
  if (at < 0) throw new Error(`declaredCommandsIn: no \`export interface ${name}\``);

  const lines = source.slice(at).split(/\r?\n/).slice(1);
  const end = lines.indexOf('}');
  if (end < 0) throw new Error(`declaredCommandsIn: unterminated ${name}`);

  const members: string[] = [];
  let depth = 0;
  for (const line of lines.slice(0, end)) {
    const text = line.trim();
    if (text.startsWith('//') || text.startsWith('/*') || text.startsWith('*')) continue;
    if (depth === 0) {
      const member = /^([A-Za-z_][A-Za-z0-9_]*)\s*[?]?:/.exec(text);
      if (member?.[1] !== undefined) members.push(member[1]);
    }
    depth += (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
  }
  return members;
}
