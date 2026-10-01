import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { celPlaceholderForSchema } from "../src/schema-compat.js";
import type { ManifestSource } from "../src/types.js";

/**
 * A computed value stands in as something its slot accepts, and a slot whose
 * items or required members NAME a shape is described by that shape: a stand-in
 * built from the reference as written is `null`, which the shape then rejects —
 * a finding about a value no author wrote.
 */

function source(files: Record<string, string>): ManifestSource {
  return {
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
  };
}

const LIBRARY = `kind: Telo.Library
metadata: { name: Parts, version: 0.1.0 }
exports:
  kinds: [Send, Relay, Flow]
---
kind: Telo.JsonSchema
metadata: { name: Part }
schema:
  type: object
  additionalProperties: false
  required: [role, text]
  properties:
    role: { type: string, enum: [user, system] }
    text: { type: string }
---
kind: Telo.Definition
metadata: { name: Send }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
inputType:
  type: object
  additionalProperties: false
  required: [parts]
  properties:
    parts:
      type: array
      minItems: 1
      items: !ref Part
schema: { type: object }
---
kind: Telo.Definition
metadata: { name: Relay }
capability: Telo.Invocable
inputType:
  type: object
  properties:
    parts: { type: array }
schema: { type: object }
resources:
  - kind: Self.Send
    metadata: { name: send }
invoke: !ref send
inputs:
  parts: !cel "inputs.parts"
---
kind: Telo.Definition
metadata: { name: Flow }
capability: Telo.Runnable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    steps:
      type: array
      items: { $ref: "telo://manifest#/$defs/Step" }
`;

const APP = `kind: Telo.Application
metadata: { name: App, version: 1.0.0 }
imports:
  Parts: ../lib/telo.yaml
---
kind: Parts.Send
metadata: { name: send }
`;

/** A kind whose own configuration holds the list, declared where it is used. */
const HOLDER = `kind: Telo.Library
metadata: { name: Held, version: 0.1.0 }
variables:
  parts: { type: array }
---
kind: Telo.JsonSchema
metadata: { name: Part }
schema:
  type: object
  additionalProperties: false
  required: [role, text]
  properties:
    role: { type: string, enum: [user, system] }
    text: { type: string }
---
kind: Telo.Definition
metadata: { name: Holder }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  additionalProperties: false
  required: [parts]
  properties:
    parts:
      type: array
      minItems: 1
      items:
        $ref: "telo://Self/Part"
---
kind: Self.Holder
metadata: { name: holder }
parts: !cel "variables.parts"
`;

async function errorsOf(files: Record<string, string>, entry: string) {
  const graph = await new Loader([source(files)]).loadGraph(entry, { desugarImports: true });
  return new StaticAnalyzer().analyze(flattenForAnalyzer(graph)).filter((d) => d.severity === 1);
}

const analyze = (body: string) =>
  errorsOf({ "/lib/telo.yaml": LIBRARY, "/app/telo.yaml": APP + body }, "/app/telo.yaml");

const flow = (steps: string) => `---
kind: Parts.Flow
metadata: { name: flow }
steps:
  - name: made
    value:
      parts:
        - { role: user, text: hello }
${steps}`;

