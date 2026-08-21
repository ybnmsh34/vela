/**
 * The arrangement: columns left to right, panes stacked inside them, a draggable
 * edge between every adjacent pair.
 *
 * Layout is `flex-grow` over shares that sum to 1, with `flex-basis: 0` — so a
 * pane's size is its share of what is there, at any window width and any display
 * scale. The alternative, writing percentages or pixels, is what makes a layout
 * wrong at 125% and unrecoverable at 150%.
 *
 * ## Which pane a drop lands on
 *
 * Dropping pane A on pane B's header means "A goes into B's column, directly
 * above B". One rule, and it is the one a header can express unambiguously: the
 * header is at the top of its pane, so above-it is where the pointer is. Splitting
 * the target into an upper and a lower half — the fuller gesture — needs a
 * pointer position inside a box whose geometry jsdom does not have, so it would
 * ship as a claim no test in this tree could check. The move disclosure covers
 * every destination the drag does not.
 */

import { Fragment, type ReactNode } from 'react';

import { columnEdgeRange, paneOrder, positionOf, slotEdgeRange } from '@/lib/pane-layout';
import { useCodeWorkspaceStore, type PaneKind } from '@/state/code-workspace-store';

import { PANE_TITLES, PaneFrame, type PaneMove } from './PaneFrame';
import { Splitter } from './Splitter';
import styles from './CodeWorkspace.module.css';

interface PaneGridProps {
  readonly renderPane: (pane: PaneKind) => ReactNode;
  /** The pane being dragged, held by the workspace so the grid stays stateless. */
  readonly dragging: PaneKind | null;
  readonly onDragging: (pane: PaneKind | null) => void;
}

