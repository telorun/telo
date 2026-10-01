import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { createAjv } from "../src/schema-compat.js";
import { readStandIn, withoutStandInFindings, type StandIns } from "../src/stand-in-findings.js";

function findings(schema: Record<string, any>, data: unknown, standIns: StandIns) {
  const validate = createAjv().compile(schema);
  expect(validate(data)).toBe(false);
  return withoutStandInFindings(validate.errors, standIns).map((e) => `${e.instancePath} ${e.keyword}`);
}

describe("readStandIn", () => {
  it("classifies a tag by its engine: computed, produced, or a value resolved at compile", () => {
    expect(readStandIn(makeTaggedSentinel("cel", "variables.t"))).toEqual({
      kind: "stand-in",
      class: "computed",
    });
    expect(readStandIn(makeTaggedSentinel("interpolate", "${{ variables.t }}s"))).toEqual({
      kind: "stand-in",
      class: "produced",
      produced: { type: "string" },
    });
    expect(readStandIn(makeTaggedSentinel("literal", "5s"))).toEqual({ kind: "value", value: "5s" });
  });
});

describe("withoutStandInFindings", () => {
  const produced: StandIns = new Map([["/wait", "produced"]]);

  it("satisfies a union through a referenced branch failing only on a value constraint", () => {
    const schema = {
      type: "object",
      properties: { wait: { anyOf: [{ $ref: "#/$defs/Text" }, { type: "integer" }] } },
      $defs: { Text: { type: "string", pattern: "^\\d+s$" } },
    };
    expect(findings(schema, { wait: "" }, produced)).toEqual([]);
  });

  it("keeps a union no branch of which admits the produced type", () => {
    const schema = {
      type: "object",
      properties: { wait: { anyOf: [{ type: "integer" }, { type: "boolean" }] } },
    };
    expect(findings(schema, { wait: "" }, produced)).toContain("/wait anyOf");
  });

  it("keeps a finding beside a satisfied union at the same node", () => {
    const schema = {
      type: "object",
      not: { required: ["wait"] },
      anyOf: [
        { properties: { wait: { type: "string", pattern: "^\\d+s$" } } },
        { properties: { wait: { type: "integer" } } },
      ],
    };
    expect(findings(schema, { wait: "" }, produced)).toEqual([" not"]);
  });
});
