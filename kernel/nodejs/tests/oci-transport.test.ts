import { IntegrityError } from "@telorun/analyzer";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OciTransport } from "../src/transports/oci/oci-transport.js";
import { parseOciRef, isOciRef } from "../src/transports/oci/oci-ref.js";

async function toBytes(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(String(body));
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A stateful in-memory OCI distribution registry as a `fetch` implementation.
 *  `requireAuth` gates every /v2 route behind a bearer token to exercise the
 *  `WWW-Authenticate` handshake. */
function mockRegistry(opts: { requireAuth?: boolean } = {}) {
  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, string>(); // `${repo}|${ref}` → json
  const uploads = new Map<string, string>();
  let uploadSeq = 0;
  let tokenRequests = 0;

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const p = url.pathname;

    if (p === "/token") {
      tokenRequests++;
      return json({ token: "test-token" });
    }

    if (opts.requireAuth && p.startsWith("/v2/")) {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== "Bearer test-token") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer realm="https://${url.host}/token",service="reg.test",scope="repository:x:pull,push"`,
          },
        });
      }
    }

    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/v2\/(.+)\/blobs\/uploads\/$/)) && method === "POST") {
      const id = `u${uploadSeq++}`;
      uploads.set(id, m[1]);
      return new Response(null, {
        status: 202,
        headers: { location: `https://${url.host}/upload/${id}` },
      });
    }
    if ((m = p.match(/^\/upload\/(.+)$/)) && method === "PUT") {
      const digest = url.searchParams.get("digest")!;
      blobs.set(digest, await toBytes(init?.body));
      return new Response(null, { status: 201 });
    }
    if ((m = p.match(/^\/v2\/(.+)\/blobs\/(.+)$/))) {
      const digest = m[2];
      if (method === "HEAD") {
        return new Response(null, { status: blobs.has(digest) ? 200 : 404 });
      }
      const b = blobs.get(digest);
      return b ? new Response(b, { status: 200 }) : new Response(null, { status: 404 });
    }
    if ((m = p.match(/^\/v2\/(.+)\/manifests\/(.+)$/))) {
      const key = `${m[1]}|${m[2]}`;
      if (method === "PUT") {
        manifests.set(key, (await toBytes(init?.body)).toString("utf-8"));
        return new Response(null, { status: 201 });
      }
      const man = manifests.get(key);
      if (!man) return new Response(null, { status: 404 });
      const headers = {
        "content-type": "application/json",
        "docker-content-digest": `sha256:${createHash("sha256").update(man).digest("hex")}`,
      };
      return method === "HEAD"
        ? new Response(null, { status: 200, headers })
        : new Response(man, { status: 200, headers });
    }
    if ((m = p.match(/^\/v2\/(.+)\/tags\/list$/))) {
      const repo = m[1];
      const tags = [...manifests.keys()]
        .filter((k) => k.startsWith(`${repo}|`))
        .map((k) => k.split("|")[1]);
      return json({ tags });
    }
    return new Response("not found", { status: 404 });
  };

  return { impl, tokenRequests: () => tokenRequests };
}

const MANIFEST =
  "kind: Telo.Application\nmetadata:\n  name: s3\n  namespace: aws\n  version: 1.2.0\n";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DOCKER_CONFIG;
});

describe("OCI ref parsing", () => {
  it("parses host, repo, reference and integrity", () => {
    expect(parseOciRef("oci://ghcr.io/aws/telo-s3@1.2.0#sha256-abc")).toEqual({
      host: "ghcr.io",
      repo: "aws/telo-s3",
      reference: "1.2.0",
      integrity: "sha256-abc",
    });
  });

  it("defaults the reference to latest and recognizes the scheme", () => {
    expect(parseOciRef("oci://ghcr.io/aws/telo-s3").reference).toBe("latest");
    expect(isOciRef("oci://ghcr.io/x/y@1")).toBe(true);
    expect(isOciRef("std/console@0.9.0")).toBe(false);
  });
});

