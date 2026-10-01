import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { createAjv } from "../src/schema-compat.js";
import { SchemaNodeValidator } from "../src/schema-node-validator.js";
import { readStandIn, withoutStandInFindings, type StandIns } from "../src/stand-in-findings.js";

/** The findings the judge keeps, as the analyzer's registry asks it: the
 *  validator's plain errors, and a verbose twin to decide each union with. */
function findings(
  schema: Record<string, any>,
  data: unknown,
  standIns: StandIns,
  shapes: Record<string, Record<string, any>> = {},
) {
  const ajv = createAjv();
  const located = createAjv({ verbose: true });
  for (const [id, shape] of Object.entries(shapes)) {
    ajv.addSchema(shape, id);
    located.addSchema(shape, id);
  }
  const validate = ajv.compile(schema);
  expect(validate(data)).toBe(false);
  return withoutStandInFindings(validate.errors, {
    value: data,
    schema,
    standIns,
    validate: new SchemaNodeValidator(located).findingsFor(schema),
  }).map((e) => `${e.instancePath} ${e.keyword}`);
}

const SECONDS = { type: "string", pattern: "^\\d+s$" };

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
  it("keeps a sibling reference's finding beside a union a stand-in satisfies", () => {
    const schema = {
      type: "object",
      properties: {
        cfg: {
          $ref: "#/$defs/Base",
          anyOf: [{ type: "object", properties: { a: SECONDS } }, { type: "integer" }],
        },
      },
      $defs: { Base: { type: "object", required: ["b"] } },
    };
    expect(findings(schema, { cfg: { a: "" } }, new Map([["/cfg/a", "produced"]]))).toEqual([
      "/cfg required",
    ]);
  });

  it("keeps the finding of an allOf member evaluated before a satisfied union", () => {
    const schema = {
      type: "object",
      allOf: [
        { $ref: "#/$defs/Base" },
        {
          properties: {
            cfg: { anyOf: [{ type: "object", properties: { a: SECONDS } }, { type: "integer" }] },
          },
        },
      ],
      $defs: { Base: { properties: { cfg: { type: "object", required: ["b"] } } } },
    };
    expect(findings(schema, { cfg: { a: "" } }, new Map([["/cfg/a", "produced"]]))).toEqual([
      "/cfg required",
    ]);
  });

  it("keeps once a finding a sibling raises and a branch of a satisfied union reproduces", () => {
    const schema = {
      type: "object",
      properties: {
        cfg: {
          $ref: "#/$defs/Base",
          anyOf: [{ $ref: "#/$defs/Base" }, { type: "object", properties: { a: SECONDS } }],
        },
      },
      $defs: { Base: { type: "object", required: ["b"] } },
    };
    expect(findings(schema, { cfg: { a: "" } }, new Map([["/cfg/a", "produced"]]))).toEqual([
      "/cfg required",
    ]);
  });

  it("judges two referenced branches apart", () => {
    const schema = {
      type: "object",
      properties: { wait: { anyOf: [{ $ref: "#/$defs/Seconds" }, { $ref: "#/$defs/Count" }] } },
      $defs: { Seconds: SECONDS, Count: { type: "integer" } },
    };
    expect(findings(schema, { wait: "" }, produced)).toEqual([]);
  });

  it("judges a branch that is a named shape", () => {
    const schema = {
      type: "object",
      properties: { wait: { anyOf: [{ $ref: "telo://m/Seconds" }, { $ref: "telo://m/Count" }] } },
    };
    const shapes = { "telo://m/Seconds": SECONDS, "telo://m/Count": { type: "integer" } };
    expect(findings(schema, { wait: "" }, produced, shapes)).toEqual([]);
  });

  it("judges a union declared in a named shape that names another", () => {
    const schema = { type: "object", properties: { wait: { $ref: "telo://m/Wait" } } };
    const shapes = {
      "telo://m/Wait": {
        anyOf: [{ $ref: "telo://m/Seconds" }, { $ref: "#/$defs/Count" }],
        $defs: { Count: { type: "integer" } },
      },
      "telo://m/Seconds": SECONDS,
    };
    expect(findings(schema, { wait: "" }, produced, shapes)).toEqual([]);
  });

  it("judges a union of a recursive shape at each place it is reached", () => {
    const schema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            wait: { anyOf: [{ $ref: "#/$defs/Seconds" }, { $ref: "#/$defs/Count" }] },
            child: { $ref: "#/$defs/Node" },
          },
        },
        Seconds: SECONDS,
        Count: { type: "integer" },
      },
    };
    const data = { wait: "soon", child: { child: { wait: "" } } };
    expect(findings(schema, data, new Map([["/child/child/wait", "produced"]]))).toEqual([
      "/wait pattern",
      "/wait type",
      "/wait anyOf",
    ]);
  });

  it("satisfies a union through a branch whose own union a stand-in satisfies", () => {
    const schema = {
      anyOf: [
        {
          type: "object",
          properties: { wait: { anyOf: [{ $ref: "#/$defs/Seconds" }, { type: "integer" }] } },
        },
        { type: "string" },
      ],
      $defs: { Seconds: SECONDS },
    };
    expect(findings(schema, { wait: "" }, produced)).toEqual([]);
  });

  it("excuses a oneOf several branches match only where the value is a stand-in's", () => {
    const schema = {
      type: "object",
      properties: {
        wait: { oneOf: [{ type: "integer" }, { type: "string", maxLength: 9 }, SECONDS] },
        other: { oneOf: [{ type: "integer" }, { type: "string", maxLength: 9 }, { type: "string" }] },
      },
    };
    const data = { wait: "5s", other: "x" };
    expect(findings(schema, data, produced)).toEqual(["/other type", "/other oneOf"]);
  });
});

