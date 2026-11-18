// The relay end to end: the real client engine (`@telorun/share-tunnel`) holding
// a tunnel to it, forwarding to HTTP servers on loopback, with ES256 DPoP
// credentials verified through the runner's identity verifier.

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";

import {
  startShareTunnel,
  TUNNEL_SUBPROTOCOL,
  tunnelProofUrl,
  type ShareTunnel,
  type ShareTunnelEvent,
  type SharePort,
} from "@telorun/share-tunnel";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { randomBase32 } from "../session/session-id.js";
import { PostgresSessionStore } from "../session-store/postgres-session-store.js";
import type { SessionStore } from "../session-store/session-store.js";
import { shareConnected, type ShareStore } from "../session-store/share-store.js";
import { buildRelayServer } from "./relay-server.js";
import {
  bootTestServer,
  FakeWorkloadBackend,
  temporaryStore,
  TEST_SHARE_ROUTING,
  testConfig,
} from "../test-support/fake-workload-backend.js";
import { MemoryShareStore, withShares } from "../test-support/memory-share-store.js";
import {
  countingShareStore,
  startRelay,
  TunnelDriver,
  visit,
  type RelayOptions,
  type RelayUnderTest,
} from "../test-support/share-relay-harness.js";
import {
  TEST_AUDIENCE,
  TEST_IDENTITY,
  TEST_ISSUER,
  TestIssuer,
  type TestUser,
} from "../test-support/test-identity.js";

const CLIENT_TIMINGS = { backoffInitialMs: 5, backoffMaxMs: 50, closeGraceMs: 100 };

