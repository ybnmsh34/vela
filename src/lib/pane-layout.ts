/**
 * THE PANE LAYOUT — columns of stacked panes, and the arithmetic of dragging
 * their edges around.
 *
 * A workspace is a row of columns; a column is a stack of panes. Two levels, not
 * a general tree. A tree is what an editor eventually needs and it is also where
 * this kind of module goes wrong: every operation acquires a recursive case,
 * every invariant acquires a "…at every depth", and the drag arithmetic acquires
 * a coordinate frame per node. Two levels covers "chat beside a diff, with the
 * editor under the diff", which is the arrangement the surface is for, and it
 * can be read in one sitting. Widening it later is a rewrite of this file and
 * nothing else, because nothing outside it knows the shape.
 *
 * ## Generic over the pane id on purpose
 *
 * `src/lib/` sits at the bottom of the graph and may not know which panes the
 * product has (`src/lib/README.md`). It is also what makes the invariants
 * testable: the feature's `PaneKind` is a closed union of the panes that exist,
 * so a test written against it could not build the thirteen-column case that
 * breaks a naively-written minimum-size floor — thirteen siblings cannot each
 * hold `MINIMUM_SHARE` of 1/12, so `floorFor` has to give way to 1/13.
 * `pane-layout.test.ts` builds it with string ids
 * (`still contains where the edge is when the floor is all there is`), and a
 * twenty-column layout with them too.
 *
 * ## Weights, not pixels
 *
 * A column's `weight` is its share of the workspace width; a slot's `weight` is
 * its share of its column's height. Shares survive a window resize and a
 * display change, which pixels do not — the same argument `src/styles/tokens.css`
 * makes for `--vela-measure` being a `clamp()` rather than a number.
 *
 * ## Clamped, never rejected
 *
 * Every operation here returns a layout. Dragging a splitter past its neighbour's
 * floor stops at the floor; closing a pane that is not open returns the layout
 * unchanged; moving a pane onto the position it already occupies is identity.
 * This mirrors `src-tauri/src/ipc/ui.rs`, which clamps a sidebar width rather
 * than erroring: a layout is a preference, not an assertion, and a drag that
 * throws is a drag that loses the user's other panes.
 */

/** One pane and the share of its column's height it takes. */
export interface PaneSlot<Id extends string> {
  readonly pane: Id;
  readonly weight: number;
}

/** One column and the share of the workspace's width it takes. */
export interface PaneColumn<Id extends string> {
  readonly slots: readonly PaneSlot<Id>[];
  readonly weight: number;
}

export interface PaneLayout<Id extends string> {
  readonly columns: readonly PaneColumn<Id>[];
}

/** Where a pane is, as a pair of indices. `null` when it is not open. */
export interface PanePosition {
  readonly column: number;
  readonly slot: number;
}

/**
 * The smallest share a column or a slot may be dragged down to, when there is
 * room for it.
 *
 * A **share**, so it has to survive being asked of a layout that cannot grant
 * it: thirteen columns cannot each hold a twelfth, because thirteen twelfths is
 * more than the whole. {@link floorFor} is what turns the wish into an answer,
 * and it is the reason this is not simply compared against — a floor larger than
 * `1 / count` makes every drag a no-op and every layout un-normalisable, which
 * is the kind of thing that looks fine until someone opens the thirteenth pane.
 *
 * The value itself is a judgement, not a measurement: at a 1280px workspace a
 * twelfth is 107px, which is about where a pane header's own controls stop
 * fitting. It is not derived from a measured minimum and should not be quoted as
 * one.
 */
export const MINIMUM_SHARE = 1 / 12;

/** The largest floor `count` siblings can all be given at once. */
export function floorFor(count: number): number {
  if (count <= 0) return 0;
  return Math.min(MINIMUM_SHARE, 1 / count);
}

/**
 * The share to hand a pane joining `incumbents` siblings whose shares already
 * sum to 1: the average of theirs.
 *
 * {@link normalise} then scales the set back down to 1, and the average is the
 * one value that lands the newcomer on an even `1 / (incumbents + 1)` while
 * scaling every incumbent by the same factor — so a user who dragged two panes
 * to 70/30 still has them at 70/30 relative to each other afterwards. Handing it
 * `1 / (incumbents + 1)` instead, which is the intuitive guess, makes the
 * newcomer arrive at `1 / (incumbents + 2)` — visibly thinner than its
 * neighbours on every open.
 *
 * There was an `incumbents <= 0 ? 1 :` arm here and it is gone. Zero incumbents
 * happens once — {@link openPane} on the empty layout, which is what closing the
 * last pane leaves — and the arm was unobservable there: `1 / 0` is `Infinity`,
 * {@link normalise}'s sanitiser reads it as zero, the single member falls to the
 * floor, and `evenly(1)` hands it the whole width, which is the same `1` the arm
 * returned. Two answers to one question, one of which no test could reach.
 * Deleting it makes the sanitiser load-bearing instead of merely defensive, and
 * `opens the first pane of an empty workspace at the full width` is what asserts
 * both at once: with the sanitiser gone as well, that weight is `NaN`.
 */
