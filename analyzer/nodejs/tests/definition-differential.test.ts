import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { familyOf, observeFamilies } from "../src/analysis-families.js";
import { observeBodyFindings, type BodyFindingReport } from "../src/cel-site-judgements.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { frozenDocuments } from "./frozen-documents.js";
import { Loader } from "../src/manifest-loader.js";
import type { ConditionDimension } from "../src/presence-condition.js";
import { TEMPLATE_BODY_FIELDS } from "../src/template-expansion.js";
import type { ManifestSource } from "../src/types.js";
import { loadGenerated, RUN } from "./configuration-cost-fixtures.js";

/**
 * The definition differential: for each definition and each assignment of its
 * own dimensions, the findings the analysis makes inside its body that hold
 * there are the findings a plain analysis makes of that definition with every
 * body choice decided there — by code and written place. Lists a message
 * renders differ by design (a lifted body's lists are its body as written), so
 * messages are not compared. A body holding a repeat is left out: decided, its
 * representative element binds nothing a plain analysis can type.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__/template-definitions");
const fileSource: ManifestSource = {
  supports: (url) => isAbsolute(url),
  async read(url) {
    const file = existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
    return { text: readFileSync(file, "utf8"), source: file };
  },
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

type Loaded = { manifests: ResourceManifest[]; moduleDocuments: unknown };

const placeOf = (d: { code: string; data?: unknown }, path: string) => `${d.code} ${path}`;
const isBodyPath = (path: unknown) => typeof path === "string" && TEMPLATE_BODY_FIELDS.includes(path.split(/[.[]/)[0]!);

/** Every assignment of `dimensions`, or the first values and each single flip. */
function assignmentsOf(dimensions: readonly ConditionDimension[], flips: boolean): Record<string, unknown>[] {
  const first = Object.fromEntries(dimensions.map((d) => [d.key, d.values[0]]));
  if (flips) {
    const out = [first];
    for (const d of dimensions) for (const value of d.values.slice(1)) out.push({ ...first, [d.key]: value });
    return out;
  }
  let out: Record<string, unknown>[] = [{}];
  for (const d of dimensions) out = out.flatMap((partial) => d.values.map((value) => ({ ...partial, [d.key]: value })));
  return out;
}

/** How many assignments it compared. */
function differential(loaded: Loaded, flips: boolean): number {
  const analyzer = new StaticAnalyzer();
  const options = { moduleDocuments: loaded.moduleDocuments as never };
  const { templates, configurations } = analyzer.configurationsOf(loaded.manifests, options);
  if (!templates) return 0;
  const reports: BodyFindingReport[] = [];
  const stop = observeBodyFindings((report) => reports.push(report));
  try {
    analyzer.analyze(loaded.manifests, options);
  } finally {
    stop();
  }
  const configuration = configurations[0] ?? {};
  let compared = 0;
  for (const definition of templates.definitions) {
    // A refused construct stays as written in every decided expansion.
    if (templates.refused.some((r) => r.holder === definition)) continue;
    const name = definition.metadata?.name;
    // Its own dimensions and the configuration dimensions its body reads.
    const dimensions = [...templates.dimensionsOf(definition), ...templates.configurationDimensionsOf(definition)];
    for (const at of assignmentsOf(dimensions, flips)) {
      const local = Object.fromEntries(dimensions.map((d) => [d.definition?.key ?? d.key, at[d.key]]));
      const decided = templates.decidedExpansion(definition, { assignmentOf: () => local });
      const stopFamilies = observeFamilies();
      let found;
      try {
        found = analyzer.analyze(
          loaded.manifests.map((m) => (m === definition ? (decided.definition as ResourceManifest) : m)),
          options,
        );
      } finally {
        stopFamilies();
      }
      const plain = found
        .filter((d) => {
          const data = d.data as { resource?: { kind?: unknown; name?: unknown }; path?: unknown } | undefined;
          // A decided expansion holds no construct and no authored text: what the
          // expansion reader judges as written is not compared.
          if (familyOf(d) === "expansion") return false;
          return data?.resource?.kind === "Telo.Definition" && data.resource.name === name && isBodyPath(data.path);
        })
        .map((d) => placeOf(d, decided.relocate(String((d.data as { path?: unknown }).path))));
      const lifted = reports
        .filter((r) => r.definition === definition && r.live !== undefined && r.space.holds(r.live, { ...configuration, ...at }))
        .map((r) => placeOf(r.diagnostic, String((r.diagnostic.data as { path?: unknown }).path)));
      expect([...new Set(lifted)].sort(), `${String(name)} at ${JSON.stringify(local)}`).toEqual([...new Set(plain)].sort());
      compared++;
    }
  }
  return compared;
}

async function loadFixture(file: string): Promise<Loaded> {
  const graph = await new Loader([fileSource]).loadGraph(join(FIXTURES, file), { desugarImports: true });
  const manifests = flattenForAnalyzer(graph);
  const moduleDocuments = collectModuleDocuments(graph);
  frozenDocuments([manifests, moduleDocuments]);
  return { manifests, moduleDocuments };
}

/** Entry K under `!if self.fK`, holding a type error and a reference to entry
 *  K−1. */
function structuralRow(k: number): string {
  const lines = ["kind: Telo.Library", "metadata: { name: Rows }", "imports:", `  Run: ${RUN}`, "---", "kind: Telo.Definition",
    "metadata: { name: Row }", "capability: Telo.Invocable", "schema:", "  type: object", "  properties:"];
  for (let i = 1; i <= k; i++) lines.push(`    f${i}: { type: boolean }`);
  lines.push("resources:");
  for (let i = 1; i <= k; i++) {
    lines.push("  - !if", `    metadata: { name: e${i} }`, `    if: !cel "self.f${i}"`, "    then:", "      kind: Telo.Sequence",
      "      steps:", `        - { name: a, value: !cel "1 + 'a'" }`);
    if (i > 1) lines.push(`        - { name: b, invoke: !ref e${i - 1} }`);
  }
  lines.push("  - { kind: Telo.Value, metadata: { name: main }, value: 1 }", "invoke: !ref main");
  return `${lines.join("\n")}\n`;
}

describe("a template definition's body findings, against a plain analysis of each way of deciding it", () => {
  const files = ["field-choice.yaml", "servers.yaml", "stamp-in-branch.yaml"];
  it.each(files)("%s", async (file) => {
    expect(differential(await loadFixture(file), false)).toBeGreaterThan(0);
  }, 300_000);

  it("an authored stamp in a body branch is one refusal at its written place, and the differential holds", async () => {
    const loaded = await loadFixture("stamp-in-branch.yaml");
    const found = new StaticAnalyzer()
      .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments as never })
      .filter((d) => d.code === "METADATA_RESERVED_FIELD");
    expect(found.map((d) => (d.data as { path?: unknown }).path)).toEqual(["resources[0].steps[0].invoke.else.metadata.module"]);
    expect(found.map((d) => d.message).filter((m) => /configuration/i.test(m))).toEqual([]);
  }, 300_000);

  it("a body choosing on the definition's own value and a module input together", async () => {
    // Every value of `self.mode` beside every value of `variables.x`.
    expect(differential(await loadFixture("../../../../../tests/__fixtures__/configurations/template-body-input-definition.yaml"), false)).toBe(4);
  }, 300_000);

  it("the structural row at k=16, at the first values and each single flip", async () => {
    const compared = differential(await loadGenerated("definition-differential-row-16.yaml", structuralRow(16)), true);
    // The first values, and one flip of each of the sixteen.
    expect(compared).toBe(17);
  }, 600_000);
});
