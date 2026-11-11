import { decodeTypedFrame, encodeFrame, encodeTypedFrame, FrameReader } from "@telorun/sdk";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ControlRefusal,
  openControlChannel,
  type ControlChannel,
  type ControlConnection,
  type ControlRequest,
} from "../src/desktop/desktop-control-channel.js";

/** The host end of desktop_host-1, spoken to as the module end would. */

let runtime: string;
let channel: ControlChannel | undefined;

beforeEach(() => {
  runtime = fs.mkdtempSync(path.join(os.tmpdir(), "telo-control-"));
});
afterEach(async () => {
  await channel?.close();
  channel = undefined;
  fs.rmSync(runtime, { recursive: true, force: true });
});

interface Peer {
  send(id: number, type: string, payload: unknown): void;
  /** Resolves with the next message the host sends. */
  next(): Promise<{ id: number; type: string; payload: any }>;
  closed: Promise<void>;
}

function dial(endpoint: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: new URL(endpoint).pathname });
    const reader = new FrameReader();
    const queue: Array<{ id: number; type: string; payload: any }> = [];
    const waiting: Array<(message: { id: number; type: string; payload: any }) => void> = [];
    socket.on("data", (chunk) => {
      for (const frame of reader.push(chunk)) {
        const message = decodeTypedFrame(frame.meta) as { id: number; type: string; payload: any };
        const wake = waiting.shift();
        if (wake) wake(message);
        else queue.push(message);
      }
    });
    const closed = new Promise<void>((done) => socket.on("close", () => done()));
    socket.once("error", reject);
    socket.once("connect", () =>
      resolve({
        send: (id, type, payload) => socket.write(encodeFrame("message", encodeTypedFrame({ id, payload, type }))),
        next: () => new Promise((wake) => (queue.length > 0 ? wake(queue.shift()!) : waiting.push(wake))),
        closed,
      }),
    );
  });
}

function host(handle: (connection: ControlConnection, request: ControlRequest) => Promise<unknown>) {
  const violations: string[] = [];
  const ended: number[] = [];
  return {
    violations,
    ended,
    handler: { handle, ended: (c: ControlConnection) => ended.push(c.id), violated: (r: string) => violations.push(r) },
  };
}

const open = async (handle: (connection: ControlConnection, request: ControlRequest) => Promise<unknown>) => {
  const stub = host(handle);
  channel = await openControlChannel(stub.handler, { env: { XDG_RUNTIME_DIR: runtime } });
  return stub;
};

describe.skipIf(process.platform === "win32")("the desktop host's control channel", () => {
  it("lives in a directory only this user can enter, as a unix: endpoint with a fresh token", async () => {
    await open(async () => ({}));
    const socketPath = new URL(channel!.endpoint).pathname;
    expect(channel!.endpoint).toBe(`unix://${socketPath}`);
    expect(fs.statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect(channel!.token.length).toBeGreaterThanOrEqual(32);
  });

  it("answers Host.Hello with its own generation, then serves requests and sends even-id notifications", async () => {
    await open(async (connection, request) => {
      if (request.type === "Window.Show") {
        connection.notify("Window.Closed", { window: "w" });
        throw new ControlRefusal("ERR_DESKTOP_HOST_UNKNOWN_ENTRY", "no window 'w' is open");
      }
      return {};
    });
    const peer = await dial(channel!.endpoint);
    peer.send(1, "Host.Hello", { generation: "desktop_host-0", token: channel!.token });
    expect(await peer.next()).toEqual({ id: 1, type: "Host.Hello", payload: { ok: { generation: "desktop_host-1" } } });
    peer.send(3, "Window.Show", { window: "w" });
    expect(await peer.next()).toEqual({ id: 2, type: "Window.Closed", payload: { window: "w" } });
    expect(await peer.next()).toEqual({
      id: 3,
      type: "Window.Show",
      payload: { error: { code: "ERR_DESKTOP_HOST_UNKNOWN_ENTRY", message: "no window 'w' is open" } },
    });
  });

  it("refuses a wrong token with ERR_DESKTOP_HOST_TOKEN_INVALID and closes the connection", async () => {
    const stub = await open(async () => ({}));
    const peer = await dial(channel!.endpoint);
    peer.send(1, "Host.Hello", { generation: "desktop_host-1", token: "not-the-token" });
    expect((await peer.next()).payload.error.code).toBe("ERR_DESKTOP_HOST_TOKEN_INVALID");
    await peer.closed;
    expect(stub.ended).toEqual([]);
  });

  it.each([
    ["a request before Host.Hello", (p: Peer) => p.send(1, "Window.Show", { window: "w" }), "'Window.Show' before Host.Hello"],
    ["an even id", (p: Peer, token: string) => (p.send(1, "Host.Hello", { generation: "desktop_host-1", token }), p.send(2, "Host.Quit", {})), "an even id 2"],
    ["an unknown type", (p: Peer, token: string) => (p.send(1, "Host.Hello", { generation: "desktop_host-1", token }), p.send(3, "Window.Explode", {})), "unknown type 'Window.Explode'"],
    ["a member its table does not list", (p: Peer, token: string) => (p.send(1, "Host.Hello", { generation: "desktop_host-1", token }), p.send(3, "Window.Show", { window: "w", extra: 1 })), "a member 'extra'"],
  ])("closes the connection on %s", async (_, misbehave, reason) => {
    const stub = await open(async () => ({}));
    const peer = await dial(channel!.endpoint);
    misbehave(peer, channel!.token);
    await peer.closed;
    expect(stub.violations.join("\n")).toContain(reason);
  });

  it("removes its socket and directory when closed", async () => {
    await open(async () => ({}));
    const directory = path.dirname(new URL(channel!.endpoint).pathname);
    await channel!.close();
    channel = undefined;
    expect(fs.existsSync(directory)).toBe(false);
  });
});
