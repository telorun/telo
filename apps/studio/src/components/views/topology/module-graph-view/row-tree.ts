import type { GraphRow } from "@telorun/analyzer";

/**
 * A body is a TREE, and it is drawn as one.
 *
 * A step body nests — `while/do`, `if/then/else`, a `switch`'s arms — and the
 * projection carries that nesting on every row (`parent`, `depth`), pre-order,
 * so a parent always precedes its children. Drawing it as a flat list keyed by
 * each row's own ARRAY put the six statements of a `while`'s body in a branch of
 * their own (`steps[1].do`), which nothing on the box could reach: collapsing
 * `Steps` hid the two top-level rows and left the loop's contents on screen,
 * under a label that then read `2`.
 *
 * So the unit stays the property — one branch per top-level field, whatever
 * depth its rows sit at — and nesting is expressed the way nesting is: each row
 * that owns children carries its own control, and shutting it puts away
 * everything beneath it.
 */

/** Rows that own at least one child — the ones a tree gives a control. */
export function branchingRows(rows: readonly GraphRow[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const row of rows) if (row.parent) out.add(row.parent);
  return out;
}

/**
 * The rows left showing once shut branches are put away, in written order.
 *
 * A row goes when its parent is shut OR its parent has itself gone — the second
 * clause is what makes shutting a `while` put away the `if` three levels inside
 * it rather than only its own statements. One pass suffices because the rows
 * arrive pre-order, so a parent's verdict is always settled before its
 * children's is asked for; the same property {@link resolveVisibility} needs a
 * fixpoint for, and does not have.
 */
export function visibleRows(
  rows: readonly GraphRow[],
  isRowOpen: (rowId: string) => boolean,
): GraphRow[] {
  const out: GraphRow[] = [];
  const gone = new Set<string>();
  for (const row of rows) {
    if (row.parent && (gone.has(row.parent) || !isRowOpen(row.parent))) {
      gone.add(row.id);
      continue;
    }
    out.push(row);
  }
  return out;
}

/** Is this row drawn — every ancestor of it open? Asked one row at a time by
 *  the edge routing, which holds an edge's row id and no list. */
export function isRowDrawn(
  rows: readonly GraphRow[],
  rowId: string,
  isRowOpen: (rowId: string) => boolean,
): boolean {
  const byId = new Map(rows.map((row) => [row.id, row]));
  let current = byId.get(rowId);
  while (current?.parent) {
    if (!isRowOpen(current.parent)) return false;
    current = byId.get(current.parent);
  }
  return true;
}
