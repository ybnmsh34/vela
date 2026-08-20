/**
 * The skills pane: every directory in the skill store, and what is in one.
 *
 * ## Why a reader and not an editor
 *
 * A skill is a directory of files the user owns and edits with their own
 * editor. `src-tauri/src/ipc/skills.rs` exposes two commands and both of them
 * read — there is no write, no upload and no delete to put a control in front
 * of — so this pane shows what is in the store and the footnote says out loud
 * that Vela does not change it. A pane that implied otherwise would be
 * promising an affordance that does not exist.
 *
 * It does **not** print the store's path, and that is an omission rather than a
 * decision to leave unstated: no command this pane calls returns one, and
 * inventing the path in the renderer would mean a sentence on screen that
 * nothing verified against the directory the host actually read.
 *
 * ## Two levels, two views, and the reason they are not one
 *
 * The list is name-and-description for every installed skill; the body is a
 * second call for exactly one of them. That is the public Agent Skills loading
 * model, and `src/data/skills-repository.ts` gives the argument for keeping the
 * cheap call cheap. So the list draws no body — it has none to draw — and
 * clicking a row is what spends the second call.
 *
 * ## A broken skill is listed, with its problem
 *
 * The load-bearing behaviour of this file. A directory the host could not parse
 * gets a row like any other, carrying a sentence saying what is wrong with it
 * instead of a description. A surface that filtered `kind === 'invalid'` out
 * would be tidier and would mean a user who mistyped a frontmatter key watches
 * their skill disappear with nothing anywhere saying why. The host already
 * refuses that — `a_broken_skill_is_listed_with_its_problem_rather_than_dropped`
 * in `src-tauri/crates/vela-skills/src/store.rs` holds it against real
 * directories — and this is the layer that could still throw it away.
 *
 * The vocabulary is closed and the **renderer** words it: `SkillProblem` in
 * `src/platform/contract.ts` is a fourteen-variant union transcribed from
 * `src-tauri/crates/vela-skills/src/document.rs`, and {@link PROBLEM_LABELS} is
 * a total map over it.
 *
 * **What that does and does not buy, measured in both directions.** A variant
 * added to the *TypeScript* union with no sentence here fails `pnpm typecheck`,
 * and the error names this file: `TS2741: Property … is missing in type … but
 * required in type 'Record<SkillProblem, string>'`. A variant added in *Rust*
 * does not reach this file at all — the union has not widened, so the map is
 * still total and `pnpm typecheck` exits **0**. That direction is caught one
 * gate later, at `pnpm test`, by `src/platform/skill-store-parity.test.ts`,
 * which reads the crate's source off disk and compares the wire names; its
 * `agrees on why a directory is not a skill` is the assertion that goes red.
 *
 * The distinction is worth the paragraph because it is the difference between
 * the first gate in `pnpm verify` and the third, and because an earlier draft of
 * this comment claimed both directions for `pnpm typecheck` — overstating a
 * guard's reach, which is the failure `skill-store-parity.test.ts` spends its
 * own header on. Both directions above were re-measured by adding a probe
 * variant to each side in turn.
 *
 * Each sentence is derived from the check that produces it in `document.rs`,
 * not from the variant's spelling: the length limits are `NAME_MAX_CHARS` and
 * `DESCRIPTION_MAX_CHARS`, and both count characters rather than bytes.
 */

import { useRef } from 'react';

import { ModalSurface } from '@/components/ModalSurface';
import {
  isBundleDirectory,
  readBundle,
  type BundleMember,
  type BundleProblem,
  type BundleReading,
} from '@/data/skill-bundles';
import type { SkillListing, SkillProblem, SkillResources, SkillsReadRes } from '@/platform/contract';

import styles from './SkillsPanel.module.css';
import { useSkills, type SkillsController } from './use-skills';

/**
 * What the user reads for each way a directory can fail to be a skill.
 *
 * A `Record` rather than a `switch` with a default: the default is what turns a
 * new variant into the word "other" on somebody's screen, and typing it as total
 * is what makes the compiler ask for the sentence instead.
 */
