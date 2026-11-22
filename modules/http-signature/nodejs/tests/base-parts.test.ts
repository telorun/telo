import { describe, expect, it } from "vitest";
import { evaluateBaseParts, compilePattern, SignatureMalformed } from "../src/index.js";

const body = new TextEncoder().encode("BODY");
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("base parts", () => {
  it("joins literal, header and body parts with nothing between them", () => {
    const joined = evaluateBaseParts(
      [{ type: "literal", value: "v0:" }, { type: "header", header: "X-Ts" }, { type: "literal", value: ":" }, { type: "body" }],
      { headers: { "x-ts": " 12 " }, body },
    );
    expect(text(joined)).toBe("v0:12:BODY");
  });

  it("takes the first group of a header pattern, and an absent body is empty", () => {
    expect(text(evaluateBaseParts([{ type: "header", header: "S", pattern: "t=(\\d+)" }, { type: "body" }], { headers: { S: "v1=a,t=99" } }))).toBe("99");
  });

  it("refuses a missing header and a pattern that finds nothing", () => {
    expect(() => evaluateBaseParts([{ type: "header", header: "S" }], { headers: {} })).toThrow(SignatureMalformed);
    expect(() => evaluateBaseParts([{ type: "header", header: "S", pattern: "t=(\\d+)" }], { headers: { S: "x" } })).toThrow(SignatureMalformed);
  });

  it("refuses a pattern that RE2 cannot read or that holds no group", () => {
    expect(() => compilePattern("v1=(")).toThrow();
    expect(() => compilePattern("v1=a")).toThrow(/no group/);
  });
});
