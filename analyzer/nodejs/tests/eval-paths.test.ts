import { describe, expect, it } from "vitest";
import {
  buildEvalPaths,
  concreteEvalPaths,
  evalPathCovers,
  evalPathsCover,
} from "../src/eval-paths.js";

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

describe("eval paths below maps, lists and a recursive $ref", () => {
  const field = {
    type: "object",
    properties: {
      selector: { type: "string", "x-telo-eval": "compile" },
      type: { type: "string" },
      fields: { type: "object", additionalProperties: { $ref: "#/$defs/Field" } },
    },
  };
  const schema = {
    type: "object",
    $defs: { Field: field },
    properties: {
      fields: { type: "object", additionalProperties: { $ref: "#/$defs/Field" } },
      rows: { type: "array", items: { type: "object", properties: { when: { "x-telo-eval": "runtime" } } } },
    },
  };

  it("names every depth of a recursive shape with one repeated group", () => {
    expect(buildEvalPaths(schema)).toEqual({
      compile: ["fields.*(.fields.*)*.selector"],
      runtime: ["rows[*].when"],
    });
  });

  it("covers the concrete paths at every depth, and nothing beside them", () => {
    const [selectors] = buildEvalPaths(schema).compile;
    expect(
      ["fields.a.selector", "fields.b.fields.c.selector", "fields.b.fields.c.fields.d.selector", "fields.a.type", "fields.a"].map(
        (target) => evalPathCovers(selectors!, target),
      ),
    ).toEqual([true, true, true, false, false]);
    expect(evalPathCovers("rows[*].when", "rows[2].when")).toBe(true);
  });

  it("finds each concrete place a pattern names in a value", () => {
    const value = {
      fields: { a: { selector: "h1", type: "text" }, b: { selector: ".x", fields: { c: { selector: "p" } } } },
    };
    expect(concreteEvalPaths(value, "fields.*(.fields.*)*.selector")).toEqual([
      ["fields", "a", "selector"],
      ["fields", "b", "selector"],
      ["fields", "b", "fields", "c", "selector"],
    ]);
    expect(concreteEvalPaths(value, "fields.a")).toEqual([["fields", "a"]]);
  });

  it("walks only plain containers, and only under the pattern's literal prefix", () => {
    class Instance {
      selector = "not configuration";
    }
    const value = {
      fields: { a: new Instance(), b: { selector: "p" }, bytes: new Uint8Array([1, 2, 3]) },
      other: {
        get selector(): string {
          throw new Error("walked outside the pattern's prefix");
        },
      },
    };
    expect(concreteEvalPaths(value, "fields.*.selector")).toEqual([["fields", "b", "selector"]]);
  });
});

describe("x-telo-eval beside a local $ref", () => {
  it("is read before the reference is followed", () => {
    expect(
      buildEvalPaths({
        type: "object",
        $defs: { B: { type: "object", properties: { x: { "x-telo-eval": "compile" } } } },
        properties: { body: { $ref: "#/$defs/B", "x-telo-eval": "runtime" } },
      }),
    ).toEqual({ compile: [], runtime: ["body"] });
  });
});
