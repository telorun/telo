import type { ArtifactLayer } from "@telorun/analyzer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeFilesIntegrity, type PayloadFile } from "../src/bundle/files-integrity.js";
import {
  ModuleArtifact,
  moduleArtifactFor,
  moduleDirectoryFor,
} from "../src/bundle/module-artifact.js";
import type { TransportRegistry } from "../src/transports/transport-registry.js";

const REF = "oci://reg.test/acme/demo@1.0.0#sha256-abc";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-artifact-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A transport registry that serves canned layers by blob digest and counts the
 *  fetches, so a test can prove what was — and was not — transferred. */
function fakeTransports(byBlob: Record<string, PayloadFile[]>) {
  const fetched: string[] = [];
  const transports = {
    fetchLayer: async (_ref: string, blob: string) => {
      fetched.push(blob);
      const files = byBlob[blob];
      if (!files) throw new Error(`no such blob ${blob}`);
      return files;
    },
  } as unknown as TransportRegistry;
  return { transports, fetched };
}

async function layer(
  role: ArtifactLayer["role"],
  blobSuffix: string,
  files: PayloadFile[],
  selector?: ArtifactLayer["selector"],
): Promise<ArtifactLayer> {
  return {
    role,
    ...(selector ? { selector } : {}),
    blob: `sha256:${blobSuffix.repeat(64).slice(0, 64)}`,
    integrity: await computeFilesIntegrity(files),
  };
}

const file = (name: string, content: string): PayloadFile => ({
  name,
  content: Buffer.from(content),
});

