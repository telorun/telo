import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { importReach } from "../src/reaching-import.js";

const importDoc = (owner: string, alias: string, target: string, source: string) =>
  ({
    kind: "Telo.Import",
    metadata: {
      name: alias,
      module: owner,
      source: `file:///${owner}/telo.yaml`,
      resolvedModuleName: target,
      resolvedSource: source,
    },
  }) as unknown as ResourceManifest;

/** App imports Wrap (which imports Lib, which imports Leaf) and then Lib
 *  directly; Lib v1 is a version reconciliation replaced, so no import names it. */
const manifests = [
  { kind: "Telo.Application", metadata: { name: "App" } } as unknown as ResourceManifest,
  importDoc("App", "First", "Wrap", "file:///wrap/telo.yaml"),
  importDoc("App", "Second", "Lib", "file:///lib-2/telo.yaml"),
  importDoc("Wrap", "Inner", "Lib", "file:///lib-2/telo.yaml"),
  importDoc("Lib", "Deep", "Leaf", "file:///leaf/telo.yaml"),
];
const reach = importReach(manifests, new Set(["App"]));

describe("the entry's import reaching a dependency", () => {
  it("is the first entry import whose closure reaches it, however deep", () => {
    const first = { alias: "First", filePath: "file:///App/telo.yaml", path: "imports.First" };
    expect(reach.of("Wrap")).toEqual(first);
    expect(reach.of("Lib")).toEqual(first);
    expect(reach.of("Leaf")).toEqual(first);
    expect(reach.of("App")).toBeUndefined();
  });

  it("loads only the documents an import reaches by source", () => {
    expect(reach.loads({ module: "Lib", sourceId: "file:///lib-2/telo.yaml" })).toBe(true);
    expect(reach.loads({ module: "Lib", sourceId: "file:///lib-1/telo.yaml" })).toBe(false);
    expect(reach.loads({ module: "Unreached", sourceId: "file:///unreached/telo.yaml" })).toBe(false);
  });
});
