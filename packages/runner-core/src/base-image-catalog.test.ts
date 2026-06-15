import { describe, expect, it } from "vitest";

import {
  BaseImageCatalog,
  filterTags,
  parseDockerHubRef,
  resolveTagDigest,
} from "./base-image-catalog.js";

const SAMPLE = [
  "latest",
  "latest-slim",
  "0",
  "0-slim",
  "0.30",
  "0.30-slim",
  "0.30.1",
  "0.30.1-slim",
  "0.30.0",
  "0.29.3-slim",
  "latest-rust-1.95.0-slim",
  "0.30.1-rust-1.95.0",
  "0.30.1-rc.1",
  "0.30.1-rc.1-slim",
  "sha-abc1234",
  "deadbeef1234",
];

describe("filterTags", () => {
  it("pinnedOnly keeps only MAJOR.MINOR.PATCH[-variant] tags", () => {
    const out = filterTags(SAMPLE, { pinnedOnly: true });
    expect(out).toEqual([
      "0.30.1",
      "0.30.1-slim",
      "0.30.0",
      "0.29.3-slim",
      "0.30.1-rust-1.95.0",
      "0.30.1-rc.1",
      "0.30.1-rc.1-slim",
    ]);
  });

  it("excludeSha drops commit-hash tags", () => {
    const out = filterTags(SAMPLE, { excludeSha: true });
    expect(out).not.toContain("sha-abc1234");
    expect(out).not.toContain("deadbeef1234");
    expect(out).toContain("0.30.1");
  });

  it("excludePrerelease drops semver prereleases but keeps build variants", () => {
    const out = filterTags(["0.30.1", "0.30.1-slim", "0.30.1-rust-1.95.0", "0.30.1-rc.1", "0.30.1-rc.1-slim"], {
      excludePrerelease: true,
    });
    expect(out).toEqual(["0.30.1", "0.30.1-slim", "0.30.1-rust-1.95.0"]);
  });

  it("pinnedOnly + excludeSha + excludePrerelease yields the release menu", () => {
    const out = filterTags(SAMPLE, { pinnedOnly: true, excludeSha: true, excludePrerelease: true });
    expect(out).toEqual(["0.30.1", "0.30.1-slim", "0.30.0", "0.29.3-slim", "0.30.1-rust-1.95.0"]);
  });

  it("include / exclude regexes are the escape hatch", () => {
    expect(filterTags(SAMPLE, { include: [/-slim$/] })).toEqual([
      "latest-slim",
      "0-slim",
      "0.30-slim",
      "0.30.1-slim",
      "0.29.3-slim",
      "latest-rust-1.95.0-slim",
      "0.30.1-rc.1-slim",
    ]);
    expect(filterTags(SAMPLE, { pinnedOnly: true, exclude: [/-rust-/] })).not.toContain(
      "0.30.1-rust-1.95.0",
    );
  });
});

