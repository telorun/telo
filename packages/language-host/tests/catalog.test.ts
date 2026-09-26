import { afterEach, describe, expect, it, vi } from "vitest";
import { knownVersions, loadCatalog, type StoredCatalog } from "../src/version-catalog.js";
import { fakeRegistry } from "./registry-fixture.js";

const memory = (initial?: StoredCatalog) => {
  let stored = initial;
  return { read: async () => stored, write: async (c: StoredCatalog) => void (stored = c) };
};

const load = (options: Partial<Parameters<typeof loadCatalog>[0]> & Pick<Parameters<typeof loadCatalog>[0], "cache">) =>
  loadCatalog({ speaks: [1], warn: () => undefined, ...options });

afterEach(() => {
  vi.useRealTimers();
});

describe("the version catalog", () => {
  // Only an engine this host can speak to is offered; the one it ships always is.
  it("offers spoken, released, current versions and always the bundled one", async () => {
    const registry = await fakeRegistry(["0.103.0", "0.104.0"], {
      "0.101.0": { dist: { tarball: "t", integrity: "sha512-x" } },
      "0.105.0": { teloEditorProtocol: 2, dist: { tarball: "t", integrity: "sha512-x" } },
      "0.106.0-rc.1": { teloEditorProtocol: 1, dist: { tarball: "t", integrity: "sha512-x" } },
      "0.107.0": { teloEditorProtocol: 1, deprecated: "broken", dist: { tarball: "t", integrity: "sha512-x" } },
    });
    const catalog = await load({ cache: memory(), fetch: registry.fetch });
    expect(knownVersions({ ...catalog, bundled: "0.102.0" })).toEqual(["0.104.0", "0.103.0", "0.102.0"]);
    expect(catalog.unoffered).toEqual({
      "0.101.0": "below-protocol-floor",
      "0.105.0": "unspoken-generation",
      "0.106.0-rc.1": "prerelease",
      "0.107.0": "deprecated",
    });
  });

  it("falls back offline to the cached catalog, then to the bundled version alone", async () => {
    const registry = await fakeRegistry(["0.103.0"]);
    const cache = memory();
    await load({ cache, fetch: registry.fetch });
    registry.offline = true;

    const cached = await load({ cache, fetch: registry.fetch });
    expect([cached.source, knownVersions({ ...cached, bundled: "0.102.0" })]).toEqual(["cache", ["0.103.0", "0.102.0"]]);
    expect(cached.failure).toMatch(/could not reach/);

    const bare = await load({ cache: memory(), fetch: registry.fetch });
    expect([bare.source, knownVersions({ ...bare, bundled: "0.102.0" })]).toEqual(["bundled", ["0.102.0"]]);
  });

  it("stops waiting for the registry after 15 s and reads the cached catalog", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const cache = memory({ offered: [{ version: "0.103.0", tarball: "t", integrity: "sha512-x" }], unoffered: {} });
    const reading = load({ cache, fetch: () => new Promise<Response>(() => undefined) });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await reading).toMatchObject({
      source: "cache",
      failure: "https://registry.npmjs.org/@telorun/language-server did not answer within 15 s",
    });
  });

  it("keeps a fresh catalog the cache cannot store, reporting the cache's failure", async () => {
    const registry = await fakeRegistry(["0.103.0"]);
    const warnings: string[] = [];
    const catalog = await load({
      cache: {
        read: async () => undefined,
        write: async () => {
          throw new Error("QuotaExceededError: the storage quota was exceeded");
        },
      },
      fetch: registry.fetch,
      warn: (message) => warnings.push(message),
    });
    expect([catalog.source, catalog.offered.map((e) => e.version), catalog.failure]).toEqual([
      "registry",
      ["0.103.0"],
      undefined,
    ]);
    expect(warnings).toEqual([
      "telo: the engine catalog read from https://registry.npmjs.org/@telorun/language-server could not be cached for offline use: QuotaExceededError: the storage quota was exceeded",
    ]);
  });
});
