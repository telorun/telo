import type { HandedConnection } from "@telorun/sdk";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { attachListeners, HostListeners } from "../src/host-listeners.js";

/**
 * The host-supplied listener's hold / hand-over / answer rules
 * (`kernel/specs/controller-protocol.md` §9.4), over in-memory sockets.
 */
const PORT = 53817;

function listeners() {
  return new HostListeners({
    ports: [{ port: PORT, address: "127.0.0.1" }],
    unavailable: ({ port, failure }) => ({
      contentType: "text/plain",
      body: failure ? `refused ${port}: ${(failure as Error).message}` : `starting ${port}`,
    }),
  });
}

/** One admitted connection: what the peer reads back from it. */
function connection(head = "GET / HTTP/1.1\r\n\r\n") {
  const socket = new PassThrough();
  let written = "";
  const ended = new Promise<string>((resolve) => {
    socket.on("data", (chunk) => (written += String(chunk)));
    socket.on("end", () => resolve(written));
  });
  return { socket, head: Buffer.from(head), peer: "127.0.0.1:53901", ended };
}

async function firstChunk(connection: HandedConnection): Promise<string> {
  for await (const chunk of connection.inbound) return Buffer.from(chunk).toString();
  return "";
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("a host-supplied listener", () => {
  it("holds a connection admitted before the claim and hands it over, replayed bytes first", async () => {
    const set = listeners();
    const kernel = attachListeners(set, "k1");
    const early = connection("GET /early HTTP/1.1\r\n\r\n");
    set.admit(PORT, early);
    const accepted: HandedConnection[] = [];
    const claim = kernel.claim(PORT, (c) => accepted.push(c), "Http.Server/web");
    expect(claim?.address).toBe("127.0.0.1");
    expect(accepted).toEqual([]);
    await tick();
    expect(accepted.map((c) => c.peer)).toEqual(["127.0.0.1:53901"]);
    expect(await firstChunk(accepted[0]!)).toBe("GET /early HTTP/1.1\r\n\r\n");
  });

  it("answers null for a port the host holds no socket for", () => {
    expect(attachListeners(listeners(), "k1").claim(9090, () => {}, "Http.Server/web")).toBeNull();
  });

  it("refuses a second claim of a claimed port", () => {
    const kernel = attachListeners(listeners(), "k1");
    kernel.claim(PORT, () => {}, "Http.Server/a");
    expect(() => kernel.claim(PORT, () => {}, "Http.Server/b")).toThrow(
      expect.objectContaining({ code: "ERR_LISTENER_CLAIMED" }),
    );
  });

  it("holds again after a release, even once startup has ended, until the port is claimed anew", async () => {
    const set = listeners();
    const kernel = attachListeners(set, "k1");
    const claim = kernel.claim(PORT, () => {}, "Http.Server/web")!;
    expect(kernel.startupEnded()).toEqual([]);
    await claim.release();
    const later = connection();
    set.admit(PORT, later);
    const accepted: HandedConnection[] = [];
    kernel.claim(PORT, (c) => accepted.push(c), "Http.Server/web");
    await tick();
    expect(accepted).toHaveLength(1);
  });

  it("answers what no server claimed by the end of startup with the host's 503, and reports the port", async () => {
    const set = listeners();
    const kernel = attachListeners(set, "k1");
    const held = connection();
    set.admit(PORT, held);
    expect(kernel.startupEnded()).toEqual([PORT]);
    expect(await held.ended).toBe(
      "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: 14\r\n" +
        "Cache-Control: no-store\r\nConnection: close\r\n\r\nstarting 53817",
    );
  });

  it("answers with the failure when startup failed", async () => {
    const set = listeners();
    attachListeners(set, "k1").startupFailed(new Error("no such kind"));
    const late = connection();
    set.admit(PORT, late);
    expect(await late.ended).toContain("\r\n\r\nrefused 53817: no such kind");
  });

  it("leaves when startup ends to the kernel that owns the set, never to one it started", () => {
    const set = listeners();
    attachListeners(set, "parent");
    const child = attachListeners(set, "child");
    const held = connection();
    set.admit(PORT, held);
    expect(child.startupEnded()).toEqual([]);
    child.stopped();
    expect(held.socket.writableEnded).toBe(false);
  });
});
