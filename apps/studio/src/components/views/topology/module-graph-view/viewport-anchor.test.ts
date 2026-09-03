import { describe, expect, it } from "vitest";
import { anchorShift, defaultAnchor } from "./viewport-anchor";
import type { ModuleGraphLayout, PlacedNode } from "./elk-layout";

function layout(positions: Record<string, [number, number]>): ModuleGraphLayout {
  const placed: PlacedNode[] = Object.entries(positions).map(([id, [x, y]]) => ({
    node: { id, kind: "k.K", name: id, ownership: "named", ports: [], rows: [], rowArrays: [] },
    x,
    y,
    absoluteX: x,
    absoluteY: y,
    width: 220,
    height: 60,
    depth: 0,
  })) as PlacedNode[];
  return {
    placed,
    byId: new Map(placed.map((p) => [p.node.id, p] as const)),
    ownedBy: new Map(),
    routes: new Map(),
    width: 0,
    height: 0,
  };
}

describe("holding the canvas still", () => {
  it("shifts by exactly what the anchor moved", () => {
    const before = layout({ a: [0, 0], b: [0, 100] });
    const after = layout({ a: [0, 0], b: [0, 40] });
    expect(anchorShift(before, after, "b")).toEqual({ dx: 0, dy: -60 });
  });

  it("does nothing when the anchor did not move", () => {
    const before = layout({ a: [0, 0] });
    expect(anchorShift(before, layout({ a: [0, 0] }), "a")).toBeNull();
  });

  it("does nothing on the first layout — there is no previous place to keep", () => {
    expect(anchorShift(null, layout({ a: [0, 0] }), "a")).toBeNull();
  });

  it("does nothing for a box that is not in both layouts", () => {
    // A box that just appeared has no "same place" to be held in; guessing one
    // would move the canvas for no reason the reader could name.
    const before = layout({ a: [0, 0] });
    expect(anchorShift(before, layout({ a: [0, 0], b: [0, 80] }), "b")).toBeNull();
  });

  it("falls back to the top-left box common to both", () => {
    const before = layout({ a: [500, 500], b: [10, 10] });
    const after = layout({ a: [500, 400], b: [10, 10], c: [0, 0] });
    // `c` is nearer the origin but is new, so it cannot anchor anything.
    expect(defaultAnchor(before, after)).toBe("b");
  });
});
