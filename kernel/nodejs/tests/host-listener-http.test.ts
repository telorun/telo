import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HostListeners } from "../src/host-listeners.js";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A host that owns a port's socket and supplies its connections: an
 * `Http.Server` configured with that number serves them and binds nothing.
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "host-listener");

class Capture {
  readonly chunks: string[] = [];
  get stream(): NodeJS.WritableStream {
    return { write: (chunk: string) => void this.chunks.push(String(chunk)) } as never;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The host's own socket on `port`: it reads each connection's first bytes, as
 *  admission does, then admits it with those bytes. */
async function hostSocket(listeners: HostListeners, port: number): Promise<void> {
  const server = net.createServer((socket) => {
    socket.on("error", (error) => {
      throw error;
    });
    socket.once("data", (head) => {
      socket.pause();
      listeners.admit(port, { socket, head, peer: `${socket.remoteAddress}:${socket.remotePort}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
}

/** One request over a fresh connection; the whole response as text. */
function request(port: number, probe: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk) => (received += String(chunk)));
    socket.on("error", reject);
    socket.on("close", () => resolve(received));
    socket.write(
      `GET /v1/hello HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Probe: ${probe}\r\nConnection: close\r\n\r\n`,
    );
  });
}

function hostListeners(...ports: number[]): HostListeners {
  return new HostListeners({
    ports: ports.map((port) => ({ port, address: "127.0.0.1" })),
    unavailable: ({ port }) => ({ contentType: "text/plain", body: `starting ${port}` }),
  });
}

async function booted(entry: string, env: Record<string, string>, listeners: HostListeners, stderr = new Capture()) {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env, listeners, stderr: stderr.stream });
  cleanups.push(() => kernel.teardown());
  await kernel.load(path.join(FIXTURES, entry));
  await kernel.boot();
  await kernel.runTargets();
  return kernel;
}

describe("a host-supplied listener", () => {
  it("is served by the server configured with its port, which binds nothing; another port binds as usual", async () => {
    const [held, plain] = [await freePort(), await freePort()];
    const listeners = hostListeners(held);
    // The host holds the port, so a server binding it would fail to start.
    await hostSocket(listeners, held);
    // Admitted before any server claims the socket: held, then served.
    const early = request(held, "early");
    const kernel = await booted("web", { WEB_PORT: String(held), PLAIN_PORT: String(plain) }, listeners);

    expect(await early).toMatch(/^HTTP\/1\.1 200 OK[\s\S]*\{"probe":"early"\}$/);
    expect(await request(held, "replayed")).toMatch(/\{"probe":"replayed"\}$/);
    expect(await request(plain, "bound")).toMatch(/\{"probe":"bound"\}$/);
    expect(kernel.getResolvedPorts()).toEqual([
      { name: "http", port: held, protocol: "tcp", address: "127.0.0.1", suppliedBy: "host" },
      { name: "plain", port: plain, protocol: "tcp" },
    ]);
  }, 60_000);

  it("is given back by a server that stops, so the next application's server claims it", async () => {
    const [held, plain] = [await freePort(), await freePort()];
    const listeners = hostListeners(held);
    await hostSocket(listeners, held);
    const env = { WEB_PORT: String(held), PLAIN_PORT: String(plain) };
    const first = await booted("web", env, listeners);
    await first.teardown();
    await booted("web", env, listeners);
    expect(await request(held, "again")).toMatch(/\{"probe":"again"\}$/);
  }, 60_000);

  it("follows its port number into a child application", async () => {
    const [held, plain] = [await freePort(), await freePort()];
    const listeners = hostListeners(held);
    await hostSocket(listeners, held);
    await booted("supervisor", { SUPERVISOR_PORT: String(held), SUPERVISOR_PLAIN_PORT: String(plain) }, listeners);
    expect(await request(held, "child")).toMatch(/\{"probe":"child"\}$/);
  }, 60_000);

  it("unclaimed by the end of startup, answers the host's 503 and is warned about by its port key", async () => {
    const idle = await freePort();
    const listeners = hostListeners(idle);
    await hostSocket(listeners, idle);
    const answer = request(idle, "nobody");
    const stderr = new Capture();
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: { IDLE_PORT: String(idle) }, listeners, stderr: stderr.stream });
    await kernel.load(path.join(FIXTURES, "unclaimed"));
    await kernel.start();
    expect(await answer).toMatch(/^HTTP\/1\.1 503 Service Unavailable\r\n[\s\S]*\r\n\r\nstarting \d+$/);
    expect(stderr.text).toContain(`no server claimed the host's socket for port ${idle} (ports.idle)`);
  }, 60_000);
});