const PROBLEM_LABELS: Record<SkillProblem, string> = {
  noSkillFile: 'This folder has no SKILL.md file in it.',
  unreadable: 'Its SKILL.md file could not be read from disk.',
  noFrontmatter: 'Its SKILL.md does not start with a --- frontmatter block.',
  unterminatedFrontmatter: 'Its frontmatter block is opened but never closed.',
  unsupportedFrontmatterSyntax:
    'Its frontmatter uses YAML beyond the key-value lines and one level of nesting this reader accepts.',
  duplicateFrontmatterKey: 'Its frontmatter sets the same key twice.',
  missingName: 'Its frontmatter has no name, or the name is empty.',
  missingDescription: 'Its frontmatter has no description.',
  nameIsNotWellFormed:
    'Its name may only be lowercase letters, digits and single hyphens, and may not begin or end with a hyphen.',
  nameTooLong: 'Its name is longer than 64 characters.',
  nameDoesNotMatchDirectory: 'Its name does not match the folder it is in.',
  descriptionIsEmpty: 'Its description is empty or only whitespace.',
  descriptionTooLong: 'Its description is longer than 1024 characters.',
  nameIsNotASinglePathSegment: 'Its name is not a single path segment.',
};

/**
 * What the user reads for each way a directory that claims to be a bundle fails
 * to be one.
 *
 * The same `Record` device as {@link PROBLEM_LABELS} and for the same reason: a
 * `BundleProblem` added in `src/data/skill-bundles.ts` with no sentence here
 * fails `pnpm typecheck` naming this file, where a `switch` with a default would
 * put the word "other" on somebody's screen.
 *
 * Unlike {@link PROBLEM_LABELS} this vocabulary has no Rust twin, so there is no
 * second direction for a parity test to hold — `skill-bundles.ts` defines and
 * produces every variant, and the compiler is the whole guard rather than the
 * first half of one. That is stated because the neighbouring map needed the
 * second half and it would be easy to assume this one does too.
 */
const BUNDLE_PROBLEM_LABELS: Record<BundleProblem, string> = {
  manifestMissing: 'Its SKILL.md has no ```vela-bundle block listing what it contains.',
  manifestUnterminated: 'Its ```vela-bundle block is opened and never closed.',
  manifestRepeated: 'Its SKILL.md has more than one ```vela-bundle block.',
  manifestSyntax: 'A line in its ```vela-bundle block is not written as key: value.',
  manifestUnknownKey: 'Its ```vela-bundle block sets a key other than skills.',
  manifestDuplicateKey: 'Its ```vela-bundle block sets the same key twice.',
  membersMissing: 'Its ```vela-bundle block has no skills key.',
  membersEmpty: 'Its skills key lists nothing.',
  memberNameNotWellFormed:
    'One of the names in its skills key is not a skill name: lowercase letters, digits and single hyphens, up to 64 characters.',
  memberRepeated: 'Its skills key names the same skill twice.',
};

/** The three conventional subdirectories, with the words the user reads. */
const RESOURCE_GROUPS: readonly (readonly [keyof SkillResources, string])[] = [
  ['scripts', 'Scripts'],
  ['references', 'References'],
  ['assets', 'Assets'],
];

interface SkillsPanelProps {
  readonly onClose: () => void;
  /** Substituted in tests; defaults to one built over the platform adapter. */
  readonly controller?: SkillsController;
}

export function SkillsPanel({ onClose, controller }: SkillsPanelProps) {
  // Called unconditionally — hooks may not be skipped — and its result is
  // discarded when the caller supplied one. The alternative is two components.
  const own = useSkills();
  const skills = controller ?? own;

  const closeRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalSurface
      labelledBy="skills-title"
      describedBy="skills-intro"
      scrimClassName={styles.scrim}
      className={styles.dialog}
      initialFocus={closeRef}
      onDismiss={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          // Escape closes the pane rather than stepping back to the list. One
          // key, one meaning, matching the other two dialogs; the way back to
          // the list is the control that says so.
          onClose();
        }
      }}
    >
      <div className={styles.head}>
        <h2 id="skills-title" className={styles.title}>
          Skills
        </h2>
        <button type="button" ref={closeRef} className={styles.close} onClick={onClose}>
          Close
        </button>
      </div>

      <p id="skills-intro" className={styles.intro}>
        Skills are folders in Vela’s skill store on this device. Each one holds a SKILL.md file
        describing when to use it, and may bundle scripts, references and assets alongside it.
      </p>

      {skills.detail.status === 'none' ? (
        <SkillsList skills={skills} />
      ) : (
        <SkillDetail skills={skills} />
      )}

      <p className={styles.footnote}>
        Vela reads this folder and never writes to it. Add, edit or remove a skill with your own
        editor, then reopen this pane.
      </p>
    </ModalSurface>
  );
}

