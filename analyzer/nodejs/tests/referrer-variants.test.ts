import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/**
 * Bindings typed from a resource's referrers are typed by ONE referrer at a
 * time: `row` from one lister never stands beside `to` from the other, so a
 * defect only one referrer's type makes is one finding naming that referrer.
 */
describe("bindings typed from referrers", () => {
  it("report a defect one referrer's type makes once, naming that referrer", async () => {
    const loaded = await loadFile(join(ROOT, "analyzer/nodejs/tests/__fixtures__/referrer-variants/telo.yaml"));
    const findings = new StaticAnalyzer()
      .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments })
      .filter((d) => d.code === "CEL_UNKNOWN_FIELD")
      .map((d) => ({ message: d.message, path: (d.data as { path?: string }).path }));
    expect(findings).toEqual([
      { message: expect.stringMatching(/'to\.a' .*\(as Self\.Lister\/betas references it\)$/), path: "inputs.shown" },
    ]);
  }, 120_000);
});
