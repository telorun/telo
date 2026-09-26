/**
 * The answers ide-support gives in-process — the way an editor host computed
 * them before the engine existed: load the owner module from disk, analyse it,
 * and call each builder directly. The engine's LSP answer must match.
 */

import {
  AnalysisRegistry,
  Loader,
  StaticAnalyzer,
  collectModuleDocuments,
  flattenForAnalyzer,
  type ManifestSource,
} from "@telorun/analyzer";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

class DiskSource implements ManifestSource {
  supports(url: string): boolean {
    return url.startsWith("/");
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
  async resolveOwnerOf(file: string) {
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      const candidate = join(dir, "telo.yaml");
      if (candidate !== file && existsSync(candidate)) return candidate;
      if (dirname(dir) === dir) return null;
    }
  }
}

export async function analyseInProcess(file: string) {
  const loader = new Loader([new DiskSource()]);
  const found = await loader.loadGraphForFile(file, { desugarImports: true, migrate: true });
  if (!found) throw new Error(`${file} belongs to no module`);
  const { graph } = found;
  const manifests = flattenForAnalyzer(graph);
  const registry = new AnalysisRegistry();
  new StaticAnalyzer().analyze(manifests, { moduleDocuments: collectModuleDocuments(graph) }, registry);
  const loaded = [...graph.modules.values()]
    .flatMap((m) => [m.owner, ...m.partials])
    .find((f) => f.source === file)!;
  return {
    graph,
    registry,
    analysis: registry.analysisOf(manifests),
    text: loaded.text,
    docs: loaded.astDocuments,
  };
}
