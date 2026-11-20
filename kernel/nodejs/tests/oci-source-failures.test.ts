import { afterEach, describe, expect, it, vi } from "vitest";

import { OciTransport } from "../src/transports/oci/oci-transport.js";
import { mockRegistry } from "./mock-oci-registry.js";

const MANIFEST = "kind: Telo.Library\nmetadata:\n  name: Lib\n  version: 1.0.0\n";
const REF = "oci://reg.test/acme/lib@1.0.0";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DOCKER_CONFIG;
});

/** A published `REF` behind a registry whose replies, once it is published,
 *  `answer` may replace. */
async function publishedRegistry(answer?: (url: URL) => Response | undefined) {
  process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
  const reg = mockRegistry();
  let published = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const replaced = published ? answer?.(new URL(String(input))) : undefined;
    return replaced ?? reg.impl(input, init);
  });
  await new OciTransport().publish("oci://reg.test/acme/lib", { manifest: MANIFEST, layers: [] });
  published = true;
  return { reg, transport: new OciTransport() };
}

describe("OciTransport read failures", () => {
  it("reads a manifest the registry answers 404 for as nothing at the ref", async () => {
    const { transport } = await publishedRegistry();
    await expect(transport.source.read("oci://reg.test/acme/lib@9.9.9")).rejects.toMatchObject({
      sourceFailure: "not-found",
      message: "nothing exists at oci://reg.test/acme/lib@9.9.9.",
    });
  });

  it("reads any other non-2xx reply as a refusal carrying its status", async () => {
    const { transport } = await publishedRegistry((url) =>
      url.pathname.includes("/manifests/") ? new Response("denied", { status: 403 }) : undefined,
    );
    await expect(transport.source.read(REF)).rejects.toMatchObject({
      sourceFailure: "refused",
      status: 403,
      message: `the host refused the request for ${REF} (HTTP 403).`,
    });
  });

  it("reads a missing manifest-layer blob as a refusal, not as a missing module", async () => {
    const { transport } = await publishedRegistry((url) =>
      url.pathname.includes("/blobs/sha256:") ? new Response(null, { status: 404 }) : undefined,
    );
    await expect(transport.source.read(REF)).rejects.toMatchObject({ sourceFailure: "refused", status: 404 });
  });

  it("reads a registry that cannot be reached as unreachable, the transport's code only on the cause", async () => {
    const { reg, transport } = await publishedRegistry();
    reg.offline();
    const failure = await transport.source.read(REF).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      sourceFailure: "unreachable",
      message: `${REF} cannot be reached: no connection to its host could be made.`,
    });
    expect((failure as { code?: unknown }).code).toBeUndefined();
    expect((failure as Error & { cause?: { code?: string } }).cause?.code).toBe("ERR_NETWORK_UNREACHABLE");
  });
});
