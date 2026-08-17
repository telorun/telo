import { IntegrityError, selectorKey } from "@telorun/analyzer";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OciTransport } from "../src/transports/oci/oci-transport.js";
import type { PayloadLayer } from "../src/transports/transport.js";
import { parseOciRef, isOciRef } from "../src/transports/oci/oci-ref.js";
import {
  OciClient,
  TELO_LEGACY_LAYER_MEDIA_TYPE,
  TELO_MANIFEST_LAYER_MEDIA_TYPE,
  TELO_PAYLOAD_LAYER_MEDIA_TYPE,
} from "../src/transports/oci/oci-client.js";
import { makeTarGz } from "../src/bundle/tar.js";
import { computeFilesIntegrity, injectLayerIndex } from "../src/bundle/files-integrity.js";
import { readOwnerManifest } from "../src/bundle/module-manifest.js";

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

  return {
    impl,
    tokenRequests: () => tokenRequests,
    manifestJson: (repo: string, ref: string) => JSON.parse(manifests.get(`${repo}|${ref}`) ?? "{}"),
  };
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

  it("claims oci:// refs and derives cache coordinates", () => {
    expect(t.supports("oci://ghcr.io/aws/telo-s3@1.2.0")).toBe(true);
    expect(t.supports("std/console@0.9.0")).toBe(false);
    expect(t.cacheCoords("oci://ghcr.io/aws/telo-s3@1.2.0")).toEqual({
      transport: "oci",
      host: "ghcr.io",
      path: "aws/telo-s3",
      version: "1.2.0",
    });
  });

  it("resolves ../lib against the repo directory base", () => {
    expect(t.resolveRelative("oci://ghcr.io/aws/my-app", "../lib")).toBe("oci://ghcr.io/aws/lib");
    expect(t.resolveRelative("oci://ghcr.io/aws/my-app", "std/console@1.0.0")).toBe(
      "std/console@1.0.0",
    );
  });

  it("reads the tag / digest reference via refVersion", () => {
    expect(t.refVersion("oci://ghcr.io/telorun/http-server@0.19.1")).toBe("0.19.1");
    expect(t.refVersion("oci://ghcr.io/telorun/http-server@0.19.1#sha256-abc")).toBe("0.19.1");
    // A digest reference flows through raw — the caller's SemVer check skips it.
    expect(t.refVersion("oci://ghcr.io/aws/telo-s3@sha256:deadbeef")).toBe("sha256:deadbeef");
    // No explicit reference → not an upgradeable pin.
    expect(t.refVersion("oci://ghcr.io/aws/telo-s3")).toBeNull();
    expect(t.refVersion("std/console@0.9.0")).toBeNull();
  });

  it("rebuilds the ref at a new version via withVersion", () => {
    expect(t.withVersion("oci://ghcr.io/telorun/http-server@0.19.1", "0.20.0")).toBe(
      "oci://ghcr.io/telorun/http-server@0.20.0",
    );
    // Multi-segment repos and integrity fragments are preserved / dropped.
    expect(t.withVersion("oci://ghcr.io/aws/telo-s3@1.2.0#sha256-abc", "1.3.0")).toBe(
      "oci://ghcr.io/aws/telo-s3@1.3.0",
    );
  });
});

/**
 * What the payload builder hands the transport: the `layers:` index is already
 * in the manifest, because that text is what a dependent hashes to derive its
 * import pin. A bundle whose manifest omits it is refused at publish — the
 * transport no longer rewrites the bytes it was given.
 */
async function bundleFor(manifest: string, layers: PayloadLayer[]) {
  const index = await new OciTransport().layerIndex(layers);
  return {
    manifest: index.length > 0 ? injectLayerIndex(manifest, index) : manifest,
    layers,
  };
}

