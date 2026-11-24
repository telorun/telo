const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const present = (value: unknown): boolean => value !== undefined && value !== null;

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
  }
  return a === b;
}

function setMember(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

/** What turns `before` into `after` as one merge-patch member, or `undefined` when nothing does. */
function memberPatch(before: unknown, after: unknown): unknown {
  if (!present(after)) return present(before) ? null : undefined;
  if (isRecord(after)) {
    const diff = objectPatch(isRecord(before) ? before : {}, after);
    return isRecord(before) && Object.keys(diff).length === 0 ? undefined : diff;
  }
  return sameValue(before, after) ? undefined : after;
}

/** The patch of an object's members: a changed one sent (an object recursively), a removed one as `null`. */
function objectPatch(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const name of new Set([...Object.keys(after), ...Object.keys(before)])) {
    const change = memberPatch(before[name], after[name]);
    if (change !== undefined) setMember(patch, name, change);
  }
  return patch;
}

/**
 * The merge patch (RFC 7396) of what a form changed: of the `properties` it
 * shows, each whose entered value differs from the record it started from — the
 * value entered, `null` for one emptied, and for an object only its members that
 * changed (a removed one as `null`); a list is sent whole. Nothing outside
 * `properties` is named. Held to `conformance/merge-patch.json`.
 */
export function mergePatchOf(properties: readonly string[], start: Record<string, unknown>, entered: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const property of properties) {
    const change = memberPatch(start[property], entered[property]);
    if (change !== undefined) setMember(patch, property, change);
  }
  return patch;
}
