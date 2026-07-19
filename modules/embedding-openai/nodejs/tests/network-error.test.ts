import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { create } from "../src/model-controller.js";

// A transport failure must name the host and the reason. `fetch` rejects with
// the literal text "fetch failed" for DNS, refusal, and TLS alike — the useful
// detail sits on `error.cause`, and reporting only `message` is what produced
// bare "INTERNAL_ERROR: fetch failed" with nothing to act on.

/** Undici's shape: an opaque TypeError wrapping the real error as `cause`. */
function fetchFailure(code: string, causeMessage: string): TypeError {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(new Error(causeMessage), { code });
  return err;
}

function makeModel(baseUrl: string) {
  return create(
    {
      metadata: { name: "T" },
      model: "embeddinggemma-300m",
      apiKey: "unused",
      baseUrl,
    } as never,
    {} as never,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embedding model transport failures", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw fetchFailure("ENOTFOUND", "getaddrinfo ENOTFOUND embedder");
      }),
    );
  });

  it("reports the host and reason instead of 'fetch failed'", async () => {
    const model = await makeModel("http://embedder/v1");
    const err = await model.embed({ texts: ["hi"], intent: "passage" }).catch((e: unknown) => e);

    const message = (err as Error).message;
    expect(message).not.toBe("fetch failed");
    expect(message).toContain("ENOTFOUND");
    expect(message).toContain("embedder");
    // Names the manifest field to change — the difference between an error a
    // developer can act on and one they have to bisect.
    expect(message).toContain("baseUrl");
  });

  it("carries structured data so a renderer need not parse prose", async () => {
    const model = await makeModel("http://embedder/v1");
    const err = (await model
      .embed({ texts: ["hi"], intent: "passage" })
      .catch((e: unknown) => e)) as { code: string; data: Record<string, unknown> };

    expect(err.code).toBe("ERR_NETWORK_UNREACHABLE");
    expect(err.data).toMatchObject({
      url: "http://embedder/v1/embeddings",
      host: "embedder",
      cause: "ENOTFOUND",
      // The actionable part is data too, not only prose in the message: another
      // language's SDK supplies these two facts rather than retyping English.
      resource: "T",
      setting: "baseUrl",
    });
  });

  it("keeps the wrapped error reachable as `cause`", async () => {
    const model = await makeModel("http://embedder/v1");
    const err = (await model
      .embed({ texts: ["hi"], intent: "passage" })
      .catch((e: unknown) => e)) as Error & { cause?: { cause?: { code?: string } } };

    // Wrapping must never destroy what was actually thrown — the code mapping
    // is a convenience layered on top, not a replacement.
    expect(err.cause).toBeDefined();
    expect(err.cause?.cause?.code).toBe("ENOTFOUND");
  });
});

describe("codes the mapping does not know", () => {
  it("keeps the underlying message, so wrapping is never a downgrade", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw fetchFailure("EUNMAPPED", "socket disconnected before secure TLS connection");
      }),
    );
    const model = await makeModel("http://embedder/v1");
    const err = await model.embed({ texts: ["hi"], intent: "passage" }).catch((e: unknown) => e);

    const message = (err as Error).message;
    expect(message).toContain("EUNMAPPED");
    expect(message).toContain("socket disconnected before secure TLS connection");
  });
});

describe("non-transport failures are left alone", () => {
  it("keeps the provider's own message for a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "model not found" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const model = await makeModel("http://embedder/v1");
    const err = await model.embed({ texts: ["hi"], intent: "passage" }).catch((e: unknown) => e);

    // A status code is a reply, not a transport fault: the provider's own body
    // is more useful than anything the wrapper could synthesise.
    expect((err as Error).message).toContain("model not found");
    expect((err as { code?: string }).code).toBeUndefined();
  });
});
