/**
 * The pane layout arithmetic.
 *
 * Written against string ids rather than the workspace's `PaneKind`, because the
 * cases worth testing are the ones a three-pane product cannot reach: thirteen
 * columns, the smallest count at which `MINIMUM_SHARE` of 1/12 stops being
 * satisfiable and `floorFor` has to give way to 1/13, and repeated drags against
 * a floor, where per-side clamping loses a sliver of the total each time.
 *
 * Eight of the thirty-two tests here assert the sum of a set of weights. A
 * layout whose shares do not sum to 1 renders as a gap or an overflow, and the
 * sum is the invariant every operation that redistributes weight has to keep.
 */

import { describe, expect, it } from 'vitest';

import {
  MINIMUM_SHARE,
  closePane,
  columnEdgeRange,
  columnsOf,
  emptyLayout,
  floorFor,
  isOpen,
  movePane,
  openPane,
  paneOrder,
  positionOf,
  resizeColumns,
  resizeSlots,
  slotEdgeRange,
  type PaneLayout,
} from './pane-layout';

function columnWeights(layout: PaneLayout<string>): number[] {
  return layout.columns.map((column) => column.weight);
}

function slotWeights(layout: PaneLayout<string>, column: number): number[] {
  return (layout.columns[column]?.slots ?? []).map((slot) => slot.weight);
}

