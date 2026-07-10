import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../server.js";
import { SessionRegistry } from "@telorun/runner-core";
import {
  makeFakeDocker,
  makeRunnerConfig,
  waitFor,
  type FakeDockerBehavior,
} from "../test-helpers.js";

interface TestHarness {
  app: FastifyInstance;
  registry: SessionRegistry;
  docker: ReturnType<typeof makeFakeDocker>;
  bundleRoot: string;
}

async function buildHarness(
  behavior: FakeDockerBehavior = {},
  configOverrides: Partial<ReturnType<typeof makeRunnerConfig>> = {},
): Promise<TestHarness> {
  const bundleRoot = await mkdtemp(join(tmpdir(), "docker-runner-sessions-"));
  const runnerConfig = makeRunnerConfig({ bundleRoot, ...configOverrides });
  const docker = makeFakeDocker(behavior);
  const { app, registry } = await buildServer({ docker, runnerConfig });
  await app.ready();
  return { app, registry, docker, bundleRoot };
}

async function teardownHarness(h: TestHarness): Promise<void> {
  await h.app.close();
  await rm(h.bundleRoot, { recursive: true, force: true });
}

const VALID_START_BODY = {
  bundle: {
    entryRelativePath: "telo.yaml",
    files: [{ relativePath: "telo.yaml", contents: "kind: Telo.Application\n" }],
  },
  env: { TELO_TEST: "1" },
  config: { image: "telorun/telo:nodejs", pullPolicy: "missing" as const },
};

/**
 * POST a session and wait for the background `backend.start()` to settle — i.e.
 * it created the container (`_lastCreateOpts`) or surfaced a terminal `failed`
 * status. The route returns 201 before start runs, so tests that inspect start's
 * side effects (or its failure) must wait for it.
 */
async function startSession(h: TestHarness, payload: object = VALID_START_BODY) {
  const res = await h.app.inject({ method: "POST", url: "/v1/sessions", payload });
  if (res.statusCode === 201) {
    const { sessionId } = res.json() as { sessionId: string };
    await waitFor(
      () => h.docker._lastCreateOpts != null || h.registry.get(sessionId)?.status.kind === "failed",
      "start settled",
    );
  }
  return res;
}

