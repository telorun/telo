import { isLogValuer, type AnyValue, type LogAttributes, type LogAttributesInput } from "@telorun/sdk";

/**
 * Attribute normalization — `kernel/specs/logging.md` §6.3.
 *
 * Resolves deferred values, applies every limit, scrubs secret values, and
 * detects cycles in a single traversal. The caps are not optional hardening:
 * they bound the blast radius of a redaction miss and of a cyclic or
 * pathological value graph, so the traversal is iterative with a bounded
 * counter rather than recursive, and an exception raised inside a user-supplied
 * deferred value is caught and rendered as a diagnostic string rather than
 * propagated (§8.4 — a logging call never throws).
 *
 * Secret scrubbing happens here rather than in the path-based pass because this
 * traversal already visits every node, and §14 requires manifest secrets to
 * redact with no configuration at all.
 */

export interface AttributeLimits {
  /** Excess attributes are dropped and counted into `dropped_attributes_count`. */
  attributeCount: number;
  /** Unlimited when `undefined`; when set, longer strings truncate and are marked. */
  valueLength?: number;
  /** Over-deep subtrees are replaced with `"[depth exceeded]"`. */
  depth: number;
  /** Arrays and maps truncate, recording the original length. */
  collectionElements: number;
  /** Deferred-value resolutions per record. Beyond this the traversal stops
   *  resolving and substitutes a diagnostic string. */
  deferredSteps: number;
}

export const DEFAULT_ATTRIBUTE_LIMITS: AttributeLimits = {
  attributeCount: 128,
  valueLength: undefined,
  depth: 10,
  collectionElements: 1000,
  deferredSteps: 100,
};

export const DEPTH_EXCEEDED = "[depth exceeded]";
export const CIRCULAR = "[circular]";

export interface NormalizeOptions {
  limits?: AttributeLimits;
  /** Exact string values to replace with the censor token. Sourced from the
   *  emitting module context's resolved `secrets:`, so redaction follows the
   *  same cascade the threshold does. */
  secretValues?: ReadonlySet<string>;
  censor?: string;
}

export interface NormalizedAttributes {
  attributes: LogAttributes | undefined;
  /** Non-zero when limits truncated attributes; emitted as
   *  `dropped_attributes_count` and omitted when zero. */
  droppedCount: number;
}

interface Task {
  /** The raw value to normalize. */
  source: unknown;
  /** Container to write the normalized value into. */
  parent: AnyValue[] | Record<string, AnyValue>;
  key: string | number;
  depth: number;
  /** Ancestor objects on this branch, for cycle detection. Bounded by
   *  `limits.depth`, so copying it per push stays cheap and — unlike a global
   *  seen-set — a value legitimately shared by two sibling branches is not
   *  mislabelled circular. */
  ancestors: readonly object[];
}

export function normalizeAttributes(
  input: LogAttributesInput | undefined,
  options: NormalizeOptions = {},
): NormalizedAttributes {
  if (!input) return { attributes: undefined, droppedCount: 0 };

  const limits = options.limits ?? DEFAULT_ATTRIBUTE_LIMITS;
  const censor = options.censor ?? "[redacted]";
  const secrets = options.secretValues;

  const root: Record<string, AnyValue> = {};
  let droppedCount = 0;
  let deferredBudget = limits.deferredSteps;

  const keys = Object.keys(input);
  const kept = keys.length > limits.attributeCount ? limits.attributeCount : keys.length;
  droppedCount += keys.length - kept;

  const stack: Task[] = [];
  for (let i = kept - 1; i >= 0; i -= 1) {
    const key = keys[i]!;
    stack.push({ source: input[key], parent: root, key, depth: 1, ancestors: [] });
  }

  while (stack.length > 0) {
    const task = stack.pop()!;
    let value: unknown = task.source;

    if (isLogValuer(value)) {
      if (deferredBudget <= 0) {
        write(task, "[deferred limit exceeded]");
        continue;
      }
      deferredBudget -= 1;
      try {
        value = value.toLogValue();
      } catch (err) {
        write(task, `[deferred value threw: ${describeThrown(err)}]`);
        continue;
      }
    }

    if (value === null || value === undefined) {
      // `null` is a valid attribute value and is preserved (§6.1). `undefined`
      // has no AnyValue variant, so it normalizes to the empty variant.
      write(task, null);
      continue;
    }

    const type = typeof value;

    if (type === "string") {
      write(task, scrubString(value as string, secrets, censor, limits.valueLength));
      continue;
    }

    if (type === "boolean" || type === "bigint") {
      write(task, value as boolean | bigint);
      continue;
    }

    if (type === "number") {
      const num = value as number;
      // JSON has no representation for these; emitting them raw produces
      // invalid output, so they render as their spelling instead.
      write(task, Number.isFinite(num) ? num : String(num));
      continue;
    }

    if (value instanceof Uint8Array) {
      write(task, value);
      continue;
    }

    if (type !== "object") {
      // Functions and symbols have no AnyValue variant.
      write(task, `[${type}]`);
      continue;
    }

    const object = value as object;

    if (task.ancestors.includes(object)) {
      write(task, CIRCULAR);
      continue;
    }

    if (task.depth >= limits.depth) {
      write(task, DEPTH_EXCEEDED);
      continue;
    }

    const ancestors = [...task.ancestors, object];

    if (Array.isArray(value)) {
      const total = value.length;
      const keep = total > limits.collectionElements ? limits.collectionElements : total;
      const array: AnyValue[] = new Array(keep);
      write(task, array);
      if (keep < total) array.push(`[truncated: ${keep} of ${total} elements]`);
      for (let i = keep - 1; i >= 0; i -= 1) {
        stack.push({ source: value[i], parent: array, key: i, depth: task.depth + 1, ancestors });
      }
      continue;
    }

    if (value instanceof Date) {
      write(task, value.toISOString());
      continue;
    }

    const record = value as Record<string, unknown>;
    const entryKeys = Object.keys(record);
    const keepKeys =
      entryKeys.length > limits.collectionElements ? limits.collectionElements : entryKeys.length;
    const map: Record<string, AnyValue> = {};
    write(task, map);
    if (keepKeys < entryKeys.length) {
      map["[truncated]"] = `${keepKeys} of ${entryKeys.length} entries`;
    }
    for (let i = keepKeys - 1; i >= 0; i -= 1) {
      const key = entryKeys[i]!;
      stack.push({
        source: record[key],
        parent: map,
        key,
        depth: task.depth + 1,
        ancestors,
      });
    }
  }

  return { attributes: root, droppedCount };
}

function write(task: Task, value: AnyValue): void {
  if (Array.isArray(task.parent)) task.parent[task.key as number] = value;
  else (task.parent as Record<string, AnyValue>)[task.key as string] = value;
}

function scrubString(
  value: string,
  secrets: ReadonlySet<string> | undefined,
  censor: string,
  maxLength: number | undefined,
): string {
  const scrubbed = secrets?.has(value) ? censor : value;
  if (maxLength === undefined || scrubbed.length <= maxLength) return scrubbed;
  return `${scrubbed.slice(0, maxLength)}[truncated ${scrubbed.length - maxLength} chars]`;
}

function describeThrown(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
