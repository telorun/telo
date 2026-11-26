import { describe, expect, it } from "vitest";
import { viewportRevealing } from "./viewport-reveal";

const size = { width: 400, height: 300 };
const node = { x: 100, y: 50, width: 100, height: 60 };

describe("viewportRevealing", () => {
  it("leaves a node already in view", () => {
    expect(viewportRevealing({ x: 0, y: 0, zoom: 1 }, node, size)).toBeNull();
  });

  it("pans a node hidden past the right edge into view, by the least amount", () => {
    const next = viewportRevealing({ x: 0, y: 0, zoom: 1 }, node, { width: 180, height: 300 });
    expect(next).toEqual({ x: -44, y: 0, zoom: 1 });
  });

  it("accounts for zoom and the left edge", () => {
    const next = viewportRevealing({ x: -300, y: 0, zoom: 2 }, node, size);
    expect(next).toEqual({ x: -176, y: 0, zoom: 2 });
  });
});
