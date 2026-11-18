import { bench, describe } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { bodyInputRow, costLibrary, loadGenerated } from "./configuration-cost-fixtures.js";

/**
 * What a template definition's body costs its check with no consumer: a body of
 * N entries, each holding one open field-value `!if` that reads no reference,
 * beside one declaration-position `!if` over an enum. The body is read once,
 * lifted over one dimension per choice, so the time grows with the body, never
 * with 2^N; with the body held at 16 entries and N of them choosing, it is the
 * same whatever N is.
 *
 * The last row is N definitions, each body choosing on a module input nothing
 * outside a body reads: one configuration dimension per definition, so until the
 * per-configuration loop is deleted it grows as 2^N.
 *
 * Run: `npx vitest bench --run tests/template-definition-cost.bench.ts`.
 */

const load = (name: string, text: string) => loadGenerated(name, text);
const growing = await Promise.all(
  [1, 8, 16].map(async (n) => [n, await load(`template-definition-cost-${n}.yaml`, costLibrary(n))] as const),
);
const fixed = await Promise.all(
  [1, 8, 16].map(async (n) => [n, await load(`template-definition-cost-${n}-of-16.yaml`, costLibrary(n, 16))] as const),
);
const inputs = await Promise.all(
  [1, 2, 4, 8].map(async (n) => [n, await load(`template-definition-inputs-${n}.yaml`, bodyInputRow(n))] as const),
);

const analyze = (set: Awaited<ReturnType<typeof loadGenerated>>) => () => {
  new StaticAnalyzer().analyze(set.manifests, { moduleDocuments: set.moduleDocuments });
};

describe("template definition check", () => {
  for (const [n, set] of growing) bench(`${n} open choices`, analyze(set));
});

describe("template definition check, a body of 16 entries", () => {
  for (const [n, set] of fixed) bench(`${n} open choices`, analyze(set));
});

describe("template definitions choosing on module inputs", () => {
  for (const [n, set] of inputs) bench(`${n} definitions`, analyze(set), { iterations: 1, warmupIterations: 0 });
});