describe("POST /v1/sessions", () => {
  let h: TestHarness;

  afterEach(async () => {
    if (h) await teardownHarness(h);
  });

  it("returns 201 with sessionId + streamUrl on happy path", async () => {
    h = await buildHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: VALID_START_BODY,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { sessionId: string; streamUrl: string; createdAt: string };
    expect(body.sessionId).toMatch(/^[a-z2-7]{12}$/);
    expect(body.streamUrl).toBe(`/v1/sessions/${body.sessionId}/events`);
    expect(body.createdAt).toEqual(expect.any(String));
    expect(h.registry.has(body.sessionId)).toBe(true);
  });

  it("writes bundle files to disk under bundleRoot/<sessionId>", async () => {
    h = await buildHarness();
    const res = await startSession(h);
    const { sessionId } = res.json() as { sessionId: string };
    const written = await readFile(join(h.bundleRoot, sessionId, "telo.yaml"), "utf8");
    expect(written).toBe("kind: Telo.Application\n");
  });

  it("names the container telo-run-<sessionId> and bind-mounts the bundle volume", async () => {
    h = await buildHarness();
    const res = await startSession(h);
    const { sessionId } = res.json() as { sessionId: string };
    const opts = h.docker._lastCreateOpts;
    expect(opts?.name).toBe(`telo-run-${sessionId}`);
    expect(opts?.HostConfig.Binds).toEqual(["telo_runner-bundles:/srv"]);
    expect(opts?.HostConfig.NetworkMode).toBe("telo_default");
    expect(opts?.HostConfig.AutoRemove).toBe(true);
    expect(opts?.WorkingDir).toBe(`/srv/${sessionId}`);
    expect(opts?.Cmd).toEqual(["telo", "./telo.yaml"]);
  });

  it("Env contains exactly FORCE_COLOR + CLICOLOR_FORCE + request env — no runner leak", async () => {
    // Seed runner process env with a noise var to prove it doesn't leak.
    process.env.RUNNER_SECRET_KEY = "should-not-leak";
    h = await buildHarness();
    await startSession(h, {
      ...VALID_START_BODY,
      env: { FOO: "bar", BAZ: "qux" },
    });
    delete process.env.RUNNER_SECRET_KEY;

    const envArr = h.docker._lastCreateOpts?.Env ?? [];
    expect(envArr).toContain("FORCE_COLOR=1");
    expect(envArr).toContain("CLICOLOR_FORCE=1");
    expect(envArr).toContain("FOO=bar");
    expect(envArr).toContain("BAZ=qux");
    for (const entry of envArr) {
      expect(entry).not.toMatch(/RUNNER_SECRET_KEY/);
    }
  });

  describe("TELO_REGISTRY_URL precedence", () => {
    afterEach(() => {
      delete process.env.TELO_REGISTRY_URL;
    });

    it("uses runner's TELO_REGISTRY_URL when neither body.env nor body.config.registryUrl provides one", async () => {
      process.env.TELO_REGISTRY_URL = "http://runner-default:3000";
      h = await buildHarness();
      await startSession(h);
      expect(h.docker._lastCreateOpts?.Env ?? []).toContain("TELO_REGISTRY_URL=http://runner-default:3000");
    });

    it("body.config.registryUrl overrides the runner's TELO_REGISTRY_URL", async () => {
      process.env.TELO_REGISTRY_URL = "http://runner-default:3000";
      h = await buildHarness();
      await startSession(h, {
        ...VALID_START_BODY,
        config: { ...VALID_START_BODY.config, registryUrl: "http://client-override:4000" },
      });
      const envArr = h.docker._lastCreateOpts?.Env ?? [];
      expect(envArr).toContain("TELO_REGISTRY_URL=http://client-override:4000");
      expect(envArr).not.toContain("TELO_REGISTRY_URL=http://runner-default:3000");
    });

    it("body.env TELO_REGISTRY_URL wins over body.config.registryUrl and runner env", async () => {
      process.env.TELO_REGISTRY_URL = "http://runner-default:3000";
      h = await buildHarness();
      await startSession(h, {
        ...VALID_START_BODY,
        env: { ...VALID_START_BODY.env, TELO_REGISTRY_URL: "http://body-env:5000" },
        config: { ...VALID_START_BODY.config, registryUrl: "http://client-override:4000" },
      });
      const envArr = h.docker._lastCreateOpts?.Env ?? [];
      expect(envArr).toContain("TELO_REGISTRY_URL=http://body-env:5000");
      expect(envArr).not.toContain("TELO_REGISTRY_URL=http://client-override:4000");
      expect(envArr).not.toContain("TELO_REGISTRY_URL=http://runner-default:3000");
    });

    it("does not set TELO_REGISTRY_URL when no source provides one", async () => {
      h = await buildHarness();
      await startSession(h);
      const envArr = h.docker._lastCreateOpts?.Env ?? [];
      expect(envArr.some((e) => e.startsWith("TELO_REGISTRY_URL="))).toBe(false);
    });

    it("treats whitespace-only body.config.registryUrl as unset and falls back to runner env", async () => {
      process.env.TELO_REGISTRY_URL = "http://runner-default:3000";
      h = await buildHarness();
      await startSession(h, {
        ...VALID_START_BODY,
        config: { ...VALID_START_BODY.config, registryUrl: "   " },
      });
      expect(h.docker._lastCreateOpts?.Env ?? []).toContain("TELO_REGISTRY_URL=http://runner-default:3000");
    });

    it("trims body.config.registryUrl before forwarding", async () => {
      h = await buildHarness();
      await startSession(h, {
        ...VALID_START_BODY,
        config: { ...VALID_START_BODY.config, registryUrl: "  http://client:4000\n" },
      });
      expect(h.docker._lastCreateOpts?.Env ?? []).toContain("TELO_REGISTRY_URL=http://client:4000");
    });
  });

  it("returns 409 too_many_sessions when at capacity", async () => {
    h = await buildHarness({}, { maxSessions: 1 });
    // First session succeeds.
    const first = await h.app.inject({ method: "POST", url: "/v1/sessions", payload: VALID_START_BODY });
    expect(first.statusCode).toBe(201);
    // Second session should be rejected.
    const second = await h.app.inject({ method: "POST", url: "/v1/sessions", payload: VALID_START_BODY });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "too_many_sessions" });
  });

  // A start failure now surfaces as a terminal `failed` status on the stream,
  // not an HTTP error — the 201 is sent before backend.start() runs.
  async function expectFailedStatus(sessionId: string, stage: string): Promise<void> {
    await waitFor(() => h.registry.get(sessionId)?.status.kind === "failed", `failed:${stage}`);
    const status = h.registry.get(sessionId)?.status;
    expect(status?.kind).toBe("failed");
    if (status?.kind === "failed") expect(status.message).toContain(stage);
  }

  it("reports a failed status at stage `inspect` when pullPolicy=never and image is absent", async () => {
    h = await buildHarness({
      inspectImage: async () => {
        throw new Error("image not found");
      },
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { ...VALID_START_BODY, config: { image: "nope:latest", pullPolicy: "never" } },
    });
    expect(res.statusCode).toBe(201);
    await expectFailedStatus((res.json() as { sessionId: string }).sessionId, "inspect");
  });

  it("reports a failed status at stage `pull` when docker.pull rejects", async () => {
    h = await buildHarness({
      pull: async () => {
        throw new Error("registry unreachable");
      },
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { ...VALID_START_BODY, config: { image: "foo:bar", pullPolicy: "always" } },
    });
    expect(res.statusCode).toBe(201);
    await expectFailedStatus((res.json() as { sessionId: string }).sessionId, "pull");
  });

  it("reports a failed status at stage `create` when createContainer rejects", async () => {
    h = await buildHarness({
      createContainer: async () => {
        throw new Error("no such image");
      },
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: VALID_START_BODY,
    });
    expect(res.statusCode).toBe(201);
    await expectFailedStatus((res.json() as { sessionId: string }).sessionId, "create");
  });

  it("rejects invalid bundle paths with 400", async () => {
    h = await buildHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        ...VALID_START_BODY,
        bundle: {
          entryRelativePath: "telo.yaml",
          files: [{ relativePath: "../escape.yaml", contents: "x" }],
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_bundle" });
  });

  it("rejects malformed bodies with 400", async () => {
    h = await buildHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { bundle: {}, env: {}, config: {} },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/sessions/:id", () => {
  let h: TestHarness;
  afterEach(async () => {
    if (h) await teardownHarness(h);
  });

  it("returns session state for a live session", async () => {
    h = await buildHarness();
    const start = await h.app.inject({ method: "POST", url: "/v1/sessions", payload: VALID_START_BODY });
    const { sessionId } = start.json() as { sessionId: string };

    const res = await h.app.inject({ method: "GET", url: `/v1/sessions/${sessionId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessionId: string; status: { kind: string } };
    expect(body.sessionId).toBe(sessionId);
    expect(["starting", "running"]).toContain(body.status.kind);
  });

  it("returns 404 for an unknown session", async () => {
    h = await buildHarness();
    const res = await h.app.inject({ method: "GET", url: "/v1/sessions/unknown" });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /v1/sessions/:id", () => {
  let h: TestHarness;
  afterEach(async () => {
    if (h) await teardownHarness(h);
  });

  it("is idempotent for unknown ids", async () => {
    h = await buildHarness();
    const res = await h.app.inject({ method: "DELETE", url: "/v1/sessions/nope" });
    expect(res.statusCode).toBe(204);
  });

  it("marks userStopped and calls container.kill", async () => {
    h = await buildHarness();
    const start = await h.app.inject({ method: "POST", url: "/v1/sessions", payload: VALID_START_BODY });
    const { sessionId } = start.json() as { sessionId: string };

    const res = await h.app.inject({ method: "DELETE", url: `/v1/sessions/${sessionId}` });
    expect(res.statusCode).toBe(204);
    const entry = h.registry.get(sessionId);
    expect(entry?.userStopped).toBe(true);
  });

  it("kills the container when DELETE arrives during a pull (pre-start race)", async () => {
    // A pull that blocks until we release it simulates the window where
    // entry.container is still null but the user has already hit DELETE.
    let releasePull: (() => void) | null = null;
    const pullReady = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    let killCalls = 0;
    h = await buildHarness({
      pull: async () => {
        await pullReady;
        const { Readable } = await import("node:stream");
        return Readable.from([]);
      },
      createContainer: async () => {
        return {
          id: "fake",
          async attach() {
            const { Duplex, PassThrough } = await import("node:stream");
            return Duplex.from({
              readable: new PassThrough(),
              writable: new PassThrough(),
            });
          },
          async start() {},
          async kill() {
            killCalls += 1;
          },
          async wait() {
            return new Promise<{ StatusCode: number }>(() => {
              /* never resolves in this test */
            });
          },
          async remove() {},
          async resize() {},
        };
      },
    });

    // The route returns 201 immediately; backend.start() runs in the background
    // and is blocked on the pull.
    const startRes = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { ...VALID_START_BODY, config: { image: "x:y", pullPolicy: "always" } },
    });
    expect(startRes.statusCode).toBe(201);
    const sessionId = (startRes.json() as { sessionId: string }).sessionId;

    const deleteRes = await h.app.inject({
      method: "DELETE",
      url: `/v1/sessions/${sessionId}`,
    });
    expect(deleteRes.statusCode).toBe(204);
    expect(h.registry.get(sessionId)?.userStopped).toBe(true);

    // Now release the pull; the background start completes, and the race-fix
    // must kill the freshly-created container.
    releasePull!();
    await waitFor(() => killCalls >= 1, "container killed");
    expect(killCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("POST /v1/sessions entry path validation", () => {
  let h: TestHarness;
  afterEach(async () => {
    if (h) await teardownHarness(h);
  });

  it("rejects entryRelativePath containing ..", async () => {
    h = await buildHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        ...VALID_START_BODY,
        bundle: {
          entryRelativePath: "../../../etc/shadow",
          files: [{ relativePath: "telo.yaml", contents: "x" }],
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_bundle" });
  });
});

describe("POST /v1/sessions terms enforcement", () => {
  let h: TestHarness;

  beforeEach(() => {
    process.env.RUNNER_TERMS_VERSION = "2024-01";
    process.env.RUNNER_TERMS_TITLE = "Test terms";
    process.env.RUNNER_TERMS_BODY = "Be excellent to each other.";
  });

  afterEach(async () => {
    if (h) await teardownHarness(h);
    delete process.env.RUNNER_TERMS_VERSION;
    delete process.env.RUNNER_TERMS_TITLE;
    delete process.env.RUNNER_TERMS_BODY;
    delete process.env.RUNNER_TERMS_FILE;
  });

  it("rejects a session with 428 + the terms when unacknowledged", async () => {
    h = await buildHarness();
    const res = await h.app.inject({ method: "POST", url: "/v1/sessions", payload: VALID_START_BODY });
    expect(res.statusCode).toBe(428);
    expect(res.json()).toMatchObject({
      error: "terms_required",
      terms: { version: "2024-01", title: "Test terms" },
    });
  });

  it("rejects a stale accepted version", async () => {
    h = await buildHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-telo-accepted-terms": "old-version" },
      payload: VALID_START_BODY,
    });
    expect(res.statusCode).toBe(428);
  });

  it("starts when the accepted version matches", async () => {
    h = await buildHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-telo-accepted-terms": "2024-01" },
      payload: VALID_START_BODY,
    });
    expect(res.statusCode).toBe(201);
    await waitFor(() => h.docker._lastCreateOpts != null, "start settled");
  });

  it("defaults the version to a content hash when none is set, and enforces it", async () => {
    delete process.env.RUNNER_TERMS_VERSION;
    const expected = createHash("sha256")
      .update(process.env.RUNNER_TERMS_BODY!)
      .digest("hex")
      .slice(0, 12);
    h = await buildHarness();

    const rejected = await h.app.inject({ method: "POST", url: "/v1/sessions", payload: VALID_START_BODY });
    expect(rejected.statusCode).toBe(428);
    expect((rejected.json() as { terms: { version: string } }).terms.version).toBe(expected);

    const accepted = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "x-telo-accepted-terms": expected },
      payload: VALID_START_BODY,
    });
    expect(accepted.statusCode).toBe(201);
    await waitFor(() => h.docker._lastCreateOpts != null, "start settled");
  });

  it("reads the agreement body from RUNNER_TERMS_FILE", async () => {
    delete process.env.RUNNER_TERMS_VERSION;
    delete process.env.RUNNER_TERMS_BODY;
    const dir = await mkdtemp(join(tmpdir(), "docker-runner-terms-"));
    const file = join(dir, "terms.md");
    const body = "# Cloud agreement\n\nUse at your own risk.";
    await writeFile(file, body, "utf8");
    process.env.RUNNER_TERMS_FILE = file;
    try {
      h = await buildHarness();
      const res = await h.app.inject({ method: "POST", url: "/v1/sessions", payload: VALID_START_BODY });
      expect(res.statusCode).toBe(428);
      expect((res.json() as { terms: { body: string } }).terms.body).toBe(body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("running-status endpoints", () => {
  let h: TestHarness;
  afterEach(async () => {
    if (h) await teardownHarness(h);
  });

  async function runningStatus(h: TestHarness, ports: object[]) {
    const res = await startSession(h, { ...VALID_START_BODY, ports });
    const { sessionId } = res.json() as { sessionId: string };
    await waitFor(() => h.registry.get(sessionId)?.status.kind === "running", "running");
    const status = h.registry.get(sessionId)?.status;
    return { sessionId, status };
  }

  it("announces a routable url per tcp port when RUNNER_PUBLIC_BASE_URL is set", async () => {
    h = await buildHarness({}, { publicBaseUrl: "http://run.telo.localhost:8060" });
    const { sessionId, status } = await runningStatus(h, [{ port: 4444, protocol: "tcp" }]);
    expect(status).toEqual({
      kind: "running",
      endpoints: [
        {
          host: `${sessionId}.run.telo.localhost`,
          port: 4444,
          protocol: "tcp",
          url: `http://4444-${sessionId}.run.telo.localhost:8060`,
        },
      ],
    });
  });

  it("leaves endpoints host-less when no public base URL is configured", async () => {
    h = await buildHarness();
    const { status } = await runningStatus(h, [{ port: 4444, protocol: "tcp" }]);
    expect(status).toEqual({
      kind: "running",
      endpoints: [{ host: "", port: 4444, protocol: "tcp" }],
    });
  });

  it("does not route udp ports through the proxy", async () => {
    h = await buildHarness({}, { publicBaseUrl: "http://run.telo.localhost:8060" });
    const { status } = await runningStatus(h, [{ port: 5000, protocol: "udp" }]);
    expect(status).toEqual({
      kind: "running",
      endpoints: [{ host: "", port: 5000, protocol: "udp" }],
    });
  });
});

