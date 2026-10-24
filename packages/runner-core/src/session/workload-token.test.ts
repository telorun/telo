import { afterEach, describe, expect, it } from "vitest";

import { loadResolvedApps } from "../config.js";
import { bootTestServer } from "../test-support/fake-workload-backend.js";

/**
 * The agent's workload token, end to end through core's routes over a backend
 * that reports an endpoint for the agent — which is all a real backend's
 * `running` status is made of.
 */
const CATALOG = JSON.stringify({
  agent: { image: "acme/agent:1", env: { KEY: "operator" }, port: 8080, tokenEnv: "AGENT_TOKEN" },
});

const TOKEN = /^[a-z2-7]{32}$/;

describe("the agent's workload token", () => {
  let booted: Awaited<ReturnType<typeof bootTestServer>>;

  afterEach(async () => {
    await booted.server.app.close();
    await booted.store.dispose();
  });

  it("is minted per workload creation, injected on the agent alone and reported on its endpoint", async () => {
    booted = await bootTestServer({ apps: loadResolvedApps({ RUNNER_APPS: CATALOG }) });
    const { server, backend } = booted;
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspace: "w", agent: "agent", apps: [] },
    });
    const { sessionId, resumeSecret } = res.json();
    const statusOf = () => server.registry.get(sessionId)!.status;
    await expect.poll(() => statusOf().kind).toBe("running");

    const token = backend.created[0]!.agent!.env.AGENT_TOKEN!;
    expect(token).toMatch(TOKEN);
    expect(backend.created[0]!.agent!.env).toEqual({ KEY: "operator", AGENT_TOKEN: token });
    expect(backend.created[0]!.tokens).toEqual({ agent: token });
    expect(statusOf()).toEqual({
      kind: "running",
      endpoints: [],
      agent: { host: "", port: 8080, protocol: "tcp", token },
    });
    expect(JSON.stringify(await booted.store.store.get(sessionId))).not.toContain(token);

    const auth = { authorization: `Bearer ${resumeSecret}` };
    await server.app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/suspend`, headers: auth });
    await server.app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/resume`, headers: auth });
    await expect.poll(() => statusOf().kind).toBe("running");

    const resumed = backend.created[1]!.agent!.env.AGENT_TOKEN!;
    expect(resumed).toMatch(TOKEN);
    expect(resumed).not.toBe(token);
    expect(statusOf()).toMatchObject({ agent: { token: resumed } });
  });
});