function shape(layout: PaneLayout<string>): string[][] {
  return layout.columns.map((column) => column.slots.map((slot) => slot.pane));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe('the starting layout', () => {
  it('gives each pane a column and an equal share', () => {
    const layout = columnsOf('chat', 'diff', 'editor');
    expect(shape(layout)).toEqual([['chat'], ['diff'], ['editor']]);
    expect(columnWeights(layout)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(sum(columnWeights(layout))).toBeCloseTo(1, 10);
  });

  it('holds a pane once however many times it is named', () => {
    expect(shape(columnsOf('chat', 'chat'))).toEqual([['chat']]);
  });

  it('is legal empty, which is what closing the last pane leaves', () => {
    expect(shape(emptyLayout())).toEqual([]);
    expect(shape(closePane(columnsOf('chat'), 'chat'))).toEqual([]);
  });
});

describe('opening a pane', () => {
  it('is identity when the pane is already open', () => {
    const layout = columnsOf('chat', 'diff');
    expect(openPane(layout, 'diff')).toBe(layout);
  });

  it('lands the newcomer on an even share rather than a thin one', () => {
    const layout = openPane(columnsOf('chat', 'diff'), 'editor');
    expect(columnWeights(layout).map((weight) => Number(weight.toFixed(6)))).toEqual([
      1 / 3, 1 / 3, 1 / 3,
    ].map((weight) => Number(weight.toFixed(6))));
  });

  it('keeps the ratio the user dragged between the panes that were already there', () => {
    // 70/30, then a third pane arrives. The two should still be 70/30 relative
    // to each other — the newcomer takes a third from both, not all of it from
    // whichever happens to be adjacent.
    const dragged = resizeColumns(columnsOf('chat', 'diff'), 0, 0.2);
    expect(columnWeights(dragged)).toEqual([0.7, 0.3]);

    const [chat, diff] = columnWeights(openPane(dragged, 'editor'));
    expect((chat ?? 0) / (diff ?? 1)).toBeCloseTo(0.7 / 0.3, 10);
  });
});

describe('closing a pane', () => {
  it('is identity when the pane is not open', () => {
    const layout = columnsOf('chat');
    expect(closePane(layout, 'diff')).toBe(layout);
  });

  it('takes the emptied column with it and shares out the width it held', () => {
    const layout = closePane(columnsOf('chat', 'diff', 'editor'), 'diff');
    expect(shape(layout)).toEqual([['chat'], ['editor']]);
    expect(columnWeights(layout)).toEqual([0.5, 0.5]);
  });

  it('leaves a column standing when it still holds another pane', () => {
    const stacked = movePane(columnsOf('chat', 'diff', 'editor'), 'editor', 1, 1);
    expect(shape(stacked)).toEqual([['chat'], ['diff', 'editor']]);

    const layout = closePane(stacked, 'diff');
    expect(shape(layout)).toEqual([['chat'], ['editor']]);
    expect(sum(columnWeights(layout))).toBeCloseTo(1, 10);
  });
});

describe('moving a pane', () => {
  it('stacks it under another pane in that pane’s column', () => {
    const layout = movePane(columnsOf('chat', 'diff'), 'diff', 0, 1);
    expect(shape(layout)).toEqual([['chat', 'diff']]);
    expect(sum(slotWeights(layout, 0))).toBeCloseTo(1, 10);
    expect(slotWeights(layout, 0)).toEqual([0.5, 0.5]);
  });

  it('reorders within a column when the target is the column it is already in', () => {
    const stacked = movePane(columnsOf('chat', 'diff'), 'diff', 0, 1);
    const reordered = movePane(stacked, 'diff', 0, 0);
    expect(shape(reordered)).toEqual([['diff', 'chat']]);
  });

  it('opens a new column on the right for an index past the end', () => {
    const stacked = movePane(columnsOf('chat', 'diff'), 'diff', 0, 1);
    expect(shape(movePane(stacked, 'diff', 5, 0))).toEqual([['chat'], ['diff']]);
  });

  it('opens a new column on the left for a negative index', () => {
    const stacked = movePane(columnsOf('chat', 'diff'), 'diff', 0, 1);
    expect(shape(movePane(stacked, 'diff', -1, 0))).toEqual([['diff'], ['chat']]);
  });

  it('is identity for a pane dropped back on the column it is alone in', () => {
    // Not a curiosity: the removal deletes the column, so every index to its
    // right slides down one, and without the guard "drop where you picked it up"
    // moves the pane into its neighbour.
    const layout = columnsOf('chat', 'diff', 'editor');
    expect(movePane(layout, 'diff', 1, 0)).toBe(layout);
  });

  it('lands where the user aimed when the source column vanishes to its left', () => {
    const layout = columnsOf('chat', 'diff', 'editor');
    // `chat` is alone in column 0 and is dropped into column 2 (`editor`).
    // Column 0 disappears, so `editor` is column 1 by the time the insert runs.
    expect(shape(movePane(layout, 'chat', 2, 0))).toEqual([['diff'], ['chat', 'editor']]);
  });

  it('is identity for a pane that is not open', () => {
    const layout = columnsOf('chat');
    expect(movePane(layout, 'diff', 0, 0)).toBe(layout);
  });
});

describe('dragging a vertical edge between two columns', () => {
  it('moves width from the right column to the left and keeps the sum', () => {
    const layout = resizeColumns(columnsOf('chat', 'diff'), 0, 0.1);
    expect(columnWeights(layout)).toEqual([0.6, 0.4]);
    expect(sum(columnWeights(layout))).toBeCloseTo(1, 10);
  });

  it('leaves every column but the two either side of the edge alone', () => {
    const layout = resizeColumns(columnsOf('chat', 'diff', 'editor'), 0, 0.1);
    expect(columnWeights(layout)[2]).toBeCloseTo(1 / 3, 10);
  });

  it('stops at the floor rather than refusing the drag', () => {
    const layout = resizeColumns(columnsOf('chat', 'diff'), 0, 5);
    expect(columnWeights(layout)[1]).toBeCloseTo(floorFor(2), 10);
    expect(sum(columnWeights(layout))).toBeCloseTo(1, 10);
  });

  it('does not leak a sliver of the total on each drag that hits the floor', () => {
    // The clamp is computed from both members at once and applied to both. A
    // version that clamps each side separately loses a little of the whole every
    // time a drag runs out of room — invisible after one drag, which is how many
    // a test usually does.
    let layout = columnsOf('chat', 'diff');
    for (let index = 0; index < 40; index += 1) layout = resizeColumns(layout, 0, 0.3);
    expect(sum(columnWeights(layout))).toBeCloseTo(1, 10);
    expect(columnWeights(layout)[1]).toBeCloseTo(floorFor(2), 10);
  });

  it('is identity for an edge that does not exist', () => {
    const layout = columnsOf('chat', 'diff');
    expect(resizeColumns(layout, 1, 0.1)).toBe(layout);
    expect(resizeColumns(layout, -1, 0.1)).toBe(layout);
  });
});

describe('dragging a horizontal edge inside one column', () => {
  it('moves height between the two slots either side of it', () => {
    const stacked = movePane(columnsOf('chat', 'diff'), 'diff', 0, 1);
    const layout = resizeSlots(stacked, 0, 0, 0.2);
    expect(slotWeights(layout, 0)).toEqual([0.7, 0.3]);
    expect(sum(slotWeights(layout, 0))).toBeCloseTo(1, 10);
  });

  it('is identity for a column that does not exist', () => {
    const layout = columnsOf('chat');
    expect(resizeSlots(layout, 4, 0, 0.2)).toBe(layout);
  });
});

describe('the floor, when there are more siblings than it can serve', () => {
  it('is capped at an equal share rather than exceeding the whole', () => {
    // Twelve is where `MINIMUM_SHARE` and an equal share meet. Past it a fixed
    // floor is larger than any sibling can be, so `floorFor` has to give way —
    // a floor that cannot be satisfied makes every drag a no-op and every
    // normalisation fall back to even.
    expect(floorFor(2)).toBe(MINIMUM_SHARE);
    expect(floorFor(12)).toBeCloseTo(MINIMUM_SHARE, 10);
    expect(floorFor(20)).toBeCloseTo(1 / 20, 10);
    expect(floorFor(0)).toBe(0);
  });

  it('keeps twenty columns summing to one', () => {
    let layout: PaneLayout<string> = emptyLayout();
    for (let index = 0; index < 20; index += 1) layout = openPane(layout, `pane-${index}`);
    expect(layout.columns).toHaveLength(20);
    expect(sum(columnWeights(layout))).toBeCloseTo(1, 10);
    expect(Math.min(...columnWeights(layout))).toBeGreaterThan(0);
  });
});

describe('reading a layout', () => {
  it('reports panes in the order they are read: columns left to right, slots down', () => {
    const layout = movePane(columnsOf('chat', 'diff', 'editor'), 'editor', 1, 0);
    expect(shape(layout)).toEqual([['chat'], ['editor', 'diff']]);
    expect(paneOrder(layout)).toEqual(['chat', 'editor', 'diff']);
  });

  it('locates a pane, and says so when it is closed', () => {
    const layout = columnsOf('chat', 'diff');
    expect(positionOf(layout, 'diff')).toEqual({ column: 1, slot: 0 });
    expect(positionOf(layout, 'editor')).toBeNull();
    expect(isOpen(layout, 'editor')).toBe(false);
  });
});

describe('how far an edge can actually be dragged', () => {
  /**
   * The range a splitter announces through `aria-valuemin`/`aria-valuemax`. It
   * was being computed at the control as `floor` and `1 - floor`, which is a
   * fact about one member and not about the pair — so the default three-column
   * layout announced a maximum of 92% for an edge that stops at 58%. These
   * assert the property that makes the announcement honest: the range is where
   * a drag of `+/-1` actually lands.
   */
  function draggedTo(direction: 1 | -1): number {
    const moved = resizeColumns(columnsOf('chat', 'editor', 'diff'), 0, direction);
    return moved.columns[0]?.weight ?? 0;
  }

  it('is the pair’s range, not the member’s floor', () => {
    const layout = columnsOf('chat', 'editor', 'diff');
    const range = columnEdgeRange(layout, 0);

    expect(range?.min).toBeCloseTo(draggedTo(-1), 10);
    expect(range?.max).toBeCloseTo(draggedTo(1), 10);
    // The number the control used to announce, kept here so the difference is
    // visible rather than merely fixed: 1 - 1/12 is 0.9166…, and the edge stops
    // at 1/3 + 1/3 - 1/12.
    expect(range?.max).toBeLessThan(1 - floorFor(3));
    expect(range?.max).toBeCloseTo(1 / 3 + 1 / 3 - 1 / 12, 10);
  });

  it('answers for a horizontal edge from the column that holds it', () => {
    const layout = movePane(columnsOf('chat', 'editor', 'diff'), 'diff', 1, 1);
    const range = slotEdgeRange(layout, 1, 0);
    const dragged = resizeSlots(layout, 1, 0, 1).columns[1]?.slots[0]?.weight ?? 0;

    expect(range?.max).toBeCloseTo(dragged, 10);
  });

  it('declines rather than inventing a range where there is no edge', () => {
    const layout = columnsOf('chat', 'editor', 'diff');

    expect(columnEdgeRange(layout, 2)).toBeNull();
    expect(columnEdgeRange(layout, -1)).toBeNull();
    expect(slotEdgeRange(layout, 9, 0)).toBeNull();
    expect(slotEdgeRange(layout, 0, 0)).toBeNull();
  });

  it('still contains where the edge is when the floor is all there is', () => {
    // Thirteen columns cannot each hold a twelfth, so `floorFor(13)` gives way
    // to 1/13 and every member sits exactly on it: the edge cannot move at all,
    // and the range is the point it is already at. A range that excluded the
    // current position would be a second wrong answer.
    const many = columnsOf('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm');
    const range = columnEdgeRange(many, 3);
    const before = many.columns[3]?.weight ?? 0;

    expect(range?.min).toBeLessThanOrEqual(before);
    expect(range?.max).toBeGreaterThanOrEqual(before);
  });

  it('contains an edge that is already below the floor, instead of excluding it', () => {
    // The test above is named for the clamps in `rangeOfPair` and cannot see
    // them: thirteen equal columns put `before`, `after` and `floorFor(13)` all
    // at exactly 1/13, where `Math.min(before, floor)` and `floor` are the same
    // number, and the assertions hold whether or not the clamps are there.
    //
    // Seeing them takes a pair that is UNDER the floor, which none of the
    // operations here will produce: `normalise` pins every member at or above
    // `floorFor` before a layout is handed out (a weight at or below the floor
    // becomes the floor exactly), and `shiftPair` clamps a drag at the floor of
    // whichever side is giving way. So the layout is written out here directly. That is the
    // point of the clamps: they are what the answer is if a member ever does
    // sit under the floor, and "cannot happen today" is a fact about the other
    // functions, not about this one.
    //
    // Unclamped, this pair answers min = 1/12 (above where the edge already is,
    // 0.02) and max = 0.02 + 0.03 - 1/12, which is NEGATIVE — a range that
    // excludes its own current position and whose maximum is below its minimum.
    const squeezed: PaneLayout<string> = {
      columns: [
        { slots: [{ pane: 'a', weight: 0.02 }], weight: 0.02 },
        { slots: [{ pane: 'b', weight: 0.03 }], weight: 0.03 },
        { slots: [{ pane: 'c', weight: 0.95 }], weight: 0.95 },
      ],
    };
    const range = columnEdgeRange(squeezed, 0);

    expect(range?.min).toBeCloseTo(0.02, 10);
    expect(range?.max).toBeCloseTo(0.02, 10);
    expect(range?.min).toBeLessThanOrEqual(0.02);
    expect(range?.max).toBeGreaterThanOrEqual(0.02);
    expect(range?.max).toBeGreaterThanOrEqual(range?.min ?? 0);
  });
});

/**
 * The clauses that decline, and the ones that sanitise.
 *
 * Every test above drives this module the way the workspace drives it, and a
 * workspace never hands it a `NaN` delta, a negative slot, a column index past
 * the end, or a share of `Infinity`. So a measurer deleted six clauses that
 * exist for exactly those inputs — `newcomerShare`'s zero-incumbent arm,
 * `normalise`'s finite/positive sanitiser, `movePane`'s slot clamp, both of
 * `shiftPair`'s early returns and `slotEdgeRange`'s missing-column guard — and
 * the whole suite stayed green on each. Two of the six turned out to be
 * unobservable and are gone from the module rather than guarded here; the four
 * that are load-bearing are below, each with the input that reaches it.
 */
describe('the inputs the workspace never sends', () => {
  it('opens the first pane of an empty workspace at the full width', () => {
    // Closing the last pane leaves `emptyLayout()`, and the Views menu can then
    // open one — so this is a round the product reaches, even though nothing
    // else in this file was in it. `newcomerShare(0)` is `1 / 0`, and it is
    // `normalise`'s `Number.isFinite(weight) && weight > 0` sanitiser that turns
    // that into a share: without it the sole column's weight is `NaN`, and a
    // `flex-grow: NaN` column has no width at all.
    const opened = openPane(emptyLayout<string>(), 'a');
    expect(shape(opened)).toEqual([['a']]);
    expect(opened.columns[0]?.weight).toBe(1);
    expect(Number.isFinite(opened.columns[0]?.weight ?? Number.NaN)).toBe(true);
  });

  it('puts a pane asked for before the first slot at the first slot, not one short of the end', () => {
    // `Array.prototype.splice` reads a negative index from the end, so
    // `splice(-1, 0, pane)` drops it *above the last* slot rather than at the
    // top. `Math.max(0, slot)` in `movePane` is what stops that, and only a
    // negative slot can see it — `splice` clamps the upper end by itself, which
    // is why there is no upper clamp there to test.
    const stacked = movePane(movePane(columnsOf('a', 'b', 'c'), 'b', 0, 1), 'c', 0, 2);
    expect(shape(stacked)).toEqual([['a', 'b', 'c']]);
    expect(shape(movePane(stacked, 'c', 0, -1))).toEqual([['c', 'a', 'b']]);
    expect(shape(movePane(stacked, 'c', 0, 99))).toEqual([['a', 'b', 'c']]);
  });

  it('declines a drag of nothing, even where the floor would otherwise pull the edge', () => {
    // `delta === 0` and `room === 0` are not the same clause, and only an
    // under-floor pair tells them apart: with the member before the edge below
    // the floor, `Math.max(0, floor - before)` is positive, so a zero-length
    // drag would *move* the edge if `delta === 0` did not decline first. Built
    // literally, for the reason its neighbour above is: no builder here hands
    // out an under-floor pair.
    const squeezed: PaneLayout<string> = {
      columns: [
        { slots: [{ pane: 'a', weight: 0.02 }], weight: 0.02 },
        { slots: [{ pane: 'b', weight: 0.03 }], weight: 0.03 },
        { slots: [{ pane: 'c', weight: 0.95 }], weight: 0.95 },
      ],
    };
    expect(columnWeights(resizeColumns(squeezed, 0, 0))).toEqual([0.02, 0.03, 0.95]);
  });

  it('declines a drag that is not a number rather than writing one into the layout', () => {
    // `(now - started.at) / started.size` in `Splitter.tsx` is `NaN` for a
    // zero-width container and `Infinity` for a zero divisor that survived. A
    // layout that takes it holds `NaN` weights for ever after, and every pane
    // in the workspace loses its width at once.
    const three = columnsOf('a', 'b', 'c');
    for (const delta of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const dragged = resizeColumns(three, 0, delta);
      expect(columnWeights(dragged), `a drag of ${String(delta)}`).toEqual(columnWeights(three));
      expect(sum(columnWeights(dragged))).toBeCloseTo(1, 10);
    }
  });

  it('declines a horizontal edge in a column that does not exist', () => {
    // `resizeSlots` has `is identity for a column that does not exist` next
    // door; `slotEdgeRange` had nothing, and without its guard it reads `.slots`
    // off `undefined` and throws where its sibling returns `null`.
    const three = columnsOf('a', 'b', 'c');
    expect(slotEdgeRange(three, 9, 0)).toBeNull();
    expect(slotEdgeRange(three, -1, 0)).toBeNull();
  });
});

/**
 * The property `PaneGrid.tsx` reads instead of a fallback.
 *
 * `columnName` used to end `|| 'column'`, for a column with no slots. There is
 * no such column: `withColumnWeights` filters `slots.length > 0` and it builds
 * every layout this module returns. The fallback was that claim made where
 * nothing could check it; this is the claim made where something can.
 */
describe('the shape every layout comes back in', () => {
  it('no builder leaves an empty column in a layout', () => {
    const three = columnsOf('a', 'b', 'c');
    const stacked = movePane(three, 'b', 0, 1);
    const built: PaneLayout<string>[] = [
      emptyLayout(),
      three,
      columnsOf('a'),
      openPane(three, 'd'),
      openPane(emptyLayout(), 'a'),
      closePane(three, 'b'),
      closePane(columnsOf('a'), 'a'),
      stacked,
      closePane(stacked, 'a'),
      movePane(three, 'c', -1, 0),
      movePane(three, 'a', 9, 0),
      movePane(stacked, 'b', 1, 0),
      resizeColumns(three, 0, 0.1),
      resizeSlots(stacked, 0, 0, 0.1),
    ];
    const empties = built
      .flatMap((layout, index) => layout.columns.map((column) => ({ index, column })))
      .filter(({ column }) => column.slots.length === 0)
      .map(({ index }) => index);
    expect(empties, 'a column with no slots has no name, and PaneGrid asks for one').toEqual([]);
    // And the list is a list of layouts, not of empties: without this a builder
    // that returned `{ columns: [] }` for everything would pass.
    expect(built.filter((layout) => layout.columns.length > 0)).toHaveLength(built.length - 2);
  });
});
