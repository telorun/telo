import { describe, expect, it } from "vitest";
import { reconcileJustDeleted, type JustDeleted } from "./just-deleted";

const entry = (over: Partial<JustDeleted> = {}): JustDeleted => ({
  kind: "K",
  name: "a",
  gone: false,
  settled: false,
  ...over,
});
const world = (graph: string[], declared: boolean) => ({
  graphIds: new Set(graph),
  declared: () => declared,
});

describe("reconcileJustDeleted", () => {
  it("keeps an entry while the model still holds the node and the document lost it", () => {
    const held = new Map([["n", entry()]]);
    const next = reconcileJustDeleted(held, world(["n"], false));
    expect(next.get("n")).toMatchObject({ gone: true });
  });

  it("drops it once a model without the node arrives", () => {
    const held = new Map([["n", entry({ gone: true })]]);
    expect(reconcileJustDeleted(held, world([], false)).size).toBe(0);
  });

  it("drops it when the document holds the resource again after losing it", () => {
    const held = new Map([["n", entry({ gone: true })]]);
    expect(reconcileJustDeleted(held, world(["n"], true)).size).toBe(0);
  });

  it("drops it when the delete returned and the document never lost it", () => {
    const held = new Map([["n", entry({ settled: true })]]);
    expect(reconcileJustDeleted(held, world(["n"], true)).size).toBe(0);
  });

  it("keeps a pending delete whose document has not changed yet", () => {
    const held = new Map([["n", entry()]]);
    expect(reconcileJustDeleted(held, world(["n"], true))).toBe(held);
  });
});
