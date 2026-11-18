// One tunnel over a scripted socket and holder: what the relay does while a
// message waits on the store or the issuer, which the wire tests cannot time.

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import type { TunnelAuthenticator, TunnelIdentity } from "./tunnel-authenticator.js";
import type { ConnectShareResult } from "../session-store/share-store.js";
import { DEFAULT_SHARE_RELAY_TIMINGS, RelayTunnel, type TunnelHolder } from "./relay-tunnel.js";

const OWNER = { kind: "identity" as const, iss: "https://issuer.test", sub: "alice" };
const IDENTITY: TunnelIdentity = { owner: OWNER, expiresAt: new Date(Date.now() + 3_600_000) };

class FakeSocket extends EventEmitter {
  readyState = 1;
  isPaused = false;
  closedWith: number | undefined;
  pause(): void {
    this.isPaused = true;
  }
  resume(): void {
    this.isPaused = false;
  }
  ping(): void {}
  readonly OPEN = 1;
  send(...args: unknown[]): void {
    const done = args.at(-1);
    if (typeof done === "function") done();
  }
  close(code: number): void {
    this.closedWith = code;
    this.readyState = 3;
    this.emit("close", code);
  }
  terminate(): void {
    this.readyState = 3;
    this.emit("close", 1006);
  }
  message(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const live: RelayTunnel[] = [];
afterEach(() => {
  for (const tunnel of live.splice(0)) tunnel.close(1000, "test over");
});

function setup(options: { connect?: Promise<ConnectShareResult>; authenticator?: TunnelAuthenticator } = {}) {
  const socket = new FakeSocket();
  const holder: TunnelHolder = {
    directory: {
      lookUp: async () => ({ owner: OWNER }),
      connect: () => options.connect ?? Promise.resolve({ kind: "connected", epoch: 1 } as ConnectShareResult),
      renew: async () => [],
      release: async () => true,
    },
    authenticator: options.authenticator ?? { authenticate: async () => IDENTITY },
    timings: { ...DEFAULT_SHARE_RELAY_TIMINGS },
    log: { info() {}, warn() {}, error() {} },
    maxConcurrentRequests: 10,
    maxBytesPerSecond: 1_000_000,
    connected: () => true,
    routable() {},
    unroutable() {},
    superseded() {},
    ended() {},
    release() {},
  };
  const tunnel = new RelayTunnel(holder, socket as unknown as WebSocket, "share", "https://t.test/tunnel", IDENTITY);
  live.push(tunnel);
  return { socket, tunnel };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("the fence", () => {
  it("holds the socket paused while the store answers, then resumes it", async () => {
    const connect = deferred<ConnectShareResult>();
    const { socket } = setup({ connect: connect.promise });

    socket.message({ type: "hello", epoch: null });
    await tick();
    expect(socket.isPaused).toBe(true);

    connect.resolve({ kind: "connected", epoch: 1 });
    await tick();
    expect(socket.isPaused).toBe(false);
  });

  it("resumes the socket when the store refuses the connect", async () => {
    const connect = deferred<ConnectShareResult>();
    const { socket } = setup({ connect: connect.promise });

    socket.message({ type: "hello", epoch: null });
    await tick();
    connect.resolve({ kind: "capacity" } as ConnectShareResult);
    await tick();

    expect(socket.closedWith).toBe(4503);
    expect(socket.isPaused).toBe(false);
  });
});

describe("re-authentication", () => {
  it("verifies one credential at a time and keeps only the newest of a burst", async () => {
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const seen: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const authenticator: TunnelAuthenticator = {
      authenticate: async ({ accessToken }) => {
        seen.push(accessToken);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const gate = deferred<void>();
        gates.push(gate);
        await gate.promise;
        inFlight--;
        return IDENTITY;
      },
    };
    const { socket } = setup({ authenticator });
    socket.message({ type: "hello", epoch: null });
    await tick();

    for (let i = 0; i < 50; i++) socket.message({ type: "auth", accessToken: `t${i}`, proof: "p" });
    await tick();
    expect(seen).toEqual(["t0"]);

    gates[0]!.resolve();
    await tick();
    expect(seen).toEqual(["t0", "t49"]);
    gates[1]!.resolve();
    await tick();

    expect(seen).toEqual(["t0", "t49"]);
    expect(maxInFlight).toBe(1);
  });
});

