import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * A kind's contract naming a shape with `!ref` — resolved in the module that
 * declared the kind, whether that is the module under analysis or a library it
 * imports, and reported where it resolves to nothing.
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

async function check(files: Record<string, string>, entry: string) {
  const graph = await new Loader([source(files)]).loadGraph(entry, { desugarImports: true });
  return new StaticAnalyzer().analyze(flattenForAnalyzer(graph));
}

const handlerLibrary = `kind: Telo.Library
metadata: { name: Billing, version: 0.1.0 }
exports: { kinds: [Handler] }
---
kind: Telo.JsonSchema
metadata: { name: Money }
schema: { type: object, required: [amount], properties: { amount: { type: integer } } }
---
kind: Telo.Abstract
metadata: { name: Handler }
capability: Telo.Invocable
outputType: !ref Money
`;

const implementation = (prefix: string) => `---
kind: Telo.JsonSchema
metadata: { name: Other }
schema: { type: string }
---
kind: Telo.Definition
metadata: { name: Impl }
extends: ${prefix}.Handler
outputType: !ref Other
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
`;

describe("a kind's contract naming a shape with !ref", () => {
  it("is compared through the shape, in the declaring module and from an importer", async () => {
    const local = await check(
      { "/lib/telo.yaml": handlerLibrary + implementation("Self") },
      "/lib/telo.yaml",
    );
    const imported = await check(
      {
        "/lib/telo.yaml": handlerLibrary,
        "/app/telo.yaml":
          `kind: Telo.Library\nmetadata: { name: Shop, version: 0.1.0 }\nimports: { Billing: ../lib/telo.yaml }\n` +
          implementation("Billing"),
      },
      "/app/telo.yaml",
    );
    for (const diagnostics of [local, imported]) {
      expect(diagnostics.map((d) => d.code)).toEqual(["CONTRACT_NOT_SUBSTITUTABLE"]);
      expect(diagnostics[0]!.message).toContain("`outputType` replaces the one declared by 'Billing.Handler'");
    }
  });

  it("reports a reference that names nothing, at the root and nested", async () => {
    const diagnostics = await check(
      {
        "/lib/telo.yaml": `kind: Telo.Library
metadata: { name: Billing, version: 0.1.0 }
---
kind: Telo.Abstract
metadata: { name: Handler }
capability: Telo.Invocable
inputType: { type: object, properties: { price: !ref Missing } }
outputType: !ref Nope
`,
      },
      "/lib/telo.yaml",
    );
    expect(
      diagnostics.map((d) => [d.code, (d.data as { path?: string }).path]),
    ).toEqual([
      ["CONTRACT_TYPE_NOT_FOUND", "inputType.properties.price"],
      ["CONTRACT_TYPE_NOT_FOUND", "outputType"],
    ]);
  });
});

describe("a contract naming a shape its library also exports", () => {
  const library = (exported: string) => `kind: Telo.Library
metadata: { name: Chat, version: 0.1.0 }
exports: { kinds: [Send], resources: [${exported}] }
---
kind: Telo.JsonSchema
metadata: { name: Call }
schema: { type: object, required: [id], properties: { id: { type: string } } }
---
kind: Telo.JsonSchema
metadata: { name: Turn }
schema:
  type: object
  additionalProperties: false
  required: [role]
  properties:
    role: { type: string }
    calls: { type: array, items: !ref Call }
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
      turns: { type: array, items: !ref Turn }
`;
  const flow = `kind: Telo.Definition
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
  const app = `kind: Telo.Application
metadata: { name: App, version: 1.0.0 }
imports:
  Chat: ../lib/telo.yaml
  Fx: ../fx/telo.yaml
---
kind: Fx.Flow
metadata: { name: flow }
steps:
  - name: send
    invoke: { kind: Chat.Send }
    inputs:
      turns:
        - { calls: [{ id: a }] }
`;
  const fx = `kind: Telo.Library
metadata: { name: Fx, version: 0.1.0 }
---
${flow}`;

  it("types an importer's call site as when the shape is not exported", async () => {
    for (const exported of ["", "Call", "Turn"]) {
      const found = (
        await check(
          { "/lib/telo.yaml": library(exported), "/fx/telo.yaml": fx, "/app/telo.yaml": app },
          "/app/telo.yaml",
        )
      ).filter((d) => d.severity === 1);
      expect(found.map((d) => [d.code, d.data?.path])).toEqual([
        ["CONTRACT_INPUTS_MISMATCH", "steps[0].inputs.turns[0]"],
      ]);
    }
  });
});

describe("a shape naming another shape", () => {
  const library = (callRef: string) => `kind: Telo.Library
metadata: { name: Chat, version: 0.1.0 }
exports: { kinds: [Send] }
---
kind: Telo.JsonSchema
metadata: { name: Call }
schema: { type: object, required: [id], properties: { id: { type: string } } }
---
kind: Telo.JsonSchema
metadata: { name: Turn }
schema:
  type: object
  required: [role]
  properties:
    role: { type: string }
    calls: { type: array, items: ${callRef} }
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
      turns: { type: array, items: !ref Turn }
`;
  const fx = `kind: Telo.Library
metadata: { name: Fx, version: 0.1.0 }
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
  const app = `kind: Telo.Application
metadata: { name: App, version: 1.0.0 }
imports:
  Chat: ../lib/telo.yaml
  Fx: ../fx/telo.yaml
---
kind: Fx.Flow
metadata: { name: flow }
steps:
  - name: send
    invoke: { kind: Chat.Send }
    inputs:
      turns:
        - { role: user, calls: [{}] }
`;
  const errors = async (callRef: string, entry = "/app/telo.yaml") =>
    (
      await check(
        { "/lib/telo.yaml": library(callRef), "/fx/telo.yaml": fx, "/app/telo.yaml": app },
        entry,
      )
    )
      .filter((d) => d.severity === 1)
      .map((d) => [d.code, d.data?.path]);

  it("reads the nested shape at an importer's call site, whichever way it is named", async () => {
    const expected = [["CONTRACT_INPUTS_MISMATCH", "steps[0].inputs.turns[0].calls[0]"]];
    expect(await errors("!ref Call")).toEqual(expected);
    expect(await errors(`{ $ref: "telo:Chat/Call" }`)).toEqual(expected);
  });

  it("reports a nested reference that names nothing once, where it is written", async () => {
    expect(await errors("!ref Nowhere", "/lib/telo.yaml")).toEqual([
      ["SCHEMA_TYPE_REF_UNRESOLVED", "schema.properties.calls.items"],
    ]);
  });
});
