import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { RELATION_STAGES, type RelationStage } from "../src/analysis-families.js";
import { observeRelationStages } from "../src/cel-site-judgements.js";
import { flagTargets, loadGenerated } from "./configuration-cost-fixtures.js";

/** How often each per-declaration relational stage is evaluated while
 *  `analyze` runs, and whether any evaluation ran inside a configuration run. */
function stageEvaluations(analyze: () => void): { counts: Map<RelationStage, number>; inRuns: RelationStage[] } {
  const counts = new Map<RelationStage, number>();
  const inRuns: RelationStage[] = [];
  const stop = observeRelationStages((stage, configurationRun) => {
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

describe("the per-declaration relational stages", () => {
  it("are evaluated once per relation key and in no run: fixture S at N=1, 4 and 8 — linear in its choices, not in its configurations", async () => {
    const totals: number[] = [];
    for (const n of [1, 4, 8]) {
      const loaded = await loadGenerated(`relation-stage-count-S-${n}.yaml`, flagTargets(n));
      const { counts, inRuns } = stageEvaluations(() => new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments }));
      expect(inRuns).toEqual([]);
      expect(counts.get("stepInvokes"), `stepInvokes at N=${n}`).toBeGreaterThan(0);
      for (const stage of counts.keys()) expect(RELATION_STAGES).toContain(stage);
      totals.push(counts.get("stepInvokes")!);
    }
    // 2, 16 and 256 configurations: the keys grow by one choice's worth each.
    expect((totals[2]! - totals[1]!) / 4).toBe((totals[1]! - totals[0]!) / 3);
  }, 240_000);
});
