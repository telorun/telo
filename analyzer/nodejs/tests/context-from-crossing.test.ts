import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { contextFromReads } from "../src/validate-cel-context.js";
import { loadFile, ROOT } from "./configuration-corpus.js";

/**
 * `x-telo-context-from` read from the object holding the region, crossing the
 * reference sites on the way: a value at a reference site is the type it names,
 * any other value a property map — a map key named like a schema keyword
 * included.
 */
describe("x-telo-context-from across references", () => {
  it("types each binding from where its path lands", async () => {
    const loaded = await loadFile(join(ROOT, "analyzer/nodejs/tests/__fixtures__/context-from-crossing/telo.yaml"));
    const findings = new StaticAnalyzer()
      .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments, positions: loaded.positions })
      .filter((d) => d.severity === 1)
      .map((d) => `${d.code} ${(d.data as { path?: string } | undefined)?.path}: ${d.message}`);
    expect(findings).toEqual([
      "CEL_UNKNOWN_FIELD sections[0].show: Acme.Panel/misses: !cel: 'params.typo' is not defined (available: type, properties)",
      "CEL_UNKNOWN_FIELD sections[1].show: Acme.Panel/misses: !cel: 'record.nmae' is not defined (available: name)",
      "CEL_UNKNOWN_FIELD sections[2].show: Acme.Panel/misses: !cel: 'params.any' is not defined (available: none)",
      "CEL_UNKNOWN_FIELD sections[3].show: Acme.Panel/misses: !cel: 'own.typo' is not defined (available: type)",
      "CEL_UNKNOWN_FIELD primary.show: Acme.Panel/misses: !cel: 'params.other' is not defined (available: none)",
    ]);
  }, 120_000);

  it("reads the reference on the holder and, onward, the rest of the path in each declaration crossed", () => {
    const places = contextFromReads({
      value: "reader/params",
      node: {},
      at: ["sections", 0, "show"],
      item: ["sections", 0],
      delegate: () => [],
      definition: undefined,
      projectionDeclarer: undefined,
    });
    expect(
      places.map((place) =>
        place.kind === "reference"
          ? { keys: place.keys, transitive: place.transitive, reads: place.reads({} as never).map((read) => ("keys" in read ? read.keys : read.kind)) }
          : place,
      ),
    ).toEqual([
      { keys: ["sections", 0, "reader", "params"], transitive: false, reads: [] },
      { keys: ["sections", 0, "reader"], transitive: true, reads: [["params"]] },
    ]);
  });
});
