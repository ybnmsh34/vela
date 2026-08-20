/**
 * **The bundle format, and the boundary it is not allowed to cross.**
 *
 * `src/data/skill-bundles.ts` is pure: text and a listing in, a reading out. So
 * everything here is exercised directly on values, and the one property that
 * cannot be shown from here — that resolving a bundle costs no host call — is
 * asserted where the calls are counted, in `src/app/skills-reachable.test.tsx`.
 *
 * ## Two totality assertions, because a closed vocabulary that lies is worse
 * than an open one
 *
 * {@link PRODUCING} and {@link MEMBER_KINDS} are typed `Record<…>` over the two
 * unions, so a variant added to either without an entry here fails
 * `pnpm typecheck`. That is the same device the panel's label maps use, and on
 * its own it proves only that somebody wrote a line. Each entry is then *run*,
 * and the variant it claims to produce is the variant that comes back — which is
 * the half that catches a `BundleProblem` that is declared, worded on screen and
 * produced by no input. A vocabulary with an unreachable variant is a promise
 * the parser does not keep.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SkillListing } from '@/platform/contract';

import {
  BUNDLE_DIRECTORY_PREFIX,
  SKILL_NAME_MAX_CHARS,
  isBundleDirectory,
  parseBundleManifest,
  readBundle,
  type BundleMember,
  type BundleProblem,
} from './skill-bundles';

/** A manifest block, assembled here so no test file contains a stray fence. */
function fenced(...lines: readonly string[]): string {
  return ['# A bundle', '', '```vela-bundle', ...lines, '```', ''].join('\n');
}

/**
 * One body per {@link BundleProblem}, each asserted to actually produce it.
 *
 * Total by the compiler, non-vacuous by the loop below.
 */
const PRODUCING: Record<BundleProblem, string> = {
  manifestMissing: '# A skill with no manifest in it\n',
  manifestUnterminated: '```vela-bundle\nskills: commit-messages\n',
  manifestRepeated: `${fenced('skills: commit-messages')}${fenced('skills: changelog')}`,
  manifestSyntax: fenced('this line has no colon in it'),
  manifestUnknownKey: fenced('version: 2'),
  manifestDuplicateKey: fenced('skills: commit-messages', 'skills: changelog'),
  membersMissing: fenced(),
  membersEmpty: fenced('skills:'),
  memberNameNotWellFormed: fenced('skills: ../../secrets'),
  memberRepeated: fenced('skills: commit-messages, commit-messages'),
};

/** Total by the compiler; each arm is produced by the resolution test below. */
const MEMBER_KINDS: Record<BundleMember['kind'], true> = {
  installed: true,
  broken: true,
  missing: true,
};

const LISTING: readonly SkillListing[] = [
  {
    kind: 'skill',
    directory: 'commit-messages',
    name: 'commit-messages',
    description: 'Writes commit messages.',
  },
  { kind: 'invalid', directory: 'half-written', problem: 'missingDescription' },
  {
    kind: 'skill',
    directory: 'bundle-release',
    name: 'bundle-release',
    description: 'A bundle.',
  },
];

describe('a manifest is read out of the bundle root’s own body', () => {
  it('takes the skills it names, in the order it names them', () => {
    expect(parseBundleManifest(fenced('skills: commit-messages, changelog'))).toEqual({
      kind: 'manifest',
      members: ['commit-messages', 'changelog'],
    });
  });

  it('reads a body whose editor wrote CRLF the same as one that wrote LF', () => {
    // Not a hypothetical on this tree: line endings are mixed here and have
    // already cost three separate pieces of work. A manifest that parsed on the
    // author's machine and not on the reader's would be the fourth.
    const lf = fenced('skills: commit-messages, changelog');
    expect(parseBundleManifest(lf.split('\n').join('\r\n'))).toEqual(parseBundleManifest(lf));
    expect(parseBundleManifest(lf).kind, 'the control: the LF body must parse').toBe('manifest');
  });

  it('ignores blank lines and comments inside the block', () => {
    expect(parseBundleManifest(fenced('', '# what this carries', 'skills: changelog'))).toEqual({
      kind: 'manifest',
      members: ['changelog'],
    });
  });

  it('produces every problem in its vocabulary, and the right one for each body', () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // The compiler makes this map total. Only running it proves the parser can
    // still reach every variant: a refactor that made one unreachable would
    // leave a sentence on screen that nothing can ever say.
    for (const [problem, body] of Object.entries(PRODUCING) as readonly (readonly [
      BundleProblem,
      string,
    ])[]) {
      expect(parseBundleManifest(body), `no body produces ${problem}`).toEqual({
        kind: 'invalid',
        problem,
      });
    }
  });

  it('refuses an empty item rather than dropping it', () => {
    // `a, , b` read as two skills is a bundle whose author believes it has
    // three, and nothing on screen would disagree with them.
    expect(parseBundleManifest(fenced('skills: commit-messages, , changelog'))).toEqual({
      kind: 'invalid',
      problem: 'memberNameNotWellFormed',
    });
    expect(parseBundleManifest(fenced('skills: commit-messages,'))).toEqual({
      kind: 'invalid',
      problem: 'memberNameNotWellFormed',
    });
  });
});