describe("a computed value at a slot that names a shape", () => {
  it("is accepted as a call argument and as a whole argument map", async () => {
    const diagnostics = await analyze(
      flow(`  - name: listComputed
    invoke: !ref send
    inputs:
      parts: !cel "steps.made.result.parts"
  - name: mapComputed
    invoke: !ref send
    inputs: !cel "steps.made.result"
`),
    );
    expect(diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });

  it("is accepted where a templated kind forwards it to its dispatch target", async () => {
    const diagnostics = await errorsOf({ "/lib/telo.yaml": LIBRARY }, "/lib/telo.yaml");
    expect(diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });

  it("is accepted as a config field", async () => {
    const diagnostics = await errorsOf({ "/held/telo.yaml": HOLDER }, "/held/telo.yaml");
    expect(diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });

  it("still refuses a literal item that violates the shape, at that item", async () => {
    const diagnostics = await analyze(
      flow(`  - name: literal
    invoke: !ref send
    inputs:
      parts:
        - { role: narrator, text: hello }
`),
    );
    expect(diagnostics.map((d) => [d.code, d.data?.path])).toEqual([
      ["CONTRACT_INPUTS_MISMATCH", "steps[1].inputs.parts[0].role"],
    ]);
  });
});

describe("the stand-in for a schema that names shapes", () => {
  const PART = {
    type: "object",
    additionalProperties: false,
    required: ["role", "text"],
    properties: { role: { type: "string", enum: ["user", "system"] }, text: { type: "string" } },
  };
  // Its `#/$defs/Head` is its own: the referring document declares another.
  const DOC = {
    type: "object",
    required: ["head"],
    properties: { head: { $ref: "#/$defs/Head" } },
    $defs: {
      Head: { type: "object", required: ["title"], properties: { title: { type: "string", minLength: 2 } } },
    },
  };
  const NODE = {
    type: "object",
    required: ["next"],
    properties: { next: { $ref: "telo:fx/Node" } },
  };
  const shapes: Record<string, Record<string, any>> = {
    "telo:fx/Part": PART,
    "telo:fx/Doc": DOC,
    "telo:fx/Node": NODE,
  };
  const external = (ref: string) => shapes[ref];

  function standIn(schema: Record<string, any>): { value: unknown; valid: boolean } {
    const ajv = new Ajv({ strict: false });
    for (const [id, shape] of Object.entries(shapes)) ajv.addSchema(shape, id);
    const value = celPlaceholderForSchema(schema, { root: schema, external });
    return { value, valid: ajv.validate(schema, value) as boolean };
  }

  it("fills a required member that names a shape", () => {
    expect(
      standIn({ type: "object", required: ["part"], properties: { part: { $ref: "telo:fx/Part" } } }),
    ).toEqual({ value: { part: { role: "user", text: "" } }, valid: true });
  });

  it("takes a union branch that names a shape", () => {
    expect(
      standIn({
        type: "object",
        required: ["part"],
        properties: { part: { oneOf: [{ $ref: "telo:fx/Part" }, { $ref: "#/$defs/Count" }] } },
        $defs: { Count: { type: "integer", minimum: 1 } },
      }),
    ).toEqual({ value: { part: { role: "user", text: "" } }, valid: true });
  });

  it("resolves a document-local reference inside a named shape against that shape", () => {
    expect(
      standIn({
        type: "array",
        minItems: 1,
        items: { $ref: "telo:fx/Doc" },
        $defs: { Head: { type: "integer" } },
      }),
    ).toEqual({ value: [{ head: { title: "xx" } }], valid: true });
  });

  it("folds an `allOf` branch that names a shape", () => {
    expect(standIn({ allOf: [{ $ref: "telo:fx/Doc" }] })).toEqual({
      value: { head: { title: "xx" } },
      valid: true,
    });
  });

  it("terminates on a shape that requires itself", () => {
    expect(standIn({ $ref: "telo:fx/Node" }).value).toEqual({ next: null });
  });
});

describe("a declared default as the stand-in for a computed value", () => {
  const TURN = {
    type: "object",
    required: ["turnId"],
    properties: { turnId: { type: "string" } },
  };
  const typed = (fallback: unknown) => ({
    type: "object",
    default: fallback,
    allOf: [{ $ref: "#/$defs/Turn" }],
    $defs: { Turn: TURN },
  });
  const standIn = (schema: Record<string, any>) => celPlaceholderForSchema(schema, { root: schema });

  it("is passed over when it lacks a member a folded reference requires", () => {
    const schema = typed({});
    const value = standIn(schema);
    expect(value).toEqual({ turnId: "" });
    expect(new Ajv({ strict: false }).validate(schema, value)).toBe(true);
  });

  it("is returned unchanged when it fits", () => {
    const fallback = { turnId: "t0" };
    expect(standIn(typed(fallback))).toBe(fallback);
    expect(standIn({ type: "string", pattern: "^[a-z]+$", default: "abc" })).toBe("abc");
  });

  it("is passed over when a member it holds breaks a conjoined enum", () => {
    expect(
      standIn({
        type: "object",
        default: { mode: "sideways" },
        allOf: [{ required: ["mode"], properties: { mode: { enum: ["up", "down"] } } }],
      }),
    ).toEqual({ mode: "up" });
  });

  it("yields the bound when it lies outside a folded one", () => {
    expect(standIn({ type: "integer", default: 0, allOf: [{ minimum: 10 }] })).toBe(10);
  });
});
