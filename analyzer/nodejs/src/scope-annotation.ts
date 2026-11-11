/**
 * The one reader of an `x-telo-scope` annotation's value.
 *
 * Three spellings: a region pointer (`"/steps"`), a list of them
 * (`["/steps", "/targets"]`), and the object form
 * `{ regions: [...], openedBy: dispatch }`. Only the object form with
 * `openedBy: dispatch` says the scope is opened by an invocation of its holder,
 * which is what binds `inputs` — the opening invocation's — in its members'
 * creation-time fields. The string and list forms are not opened by dispatch.
 *
 * Browser-safe.
 */

export interface ScopeAnnotation {
  /** Every region pointer the annotation names, as written. */
  readonly regions: readonly string[];
  /** The holder opens the scope from an invocation and hands it that
   *  invocation's inputs. */
  readonly openedByDispatch: boolean;
}

const OBJECT_KEYS = new Set(["regions", "openedBy"]);

/** The capabilities whose instances have an entry point that opens a scope from
 *  a call: `invoke()` or `run()`. */
const DISPATCHING_CAPABILITIES = new Set(["Telo.Invocable", "Telo.Runnable", "Telo.Service"]);

/** What `value` declares. A malformed value declares the regions it can be read
 *  for and is not opened by dispatch; {@link scopeAnnotationProblem} says why. */
export function readScopeAnnotation(value: unknown): ScopeAnnotation {
  if (typeof value === "string") return { regions: [value], openedByDispatch: false };
  if (Array.isArray(value)) {
    return { regions: value.filter((p): p is string => typeof p === "string"), openedByDispatch: false };
  }
  if (value && typeof value === "object") {
    const object = value as { regions?: unknown; openedBy?: unknown };
    const regions = Array.isArray(object.regions)
      ? object.regions.filter((p): p is string => typeof p === "string")
      : [];
    return {
      regions,
      openedByDispatch: object.openedBy === "dispatch" && scopeAnnotationProblem(value) === undefined,
    };
  }
  return { regions: [], openedByDispatch: false };
}

/** Why the object form of `value` is malformed, when it is. The string and list
 *  forms are judged by the annotation's own schema. */
export function scopeAnnotationProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).filter((key) => !OBJECT_KEYS.has(key));
  if (unknown.length > 0) {
    return `the object form takes only \`regions\` and \`openedBy\`, not ${unknown.map((k) => `\`${k}\``).join(", ")}`;
  }
  const regions = object.regions;
  if (!Array.isArray(regions) || regions.length === 0 || regions.some((p) => typeof p !== "string")) {
    return "`regions` must be a non-empty list of JSON Pointers";
  }
  if (object.openedBy !== undefined && object.openedBy !== "dispatch") {
    return `\`openedBy\` takes only \`dispatch\`, not ${JSON.stringify(object.openedBy)}`;
  }
  return undefined;
}

/** Why a kind of `capability` cannot declare a scope opened by dispatch, when it
 *  cannot: only a kind with `invoke()` or `run()` is dispatched. A capability not
 *  yet known (an ancestor not resolved) is not judged. */
export function openedByCapabilityProblem(value: unknown, capability: string | undefined): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if ((value as { openedBy?: unknown }).openedBy !== "dispatch") return undefined;
  if (capability === undefined || DISPATCHING_CAPABILITIES.has(capability)) return undefined;
  return (
    `\`openedBy: dispatch\` needs a kind whose instances are dispatched — ` +
    `Telo.Invocable, Telo.Runnable or Telo.Service — but its capability is ${capability}`
  );
}