describe('a member name is matched against the store, never joined to a path', () => {
  /**
   * The boundary, stated as the property rather than as a blocklist.
   *
   * Each of these is refused at the manifest, so none of them ever reaches
   * resolution — and if one ever did, resolution is `listing.find(entry =>
   * entry.directory === member)`, which is a comparison against a fixed set of
   * strings the host produced. That is why this list does not need to be
   * complete to be sound: it is a sample of a class, not the guard itself. A
   * guard that *was* a list of these would be the narrower question — beaten by
   * the encoding nobody thought of.
   */
  const PATH_SHAPED = [
    '../../secrets',
    '..',
    '.',
    '/etc/passwd',
    'C:\\Windows\\System32',
    '\\\\server\\share',
    'skills/../../..',
    '%2e%2e%2fsecrets',
    'a\u0000b',
    'commit-messages/../half-written',
  ];

  it('refuses every path-shaped member, and refuses the whole manifest with it', () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    for (const member of PATH_SHAPED) {
      expect(parseBundleManifest(fenced(`skills: ${member}`)), member).toEqual({
        kind: 'invalid',
        problem: 'memberNameNotWellFormed',
      });
    }
  });

  it('refuses the whole manifest when one member of several is path-shaped', () => {
    // The narrower version of this parser would drop the bad name and keep the
    // good ones, which reads as tidy and hands the user a bundle that is not the
    // one written down.
    expect(parseBundleManifest(fenced('skills: commit-messages, ../evil, changelog'))).toEqual({
      kind: 'invalid',
      problem: 'memberNameNotWellFormed',
    });
  });

  it('cannot name a directory whose own name the host will not accept', () => {
    // The cost of spelling the crate's name rule at the manifest, written down
    // here rather than left to be discovered.
    //
    // `SkillStore::list` in `src-tauri/crates/vela-skills/src/store.rs` lists
    // *every* directory it finds — I read the function, not its doc comment: it
    // collects directory names, sorts them, and maps a header error to
    // `SkillListing::Invalid { directory, problem }` rather than skipping the
    // entry. `nameIsNotWellFormed` is one of those problems. So a directory
    // called `MySkill` can be installed, listed, and on the user's screen, and a
    // bundle still cannot name it.
    //
    // And the refusal is the whole manifest, not that one member: the name
    // never reaches resolution, so the bundle reads `invalid`, not a member
    // reading `missing`. That is stricter than it may look and it is what the
    // code does. The trade is deliberate — the alternative is a member-name rule
    // that accepts names the host's own rule does not, which is a second name
    // rule in a second place, and this module holds a copy of the first one
    // precisely to avoid that.
    const withMisnamed: readonly SkillListing[] = [
      ...LISTING,
      { kind: 'invalid', directory: 'MySkill', problem: 'nameIsNotWellFormed' },
    ];
    expect(
      withMisnamed.some((entry) => entry.directory === 'MySkill'),
      'the listing handed to the resolver must really carry the directory',
    ).toBe(true);

    expect(readBundle('bundle-release', fenced('skills: MySkill'), withMisnamed)).toEqual({
      kind: 'invalid',
      directory: 'bundle-release',
      problem: 'memberNameNotWellFormed',
    });
  });

  it('accepts a name up to the host’s limit and refuses one past it', () => {
    const atLimit = 'a'.repeat(SKILL_NAME_MAX_CHARS);
    expect(parseBundleManifest(fenced(`skills: ${atLimit}`))).toEqual({
      kind: 'manifest',
      members: [atLimit],
    });
    expect(parseBundleManifest(fenced(`skills: ${atLimit}a`))).toEqual({
      kind: 'invalid',
      problem: 'memberNameNotWellFormed',
    });
  });

  it('spells the same name rule the skills crate spells', () => {
    // The crate is the authority and this module holds a copy of its bound.
    // Read off disk rather than restated, so the copy cannot drift in silence.
    const crate = readFileSync(
      join(process.cwd(), 'src-tauri', 'crates', 'vela-skills', 'src', 'document.rs'),
      'utf8',
    );
    const declared = /pub const NAME_MAX_CHARS: usize = ([0-9_]+);/u.exec(crate);
    expect(declared?.[1], 'NAME_MAX_CHARS moved in document.rs; fix this guard').toBeDefined();
    expect(Number(declared?.[1]?.replaceAll('_', ''))).toBe(SKILL_NAME_MAX_CHARS);

    // The shape rule, sampled against the cases `is_well_formed_name` names in
    // its own doc comment: a leading hyphen, a trailing hyphen, a doubled
    // hyphen, and any uppercase.
    for (const refused of ['-lead', 'trail-', 'doub--le', 'Upper', 'under_score', 'dot.name']) {
      expect(parseBundleManifest(fenced(`skills: ${refused}`)), refused).toEqual({
        kind: 'invalid',
        problem: 'memberNameNotWellFormed',
      });
    }
    for (const accepted of ['a', 'a1', 'commit-messages', 'a-b-c-1']) {
      expect(parseBundleManifest(fenced(`skills: ${accepted}`)).kind, accepted).toBe('manifest');
    }
  });
});

