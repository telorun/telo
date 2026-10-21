import { describe, expect, it } from "vitest";
import { formatMessage, formatNumber, parsePattern, readMessage, type Message } from "../src/index.js";

/** What only a JavaScript host can hand the core: the Rust core's value enum cannot hold these. */
describe("values only a JavaScript host can pass", () => {
  const read = (data: unknown): Message => {
    const result = readMessage(data);
    if (!result.ok) throw new Error("does not read");
    return result.message;
  };

  it.each([
    ["a boolean", true],
    ["null", null],
    ["a timestamp object", { seconds: 0n, nanos: 0 }],
  ])("refuses %s at a placeholder", (_, value) => {
    expect(() => formatMessage(read("{$v}"), "en", { v: value } as never)).toThrow(
      expect.objectContaining({
        code: "MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED",
        message: "the value given for v is neither a string nor a number",
      }),
    );
  });

  it("refuses an integer outside int64 ∪ uint64", () => {
    expect(() => formatMessage(read("{$v}"), "en", { v: 2n ** 64n })).toThrow(
      expect.objectContaining({
        code: "MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED",
        message: "the value given for v is an integer outside the 64-bit range",
      }),
    );
    expect(() => formatNumber(-(2n ** 63n) - 1n, "en")).toThrow(
      expect.objectContaining({ message: "the value is an integer outside the 64-bit range" }),
    );
  });

  it("refuses a value that is not a number at formatNumber", () => {
    expect(() => formatNumber("1" as never, "en")).toThrow(expect.objectContaining({ message: "the value is not a number" }));
  });

  it("refuses an unpaired surrogate in a pattern", () => {
    expect(parsePattern("a\uD800b")).toEqual({
      ok: false,
      problem: {
        code: "MESSAGE_SYNTAX_INVALID",
        message: "an unpaired surrogate cannot appear in a message",
        path: [],
        range: { start: 1, end: 2 },
      },
    });
  });
});
