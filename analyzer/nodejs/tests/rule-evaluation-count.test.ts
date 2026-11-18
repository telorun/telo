import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeRuleEvaluations, type RuleFamily } from "../src/cel-site-judgements.js";
import { loadFile, ROOT } from "./configuration-corpus.js";
import { flagTargets, loadGenerated } from "./configuration-cost-fixtures.js";

/** Every rule evaluation the analysis of `loaded` makes, by family and by
 *  whether a configuration run made it. */
function evaluationsOf(loaded: Awaited<ReturnType<typeof loadFile>>): Array<[RuleFamily, boolean]> {
  const evaluations: Array<[RuleFamily, boolean]> = [];
  const stop = observeRuleEvaluations((family, configurationRun) => evaluations.push([family, configurationRun]));
  try {
    new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
  } finally {
    stop();
  }
  return evaluations;
}

describe("rules over configurations", () => {
  const fixtures: Array<[RuleFamily, string]> = [
    ["resourceRules", "resource-rule-resolve-choice.yaml"],
    ["resourceRules", "resource-rule-function-choice.yaml"],
    ["resourceRules", "instances-rules.yaml"],
    ["referrerRules", "referrer-rule-resolve-choice.yaml"],
    ["referrerRules", "referrer-rule-peers-choice.yaml"],
    ["referrerRules", "referrer-rule-self-choice.yaml"],
    ["referrerRules", "referrer-rule-co-referrers-choice.yaml"],
  ];
  for (const [family, fixture] of fixtures) {
    it(`are evaluated at their relation sites and never inside a configuration run: ${family}, ${fixture}`, async () => {
      const evaluations = evaluationsOf(await loadFile(join(ROOT, "tests/__fixtures__/configurations", fixture)));
      const judged = evaluations.filter(([each]) => each === family);
      expect(judged.length).toBeGreaterThan(0);
      expect(evaluations.filter(([, inRun]) => inRun)).toEqual([]);
    }, 120_000);
  }

  it("are never evaluated inside a configuration run: fixture S at N=4", async () => {
    const evaluations = evaluationsOf(await loadGenerated("rule-evaluation-S-4.yaml", flagTargets(4)));
    expect(evaluations.filter(([, inRun]) => inRun)).toEqual([]);
  }, 120_000);
});
