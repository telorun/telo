import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { DiagnosticSeverity, type ManifestSource } from "../src/types.js";

/**
 * A member of a scope its holder opens from a call (`openedBy: dispatch`) reads
 * the opening call's `inputs` in its creation-time fields, typed by the holder's
 * input contract; a scope declared without it binds nothing.
 */
function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports() {
      return true;
    },
    async read(url: string) {
      const file = url in files ? url : `${url.replace(/\/$/, "")}/telo.yaml`;
      const text = files[file];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: file };
    },
    resolveRelative(base: string, relative: string): string {
      return new URL(relative, `file://${base}`).pathname;
    },
  };
}

type Found = [code: string, resource: string, path: string];

async function check(body: string): Promise<Found[]> {
  const files = { "/app/telo.yaml": `${HEAD}${body}` };
  const graph = await new Loader([inMemorySource(files)]).loadGraph("/app/telo.yaml", {
    desugarImports: true,
  });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === DiagnosticSeverity.Error)
    .map((d) => {
      const data = d.data as { resource?: { kind: string; name: string }; path?: string };
      return [String(d.code), `${data.resource?.kind}/${data.resource?.name}`, String(data.path)] as Found;
    });
}

// `Thing` is a provider, so every field is creation-time; `Call` evaluates its
// `note` per call.
const HEAD = `kind: Telo.Application
metadata:
  name: App
  version: 1.0.0
---
kind: Telo.Definition
metadata:
  name: Thing
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  additionalProperties: false
  properties:
    key: { type: string }
---
kind: Telo.Definition
metadata:
  name: Call
capability: Telo.Invocable
controllers:
  - pkg:npm/none@0.0.0
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, properties: { own: { type: string } } }
schema:
  type: object
  additionalProperties: false
  properties:
    note: { type: string, x-telo-eval: runtime }
---
kind: Telo.Definition
metadata:
  name: Holder
capability: Telo.Runnable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  additionalProperties: false
  properties:
    members:
      type: array
      x-telo-scope: /steps
      items: { type: object }
    steps: { type: array, items: { type: object } }
`;

const SEQUENCE = (key: string) => `---
kind: Telo.Sequence
metadata:
  name: seq
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [apiKey, prompt]
    properties: { apiKey: { type: string, x-telo-sensitive: true }, prompt: { type: string } }
with:
  - kind: App.Thing
    metadata:
      name: model
    key: !cel "${key}"
steps:
  - name: reply
    value: !cel "inputs.prompt"
`;

describe("a scope opened by dispatch", () => {
  it("types a member's creation-time field by the holder's input contract", async () => {
    expect(await check(SEQUENCE("inputs.apiKey"))).toEqual([]);
    expect(await check(SEQUENCE("inputs.apikey"))).toEqual([
      ["CEL_UNKNOWN_FIELD", "Telo.Sequence/seq", "with[0].key"],
    ]);
  });

  it("binds nothing in a member's per-call field", async () => {
    const body = (note: string) => `---
kind: Telo.Sequence
metadata:
  name: seq
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, properties: { apiKey: { type: string } } }
with:
  - kind: App.Call
    metadata:
      name: call
    note: !cel "${note}"
steps:
  - name: go
    invoke: !ref call
`;
    expect(await check(body("inputs.apiKey"))).toEqual([
      ["CEL_UNKNOWN_IDENTIFIER", "Telo.Sequence/seq", "with[0].note"],
    ]);
  });

  it("gives a nested scope the inputs of the call that opened it", async () => {
    const body = (key: string) => `---
kind: Telo.Sequence
metadata:
  name: outer
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, properties: { outerKey: { type: string } } }
with:
  - kind: Telo.Sequence
    metadata:
      name: inner
    inputType:
      kind: Telo.JsonSchema
      schema: { type: object, properties: { innerKey: { type: string } } }
    with:
      - kind: App.Thing
        metadata:
          name: model
        key: !cel "${key}"
    steps:
      - name: noop
        value: 1
steps:
  - name: go
    invoke: !ref inner
    inputs: { innerKey: x }
`;
    expect(await check(body("inputs.innerKey"))).toEqual([]);
    expect((await check(body("inputs.outerKey"))).map(([code]) => code)).toEqual(["CEL_UNKNOWN_FIELD"]);
  });

  it("binds nothing in a scope declared without openedBy", async () => {
    const found = await check(`---
kind: App.Holder
metadata:
  name: holder
members:
  - kind: App.Thing
    metadata:
      name: model
    key: !cel "inputs.apiKey"
steps: []
`);
    expect(found).toEqual([["CEL_UNKNOWN_IDENTIFIER", "App.Holder/holder", "members[0].key"]]);
  });
});

