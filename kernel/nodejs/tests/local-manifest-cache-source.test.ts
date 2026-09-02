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

/** The entry-dir the cachePathForCanonical cases below pass in. */
const ENTRY_DIR = "/srv/app";

/** Build an expected cache path the way the production code does.
 *
 *  The layout is assembled with `path.join`, so an expectation spelled with
 *  forward slashes asserts the host separator as much as the layout and fails on
 *  Windows for a mapping that is correct. `path.join` normalizes the separators
 *  in the tail, so the readable single-string form survives. */
const cachePath = (relative: string) => path.join(ENTRY_DIR, ".telo/manifests", relative);

describe("cachePathForCanonical", () => {
  it("maps an oci ref into the oci/host/repo/version layout", () => {
    const result = cachePathForCanonical("oci://ghcr.io/telorun/type@1.0.5", ENTRY_DIR);
    expect(result).toBe(cachePath("oci/ghcr.io/telorun/type/1.0.5/telo.yaml"));
  });

  it("maps an arbitrary HTTP URL under the url subtree", () => {
    const result = cachePathForCanonical("https://example.com/lib/v1/telo.yaml", ENTRY_DIR);
    expect(result).toBe(cachePath("url/example.com/lib/v1/telo.yaml"));
  });

  it("returns null for file:// sources (already on disk)", () => {
    expect(cachePathForCanonical("file:///tmp/foo/telo.yaml", ENTRY_DIR)).toBeNull();
  });

  it("returns null for memory:// sources (transient)", () => {
    expect(cachePathForCanonical("memory://app/telo.yaml", ENTRY_DIR)).toBeNull();
  });
});

describe("LocalManifestCacheSource.supports", () => {
  it("matches an oci ref when the on-disk file exists", async () => {
    const cacheRoot = path.join(workdir, ".telo/manifests/oci/ghcr.io/telorun/type/1.0.5");
    await fs.mkdir(cacheRoot, { recursive: true });
    await fs.writeFile(path.join(cacheRoot, "telo.yaml"), "kind: Telo.Library\n");

    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("oci://ghcr.io/telorun/type@1.0.5")).toBe(true);
  });

  it("returns false when the ref has no on-disk file (miss falls through)", () => {
    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("oci://ghcr.io/telorun/type@1.0.5")).toBe(false);
  });

  it("matches an HTTP URL when the on-disk file exists", async () => {
    const cacheRoot = path.join(workdir, ".telo/manifests/url/example.com/lib");
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
    // `mkdir -p .telo/manifests/oci/ghcr.io/telorun/foo/1.0.0/telo.yaml` — note the
    // .yaml segment is itself a directory. existsSync would say true here; we need
    // a stricter regular-file check so reads don't blow up with EISDIR and the
    // chain still falls through to the network source.
    await fs.mkdir(
      path.join(workdir, ".telo/manifests/oci/ghcr.io/telorun/foo/1.0.0/telo.yaml"),
      { recursive: true },
    );

    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("oci://ghcr.io/telorun/foo@1.0.0")).toBe(false);
  });

  it("rejects an oci ref with no addressable version", () => {
    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("oci://ghcr.io/telorun/type")).toBe(false);
    expect(source.supports("oci://ghcr.io/telorun/type@sha256:deadbeef")).toBe(false);
  });
});

describe("LocalManifestCacheSource.read", () => {
  it("returns the cached text and a file:// canonical source", async () => {
    const cacheRoot = path.join(workdir, ".telo/manifests/oci/ghcr.io/telorun/run/0.2.4");
    await fs.mkdir(cacheRoot, { recursive: true });
    const expected = "kind: Telo.Library\nmetadata:\n  name: run\n";
    await fs.writeFile(path.join(cacheRoot, "telo.yaml"), expected);

    const source = new LocalManifestCacheSource(workdir);
    const { text, source: canonical } = await source.read("oci://ghcr.io/telorun/run@0.2.4");

    expect(text).toBe(expected);
    expect(canonical.startsWith("file://")).toBe(true);
    expect(canonical.endsWith("/oci/ghcr.io/telorun/run/0.2.4/telo.yaml")).toBe(true);
  });
});

