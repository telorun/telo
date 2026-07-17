import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MANIFEST_CACHE_BASE_URL,
  ManifestCacheSource,
  manifestCacheKey,
  manifestCacheUrl,
  ociManifestCacheCoords,
} from "../src/sources/manifest-cache.js";
import { IntegrityError, sha256Base64Url } from "../src/sources/integrity.js";

describe("manifestCacheKey", () => {
  it("builds <transport>/<host>/<path…>/<version>/telo.yaml", () => {
    expect(
      manifestCacheKey({ transport: "oci", host: "ghcr.io", path: "aws/telo-s3", version: "1.2.0" }),
    ).toBe("oci/ghcr.io/aws/telo-s3/1.2.0/telo.yaml");
  });

  it("nests a multi-segment OCI repo path as prefixes", () => {
    expect(
      manifestCacheKey({
        transport: "oci",
        host: "ghcr.io",
        path: "telorun/integrations/jetbrains/youtrack",
        version: "2.1.0",
      }),
    ).toBe("oci/ghcr.io/telorun/integrations/jetbrains/youtrack/2.1.0/telo.yaml");
  });

  it("rejects traversal and empty segments", () => {
    expect(manifestCacheKey({ transport: "oci", host: "ghcr.io", path: "../etc", version: "1.0.0" })).toBeNull();
    expect(manifestCacheKey({ transport: "oci", host: "ghcr.io", path: "a//b", version: "1.0.0" })).toBeNull();
    expect(manifestCacheKey({ transport: "oci", host: "", path: "aws/s3", version: "1.0.0" })).toBeNull();
    expect(manifestCacheKey({ transport: "oci", host: "ghcr.io", path: "aws/s3", version: "." })).toBeNull();
    expect(manifestCacheKey({ transport: "oci", host: "ghcr.io", path: "aws/s3", version: "1/0" })).toBeNull();
  });
});

describe("ociManifestCacheCoords", () => {
  it("parses a tagged oci ref", () => {
    expect(ociManifestCacheCoords("oci://ghcr.io/aws/telo-s3@1.2.0")).toEqual({
      transport: "oci",
      host: "ghcr.io",
      path: "aws/telo-s3",
      version: "1.2.0",
    });
  });

  it("tolerates an inline integrity fragment", () => {
    expect(ociManifestCacheCoords("oci://ghcr.io/aws/telo-s3@1.2.0#sha256-abc123")).toEqual({
      transport: "oci",
      host: "ghcr.io",
      path: "aws/telo-s3",
      version: "1.2.0",
    });
  });

  it("returns null without an explicit tag", () => {
    // Defaulted `latest` is not addressable — the cache is keyed by enumerated tags.
    expect(ociManifestCacheCoords("oci://ghcr.io/aws/telo-s3")).toBeNull();
    // A digest reference is not a human version tag.
    expect(ociManifestCacheCoords("oci://ghcr.io/aws/telo-s3@sha256:deadbeef")).toBeNull();
    // Non-OCI refs are never claimed.
    expect(ociManifestCacheCoords("std/console@0.9.0")).toBeNull();
    expect(ociManifestCacheCoords("https://example.com/telo.yaml")).toBeNull();
  });

  it("accepts an explicit @latest tag", () => {
    expect(ociManifestCacheCoords("oci://ghcr.io/aws/telo-s3@latest")?.version).toBe("latest");
  });
});

describe("manifestCacheUrl", () => {
  it("builds the full URL from a ref", () => {
    expect(manifestCacheUrl("oci://ghcr.io/aws/telo-s3@1.2.0")).toBe(
      `${MANIFEST_CACHE_BASE_URL}/oci/ghcr.io/aws/telo-s3/1.2.0/telo.yaml`,
    );
  });

  it("respects a custom base URL and trims trailing slashes", () => {
    expect(manifestCacheUrl("oci://ghcr.io/aws/telo-s3@1.2.0", "http://localhost:8080/")).toBe(
      "http://localhost:8080/oci/ghcr.io/aws/telo-s3/1.2.0/telo.yaml",
    );
  });

  it("returns null for an unaddressable ref", () => {
    expect(manifestCacheUrl("oci://ghcr.io/aws/telo-s3")).toBeNull();
  });
});

