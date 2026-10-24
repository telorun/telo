import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { loadResolvedApps } from "../config.js";
import type { RunEvent } from "../contract.js";
import { resumeSecretHash } from "../session/session-credentials.js";
import {
  bootTestServer,
  FakeWorkloadBackend,
  temporaryStore,
  testConfig,
} from "../test-support/fake-workload-backend.js";

type Booted = Awaited<ReturnType<typeof bootTestServer>>;

const APPS = [{ name: "web", entryRelativePath: "web/telo.yaml", ports: [{ port: 3000, protocol: "tcp" }] }];
const CATALOG = loadResolvedApps({
  RUNNER_APPS: JSON.stringify({
    agent: { image: "acme/agent:1", env: { KEY: "operator" }, port: 8080, tokenEnv: "AGENT_TOKEN" },
  }),
});

let booted: Booted | undefined;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  await booted?.server.app.close();
  await booted?.store.dispose();
  booted = undefined;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function boot(deps: Parameters<typeof bootTestServer>[0] = {}): Promise<Booted> {
  booted = await bootTestServer(deps);
  return booted;
}

async function create(b: Booted, body: Record<string, unknown> = {}) {
  const res = await b.server.app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: { workspace: "ws-1", apps: APPS, ...body },
  });
  expect(res.statusCode).toBe(201);
  const { sessionId, resumeSecret } = res.json() as { sessionId: string; resumeSecret: string };
  await expect.poll(() => b.server.registry.get(sessionId)?.status.kind).toBe("running");
  return { id: sessionId, secret: resumeSecret, auth: { authorization: `Bearer ${resumeSecret}` } };
}

function call(
  b: Booted,
  session: { id: string; auth: Record<string, string> },
  method: "GET" | "POST" | "PUT" | "DELETE",
  suffix: string,
  payload?: Record<string, unknown>,
) {
  return b.server.app.inject({
    method,
    url: `/v1/sessions/${session.id}${suffix}`,
    headers: session.auth,
    ...(payload !== undefined ? { payload } : {}),
  });
}

function events(b: Booted, sessionId: string): RunEvent[] {
  return b.server.registry.get(sessionId)!.buffer.replay(0).entries.map((e) => e.event);
}

describe("creating a session", () => {
  it("creates an empty workspace session, answers its resume secret once and stores only its hash", async () => {
    const b = await boot();
    const s = await create(b);

    const record = await b.store.store.get(s.id);
    expect(record).toMatchObject({
      workspace: "ws-1",
      owner: { kind: "secret", secretHash: resumeSecretHash(s.secret) },
      apps: [{ name: "web", entryRelativePath: "web/telo.yaml", ports: [{ port: 3000, protocol: "tcp" }] }],
      status: "running",
    });
    expect(JSON.stringify(record)).not.toContain(s.secret);
    // The workload is created with no env: env arrives with each Run.
    expect(Object.keys(b.backend.created[0]!).sort()).toEqual(["apps", "config", "sessionId", "tokens"]);
    const doc = (await call(b, s, "GET", "")).json();
    expect(doc).toMatchObject({ sessionId: s.id, workspace: "ws-1", apps: [{ name: "web", state: "ready" }] });
    expect(doc).not.toHaveProperty("resumeSecret");
  });

  it("answers a second create for the same owner and workspace with the existing id", async () => {
    const b = await boot({
      resolveCaller: async () => ({
        caller: { kind: "owner", owner: { kind: "identity", iss: "https://id.example", sub: "u1" } },
      }),
    });
    const first = await b.server.app.inject({ method: "POST", url: "/v1/sessions", payload: { workspace: "w", apps: [] } });
    const second = await b.server.app.inject({ method: "POST", url: "/v1/sessions", payload: { workspace: "w", apps: [] } });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "session_exists", sessionId: first.json().sessionId });
    expect(first.json()).not.toHaveProperty("resumeSecret");
  });

  it("refuses a resume secret presented on create", async () => {
    const b = await boot();
    const res = await b.server.app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: "Bearer someone-elses" },
      payload: { workspace: "w", apps: [] },
    });
    expect([res.statusCode, res.json().error]).toEqual([400, "resume_secret_on_create"]);
  });

  it("bounds running sessions, counting no suspended one", async () => {
    const b = await boot({ config: testConfig({ maxSessions: 1 }) });
    const s = await create(b);
    const refused = await b.server.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { workspace: "ws-2", apps: [] },
    });
    expect([refused.statusCode, refused.json().error]).toEqual([429, "too_many_sessions"]);

    await call(b, s, "POST", "/suspend");
    await create(b, { workspace: "ws-2" });
  });
});

