import type { DebugFrame } from "@telorun/debug-wire";
import { describe, expect, it } from "vitest";

import { OpenUrlRequests } from "./open-url-requests.js";

const routed = (...ports: Array<[string, number[]]>) => ({
  declared: () => ports.map(([app, p]) => ({ app, ports: p })),
});
const WEB = routed(["web", [8080, 80, 443]]);

function frame(payload: unknown): DebugFrame {
  return { kind: "event", timestamp: "t", event: "Kernel.OpenUrlRequested", payload } as DebugFrame;
}
const ask = (r: OpenUrlRequests, url: unknown, generation = 1, app = "web", ports = WEB) =>
  r.request(app, generation, frame({ url }), ports);

describe("classifying a request", () => {
  it.each([
    ["http://localhost:8080/docs/", "http://localhost:8080/docs/", 8080],
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080/", 8080],
    ["http://[::1]:8080/x", "http://[::1]:8080/x", 8080],
    ["http://0.0.0.0:8080/", "http://0.0.0.0:8080/", 8080],
    ["http://[::]:8080/", "http://[::]:8080/", 8080],
    ["http://foo.localhost:8080/", "http://foo.localhost:8080/", 8080],
    ["http://localhost/", "http://localhost/", 80],
    ["https://localhost/a", "https://localhost/a", 443],
  ])("%s is a routed port", (raw, url, port) => {
    expect(ask(new OpenUrlRequests(), raw)).toEqual({ url, reach: "port", port });
  });

  it("is unrouted on an undeclared loopback port and on a port whose routing was rejected", () => {
    const r = new OpenUrlRequests();
    expect(ask(r, "http://localhost:9999/")).toEqual({ url: "http://localhost:9999/", reach: "unrouted", port: 9999 });
    r.routing("web", { rejected: [{ port: 8080 }] });
    expect(ask(r, "http://localhost:8080/")).toEqual({ url: "http://localhost:8080/", reach: "unrouted", port: 8080 });
    r.routing("web", { added: [{ port: 8080 }] });
    expect(ask(r, "http://localhost:8080/", 2)?.reach).toBe("port");
  });

  it("is external for any other host, with the serialization kept and no port", () => {
    expect(ask(new OpenUrlRequests(), "https://auth.example.com/authorize?x=1&y=%2F")).toEqual({
      url: "https://auth.example.com/authorize?x=1&y=%2F",
      reach: "external",
    });
  });

  it("counts a port declared by another app of the session", () => {
    expect(ask(new OpenUrlRequests(), "http://localhost:9000/", 1, "web", routed(["web", []], ["api", [9000]]))?.reach).toBe(
      "port",
    );
  });
});

describe("refusing a request", () => {
  it.each([
    ["javascript:alert(1)"],
    ["file:///x"],
    ["data:text/html,x"],
    ["ftp://example.com/"],
    ["http://user:pw@example.com/"],
    ["/relative"],
    [42],
    [undefined],
    ["http://example.com/" + "a".repeat(8 * 1024)],
    // Under the raw bound, over it once percent-encoded into the published href.
    ["http://example.com/" + "é".repeat(3000)],
  ])("drops %s without failing", (raw) => {
    expect(ask(new OpenUrlRequests(), raw)).toBeUndefined();
  });

  it("drops a frame with no payload", () => {
    expect(new OpenUrlRequests().request("web", 1, frame(undefined), WEB)).toBeUndefined();
  });
});

describe("bounding requests", () => {
  it("publishes a URL once per generation and again in the next", () => {
    const r = new OpenUrlRequests();
    expect(ask(r, "http://localhost:8080/", 1)).toBeDefined();
    expect(ask(r, "http://localhost:8080/", 1)).toBeUndefined();
    expect(ask(r, "http://localhost:8080/", 2)).toBeDefined();
  });

  it("publishes at most 16 distinct requests per generation, per app", () => {
    const r = new OpenUrlRequests();
    const published = (app: string) =>
      Array.from({ length: 1000 }, (_, i) => ask(r, `https://e.example/${i}`, 1, app)).filter(Boolean);
    expect(published("web")).toHaveLength(16);
    expect(published("api")).toHaveLength(16);
  });
});
