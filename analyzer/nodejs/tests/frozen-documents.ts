/**
 * The written documents a load hands the analysis, deep-frozen: no stage may
 * write to a written document after load, so a write throws where it is made.
 * Only plain containers are frozen — a value of a class owns its own state.
 */
export function frozenDocuments<T>(value: T): T {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === null || typeof next !== "object" || seen.has(next)) continue;
    seen.add(next);
    const prototype = Object.getPrototypeOf(next);
    if (!Array.isArray(next) && prototype !== Object.prototype && prototype !== null) continue;
    Object.freeze(next);
    for (const child of Object.values(next)) pending.push(child);
  }
  return value;
}
