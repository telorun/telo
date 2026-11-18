import { describe, expect, it } from "vitest";
import { formatAjvErrors } from "../src/schema-error-report.js";
import { unionOutcome, type BranchState } from "../src/union-outcome.js";
import { judgedFindings } from "./judged-validation.js";

const valid: BranchState = { state: "valid" };
const failing: BranchState = { state: "failing" };
const shape: BranchState = { state: "shape-refused" };
const typed: BranchState = { state: "type-refused" };
const tagAt = (...at: string[]): BranchState => ({ state: "tag-refused", at });

describe("unionOutcome", () => {
  it("passes an anyOf with a valid branch beside failing ones", () => {
    expect(unionOutcome("anyOf", [failing, valid, valid])).toEqual({ kind: "pass" });
  });

  it("passes a oneOf with exactly one valid branch", () => {
    expect(unionOutcome("oneOf", [failing, valid, shape])).toEqual({ kind: "pass" });
  });

  it("calls a oneOf several branches match ambiguous", () => {
    expect(unionOutcome("oneOf", [valid, failing, valid])).toEqual({ kind: "ambiguous" });
  });

  it("reads a tagged union by the one candidate accepting the tag", () => {
    for (const applicator of ["anyOf", "oneOf"] as const) {
      expect(unionOutcome(applicator, [tagAt("/kind"), shape, tagAt("/kind"), typed])).toEqual({
        kind: "branches",
        branches: [1],
      });
    }
  });

  it("refuses the tag where every candidate refuses it at one place", () => {
    for (const applicator of ["anyOf", "oneOf"] as const) {
      expect(unionOutcome(applicator, [typed, tagAt("/mode", "/kind"), tagAt("/kind")])).toEqual({
        kind: "tag",
        at: "/kind",
        branches: [1, 2],
      });
    }
  });

  it("decides among the candidates accepting the tag alone when several do", () => {
    for (const applicator of ["anyOf", "oneOf"] as const) {
      expect(unionOutcome(applicator, [failing, tagAt("/kind"), failing, shape])).toEqual({
        kind: "branches",
        branches: [0, 2],
      });
      expect(unionOutcome(applicator, [shape, tagAt("/kind"), shape])).toEqual({ kind: "alternatives" });
    }
  });

  it("reports every failing candidate where none refuses a tag", () => {
    for (const applicator of ["anyOf", "oneOf"] as const) {
      expect(unionOutcome(applicator, [failing, shape, failing, typed])).toEqual({
        kind: "branches",
        branches: [0, 2],
      });
    }
  });

  it("lists the alternatives where no candidate is failing", () => {
    for (const applicator of ["anyOf", "oneOf"] as const) {
      expect(unionOutcome(applicator, [shape, typed, shape])).toEqual({ kind: "alternatives" });
      expect(unionOutcome(applicator, [typed, typed])).toEqual({ kind: "alternatives" });
    }
  });
});

describe("a union judged branch by branch", () => {
  /** Two branches both accepting the value's shape, failing at different
   *  depths: neither is the reading by depth or by count. */
  const twoReadings = (applicator: "anyOf" | "oneOf") => ({
    type: "object",
    properties: {
      cfg: {
        [applicator]: [
          { type: "object", properties: { a: { type: "string" } } },
          { type: "object", properties: { b: { type: "object", properties: { c: { type: "integer" } } } } },
        ],
      },
    },
  });

  it("reports each of several failing branches", () => {
    for (const applicator of ["anyOf", "oneOf"] as const) {
      const findings = judgedFindings(twoReadings(applicator), { cfg: { a: 1, b: { c: "x" } } });
      expect(formatAjvErrors(findings)).toBe("/cfg/a must be string; /cfg/b/c must be integer");
    }
  });

  it("reports a finding several failing branches share once", () => {
    const schema = {
      anyOf: [
        { type: "object", required: ["a"], properties: { a: { type: "string" }, b: { $ref: "#/$defs/B" } } },
        { type: "object", properties: { b: { $ref: "#/$defs/B" }, c: { type: "integer" } } },
      ],
      $defs: { B: { type: "integer" } },
    };
    expect(formatAjvErrors(judgedFindings(schema, { a: 1, b: "x", c: "y" }))).toBe(
      "/a must be string; /b must be integer; /c must be integer",
    );
  });

  it("assigns a finding inside a referenced branch to that branch alone", () => {
    const shapes = {
      "test://content": {
        anyOf: [{ $ref: "#/$defs/Text" }, { $ref: "#/$defs/Table" }],
        $defs: {
          Text: {
            type: "object",
            required: ["kind"],
            properties: { kind: { const: "text" }, text: { type: "string" } },
          },
          Table: {
            type: "object",
            required: ["kind"],
            properties: {
              kind: { const: "table" },
              table: { type: "object", properties: { rows: { type: "array" } } },
            },
          },
        },
      },
    };
    const findings = judgedFindings(
      { $ref: "test://content" },
      { kind: "text", text: 1, table: { rows: 1 } },
      { shapes },
    );
    expect(formatAjvErrors(findings)).toBe("/text must be string");
  });
});