describe("SCOPE_OPENED_BY_INVALID", () => {
  const kind = (capability: string, scope: string) => `---
kind: Telo.Definition
metadata:
  name: Bad
capability: ${capability}
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    members:
      type: array
      x-telo-scope: ${scope}
      items: { type: object }
    steps: { type: array, items: { type: object } }
`;

  it("refuses openedBy: dispatch on a kind nothing dispatches", async () => {
    expect(await check(kind("Telo.Provider", "{ regions: [/steps], openedBy: dispatch }"))).toEqual([
      ["SCOPE_OPENED_BY_INVALID", "Telo.Definition/Bad", "schema.properties.members.x-telo-scope"],
    ]);
  });

  it("refuses a malformed object form", async () => {
    expect(await check(kind("Telo.Runnable", "{ regions: [/steps], openedBy: call }"))).toEqual([
      ["SCOPE_OPENED_BY_INVALID", "Telo.Definition/Bad", "schema.properties.members.x-telo-scope"],
    ]);
    expect(await check(kind("Telo.Runnable", "{ openedBy: dispatch }"))).toEqual([
      ["SCOPE_OPENED_BY_INVALID", "Telo.Definition/Bad", "schema.properties.members.x-telo-scope"],
    ]);
  });

  it("accepts it on a dispatched kind", async () => {
    expect(await check(kind("Telo.Runnable", "{ regions: [/steps], openedBy: dispatch }"))).toEqual([]);
  });
});

describe("a run is its contract applied to {}", () => {
  const app = (schema: string) => `kind: Telo.Application
metadata:
  name: App
targets:
  - !ref greet
---
kind: Telo.Sequence
metadata:
  name: greet
inputType:
  kind: Telo.JsonSchema
  schema: ${schema}
steps:
  - name: say
    value: !cel "inputs.greeting"
`;
  const run = async (text: string) => {
    const graph = await new Loader([inMemorySource({ "/app/telo.yaml": text })]).loadGraph("/app/telo.yaml", {
      desugarImports: true,
    });
    return new StaticAnalyzer()
      .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
      .filter((d) => d.severity === DiagnosticSeverity.Error)
      .map((d) => [String(d.code), String((d.data as { path?: string }).path)]);
  };

  it("accepts a contract an empty call satisfies", async () => {
    expect(await run(app("{ type: object, properties: { greeting: { type: string, default: hi } } }"))).toEqual([]);
  });

  it("accepts a contract a default completes", async () => {
    expect(
      await run(app("{ type: object, minProperties: 1, properties: { greeting: { type: string, default: hi } } }")),
    ).toEqual([]);
    expect(
      await run(app("{ type: object, required: [greeting], properties: { greeting: { type: string, default: hi } } }")),
    ).toEqual([]);
  });

  it("refuses a contract that still refuses {} once defaults are filled", async () => {
    expect(
      await run(app("{ type: object, minProperties: 1, properties: { greeting: { type: string } } }")),
    ).toEqual([["CONTRACT_INPUTS_AT_RUN_SITE", "targets[0]"]]);
    expect(
      await run(app("{ type: object, required: [greeting], properties: { greeting: { type: string } } }")),
    ).toEqual([["CONTRACT_INPUTS_AT_RUN_SITE", "targets[0]"]]);
  });
});
