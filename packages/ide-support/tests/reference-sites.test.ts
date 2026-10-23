import { AnalysisRegistry, Loader, StaticAnalyzer, collectModuleDocuments, flattenForAnalyzer, type ManifestSource } from "@telorun/analyzer";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { referenceSitesOf } from "../src/view-model/reference-sites.js";

const OWNER = fileURLToPath(new URL("./__fixtures__/reference-sites/telo.yaml", import.meta.url));

class DiskSource implements ManifestSource {
  supports(url: string): boolean {
    return isAbsolute(url);
  }
  async read(url: string) {
    const path = statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
    return { text: readFileSync(path, "utf8"), source: path };
  }
  resolveRelative(base: string, relative: string): string {
    return resolve(dirname(base), relative);
  }
  async exists(base: string, relative: string) {
    return existsSync(resolve(dirname(base), relative));
  }
}

describe("referenceSitesOf", () => {
  it("lists a reference, never an inline declaration whose kind has a `name` field", async () => {
    const graph = await new Loader([new DiskSource()]).loadGraph(OWNER, { desugarImports: true, migrate: true });
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) }, registry);
    expect(referenceSitesOf(registry, graph.entry)).toEqual([
      { source: { kind: "Kinds.Holder", name: "references" }, path: "target", target: "house" },
    ]);
  });
});
