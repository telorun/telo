import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments } from "../src/index.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/** `analyzer/outline-conformance/`: each vector is a module and the outline
 *  every analyzer answers for it. */
const VECTORS = fileURLToPath(new URL("../../outline-conformance/vectors/", import.meta.url));

/** Every YAML file of a vector, keyed by its path under `/vector`. */
function filesUnder(root: string, dir = root, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(root, path, out);
    else if (name.endsWith(".yaml")) {
      out[`/vector${path.slice(root.length).replace(/\\/g, "/")}`] = readFileSync(path, "utf8");
    }
  }
  return out;
}

/** The vector's files, a directory resolving to its `telo.yaml`. */
function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative: (base: string, relative: string) => {
      const resolved = new URL(relative, `file://${base}`).pathname;
      return resolved.endsWith(".yaml") ? resolved : `${resolved}/telo.yaml`;
    },
  };
}

describe("outline conformance", () => {
  for (const vector of readdirSync(VECTORS)) {
    it(vector, async () => {
      const dir = join(VECTORS, vector);
      const graph = await new Loader([inMemorySource(filesUnder(dir))]).loadGraph("/vector/telo.yaml", {
        desugarImports: true,
      });
      expect(graph.errors).toEqual([]);
      const manifests = flattenForAnalyzer(graph);
      const registry = new AnalysisRegistry();
      const diagnostics = new StaticAnalyzer().analyze(
        manifests,
        { moduleDocuments: collectModuleDocuments(graph) },
        registry,
      );
      expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
      const root = manifests.find(
        (m) =>
          (m.kind === "Telo.Application" || m.kind === "Telo.Library") &&
          m.metadata?.source === graph.entry.owner.source,
      );
      const options = { root, entryModule: root?.metadata?.name as string };
      const outline = registry
        .analysisOf(manifests)
        .outline(registry.moduleGraphDeps(manifests, options), options);
      const expected = JSON.parse(readFileSync(join(dir, "outline.json"), "utf8"));
      expect(JSON.parse(JSON.stringify(outline))).toEqual(expected);
    });
  }
});
