import { afterEach, describe, expect, it } from "vitest";

import type { BackendStartSpec, RunnerBackend } from "../backend.js";
import { loadSessionContainersConfig, RunnerConfigError, type RunnerCoreConfig } from "../config.js";
import { buildServer, type ServerHandle } from "../server.js";
import {
  SessionContainerFieldRefused,
  SessionContainerNotFound,
  type SessionContainerEngine,
  type SessionContainerSpec,
} from "../session-containers/session-container-engine.js";

const INTERNAL_URL = "http://runner.internal:8061";

function config(enabled: boolean): RunnerCoreConfig {
  return {
    port: 0,
    logLevel: "silent",
    maxSessions: 8,
    exitTtlMs: 60_000,
    replayBufferBytes: 100_000,
    corsOrigins: "*",
    watch: {
      enabled: false,
      idleMs: 3_600_000,
      maxTtlSeconds: 21_600,
      maxSessions: 8,
      reloadLimitPerMinute: 30,
      suspendedTtlMs: 3_600_000,
      checkpointMs: 3_600_000,
    },
    sessionContainers: enabled
      ? { enabled: true, max: 2, internalUrl: INTERNAL_URL }
      : { enabled: false, max: 2 },
  };
}

interface FakeEngine extends SessionContainerEngine {
  created: Array<{ sessionId: string; spec: SessionContainerSpec }>;
  removed: string[];
  ended: string[];
  running: Set<string>;
}

function fakeEngine(): FakeEngine {
  let next = 0;
  const engine: FakeEngine = {
    created: [],
    removed: [],
    ended: [],
    running: new Set(),
    ping: async () => {},
    hasImage: async (image) => image === "held:1",
    pullImage: async () => {},
    async create(sessionId, spec) {
      if (spec.user === "root") throw new SessionContainerFieldRefused("User", "must not be root");
      engine.created.push({ sessionId, spec });
      next += 1;
      return `c${next}`;
    },
    async start(sessionId, id) {
      engine.running.add(id);
    },
    async inspect(sessionId, id) {
      if (engine.removed.includes(id)) throw new SessionContainerNotFound(id);
      return { running: engine.running.has(id), exitCode: null, address: "10.0.0.7" };
    },
    async logs() {
      return (async function* () {
        yield { stream: "stdout" as const, data: Buffer.from("ready\n") };
        yield { stream: "stderr" as const, data: Buffer.from("warn") };
      })();
    },
    async remove(sessionId, id) {
      engine.removed.push(id);
      engine.running.delete(id);
    },
    async endSession(sessionId) {
      engine.ended.push(sessionId);
    },
  };
  return engine;
}

function backend(starts: BackendStartSpec[], engine?: SessionContainerEngine): RunnerBackend {
  return {
    probe: async () => ({ status: "ready" }),
    async start(spec) {
      starts.push(spec);
      spec.onStatus({ kind: "running" });
      return {
        writeStdin: () => {},
        resize: () => {},
        done: new Promise<void>(() => {}),
        stop: async () => spec.onStatus({ kind: "stopped" }),
      };
    },
    ...(engine ? { containers: engine } : {}),
  };
}

const SESSION_BODY = {
  bundle: {
    entryRelativePath: "telo.yaml",
    files: [{ relativePath: "telo.yaml", contents: "kind: Telo.Application\n" }],
  },
  env: { TELO_HOST_CONTAINER_ENGINE_TOKEN: "client" },
};

const CREATE_BODY = {
  Image: "pgvector/pgvector:pg18",
  Env: ["POSTGRES_PASSWORD=postgres"],
  User: "999:999",
  ExposedPorts: { "5432/tcp": {} },
  Labels: { "run.telo.container.expires": "1760000000" },
  HostConfig: { PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } },
};