describe("host port publishing", () => {
  let h: TestHarness;
  afterEach(async () => {
    if (h) await teardownHarness(h);
  });

  it("skips host port bindings when a public base URL is configured", async () => {
    h = await buildHarness({}, { publicBaseUrl: "http://run.telo.localhost:8060" });
    await startSession(h, { ...VALID_START_BODY, ports: [{ port: 4444, protocol: "tcp" }] });
    const opts = h.docker._lastCreateOpts;
    expect(opts?.ExposedPorts).toEqual({ "4444/tcp": {} });
    expect(opts?.HostConfig.PortBindings).toBeUndefined();
  });

  it("publishes host port bindings when no public base URL is configured", async () => {
    h = await buildHarness();
    await startSession(h, { ...VALID_START_BODY, ports: [{ port: 4444, protocol: "tcp" }] });
    const opts = h.docker._lastCreateOpts;
    expect(opts?.ExposedPorts).toEqual({ "4444/tcp": {} });
    expect(opts?.HostConfig.PortBindings).toEqual({
      "4444/tcp": [{ HostIp: "", HostPort: "4444" }],
    });
  });
});

describe("inspection URL", () => {
  let h: TestHarness;
  afterEach(async () => {
    if (h) await teardownHarness(h);
  });

  async function running(payload: object) {
    const res = await startSession(h, payload);
    const { sessionId } = res.json() as { sessionId: string };
    await waitFor(() => h.registry.get(sessionId)?.status.kind === "running", "running");
    const status = h.registry.get(sessionId)?.status;
    if (status?.kind !== "running") throw new Error("expected running status");
    return { sessionId, status };
  }

  it("announces a proxy-routed inspect url when inspect + public base URL are set", async () => {
    h = await buildHarness({}, { publicBaseUrl: "http://run.telo.localhost:8060" });
    const { sessionId, status } = await running({ ...VALID_START_BODY, inspect: true });
    expect(status.inspectUrl).toBe(`http://9230-${sessionId}.run.telo.localhost:8060`);
  });

  it("omits the inspect url when inspect is not requested", async () => {
    h = await buildHarness({}, { publicBaseUrl: "http://run.telo.localhost:8060" });
    const { status } = await running(VALID_START_BODY);
    expect(status.inspectUrl).toBeUndefined();
  });

  it("omits the inspect url when no public base URL is configured", async () => {
    h = await buildHarness();
    const { status } = await running({ ...VALID_START_BODY, inspect: true });
    expect(status.inspectUrl).toBeUndefined();
  });
});

