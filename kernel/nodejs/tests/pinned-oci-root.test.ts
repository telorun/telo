import { sha256Base64Url } from "@telorun/analyzer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeTarGz } from "../src/bundle/tar.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { LocalManifestCacheSource } from "../src/manifest-sources/local-manifest-cache-source.js";
import { RESOURCE_CREATE_COMPLETED } from "../src/resource-timing.js";
import {
  OciClient,
  TELO_MANIFEST_LAYER_MEDIA_TYPE,
  type OciManifest,
} from "../src/transports/oci/oci-client.js";

/** `telo run oci://…@<version>#sha256-<pin>`: the root application is read from a
 *  registry and verified against its pin before anything boots. The network is
 *  stubbed at the OCI client — the transport, the loader and the kernel are real. */

const REF = "oci://reg.example.test/demo/hello-app@0.1.0";
const APP = [
  "kind: Telo.Application",
  "metadata:",
  "  name: HelloApp",
  "  version: 0.1.0",
  "---",
  "kind: Telo.JsonSchema",
  "metadata:",
  "  name: Greeting",
  "schema:",
  "  type: string",
  "",
].join("\n");
const TAMPERED = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let workdir: string;
let pin: string;

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-pinned-root-"));
  pin = `sha256-${await sha256Base64Url(new TextEncoder().encode(APP))}`;
  const layer = await makeTarGz([{ name: "telo.yaml", content: APP }]);
  const digest = `sha256:${"1".repeat(64)}`;
  const manifest: OciManifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest, size: 2 },
    layers: [{ mediaType: TELO_MANIFEST_LAYER_MEDIA_TYPE, digest, size: layer.length }],
  };
  vi.spyOn(OciClient.prototype, "pullManifest").mockResolvedValue(manifest);
  vi.spyOn(OciClient.prototype, "pullBlob").mockResolvedValue(layer);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(workdir, { recursive: true, force: true });
});

/** A kernel over the sources `telo run` gives it, counting resource creations. */
function runKernel(): { kernel: Kernel; created: string[] } {
  const kernel = new Kernel({
    env: {},
    sources: [
      new LocalFileSource(),
      new LocalManifestCacheSource("", path.join(workdir, "manifests")),
    ],
  });
  const created: string[] = [];
  kernel.on(RESOURCE_CREATE_COMPLETED, (event) => {
    created.push(String((event.payload as { resource: { name: string } }).resource.name));
  });
  return { kernel, created };
}

describe("a pinned oci:// root", () => {
  it("loads and boots", async () => {
    const { kernel, created } = runKernel();
    await kernel.load(`${REF}#${pin}`, { cacheDir: null });
    await kernel.start();

    expect(kernel.exitCode).toBe(0);
    expect(created).toContain("Greeting");
  });

  it("is refused before any resource is created when the pin does not match", async () => {
    const { kernel, created } = runKernel();

    await expect(kernel.load(`${REF}#${TAMPERED}`, { cacheDir: null })).rejects.toThrow(
      `Integrity check failed for ${REF}#${TAMPERED}: expected ${TAMPERED}, got ${pin}`,
    );
    expect(created).toEqual([]);
  });

  it("is refused the same way from a warm manifest cache", async () => {
    const cached = path.join(workdir, "manifests/oci/reg.example.test/demo/hello-app/0.1.0/telo.yaml");
    await fs.mkdir(path.dirname(cached), { recursive: true });
    await fs.writeFile(cached, APP);
    const { kernel, created } = runKernel();

    await expect(kernel.load(`${REF}#${TAMPERED}`, { cacheDir: null })).rejects.toThrow(
      `Integrity check failed for ${REF}: expected ${TAMPERED}, got ${pin}`,
    );
    expect(created).toEqual([]);
    expect(OciClient.prototype.pullManifest).not.toHaveBeenCalled();
  });
});
