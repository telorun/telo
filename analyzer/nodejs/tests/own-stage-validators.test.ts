import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { untaggedInterpolationInLibraries, untaggedInterpolationInManifests } from "../src/untagged-interpolation.js";
import { hostPathInputFindings } from "../src/validate-import-host-paths.js";

const manifest = (kind: string, name: string, fields: Record<string, unknown>, module?: string) =>
  ({ kind, metadata: { name, source: "app.yaml", ...(module ? { module } : {}) }, ...fields }) as unknown as ResourceManifest;

describe("untagged interpolation", () => {
  const roots = new Set(["App"]);

  it("judges each declaration of the entry's modules alone", () => {
    const own = manifest("Test.Thing", "own", { text: "a ${{ x }} b" }, "App");
    const foreign = manifest("Test.Thing", "foreign", { text: "${{ x }}" }, "Dependency");
    const found = untaggedInterpolationInManifests([own, foreign], roots);
    expect(found.map((d) => (d.data as { path: string }).path)).toEqual(["text"]);
    expect(untaggedInterpolationInManifests([own], roots)).toHaveLength(1);
  });

  it("reads a library's documents beside the declarations, at the import reaching it", () => {
    const entryImport = { ...manifest("Telo.Import", "Lib", {}, "App"), metadata: { name: "Lib", source: "app.yaml", module: "App", resolvedModuleName: "Library" } } as unknown as ResourceManifest;
    const library = { module: "Library", manifests: [manifest("Test.Thing", "inside", { text: "${{" }, "Library")] };
    expect(untaggedInterpolationInManifests([entryImport], roots)).toEqual([]);
    const found = untaggedInterpolationInLibraries([entryImport], roots, [library as never]);
    expect(found.map((d) => (d.data as { path: string }).path)).toEqual(["source"]);
  });
});

describe("a host-path input an import supplies", () => {
  const importDoc = manifest("Telo.Import", "Lib", {}, "App");
  const declared = { entry: undefined, mediaType: undefined };

  it("is refused where the chain is typed a plain string, whichever source typed it", () => {
    const supplied = makeTaggedSentinel("cel", "variables.dir");
    expect(hostPathInputFindings(importDoc, "variables.root", declared, supplied, () => ({ schema: { type: "string" } })).map((d) => d.code)).toEqual([
      "HOST_PATH_UNTYPED_SOURCE",
    ]);
    expect(hostPathInputFindings(importDoc, "variables.root", declared, supplied, () => ({ schema: { type: "string", "x-telo-type": "Telo.HostPath" } }))).toEqual([]);
    expect(hostPathInputFindings(importDoc, "variables.root", declared, supplied, () => undefined)).toEqual([]);
  });

  it("reads a literal as the import-inputs stage's", () => {
    expect(hostPathInputFindings(importDoc, "variables.root", declared, "relative/dir", () => ({ schema: { type: "string" } }))).toEqual([]);
  });
});
