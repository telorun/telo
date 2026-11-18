import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeDocumentStages } from "../src/cel-site-judgements.js";
import { loadGenerated } from "./configuration-cost-fixtures.js";

/** A library keying its inputs for a host, listing a non-string export, and
 *  declaring a value under a choice its own variable decides. */
const LIBRARY = `
kind: Telo.Library
metadata: { name: BlockLib }
variables:
  flag: { type: boolean, default: false, env: FLAG }
  other: { type: string, arg: other }
exports:
  resources: [shown, { name: written }]
---
kind: Telo.Value
metadata: { name: shown }
value: !if
  if: !cel "variables.flag"
  then: 1
  else: 2
`;

describe("a library's own blocks", () => {
  it("refuse a host key and a non-string export once, in no configuration run", async () => {
    const loaded = await loadGenerated("library-block-stages.yaml", LIBRARY);
    const stages: string[] = [];
    const inRuns: string[] = [];
    const stop = observeDocumentStages((stage, configurationRun) => {
      if (stage !== "libraryBlocks") return;
      stages.push(stage);
      if (configurationRun) inRuns.push(stage);
    });
    let found;
    try {
      found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments, positions: loaded.positions });
    } finally {
      stop();
    }
    expect(stages).toHaveLength(1);
    expect(inRuns).toEqual([]);
    expect(found.filter((d) => ["LIBRARY_ENV_KEY_REJECTED", "LIBRARY_ARG_KEY_REJECTED", "INVALID_EXPORT"].includes(String(d.code))).map((d) => [d.code, (d.data as { path?: string }).path])).toEqual([
      ["LIBRARY_ENV_KEY_REJECTED", "variables.flag.env"],
      ["LIBRARY_ARG_KEY_REJECTED", "variables.other.arg"],
      ["INVALID_EXPORT", "exports.resources.1"],
    ]);
  }, 60_000);
});
