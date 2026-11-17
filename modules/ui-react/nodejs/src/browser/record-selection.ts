import { conditionHolds, readBinding, type Binding, type Condition } from "./bindings.js";
import { leadsHere, type Lead, type Viewer } from "./current-location.js";
import { leadOf, resolveDestination, type DestinationWire } from "./destination.js";
import type { SpecNode } from "./nodes.js";
import { presentedAddress } from "./value-cell.js";

/** Nodes that draw records of their own, whose links belong to those records. */
const DRAWS_OWN_RECORDS = new Set(["list", "listing", "data", "action", "form", "filters", "chat", "split", "component"]);

/** Nodes a press is written on. */
const PRESSABLE = new Set(["box", "stack", "columns"]);

/** A value's own address leads where a link moving to it does. */
const moving = (address: string | undefined): Lead[] => (address === undefined ? [] : [{ type: "navigate", address }]);

/**
 * Where the links a node tree draws over `scope` lead: link nodes, menu items,
 * a value's `to` or its own address, and a container's press. A value a
 * relation labels is left out, as is whatever a hidden node holds.
 */
export function drawnLeads(node: unknown, scope: Readonly<Record<string, unknown>>, relations: Readonly<Record<string, unknown>>): Lead[] {
  const found: Lead[] = [];
  const add = (to: DestinationWire | undefined, where: string) => {
    const resolved = resolveDestination(to, scope, where);
    if (resolved !== undefined) found.push(leadOf(resolved));
  };
  const walk = (at: unknown): void => {
    if (at === null || typeof at !== "object") return;
    if (Array.isArray(at)) {
      at.forEach(walk);
      return;
    }
    const held = at as Record<string, any>;
    if (typeof held.type === "string") {
      if (DRAWS_OWN_RECORDS.has(held.type)) return;
      if (held.shown !== undefined && !conditionHolds(held.shown as Condition, scope)) return;
      if (held.type === "link") {
        add(held.to as DestinationWire, "'link' to");
      } else if (held.type === "menu") {
        for (const item of held.items as { to: DestinationWire; shown?: Condition }[]) {
          if (item.shown !== undefined && !conditionHolds(item.shown, scope)) continue;
          add(item.to, "'menu' item to");
        }
        return;
      } else if (held.type === "value") {
        const binding = held.value as Binding;
        const relation = "root" in binding && binding.root === "row" && binding.path.length === 1 ? binding.path[0] : undefined;
        if (relation !== undefined && Object.hasOwn(relations, relation)) return;
        const read = readBinding(binding, scope);
        const given = resolveDestination(held.to as DestinationWire | undefined, scope, "'value' to");
        found.push(...(given !== undefined ? [leadOf(given)] : moving(presentedAddress(read.present ? read.value : undefined, held.present, held.labels))));
        return;
      } else if (PRESSABLE.has(held.type) && held.press != null) {
        add((held.press as { to: DestinationWire }).to, "'press' to");
      }
    }
    for (const [key, child] of Object.entries(held)) if (key !== "shown" && key !== "to" && key !== "press") walk(child);
  };
  walk(node);
  return found;
}

/** A column of a table or a `list` node, as far as the links it draws go. */
export interface ColumnLinks {
  value?: Binding;
  relation?: string;
  present?: { type?: unknown; format?: unknown };
  labels?: Parameters<typeof presentedAddress>[2];
  cell?: SpecNode;
  to?: DestinationWire;
}

/** Where the links a row's columns draw lead, relation labels left out. */
export function columnLeads(columns: readonly ColumnLinks[], scope: Readonly<Record<string, unknown>>, where: string): Lead[] {
  return columns.flatMap((column) => {
    if (column.cell) return drawnLeads(column.cell, scope, {});
    if (column.relation !== undefined || column.value === undefined) return [];
    const given = resolveDestination(column.to, scope, where);
    if (given !== undefined) return [leadOf(given)];
    const read = readBinding(column.value, scope);
    return moving(presentedAddress(read.present ? read.value : undefined, column.present, column.labels));
  });
}

/** Whether any of the leads goes to where the viewer is. */
export const anyLeadsHere = (leads: readonly Lead[], viewer: Viewer): boolean => leads.some((lead) => leadsHere(lead, viewer));
