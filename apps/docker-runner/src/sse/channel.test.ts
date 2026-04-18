import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../server.js";
import type { SessionRegistry } from "../session/registry.js";
import type { RunEvent } from "../types.js";
import { makeFakeDocker, makeRunnerConfig } from "../test-helpers.js";

interface StreamHarness {
  app: FastifyInstance;
  registry: SessionRegistry;
  bundleRoot: string;
  sessionId: string;
  containerName: string;
}

async function buildStreamHarness(): Promise<StreamHarness> {
  const bundleRoot = await mkdtemp(join(tmpdir(), "docker-runner-sse-"));
  const runnerConfig = makeRunnerConfig({ bundleRoot, replayBufferBytes: 10_000 });
  const docker = makeFakeDocker({});
  const { app, registry } = await buildServer({ docker, runnerConfig });
  await app.ready();

  const startRes = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    payload: {
      bundle: {
        entryRelativePath: "telo.yaml",
        files: [{ relativePath: "telo.yaml", contents: "x" }],
      },
      env: {},
      config: { image: "telorun/telo:nodejs", pullPolicy: "missing" },
    },
  });
  const { sessionId } = startRes.json() as { sessionId: string };
  return { app, registry, bundleRoot, sessionId, containerName: `telo-run-${sessionId}` };
}

async function teardown(h: StreamHarness): Promise<void> {
  await h.app.close();
  await rm(h.bundleRoot, { recursive: true, force: true });
}

function parseSseFrames(body: string): Array<{ id?: number; event?: string; data?: unknown }> {
  return body
    .split("\n\n")
    .filter((s) => s.trim() !== "")
    .map((frame) => {
      const out: { id?: number; event?: string; data?: unknown } = {};
      for (const line of frame.split("\n")) {
        if (line.startsWith("id: ")) out.id = Number(line.slice(4));
        else if (line.startsWith("event: ")) out.event = line.slice(7);
        else if (line.startsWith("data: ")) out.data = JSON.parse(line.slice(6));
      }
      return out;
    });
}

describe("GET /v1/sessions/:id/events", () => {
  let h: StreamHarness;

  beforeEach(async () => {
    h = await buildStreamHarness();
  });

  afterEach(async () => {
    await teardown(h);
  });

  it("replays buffered events and closes after terminal status", async () => {
    const push = (event: RunEvent): void => {
      h.registry.emit(h.sessionId, event);
    };
    push({ type: "stdout", chunk: "hello\n" });
    push({ type: "stdout", chunk: "world\n" });
    push({ type: "status", status: { kind: "exited", code: 0 } });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/sessions/${h.sessionId}/events`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const frames = parseSseFrames(res.payload);
    expect(frames).toHaveLength(5); // 2 initial starting/running + our 3 events
    expect(frames[frames.length - 1]).toMatchObject({
      event: "status",
      data: { type: "status", status: { kind: "exited", code: 0 } },
    });
  });

  it("respects Last-Event-ID header for replay", async () => {
    h.registry.emit(h.sessionId, { type: "stdout", chunk: "a" });
    h.registry.emit(h.sessionId, { type: "stdout", chunk: "b" });
    h.registry.emit(h.sessionId, { type: "status", status: { kind: "exited", code: 0 } });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/sessions/${h.sessionId}/events`,
      headers: { "last-event-id": "3" }, // skip starting(1), running(2), stdout "a"(3)
    });

    const frames = parseSseFrames(res.payload);
    // Should only contain stdout "b" (id=4) and the terminal status (id=5)
    expect(frames.map((f) => f.id)).toEqual([4, 5]);
  });

  it("respects ?lastEventId= query param when no header is present", async () => {
    h.registry.emit(h.sessionId, { type: "stdout", chunk: "a" });
    h.registry.emit(h.sessionId, { type: "status", status: { kind: "exited", code: 0 } });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/sessions/${h.sessionId}/events?lastEventId=2`,
    });

    const frames = parseSseFrames(res.payload);
    // Skip starting(1), running(2) — stdout "a" is id 3, exit is id 4.
    expect(frames.map((f) => f.id)).toEqual([3, 4]);
  });

  it("returns 404 for unknown session", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/sessions/nope/events",
    });
    expect(res.statusCode).toBe(404);
  });
});
