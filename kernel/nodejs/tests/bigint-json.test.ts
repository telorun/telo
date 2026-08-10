import { describe, expect, it } from "vitest";
import { bigIntAt, decodeJsonValue, encodeJsonValue, isBigIntJsonEnabled } from "@telorun/sdk";
import { enableBigIntJson } from "../src/bigint-json.js";
import { encodeJson } from "../src/logging/encode-json.js";
import { encodePretty } from "../src/logging/encode-pretty.js";
import { mergeFilledDefaults, withBigIntsAsNumbers } from "../src/bigint-schema-view.js";

/**
 * A CEL integer is int64 — a BigInt here — and `JSON.stringify` refuses one, so
 * every JSON boundary a manifest can reach used to answer the question for
 * itself. The kernel now installs one answer for the whole process
 * (`enableBigIntJson`), and these are the two halves worth pinning: that the
 * default really is exact digits everywhere, and that the two destinations which
 * deliberately encode differently still do.
 *
 * The second half has no other guard. `toJSON` runs BEFORE a replacer, so a
 * serializer reaching for `typeof v === "bigint"` silently stops matching — the
 * failure is a changed encoding, not an error.
 */

// The kernel installs this at boot(); these tests exercise the encoders directly.
enableBigIntJson();

const BEYOND_DOUBLE = 9007199254740993n; // 2^53 + 1 — not representable as a double

describe("BigInt JSON encoding", () => {
  it("installs, and is idempotent", () => {
    expect(isBigIntJsonEnabled()).toBe(true);
    enableBigIntJson();
    expect(JSON.stringify({ n: 1n })).toBe('{"n":1}');
  });

  it("emits exact digits, not a rounded double", () => {
    expect(JSON.stringify({ big: BEYOND_DOUBLE })).toBe('{"big":9007199254740993}');
    // The proof that it is not going through Number: a double cannot hold it.
    expect(String(Number(BEYOND_DOUBLE))).toBe("9007199254740992");
  });

  it("encodes at every position — root, nested, array, negative", () => {
    expect(JSON.stringify(3n)).toBe("3");
    expect(JSON.stringify({ rows: [{ c: 5n }] })).toBe('{"rows":[{"c":5}]}');
    expect(JSON.stringify([-42n])).toBe("[-42]");
  });

  it("reaches the pre-toJSON value through the holder", () => {
    // What a replacer must do once it can no longer see a `bigint` in `value`.
    expect(bigIntAt({ n: 7n }, "n")).toBe(7n);
    expect(bigIntAt({ n: 7 }, "n")).toBeUndefined();
    expect(bigIntAt(undefined, "n")).toBeUndefined();
  });
});

describe("destinations that deliberately encode differently", () => {
  it("keeps the persistence codec invertible — a BigInt returns as a BigInt", () => {
    const text = encodeJsonValue({ charged: BEYOND_DOUBLE, note: "x" });
    expect(text).toBe('{"charged":{"$bigint":"9007199254740993"},"note":"x"}');
    // At-most-once execution replays this value: it must equal what went in,
    // type included, or the second call silently answers differently.
    expect(decodeJsonValue(text)).toEqual({ charged: BEYOND_DOUBLE, note: "x" });
  });

  it("keeps a log record's 64-bit attribute quoted past the safe range", () => {
    // §11.1 / OTLP: a value a JS receiver cannot hold degrades to a decimal
    // string rather than to a wrong number.
    expect(encodeJson(record({ big: BEYOND_DOUBLE }))).toContain('"big":"9007199254740993"');
    expect(encodeJson(record({ small: 42n }))).toContain('"small":42');
  });

  it("keeps the console encoding rendering a nested integer as text", () => {
    // `pretty` is read by a human, never parsed, and renders an integer inside a
    // structured attribute as a decimal string. This is the site that silently
    // changed encoding when the patch landed, because it matched on `typeof`.
    // The whole attribute is re-quoted by `quoteIfNeeded`, so the rendering
    // shows up escaped; what matters is that the digits are a JSON string and
    // not a bare number.
    const line = encodePretty(record({ nested: { n: BEYOND_DOUBLE } }), { color: false });
    expect(line).toContain('{\\"n\\":\\"9007199254740993\\"}');
  });
});

describe("the BigInt-normalized validation view", () => {
  it("normalizes for the validator and leaves the value alone", () => {
    expect(withBigIntsAsNumbers({ rows: [{ n: 7n }] })).toEqual({ rows: [{ n: 7 }] });
  });

  it("returns the same reference when there is nothing to normalize", () => {
    // What keeps the BigInt-free path identical to a plain validate(data),
    // defaults-fill included.
    const value = { rows: [{ n: 7 }] };
    expect(withBigIntsAsNumbers(value)).toBe(value);
  });

  it("merges a default the validator filled INSIDE an array back onto the value", () => {
    // AJV writes a default at every level it finds one, `items` included
    // (`Collection.Sort`'s `orderBy[].descending`). Treating an array as a leaf
    // dropped those fills silently — the call then succeeds with the default
    // missing, which is harder to notice than the throw it replaced.
    const target = { orderBy: [{ by: 1n }] };
    const view = { orderBy: [{ by: 1, descending: false }] };
    mergeFilledDefaults(target, view);
    expect(target).toEqual({ orderBy: [{ by: 1n, descending: false }] });
  });
});

function record(attributes: Record<string, unknown>) {
  return {
    timestamp: 1770000000123456000n,
    severityNumber: 9,
    severityText: "INFO",
    message: "m",
    attributes,
  } as any;
}
