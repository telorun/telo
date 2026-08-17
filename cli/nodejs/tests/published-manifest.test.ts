import { OciTransport, injectLayerIndex, makeTarGz, readOwnerManifest } from "@telorun/kernel";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

/**
 * The published `telo.yaml` must be the manifest the payload builder produced.
 *
 * A dependent's import pin is a hash of its dependency's published manifest,
 * derived locally from that dependency's own bytes. While the `layers:` index
 * was injected during the push, the two were different documents for every
 * module shipping a payload — so the pin named bytes no registry holds, and 18
 * standard-library modules could not resolve their own dependencies at load.
 * Neither the payload-drift gate (which compares layer digests, unmoved by
 * injection) nor the ledger (whose manifest digest was pre-injection on both
 * sides) could see it.
 *
 * The property that closes it has two halves, one per test below: the index is
 * derivable before anything is pushed, and it is derivable *repeatably*.
 */
describe("published manifest", () => {
  const layers = [
    {
      role: "library" as const,
      selector: { format: "js" },
      files: [{ name: "nodejs/sql.mjs", content: Buffer.from("export const x = 1;\n") }],
    },
  ];

  it("frames a layer to the same bytes every time", async () => {
    const once = await makeTarGz([{ name: "a.js", content: "console.log(1)\n" }]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const again = await makeTarGz([{ name: "a.js", content: "console.log(1)\n" }]);
    // Not merely equal digests: identical archives. A header carrying the wall
    // clock is what made a locally predicted `blob` disagree with the pushed one.
    expect(again.equals(once)).toBe(true);
  });

  it("indexes a layer by the digest its blob will be pushed under", async () => {
    const index = await new OciTransport().layerIndex(layers);
    const tar = await makeTarGz(
      layers[0].files.map((f) => ({ name: f.name, content: Buffer.from(f.content) })),
    );
    expect(index).toHaveLength(1);
    expect(index[0].blob).toBe(`sha256:${createHash("sha256").update(tar).digest("hex")}`);
    expect(index[0].role).toBe("library");
    expect(index[0].selector).toEqual({ format: "js" });
  });

  it("carries the index in the bytes an importer pins", async () => {
    const built = "kind: Telo.Library\nmetadata:\n  name: Sql\n  version: 1.0.0\n";
    const index = await new OciTransport().layerIndex(layers);
    const published = injectLayerIndex(built, index);

    // What a dependent hashes is the published text, so the index has to be in
    // it — the pin is over these bytes, not over `built`.
    expect(published).not.toBe(built);
    expect(readOwnerManifest(published).layers).toEqual(index);
  });

  it("leaves a manifest-only module's bytes untouched", async () => {
    expect(await new OciTransport().layerIndex([])).toEqual([]);
    // No index, so nothing is injected and the pin was always correct for these
    // — which is why manifest-only modules were the ones that kept resolving.
    expect(await new OciTransport().layerIndex([{ role: "common", files: [] }])).toEqual([]);
  });
});
