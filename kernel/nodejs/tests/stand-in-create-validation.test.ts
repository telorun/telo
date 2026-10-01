import { withoutStandInFindings, type StandIns } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { stripCompiledValues } from "../src/schema-compiled-values.js";
import { SchemaValidator } from "../src/schema-validator.js";

/**
 * Create-time validation of a config holding a stand-in: a failure is judged
 * again on every error, each union decided branch by branch, so a stand-in
 * satisfying a union never takes a finding raised beside that union with it.
 */
describe("create-time validation with a stand-in recorded", () => {
  it("keeps a sibling reference's required member beside a union the stand-in satisfies", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        cfg: {
          $ref: "#/$defs/Base",
          anyOf: [
            { type: "object", properties: { a: { type: "string", pattern: "^\\d+s$" } } },
            { type: "integer" },
          ],
        },
      },
      $defs: { Base: { type: "object", required: ["b"] } },
    };
    const interpolated = { __compiled: true, engine: "interpolate", source: "${{ s }}s" };
    const standIns: StandIns = new Map();
    const stripped = stripCompiledValues(
      { kind: "Self.Thing", metadata: { name: "thing" }, cfg: { a: interpolated } },
      schema,
      undefined,
      undefined,
      standIns,
    );
    const validator = new SchemaValidator();
    expect(validator.compile(schema).isValid(stripped)).toBe(false);

    const findings = validator.findingsFor(schema);
    const remaining = withoutStandInFindings(findings(schema, stripped), {
      value: stripped,
      schema,
      standIns,
      validate: findings,
    });
    expect(remaining.map((e) => `${e.instancePath} ${e.keyword}`)).toEqual(["/cfg required"]);
  });
});
