import { describe, expect, it } from "vitest";
import { wireText } from "./words.js";
import { activePreset, presetRange, rangeLongerThan, rangeReversed, type Preset } from "../src/browser/date-range.js";

const on = (text: string) => {
  const [year, month, day] = text.split("-").map(Number);
  return new Date(year, month - 1, day);
};
const preset = (unit: Preset["unit"], offset = 0): Preset => ({ label: wireText(`${unit}${offset}`), unit, offset });

describe("a date range preset", () => {
  it("is the week holding today, begun on the declared day", () => {
    // 2026-03-01 is a Sunday.
    expect(presetRange(preset("week"), "monday", on("2026-03-01"))).toEqual({ from: "2026-02-23", to: "2026-03-01" });
    expect(presetRange(preset("week"), "sunday", on("2026-03-01"))).toEqual({ from: "2026-03-01", to: "2026-03-07" });
    expect(presetRange(preset("week", -1), "monday", on("2026-03-02"))).toEqual({ from: "2026-02-23", to: "2026-03-01" });
    expect(presetRange(preset("week", 1), "sunday", on("2026-02-28"))).toEqual({ from: "2026-03-01", to: "2026-03-07" });
  });

  it("is a whole month, quarter or year across a year's end", () => {
    expect(presetRange(preset("month", -1), "monday", on("2026-01-31"))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(presetRange(preset("month"), "monday", on("2024-02-29"))).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(presetRange(preset("quarter", 1), "monday", on("2026-12-31"))).toEqual({ from: "2027-01-01", to: "2027-03-31" });
    expect(presetRange(preset("year", 1), "sunday", on("2026-12-31"))).toEqual({ from: "2027-01-01", to: "2027-12-31" });
    expect(presetRange(preset("day", 1), "monday", on("2026-12-31"))).toEqual({ from: "2027-01-01", to: "2027-01-01" });
  });

  it("is shown active whenever the dates equal it, chosen or typed", () => {
    const presets = [preset("day"), preset("month")];
    expect(activePreset(presets, "monday", { from: "2026-05-01", to: "2026-05-31" }, on("2026-05-20"))).toBe(1);
    expect(activePreset(presets, "monday", { from: "2026-05-01", to: "2026-05-30" }, on("2026-05-20"))).toBe(-1);
  });

  it("blocks a start after the end, and warns past a length without blocking", () => {
    expect(rangeReversed({ from: "2026-05-02", to: "2026-05-01" })).toBe(true);
    expect(rangeReversed({ from: "2026-05-01", to: "" })).toBe(false);
    expect(rangeLongerThan({ from: "2026-01-01", to: "2026-03-31" }, { unit: "quarter", count: 1 })).toBe(false);
    expect(rangeLongerThan({ from: "2026-01-01", to: "2026-04-01" }, { unit: "quarter", count: 1 })).toBe(true);
  });
});
