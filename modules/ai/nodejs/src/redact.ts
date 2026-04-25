/**
 * Shallow-copy `obj` with the given top-level keys omitted. Used by provider controllers
 * in their `snapshot()` method to keep secrets (apiKey, …) out of the CEL-visible
 * `resources.<name>` record.
 *
 * Example:
 *   snapshot() { return redact(["apiKey"], this.resource); }
 *
 * Not recursive by design — `snapshot()` output is a flat config record, not a nested tree,
 * and deep redaction invites surprising behaviour (accidentally stripping nested `apiKey`
 * fields that weren't meant to be secret).
 */
export function redact<T extends object>(fields: readonly string[], obj: T): Partial<T> {
  const copy: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  for (const field of fields) {
    delete copy[field];
  }
  return copy as Partial<T>;
}
