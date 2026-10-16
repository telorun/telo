import { describe, expect, it } from "vitest";
import { PLAIN_ENCODINGS } from "@telorun/sdk";
import { toErrorValue } from "../src/logging/to-error-value.js";
import { spanRecordOf } from "../src/span-export.js";

/** The value rule (logging §14) in the two writers a manifest test cannot reach: a value
 *  holding a sensitive member is written as the censor, one holding none as itself. */
const urlOf = (text: string) => PLAIN_ENCODINGS["url-text"]!.decode(text);
const secret = urlOf("postgres://app:wr1ter-pw@db");
const open = urlOf("postgres://app@db");

describe("a value holding a sensitive member", () => {
  it("is censored where a thrown value is written into a log record's error", () => {
    const error = toErrorValue({ code: "ERR_X", detail: { url: secret, other: "kept" } }, "[redacted]");
    expect(error.message).toBe('{"code":"ERR_X","detail":{"url":"[redacted]","other":"kept"}}');
  });

  it("is censored as a span attribute, and a URL holding none is its text", () => {
    const record = spanRecordOf({
      name: "invoke x",
      traceId: "0".repeat(31) + "1",
      spanId: 1,
      parentSpanId: undefined,
      startTime: 1n,
      endTime: 2n,
      outcome: "ok",
      attributes: { "app.url": secret, "app.open": open },
    });
    expect(record?.attributes).toMatchObject({
      "app.url": "[redacted]",
      "app.open": "postgres://app@db",
    });
  });
});
