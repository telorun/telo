import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/** The in-repo configuration corpus: every fixture under a configurations
 *  fixture directory, and every manifest writing a choice. */

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** `file` relative to the repository root, `/`-separated on every platform. */
const repoPath = (file: string) => relative(ROOT, file).split(sep).join("/");

const fileSource: ManifestSource = {
  supports: (url) => isAbsolute(url),
  async read(url) {
    const file = existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
    return { text: readFileSync(file, "utf8"), source: file };
  },
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

export async function loadFile(file: string) {
  const graph = await new Loader([fileSource]).loadGraph(file, { desugarImports: true });
  return { manifests: flattenForAnalyzer(graph), moduleDocuments: collectModuleDocuments(graph) };
}

const TAG = /(?:^|:|-|---)\s*!(?:if|switch)\b/m;
const EXPANSION_TAG = /(?:^|:|-|---)\s*!(?:if|switch|for-each)\b/m;

/** Whether the manifest at `file` writes `!if`, `!switch` or `!for-each`
 *  outside a comment. */
export function writesExpansion(file: string): boolean {
  const written = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  return EXPANSION_TAG.test(written);
}
const SKIP = new Set(["node_modules", ".telo", "dist", ".claude", ".git"]);

/** The configuration corpus `configurations.test.ts` records, in-repo files. */
export function fileCorpus(): string[] {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".yaml")) {
        const written = readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("#"))
          .join("\n");
        const fixture = /__fixtures__[\\/](?:check-run-agreement[\\/])?configurations[\\/]/.test(path);
        if (fixture || TAG.test(written)) out.add(repoPath(path));
      }
    }
  };
  for (const dir of ["tests", "modules", "examples", "starters", "blueprints"]) {
    if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));
  }
  return [...out].sort();
}

