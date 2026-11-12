import { describe, expect, it } from "vitest";
import { readRelative, resolveRelative, spellRelative } from "../src/browser/relative-time.js";

describe("a filter value relative to now", () => {
  it("is spelled `now<sign><count><unit>`, and read back from that spelling alone", () => {
    expect([spellRelative({ unit: "day", offset: -1 }), spellRelative({ unit: "hour", offset: 0 }), spellRelative({ unit: "week", offset: 2 })]).toEqual(["now-1day", "now+0hour", "now+2week"]);
    expect([readRelative("now-1day"), readRelative("now+0hour")]).toEqual([{ unit: "day", offset: -1 }, { unit: "hour", offset: 0 }]);
    expect([readRelative("now"), readRelative("now-1days"), readRelative("2026-10-01")]).toEqual([undefined, undefined, undefined]);
  });

  it("resolves to the instant for a date-time, and to that moment's date in the viewer's time zone for a date", () => {
    expect(resolveRelative({ unit: "hour", offset: -3 }, "date-time", new Date(Date.UTC(2026, 10, 6, 12)))).toBe("2026-11-06T09:00:00.000Z");
    expect(resolveRelative({ unit: "day", offset: -1 }, "date", new Date(2026, 0, 1, 0, 30))).toBe("2025-12-31");
    // A month on from the 31st is the last day of the month it lands in.
    expect(resolveRelative({ unit: "month", offset: 1 }, "date", new Date(2026, 0, 31, 12))).toBe("2026-02-28");
    expect(resolveRelative({ unit: "year", offset: -1 }, "date", new Date(2028, 1, 29, 12))).toBe("2027-02-28");
  });
});
