import { isRecord } from "./utils";

/**
 * The concrete field-map path grammar — the single source of truth for parsing,
 * reading, pointer-building, and writing `name[idx]`-style paths.
 *
 * A concrete path is dot-separated; a segment may carry a trailing array index
 * (`targets[0]`, `routes[2].handler`, `encoder`). Every consumer that targets a
 * ref slot — the value reader (node ports, edge inputs), the JSON-pointer
 * builder (edge inputs), and the writer (ref writes / delete-prune) — MUST agree
 * on this grammar; drift silently mis-targets a write. Route them all here.
 */

export interface PathSegment {
  key: string;
  /** Array index when the segment was `key[idx]`, else undefined. */
  index?: number;
}

/** Parses a concrete path into segments (`routes[2].handler` →
 *  `[{key:"routes",index:2},{key:"handler"}]`). */
export function parseConcretePath(path: string): PathSegment[] {
  return path.split(".").map((seg) => {
    const m = seg.match(/^(.+)\[(\d+)\]$/);
    return m ? { key: m[1], index: Number(m[2]) } : { key: seg };
  });
}

/** JSON pointer for a concrete path (`routes[2].handler` → `/routes/2/handler`). */
export function concretePathToPointer(path: string): string {
  const out: string[] = [];
  for (const { key, index } of parseConcretePath(path)) {
    out.push(key);
    if (index !== undefined) out.push(String(index));
  }
  return "/" + out.join("/");
}

/** Reads the value at a concrete path in a data tree, or undefined. */
export function readConcretePath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const { key, index } of parseConcretePath(path)) {
    cur = isRecord(cur) ? cur[key] : undefined;
    if (index !== undefined) cur = Array.isArray(cur) ? cur[index] : undefined;
  }
  return cur;
}

/** Trailing array index of a concrete path, or -1. Used to order a batch's
 *  removals high-to-low so array splices don't shift earlier targets. */
export function leafConcreteIndex(path: string): number {
  const segs = parseConcretePath(path);
  return segs[segs.length - 1]?.index ?? -1;
}

/**
 * Sets (or, when `value === null`, clears) the slot at a concrete path on a
 * mutable fields tree. Intermediate containers are created on demand (so an
 * append to `targets[len]` materializes the array / object). Clearing deletes
 * an object key or splices an array index.
 *
 * Note: clearing a *sub-field* (`mounts[0].type`) removes only that key and
 * leaves its container object (the typeless `{ path }` mount) — clearing a slot
 * is deliberately not the same as removing the slot's container.
 */
export function writeConcretePath(
  fields: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const tokens = parseConcretePath(path);
  let parent: Record<string, unknown> = fields;
  tokens.forEach(({ key, index }, t) => {
    const isLeaf = t === tokens.length - 1;
    if (index === undefined) {
      if (isLeaf) {
        if (value === null) delete parent[key];
        else parent[key] = value;
        return;
      }
      if (!isRecord(parent[key])) parent[key] = {};
      parent = parent[key] as Record<string, unknown>;
      return;
    }
    if (!Array.isArray(parent[key])) parent[key] = [];
    const arr = parent[key] as unknown[];
    if (isLeaf) {
      if (value === null) {
        if (index < arr.length) arr.splice(index, 1);
      } else arr[index] = value;
      return;
    }
    if (!isRecord(arr[index])) arr[index] = {};
    parent = arr[index] as Record<string, unknown>;
  });
}