describe("credentials", () => {
  it("takes the resume secret on every route: none is 401, another owner's session is the same 404 as none", async () => {
    const b = await boot();
    const s = await create(b);
    const other = await create(b, { workspace: "ws-2" });

    const missing = await b.server.app.inject({ method: "GET", url: `/v1/sessions/${s.id}` });
    const foreign = await call(b, { id: s.id, auth: other.auth }, "GET", "");
    const unknown = await call(b, { id: "nosuchsession", auth: other.auth }, "GET", "");

    expect([missing.statusCode, missing.json().error]).toEqual([401, "session_auth_required"]);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ ...unknown.json(), message: `no session '${s.id}'` });
  });
});

describe("running an app", () => {
  it("starts the app in its slot with the runner's argv and the run's env, and refuses a second Run while one is live", async () => {
    const b = await boot();
    const s = await create(b);

    const run = await call(b, s, "POST", "/apps/web/run", {
      env: { NAME: "x", TELO_CACHE_DIR: "/elsewhere" },
      io: "streams",
    });
    expect(run.statusCode).toBe(202);
    const { runId } = run.json();
    const asked = b.backend.workloadOf(s.id).runs[0]!;
    expect(asked).toEqual({
      app: "web",
      run: {
        runId,
        argv: ["telo", "run", "--watch", "--no-input", "--inspect", "0.0.0.0:9230", "--no-open", "web/telo.yaml"],
        env: { NAME: "x" },
        cwd: ".",
        io: "streams",
      },
    });

    const again = await call(b, s, "POST", "/apps/web/run", { env: {}, io: "tty" });
    expect([again.statusCode, again.json().error]).toEqual([409, "run_active"]);
    expect(events(b, s.id)).toContainEqual({ type: "app", app: "web", state: "running", runId });
  });

  it("stops the live run, after which the app is ready again; with none live it is a no-op", async () => {
    const b = await boot();
    const s = await create(b);
    const { runId } = (await call(b, s, "POST", "/apps/web/run", { env: {}, io: "tty" })).json();

    const stop = await call(b, s, "POST", "/apps/web/stop");
    const idle = await call(b, s, "POST", "/apps/web/stop");

    expect([stop.statusCode, stop.json()]).toEqual([202, { runId }]);
    expect(idle.json()).toEqual({ runId: null });
    expect(b.backend.workloadOf(s.id).stops).toEqual([{ app: "web", runId, graceMs: 10_000 }]);
    expect(events(b, s.id)).toContainEqual({
      type: "app",
      app: "web",
      state: "ready",
      ended: { runId, signal: "SIGTERM" },
    });
  });

  it("refuses an io mode the runner does not serve", async () => {
    const b = await boot({
      capabilities: { displayName: "t", description: "", config: { schema: {} }, features: { io: ["streams"], ports: true } },
    });
    const s = await create(b);
    const res = await call(b, s, "POST", "/apps/web/run", { env: {}, io: "tty" });
    expect([res.statusCode, res.json().error]).toEqual([400, "io_unsupported"]);
  });

  it("relays each run's debug stream from a fresh last-event-id, attributing the first generation to Run", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const inspect = await sseServer((headers) => seen.push(headers));
    const backend = new FakeWorkloadBackend();
    backend.addresses = () => ({ inspect: { listen: "0.0.0.0:9230", url: inspect.url }, host: "127.0.0.1" });
    const b = await boot({ backend });
    const s = await create(b);

    for (let i = 0; i < 2; i++) {
      await call(b, s, "POST", "/apps/web/run", { env: {}, io: "tty" });
      await expect.poll(() => runStarts(b, s.id).length).toBe(i + 1);
      await call(b, s, "POST", "/apps/web/stop");
    }

    expect(runStarts(b, s.id)).toEqual([
      expect.objectContaining({ generation: 1, trigger: "run" }),
      expect.objectContaining({ generation: 2, trigger: "run" }),
    ]);
    // Each process gets its own relay, which asks from the beginning.
    expect(seen.map((h) => h["last-event-id"])).toEqual([undefined, undefined]);
  });

  it("reports reachability of an app's ports only while it runs", async () => {
    const b = await boot();
    const s = await create(b);
    const reachability = () => events(b, s.id).filter((e) => e.type === "reachability");
    expect(reachability()).toEqual([]);

    await call(b, s, "POST", "/apps/web/run", { env: {}, io: "tty" });
    await expect.poll(() => reachability()).toEqual([
      { type: "reachability", app: "web", port: 3000, state: "checking" },
    ]);
    await call(b, s, "POST", "/apps/web/stop");
    const after = reachability().length;
    await new Promise((r) => setTimeout(r, 50));
    expect(reachability()).toHaveLength(after);
  });
});

