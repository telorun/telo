import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { authoredText, summarizeValue } from "./value-summary";

/**
 * One summarizer, because every list in the topology tab asks the same
 * question. It was written twice — `summarizeValue` and the entry list's
 * `entryFieldText`, whose own doc said it gave "the same one-line reading the
 * property rail gives".
 */
describe("summarizeValue", () => {
  it("says what is there without pretending to be the value", () => {
    expect(summarizeValue(undefined)).toBe("not set");
    expect(summarizeValue(null)).toBe("null");
    expect(summarizeValue(10)).toBe("10");
    expect(summarizeValue(false)).toBe("false");
    expect(summarizeValue("/v1")).toBe("/v1");
    expect(summarizeValue([1, 2, 3])).toBe("3 entries");
    expect(summarizeValue([1])).toBe("1 entry");
    expect(summarizeValue({ a: 1, b: 2 })).toBe("a, b");
    expect(summarizeValue({})).toBe("empty");
  });

  it("shows an expression verbatim — it is what the author wrote", () => {
    expect(summarizeValue(makeTaggedSentinel("cel", "previous == null"))).toBe("previous == null");
    expect(summarizeValue(makeTaggedSentinel("ref", "server"))).toBe("server");
  });

  it("tests the sentinel through templating's own predicate", () => {
    // A plain object carrying a `source` key is NOT a sentinel, and an inline
    // `__tagged` test would have said otherwise the day the shape changed.
    expect(summarizeValue({ __tagged: true, source: "x" })).toBe("__tagged, source");
  });
});

describe("authoredText", () => {
  it("is the reading a guard or a condition gets", () => {
    expect(authoredText(makeTaggedSentinel("cel", "a > 1"))).toBe("a > 1");
    expect(authoredText("literal")).toBe("literal");
    expect(authoredText(undefined)).toBeUndefined();
    expect(authoredText(null)).toBeUndefined();
  });
});
