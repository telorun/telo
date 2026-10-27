import { afterEach, describe, expect, it } from "vitest";

import { loadSessionContainersConfig, RunnerConfigError, type RunnerCoreConfig } from "../config.js";
import { buildServer } from "../server.js";
import {
  SessionContainerFieldRefused,
  SessionContainerNotFound,
  type SessionContainerEngine,
  type SessionContainerSpec,
} from "../session-containers/session-container-engine.js";
import {
  bootTestServer,
  FakeWorkloadBackend,
  TEST_CAPABILITIES,
  temporaryStore,
  testConfig,
} from "../test-support/fake-workload-backend.js";

const INTERNAL_URL = "http://runner.internal:8061";

function config(enabled: boolean): RunnerCoreConfig {
  return testConfig({
    sessionContainers: enabled
      ? { enabled: true, max: 2, internalUrl: INTERNAL_URL }
      : { enabled: false, max: 2 },
  });
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

/** A Run's env carrying a client value the runner must write over. */
const RUN_BODY = { env: { TELO_HOST_CONTAINER_ENGINE_TOKEN: "client" }, io: "tty" };

const CREATE_BODY = {
  Image: "pgvector/pgvector:pg18",
  Env: ["POSTGRES_PASSWORD=postgres"],
  User: "999:999",
  ExposedPorts: { "5432/tcp": {} },
  Labels: { "run.telo.container.expires": "1760000000" },
  HostConfig: { PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } },
};

