import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpSource } from "../src/sources/http-source.js";
import {
  sha256Base64Url,
  splitIntegrity,
  verifyIntegrity,
} from "../src/sources/integrity.js";

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
  it("splits a trailing sha256 fragment off a module ref", () => {
    expect(splitIntegrity("oci://ghcr.io/telorun/console@0.9.0#sha256-AAAA")).toEqual({
      base: "oci://ghcr.io/telorun/console@0.9.0",
      integrity: "sha256-AAAA",
    });
  });

  it("leaves a ref without an integrity fragment untouched", () => {
    expect(splitIntegrity("oci://ghcr.io/telorun/console@0.9.0")).toEqual({
      base: "oci://ghcr.io/telorun/console@0.9.0",
    });
  });

  it("ignores a non-integrity fragment", () => {
    expect(splitIntegrity("http://x/a.yaml#section")).toEqual({
      base: "http://x/a.yaml#section",
    });
  });
});

describe("verifyIntegrity", () => {
  it("passes when the digest matches", async () => {
    const bytes = enc("hello telo");
    const hash = `sha256-${await sha256Base64Url(bytes)}`;
    await expect(verifyIntegrity(bytes, hash, "ref")).resolves.toBeUndefined();
  });

  it("throws a terminal error on mismatch", async () => {
    await expect(
      verifyIntegrity(enc("tampered"), "sha256-AAAA", "oci://ghcr.io/aws/s3@1.0.0"),
    ).rejects.toThrow(/Integrity check failed for oci:\/\/ghcr\.io\/aws\/s3@1\.0\.0/);
  });

  it("rejects an unsupported algorithm", async () => {
    await expect(verifyIntegrity(enc("x"), "md5-AAAA", "ref")).rejects.toThrow(
      /Unsupported integrity algorithm/,
    );
  });
});

describe("source read verification", () => {
  const manifest = "kind: Telo.Library\nmetadata:\n  name: console\n";

  it("HttpSource serves the manifest when the hash matches", async () => {
    vi.stubGlobal("fetch", mockFetch(manifest));
    const hash = `sha256-${await sha256Base64Url(enc(manifest))}`;
    const src = new HttpSource();
    const { text, source } = await src.read(`https://x.example/console/telo.yaml#${hash}`);
    expect(text).toBe(manifest);
    // The canonical source never carries the integrity fragment.
    expect(source).toBe("https://x.example/console/telo.yaml");
  });

  it("names the origin when a bucket answers 200 with an XML error body", async () => {
    // R2 / S3 surface auth and permission failures this way. Without the sniff
    // the loader parses the XML as YAML and blames the manifest's contents.
    vi.stubGlobal(
      "fetch",
      mockFetch(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>",
      ),
    );
    const src = new HttpSource();
    await expect(src.read("https://x.example/lib/telo.yaml")).rejects.toThrow(
      /non-manifest response.*AccessDenied: Access Denied/s,
    );
  });

  it("reports the XML body ahead of a pin mismatch, so the cause is the origin", async () => {
    // A bucket's error page hashes to something; reporting the pin would name
    // the wrong cause exactly as the loader would.
    vi.stubGlobal("fetch", mockFetch("<Error><Code>NoSuchKey</Code><Message>gone</Message></Error>"));
    const src = new HttpSource();
    await expect(src.read("https://x.example/lib/telo.yaml#sha256-WRONG")).rejects.toThrow(
      /non-manifest response/,
    );
  });

  it("leaves a manifest that merely starts with a angle bracket alone", async () => {
    // The sniff keys on the XML prologue / <Error> root, not on "<".
    const yaml = "kind: Telo.Library\nmetadata:\n  name: lib\n";
    vi.stubGlobal("fetch", mockFetch(yaml));
    const src = new HttpSource();
    await expect(src.read("https://x.example/lib/telo.yaml")).resolves.toMatchObject({ text: yaml });
  });

  it("HttpSource verifies the fetched bytes", async () => {
    vi.stubGlobal("fetch", mockFetch(manifest));
    const src = new HttpSource();
    await expect(src.read("http://x/telo.yaml#sha256-WRONG")).rejects.toThrow(
      /Integrity check failed/,
    );
  });
});
