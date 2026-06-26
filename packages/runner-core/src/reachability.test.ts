import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { ReachabilityState } from "./contract.js";
import { watchReachability } from "./reachability.js";

const servers: net.Server[] = [];

function listen(port = 0): Promise<{ port: number; server: net.Server }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    servers.push(server);
    server.listen(port, "127.0.0.1", () => {
      resolve({ port: (server.address() as net.AddressInfo).port, server });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  for (const s of servers) s.close();
  servers.length = 0;
});

// Short windows so the suite is fast; real defaults are seconds.
const fast = { timeoutMs: 120, intervalMs: 20, recheckIntervalMs: 20, connectTimeoutMs: 50 };

describe("watchReachability", () => {
  it("reports checking then reachable for a live port", async () => {
    const { port } = await listen();
    const states: ReachabilityState[] = [];
    await watchReachability({
      host: "127.0.0.1",
      ports: [port],
      onState: (_p, s) => states.push(s),
      signal: new AbortController().signal,
      ...fast,
    });
    expect(states[0]).toBe("checking");
    expect(states.at(-1)).toBe("reachable");
  });

  it("reports unreachable after the timeout when nothing listens", async () => {
    const { port, server } = await listen();
    server.close(); // free the port → connections are refused
    const states: ReachabilityState[] = [];
    const controller = new AbortController();
    const run = watchReachability({
      host: "127.0.0.1",
      ports: [port],
      onState: (_p, s) => states.push(s),
      signal: controller.signal,
      ...fast,
    });
    await sleep(300);
    controller.abort();
    await run;
    expect(states[0]).toBe("checking");
    expect(states).toContain("unreachable");
  });

  it("flips back to reachable when the port recovers", async () => {
    const { port, server } = await listen();
    server.close();
    const states: ReachabilityState[] = [];
    const run = watchReachability({
      host: "127.0.0.1",
      ports: [port],
      onState: (_p, s) => states.push(s),
      signal: new AbortController().signal,
      ...fast,
    });
    await sleep(200); // past the timeout → unreachable
    await listen(port); // bind the same port → recovers
    await run; // resolves once reachable
    expect(states).toContain("unreachable");
    expect(states.at(-1)).toBe("reachable");
  });
});
