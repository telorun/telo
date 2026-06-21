import * as fs from "fs/promises";
import { createRequire } from "module";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Loader, defaultSources } from "@telorun/analyzer";
import {
  LocalManifestCacheSource,
  cachePathForCanonical,
  resolveEntryDir,
  writeManifestCache,
} from "../src/manifest-sources/local-manifest-cache-source.js";
import {
  computeAnalysisSignature,
  readAnalysisStamp,
  writeAnalysisStamp,
} from "../src/manifest-sources/analysis-stamp.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

let workdir: string;

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-manifest-cache-"));
});

afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

const REGISTRY_URL = "https://registry.telo.run";

describe("cachePathForCanonical", () => {
  it("maps a registry-served URL into the namespace/name/version layout", () => {
    const result = cachePathForCanonical(
      "https://registry.telo.run/std/type/1.0.5/telo.yaml",
      "/srv/app",
      REGISTRY_URL,
    );
    expect(result).toBe("/srv/app/.telo/manifests/std/type/1.0.5/telo.yaml");
  });

  it("strips a trailing slash from the configured registry URL", () => {
    const result = cachePathForCanonical(
      "https://registry.telo.run/std/run/0.2.4/telo.yaml",
      "/srv/app",
      `${REGISTRY_URL}/`,
    );
    expect(result).toBe("/srv/app/.telo/manifests/std/run/0.2.4/telo.yaml");
  });

  it("maps an arbitrary HTTP URL under the __http subtree", () => {
    const result = cachePathForCanonical(
      "https://example.com/lib/v1/telo.yaml",
      "/srv/app",
      REGISTRY_URL,
    );
    expect(result).toBe(
      "/srv/app/.telo/manifests/__http/example.com/lib/v1/telo.yaml",
    );
  });

  it("returns null for file:// sources (already on disk)", () => {
    expect(
      cachePathForCanonical("file:///tmp/foo/telo.yaml", "/srv/app", REGISTRY_URL),
    ).toBeNull();
  });

  it("returns null for memory:// sources (transient)", () => {
    expect(
      cachePathForCanonical("memory://app/telo.yaml", "/srv/app", REGISTRY_URL),
    ).toBeNull();
  });

});

describe("LocalManifestCacheSource.supports", () => {
  it("matches a registry ref when the on-disk file exists", async () => {
    const cacheRoot = path.join(workdir, ".telo/manifests/std/type/1.0.5");
    await fs.mkdir(cacheRoot, { recursive: true });
    await fs.writeFile(path.join(cacheRoot, "telo.yaml"), "kind: Telo.Library\n");

    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("std/type@1.0.5")).toBe(true);
  });

  it("returns false when the registry ref has no on-disk file (miss falls through)", () => {
    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("std/type@1.0.5")).toBe(false);
  });

  it("matches an HTTP URL when the on-disk file exists", async () => {
    const cacheRoot = path.join(workdir, ".telo/manifests/__http/example.com/lib");
    await fs.mkdir(cacheRoot, { recursive: true });
    await fs.writeFile(path.join(cacheRoot, "telo.yaml"), "kind: Telo.Library\n");

    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("https://example.com/lib")).toBe(true);
    expect(source.supports("https://example.com/lib/telo.yaml")).toBe(true);
  });

  it("does not claim file:// URLs (defers to LocalFileSource)", () => {
    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("file:///tmp/foo.yaml")).toBe(false);
  });

  it("does not claim relative paths", () => {
    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("./telo.yaml")).toBe(false);
    expect(source.supports("../sibling/telo.yaml")).toBe(false);
  });

  it("does not claim memory:// URLs", () => {
    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("memory://app/telo.yaml")).toBe(false);
  });

  it("treats a directory at the cache path as a miss (not a hit)", async () => {
    // `mkdir -p .telo/manifests/std/foo/1.0.0/telo.yaml` — note the .yaml
    // segment is itself a directory. existsSync would say true here; we need
    // a stricter regular-file check so reads don't blow up with EISDIR and
    // the chain still falls through to the registry.
    await fs.mkdir(
      path.join(workdir, ".telo/manifests/std/foo/1.0.0/telo.yaml"),
      { recursive: true },
    );

    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("std/foo@1.0.0")).toBe(false);
  });

  it("rejects malformed registry refs (missing version)", () => {
    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("std/type@")).toBe(false);
    expect(source.supports("@1.0.0")).toBe(false);
    expect(source.supports("notnamespace@1.0.0")).toBe(false);
  });
});

