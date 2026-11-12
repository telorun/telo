import { join } from "node:path";
import { expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

it("types a value-schema location by a field an ancestor in another module declares", async () => {
  const loaded = await loadFile(join(ROOT, "analyzer/nodejs/tests/__fixtures__/value-schema-inherited/imported.yaml"));
  const findings = new StaticAnalyzer()
    .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments })
    .filter((d) => d.code === "VALUE_SCHEMA_FROM_INVALID");
  expect(findings).toEqual([]);
});
