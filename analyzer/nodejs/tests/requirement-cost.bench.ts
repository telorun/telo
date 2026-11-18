import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isExpansionSentinel } from "@telorun/templating";
import { bench, describe } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { readChoices } from "../src/choice-reading.js";
import { choiceScopeOf } from "../src/choice-scope.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { inputRequirements } from "../src/input-requirements.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";
import { registeredNeedTable } from "../src/validate-needs.js";
import { GENERATED } from "./configuration-cost-fixtures.js";

/**
 * What deriving an application's input requirements costs at N = 4, 8 and 16
 * boolean flags: flag k gates the one declaration reading the required
 * variable `vK`, and the application imports a chain of L = 3 libraries, each
 * reading its own need only where its flag holds, every flag bound from the
 * one above to the application's `flag1`. Only the derivation is timed; the
 * target is linear growth (t(16)/t(8) at most 2.5).
 *
 * Run: `npx vitest bench --run tests/requirement-cost.bench.ts`;
 * `REQUIREMENT_COST_N=4,8` picks the rows.
 */

const KINDS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tests/__fixtures__/configurations/needs/kinds");
const DEPTH = 3;

function application(n: number): string {
  const flags = Array.from({ length: n }, (_, i) => i + 1);
  return [
    "kind: Telo.Application",
    "metadata: { name: RequirementCost }",
    "variables:",
    ...flags.flatMap((k) => [`  flag${k}: { env: FLAG_${k}, type: boolean, default: false }`, `  v${k}: { env: V_${k}, type: string }`]),
    "imports:",
    `  Kinds: ${KINDS}`,
    "  Chain:",
    "    source: ./chain1",
    '    variables: { flag: !cel "variables.flag1" }',
    ...flags.flatMap((k) => [
      "--- !if",
      `metadata: { name: r${k} }`,
      `if: !cel "variables.flag${k}"`,
      "then:",
      "  kind: Kinds.Labelled",
      `  label: !cel "variables.v${k}"`,
    ]),
    "",
  ].join("\n");
}

function library(depth: number): string {
  return [
    "kind: Telo.Library",
    `metadata: { name: Chain${depth}, version: 0.0.0, description: A link of the requirement-cost chain. }`,
    "imports:",
    `  Kinds: ${KINDS}`,
    ...(depth < DEPTH ? ["  Next:", `    source: ../chain${depth + 1}`, '    variables: { flag: !cel "variables.flag" }'] : []),
    "variables:",
    "  flag: { type: boolean, default: false }",
    "needs:",
    "  data: { kind: Telo.DurableDirectory }",
    "--- !if",
    "metadata: { name: store }",
    'if: !cel "variables.flag"',
    "then:",
    "  kind: Kinds.Labelled",
    "  label: !cel \"string(resources.data.path)\"",
    "",
  ].join("\n");
}

/** The application at `n` flags, its chain served from memory beside it. */
async function load(n: number) {
  const base = join(GENERATED, `requirement-cost-${n}`);
  const texts = new Map<string, string>([[join(base, "telo.yaml"), application(n)]]);
  for (let depth = 1; depth <= DEPTH; depth++) texts.set(join(base, `chain${depth}`, "telo.yaml"), library(depth));
  const source: ManifestSource = {
    supports: (url) => isAbsolute(url),
    async read(url) {
      const generated = texts.get(url) ?? texts.get(join(url, "telo.yaml"));
      if (generated !== undefined) return { text: generated, source: texts.has(url) ? url : join(url, "telo.yaml") };
      const file = existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
      return { text: readFileSync(file, "utf8"), source: file };
    },
    resolveRelative: (from, relative) => resolve(dirname(from), relative),
  };
  const graph = await new Loader([source]).loadGraph(join(base, "telo.yaml"), { desugarImports: true });
  const manifests = flattenForAnalyzer(graph);
  const libraries = collectModuleDocuments(graph);
  const registry = new AnalysisRegistry();
  new StaticAnalyzer().analyze(manifests, { moduleDocuments: libraries, skipValidation: true }, registry);
  const table = registeredNeedTable(manifests, registry, libraries);
  const choices = readChoices(
    manifests.filter((m) => !isExpansionSentinel(m)),
    manifests.filter(isExpansionSentinel),
    choiceScopeOf(manifests, registry, [], table),
  );
  return { manifests, choices, table, libraries };
}

const N = (process.env.REQUIREMENT_COST_N ?? "4,8,16").split(",").map(Number);
const loaded = await Promise.all(N.map(async (n) => [n, await load(n)] as const));

describe("input requirements", () => {
  for (const [n, { manifests, choices, table, libraries }] of loaded) {
    bench(`N=${n}`, () => {
      inputRequirements(manifests, choices, table, libraries);
    });
  }
});
