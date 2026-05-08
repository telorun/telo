import { describe, expect, it } from "vitest";
import { isTaggedSentinel, makeTaggedSentinel } from "../src/sentinel.js";

describe("makeTaggedSentinel", () => {
  it("produces an object with the expected shape", () => {
    const s = makeTaggedSentinel("cel", "variables.port");
    expect(s).toEqual({ __tagged: true, engine: "cel", source: "variables.port" });
  });
});

describe("isTaggedSentinel", () => {
  it("returns true for objects produced by makeTaggedSentinel", () => {
    expect(isTaggedSentinel(makeTaggedSentinel("cel", "x"))).toBe(true);
    expect(isTaggedSentinel(makeTaggedSentinel("literal", ""))).toBe(true);
  });

  it("returns true for compiled-decorated tagged values (kernel path)", () => {
    // Precompile decorates CompiledValues with __tagged + engine + source +
    // __compiled — both flags coexist on the same object.
    const compiledTagged = {
      __tagged: true,
      __compiled: true,
      engine: "cel",
      source: "1 + 1",
      call: () => 2,
    };
    expect(isTaggedSentinel(compiledTagged)).toBe(true);
  });

  it("rejects plain strings, numbers, null, undefined", () => {
    expect(isTaggedSentinel("cel")).toBe(false);
    expect(isTaggedSentinel(42)).toBe(false);
    expect(isTaggedSentinel(null)).toBe(false);
    expect(isTaggedSentinel(undefined)).toBe(false);
  });

  it("rejects partial objects missing __tagged, engine, or source", () => {
    expect(isTaggedSentinel({ engine: "cel", source: "x" })).toBe(false);
    expect(isTaggedSentinel({ __tagged: true, engine: "cel" })).toBe(false);
    expect(isTaggedSentinel({ __tagged: true, source: "x" })).toBe(false);
  });

  it("rejects objects whose __tagged is truthy but not strictly true", () => {
    expect(isTaggedSentinel({ __tagged: 1, engine: "cel", source: "x" })).toBe(false);
    expect(isTaggedSentinel({ __tagged: "true", engine: "cel", source: "x" })).toBe(false);
  });

  it("rejects objects whose engine or source is not a string", () => {
    expect(isTaggedSentinel({ __tagged: true, engine: 123, source: "x" })).toBe(false);
    expect(isTaggedSentinel({ __tagged: true, engine: "cel", source: 42 })).toBe(false);
  });
});
