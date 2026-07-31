import type { ArtifactLayer } from "@telorun/analyzer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeFilesIntegrity, type PayloadFile } from "../src/bundle/files-integrity.js";
import { ModuleArtifact } from "../src/bundle/module-artifact.js";
import { BundleControllerLoader } from "../src/controller-loaders/bundle-loader.js";
import type { TransportRegistry } from "../src/transports/transport-registry.js";

/**
 * The resolve source is what the CLI's progress trail keys on, so it has to name
 * what the resolve actually cost. Reporting `bundle` for a layer already on disk
 * put a line on screen for every bundled controller on every warm start.
 */
describe("BundleControllerLoader resolve source", () => {
  const REF = "oci://reg.test/acme/demo@1.0.0#sha256-abc";
  const PURL = "pkg:telo/local/js?path=./nodejs/c.mjs#create";
  const CONTROLLER = "export const create = async () => ({});";

  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-bundle-source-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function transportsFor(blob: string, files: PayloadFile[]): TransportRegistry {
    return {
      fetchLayer: async (_ref: string, asked: string) => {
        if (asked !== blob) throw new Error(`no such blob ${asked}`);
        return files;
      },
    } as unknown as TransportRegistry;
  }

  async function jsLayer(files: PayloadFile[]): Promise<ArtifactLayer> {
    return {
      role: "controller",
      selector: { format: "js" },
      blob: `sha256:${"1".repeat(64)}`,
      integrity: await computeFilesIntegrity(files),
    };
  }

  it("reports `local` for a module sitting on disk beside its manifest", async () => {
    fs.mkdirSync(path.join(dir, "nodejs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "nodejs/c.mjs"), CONTROLLER);
    const baseUri = pathToFileURL(path.join(dir, "telo.yaml")).href;

    const { source } = await new BundleControllerLoader().resolve(PURL, baseUri);
    expect(source).toBe("local");
  });

  it("reports `bundle` on the fetch and `cache` once the layer is extracted", async () => {
    const files: PayloadFile[] = [{ name: "nodejs/c.mjs", content: Buffer.from(CONTROLLER) }];
    const layer = await jsLayer(files);
    const transports = transportsFor(layer.blob, files);
    const baseUri = pathToFileURL(path.join(dir, "telo.yaml")).href;

    const cold = new ModuleArtifact({ pinnedRef: REF, layers: [layer], dir, transports });
    expect((await new BundleControllerLoader().resolve(PURL, baseUri, cold)).source).toBe("bundle");

    // A fresh artifact handle over the same directory is the next `telo run`.
    const warm = new ModuleArtifact({ pinnedRef: REF, layers: [layer], dir, transports });
    expect((await new BundleControllerLoader().resolve(PURL, baseUri, warm)).source).toBe("cache");
  });
});
