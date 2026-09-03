import type { EdgeChange } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { applyEdgeSelection } from "./edge-selection";

describe("edge selection", () => {
  it("records a selection", () => {
    const next = applyEdgeSelection(new Set(), [
      { id: "a", type: "select", selected: true } as EdgeChange,
    ]);
    expect([...next]).toEqual(["a"]);
  });

  it("clears one", () => {
    const next = applyEdgeSelection(new Set(["a"]), [
      { id: "a", type: "select", selected: false } as EdgeChange,
    ]);
    expect([...next]).toEqual([]);
  });

  it("ignores a removal — the manifest decides what exists, not the canvas", () => {
    const before = new Set(["a"]);
    expect(applyEdgeSelection(before, [{ id: "a", type: "remove" } as EdgeChange])).toBe(before);
  });

  it("returns the same set when nothing selection-related happened", () => {
    const before = new Set(["a"]);
    expect(applyEdgeSelection(before, [])).toBe(before);
  });
});