let issuer: TestIssuer;
let jti: Awaited<ReturnType<typeof temporaryStore>>;
beforeAll(async () => {
  issuer = await TestIssuer.create();
  jti = await temporaryStore();
});
afterAll(async () => {
  await jti.dispose();
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function relayOver(shares: ShareStore, options: Partial<RelayOptions> = {}): Promise<RelayUnderTest> {
  const relay = await startRelay({ issuer, shares, jti: jti.store, ...options });
  let closed = false;
  cleanup.push(async () => {
    if (!closed) await relay.close();
  });
  return {
    ...relay,
    close: async () => {
      closed = true;
      await relay.close();
    },
  };
}

async function shareOf(shares: ShareStore, user: TestUser): Promise<string> {
  const created = await shares.createShare({
    owner: { kind: "identity", iss: TEST_ISSUER, sub: user.sub },
    name: randomBase32(12),
    application: "Demo",
    now: new Date(),
    maxPerOwner: 100,
  });
  if (created.kind !== "created") throw new Error(`no share: ${created.kind}`);
  return created.share.id;
}

async function localServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { server, port: (server.address() as AddressInfo).port };
}

interface Run {
  tunnel: ShareTunnel;
  events: ShareTunnelEvent[];
  connected(count?: number): Promise<void>;
}

/** A `telo run --share` of `shareId`, announcing `ports`. */
function run(relay: RelayUnderTest, shareId: string, user: TestUser, ports: SharePort[]): Run {
  const events: ShareTunnelEvent[] = [];
  const tunnel = startShareTunnel({
    tunnelUrl: relay.tunnelUrl(shareId),
    runnerUrl: TEST_AUDIENCE,
    credentials: user,
    ports,
    onEvent: (event) => events.push(event),
    timings: CLIENT_TIMINGS,
  });
  cleanup.push(() => tunnel.close());
  return {
    tunnel,
    events,
    connected: (count = 1) => waitFor(() => events.filter((e) => e.type === "connected").length >= count),
  };
}

/** Waits until `host` is answered from a live tunnel. */
async function served(relay: RelayUnderTest, host: string): Promise<void> {
  await waitFor(async () => {
    const response = await visit(relay.port, host, { path: "/__served" });
    return response.body.toString() !== "This share is not connected.";
  });
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function warnings(events: ShareTunnelEvent[], reason: string): ShareTunnelEvent[] {
  return events.filter((event) => event.type === "warning" && event.reason === reason);
}

/** A raw tunnel for `user`, its upgrade proof naming `htu` (the tunnel's by default). */
async function rawTunnel(relay: RelayUnderTest, shareId: string, user: TestUser, htu?: string) {
  const url = relay.tunnelUrl(shareId);
  const { accessToken } = await user.token();
  const headers = {
    authorization: `DPoP ${accessToken}`,
    dpop: await user.proof(accessToken, { htm: "GET", htu: htu ?? tunnelProofUrl(url) }),
  };
  return { driver: await TunnelDriver.open(url, headers), headers, url };
}

async function handshake(driver: TunnelDriver, epoch: number | null = null): Promise<void> {
  driver.send({ type: "hello", epoch });
  const answer = await driver.next();
  expect(answer.kind).toBe("text");
}

describe("visitors", () => {
  it("reach the local port with their Host and X-Forwarded-*, the visitor's telo-share-port overwritten", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares);
    const user = await issuer.user("alice");
    const shareId = await shareOf(shares, user);
    const seen: http.IncomingHttpHeaders[] = [];
    const local = await localServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(201, { "x-local": "yes" }).end(`${req.method} ${req.url}`);
    });
    run(relay, shareId, user, [{ name: "http", port: local.port }]);
    const host = relay.visitorHost(shareId, local.port);
    await served(relay, host);
    seen.length = 0;

    const response = await visit(relay.port, host, {
      method: "PUT",
      path: "/hooks/github?x=1",
      headers: {
        "x-forwarded-for": "203.0.113.7",
        "x-forwarded-proto": "https",
        "x-forwarded-host": host,
        "telo-share-port": "1",
      },
    });

    expect(response.status).toBe(201);
    expect(response.headers["x-local"]).toBe("yes");
    expect(response.body.toString()).toBe("PUT /hooks/github?x=1");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      host,
      "x-forwarded-for": "203.0.113.7",
      "x-forwarded-proto": "https",
      "x-forwarded-host": host,
    });
    expect(seen[0]!["telo-share-port"]).toBeUndefined();
  });

  it("stream a large body both ways", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares, { settings: { maxBytesPerSecond: 1 << 30 } });
    const user = await issuer.user("alice");
    const shareId = await shareOf(shares, user);
    // Many 64 KiB flow-control windows and more than one 1 MiB binary message in each direction.
    const upload = randomBytes(4 * 1024 * 1024);
    const local = await localServer((req, res) => {
      const hash = createHash("sha256");
      req.on("data", (chunk: Buffer) => hash.update(chunk));
      req.on("end", () => {
        res.writeHead(200, { "x-upload-sha256": hash.digest("hex") });
        res.end(upload);
      });
    });
    run(relay, shareId, user, [{ name: "http", port: local.port }]);
    const host = relay.visitorHost(shareId, local.port);
    await served(relay, host);

    const response = await visit(relay.port, host, { method: "POST", body: upload });

    const digest = createHash("sha256").update(upload).digest("hex");
    expect(response.status).toBe(200);
    expect(response.headers["x-upload-sha256"]).toBe(digest);
    expect(createHash("sha256").update(response.body).digest("hex")).toBe(digest);
  }, 30_000);

  it("open a WebSocket to the local port and echo through it", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares);
    const user = await issuer.user("alice");
    const shareId = await shareOf(shares, user);
    const local = await localServer((req, res) => res.writeHead(404).end());
    const wss = new WebSocketServer({ server: local.server, handleProtocols: () => "chat" });
    wss.on("connection", (ws) => ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary })));
    run(relay, shareId, user, [{ name: "http", port: local.port }]);
    const host = relay.visitorHost(shareId, local.port);
    await served(relay, host);

    const visitor = new WebSocket(`ws://127.0.0.1:${relay.port}/echo`, ["chat"], { headers: { host } });
    await new Promise<void>((resolve, reject) => {
      visitor.once("open", () => resolve());
      visitor.once("error", reject);
    });
    const echoed = new Promise<string>((resolve) => visitor.once("message", (data) => resolve(String(data))));
    visitor.send("hello through the share");

    expect(visitor.protocol).toBe("chat");
    expect(await echoed).toBe("hello through the share");
    visitor.close();
  });

  it("get 404 for a host that does not parse or a port not announced, and 503 for a share with no tunnel", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares);
    const user = await issuer.user("alice");
    const shareId = await shareOf(shares, user);
    const local = await localServer((req, res) => res.end("ok"));
    run(relay, shareId, user, [{ name: "http", port: local.port }]);
    await served(relay, relay.visitorHost(shareId, local.port));

    const unparsed = await visit(relay.port, "www.share.test");
    const unannounced = await visit(relay.port, relay.visitorHost(shareId, 1));
    const disconnected = await visit(relay.port, relay.visitorHost(randomBase32(12), 8080));

    expect(unparsed.status).toBe(404);
    expect(unannounced.status).toBe(404);
    expect(disconnected).toMatchObject({ status: 503, headers: { "retry-after": "5", "content-type": "text/plain" } });
    expect(disconnected.body.toString()).toBe("This share is not connected.");
  });

  it("get 502 when nothing answers on the local port, and 504 when it answers too late", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares, { timings: { responseTimeoutMs: 300 } });
    const user = await issuer.user("alice");
    const shareId = await shareOf(shares, user);
    const slow = await localServer(() => undefined);
    const refusing = await localServer(() => undefined);
    await new Promise<void>((resolve) => refusing.server.close(() => resolve()));
    run(relay, shareId, user, [
      { name: "slow", port: slow.port },
      { name: "refusing", port: refusing.port },
    ]);
    await waitFor(async () => (await visit(relay.port, relay.visitorHost(shareId, refusing.port))).status === 502);

    const timedOut = await visit(relay.port, relay.visitorHost(shareId, slow.port));

    expect(timedOut.status).toBe(504);
  });

  it("are refused 503 busy beyond the concurrent request limit while the others complete", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares);
    const user = await issuer.user("alice");
    const shareId = await shareOf(shares, user);
    const held: http.ServerResponse[] = [];
    const local = await localServer((req, res) => {
      if (req.url === "/__served") res.end("ok");
      else held.push(res);
    });
    run(relay, shareId, user, [{ name: "http", port: local.port }]);
    const host = relay.visitorHost(shareId, local.port);
    await served(relay, host);

    const first = Array.from({ length: 100 }, () => visit(relay.port, host, { path: "/held" }));
    await waitFor(() => held.length === 100);
    const extra = await visit(relay.port, host, { path: "/held" });
    for (const res of held) res.end("done");
    const completed = await Promise.all(first);

    expect(extra).toMatchObject({ status: 503, headers: { "retry-after": "1" } });
    expect(extra.body.toString()).toBe("This share is busy.");
    expect(completed.map((r) => r.status)).toEqual(Array(100).fill(200));
  });

  it("for random well-formed ids are answered without reading the store", async () => {
    const counted = countingShareStore(new MemoryShareStore());
    const relay = await relayOver(counted.store);

    const answers = await Promise.all(
      Array.from({ length: 50 }, () => visit(relay.port, relay.visitorHost(randomBase32(12), 8080))),
    );

    expect(answers.map((a) => a.status)).toEqual(Array(50).fill(503));
    expect(counted.calls).toEqual([]);
  });
});