describe("ModuleArtifact", () => {
  it("materializes the controller layer matching the host and extracts it", async () => {
    const files = [file("nodejs/c.mjs", "export const x = 1")];
    const js = await layer("controller", "1", files, { format: "js" });
    const { transports, fetched } = fakeTransports({ [js.blob]: files });

    const artifact = new ModuleArtifact({ pinnedRef: REF, layers: [js], dir, transports });
    const result = await artifact.materializeController({ format: "js" });

    expect(result?.files).toEqual(["nodejs/c.mjs"]);
    expect(fs.readFileSync(path.join(dir, "nodejs/c.mjs"), "utf-8")).toBe("export const x = 1");
    expect(fetched).toEqual([js.blob]);
  });

  // Regression: the loader used to hand the *host* target here, so a lookup ran
  // `matchControllerLayer` (first match in declaration order). A module shipping
  // both a neutral and a constrained layer of one format then fetched whichever
  // came first, regardless of which candidate asked.
  it("materializes the layer whose selector matches exactly, not the first host match", async () => {
    const neutralFiles = [file("nodejs/any.mjs", "neutral")];
    const linuxFiles = [file("nodejs/linux.mjs", "linux")];
    const neutral = await layer("controller", "1", neutralFiles, { format: "js" });
    const linux = await layer("controller", "2", linuxFiles, {
      format: "js",
      os: "linux",
      arch: "amd64",
    });
    const { transports, fetched } = fakeTransports({
      [neutral.blob]: neutralFiles,
      [linux.blob]: linuxFiles,
    });

    // Neutral is declared first, so a host-match lookup would pick it.
    const artifact = new ModuleArtifact({
      pinnedRef: REF,
      layers: [neutral, linux],
      dir,
      transports,
    });
    const result = await artifact.materializeController({
      format: "js",
      os: "linux",
      arch: "amd64",
    });

    expect(result?.files).toEqual(["nodejs/linux.mjs"]);
    expect(fetched).toEqual([linux.blob]);
  });

  // Regression: the asset path fetched only `assets`, so a module shipping static
  // files with no `assets:` declaration (everything in `common`) and no bundled
  // controller had no route to its own payload — Http.Static served an empty root.
  it("materializes assets and common together for a module-relative file read", async () => {
    const commonFiles = [file("public/index.html", "<h1>hi</h1>")];
    const common = await layer("common", "1", commonFiles);
    const { transports, fetched } = fakeTransports({ [common.blob]: commonFiles });

    const artifact = new ModuleArtifact({ pinnedRef: REF, layers: [common], dir, transports });
    await artifact.materializeModuleFiles();

    expect(fetched).toEqual([common.blob]);
    expect(fs.readFileSync(path.join(dir, "public/index.html"), "utf-8")).toBe("<h1>hi</h1>");
  });

  it("fetches no layer for a selector the artifact does not ship", async () => {
    const files = [file("nodejs/c.mjs", "x")];
    const js = await layer("controller", "1", files, { format: "js" });
    const { transports, fetched } = fakeTransports({ [js.blob]: files });

    const artifact = new ModuleArtifact({ pinnedRef: REF, layers: [js], dir, transports });
    expect(
      await artifact.materializeController({ format: "napi", os: "linux", arch: "amd64" }),
    ).toBeUndefined();
    expect(fetched).toEqual([]);
  });

  // The sink rule: `common` holds what no candidate claimed, so it has to arrive
  // with any controller or an undeclared sidecar would be missing at import.
  it("materializes the common layer alongside a controller layer", async () => {
    const jsFiles = [file("nodejs/glue.mjs", "glue")];
    const commonFiles = [file("nodejs/mod.wasm", "wasm")];
    const js = await layer("controller", "1", jsFiles, { format: "js" });
    const common = await layer("common", "2", commonFiles);
    const { transports, fetched } = fakeTransports({
      [js.blob]: jsFiles,
      [common.blob]: commonFiles,
    });

    const artifact = new ModuleArtifact({
      pinnedRef: REF,
      layers: [js, common],
      dir,
      transports,
    });
    await artifact.materializeController({ format: "js" });

    expect(fetched.sort()).toEqual([common.blob, js.blob].sort());
    expect(fs.existsSync(path.join(dir, "nodejs/mod.wasm"))).toBe(true);
  });

  it("leaves the asset layer untouched until something asks for it", async () => {
    const jsFiles = [file("nodejs/c.mjs", "x")];
    const assetFiles = [file("public/index.html", "<h1>hi</h1>")];
    const js = await layer("controller", "1", jsFiles, { format: "js" });
    const assets = await layer("assets", "2", assetFiles);
    const { transports, fetched } = fakeTransports({
      [js.blob]: jsFiles,
      [assets.blob]: assetFiles,
    });

    const artifact = new ModuleArtifact({ pinnedRef: REF, layers: [js, assets], dir, transports });
    await artifact.materializeController({ format: "js" });
    expect(fetched).toEqual([js.blob]);
    expect(fs.existsSync(path.join(dir, "public/index.html"))).toBe(false);

    await artifact.materializeAssets();
    expect(fetched).toContain(assets.blob);
    expect(fs.readFileSync(path.join(dir, "public/index.html"), "utf-8")).toBe("<h1>hi</h1>");
  });

  it("fetches a layer once — concurrent asks share one transfer", async () => {
    const files = [file("nodejs/c.mjs", "x")];
    const js = await layer("controller", "1", files, { format: "js" });
    const { transports, fetched } = fakeTransports({ [js.blob]: files });

    const artifact = new ModuleArtifact({ pinnedRef: REF, layers: [js], dir, transports });
    await Promise.all(
      Array.from({ length: 5 }, () => artifact.materializeController({ format: "js" })),
    );
    // And again after they settled, to exercise the on-disk marker.
    await artifact.materializeController({ format: "js" });

    expect(fetched).toEqual([js.blob]);
  });

  it("hard-fails when a layer's contents do not match its pinned integrity", async () => {
    const declared = [file("nodejs/c.mjs", "the published bytes")];
    const js = await layer("controller", "1", declared, { format: "js" });
    // The registry answers with different content than the index pinned.
    const { transports } = fakeTransports({ [js.blob]: [file("nodejs/c.mjs", "tampered")] });

    const artifact = new ModuleArtifact({ pinnedRef: REF, layers: [js], dir, transports });
    await expect(artifact.materializeController({ format: "js" })).rejects.toThrow(
      /Integrity check failed/,
    );
    // Verification runs before extraction, so nothing reached the disk.
    expect(fs.existsSync(path.join(dir, "nodejs/c.mjs"))).toBe(false);
  });

  it("rejects a layer entry that escapes the module directory", async () => {
    const evil = [file("../escape.txt", "x")];
    const bad = await layer("assets", "1", evil);
    const { transports } = fakeTransports({ [bad.blob]: evil });

    const artifact = new ModuleArtifact({ pinnedRef: REF, layers: [bad], dir, transports });
    await expect(artifact.materializeAssets()).rejects.toThrow(
      /resolves outside the module's cache directory/,
    );
    expect(fs.existsSync(path.join(path.dirname(dir), "escape.txt"))).toBe(false);
  });

  it("retries after a transient fetch failure rather than caching the rejection", async () => {
    const files = [file("nodejs/c.mjs", "x")];
    const js = await layer("controller", "1", files, { format: "js" });
    let attempts = 0;
    const transports = {
      fetchLayer: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("network blip");
        return files;
      },
    } as unknown as TransportRegistry;

    const artifact = new ModuleArtifact({ pinnedRef: REF, layers: [js], dir, transports });
    await expect(artifact.materializeController({ format: "js" })).rejects.toThrow("network blip");
    await expect(artifact.materializeController({ format: "js" })).resolves.toMatchObject({
      files: ["nodejs/c.mjs"],
    });
    expect(attempts).toBe(2);
  });
});

