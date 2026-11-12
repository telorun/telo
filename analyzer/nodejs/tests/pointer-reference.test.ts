import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { celEvalSites } from "../src/eval-paths.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { resolveSchemaReference } from "../src/schema-reference.js";
import type { ManifestSource } from "../src/types.js";

/**
 * A JSON Pointer `$ref` — into a local `$defs` member or into a named shape — is
 * read exactly as the member written inline: the same reference slot with its
 * `inputs` and `completedWhen` siblings, the same eval sites, regions and CEL
 * context, the same text judgement, and a schema that compiles.
 */

const BUTTON = `{ type: object, additionalProperties: false, required: [action, inputs], properties: {
      action: { x-telo-ref: { kind: Self.Act, use: call, inputs: /inputs, completedWhen: /prompt } },
      inputs: { type: object },
      prompt: { type: boolean, default: false },
      when: { type: boolean, x-telo-eval: compile },
      value: { x-telo-eval: runtime, x-telo-context: { type: object, properties: { row: { type: object, additionalProperties: false, properties: { id: { type: string } } } } } },
      label: { $ref: "telo://manifest#/$defs/Text" } } }`;

const HOLDER = `{ type: object, properties: { button: ${BUTTON}, caption: { $ref: "telo://Self/Caption" } } }`;

type Form = "inline" | "local" | "shape";

const MEMBERS: Record<Form, { button: string; caption: string; defs: string }> = {
  inline: { button: BUTTON, caption: `{ $ref: "telo://Self/Caption" }`, defs: "" },
  local: {
    button: `{ $ref: "#/$defs/Holder/properties/button" }`,
    caption: `{ $ref: "#/$defs/Holder/properties/caption" }`,
    defs: `\n  $defs: { Holder: ${HOLDER} }`,
  },
  shape: {
    button: `{ $ref: "telo://Self/Holder#/properties/button" }`,
    caption: `{ $ref: "telo://Self/Holder#/properties/caption" }`,
    defs: "",
  },
};

