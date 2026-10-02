import { makeTaggedSentinel } from "@telorun/templating";
import AjvModule from "ajv";
import { describe, expect, it } from "vitest";
import { createAjv } from "../src/schema-compat.js";
import { SchemaNodeValidator } from "../src/schema-node-validator.js";
import {
  readStandIn,
  withoutStandInFindings,
  type StandIn,
  type StandIns,
} from "../src/stand-in-findings.js";

const Ajv = (AjvModule as any).default ?? AjvModule;

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
      identity: { tag: "cel", text: "variables.t", repeatable: true },
    });
    expect(readStandIn(makeTaggedSentinel("interpolate", "${{ uuidv4() }}s"))).toEqual({
      kind: "stand-in",
      class: "produced",
      produced: { type: "string" },
      identity: { tag: "interpolate", text: "${{ uuidv4() }}s", repeatable: false },
    });
    expect(readStandIn(makeTaggedSentinel("literal", "5s"))).toEqual({ kind: "value", value: "5s" });
  });
});

describe("withoutStandInFindings", () => {
  const produced: StandIns = new Map([["/wait", { class: "produced" }]]);

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
    expect(findings(schema, { cfg: { a: "" } }, new Map([["/cfg/a", { class: "produced" }]]))).toEqual([
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
    expect(findings(schema, { cfg: { a: "" } }, new Map([["/cfg/a", { class: "produced" }]]))).toEqual([
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
    expect(findings(schema, { cfg: { a: "" } }, new Map([["/cfg/a", { class: "produced" }]]))).toEqual([
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
    expect(findings(schema, data, new Map([["/child/child/wait", { class: "produced" }]]))).toEqual([
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
      ["/tags/0", { class: "produced" }],
      ["/tags/1", { class: "computed" }],
    ]);
    expect(findings(tags, { tags: ["", ""] }, standIns)).toEqual([]);
  });

  it("names the written duplicates a pair of stand-ins precedes", () => {
    const standIns: StandIns = new Map([
      ["/tags/2", { class: "produced" }],
      ["/tags/3", { class: "produced" }],
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
      ["/tags/0/id", { class: "computed" }],
      ["/tags/1/id", { class: "computed" }],
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
    const standIns: StandIns = new Map([["/mode/name", { class: "produced" }]]);
    expect(findings(schema, { mode: { name: "", level: 2 } }, standIns)).toEqual([]);
    expect(findings(schema, { mode: { name: "", level: 3 } }, standIns)).toEqual(["/mode enum"]);
  });
});

describe("withoutStandInFindings — the same expression twice in a uniqueItems list", () => {
  const tags = { type: "object", properties: { tags: { type: "array", uniqueItems: true } } };
  const written = (tag: string, text: string) => readStandIn(makeTaggedSentinel(tag, text)) as StandIn;
  /** What the judge keeps of a two-item list whose items stand for these. */
  const pair = (first: StandIn, second: StandIn, item: (standIn: string) => unknown = (s) => s) => {
    const nested = typeof item("") === "object";
    const standIns: StandIns = new Map([
      [nested ? "/tags/0/id" : "/tags/0", first],
      [nested ? "/tags/1/id" : "/tags/1", second],
    ]);
    const data = { tags: [item(""), item("")] };
    const validate = createAjv().compile(tags);
    expect(validate(data)).toBe(false);
    return withoutStandInFindings(validate.errors, {
      value: data,
      schema: tags,
      standIns,
      validate: () => undefined,
    }).map((e) => [e.instancePath, e.params, e.message]);
  };
  const DUPLICATE = [
    ["/tags", { i: 1, j: 0 }, "must NOT have duplicate items (items ## 0 and 1 are identical)"],
  ];

  it("keeps an identical !cel pair, naming it", () => {
    expect(pair(written("cel", "variables.word"), written("cel", "variables.word"))).toEqual(DUPLICATE);
  });

  it("keeps an identical !interpolate pair", () => {
    const text = "a-${{ variables.word }}";
    expect(pair(written("interpolate", text), written("interpolate", text))).toEqual(DUPLICATE);
  });

  it("never compares two different texts", () => {
    expect(pair(written("cel", "variables.word"), written("cel", "variables.other"))).toEqual([]);
  });

  it("never compares one text under two tags", () => {
    expect(pair(written("cel", "variables.word"), written("interpolate", "variables.word"))).toEqual([]);
  });

  it("never compares a text that differs per evaluation", () => {
    expect(pair(written("cel", "uuidv4()"), written("cel", "uuidv4()"))).toEqual([]);
  });

  it("never compares a text that may call a module's function", () => {
    expect(pair(written("cel", "Billing.tag()"), written("cel", "Billing.tag()"))).toEqual([]);
  });

  it("keeps two objects with equal literals and identical stand-ins", () => {
    const item = (id: string) => ({ id, kind: "a" });
    expect(pair(written("cel", "variables.word"), written("cel", "variables.word"), item)).toEqual(
      DUPLICATE,
    );
  });
});

describe("withoutStandInFindings — a branch judged alone, on a validator that fills defaults", () => {
  /** The kernel's arrangement: a defaults-filling whole-schema pass, then one
   *  defaults-free locating instance for the whole schema and each branch. */
  function judged(schema: Record<string, any>, data: unknown, standIns: StandIns) {
    const filling = new Ajv({ strict: false, allErrors: true, useDefaults: true });
    const seam = new SchemaNodeValidator(createAjv({ verbose: true }), {
      fillDefaults: (whole, value) => void filling.compile(whole)(value),
    }).findingsFor(schema);
    const all = seam(schema, data);
    const filled = structuredClone(data);
    const kept = withoutStandInFindings(all, { value: data, schema, standIns, validate: seam });
    expect(data).toEqual(filled);
    return kept.map((e) => `${e.instancePath} ${e.keyword}`);
  }
  const closed = (properties: Record<string, any>, required: string[]) => ({
    type: "object",
    required,
    additionalProperties: false,
    properties,
  });

  it("leaves a discriminator each branch defaults unwritten", () => {
    const schema = {
      type: "object",
      properties: {
        retry: {
          oneOf: [
            closed({ mode: { enum: ["fixed"], default: "fixed" }, after: SECONDS }, ["after"]),
            closed({ mode: { enum: ["backoff"], default: "backoff" }, base: SECONDS }, ["base"]),
          ],
        },
      },
    };
    const data = { retry: { base: "" } };
    expect(judged(schema, data, new Map([["/retry/base", { class: "produced" }]]))).toEqual([]);
    expect(data).toEqual({ retry: { base: "" } });
  });

  it("leaves a member only an earlier branch defaults unwritten", () => {
    const schema = {
      type: "object",
      properties: {
        cfg: {
          anyOf: [
            closed({ kind: { const: "a" }, extra: { type: "string", default: "d" }, t: SECONDS }, ["kind"]),
            closed({ kind: { const: "b" }, t: SECONDS }, ["kind"]),
          ],
        },
      },
    };
    const data = { cfg: { kind: "b", t: "" } };
    expect(judged(schema, data, new Map([["/cfg/t", { class: "produced" }]]))).toEqual([]);
    expect(data).toEqual({ cfg: { kind: "b", t: "" } });
  });

  it("keeps a union whose only fitting branch requires a member it merely defaults", () => {
    const schema = {
      type: "object",
      properties: {
        retry: {
          anyOf: [
            closed({ mode: { type: "string", default: "backoff" }, base: SECONDS }, ["mode", "base"]),
            { type: "integer" },
          ],
        },
      },
    };
    const standIns: StandIns = new Map([["/retry/base", { class: "produced" }]]);
    expect(judged(schema, { retry: { base: "" } }, standIns)).toEqual([
      "/retry required",
      "/retry type",
      "/retry anyOf",
    ]);
  });
});

describe("SchemaNodeValidator", () => {
  it("answers 'cannot' for a node in no document it holds, and the judge keeps that union", () => {
    const schema = {
      type: "object",
      properties: { wait: { anyOf: [SECONDS, { type: "integer" }] } },
    };
    const validate = createAjv({ verbose: true }).compile(schema);
    expect(validate({ wait: "" })).toBe(false);
    const seam = new SchemaNodeValidator(createAjv({ verbose: true })).findingsFor({});
    expect(seam(schema.properties.wait.anyOf[0]!, "")).toBeUndefined();
    const kept = withoutStandInFindings(validate.errors, {
      value: { wait: "" },
      schema,
      standIns: new Map([["/wait", { class: "produced" }]]),
      validate: seam,
    });
    expect(kept.map((e) => `${e.instancePath} ${e.keyword}`)).toEqual(["/wait type", "/wait anyOf"]);
  });

  it("throws, naming the node, when a held node does not compile where it stands", () => {
    const ajv = createAjv({ verbose: true });
    const document = { anyOf: [{ $ref: "telo://m/Missing" }, { type: "integer" }] };
    ajv.addSchema(document, "telo://m/Doc", undefined, false);
    const seam = new SchemaNodeValidator(ajv).findingsFor({});
    let thrown: unknown;
    try {
      seam(document.anyOf[0]!, "");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toMatch(
      /^Schema node '#\/anyOf\/0' of document 'telo:\/\/m\/Doc'.*telo:\/\/m\/Missing/,
    );
    expect((thrown as Error).cause).toBeInstanceOf(Error);
  });
});
