import { isRefSlot } from "@telorun/analyzer";
import { inlineResourceKind } from "../../resource-schema-form/ref-candidates";
import { isRecord } from "../../../lib/utils";
import { getTopologyRole, resolveRef } from "../../../schema-utils";
import { refTargetName } from "./overview-graph";
import { summarizeValue } from "./value-summary";

/**
 * An ORDERED list of entries, each naming what it attaches — `Http.Server`'s
 * mounts today.
 *
 * The third list-shaped slot beside an Application's `targets:` and a step
 * body, and read the same way for the same reason: the array is ordered and the
 * order is load-bearing (a mount's position is its match position), so a graph
 * of nodes draws a list as a DAG and asks the reader to recover an order the
 * picture cannot carry — the argument `RootLevel` already makes about the boot
 * sequence.
 *
 * What distinguishes it from a step body is that the entry has no grammar: a
 * step is one of a closed set of variants, while an entry is whatever the kind
 * declared its items to be. So nothing here knows a field name. The reference
 * is whichever item property carries an `x-telo-ref`, and everything else is
 * read generically as the entry's own configuration.
 */

/** One field of an entry, as the row reads it. */
export interface EntryField {
  name: string;
  label: string;
  value: unknown;
}

/**
 * The entry grammar a kind declares, or null when it declares none.
 *
 * THE single accessor — the `ref-slot.ts` precedent — because the annotation is
 * read in three places (whether the view applies, what the view renders, which
 * property the rail leaves alone) and a second reading of the same tokens is
 * how two surfaces come to disagree about what a manifest means. That already
 * happened once here: the array was annotated `entries` while the view sniffed
 * for "any property that is a ref slot", so the route table read `handler` and
 * the list read something else.
 */
export interface EntryList {
  /** The array property, e.g. `mounts`. */
  name: string;
  itemSchema: Record<string, unknown>;
  /** Item property holding the reference this entry dispatches to. */
  handler: string;
  /** Item property that selects this entry — a path, a tool name. Absent when
   *  the kind declares none. */
  matcher?: string;
}

export interface EntryRow {
  /** JSON pointer to this entry, e.g. `/mounts/0`. Identity, and the target of
   *  every edit the row makes. */
  pointer: string;
  index: number;
  /** The resource this entry dispatches to, when its handler names one. */
  target?: string;
  /**
   * The kind of a resource declared INLINE in the handler slot, when that is
   * what the entry holds.
   *
   * Separate from `target` because it is a different fact: a target is a NAME
   * this module declares elsewhere and can be opened, while an inline
   * declaration exists only here and has no name at all. Collapsing them would
   * make a row offer to open something that is not a resource in the list.
   */
  inlineKind?: string;
  /** The entry names a resource this module does not declare. */
  unresolved: boolean;
  /** What SELECTS this entry, when the kind declares a matcher and the author
   *  set it — a mount's path, a tool's name. It leads the row, because it is
   *  what tells one entry from the next; two mounts of the same API differ only
   *  here. */
  matcher?: EntryField;
  /** The entry's remaining configuration, in declaration order. */
  fields: EntryField[];
  /** The schema the detail panel edits this entry through — the item schema
   *  itself, since an entry IS an object at its pointer. */
  schema: Record<string, unknown>;
}

/**
 * The entry list this kind declares, or null.
 *
 * Null when the array carries no `entries` role, when its items are not an
 * object schema, or when NO HANDLER can be found — the last because a list of
 * entries that dispatch to nothing is not this view's shape, and rendering one
 * would be a column of rows all saying "(nothing attached)". A kind annotating
 * some other array `entries` therefore falls through to the ordinary field
 * form rather than to a broken canvas.
 */
export function entryListOf(kindSchema: Record<string, unknown>): EntryList | null {
  const properties = kindSchema.properties;
  if (!isRecord(properties)) return null;
  for (const [name, prop] of Object.entries(properties)) {
    if (!isRecord(prop) || getTopologyRole(prop) !== "entries") continue;
    const itemSchema = resolveRef(prop.items, kindSchema);
    if (!isRecord(itemSchema)) return null;
    const handler = handlerField(itemSchema);
    if (!handler) return null;
    const matcher = itemRoleField(itemSchema, "matcher");
    return { name, itemSchema, handler, ...(matcher ? { matcher } : {}) };
  }
  return null;
}

/**
 * The item property holding the reference this entry dispatches to.
 *
 * The DECLARED `handler` role wins; a ref slot is the fallback. Two spellings,
 * one answer — the `x-telo-step-context` precedent: a kind that names its own
 * handler is describing its own manifest, while the fallback is what keeps an
 * artifact published before the role was written on it readable. The fallback
 * takes the first ref slot, which is arbitrary but stable; a kind with two is
 * exactly the case the role exists to disambiguate.
 */
function handlerField(itemSchema: Record<string, unknown>): string | null {
  const declared = itemRoleField(itemSchema, "handler");
  if (declared) return declared;
  const properties = itemSchema.properties;
  if (!isRecord(properties)) return null;
  for (const [name, prop] of Object.entries(properties)) {
    if (isRecord(prop) && isRefSlot(prop)) return name;
  }
  return null;
}

/** The item property carrying `role`, if any. */
function itemRoleField(itemSchema: Record<string, unknown>, role: string): string | null {
  const properties = itemSchema.properties;
  if (!isRecord(properties)) return null;
  for (const [name, prop] of Object.entries(properties)) {
    if (isRecord(prop) && getTopologyRole(prop) === role) return name;
  }
  return null;
}

export interface EntryListOptions {
  entries: readonly unknown[];
  /** The kind's declared entry grammar, from {@link entryListOf}. */
  list: EntryList;
  /** JSON pointer to the array itself, e.g. `/mounts`. */
  pointer: string;
  /** Every resource this module declares, for the unresolved check. */
  declared: ReadonlySet<string>;
}

export function buildEntryList({ entries, list, pointer, declared }: EntryListOptions): EntryRow[] {
  const properties = isRecord(list.itemSchema.properties) ? list.itemSchema.properties : {};

  const field = (name: string, value: unknown): EntryField => {
    const prop = properties[name];
    return {
      name,
      label: isRecord(prop) && typeof prop.title === "string" && prop.title ? prop.title : name,
      value,
    };
  };

  return entries.map((entry, index) => {
    const data = isRecord(entry) ? entry : {};
    const handler = data[list.handler];
    const target = refTargetName(handler);
    const inlineKind = inlineResourceKind(handler);
    const matcher =
      list.matcher && data[list.matcher] !== undefined
        ? field(list.matcher, data[list.matcher])
        : undefined;
    return {
      pointer: `${pointer}/${index}`,
      index,
      ...(target ? { target } : {}),
      ...(inlineKind ? { inlineKind } : {}),
      unresolved: !!target && !declared.has(target),
      ...(matcher ? { matcher } : {}),
      // Declaration order, and only what the author actually set: an entry
      // listing every optional field as unset would bury the one or two that
      // say what it does.
      fields: Object.entries(properties).flatMap(([name]) =>
        name === list.handler || name === list.matcher || data[name] === undefined
          ? []
          : [field(name, data[name])],
      ),
      schema: list.itemSchema,
    };
  });
}
