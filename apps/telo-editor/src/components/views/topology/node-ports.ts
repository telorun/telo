import type { RefFieldInfo } from "@telorun/analyzer";
import { readConcretePath } from "../../../lib/concrete-path";
import { isRecord } from "../../../lib/utils";
import { resolveRef } from "../../../schema-utils";
import { AMBIENT_CAPABILITIES, NODE_CAPABILITIES, refTargetName } from "./overview-graph";

/** Generic Telo dispatch keys: when a ref sits directly under one of these, the
 *  enclosing field's title reads better than the raw key (e.g.
 *  `notFoundHandler.invoke` → "Not Found Handler", not "invoke"). */
const DISPATCH_KEYS = new Set(["invoke", "ref", "run", "provide"]);

/** How a port resolves its targets. `edge` ports are drag-to-wire handles whose
 *  filled slots render as graph edges; `picker` ports (ambient Provider / Type
 *  refs) render an inline select and never draw an edge. */
export type PortFlavor = "edge" | "picker";

/** One slot of a port — the single field, or one array item. */
export interface PortSlot {
  /** Concrete path of this slot (`targets[0]`, `encoder`, `routes[2].handler`).
   *  Doubles as the xyflow source-handle id (sanitized) and the write target. */
  concretePath: string;
  /** Referenced resource name when filled; undefined for an empty slot. */
  target?: string;
}

/** A reference field surfaced as an adapter on a node. A single ref renders one
 *  slot; an array-of-refs renders a slot per item plus an `addPath` "+" slot. */
export interface NodePort {
  /** Stable key within the node — the field-map path (`targets[]`, `encoder`). */
  key: string;
  /** Human label — the field's last path segment. */
  label: string;
  flavor: PortFlavor;
  /** Accepted `x-telo-ref` constraint strings (picker candidates / validation). */
  refs: string[];
  /** Capabilities a target may satisfy — validates drag-to-wire endpoints. */
  capabilities: string[];
  /** Filled slots (single ports always carry exactly one, possibly empty). */
  slots: PortSlot[];
  /** Empty append slot: dragging / picking here writes a new array item at this
   *  concrete path. Set only for top-level array-of-refs ports. */
  addPath?: string;
  /** Picker ports only: resource names a slot may select, by capability match. */
  candidates?: string[];
  /** Edge ports with an `addPath`: user-facing kinds the `+` slot can create and
   *  link (the kinds that satisfy this port's `refs`). */
  createKinds?: string[];
}

/** Classifies a port by the capability its constraints target: node → edge,
 *  ambient → picker, neither → null (not a port). */
function portFlavor(capabilities: string[]): PortFlavor | null {
  const cap = capabilities[0];
  if (cap && NODE_CAPABILITIES.has(cap)) return "edge";
  if (cap && AMBIENT_CAPABILITIES.has(cap)) return "picker";
  return null;
}

/** Last segment of a field-map path, markers stripped (`routes[].handler` →
 *  `handler`, `targets[]` → `targets`). The fallback label when the schema
 *  carries no title. */
function pathLabel(path: string): string {
  const last = path.split(".").pop() ?? path;
  return last.replace(/\[\]$/, "").replace(/\{\}$/, "");
}

function safeResolveRef(node: unknown, root: unknown): unknown {
  try {
    return resolveRef(node, root);
  } catch {
    return node;
  }
}

/** Walks a field-map path through a kind schema, collecting each segment's
 *  `title` (when declared). Descends into `items` for `[]` segments and
 *  `additionalProperties` for the standalone `{}` map segment, resolving `$ref`
 *  along the way. */
function titlesAlongPath(schema: unknown, path: string): { seg: string; title?: string }[] {
  const out: { seg: string; title?: string }[] = [];
  let node: unknown = schema;
  for (const rawSeg of path.split(".")) {
    if (rawSeg === "{}") {
      const container = safeResolveRef(node, schema);
      node = isRecord(container) ? safeResolveRef(container.additionalProperties, schema) : undefined;
      continue;
    }
    const isArray = rawSeg.endsWith("[]");
    const seg = rawSeg.replace(/\[\]$/, "");
    const container = safeResolveRef(node, schema);
    const props = isRecord(container) && isRecord(container.properties) ? container.properties : undefined;
    const propSchema = props ? safeResolveRef(props[seg], schema) : undefined;
    const title = isRecord(propSchema) && typeof propSchema.title === "string" ? propSchema.title : undefined;
    out.push({ seg, title });
    node = isRecord(propSchema) ? (isArray ? safeResolveRef(propSchema.items, schema) : propSchema) : undefined;
  }
  return out;
}

/** Human label for a ref port. Prefers the schema `title`: the enclosing field's
 *  title when the ref sits under a generic dispatch key, otherwise the leaf
 *  field's title. Falls back to the raw path segment when nothing is titled (or
 *  no schema is available). */
