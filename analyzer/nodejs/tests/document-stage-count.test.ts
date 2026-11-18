import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DOCUMENT_STAGES, type DocumentStage } from "../src/analysis-families.js";
import { observeDocumentStages } from "../src/cel-site-judgements.js";
import { flagTargets, loadGenerated } from "./configuration-cost-fixtures.js";

const KIND_STAGES: DocumentStage[] = ["libraryRequires", "kindHostPathDefaults", "controllerSelectors", "schemaCompile", "extends", "baseMapping", "providerCoherence", "callableKinds", "kindMetadata", "bodyReferenceForms", "kindCapability", "kindRefSlots", "kindSlotAnnotations", "kindZoneSlots", "kindRules", "kindValueTypes", "kindAnnotations", "kindContracts"];
const MODULE_STAGES = DOCUMENT_STAGES.filter((stage) => !KIND_STAGES.includes(stage) && stage !== "scopedKindDocuments");


/** How often each document-level stage is evaluated while `analyze` runs, and
 *  whether any evaluation ran inside a configuration run. */
function stageEvaluations(analyze: () => void): { counts: Map<DocumentStage, number>; inRuns: DocumentStage[] } {
  const counts = new Map<DocumentStage, number>();
  const inRuns: DocumentStage[] = [];
  const stop = observeDocumentStages((stage, configurationRun) => {
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
    if (configurationRun) inRuns.push(stage);
  });
  try {
    analyze();
  } finally {
    stop();
  }
  return { counts, inRuns };
}

describe("the document-level stages", () => {
  it("are evaluated once for the kind documents and once per key of the module document, in no run, however many configurations: fixture S at N=1, 4 and 8", async () => {
    const seen: string[] = [];
    for (const n of [1, 4, 8]) {
      const loaded = await loadGenerated(`document-stage-count-S-${n}.yaml`, flagTargets(n));
      const { counts, inRuns } = stageEvaluations(() => new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments }));
      expect(inRuns).toEqual([]);
      for (const stage of KIND_STAGES) expect(counts.get(stage), stage).toBe(1);
      for (const stage of MODULE_STAGES) expect(counts.get(stage), stage).toBe(1);
      seen.push(JSON.stringify(DOCUMENT_STAGES.map((stage) => [stage, counts.get(stage) ?? 0])));
    }
    expect(new Set(seen).size).toBe(1);
  }, 240_000);
});