describe("byte shaping", () => {
  const RATE = 192 * 1024;
  const BYTES = 448 * 1024;
  // The bucket holds 64 KiB, and the last write (at most one 64 KiB HTTP/2
  // stream window) is sent before its debt is paid: (448 - 64 - 64) / 192 s.
  const LEAST_MS = ((BYTES - 2 * 64 * 1024) / RATE) * 1000;
  const MOST_MS = ((BYTES - 64 * 1024) / RATE) * 1000 * 2;

  async function shaped(handler: http.RequestListener) {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares, { settings: { maxBytesPerSecond: RATE } });
    const user = await issuer.user("alice");
    const shareId = await shareOf(shares, user);
    const local = await localServer(handler);
    run(relay, shareId, user, [{ name: "http", port: local.port }]);
    const host = relay.visitorHost(shareId, local.port);
    await served(relay, host);
    return { relay, host };
  }

  it("holds a download to the tunnel's byte rate", async () => {
    const body = randomBytes(BYTES);
    const { relay, host } = await shaped((req, res) => res.end(req.url === "/__served" ? "ok" : body));
    const started = performance.now();

    const response = await visit(relay.port, host);

    const elapsed = performance.now() - started;
    expect(response.body.equals(body)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(LEAST_MS * 0.95);
    expect(elapsed).toBeLessThan(MOST_MS);
  });

  it("holds an upload to the tunnel's byte rate", async () => {
    const body = randomBytes(BYTES);
    const { relay, host } = await shaped((req, res) => {
      let length = 0;
      req.on("data", (chunk: Buffer) => (length += chunk.length));
      req.on("end", () => res.end(String(length)));
    });
    const started = performance.now();

    const response = await visit(relay.port, host, { method: "POST", body });

    const elapsed = performance.now() - started;
    expect(response.body.toString()).toBe(String(BYTES));
    expect(elapsed).toBeGreaterThanOrEqual(LEAST_MS * 0.95);
    expect(elapsed).toBeLessThan(MOST_MS);
  });
});

