import { describe, expect, it } from "vitest";
import { configurationsCondition } from "../src/configuration-dimensions.js";
import { ConditionSpace, definitionDimensionKey, FALSE, TRUE, type Condition, type ConditionDimension } from "../src/presence-condition.js";

type Assignment = Record<string, unknown>;

const keyOf = (a: Assignment) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]]));

function product(dimensions: readonly ConditionDimension[], block?: Map<string, Set<unknown>>): Assignment[] {
  let out: Assignment[] = [{}];
  for (const d of dimensions) {
    out = out.flatMap((p) => [...(block?.get(d.key) ?? d.values)].map((v) => ({ ...p, [d.key]: v })));
  }
  return out;
}

/** The enumerating cover the labels were written by before conditions: seeded
 *  at the first remaining configuration, grown in dimension and value order. */
function enumeratedCover(subset: Assignment[], all: Assignment[], dimensions: readonly ConditionDimension[]) {
  const remaining = new Map(subset.map((a) => [keyOf(a), a]));
  const universe = new Set(all.map(keyOf));
  const members = new Set(remaining.keys());
  const blocks: Map<string, unknown[]>[] = [];
  while (remaining.size > 0) {
    const seed = remaining.values().next().value as Assignment;
    const block = new Map<string, Set<unknown>>(dimensions.map((d) => [d.key, new Set([seed[d.key]])]));
    const inSubset = () => product(dimensions, block).every((a) => !universe.has(keyOf(a)) || members.has(keyOf(a)));
    for (const d of dimensions) {
      for (const v of d.values) {
        const values = block.get(d.key)!;
        if (values.has(v)) continue;
        values.add(v);
        if (!inSubset()) values.delete(v);
      }
    }
    for (const a of product(dimensions, block)) remaining.delete(keyOf(a));
    const out = new Map<string, unknown[]>();
    for (const d of dimensions) {
      const values = [...block.get(d.key)!];
      if (values.length !== d.values.length) out.set(d.key, values);
    }
    blocks.push(out);
  }
  return blocks;
}