describe("writeManifestCache", () => {
  it("persists every transitively-imported manifest from a graph", async () => {
    // Build a fake graph with an OCI-served import and an HTTP-served import,
    // plus the root entry which must be skipped.
    const rootSource = "file:///tmp/root/telo.yaml";
    const ociTarget = "oci://ghcr.io/telorun/type@1.0.5";
    const httpTarget = "https://example.com/lib/telo.yaml";

    const fakeGraph: any = {
      rootSource,
      entry: null,
      modules: new Map<string, any>([
        [rootSource, { owner: { source: rootSource, text: "entry-text" }, partials: [] }],
        [ociTarget, { owner: { source: ociTarget, text: "oci-text" }, partials: [] }],
        [httpTarget, { owner: { source: httpTarget, text: "http-text" }, partials: [] }],
      ]),
      importEdges: new Map(),
      errors: [],
    };

    const written = await writeManifestCache(fakeGraph, workdir);

    expect(written.length).toBe(2);
    const ociFile = path.join(
      workdir,
      ".telo/manifests/oci/ghcr.io/telorun/type/1.0.5/telo.yaml",
    );
    const httpFile = path.join(workdir, ".telo/manifests/url/example.com/lib/telo.yaml");
    expect(await fs.readFile(ociFile, "utf-8")).toBe("oci-text");
    expect(await fs.readFile(httpFile, "utf-8")).toBe("http-text");

    // The entry itself must not be cached — it already lives on disk.
    const entryCache = path.join(workdir, ".telo/manifests");
    const entries = await fs.readdir(entryCache);
    expect(entries.sort()).toEqual(["oci", "url"]);
  });

  it("dedupes when the same source is reachable through multiple paths", async () => {
    const rootSource = "file:///tmp/root/telo.yaml";
    const shared = "https://example.com/run/0.2.4/telo.yaml";
    const fakeGraph: any = {
      rootSource,
      entry: null,
      modules: new Map<string, any>([
        [rootSource, { owner: { source: rootSource, text: "entry" }, partials: [] }],
        [shared, { owner: { source: shared, text: "shared-text" }, partials: [] }],
      ]),
      importEdges: new Map(),
      errors: [],
    };

    const written = await writeManifestCache(fakeGraph, workdir);
    expect(written.length).toBe(1);
  });

  it("overwrites existing cache entries with freshly fetched bytes (refresh on re-install)", async () => {
    // Seed a stale cache entry, then run writeManifestCache with a graph whose
    // canonical sources are the network URLs (as they would be when the
    // install-time Loader skips the cache source and fetches directly). The
    // on-disk bytes must be the freshly fetched ones, not whatever was there.
    const cacheFile = path.join(
      workdir,
      ".telo/manifests/url/example.com/foo/1.0.0/telo.yaml",
    );
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, "stale-bytes");

    const rootSource = "file:///tmp/root/telo.yaml";
    const target = "https://example.com/foo/1.0.0/telo.yaml";
    const fakeGraph: any = {
      rootSource,
      entry: null,
      modules: new Map<string, any>([
        [rootSource, { owner: { source: rootSource, text: "" }, partials: [] }],
        [target, { owner: { source: target, text: "fresh-bytes" }, partials: [] }],
      ]),
      importEdges: new Map(),
      errors: [],
    };

    await writeManifestCache(fakeGraph, workdir);
    expect(await fs.readFile(cacheFile, "utf-8")).toBe("fresh-bytes");
  });

  it("persists partials alongside their owner", async () => {
    const rootSource = "file:///tmp/root/telo.yaml";
    const ownerSource = "https://example.com/foo/1.0.0/telo.yaml";
    const partialSource = "https://example.com/foo/1.0.0/sub.yaml";
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

    await writeManifestCache(fakeGraph, workdir);

    const partialPath = path.join(
      workdir,
      ".telo/manifests/url/example.com/foo/1.0.0/sub.yaml",
    );
    expect(await fs.readFile(partialPath, "utf-8")).toBe("partial-text");
  });
});

describe("Loader picks the cache source over HttpSource on hit", () => {
  it("serves an HTTP import from disk and never touches the network", async () => {
    // Seed the cache directly.
    const libDir = path.join(workdir, ".telo/manifests/url/example.invalid/foo/1.0.0");
    await fs.mkdir(libDir, { recursive: true });
    await fs.writeFile(
      path.join(libDir, "telo.yaml"),
      ["kind: Telo.Library", "metadata:", "  name: foo", "  version: 1.0.0", ""].join("\n"),
    );

    // The import points at an unreachable host, so a hit is the only way this
    // resolves — which is exactly what the cache is claimed to guarantee.
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
        "source: https://example.invalid/foo/1.0.0/telo.yaml",
        "",
      ].join("\n"),
    );

    const loader = new Loader([
      new LocalFileSource(),
      new LocalManifestCacheSource(workdir),
      ...defaultSources(),
    ]);

    const graph = await loader.loadGraph(entryPath);
    expect(graph.errors).toEqual([]);
    expect(graph.modules.size).toBe(2);
  });

  it("falls through to HttpSource on cache miss", async () => {
    // No cache file written. Same entry as above, but expect a network failure
    // because HttpSource is consulted next.
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
        "source: https://example.invalid/foo/1.0.0/telo.yaml",
        "",
      ].join("\n"),
    );

    const loader = new Loader([
      new LocalFileSource(),
      new LocalManifestCacheSource(workdir),
      ...defaultSources(),
    ]);

    const graph = await loader.loadGraph(entryPath);
    expect(graph.errors.length).toBeGreaterThan(0);
  });
});

