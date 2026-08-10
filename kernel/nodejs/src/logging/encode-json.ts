import { bigIntAt, formatUnixNano, type AnyValue, type ErrorValue, type LogRecord } from "@telorun/sdk";

/**
 * The `json` encoding — `kernel/specs/logging.md` §11.1. One JSON object per
 * line, UTF-8, newline-terminated.
 *
 * No de-facto cross-ecosystem standard exists for key names, so Telo defines its
 * own profile and keeps OTLP as a separate one. Keys are emitted in the §11.1
 * order for diffability, and extension data belongs in `attributes` — unknown
 * top-level keys are never emitted.
 */

/** How a `bytes` attribute is rendered. Raw bytes are never inlined into a text
 *  encoding: a sink with a blob store offloads them to a pointer, and every
 *  other sink base64-encodes (§6.1). */
export type BytesEncoder = (bytes: Uint8Array) => AnyValue;

export const base64Bytes: BytesEncoder = (bytes) => Buffer.from(bytes).toString("base64");

export interface JsonEncodeOptions {
  encodeBytes?: BytesEncoder;
}

/** Encode one record as a newline-terminated JSON line. */
export function encodeJsonLine(record: LogRecord, options: JsonEncodeOptions = {}): string {
  return `${encodeJson(record, options)}\n`;
}

/** Encode one record as a JSON object, without the trailing newline — the shape
 *  the debug wire nests inside its `record` frame (§11.4). */
export function encodeJson(record: LogRecord, options: JsonEncodeOptions = {}): string {
  return JSON.stringify(toJsonProfile(record), makeReplacer(options.encodeBytes ?? base64Bytes));
}

/** The §11.1 key profile as a plain object, in the recommended order. Exposed
 *  separately because the debug wire embeds the same profile rather than
 *  re-deriving it. */
export function toJsonProfile(record: LogRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    time: formatUnixNano(record.timestamp),
    level: record.severityText.toUpperCase(),
    severity: record.severityNumber,
    msg: record.message,
  };

  // `observed_timestamp` is deliberately NOT emitted: §11.1 defines a closed key
  // set and forbids extra top-level keys, and §17's schema is
  // `additionalProperties: false`. The field survives on the record model and in
  // the `otlp` profile, which has a real `observedTimeUnixNano` slot for it.
  if (record.traceId !== undefined) out["trace_id"] = record.traceId;
  if (record.spanId !== undefined) out["span_id"] = record.spanId;
  if (record.traceFlags !== undefined) out["trace_flags"] = record.traceFlags;
  if (record.resource !== undefined) out["resource"] = record.resource;
  if (record.module !== undefined) out["module"] = record.module;
  if (record.scope !== undefined) out["scope"] = record.scope;
  // Nested, never flattened — flattening risks collision with reserved keys.
  // Emitted with keys in sorted (code-point) order so the `json` encoding is
  // byte-identical across runtimes (§16 vector 18): attribute keys are arbitrary
  // user data with no natural order, and sorted is the only order both this
  // runtime and a Rust `BTreeMap`-backed one produce without extra config.
  if (record.attributes !== undefined) out["attributes"] = sortKeysDeep(record.attributes);
  if (record.error !== undefined) out["err"] = record.error satisfies ErrorValue;
  if (record.eventName !== undefined) out["event_name"] = record.eventName;
  if (record.droppedAttributesCount) {
    out["dropped_attributes_count"] = record.droppedAttributesCount;
  }

  return out;
}

/** Rebuild an attribute value with every nested object's keys in sorted order.
 *  `JSON.stringify` emits string keys in insertion order, so reconstructing the
 *  object with sorted insertion is what pins the byte order. Arrays keep their
 *  index order; `Uint8Array` is a leaf. The attributes are already normalized
 *  (§6.3), so depth and breadth are bounded and this cannot diverge. */
function sortKeysDeep(value: AnyValue): AnyValue {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const sorted: Record<string, AnyValue> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]!);
  return sorted;
}

function makeReplacer(encodeBytes: BytesEncoder) {
  return function replacer(this: unknown, key: string, value: unknown): unknown {
    // Read the BigInt off the HOLDER, not off `value`: `BigInt.prototype.toJSON`
    // has already rewritten it to the exact-digits form every other JSON boundary
    // wants (see `enableBigIntJson`). A log record is the one destination where
    // that is wrong — a value beyond 2^53 loses precision in a JS receiver, so it
    // degrades to a decimal string rather than to a wrong number, the same
    // reasoning OTLP gives for quoting its 64-bit fields.
    const source = bigIntAt(this, key);
    if (source !== undefined) {
      return source >= MIN_SAFE && source <= MAX_SAFE ? Number(source) : source.toString();
    }
    if (value instanceof Uint8Array) return encodeBytes(value);
    return value;
  };
}

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
