import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";

import type { IdentityConfig } from "../config.js";
import { callerResolver } from "../session/session-credentials.js";
import {
  bootTestServer,
  temporaryStore,
  testConfig,
} from "../test-support/fake-workload-backend.js";
import { IdentityVerifier } from "./identity-verifier.js";

const AUDIENCE = "https://runner.example.com/r";
const METADATA_URL = "https://runner.example.com/.well-known/oauth-protected-resource/r";
/** Discovered through RFC 8414; signs ES256. */
const ISSUER_A = "https://id-a.example";
/** Discovered only through OIDC; signs EdDSA. */
const ISSUER_B = "https://id-b.example/tenant";
/** Configured, never reachable. */
const ISSUER_DOWN = "https://down.example";
const IDENTITY: IdentityConfig = { audience: AUDIENCE, issuers: [ISSUER_A, ISSUER_B, ISSUER_DOWN] };

interface SigningKey {
  alg: "ES256" | "EdDSA";
  kid: string;
  privateKey: CryptoKey;
  jwk: JWK;
}

/** An issuer's key publishes its `kid`; a client's DPoP key is a bare public JWK. */
async function signingKey(alg: "ES256" | "EdDSA", kid?: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { crv: alg === "EdDSA" ? "Ed25519" : undefined });
  const jwk = await exportJWK(publicKey);
  return { alg, kid: kid ?? "", privateKey, jwk: kid ? { ...jwk, kid, alg, use: "sig" } : jwk };
}

/** The stub issuers' published keys, and every URL the runner fetched. */
const published: Record<string, SigningKey[]> = { a: [], b: [] };
const fetched: string[] = [];
let stub: Server;
let stubBase: string;

beforeAll(async () => {
  stub = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    switch (req.url) {
      case "/a/.well-known/oauth-authorization-server":
        return json(200, { issuer: ISSUER_A, jwks_uri: `${ISSUER_A}/jwks` });
      case "/a/jwks":
        return json(200, { keys: published.a!.map((k) => k.jwk) });
      case "/b/tenant/.well-known/openid-configuration":
        return json(200, { issuer: ISSUER_B, jwks_uri: `${ISSUER_B}/jwks` });
      case "/b/tenant/jwks":
        return json(200, { keys: published.b!.map((k) => k.jwk) });
      default:
        return json(404, { error: "not_found" });
    }
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => stub.close(resolve));
});

/** Routes each issuer's https host to the stub; the down issuer's host fails. */
const stubFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  fetched.push(url.href);
  const prefix = { "id-a.example": "/a", "id-b.example": "/b" }[url.host];
  if (!prefix) throw new TypeError("fetch failed: getaddrinfo ENOTFOUND " + url.host);
  return fetch(stubBase + prefix + url.pathname, init);
};

let clock = Date.now();
const nowS = () => Math.floor(clock / 1000);

interface Client {
  issuer: string;
  issuerKey: SigningKey;
  sub: string;
  dpop: SigningKey;
  jkt: string;
}

async function client(issuer: string, issuerKey: SigningKey, sub: string): Promise<Client> {
  const dpop = await signingKey(issuerKey.alg);
  return { issuer, issuerKey, sub, dpop, jkt: await calculateJwkThumbprint(dpop.jwk, "sha256") };
}

async function accessToken(
  c: Client,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({
    iss: c.issuer,
    aud: AUDIENCE,
    iat: nowS(),
    exp: nowS() + 300,
    sub: c.sub,
    cnf: { jkt: c.jkt },
    client_id: "studio",
    scope: "runner",
    ...claims,
  })
    .setProtectedHeader({ alg: c.issuerKey.alg, typ: "at+jwt", kid: c.issuerKey.kid, ...header })
    .sign(c.issuerKey.privateKey);
}

async function proof(
  c: Client,
  token: string,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
  key: SigningKey = c.dpop,
): Promise<string> {
  return new SignJWT({
    jti: randomUUID(),
    iat: nowS(),
    ath: createHash("sha256").update(token).digest("base64url"),
    ...claims,
  })
    .setProtectedHeader({ alg: key.alg, typ: "dpop+jwt", jwk: key.jwk, ...header })
    .sign(key.privateKey);
}

