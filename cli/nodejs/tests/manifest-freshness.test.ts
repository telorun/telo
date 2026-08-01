import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import nock from "nock";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LoadedGraph } from "@telorun/analyzer";
import {
  isCacheableForCheck,
  isOciTagRef,
  isPinnedOciRef,
  originKey,
  readOriginDigests,
  revalidateMutableOciRefs,
  writeOriginDigests,
} from "../src/manifest-freshness.js";

const REGISTRY = "https://registry.example.test";
const HOST = "https://ghcr.io";
const PIN = "#sha256-Ac-5GQaSaOs5uH4jEELH1MLOACS5g0IFK0w21YeBmXY";

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "telo-freshness-"));
}

/** Minimal LoadedGraph — the pass reads only `modules` keys and `importEdges`. */
function graphOf(
  moduleSources: string[],
  edges: Array<{ targetRef: string; targetSource: string }> = [],
): LoadedGraph {
  const importEdges = new Map<string, Map<string, any>>();
  edges.forEach((edge, i) => {
    importEdges.set(`entry-${i}`, new Map([[`Alias${i}`, edge]]));
  });
  return {
    modules: new Map(moduleSources.map((s) => [s, {} as any])),
    importEdges,
  } as unknown as LoadedGraph;
}

/** A HEAD that answers without the bearer dance (anonymous 200). */
function headDigest(repo: string, reference: string, digest: string): nock.Scope {
  return nock(HOST)
    .head(`/v2/${repo}/manifests/${reference}`)
    .reply(200, "", { "docker-content-digest": digest });
}

describe("ref predicates", () => {
  it("treats an oci tag reference as mutable", () => {
    expect(isOciTagRef("oci://ghcr.io/acme/thing@1.2.3")).toBe(true);
    expect(isOciTagRef("oci://ghcr.io/acme/thing")).toBe(true); // implicit latest
  });

  it("treats a sha256: reference as immutable", () => {
    expect(isOciTagRef("oci://ghcr.io/acme/thing@sha256:abc")).toBe(false);
  });

  it("is not fooled by non-oci refs", () => {
    expect(isOciTagRef("std/console@1.0.0")).toBe(false);
    expect(isOciTagRef("https://example.test/telo.yaml")).toBe(false);
    expect(isOciTagRef("./sibling")).toBe(false);
  });

  it("reads the inline pin off the ref as authored", () => {
    expect(isPinnedOciRef(`oci://ghcr.io/acme/thing@1.2.3${PIN}`)).toBe(true);
    // The canonical source a resolved graph carries has the fragment stripped.
    expect(isPinnedOciRef("oci://ghcr.io/acme/thing@1.2.3")).toBe(false);
  });

  it("keys an origin record by host/repo@reference, ignoring the pin", () => {
    expect(originKey(`oci://ghcr.io/acme/thing@1.2.3${PIN}`)).toBe("ghcr.io/acme/thing@1.2.3");
    expect(originKey("oci://ghcr.io/acme/thing@1.2.3")).toBe("ghcr.io/acme/thing@1.2.3");
  });
});

describe("isCacheableForCheck", () => {
  it("serves oci and versioned registry refs from the cache", () => {
    expect(isCacheableForCheck("oci://ghcr.io/acme/thing@1.2.3", REGISTRY)).toBe(true);
    expect(isCacheableForCheck("std/console@1.0.0", REGISTRY)).toBe(true);
  });

  it("never serves an arbitrary HTTP(S) import from the cache", () => {
    // Its cache key carries no version segment, so a hit would be served
    // forever regardless of what the server now returns.
    expect(isCacheableForCheck("https://example.test/some/telo.yaml", REGISTRY)).toBe(false);
    expect(isCacheableForCheck("http://example.test/other/telo.yaml", REGISTRY)).toBe(false);
  });
});