function newcomerShare(incumbents: number): number {
  return 1 / incumbents;
}

/** Shares, summing to 1, with every sibling equal. */
function evenly(count: number): number[] {
  return Array.from({ length: count }, () => (count === 0 ? 0 : 1 / count));
}

/**
 * Rescale so the shares sum to 1 and none is below the floor.
 *
 * Order matters and the naive order is wrong: lifting a member to the floor
 * *after* scaling breaks the sum again. So the members below the floor are
 * pinned first, and only the remainder is scaled into what is left — which is
 * exactly the division a splitter drag has to make anyway.
 */
function normalise(weights: readonly number[]): number[] {
  const count = weights.length;
  if (count === 0) return [];
  const floor = floorFor(count);

  const usable = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
  const pinned = usable.map((weight) => weight <= floor);
  const pinnedTotal = pinned.filter(Boolean).length * floor;
  const freeTotal = usable.reduce(
    (total, weight, index) => total + (pinned[index] === true ? 0 : weight),
    0,
  );
  const freeRoom = 1 - pinnedTotal;

  if (freeTotal <= 0 || freeRoom <= 0) return evenly(count);

  return usable.map((weight, index) =>
    pinned[index] === true ? floor : (weight / freeTotal) * freeRoom,
  );
}

function withColumnWeights<Id extends string>(
  columns: readonly PaneColumn<Id>[],
): PaneLayout<Id> {
  const kept = columns.filter((column) => column.slots.length > 0);
  const weights = normalise(kept.map((column) => column.weight));
  return {
    columns: kept.map((column, index) => ({
      slots: withSlotWeights(column.slots),
      weight: weights[index] ?? 0,
    })),
  };
}

function withSlotWeights<Id extends string>(slots: readonly PaneSlot<Id>[]): PaneSlot<Id>[] {
  const weights = normalise(slots.map((slot) => slot.weight));
  return slots.map((slot, index) => ({ pane: slot.pane, weight: weights[index] ?? 0 }));
}

/** The empty workspace. Legal, and what closing the last pane leaves. */
export function emptyLayout<Id extends string>(): PaneLayout<Id> {
  return { columns: [] };
}

/**
 * One column per pane, left to right, evenly divided.
 *
 * The starting arrangement, and the answer to "reset layout". Panes given twice
 * appear once: a layout holding the same pane in two places has no meaning, and
 * silently de-duplicating is better than a constructor that can throw at start-up.
 */
export function columnsOf<Id extends string>(...panes: readonly Id[]): PaneLayout<Id> {
  const unique = [...new Set(panes)];
  return withColumnWeights(
    unique.map((pane) => ({ slots: [{ pane, weight: 1 }], weight: 1 / unique.length })),
  );
}

/** Every open pane in visual order: columns left to right, slots top to bottom. */
export function paneOrder<Id extends string>(layout: PaneLayout<Id>): readonly Id[] {
  return layout.columns.flatMap((column) => column.slots.map((slot) => slot.pane));
}

export function positionOf<Id extends string>(
  layout: PaneLayout<Id>,
  pane: Id,
): PanePosition | null {
  for (const [column, entry] of layout.columns.entries()) {
    const slot = entry.slots.findIndex((candidate) => candidate.pane === pane);
    if (slot !== -1) return { column, slot };
  }
  return null;
}

export function isOpen<Id extends string>(layout: PaneLayout<Id>, pane: Id): boolean {
  return positionOf(layout, pane) !== null;
}

/**
 * Open a pane in a column of its own, on the right. Already-open is identity —
 * the Views menu is a list of panes, not a list of copies.
 */
export function openPane<Id extends string>(layout: PaneLayout<Id>, pane: Id): PaneLayout<Id> {
  if (isOpen(layout, pane)) return layout;
  return withColumnWeights([
    ...layout.columns,
    { slots: [{ pane, weight: 1 }], weight: newcomerShare(layout.columns.length) },
  ]);
}

/**
 * Close a pane. A column that loses its last pane goes with it, and the width it
 * held is shared out among the columns that remain rather than left as a gap.
 */
