import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/**
 * A bare reference a rule reads past resolves from the module that wrote it,
 * even where another module declares the same name: `Lib.entry`'s `!ref posts`
 * is the library's `posts`, never the application's, and never nothing.
 */
describe("a reference a rule reads past", () => {
  it("names the declaration of the module that wrote it", async () => {
    const loaded = await loadFile(join(ROOT, "analyzer/nodejs/tests/__fixtures__/rule-reference-module/telo.yaml"));
    const findings = new StaticAnalyzer()
      .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments })
      .filter((d) => d.code.startsWith("RESOURCE_RULE_"))
      .map((d) => `${d.code} ${d.message}`);
    expect(findings).toEqual([]);
  }, 120_000);
});