describe("OciTransport pure methods", () => {
  const t = new OciTransport();

  it("claims oci:// refs and derives cache segments", () => {
    expect(t.supports("oci://ghcr.io/aws/telo-s3@1.2.0")).toBe(true);
    expect(t.supports("std/console@0.9.0")).toBe(false);
    expect(t.cacheLocation("oci://ghcr.io/aws/telo-s3@1.2.0")).toEqual([
      "__oci",
      "ghcr.io",
      "aws",
      "telo-s3",
      "1.2.0",
    ]);
  });

  it("resolves ../lib against the repo directory base", () => {
    expect(t.resolveRelative("oci://ghcr.io/aws/my-app", "../lib")).toBe("oci://ghcr.io/aws/lib");
    expect(t.resolveRelative("oci://ghcr.io/aws/my-app", "std/console@1.0.0")).toBe(
      "std/console@1.0.0",
    );
  });
});

describe("OciTransport round-trip against a mock registry", () => {
  it("publishes, then reads and fetches the artifact back", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry();
    vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    const result = await t.publish("oci://reg.test/aws/telo-s3", {
      manifest: MANIFEST,
      files: [{ name: "public/x.txt", content: Buffer.from("hi") }],
    });
    expect(result.url).toBe("oci://reg.test/aws/telo-s3@1.2.0");

    const read = await t.source.read("oci://reg.test/aws/telo-s3@1.2.0");
    expect(read.text).toContain("name: s3");
    expect(read.text).toContain("filesIntegrity:");
    expect(read.source).toBe("oci://reg.test/aws/telo-s3@1.2.0");

    const artifact = await t.fetchArtifact("oci://reg.test/aws/telo-s3@1.2.0");
    const payload = artifact.files.find((f) => f.name === "public/x.txt");
    expect(payload?.content.toString()).toBe("hi");

    expect(await t.listVersions("oci://reg.test/aws/telo-s3@1.2.0")).toEqual(["1.2.0"]);
  });

  it("performs the WWW-Authenticate token handshake", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry({ requireAuth: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    await t.publish("oci://reg.test/aws/telo-s3", { manifest: MANIFEST, files: [] });
    const read = await t.source.read("oci://reg.test/aws/telo-s3@1.2.0");
    expect(read.text).toContain("name: s3");
    expect(reg.tokenRequests()).toBeGreaterThan(0);
  });

  it("reports a version's content digest via HEAD, null when missing", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry();
    vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    await t.publish("oci://reg.test/aws/telo-s3", { manifest: MANIFEST, files: [] });
    const digest = await t.digest("oci://reg.test/aws/telo-s3@1.2.0");
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Stable across reads — the tracker compares it for equality on every track.
    expect(await t.digest("oci://reg.test/aws/telo-s3@1.2.0")).toBe(digest);
    expect(await t.digest("oci://reg.test/aws/telo-s3@9.9.9")).toBeNull();
  });

  it("follows tags/list pagination Link headers", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const pages = [
      new Response(JSON.stringify({ tags: ["1.0.0", "1.1.0"] }), {
        status: 200,
        headers: { link: '</v2/aws/telo-s3/tags/list?last=1.1.0&n=1000>; rel="next"' },
      }),
      new Response(JSON.stringify({ tags: ["1.2.0"] }), { status: 200 }),
    ];
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(String(input));
      return pages.shift() ?? new Response(JSON.stringify({ tags: [] }), { status: 200 });
    });
    const t = new OciTransport();

    expect(await t.listVersions("oci://reg.test/aws/telo-s3")).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("last=1.1.0");
  });

  it("hard-fails a pinned read when the inline hash does not match", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry();
    vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    await t.publish("oci://reg.test/aws/telo-s3", { manifest: MANIFEST, files: [] });
    await expect(
      t.source.read("oci://reg.test/aws/telo-s3@1.2.0#sha256-deadbeefdeadbeefdeadbeefdeadbeef"),
    ).rejects.toBeInstanceOf(IntegrityError);
  });
});
