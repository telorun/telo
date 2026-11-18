// The client engine against a fake relay speaking the tunnel's HTTP/2 as the
// client, forwarding to real HTTP servers on loopback.

import { randomBytes } from "node:crypto";
import http from "node:http";
import net, { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  startShareTunnel,
  type ShareTunnelEvent,
  type ShareTunnelOptions,
  type SharePort,
} from "../src/index.js";
import { FakeRelay } from "./support/fake-relay.js";
import { readProof, TestCredentialProvider, tokenHash } from "./support/test-credential-provider.js";

const RUNNER_URL = "https://runner.test";
const AUTHORITY = "8080-k3xqz2m7ahc4.telorun.dev";
const TIMINGS = { backoffInitialMs: 5, backoffMaxMs: 20, closeGraceMs: 100 };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function localServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { server, port: (server.address() as AddressInfo).port };
}

interface Started {
  relay: FakeRelay;
  provider: TestCredentialProvider;
  events: ShareTunnelEvent[];
  tunnel: ReturnType<typeof startShareTunnel>;
}

async function start(options: Partial<ShareTunnelOptions> & { provider?: TestCredentialProvider } = {}): Promise<Started> {
  const relay = await FakeRelay.start();
  cleanup.push(() => relay.close());
  const provider = options.provider ?? new TestCredentialProvider();
  const events: ShareTunnelEvent[] = [];
  const tunnel = startShareTunnel({
    tunnelUrl: relay.tunnelUrl,
    runnerUrl: RUNNER_URL,
    credentials: provider,
    onEvent: (event) => events.push(event),
    ...options,
    timings: { ...TIMINGS, ...options.timings },
  });
  cleanup.push(() => tunnel.close());
  return { relay, provider, events, tunnel };
}

/** Starts a tunnel announcing `ports` and completes its handshake. */
async function connected(ports: SharePort[], options: Partial<ShareTunnelOptions> & { provider?: TestCredentialProvider } = {}) {
  const started = await start({ ...options, ports });
  const connection = await started.relay.nextConnection();
  await connection.handshake(1);
  expect(await connection.nextControl()).toEqual({ type: "ports", ports });
  return { ...started, connection };
}

function visitor(port: number, headers: VisitorHeaders = {}): VisitorHeaders {
  return { ":authority": AUTHORITY, "telo-share-port": String(port), ...headers };
}
type VisitorHeaders = Record<string, string>;

