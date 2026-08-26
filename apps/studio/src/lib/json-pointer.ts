import { isRecord } from "./utils";

/**
 * RFC 6901 pointer reads and writes over a resource's plain-data fields.
 *
 * The editor addresses everything below a resource by pointer — a form's scope,
 * a step, a resource declared inline at a ref slot — so reading and writing one
 * is shared rather than restated per surface: the detail panel's scoped commit
 * and inline extraction must agree about what `/mounts/0/mount` names, or an
 * extraction writes its reference somewhere the form was not looking.
 *
 * Distinct from the concrete-path grammar (`routes[2].handler`), which is the
 * field map's spelling of the same idea; that one has its own reader.
 */
export function parsePointer(pointer: string): (string | number)[] {
  if (!pointer) return [];
  return pointer
    .replace(/^\//, "")
    .split("/")
    .map((segment) => {
      const unescaped = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      const index = Number(unescaped);
      return Number.isInteger(index) && index >= 0 && /^\d+$/.test(unescaped)
        ? index
        : unescaped;
    });
}

/** The pointer of a field inside a pointer-scoped form: the form's own scope
 *  plus the field's path, whose segments the form joins with dots (numeric ones
 *  for array items). One reader, because a drill-in and a CEL scope lookup both
 *  ask where a rendered field sits in its resource and must get the same
 *  answer. */
export function fieldPointer(scopePointer: string, fieldPath: string): string {
  const segments = fieldPath
    .split(".")
    .filter((s) => s !== "")
    .map((s) => s.replace(/~/g, "~0").replace(/\//g, "~1"));
  return segments.length === 0 ? scopePointer : `${scopePointer}/${segments.join("/")}`;
}

export function readPointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const segment of parsePointer(pointer)) {
    if (current == null) return undefined;
    if (Array.isArray(current)) current = current[segment as number];
    else if (isRecord(current)) current = current[segment as string];
    else return undefined;
  }
  return current;
}

/** A copy of `root` with `value` at `pointer`. Structural sharing everywhere
 *  the path does not go, so an edit to one slot leaves every sibling's identity
 *  intact — which is what keeps the form from remounting controls mid-edit. */
export function writePointer(root: unknown, pointer: string, value: unknown): unknown {
  const segments = parsePointer(pointer);
  if (segments.length === 0) return value;

  function update(node: unknown, index: number): unknown {
    if (index === segments.length) return value;
    const segment = segments[index];
    if (Array.isArray(node)) {
      const next = [...node];
      next[segment as number] = update(next[segment as number], index + 1);
      return next;
    }
    if (isRecord(node)) {
      return { ...node, [segment as string]: update(node[segment as string], index + 1) };
    }
    return node;
  }

  return update(root, 0);
}
