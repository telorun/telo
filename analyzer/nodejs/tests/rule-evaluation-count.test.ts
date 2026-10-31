import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeRuleEvaluations, type RuleFamily } from "../src/cel-site-judgements.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

describe("resource rules over configurations", () => {
  for (const fixture of ["resource-rule-resolve-choice.yaml", "resource-rule-function-choice.yaml", "instances-rules.yaml"]) {
    it(`are evaluated at their relation sites and never inside a configuration run: ${fixture}`, async () => {
      const loaded = await loadFile(join(ROOT, "tests/__fixtures__/configurations", fixture));
      const evaluations: Array<[RuleFamily, boolean]> = [];
      const stop = observeRuleEvaluations((family, configurationRun) => evaluations.push([family, configurationRun]));
      try {
        new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
      } finally {
        stop();
      }
      const resource = evaluations.filter(([family]) => family === "resourceRules");
      expect(resource.length).toBeGreaterThan(0);
      expect(resource.filter(([, inRun]) => inRun)).toEqual([]);
    }, 120_000);
  }
});
