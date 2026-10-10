import { describe, expect, it } from "vitest";
import { readInt64Column, readTimestampColumn } from "../src/column-readers.js";

describe("readInt64Column", () => {
  const beyondDouble = 2n ** 53n + 1n;

  it("reads decimal text exactly past 2^53", () => {
    expect(readInt64Column(beyondDouble.toString())).toBe(beyondDouble);
    expect(readInt64Column(readInt64Column(beyondDouble.toString()).toString())).toBe(beyondDouble);
  });

  it("reads a bigint and a safe number as the same value", () => {
    expect(readInt64Column(beyondDouble)).toBe(beyondDouble);
    expect(readInt64Column(42)).toBe(42n);
    expect(readInt64Column("-7")).toBe(-7n);
  });

  it("refuses a number that has already lost precision, and anything outside int64", () => {
    expect(() => readInt64Column(2 ** 53 + 2)).toThrow(/64-bit integer/);
    expect(() => readInt64Column((2n ** 63n).toString())).toThrow(/64-bit integer/);
    expect(() => readInt64Column("12.5")).toThrow(/64-bit integer/);
    expect(() => readInt64Column(null)).toThrow(/64-bit integer/);
  });
});

describe("readTimestampColumn", () => {
  it("reads a driver date as it is", () => {
    const date = new Date("2026-10-09T12:34:56.789Z");
    expect(readTimestampColumn(date)).toBe(date);
  });

  it("reads the fixed-width UTC text to the same instant", () => {
    expect(readTimestampColumn("2026-10-09T12:34:56.789Z").toISOString()).toBe(
      "2026-10-09T12:34:56.789Z",
    );
  });

  it("refuses text in any other form", () => {
    expect(() => readTimestampColumn("2026-10-09 12:34:56")).toThrow(/timestamp column/);
    expect(() => readTimestampColumn("2026-10-09T12:34:56Z")).toThrow(/timestamp column/);
    expect(() => readTimestampColumn(1728476096789)).toThrow(/timestamp column/);
  });
});