describe("LocalManifestCacheSource.read", () => {
  it("returns the cached text and a file:// canonical source", async () => {
    const cacheRoot = path.join(workdir, ".telo/manifests/std/run/0.2.4");
    await fs.mkdir(cacheRoot, { recursive: true });
    const expected = "kind: Telo.Library\nmetadata:\n  name: run\n";
    await fs.writeFile(path.join(cacheRoot, "telo.yaml"), expected);

    const source = new LocalManifestCacheSource(workdir);
    const { text, source: canonical } = await source.read("std/run@0.2.4");

    expect(text).toBe(expected);
    expect(canonical.startsWith("file://")).toBe(true);
    expect(canonical.endsWith("/std/run/0.2.4/telo.yaml")).toBe(true);
  });

  it("strips a leading v from the version", async () => {
    const cacheRoot = path.join(workdir, ".telo/manifests/std/run/0.2.4");
    await fs.mkdir(cacheRoot, { recursive: true });
    await fs.writeFile(path.join(cacheRoot, "telo.yaml"), "kind: Telo.Library\n");

    const source = new LocalManifestCacheSource(workdir);
    const { text } = await source.read("std/run@v0.2.4");
    expect(text).toContain("kind: Telo.Library");
  });
});

describe("writeManifestCache", () => {
  it("persists every transitively-imported manifest from a graph", async () => {
    // Build a fake graph with a registry-served import and an HTTP-served
    // import, plus the root entry which must be skipped.
    const rootSource = "file:///tmp/root/telo.yaml";
    const registryTarget = "https://registry.telo.run/std/type/1.0.5/telo.yaml";
    const httpTarget = "https://example.com/lib/telo.yaml";

    const fakeGraph: any = {
      rootSource,
      entry: null,
      modules: new Map<string, any>([
        [
          rootSource,
          { owner: { source: rootSource, text: "entry-text" }, partials: [] },
        ],
        [
          registryTarget,
          {
            owner: { source: registryTarget, text: "registry-text" },
            partials: [],
          },
        ],
        [
          httpTarget,
          {
            owner: { source: httpTarget, text: "http-text" },
            partials: [],
          },
        ],
      ]),
      importEdges: new Map(),
      errors: [],
    };

    const written = await writeManifestCache(fakeGraph, workdir, REGISTRY_URL);

    expect(written.length).toBe(2);
    const registryFile = path.join(
      workdir,
      ".telo/manifests/std/type/1.0.5/telo.yaml",
    );
    const httpFile = path.join(
      workdir,
      ".telo/manifests/__http/example.com/lib/telo.yaml",
    );
    expect(await fs.readFile(registryFile, "utf-8")).toBe("registry-text");
    expect(await fs.readFile(httpFile, "utf-8")).toBe("http-text");

    // The entry itself must not be cached — it already lives on disk.
    const entryCache = path.join(workdir, ".telo/manifests");
    const entries = await fs.readdir(entryCache);
    expect(entries.sort()).toEqual(["__http", "std"]);
  });

  it("dedupes when the same source is reachable through multiple paths", async () => {
    const rootSource = "file:///tmp/root/telo.yaml";
    const shared = "https://registry.telo.run/std/run/0.2.4/telo.yaml";
    const fakeGraph: any = {
      rootSource,
      entry: null,
      modules: new Map<string, any>([
        [
          rootSource,
          { owner: { source: rootSource, text: "entry" }, partials: [] },
        ],
        [
          shared,
          { owner: { source: shared, text: "shared-text" }, partials: [] },
        ],
      ]),
      importEdges: new Map(),
      errors: [],
    };

    const written = await writeManifestCache(fakeGraph, workdir, REGISTRY_URL);
    expect(written.length).toBe(1);
  });

  it("overwrites existing cache entries with freshly fetched bytes (refresh on re-install)", async () => {
    // Seed a stale cache entry, then run writeManifestCache with a graph
    // whose canonical sources are the network URLs (as they would be when
    // the install-time Loader skips the cache source and reads from the
    // registry directly). The on-disk bytes must be the freshly fetched
    // ones, not whatever was already there.
    const cacheFile = path.join(
      workdir,
      ".telo/manifests/std/foo/1.0.0/telo.yaml",
    );
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, "stale-bytes");

    const rootSource = "file:///tmp/root/telo.yaml";
    const fakeGraph: any = {
      rootSource,
      entry: null,
      modules: new Map<string, any>([
        [rootSource, { owner: { source: rootSource, text: "" }, partials: [] }],
        [
          "https://registry.telo.run/std/foo/1.0.0/telo.yaml",
          {
            owner: {
              source: "https://registry.telo.run/std/foo/1.0.0/telo.yaml",
              text: "fresh-bytes",
            },
            partials: [],
          },
        ],
      ]),
      importEdges: new Map(),
      errors: [],
    };

    await writeManifestCache(fakeGraph, workdir, REGISTRY_URL);
    expect(await fs.readFile(cacheFile, "utf-8")).toBe("fresh-bytes");
  });

  it("persists partials alongside their owner", async () => {
    const rootSource = "file:///tmp/root/telo.yaml";
    const ownerSource = "https://registry.telo.run/std/foo/1.0.0/telo.yaml";
    const partialSource = "https://registry.telo.run/std/foo/1.0.0/sub.yaml";
    const fakeGraph: any = {
      rootSource,
      entry: null,
      modules: new Map<string, any>([
        [rootSource, { owner: { source: rootSource, text: "" }, partials: [] }],
        [
          ownerSource,
          {
            owner: { source: ownerSource, text: "owner-text" },
            partials: [{ source: partialSource, text: "partial-text" }],
          },
        ],
      ]),
      importEdges: new Map(),
      errors: [],
    };

    await writeManifestCache(fakeGraph, workdir, REGISTRY_URL);

    const partialPath = path.join(
      workdir,
      ".telo/manifests/std/foo/1.0.0/sub.yaml",
    );
    expect(await fs.readFile(partialPath, "utf-8")).toBe("partial-text");
  });
});

