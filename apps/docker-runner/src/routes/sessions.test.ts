import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../server.js";
import { SessionRegistry } from "../session/registry.js";
import {
  makeFakeDocker,
  makeRunnerConfig,
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
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.streamUrl).toBe(`/v1/sessions/${body.sessionId}/events`);
    expect(body.createdAt).toEqual(expect.any(String));
    expect(h.registry.has(body.sessionId)).toBe(true);
  });

  it("writes bundle files to disk under bundleRoot/<sessionId>", async () => {
    h = await buildHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: VALID_START_BODY,
    });
    const { sessionId } = res.json() as { sessionId: string };
    const written = await readFile(join(h.bundleRoot, sessionId, "telo.yaml"), "utf8");
    expect(written).toBe("kind: Telo.Application\n");
  });

  it("names the container telo-run-<sessionId> and bind-mounts the bundle volume", async () => {
    h = await buildHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: VALID_START_BODY,
    });
    const { sessionId } = res.json() as { sessionId: string };
    const opts = h.docker._lastCreateOpts;
    expect(opts?.name).toBe(`telo-run-${sessionId}`);
    expect(opts?.HostConfig.Binds).toEqual(["telo_runner-bundles:/srv"]);
    expect(opts?.HostConfig.NetworkMode).toBe("telo_default");
    expect(opts?.HostConfig.AutoRemove).toBe(true);
    expect(opts?.WorkingDir).toBe(`/srv/${sessionId}`);
    expect(opts?.Cmd).toEqual(["./telo.yaml"]);
  });

  it("Env contains exactly FORCE_COLOR + CLICOLOR_FORCE + request env — no runner leak", async () => {
    // Seed runner process env with a noise var to prove it doesn't leak.
    process.env.RUNNER_SECRET_KEY = "should-not-leak";
    h = await buildHarness();
    await h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        ...VALID_START_BODY,
        env: { FOO: "bar", BAZ: "qux" },
      },
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

  it("returns 502 pull_failed / inspect when pullPolicy=never and image is absent", async () => {
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
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: "pull_failed",
      stage: "inspect",
    });
  });

  it("returns 502 pull_failed / pull when docker.pull rejects", async () => {
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
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: "pull_failed",
      stage: "pull",
    });
  });

  it("returns 503 start_failed / create when createContainer rejects", async () => {
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
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: "start_failed",
      stage: "create",
    });
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
            const { PassThrough } = await import("node:stream");
            return new PassThrough();
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
        };
      },
    });

    const startPromise = h.app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { ...VALID_START_BODY, config: { image: "x:y", pullPolicy: "always" } },
    });

    // Wait for the registry to see the (still-starting) session, then DELETE.
    await new Promise((r) => setTimeout(r, 20));
    const sessionIds = h.registry.list().map((e) => e.sessionId);
    expect(sessionIds).toHaveLength(1);
    const sessionId = sessionIds[0]!;

    const deleteRes = await h.app.inject({
      method: "DELETE",
      url: `/v1/sessions/${sessionId}`,
    });
    expect(deleteRes.statusCode).toBe(204);
    expect(h.registry.get(sessionId)?.userStopped).toBe(true);

    // Now release the pull; spawnSession completes, and the race-fix must kill
    // the freshly-created container.
    releasePull!();
    const startRes = await startPromise;
    expect(startRes.statusCode).toBe(201);
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
