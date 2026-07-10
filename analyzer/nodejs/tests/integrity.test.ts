import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistrySource } from "../src/sources/registry-source.js";
import { HttpSource } from "../src/sources/http-source.js";
import {
  sha256Base64Url,
  splitIntegrity,
  verifyIntegrity,
} from "../src/sources/integrity.js";
import { parseModuleRef } from "../src/sources/module-ref.js";

const enc = (s: string) => new TextEncoder().encode(s);

function mockFetch(body: string) {
  return vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => enc(body).buffer,
  })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("splitIntegrity", () => {
  it("splits a trailing sha256 fragment off a registry ref", () => {
    expect(splitIntegrity("std/console@0.9.0#sha256-AAAA")).toEqual({
      base: "std/console@0.9.0",
      integrity: "sha256-AAAA",
    });
  });

  it("leaves a ref without an integrity fragment untouched", () => {
    expect(splitIntegrity("std/console@0.9.0")).toEqual({ base: "std/console@0.9.0" });
  });

  it("ignores a non-integrity fragment", () => {
    expect(splitIntegrity("http://x/a.yaml#section")).toEqual({
      base: "http://x/a.yaml#section",
    });
  });
});

describe("parseModuleRef", () => {
  it("strips the integrity fragment and the leading v from the version", () => {
    expect(parseModuleRef("aws/s3@v1.2.0#sha256-ZZZ")).toEqual({
      modulePath: "aws/s3",
      version: "1.2.0",
      integrity: "sha256-ZZZ",
    });
  });

  it("rejects a ref without a namespace slash", () => {
    expect(() => parseModuleRef("console@0.9.0")).toThrow(/expected namespace\/name@version/);
  });
});

describe("verifyIntegrity", () => {
  it("passes when the digest matches", async () => {
    const bytes = enc("hello telo");
    const hash = `sha256-${await sha256Base64Url(bytes)}`;
    await expect(verifyIntegrity(bytes, hash, "ref")).resolves.toBeUndefined();
  });

  it("throws a terminal error on mismatch", async () => {
    await expect(verifyIntegrity(enc("tampered"), "sha256-AAAA", "aws/s3@1.0.0")).rejects.toThrow(
      /Integrity check failed for aws\/s3@1\.0\.0/,
    );
  });

  it("rejects an unsupported algorithm", async () => {
    await expect(verifyIntegrity(enc("x"), "md5-AAAA", "ref")).rejects.toThrow(
      /Unsupported integrity algorithm/,
    );
  });
});

describe("source read verification", () => {
  const manifest = "kind: Telo.Library\nmetadata:\n  name: console\n";

  it("RegistrySource serves the manifest when the hash matches", async () => {
    vi.stubGlobal("fetch", mockFetch(manifest));
    const hash = `sha256-${await sha256Base64Url(enc(manifest))}`;
    const src = new RegistrySource("https://reg.example");
    const { text, source } = await src.read(`std/console@0.9.0#${hash}`);
    expect(text).toBe(manifest);
    // The canonical source never carries the integrity fragment.
    expect(source).toBe("https://reg.example/std/console/0.9.0/telo.yaml");
  });

  it("RegistrySource throws when the hash does not match", async () => {
    vi.stubGlobal("fetch", mockFetch(manifest));
    const src = new RegistrySource("https://reg.example");
    await expect(src.read("std/console@0.9.0#sha256-WRONG")).rejects.toThrow(
      /Integrity check failed/,
    );
  });

  it("HttpSource verifies the fetched bytes", async () => {
    vi.stubGlobal("fetch", mockFetch(manifest));
    const src = new HttpSource();
    await expect(src.read("http://x/telo.yaml#sha256-WRONG")).rejects.toThrow(
      /Integrity check failed/,
    );
  });
});
