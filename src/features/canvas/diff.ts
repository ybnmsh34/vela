/**
 * A line diff between two revisions of one artifact.
 *
 * ## Why lines, and why the longest common subsequence
 *
 * The question a user asks of a version rail is "what did it change", and for a
 * document the answerable unit is a line: a character diff of reformatted HTML
 * is a wall of noise, and a whole-file replace answers nothing at all. The
 * longest common subsequence is the smallest edit script that is also *stable* —
 * a line the model did not touch is reported unchanged even when the lines
 * around it moved, which is the property a greedy scan loses first and the one a
 * reader notices immediately.
 *
 * ## The cap, and why it is a fallback rather than a refusal
 *
 * The table is `before × after` cells. At {@link MAXIMUM_DIFF_LINES} on both
 * sides that is four million, which is already more than a diff of a
 * model-authored artifact should ever need; past it this reports one whole-file
 * replacement instead of freezing the panel. The user still sees both texts and
 * still sees that the thing changed — they lose the alignment, not the fact.
 * Refusing outright would be worse: the version they are looking at is real.
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

/** Past this on either side the table is not worth building. See the header. */
export const MAXIMUM_DIFF_LINES = 2000;

export interface DiffSummary {
  readonly added: number;
  readonly removed: number;
}

function lines(source: string): readonly string[] {
  return source.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Rows in reading order: the diff, top to bottom, with line numbers on the side
 * each row exists in.
 *
 * Line numbers are 1-based because they are shown to a person, and a row that
 * exists on only one side carries only that side's number rather than a zero —
 * a zero in a gutter reads as line zero, which no file has.
 */
export function diffLines(before: string, after: string): readonly DiffRow[] {
  const left = lines(before);
  const right = lines(after);

  if (left.length > MAXIMUM_DIFF_LINES || right.length > MAXIMUM_DIFF_LINES) {
    return [
      ...left.map<DiffRow>((text, index) => ({ kind: 'removed', text, leftLine: index + 1 })),
      ...right.map<DiffRow>((text, index) => ({ kind: 'added', text, rightLine: index + 1 })),
    ];
  }

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
      rows.push({ kind: 'same', text: leftText, leftLine: i + 1, rightLine: j + 1 });
      i += 1;
      j += 1;
      continue;
    }
    const dropLeft = table[i + 1]?.[j] ?? 0;
    const dropRight = table[i]?.[j + 1] ?? 0;
    // Ties go to the removal, so a replaced line reads as "the old one went,
    // then the new one came" rather than the other way round.
    if (dropLeft >= dropRight) {
      rows.push({ kind: 'removed', text: leftText, leftLine: i + 1 });
      i += 1;
    } else {
      rows.push({ kind: 'added', text: rightText, rightLine: j + 1 });
      j += 1;
    }
  }
  while (i < left.length) {
    rows.push({ kind: 'removed', text: left[i] ?? '', leftLine: i + 1 });
    i += 1;
  }
  while (j < right.length) {
    rows.push({ kind: 'added', text: right[j] ?? '', rightLine: j + 1 });
    j += 1;
  }

  return rows;
}

export function summariseDiff(rows: readonly DiffRow[]): DiffSummary {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'added') added += 1;
    if (row.kind === 'removed') removed += 1;
  }
  return { added, removed };
}