/** Credentials for one request to `path`. */
async function credentials(
  c: Client,
  method: string,
  path: string,
  tweak: {
    token?: Record<string, unknown>;
    tokenHeader?: Record<string, unknown>;
    proof?: Record<string, unknown>;
    otherProofKey?: boolean;
  } = {},
): Promise<Record<string, string>> {
  const token = await accessToken(c, tweak.token, tweak.tokenHeader);
  const key = tweak.otherProofKey ? await signingKey(c.dpop.alg) : c.dpop;
  const dpop = await proof(c, token, { htm: method, htu: AUDIENCE + path, ...tweak.proof }, {}, key);
  return { authorization: `DPoP ${token}`, dpop };
}

type Booted = Awaited<ReturnType<typeof bootTestServer>>;
const servers: Booted[] = [];
const stores: Array<Awaited<ReturnType<typeof temporaryStore>>> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const b of servers.splice(0)) await b.server.app.close();
  for (const s of stores.splice(0)) await s.dispose();
  fetched.length = 0;
  clock = Date.now();
});

async function boot(storeHandle?: Awaited<ReturnType<typeof temporaryStore>>): Promise<Booted> {
  const store = storeHandle ?? (await temporaryStore());
  if (!storeHandle) stores.push(store);
  const identity = new IdentityVerifier({
    config: IDENTITY,
    store: store.store,
    fetch: stubFetch,
    now: () => clock,
    log: { warn: () => undefined },
  });
  const booted = await bootTestServer(
    { config: testConfig({ identity: IDENTITY }), resolveCaller: callerResolver({ identity }) },
    store,
  );
  servers.push(booted);
  return booted;
}

let alice: Client;
let bob: Client;
let carol: Client;

beforeAll(async () => {
  const aKey = await signingKey("ES256", "a-1");
  const bKey = await signingKey("EdDSA", "b-1");
  published.a = [aKey];
  published.b = [bKey];
  alice = await client(ISSUER_A, aKey, "alice");
  bob = await client(ISSUER_B, bKey, "bob");
  carol = await client(ISSUER_DOWN, aKey, "carol");
});

async function createAs(b: Booted, c: Client, workspace: string) {
  return b.server.app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: await credentials(c, "POST", "/v1/sessions"),
    payload: { workspace, apps: [] },
  });
}

async function createAnonymous(b: Booted, workspace: string) {
  const res = await b.server.app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: { workspace, apps: [] },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { sessionId: string; resumeSecret: string };
}