describe("path traversal guard", () => {
  it("returns null for a ref no transport owns", () => {
    expect(cachePathForCanonical("foo/../../escape@1.0.0", ENTRY_DIR)).toBeNull();
  });

  it("rejects an oci ref whose repo segments would escape the cache root", () => {
    expect(cachePathForCanonical("oci://ghcr.io/foo/../../escape@1.0.0", ENTRY_DIR)).toBeNull();
  });

  it("URL parser canonicalizes .. in HTTP pathnames so they cannot escape", () => {
    // `new URL()` collapses `..` segments, so a malformed import like this is
    // already neutered before our mapping sees it: pathname becomes
    // `/escape/telo.yaml`, which lands inside the url subtree.
    const result = cachePathForCanonical("https://example.com/../../escape/telo.yaml", ENTRY_DIR);
    expect(result).toBe(cachePath("url/example.com/escape/telo.yaml"));
  });

  it("supports() returns false on a traversal attempt even when a file exists at the escaped path", async () => {
    // Plant a file *outside* the cache root that the bad ref would target.
    const outside = path.join(workdir, "escape", "1.0.0");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "telo.yaml"), "kind: Telo.Library\n");

    // The cache root is workdir/.telo/manifests — so the ref below would
    // otherwise resolve to <workdir>/escape/1.0.0/telo.yaml (above).
    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("oci://ghcr.io/foo/../../../../escape@1.0.0")).toBe(false);
  });
});

describe("query-string disambiguation", () => {
  it("writes distinct cache paths for URLs that differ only in query string", () => {
    const a = cachePathForCanonical("https://example.com/lib/telo.yaml?a=1", ENTRY_DIR);
    const b = cachePathForCanonical("https://example.com/lib/telo.yaml?a=2", ENTRY_DIR);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("writes a distinct path for a fragment", () => {
    const a = cachePathForCanonical("https://example.com/lib/telo.yaml", ENTRY_DIR);
    const b = cachePathForCanonical("https://example.com/lib/telo.yaml#frag", ENTRY_DIR);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("reader and writer agree on the disambiguated path for the same query string", async () => {
    const url = "https://example.com/lib/telo.yaml?a=1";
    const writePath = cachePathForCanonical(url, workdir);
    expect(writePath).not.toBeNull();
    await fs.mkdir(path.dirname(writePath!), { recursive: true });
    await fs.writeFile(writePath!, "kind: Telo.Library\n");

    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports(url)).toBe(true);
    const { text } = await source.read(url);
    expect(text).toContain("kind: Telo.Library");
  });

  it("an un-suffixed URL and its /telo.yaml form share one cache file", async () => {
    // HttpSource appends /telo.yaml; the cache mapping mirrors that
    // normalization, so both import shapes resolve to the same file.
    const writePath = cachePathForCanonical("https://example.com/foo/1.0.0/telo.yaml", workdir);
    expect(writePath).toBe(
      path.join(workdir, ".telo/manifests/url/example.com/foo/1.0.0/telo.yaml"),
    );
    await fs.mkdir(path.dirname(writePath!), { recursive: true });
    await fs.writeFile(writePath!, "kind: Telo.Library\n");

    const source = new LocalManifestCacheSource(workdir);
    expect(source.supports("https://example.com/foo/1.0.0/telo.yaml")).toBe(true);
    expect(source.supports("https://example.com/foo/1.0.0")).toBe(true);
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
    const entry = "file:///ws/app.telo.yaml";
    await writeAnalysisStamp(entry, signature, workdir);
    const stamp = await readAnalysisStamp(entry, workdir);
    expect(stamp?.signature).toBe(signature);
    expect(stamp?.version).toBe(1);
  });

  it("readAnalysisStamp returns undefined when no stamp file exists", async () => {
    expect(await readAnalysisStamp("file:///ws/app.telo.yaml", workdir)).toBeUndefined();
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
