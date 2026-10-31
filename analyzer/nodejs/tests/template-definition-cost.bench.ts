import { bench, describe } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { costLibrary, loadGenerated } from "./configuration-cost-fixtures.js";

/**
 * What a template definition's body costs its check with no consumer: a body of
 * N entries, each holding one open field-value `!if` that reads no reference,
 * beside one declaration-position `!if` over an enum. The body is expanded once
 * per structural assignment (two) and each entry once per assignment of what it
 * reads, so the time grows with N, never with 2^N.
 *
 * Run: `npx vitest bench --run tests/template-definition-cost.bench.ts`.
 */

const sets = await Promise.all(
  [1, 8, 16].map(async (n) => [n, await loadGenerated(`template-definition-cost-${n}.yaml`, costLibrary(n))] as const),
);

describe("template definition check", () => {
  for (const [n, set] of sets) {
    bench(`${n} open choices`, () => {
      new StaticAnalyzer().analyze(set.manifests, { moduleDocuments: set.moduleDocuments });
    });
  }
});