describe("Loader picks the cache source over RegistrySource on hit", () => {
  it("serves a registry ref from disk and never touches the network", async () => {
    // Seed the cache directly.
    const libDir = path.join(workdir, ".telo/manifests/std/foo/1.0.0");
    await fs.mkdir(libDir, { recursive: true });
    await fs.writeFile(
      path.join(libDir, "telo.yaml"),
      [
        "kind: Telo.Library",
        "metadata:",
        "  name: foo",
        "  version: 1.0.0",
        "",
      ].join("\n"),
    );

    // Write an entry manifest that imports the library by registry ref.
    const entryPath = path.join(workdir, "telo.yaml");
    await fs.writeFile(
      entryPath,
      [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "---",
        "kind: Telo.Import",
        "metadata:",
        "  name: Foo",
        "source: std/foo@1.0.0",
        "",
      ].join("\n"),
    );

    // Build a Loader with the cache source registered, and point
    // `registryUrl` at an unreachable host to prove no network call is made.
    const loader = new Loader([
      new LocalFileSource(),
      new LocalManifestCacheSource(workdir),
      ...defaultSources("http://127.0.0.1:1"),
    ]);

    const graph = await loader.loadGraph(entryPath);
    expect(graph.errors).toEqual([]);
    expect(graph.modules.size).toBe(2);
  });

  it("falls through to RegistrySource on cache miss", async () => {
    // No cache file written. Same entry as above, but expect a network
    // failure because RegistrySource is consulted next.
    const entryPath = path.join(workdir, "telo.yaml");
    await fs.writeFile(
      entryPath,
      [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "---",
        "kind: Telo.Import",
        "metadata:",
        "  name: Foo",
        "source: std/foo@1.0.0",
        "",
      ].join("\n"),
    );

    const loader = new Loader([
      new LocalFileSource(),
      new LocalManifestCacheSource(workdir),
      ...defaultSources("http://127.0.0.1:1"),
    ]);

    const graph = await loader.loadGraph(entryPath);
    expect(graph.errors.length).toBeGreaterThan(0);
  });
});