describe('a bundle resolves against the listing the caller already has', () => {
  it('answers installed, broken and missing — and can answer all three', () => {
    // ── THE LOAD-BEARING TEST ──────────────────────────────────────────────
    // `broken` and `missing` are the pair worth the third arm: the same fact
    // from a distance and opposite instructions. A resolver that collapsed them
    // would tell somebody to install a directory already on their disk.
    const reading = readBundle(
      'bundle-release',
      fenced('skills: commit-messages, half-written, changelog'),
      LISTING,
    );

    expect(reading).toEqual({
      kind: 'bundle',
      directory: 'bundle-release',
      members: [
        {
          kind: 'installed',
          directory: 'commit-messages',
          name: 'commit-messages',
          description: 'Writes commit messages.',
        },
        { kind: 'broken', directory: 'half-written', problem: 'missingDescription' },
        { kind: 'missing', directory: 'changelog' },
      ],
    });

    // Totality, run rather than asserted in prose: every arm the type allows is
    // an arm this resolver produced above.
    const produced = new Set(
      reading.kind === 'bundle' ? reading.members.map((member) => member.kind) : [],
    );
    expect([...produced].sort()).toEqual(Object.keys(MEMBER_KINDS).sort());
  });

  it('carries a malformed manifest out as a reading, not as a throw', () => {
    // The store's precedent: a thing the user installed that cannot be read is
    // listed with its problem. `invalid` here is the same answer for the same
    // reason, and the panel words it beside the skill the root still is.
    expect(readBundle('bundle-release', '# no manifest here\n', LISTING)).toEqual({
      kind: 'invalid',
      directory: 'bundle-release',
      problem: 'manifestMissing',
    });
  });

  it('does not treat a member that is itself a bundle as anything special', () => {
    // A bundle naming a bundle is a skill naming a skill. No recursion, no
    // second read, no expansion — the format has no way to ask for one.
    expect(readBundle('bundle-release', fenced('skills: bundle-release'), LISTING)).toEqual({
      kind: 'bundle',
      directory: 'bundle-release',
      members: [
        {
          kind: 'installed',
          directory: 'bundle-release',
          name: 'bundle-release',
          description: 'A bundle.',
        },
      ],
    });
  });
});

describe('the claim a directory makes is its name', () => {
  it('reads the prefix off a listing entry, with no body', () => {
    expect(isBundleDirectory(`${BUNDLE_DIRECTORY_PREFIX}release`)).toBe(true);
    expect(isBundleDirectory('commit-messages')).toBe(false);
    // The reserved-namespace cost, asserted rather than left in the header: an
    // ordinary skill named into the prefix *is* claiming to be a bundle, and is
    // told so instead of being quietly passed over.
    expect(isBundleDirectory('bundle-analyzer')).toBe(true);
    expect(readBundle('bundle-analyzer', '# an ordinary skill\n', LISTING)).toEqual({
      kind: 'invalid',
      directory: 'bundle-analyzer',
      problem: 'manifestMissing',
    });
  });

  it('is a legal skill name, or the root could not be in the store at all', () => {
    // The prefix has to survive `is_well_formed_name`, since a bundle root is an
    // ordinary skill directory and the host would otherwise list it as invalid.
    expect(parseBundleManifest(fenced(`skills: ${BUNDLE_DIRECTORY_PREFIX}release`))).toEqual({
      kind: 'manifest',
      members: [`${BUNDLE_DIRECTORY_PREFIX}release`],
    });
  });
});
