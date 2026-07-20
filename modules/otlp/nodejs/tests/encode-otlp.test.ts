import { type LogRecord } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { toOtlpPayload } from "../src/encode-otlp.js";

/**
 * OTLP/JSON encoding — `kernel/specs/logging.md` §11.3. These are the module's
 * own encoder tests, **not** §16 conformance vectors: §16 requires only the
 * `json` and `pretty` encodings of every runtime, and the OTLP exporter is
 * explicitly out of the runtime contract (§0). A Rust or Go kernel is under no
 * obligation to reproduce any of this to conform.
 *
 * Every assertion below pins a documented OTLP/JSON interop trap.
 */

const FIXED_TIMESTAMP = 1_770_000_000_123_456_000n;

function baseRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timestamp: FIXED_TIMESTAMP,
    severityNumber: 9,
    severityText: "INFO",
    message: "listening",
    ...overrides,
  };
}

function firstRecord(payload: unknown): Record<string, unknown> {
  return (
    payload as {
      resourceLogs: { scopeLogs: { logRecords: Record<string, unknown>[] }[] }[];
    }
  ).resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
}

describe("OTLP/JSON encoding", () => {
  it("quotes 64-bit fields and leaves 32-bit fields bare", () => {
    const record = firstRecord(
      toOtlpPayload([baseRecord({ droppedAttributesCount: 2, traceFlags: 1 })]),
    );
    expect(record["timeUnixNano"]).toBe("1770000000123456000");
    expect(record["droppedAttributesCount"]).toBe(2);
    expect(record["flags"]).toBe(1);
  });

  it("encodes attributes as an array of key/value objects, never a map", () => {
    const record = firstRecord(toOtlpPayload([baseRecord({ attributes: { "db.system": "postgres" } })]));
    expect(record["attributes"]).toEqual([{ key: "db.system", value: { stringValue: "postgres" } }]);
  });

  it("base64-encodes bytesValue rather than over-applying the hex rule", () => {
    const record = firstRecord(
      toOtlpPayload([baseRecord({ attributes: { blob: new Uint8Array([1, 2, 3]) } })]),
    );
    expect(record["attributes"]).toEqual([{ key: "blob", value: { bytesValue: "AQID" } }]);
  });

  it("emits severityNumber as an integer, never a name", () => {
    expect(firstRecord(toOtlpPayload([baseRecord()]))["severityNumber"]).toBe(9);
  });

  it("requires service.name on the resource, falling back when unset", () => {
    const payload = toOtlpPayload([baseRecord()]) as {
      resourceLogs: { resource: { attributes: { key: string; value: unknown }[] } }[];
    };
    const serviceName = payload.resourceLogs[0]!.resource.attributes.find(
      (attribute) => attribute.key === "service.name",
    );
    expect(serviceName).toBeDefined();
  });

  it("mirrors an error onto OTel exception semantic conventions", () => {
    const record = firstRecord(
      toOtlpPayload([baseRecord({ error: { type: "ERR_X", message: "boom" } })]),
    );
    const attributes = record["attributes"] as { key: string; value: unknown }[];
    expect(attributes).toContainEqual({ key: "exception.type", value: { stringValue: "ERR_X" } });
    expect(attributes).toContainEqual({ key: "exception.message", value: { stringValue: "boom" } });
  });
});
