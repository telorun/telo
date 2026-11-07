import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { importResolutionDiagnostics } from "../src/import-resolution-diagnostics.js";
import { Loader } from "../src/manifest-loader.js";
import { needGraphFromLoadedGraph, needGraphScopeOf, resolveNeedTable } from "../src/need-table.js";
import { ROOT } from "./configuration-corpus.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ManifestSource } from "../src/types.js";

/**
 * A `Telo.Import` declared as a scope member is loaded and analysed through the
 * per-import step an `imports:` entry takes: its library instance sits beneath
 * its holders, gives its scope instance names and no module name, and its
 * import refusals are reported at the member.
 */
const FIXTURES = join(ROOT, "analyzer/nodejs/tests/__fixtures__/scoped-imports");

const files: ManifestSource = {
  supports: (url) => isAbsolute(url),
  async read(url) {
    const file = existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
    return { text: readFileSync(file, "utf8"), source: file };
  },
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

const loadGraph = (file: string) => new Loader([files]).loadGraph(join(FIXTURES, file), { desugarImports: true });

async function findings(file: string): Promise<string[]> {
  const graph = await loadGraph(file);
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === 1)
    .map((d) => {
      const data = d.data as { resource?: { name?: string }; path?: string } | undefined;
      return `${d.code} ${data?.resource?.name ?? "-"} ${data?.path}`;
    });
}

describe("a Telo.Import declared in a scope", () => {
  it("loads its target and records it beneath its holder", async () => {
    const graph = await loadGraph("instances.yaml");
    const [edge] = [...graph.scopedImportEdges!.values()].flat();
    expect(edge).toMatchObject({
      alias: "Inner",
      targetModuleName: "ScopedGreetLib",
      holders: [{ name: "seq", field: "with", index: 0 }],
    });
    expect(graph.modules.has(edge!.targetSource)).toBe(true);
  });

  it("reports an import refusal at the member inside its holder", async () => {
    const graph = await new Loader([files]).loadGraph(join(ROOT, "tests/__fixtures__/scoped-imports/unresolved.yaml"), {
      desugarImports: true,
    });
    expect(importResolutionDiagnostics(graph)).toEqual([
      expect.objectContaining({
        code: "IMPORT_UNRESOLVED",
        data: expect.objectContaining({ resource: { kind: "Telo.Sequence", name: "seq" }, path: "with[0]" }),
      }),
    ]);
  });

  it("reports nothing about its library's own defects, as for an imports: entry", async () => {
    expect(await findings("broken-scoped.yaml")).toEqual([]);
    expect(await findings("broken-imported.yaml")).toEqual([]);
  });

  it("gives its scope's regions its exported instances, and nothing outside them", async () => {
    expect(await findings("instances.yaml")).toEqual([
      "CEL_UNKNOWN_FIELD outside steps[1].value",
      "UNRESOLVED_REFERENCE outside steps[0].invoke",
    ]);
  });

  it("names its needs beneath its holders, one instance per holder", async () => {
    const graph = await loadGraph("needs.yaml");
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) }, registry);
    const table = resolveNeedTable(needGraphFromLoadedGraph(graph, needGraphScopeOf(registry, "ScopedNeeds")));
    expect(table.environment.flatMap((entry) => Object.values(entry.fields).map((field) => field.env))).toEqual([
      "TELO_NEED_FIRST__INNER__STORAGE__PATH",
      "TELO_NEED_SECOND__INNER__STORAGE__PATH",
    ]);
  });

  it("refuses a member named in two scopes of one holder", async () => {
    expect(await findings("two-scopes.yaml")).toEqual(["DUPLICATE_RESOURCE_NAME pair right[0].metadata.name"]);
  });
});