describe("the session lifecycle", () => {
  it("suspends by deleting the workload and keeping the record, and resumes under the same id with apps ready", async () => {
    const b = await boot();
    const s = await create(b);
    const first = b.backend.workloadOf(s.id);

    expect((await call(b, s, "POST", "/suspend")).statusCode).toBe(202);
    expect(first.suspended).toBe(true);
    expect(await b.store.store.get(s.id)).toMatchObject({ status: "suspended", suspendedAt: expect.any(Date) });

    expect((await call(b, s, "POST", "/resume")).statusCode).toBe(202);
    await expect.poll(() => b.server.registry.get(s.id)?.status.kind).toBe("running");
    expect(b.backend.created).toHaveLength(2);
    expect(await b.store.store.get(s.id)).toMatchObject({ status: "running", suspendedAt: null });
    expect((await call(b, s, "GET", "")).json().apps).toMatchObject([{ name: "web", state: "ready" }]);
  });

  it("suspends a session idle for the idle window, and not one a client is attached to", async () => {
    let now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    const b = await boot({ config: testConfig({ sessions: { ...testConfig().sessions, idleMs: 1000 } }) });
    const idle = await create(b);
    const watched = await create(b, { workspace: "ws-2" });
    b.server.registry.addSubscriber(watched.id);
    for (const id of [idle.id, watched.id]) b.server.registry.get(id)!.idleSince = now;

    vi.setSystemTime((now += 1000));
    await b.server.lifecycle.tick();

    expect(b.server.registry.get(idle.id)!.status.kind).toBe("suspended");
    expect(b.server.registry.get(watched.id)!.status.kind).toBe("running");
  });

  it("suspends a session past its running limit even with a client attached", async () => {
    let now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    const b = await boot({ config: testConfig({ sessions: { ...testConfig().sessions, maxRunningSeconds: 60 } }) });
    const s = await create(b);
    b.server.registry.addSubscriber(s.id);
    b.server.registry.get(s.id)!.runningSince = now;

    vi.setSystemTime((now += 59_000));
    await b.server.lifecycle.tick();
    expect(b.server.registry.get(s.id)!.status.kind).toBe("running");
    vi.setSystemTime((now += 1_000));
    await b.server.lifecycle.tick();
    expect(b.server.registry.get(s.id)!.status.kind).toBe("suspended");
  });

  it("purges a session suspended past retention, with its storage", async () => {
    let now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    const b = await boot({ config: testConfig({ sessions: { ...testConfig().sessions, retentionMs: 5000 } }) });
    const s = await create(b);
    await call(b, s, "POST", "/suspend");

    vi.setSystemTime((now += 4999));
    await b.server.lifecycle.tick();
    expect(b.server.registry.has(s.id)).toBe(true);
    vi.setSystemTime((now += 1));
    await b.server.lifecycle.tick();

    expect(b.server.registry.has(s.id)).toBe(false);
    expect(await b.store.store.get(s.id)).toBeUndefined();
    expect(b.backend.destroyed).toEqual([s.id]);
  });

  it("deletes the workload, the storage and the record", async () => {
    const b = await boot();
    const s = await create(b);
    const res = await call(b, s, "DELETE", "");

    expect(res.statusCode).toBe(204);
    expect(b.backend.workloadOf.bind(b.backend, s.id)).toThrow();
    expect(b.backend.destroyed).toEqual([s.id]);
    expect(await b.store.store.get(s.id)).toBeUndefined();
    expect((await call(b, s, "GET", "")).statusCode).toBe(404);
  });

  it("records a workload failure, keeps the storage, and resumes from it", async () => {
    const b = await boot();
    const s = await create(b);
    const workload = b.backend.workloadOf(s.id);
    workload.callbacks.onStatus({ kind: "failed", message: "container app-web ended" });

    await expect.poll(async () => (await b.store.store.get(s.id))?.status).toBe("failed");
    expect(workload.suspended).toBe(true);
    expect(b.backend.destroyed).toEqual([]);
    expect((await call(b, s, "POST", "/resume")).statusCode).toBe(202);
    await expect.poll(() => b.server.registry.get(s.id)?.status.kind).toBe("running");
  });
});

