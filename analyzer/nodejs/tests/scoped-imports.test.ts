import { collectFilePositions } from "../src/diagnostic-location.js";
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
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph), positions: collectFilePositions(graph) })
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

  it("refuses a splice at its own top level at the member, loading nothing beneath it", async () => {
    const graph = await new Loader([files]).loadGraph(
      join(ROOT, "tests/__fixtures__/check-run-agreement/import-choices/splice-member.yaml"),
      { desugarImports: true },
    );
    expect(graph.scopedImportEdges?.size ?? 0).toBe(0);
    expect(importResolutionDiagnostics(graph)).toEqual([
      expect.objectContaining({
        code: "REPEAT_OUTSIDE_TEMPLATE",
        message: expect.stringMatching(/^Telo\.Import\/Lib: A '\.\.\.' splice at '\.\.\.' of the Telo\.Import: /),
        data: expect.objectContaining({ resource: { kind: "Telo.Sequence", name: "scope" }, path: "with[0]...." }),
      }),
    ]);
  });

  it("is followed wherever a choice writes it, recording its written place and the options on the way", async () => {
    const graph = await new Loader([files]).loadGraph(
      join(ROOT, "tests/__fixtures__/configurations/scoped-import-need-choice.yaml"),
      { desugarImports: true },
    );
    expect(
      [...graph.scopedImportEdges!.values()].flat().map(({ alias, holderKind, holders, place, options, targetModuleName }) => ({
        alias, holderKind, holders, place, options, targetModuleName,
      })),
    ).toEqual([
      {
        alias: "Inner",
        holderKind: "!if",
        holders: [{ name: "holder", field: "with", index: 0 }],
        place: ["then", "with", 0],
        options: [{ at: [], branch: "then" }],
        targetModuleName: "ScopedChoiceNeedLib",
      },
      {
        alias: "Inner",
        holderKind: "Telo.Sequence",
        holders: [{ name: "scope", field: "with", index: 0 }],
        place: ["with", "then", 0],
        options: [{ at: ["with"], branch: "then" }],
        targetModuleName: "ScopedChoiceNeedLib",
      },
      {
        alias: "Bad",
        holderKind: "Telo.Sequence",
        holders: [{ name: "scope", field: "with", index: 1 }],
        place: ["with", "then", 1],
        options: [{ at: ["with"], branch: "then" }],
        targetModuleName: "ScopedChoiceBadNeedLib",
      },
      {
        alias: "Inner",
        holderKind: "Telo.Sequence",
        holders: [{ name: "member", field: "with", index: 0 }],
        place: ["with", 0, "then"],
        options: [{ at: ["with", 0], branch: "then" }],
        targetModuleName: "ScopedChoiceNeedLib",
      },
    ]);
  });

  it("reports a choice-written one's import refusal where it is written, in no configuration", async () => {
    const graph = await new Loader([files]).loadGraph(
      join(ROOT, "tests/__fixtures__/scoped-imports/choice-unresolved-off.yaml"),
      { desugarImports: true },
    );
    expect(
      importResolutionDiagnostics(graph).map((d) => {
        const data = d.data as { resource?: unknown; path?: string; configurations?: unknown };
        return [d.code, data.resource, data.path, data.configurations];
      }),
    ).toEqual([
      ["IMPORT_UNRESOLVED", { kind: "!if", name: "holder" }, "then.with[0]", undefined],
      ["IMPORT_UNRESOLVED", { kind: "Telo.Sequence", name: "scope" }, "with.then[0]", undefined],
      ["IMPORT_UNRESOLVED", { kind: "Telo.Sequence", name: "member" }, "with[0].then", undefined],
    ]);
  });

  it("reports nothing about its library's own defects, as for an imports: entry", async () => {
    expect(await findings("broken-scoped.yaml")).toEqual([]);
    expect(await findings("broken-imported.yaml")).toEqual([]);
  });

  it("gives its scope's regions its exported instances, and nothing outside them", async () => {
    expect(await findings("instances.yaml")).toEqual([
      "UNRESOLVED_REFERENCE outside steps[0].invoke",
      "CEL_UNKNOWN_FIELD outside steps[1].value",
    ]);
  });

  it("names its needs beneath its holders, one instance per holder", async () => {
    const graph = await loadGraph("needs.yaml");
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph), positions: collectFilePositions(graph) }, registry);
    const table = resolveNeedTable(needGraphFromLoadedGraph(graph, needGraphScopeOf(registry, "ScopedNeeds")));
    expect(table.environment.flatMap((entry) => Object.values(entry.fields).map((field) => field.env))).toEqual([
      "TELO_NEED_FIRST__INNER__STORAGE__PATH",
      "TELO_NEED_SECOND__INNER__STORAGE__PATH",
    ]);
  });

  it("judges its inputs as an imports: entry's: CEL in the import's environment, host paths against its library's", async () => {
    expect(await findings("inputs.yaml")).toEqual([
      "HOST_PATH_UNTYPED_SOURCE seq with[0].variables.root",
      "HOST_PATH_RELATIVE seq with[0].variables.extra",
      "CEL_TYPE_ERROR seq with[0].variables.count",
    ]);
  });

  it("judges its CEL in the import's environment where a choice writes its scope", async () => {
    const graph = await new Loader([files]).loadGraph(join(ROOT, "tests/__fixtures__/configurations/scoped-import-cel-choice.yaml"), {
      desugarImports: true,
    });
    const found = new StaticAnalyzer().analyze(flattenForAnalyzer(graph), {
      moduleDocuments: collectModuleDocuments(graph),
      positions: collectFilePositions(graph),
    });
    expect(found.map((d) => [d.code, (d.data as { path?: string }).path, (d.data as { configurations?: unknown }).configurations])).toEqual([
      ["CEL_TYPE_ERROR", "with.then[0].variables.root", [{ "variables.flag1": true }]],
    ]);
  });

  it("refuses a member named in two scopes of one holder", async () => {
    expect(await findings("two-scopes.yaml")).toEqual(["DUPLICATE_RESOURCE_NAME pair right[0].metadata.name"]);
  });
});