describe("bounded memory", () => {
  it("reads no more of an upload than the stalled local app makes room for", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares, { settings: { maxBytesPerSecond: 1 << 30 } });
    const sockets: Socket[] = [];
    relay.handle.app.server.on("connection", (socket: Socket) => sockets.push(socket));
    const user = await issuer.user("alice");
    const shareId = await shareOf(shares, user);
    const local = await localServer((req, res) => {
      if (req.url === "/__served") res.end("ok");
      else req.pause();
    });
    run(relay, shareId, user, [{ name: "http", port: local.port }]);
    const host = relay.visitorHost(shareId, local.port);
    await served(relay, host);
    const visitorSockets = sockets.length;

    const upload = http.request({ host: "127.0.0.1", port: relay.port, method: "POST", path: "/", headers: { host }, agent: false });
    upload.on("error", () => undefined);
    const chunk = Buffer.alloc(1024 * 1024);
    let written = 0;
    const pump = () => {
      while (written < 64 && upload.write(chunk)) written++;
    };
    upload.on("drain", pump);
    pump();
    await sleep(1_500);

    const read = Math.max(...sockets.slice(visitorSockets).map((socket) => socket.bytesRead));
    upload.destroy();
    expect(read).toBeLessThan(4 * 1024 * 1024);
  });
});

/** Postgres runs only when `RUNNER_SESSION_STORE_TEST_URL` names a THROWAWAY database. */
const POSTGRES_URL = process.env.RUNNER_SESSION_STORE_TEST_URL?.trim() || undefined;

/** One store the relays of a test share: its share half, and the session half recording `jti`s. */
type FenceStore = { shares: ShareStore; jti: SessionStore };

const fenceStores: Array<[string, () => Promise<FenceStore>]> = [
  ["memory", async () => ({ shares: new MemoryShareStore(), jti: jti.store })],
];
if (POSTGRES_URL) {
  fenceStores.push([
    "postgres",
    async () => {
      const admin = new pg.Pool({ connectionString: POSTGRES_URL });
      await admin.query(
        "DROP TABLE IF EXISTS runner_shares, runner_host_ids, runner_sessions, runner_dpop_jtis, runner_schema_version",
      );
      await admin.end();
      const store = await PostgresSessionStore.open(POSTGRES_URL, {
        onIdleClientError: (err) => {
          throw err;
        },
      });
      cleanup.push(() => store.close());
      return { shares: store.shares!, jti: store };
    },
  ]);
}

