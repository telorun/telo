import { describe, expect, it } from "vitest";
import { Duration, UnsignedInt } from "../src/cel-value-identity.js";
import { isInvokeError } from "../src/invoke-error.js";
import { plainSchemaOf, writePlainJson } from "../src/plain-json.js";

describe("the plain JSON writer", () => {
  it("writes each CEL value JSON cannot carry as its plain form, with no tag", () => {
    const text = writePlainJson({
      at: new Date("2026-01-15T07:30:00Z"),
      took: new Duration(5400n, 0),
      raw: new Uint8Array([1, 2, 255]),
      big: new UnsignedInt(18446744073709551615n),
      int: 9223372036854775807n,
      doubles: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0],
      byInt: new Map<unknown, unknown>([[1n, "one"], [true, "yes"]]),
      tagKey: { $telo: "int", value: "1" },
    });
    expect(text).toBe(
      '{"at":"2026-01-15T07:30:00.000Z","took":"5400s","raw":"AQL_","big":18446744073709551615,' +
        '"int":9223372036854775807,"doubles":["NaN","Infinity","-Infinity",0],' +
        '"byInt":{"1":"one","true":"yes"},"tagKey":{"$telo":"int","value":"1"}}',
    );
  });

  it("refuses a map two of whose keys are written as the same text", () => {
    let thrown: unknown;
    try {
      writePlainJson(new Map<unknown, unknown>([[1n, "int"], ["1", "string"]]));
    } catch (error) {
      thrown = error;
    }
    expect(isInvokeError(thrown) && thrown.code).toBe("ERR_PLAIN_JSON_UNWRITABLE");
  });
});

describe("plainSchemaOf", () => {
  it("describes an instance-typed slot by the text it is written as, and leaves every other node alone", () => {
    const schema = {
      type: "object",
      properties: {
        at: { title: "When", "x-telo-type": "Telo.Timestamp" },
        items: { type: "array", items: { anyOf: [{ "x-telo-type": "Telo.Bytes" }, { type: "null" }] } },
        port: { type: "integer", "x-telo-type": "Telo.TcpPort" },
      },
    };
    expect(plainSchemaOf(schema)).toEqual({
      type: "object",
      properties: {
        at: { title: "When", type: "string", format: "date-time" },
        items: { type: "array", items: { anyOf: [{ type: "string", pattern: "^[A-Za-z0-9_-]*$" }, { type: "null" }] } },
        port: { type: "integer", "x-telo-type": "Telo.TcpPort" },
      },
    });
    const untouched = { type: "object", properties: { port: schema.properties.port } };
    expect(plainSchemaOf(untouched)).toBe(untouched);
  });
});