describe("ManifestCacheSource", () => {
  afterEach(() => vi.unstubAllGlobals());

  const manifest = "kind: Telo.Library\nmetadata:\n  name: s3\n  version: 1.2.0\n";

  function stubFetch(text: string, ok = true) {
    const fetchMock = vi.fn(async () => ({
      ok,
      status: ok ? 200 : 404,
      statusText: ok ? "OK" : "Not Found",
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("claims every oci ref (unaddressable ones get read()'s actionable error), nothing else", () => {
    const source = new ManifestCacheSource();
    expect(source.supports("oci://ghcr.io/aws/telo-s3@1.2.0")).toBe(true);
    expect(source.supports("oci://ghcr.io/aws/telo-s3")).toBe(true);
    expect(source.supports("oci://ghcr.io/aws/telo-s3@sha256:deadbeef")).toBe(true);
    expect(source.supports("std/console@0.9.0")).toBe(false);
    expect(source.supports("https://example.com/telo.yaml")).toBe(false);
  });

  it("reads from the deterministic cache key and returns the canonical oci source", async () => {
    const fetchMock = stubFetch(manifest);
    const source = new ManifestCacheSource("http://cache.test");
    const result = await source.read("oci://ghcr.io/aws/telo-s3@1.2.0");
    expect(fetchMock).toHaveBeenCalledWith("http://cache.test/oci/ghcr.io/aws/telo-s3/1.2.0/telo.yaml");
    expect(result.text).toBe(manifest);
    expect(result.source).toBe("oci://ghcr.io/aws/telo-s3@1.2.0");
  });

  it("verifies a pinned ref against the fetched bytes", async () => {
    stubFetch(manifest);
    const source = new ManifestCacheSource("http://cache.test");
    const hash = await sha256Base64Url(new TextEncoder().encode(manifest));
    const result = await source.read(`oci://ghcr.io/aws/telo-s3@1.2.0#sha256-${hash}`);
    expect(result.text).toBe(manifest);
  });

  it("throws IntegrityError when a pinned ref's bytes moved", async () => {
    stubFetch("kind: Telo.Library\nmetadata: { name: tampered }\n");
    const source = new ManifestCacheSource("http://cache.test");
    const hash = await sha256Base64Url(new TextEncoder().encode(manifest));
    await expect(source.read(`oci://ghcr.io/aws/telo-s3@1.2.0#sha256-${hash}`)).rejects.toBeInstanceOf(
      IntegrityError,
    );
  });

  it("surfaces a fetch failure with the cache URL", async () => {
    stubFetch("", false);
    const source = new ManifestCacheSource("http://cache.test");
    await expect(source.read("oci://ghcr.io/aws/telo-s3@1.2.0")).rejects.toThrow(
      /404.*http:\/\/cache\.test\/oci\/ghcr\.io\/aws\/telo-s3\/1\.2\.0\/telo\.yaml/,
    );
  });

  it("rejects an unaddressable ref with an actionable message", async () => {
    const source = new ManifestCacheSource();
    await expect(source.read("oci://ghcr.io/aws/telo-s3")).rejects.toThrow(/explicit version tag/);
  });

  it("resolves relative sibling imports against the repo path", () => {
    const source = new ManifestCacheSource();
    expect(source.resolveRelative("oci://ghcr.io/aws/my-app@1.0.0", "../lib")).toBe("oci://ghcr.io/aws/lib");
    expect(source.resolveRelative("oci://ghcr.io/aws/my-app@1.0.0", "std/console@0.9.0")).toBe(
      "std/console@0.9.0",
    );
  });
});
