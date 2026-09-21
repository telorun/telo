import type { GraphNode, GraphRow, ModuleGraph } from "@telorun/analyzer";
import { isTaggedSentinel, makeTaggedSentinel, type TaggedSentinel } from "@telorun/templating";
import { isRecord } from "../../../lib/utils";
import type { RefResolver } from "../../resource-schema-form/ref-candidates";
import { accepts } from "./module-graph-view/wire";

/**
 * An Application's boot sequence, `targets:`, as the editor reads and writes it.
 *
 * The module root is not drawn, so the boot list is shown twice over instead:
 * on each resource it starts (a marker with its position) and as the ordered
 * Boot section of the module bar. Both read the same entries here, and the
 * resource an entry names is the one the module graph resolved it to — never a
 * second name lookup that could disagree with the checker about which box a
 * reference lands on.
 */

/** The Application field holding the boot sequence. */
export const BOOT_FIELD = "targets";

/** The three spellings of a boot entry: a bare `!ref`, a gated `{ ref, when }`,
 *  and an inline invoke step `{ name?, invoke, inputs?, when? }`. */
export type BootEntryForm = "ref" | "gated" | "step";

export interface BootEntry {
  /** Position in `targets:`, 0-based. */
  index: number;
  form: BootEntryForm;
  /** The reference as written — the started resource, or the step's `invoke:`. */
  target?: string;
  /** A step's own `name:`. */
  name?: string;
  /** The `when:` guard as written. */
  when?: string;
}

function referenceOf(value: unknown): string | undefined {
  if (isTaggedSentinel(value)) return value.engine === "ref" ? value.source : undefined;
  return typeof value === "string" ? value : undefined;
}

function guardOf(entry: Record<string, unknown>): string | undefined {
  const written = entry.when;
  if (typeof written === "string") return written;
  if (isTaggedSentinel(written)) return written.source;
  return undefined;
}

/** Every entry of `targets:`, in boot order. An entry that is none of the three
 *  shapes is still listed — as a gated entry naming nothing — so it can be
 *  removed from the same place it is seen. */
export function bootEntries(targets: unknown): BootEntry[] {
  if (!Array.isArray(targets)) return [];
  return targets.map((entry, index): BootEntry => {
    const bare = referenceOf(entry);
    if (bare !== undefined) return { index, form: "ref", target: bare };
    const record = isRecord(entry) ? entry : {};
    const when = guardOf(record);
    const target = referenceOf("invoke" in record ? record.invoke : record.ref);
    const name = typeof record.name === "string" ? record.name : undefined;
    return {
      index,
      form: "invoke" in record ? "step" : "gated",
      ...(target !== undefined ? { target } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(when !== undefined ? { when } : {}),
    };
  });
}

/** What an entry is called in a list: a step's name, else what it runs. */
export function bootEntryLabel(entry: BootEntry): string {
  return entry.name ?? entry.target ?? `entry ${entry.index + 1}`;
}

/** JSON Pointer to one entry, for the sequence edits that move or remove it. */
export function bootEntryPointer(index: number): string {
  return `/${BOOT_FIELD}/${index}`;
}

/** The resource name a reference ends in. The graph carries a resolved
 *  reference's name without the import alias it was written through. */
function referencedName(reference: string | undefined): string | undefined {
  return reference?.slice(reference.lastIndexOf(".") + 1);
}

/**
 * The module root's row for each entry, when the graph and the manifest agree
 * about what it names.
 *
 * The graph is analysed from a manifest that may be one edit behind the one the
 * entries were read from; a row whose reference differs from the entry's is
 * stale, and resolving through it would put a marker on the wrong box.
 */
export function bootRows(entries: readonly BootEntry[], graph: ModuleGraph): Map<number, GraphRow> {
  const out = new Map<number, GraphRow>();
  const rows = graph.root?.rows ?? [];
  for (const entry of entries) {
    const row = rows.find((r) => r.kind === "target" && r.index === entry.index);
    if (row && referencedName(row.target) === referencedName(entry.target)) {
      out.set(entry.index, row);
    }
  }
  return out;
}

/** One start of a resource at boot. */
export interface BootMarker {
  /** The entry's index in `targets:`. */
  index: number;
  /** 1-based position in the boot order. */
  position: number;
  /** The entry's guard, when it is conditional. */
  when?: string;
}

/**
 * The markers each resource carries, by node id: one per entry that STARTS it —
 * a bare or gated reference. An inline invoke step dispatches its target rather
 * than starting it, so it marks nothing.
 */
export function bootMarkers(
  entries: readonly BootEntry[],
  graph: ModuleGraph,
): Map<string, BootMarker[]> {
  const rows = bootRows(entries, graph);
  const out = new Map<string, BootMarker[]>();
  for (const entry of entries) {
    if (entry.form === "step") continue;
    const nodeId = rows.get(entry.index)?.targetNode;
    if (!nodeId) continue;
    out.set(nodeId, [
      ...(out.get(nodeId) ?? []),
      {
        index: entry.index,
        position: entry.index + 1,
        ...(entry.when !== undefined ? { when: entry.when } : {}),
      },
    ]);
  }
  return out;
}

/**
 * The kinds a started entry accepts, read off the module root's own `targets`
 * slot — so which capabilities may be booted is the built-in schema's answer,
 * not a list restated here. Undefined for a module with no boot sequence (a
 * Library).
 */
export function bootConstraint(graph: ModuleGraph): string[] | undefined {
  const root = graph.root;
  if (!root?.rowArrays.some((array) => array.field === BOOT_FIELD && array.kind === "target")) {
    return undefined;
  }
  return root.ports.find((port) => port.slot === `${BOOT_FIELD}[]`)?.refs;
}

/** May this resource be started at boot? A declaration owned by another box has
 *  no name to reference it by, and the root is not a resource. */
export function canStartAtBoot(
  node: GraphNode,
  graph: ModuleGraph,
  resolver: RefResolver,
): boolean {
  const refs = bootConstraint(graph);
  if (!refs || refs.length === 0) return false;
  if (node.root || node.ownership === "inline" || node.ownership === "scoped") return false;
  return accepts({ refs }, node, resolver);
}

/** `targets:` with a bare `!ref` to `reference` appended — the key is created
 *  when the module has none. */
export function withBootTarget(targets: unknown, reference: string): unknown[] {
  const ref: TaggedSentinel = makeTaggedSentinel("ref", reference);
  return [...(Array.isArray(targets) ? targets : []), ref];
}

/** `targets:` without the entries at `indexes`. */
export function withoutBootEntries(targets: unknown, indexes: readonly number[]): unknown[] {
  const drop = new Set(indexes);
  return (Array.isArray(targets) ? targets : []).filter((entry, index) => !drop.has(index));
}
