import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { NpmControllerLoader } from "../src/controller-loaders/npm-loader.js";
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
    "writes overrides + pnpm.overrides pinning @telorun/sdk to the kernel's resolution",
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

      expect(installRootPkgJson.dependencies["@telorun/sdk"]).toMatch(/^file:/);
      expect(installRootPkgJson.overrides["@telorun/sdk"]).toBe("$@telorun/sdk");
      // Mirror under pnpm.overrides so both package managers honour the pin.
      expect(installRootPkgJson.pnpm.overrides["@telorun/sdk"]).toBe("$@telorun/sdk");
    },
    { timeout: 60_000 },
  );

  it(
    "rejects http(s) entry URLs as env-missing so the dispatcher can fall back to other candidates",
    async () => {
      const loader = new NpmControllerLoader({ entryUrl: "https://example.com/manifest.yaml" });
      const fakeBaseUri = pathToFileURL(path.join(repoRoot, "fake-manifest.yaml")).toString();
      // Specifically `ControllerEnvMissingError` (not a plain Error): the
      // dispatcher uses that type as the signal to advance to the next
      // candidate in a mixed list (e.g. `pkg:npm` + `pkg:cargo`).
      try {
        await loader.load(
          "pkg:npm/@telorun/javascript@latest?local_path=./modules/javascript/nodejs#script",
          fakeBaseUri,
        );
        expect.fail("expected load() to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ControllerEnvMissingError);
        expect((err as Error).message).toMatch(/scheme 'https' is not supported/);
      }
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