const manifest = (form: Form) => `kind: Telo.Application
metadata: { name: App }
---
kind: Telo.Definition
metadata: { name: Act }
capability: Telo.Invocable
controllers: [pkg:telo/local/js?path=./x.mjs#X]
inputType:
  type: object
  additionalProperties: false
  required: [id, note]
  properties: { id: { type: string }, note: { type: string } }
schema: { type: object, additionalProperties: false, properties: {} }
---
kind: Telo.JsonSchema
metadata: { name: Caption }
schema: { $ref: "telo://manifest#/$defs/Text" }
---
kind: Telo.JsonSchema
metadata: { name: Holder }
schema: ${HOLDER}
---
kind: Telo.Definition
metadata: { name: Panel }
capability: Telo.Service
controllers: [pkg:telo/local/js?path=./x.mjs#X]
schema:
  type: object
  additionalProperties: false
  properties:
    button: ${MEMBERS[form].button}
    caption: ${MEMBERS[form].caption}${MEMBERS[form].defs}
---
kind: App.Act
metadata: { name: act }
---
kind: App.Panel
metadata: { name: unprompted }
button:
  action: !ref act
  inputs: { id: p7 }
  when: !cel "'yes'"
  value: !cel "row.idd"
  label: "Hello {$who"
caption: "Bye {"
---
kind: App.Panel
metadata: { name: prompted }
button: { action: !ref act, inputs: { id: p7 }, prompt: true }
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

async function findings(form: Form) {
  const graph = await new Loader([source({ "/app/telo.yaml": manifest(form) })]).loadGraph("/app/telo.yaml", {
    desugarImports: true,
  });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .map((d) => [d.severity, d.code, d.data?.resource?.name, d.data?.path, d.message] as const);
}

describe("a JSON Pointer $ref", () => {
  it("gives the diagnostics the inline member gives, through a local $defs pointer and a pointer into a named shape", async () => {
    const inline = await findings("inline");
    expect(inline.filter(([severity]) => severity === 1).map(([, code, name, path]) => [code, name, path])).toEqual(
      expect.arrayContaining([
        ["CONTRACT_INPUTS_MISMATCH", "unprompted", "button.inputs"],
        ["CEL_UNKNOWN_FIELD", "unprompted", "button.value"],
      ]),
    );
    expect(inline.some(([, code]) => code === "SCHEMA_COMPILE_ERROR")).toBe(false);
    expect(inline.filter(([, code, name]) => code === "CONTRACT_INPUTS_MISMATCH" && name === "prompted")).toEqual([]);
    expect(inline.filter(([, code]) => code.startsWith("MESSAGE_")).map(([, , , path]) => path).sort()).toEqual([
      "button.label",
      "caption",
    ]);
    expect(inline.some(([, code, , path]) => code === "CEL_TYPE_ERROR" && path === "button.when")).toBe(true);
    expect(await findings("local")).toEqual(inline);
    expect(await findings("shape")).toEqual(inline);
  });

  it("is refused at the shape declaring the annotation when its completedWhen sibling, reached by a pointer, is not boolean", async () => {
    const files = {
      "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
---
kind: Telo.Definition
metadata: { name: Act }
capability: Telo.Invocable
controllers: [pkg:telo/local/js?path=./x.mjs#X]
schema: { type: object, additionalProperties: false, properties: {} }
---
kind: Telo.JsonSchema
metadata: { name: Flags }
schema: { type: object, properties: { prompt: { type: boolean }, label: { type: string } } }
---
kind: Telo.JsonSchema
metadata: { name: Bound }
schema:
  type: object
  properties:
    action: { x-telo-ref: { kind: Self.Act, use: call, inputs: /inputs, completedWhen: /prompt } }
    inputs: { type: object }
    prompt: { $ref: "telo://Self/Flags#/properties/PROMPT" }
`,
    };
    const run = async (member: string) => {
      const graph = await new Loader([
        source({ "/app/telo.yaml": files["/app/telo.yaml"].replace("PROMPT", member) }),
      ]).loadGraph("/app/telo.yaml", { desugarImports: true });
      return new StaticAnalyzer()
        .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
        .filter((d) => d.code === "X_TELO_REF_INVALID_COMPLETED_WHEN")
        .map((d) => [d.data?.resource?.name, d.message]);
    };
    expect(await run("prompt")).toEqual([]);
    expect(await run("label")).toEqual([
      ["Bound", "Telo.JsonSchema 'Bound': x-telo-ref at 'schema.properties.action' declares 'completedWhen: /prompt', but '/prompt' is not declared 'type: boolean'."],
    ]);
  });

  it("gives the eval, accessor and region sites of the member written inline", () => {
    const member = {
      type: "object",
      properties: {
        when: { type: "boolean", "x-telo-eval": "compile" },
        at: { "x-telo-eval": "accessor", "x-telo-context": { type: "object", properties: { row: {} } } },
        value: { "x-telo-eval": "runtime" },
      },
    };
    const holder = { type: "object", properties: { member } };
    const lookup = (id: string) => (id === "telo:T/Holder" ? holder : undefined);
    const inline = celEvalSites({ type: "object", properties: { member } }, lookup);
    const local = celEvalSites(
      { type: "object", properties: { member: { $ref: "#/$defs/Holder/properties/member" } }, $defs: { Holder: holder } },
      lookup,
    );
    const shape = celEvalSites({ type: "object", properties: { member: { $ref: "telo:T/Holder#/properties/member" } } }, lookup);
    expect(inline.compile).toEqual(["member.when"]);
    expect(local).toEqual(inline);
    expect(shape).toEqual(inline);
  });

  it("resolves a local pointer beneath a crossed shape against that shape's document", () => {
    const shape = { $defs: { Row: { type: "string" } }, properties: { a: { $ref: "#/$defs/Row" } } };
    const reached = resolveSchemaReference("telo:T/S#/properties/a", {}, (id) => (id === "telo:T/S" ? shape : undefined));
    expect(reached).toEqual({ node: shape.properties.a, document: shape, shape: "telo:T/S" });
    expect(resolveSchemaReference(reached!.node.$ref, reached!.document, undefined)?.node).toBe(shape.$defs.Row);
  });
});