for (const [backend, open] of fenceStores) {
  describe(`the fence (${backend})`, () => {
    const owner = (user: TestUser) => ({ kind: "identity" as const, iss: TEST_ISSUER, sub: user.sub });

    it("a second run takes the share over: the first drains through GOAWAY and ends superseded", async () => {
      const { shares, jti: store } = await open();
      const relay = await relayOver(shares, { jti: store });
      const user = await issuer.user("alice");
      const shareId = await shareOf(shares, user);
      let releaseSlow: (() => void) | undefined;
      const first = await localServer((req, res) => {
        if (req.url === "/slow") releaseSlow = () => res.end("first, slow");
        else res.end("first");
      });
      const second = await localServer((req, res) => res.end("second"));
      const run1 = run(relay, shareId, user, [{ name: "http", port: first.port }]);
      await served(relay, relay.visitorHost(shareId, first.port));
      const slow = visit(relay.port, relay.visitorHost(shareId, first.port), { path: "/slow" });
      await waitFor(() => releaseSlow !== undefined);

      const run2 = run(relay, shareId, user, [{ name: "http", port: second.port }]);
      await served(relay, relay.visitorHost(shareId, second.port));
      releaseSlow!();

      expect((await slow).body.toString()).toBe("first, slow");
      await expect(run1.tunnel.ended).resolves.toMatchObject({ outcome: "lost", reason: "superseded", code: 4409 });
      expect((await visit(relay.port, relay.visitorHost(shareId, second.port))).body.toString()).toBe("second");
      expect(run2.events.filter((e) => e.type === "warning")).toEqual([]);
    });

    it("a reconnect presenting an epoch taken over across a relay restart is closed 4409", async () => {
      const { shares, jti: store } = await open();
      const relayA = await relayOver(shares, { jti: store });
      const relayB = await relayOver(shares, { jti: store });
      const user = await issuer.user("alice");
      const shareId = await shareOf(shares, user);
      const run1 = run(relayA, shareId, user, [{ name: "http", port: 8080 }]);
      await run1.connected();

      await relayA.close();
      const run2 = run(relayB, shareId, user, [{ name: "http", port: 8080 }]);
      await run2.connected();
      await relayOver(shares, { jti: store, port: relayA.port });

      await expect(run1.tunnel.ended).resolves.toMatchObject({ outcome: "lost", reason: "superseded", code: 4409 });
      expect((await shares.getShare(shareId))!.epoch).toBe(2);
    });

    it("across two relays over one store, the first run ends superseded at its relay's next renewal", async () => {
      const { shares, jti: store } = await open();
      const relayA = await relayOver(shares, { jti: store, timings: { renewIntervalMs: 100 } });
      const relayB = await relayOver(shares, { jti: store, timings: { renewIntervalMs: 100 } });
      const user = await issuer.user("alice");
      const shareId = await shareOf(shares, user);
      const local = await localServer((req, res) => res.end("ok"));
      const run1 = run(relayA, shareId, user, [{ name: "http", port: local.port }]);
      await run1.connected();

      const run2 = run(relayB, shareId, user, [{ name: "http", port: local.port }]);
      await run2.connected();

      await expect(run1.tunnel.ended).resolves.toMatchObject({ outcome: "lost", reason: "superseded", code: 4409 });
      await served(relayB, relayB.visitorHost(shareId, local.port));
    });

    it("the first run's clean close after a takeover leaves the share connected", async () => {
      const { shares, jti: store } = await open();
      const relayA = await relayOver(shares, { jti: store, timings: { renewIntervalMs: 60_000 } });
      const relayB = await relayOver(shares, { jti: store });
      const user = await issuer.user("alice");
      const shareId = await shareOf(shares, user);
      const run1 = run(relayA, shareId, user, [{ name: "http", port: 8080 }]);
      await run1.connected();
      const run2 = run(relayB, shareId, user, [{ name: "http", port: 8080 }]);
      await run2.connected();

      await run1.tunnel.close();
      await sleep(100);

      const share = (await shares.getShare(shareId))!;
      expect(share.epoch).toBe(2);
      expect(shareConnected(share, new Date())).toBe(true);
    });

    it("a clean close ends the lease at once", async () => {
      const { shares, jti: store } = await open();
      const relay = await relayOver(shares, { jti: store });
      const user = await issuer.user("alice");
      const shareId = await shareOf(shares, user);
      const share = run(relay, shareId, user, [{ name: "http", port: 8080 }]);
      await share.connected();

      await share.tunnel.close();

      await waitFor(async () => !shareConnected((await shares.getShare(shareId))!, new Date()));
    });

    it("a deleted share's tunnel is closed 4404 within one renewal", async () => {
      const { shares, jti: store } = await open();
      const relay = await relayOver(shares, { jti: store, timings: { renewIntervalMs: 200 } });
      const user = await issuer.user("alice");
      const shareId = await shareOf(shares, user);
      const local = await localServer((req, res) => res.end("ok"));
      const share = run(relay, shareId, user, [{ name: "http", port: local.port }]);
      await served(relay, relay.visitorHost(shareId, local.port));

      const deletedAt = Date.now();
      await shares.deleteShare(shareId, owner(user), new Date());

      await expect(share.tunnel.ended).resolves.toMatchObject({ outcome: "lost", reason: "deleted", code: 4404 });
      expect(Date.now() - deletedAt).toBeLessThan(1_000);
      expect((await visit(relay.port, relay.visitorHost(shareId, local.port))).status).toBe(503);
    });
  });
}

