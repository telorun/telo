import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { watchUnionBackstop, type UnionBackstop } from "../src/schema-findings-judge.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/**
 * The corpus manifests that refuse a value against a union — the UI spec shapes,
 * the content-part shapes, the nested tagged shape — are decided by the judge
 * from the documents the validator holds: none may take the reporting backstop,
 * which keeps a union undecided with everything raised around it.
 */
const files = [
  ...readdirSync(join(ROOT, "modules/ui/tests/__fixtures__/invalid"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `modules/ui/tests/__fixtures__/invalid/${entry.name}/telo.yaml`),
  "modules/ai/tests/__fixtures__/content-part-shape.yaml",
  "tests/__fixtures__/check-run-agreement/union-tag-shape/telo.yaml",
];

describe("the judge's reporting backstop", () => {
  it.each(files)("is not taken analysing %s", async (file) => {
    const taken: UnionBackstop[] = [];
    const stop = watchUnionBackstop((reason) => taken.push(reason));
    try {
      const { manifests, moduleDocuments, positions } = await loadFile(join(ROOT, file));
      new StaticAnalyzer().analyze(manifests, { moduleDocuments, positions });
    } finally {
      stop();
    }
    expect(taken).toEqual([]);
  }, 120_000);
});
