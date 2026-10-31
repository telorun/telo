import { bench, describe } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flagSequence, flagTargets, loadGenerated } from "./configuration-cost-fixtures.js";

/**
 * What independent flags cost the analysis, at N = 1, 4, 8 and 16 boolean
 * flags: V, a sequence whose step k chooses on flagK and reads step k-1's
 * result; S, N jobs each declared and started under its own flag, throwing
 * into one shared `catches:`, beside a cycle on flag1 and flag2. Analysed one
 * configuration at a time, each grows with 2^N; the target is linear growth
 * (t(8)/t(4) and t(16)/t(8) at most 2.5).
 *
 * Run: `npx vitest bench --run tests/flag-cost.bench.ts`; `FLAG_COST_N=1,4,8`
 * picks the rows (while the analysis still runs per configuration, N=16 is
 * 65,536 of them).
 */

const N = (process.env.FLAG_COST_N ?? "1,4,8,16").split(",").map(Number);
const fixtures = { V: flagSequence, S: flagTargets } as const;

for (const [fixture, generate] of Object.entries(fixtures)) {
  const loaded = await Promise.all(N.map(async (n) => [n, await loadGenerated(`${fixture}-${n}.yaml`, generate(n))] as const));
  describe(fixture, () => {
    for (const [n, { manifests, moduleDocuments }] of loaded) {
      bench(
        `N=${n}`,
        () => {
          new StaticAnalyzer().analyze(manifests, { moduleDocuments });
        },
        { iterations: 3, warmupIterations: 1 },
      );
    }
  });
}
