import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/**
 * An `x-telo-context-ref-from` subpath crossing reference slots
 * (`source/collection/model`): each map entry's `row` is a record of the model
 * its own source's collection names, read in the module that wrote each hop and
 * with `extends` folded — the first hop included when it names another
 * module's declaration (`!ref Lib.libAuthorsSource`).
 */
describe("x-telo-context-ref-from across references", () => {
  it("types each entry's binding from the shape its references reach", async () => {
    const loaded = await loadFile(join(ROOT, "analyzer/nodejs/tests/__fixtures__/context-ref-crossing/telo.yaml"));
    const findings = new StaticAnalyzer()
      .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments })
      .filter((d) => d.code.startsWith("CEL_"))
      .map((d) => `${d.code} ${(d.data as { resource?: { name?: string } } | undefined)?.resource?.name} ${(d.data as { path?: string } | undefined)?.path}: ${d.message}`);
    expect(findings).toEqual([
      "CEL_UNKNOWN_FIELD misses relations.authorId.label: Kinds.Presentation/misses: !cel: 'row.handle' is not defined (available: id, name)",
      "CEL_UNKNOWN_FIELD misses relations.reviewerId.label: Kinds.Presentation/misses: !cel: 'row.name' is not defined (available: handle, id)",
      "CEL_UNKNOWN_FIELD misses relations.publisherId.label: Kinds.Presentation/misses: !cel: 'row.handle' is not defined (available: id, name)",
    ]);
  }, 120_000);
});
