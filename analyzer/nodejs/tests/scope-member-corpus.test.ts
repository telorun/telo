import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DiagnosticSeverity } from "../src/types.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * Every in-repo manifest declaring a `with:` scope, checked as `telo check`
 * checks it: a scope member is analysed as a declaration of its own and never
 * through its holder as well, so no finding is reported twice — and no manifest
 * but those {@link BROKEN_ON_PURPOSE} has an error inside a member, each of
 * which does.
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const fileSource: ManifestSource = {
  supports: (url) => isAbsolute(url),
  async read(url) {
    const file = existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
    return { text: readFileSync(file, "utf8"), source: file };
  },
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return entry.name.endsWith(".yaml") ? [path] : [];
  });
}

const corpus = [
  ...readdirSync(join(REPO, "modules")).map((m) => join(REPO, "modules", m, "tests")),
  join(REPO, "tests"),
  join(REPO, "examples"),
  join(REPO, "starters"),
]
  .flatMap(yamlFiles)
  .filter((file) => /^\s*with:\s*$/m.test(readFileSync(file, "utf8")));

/** Fixtures whose members are wrong by design — each pins a refusal inside a
 *  scope member in the check/run agreement suite. */
const BROKEN_ON_PURPOSE = new Set(
  [
    "tests/__fixtures__/check-run-agreement/provider-status/scoped-lib/telo.yaml",
    "tests/__fixtures__/check-run-agreement/expansion/branch-shape/telo.yaml",
    "tests/__fixtures__/configurations/scope-choice.yaml",
    "tests/__fixtures__/configurations/scope-member-own-kind.yaml",
    "tests/__fixtures__/check-run-agreement/scope-members/cel-lib/telo.yaml",
    "tests/__fixtures__/check-run-agreement/scope-members/cel-nested.yaml",
    "tests/__fixtures__/check-run-agreement/scope-members/cel-sibling.yaml",
    "tests/__fixtures__/check-run-agreement/scope-members/lib/telo.yaml",
    "tests/__fixtures__/check-run-agreement/scoped-kind-document/telo.yaml",
    "tests/__fixtures__/check-run-agreement/scoped-kind-document-library/lib/telo.yaml",
  ].map((file) => join(REPO, file)),
);

describe("the `with:` corpus", () => {
  it(
    "reports no finding twice, and no error inside a member of a manifest a suite runs",
    async () => {
      const loader = new Loader([fileSource]);
      let analysed = 0;
      const repeated: string[] = [];
      const inMembers: string[] = [];
      const brokenFound = new Set<string>();
      for (const file of corpus) {
        const graph = await loader.loadGraph(file, { desugarImports: true }).catch(() => undefined);
        if (!graph || graph.errors?.length) continue;
        analysed++;
        const seen = new Set<string>();
        for (const d of new StaticAnalyzer().analyze(flattenForAnalyzer(graph), {
          moduleDocuments: collectModuleDocuments(graph),
        })) {
          const data = d.data as
            | { resource?: { kind?: string; name?: string }; filePath?: string; path?: string }
            | undefined;
          const key = [
            d.code,
            data?.resource?.kind,
            data?.resource?.name,
            data?.filePath,
            data?.path,
            d.message,
          ].join("\0");
          if (seen.has(key)) repeated.push(`${file}: ${d.code} at ${data?.path}: ${d.message}`);
          seen.add(key);
          if (d.severity === DiagnosticSeverity.Error && /^with\[\d+\]/.test(data?.path ?? "")) {
            if (BROKEN_ON_PURPOSE.has(file)) brokenFound.add(file);
            else inMembers.push(`${file}: ${d.code} at ${data?.path}: ${d.message}`);
          }
        }
      }
      expect(repeated).toEqual([]);
      expect(inMembers).toEqual([]);
      // A listed fixture that no longer reports one is a stale entry.
      expect([...BROKEN_ON_PURPOSE].filter((file) => !brokenFound.has(file))).toEqual([]);
      // Most of the corpus loads from the checkout; one importing a published
      // module is skipped rather than fetched.
      expect(analysed).toBeGreaterThan(corpus.length * 0.8);
    },
    300_000,
  );
});
