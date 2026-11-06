import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * `x-telo-ref` `outputTo: { slot, member }` — a source slot's output, null
 * removed, must fit the named member of the sibling slot's target's input.
 */

const KINDS = (outputTo = "{ slot: /verifier, member: presentation }") => `kind: Telo.Definition
metadata: { name: Verifier }
capability: Telo.Invocable
controllers: [pkg:telo/local/js?path=./x.mjs#X]
inputType:
  type: object
  properties:
    presentation:
      type: object
      required: [token]
      properties: { token: { type: string } }
schema: { type: object, additionalProperties: false, properties: {} }
---
kind: Telo.Definition
metadata: { name: TokenSource }
capability: Telo.Invocable
controllers: [pkg:telo/local/js?path=./x.mjs#X]
outputType:
  type: [object, "null"]
  required: [token]
  properties: { token: { type: string } }
schema: { type: object, additionalProperties: false, properties: {} }
---
kind: Telo.Definition
metadata: { name: BasicSource }
capability: Telo.Invocable
controllers: [pkg:telo/local/js?path=./x.mjs#X]
outputType:
  type: [object, "null"]
  required: [basic]
  properties: { basic: { type: object } }
schema: { type: object, additionalProperties: false, properties: {} }
---
kind: Telo.Definition
metadata: { name: Server }
capability: Telo.Service
controllers: [pkg:telo/local/js?path=./x.mjs#X]
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
          verifier: { x-telo-ref: { kind: Self.Verifier, use: call } }
          from:
            x-telo-ref: { kind: [Self.TokenSource, Self.BasicSource], use: call, outputTo: ${outputTo} }
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

async function findings(body: string, outputTo?: string) {
  const files = {
    "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
---
${KINDS(outputTo)}${body}`,
  };
  const graph = await new Loader([source(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === 1)
    .map((d) => [d.code, d.data?.path, d.message] as const);
}

describe("x-telo-ref outputTo", () => {
  it("accepts a source whose output, null removed, fits the member", async () => {
    const found = await findings(`---
kind: App.Server
metadata: { name: server }
entries:
  - verifier: { kind: App.Verifier }
    from: { kind: App.TokenSource }
`);
    expect(found).toEqual([]);
  });

  it("refuses a source the verifier cannot take, at the source", async () => {
    const found = await findings(`---
kind: App.Verifier
metadata: { name: jwt }
---
kind: App.Server
metadata: { name: server }
entries:
  - verifier: !ref jwt
    from: { kind: App.BasicSource }
`);
    expect(found.map(([code, path]) => [code, path])).toEqual([["CONTRACT_INPUTS_MISMATCH", "entries[0].from"]]);
    expect(found[0]![2]).toContain("App.Verifier 'jwt'");
    expect(found[0]![2]).toContain("'presentation' input");
  });

  it("refuses an outputTo naming no sibling reference slot, or no member of its input", async () => {
    const noSlot = await findings("", "{ slot: /verifyer, member: presentation }");
    expect(noSlot.map(([code, path]) => [code, path])).toEqual([
      ["X_TELO_REF_INVALID_OUTPUT_TO", "schema.properties.entries.items.properties.from.x-telo-ref.outputTo"],
    ]);
    expect(noSlot[0]![2]).toContain("declares nothing at '/verifyer'");
    const noMember = await findings("", "{ slot: /verifier, member: credential }");
    expect(noMember.map(([code]) => code)).toEqual(["X_TELO_REF_INVALID_OUTPUT_TO"]);
    expect(noMember[0]![2]).toContain("declares no member 'credential'");
  });

  it("refuses a malformed outputTo", async () => {
    const found = await findings("", "{ slot: verifier }");
    expect(found.map(([code]) => code)).toEqual(["X_TELO_REF_INVALID_OUTPUT_TO"]);
  });
});
