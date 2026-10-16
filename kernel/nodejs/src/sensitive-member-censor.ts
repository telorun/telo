import { holdsSensitiveMember, isCelRecord, membersEntryOfValue, plainScalar } from "@telorun/sdk";

/**
 * The value rule of `kernel/specs/logging.md` §14 for a payload a debug consumer reads: a
 * value holding a member its type declares sensitive (a URL's password) is written as the
 * censor wherever it was built, and one holding none as its plain text. No redaction set
 * holds a value built at dispatch, so this is what protects one.
 *
 * Copy-on-write: a container is copied only where something beneath it changed, and only
 * arrays and plain records are entered — a live instance, a stream or a branded value is
 * handed over as it is.
 */
export function censorSensitiveMembers(value: unknown, censor: string): unknown {
  return walk(value, censor, []);
}

function walk(value: unknown, censor: string, ancestors: readonly object[]): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (holdsSensitiveMember(value)) return censor;
  if (membersEntryOfValue(value)) return plainScalar(value);
  const isArray = Array.isArray(value);
  if ((!isArray && !isCelRecord(value)) || ancestors.includes(value)) return value;
  const within = [...ancestors, value];
  if (isArray) {
    let out: unknown[] | undefined;
    (value as unknown[]).forEach((item, index) => {
      const next = walk(item, censor, within);
      if (next === item) return;
      out ??= [...(value as unknown[])];
      out[index] = next;
    });
    return out ?? value;
  }
  let out: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = walk(item, censor, within);
    if (next === item) continue;
    out ??= { ...(value as Record<string, unknown>) };
    out[key] = next;
  }
  return out ?? value;
}

/**
 * Each of `detail`'s entries on `target`, shown through its view and censored when first
 * read rather than when the payload is built: a dispatch emits its payload whether or not
 * anything listens, and only a reader should pay for the walk.
 */
export function defineCensoredEntries(
  target: Record<string, unknown>,
  detail: Record<string, unknown>,
  censor: string,
  /** How an entry is shown before the rule applies, by key. */
  views?: Readonly<Record<string, (value: unknown) => unknown>>,
): void {
  for (const [key, raw] of Object.entries(detail)) {
    let read = false;
    let held: unknown;
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        if (!read) {
          const view = views?.[key];
          held = censorSensitiveMembers(view ? view(raw) : raw, censor);
          read = true;
        }
        return held;
      },
      set: (next: unknown) => {
        held = next;
        read = true;
      },
    });
  }
}