function SkillsList({ skills }: { readonly skills: SkillsController }) {
  const { list } = skills;

  if (list.status === 'loading') {
    return (
      <p className={styles.note} data-testid="skills-loading">
        Reading the skill store…
      </p>
    );
  }

  if (list.status === 'error') {
    // An empty store and a store that could not be read look identical drawn as
    // an empty list, and one of them is a lie.
    return (
      <p className={styles.error} role="status">
        Skills unavailable · {list.code}
      </p>
    );
  }

  if (list.skills.length === 0) {
    return <p className={styles.note}>No skills are installed yet.</p>;
  }

  return (
    <ul className={styles.list}>
      {list.skills.map((entry) => (
        <li key={entry.directory}>
          <SkillRow entry={entry} onOpen={() => void skills.select(entry.directory)} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One row. Clickable in both arms, including the broken one — reading a
 * directory that is not a skill is a question the host answers, and answering
 * it is how the user finds out which line to go and fix.
 */
function SkillRow({
  entry,
  onOpen,
}: {
  readonly entry: SkillListing;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={entry.kind === 'skill' ? styles.row : `${styles.row} ${styles.rowBroken}`}
      onClick={onOpen}
    >
      <span className={styles.rowName}>
        {entry.kind === 'skill' ? entry.name : entry.directory}
      </span>
      {entry.kind === 'skill' ? (
        <span className={styles.rowDescription}>{entry.description}</span>
      ) : (
        <span className={styles.rowProblem}>
          Not readable as a skill · {PROBLEM_LABELS[entry.problem]}
        </span>
      )}
    </button>
  );
}

function SkillDetail({ skills }: { readonly skills: SkillsController }) {
  const { detail } = skills;
  if (detail.status === 'none') return null;

  return (
    <div className={styles.detail}>
      <button
        type="button"
        className={styles.back}
        onClick={() => {
          skills.clearSelection();
        }}
      >
        ← All skills
      </button>

      {detail.status === 'loading' && (
        <p className={styles.note} data-testid="skill-loading">
          Reading {detail.directory}…
        </p>
      )}

      {detail.status === 'error' && (
        <p className={styles.error} role="status">
          {detail.directory} could not be read · {detail.code}
        </p>
      )}

      {detail.status === 'ready' && (
        <SkillContents
          directory={detail.directory}
          read={detail.detail}
          // The listing this pane already fetched when it opened. Handed down
          // rather than re-requested: resolving a bundle's members costs no host
          // call, which is the property `src/data/skill-bundles.ts` is built to
          // have and `skills-reachable.test.tsx` asserts by counting commands.
          listing={skills.list.status === 'ready' ? skills.list.skills : []}
        />
      )}
    </div>
  );
}

function SkillContents({
  directory,
  read,
  listing,
}: {
  readonly directory: string;
  readonly read: SkillsReadRes;
  readonly listing: readonly SkillListing[];
}) {
  if (read.kind === 'invalid') {
    // Not an error path: the host answered truthfully, and the answer is that
    // the file on disk is not a skill. The same sentence the row carries, so a
    // user who clicked to find out more is not shown different words.
    return (
      <>
        <h3 className={styles.detailName}>{directory}</h3>
        <p className={styles.rowProblem}>
          Not readable as a skill · {PROBLEM_LABELS[read.problem]}
        </p>
        <p className={styles.note}>
          There are no instructions to show until its SKILL.md file parses.
        </p>
      </>
    );
  }

  return (
    <>
      <h3 className={styles.detailName}>{read.name}</h3>
      <p className={styles.detailDescription}>{read.description}</p>

      {isBundleDirectory(directory) && (
        <BundleContents reading={readBundle(directory, read.body, listing)} />
      )}

      <p className={styles.sectionLabel}>Instructions</p>
      {/* The file's own text, not a rendering of it. This pane exists to show
          what is on disk; putting a Markdown renderer between the user and the
          bytes would mean anything the parser dropped is invisible in the one
          place they came to look. */}
      <pre className={styles.body}>{read.body}</pre>

      <SkillResourceList resources={read.resources} />
    </>
  );
}

/**
 * What a bundle contains, under the bundle root's own heading.
 *
 * Rendered above the instructions rather than below them because it is the
 * reason the user opened this entry: for a bundle the instruction body is mostly
 * the manifest they are being told about.
 *
 * **No new CSS.** Every class here already exists in `SkillsPanel.module.css`
 * and every colour is already a token, which is the cheapest way to obey the
 * standing rule that no colour value is introduced: none is, because no
 * declaration is.
 */
function BundleContents({ reading }: { readonly reading: BundleReading }) {
  if (reading.kind === 'invalid') {
    // The precedent, applied: a directory that claims to be a bundle and is not
    // readable as one says so, in the window, next to the skill it still is.
    // The alternative — render nothing and let it be an ordinary skill — is the
    // silent drop `use-skills.ts` calls the load-bearing omission.
    return (
      <>
        <p className={styles.sectionLabel}>Bundle</p>
        <p className={styles.rowProblem}>
          Not readable as a bundle · {BUNDLE_PROBLEM_LABELS[reading.problem]}
        </p>
      </>
    );
  }

  return (
    <>
      <p className={styles.sectionLabel}>Bundle · {reading.members.length} skills</p>
      <ul className={styles.resources}>
        {reading.members.map((member) => (
          <li key={member.directory} className={styles.resourceGroup}>
            <BundleMemberRow member={member} />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * One member of a bundle.
 *
 * The three arms of {@link BundleMember} are worded separately and none of them
 * is a default. `broken` and `missing` are the pair that matters: they are the
 * same fact from a distance — you cannot use this skill — and opposite
 * instructions, so a shared sentence would send somebody to install a directory
 * that is already on their disk.
 */
function BundleMemberRow({ member }: { readonly member: BundleMember }) {
  switch (member.kind) {
    case 'installed':
      return (
        <>
          <span className={styles.rowName}>{member.name}</span>
          <span className={styles.rowDescription}>{member.description}</span>
        </>
      );
    case 'broken':
      return (
        <>
          <span className={styles.rowName}>{member.directory}</span>
          <span className={styles.rowProblem}>
            Installed and not readable as a skill · {PROBLEM_LABELS[member.problem]}
          </span>
        </>
      );
    case 'missing':
      return (
        <>
          <span className={styles.rowName}>{member.directory}</span>
          <span className={styles.rowProblem}>
            Named by this bundle and not in the skill store.
          </span>
        </>
      );
  }
}

/**
 * The third level of disclosure: **names only**.
 *
 * `SkillResources` in `src/platform/contract.ts` carries filenames and no
 * contents, and no command crosses the bridge with a resource file's bytes. So
 * this lists what a skill brings with it and stops there, which is also the
 * whole truth about what Vela has read.
 */
function SkillResourceList({ resources }: { readonly resources: SkillResources }) {
  const populated = RESOURCE_GROUPS.filter(([key]) => resources[key].length > 0);

  if (populated.length === 0) {
    return (
      <>
        <p className={styles.sectionLabel}>Files</p>
        <p className={styles.note}>This skill bundles no other files.</p>
      </>
    );
  }

  return (
    <div className={styles.resources}>
      <p className={styles.sectionLabel}>Files</p>
      {populated.map(([key, label]) => (
        <div key={key}>
          <p className={styles.note}>{label}</p>
          <ul className={styles.resourceGroup} aria-label={label}>
            {resources[key].map((file) => (
              <li key={file} className={styles.resourceName}>
                {file}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
