import { sha256Base64Url } from "@telorun/analyzer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RegistryTransport } from "../src/transports/registry-transport.js";

const MANIFEST = "kind: Telo.Library\nmetadata:\n  name: console\n  version: 0.9.0\n";

afterEach(() => vi.restoreAllMocks());

describe("RegistryTransport.refVersion / withVersion", () => {
  const t = new RegistryTransport("https://reg.test");

  it("reads the version out of a bare registry ref (raw, integrity ignored)", () => {
    expect(t.refVersion("std/console@0.9.0")).toBe("0.9.0");
    expect(t.refVersion("std/console@0.9.0#sha256-abc")).toBe("0.9.0");
    expect(t.refVersion("std/console@v1.2.3")).toBe("v1.2.3");
  });

  it("returns null for a direct https URL (no version segment to bump)", () => {
    expect(t.refVersion("https://example.com/modules/console")).toBeNull();
    expect(t.refVersion("https://example.com/x@1.0.0")).toBeNull();
  });

  it("rebuilds the ref at a new version, dropping any integrity fragment", () => {
    expect(t.withVersion("std/console@0.9.0", "1.0.0")).toBe("std/console@1.0.0");
    expect(t.withVersion("std/console@0.9.0#sha256-abc", "1.0.0")).toBe("std/console@1.0.0");
  });
});

describe("RegistryTransport.digest", () => {
  it("hashes the telo.yaml bytes at the registry layout URL", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(String(input));
      return new Response(MANIFEST, { status: 200 });
    });
    const t = new RegistryTransport("https://reg.test");

    const digest = await t.digest("std/console@0.9.0");
    expect(urls).toEqual(["https://reg.test/std/console/0.9.0/telo.yaml"]);
    expect(digest).toBe(`sha256-${await sha256Base64Url(new TextEncoder().encode(MANIFEST))}`);
  });

  it("derives the fetch URL for a direct https ref", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(String(input));
      return new Response(MANIFEST, { status: 200 });
    });
    const t = new RegistryTransport("https://reg.test");

    await t.digest("https://example.com/modules/console");
    await t.digest("https://example.com/modules/console/telo.yaml#sha256-abc");
    expect(urls).toEqual([
      "https://example.com/modules/console/telo.yaml",
      "https://example.com/modules/console/telo.yaml",
    ]);
  });

  it("returns null for a missing version", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(null, { status: 404 }),
    );
    const t = new RegistryTransport("https://reg.test");
    expect(await t.digest("std/console@9.9.9")).toBeNull();
  });
});
