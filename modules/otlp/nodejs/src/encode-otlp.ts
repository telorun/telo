import { formatUnixNano, type AnyValue, type ErrorValue, type LogRecord } from "@telorun/sdk";

/**
 * The `otlp` encoding — OTLP/JSON, `kernel/specs/logging.md` §11.3.
 *
 * Lives in this module rather than the kernel because §0 scopes the OTLP
 * exporter *out* of the runtime contract — §16 conformance requires only `json`
 * and `pretty`. Keeping it here means a Rust or Go kernel is not obliged to
 * reimplement OTLP to conform, and the kernel carries no code that only one
 * optional module consumes.
 *
 * Every rule below is a documented interop trap rather than a stylistic choice:
 *
 * - 64-bit integers are **decimal strings**. Nanosecond epoch values exceed
 *   `Number.MAX_SAFE_INTEGER`, so emitting them bare loses precision in JS
 *   receivers. 32-bit fields stay bare numbers.
 * - `traceId` / `spanId` are **hex, not base64** — OTLP/JSON's documented
 *   deviation from standard Protobuf JSON mapping, scoped to these two fields
 *   only. Every other `bytes` field, including `AnyValue`'s `bytesValue`, falls
 *   back to the proto3 default and **is base64**. Over-applying hex here is a
 *   silent interop break.
 * - Enums are **integers**, never names. Standard proto3 JSON permits enum name
 *   strings; OTLP explicitly forbids them.
 * - `attributes` is an **array of `{ key, value }` objects**, never a JSON map.
 *   Encoding it as a map is the single most common OTLP/JSON mistake.
 * - Each `AnyValue` carries **exactly one** variant key.
 */

/** §11.3: `service.name` is REQUIRED on the resource. */
export const UNKNOWN_SERVICE = "unknown_service";

export interface OtlpEncodeOptions {
  /** Resource-level attributes, e.g. the manifest's `logging.attributes`. */
  resourceAttributes?: Record<string, AnyValue>;
  scopeName?: string;
  scopeVersion?: string;
}

/** The `service.name` fallback: `unknown_service:<process executable name>`, or
 *  bare `unknown_service` when the executable name is unavailable. */
export function defaultServiceName(): string {
  const executable = process.argv0 || process.execPath;
  if (!executable) return UNKNOWN_SERVICE;
  const base = executable.split(/[\\/]/).pop();
  return base ? `${UNKNOWN_SERVICE}:${base}` : UNKNOWN_SERVICE;
}

/** Encode a batch of records as one OTLP/JSON `ExportLogsServiceRequest` body. */
export function encodeOtlp(records: readonly LogRecord[], options: OtlpEncodeOptions = {}): string {
  return JSON.stringify(toOtlpPayload(records, options));
}

export function toOtlpPayload(
  records: readonly LogRecord[],
  options: OtlpEncodeOptions = {},
): Record<string, unknown> {
  const resourceAttributes = { ...(options.resourceAttributes ?? {}) };
  if (resourceAttributes["service.name"] === undefined) {
    resourceAttributes["service.name"] = defaultServiceName();
  }

  // Records are grouped by `scope` so an OTLP receiver sees one instrumentation
  // scope per emitting module context, which is what `scope` identifies (§7.3).
  const byScope = new Map<string, LogRecord[]>();
  for (const record of records) {
    const key = record.scope ?? "";
    const bucket = byScope.get(key);
    if (bucket) bucket.push(record);
    else byScope.set(key, [record]);
  }

  const scopeLogs = [...byScope.entries()].map(([scope, scoped]) => ({
    scope: {
      name: scope || options.scopeName || "telo",
      ...(options.scopeVersion ? { version: options.scopeVersion } : {}),
    },
    logRecords: scoped.map(toOtlpRecord),
  }));

  return {
    resourceLogs: [
      {
        resource: { attributes: toKeyValueList(resourceAttributes) },
        scopeLogs,
      },
    ],
  };
}

function toOtlpRecord(record: LogRecord): Record<string, unknown> {
  const attributes: Record<string, AnyValue> = { ...(record.attributes ?? {}) };

  // §4.2: runtimes SHOULD mirror the error onto OTel exception semantic
  // conventions when exporting to OTLP.
  if (record.error) mirrorException(attributes, record.error);

  const out: Record<string, unknown> = {
    timeUnixNano: record.timestamp.toString(),
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    body: { stringValue: record.message },
  };

  if (record.observedTimestamp !== undefined) {
    out["observedTimeUnixNano"] = record.observedTimestamp.toString();
  }
  if (Object.keys(attributes).length > 0) {
    out["attributes"] = toKeyValueList(attributes);
  }
  if (record.droppedAttributesCount) {
    out["droppedAttributesCount"] = record.droppedAttributesCount;
  }
  if (record.traceId !== undefined) out["traceId"] = record.traceId;
  if (record.spanId !== undefined) out["spanId"] = record.spanId;
  if (record.traceFlags !== undefined) out["flags"] = record.traceFlags;
  if (record.eventName !== undefined) out["eventName"] = record.eventName;

  return out;
}

function mirrorException(attributes: Record<string, AnyValue>, error: ErrorValue): void {
  attributes["exception.type"] = error.type;
  attributes["exception.message"] = error.message;
  if (error.stack !== undefined) attributes["exception.stacktrace"] = error.stack;
}

function toKeyValueList(map: Record<string, AnyValue>): { key: string; value: unknown }[] {
  return Object.entries(map).map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

/** Exactly one variant key per value. `null` maps to the empty variant — an
 *  object with no key — which is how OTLP spells an absent value while keeping
 *  the attribute's key present. */
function toAnyValue(value: AnyValue): Record<string, unknown> {
  if (value === null || value === undefined) return {};

  switch (typeof value) {
    case "string":
      return { stringValue: value };
    case "boolean":
      return { boolValue: value };
    case "bigint":
      return { intValue: value.toString() };
    case "number":
      return Number.isInteger(value)
        ? { intValue: String(value) }
        : { doubleValue: value };
    default:
      break;
  }

  if (value instanceof Uint8Array) {
    // base64, NOT hex — the hex rule is scoped to traceId/spanId (§6.1).
    return { bytesValue: Buffer.from(value).toString("base64") };
  }

  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toAnyValue) } };
  }

  return { kvlistValue: { values: toKeyValueList(value as Record<string, AnyValue>) } };
}