export function closePane<Id extends string>(layout: PaneLayout<Id>, pane: Id): PaneLayout<Id> {
  if (!isOpen(layout, pane)) return layout;
  return withColumnWeights(
    layout.columns.map((column) => ({
      ...column,
      slots: column.slots.filter((slot) => slot.pane !== pane),
    })),
  );
}

/**
 * Move a pane to a column and a position within it — what a drag commits, and
 * what the pane header's keyboard menu calls directly.
 *
 * `column` may be `layout.columns.length`, meaning "a new column on the right",
 * and `-1`, meaning "a new column on the left". Anything further out is clamped
 * to those, because a drop lands where the pointer was and a pointer can be
 * anywhere.
 *
 * The removal happens first and the indices are resolved **after** it, which is
 * the only ordering that makes "move down one inside my own column" mean what a
 * user means by it.
 */
export function movePane<Id extends string>(
  layout: PaneLayout<Id>,
  pane: Id,
  column: number,
  slot: number,
): PaneLayout<Id> {
  const from = positionOf(layout, pane);
  if (from === null) return layout;
  // Alone in its column and dropped back on that column: it already *is* that
  // column. Without this the removal deletes the column, every index to its
  // right slides down one, and "drop where you picked it up" moves the pane
  // into its neighbour.
  if (column === from.column && layout.columns[from.column]?.slots.length === 1) return layout;

  const emptied = layout.columns
    .map((entry) => ({
      ...entry,
      slots: entry.slots.filter((candidate) => candidate.pane !== pane),
    }))
    .filter((entry) => entry.slots.length > 0);

  // A column index counted before the removal; if the pane's old column
  // disappeared and it was to the left, everything to its right shifted down one.
  const lostColumn = layout.columns[from.column]?.slots.length === 1;
  const shifted = lostColumn && column > from.column ? column - 1 : column;

  if (shifted < 0 || shifted >= emptied.length) {
    const atLeft = shifted < 0;
    const fresh = { slots: [{ pane, weight: 1 }], weight: newcomerShare(emptied.length) };
    return withColumnWeights(atLeft ? [fresh, ...emptied] : [...emptied, fresh]);
  }

  const target = emptied[shifted];
  if (target === undefined) return layout;
  // Lower bound only. `Array.prototype.splice` clamps an index past the end to
  // the end itself, so an upper clamp here is a second answer to a question
  // already answered and nothing could ever tell it from the first — a measurer
  // deleted the whole expression and the suite stayed green. A *negative* slot
  // is different: `splice(-1, 0, x)` counts from the end and drops the pane one
  // short of where it was asked for, which is what
  // `puts a pane asked for before the first slot at the first slot, not one
  // short of the end` measures.
  const index = Math.max(0, slot);
  const slots = [...target.slots];
  slots.splice(index, 0, { pane, weight: newcomerShare(target.slots.length) });

  return withColumnWeights(
    emptied.map((entry, entryIndex) => (entryIndex === shifted ? { ...entry, slots } : entry)),
  );
}

/**
 * How far the member **before** an edge can be dragged, as shares of the whole.
 *
 * Not the same question as "what is the floor". A floor is a fact about one
 * member; how far an *edge* can travel is a fact about the pair it divides,
 * because everything the member before gains is taken from the member after and
 * stops when *that* one reaches its floor. Three even columns with a floor of a
 * twelfth give an edge a reachable range of 8%–58%, not 8%–92%: the second
 * column runs out first.
 *
 * It exists because the splitter announces this range through `aria-valuemin`
 * and `aria-valuemax`, and it was announcing `100 - floor` — a maximum computed
 * from an input that cannot answer the question, which is the same defect this
 * workspace's diff stat was fixed for. {@link shiftPair} is the only thing that
 * knows, so the answer is derived here beside it rather than approximated at the
 * control.
 */
export interface EdgeRange {
  /** The smallest share the member before the edge can be dragged to. */
  readonly min: number;
  /** The largest. */
  readonly max: number;
}

function rangeOfPair(weights: readonly number[], boundary: number): EdgeRange | null {
  const before = weights[boundary];
  const after = weights[boundary + 1];
  if (before === undefined || after === undefined) return null;
  const floor = floorFor(weights.length);
  // `Math.min`/`Math.max` against the current share is defensive, not a case
  // this layout reaches: `normalise` pins every member at or above `floorFor`,
  // and past twelve siblings `floorFor` gives way to an equal share, so `before`
  // sits *on* the floor rather than under it. If a range ever were wrong, this
  // is what keeps it containing where the edge already is instead of excluding
  // it — a range that excludes the current position is a second wrong answer,
  // not a correction.
  //
  // `contains an edge that is already below the floor, instead of excluding it`
  // is what asserts that, and it has to build the layout literally, because no
  // builder here will hand out an under-floor pair. Its neighbour
  // `still contains where the edge is when the floor is all there is` is named
  // for this property and cannot see it: thirteen equal columns make `before`,
  // `after` and `floorFor(13)` the same number, so both clamps are identities on
  // that fixture and it passes with them deleted.
  return {
    min: Math.min(before, floor),
    max: Math.max(before, before + after - floor),
  };
}

