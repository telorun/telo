/**
 * Event-shape classifier. The Lambda.Function controller dispatches incoming
 * AWS events to one of its listed handlers based on the event's structural
 * shape. Each handler kind contributes one classifier entry; the Function
 * picks the first matching entry.
 *
 * Classifier rules are hardcoded per AWS event source. Adding a new handler
 * kind (e.g. Lambda.EventBridge) means registering a new entry here — there
 * is no per-handler `match:` field on the manifest (the kind IS the source,
 * per the per-source-kind design — see modules/lambda/plans/lambda-function.md).
 */

export type HandlerKindKey =
  | "aws/lambda.HttpApi"
  | "aws/lambda.Sqs"
  | "aws/lambda.Direct";

export interface ClassifierEntry {
  /** Canonical kind key, e.g. "aws/lambda.HttpApi". The Function compares
   *  each listed handler's resolved kind to this key when registering it. */
  kind: HandlerKindKey;
  /** Predicate: returns true when the event matches this handler kind's
   *  shape. Mutually exclusive across non-Direct entries; Direct catches all. */
  matches: (event: unknown) => boolean;
}

export const CLASSIFIERS: ClassifierEntry[] = [
  {
    kind: "aws/lambda.HttpApi",
    matches: (event) =>
      isObject(event) &&
      isObject((event as Record<string, unknown>).requestContext) &&
      isObject(
        ((event as Record<string, unknown>).requestContext as Record<string, unknown>).http,
      ),
  },
  {
    kind: "aws/lambda.Sqs",
    matches: (event) => {
      if (!isObject(event)) return false;
      const records = (event as Record<string, unknown>).Records;
      if (!Array.isArray(records) || records.length === 0) return false;
      const first = records[0];
      return isObject(first) && (first as Record<string, unknown>).eventSource === "aws:sqs";
    },
  },
  {
    // Direct is the catch-all. Must be last; matches anything.
    kind: "aws/lambda.Direct",
    matches: () => true,
  },
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Resolves an incoming event to the matching handler kind. Returns the
 * canonical kind key, or undefined when no entry matches (shouldn't happen
 * since Direct is a catch-all, but defensive). The caller picks the actual
 * resolved handler instance from its `handlers:` list by matching this kind.
 */
export function classifyEvent(event: unknown): HandlerKindKey | undefined {
  for (const c of CLASSIFIERS) {
    if (c.matches(event)) return c.kind;
  }
  return undefined;
}