describe("advertising identity", () => {
  it("serves the protected-resource metadata on /v1/capabilities and at the RFC 9728 paths", async () => {
    const b = await boot();
    const metadata = {
      resource: AUDIENCE,
      authorization_servers: [ISSUER_A, ISSUER_B, ISSUER_DOWN],
      dpop_bound_access_tokens_required: true,
      dpop_signing_alg_values_supported: ["ES256", "EdDSA"],
    };
    expect((await b.server.app.inject({ method: "GET", url: "/v1/capabilities" })).json().identity).toEqual(metadata);
    for (const url of ["/.well-known/oauth-protected-resource/r", "/.well-known/oauth-protected-resource"]) {
      expect((await b.server.app.inject({ method: "GET", url })).json()).toEqual(metadata);
    }
  });

  it("advertises nothing without configuration", async () => {
    const store = await temporaryStore();
    stores.push(store);
    const b = await bootTestServer({}, store);
    servers.push(b);
    expect((await b.server.app.inject({ method: "GET", url: "/v1/capabilities" })).json()).not.toHaveProperty(
      "identity",
    );
    expect((await b.server.app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" })).statusCode).toBe(404);
  });

  it("challenges a request with no credential", async () => {
    const b = await boot();
    const res = await b.server.app.inject({ method: "GET", url: "/v1/sessions/whatever" });
    expect([res.statusCode, res.json().error]).toEqual([401, "session_auth_required"]);
    expect(res.headers["www-authenticate"]).toBe(
      `DPoP algs="ES256 EdDSA", resource_metadata="${METADATA_URL}"`,
    );
  });
});

describe("an identity caller", () => {
  it("owns what it creates, with no resume secret, and reaches it by identity alone", async () => {
    const b = await boot();
    const created = await createAs(b, alice, "project-1");
    expect(created.statusCode).toBe(201);
    expect(created.json()).not.toHaveProperty("resumeSecret");
    const id = created.json().sessionId as string;
    expect((await b.store.store.get(id))?.owner).toEqual({ kind: "identity", iss: ISSUER_A, sub: "alice" });

    const path = `/v1/sessions/${id}`;
    const read = await b.server.app.inject({ method: "GET", url: path, headers: await credentials(alice, "GET", path) });
    expect([read.statusCode, read.json().workspace]).toEqual([200, "project-1"]);
  });

  it("is verified by an EdDSA key found through OIDC discovery", async () => {
    const b = await boot();
    expect((await createAs(b, bob, "project-1")).statusCode).toBe(201);
    expect(fetched).toEqual([
      "https://id-b.example/.well-known/oauth-authorization-server/tenant",
      "https://id-b.example/tenant/.well-known/openid-configuration",
      "https://id-b.example/tenant/jwks",
    ]);
  });

  it("caches the issuer's keys, and refetches them for an unknown key at most every 30 s", async () => {
    const b = await boot();
    expect((await createAs(b, alice, "w-1")).statusCode).toBe(201);
    expect((await createAs(b, alice, "w-2")).statusCode).toBe(201);
    expect(fetched).toHaveLength(2);

    const rotated = await signingKey("ES256", "a-2");
    published.a = [...published.a!, rotated];
    const rotatedAlice = { ...alice, issuerKey: rotated };
    const early = await createAs(b, rotatedAlice, "w-3");
    expect([early.statusCode, early.json().error]).toEqual([401, "invalid_token"]);
    expect(fetched).toHaveLength(2);

    try {
      clock += 31_000;
      expect((await createAs(b, rotatedAlice, "w-3")).statusCode).toBe(201);
      expect(fetched).toHaveLength(4);
    } finally {
      published.a = published.a!.filter((k) => k !== rotated);
    }
  });

  it("mints a byte-channel ticket", async () => {
    const b = await boot();
    const created = await b.server.app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: await credentials(alice, "POST", "/v1/sessions"),
      payload: { workspace: "w", apps: [{ name: "web", entryRelativePath: "telo.yaml" }] },
    });
    const path = `/v1/sessions/${created.json().sessionId}/io-tickets`;
    await expect
      .poll(() => b.server.registry.get(created.json().sessionId)?.status.kind)
      .toBe("running");
    const res = await b.server.app.inject({
      method: "POST",
      url: path,
      headers: await credentials(alice, "POST", path),
      payload: { app: "web" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty("ticket");
  });
});

describe("refusing an identity", () => {
  it.each([
    ["a token for another audience", "invalid_token", { token: { aud: "https://other-runner.example.com" } }, /unexpected "aud" claim value/],
    ["a token from an issuer not configured", "invalid_token", { token: { iss: "https://evil.example" } }, /issuer 'https:\/\/evil.example' is not one this runner accepts/],
    ["an expired token", "invalid_token", { token: { exp: Math.floor(Date.now() / 1000) - 120 } }, /"exp" claim timestamp check failed/],
    ["a token with no cnf", "invalid_token", { token: { cnf: undefined } }, /carries no 'cnf.jkt'/],
    ["a token with an empty sub", "invalid_token", { token: { sub: "" } }, /carries no 'sub'/],
    ["a token whose typ is not at+jwt", "invalid_token", { tokenHeader: { typ: "JWT" } }, /'typ' is 'JWT', not 'at\+jwt'/],
    ["a proof replayed against another URL", "invalid_dpop_proof", { proof: { htu: `${AUDIENCE}/v1/sessions/other` } }, /'htu' is .*\/v1\/sessions\/other'/],
    ["a proof for another method", "invalid_dpop_proof", { proof: { htm: "GET" } }, /'htm' is 'GET', but the request is POST/],
    ["a proof whose ath is another token's", "invalid_dpop_proof", { proof: { ath: "x".repeat(43) } }, /'ath' is not the hash/],
    ["a proof older than 120 s", "invalid_dpop_proof", { proof: { iat: Math.floor(Date.now() / 1000) - 121 } }, /'iat' is more than 120 s from now/],
    ["a proof by another key than the token's", "invalid_dpop_proof", { otherProofKey: true }, /signed by a key other than/],
  ] satisfies Array<[string, string, Parameters<typeof credentials>[3], RegExp]>)("refuses %s with 401 %s", async (what, code, tweak, reason) => {
    const b = await boot();
    const headers = await credentials(alice, "POST", "/v1/sessions", tweak);
    const res = await b.server.app.inject({ method: "POST", url: "/v1/sessions", headers, payload: { workspace: "w", apps: [] } });
    expect([res.statusCode, res.json().error]).toEqual([401, code]);
    expect(res.json().message).toMatch(reason);
    expect(res.headers["www-authenticate"]).toMatch(
      new RegExp(`^DPoP error="${code}", error_description="[^"]+", algs="ES256 EdDSA", resource_metadata="${METADATA_URL}"$`),
    );
  });

  it("refuses a token signed with a symmetric algorithm", async () => {
    const b = await boot();
    const token = await new SignJWT({ iss: ISSUER_A, aud: AUDIENCE, sub: "alice", exp: nowS() + 300, cnf: { jkt: alice.jkt } })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .sign(new TextEncoder().encode("a shared secret the runner never holds"));
    const res = await b.server.app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: {
        authorization: `DPoP ${token}`,
        dpop: await proof(alice, token, { htm: "POST", htu: `${AUDIENCE}/v1/sessions` }),
      },
      payload: { workspace: "w", apps: [] },
    });
    expect([res.statusCode, res.json().error]).toEqual([401, "invalid_token"]);
    expect(res.json().message).toMatch(/'alg' 'HS256' is not an asymmetric signature algorithm/);
  });

  it("refuses a token with no proof, naming the metadata", async () => {
    const b = await boot();
    const res = await b.server.app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: `DPoP ${await accessToken(alice)}` },
      payload: { workspace: "w", apps: [] },
    });
    expect([res.statusCode, res.json().error]).toEqual([401, "invalid_dpop_proof"]);
    expect(res.headers["www-authenticate"]).toContain(`resource_metadata="${METADATA_URL}"`);
  });

  it("refuses a replayed proof, also after the runner restarts", async () => {
    const store = await temporaryStore();
    stores.push(store);
    const first = await boot(store);
    const headers = await credentials(alice, "POST", "/v1/sessions");
    const send = (b: Booted, workspace: string) =>
      b.server.app.inject({ method: "POST", url: "/v1/sessions", headers, payload: { workspace, apps: [] } });

    expect((await send(first, "w-1")).statusCode).toBe(201);
    const replayed = await send(first, "w-2");
    expect([replayed.statusCode, replayed.json().error]).toEqual([401, "invalid_dpop_proof"]);
    expect(replayed.json().message).toMatch(/'jti' was already used/);

    await first.server.app.close();
    servers.splice(servers.indexOf(first), 1);
    await store.reopen();
    const restarted = await send(await boot(store), "w-3");
    expect([restarted.statusCode, restarted.json().error]).toEqual([401, "invalid_dpop_proof"]);
  });

  it("answers an unreachable issuer with 503 and leaves resume-secret sessions working", async () => {
    const b = await boot();
    const anonymous = await createAnonymous(b, "w");
    const down = await createAs(b, carol, "w");
    expect([down.statusCode, down.json().error]).toEqual([503, "identity_provider_unavailable"]);

    const read = await b.server.app.inject({
      method: "GET",
      url: `/v1/sessions/${anonymous.sessionId}`,
      headers: { authorization: `Bearer ${anonymous.resumeSecret}` },
    });
    expect(read.statusCode).toBe(200);
  });

  it("purges expired proof ids on the lifecycle tick", async () => {
    const b = await boot();
    const purge = vi.spyOn(b.store.store, "purgeExpiredJtis");
    await b.server.lifecycle.tick();
    expect(purge).toHaveBeenCalledTimes(1);
  });
});

