import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { checkSchemaCompatibility } from "../src/schema-compat.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * What an expression's tree says about its value is judged against the slot it
 * fills: a list's elements against `items`, a map literal's keys against an
 * object, a module call's declared result, a concatenation's elements, either
 * branch of a conditional.
 */

const LIBRARY = `kind: Telo.Library
metadata: { name: Chat, version: 0.1.0 }
---
kind: Telo.JsonSchema
metadata: { name: Message }
schema:
  type: object
  required: [role, content]
  properties:
    role: { type: string, enum: [user, assistant, tool] }
    content: { type: string }
    toolCallId: { type: string }
  anyOf:
    - properties: { role: { enum: [user, assistant] }, toolCallId: false }
    - required: [role, toolCallId]
      properties: { role: { const: tool } }
---
kind: Telo.Function
metadata: { name: historyMessages }
params:
  - name: count
    schema: { type: integer }
returns:
  schema: { type: array, items: !ref Message }
body: !cel "[]"
---
kind: Telo.Definition
metadata: { name: Send }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      messages: { type: array, items: !ref Message }
      tags: { type: array, items: { type: string } }
      streams:
        type: array
        items: { x-telo-type: { name: Telo.Stream, of: { type: string } } }
      target:
        anyOf:
          - { type: object, required: [url], properties: { url: { type: string } } }
          - { type: object, required: [path], properties: { path: { type: string } } }
---
kind: Telo.Definition
metadata: { name: Source }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      output: { x-telo-type: { name: Telo.Stream, of: Telo.Bytes } }
---
kind: Telo.Definition
metadata: { name: Pair }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [a, b, c]
    properties:
      a: { type: integer }
      b: { type: string, default: x }
      c: { type: integer, default: 2 }
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

const source = (files: Record<string, string>): ManifestSource => ({
  supports: () => true,
  async read(url: string) {
    const text = files[url];
    if (text === undefined) throw new Error(`File not found: ${url}`);
    return { text, source: url };
  },
  resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
});

/** The errors a step passing `inputs` to `Send` reports, as code and path. */
async function errors(inputs: string, kind = "Send"): Promise<Array<[string, unknown, string]>> {
  const flow = `---
kind: Self.Flow
metadata: { name: flow }
steps:
  - name: a
    invoke: { kind: Self.Source }
  - name: send
    invoke: { kind: Self.${kind} }
    inputs:${inputs.startsWith("!") ? ` ${inputs}` : `\n${inputs}`}
`;
  const files = { "/lib/telo.yaml": LIBRARY + flow };
  const graph = await new Loader([source(files)]).loadGraph("/lib/telo.yaml", { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === 1)
    .map((d) => [d.code, d.data?.path, d.message]);
}

describe("a computed value judged by what its tree says", () => {
  it("refuses a literal element a concatenation adds beside a module call's result", async () => {
    const found = await errors(
      `      messages: !cel "[{'role': 'tool', 'content': 'x'}] + Self.historyMessages(2)"`,
    );
    expect(found.map(([code, path]) => [code, path])).toEqual([
      ["CEL_TYPE_ERROR", "steps[1].inputs.messages"],
    ]);
    expect(found[0]![2]).toContain("toolCallId");
  });

  it("reads a module call's declared result", async () => {
    expect(await errors(`      tags: !cel "Self.historyMessages(1)"`)).toEqual([
      ["CEL_TYPE_ERROR", "steps[1].inputs.tags", expect.stringContaining("tags")],
    ]);
  });

  it("judges a list literal's elements, and a CEL list type's element type", async () => {
    expect((await errors(`      tags: !cel "['a', 1]"`)).map(([code]) => code)).toEqual(["CEL_TYPE_ERROR"]);
    expect((await errors(`      tags: !cel "[1, 2]"`)).map(([code]) => code)).toEqual(["CEL_TYPE_ERROR"]);
  });

  it("holds a closed map literal to an object's required members", async () => {
    expect(
      (await errors(`      messages: !cel "[{'role': 'user'}]"`)).map(([code, path]) => [code, path]),
    ).toEqual([["CEL_TYPE_ERROR", "steps[1].inputs.messages"]]);
  });

  it("refuses a conditional only when neither branch fits", async () => {
    expect(await errors(`      tags: !cel "true ? ['a'] : [1]"`)).toEqual([]);
    expect((await errors(`      tags: !cel "true ? [2] : [1]"`)).map(([code]) => code)).toEqual(["CEL_TYPE_ERROR"]);
  });

  it("says nothing where the tree does not know the value", async () => {
    expect(await errors(`      tags: !cel "[dyn(1)].map(x, x)"`)).toEqual([]);
    expect(await errors(`      messages: !cel "[{'role': 'user', 'content': dyn(2)}]"`)).toEqual([]);
  });

  it("accepts a map literal one branch of a union target agrees with", async () => {
    expect(await errors(`      target: !cel "{'path': 'a'}"`)).toEqual([]);
  });

  it("reads a required member whose own schema declares a default as filled", async () => {
    expect(await errors(`!cel "{'a': 1}"`, "Pair")).toEqual([]);
    expect((await errors(`!cel "{'b': 'y'}"`, "Pair")).map(([code]) => code)).toEqual(["CEL_TYPE_ERROR"]);
  });

  it("reads a default as filling a required member only where the target's validator fills it", () => {
    const ancestor = { type: "object", required: ["runId"], properties: { runId: { type: "string", default: "x" } } };
    const child = { type: "object", properties: { status: { type: "string" } } };
    expect(checkSchemaCompatibility(child, ancestor).compatible).toBe(false);
    expect(checkSchemaCompatibility(child, ancestor, undefined, undefined, { targetFillsDefaults: true }).compatible).toBe(true);
  });

  it("reports a conflict lying wholly beneath a type argument as an argument mismatch", async () => {
    expect((await errors(`      streams: !cel "[steps.a.result.output]"`)).map(([code, path]) => [code, path])).toEqual([
      ["CEL_TYPE_ARGUMENT_MISMATCH", "steps[1].inputs.streams"],
    ]);
  });
});
