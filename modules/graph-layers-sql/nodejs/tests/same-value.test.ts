import { describe, expect, it } from "vitest";
import { sameValue } from "../src/same-value.js";

const at = (iso: string) => new Date(iso);
const bytes = (...values: number[]) => new Uint8Array(values);

const same: [string, unknown, unknown][] = [
  ["absent and null", undefined, null],
  ["two nulls", null, null],
  ["strings of the same text", "seven", "seven"],
  ["booleans of the same value", true, true],
  ["numbers of the same value", 7.5, 7.5],
  ["an integer number and the int64 holding it", 7, 7n],
  ["an int64 and the integer number holding it", 7n, 7],
  ["two int64 of the same value", 7n, 7n],
  ["bytes of the same content", bytes(1, 2, 3), bytes(1, 2, 3)],
  ["host dates at the same instant", at("2026-01-01T00:00:00Z"), at("2026-01-01T01:00:00+01:00")],
  ["lists the same pairwise", [1, "a", [true]], [1n, "a", [true]]],
  ["maps with the same entries in another key order", { a: 1, b: { c: "x" } }, { b: { c: "x" }, a: 1 }],
];

const different: [string, unknown, unknown][] = [
  ["null and a value", null, 0],
  ["a value and absent", "", undefined],
  ["strings of different text", "seven", "Seven"],
  ["booleans of different value", true, false],
  ["numbers of different value", 7, 8],
  ["a fraction and an int64", 7.5, 7n],
  ["decimal text and an integer", "7", 7],
  ["decimal text and an int64", "7", 7n],
  ["text and a boolean", "true", true],
  ["bytes of different content", bytes(1, 2, 3), bytes(1, 2, 4)],
  ["bytes of different length", bytes(1, 2), bytes(1, 2, 3)],
  ["host dates at different instants", at("2026-01-01T00:00:00Z"), at("2026-01-01T00:00:01Z")],
  ["a host date and its text", at("2026-01-01T00:00:00Z"), "2026-01-01T00:00:00.000Z"],
  ["a reordered list", [1, 2], [2, 1]],
  ["lists of different length", [1], [1, 1]],
  ["maps with different key sets", { a: 1 }, { a: 1, b: undefined }],
  ["maps differing in one value", { a: 1 }, { a: "1" }],
  ["a list and a map", [], {}],
  ["a map and its JSON text", { a: 1 }, '{"a":1}'],
];

describe("the same value", () => {
  it.each(same)("%s are the same", (name, a, b) => {
    expect(sameValue(a, b)).toBe(true);
    expect(sameValue(b, a)).toBe(true);
  });

  it.each(different)("%s are different", (name, a, b) => {
    expect(sameValue(a, b)).toBe(false);
    expect(sameValue(b, a)).toBe(false);
  });
});