describe("listing sessions", () => {
  it("lists the identity's own sessions, newest activity first, filtered by workspace", async () => {
    const b = await boot();
    const one = (await createAs(b, alice, "project-1")).json().sessionId as string;
    const two = (await createAs(b, alice, "project-2")).json().sessionId as string;
    await createAs(b, bob, "project-1");
    await expect.poll(() => b.server.registry.get(two)?.status.kind).toBe("running");
    const list = async (query: string) =>
      b.server.app.inject({
        method: "GET",
        url: `/v1/sessions${query}`,
        headers: await credentials(alice, "GET", "/v1/sessions"),
      });

    const all = (await list("")).json().sessions as Array<Record<string, unknown>>;
    expect(all.map((s) => s.sessionId).sort()).toEqual([one, two].sort());
    expect(all[0]).toEqual({
      sessionId: expect.any(String),
      workspace: expect.any(String),
      status: "running",
      lastActiveAt: expect.any(String),
    });
    expect(Date.parse(all[0]!.lastActiveAt as string)).toBeGreaterThanOrEqual(Date.parse(all[1]!.lastActiveAt as string));
    expect((await list("?workspace=project-2")).json()).toEqual({
      sessions: [expect.objectContaining({ sessionId: two, workspace: "project-2" })],
    });
  });

  it("is refused to a resume secret with 403 and to no credential with 401", async () => {
    const b = await boot();
    const anonymous = await createAnonymous(b, "w");
    const secret = await b.server.app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: `Bearer ${anonymous.resumeSecret}` },
    });
    expect([secret.statusCode, secret.json().error]).toEqual([403, "identity_required"]);
    const none = await b.server.app.inject({ method: "GET", url: "/v1/sessions" });
    expect([none.statusCode, none.json().error]).toEqual([401, "session_auth_required"]);
    expect(none.headers["www-authenticate"]).toContain(`resource_metadata="${METADATA_URL}"`);
  });
});

