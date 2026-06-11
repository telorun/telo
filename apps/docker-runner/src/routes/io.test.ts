import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { buildServer } from "../server.js";
import type { SessionRegistry } from "@telorun/runner-core";
import type { FakeDocker } from "../test-helpers.js";
import { makeFakeDocker, makeRunnerConfig, waitFor } from "../test-helpers.js";

interface IoHarness {
  app: FastifyInstance;
  registry: SessionRegistry;
  docker: FakeDocker;
  bundleRoot: string;
  port: number;
  baseUrl: string;
  sessionId: string;
  containerName: string;
}

const ALLOWED_ORIGIN = "https://test.local";

/** Helper: deterministic Origin header for the WS client. The runner's
 *  default cors=`*` allows any origin (or none); explicit-allowlist tests
 *  set `corsOrigins: [ALLOWED_ORIGIN]` and the client sends the header. */
function wsHeaders(): { origin: string } {
  return { origin: ALLOWED_ORIGIN };
}

async function buildIoHarness(opts: { corsOrigins?: string[] | "*" } = {}): Promise<IoHarness> {
  const bundleRoot = await mkdtemp(join(tmpdir(), "docker-runner-io-"));
  const runnerConfig = makeRunnerConfig({
    bundleRoot,
    replayBufferBytes: 10_000,
    corsOrigins: opts.corsOrigins ?? "*",
  });
  const docker = makeFakeDocker({});
  const { app, registry } = await buildServer({ docker, runnerConfig });
  await app.ready();
  // Bind ephemeral port — `app.inject()` does not support WS upgrades, so
  // the WS routes must be tested through a real socket.
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected fastify to bind a TCP socket");
  }
  const port = address.port;

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
  // The route returns 201 before backend.start() runs; wait for the background
  // start to set entry.session so a test that overwrites it with a mock (resize
  // tests) isn't clobbered when the real start later resolves.
  await waitFor(() => registry.get(sessionId)?.session != null, "session started");

  return {
    app,
    registry,
    docker,
    bundleRoot,
    port,
    baseUrl: `ws://127.0.0.1:${port}`,
    sessionId,
    containerName: `telo-run-${sessionId}`,
  };
}

async function teardown(h: IoHarness): Promise<void> {
  await h.app.close();
  await rm(h.bundleRoot, { recursive: true, force: true });
}

const SEQ_PREFIX_BYTES = 4;

interface DecodedFrame {
  seq: number;
  payload: Buffer;
}

function decodeFrame(buf: Buffer): DecodedFrame {
  if (buf.byteLength < SEQ_PREFIX_BYTES) {
    throw new Error(`binary frame too short for seq prefix: ${buf.byteLength}`);
  }
  return {
    seq: buf.readUInt32BE(0),
    payload: buf.subarray(SEQ_PREFIX_BYTES),
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("close", (code) => reject(new Error(`closed before open: ${code}`)));
  });
}

/** A live message collector that MUST be created synchronously after
 *  `new WebSocket(...)` so no frames are dropped between connect and the
 *  first listener attaching. */
