import type { ArtifactLayer } from "@telorun/analyzer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeFilesIntegrity, type PayloadFile } from "../src/bundle/files-integrity.js";
import { materializeStoredLayer, readStoredLayer, storedLayerDirectory } from "../src/bundle/layer-store.js";

let cacheRoot: string;

beforeEach(() => {
  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telo-layer-store-"));
});

afterEach(() => {
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

async function recordLayer(text: string, blobChar: string): Promise<{ layer: ArtifactLayer; files: PayloadFile[] }> {
  const files: PayloadFile[] = [{ name: "sbom.cdx.json", content: Buffer.from(text) }];
  return {
    files,
    layer: { role: "sbom", blob: `sha256:${blobChar.repeat(64)}`, integrity: await computeFilesIntegrity(files) },
  };
}

describe("the layer store", () => {
  it("keeps two modules' records apart by blob, and fetches again a copy that no longer verifies", async () => {
    // An owner and a nested file manifest share one module directory; each has
    // a record at the same in-layer path.
    const owner = await recordLayer('{"owner":true}\n', "a");
    const nested = await recordLayer('{"nested":true}\n', "b");
    const fetched: string[] = [];
    const transports = {
      fetchLayer: async (_ref: string, blob: string) => {
        fetched.push(blob);
        return blob === owner.layer.blob ? owner.files : nested.files;
      },
    };
    const store = (layer: ArtifactLayer) =>
      materializeStoredLayer({ cacheRoot, pinnedRef: "oci://registry.example/acme/app@1.0.0", layer, transports });

    const first = await store(owner.layer);
    const second = await store(nested.layer);
    expect(first.dir).toBe(storedLayerDirectory(cacheRoot, owner.layer.blob));
    expect(first.dir).toBe(path.join(cacheRoot, "layers", `sha256-${"a".repeat(64)}`));
    expect(fs.readFileSync(path.join(first.dir, "sbom.cdx.json"), "utf8")).toBe('{"owner":true}\n');
    expect(fs.readFileSync(path.join(second.dir, "sbom.cdx.json"), "utf8")).toBe('{"nested":true}\n');
    expect(fs.readdirSync(path.join(cacheRoot, "layers")).sort()).toEqual([
      `sha256-${"a".repeat(64)}`,
      `sha256-${"b".repeat(64)}`,
    ]);

    await store(owner.layer);
    expect(fetched).toEqual([owner.layer.blob, nested.layer.blob]);

    fs.writeFileSync(path.join(first.dir, "sbom.cdx.json"), '{"own');
    await store(owner.layer);
    expect(fetched).toEqual([owner.layer.blob, nested.layer.blob, owner.layer.blob]);
    expect(fs.readFileSync(path.join(first.dir, "sbom.cdx.json"), "utf8")).toBe('{"owner":true}\n');
  });

  it("never writes or removes in a sealed root, and fetches into the working root instead", async () => {
    const record = await recordLayer('{"owner":true}\n', "c");
    const sealedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telo-layer-sealed-"));
    try {
      const sealedDir = storedLayerDirectory(sealedRoot, record.layer.blob);
      fs.mkdirSync(sealedDir, { recursive: true });
      fs.writeFileSync(path.join(sealedDir, "sbom.cdx.json"), '{"edited":true}\n');

      expect(await readStoredLayer(sealedRoot, record.layer, { removeStale: false })).toBeUndefined();
      expect(fs.existsSync(sealedDir)).toBe(true);

      const fetched: string[] = [];
      const stored = await materializeStoredLayer({
        cacheRoot,
        sealedRoot,
        pinnedRef: "oci://registry.example/acme/app@1.0.0",
        layer: record.layer,
        transports: { fetchLayer: async (_ref: string, blob: string) => (fetched.push(blob), record.files) },
      });
      expect(fetched).toEqual([record.layer.blob]);
      expect(stored.dir).toBe(storedLayerDirectory(cacheRoot, record.layer.blob));
      expect(fs.readFileSync(path.join(sealedDir, "sbom.cdx.json"), "utf8")).toBe('{"edited":true}\n');
    } finally {
      fs.rmSync(sealedRoot, { recursive: true, force: true });
    }
  });
});
