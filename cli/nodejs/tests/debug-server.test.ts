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

describe("DebugServer UI availability", () => {
  let server: DebugServer | undefined;

  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  it("renders the unavailable reason (incl. the fetch URL) in the 503", async () => {
    const reason = "could not fetch the debug UI from https://cdn.jsdelivr.net/npm/@telorun/debug-ui@0.2.0/app-single/index.html — HTTP 404 Not Found.";
    server = new DebugServer({ uiUnavailableReason: reason });
    await server.start();

    const res = await fetch(`${server.url}/`);
    const body = await res.text();

    expect(res.status).toBe(503);
    expect(body).toContain("https://cdn.jsdelivr.net/npm/@telorun/debug-ui@0.2.0");
    expect(body).toContain("HTTP 404 Not Found");
  });

  it("keeps the live endpoint working even when the UI is unavailable", async () => {
    server = new DebugServer({ uiUnavailableReason: "nope" });
    await server.start();

    const info = await fetch(`${server.url}/json/version`).then((r) => r.json());

    expect(info.protocol).toBe("telo-debug");
  });
});