describe("a store that refuses writes", () => {
  /** A store whose next `failures` record updates throw. */
  async function flakyStore() {
    const handle = await temporaryStore();
    const real = handle.store;
    const control = { failures: 0 };
    const flaky = Object.create(real) as typeof real;
    flaky.update = async (id, changes) => {
      if (control.failures > 0) {
        control.failures -= 1;
        throw new Error("disk I/O error");
      }
      return real.update(id, changes);
    };
    handle.store = flaky;
    booted = await bootTestServer({ storeRetryDelaysMs: [1, 1] }, handle);
    return { b: booted, control };
  }

  it("retries a failed record write", async () => {
    const { b, control } = await flakyStore();
    const s = await create(b);
    control.failures = 2;
    expect((await call(b, s, "POST", "/suspend")).statusCode).toBe(202);
    expect(await b.store.store.get(s.id)).toMatchObject({ status: "suspended" });
  });

  it("fails a session whose reported status cannot be written, with the store's error on its stream, and resumes it", async () => {
    const { b, control } = await flakyStore();
    control.failures = Infinity;
    const res = await b.server.app.inject({ method: "POST", url: "/v1/sessions", payload: { workspace: "ws-1", apps: APPS } });
    const s = { id: res.json().sessionId as string, auth: { authorization: `Bearer ${res.json().resumeSecret}` } };
    await expect.poll(() => b.server.registry.get(s.id)?.status).toEqual({
      kind: "failed",
      message: "the session record could not be written to the session store: disk I/O error",
    });
    expect(b.backend.workloads[0]!.suspended).toBe(true);
    await expect.poll(() => b.server.registry.get(s.id)?.busy).toBeNull();

    control.failures = 0;
    expect((await call(b, s, "POST", "/resume")).statusCode).toBe(202);
    await expect.poll(() => b.server.registry.get(s.id)?.status.kind).toBe("running");
  });

  it("leaves a session whose resume cannot be written failed and not busy", async () => {
    const { b, control } = await flakyStore();
    const s = await create(b);
    await call(b, s, "POST", "/suspend");
    control.failures = Infinity;

    const refused = await call(b, s, "POST", "/resume");
    expect([refused.statusCode, refused.json().error]).toEqual([500, "session_store_failed"]);
    const entry = b.server.registry.get(s.id)!;
    expect([entry.busy, entry.status.kind]).toEqual([null, "failed"]);

    control.failures = 0;
    expect((await call(b, s, "POST", "/resume")).statusCode).toBe(202);
    await expect.poll(() => b.server.registry.get(s.id)?.status.kind).toBe("running");
  });

  it("fails a session whose suspend cannot be written once its workload is gone", async () => {
    const { b, control } = await flakyStore();
    const s = await create(b);
    const workload = b.backend.workloadOf(s.id);
    control.failures = Infinity;

    const refused = await call(b, s, "POST", "/suspend");
    expect([refused.statusCode, refused.json().error]).toEqual([500, "session_store_failed"]);
    const entry = b.server.registry.get(s.id)!;
    expect([workload.suspended, entry.workload, entry.busy, entry.status.kind]).toEqual([true, null, null, "failed"]);

    control.failures = 0;
    expect((await call(b, s, "POST", "/resume")).statusCode).toBe(202);
    await expect.poll(() => b.server.registry.get(s.id)?.status.kind).toBe("running");
  });
});

