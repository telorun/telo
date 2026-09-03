import type { GraphNode } from "@telorun/analyzer";
import { collapsibleProps, isCollapsible, propertyOf } from "./collapsible";
import { isPickerPort, pickerRows } from "./picker-port";
import { visibleRows } from "./row-tree";

/**
 * Where things sit inside a box.
 *
 * The renderer stacks a header, then a port row per declared slot, then the
 * ordered rows — so the y of any handle is arithmetic over those constants. It
 * lives here, apart from both the renderer and the layout, because BOTH need
 * it and they must agree: the layout tells the routing engine where an edge
 * leaves a box, and the renderer puts the socket there. A drift between the two
 * is an edge that visibly starts somewhere other than its own row, which is the
 * defect this file exists to make impossible.
 */

export const NODE_WIDTH = 220;
export const HEADER_HEIGHT = 46;
export const PORT_HEIGHT = 20;
export const ROW_HEIGHT = 20;
/** The rows region's top border + padding. */
export const ROWS_LEAD = 8;
/** The one-line summary a closed box shows instead of its rows. */
export const ROW_SUMMARY_HEIGHT = 18;
export const BOX_TAIL = 10;
/** Padding inside a box that holds children, and the gap between them. */
export const NEST_PAD = 8;
/** How deep owned declarations nest before the layout stops descending. Three
 *  is past anything in the standard library; the cap exists so a cycle in the
 *  ownership stamps cannot hang the editor. */
export const NEST_DEPTH_LIMIT = 3;
/**
 * A MIRROR is one line, because it holds one: a name and a kind.
 *
 * Sized apart from a box because it is not one — given a box's header and tail
 * it stood four times taller than the row it answers to, so eleven of them ran
 * three screens past the eleven rows that called them. What makes a mirror
 * readable is sitting near its call site, and it cannot if it is bigger than
 * the whole body it came from.
 */
export const MIRROR_HEIGHT = 28;
export const MIRROR_WIDTH = 150;

/** Rows past this are not drawn — a body of hundreds is a source file, not a
 *  picture — so the geometry stops counting there too. Raised with the tree: a
 *  step whose dispatch is a declaration written at the site now costs two or
 *  three lines rather than one, and the cap is about how much picture a body is
 *  worth, not about how many rows the model happens to produce. */
export const MAX_DRAWN_ROWS = 40;

/** The ports a box renders as its own rail: not the ones drawn as rows, and not
 *  the type references, which name a shape rather than wiring anything. */
export function railPorts(node: GraphNode): GraphNode["ports"] {
  return node.ports.filter((p) => !p.rowOwned && p.class !== "shape");
}

/**
 * The rows a box actually draws: the tree with its shut subtrees left out, then
 * capped.
 *
 * The cap is applied AFTER visibility, so putting a long loop away reveals what
 * came after it rather than leaving the box showing the same 24 lines. ONE walk,
 * called by the geometry and by the renderer, because a box whose height was
 * computed over a different list than it draws runs past its own border.
 */
export function drawnRows(node: GraphNode, isOpen: IsOpen): GraphNode["rows"] {
  return visibleRows(node.rows, (rowId) => isOpen(node.id, rowId)).slice(0, MAX_DRAWN_ROWS);
}

/** Whether a box's branch is open. One predicate, so the geometry and the
 *  renderer walk the box the same way. */
export type IsOpen = (nodeId: string, property: string) => boolean;

/**
 * The lines a box draws, in order, each with its height.
 *
 * ONE walk, shared by the height, the handle offsets and the renderer. Three
 * separate versions of "what does this box contain, in what order" is how a
 * handle ends up drawn somewhere other than where the layout put its port.
 */
export interface BoxLine {
  /** The concrete path this line carries a handle for, when it has one. */
  path?: string;
  height: number;
}

export function boxLines(node: GraphNode, isOpen: IsOpen): BoxLine[] {
  const lines: BoxLine[] = [{ height: HEADER_HEIGHT }];
  const drawn = drawnRows(node, isOpen);
  for (const prop of collapsibleProps(node)) {
    // A branch with no collapse control cannot be shut — see `isCollapsible`.
    const open = !isCollapsible(prop) || isOpen(node.id, prop.key);
    // The branch's header line: for a rail port it IS the port row, for an
    // ordered list it is the summary the rows sit under.
    if (prop.ports.length > 0) {
      for (const port of prop.ports) {
        // A picker draws a select per occupancy and one for the next entry, and
        // no socket at all — nothing docks on a slot that never draws an edge.
        if (isPickerPort(port)) {
          lines.push({ height: PORT_HEIGHT * pickerRows(port).length });
          continue;
        }
        const line: BoxLine = { height: PORT_HEIGHT };
        // A collapsed branch keeps its socket — it is the control that reopens
        // it, and a slot with nowhere to drag is the defect we already fixed.
        if (open) {
          for (const slot of port.slots) lines.push({ path: slot.path, height: 0 });
          if (port.addPath) lines.push({ path: port.addPath, height: 0 });
        }
        lines.push(line);
      }
    }
    if (!prop.ordered) continue;
    // Every row of the body, at every depth — a nested row's own array is
    // `steps[1].do`, and the branch it belongs to is `steps`.
    const rows = drawn.filter((r) => propertyOf(r.array) === prop.key);
    lines.push({ height: ROW_SUMMARY_HEIGHT });
    if (!open) continue;
    for (const row of rows) lines.push({ path: row.path, height: ROW_HEIGHT });
    lines.push({ height: ROW_HEIGHT });
  }
  for (const port of railPorts(node)) {
    // A port belonging to no collapsible branch (there are none today, but a
    // kind may declare a ref slot the property walk does not group) still draws.
    if (collapsibleProps(node).some((p) => p.key === propertyOf(port.slot))) continue;
    lines.push({ path: port.slots[0]?.path, height: PORT_HEIGHT });
  }
  lines.push({ height: BOX_TAIL });
  return lines;
}

/** Height of what the box itself shows, before anything nested inside it. */
export function contentHeight(node: GraphNode, isOpen: IsOpen): number {
  return boxLines(node, isOpen).reduce((sum, line) => sum + line.height, 0);
}

/**
 * The y of every handle a box renders, relative to the box's own top.
 *
 * Keyed by the CONCRETE PATH the handle stands for — a port slot's write site
 * or a row's path — which is exactly what an edge carries, so a caller joins the
 * two without knowing how either was rendered. A zero-height line is a handle
 * that rides the line after it (a port's socket sits on its own row).
 */
export function handleOffsets(node: GraphNode, isOpen: IsOpen): Map<string, number> {
  const out = new Map<string, number>();
  let y = 0;
  const lines = boxLines(node, isOpen);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.path !== undefined) {
      const carrier = line.height > 0 ? line : (lines[i + 1] ?? line);
      out.set(line.path, y + carrier.height / 2);
    }
    y += line.height;
  }
  return out;
}
