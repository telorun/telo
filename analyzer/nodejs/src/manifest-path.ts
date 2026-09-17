/**
 * Navigating a MANIFEST by a concrete path (`routes[0].request.schema.query`).
 *
 * The counterpart to `schema-walk.ts`, which navigates a schema: this addresses
 * the author's own document, indices and all. Its own module because three
 * places needed it independently — the CEL scope query resolving a context
 * binding's declaration, the call-site checker resolving an argument map, and
 * the IDE resolving the same map for completion — and three copies of one
 * traversal is exactly what the shared-answer rule exists to prevent.
 */

/**
 * The value at `path`, or `undefined` when any segment is absent.
 *
 * Absence is what makes a candidate path a CHECK rather than a guess: a caller
 * offering several possible shapes can try each and know a hit is a real node.
 */
export function navigateConcretePath(root: Record<string, any>, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (!segment) continue;
    const match = segment.match(/^([^[]*)((?:\[\d+\])*)$/);
    if (!match) return undefined;
    if (match[1]) {
      if (current === null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[match[1]];
    }
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(index[1])];
    }
  }
  return current;
}

/**
 * Write `value` at a concrete `a.b[0].c` path the caller read from `root`. A path
 * addressing nothing is a defect in whatever produced it, not in a manifest, so
 * it throws.
 */
export function assignConcretePath(root: Record<string, any>, path: string, value: unknown): void {
  const keys: Array<string | number> = [];
  for (const segment of path.split(".")) {
    const match = segment.match(/^([^[]*)((?:\[\d+\])*)$/);
    if (!match) throw new Error(`manifest path '${path}' is not a concrete path`);
    if (match[1]) keys.push(match[1]);
    for (const index of match[2]!.matchAll(/\[(\d+)\]/g)) keys.push(Number(index[1]));
  }
  const last = keys.pop();
  let container: any = root;
  for (const key of keys) container = container?.[key];
  if (last === undefined || container === null || typeof container !== "object") {
    throw new Error(`manifest path '${path}' addresses no value in the resource`);
  }
  container[last] = value;
}
