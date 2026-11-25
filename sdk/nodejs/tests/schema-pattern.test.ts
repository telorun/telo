import { describe, expect, it } from "vitest";
import {
  isOpaqueSchemaValue,
  opaqueSchemaView,
  schemaHeldValue,
  schemaPattern,
  schemaPatternRefusal,
  SCHEMA_REGEX_FORMAT,
} from "../src/index.js";
import { celDurationFromNanos } from "../src/index.js";

describe("schemaPattern", () => {
  it("is an unanchored RE2 search", () => {
    expect(schemaPattern("b+", "u").test("abbbc")).toBe(true);
    expect(schemaPattern("^b+$", "u").test("abbbc")).toBe(false);
    expect(schemaPattern("\\x{41}", "").test("A")).toBe(true);
  });

  it("accepts the u flag as inert and refuses any other flag", () => {
    expect(schemaPatternRefusal("a", "u")).toBeUndefined();
    expect(schemaPatternRefusal("a", "g")).toBe('invalid RE2 pattern "a": flag "g" is not supported');
    expect(() => schemaPattern("a", "i")).toThrow('invalid RE2 pattern "a": flag "i" is not supported');
  });

  it("refuses what RE2 refuses, naming RE2's kind", () => {
    expect(schemaPatternRefusal("(?=x)")).toBe('invalid RE2 pattern "(?=x)": invalid or unsupported Perl syntax');
    expect(schemaPatternRefusal("(a")).toBe('invalid RE2 pattern "(a": missing closing )');
    expect(() => schemaPattern("(?!x)", "u")).toThrow('invalid RE2 pattern "(?!x)"');
  });

  it("names itself to a standalone validator through the SDK", () => {
    expect(schemaPattern.code).toBe('require("@telorun/sdk").schemaPattern');
  });

  it("is the verdict of format: regex", () => {
    expect(SCHEMA_REGEX_FORMAT.validate("\\x{41}")).toBe(true);
    expect(SCHEMA_REGEX_FORMAT.validate("(?=x)")).toBe(false);
  });
});

describe("opaqueSchemaView", () => {
  it("replaces an instance value by a stand-in with no entries, equal by its value", () => {
    const duration = celDurationFromNanos(5_000_000_000n);
    const view = opaqueSchemaView({ wait: duration, bytes: new Uint8Array([1, 2]), n: 1 }) as Record<string, any>;
    expect(isOpaqueSchemaValue(view.wait)).toBe(true);
    expect(Object.keys(view.wait)).toEqual([]);
    expect(Object.keys(view.bytes)).toEqual([]);
    expect(schemaHeldValue(view.wait)).toBe(duration);
    expect(view.wait.valueOf()).toBe((opaqueSchemaView(celDurationFromNanos(5_000_000_000n)) as object).valueOf());
    expect(view.bytes.valueOf()).not.toBe(view.wait.valueOf());
    expect(view.n).toBe(1);
  });

  it("is the same reference when nothing is an instance value", () => {
    const plain = { a: [1, { b: "x" }] };
    expect(opaqueSchemaView(plain)).toBe(plain);
  });
});