describe("the session container engine", () => {
  let server: ServerHandle | undefined;
  let starts: BackendStartSpec[];
  let engine: FakeEngine;

  async function boot(enabled = true): Promise<ServerHandle> {
    starts = [];
    engine = fakeEngine();
    server = await buildServer({
      backend: backend(starts, engine),
      config: config(enabled),
      version: "test",
      capabilities: {
        displayName: "test",
        description: "test",
        config: { schema: { type: "object" } },
        features: { io: ["tty"], ports: true, watch: false },
      },
    });
    return server;
  }

  async function startSession(): Promise<{ id: string; prefix: string; auth: Record<string, string> }> {
    const res = await server!.app.inject({ method: "POST", url: "/v1/sessions", payload: SESSION_BODY });
    expect(res.statusCode).toBe(201);
    const id = res.json().sessionId as string;
    const env = starts.at(-1)!.env;
    return {
      id,
      prefix: `/v1/sessions/${id}/engine/v1.41`,
      auth: { authorization: `Bearer ${env.TELO_HOST_CONTAINER_ENGINE_TOKEN}` },
    };
  }

  async function createContainer(session: { prefix: string; auth: Record<string, string> }) {
    return server!.app.inject({
      method: "POST",
      url: `${session.prefix}/containers/create`,
      headers: session.auth,
      payload: CREATE_BODY,
    });
  }

  afterEach(async () => {
    await server?.app.close();
    server = undefined;
  });

  it("points every session at its own engine, with a token the runner minted", async () => {
    await boot();
    const { id } = await startSession();
    const env = starts[0]!.env;
    expect(env.TELO_HOST_CONTAINER_ENGINE_URL).toBe(`${INTERNAL_URL}/v1/sessions/${id}/engine`);
    expect(env.TELO_HOST_CONTAINER_ENGINE_TOKEN).toMatch(/^[a-z2-7]{32}$/);
  });

  it("gives a session nothing when the runner serves no engine", async () => {
    await boot(false);
    const res = await server!.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { ...SESSION_BODY, env: {} },
    });
    expect(res.statusCode).toBe(201);
    expect(Object.keys(starts[0]!.env).filter((key) => key.startsWith("TELO_HOST_"))).toEqual([]);
    const engineCall = await server!.app.inject({
      method: "GET",
      url: `/v1/sessions/${res.json().sessionId}/engine/v1.41/_ping`,
    });
    expect(engineCall.statusCode).toBe(404);
  });

  it("is refused at boot over a backend that cannot run containers", async () => {
    await expect(
      buildServer({
        backend: backend([]),
        config: config(true),
        version: "test",
        capabilities: {
          displayName: "test",
          description: "test",
          config: { schema: { type: "object" } },
          features: { io: ["tty"], ports: true, watch: false },
        },
      }),
    ).rejects.toThrow(RunnerConfigError);
  });

  it("refuses a request without the session's token, and a forged one", async () => {
    await boot();
    const session = await startSession();
    const missing = await server!.app.inject({ method: "GET", url: `${session.prefix}/_ping` });
    const forged = await server!.app.inject({
      method: "GET",
      url: `${session.prefix}/_ping`,
      headers: { authorization: `Bearer ${"a".repeat(32)}` },
    });
    expect([missing.statusCode, forged.statusCode]).toEqual([401, 403]);
  });

  it("answers ping, image inspect and pull", async () => {
    await boot();
    const session = await startSession();
    const ping = await server!.app.inject({ method: "GET", url: `${session.prefix}/_ping`, headers: session.auth });
    const held = await server!.app.inject({
      method: "GET",
      url: `${session.prefix}/images/held:1/json`,
      headers: session.auth,
    });
    const absent = await server!.app.inject({
      method: "GET",
      url: `${session.prefix}/images/library/absent:1/json`,
      headers: session.auth,
    });
    const pull = await server!.app.inject({
      method: "POST",
      url: `${session.prefix}/images/create?fromImage=library/absent&tag=1`,
      headers: session.auth,
    });
    expect([ping.body, held.statusCode, absent.statusCode, pull.statusCode]).toEqual(["OK", 200, 404, 200]);
  });

  it("creates what the whitelist admits, labelled with the session", async () => {
    await boot();
    const session = await startSession();
    const res = await createContainer(session);
    expect(res.statusCode).toBe(201);
    expect(engine.created).toEqual([
      {
        sessionId: session.id,
        spec: {
          image: "pgvector/pgvector:pg18",
          env: ["POSTGRES_PASSWORD=postgres"],
          user: "999:999",
          ports: [5432],
          labels: { "run.telo.container.expires": "1760000000", "run.telo.session": session.id },
        },
      },
    ]);
  });

  it.each([
    [{ Privileged: true }, "Privileged"],
    [{ HostConfig: { Privileged: true } }, "HostConfig.Privileged"],
    [{ HostConfig: { PublishAllPorts: true } }, "HostConfig.PublishAllPorts"],
    [
      { HostConfig: { PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5432" }] } } },
      "HostConfig.PortBindings.5432/tcp[0].HostPort",
    ],
    [
      { HostConfig: { PortBindings: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "" }] } } },
      "HostConfig.PortBindings.5432/tcp[0].HostIp",
    ],
    [
      { HostConfig: { PortBindings: { "6379/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } } },
      "HostConfig.PortBindings.6379/tcp",
    ],
    [{ Labels: { "run.telo.session": "other" } }, "Labels.run.telo.session"],
    [{ Env: ["NO_VALUE"] }, "Env[0]"],
  ])("refuses %j with a 400 naming %s", async (patch, field) => {
    await boot();
    const session = await startSession();
    const res = await server!.app.inject({
      method: "POST",
      url: `${session.prefix}/containers/create`,
      headers: session.auth,
      payload: { ...CREATE_BODY, ...patch },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message.startsWith(`${field}: `)).toBe(true);
    expect(engine.created).toEqual([]);
  });

  it("answers a field the backend cannot run with a 400 naming it", async () => {
    await boot();
    const session = await startSession();
    const res = await server!.app.inject({
      method: "POST",
      url: `${session.prefix}/containers/create`,
      headers: session.auth,
      payload: { ...CREATE_BODY, User: "root" },
    });
    expect([res.statusCode, res.json().message]).toEqual([400, "User: must not be root"]);
  });

  it("refuses a container beyond the session's ceiling", async () => {
    await boot();
    const session = await startSession();
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await createContainer(session)).statusCode);
    expect(codes).toEqual([201, 201, 429]);
  });

  it("answers inspect's binding with the address the session reaches the container at", async () => {
    await boot();
    const session = await startSession();
    const { Id } = (await createContainer(session)).json();
    await server!.app.inject({ method: "POST", url: `${session.prefix}/containers/${Id}/start`, headers: session.auth });
    const res = await server!.app.inject({
      method: "GET",
      url: `${session.prefix}/containers/${Id}/json`,
      headers: session.auth,
    });
    expect(res.json().State.Running).toBe(true);
    expect(res.json().NetworkSettings.Ports).toEqual({
      "5432/tcp": [{ HostIp: "10.0.0.7", HostPort: "5432" }],
    });
  });

  it("streams logs in the engine's multiplexed framing", async () => {
    await boot();
    const session = await startSession();
    const { Id } = (await createContainer(session)).json();
    const res = await server!.app.inject({
      method: "GET",
      url: `${session.prefix}/containers/${Id}/logs?follow=true&stdout=true&stderr=true`,
      headers: session.auth,
    });
    const frame = (stream: number, text: string) => {
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(Buffer.byteLength(text), 4);
      return Buffer.concat([header, Buffer.from(text)]);
    };
    expect(res.rawPayload).toEqual(Buffer.concat([frame(1, "ready\n"), frame(2, "warn")]));
  });

  it("lists the session's containers by label", async () => {
    await boot();
    const session = await startSession();
    const { Id } = (await createContainer(session)).json();
    const list = (filters: object) =>
      server!.app.inject({
        method: "GET",
        url: `${session.prefix}/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify(filters))}`,
        headers: session.auth,
      });
    expect((await list({ label: ["run.telo.container.expires"] })).json().map((c: { Id: string }) => c.Id)).toEqual([Id]);
    expect((await list({ label: ["absent"] })).json()).toEqual([]);
  });

  it("scopes every container id to the session that created it", async () => {
    await boot();
    const owner = await startSession();
    const other = await startSession();
    const { Id } = (await createContainer(owner)).json();
    const calls = await Promise.all([
      server!.app.inject({ method: "GET", url: `${other.prefix}/containers/${Id}/json`, headers: other.auth }),
      server!.app.inject({ method: "GET", url: `${other.prefix}/containers/${Id}/logs`, headers: other.auth }),
      server!.app.inject({ method: "DELETE", url: `${other.prefix}/containers/${Id}`, headers: other.auth }),
      server!.app.inject({
        method: "GET",
        url: `${other.prefix}/containers/json?all=true`,
        headers: other.auth,
      }),
    ]);
    expect(calls.map((c) => c.statusCode)).toEqual([404, 404, 404, 200]);
    expect(calls[3]!.json()).toEqual([]);
    expect(engine.removed).toEqual([]);
  });

  it("refuses a request outside the subset", async () => {
    await boot();
    const session = await startSession();
    const res = await server!.app.inject({
      method: "POST",
      url: `${session.prefix}/containers/c1/exec`,
      headers: session.auth,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("removes a session's containers when the session ends, and ends its engine", async () => {
    await boot();
    const session = await startSession();
    const { Id } = (await createContainer(session)).json();
    await server!.app.inject({ method: "DELETE", url: `/v1/sessions/${session.id}` });
    await expect.poll(() => engine.removed).toEqual([Id]);
    await expect.poll(() => engine.ended).toEqual([session.id]);
    const after = await server!.app.inject({ method: "GET", url: `${session.prefix}/_ping`, headers: session.auth });
    expect(after.statusCode).toBe(404);
  });

  it("removes a suspended session's containers and keeps its engine for the resume", async () => {
    await boot();
    const session = await startSession();
    const { Id } = (await createContainer(session)).json();
    server!.registry.emit(session.id, { type: "status", status: { kind: "suspended" } });
    await expect.poll(() => engine.removed).toEqual([Id]);
    expect(engine.ended).toEqual([]);
    const after = await server!.app.inject({ method: "GET", url: `${session.prefix}/_ping`, headers: session.auth });
    expect(after.statusCode).toBe(200);
  });

  it("removes every container when the runner shuts down", async () => {
    await boot();
    const session = await startSession();
    const { Id } = (await createContainer(session)).json();
    await server!.app.close();
    server = undefined;
    expect(engine.removed).toEqual([Id]);
    expect(engine.ended).toEqual([session.id]);
  });
});

describe("RUNNER_SESSION_CONTAINERS", () => {
  it("is off unless set", () => {
    expect(loadSessionContainersConfig({})).toEqual({ enabled: false, max: 4 });
  });

  it("refuses to boot without the runner's internal URL", () => {
    expect(() => loadSessionContainersConfig({ RUNNER_SESSION_CONTAINERS: "true" })).toThrow(
      /RUNNER_INTERNAL_URL is required/,
    );
  });
});
