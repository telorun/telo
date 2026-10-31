import { describe, expect, it } from "vitest";
import { ConditionSpace, FALSE, TRUE, type ConditionDimension } from "../src/presence-condition.js";

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
});
