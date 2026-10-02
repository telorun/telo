import { describe, expect, it } from "vitest";
import { scanJsonPrefix } from "../src/cel/json-prefix-scan.js";

describe("scanJsonPrefix", () => {
  it.each([
    ['{"a": [1, -2.5e+3, true, false, null, "x\\n\\u00e9\\/"], "b": {}}'],
    [" \t\r\n[ ] "],
    ["-0"],
    ['" "'],
  ])("reads %j as a JSON text", (text) => {
    expect(scanJsonPrefix(text)).toBeUndefined();
  });

  it.each([
    ["[1,]", 3],
    ["01", 1],
    ["1 x", 2],
    ['"\\x"', 2],
    ['"\\u12"', 5],
    ['"a\tb"', 2],
    ['{"a":1,}', 7],
    ['{"a" 1}', 5],
    ["{1}", 1],
    ["[1 2]", 3],
    ["[1}", 2],
    ["-x", 1],
    ["1.x", 2],
    ["1e+x", 3],
    ["trux", 3],
    ["nulL", 3],
    ["'a'", 0],
    ["[] []", 3],
    ["﻿1", 0],
  ])("refuses %j at the first code unit no JSON text continues with", (text, offset) => {
    expect(scanJsonPrefix(text)).toEqual({ offset, endOfInput: false });
  });

  it.each([[""], ["  "], ["{"], ["tru"], ["-"], ["1."], ["1e"], ['"abc'], ['"\\'], ['"\\u00'], ['{"a"'], ['{"a":'], ["[1,"], ['[{"a":[1']])(
    "refuses %j at its end when every prefix is viable",
    (text) => {
      expect(scanJsonPrefix(text)).toEqual({ offset: text.length, endOfInput: true });
    },
  );

  it("counts the offset in UTF-16 code units", () => {
    expect(scanJsonPrefix('["\u{1F600}" x')).toEqual({ offset: 6, endOfInput: false });
  });

  it("reads nesting deeper than the call stack", () => {
    const depth = 200_000;
    expect(scanJsonPrefix("[".repeat(depth) + "]".repeat(depth))).toBeUndefined();
  });
});
