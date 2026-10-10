import { describe, expect, it } from "vitest";
import {
  composeStack,
  mergeBaseLists,
  placePins,
  sameBaseList,
  type Pin,
} from "../src/pinned-stack.js";

const pin = (layer: string, revision: number): Pin => ({ layer, revision: BigInt(revision) });
const names = (list: readonly Pin[]) => list.map((each) => `${each.layer}@${each.revision}`);

describe("a pinned stack", () => {
  it("is each pin followed by what lies beneath it, in position order", () => {
    const composed = composeStack([
      [pin("left", 2), pin("base", 5)],
      [pin("side", 1)],
    ]);
    expect("stack" in composed && names(composed.stack)).toEqual(["left@2", "base@5", "side@1"]);
  });

  it("gives a layer reached twice one place, the lowest", () => {
    const composed = composeStack([
      [pin("left", 2), pin("base", 5)],
      [pin("right", 3), pin("base", 5)],
    ]);
    expect("stack" in composed && names(composed.stack)).toEqual(["left@2", "right@3", "base@5"]);
  });

  it("refuses one layer reached at two revisions, naming both in order", () => {
    expect(
      composeStack([
        [pin("left", 2), pin("base", 6)],
        [pin("right", 3), pin("base", 5)],
      ]),
    ).toEqual({ conflict: { layer: "base", revisions: [5n, 6n] } });
  });
});

describe("pins set as one move", () => {
  const current = [pin("a", 1), pin("b", 1), pin("c", 1)];

  it("keeps an already-pinned layer's place and appends a new one", () => {
    expect(names(placePins(current, [pin("b", 4), pin("d", 2)]))).toEqual(["a@1", "b@4", "c@1", "d@2"]);
  });

  it("moves a layer to the position it names", () => {
    expect(names(placePins(current, [{ ...pin("c", 1), position: 0 }]))).toEqual(["c@1", "a@1", "b@1"]);
    expect(names(placePins(current, [{ ...pin("d", 1), position: 9 }]))).toEqual([
      "a@1",
      "b@1",
      "c@1",
      "d@1",
    ]);
  });

  it("leaves the list it was given as it was", () => {
    placePins(current, [pin("a", 9)]);
    expect(sameBaseList(current, [pin("a", 1), pin("b", 1), pin("c", 1)])).toBe(true);
  });
});

describe("a draft's base list brought onto the layer's current one", () => {
  it("is the head's list when the draft moved no pin", () => {
    const parent = [pin("a", 1), pin("b", 1)];
    expect(names(mergeBaseLists(parent, parent, [pin("a", 2), pin("c", 1)]))).toEqual(["a@2", "c@1"]);
  });

  it("keeps what the draft pinned, unpinned and moved, and takes the rest from the head", () => {
    const parent = [pin("a", 1), pin("b", 1), pin("c", 1)];
    const draft = [pin("a", 3), pin("c", 1), pin("d", 1)];
    const head = [pin("a", 2), pin("b", 2), pin("c", 2)];
    expect(names(mergeBaseLists(parent, draft, head))).toEqual(["a@3", "c@2", "d@1"]);
  });

  it("drops a layer the head unpinned and the draft left alone", () => {
    const parent = [pin("a", 1), pin("b", 1)];
    expect(names(mergeBaseLists(parent, [pin("a", 1), pin("b", 1), pin("d", 1)], [pin("a", 1)]))).toEqual([
      "a@1",
      "d@1",
    ]);
  });

  it("keeps the draft's order when the draft reordered the layers it kept", () => {
    const parent = [pin("a", 1), pin("b", 1)];
    expect(names(mergeBaseLists(parent, [pin("b", 1), pin("a", 1)], [pin("a", 2), pin("b", 1)]))).toEqual([
      "b@1",
      "a@2",
    ]);
  });
});
