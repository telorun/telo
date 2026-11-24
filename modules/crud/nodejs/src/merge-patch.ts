const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function setMember(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * RFC 7396 `MergePatch(target, patch)`: an object patch merges into the target
 * member by member — a `null` member removes it — and anything else replaces
 * the target whole.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const result: Record<string, unknown> = {};
  if (isObject(target)) for (const [name, value] of Object.entries(target)) setMember(result, name, value);
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete result[name];
    else setMember(result, name, mergePatch(result[name], value));
  }
  return result;
}
