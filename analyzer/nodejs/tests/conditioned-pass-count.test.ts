import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeConditionedPasses, type ConditionedPass } from "../src/cel-site-judgements.js";
import { flagTargets, loadGenerated } from "./configuration-cost-fixtures.js";

const PASSES: ConditionedPass[] = ["duplicateNames", "unusedDeclarations", "sinkAttachment", "observedStateDeclarations"];

describe("the passes that carry presence conditions", () => {
  it("run once over the union and never inside a configuration run: fixture S at N=4", async () => {
    const loaded = await loadGenerated("conditioned-pass-S-4.yaml", flagTargets(4));
    const runs: Array<[ConditionedPass, boolean]> = [];
    const stop = observeConditionedPasses((pass, configurationRun) => runs.push([pass, configurationRun]));
    try {
      new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
    } finally {
      stop();
    }
    for (const pass of PASSES) {
      expect(runs.filter(([name]) => name === pass)).toEqual([[pass, false]]);
    }
  }, 120_000);
});
