import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * A library's own calls — `Self.<fn>` and `<LibName>.<fn>` — reach what it
 * declares in an importer's analysis too, its exported functions included:
 * that is where its rule conditions run. A re-export is no declaration of the
 * re-exporter.
 */

const source = (files: Record<string, string>): ManifestSource => ({
  supports: () => true,
  async read(url: string) {
    const text = files[url];
    if (text === undefined) throw new Error(`File not found: ${url}`);
    return { text, source: url };
  },
  resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
});

const LIB = `kind: Telo.Library
metadata: { name: Lib, version: 0.1.0 }
exports:
  kinds: [Box]
  resources: [fits, wraps]
---
kind: Telo.Function
metadata: { name: fits }
params: [{ name: size, schema: { type: integer } }]
returns: { schema: { type: boolean } }
body: !cel "size < 10"
---
kind: Telo.Function
metadata: { name: small }
params: [{ name: size, schema: { type: integer } }]
returns: { schema: { type: boolean } }
body: !cel "size < 5"
---
kind: Telo.Function
metadata: { name: wraps }
params: [{ name: size, schema: { type: integer } }]
returns: { schema: { type: boolean } }
body: !cel "Self.small(size)"
---
kind: Telo.Definition
metadata: { name: Box }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./x.mjs#X
schema:
  type: object
  additionalProperties: false
  properties:
    size: { type: integer }
  x-telo-resource-rules:
    - condition: !cel "Self.fits(self.size)"
      code: BOX_TOO_BIG
      message: is too big.
    - condition: !cel "Lib.fits(self.size)"
      code: BOX_TOO_BIG_BY_NAME
      message: is too big by name.
    - condition: !cel "Self.wraps(self.size)"
      code: BOX_NOT_SMALL
      message: is not small.
`;

const REEXPORTER = `kind: Telo.Library
metadata: { name: Again, version: 0.1.0 }
imports:
  Lib: ../lib/telo.yaml
exports:
  kinds: [Crate]
  resources: [Lib.fits]
---
kind: Telo.Definition
metadata: { name: Crate }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./x.mjs#X
schema:
  type: object
  additionalProperties: false
  properties:
    size: { type: integer }
  x-telo-resource-rules:
    - condition: !cel "Self.fits(self.size)"
      code: CRATE_TOO_BIG
      message: is too big.
`;

const APP = `kind: Telo.Application
metadata: { name: App }
imports:
  Lib: ../lib/telo.yaml
  Again: ../again/telo.yaml
---
kind: Lib.Box
metadata: { name: big }
size: 12
---
kind: Again.Crate
metadata: { name: crate }
size: 12
`;

async function analyzed() {
  const files = { "/lib/telo.yaml": LIB, "/again/telo.yaml": REEXPORTER, "/app/telo.yaml": APP };
  const graph = await new Loader([source(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  const manifests = flattenForAnalyzer(graph);
  const registry = new AnalysisRegistry();
  const diagnostics = new StaticAnalyzer().analyze(manifests, { moduleDocuments: collectModuleDocuments(graph) }, registry);
  return { diagnostics, manifests, registry };
}

describe("a library's own call in an importer's analysis", () => {
  it("reaches its exported function through Self and through its own name, and a non-exported one an export calls", async () => {
    const { diagnostics } = await analyzed();
    const rules = diagnostics
      .filter((d) => d.data?.resource?.name === "big")
      .map((d) => [d.code, (d.data as { rule?: string } | undefined)?.rule]);
    expect(rules).toEqual([
      ["RESOURCE_RULE_VIOLATED", "BOX_TOO_BIG"],
      ["RESOURCE_RULE_VIOLATED", "BOX_TOO_BIG_BY_NAME"],
      ["RESOURCE_RULE_VIOLATED", "BOX_NOT_SMALL"],
    ]);
    const lib = diagnostics.filter((d) => (d.data as { rule?: string } | undefined)?.rule?.startsWith("BOX_"));
    expect(lib.filter((d) => d.code !== "RESOURCE_RULE_VIOLATED")).toEqual([]);
  });

  it("does not reach a function a re-exporter only re-exports", async () => {
    const { diagnostics } = await analyzed();
    expect(diagnostics.filter((d) => d.code === "RESOURCE_RULE_VIOLATED" && (d.data as { rule?: string }).rule === "CRATE_TOO_BIG")).toEqual([]);
    expect(diagnostics.some((d) => d.code === "RESOURCE_RULE_INVALID" && d.message.includes("'Self.fits'"))).toBe(true);
  });

  it("offers the exported function through Self where the library's own CEL is read", async () => {
    const { manifests, registry } = await analyzed();
    const wraps = manifests.find((m) => m.metadata?.name === "wraps" && m.kind === "Telo.Function")!;
    const scope = registry.analysisOf(manifests).celScope.scopeAt(wraps, "body");
    expect(scope?.moduleFunctionsOf("Self").map((entry) => entry.name)).toEqual(expect.arrayContaining(["fits", "wraps"]));
  });
});
