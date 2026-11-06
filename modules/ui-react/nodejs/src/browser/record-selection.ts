import { isCurrentAddress, resolveAddress, type AddressWire, type CurrentLocation } from "./address-wire.js";
import { conditionHolds, readBinding, type Binding, type Condition } from "./bindings.js";
import type { SpecNode } from "./nodes.js";
import { presentedAddress } from "./value-cell.js";

/** Nodes that draw records of their own, whose links belong to those records. */
const DRAWS_OWN_RECORDS = new Set(["list", "listing", "data", "action", "form", "filters", "chat", "split", "component"]);

/**
 * The addresses of the links a node tree draws over `scope`: link nodes, menu
 * items, a value's `href` or its own address. A value a relation labels is left
 * out, as is whatever a hidden node holds.
 */
export function drawnAddresses(node: unknown, scope: Readonly<Record<string, unknown>>, relations: Readonly<Record<string, unknown>>): string[] {
  const found: string[] = [];
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
        const resolved = resolveAddress(held.href as AddressWire, scope, "'link' href");
        if (resolved !== undefined) found.push(resolved);
      } else if (held.type === "menu") {
        for (const item of held.items as { href: AddressWire; shown?: Condition }[]) {
          if (item.shown !== undefined && !conditionHolds(item.shown, scope)) continue;
          const resolved = resolveAddress(item.href, scope, "'menu' item href");
          if (resolved !== undefined) found.push(resolved);
        }
        return;
      } else if (held.type === "value") {
        const binding = held.value as Binding;
        const relation = "root" in binding && binding.root === "row" && binding.path.length === 1 ? binding.path[0] : undefined;
        if (relation !== undefined && Object.hasOwn(relations, relation)) return;
        const read = readBinding(binding, scope);
        const given = held.href === undefined ? undefined : resolveAddress(held.href as AddressWire, scope, "'value' href");
        const address = presentedAddress(read.present ? read.value : undefined, held.present, held.labels, given);
        if (address !== undefined) found.push(address);
        return;
      }
    }
    for (const [key, child] of Object.entries(held)) if (key !== "shown" && key !== "href") walk(child);
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
  href?: AddressWire;
}

/** The addresses a row's columns draw links to, relation labels left out. */
export function columnAddresses(columns: readonly ColumnLinks[], scope: Readonly<Record<string, unknown>>, where: string): string[] {
  return columns.flatMap((column) => {
    if (column.cell) return drawnAddresses(column.cell, scope, {});
    if (column.relation !== undefined || column.value === undefined) return [];
    const read = readBinding(column.value, scope);
    const given = column.href && resolveAddress(column.href, scope, where);
    const address = presentedAddress(read.present ? read.value : undefined, column.present, column.labels, given);
    return address === undefined ? [] : [address];
  });
}

/** Whether any of the addresses leads to where the viewer is. */
export const anyCurrent = (addresses: readonly string[], location: CurrentLocation): boolean => addresses.some((address) => isCurrentAddress(address, location));
