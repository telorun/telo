import { describe, expect, it } from "vitest";
import { evalPathCovers, evalPathsCover } from "../src/eval-paths.js";

describe("evalPathCovers — shared x-telo-eval containment rule", () => {
  it("`**` covers everything", () => {
    expect(evalPathCovers("**", "anything.at.all[3]")).toBe(true);
    expect(evalPathCovers("**", "")).toBe(true);
  });

  it("a dotted path covers itself and any descendant", () => {
    expect(evalPathCovers("handler", "handler")).toBe(true);
    expect(evalPathCovers("handler", "handler.body")).toBe(true);
    expect(evalPathCovers("handler", "handler[0]")).toBe(true);
    expect(evalPathCovers("a.b", "a.b.c.d")).toBe(true);
  });

  it("does not cover a sibling, a prefix that is not a boundary, or an ancestor", () => {
    expect(evalPathCovers("a.b", "a.bc")).toBe(false); // not a path boundary
    expect(evalPathCovers("handler", "handlers")).toBe(false);
    expect(evalPathCovers("a.b", "a")).toBe(false); // ancestor is not covered
    expect(evalPathCovers("a", "b")).toBe(false);
  });

  it("evalPathsCover is the any-of lift over the set", () => {
    expect(evalPathsCover(["x", "y"], "y.z")).toBe(true);
    expect(evalPathsCover(["**"], "whatever")).toBe(true);
    expect(evalPathsCover(["a", "b"], "c")).toBe(false);
  });
});

describe("kernel isExcluded stays in lockstep with the shared rule", () => {
  // The kernel excludes a compile path that overlaps a runtime path in EITHER
  // direction. This reproduces the pre-refactor hand-rolled predicate and asserts
  // the shared formulation matches it across the pure-dotted input domain the
  // kernel uses (buildEvalPaths never emits array segments), so the refactor is
  // behavior-preserving.
  const legacyIsExcluded = (path: string, excludePaths: string[]): boolean =>
    excludePaths.some(
      (ep) => ep === path || ep === "**" || path.startsWith(ep + ".") || ep.startsWith(path + "."),
    );
  const sharedIsExcluded = (path: string, excludePaths: string[]): boolean =>
    excludePaths.some((ep) => evalPathCovers(ep, path) || evalPathCovers(path, ep));

  const paths = ["a", "a.b", "a.b.c", "ab", "x", "config.timeout"];
  const excludeSets = [
    [],
    ["**"],
    ["a"],
    ["a.b"],
    ["a.b.c"],
    ["x", "a.b"],
    ["config"],
    ["config.timeout.ms"],
  ];

  it("matches the legacy predicate for every (path, excludePaths) pair", () => {
    for (const path of paths) {
      for (const excl of excludeSets) {
        expect(sharedIsExcluded(path, excl)).toBe(legacyIsExcluded(path, excl));
      }
    }
  });
});