describe("path traversal guard", () => {
  it("rejects a registry ref whose modulePath segments would escape the cache root", () => {
    const result = cachePathForCanonical(
      "foo/../../escape@1.0.0",
      "/srv/app",
      REGISTRY_URL,
    );
    expect(result).toBeNull();
  });

  it("URL parser canonicalizes .. in HTTP pathnames so they cannot escape", () => {
    // `new URL()` collapses `..` segments, so a malformed import like this
    // is already neutered before our mapping sees it: pathname becomes
    // `/escape/telo.yaml`, which lands inside the __http subtree.
    const result = cachePathForCanonical(
      "https://example.com/../../escape/telo.yaml",
      "/srv/app",
      REGISTRY_URL,
    );
    expect(result).toBe(
      "/srv/app/.telo/manifests/__http/example.com/escape/telo.yaml",
    );
  });

  it("supports() returns false on a traversal attempt even when a file exists at the escaped path", async () => {
    // Plant a file *outside* the cache root that the bad ref would target.
    const outside = path.join(workdir, "escape", "1.0.0");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "telo.yaml"), "kind: Telo.Library\n");

    // The cache root is workdir/.telo/manifests — so `foo/../../escape@1.0.0`
    // would otherwise resolve to <workdir>/escape/1.0.0/telo.yaml (above).
    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("foo/../../escape@1.0.0")).toBe(false);
  });
});

