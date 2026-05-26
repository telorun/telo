import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { NpmControllerLoader, __testing__ } from "../src/controller-loaders/npm-loader.js";
import { ControllerEnvMissingError } from "../src/controller-loaders/napi-loader.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const sdkPath = path.join(repoRoot, "sdk", "nodejs");

/**
 * Two controllers loaded into the same install root must resolve `@telorun/sdk`
 * to the same realpath (and therefore the same module instance, the same
 * `Stream` constructor, etc.). This is the realm-collapse contract that the
 * plan in plans/single-realm-install.md restores.
 *
 * Path-based equality is the test signal; constructor identity is implied
 * once the realpaths match because Node's ESM resolver caches by realpath.
 * (npm's `file:` install behaviour — symlink vs. copy — varies across
 * versions; this test does not assume one or the other, only that whichever
 * the package manager picked was applied consistently to both controllers.)
 */
describe("NpmControllerLoader single-realm install", () => {
  let workDir: string;
  let manifestPath: string;
  let manifestUrl: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-realm-test-"));
    manifestPath = path.join(workDir, "manifest.yaml");
    await fs.writeFile(manifestPath, "kind: Telo.Application\nmetadata:\n  name: test\n");
    manifestUrl = pathToFileURL(manifestPath).toString();
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it(
    "resolves @telorun/sdk to the kernel's own realpath after a single materialization",
    async () => {
      const loader = new NpmControllerLoader({ entryUrl: manifestUrl });

      // The first controller load forces the install root to be materialized.
      // We use a workspace-local module via local_path so the test doesn't
      // hit the public registry; the load itself is incidental — we only
      // need it to drive `ensureInstallRoot()` exactly once.
      const javascriptPurl =
        "pkg:npm/@telorun/javascript@latest?local_path=./modules/javascript/nodejs#script";
      const fakeBaseUri = pathToFileURL(path.join(repoRoot, "fake-manifest.yaml")).toString();
      const result = await loader.load(javascriptPurl, fakeBaseUri);
      expect(result.instance).toBeDefined();

      const installRoot = path.join(workDir, ".telo", "npm");
      const installSdk = path.join(installRoot, "node_modules", "@telorun", "sdk");
      const installSdkRealpath = await fs.realpath(installSdk);

      // Anchor "the kernel's own SDK" via the resolved package directory at
      // the workspace root. This is the path NpmControllerLoader itself
      // discovers via createRequire.
      const kernelSdkRealpath = await fs.realpath(sdkPath);

      expect(installSdkRealpath).toBe(kernelSdkRealpath);
    },
    { timeout: 60_000 },
  );

  it(
    "writes @telorun/sdk as a file: dep pointing at the kernel's resolution",
    async () => {
      const loader = new NpmControllerLoader({ entryUrl: manifestUrl });
      const fakeBaseUri = pathToFileURL(path.join(repoRoot, "fake-manifest.yaml")).toString();
      await loader.load(
        "pkg:npm/@telorun/javascript@latest?local_path=./modules/javascript/nodejs#script",
        fakeBaseUri,
      );

      const installRootPkgJson = JSON.parse(
        await fs.readFile(path.join(workDir, ".telo", "npm", "package.json"), "utf8"),
      );

      // Single mechanism now: modules declare @telorun/sdk as a peer dep,
      // the install root provides exactly one copy via `file:`. No overrides
      // needed — that block existed only to enforce what peer deps now do.
      expect(installRootPkgJson.dependencies["@telorun/sdk"]).toMatch(/^file:/);
      expect(installRootPkgJson.overrides).toBeUndefined();
      expect(installRootPkgJson.pnpm).toBeUndefined();
    },
    { timeout: 60_000 },
  );

  it(
    "anchors http(s) entry URLs to a hash-keyed cache directory and materializes a working install root",
    async () => {
      // `TELO_NPM_CACHE_DIR` overrides the default `~/.cache/telo/remote` so
      // the test doesn't pollute the developer's cache. The path inside is
      // still derived from sha256(entryUrl), exactly as a real `pnpm telo
      // https://...yaml` invocation would compute it.
      const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-remote-cache-"));
      const originalCacheDir = process.env.TELO_NPM_CACHE_DIR;
      process.env.TELO_NPM_CACHE_DIR = cacheDir;
      try {
        const entryUrl = "https://example.com/manifest.yaml";
        const loader = new NpmControllerLoader({ entryUrl });

        // baseUri = file:// so `local_path` resolves — in a real remote run
        // the baseUri would also be HTTP (registry-served definitions) and
        // the loader would fall through to a registry install. The hash-keyed
        // root computation is the same either way; using `local_path` here
        // keeps the test off the public npm registry.
        const fakeBaseUri = pathToFileURL(path.join(repoRoot, "fake-manifest.yaml")).toString();
        const result = await loader.load(
          "pkg:npm/@telorun/javascript@latest?local_path=./modules/javascript/nodejs#script",
          fakeBaseUri,
        );
        expect(result.instance).toBeDefined();

        const expectedHash = crypto.createHash("sha256").update(entryUrl).digest("hex");
        const expectedRoot = path.join(cacheDir, expectedHash, "npm");
        expect(__testing__.computeInstallRoot(entryUrl)).toBe(expectedRoot);

        // Sanity: the install root was actually materialized at the expected path.
        const stat = await fs.stat(path.join(expectedRoot, "node_modules"));
        expect(stat.isDirectory()).toBe(true);
      } finally {
        if (originalCacheDir === undefined) delete process.env.TELO_NPM_CACHE_DIR;
        else process.env.TELO_NPM_CACHE_DIR = originalCacheDir;
        await fs.rm(cacheDir, { recursive: true, force: true });
      }
    },
    { timeout: 60_000 },
  );

  it(
    "rejects unsupported entry URL schemes as env-missing so the dispatcher can fall back",
    async () => {
      // Anything that isn't file://, http://, https://, or a bare path is
      // env-missing rather than a hard error — the dispatcher uses this as
      // the signal to advance to a non-npm candidate.
      expect(() => __testing__.computeInstallRoot("ftp://example.com/manifest.yaml")).toThrow(
        ControllerEnvMissingError,
      );
      expect(() =>
        __testing__.computeInstallRoot("ftp://example.com/manifest.yaml"),
      ).toThrow(/scheme 'ftp' is not supported/);
    },
    { timeout: 10_000 },
  );

  it(
    "throws env-missing (not a hard error) when constructed without an entry URL",
    async () => {
      const loader = new NpmControllerLoader();
      const fakeBaseUri = pathToFileURL(path.join(repoRoot, "fake-manifest.yaml")).toString();
      try {
        await loader.load(
          "pkg:npm/@telorun/javascript@latest?local_path=./modules/javascript/nodejs#script",
          fakeBaseUri,
        );
        expect.fail("expected load() to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ControllerEnvMissingError);
      }
    },
    { timeout: 10_000 },
  );

  it(
    "skips re-running `npm install` on the same install state",
    async () => {
      const loader = new NpmControllerLoader({ entryUrl: manifestUrl });
      const fakeBaseUri = pathToFileURL(path.join(repoRoot, "fake-manifest.yaml")).toString();
      const purl =
        "pkg:npm/@telorun/javascript@latest?local_path=./modules/javascript/nodejs#script";

      const r1 = await loader.load(purl, fakeBaseUri);
      const r2 = await loader.load(purl, fakeBaseUri);

      // First call materializes + installs; second hits the in-process cache.
      // Either `cache` or `local` (when the package was already present from
      // a prior test run) is acceptable — the failure mode would be `npm-install`.
      expect(r2.source).toBe("cache");
      expect(r1.instance).toBeDefined();
      expect(r2.instance).toBeDefined();
    },
    { timeout: 60_000 },
  );
});