function resolvePortLabel(schema: unknown, path: string): string {
  if (!isRecord(schema)) return pathLabel(path);
  const chain = titlesAlongPath(schema, path);
  const leaf = chain[chain.length - 1];
  if (leaf && DISPATCH_KEYS.has(leaf.seg)) {
    for (let i = chain.length - 2; i >= 0; i--) {
      if (chain[i].title) return chain[i].title!;
    }
  }
  return leaf?.title ?? pathLabel(path);
}

/** A top-level array of direct refs (`targets[]`, `handlers[]`): trailing `[]`
 *  is the field's only marker. These get the drag-to-add `+` slot. */
function isArrayOfRefs(path: string): boolean {
  return path.endsWith("[]") && !path.slice(0, -2).match(/\[\]|\{\}/);
}

/** Array base of an array-of-refs path (`targets[]` → `targets`). */
function arrayBase(path: string): string {
  return path.slice(0, -2);
}

/** Resolves the referenced resource name of one array-of-refs item, preferring
 *  the wrapped forms (`{ invoke }` inline step, `{ ref }` gated) over a bare
 *  `name` so an inline step's own `name` is never mistaken for a target. */
function arrayItemTarget(item: unknown): string | undefined {
  if (isRecord(item)) {
    if ("invoke" in item) return refTargetName(item.invoke);
    if ("ref" in item) return refTargetName(item.ref);
  }
  return refTargetName(item);
}

/**
 * Projects a resource's reference fields into node ports. Driven entirely by the
 * analyzer's field map (`refFields`) overlaid with the resource's own `fields`
 * for occupancy — no resource kind is hardcoded.
 *
 * - **single ref** (`encoder`) → one port, one slot (filled or empty).
 * - **array-of-refs** (`targets[]`) → one slot per item + a `+` add slot. The
 *   `anyOf` sub-shapes of the same array (`targets[].invoke`, `targets[].ref`)
 *   are folded into this one port, not surfaced as separate ports.
 * - **ref inside an array of objects** (`mounts[].type`, `routes[].handler`) →
 *   one slot per array item + a `+` add slot that writes a fresh
 *   `{ <sub>: !ref }`; labelled by the array field. Other fields of a newly
 *   added item are filled in the form.
 *
 * `skipUnderField` drops refs that live under a node's step topology
 * (`steps[].invoke`) — those render as step rows with their own handles.
 */
export function buildNodePorts(
  refFields: RefFieldInfo[],
  fields: Record<string, unknown>,
  skipUnderField?: string | null,
  schema?: Record<string, unknown>,
): NodePort[] {
  const arrayRefBases = new Set<string>();
  for (const f of refFields) {
    if (isArrayOfRefs(f.path)) arrayRefBases.add(arrayBase(f.path));
  }

  const ports: NodePort[] = [];
  for (const f of refFields) {
    if (skipUnderField && (f.path === skipUnderField || f.path.startsWith(skipUnderField + "["))) {
      continue;
    }
    const flavor = portFlavor(f.capabilities);
    if (!flavor) continue;

    const base = {
      key: f.path,
      label: resolvePortLabel(schema, f.path),
      flavor,
      refs: f.refs,
      capabilities: f.capabilities,
    };

    if (isArrayOfRefs(f.path)) {
      const arr = readConcretePath(fields, arrayBase(f.path));
      const items = Array.isArray(arr) ? arr : [];
      const slots: PortSlot[] = items.map((item, i) => ({
        concretePath: `${arrayBase(f.path)}[${i}]`,
        target: arrayItemTarget(item),
      }));
      ports.push({ ...base, slots, addPath: `${arrayBase(f.path)}[${items.length}]` });
      continue;
    }

    // Sub-shape of an array-of-refs (`targets[].invoke`) — already folded above.
    const folded = [...arrayRefBases].some((b) => f.path.startsWith(`${b}[].`));
    if (folded) continue;

    if (!f.path.includes("[]") && !f.path.includes("{}")) {
      const value = readConcretePath(fields, f.path);
      ports.push({ ...base, slots: [{ concretePath: f.path, target: refTargetName(value) }] });
      continue;
    }

    // Ref inside an array of objects (`mounts[].type`, `routes[].handler`): a
    // slot per array item (filled or not) plus a drag-to-add slot that writes a
    // fresh `{ <sub>: !ref }`. Labelled by the array field, not the inner ref —
    // the mount/route is what the slot represents.
    const m = f.path.match(/^([^[]+)\[\]\.(.+)$/);
    if (m && !m[2].match(/\[\]|\{\}/)) {
      const [, arrName, sub] = m;
      const arr = readConcretePath(fields, arrName);
      const items = Array.isArray(arr) ? arr : [];
      const slots: PortSlot[] = items.map((item, i) => ({
        concretePath: `${arrName}[${i}].${sub}`,
        target: isRecord(item) ? refTargetName(readConcretePath(item, sub)) : undefined,
      }));
      ports.push({
        ...base,
        label: resolvePortLabel(schema, arrName),
        slots,
        addPath: `${arrName}[${items.length}].${sub}`,
      });
    }
  }
  return ports;
}