describe("connected-share limits", () => {
  it("a tunnel past the runner's capacity is closed 4503 and connects once another leaves", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares, { settings: { maxConnected: 1 } });
    const alice = await issuer.user("alice");
    const bob = await issuer.user("bob");
    const first = run(relay, await shareOf(shares, alice), alice, [{ name: "http", port: 8080 }]);
    await first.connected();

    const second = run(relay, await shareOf(shares, bob), bob, [{ name: "http", port: 8080 }]);
    await waitFor(() => warnings(second.events, "runner-capacity").length > 0);
    await first.tunnel.close();

    await second.connected();
    expect(warnings(second.events, "runner-capacity")).toMatchObject([{ code: 4503 }]);
  });

  it("an owner's tunnel past its connected-share limit is closed 4429 and connects once another leaves", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares, { settings: { maxConnectedPerOwner: 1 } });
    const alice = await issuer.user("alice");
    const first = run(relay, await shareOf(shares, alice), alice, [{ name: "http", port: 8080 }]);
    await first.connected();

    const second = run(relay, await shareOf(shares, alice), alice, [{ name: "http", port: 8080 }]);
    await waitFor(() => warnings(second.events, "owner-limit").length > 0);
    await first.tunnel.close();

    await second.connected();
    expect(warnings(second.events, "owner-limit")).toMatchObject([{ code: 4429 }]);
  });
});

describe("tunnel credentials", () => {
  it("a proof naming the control origin's URL is refused 4401", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares);
    const user = await issuer.user("alice");
    const shareId = await shareOf(shares, user);

    const { driver } = await rawTunnel(relay, shareId, user, `${TEST_AUDIENCE}/v1/shares/${shareId}/tunnel`);

    expect((await driver.nextClose()).code).toBe(4401);
  });

  it("a replayed upgrade proof is refused 4401 by a restarted relay", async () => {
    const shares = new MemoryShareStore();
    const relayA = await relayOver(shares);
    const user = await issuer.user("alice");
    const shareId = await shareOf(shares, user);
    const first = await rawTunnel(relayA, shareId, user);
    await handshake(first.driver);
    await relayA.close();

    const relayB = await relayOver(shares, { port: relayA.port });
    const replayed = await TunnelDriver.open(relayB.tunnelUrl(shareId), first.headers);

    expect((await replayed.nextClose()).code).toBe(4401);
  });

  it("an auth carrying another owner's token is closed 4401", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares);
    const alice = await issuer.user("alice");
    const mallory = await issuer.user("mallory");
    const shareId = await shareOf(shares, alice);
    const { driver, url } = await rawTunnel(relay, shareId, alice);
    await handshake(driver);

    const { accessToken } = await mallory.token();
    driver.send({
      type: "auth",
      accessToken,
      proof: await mallory.proof(accessToken, { htm: "GET", htu: tunnelProofUrl(url) }),
    });

    expect(await driver.nextClose()).toMatchObject({ code: 4401, reason: "the renewed credential is another owner's" });
  });

  it("a tunnel is closed 4401 when the newest token it holds expires", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares);
    const user = await issuer.user("alice", { lifetimeMs: 2_000 });
    const shareId = await shareOf(shares, user);
    const { driver, url } = await rawTunnel(relay, shareId, user);
    await handshake(driver);
    const firstExpiry = user.issued[0]!.expiresAt.getTime();

    user.lifetimeMs = 4_000;
    const renewed = await user.token();
    driver.send({
      type: "auth",
      accessToken: renewed.accessToken,
      proof: await user.proof(renewed.accessToken, { htm: "GET", htu: tunnelProofUrl(url) }),
    });

    const closed = await driver.nextClose(10_000);
    expect(closed).toMatchObject({ code: 4401, reason: "the newest access token expired" });
    expect(Date.now()).toBeGreaterThan(firstExpiry + 1_000);
  });
});

