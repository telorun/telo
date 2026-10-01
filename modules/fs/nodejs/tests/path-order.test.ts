import { expect, it } from "vitest";
import { comparePaths } from "../src/path-order.js";

it("orders paths by code point, not by UTF-16 code unit", () => {
  // U+FF5E is one code unit above the surrogate range; U+1F600 is a surrogate
  // pair, so a code-unit comparison puts it first.
  const paths = ["\u{1F600}.txt", "\u{FF5E}.txt", "a/1.txt", "a.txt", "a"];
  expect(paths.sort(comparePaths)).toEqual(["a", "a.txt", "a/1.txt", "\u{FF5E}.txt", "\u{1F600}.txt"]);
});
