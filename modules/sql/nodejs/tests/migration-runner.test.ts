import { describe, expect, it } from "vitest";
import {
  migrationStatements,
  orphanedKeys,
  pendingKeys,
} from "../src/schema/migration-runner.js";

describe("migrationStatements", () => {
  it("accepts either spelling and normalizes to a list", () => {
    expect(migrationStatements("k", { statement: "A" })).toEqual(["A"]);
    expect(migrationStatements("k", { statements: ["A", "B"] })).toEqual(["A", "B"]);
  });

  it("refuses an entry that says nothing, naming the key", () => {
    expect(() => migrationStatements("20260401_x", {})).toThrow(/'20260401_x' has no statement/);
    expect(() => migrationStatements("k", { statements: [] })).toThrow(/no statement/);
  });

  it("copies the list, so a caller cannot mutate the declaration", () => {
    const entry = { statements: ["A"] };
    migrationStatements("k", entry).push("B");
    expect(entry.statements).toEqual(["A"]);
  });
});

describe("pendingKeys", () => {
  it("is lexicographic over keys, which is the documented run order", () => {
    const migrations = { "20260402_b": {}, "20260401_a": {}, "20260403_c": {} };
    expect(pendingKeys(migrations, new Set())).toEqual([
      "20260401_a",
      "20260402_b",
      "20260403_c",
    ]);
  });

  it("skips what the ledger already has", () => {
    const migrations = { a: {}, b: {} };
    expect(pendingKeys(migrations, new Set(["a"]))).toEqual(["b"]);
  });

  it("is empty when everything has run", () => {
    expect(pendingKeys({ a: {} }, new Set(["a"]))).toEqual([]);
  });
});

describe("orphanedKeys", () => {
  it("reports an applied key no declaration mentions, across both phases", () => {
    expect(orphanedKeys(new Set(["a", "b", "c"]), { a: {} }, { b: {} })).toEqual(["c"]);
  });

  it("reports nothing when every applied key is still declared", () => {
    expect(orphanedKeys(new Set(["a"]), { a: {} }, {})).toEqual([]);
  });
});
