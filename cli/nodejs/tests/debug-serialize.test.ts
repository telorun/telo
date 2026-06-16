import { describe, expect, it } from "vitest";
import { serializeEvent } from "../src/debug-serialize.js";

const wireOf = (payload: unknown): any =>
  JSON.parse(serializeEvent("X.Y.Invoked", payload)).payload;

describe("toWire cycle detection", () => {
  it("serializes a shared (non-cyclic) reference fully on every path", () => {
    // The shape the template/handler dispatch produces: `filters` reachable via
    // two sibling paths — a DAG, not a cycle.
    const filters = { a: 1 };
    const payload = { filters, inputs: { filters } };
    expect(wireOf(payload)).toEqual({ filters: { a: 1 }, inputs: { filters: { a: 1 } } });
  });

  it("still cuts a genuine cycle as [Circular]", () => {
    const a: any = { name: "a" };
    a.self = a;
    expect(wireOf(a)).toEqual({ name: "a", self: "[Circular]" });
  });

  it("cuts a cycle through an array, but keeps a shared array sibling intact", () => {
    const shared = [1, 2];
    expect(wireOf({ x: shared, y: shared })).toEqual({ x: [1, 2], y: [1, 2] });

    const cyclic: any = { list: [] };
    cyclic.list.push(cyclic);
    expect(wireOf(cyclic)).toEqual({ list: ["[Circular]"] });
  });
});

describe("toWire bigint formatting", () => {
  it("emits a safe-range bigint as a plain number", () => {
    expect(wireOf({ score: 3n })).toEqual({ score: 3 });
    expect(wireOf({ score: -7n })).toEqual({ score: -7 });
    expect(wireOf({ max: BigInt(Number.MAX_SAFE_INTEGER) })).toEqual({
      max: Number.MAX_SAFE_INTEGER,
    });
  });

  it("emits an out-of-range bigint as a lossless decimal string", () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    expect(wireOf({ big })).toEqual({ big: big.toString() });
  });
});
