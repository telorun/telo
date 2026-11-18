import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeDocumentStages } from "../src/cel-site-judgements.js";
import { observeShapeVerdicts } from "../src/named-shape-reader.js";
import { loadGenerated } from "./configuration-cost-fixtures.js";

function flags(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `  flag${i + 1}: { env: FLAG_${i + 1}, type: boolean, default: false }`);
}

/**
 * An abstract whose output holds two members, each one of a chain of `k`
 * shapes or nothing, every link reached as an alternative and varying under a
 * choice of its own; `kinds` implementations name, for both members, one chain
 * that holds an integer at its end where the abstract's holds a string.
 */
function contractChain(k: number, kinds: number): string {
  const lines = ["kind: Telo.Application", "metadata: { name: ContractChain }", "variables:", ...flags(k)];
  for (let i = 1; i <= k; i++) {
    const then = i === k ? "{ type: string }" : `{ anyOf: [{ $ref: "telo://Self/S${i + 1}" }, { type: "null" }] }`;
    lines.push(
      "---",
      "kind: Telo.JsonSchema",
      `metadata: { name: S${i} }`,
      "schema:",
      "  type: object",
      "  required: [next]",
      "  properties:",
      "    next: !if",
      `      if: !cel "variables.flag${i}"`,
      `      then: ${then}`,
      "      else: {}",
    );
    const own = i === k ? "{ type: integer }" : `{ $ref: "telo://Self/T${i + 1}" }`;
    lines.push("---", "kind: Telo.JsonSchema", `metadata: { name: T${i} }`, `schema: { type: object, required: [next], properties: { next: ${own} } }`);
  }
  lines.push(
    "---",
    "kind: Telo.Abstract",
    "metadata: { name: Step }",
    "capability: Telo.Invocable",
    "outputType:",
    "  type: object",
    "  required: [v, w]",
    "  properties:",
    `    v: { anyOf: [{ $ref: "telo://Self/S1" }, { type: "null" }] }`,
    `    w: { anyOf: [{ $ref: "telo://Self/S1" }, { type: "null" }] }`,
  );
  for (let j = 1; j <= kinds; j++) {
    lines.push(
      "---",
      "kind: Telo.Definition",
      `metadata: { name: Impl${j} }`,
      "extends: Self.Step",
      "capability: Telo.Invocable",
      `controllers: [pkg:telo/local/js?path=./probe.mjs#Impl${j}]`,
      `outputType: { type: object, required: [v, w], properties: { v: { $ref: "telo://Self/T1" }, w: { $ref: "telo://Self/T1" } } }`,
    );
  }
  return lines.join("\n") + "\n";
}

describe("a kind's contract compared through named shapes", () => {
  it("judges each pair of a chain of k shapes reached as alternatives once, in a count linear in k, however many unions and kinds reach it, in no run: k=1, 4 and 8", async () => {
    const counts: number[] = [];
    for (const k of [1, 4, 8]) {
      const loaded = await loadGenerated(`contract-chain-${k}.yaml`, contractChain(k, 2));
      const evaluated: boolean[] = [];
      const stopStages = observeDocumentStages((stage, configurationRun) => {
        if (stage === "kindContracts") evaluated.push(configurationRun);
      });
      const judged: string[] = [];
      const stopVerdicts = observeShapeVerdicts((kind, key) => {
        if (kind === "contractCompat") judged.push(key);
      });
      let found: ReturnType<StaticAnalyzer["analyze"]> = [];
      try {
        found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
      } finally {
        stopVerdicts();
        stopStages();
      }
      expect(evaluated).toEqual([false]);
      // Every content read is a judgement, and none is read twice: the
      // fixpoints combine what the judgements hold.
      expect(new Set(judged).size).toBe(judged.length);
      counts.push(judged.length);
      // The chains disagree only at their ends, reached where every link is.
      const all = Object.fromEntries(Array.from({ length: k }, (_, i) => [`variables.flag${i + 1}`, true]));
      const refused = found.filter((d) => d.code === "CONTRACT_NOT_SUBSTITUTABLE");
      expect(refused.length).toBeGreaterThan(0);
      for (const d of refused) {
        const configurations = (d.data as { configurations?: Record<string, unknown>[] }).configurations;
        expect(configurations, d.message).toBeDefined();
        for (const configuration of configurations!) expect(configuration).toMatchObject(all);
      }
    }
    // Each kind's own comparison, then the same pairs per link whichever of the
    // two members and two kinds reaches them.
    expect(counts).toEqual([6, 18, 34]);
  }, 240_000);
});
