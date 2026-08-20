/**
 * A line diff between two texts — and, in the same value, whether the answer is
 * an alignment or a fallback.
 *
 * ## Why lines, and why the longest common subsequence
 *
 * The question a user asks of a change is "what did it change", and the
 * answerable unit is a line: a character diff of reformatted source is a wall of
 * noise, and a whole-file replace answers nothing at all. The longest common
 * subsequence is the smallest edit script that is also *stable* — a line nothing
 * touched is reported unchanged even when the lines around it moved, which is
 * the property a greedy scan loses first and the one a reader notices
 * immediately.
 *
 * ## Why this is in `lib/` and not in a feature
 *
 * It lived inside the canvas feature, read only by the canvas version rail.
 * Two features need it now — the canvas rail and the code workspace's diff
 * review — and `src/features/README.md` is explicit: "If two features need the
 * same thing, it moves to `components/`, `data/`, `state/` or `lib/`." The
 * markdown parser took the same trip for the same reason.
 *
 * ## THE CAP, AND THE CLAIM IT USED TO MAKE
 *
 * The table is `before × after` cells, so a cap is real: past
 * {@link MAXIMUM_ALIGNED_LINES} on either side this stops aligning and reports a
 * wholesale replacement instead of freezing the pane.
 *
 * What the previous version got wrong was not the cap. It was that the fallback
 * **was indistinguishable from a real answer**. `diffLines` returned a bare row
 * array and `summariseDiff` counted rows, so two *identical* 2001-line texts
 * were summarised `{ added: 2001, removed: 2001 }` — and the panel printed
 * "2001 added, 2001 removed" about a pair of files that differed nowhere. Its
 * own header said the user "still sees that the thing changed", which is exactly
 * one notch narrower than the truth: the user was **told** a change that had not
 * happened, and no caller had any way to know.
 *
 * Two things close it, and both are needed:
 *
 *  1. **The common prefix and suffix are trimmed before the table is built.**
 *     The cap now applies to the *changed core*, not to the file, so the ordinary
 *     shape of a real edit — a few lines in a long file — never reaches it at
 *     all, and identical texts cost a linear scan and report nothing changed.
 *     On its own this would be the same defect one level down: a pair that
 *     differs at both ends still trims to nothing and still hits the cap.
 *  2. **`aligned` travels with the counts.** There is no way to obtain
 *     `added`/`removed` from this module without also obtaining the flag that
 *     says whether they count *changes* or merely count *lines*. The old shape
 *     let a caller take one without the other; this one does not, which is why
 *     `summariseDiff(rows)` is gone rather than merely corrected — a function
 *     that takes rows cannot answer the question, and that is the whole story of
 *     how the wrong number reached a user.
 *
 * Both readers of `aligned` are named in the code workspace's and the canvas's
 * diff headers; neither prints a count without qualifying it when it is false.
 */

export type DiffRow =
  | {
      readonly kind: 'same';
      readonly text: string;
      readonly leftLine: number;
      readonly rightLine: number;
    }
  | { readonly kind: 'removed'; readonly text: string; readonly leftLine: number }
  | { readonly kind: 'added'; readonly text: string; readonly rightLine: number };

/**
 * The largest **changed core** — after the common prefix and suffix are gone —
 * that is still worth aligning, per side.
 *
 * It is a chosen ceiling on a quadratic table, not a measurement: at this value
 * on both sides the table is four million cells, which is already more than a
 * review of a source file should ever need. It is deliberately named for what it
 * now bounds. The constant it replaced was `MAXIMUM_DIFF_LINES` and it bounded
 * the whole file, which is why an untouched long file used to fall off it.
 */
export const MAXIMUM_ALIGNED_LINES = 2000;

export interface TextDiff {
  /** The diff, top to bottom, in reading order. */
  readonly rows: readonly DiffRow[];
  /**
   * Rows of kind `added`. A count of **changes** when {@link aligned}; a count
   * of the right-hand core's lines when not.
   */
  readonly added: number;
  /** The same, for `removed` and the left-hand core. */
  readonly removed: number;
  /**
   * Whether the changed core was small enough to align.
   *
   * `false` means `rows` is the fallback: every core line on the left reported
   * removed and every core line on the right reported added, whether or not any
   * of them differ. A surface that prints `added`/`removed` **must** qualify
   * them when this is false; see the module header for the defect that is.
   */
  readonly aligned: boolean;
}