export function PaneGrid({ renderPane, dragging, onDragging }: PaneGridProps) {
  const layout = useCodeWorkspaceStore((state) => state.layout);
  const focusedPane = useCodeWorkspaceStore((state) => state.focusedPane);
  const focusPane = useCodeWorkspaceStore((state) => state.focusPane);
  const closePane = useCodeWorkspaceStore((state) => state.closePane);
  const movePane = useCodeWorkspaceStore((state) => state.movePane);
  const resizeColumns = useCodeWorkspaceStore((state) => state.resizeColumns);
  const resizeSlots = useCodeWorkspaceStore((state) => state.resizeSlots);

  const open = paneOrder(layout);
  if (open.length === 0) {
    return (
      <p className={styles.noPanes}>
        Every pane is closed. Open one from the Views menu above.
      </p>
    );
  }

  /**
   * Every move this pane could make from where it is, in the order the header
   * lists them.
   *
   * There was an `if (open.length <= 1) return [];` at the top and it is gone: a
   * measurer deleted it with the suite green, and it is redundant rather than
   * merely untested. One open pane means one column holding one slot — a column
   * with no slots is filtered out of every layout `src/lib/pane-layout.ts`
   * builds — so `slot`, `stack` and `layout.columns.length` are all 0 or 1 and
   * every clause below is false anyway; and zero open panes never reaches here,
   * because the grid returns its "Every pane is closed" state above. The empty
   * list is still what a lone pane gets, and `offers exactly the moves that
   * arrangement has, in the order it lists them` has a row that says so, next to
   * the rows for the arrangements that are not empty.
   */
  function movesFor(pane: PaneKind, column: number, slot: number): readonly PaneMove[] {
    const entry = layout.columns[column];
    const stack = entry?.slots.length ?? 1;
    const moves: PaneMove[] = [];

    if (slot > 0) {
      moves.push({ label: 'Move up', run: () => movePane(pane, column, slot - 1) });
    }
    if (slot < stack - 1) {
      moves.push({ label: 'Move down', run: () => movePane(pane, column, slot + 1) });
    }
    if (column > 0) {
      moves.push({
        label: 'Move into the column on the left',
        run: () => movePane(pane, column - 1, layout.columns[column - 1]?.slots.length ?? 0),
      });
    }
    if (column < layout.columns.length - 1) {
      moves.push({
        label: 'Move into the column on the right',
        run: () => movePane(pane, column + 1, layout.columns[column + 1]?.slots.length ?? 0),
      });
    }
    if (stack > 1) {
      moves.push({
        label: 'Move to a new column on the left',
        run: () => movePane(pane, -1, 0),
      });
      moves.push({
        label: 'Move to a new column on the right',
        run: () => movePane(pane, layout.columns.length, 0),
      });
    }
    return moves;
  }

  return (
    <div className={styles.grid}>
      {layout.columns.map((column, columnIndex) => {
        // The member on the far side of this column's left edge, and how far
        // that edge can travel. Both were `?? …` fallbacks — `?? []`, `?? 0`,
        // `?? FULL_RANGE` — guarding a case the docblock called unreachable,
        // and a measurer confirmed the whole suite is green with each of them
        // replaced by anything at all. An unreachable fallback is a claim no
        // test can check, so the claim is made to the compiler instead: the two
        // lookups are narrowed once, here, and the splitter is rendered on the
        // narrowing. Deleting the narrowing does not go green — it fails
        // `npx tsc --build --force`.
        const previousColumn = layout.columns[columnIndex - 1];
        const columnRange = columnEdgeRange(layout, columnIndex - 1);
        return (
          <Fragment key={column.slots.map((slot) => slot.pane).join('+')}>
            {previousColumn === undefined || columnRange === null ? null : (
              <Splitter
                orientation="vertical"
                label={`Resize ${columnName(previousColumn.slots)} and ${columnName(column.slots)}`}
                before={previousColumn.weight}
                // The pair's range, from the module that does the clamping. A
                // floor would be the wrong input: see `Splitter.tsx`'s header.
                range={columnRange}
                onResize={(delta) => resizeColumns(columnIndex - 1, delta)}
              />
            )}

            <div className={styles.column} style={{ flexGrow: column.weight }}>
              {column.slots.map((slot, slotIndex) => {
                const previousSlot = column.slots[slotIndex - 1];
                const slotRange = slotEdgeRange(layout, columnIndex, slotIndex - 1);
                return (
                  <Fragment key={slot.pane}>
                    {previousSlot === undefined || slotRange === null ? null : (
                      <Splitter
                        orientation="horizontal"
                        label={`Resize ${PANE_TITLES[previousSlot.pane]} and ${PANE_TITLES[slot.pane]}`}
                        before={previousSlot.weight}
                        range={slotRange}
                        onResize={(delta) => resizeSlots(columnIndex, slotIndex - 1, delta)}
                      />
                    )}

                    <PaneFrame
                      pane={slot.pane}
                      focused={focusedPane === slot.pane}
                      share={slot.weight}
                      moves={movesFor(slot.pane, columnIndex, slotIndex)}
                      onFocusPane={() => focusPane(slot.pane)}
                      onClose={() => closePane(slot.pane)}
                      onDragStart={() => onDragging(slot.pane)}
                      onDragEnd={() => onDragging(null)}
                      dragging={dragging}
                      onDropOn={() => {
                        if (dragging === null) return;
                        // Resolved against the layout as it is *now*, not against
                        // the indices this row was rendered with: a drag is long
                        // enough for another action to have moved something.
                        const target = positionOf(layout, slot.pane);
                        if (target !== null) movePane(dragging, target.column, target.slot);
                        onDragging(null);
                      }}
                    >
                      {renderPane(slot.pane)}
                    </PaneFrame>
                  </Fragment>
                );
              })}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * A column's name, for the splitter that divides it from its neighbour.
 *
 * No `|| 'column'` fallback for the empty stack. A column with no slots is not
 * a thing this module can be handed: `withColumnWeights` in
 * `src/lib/pane-layout.ts` filters `slots.length > 0` out of every layout it
 * builds, and it builds all of them. `no builder leaves an empty column in a
 * layout` is what asserts that over every constructor and mutator the module
 * exports, which is where the property belongs — a fallback here was the same
 * claim, made where nothing could check it.
 */
function columnName(slots: readonly { readonly pane: PaneKind }[]): string {
  return slots.map((slot) => PANE_TITLES[slot.pane]).join(' and ');
}
