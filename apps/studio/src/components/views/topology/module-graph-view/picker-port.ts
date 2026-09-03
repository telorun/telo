import type { GraphNode, GraphPort } from "@telorun/analyzer";
import type { RefResolver } from "../../../resource-schema-form/ref-candidates";
import { AMBIENT_CAPABILITIES } from "./off-canvas";
import { referenceableTargets, referenceName } from "./wire";

/**
 * A slot that is PICKED rather than wired.
 *
 * A hold on ambient infrastructure — a connection, a table, a declared shape —
 * never draws an edge: the same connection is held by every statement in the
 * application, so the fan-in is collapsed and the slot shows the name it holds.
 * A socket that can never carry a line is an affordance with no result, and a
 * name shown as static text is a value the reader can see and not change. The
 * select is both halves at once, and it is the same gesture the detail panel
 * offers for the same field.
 *
 * **`holds` is part of the rule, not a convenience.** The capability alone is
 * not enough: `Ai.Model` declares `capability: Telo.Provider` and is genuinely
 * CALLED, so its slot draws a real edge and must keep its socket. What makes a
 * slot pickable is that control never transfers through it — which is exactly
 * what the analyzer's own {@link isAmbientHold} tests on the edge, one slot
 * later.
 */
export function isPickerPort(port: GraphPort): boolean {
  return (
    port.class === "holds" &&
    port.capabilities.length > 0 &&
    port.capabilities.every((capability) => AMBIENT_CAPABILITIES.has(capability))
  );
}

/**
 * The names a picker offers, as a reference to each would be WRITTEN — alias-
 * qualified where it crosses an import boundary, since that is the text that
 * has to land in the manifest.
 *
 * Acceptance is the drag rule, unchanged: a name is offered exactly when the
 * canvas would have let a wire from that slot land on it, so the two ways of
 * filling one slot cannot disagree about what fills it. An owned declaration is
 * never offered — an inline or `with:`-scoped resource exists nowhere but its
 * owner's YAML and has no name to reference it by.
 */
export function pickerCandidates(
  port: GraphPort,
  nodes: readonly GraphNode[],
  resolver: RefResolver,
): string[] {
  return [...new Set(referenceableTargets(port, nodes, resolver).map(referenceName))].sort();
}

/** One select a picker draws. `path` is absent where a slot names no write site
 *  (a map-valued or doubly-nested one), which renders the row disabled rather
 *  than dropping the branch's only line. */
export interface PickerRow {
  path?: string;
  target?: string;
  /**
   * What the line IS, which decides what may be done to it.
   *
   * - `slot` — the resource's own single reference. It can be UNSET, so the
   *   select offers "nothing".
   * - `item` — one entry of an array. It cannot be unset: an array has no
   *   holes, so the only meaning is REMOVE, and offering "nothing" there is
   *   offering a word that does not apply to it.
   * - `add` — the site the next entry would be written at. Choosing a name here
   *   appends one.
   */
  role: "slot" | "item" | "add";
}

/**
 * The rows a picker draws, in order.
 *
 * The geometry and the renderer both ask, because a box's height is the sum of
 * its lines and a picker is the one port whose row count is not one — a drift
 * between the two is a box whose contents run past its own border.
 */
export function pickerRows(port: GraphPort): PickerRow[] {
  const rows: PickerRow[] = port.slots.map((slot) => ({
    path: slot.path,
    role: port.array ? ("item" as const) : ("slot" as const),
    ...(slot.target ? { target: slot.target } : {}),
  }));
  if (port.addPath) rows.push({ path: port.addPath, role: "add" });
  return rows.length > 0 ? rows : [{ role: port.array ? "item" : "slot" }];
}