describe("the upgrade", () => {
  it("counts a first frame pipelined in the upgrade's bytes once: the hello is answered, not closed 4400", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares);
    const user = await issuer.user("alice");
    const shareId = await shareOf(shares, user);
    const url = relay.tunnelUrl(shareId);
    const { accessToken } = await user.token();
    const proof = await user.proof(accessToken, { htm: "GET", htu: tunnelProofUrl(url) });
    const payload = Buffer.from(JSON.stringify({ type: "hello", epoch: null }));
    const mask = randomBytes(4);
    const frame = Buffer.concat([
      Buffer.from([0x81, 0x80 | payload.length]),
      mask,
      payload.map((byte, at) => byte ^ mask[at % 4]!),
    ]);
    const request = [
      `GET /v1/shares/${shareId}/tunnel HTTP/1.1`,
      `Host: 127.0.0.1:${relay.port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      `Sec-WebSocket-Protocol: ${TUNNEL_SUBPROTOCOL}`,
      `Authorization: DPoP ${accessToken}`,
      `DPoP: ${proof}`,
      "",
      "",
    ].join("\r\n");

    const received: Buffer[] = [];
    const socket = net.connect(relay.port, "127.0.0.1");
    cleanup.push(async () => void socket.destroy());
    socket.on("data", (chunk) => received.push(chunk));
    socket.write(Buffer.concat([Buffer.from(request), frame]));
    await waitFor(() => Buffer.concat(received).includes('"type":"hello"'));

    const answer = Buffer.concat(received);
    expect(answer.toString("latin1")).toMatch(/^HTTP\/1\.1 101/);
    expect(answer.includes(Buffer.from([0x88, 0x02, 0x11, 0x10]))).toBe(false);
  });
});

describe("keepalive", () => {
  it("the relay pings an open tunnel every interval", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares, { timings: { pingIntervalMs: 50 } });
    const user = await issuer.user("alice");
    const { driver } = await rawTunnel(relay, await shareOf(shares, user), user);
    await handshake(driver);
    let pings = 0;
    driver.ws.on("ping", () => pings++);

    await sleep(300);

    expect(pings).toBeGreaterThanOrEqual(3);
  });

  it("a tunnel the relay hears nothing from is closed 4408", async () => {
    const shares = new MemoryShareStore();
    const relay = await relayOver(shares, { timings: { silenceMs: 300, pingIntervalMs: 60_000 } });
    const user = await issuer.user("alice");
    const { driver } = await rawTunnel(relay, await shareOf(shares, user), user);
    await handshake(driver);

    expect((await driver.nextClose()).code).toBe(4408);
  });
});

describe("boot", () => {
  it("the control plane refuses the relay role", async () => {
    const config = testConfig({
      identity: TEST_IDENTITY,
      shares: { ...testConfig().shares, enabled: true, role: "relay" },
    });
    await expect(
      bootTestServer({
        backend: new FakeWorkloadBackend({ shareRouting: TEST_SHARE_ROUTING }),
        config,
        store: withShares(jti.store, new MemoryShareStore()),
      }),
    ).rejects.toThrow(/^RUNNER_ROLE=relay serves share tunnels and visitors, not \/v1/);
  });

  it("the relay refuses a missing share routing, naming its role", async () => {
    const config = testConfig({
      identity: TEST_IDENTITY,
      shares: { ...testConfig().shares, enabled: true, role: "relay" },
    });
    await expect(
      buildRelayServer({ shareRouting: undefined, config, store: withShares(jti.store, new MemoryShareStore()) }),
    ).rejects.toThrow(/^RUNNER_ROLE=relay is on, but this runner's backend routes no shares/);
  });

  it("the control plane names a backend that routes no shares before it points at the relay main", async () => {
    const config = testConfig({
      identity: TEST_IDENTITY,
      shares: { ...testConfig().shares, enabled: true, role: "relay" },
    });
    await expect(
      bootTestServer({ backend: new FakeWorkloadBackend(), config, store: withShares(jti.store, new MemoryShareStore()) }),
    ).rejects.toThrow(/^RUNNER_ROLE=relay is on, but this runner's backend routes no shares/);
  });
});
