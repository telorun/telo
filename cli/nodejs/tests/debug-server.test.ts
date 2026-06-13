import { afterEach, describe, expect, it } from "vitest";
import { DebugServer } from "../src/debug-server.js";

describe("DebugServer /json/version handshake", () => {
  let server: DebugServer | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  it("advertises app endpoints set via setEndpoints", async () => {
    server = new DebugServer();
    await server.start();
    server.setEndpoints([
      { host: "", port: 8080, protocol: "tcp" },
      { host: "", port: 9000, protocol: "udp" },
    ]);

    const info = await fetch(`${server.url}/json/version`).then((r) => r.json());

    expect(info.protocol).toBe("telo-debug");
    expect(info.appEndpoints).toEqual([
      { host: "", port: 8080, protocol: "tcp" },
      { host: "", port: 9000, protocol: "udp" },
    ]);
  });

  it("defaults appEndpoints to an empty list before any are set", async () => {
    server = new DebugServer();
    await server.start();

    const info = await fetch(`${server.url}/json/version`).then((r) => r.json());

    expect(info.appEndpoints).toEqual([]);
  });
});