describe("query-string disambiguation", () => {
  it("writes distinct cache paths for URLs that differ only in query string", () => {
    const a = cachePathForCanonical(
      "https://example.com/lib/telo.yaml?a=1",
      "/srv/app",
      REGISTRY_URL,
    );
    const b = cachePathForCanonical(
      "https://example.com/lib/telo.yaml?a=2",
      "/srv/app",
      REGISTRY_URL,
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("writes a distinct path for a fragment", () => {
    const a = cachePathForCanonical(
      "https://example.com/lib/telo.yaml",
      "/srv/app",
      REGISTRY_URL,
    );
    const b = cachePathForCanonical(
      "https://example.com/lib/telo.yaml#frag",
      "/srv/app",
      REGISTRY_URL,
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("reader and writer agree on the disambiguated path for the same query string", async () => {
    const url = "https://example.com/lib/telo.yaml?a=1";
    const writePath = cachePathForCanonical(url, workdir, REGISTRY_URL);
    expect(writePath).not.toBeNull();
    await fs.mkdir(path.dirname(writePath!), { recursive: true });
    await fs.writeFile(writePath!, "kind: Telo.Library\n");

    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports(url)).toBe(true);
    const { text } = await source.read(url);
    expect(text).toContain("kind: Telo.Library");
  });
});

describe("registry URL alignment between reader and writer", () => {
  it("direct registry URL imports hit the same cache that registry-ref imports wrote", async () => {
    // Writer sees the canonical URL (HTTP) that RegistrySource returns.
    const canonical = "https://registry.telo.run/std/foo/1.0.0/telo.yaml";
    const writePath = cachePathForCanonical(canonical, workdir, REGISTRY_URL);
    expect(writePath).toBe(
      path.join(workdir, ".telo/manifests/std/foo/1.0.0/telo.yaml"),
    );
    await fs.mkdir(path.dirname(writePath!), { recursive: true });
    await fs.writeFile(writePath!, "kind: Telo.Library\n");

    const source = new LocalManifestCacheSource(workdir, REGISTRY_URL);

    // Both import shapes must resolve to the same cache file.
    expect(source.supports("std/foo@1.0.0")).toBe(true);
    expect(source.supports("https://registry.telo.run/std/foo/1.0.0/telo.yaml")).toBe(true);
    // And even the un-suffixed direct URL: HttpSource would append /telo.yaml,
    // the cache mapping must mirror that normalization.
    expect(source.supports("https://registry.telo.run/std/foo/1.0.0")).toBe(true);
  });

  it("falls back to __http layout for registry URLs when a non-default registry is configured", () => {
    // Writer with a custom registry URL.
    const customRegistry = "https://registry.example.internal";
    const writePath = cachePathForCanonical(
      "https://registry.telo.run/std/foo/1.0.0/telo.yaml",
      "/srv/app",
      customRegistry,
    );
    // The default registry URL is NOT the configured one, so this is
    // arbitrary HTTP from the perspective of the cache.
    expect(writePath).toBe(
      "/srv/app/.telo/manifests/__http/registry.telo.run/std/foo/1.0.0/telo.yaml",
    );
  });

  it("registry URL with a path prefix maps correctly", () => {
    const writePath = cachePathForCanonical(
      "https://reg.example.com/r/std/foo/1.0.0/telo.yaml",
      "/srv/app",
      "https://reg.example.com/r",
    );
    expect(writePath).toBe(
      "/srv/app/.telo/manifests/std/foo/1.0.0/telo.yaml",
    );
  });
});

describe("resolveEntryDir", () => {
  it("returns the parent dir for a file path", async () => {
    const entry = path.join(workdir, "telo.yaml");
    await fs.writeFile(entry, "");
    expect(resolveEntryDir(entry)).toBe(workdir);
  });

  it("returns the dir itself for a directory path", () => {
    expect(resolveEntryDir(workdir)).toBe(workdir);
  });

  it("returns null for HTTP URLs", () => {
    expect(resolveEntryDir("https://example.com/x/telo.yaml")).toBeNull();
  });
});

describe("analysis stamp", () => {
  function makeGraph(files: Array<{ source: string; text: string }>) {
    const modules = new Map<
      string,
      { owner: { source: string; text: string }; partials: never[] }
    >();
    for (const f of files) {
      modules.set(f.source, { owner: f, partials: [] });
    }
    return {
      rootSource: files[0]?.source ?? "",
      modules,
      importEdges: new Map(),
      errors: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it("computeAnalysisSignature is stable across permutations of the same files", () => {
    const graphA = makeGraph([
      { source: "file:///a.yaml", text: "kind: Telo.Application" },
      { source: "file:///b.yaml", text: "kind: Telo.Library" },
    ]);
    const graphB = makeGraph([
      { source: "file:///b.yaml", text: "kind: Telo.Library" },
      { source: "file:///a.yaml", text: "kind: Telo.Application" },
    ]);
    expect(computeAnalysisSignature(graphA)).toBe(computeAnalysisSignature(graphB));
  });

  it("computeAnalysisSignature changes when any file text changes", () => {
    const before = computeAnalysisSignature(
      makeGraph([{ source: "file:///a.yaml", text: "kind: Telo.Application" }]),
    );
    const after = computeAnalysisSignature(
      makeGraph([
        { source: "file:///a.yaml", text: "kind: Telo.Application # edited" },
      ]),
    );
    expect(after).not.toBe(before);
  });

  it("writeAnalysisStamp + readAnalysisStamp round-trip", async () => {
    const signature = "deadbeef".repeat(8);
    await writeAnalysisStamp(workdir, signature);
    const stamp = await readAnalysisStamp(workdir);
    expect(stamp?.signature).toBe(signature);
    expect(stamp?.version).toBe(1);
  });

  it("readAnalysisStamp returns undefined when no stamp file exists", async () => {
    expect(await readAnalysisStamp(workdir)).toBeUndefined();
  });

  it("@telorun/analyzer/package.json is reachable so its version pins the signature", () => {
    // Regression: when the analyzer's `exports` map omitted
    // `./package.json`, this require failed and `readDepVersion`
    // collapsed to "unknown" — breaking the "pnpm install of a new
    // analyzer invalidates every stamp" guarantee. Asserting the
    // require works keeps that promise enforced.
    const myRequire = createRequire(import.meta.url);
    const pkg = myRequire("@telorun/analyzer/package.json");
    expect(typeof pkg.version).toBe("string");
    expect(pkg.version).not.toBe("unknown");
    expect(pkg.name).toBe("@telorun/analyzer");
  });

  it("readAnalysisStamp rejects a stamp from an unknown protocol version", async () => {
    const target = path.join(workdir, ".telo/manifests/.validated.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      JSON.stringify({ version: 9999, signature: "x" }),
      "utf-8",
    );
    expect(await readAnalysisStamp(workdir)).toBeUndefined();
  });
});
