import { sha256Base64Url } from "@telorun/analyzer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpTransport } from "../src/transports/http-transport.js";

const MANIFEST = "kind: Telo.Library\nmetadata:\n  name: console\n  version: 0.9.0\n";

afterEach(() => vi.restoreAllMocks());

describe("HttpTransport.supports", () => {
  const t = new HttpTransport();

  it("claims http(s) URLs and nothing else", () => {
    expect(t.supports("https://example.com/modules/console")).toBe(true);
    expect(t.supports("http://example.com/telo.yaml#sha256-abc")).toBe(true);
    expect(t.supports("oci://ghcr.io/telorun/console@0.9.0")).toBe(false);
    expect(t.supports("../sibling")).toBe(false);
  });
});

describe("HttpTransport.refVersion / withVersion", () => {
  const t = new HttpTransport();

  it("returns null — a URL addresses one file and names no version", () => {
    expect(t.refVersion()).toBeNull();
  });

  it("refuses to fabricate a version segment", () => {
    expect(() => t.withVersion("https://example.com/modules/console")).toThrow(
      /carries no version segment/,
    );
  });
});

describe("HttpTransport.listVersions", () => {
  it("enumerates nothing — a URL has no version-list endpoint", async () => {
    expect(await new HttpTransport().listVersions()).toBeNull();
  });
});

describe("HttpTransport.canonicalizeSiblingRef", () => {
  it("refuses, because nothing it computes could ever be published", () => {
    // An `https://host/` destination has no path to resolve `../lib` beside, so
    // joining anyway yields a ref one segment short with no error at all.
    expect(() =>
      new HttpTransport().canonicalizeSiblingRef("https://example.com/", "../lib", "1.0.0"),
    ).toThrow(/publishing over plain HTTP has been removed/i);
  });
});

describe("HttpTransport.digest", () => {
  it("derives the fetch URL and hashes the telo.yaml bytes", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(String(input));
      return new Response(MANIFEST, { status: 200 });
    });
    const t = new HttpTransport();

    const digest = await t.digest("https://example.com/modules/console");
    await t.digest("https://example.com/modules/console/telo.yaml#sha256-abc");
    expect(urls).toEqual([
      "https://example.com/modules/console/telo.yaml",
      "https://example.com/modules/console/telo.yaml",
    ]);
    expect(digest).toBe(`sha256-${await sha256Base64Url(new TextEncoder().encode(MANIFEST))}`);
  });

  it("returns null for a missing manifest", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(null, { status: 404 }),
    );
    expect(await new HttpTransport().digest("https://example.com/modules/gone")).toBeNull();
  });
});