describe("withoutStandInFindings — content keywords at a value holding stand-ins", () => {
  const tags = { type: "object", properties: { tags: { type: "array", uniqueItems: true } } };

  it("never compares two stand-ins with each other", () => {
    const standIns: StandIns = new Map([
      ["/tags/0", "produced"],
      ["/tags/1", "computed"],
    ]);
    expect(findings(tags, { tags: ["", ""] }, standIns)).toEqual([]);
  });

  it("names the written duplicates a pair of stand-ins precedes", () => {
    const standIns: StandIns = new Map([
      ["/tags/2", "produced"],
      ["/tags/3", "produced"],
    ]);
    const validate = createAjv().compile(tags);
    const data = { tags: ["x", "x", "", ""] };
    expect(validate(data)).toBe(false);
    expect(validate.errors?.[0]?.params).toEqual({ i: 3, j: 2 });
    const kept = withoutStandInFindings(validate.errors, {
      value: data,
      schema: tags,
      standIns,
      validate: () => undefined,
    });
    expect(kept.map((e) => [e.instancePath, e.params, e.message])).toEqual([
      ["/tags", { i: 1, j: 0 }, "must NOT have duplicate items (items ## 0 and 1 are identical)"],
    ]);
  });

  it("leaves out an item that holds a stand-in", () => {
    const standIns: StandIns = new Map([
      ["/tags/0/id", "computed"],
      ["/tags/1/id", "computed"],
    ]);
    expect(findings(tags, { tags: [{ id: null }, { id: null }] }, standIns)).toEqual([]);
  });

  it("holds an enum to the parts written around a stand-in", () => {
    const schema = {
      type: "object",
      properties: {
        mode: {
          enum: [
            { name: "fast", level: 1 },
            { name: "slow", level: 2 },
          ],
        },
      },
    };
    const standIns: StandIns = new Map([["/mode/name", "produced"]]);
    expect(findings(schema, { mode: { name: "", level: 2 } }, standIns)).toEqual([]);
    expect(findings(schema, { mode: { name: "", level: 3 } }, standIns)).toEqual(["/mode enum"]);
  });
});
