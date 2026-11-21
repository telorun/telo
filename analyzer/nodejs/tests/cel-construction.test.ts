import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { locateDiagnostic } from "../src/diagnostic-location.js";
import { Loader } from "../src/manifest-loader.js";
import { DiagnosticSeverity, type ManifestSource } from "../src/types.js";

/** A construction in a manifest is read, checked and reported like any other expression. */
function inMemorySource(files: Record<string, string>): ManifestSource {
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

const HEAD = `kind: Telo.Application
metadata:
  name: App
  version: 1.0.0
variables:
  street: { env: STREET, type: string, default: Main }
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
    key: {}
---
`;

async function errors(body: string) {
  const text = `${HEAD}${body}`;
  const graph = await new Loader([inMemorySource({ "/app/telo.yaml": text })]).loadGraph("/app/telo.yaml", {
    desugarImports: true,
  });
  const found = new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === DiagnosticSeverity.Error);
  return { text, found, graph };
}

describe("message construction in a manifest", () => {
  it("reports a construction of a type the host does not allow constructing, ranged at the scalar", async () => {
    const { text, found, graph } = await errors(`kind: App.Thing
metadata:
  name: thing
key: !cel "Telo.Url{scheme: 'https'}"
`);
    expect(found.map((d) => d.code)).toEqual(["CEL_TYPE_NOT_CONSTRUCTIBLE"]);
    const range = locateDiagnostic(graph, found[0]!)!.range;
    const lines = text.split("\n");
    const line = lines.findIndex((l) => l.startsWith("key:"));
    expect(range.start.line).toBe(line);
    expect(lines[line]!.slice(range.start.character, range.end.character)).toBe(`"Telo.Url{scheme: 'https'}"`);
  });

  it("reads the values written in a construction like any other expression", async () => {
    const { found } = await errors(`kind: App.Thing
metadata:
  name: thing
key: !cel "Shop{street: variables.nope}"
`);
    expect(found.map((d) => d.code).sort()).toEqual(["CEL_UNKNOWN_FIELD", "CEL_UNKNOWN_TYPE"]);
  });
});
