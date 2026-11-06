import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * A contract comparison reads a named shape in the module that WROTE the
 * reference: an application importing only `Lib`, whose kinds name shapes of
 * `Lib`'s own import `Shapes`, has every comparison against those kinds judged
 * through the shapes — at a contract's root and nested inside it, on a kind
 * declared with and without `extends`.
 */

const SHAPES = `kind: Telo.Library
metadata: { name: Shapes }
exports: { resources: [Token, Basic, Pair] }
---
kind: Telo.JsonSchema
metadata: { name: Token }
schema: { type: object, required: [type, token], properties: { type: { const: token }, token: { type: string } } }
---
kind: Telo.JsonSchema
metadata: { name: Basic }
schema: { type: object, required: [type, username], properties: { type: { const: basic }, username: { type: string } } }
---
kind: Telo.JsonSchema
metadata: { name: Pair }
schema: { type: object, required: [a], properties: { a: { type: integer } } }
`;

const CONTROLLER = "controllers: [pkg:telo/local/js?path=./x.mjs#X]";

const LIB = `kind: Telo.Library
metadata: { name: Lib }
imports: { Shapes: ../shapes/telo.yaml }
variables:
  pair: { $ref: "telo://Shapes/Pair" }
exports: { kinds: [SourceBase, FromBasic, Verifier, Server, OpBase, Op, Caller, Abs, Fn, Holder, Box] }
---
kind: Telo.Abstract
metadata: { name: SourceBase }
capability: Telo.Invocable
---
kind: Telo.Definition
metadata: { name: FromBasic }
capability: Telo.Invocable
extends: Self.SourceBase
${CONTROLLER}
schema: { type: object, additionalProperties: false, properties: {} }
outputType: !ref Shapes.Basic
---
kind: Telo.Definition
metadata: { name: Verifier }
capability: Telo.Invocable
${CONTROLLER}
schema: { type: object, additionalProperties: false, properties: {} }
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, properties: { presentation: !ref Shapes.Token } }
---
kind: Telo.Definition
metadata: { name: Server }
capability: Telo.Service
${CONTROLLER}
schema:
  type: object
  additionalProperties: false
  properties:
    entries:
      type: array
      items:
        type: object
        additionalProperties: false
        properties:
          verifier: { x-telo-ref: { kind: Self.Verifier, use: trigger.inbound } }
          from: { x-telo-ref: { kind: Self.SourceBase, use: trigger.inbound, outputTo: { slot: /verifier, member: presentation } } }
---
kind: Telo.Abstract
metadata: { name: OpBase }
capability: Telo.Invocable
---
kind: Telo.Definition
metadata: { name: Op }
capability: Telo.Invocable
extends: Self.OpBase
${CONTROLLER}
schema: { type: object, additionalProperties: false, properties: {} }
inputType: !ref Shapes.Pair
---
kind: Telo.Definition
metadata: { name: Caller }
capability: Telo.Invocable
${CONTROLLER}
schema:
  type: object
  additionalProperties: false
  properties:
    handler: { x-telo-ref: { kind: Self.Op, use: call, inputs: /inputs } }
    inputs: { type: object }
---
kind: Telo.Abstract
metadata: { name: Abs }
capability: Telo.Invocable
outputType:
  kind: Telo.JsonSchema
  schema: { type: object, required: [out], properties: { out: !ref Shapes.Pair } }
---
kind: Telo.Abstract
metadata: { name: Fn }
capability: Telo.Callable
params:
  - name: x
    schema: !ref Shapes.Pair
returns:
  schema: { type: string }
---
kind: Telo.Definition
metadata: { name: Holder }
capability: Telo.Invocable
${CONTROLLER}
schema:
  type: object
  additionalProperties: false
  properties:
    fn: { x-telo-ref: { kind: Self.Fn, use: dependency } }
---
kind: Telo.Definition
metadata: { name: Box }
capability: Telo.Invocable
${CONTROLLER}
schema:
  type: object
  additionalProperties: false
  properties:
    value: { $ref: "telo://Shapes/Pair" }
`;

const source = (files: Record<string, string>): ManifestSource => ({
  supports: () => true,
  async read(url: string) {
    const text = files[url];
    if (text === undefined) throw new Error(`File not found: ${url}`);
    return { text, source: url };
  },
  resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
});

async function errors(body: string, imports = "imports: { Lib: ../lib/telo.yaml }") {
  const files = {
    "/shapes/telo.yaml": SHAPES,
    "/lib/telo.yaml": LIB,
    "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
${imports}
---
${body}`,
  };
  const graph = await new Loader([source(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === 1)
    .map((d) => [d.code, d.data?.path] as const);
}

describe("a contract comparison across modules", () => {
  it("judges a source's output against the member it fills", async () => {
    expect(
      await errors(`kind: Lib.Server
metadata: { name: server }
entries:
  - verifier: { kind: Lib.Verifier }
    from: { kind: Lib.FromBasic }
`),
    ).toEqual([["CONTRACT_INPUTS_MISMATCH", "entries[0].from"]]);
  });

  it("judges a step's arguments", async () => {
    expect(
      await errors(`kind: Telo.Sequence
metadata: { name: run }
steps:
  - name: op
    invoke: { kind: Lib.Op }
    inputs: { a: "x" }
`),
    ).toEqual([["CONTRACT_INPUTS_MISMATCH", "steps[0].inputs.a"]]);
  });

  it("judges a reference slot's arguments", async () => {
    expect(
      await errors(`kind: Lib.Caller
metadata: { name: caller }
handler: { kind: Lib.Op }
inputs: { a: "x" }
`),
    ).toEqual([["CONTRACT_INPUTS_MISMATCH", "inputs.a"]]);
  });

  it("judges a contract replacing an abstract ancestor's", async () => {
    expect(
      await errors(`kind: Telo.Definition
metadata: { name: Impl }
capability: Telo.Invocable
extends: Lib.Abs
${CONTROLLER}
schema: { type: object, properties: {} }
outputType:
  kind: Telo.JsonSchema
  schema: { type: object, required: [out], properties: { out: { type: object, required: [a], properties: { a: { type: string } } } } }
`),
    ).toEqual([["CONTRACT_NOT_SUBSTITUTABLE", "outputType"]]);
  });

  it("judges a function standing in for a callable abstract", async () => {
    expect(
      await errors(`kind: Telo.Function
metadata: { name: format }
params:
  - name: x
    schema: { type: object, required: [a], properties: { a: { type: string } } }
returns:
  schema: { type: string }
body: !cel "x.a"
---
kind: Lib.Holder
metadata: { name: holder }
fn: !ref format
`),
    ).toEqual([["REFERENCE_KIND_MISMATCH", "fn"]]);
  });

  it("judges a value a template body forwards", async () => {
    expect(
      await errors(`kind: Telo.Definition
metadata: { name: Wrap }
capability: Telo.Invocable
schema: { type: object, properties: { value: { type: string } } }
resources:
  - kind: Lib.Box
    metadata: { name: box }
    value: !cel "self.value"
invoke: !ref box
`),
    ).toEqual([["TEMPLATE_FORWARD_INCOMPATIBLE", "schema.properties.value"]]);
  });

  it("judges what an import supplies", async () => {
    expect(
      await errors(
        "",
        `imports:
  Lib:
    source: ../lib/telo.yaml
    variables: { pair: { a: "x" } }`,
      ),
    ).toEqual([["SCHEMA_VIOLATION", "variables.pair.a"]]);
  });
});