/** A fake Docker Hub tags endpoint serving one page of `results`. */
function fakeHub(results: Array<{ name: string; last_updated?: string }>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ next: null, results }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("BaseImageCatalog", () => {
  const defaultRef = "telorun/node:latest-slim";

  it("serves only the default before the first refresh", () => {
    const catalog = new BaseImageCatalog({ repository: "telorun/node", defaultRef });
    expect(catalog.current()).toEqual([defaultRef]);
    expect(catalog.isAllowed(defaultRef)).toBe(true);
    expect(catalog.isAllowed("telorun/node:0.30.1-slim")).toBe(false);
  });

  it("advertises the default first, then filtered tags newest-first within the limit", async () => {
    const catalog = new BaseImageCatalog({
      repository: "telorun/node",
      defaultRef,
      filter: { pinnedOnly: true },
      limit: 2,
      fetchImpl: fakeHub([
        { name: "0.30.0", last_updated: "2026-06-14T00:00:00Z" },
        { name: "0.30.1", last_updated: "2026-06-15T00:00:00Z" },
        { name: "0.29.9", last_updated: "2026-06-10T00:00:00Z" },
        { name: "latest", last_updated: "2026-06-15T00:00:00Z" },
      ]),
    });
    await catalog.refresh();
    expect(catalog.current()).toEqual([
      defaultRef,
      "telorun/node:0.30.1",
      "telorun/node:0.30.0",
    ]);
    expect(catalog.isAllowed("telorun/node:0.30.1")).toBe(true);
    expect(catalog.isAllowed("telorun/node:0.29.9")).toBe(false); // dropped by limit
  });

  it("keeps the default offered even when filters would exclude it", async () => {
    const catalog = new BaseImageCatalog({
      repository: "telorun/node",
      defaultRef, // latest-slim — a moving tag pinnedOnly drops
      filter: { pinnedOnly: true },
      fetchImpl: fakeHub([{ name: "0.30.1", last_updated: "2026-06-15T00:00:00Z" }]),
    });
    await catalog.refresh();
    expect(catalog.current()).toContain(defaultRef);
    expect(catalog.isAllowed(defaultRef)).toBe(true);
  });

  it("throws on a non-ok Docker Hub response so the caller can degrade", async () => {
    const catalog = new BaseImageCatalog({
      repository: "telorun/node",
      defaultRef,
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(catalog.refresh()).rejects.toThrow(/Docker Hub tags request/);
    expect(catalog.current()).toEqual([defaultRef]); // unchanged
  });
});

describe("parseDockerHubRef", () => {
  it("parses namespace/repo:tag", () => {
    expect(parseDockerHubRef("telorun/node:latest-slim")).toEqual({
      namespace: "telorun",
      repo: "node",
      tag: "latest-slim",
      digest: undefined,
    });
  });

  it("defaults the tag and the library namespace", () => {
    expect(parseDockerHubRef("node")).toMatchObject({ namespace: "library", repo: "node", tag: "latest" });
  });

  it("strips a docker.io host and carries an @digest through", () => {
    expect(parseDockerHubRef("docker.io/telorun/node:0.30.1")).toMatchObject({
      namespace: "telorun",
      repo: "node",
      tag: "0.30.1",
    });
    expect(parseDockerHubRef("telorun/node@sha256:abc")?.digest).toBe("sha256:abc");
  });

  it("returns null for a non-Docker-Hub registry", () => {
    expect(parseDockerHubRef("ghcr.io/telorun/node:latest")).toBeNull();
    expect(parseDockerHubRef("registry.telo-runner.svc:5000/x:y")).toBeNull();
  });
});

describe("resolveTagDigest", () => {
  it("returns an already-pinned digest without a network call", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(await resolveTagDigest("telorun/node@sha256:deadbeef", { fetchImpl })).toBe(
      "sha256:deadbeef",
    );
    expect(called).toBe(false);
  });

  it("reads the manifest digest from the Docker Hub tag endpoint", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ digest: "sha256:abc123", images: [{ digest: "sha256:zzz" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    expect(await resolveTagDigest("telorun/node:latest-slim", { fetchImpl })).toBe("sha256:abc123");
  });

  it("returns undefined for a non-Hub ref or on a failed request", async () => {
    expect(await resolveTagDigest("ghcr.io/foo/bar:1")).toBeUndefined();
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    expect(await resolveTagDigest("telorun/node:missing", { fetchImpl })).toBeUndefined();
  });

  it("reports a genuine Hub failure to onError but stays silent for a non-Hub ref", async () => {
    const errors: unknown[] = [];
    const fail = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await resolveTagDigest("telorun/node:latest", { fetchImpl: fail, onError: (e) => errors.push(e) });
    expect(errors).toHaveLength(1);

    await resolveTagDigest("ghcr.io/foo/bar:1", { onError: (e) => errors.push(e) });
    expect(errors).toHaveLength(1); // non-Hub ref is not an error
  });
});
