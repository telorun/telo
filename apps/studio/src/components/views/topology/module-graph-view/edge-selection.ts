import type { EdgeChange } from "@xyflow/react";

/**
 * Fold xyflow's edge changes into the set of selected edge ids.
 *
 * **Selection is a CHANGE**, and a controlled flow has nowhere to put one
 * without a handler for it — which is why edges could not be selected at all
 * and the delete key had nothing to act on.
 *
 * A REMOVAL is ignored on purpose: the manifest is the source of truth, so an
 * edge disappears when the write that cleared its reference lands and the graph
 * is rebuilt, not because the canvas dropped it locally. Returning the same set
 * when nothing selection-related happened keeps the render from churning.
 */
export function applyEdgeSelection(
  current: ReadonlySet<string>,
  changes: readonly EdgeChange[],
): ReadonlySet<string> {
  let next: Set<string> | undefined;
  for (const change of changes) {
    if (change.type !== "select") continue;
    next ??= new Set(current);
    if (change.selected) next.add(change.id);
    else next.delete(change.id);
  }
  return next ?? current;
}
