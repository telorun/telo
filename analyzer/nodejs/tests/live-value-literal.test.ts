import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import AjvModule from "ajv";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { registerTeloKeywords } from "../src/value-type-keyword.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

const Ajv = (AjvModule as any).default ?? AjvModule;

const LITERAL_REFUSED = "a value written in the manifest can never be one";

/** A kind taking a stream as an argument AND in its own configuration, beside a
 *  union slot a literal legitimately satisfies. */
const sinkDef = {
  kind: "Telo.Definition",
  metadata: { name: "Sink", module: "srv" },
  capability: "Telo.Invocable",
  inputType: {
    kind: "Telo.JsonSchema",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["input"],
      properties: { input: { "x-telo-type": "Telo.Stream" } },
    },
  },
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      source: { "x-telo-type": "Telo.Stream", "x-telo-eval": "runtime" },
      either: {
        anyOf: [{ type: "string" }, { "x-telo-type": "Telo.Stream" }],
        "x-telo-eval": "runtime",
      },
    },
  },
};

/** A kind whose reference slot names its call's argument map, as a tap does. */
const callerDef = {
  kind: "Telo.Definition",
  metadata: { name: "Caller", module: "srv" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      handler: { "x-telo-ref": { kind: "Telo.Executable", use: "call", inputs: "/inputs" } },
      inputs: {
        type: "object",
        additionalProperties: true,
        "x-telo-context": { type: "object", properties: { item: {} } },
      },
    },
  },
};

function analyze(resources: Record<string, unknown>[]) {
  const manifests = [
    { kind: "Telo.Application", metadata: { name: "app", source: "telo.yaml" } },
    sinkDef,
    callerDef,
    ...resources.map((r) => ({ ...r, metadata: { ...(r.metadata as object), source: "telo.yaml" } })),
  ] as unknown as ResourceManifest[];
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions(manifests))
    .filter((d) => d.code === "CONTRACT_INPUTS_MISMATCH" || d.code === "SCHEMA_VIOLATION");
}

const sink = { kind: "srv.Sink", metadata: { name: "sink" } };
const caller = (input: unknown) => ({
  kind: "srv.Caller",
  metadata: { name: "caller" },
  handler: makeTaggedSentinel("ref", "sink"),
  inputs: { input },
});

describe("a literal at a live value-type slot", () => {
  it("is refused at a call site, through the contract check", () => {
    const diags = analyze([sink, caller("not a stream")]);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe("CONTRACT_INPUTS_MISMATCH");
    expect(diags[0].message).toContain(`must be a live Telo.Stream — ${LITERAL_REFUSED}`);
  });

  it("is refused whatever shape the literal takes", () => {
    for (const literal of [42, true, null, ["a"], { chunk: "a" }]) {
      const diags = analyze([sink, caller(literal)]);
      expect(diags.map((d) => d.code), JSON.stringify(literal)).toEqual(["CONTRACT_INPUTS_MISMATCH"]);
    }
  });

  it("is refused in a resource's own configuration", () => {
    const diags = analyze([{ ...sink, source: "text" }]);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe("SCHEMA_VIOLATION");
    expect(diags[0].message).toContain(LITERAL_REFUSED);
  });

  it("leaves an expression alone, at a call site and in configuration", () => {
    const expression = makeTaggedSentinel("cel", "item");
    expect(analyze([sink, caller(expression)])).toEqual([]);
    expect(analyze([{ ...sink, source: makeTaggedSentinel("cel", "variables.x") }])).toEqual([]);
  });

  it("leaves a literal a union's other branch accepts alone", () => {
    expect(analyze([{ ...sink, either: "text" }])).toEqual([]);
    expect(analyze([{ ...sink, either: 42 }]).map((d) => d.code)).toEqual(["SCHEMA_VIOLATION"]);
  });
});

describe("the dispatch posture", () => {
  const slot = { "x-telo-type": "Telo.Stream" };

  it("exempts a live value where the option is off, as every kernel instance registers", () => {
    const ajv = new Ajv({ strict: false });
    registerTeloKeywords(ajv);
    expect(ajv.compile(slot)("not a stream")).toBe(true);
  });

  it("asserts it where static analysis turns the option on", () => {
    const ajv = new Ajv({ strict: false });
    registerTeloKeywords(ajv, { assertLive: true });
    expect(ajv.compile(slot)("not a stream")).toBe(false);
  });
});
