import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

const source = (files: Record<string, string>): ManifestSource => ({
  supports: () => true,
  async read(url: string) {
    const text = files[url];
    if (text === undefined) throw new Error(`File not found: ${url}`);
    return { text, source: url };
  },
  resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
});

/** Errors reported for an application declaring one `Telo.Value`, with no import. */
async function errors(lengthExpr: string): Promise<Array<[string, string]>> {
  const text = `kind: Telo.Application
metadata: { name: App, version: 1.0.0 }
targets:
  - { name: greeting, invoke: !ref greet, inputs: { name: telo } }
---
kind: Telo.Value
metadata: { name: greet }
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, required: [name], properties: { name: { type: string } } }
outputType:
  kind: Telo.JsonSchema
  schema: { type: object, required: [greeting, length], properties: { greeting: { type: string }, length: { type: integer } } }
bindings:
  greeting: !cel "'Hello ' + inputs.name"
value:
  greeting: !cel "greeting"
  length: !cel "${lengthExpr}"
`;
  const graph = await new Loader([source({ "/app/telo.yaml": text })]).loadGraph("/app/telo.yaml", {
    desugarImports: true,
  });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === 1)
    .map((d) => [d.code, String(d.data?.path)]);
}

describe("Telo.Value", () => {
  it("accepts a value that fits its outputType, reading bindings and inputs", async () => {
    expect(await errors("size(greeting)")).toEqual([]);
  });

  it("refuses a value that does not fit its outputType", async () => {
    const found = await errors("inputs.name");
    expect(found.map(([code]) => code)).toEqual(["CEL_TYPE_ERROR"]);
  });
});
