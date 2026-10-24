import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpRunnerAdapter } from "../adapters/http-runner/factory";
import { accessTokenHash, createDpopKey } from "../dpop-proof";
import { identityCredentials } from "../identity-credentials";
import { RunnerRefusal } from "../types";

const BASE = "https://runner.test";

const adapter = createHttpRunnerAdapter<{ baseUrl: string }>({
  id: "http-runner",
  displayName: "HTTP runner",
  description: "",
  configSchema: {},
  defaultConfig: { baseUrl: BASE },
  startTimeoutMs: 1000,
  buildRequestConfig: () => ({}),
});

/** A stand-in for the holder: a new token each time, valid `lifetimeMs`. */
function tokenSource(now: () => number, lifetimeMs: number) {
  let issued = 0;
  return {
    get issued() {
      return issued;
    },
    async token() {
      issued += 1;
      return { accessToken: `at-${issued}`, expiresAt: now() + lifetimeMs };
    },
  };
}

function invalidToken(): Response {
  return new Response(JSON.stringify({ error: "invalid_token", message: "the token has expired" }), {
    status: 401,
    headers: { "www-authenticate": 'DPoP error="invalid_token", error_description="the token has expired"' },
  });
}

function payloadOf(proof: string): Record<string, unknown> {
  const part = proof.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4))) as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

async function setUp(lifetimeMs: number, ...answers: Response[]) {
  let clock = 1_000_000;
  const now = () => clock;
  const tokens = tokenSource(now, lifetimeMs);
  const key = await createDpopKey();
  const credentials = identityCredentials({ resource: BASE, tokens, key: async () => key, now });
  const fetchMock = vi.fn<typeof fetch>();
  for (const answer of answers) fetchMock.mockResolvedValueOnce(answer);
  vi.stubGlobal("fetch", fetchMock);
  const session = (await adapter.connect({ baseUrl: BASE })).session("s1", credentials);
  const sent = (index: number) => {
    const headers = fetchMock.mock.calls[index]![1]!.headers as Record<string, string>;
    return { authorization: headers.authorization, proof: payloadOf(headers.dpop!) };
  };
  return { tokens, session, sent, advance: (ms: number) => (clock += ms) };
}

describe("a session reached with the signed-in identity", () => {
  it("sends the token with a proof for each request, and renews the token 60 s before it expires", async () => {
    const ok = () => new Response(null, { status: 202 });
    const { tokens, session, sent, advance } = await setUp(120_000, ok(), ok(), ok());
    await session.reload("api");
    expect(sent(0).authorization).toBe("DPoP at-1");
    expect(sent(0).proof).toMatchObject({ htm: "POST", htu: `${BASE}/v1/sessions/s1/reload`, ath: await accessTokenHash("at-1") });

    advance(59_000);
    await session.suspend();
    expect(sent(1).authorization).toBe("DPoP at-1");
    expect(sent(1).proof.jti).not.toBe(sent(0).proof.jti);

    advance(2_000);
    await session.suspend();
    expect(sent(2).authorization).toBe("DPoP at-2");
    expect(tokens.issued).toBe(2);
  });

  it("renews once on invalid_token and retries with a fresh proof; a second refusal is the runner's", async () => {
    const { tokens, session, sent } = await setUp(3_600_000, invalidToken(), new Response(null, { status: 202 }));
    await session.suspend();
    expect(tokens.issued).toBe(2);
    expect(sent(1).authorization).toBe("DPoP at-2");
    expect(sent(1).proof.jti).not.toBe(sent(0).proof.jti);
    expect(sent(1).proof.ath).toBe(await accessTokenHash("at-2"));

    const refused = await setUp(3_600_000, invalidToken(), invalidToken());
    const error = await refused.session.suspend().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RunnerRefusal);
    expect((error as RunnerRefusal).code).toBe("invalid_token");
    expect((error as RunnerRefusal).message).toContain("the token has expired");
    expect(refused.tokens.issued).toBe(2);
  });
});