function warnings(events: ShareTunnelEvent[], reason: string) {
  return events.filter((event) => event.type === "warning" && event.reason === reason);
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("forwarding", () => {
  it("forwards a visitor request to the local port and its answer back", async () => {
    const local = await localServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(201, { "content-type": "application/json", "x-local": "yes" });
        res.end(JSON.stringify({ method: req.method, url: req.url, body }));
      });
    });
    const { connection } = await connected([{ name: "http", port: local.port }]);

    const response = await connection.fetch(visitor(local.port, { ":method": "POST", ":path": "/hooks/github?x=1" }), "ping");

    expect(response.status).toBe(201);
    expect(response.headers["x-local"]).toBe("yes");
    expect(JSON.parse(response.body.toString())).toEqual({ method: "POST", url: "/hooks/github?x=1", body: "ping" });
  });

  it("hands the local server the visitor's Host and forwarded headers, without telo-share-port", async () => {
    const local = await localServer((req, res) => res.end(JSON.stringify(req.headers)));
    const { connection } = await connected([{ name: "http", port: local.port }]);

    const response = await connection.fetch(visitor(local.port, { "x-forwarded-for": "203.0.113.7" }));

    const seen = JSON.parse(response.body.toString()) as Record<string, string>;
    expect(seen.host).toBe(AUTHORITY);
    expect(seen["x-forwarded-for"]).toBe("203.0.113.7");
    expect(seen).not.toHaveProperty("telo-share-port");
  });

  it("streams a body many windows long both ways, in binary messages of at most 1 MiB", async () => {
    const local = await localServer((req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      req.pipe(res);
    });
    const { connection } = await connected([{ name: "http", port: local.port }]);
    const body = randomBytes(8 * 1024 * 1024);

    const response = await connection.fetch(visitor(local.port, { ":method": "PUT", ":path": "/blob" }), body);

    expect(response.status).toBe(200);
    expect(response.body.equals(body)).toBe(true);
    expect(connection.largestBinary).toBeLessThanOrEqual(1024 * 1024);
  });

  it("carries a visitor WebSocket through extended CONNECT to a local upgrade", async () => {
    const local = await localServer((req, res) => res.writeHead(404).end());
    const echo = new WebSocketServer({ server: local.server, handleProtocols: (offered) => (offered.has("chat") ? "chat" : false) });
    echo.on("connection", (ws) => ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary })));
    const { connection } = await connected([{ name: "http", port: local.port }]);

    const stream = connection.connect(
      visitor(local.port, { ":path": "/echo", "sec-websocket-version": "13", "sec-websocket-protocol": "chat" }),
    );
    const answer = await new Promise<Record<string, unknown>>((resolve) => stream.once("response", resolve));
    stream.write(maskedTextFrame("hello"));
    const frame = await readBytes(stream, 7);

    expect(answer[":status"]).toBe(200);
    expect(answer["sec-websocket-protocol"]).toBe("chat");
    expect(frame).toEqual(Buffer.from([0x81, 0x05, ...Buffer.from("hello")]));
    stream.close();
    echo.close();
  });

  it("answers 404 for a port the client did not announce, reaching nothing", async () => {
    let reached = 0;
    const announced = await localServer((req, res) => res.end("announced"));
    const other = await localServer((req, res) => {
      reached++;
      res.end("other");
    });
    const { connection } = await connected([{ name: "http", port: announced.port }]);

    const response = await connection.fetch(visitor(other.port));

    expect(response.status).toBe(404);
    expect(reached).toBe(0);
  });

  it("announces replaced ports on the open tunnel and routes them without reconnecting", async () => {
    const first = await localServer((req, res) => res.end("first"));
    const added = await localServer((req, res) => res.end("added"));
    const { tunnel, relay, connection } = await connected([{ name: "http", port: first.port }]);
    const ports = [
      { name: "http", port: first.port },
      { name: "metrics", port: added.port },
    ];

    tunnel.setPorts(ports);

    expect(await connection.nextControl()).toEqual({ type: "ports", ports });
    const response = await connection.fetch(visitor(added.port));
    expect(response.body.toString()).toBe("added");
    expect(relay.connections).toHaveLength(1);
  });
});