describe("POST /v1/apps/:name/sessions (predefined applications)", () => {
  const APP_BODY = { env: { CLIENT_VAR: "x", SERVICE_TOKEN: "tok-client" } };
  const CATALOG = '{"tool":{"image":"acme/tool:1","env":{"SERVICE_TOKEN":"tok-operator"}}}';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("404s an unknown app name (empty catalog)", async () => {
    vi.stubEnv("RUNNER_APPS", "");
    const h = await buildHarness();
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/apps/tool/sessions",
        payload: APP_BODY,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("unknown_app");
    } finally {
      await teardownHarness(h);
    }
  });

  it("launches the catalog image with operator env; client values for owned keys are dropped", async () => {
    vi.stubEnv("RUNNER_APPS", CATALOG);
    const h = await buildHarness();
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/apps/tool/sessions",
        payload: APP_BODY,
      });
      expect(res.statusCode).toBe(201);
      const { sessionId, streamUrl } = res.json() as { sessionId: string; streamUrl: string };
      // App sessions live in the shared session collection.
      expect(streamUrl).toBe(`/v1/sessions/${sessionId}/events`);
      await waitFor(
        () => h.docker._lastCreateOpts != null || h.registry.get(sessionId)?.status.kind === "failed",
        "start settled",
      );
      const opts = h.docker._lastCreateOpts!;
      expect(opts.Image).toBe("acme/tool:1");
      expect(opts.Env).toContain("SERVICE_TOKEN=tok-operator");
      expect(opts.Env).toContain("CLIENT_VAR=x");
      expect(opts.Env).not.toContain("SERVICE_TOKEN=tok-client");
    } finally {
      await teardownHarness(h);
    }
  });

  it("keeps bundle + config strictly required on POST /v1/sessions", async () => {
    const h = await buildHarness();
    try {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: { env: {} },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await teardownHarness(h);
    }
  });
});
