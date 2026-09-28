import { afterEach, describe, expect, it } from "vitest";

import type { BackendStartSpec, RunnerBackend } from "../backend.js";
import { loadResolvedApps, type RunnerCoreConfig } from "../config.js";
import type { RunStatus } from "../contract.js";
import { buildServer, type ServerHandle } from "../server.js";

/**
 * The per-session workload token, end to end through core's routes over a
 * backend that records what it was asked to start and reports an endpoint for
 * every port — which is all a real backend's `running` status is made of.
 */
const CONFIG: RunnerCoreConfig = {
  port: 0,
  logLevel: "silent",
  maxSessions: 8,
  exitTtlMs: 60_000,
  replayBufferBytes: 100_000,
  corsOrigins: "*",
  watch: {
    enabled: true,
    idleMs: 3_600_000,
    maxTtlSeconds: 21_600,
    maxSessions: 8,
    reloadLimitPerMinute: 30,
    suspendedTtlMs: 3_600_000,
    checkpointMs: 3_600_000,
  },
};

const CATALOG = JSON.stringify({
  tool: { image: "acme/tool:1", env: { KEY: "operator" }, tokenEnv: "TOOL_TOKEN" },
  agent: { image: "acme/agent:1", env: { KEY: "operator" }, port: 8080, tokenEnv: "AGENT_TOKEN" },
});

const TOKEN = /^[a-z2-7]{32}$/;

function recordingBackend(starts: BackendStartSpec[]): RunnerBackend {
  return {
    probe: async () => ({ status: "ready" }),
    async start(spec) {
      starts.push(spec);
      spec.onStatus({
        kind: "running",
        endpoints: spec.apps.flatMap((a) =>
          a.ports.map((p) => ({ host: "", port: p.port, protocol: p.protocol })),
        ),
        ...(spec.agent?.port !== undefined
          ? { agent: { host: "", port: spec.agent.port, protocol: "tcp" as const } }
          : {}),
      });
      return {
        writeStdin: () => {},
        resize: () => {},
        done: new Promise<void>(() => {}),
        stop: async () => {},
      };
    },
  };
}

const WATCH_BODY = {
  bundle: {
    entryRelativePath: "telo.yaml",
    files: [{ relativePath: "telo.yaml", contents: "kind: Telo.Application\n" }],
  },
  env: { AGENT_TOKEN: "client" },
  mode: "watch",
  agent: "agent",
  ports: [{ port: 3000, protocol: "tcp" }],
};

describe("per-session workload token", () => {
  let server: ServerHandle;
  let starts: BackendStartSpec[];

  async function boot(): Promise<void> {
    starts = [];
    server = await buildServer({
      backend: recordingBackend(starts),
      config: CONFIG,
      version: "test",
      capabilities: {
        displayName: "test",
        description: "test",
        config: { schema: {} },
        features: { io: ["tty"], ports: true, watch: true },
      },
      apps: loadResolvedApps({ RUNNER_APPS: CATALOG }),
    });
  }

  function statusOf(sessionId: string): RunStatus {
    return server.registry.get(sessionId)!.status;
  }

  afterEach(async () => {
    await server.app.close();
  });

  it("mints one for an app session, injects it, reports it on every endpoint, and drops a client value", async () => {
    await boot();
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/apps/tool/sessions",
      payload: { env: { TOOL_TOKEN: "client", OTHER: "x" }, ports: [{ port: 8080, protocol: "tcp" }] },
    });
    expect(res.statusCode).toBe(201);
    const { sessionId } = res.json();

    const token = starts[0]!.env.TOOL_TOKEN!;
    expect(token).toMatch(TOKEN);
    expect(starts[0]!.env).toEqual({ OTHER: "x", KEY: "operator", TOOL_TOKEN: token });
    expect(statusOf(sessionId)).toEqual({
      kind: "running",
      endpoints: [{ host: "", port: 8080, protocol: "tcp", token }],
    });
  });

  it("gives a co-resident agent its own token per session, on the agent alone", async () => {
    await boot();
    const first = (await server.app.inject({ method: "POST", url: "/v1/sessions", payload: WATCH_BODY })).json();
    await server.app.inject({ method: "POST", url: "/v1/sessions", payload: WATCH_BODY });

    const token = starts[0]!.agent!.env.AGENT_TOKEN!;
    expect(token).toMatch(TOKEN);
    expect(starts[1]!.agent!.env.AGENT_TOKEN).not.toBe(token);
    expect(starts[0]!.agent!.env).toEqual({ KEY: "operator", AGENT_TOKEN: token });
    // The session env is the applications', and never carries the agent's token.
    expect(starts[0]!.env).toEqual({ AGENT_TOKEN: "client" });
    expect(statusOf(first.sessionId)).toEqual({
      kind: "running",
      endpoints: [{ host: "", port: 3000, protocol: "tcp" }],
      agent: { host: "", port: 8080, protocol: "tcp", token },
    });
  });

  it("keeps the agent's token across suspend and resume", async () => {
    await boot();
    const { sessionId } = (
      await server.app.inject({ method: "POST", url: "/v1/sessions", payload: WATCH_BODY })
    ).json();
    const token = starts[0]!.agent!.env.AGENT_TOKEN;

    const entry = server.registry.get(sessionId)!;
    entry.checkpoint = { takenAt: new Date(), files: [] };
    server.registry.emit(sessionId, { type: "status", status: { kind: "suspended" } });
    const resumed = await server.app.inject({ method: "POST", url: `/v1/sessions/${sessionId}/resume` });
    expect(resumed.statusCode).toBe(202);

    expect(starts).toHaveLength(2);
    expect(starts[1]!.agent!.env.AGENT_TOKEN).toBe(token);
    expect(statusOf(sessionId)).toMatchObject({ kind: "running", agent: { token } });
  });
});