describe("origin digest record", () => {
  it("round-trips", async () => {
    const dir = tmpdir();
    await writeOriginDigests(dir, new Map([["ghcr.io/acme/thing@1.0.0", "sha256:aaa"]]));
    expect(await readOriginDigests(dir)).toEqual(
      new Map([["ghcr.io/acme/thing@1.0.0", "sha256:aaa"]]),
    );
  });

  it("merges rather than replacing, so one entry never drops another's", async () => {
    const dir = tmpdir();
    await writeOriginDigests(dir, new Map([["a@1", "sha256:a"]]));
    await writeOriginDigests(dir, new Map([["b@1", "sha256:b"]]));
    const record = await readOriginDigests(dir);
    expect(record.get("a@1")).toBe("sha256:a");
    expect(record.get("b@1")).toBe("sha256:b");
  });

  it("reads a missing, corrupt, or version-mismatched record as empty", async () => {
    const dir = tmpdir();
    expect(await readOriginDigests(dir)).toEqual(new Map());

    fs.writeFileSync(path.join(dir, ".origins.json"), "{not json");
    expect(await readOriginDigests(dir)).toEqual(new Map());

    fs.writeFileSync(path.join(dir, ".origins.json"), JSON.stringify({ version: 99, digests: {} }));
    expect(await readOriginDigests(dir)).toEqual(new Map());
  });

  it("writes nothing when there is nothing to record", async () => {
    const dir = tmpdir();
    await writeOriginDigests(dir, new Map());
    expect(fs.existsSync(path.join(dir, ".origins.json"))).toBe(false);
  });
});