describe("OciTransport round-trip against a mock registry", () => {
  it("publishes, then reads and fetches the artifact back", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry();
    vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    const bundle = await bundleFor(MANIFEST, [
      { role: "assets", files: [{ name: "public/x.txt", content: Buffer.from("hi") }] },
    ]);
    const result = await t.publish("oci://reg.test/aws/telo-s3", bundle);
    expect(result.url).toBe("oci://reg.test/aws/telo-s3@1.2.0");

    // Reading a manifest pulls the manifest layer alone — the payload is a
    // separate blob, so nothing downloads it here.
    const read = await t.source.read("oci://reg.test/aws/telo-s3@1.2.0");
    expect(read.text).toContain("name: s3");
    expect(read.source).toBe("oci://reg.test/aws/telo-s3@1.2.0");

    // The index in the manifest is what addresses the payload.
    const layers = readOwnerManifest(read.text).layers!;
    expect(layers).toHaveLength(1);
    expect(layers[0].role).toBe("assets");
    expect(layers[0].blob).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(layers[0].integrity).toMatch(/^sha256-[A-Za-z0-9_-]{43}$/);

    const files = await t.fetchLayer("oci://reg.test/aws/telo-s3@1.2.0", layers[0].blob);
    expect(files.find((f) => f.name === "public/x.txt")?.content.toString()).toBe("hi");
    // The layer's own content digest re-derives from what was extracted.
    expect(await computeFilesIntegrity(files)).toBe(layers[0].integrity);

    expect(await t.listVersions("oci://reg.test/aws/telo-s3@1.2.0")).toEqual(["1.2.0"]);
  });

  it("publishes the manifest bytes it was handed, verbatim", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry();
    vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    const bundle = await bundleFor(MANIFEST, [
      { role: "assets", files: [{ name: "public/x.txt", content: Buffer.from("hi") }] },
    ]);
    await t.publish("oci://reg.test/aws/telo-s3", bundle);

    // The whole point. A dependent derives its pin by hashing the manifest its
    // dependency's payload builder produced, so any rewrite between there and
    // the registry makes that pin name bytes nobody serves — which is what
    // injecting the index at push time did to 18 standard-library modules.
    const read = await t.source.read("oci://reg.test/aws/telo-s3@1.2.0");
    expect(read.text).toBe(bundle.manifest);
  });

  it("refuses to publish when a pushed layer contradicts the manifest's index", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry();
    vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    // An index built for different files: the manifest promises a digest the
    // layer being pushed does not have. Correcting it here is not available —
    // the manifest is already pinned by whoever hashed it — so publish fails.
    const bundle = await bundleFor(MANIFEST, [
      { role: "assets", files: [{ name: "a.txt", content: Buffer.from("declared") }] },
    ]);
    await expect(
      t.publish("oci://reg.test/aws/telo-s3", {
        manifest: bundle.manifest,
        layers: [{ role: "assets", files: [{ name: "a.txt", content: Buffer.from("actual") }] }],
      }),
    ).rejects.toThrow(/'layers:' index claims/);
  });

  it("gives each controller selector its own layer and leaves telo.yaml alone in its own", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry();
    vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    await t.publish(
      "oci://reg.test/aws/telo-s3",
      await bundleFor(MANIFEST, [
        {
          role: "controller",
          selector: { format: "js" },
          files: [{ name: "nodejs/c.mjs", content: Buffer.from("export const x=1") }],
        },
        {
          role: "controller",
          selector: { format: "napi", os: "linux", arch: "amd64", libc: "gnu" },
          files: [{ name: "rust/c.node", content: Buffer.from("binary") }],
        },
        { role: "common", files: [{ name: "rust/lib.so", content: Buffer.from("sidecar") }] },
      ]),
    );

    const ociManifest = reg.manifestJson("aws/telo-s3", "1.2.0");
    // The manifest layer comes first and is the only one located by media type.
    expect(ociManifest.layers[0].mediaType).toBe(TELO_MANIFEST_LAYER_MEDIA_TYPE);
    expect(ociManifest.layers).toHaveLength(4);
    expect(ociManifest.layers.slice(1).map((l: any) => l.mediaType)).toEqual([
      TELO_PAYLOAD_LAYER_MEDIA_TYPE,
      TELO_PAYLOAD_LAYER_MEDIA_TYPE,
      TELO_PAYLOAD_LAYER_MEDIA_TYPE,
    ]);

    const index = readOwnerManifest((await t.source.read("oci://reg.test/aws/telo-s3@1.2.0")).text)
      .layers!;
    expect(index.map((l) => (l.selector ? selectorKey(l.selector) : l.role))).toEqual([
      "format=js",
      "arch=amd64;format=napi;libc=gnu;os=linux",
      "common",
    ]);

    // A host fetches exactly one controller layer: the js one carries only its
    // own file, so the napi binary is never transferred.
    const js = await t.fetchLayer("oci://reg.test/aws/telo-s3@1.2.0", index[0].blob);
    expect(js.map((f) => f.name)).toEqual(["nodejs/c.mjs"]);
  });

  // Every module published before layers existed is one blob carrying telo.yaml
  // plus its whole payload. The read path only ever wants telo.yaml, which that
  // blob has — so an already-published module keeps resolving, and the npm-backed
  // majority (no payload at all) is entirely unaffected by the format change.
  it("still reads telo.yaml out of a pre-layers single-blob artifact", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry();
    vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    // Hand-build the legacy shape: one layer, telo.yaml inside it.
    const tar = await makeTarGz([{ name: "telo.yaml", content: MANIFEST }]);
    const client = new OciClient("reg.test", "aws/telo-s3");
    const digest = await client.pushBlob(tar);
    await client.pushManifest("1.2.0", {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: await client.pushEmptyConfig(),
      layers: [
        { mediaType: TELO_LEGACY_LAYER_MEDIA_TYPE, digest, size: tar.length },
      ],
    });

    const read = await t.source.read("oci://reg.test/aws/telo-s3@1.2.0");
    expect(read.text).toContain("name: s3");
    // No index, so nothing claims a payload — a bundled controller in such a
    // module fails at the loader with an actionable "republish" error instead.
    expect(readOwnerManifest(read.text).layers).toBeUndefined();
  });

  it("rejects a layer fetch whose bytes do not match the digest that addressed it", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry();
    vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    await t.publish(
      "oci://reg.test/aws/telo-s3",
      await bundleFor(MANIFEST, [
        { role: "assets", files: [{ name: "a.txt", content: Buffer.from("a") }] },
      ]),
    );
    const index = readOwnerManifest((await t.source.read("oci://reg.test/aws/telo-s3@1.2.0")).text)
      .layers!;

    // Ask for a digest the registry will answer with different bytes for.
    const wrong = `sha256:${"0".repeat(64)}`;
    await expect(
      t.fetchLayer("oci://reg.test/aws/telo-s3@1.2.0", wrong),
    ).rejects.toThrow();
    // The honest digest still works, so the rejection was the check and not the mock.
    await expect(
      t.fetchLayer("oci://reg.test/aws/telo-s3@1.2.0", index[0].blob),
    ).resolves.toHaveLength(1);
  });

  it("projects declared provenance onto org.opencontainers.image.* annotations", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry();
    vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    const manifest =
      "kind: Telo.Library\nmetadata:\n  name: s3\n  version: 1.2.0\n" +
      "  description: Object storage\n  repository: https://github.com/aws/telo-s3\n" +
      "  license: Apache-2.0\n  documentation: https://example.test/docs\n";
    await t.publish("oci://reg.test/aws/telo-s3", { manifest, layers: [] });

    expect(reg.manifestJson("aws/telo-s3", "1.2.0").annotations).toEqual({
      "org.opencontainers.image.title": "s3",
      "org.opencontainers.image.version": "1.2.0",
      "org.opencontainers.image.description": "Object storage",
      "org.opencontainers.image.source": "https://github.com/aws/telo-s3",
      "org.opencontainers.image.licenses": "Apache-2.0",
      "org.opencontainers.image.documentation": "https://example.test/docs",
    });
  });

  it("omits annotations a module did not declare", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry();
    vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    // MANIFEST declares only name/namespace/version — no provenance fields.
    await t.publish("oci://reg.test/aws/telo-s3", { manifest: MANIFEST, layers: [] });

    expect(reg.manifestJson("aws/telo-s3", "1.2.0").annotations).toEqual({
      "org.opencontainers.image.title": "s3",
      "org.opencontainers.image.version": "1.2.0",
    });
  });

  it("rejects a host-only destination instead of deriving the repo from metadata", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    // MANIFEST declares namespace/name, which the old default would have turned
    // into `reg.test/aws/s3` — a namespace the publisher may not own.
    await expect(t.publish("oci://reg.test", { manifest: MANIFEST, layers: [] })).rejects.toThrow(
      /host-only/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("performs the WWW-Authenticate token handshake", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry({ requireAuth: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    await t.publish("oci://reg.test/aws/telo-s3", { manifest: MANIFEST, layers: [] });
    const read = await t.source.read("oci://reg.test/aws/telo-s3@1.2.0");
    expect(read.text).toContain("name: s3");
    expect(reg.tokenRequests()).toBeGreaterThan(0);
  });

  it("reports a version's content digest via HEAD, null when missing", async () => {
    process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
    const reg = mockRegistry();
    vi.spyOn(globalThis, "fetch").mockImplementation(reg.impl);
    const t = new OciTransport();

    await t.publish("oci://reg.test/aws/telo-s3", { manifest: MANIFEST, layers: [] });
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

    await t.publish("oci://reg.test/aws/telo-s3", { manifest: MANIFEST, layers: [] });
    await expect(
      t.source.read("oci://reg.test/aws/telo-s3@1.2.0#sha256-deadbeefdeadbeefdeadbeefdeadbeef"),
    ).rejects.toBeInstanceOf(IntegrityError);
  });
});
