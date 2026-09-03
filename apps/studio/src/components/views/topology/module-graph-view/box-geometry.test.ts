import type { GraphNode, GraphPort, GraphRow } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import {
  contentHeight,
  handleOffsets,
  HEADER_HEIGHT,
  PORT_HEIGHT,
  ROW_HEIGHT,
  ROW_SUMMARY_HEIGHT,
} from "./box-geometry";

const allOpen = () => true;
const allClosed = () => false;

const port = (slot: string, over: Partial<GraphPort> = {}): GraphPort => ({
  slot,
  refs: [],
  capabilities: [],
  array: false,
  class: "flow",
  slots: [{ path: slot }],
  ...over,
});

const row = (path: string, index: number): GraphRow => ({
  id: path,
  kind: "step",
  path,
  array: "steps",
  index,
  depth: 0,
});

/** A step inside `steps[1].do` — its own array, but part of the `steps` branch. */
const nested = (path: string, index: number, parent: string): GraphRow => ({
  id: path,
  kind: "step",
  path,
  array: "steps[1].do",
  index,
  depth: 1,
  parent,
});

const node = (over: Partial<GraphNode> = {}): GraphNode => ({
  id: "n",
  kind: "k.K",
  name: "n",
  ownership: "named",
  ports: [],
  rows: [],
  rowArrays: [],
  ...over,
});

describe("where a handle sits inside a box", () => {
  it("puts a port row's handle at that row's centre", () => {
    const n = node({ ports: [port("a"), port("b")] });
    const offsets = handleOffsets(n, allOpen);
    expect(offsets.get("a")).toBe(HEADER_HEIGHT + PORT_HEIGHT / 2);
    expect(offsets.get("b")).toBe(HEADER_HEIGHT + PORT_HEIGHT + PORT_HEIGHT / 2);
  });

  it("puts an ordered row's handle below its branch summary, once open", () => {
    const n = node({
      ports: [port("a")],
      rows: [row("steps[0]", 0), row("steps[1]", 1)],
      rowArrays: [{ field: "steps", kind: "step" }],
    });
    const offsets = handleOffsets(n, allOpen);
    const rowsTop = HEADER_HEIGHT + PORT_HEIGHT + ROW_SUMMARY_HEIGHT;
    expect(offsets.get("steps[0]")).toBe(rowsTop + ROW_HEIGHT / 2);
    expect(offsets.get("steps[1]")).toBe(rowsTop + ROW_HEIGHT + ROW_HEIGHT / 2);
  });

  it("offers no row handle while that branch is collapsed", () => {
    const n = node({
      rows: [row("steps[0]", 0)],
      rowArrays: [{ field: "steps", kind: "step" }],
    });
    expect(handleOffsets(n, allClosed).has("steps[0]")).toBe(false);
  });

  it("collapses one branch and leaves the other alone", () => {
    const n = node({
      ports: [port("notFoundHandler.invoke")],
      rows: [row("mounts[0]", 0)],
      rowArrays: [{ field: "mounts", kind: "entry" }],
    });
    const offsets = handleOffsets(n, (_id, prop) => prop === "notFoundHandler");
    expect(offsets.has("notFoundHandler.invoke")).toBe(true);
    expect(offsets.has("mounts[0]")).toBe(false);
  });

  it("gives an array port's append handle the port's own position", () => {
    const n = node({ ports: [port("mounts[].mount", { slots: [], addPath: "mounts[0].mount" })] });
    expect(handleOffsets(n, allOpen).get("mounts[0].mount")).toBe(HEADER_HEIGHT + PORT_HEIGHT / 2);
  });

  it("keeps every handle inside the box it belongs to", () => {
    const n = node({
      ports: [port("a"), port("b")],
      rows: [row("steps[0]", 0), row("steps[1]", 1)],
      rowArrays: [{ field: "steps", kind: "step" }],
    });
    const height = contentHeight(n, allOpen);
    for (const y of handleOffsets(n, allOpen).values()) {
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(height);
    }
  });

  it("keeps an uncollapsible branch open, so its socket is there whatever the state says", () => {
    const n = node({ ports: [port("notFoundHandler.invoke")] });
    expect(handleOffsets(n, allClosed).has("notFoundHandler.invoke")).toBe(true);
  });
});

describe("the room a picked slot takes", () => {
  const picker = (over: Partial<GraphPort> = {}) =>
    port("connection", { class: "holds", capabilities: ["Telo.Provider"], ...over });

  it("gives a single hold one row and no socket — nothing docks on a select", () => {
    const n = node({ ports: [picker()] });
    expect(contentHeight(n, allOpen)).toBe(contentHeight(node(), allOpen) + PORT_HEIGHT);
    expect(handleOffsets(n, allOpen).has("connection")).toBe(false);
  });

  it("gives an array hold a row per entry plus the next", () => {
    const n = node({
      ports: [
        picker({
          slot: "tables[]",
          array: true,
          slots: [{ path: "tables[0]", target: "users" }, { path: "tables[1]", target: "orders" }],
          addPath: "tables[2]",
        }),
      ],
    });
    expect(contentHeight(n, allOpen)).toBe(contentHeight(node(), allOpen) + PORT_HEIGHT * 3);
  });

  it("keeps its height whether the branch is nominally open or shut", () => {
    const n = node({ ports: [picker()] });
    expect(contentHeight(n, allClosed)).toBe(contentHeight(n, allOpen));
  });
});

describe("the room a nested body takes", () => {
  const loop = node({
    rows: [
      row("steps[0]", 0),
      row("steps[1]", 1),
      nested("steps[1].do[0]", 0, "steps[1]"),
      nested("steps[1].do[1]", 1, "steps[1]"),
    ],
    rowArrays: [{ field: "steps", kind: "step" }],
  });

  it("counts a nested row inside its own branch, not a branch of its own", () => {
    const bare = node({ rowArrays: [{ field: "steps", kind: "step" }] });
    // Summary + four rows + the add line, over the summary + add line alone.
    expect(contentHeight(loop, allOpen)).toBe(contentHeight(bare, allOpen) + ROW_HEIGHT * 4);
  });

  it("takes the whole body away when the branch is shut", () => {
    const shut = (_id: string, prop: string) => prop !== "steps";
    expect(handleOffsets(loop, shut).has("steps[1].do[0]")).toBe(false);
    expect(handleOffsets(loop, shut).has("steps[0]")).toBe(false);
  });

  it("takes only the loop's contents away when the loop itself is shut", () => {
    const shut = (_id: string, prop: string) => prop !== "steps[1]";
    const offsets = handleOffsets(loop, shut);
    expect(offsets.has("steps[0]")).toBe(true);
    expect(offsets.has("steps[1]")).toBe(true);
    expect(offsets.has("steps[1].do[0]")).toBe(false);
    expect(contentHeight(loop, shut)).toBe(contentHeight(loop, allOpen) - ROW_HEIGHT * 2);
  });
});