/** {@link EdgeRange} for the vertical edge between columns `boundary` and `boundary + 1`. */
export function columnEdgeRange<Id extends string>(
  layout: PaneLayout<Id>,
  boundary: number,
): EdgeRange | null {
  return rangeOfPair(
    layout.columns.map((column) => column.weight),
    boundary,
  );
}

/** The same, for the horizontal edge between two slots of one column. */
export function slotEdgeRange<Id extends string>(
  layout: PaneLayout<Id>,
  column: number,
  boundary: number,
): EdgeRange | null {
  const entry = layout.columns[column];
  if (entry === undefined) return null;
  return rangeOfPair(
    entry.slots.map((slot) => slot.weight),
    boundary,
  );
}

/**
 * Drag the vertical edge between column `boundary` and column `boundary + 1` by
 * `delta` of the workspace's width.
 *
 * Only the two columns either side move. Redistributing across all of them is
 * the other plausible reading and it is the wrong one: a user dragging one edge
 * is making a statement about two panes, and watching a third pane they were not
 * touching resize is how a layout stops feeling like a direct manipulation.
 */
export function resizeColumns<Id extends string>(
  layout: PaneLayout<Id>,
  boundary: number,
  delta: number,
): PaneLayout<Id> {
  const weights = layout.columns.map((column) => column.weight);
  const moved = shiftPair(weights, boundary, delta);
  if (moved === null) return layout;
  return {
    columns: layout.columns.map((column, index) => ({
      ...column,
      weight: moved[index] ?? column.weight,
    })),
  };
}

/**
 * The same drag, on the horizontal edge between slot `boundary` and
 * `boundary + 1` inside one column.
 */
export function resizeSlots<Id extends string>(
  layout: PaneLayout<Id>,
  column: number,
  boundary: number,
  delta: number,
): PaneLayout<Id> {
  const entry = layout.columns[column];
  if (entry === undefined) return layout;
  const moved = shiftPair(
    entry.slots.map((slot) => slot.weight),
    boundary,
    delta,
  );
  if (moved === null) return layout;
  return {
    columns: layout.columns.map((candidate, index) =>
      index !== column
        ? candidate
        : {
            ...candidate,
            slots: candidate.slots.map((slot, slotIndex) => ({
              ...slot,
              weight: moved[slotIndex] ?? slot.weight,
            })),
          },
    ),
  };
}

/**
 * Move `delta` of the whole from the member after `boundary` to the one before
 * it, stopping at whichever floor is reached first. `null` when there is no such
 * boundary, which is how the two callers above decline without inventing a
 * layout.
 *
 * The clamp is computed **before** anything is written, from both members at
 * once. Clamping each side separately is the version that silently loses a
 * sliver of the total on every drag against a floor — the sum stops being 1, and
 * the drift only shows up after a few dozen drags, which is to say in front of
 * the user and never in a test that drags once.
 */
function shiftPair(
  weights: readonly number[],
  boundary: number,
  delta: number,
): readonly number[] | null {
  const before = weights[boundary];
  const after = weights[boundary + 1];
  if (before === undefined || after === undefined) return null;
  if (!Number.isFinite(delta) || delta === 0) return weights;

  const floor = floorFor(weights.length);
  const room = delta > 0 ? Math.min(delta, after - floor) : Math.max(delta, floor - before);
  // No `if (room === 0) return weights;` here, and that is deliberate: adding
  // and subtracting an exact zero returns every weight unchanged, and both
  // callers rebuild the layout object either way, so nothing in this tree — or
  // reachable from it — could distinguish the early return from the map. It was
  // there and a measurer deleted it green. The guard that *is* load-bearing is
  // `delta === 0` above, which is not the same clause: on a layout whose member
  // before the edge is under the floor, `Math.max(0, floor - before)` is
  // positive, so a zero-length drag would move the edge. That is what
  // `declines a drag of nothing, even where the floor would otherwise pull the
  // edge` asserts, on a literally-built under-floor pair.

  return weights.map((weight, index) => {
    if (index === boundary) return weight + room;
    if (index === boundary + 1) return weight - room;
    return weight;
  });
}
