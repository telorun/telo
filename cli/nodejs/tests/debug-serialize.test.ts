import { celDurationFromNanos, celMapFromEntries, celUint } from "@telorun/sdk";
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

describe("toWire CEL values", () => {
  it("writes a timestamp, duration, uint, non-finite double and int-keyed map in plain form", () => {
    expect(
      wireOf({
        at: new Date("2026-01-15T07:30:00Z"),
        took: celDurationFromNanos(5400n * 1_000_000_000n),
        count: celUint(7n),
        ratio: Number.NaN,
        byInt: celMapFromEntries([1n, "one"]),
      }),
    ).toEqual({
      at: "2026-01-15T07:30:00.000Z",
      took: "5400s",
      count: 7,
      ratio: "NaN",
      byInt: { "1": "one" },
    });
  });

  it("writes a map whose keys share a text as its pairs", () => {
    // An int and a string are two keys in CEL and one object key, so the pairs are the
    // only writing that keeps both — and observing a run must never fail it.
    //
    // The guard's other arm, a key that is no CEL map key at all, is unreachable through
    // the value domain: a map is built with an int, uint, bool or string key, so a double
    // key cannot be inside one. It stays in the serializer as a defence, since this writer
    // is handed whatever the debug wire carries and may not throw about it.
    expect(
      wireOf({
        colliding: celMapFromEntries([1n, "a", "1", "b"]),
      }),
    ).toEqual({
      colliding: [
        [1, "a"],
        ["1", "b"],
      ],
    });
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
