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

import { floorFor, paneOrder, positionOf } from '@/lib/pane-layout';
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

  const columnFloor = floorFor(layout.columns.length);

  function movesFor(pane: PaneKind, column: number, slot: number): readonly PaneMove[] {
    if (open.length <= 1) return [];
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
        const slotFloor = floorFor(column.slots.length);
        return (
          <Fragment key={column.slots.map((slot) => slot.pane).join('+')}>
            {columnIndex > 0 ? (
              <Splitter
                orientation="vertical"
                label={`Resize ${columnName(layout.columns[columnIndex - 1]?.slots ?? [])} and ${columnName(column.slots)}`}
                before={layout.columns[columnIndex - 1]?.weight ?? 0}
                floor={columnFloor}
                onResize={(delta) => resizeColumns(columnIndex - 1, delta)}
              />
            ) : null}

            <div className={styles.column} style={{ flexGrow: column.weight }}>
              {column.slots.map((slot, slotIndex) => (
                <Fragment key={slot.pane}>
                  {slotIndex > 0 ? (
                    <Splitter
                      orientation="horizontal"
                      label={`Resize ${PANE_TITLES[column.slots[slotIndex - 1]?.pane ?? slot.pane]} and ${PANE_TITLES[slot.pane]}`}
                      before={column.slots[slotIndex - 1]?.weight ?? 0}
                      floor={slotFloor}
                      onResize={(delta) => resizeSlots(columnIndex, slotIndex - 1, delta)}
                    />
                  ) : null}

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
              ))}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

function columnName(slots: readonly { readonly pane: PaneKind }[]): string {
  return slots.map((slot) => PANE_TITLES[slot.pane]).join(' and ') || 'column';
}