describe("the app set and the agent", () => {
  it("writes a new app set to the store before the workload is recreated with it", async () => {
    const b = await boot();
    const s = await create(b);
    const workload = b.backend.workloadOf(s.id);
    let storedFirst: string[] | undefined;
    workload.onSetApps = () => {
      void b.store.store.get(s.id).then((r) => (storedFirst = r?.apps.map((a) => a.name)));
    };

    const res = await call(b, s, "PUT", "/apps", {
      apps: [{ name: "worker", entryRelativePath: "worker.yaml" }],
    });

    expect(res.statusCode).toBe(202);
    await expect.poll(() => storedFirst).toEqual(["worker"]);
    expect(workload.apps.map((a) => a.name)).toEqual(["worker"]);
    expect([...b.server.registry.get(s.id)!.apps.keys()]).toEqual(["worker"]);
  });

  it("judges telo versions when the app set is replaced", async () => {
    const backend = new FakeWorkloadBackend();
    Object.assign(backend, { supplyTelo: async () => undefined });
    const b = await boot({
      backend,
      capabilities: {
        displayName: "t",
        description: "",
        config: { schema: {} },
        features: { io: ["tty"], ports: true, teloVersions: true },
      },
    });
    const s = await create(b);
    const res = await call(b, s, "PUT", "/apps", {
      apps: [{ name: "web", entryRelativePath: "telo.yaml", telo: "0.120.0" }],
    });
    expect([res.statusCode, res.json().error]).toEqual([400, "telo_version_unavailable"]);
  });

  it("refuses an app declaring a port the backend reserves, on create and on replace", async () => {
    const backend = new FakeWorkloadBackend();
    Object.assign(backend, {
      reservedPorts: (apps: Array<{ name: string }>) =>
        apps.map((a, i) => ({ app: a.name, port: 9330 + i, protocol: "tcp", purpose: "the session supervisor" })),
    });
    const b = await boot({ backend });
    const refused = await b.server.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        workspace: "ws-1",
        apps: [...APPS, { name: "worker", entryRelativePath: "w.yaml", ports: [{ port: 9330, protocol: "tcp" }] }],
      },
    });
    expect([refused.statusCode, refused.json()]).toEqual([
      400,
      {
        error: "port_conflict",
        message:
          "app 'worker' declares tcp port 9330, which this runner reserves for the session supervisor of app 'web'",
      },
    ]);

    const s = await create(b);
    const replaced = await call(b, s, "PUT", "/apps", {
      apps: [{ name: "web", entryRelativePath: "telo.yaml", ports: [{ port: 9330, protocol: "tcp" }] }],
    });
    expect([replaced.statusCode, replaced.json().error]).toEqual([400, "port_conflict"]);
    expect(b.backend.workloadOf(s.id).apps.map((a) => a.ports)).toEqual([APPS[0]!.ports]);
  });

  it("recreates the workload with the agent and a token minted for it, and removes it on null", async () => {
    const b = await boot({ apps: CATALOG });
    const s = await create(b);
    const workload = b.backend.workloadOf(s.id);

    const set = await call(b, s, "PUT", "/agent", { name: "agent" });
    expect([set.statusCode, set.json()]).toEqual([202, { agent: "agent" }]);
    const token = workload.tokens.agent!;
    expect(workload.agent?.env).toEqual({ KEY: "operator", AGENT_TOKEN: token });
    await expect.poll(() => b.server.registry.get(s.id)!.status).toMatchObject({ agent: { token } });
    expect((await b.store.store.get(s.id))?.agent).toBe("agent");

    await call(b, s, "PUT", "/agent", { name: null });
    expect(workload.agent).toBeUndefined();
    expect((await b.store.store.get(s.id))?.agent).toBeNull();
  });
});

