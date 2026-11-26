import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { analyzeLoadedGraph } from "../src/graph-analysis.js";
import { Loader } from "../src/manifest-loader.js";
import type { AnalysisDiagnostic } from "../src/types.js";
import { fileSource, loadFile, ROOT } from "./configuration-corpus.js";

/**
 * `x-telo-context-ref-from` as a path read from the object holding the region —
 * data, then each reference slot crossed — or a list of them as ordered
 * alternatives; beside `x-telo-context-withheld`, withheld where no alternative
 * names anything; the node's own keywords where the path holds nothing.
 */

const FIXTURES = join(ROOT, "analyzer/nodejs/tests/__fixtures__/context-ref-from");

async function analysis(file: string): Promise<AnalysisDiagnostic[]> {
  const loaded = await loadFile(join(FIXTURES, file));
  return new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
}

const findings = (diagnostics: AnalysisDiagnostic[]) =>
  diagnostics
    .filter((d) => d.severity === 1)
    .map((d) => `${d.code} ${(d.data as { resource?: { name?: string } }).resource?.name} ${(d.data as { path?: string }).path}: ${d.message}`)
    .sort();

describe("x-telo-context-ref-from", () => {
  it("types a binding where its path names something and withholds it where it names nothing", async () => {
    expect(findings(await analysis("telo.yaml"))).toEqual([
      // The write declares no answer: the node's own keywords, closed and empty.
      "CEL_UNKNOWN_FIELD closedEmpty effects[0]: RefKinds.Editor/closedEmpty: !cel: 'result.id' is not defined (available: none)",
      "CEL_UNKNOWN_FIELD misspelt url: RefKinds.Lookup/misspelt: !cel: 'sheet.titel' is not defined (available: id, title)",
      // The first alternative holds a type.
      "CEL_UNKNOWN_FIELD typedFirst effects[1]: RefKinds.Editor/typedFirst: !cel: 'result.titel' is not defined (available: id, title)",
      // The first alternative's data prefix is absent: the second types it.
      "CEL_UNKNOWN_FIELD typedSecond effects[1]: RefKinds.Editor/typedSecond: !cel: 'result.nmae' is not defined (available: id, name)",
      "CEL_UNKNOWN_IDENTIFIER noSheet url: RefKinds.Lookup/noSheet: !cel: 'sheet' is not available here: the lookup names no sheet in `sheet`.",
    ]);
  }, 120_000);

  it("finds a binding's declaration through the alternative that types it", async () => {
    // The editor's reading: the analysed set, its references resolved.
    const graph = await new Loader([fileSource]).loadGraph(join(FIXTURES, "telo.yaml"), { desugarImports: true });
    const registry = new AnalysisRegistry();
    const { manifests } = await analyzeLoadedGraph(graph, { registry });
    const query = registry.analysisOf(manifests).celScope;
    const site = (name: string, member: string) =>
      query.contextDeclarationSite(query.resourceFor("RefKinds.Editor", name)!, "effects[0]", ["sample", member]);
    // Both alternatives name something: the first is read.
    expect(site("bothNamed", "title")).toMatchObject({ kind: "RefKinds.Write", name: "saveInline", path: "sample.properties.title" });
    expect(site("typedSecond", "name")).toMatchObject({ kind: "RefKinds.Table", name: "people", path: "sample.properties.name" });
  }, 120_000);

  it("withholds a binding a nested region shadows where its own path crosses a reference naming nothing", async () => {
    expect(findings(await analysis("board/telo.yaml"))).toEqual([
      "CEL_UNKNOWN_FIELD board nodes[0].content[2].label: Self.Board/board: !cel: 'sheet.titel' is not defined (available: id, title)",
      "CEL_UNKNOWN_IDENTIFIER board nodes[0].content[1].label: Self.Board/board: !cel: 'sheet' is not available here: the node's lookup names no sheet in `sheet`.",
    ]);
  }, 120_000);

  it("leaves the binding open where the slot is a library's kind-only input", async () => {
    expect(findings(await analysis("lib/telo.yaml"))).toEqual([]);
  }, 120_000);

  it("refuses at the kind a path the holder cannot follow, a malformed value, and the mark beside both typings", async () => {
    const diagnostics = (await analysis("invalid/telo.yaml")).filter((d) =>
      ["CONTEXT_REF_FROM_INVALID", "SCHEMA_VIOLATION", "CONTEXT_WITHHELD_INVALID"].includes(d.code),
    );
    const at = (binding: string, annotation: string) =>
      `schema.properties.effects.x-telo-context.properties.${binding}.${annotation}`;
    expect(diagnostics.map((d) => [d.code, (d.data as { path?: string }).path]).sort()).toEqual(
      [
        ["CONTEXT_REF_FROM_INVALID", at("data", "x-telo-context-ref-from")],
        ["CONTEXT_REF_FROM_INVALID", at("endsAtSlot", "x-telo-context-ref-from")],
        ["CONTEXT_REF_FROM_INVALID", at("misspelt", "x-telo-context-ref-from")],
        ["CONTEXT_WITHHELD_INVALID", at("both", "x-telo-context-withheld")],
        ["SCHEMA_VIOLATION", at("empty", "x-telo-context-ref-from")],
        ["SCHEMA_VIOLATION", at("gap", "x-telo-context-ref-from")],
        ["SCHEMA_VIOLATION", at("number", "x-telo-context-ref-from")],
      ].sort(),
    );
  }, 120_000);
});
