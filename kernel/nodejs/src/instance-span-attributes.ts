import type { SpanAttributePath } from "@telorun/analyzer";
import type { ContractDirection } from "./instance-sensitive-paths.js";

/**
 * Instance → the contract properties its kind marked `x-telo-span-attribute`,
 * recorded at `create()` beside the sensitive paths and for the same reason: the
 * dispatch site holds only the instance, and the resolved contract is compiled
 * inside the binding's closure.
 *
 * Lazy, so a contract is still compiled on first dispatch rather than at create
 * time. A contract whose marks are malformed raises `ERR_SPAN_ATTRIBUTE_INVALID`
 * from that same first dispatch, so the lookup here reads as "no attributes"
 * rather than raising the failure a second time from the trace path.
 */

interface SpanAttributeThunks {
  inputType?: () => SpanAttributePath[];
  outputType?: () => SpanAttributePath[];
}

const marks = new WeakMap<object, SpanAttributeThunks>();

/** First record wins, matching the sensitive-path rule: a `base:` child IS its
 *  parent instance, and the parent's binding produced it. */
export function recordSpanAttributes(
  instance: object,
  direction: ContractDirection,
  paths: () => SpanAttributePath[],
): void {
  const entry = marks.get(instance) ?? {};
  if (entry[direction] !== undefined) return;
  entry[direction] = paths;
  marks.set(instance, entry);
}

/** The declared span attributes one direction of a dispatch carries, read off
 *  `value` at the marked properties. An absent property contributes nothing. */
export function spanAttributesOf(
  instance: unknown,
  direction: ContractDirection,
  value: unknown,
): Record<string, unknown> {
  if (!instance || typeof instance !== "object") return {};
  const thunk = marks.get(instance as object)?.[direction];
  if (!thunk) return {};
  let paths: SpanAttributePath[];
  try {
    paths = thunk();
  } catch {
    // The same resolution the dispatch performs, which raises this failure with
    // its own code; see the header.
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const { path, name } of paths) {
    let node: unknown = value;
    for (const segment of path) {
      if (!node || typeof node !== "object") {
        node = undefined;
        break;
      }
      node = (node as Record<string, unknown>)[segment];
    }
    if (node !== undefined && node !== null) out[name] = node;
  }
  return out;
}