describe("local forwarding failures", () => {
  async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }
  const failures = (events: ShareTunnelEvent[]) => events.filter((event) => event.type === "forward-failed");

  it("keeps the visitor's 502 and reports the refused port's error, then that it answered again", async () => {
    const port = await freePort();
    const { connection, events } = await connected([{ name: "http", port }]);

    const response = await connection.fetch(visitor(port));

    expect(response.status).toBe(502);
    expect(response.body.toString()).toBe(`Nothing answered on port ${port} of the shared run.\n`);
    expect(failures(events)).toEqual([{ type: "forward-failed", port, message: expect.stringContaining("ECONNREFUSED") }]);

    const server = http.createServer((req, res) => res.end("up"));
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    expect((await connection.fetch(visitor(port))).status).toBe(200);
    expect(events).toContainEqual({ type: "forward-recovered", port });
  });

  it("reports the parse error of a port that does not speak HTTP", async () => {
    const server = net.createServer((socket) => socket.end("this is not http\r\n\r\n"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    server.on("connection", (socket) => cleanup.push(async () => void socket.destroy()));
    const { port } = server.address() as AddressInfo;
    const { connection, events } = await connected([{ name: "http", port }]);

    const response = await connection.fetch(visitor(port));

    expect(response.status).toBe(502);
    expect(failures(events)).toEqual([{ type: "forward-failed", port, message: expect.stringMatching(/parse|Parse/) }]);
  });
});

describe("credentials", () => {
  it("presents a fresh proof for the tunnel's https URL on every upgrade", async () => {
    const { relay } = await start();
    const first = await relay.nextConnection();
    await first.handshake(1);
    first.close(1001);
    const second = await relay.nextConnection();

    const proofs = [first, second].map((connection) => readProof(String(connection.request.headers.dpop)));
    const htu = relay.tunnelUrl.replace(/^ws:/, "http:");
    for (const [index, connection] of [first, second].entries()) {
      expect(connection.request.headers.authorization).toBe("DPoP token-1");
      expect(proofs[index]).toMatchObject({ signed: true, payload: { htm: "GET", htu, ath: tokenHash("token-1") } });
    }
    expect(proofs[0]!.payload.jti).not.toBe(proofs[1]!.payload.jti);
  });

  it("sends auth with a renewed token well before the presented one expires", async () => {
    const provider = new TestCredentialProvider(1_500);
    const { relay, events, connection } = await connected([], {
      provider,
      timings: { reauthLeadMs: 600, credentialMinLifetimeMs: 900 },
    });

    const auth = await connection.nextControl();
    const receivedAt = Date.now();

    expect(auth).toMatchObject({ type: "auth", accessToken: "token-2" });
    expect(provider.issued[0]!.expiresAt.getTime() - receivedAt).toBeGreaterThanOrEqual(400);
    expect(readProof(String(auth.proof))).toMatchObject({
      signed: true,
      payload: { htm: "GET", htu: relay.tunnelUrl.replace(/^ws:/, "http:"), ath: tokenHash("token-2") },
    });
    expect(events).toContainEqual({ type: "renewed", afterWarning: false });
    expect(relay.connections).toHaveLength(1);
  });

  it("warns once while sign-in is required mid-run and renews once a credential returns", async () => {
    const provider = new TestCredentialProvider(1_500);
    const { relay, events, connection } = await connected([], {
      provider,
      timings: { reauthLeadMs: 600, credentialMinLifetimeMs: 900 },
    });
    provider.mode = "sign-in-required";

    await waitFor(() => warnings(events, "sign-in-required").length > 0);
    await waitFor(() => provider.requests.length >= 5);
    provider.mode = "credential";
    const auth = await connection.nextControl();

    expect(auth).toMatchObject({ type: "auth", accessToken: "token-2" });
    expect(warnings(events, "sign-in-required")).toEqual([
      { type: "warning", reason: "sign-in-required", detail: "", command: `telo auth login --runner ${RUNNER_URL}` },
    ]);
    expect(events.at(-1)).toEqual({ type: "renewed", afterWarning: true });
    expect(relay.connections).toHaveLength(1);
  });

  it("warns once while the credential is unavailable and connects when it is", async () => {
    const provider = new TestCredentialProvider();
    provider.mode = "unavailable";
    const { relay, events } = await start({ provider });
    await waitFor(() => provider.requests.length >= 5);
    provider.mode = "credential";

    const connection = await relay.nextConnection();
    await connection.handshake(1);
    await waitFor(() => events.some((event) => event.type === "connected"));

    expect(warnings(events, "credential-unavailable")).toEqual([
      { type: "warning", reason: "credential-unavailable", detail: "the token endpoint answered 503" },
    ]);
    expect(events.at(-1)).toEqual({ type: "connected", epoch: 1, reconnect: false, afterWarning: true });
  });
});

describe("renewal timer", () => {
  it("does not spin on a token that outlives the timer limit", async () => {
    const provider = new TestCredentialProvider(40 * 24 * 60 * 60_000);
    const { connection } = await connected([], { provider });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(provider.requests).toHaveLength(1);
    expect(connection.ws.readyState).toBe(1);
  });
});

describe("liveness", () => {
  it("stays open while the relay pings, and closes 4408 and reconnects after silence", async () => {
    const { relay, events, connection } = await connected([], { timings: { silenceMs: 300 } });

    const pinger = setInterval(() => connection.ws.ping(), 100);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    clearInterval(pinger);
    expect(relay.connections).toHaveLength(1);

    expect(await connection.closed).toMatchObject({ code: 4408 });
    await relay.nextConnection();
    expect(warnings(events, "timed-out")).toHaveLength(1);
  });

  it("closes cleanly with 1000 and ends as closed", async () => {
    const { tunnel, connection } = await connected([]);

    await tunnel.close();

    expect(await connection.closed).toMatchObject({ code: 1000 });
    await expect(tunnel.ended).resolves.toEqual({ outcome: "closed" });
  });
});

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!));
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

async function readBytes(stream: NodeJS.ReadableStream, count: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    length += (chunk as Buffer).length;
    if (length >= count) break;
  }
  return Buffer.concat(chunks).subarray(0, count);
}
