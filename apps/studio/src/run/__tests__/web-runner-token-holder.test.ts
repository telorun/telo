import { describe, expect, it, vi } from "vitest";

import type { CloudRequest, CloudTransport } from "../../cloud/transport";
import { createDpopKey } from "../dpop-proof";
import { IdentityProviderUnavailableError, RunnerTokenSource } from "../runner-token";
import { webRunnerTokenHolder } from "../web-runner-token-holder";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A stand-in for the same-origin server, answering in order. */
function server(...answers: Response[]) {
  const requests: CloudRequest[] = [];
  const transport: CloudTransport = {
    async request(request) {
      requests.push(request);
      const answer = answers.shift();
      if (!answer) throw new Error("no answer left");
      return answer;
    },
  };
  return { transport, requests };
}

function claimsOf(request: CloudRequest): Record<string, unknown> {
  const part = request.headers!.dpop!.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4))) as Record<string, unknown>;
}

const TOKEN_ENDPOINT = "https://issuer.test/token";

describe("runner tokens from the web build's server", () => {
  it("signs for the token endpoint the server names, re-signs once with its nonce, and takes the DPoP token", async () => {
    const { transport, requests } = server(
      json(401, { error: "dpop_proof_required", token_endpoint: TOKEN_ENDPOINT }),
      json(401, { error: "use_dpop_nonce", token_endpoint: TOKEN_ENDPOINT }, { "dpop-nonce": "n-1" }),
      json(200, { access_token: "at", token_type: "DPoP", expires_in: 300 }),
    );
    const key = await createDpopKey();
    const source = new RunnerTokenSource(webRunnerTokenHolder(transport), async () => key, () => 1_000);
    expect(await source.token("https://runner.test")).toEqual({ accessToken: "at", expiresAt: 301_000 });

    expect(requests.map((r) => [r.method, r.path, JSON.parse(r.body!)])).toEqual([
      ["POST", "/session/runner-token", { resource: "https://runner.test" }],
      ["POST", "/session/runner-token", { resource: "https://runner.test" }],
      ["POST", "/session/runner-token", { resource: "https://runner.test" }],
    ]);
    expect(requests[0]!.headers).toEqual({});
    expect(claimsOf(requests[1]!)).toMatchObject({ htm: "POST", htu: TOKEN_ENDPOINT });
    expect(claimsOf(requests[1]!)).not.toHaveProperty("nonce");
    expect(claimsOf(requests[2]!)).toMatchObject({ htu: TOKEN_ENDPOINT, nonce: "n-1" });
  });

  it("refuses a nonce demanded again after it was signed", async () => {
    const nonce = () => json(401, { error: "use_dpop_nonce", token_endpoint: TOKEN_ENDPOINT }, { "dpop-nonce": "n-1" });
    const { transport } = server(nonce(), nonce(), nonce());
    const key = await createDpopKey();
    const source = new RunnerTokenSource(webRunnerTokenHolder(transport), async () => key);
    await expect(source.token("https://runner.test")).rejects.toThrow(/refused the nonce it handed out/);
  });

  it("navigates to the runner's authorization on this origin, returning here", async () => {
    window.history.replaceState(null, "", "/editor?x=1#tab");
    const navigate = vi.fn();
    const { transport } = server(
      json(409, { error: "runner_authorization_required", authorizationUrl: "/api/session/runner-authorization?r=1" }),
    );
    void webRunnerTokenHolder(transport, navigate).exchange("https://runner.test", "proof");
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    const target = new URL(navigate.mock.calls[0]![0] as string, window.location.origin);
    expect(target.pathname).toBe("/api/session/runner-authorization");
    expect(target.searchParams.get("r")).toBe("1");
    expect(target.searchParams.get("returnTo")).toBe("/editor?x=1#tab");
  });

  it("authorizes a runner whose grant the server lost after it worked, as it does a first time", async () => {
    window.history.replaceState(null, "", "/editor");
    const navigate = vi.fn();
    const { transport, requests } = server(
      json(401, { error: "dpop_proof_required", token_endpoint: TOKEN_ENDPOINT }),
      json(200, { access_token: "at", token_type: "DPoP", expires_in: 300 }),
      json(409, { error: "runner_authorization_required", authorizationUrl: "/api/session/runner-authorization" }),
    );
    const key = await createDpopKey();
    const source = new RunnerTokenSource(webRunnerTokenHolder(transport, navigate), async () => key);
    await source.token("https://runner.test");

    void source.token("https://runner.test");
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(navigate.mock.calls[0]![0]).toBe("/api/session/runner-authorization?returnTo=%2Feditor");
    expect(requests.map((r) => [Object.keys(r.headers!), JSON.parse(r.body!)])).toEqual([
      [[], { resource: "https://runner.test" }],
      [["dpop"], { resource: "https://runner.test" }],
      [["dpop"], { resource: "https://runner.test" }],
    ]);
  });

  it("reports an identity provider it cannot reach as a retryable failure", async () => {
    const { transport } = server(json(503, { error: "identity_provider_unavailable", message: "down" }));
    await expect(webRunnerTokenHolder(transport).exchange("https://runner.test", "proof")).rejects.toBeInstanceOf(
      IdentityProviderUnavailableError,
    );
  });
});
