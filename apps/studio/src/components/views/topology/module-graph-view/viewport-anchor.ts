import type { ModuleGraphLayout } from "./elk-layout";

/**
 * Keeping the canvas still across a re-layout.
 *
 * Collapsing a branch changes a box's height, so ELK re-places everything below
 * and beside it — correctly, and the reader still experiences it as the picture
 * jumping out from under them, because the thing they were looking at moved.
 *
 * The fix is to move the VIEWPORT by the same amount one anchor box moved, so
 * that box stays where it was on screen and the rest rearranges around it. The
 * anchor is the box whose branch was just toggled: that is where the reader's
 * attention is, and holding it still is what makes the change legible instead
 * of disorienting.
 */
export interface ViewportShift {
  dx: number;
  dy: number;
}

/**
 * How far the viewport must move to hold `anchor` still between two layouts.
 *
 * Null when there is nothing to hold — no previous layout, or an anchor that is
 * not in both (a box that has just appeared or disappeared has no "same place"
 * to keep it in, and guessing one would move the canvas for no stated reason).
 */
export function anchorShift(
  previous: ModuleGraphLayout | null,
  next: ModuleGraphLayout,
  anchor: string | null,
): ViewportShift | null {
  if (!previous || !anchor) return null;
  const before = previous.byId.get(anchor);
  const after = next.byId.get(anchor);
  if (!before || !after) return null;
  const dx = after.absoluteX - before.absoluteX;
  const dy = after.absoluteY - before.absoluteY;
  return dx === 0 && dy === 0 ? null : { dx, dy };
}

/**
 * The box to hold still when the reader has not touched one — the top-left-most
 * box present in both layouts.
 *
 * Deterministic rather than clever: an anchor picked from what happens to be
 * near the viewport centre changes as the reader pans, so two identical edits
 * would settle differently.
 */
export function defaultAnchor(
  previous: ModuleGraphLayout | null,
  next: ModuleGraphLayout,
): string | null {
  if (!previous) return null;
  let best: { id: string; x: number; y: number } | null = null;
  for (const placed of next.placed) {
    if (placed.depth !== 0 || !previous.byId.has(placed.node.id)) continue;
    const candidate = { id: placed.node.id, x: placed.absoluteX, y: placed.absoluteY };
    if (!best || candidate.x + candidate.y < best.x + best.y) best = candidate;
  }
  return best?.id ?? null;
}