/** A deterministic sequence, so a failure reproduces. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("presence conditions", () => {
  it("are one node for one set of configurations, however they were built", () => {
    const space = new ConditionSpace([
      { key: "a", values: [1, 2, 3] },
      { key: "b", values: [false, true] },
    ]);
    const a12 = space.literal("a", [1, 2]);
    const b = space.literal("b", [true]);
    expect(space.or(space.and(a12, b), space.and(space.not(a12), b))).toBe(b);
    expect(space.not(space.and(a12, b))).toBe(space.or(space.not(a12), space.not(b)));
    expect(space.or(a12, space.not(a12))).toBe(TRUE);
    expect(space.and(b, space.not(b))).toBe(FALSE);
    expect(space.implies(space.and(a12, b), b)).toBe(true);
    expect(space.holds(space.and(a12, b), { a: 2, b: true })).toBe(true);
    expect(space.firstAssignment(space.and(space.literal("a", [3]), b))).toEqual({ a: 3, b: true });
  });

  it("cover a condition with the blocks the enumerating cover grew, but for one the others cover", () => {
    const next = random(7);
    for (let round = 0; round < 300; round++) {
      const dimensions: ConditionDimension[] = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, i) => ({
        key: `d${i}`,
        values: Array.from({ length: 1 + Math.floor(next() * 3) }, (_, v) => (v === 2 ? null : `v${v}`)),
      }));
      const every = product(dimensions);
      const all = every.filter(() => next() < 0.85);
      const subset = all.filter(() => next() < 0.5);
      const space = new ConditionSpace(dimensions);
      const blocks = space.cover(
        space.some(subset.map((a) => space.assignment(a))),
        space.some(all.map((a) => space.assignment(a))),
      );
      const expected = enumeratedCover(subset, all, dimensions).map((b) => JSON.stringify([...b]));
      // The enumerating cover may keep a block the later ones cover; the
      // cover keeps the others, in its order, and still covers the subset.
      const holds = (block: Map<string, unknown[]> | ReadonlyMap<string, readonly unknown[]>, a: Assignment) =>
        dimensions.every((d) => (block.get(d.key) ?? d.values).includes(a[d.key]));
      const shown = blocks.map((b) => JSON.stringify([...b]));
      expect(shown.filter((b) => expected.includes(b)), JSON.stringify({ dimensions, all, subset })).toEqual(shown);
      expect(expected.filter((b) => shown.includes(b))).toEqual(shown);
      for (const a of subset) expect(blocks.some((b) => holds(b, a))).toBe(true);
      for (const a of all) if (blocks.some((b) => holds(b, a))) expect(subset.map(keyOf)).toContain(keyOf(a));
      blocks.forEach((block, i) => {
        const others = blocks.filter((_, j) => j !== i);
        expect(subset.some((a) => holds(block, a) && !others.some((o) => holds(o, a)))).toBe(true);
      });
    }
  });

  it("restrict a condition to fixed values of the dimensions an assignment names", () => {
    const space = new ConditionSpace([
      { key: "a", values: [1, 2] },
      { key: "b", values: [true, false] },
    ]);
    const c = space.or(space.assignment({ a: 1, b: true }), space.assignment({ a: 2, b: false }));
    expect(space.restrict(c, { a: 1 })).toBe(space.literal("b", [true]));
    expect(space.restrict(c, { a: 2, b: true })).toBe(FALSE);
  });

  it("project dimensions out where some value of each makes a condition hold", () => {
    const space = new ConditionSpace([
      { key: "a", values: [1, 2, 3] },
      { key: "b", values: [true, false] },
    ]);
    const c = space.or(space.assignment({ a: 1, b: true }), space.assignment({ a: 2, b: true }));
    expect(space.exists(c, ["a"])).toBe(space.literal("b", [true]));
    expect(space.exists(c, ["a", "b"])).toBe(TRUE);
  });

  it("translate a condition into another space, each dimension renamed, fixed or projected out", () => {
    const from = new ConditionSpace([
      { key: "lib.flag", values: [true, false] },
      { key: "lib.mode", values: ["x", "y"] },
      { key: "lib.open", values: ["p", "q"] },
    ]);
    const to = new ConditionSpace([{ key: "app.flag", values: [true, false] }]);
    const c = from.and(from.literal("lib.flag", [true]), from.or(from.literal("lib.mode", ["x"]), from.literal("lib.open", ["p"])));
    const meanings: Record<string, { key: string } | { fact: unknown } | undefined> = {
      "lib.flag": { key: "app.flag" },
      "lib.mode": { fact: "y" },
      "lib.open": undefined,
    };
    expect(from.translate(c, to, (key) => meanings[key])).toBe(to.literal("app.flag", [true]));
    expect(from.translate(c, to, (key) => (key === "lib.open" ? { fact: "q" } : meanings[key]))).toBe(FALSE);
    expect(from.translate(c, to, (key) => (key === "lib.flag" ? { fact: "unknown" } : meanings[key]))).toBe(FALSE);
  });

  it("compose a dimension with a condition per value, of which renaming, fixing and projecting are cases", () => {
    const space = new ConditionSpace([
      { key: "variables.f", values: [true, false] },
      { key: "variables.g", values: ["a", "b"] },
      { key: "def:self.mode", values: ["x", "y", "z"], definition: { identity: "def", role: "closed", key: "self.mode" } },
    ]);
    const f = space.literal("variables.f", [true]);
    const g = space.literal("variables.g", ["a"]);
    const mode = (values: string[]) => space.literal("def:self.mode", values);
    const c = space.or(space.and(mode(["x"]), g), mode(["z"]));
    // `mode` is x where f holds, y or z elsewhere.
    const vector = [f, space.not(f), space.not(f)];
    const composed = space.translate(c, space, (key) => (key === "def:self.mode" ? { values: vector } : { key }));
    expect(composed).toBe(space.or(space.and(f, g), space.not(f)));
    expect(space.readsDefinition(c)).toBe(true);
    expect(space.readsDefinition(composed)).toBe(false);
    const through = (meaning: { values: Condition[] } | { fact: unknown } | undefined) =>
      space.translate(c, space, (key) => (key === "def:self.mode" ? meaning : { key }));
    expect(through({ fact: "x" })).toBe(through({ values: [TRUE, FALSE, FALSE] }));
    expect(through(undefined)).toBe(through({ values: [TRUE, TRUE, TRUE] }));
    expect(() => through({ values: [TRUE] })).toThrow(/gives the dimension 'def:self.mode' 1 values of 3/);
  });

  it("cost what a condition's support costs, however many definition dimensions the space holds", () => {
    const roles = ["closed", "atom", "selector"] as const;
    const definitionDimensions: ConditionDimension[] = Array.from({ length: 64 }, (_, i) => {
      const role = roles[i % 3]!;
      const key = `self.d${i}`;
      return { key: definitionDimensionKey("Lib.Kind", key), values: ["x", "y", "z"], definition: { identity: "Lib.Kind", role, key } };
    });
    const space = new ConditionSpace([{ key: "variables.flag", values: [false, true] }, ...definitionDimensions]);
    const chosen = definitionDimensionKey("Lib.Kind", "self.d37");
    const c = space.and(space.literal("variables.flag", [true]), space.literal(chosen, ["y"]));
    const support = 2;
    const counted = <T>(operation: () => T): T => {
      const before = space.work;
      const out = operation();
      expect(space.work - before, operation.toString()).toBeLessThanOrEqual(16 * support);
      return out;
    };
    const universe = counted(() => configurationsCondition(space, [{ "variables.flag": false }, { "variables.flag": true }]));
    const held = counted(() => space.and(c, universe));
    const witness = counted(() => space.firstAssignment(held)!);
    expect(witness).toEqual({ "variables.flag": true, [chosen]: "y" });
    counted(() => space.assignment(witness));
    expect(counted(() => space.holds(c, witness))).toBe(true);
    // A definition dimension the witness leaves out is at its first value.
    expect(space.holds(space.literal(definitionDimensionKey("Lib.Kind", "self.d5"), ["x"]), witness)).toBe(true);
    expect(counted(() => space.restrict(c, witness))).toBe(TRUE);
    expect(counted(() => space.existsDefinitions(c))).toBe(space.literal("variables.flag", [true]));
    expect(counted(() => space.existsConfiguration(c))).toBe(space.literal(chosen, ["y"]));
    expect(counted(() => space.cover(c, universe))).toEqual([new Map([["variables.flag", [true]], [chosen, ["y"]]])]);
  });
});
