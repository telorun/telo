import { createHash } from "node:crypto";

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
 *  `WWW-Authenticate` handshake. `blobPulls` lists every blob a GET served, in
 *  order, and `offline()` makes every later request fail as an unreachable
 *  host does. */
export function mockRegistry(opts: { requireAuth?: boolean } = {}) {
  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, string>(); // `${repo}|${ref}` → json
  const uploads = new Map<string, string>();
  const blobPulls: string[] = [];
  let uploadSeq = 0;
  let tokenRequests = 0;
  let reachable = true;

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!reachable) throw new TypeError("fetch failed");
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
      if (b) blobPulls.push(digest);
      return b ? new Response(b, { status: 200 }) : new Response(null, { status: 404 });
    }
    if ((m = p.match(/^\/v2\/(.+)\/manifests\/(.+)$/))) {
      const key = `${m[1]}|${m[2]}`;
      if (method === "PUT") {
        const body = (await toBytes(init?.body)).toString("utf-8");
        manifests.set(key, body);
        // A manifest is addressable by its digest too, as a registry stores it.
        const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
        manifests.set(`${m[1]}|${digest}`, body);
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
        .filter((k) => k.startsWith(`${repo}|`) && !k.includes("|sha256:"))
        .map((k) => k.split("|")[1]);
      return json({ tags });
    }
    return new Response("not found", { status: 404 });
  };

  return {
    impl,
    tokenRequests: () => tokenRequests,
    blobPulls: () => [...blobPulls],
    offline: () => {
      reachable = false;
    },
    manifestJson: (repo: string, ref: string) => JSON.parse(manifests.get(`${repo}|${ref}`) ?? "{}"),
  };
}
