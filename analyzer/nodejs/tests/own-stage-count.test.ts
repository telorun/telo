import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { OWN_STAGES, type OwnStage } from "../src/analysis-families.js";
import { observeOwnStages } from "../src/cel-site-judgements.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flagTargets, loadGenerated } from "./configuration-cost-fixtures.js";

/** How often each per-declaration own stage is evaluated while `analyze` runs,
 *  and whether any evaluation ran inside a configuration run. */
function stageEvaluations(analyze: () => void): { counts: Map<OwnStage, number>; inRuns: OwnStage[] } {
  const counts = new Map<OwnStage, number>();
  const inRuns: OwnStage[] = [];
  const stop = observeOwnStages((stage, configurationRun) => {
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
    if (configurationRun) inRuns.push(stage);
  });
  try {
    analyze();
  } finally {
    stop();
  }
  return { counts, inRuns };
}

describe("the per-declaration own stages", () => {
  it("are evaluated once per key of a declaration's own region and in no run: fixture S at N=1, 4 and 8 — linear in its choices, not in its configurations", async () => {
    const totals: number[] = [];
    for (const n of [1, 4, 8]) {
      const loaded = await loadGenerated(`own-stage-count-S-${n}.yaml`, flagTargets(n));
      const { counts, inRuns } = stageEvaluations(() => new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments }));
      expect(inRuns).toEqual([]);
      // Every stage judges the same keys' declarations.
      const evaluated = new Set(OWN_STAGES.filter((stage) => counts.has(stage)).map((stage) => counts.get(stage)));
      expect(evaluated.size).toBe(1);
      for (const stage of ["kindSite", "includePlacement", "untaggedInterpolation", "importInputs", "importAndSinkLogging", "callableInstances", "valueTypeSlots", "contractInputsForm", "textKeysPlacement"] as const) {
        expect(counts.get(stage), `${stage} at N=${n}`).toBeGreaterThan(0);
      }
      totals.push([...evaluated][0]!);
    }
    // 2, 16 and 256 configurations: the keys grow by one choice's worth each.
    expect((totals[2]! - totals[1]!) / 4).toBe((totals[1]! - totals[0]!) / 3);
  }, 240_000);
});

describe("a named shape's own reference-slot checks", () => {
  it("are evaluated per key of the shape's own region and in no run", async () => {
    const text = readFileSync(fileURLToPath(new URL("../../../tests/__fixtures__/configurations/shape-ref-slot-choice.yaml", import.meta.url)), "utf8");
    const loaded = await loadGenerated("own-stage-count-shape.yaml", text);
    const { counts, inRuns } = stageEvaluations(() => new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments }));
    expect(inRuns).toEqual([]);
    expect(counts.get("shapeRefSlots")).toBeGreaterThan(0);
  }, 60_000);
});