describe("adopting a session", () => {
  async function adopt(b: Booted, c: Client, id: string, resumeSecret: string) {
    const path = `/v1/sessions/${id}/owner`;
    return b.server.app.inject({
      method: "POST",
      url: path,
      headers: await credentials(c, "POST", path),
      payload: { resumeSecret },
    });
  }

  it("hands a resume-secret session to the identity, after which the secret answers 404", async () => {
    const b = await boot();
    const anonymous = await createAnonymous(b, "project-1");
    const res = await adopt(b, alice, anonymous.sessionId, anonymous.resumeSecret);
    expect([res.statusCode, res.json()]).toEqual([200, { sessionId: anonymous.sessionId }]);
    expect((await b.store.store.get(anonymous.sessionId))?.owner).toEqual({
      kind: "identity",
      iss: ISSUER_A,
      sub: "alice",
    });

    const path = `/v1/sessions/${anonymous.sessionId}`;
    const bySecret = await b.server.app.inject({
      method: "GET",
      url: path,
      headers: { authorization: `Bearer ${anonymous.resumeSecret}` },
    });
    expect(bySecret.statusCode).toBe(404);
    const byIdentity = await b.server.app.inject({ method: "GET", url: path, headers: await credentials(alice, "GET", path) });
    expect(byIdentity.statusCode).toBe(200);
  });

  it("answers 409 session_exists with the identity's own session for that workspace", async () => {
    const b = await boot();
    const own = (await createAs(b, alice, "project-1")).json().sessionId as string;
    const anonymous = await createAnonymous(b, "project-1");
    const res = await adopt(b, alice, anonymous.sessionId, anonymous.resumeSecret);
    expect([res.statusCode, res.json().error, res.json().sessionId]).toEqual([409, "session_exists", own]);
    expect((await b.store.store.get(anonymous.sessionId))?.owner.kind).toBe("secret");
  });

  it("answers a wrong secret with 404", async () => {
    const b = await boot();
    const anonymous = await createAnonymous(b, "project-1");
    const res = await adopt(b, alice, anonymous.sessionId, "not-the-secret");
    expect([res.statusCode, res.json().error]).toEqual([404, "not_found"]);
    expect((await b.store.store.get(anonymous.sessionId))?.owner.kind).toBe("secret");
  });
});