describe("moduleArtifactFor", () => {
  it("returns nothing for a module with no payload layers", () => {
    const { transports } = fakeTransports({});
    expect(
      moduleArtifactFor({
        pinnedRef: REF,
        layers: [],
        moduleDir: dir,
        transports,
      }),
    ).toBeUndefined();
  });

  it("returns nothing for a module this cache cannot place (a local file:// module)", async () => {
    const files = [file("nodejs/c.mjs", "x")];
    const js = await layer("controller", "1", files, { format: "js" });
    const { transports } = fakeTransports({});
    expect(
      moduleArtifactFor({ pinnedRef: REF, layers: [js], moduleDir: null, transports }),
    ).toBeUndefined();
  });

  it("anchors the module directory on the directory it is handed", async () => {
    const files = [file("nodejs/c.mjs", "x")];
    const js = await layer("controller", "1", files, { format: "js" });
    const { transports } = fakeTransports({});
    const artifact = moduleArtifactFor({
      pinnedRef: REF,
      layers: [js],
      moduleDir: dir,
      transports,
    });
    expect(artifact?.directory).toBe(dir);
  });
});

// Regression: placement used to be derived from the canonical `source`, which
// diverges from the pinned ref the moment the manifest cache is warm —
// `LocalManifestCacheSource` serves a hit as a `file://` URL that no transport
// claims, so `cacheCoords` returned null, no artifact was built, and every OCI
// module silently lost lazy materialization from the second run onward.
describe("moduleDirectoryFor", () => {
  const PINNED = "oci://ghcr.io/acme/demo@1.0.0#sha256-Ab3cDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-ab";

  it("places a module identically whether the manifest came from the network or the cache", () => {
    const manifests = "/tmp/entry/.telo/manifests";
    const cold = moduleDirectoryFor(PINNED, "oci://ghcr.io/acme/demo@1.0.0", "", undefined, manifests);
    // Warm: the cache source served the file, so `source` is a local file:// URL.
    const warm = moduleDirectoryFor(
      PINNED,
      pathToFileURL(path.join(manifests, "oci/ghcr.io/acme/demo/1.0.0/telo.yaml")).href,
      "",
      undefined,
      manifests,
    );
    expect(cold).not.toBeNull();
    expect(warm).toBe(cold);
  });

  it("falls back to the manifest's own directory for a module already on disk", () => {
    const local = pathToFileURL("/srv/mod/telo.yaml").href;
    expect(moduleDirectoryFor(local, local, "", undefined, undefined)).toBe(path.resolve("/srv/mod"));
  });

  it("returns null when neither route places the module", () => {
    expect(moduleDirectoryFor("memory://x", "memory://x", "", undefined, undefined)).toBeNull();
  });
});
