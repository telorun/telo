import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/**
 * A rule reading past an exported declaration continues through the references
 * that declaration writes, resolved in its own library — into declarations the
 * library does not export, a hop and two hops out — and never into the
 * application's declaration that shares the name. The library spells the kind
 * through an alias of its own.
 */
describe("a rule reading through a library's own declarations", () => {
  it("binds what the library keeps to itself and judges it", async () => {
    const loaded = await loadFile(join(ROOT, "analyzer/nodejs/tests/__fixtures__/rule-library-private/telo.yaml"));
    const findings = new StaticAnalyzer()
      .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments })
      .filter((d) => d.code.startsWith("RESOURCE_RULE_"))
      .map((d) => `${d.code} ${(d.data as { rule?: string } | undefined)?.rule} ${d.data?.resource?.name}`);
    expect(findings).toEqual([
      "RESOURCE_RULE_VIOLATED SECOND_HOP_BAD holder",
      "RESOURCE_RULE_VIOLATED THIRD_HOP_BAD holder",
    ]);
  }, 120_000);
});
