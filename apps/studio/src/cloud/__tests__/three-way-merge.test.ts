import { describe, expect, it } from "vitest";
import { planMerge, type PathState } from "../three-way-merge";

const file = (sha256: string, executable = false): PathState => ({
  kind: "file",
  sha256,
  executable,
});
const tree = (entries: Record<string, PathState>) => new Map(Object.entries(entries));

describe("planMerge", () => {
  it("takes the side that changed, and settles what both changed alike", () => {
    const plan = planMerge(
      tree({ same: file("1"), theirs: file("1"), mine: file("1"), both: file("1"), gone: file("1") }),
      tree({ same: file("1"), theirs: file("1"), mine: file("2"), both: file("3"), gone: file("1"), added: file("9") }),
      tree({ same: file("1"), theirs: file("2"), mine: file("1"), both: file("3"), new: file("7") }),
    );
    expect(plan).toEqual({ takeHead: ["gone", "new", "theirs"], conflicts: [] });
  });

  it("makes a conflict of a path changed differently on both sides, deletions included", () => {
    const plan = planMerge(
      tree({ edited: file("1"), deletedHere: file("1"), deletedThere: file("1") }),
      tree({ edited: file("2"), deletedThere: file("2"), addedBoth: file("4") }),
      tree({ edited: file("3"), deletedHere: file("3"), addedBoth: file("5") }),
    );
    expect(plan).toEqual({
      takeHead: [],
      conflicts: ["addedBoth", "deletedHere", "deletedThere", "edited"],
    });
  });

  it("treats a mode change as a change", () => {
    const plan = planMerge(
      tree({ run: file("1") }),
      tree({ run: file("1") }),
      tree({ run: file("1", true) }),
    );
    expect(plan.takeHead).toEqual(["run"]);
  });
});
