import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConnectionListener, type HandshakeFailure, type UnavailableAddress } from "../src/connection-listener.js";
import { resolveHttpsOptions } from "../src/tls-material.js";

const dir = fileURLToPath(new URL("../../tests/__fixtures__/tls/", import.meta.url));
const text = (name: string) => readFileSync(dir + name, "utf8");

const httpOptions = { keepAliveTimeout: 72_000, requestTimeout: 0, connectionTimeout: 0, maxRequestsPerSocket: 0 };

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function listening(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  tls?: ReturnType<typeof resolveHttpsOptions>,
) {
  const port = await freePort();
  const failures: HandshakeFailure[] = [];
  const listener = new ConnectionListener({
    address: "127.0.0.1",
    port,
    ...(tls ? { tls } : {}),
    onHandshakeFailure: (failure) => failures.push(failure),
    onAddressUnavailable: (unavailable) => {
      throw new Error(`unexpected unavailable address ${unavailable.address}`);
    },
  });
  listener.serverFactory(handler as never, httpOptions);
  await listener.listen();
  return { listener, port, failures };
}

/** A raw client socket, with everything it received and when it closed. */
async function connect(port: number, host = "127.0.0.1") {
  const socket = net.connect(port, host);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const state = { received: "", closed: false };
  socket.on("data", (chunk) => (state.received += String(chunk)));
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => {
      state.closed = true;
      resolve();
    }),
  );
  return { socket, state, closed };
}

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("ConnectionListener", () => {
  it("closes an idle connection at once and a busy one after its response, then stops accepting", async () => {
    const arrived: string[] = [];
    const { listener, port } = await listening((request, response) => {
      arrived.push(request.url!);
      setTimeout(() => response.end(request.url), request.url === "/slow" ? 200 : 0);
    });
    const idle = await connect(port);
    idle.socket.write("GET /fast HTTP/1.1\r\nHost: x\r\n\r\n");
    await until(() => idle.state.received.endsWith("/fast"));
    const busy = await connect(port);
    busy.socket.write("GET /slow HTTP/1.1\r\nHost: x\r\n\r\n");
    await until(() => arrived.includes("/slow"));

    const closing = listener.close();
    await idle.closed;
    expect(busy.state.closed).toBe(false);
    await closing;
    await busy.closed;
    expect(busy.state.received).toMatch(/^HTTP\/1\.1 200 OK\r\n[\s\S]*\/slow$/);
    await expect(connect(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("binds every address a hostname resolves to on one port, skipping one the host lacks", async () => {
    const loopbacks = ["127.0.0.1"];
    const probe = net.createServer();
    const ipv6 = await new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(0, "::1", () => probe.close(() => resolve(true)));
    });
    if (ipv6) loopbacks.push("::1");
    // TEST-NET-1: an address no interface of this host holds.
    const resolved = [...loopbacks, "192.0.2.1"];
    const unavailable: UnavailableAddress[] = [];
    const listener = new ConnectionListener({
      address: "loopback.test",
      port: 0,
      resolve: async () => resolved,
      onHandshakeFailure: () => {},
      onAddressUnavailable: (entry) => unavailable.push(entry),
    });
    listener.serverFactory(((_request: IncomingMessage, response: ServerResponse) =>
      response.end("ok")) as never, httpOptions);
    await listener.listen();
    const bound = listener.bound;
    const port = bound[0]!.port;
    expect(bound.map((entry) => [entry.address, entry.port])).toEqual(loopbacks.map((host) => [host, port]));
    expect(unavailable).toMatchObject([{ address: "192.0.2.1", port, type: "EADDRNOTAVAIL" }]);
    for (const host of loopbacks) {
      const client = await connect(port, host);
      client.socket.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      await client.closed;
      expect(client.state.received).toMatch(/^HTTP\/1\.1 200 OK\r\n[\s\S]*ok$/);
    }
    await listener.close();
    for (const host of loopbacks) await expect(connect(port, host)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("drops a connection still in its TLS handshake when it closes, reporting no failure", async () => {
    const tls = resolveHttpsOptions({ cert: { pem: text("server.pem") }, key: { pem: text("server.key") } });
    const { listener, port, failures } = await listening((_request, response) => response.end(), tls);
    const stalled = await connect(port);
    await listener.close();
    await stalled.closed;
    expect(failures).toEqual([]);
  });
});
