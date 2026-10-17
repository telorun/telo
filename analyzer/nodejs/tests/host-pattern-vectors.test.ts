import { describe, expect, it } from "vitest";
import { parseHostPattern } from "../src/public-address.js";

/** The one table both readers of a host pattern are held to — this one, and
 *  `http-dispatch`'s `hostnameMatcher` (its `hostname.test.ts` carries the same
 *  rows). A change to one reader changes both tables. */
const VECTORS: Array<[string, { form: "label" | "prefix"; suffix: string } | null]> = [
  ["*.a.example", { form: "label", suffix: ".a.example" }],
  ["*.A.Example.", { form: "label", suffix: ".a.example" }],
  ["*-a.example", { form: "prefix", suffix: "-a.example" }],
  ["*x-a.example", { form: "prefix", suffix: "x-a.example" }],
  ["*.", null],
  ["*", null],
  ["*-a", null],
  ["*-a.", null],
];

describe("a host pattern", () => {
  it.each(VECTORS)("%s reads as %j", (pattern, expected) => {
    expect(parseHostPattern(pattern) ?? null).toEqual(expected);
  });
});
