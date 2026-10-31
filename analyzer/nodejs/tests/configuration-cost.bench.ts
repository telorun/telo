import { bench, describe } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { costApplication, loadGenerated, type CostShape } from "./configuration-cost-fixtures.js";

/**
 * What a configuration costs the analysis: an application of 300 resources
 * analysed with no choice and at 1, 2 and 4 configurations, read off two enum
 * variables. In `isolated` every tenth resource holds a choice and the rest
 * reach nothing that varies; in `reached` every resource reads a dimension.
 * Each declaration's own checks run once per distinct signature, so `isolated`
 * grows by the whole-application passes and its thirty choices alone, while
 * `reached` checks every resource once per configuration.
 *
 * Run: `npx vitest bench --run tests/configuration-cost.bench.ts`.
 */

const sets = async (shape: CostShape) =>
  Promise.all(
    ([0, 1, 2, 4] as const).map(
      async (n) => [n, await loadGenerated(`configuration-cost-${shape}-${n}.yaml`, costApplication(shape, n))] as const,
    ),
  );

for (const shape of ["isolated", "reached"] as const) {
  const loaded = await sets(shape);
  describe(shape, () => {
    for (const [configurations, { manifests, moduleDocuments }] of loaded) {
      bench(
        configurations === 0 ? "no choice" : `${configurations} configuration${configurations > 1 ? "s" : ""}`,
        () => {
          new StaticAnalyzer().analyze(manifests, { moduleDocuments });
        },
        { iterations: 5, warmupIterations: 1 },
      );
    }
  });
}
