import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * `x-telo-ref` `completedWhen: <pointer>` — where the boolean sibling holds
 * `true`, the target obtains every input the argument map leaves unbound, so a
 * required input missing from the map is not refused at the call site.
 */

const KINDS = (slot = "{ kind: Self.Act, use: call, inputs: /inputs, completedWhen: /prompt }", prompt = "{ type: boolean }") => `kind: Telo.Definition
metadata: { name: Act }
capability: Telo.Invocable
controllers: [pkg:telo/local/js?path=./x.mjs#X]
inputType:
  type: object
  additionalProperties: false
  required: [id, note]
  properties:
    id: { type: string }
    note: { type: string }
schema: { type: object, additionalProperties: false, properties: {} }
---
kind: Telo.Definition
metadata: { name: Button }
capability: Telo.Service
controllers: [pkg:telo/local/js?path=./x.mjs#X]
schema:
  type: object
  additionalProperties: false
  required: [action, inputs]
  properties:
    action:
      x-telo-ref: ${slot}
    inputs: { type: object }
    prompt: ${prompt}
---
kind: App.Act
metadata: { name: act }
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

async function findings(body: string, slot?: string, prompt?: string) {
  const files = {
    "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
---
${KINDS(slot, prompt)}${body}`,
  };
  const graph = await new Loader([source(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === 1)
    .map((d) => [d.code, d.data?.path, d.message] as const);
}

const button = (fields: string) => `---
kind: App.Button
metadata: { name: approve }
action: !ref act
${fields}
`;

describe("x-telo-ref completedWhen", () => {
  it("leaves a required input unbound where the sibling holds true, still judging keys and types", async () => {
    expect(await findings(button("inputs: { id: p7 }\nprompt: true"))).toEqual([]);
    const found = await findings(button("inputs: { id: 7, hsah: x }\nprompt: true"));
    expect(found.map(([code, path]) => [code, path])).toEqual([
      ["CONTRACT_INPUTS_MISMATCH", "inputs"],
      ["CONTRACT_INPUTS_MISMATCH", "inputs.id"],
    ]);
    expect(found[0]![2]).toContain("hsah");
  });

  it("refuses a required input missing from the map where the sibling is false or absent", async () => {
    for (const fields of ["inputs: { id: p7 }\nprompt: false", "inputs: { id: p7 }"]) {
      const found = await findings(button(fields));
      expect(found.map(([code, path]) => [code, path])).toEqual([["CONTRACT_INPUTS_MISMATCH", "inputs"]]);
      expect(found[0]![2]).toContain("note");
    }
  });

  it("refuses a completedWhen naming no boolean sibling, or on a slot pairing no inputs", async () => {
    const at = "schema.properties.action.x-telo-ref.completedWhen";
    const notBoolean = await findings("", undefined, "{ type: string }");
    expect(notBoolean.map(([code, path]) => [code, path])).toEqual([["X_TELO_REF_INVALID_COMPLETED_WHEN", at]]);
    expect(notBoolean[0]![2]).toContain("'/prompt' is not declared 'type: boolean'");
    const nothing = await findings("", "{ kind: Self.Act, use: call, inputs: /inputs, completedWhen: /promt }");
    expect(nothing.map(([code]) => code)).toEqual(["X_TELO_REF_INVALID_COMPLETED_WHEN"]);
    expect(nothing[0]![2]).toContain("declares nothing at '/promt'");
    const noInputs = await findings("", "{ kind: Self.Act, use: call, completedWhen: /prompt }");
    expect(noInputs.map(([code]) => code)).toEqual(["X_TELO_REF_INVALID_COMPLETED_WHEN"]);
    expect(noInputs[0]![2]).toContain("declares no 'inputs:' argument map");
    const malformed = await findings("", "{ kind: Self.Act, use: call, inputs: /inputs, completedWhen: prompt }");
    expect(malformed.map(([code]) => code)).toEqual(["X_TELO_REF_INVALID_COMPLETED_WHEN"]);
  });

  it("reads a slot a named shape declares, and refuses one misdirected there", async () => {
    const shape = (prompt: string) => `---
kind: Telo.JsonSchema
metadata: { name: Bound }
schema:
  type: object
  additionalProperties: false
  required: [action, inputs]
  properties:
    action: { x-telo-ref: { kind: Self.Act, use: call, inputs: /inputs, completedWhen: /prompt } }
    inputs: { type: object }
    prompt: ${prompt}
---
kind: Telo.Definition
metadata: { name: Bar }
capability: Telo.Service
controllers: [pkg:telo/local/js?path=./x.mjs#X]
schema:
  type: object
  additionalProperties: false
  properties:
    buttons: { type: array, items: { $ref: "telo://Self/Bound" } }
---
kind: App.Bar
metadata: { name: bar }
buttons:
  - { action: !ref act, inputs: { id: p7 }, prompt: true }
  - { action: !ref act, inputs: { id: p7 } }
`;
    const found = await findings(shape("{ type: boolean }"));
    expect(found.map(([code, path]) => [code, path])).toEqual([["CONTRACT_INPUTS_MISMATCH", "buttons[1].inputs"]]);
    const misdirected = await findings(shape("{ type: string }"));
    expect(misdirected.filter(([code]) => code === "X_TELO_REF_INVALID_COMPLETED_WHEN").map(([, path, message]) => [path, message])).toEqual([
      [
        "schema.properties.action.x-telo-ref.completedWhen",
        "Telo.JsonSchema 'Bound': x-telo-ref at 'schema.properties.action' declares 'completedWhen: /prompt', but '/prompt' is not declared 'type: boolean'.",
      ],
    ]);
  });
});