describe("the session container engine", () => {
  let booted: Awaited<ReturnType<typeof bootTestServer>> | undefined;
  let engine: FakeEngine;

  async function boot(enabled = true) {
    engine = fakeEngine();
    booted = await bootTestServer({
      backend: new FakeWorkloadBackend({ containers: engine }),
      config: config(enabled),
    });
    return booted;
  }

  /** A session with one app, run once: the engine env rides each Run. */
  async function startSession(): Promise<{
    id: string;
    prefix: string;
    auth: Record<string, string>;
    session: Record<string, string>;
    env: Record<string, string>;
  }> {
    const res = await booted!.server.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspace: `w-${Math.random()}`, apps: [{ name: "app", entryRelativePath: "telo.yaml" }] },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().sessionId as string;
    const session = { authorization: `Bearer ${res.json().resumeSecret}` };
    await expect.poll(() => booted!.server.registry.get(id)?.apps.get("app")?.state).toBe("ready");
    const run = await booted!.server.app.inject({
      method: "POST",
      url: `/v1/sessions/${id}/apps/app/run`,
      headers: session,
      payload: RUN_BODY,
    });
    expect(run.statusCode).toBe(202);
    const env = booted!.backend.workloadOf(id).runs.at(-1)!.run.env;
    return {
      id,
      prefix: `/v1/sessions/${id}/engine/v1.41`,
      auth: { authorization: `Bearer ${env.TELO_HOST_CONTAINER_ENGINE_TOKEN}` },
      session,
      env,
    };
  }

  async function createContainer(session: { prefix: string; auth: Record<string, string> }) {
    return booted!.server.app.inject({
      method: "POST",
      url: `${session.prefix}/containers/create`,
      headers: session.auth,
      payload: CREATE_BODY,
    });
  }

  afterEach(async () => {
    await booted?.server.app.close();
    await booted?.store.dispose();
    booted = undefined;
  });

  it("points every run of a session at its own engine, with a token the runner minted", async () => {
    await boot();
    const { id, env } = await startSession();
    expect(env.TELO_HOST_CONTAINER_ENGINE_URL).toBe(`${INTERNAL_URL}/v1/sessions/${id}/engine`);
    expect(env.TELO_HOST_CONTAINER_ENGINE_TOKEN).toMatch(/^[a-z2-7]{32}$/);
  }, 20_000);

  it("gives a session nothing when the runner serves no engine", async () => {
    await boot(false);
    const { env, prefix } = await startSession();
    expect(env).toEqual(RUN_BODY.env);
    const engineCall = await booted!.server.app.inject({ method: "GET", url: `${prefix}/_ping` });
    expect(engineCall.statusCode).toBe(404);
  });

  it("is refused at boot over a backend that cannot run containers", async () => {
    const store = await temporaryStore();
    await expect(
      buildServer({
        backend: new FakeWorkloadBackend(),
        config: config(true),
        version: "test",
        capabilities: TEST_CAPABILITIES,
        store: store.store,
      }),
    ).rejects.toThrow(RunnerConfigError);
    await store.dispose();
  });

  it("refuses a request without the session's token, and a forged one", async () => {
    await boot();
    const session = await startSession();
    const missing = await booted!.server.app.inject({ method: "GET", url: `${session.prefix}/_ping` });
    const forged = await booted!.server.app.inject({
      method: "GET",
      url: `${session.prefix}/_ping`,
      headers: { authorization: `Bearer ${"a".repeat(32)}` },
    });
    expect([missing.statusCode, forged.statusCode]).toEqual([401, 403]);
  });

  it("answers ping, image inspect and pull", async () => {
    await boot();
    const session = await startSession();
    const ping = await booted!.server.app.inject({ method: "GET", url: `${session.prefix}/_ping`, headers: session.auth });
    const held = await booted!.server.app.inject({
      method: "GET",
      url: `${session.prefix}/images/held:1/json`,
      headers: session.auth,
    });
    const absent = await booted!.server.app.inject({
      method: "GET",
      url: `${session.prefix}/images/library/absent:1/json`,
      headers: session.auth,
    });
    const pull = await booted!.server.app.inject({
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
    const res = await booted!.server.app.inject({
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
    const res = await booted!.server.app.inject({
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
    await booted!.server.app.inject({ method: "POST", url: `${session.prefix}/containers/${Id}/start`, headers: session.auth });
    const res = await booted!.server.app.inject({
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
    const res = await booted!.server.app.inject({
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
      booted!.server.app.inject({
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
      booted!.server.app.inject({ method: "GET", url: `${other.prefix}/containers/${Id}/json`, headers: other.auth }),
      booted!.server.app.inject({ method: "GET", url: `${other.prefix}/containers/${Id}/logs`, headers: other.auth }),
      booted!.server.app.inject({ method: "DELETE", url: `${other.prefix}/containers/${Id}`, headers: other.auth }),
      booted!.server.app.inject({
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
    const res = await booted!.server.app.inject({
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
    await booted!.server.app.inject({
      method: "DELETE",
      url: `/v1/sessions/${session.id}`,
      headers: session.session,
    });
    await expect.poll(() => engine.removed).toEqual([Id]);
    await expect.poll(() => engine.ended).toEqual([session.id]);
    const after = await booted!.server.app.inject({ method: "GET", url: `${session.prefix}/_ping`, headers: session.auth });
    expect(after.statusCode).toBe(404);
  });

  it("removes a suspended session's containers and keeps its engine for the resume", async () => {
    await boot();
    const session = await startSession();
    const { Id } = (await createContainer(session)).json();
    booted!.server.registry.emit(session.id, { type: "status", status: { kind: "suspended" } });
    await expect.poll(() => engine.removed).toEqual([Id]);
    expect(engine.ended).toEqual([]);
    const after = await booted!.server.app.inject({ method: "GET", url: `${session.prefix}/_ping`, headers: session.auth });
    expect(after.statusCode).toBe(200);
  });

  /** Close the runner and boot another over the same store and engine, with
   *  the session's workload still there when `adoptable`. */
  async function restart(sessionId: string, adoptable: boolean) {
    const store = booted!.store;
    await booted!.server.app.close();
    const backend = new FakeWorkloadBackend({ containers: engine });
    if (adoptable) backend.adoptable.set(sessionId, { tokens: {}, live: { app: "run-1" } });
    booted = await bootTestServer({ backend, config: config(true) }, store);
  }

  it("keeps a live session's containers across a runner restart, still admitting the token its run holds", async () => {
    await boot();
    const session = await startSession();
    const { Id } = (await createContainer(session)).json();
    await restart(session.id, true);
    expect([engine.removed, engine.ended]).toEqual([[], []]);

    const inspect = await booted!.server.app.inject({
      method: "GET",
      url: `${session.prefix}/containers/${Id}/json`,
      headers: session.auth,
    });
    expect(inspect.statusCode).toBe(200);

    // Once the runs holding the old token are gone, it admits nothing.
    booted!.server.registry.emit(session.id, { type: "status", status: { kind: "suspended" } });
    await expect.poll(() => engine.removed).toEqual([Id]);
    const after = await booted!.server.app.inject({ method: "GET", url: `${session.prefix}/_ping`, headers: session.auth });
    expect(after.statusCode).toBe(403);
  });

  it("removes the containers of a session whose workload did not survive a runner restart", async () => {
    await boot();
    const session = await startSession();
    const { Id } = (await createContainer(session)).json();
    await restart(session.id, false);
    expect(booted!.server.registry.get(session.id)!.status.kind).toBe("suspended");
    await expect.poll(() => engine.removed).toEqual([Id]);
    expect(engine.ended).toEqual([]);
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