function startCollector(ws: WebSocket): {
  binary: Buffer[];
  text: string[];
  waitForBinary(count: number, timeoutMs?: number): Promise<Buffer[]>;
} {
  const binary: Buffer[] = [];
  const text: string[] = [];
  const waiters: Array<{
    count: number;
    resolve: (buffers: Buffer[]) => void;
    reject: (err: Error) => void;
  }> = [];

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof Buffer
          ? data
          : Buffer.from(data as ArrayBuffer);
      binary.push(buf);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (binary.length >= waiters[i]!.count) {
          waiters[i]!.resolve(binary.slice(0, waiters[i]!.count));
          waiters.splice(i, 1);
        }
      }
    } else {
      text.push(String(data));
    }
  });

  return {
    binary,
    text,
    waitForBinary(count, timeoutMs = 2000) {
      if (binary.length >= count) return Promise.resolve(binary.slice(0, count));
      return new Promise<Buffer[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${count} binary frames; got ${binary.length}`));
        }, timeoutMs);
        waiters.push({
          count,
          resolve: (buffers) => {
            clearTimeout(timer);
            resolve(buffers);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      });
    },
  };
}

function waitForClose(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    ws.once("close", (code) => resolve({ code }));
  });
}

describe("WebSocket /v1/sessions/:id/io", () => {
  let h: IoHarness;
  afterEach(async () => {
    if (h) await teardown(h);
  });

  it("replays buffered bytes and streams live ones with seq-prefixed frames", async () => {
    h = await buildIoHarness();
    // Push some bytes into the buffer before any client attaches.
    h.registry.pushBytes(h.sessionId, Buffer.from("hello ")); // seq 1
    h.registry.pushBytes(h.sessionId, Buffer.from("world\r\n")); // seq 2

    const ws = new WebSocket(`${h.baseUrl}/v1/sessions/${h.sessionId}/io`, {
      headers: wsHeaders(),
    });
    const collector = startCollector(ws);
    await waitForOpen(ws);

    const chunks = await collector.waitForBinary(2);
    const frames = chunks.map(decodeFrame);
    expect(frames.map((f) => f.seq)).toEqual([1, 2]);
    expect(Buffer.concat(frames.map((f) => f.payload)).toString()).toBe("hello world\r\n");

    // Live: push another chunk after the client is attached.
    h.registry.pushBytes(h.sessionId, Buffer.from("more"));
    const live = await collector.waitForBinary(3);
    const liveFrames = live.map(decodeFrame);
    expect(liveFrames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(Buffer.concat(liveFrames.map((f) => f.payload)).toString()).toBe("hello world\r\nmore");

    ws.close();
  });

  it("respects ?lastSeq and skips already-seen bytes", async () => {
    h = await buildIoHarness();
    h.registry.pushBytes(h.sessionId, Buffer.from("a")); // seq 1
    h.registry.pushBytes(h.sessionId, Buffer.from("b")); // seq 2
    h.registry.pushBytes(h.sessionId, Buffer.from("c")); // seq 3

    const ws = new WebSocket(`${h.baseUrl}/v1/sessions/${h.sessionId}/io?lastSeq=2`, {
      headers: wsHeaders(),
    });
    const collector = startCollector(ws);
    await waitForOpen(ws);
    const bytes = await collector.waitForBinary(1);
    const frame = decodeFrame(bytes[0]!);
    expect(frame.seq).toBe(3);
    expect(frame.payload.toString()).toBe("c");
    ws.close();
  });

  it("delivers bytes pushed during the subscribe-replay window with no gaps", async () => {
    h = await buildIoHarness();
    h.registry.pushBytes(h.sessionId, Buffer.from("a")); // seq 1
    h.registry.pushBytes(h.sessionId, Buffer.from("b")); // seq 2

    // Open the WS; the registry's emit is synchronous, so we can race a
    // pushBytes onto the same event-loop tick the handler is in by issuing
    // it before the message-collector tick consumes the replay frames.
    const ws = new WebSocket(`${h.baseUrl}/v1/sessions/${h.sessionId}/io`, {
      headers: wsHeaders(),
    });
    const collector = startCollector(ws);
    await waitForOpen(ws);

    // This push could land in the handler's deferred queue (subscribed
    // before snapshot) or after the queue drain (subscribe-direct mode);
    // either way the client must see the seq=3 frame exactly once.
    h.registry.pushBytes(h.sessionId, Buffer.from("c"));

    const bytes = await collector.waitForBinary(3);
    const frames = bytes.map(decodeFrame);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(Buffer.concat(frames.map((f) => f.payload)).toString()).toBe("abc");
    ws.close();
  });

  it("closes 4404 when the session id is unknown", async () => {
    h = await buildIoHarness();
    const ws = new WebSocket(`${h.baseUrl}/v1/sessions/nope/io`, {
      headers: wsHeaders(),
    });
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(4404);
  });

  it("closes WS with code 4403 when origin is not allowlisted", async () => {
    // Note: the Origin allowlist runs INSIDE the handler (not preValidation)
    // so browsers — which can't see HTTP status codes from a failed upgrade —
    // get a readable application close code (4403) instead of the generic
    // 1006 that would trigger reconnect storms.
    h = await buildIoHarness({ corsOrigins: ["https://allowed.example"] });
    const ws = new WebSocket(`${h.baseUrl}/v1/sessions/${h.sessionId}/io`, {
      headers: { origin: "https://evil.example" },
    });
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(4403);
  });

  it("closes WS with code 4403 when Origin is missing under explicit allowlist", async () => {
    // Browsers always send Origin on WS handshakes — a missing Origin
    // means the request is from a non-browser caller. With cors=*,
    // missing Origin is fine. With an explicit allowlist, missing Origin
    // is a rejection: the runner cannot tell a legitimate non-browser
    // client from one trying to bypass the same-origin check by stripping
    // the header. Tests for non-browser-host scenarios should set Origin
    // explicitly (what `wsHeaders()` does above).
    h = await buildIoHarness({ corsOrigins: ["https://allowed.example"] });
    const ws = new WebSocket(`${h.baseUrl}/v1/sessions/${h.sessionId}/io`);
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(4403);
  });

  it("accepts WS upgrade when Origin is on the allowlist", async () => {
    h = await buildIoHarness({ corsOrigins: ["https://allowed.example"] });
    const ws = new WebSocket(`${h.baseUrl}/v1/sessions/${h.sessionId}/io`, {
      headers: { origin: "https://allowed.example" },
    });
    await waitForOpen(ws);
    ws.close();
  });

  it("forwards binary frames into the session stdin", async () => {
    h = await buildIoHarness();
    // Wire a fake BackendSession on the entry directly so we can observe writes.
    const writes: Buffer[] = [];
    const entry = h.registry.get(h.sessionId);
    expect(entry).toBeDefined();
    entry!.session = {
      writeStdin(bytes: Uint8Array) {
        writes.push(Buffer.from(bytes));
      },
      resize() {},
      done: Promise.resolve(),
      async stop() {},
    };

    const ws = new WebSocket(`${h.baseUrl}/v1/sessions/${h.sessionId}/io`, {
      headers: wsHeaders(),
    });
    await waitForOpen(ws);
    ws.send(Buffer.from("ls -la\n"));
    // Give the event loop a tick to deliver the message.
    await new Promise((r) => setTimeout(r, 30));
    expect(Buffer.concat(writes).toString()).toBe("ls -la\n");
    ws.close();
  });

  it("closes the WS with code 1000 after the session reaches terminal status", async () => {
    h = await buildIoHarness();
    const ws = new WebSocket(`${h.baseUrl}/v1/sessions/${h.sessionId}/io`, {
      headers: wsHeaders(),
    });
    await waitForOpen(ws);
    const closedPromise = waitForClose(ws);

    // Drive the session to terminal status. The WS handler subscribes to
    // status events and should close with 1000 once it observes the
    // transition (after draining any pending bufferedAmount).
    h.registry.emit(h.sessionId, { type: "status", status: { kind: "exited", code: 0 } });

    const closed = await closedPromise;
    expect(closed.code).toBe(1000);
  });

  it("closes the WS after replay when connecting to an already-terminal session", async () => {
    // Late-connect race: session reaches terminal status BEFORE the client
    // attaches, but still has replayable bytes in the byte buffer (so the
    // 4410 fast path doesn't apply). Without the post-replay isTerminal
    // check the socket would never receive a status event and would stay
    // open indefinitely after the replay flushes.
    h = await buildIoHarness();
    h.registry.pushBytes(h.sessionId, Buffer.from("startup output\r\n"));
    h.registry.emit(h.sessionId, { type: "status", status: { kind: "exited", code: 0 } });

    const ws = new WebSocket(`${h.baseUrl}/v1/sessions/${h.sessionId}/io`, {
      headers: wsHeaders(),
    });
    const collector = startCollector(ws);
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(1000);
    const frames = collector.binary.map(decodeFrame);
    expect(frames.map((f) => f.payload.toString())).toEqual(["startup output\r\n"]);
  });

  it("flushes pending live bytes before closing on terminal status", async () => {
    // Mirrors the chat-console.yaml shape: prompt printed, then process
    // exits ~270ms later. Without bufferedAmount-aware close, the prompt
    // would be lost. We can't directly observe `bufferedAmount` from the
    // client, but we CAN assert the bytes arrive before the close frame.
    h = await buildIoHarness();
    const ws = new WebSocket(`${h.baseUrl}/v1/sessions/${h.sessionId}/io`, {
      headers: wsHeaders(),
    });
    const collector = startCollector(ws);
    await waitForOpen(ws);

    h.registry.pushBytes(h.sessionId, Buffer.from("you › "));
    h.registry.emit(h.sessionId, { type: "status", status: { kind: "exited", code: 0 } });

    const closed = await waitForClose(ws);
    expect(closed.code).toBe(1000);
    const frames = collector.binary.map(decodeFrame);
    expect(frames.map((f) => f.payload.toString())).toEqual(["you › "]);
  });

  it("forwards resize control frames to session.resize after debounce", async () => {
    h = await buildIoHarness();
    const entry = h.registry.get(h.sessionId);
    expect(entry).toBeDefined();
    let called: { cols: number; rows: number } | null = null;
    entry!.session = {
      writeStdin() {},
      resize(cols, rows) {
        called = { cols, rows };
      },
      done: Promise.resolve(),
      async stop() {},
    };

    const ws = new WebSocket(`${h.baseUrl}/v1/sessions/${h.sessionId}/io`, {
      headers: wsHeaders(),
    });
    await waitForOpen(ws);
    // Send several resize frames in quick succession; only the last should reach the backend.
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await new Promise((r) => setTimeout(r, 120));
    expect(called).toEqual({ cols: 120, rows: 40 });
    ws.close();
  });

  it("clamps absurd resize values and rejects NaN", async () => {
    h = await buildIoHarness();
    const entry = h.registry.get(h.sessionId);
    let called: { cols: number; rows: number } | null = null;
    entry!.session = {
      writeStdin() {},
      resize(cols, rows) {
        called = { cols, rows };
      },
      done: Promise.resolve(),
      async stop() {},
    };
    const ws = new WebSocket(`${h.baseUrl}/v1/sessions/${h.sessionId}/io`, {
      headers: wsHeaders(),
    });
    await waitForOpen(ws);

    // Garbage rejected: no resize call.
    ws.send(JSON.stringify({ type: "resize", cols: "abc", rows: NaN }));
    await new Promise((r) => setTimeout(r, 80));
    expect(called).toBeNull();

    // Absurd values clamped to the upper bound (10_000).
    ws.send(JSON.stringify({ type: "resize", cols: Number.MAX_SAFE_INTEGER, rows: 99_999 }));
    await new Promise((r) => setTimeout(r, 80));
    expect(called).toEqual({ cols: 10_000, rows: 10_000 });
    ws.close();
  });
});