function lines(source: string): readonly string[] {
  return source.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * The diff, with line numbers on the side each row exists in.
 *
 * Line numbers are 1-based because they are shown to a person, and a row that
 * exists on only one side carries only that side's number rather than a zero —
 * a zero in a gutter reads as line zero, which no file has.
 */
export function diffText(before: string, after: string): TextDiff {
  const left = lines(before);
  const right = lines(after);
  const shortest = Math.min(left.length, right.length);

  let head = 0;
  while (head < shortest && left[head] === right[head]) head += 1;

  // The suffix scan is bounded by what the prefix left, not by the shorter
  // file. Without that bound the two scans claim the same line twice whenever
  // one text is a prefix of the other — `a` against `a\na` would trim a head of
  // one and a tail of one out of a single left-hand line and produce a negative
  // slice, which reads as "nothing changed" about an inserted line.
  let tail = 0;
  const trimmable = shortest - head;
  while (
    tail < trimmable &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1;
  }

  const coreLeft = left.slice(head, left.length - tail);
  const coreRight = right.slice(head, right.length - tail);
  const aligned =
    coreLeft.length <= MAXIMUM_ALIGNED_LINES && coreRight.length <= MAXIMUM_ALIGNED_LINES;

  const rows: DiffRow[] = [];
  for (let index = 0; index < head; index += 1) {
    rows.push({
      kind: 'same',
      text: left[index] ?? '',
      leftLine: index + 1,
      rightLine: index + 1,
    });
  }

  let added = 0;
  let removed = 0;
  for (const row of aligned
    ? alignCore(coreLeft, coreRight, head)
    : replaceCore(coreLeft, coreRight, head)) {
    rows.push(row);
    if (row.kind === 'added') added += 1;
    else if (row.kind === 'removed') removed += 1;
  }

  for (let index = 0; index < tail; index += 1) {
    const leftLine = left.length - tail + index + 1;
    rows.push({
      kind: 'same',
      text: left[leftLine - 1] ?? '',
      leftLine,
      rightLine: right.length - tail + index + 1,
    });
  }

  return { rows, added, removed, aligned };
}

/**
 * The fallback: the core replaced wholesale.
 *
 * Still emitted as rows, because the user is entitled to see both texts — what
 * they lose is the alignment. What they must not lose is being told so, which is
 * {@link TextDiff.aligned}'s job.
 */
function replaceCore(
  left: readonly string[],
  right: readonly string[],
  offset: number,
): readonly DiffRow[] {
  return [
    ...left.map<DiffRow>((text, index) => ({
      kind: 'removed',
      text,
      leftLine: offset + index + 1,
    })),
    ...right.map<DiffRow>((text, index) => ({
      kind: 'added',
      text,
      rightLine: offset + index + 1,
    })),
  ];
}

function alignCore(
  left: readonly string[],
  right: readonly string[],
  offset: number,
): readonly DiffRow[] {
  // `table[i][j]` is the length of the longest common subsequence of
  // `left.slice(i)` and `right.slice(j)`. Built from the end so the walk below
  // can go forwards, which is the order the rows are read in.
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      const row = table[i] ?? [];
      const next = table[i + 1] ?? [];
      row[j] =
        left[i] === right[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const leftText = left[i] ?? '';
    const rightText = right[j] ?? '';
    if (leftText === rightText) {
      rows.push({
        kind: 'same',
        text: leftText,
        leftLine: offset + i + 1,
        rightLine: offset + j + 1,
      });
      i += 1;
      j += 1;
      continue;
    }
    const dropLeft = table[i + 1]?.[j] ?? 0;
    const dropRight = table[i]?.[j + 1] ?? 0;
    // Ties go to the removal, so a replaced line reads as "the old one went,
    // then the new one came" rather than the other way round.
    if (dropLeft >= dropRight) {
      rows.push({ kind: 'removed', text: leftText, leftLine: offset + i + 1 });
      i += 1;
    } else {
      rows.push({ kind: 'added', text: rightText, rightLine: offset + j + 1 });
      j += 1;
    }
  }
  while (i < left.length) {
    rows.push({ kind: 'removed', text: left[i] ?? '', leftLine: offset + i + 1 });
    i += 1;
  }
  while (j < right.length) {
    rows.push({ kind: 'added', text: right[j] ?? '', rightLine: offset + j + 1 });
    j += 1;
  }

  return rows;
}
