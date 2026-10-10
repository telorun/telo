import { describe, expect, it } from "vitest";
import type { CompiledColumn } from "../src/compiled-types.js";
import { merge } from "../src/revision-merge.js";

const properties = new Map(
  ["name", "age", "city"].map((name) => [name, { name } as unknown as CompiledColumn]),
);

/**
 * What a moved pin feeds the merge: the layer's own statement, the row it
 * recorded as lying beneath it — the ancestor — and the row that lies beneath
 * it now.
 */
const overMovedPin = (
  mine: { effect: "stated" | "removed"; row?: Record<string, unknown> },
  recorded: Record<string, unknown> | undefined,
  now: Record<string, unknown> | undefined,
) =>
  merge(properties, {
    mine: { effect: mine.effect, row: mine.row ?? {} },
    ...(recorded ? { base: recorded } : {}),
    ...(now ? { theirs: now } : {}),
  });

const ada = { name: "Ada", age: 36, city: "London" };

describe("a statement merged against a moved pin", () => {
  it("takes what the base alone changed, keeping what the layer changed", () => {
    expect(
      overMovedPin({ effect: "stated", row: { ...ada, age: 37 } }, ada, { ...ada, city: "Paris" }),
    ).toEqual({ outcome: "keep", values: { name: "Ada", age: 37, city: "Paris" } });
  });

  it("stands unchanged when the base changed only what the layer changed alike", () => {
    expect(
      overMovedPin({ effect: "stated", row: { ...ada, age: 37 } }, ada, { ...ada, age: 37, city: "Paris" }),
    ).toEqual({ outcome: "drop" });
  });

  it("names only the properties both changed to different values", () => {
    expect(
      overMovedPin(
        { effect: "stated", row: { ...ada, age: 37, name: "Ada L." } },
        ada,
        { ...ada, age: 38, city: "Paris" },
      ),
    ).toEqual({
      outcome: "conflict",
      class: "changed-both",
      properties: ["age"],
      takingMine: { name: "Ada L.", age: 37, city: "Paris" },
      takingTheirs: { name: "Ada L.", age: 38, city: "Paris" },
    });
  });

  it("has nothing left to say when the base came to state what the layer states", () => {
    expect(
      overMovedPin({ effect: "stated", row: { ...ada, age: 37 } }, ada, { ...ada, age: 37 }),
    ).toEqual({ outcome: "drop" });
  });

  it("is changed-removed when the base no longer states what the layer changed", () => {
    expect(overMovedPin({ effect: "stated", row: { ...ada, age: 37 } }, ada, undefined)).toEqual({
      outcome: "conflict",
      class: "changed-removed",
      takingMine: { ...ada, age: 37 },
    });
  });

  it("keeps hiding a key the base left as it was, and is removed-changed once the base changed it", () => {
    expect(overMovedPin({ effect: "removed" }, ada, ada)).toEqual({ outcome: "keep" });
    expect(overMovedPin({ effect: "removed" }, ada, { ...ada, age: 37 })).toEqual({
      outcome: "conflict",
      class: "removed-changed",
      takingTheirs: { ...ada, age: 37 },
    });
  });

  it("drops a removal of a key the base no longer states", () => {
    expect(overMovedPin({ effect: "removed" }, ada, undefined)).toEqual({ outcome: "drop" });
  });

  it("is added-both when the base came to state a key the layer added over nothing", () => {
    expect(overMovedPin({ effect: "stated", row: ada }, undefined, { ...ada, age: 40 })).toEqual({
      outcome: "conflict",
      class: "added-both",
      takingMine: ada,
      takingTheirs: { ...ada, age: 40 },
    });
    expect(overMovedPin({ effect: "stated", row: ada }, undefined, ada)).toEqual({ outcome: "drop" });
  });
});
