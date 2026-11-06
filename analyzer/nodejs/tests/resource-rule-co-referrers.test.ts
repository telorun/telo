import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/** A resource rule's `coReferrers:` — the other declarations the rule judges
 *  whose slot at the pointer names the declaration `self`'s does. */

const FIXTURES = join(ROOT, "analyzer/nodejs/tests/__fixtures__/resource-rule-co-referrers");

async function findings(file: string): Promise<string[]> {
  const loaded = await loadFile(join(FIXTURES, file));
  return new StaticAnalyzer()
    .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments })
    .filter((d) => d.code.startsWith("RESOURCE_RULE_"))
    .map((d) => `${d.code} ${d.data?.resource?.name} ${(d.data as { path?: string }).path ?? ""}`.trimEnd())
    .sort();
}

describe("resource rules — coReferrers", () => {
  it("binds the declarations reaching the same target through the slot, a rule-inheriting child included", async () => {
    // `distinct` and `elsewhere` share a name with nobody on their bucket, and
    // `renamed` (a `base:` child) is judged by no rule of its parent.
    expect(await findings("telo.yaml")).toEqual([
      "RESOURCE_RULE_INVALID ByField schema.x-telo-resource-rules[0].coReferrers",
      "RESOURCE_RULE_INVALID ByList schema.x-telo-resource-rules[0].coReferrers",
      "RESOURCE_RULE_VIOLATED first",
      "RESOURCE_RULE_VIOLATED second",
    ]);
  }, 120_000);

  it("skips, rather than passes, where the slot names a library's kind-only input", async () => {
    expect(await findings("input/telo.yaml")).toEqual([
      "RESOURCE_RULE_SKIPPED first bucket",
      "RESOURCE_RULE_SKIPPED second bucket",
    ]);
  }, 120_000);
});
