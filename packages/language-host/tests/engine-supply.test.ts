import { describe, expect, it } from "vitest";
import { EngineIntegrityError } from "../src/engine-archive.js";
import { loadEngine } from "../src/engine-supply.js";
import type { CachedEngine } from "../src/host-seams.js";
import { loadCatalog } from "../src/version-catalog.js";
import { engineCode, fakeRegistry } from "./registry-fixture.js";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function setup() {
  const registry = await fakeRegistry(["0.103.0"]);
  const catalog = await loadCatalog({
    speaks: [1],
    cache: { read: async () => undefined, write: async () => undefined },
    fetch: registry.fetch,
    warn: (message) => {
      throw new Error(message);
    },
  });
  const stored = new Map<string, CachedEngine>();
  const cache = {
    get: async (v: string) => stored.get(v),
    put: async (v: string, e: CachedEngine) => void stored.set(v, e),
    has: async (v: string) => stored.has(v),
  };
  const warnings: string[] = [];
  const load = () =>
    loadEngine({
      version: "0.103.0",
      catalog,
      cache,
      speaks: [1],
      fetch: registry.fetch,
      warn: (m) => warnings.push(m),
    });
  return { registry, stored, warnings, load };
}

describe("engine supply", () => {
  it("refuses a tarball with one flipped byte, naming the version", async () => {
    const { registry, load } = await setup();
    const tarball = [...registry.tarballs.values()][0]!;
    tarball[tarball.length - 10] ^= 0xff;
    const refused = load();
    await expect(refused).rejects.toBeInstanceOf(EngineIntegrityError);
    await expect(refused).rejects.toThrow(/telo 0\.103\.0 engine does not match its published integrity/);
  });

  it("refuses a cached engine that no longer matches its digest and fetches it again", async () => {
    const { stored, warnings, load } = await setup();
    await load();
    const cached = stored.get("0.103.0")!;
    stored.set("0.103.0", { ...cached, bytes: new TextEncoder().encode("tampered") });

    expect(text(await load())).toBe(engineCode("0.103.0"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/cached telo 0\.103\.0 engine no longer matches/);
    expect(text(stored.get("0.103.0")!.bytes)).toBe(engineCode("0.103.0"));
  });
});
