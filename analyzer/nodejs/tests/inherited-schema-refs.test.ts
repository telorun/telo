import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/** A `telo://Self/<Type>` a kind inherits in merge form names a shape of the
 *  module that wrote it, not of the inheriting kind's module. */

const FIXTURE = join(ROOT, "analyzer/nodejs/tests/__fixtures__/inherited-schema-refs/telo.yaml");

describe("inherited schema references", () => {
  it("reads an inherited shape in the declaring module, under any import alias", async () => {
    const loaded = await loadFile(FIXTURE);
    const diagnostics = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
    expect(diagnostics.map((d) => `${d.code} ${d.data?.resource?.name}: ${d.message}`)).toEqual([
      "RESOURCE_RULE_VIOLATED holder: Ext.Holder/holder: names an item with no title.",
    ]);
  }, 120_000);
});
