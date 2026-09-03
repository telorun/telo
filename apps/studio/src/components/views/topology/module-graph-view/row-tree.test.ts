import type { GraphRow } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { branchingRows, isRowDrawn, visibleRows } from "./row-tree";

/**
 * The body of the `chatLoop` sequence that made the tree necessary: two steps
 * at the top, the second a `while` whose `do` holds five more — pre-order, as
 * the call graph emits it.
 */
const body: GraphRow[] = [
  { id: "read", kind: "step", path: "steps[0]", array: "steps", index: 0, depth: 0 },
  { id: "converse", kind: "step", path: "steps[1]", array: "steps", index: 1, depth: 0 },
  ...["insertUser", "readHistory", "ask", "print", "insertAssistant"].map(
    (name, index): GraphRow => ({
      id: name,
      kind: "step",
      path: `steps[1].do[${index}]`,
      array: "steps[1].do",
      index,
      depth: 1,
      parent: "converse",
    }),
  ),
];

const deep: GraphRow[] = [
  ...body,
  {
    id: "retry",
    kind: "step",
    path: "steps[1].do[2].then[0]",
    array: "steps[1].do[2].then",
    index: 0,
    depth: 2,
    parent: "ask",
  },
];

describe("which rows own a body", () => {
  it("names every row something nests under, and no leaf", () => {
    expect([...branchingRows(body)]).toEqual(["converse"]);
    expect([...branchingRows(deep)].sort()).toEqual(["ask", "converse"]);
  });
});

describe("what a body shows once branches are put away", () => {
  const open = (shut: string[]) => (id: string) => !shut.includes(id);

  it("shows the whole tree when nothing is shut", () => {
    expect(visibleRows(body, open([])).map((r) => r.id)).toEqual(body.map((r) => r.id));
  });

  it("puts a loop away with its contents, not beside them", () => {
    expect(visibleRows(body, open(["converse"])).map((r) => r.id)).toEqual(["read", "converse"]);
  });

  it("takes a grandchild with the ancestor that was shut", () => {
    expect(visibleRows(deep, open(["converse"])).map((r) => r.id)).toEqual(["read", "converse"]);
  });

  it("shuts one branch inside an open one", () => {
    expect(visibleRows(deep, open(["ask"])).map((r) => r.id)).toEqual([
      "read",
      "converse",
      "insertUser",
      "readHistory",
      "ask",
      "print",
      "insertAssistant",
    ]);
  });
});

describe("whether one row is drawn", () => {
  const open = (shut: string[]) => (id: string) => !shut.includes(id);

  it("draws a top-level row whatever is shut below it", () => {
    expect(isRowDrawn(deep, "read", open(["converse", "ask"]))).toBe(true);
  });

  it("does not draw a row whose grandparent is shut", () => {
    expect(isRowDrawn(deep, "retry", open(["converse"]))).toBe(false);
  });

  it("draws a row every ancestor of which is open", () => {
    expect(isRowDrawn(deep, "retry", open([]))).toBe(true);
  });
});