describe("boot", () => {
  it("adopts a running session's workload and its live run, suspends one whose workload is gone, and sweeps sparing known sessions", async () => {
    const store = await temporaryStore();
    const first = await bootTestServer({}, store);
    const kept = await create(first);
    const lost = await create(first, { workspace: "ws-2" });
    const parked = await create(first, { workspace: "ws-3" });
    await call(first, parked, "POST", "/suspend");
    await first.server.app.close();

    const backend = new FakeWorkloadBackend();
    backend.adoptable.set(kept.id, { tokens: {}, live: { web: "run-1" } });
    booted = await bootTestServer({ backend }, store);

    const registry = booted.server.registry;
    expect(registry.get(kept.id)!.status.kind).toBe("running");
    expect(registry.get(kept.id)!.apps.get("web")).toMatchObject({ state: "running", run: { runId: "run-1" } });
    expect(registry.get(lost.id)!.status.kind).toBe("suspended");
    expect(await store.store.get(lost.id)).toMatchObject({ status: "suspended" });
    expect(backend.reaped).toEqual([
      { known: new Set([kept.id, lost.id, parked.id]), live: new Set([kept.id]) },
    ]);
    // The adopted run is stoppable.
    await call(booted, kept, "POST", "/apps/web/stop");
    expect(backend.workloadOf(kept.id).stops).toMatchObject([{ app: "web", runId: "run-1" }]);
  });

  it("suspends every running session over a backend that cannot adopt", async () => {
    const store = await temporaryStore();
    const first = await bootTestServer({}, store);
    const s = await create(first);
    await first.server.app.close();

    const backend = new FakeWorkloadBackend();
    backend.adopt = undefined;
    booted = await bootTestServer({ backend }, store);
    expect(booted.server.registry.get(s.id)!.status.kind).toBe("suspended");
  });

  it("detaches every workload on close and stops nothing", async () => {
    const b = await boot();
    const s = await create(b);
    const workload = b.backend.workloadOf(s.id);
    await b.server.app.close();
    expect([workload.detached, workload.suspended]).toEqual([true, false]);
    expect((await b.store.store.get(s.id))?.status).toBe("running");
  });
});

describe("the byte channel", () => {
  it("takes only a single-use ticket bound to the session and the app", async () => {
    const b = await boot();
    const s = await create(b);
    await b.server.app.listen({ port: 0, host: "127.0.0.1" });
    const base = `ws://127.0.0.1:${(b.server.app.server.address() as AddressInfo).port}/v1/sessions/${s.id}/io`;

    const unknown = await call(b, s, "POST", "/io-tickets", { app: "nope" });
    expect(unknown.statusCode).toBe(404);
    const minted = await call(b, s, "POST", "/io-tickets", { app: "web" });
    expect(minted.statusCode).toBe(201);
    const { ticket } = minted.json();

    expect(await closeCode(base)).toBe(4401);
    const first = await firstMessage(`${base}?ticket=${ticket}`);
    expect(JSON.parse(first)).toMatchObject({ type: "seq", app: "web" });
    expect(await closeCode(`${base}?ticket=${ticket}`)).toBe(4403);
  });
});

function runStarts(b: Booted, sessionId: string) {
  return events(b, sessionId).filter((e) => e.type === "run" && e.phase === "started");
}

/** An inspect endpoint that answers each connection with one `Kernel.Starting`. */
async function sseServer(onConnect: (headers: IncomingHttpHeaders) => void): Promise<{ url: string }> {
  const server: Server = createServer((req, res) => {
    onConnect(req.headers);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `id: 7\nevent: debug\ndata: ${JSON.stringify({
        kind: "event",
        timestamp: "2026-01-01T00:00:00.000Z",
        event: "Kernel.Starting",
        payload: {},
      })}\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/events` };
}

function closeCode(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on("close", (code) => resolve(code));
    socket.on("error", reject);
  });
}

function firstMessage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on("message", (data) => {
      resolve(data.toString());
      socket.close();
    });
    socket.on("close", (code) => reject(new Error(`closed ${code}`)));
    socket.on("error", reject);
  });
}
