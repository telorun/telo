import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { beforeEach, describe, expect, it } from "vitest";
import { moduleDirectoryFor } from "../src/bundle/module-artifact.js";
import {
  LocalManifestCacheSource,
  legacyManifestsDirFallback,
} from "../src/manifest-sources/local-manifest-cache-source.js";

/**
 * The pre-workspace-anchor read fallback — the whole upgrade story.
 *
 * Moving the cache root turns a warm cache cold, which costs only CPU everywhere
 * except manifests, where it costs network: a hermetic setup ran `telo install`
 * precisely so boot does no network I/O, and its output sits at the old path. So
 * BOTH halves of a module have to be found there — the manifest and the layers
 * that extract beside it. Covering only the manifest is worse than covering
 * neither, because boot then gets far enough to look like it works and fails on
 * the first bundled controller.
 */

const REGISTRY = "https://registry.telo.run";
const REF = "oci://ghcr.io/telorun/console@0.9.0";
const REF_PATH = path.join("oci", "ghcr.io", "telorun", "console", "0.9.0");

let root: string;
let entryDir: string;
let newManifests: string;
let legacyManifests: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-legacy-")));
  entryDir = path.join(root, "app");
  newManifests = path.join(root, ".telo", "manifests");
  legacyManifests = path.join(entryDir, ".telo", "manifests");
  await fs.mkdir(newManifests, { recursive: true });
});

async function seed(manifestsRoot: string): Promise<string> {
  const dir = path.join(manifestsRoot, REF_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "telo.yaml"), "kind: Telo.Library\n");
  return dir;
}

/** The directory a `read()` actually served from, as a filesystem path.
 *
 *  `read()` reports a `file://` URL, whose separator is `/` on every platform,
 *  so a substring assertion built with `path.join` compares `\` against `/` and
 *  fails on Windows only. Converting back is also the more honest check: it
 *  asserts the resolved location rather than that some text appears in a URL. */
async function servedFrom(source: LocalManifestCacheSource): Promise<string> {
  const { source: served } = await source.read(REF);
  return path.dirname(fileURLToPath(served));
}

describe("legacy cache fallback", () => {
  it("serves a manifest from the pre-anchor root when the current one misses", async () => {
    await seed(legacyManifests);
    const source = new LocalManifestCacheSource(entryDir, REGISTRY, newManifests);

    expect(source.supports(REF)).toBe(true);
    expect(await servedFrom(source)).toBe(path.join(legacyManifests, REF_PATH));
  });

  it("prefers the current root when both hold the manifest", async () => {
    await seed(legacyManifests);
    await seed(newManifests);
    const source = new LocalManifestCacheSource(entryDir, REGISTRY, newManifests);

    expect(await servedFrom(source)).toBe(path.join(newManifests, REF_PATH));
  });

  it("misses when neither root holds it, so the network source still gets a turn", async () => {
    const source = new LocalManifestCacheSource(entryDir, REGISTRY, newManifests);
    expect(source.supports(REF)).toBe(false);
  });

  it("does not look twice when the roots coincide", () => {
    expect(legacyManifestsDirFallback(entryDir, legacyManifests)).toBeNull();
    expect(legacyManifestsDirFallback(entryDir, newManifests)).toBe(legacyManifests);
    expect(legacyManifestsDirFallback("", newManifests)).toBeNull();
  });

  it("places a module's LAYERS beside whichever cached manifest was used", async () => {
    // The regression this exists for: the manifest resolved from the old root
    // while its controller layers were looked for under the new one, so an
    // offline upgrade booted far enough to fetch every bundled controller.
    const legacyDir = await seed(legacyManifests);
    const fallback = legacyManifestsDirFallback(entryDir, newManifests);

    expect(
      moduleDirectoryFor(REF, "file:///irrelevant/telo.yaml", entryDir, REGISTRY, newManifests, fallback),
    ).toBe(legacyDir);
  });

  it("keeps a cold module under the CURRENT root, so nothing is materialized into the old one", () => {
    const fallback = legacyManifestsDirFallback(entryDir, newManifests);

    expect(
      moduleDirectoryFor(REF, "file:///irrelevant/telo.yaml", entryDir, REGISTRY, newManifests, fallback),
    ).toBe(path.join(newManifests, REF_PATH));
  });
});
