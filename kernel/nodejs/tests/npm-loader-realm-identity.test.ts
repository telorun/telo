import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "crypto";
import { realpathSync } from "fs";
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
/** GitHub's Windows runners hand back an 8.3 SHORT path from os.tmpdir()
 *  (`C:\\Users\\RUNNER~1\\AppData\\Local\\Temp`). The `~` survives into the module
 *  URL the loader imports, where vite's resolver percent-encodes it to `%7E` and
 *  then cannot find the file. `realpathSync.native` is what expands a short name
 *  to its long form; the promises API has no `.native` variant. */
const TMP_ROOT = realpathSync.native(os.tmpdir());

describe("NpmControllerLoader single-realm install", () => {
  let workDir: string;
  let manifestPath: string;
  let manifestUrl: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(TMP_ROOT, "telo-realm-test-"));
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
      // need it to drive `ensureInstallRoot()` exactly once. `http-server` is
      // the subject because it is one of the modules that still DELIVERS its
      // controller from npm; a bundled module has no npm package for this
      // loader to install.
      const javascriptPurl =
        "pkg:npm/@telorun/http-server@latest?local_path=./modules/http-server/nodejs#http-static";
      const fakeBaseUri = pathToFileURL(path.join(repoRoot, "fake-manifest.yaml")).toString();
      const result = await loader.load(javascriptPurl, fakeBaseUri);
      expect(result.instance).toBeDefined();

      const installRoot = await __testing__.installRootIn(manifestUrl);
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
        "pkg:npm/@telorun/http-server@latest?local_path=./modules/http-server/nodejs#http-static",
        fakeBaseUri,
      );

      const installRootPkgJson = JSON.parse(
        await fs.readFile(path.join(await __testing__.installRootIn(manifestUrl), "package.json"), "utf8"),
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

  // Regression: the root's package.json used to be rewritten from scratch with
  // only the realm deps, so the `--save`d controller aliases vanished from it
  // and the install below pruned their folders. Any realm change — a globally
  // installed CLI and a repo checkout addressing the same app, which resolve
  // `@telorun/sdk` to different paths — therefore evicted every controller and
  // reinstalled the lot, on every switch between the two.
  it(
    "keeps installed controllers when the realm dep changes",
    async () => {
      const loader = new NpmControllerLoader({ entryUrl: manifestUrl });
      const fakeBaseUri = pathToFileURL(path.join(repoRoot, "fake-manifest.yaml")).toString();
      await loader.load(
        "pkg:npm/@telorun/http-server@latest?local_path=./modules/http-server/nodejs#http-static",
        fakeBaseUri,
      );

      const installRoot = await __testing__.installRootIn(manifestUrl);
      const pkgJsonPath = path.join(installRoot, "package.json");
      const before = JSON.parse(await fs.readFile(pkgJsonPath, "utf8"));
      const aliases = Object.keys(before.dependencies).filter((d) => d !== "@telorun/sdk");
      expect(aliases.length).toBeGreaterThan(0);

      // Simulate the other kernel: a realm identity this root was not built for.
      await fs.writeFile(
        path.join(installRoot, ".telo-state.json"),
        JSON.stringify({ rootHash: "a-different-realm" }),
      );

      // A fresh loader re-materializes the root, since the recorded identity no
      // longer matches what it would write. The controller must survive that:
      // `cache` is the loader saying it found the package already installed —
      // any other source means the root install evicted it and it was fetched
      // again, which is the whole defect.
      const second = await new NpmControllerLoader({ entryUrl: manifestUrl }).resolve(
        "pkg:npm/@telorun/http-server@latest?local_path=./modules/http-server/nodejs#http-static",
        fakeBaseUri,
      );
      expect(second.source).toBe("cache");

      const after = JSON.parse(await fs.readFile(pkgJsonPath, "utf8"));
      for (const alias of aliases) {
        expect(after.dependencies[alias]).toBe(before.dependencies[alias]);
        await expect(
          fs.stat(path.join(installRoot, "node_modules", alias)),
        ).resolves.toBeDefined();
      }
      expect(after.dependencies["@telorun/sdk"]).toMatch(/^file:/);
    },
    { timeout: 120_000 },
  );

  // The other half of preserving aliases: a recorded `file:` controller whose
  // target has since moved must not be carried into the rewrite. The package
  // manager resolves every entry, so one dead record fails the whole root
  // install — and because the state file is written only after a successful
  // install, every later run would repeat it and no controller would load.
  it(
    "drops a controller whose file: target no longer exists instead of failing the root install",
    async () => {
      const loader = new NpmControllerLoader({ entryUrl: manifestUrl });
      const fakeBaseUri = pathToFileURL(path.join(repoRoot, "fake-manifest.yaml")).toString();
      await loader.load(
        "pkg:npm/@telorun/http-server@latest?local_path=./modules/http-server/nodejs#http-static",
        fakeBaseUri,
      );

      const installRoot = await __testing__.installRootIn(manifestUrl);
      const pkgJsonPath = path.join(installRoot, "package.json");
      const pkg = JSON.parse(await fs.readFile(pkgJsonPath, "utf8"));
      // A dead alias of the shape `--save` records for a local controller.
      pkg.dependencies["telorun__ghost__1.0.0__deadbeef"] =
        `file:${path.join(workDir, "gone", "nodejs")}`;
      await fs.writeFile(pkgJsonPath, JSON.stringify(pkg, null, 2));
      await fs.writeFile(
        path.join(installRoot, ".telo-state.json"),
        JSON.stringify({ rootHash: "a-different-realm" }),
      );

      // Must not throw: the dead entry is dropped, the live ones are kept.
      const second = await new NpmControllerLoader({ entryUrl: manifestUrl }).resolve(
        "pkg:npm/@telorun/http-server@latest?local_path=./modules/http-server/nodejs#http-static",
        fakeBaseUri,
      );
      expect(second.source).toBe("cache");

      const after = JSON.parse(await fs.readFile(pkgJsonPath, "utf8"));
      expect(after.dependencies["telorun__ghost__1.0.0__deadbeef"]).toBeUndefined();
      // The install completed, so the identity is recorded and the next run
      // takes the fast path rather than repeating this.
      expect(
        JSON.parse(await fs.readFile(path.join(installRoot, ".telo-state.json"), "utf8")).rootHash,
      ).not.toBe("a-different-realm");
    },
    { timeout: 120_000 },
  );

  it(
    "anchors http(s) entry URLs to a hash-keyed cache directory and materializes a working install root",
    async () => {
      // `TELO_NPM_CACHE_DIR` overrides the default `~/.cache/telo/remote` so
      // the test doesn't pollute the developer's cache. The path inside is
      // still derived from sha256(entryUrl), exactly as a real `pnpm telo
      // https://...yaml` invocation would compute it.
      const cacheDir = await fs.mkdtemp(path.join(TMP_ROOT, "telo-remote-cache-"));
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
          "pkg:npm/@telorun/http-server@latest?local_path=./modules/http-server/nodejs#http-static",
          fakeBaseUri,
        );
        expect(result.instance).toBeDefined();

        // The URL hash still anchors the cache directory; the install root is
        // one level further in, keyed by (entry, host platform) like every other.
        const expectedHash = crypto.createHash("sha256").update(entryUrl).digest("hex");
        const expectedRoot = await __testing__.installRootIn(entryUrl);
        expect(expectedRoot.startsWith(path.join(cacheDir, expectedHash, "npm") + path.sep)).toBe(
          true,
        );

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
          "pkg:npm/@telorun/http-server@latest?local_path=./modules/http-server/nodejs#http-static",
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
        "pkg:npm/@telorun/http-server@latest?local_path=./modules/http-server/nodejs#http-static";

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
