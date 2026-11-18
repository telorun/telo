import { bench, describe } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { loadGenerated, paddingRow } from "./configuration-cost-fixtures.js";

/**
 * What a template definition costs beside others: P definitions, each with two
 * structural choices in its body. The time per definition stays the same
 * however many stand beside it — `structural-choice-cost.test.ts` asserts it
 * at P = 0/50/200; this times P = 0/100/1000.
 *
 * Run: `npx vitest bench --run tests/definition-padding-cost.bench.ts`.
 */

const sets = await Promise.all(
  [0, 100, 1000].map(async (p) => [p, await loadGenerated(`definition-padding-cost-${p}.yaml`, paddingRow(p))] as const),
);

describe("definitions beside one another", () => {
  for (const [p, set] of sets) {
    bench(`${p} definitions`, () => {
      new StaticAnalyzer().analyze(set.manifests, { moduleDocuments: set.moduleDocuments });
    }, { iterations: 1, warmupIterations: 0 });
  }
});