describe("revalidateMutableOciRefs", () => {
  it("skips a pinned import entirely — no HEAD, nothing to record", async () => {
    // No nock interceptor: any request would throw.
    const source = "oci://ghcr.io/acme/thing@1.2.3";
    const result = await revalidateMutableOciRefs(
      graphOf([source], [{ targetRef: `${source}${PIN}`, targetSource: source }]),
      new Map(),
      new Map(),
      REGISTRY,
    );
    expect(result).toEqual({ staleFiles: [], digests: new Map() });
  });

  it("records a network-fetched mutable tag without ever marking it stale", async () => {
    const scope = headDigest("acme/thing", "1.2.3", "sha256:aaa");
    const result = await revalidateMutableOciRefs(
      graphOf(["oci://ghcr.io/acme/thing@1.2.3"]),
      new Map(),
      new Map(),
      REGISTRY,
    );
    expect(result.staleFiles).toEqual([]);
    expect(result.digests.get("ghcr.io/acme/thing@1.2.3")).toBe("sha256:aaa");
    scope.done();
  });

  it("marks a cache-served entry stale when the record is missing", async () => {
    const dir = tmpdir();
    const cacheFile = path.join(dir, "oci", "ghcr.io", "acme", "thing", "1.2.3", "telo.yaml");
    headDigest("acme/thing", "1.2.3", "sha256:aaa");

    const result = await revalidateMutableOciRefs(
      graphOf([pathToFileURL(cacheFile).href]),
      new Map([["oci://ghcr.io/acme/thing@1.2.3", cacheFile]]),
      new Map([[dir, new Map()]]),
      REGISTRY,
    );
    expect(result.staleFiles).toEqual([cacheFile]);
  });

  it("leaves a cache-served entry alone when the recorded digest still matches", async () => {
    const dir = tmpdir();
    const cacheFile = path.join(dir, "oci", "ghcr.io", "acme", "thing", "1.2.3", "telo.yaml");
    headDigest("acme/thing", "1.2.3", "sha256:aaa");

    const result = await revalidateMutableOciRefs(
      graphOf([pathToFileURL(cacheFile).href]),
      new Map([["oci://ghcr.io/acme/thing@1.2.3", cacheFile]]),
      new Map([[dir, new Map([["ghcr.io/acme/thing@1.2.3", "sha256:aaa"]])]]),
      REGISTRY,
    );
    expect(result.staleFiles).toEqual([]);
  });

  it("marks it stale when the tag has moved", async () => {
    const dir = tmpdir();
    const cacheFile = path.join(dir, "oci", "ghcr.io", "acme", "thing", "1.2.3", "telo.yaml");
    headDigest("acme/thing", "1.2.3", "sha256:bbb");

    const result = await revalidateMutableOciRefs(
      graphOf([pathToFileURL(cacheFile).href]),
      new Map([["oci://ghcr.io/acme/thing@1.2.3", cacheFile]]),
      new Map([[dir, new Map([["ghcr.io/acme/thing@1.2.3", "sha256:aaa"]])]]),
      REGISTRY,
    );
    expect(result.staleFiles).toEqual([cacheFile]);
  });

  it("marks it stale when the tag no longer resolves", async () => {
    const dir = tmpdir();
    const cacheFile = path.join(dir, "oci", "ghcr.io", "acme", "thing", "1.2.3", "telo.yaml");
    nock(HOST).head("/v2/acme/thing/manifests/1.2.3").reply(404);

    const result = await revalidateMutableOciRefs(
      graphOf([pathToFileURL(cacheFile).href]),
      new Map([["oci://ghcr.io/acme/thing@1.2.3", cacheFile]]),
      new Map([[dir, new Map([["ghcr.io/acme/thing@1.2.3", "sha256:aaa"]])]]),
      REGISTRY,
    );
    expect(result.staleFiles).toEqual([cacheFile]);
  });

  it("judges a cache file against the record of the root it came from", async () => {
    // Two roots registered; the file lives under `other`, whose record matches.
    // Reading `mine`'s record instead would call it stale.
    const mine = tmpdir();
    const other = tmpdir();
    const cacheFile = path.join(other, "oci", "ghcr.io", "acme", "thing", "1.2.3", "telo.yaml");
    headDigest("acme/thing", "1.2.3", "sha256:aaa");

    const result = await revalidateMutableOciRefs(
      graphOf([pathToFileURL(cacheFile).href]),
      new Map([["oci://ghcr.io/acme/thing@1.2.3", cacheFile]]),
      new Map([
        [mine, new Map()],
        [other, new Map([["ghcr.io/acme/thing@1.2.3", "sha256:aaa"]])],
      ]),
      REGISTRY,
    );
    expect(result.staleFiles).toEqual([]);
  });

  it("HEADs a shared tag once per invocation, not once per path", async () => {
    const scope = headDigest("acme/thing", "1.2.3", "sha256:aaa");
    const verified = new Map<string, string>();
    const graph = graphOf(["oci://ghcr.io/acme/thing@1.2.3"]);

    const first = await revalidateMutableOciRefs(graph, new Map(), new Map(), REGISTRY, verified);
    // A second path resolving the same tag must not issue another request —
    // only one interceptor is registered, so a second HEAD would throw.
    const second = await revalidateMutableOciRefs(graph, new Map(), new Map(), REGISTRY, verified);

    expect(first.digests.get("ghcr.io/acme/thing@1.2.3")).toBe("sha256:aaa");
    expect(second.digests.get("ghcr.io/acme/thing@1.2.3")).toBe("sha256:aaa");
    scope.done();
  });

  it("prefers the cache-served target when a tag is reached both ways", async () => {
    const dir = tmpdir();
    const cacheFile = path.join(dir, "oci", "ghcr.io", "acme", "thing", "1.2.3", "telo.yaml");
    headDigest("acme/thing", "1.2.3", "sha256:bbb");

    const result = await revalidateMutableOciRefs(
      graphOf([pathToFileURL(cacheFile).href, "oci://ghcr.io/acme/thing@1.2.3"]),
      new Map([["oci://ghcr.io/acme/thing@1.2.3", cacheFile]]),
      new Map([[dir, new Map([["ghcr.io/acme/thing@1.2.3", "sha256:aaa"]])]]),
      REGISTRY,
    );
    expect(result.staleFiles).toEqual([cacheFile]);
  });
});
