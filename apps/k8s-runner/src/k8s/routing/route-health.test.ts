import { describe, expect, it } from "vitest";

import type { RouteState } from "@telorun/runner-core";

import { watchRouteHealth } from "./route-health.js";
import type { PublishedRoute, RouteVerdict, SessionRouter } from "./session-router.js";

const routes: PublishedRoute[] = [
  { host: "8080-abc.telo.run", port: 8080 },
  { host: "9090-abc.telo.run", port: 9090 },
];

function router(verdicts: (route: PublishedRoute) => RouteVerdict): SessionRouter {
  return {
    layer: "gateway",
    publish: async () => routes,
    verdictFor: async (_id, route) => verdicts(route),
    unclaimedReason: () => "nobody claimed it",
  };
}

function collect() {
  const seen: Array<{ host: string; state: RouteState; reason?: string }> = [];
  return {
    seen,
    onState: (route: PublishedRoute, state: RouteState, reason?: string) =>
      seen.push({ host: route.host, state, ...(reason ? { reason } : {}) }),
  };
}

describe("watchRouteHealth", () => {
  it("reports pending up front, then programmed per host", async () => {
    const { seen, onState } = collect();
    await watchRouteHealth({
      router: router(() => ({ kind: "programmed" })),
      sessionId: "abc",
      routes,
      onState,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      intervalMs: 1,
    });
    expect(seen).toEqual([
      { host: "8080-abc.telo.run", state: "pending" },
      { host: "9090-abc.telo.run", state: "pending" },
      { host: "8080-abc.telo.run", state: "programmed" },
      { host: "9090-abc.telo.run", state: "programmed" },
    ]);
  });

  it("carries a refusal's reason straight through", async () => {
    const { seen, onState } = collect();
    await watchRouteHealth({
      router: router(() => ({ kind: "rejected", reason: "NotAllowedByListeners" })),
      sessionId: "abc",
      routes: [routes[0]],
      onState,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      intervalMs: 1,
    });
    expect(seen.at(-1)).toEqual({
      host: "8080-abc.telo.run",
      state: "unprogrammed",
      reason: "NotAllowedByListeners",
    });
  });

  it("calls a route that stays pending unprogrammed at the deadline — the silent-404 case", async () => {
    const { seen, onState } = collect();
    await watchRouteHealth({
      router: router(() => ({ kind: "pending" })),
      sessionId: "abc",
      routes: [routes[0]],
      onState,
      signal: new AbortController().signal,
      timeoutMs: 5,
      intervalMs: 1,
    });
    expect(seen.at(-1)).toEqual({
      host: "8080-abc.telo.run",
      state: "unprogrammed",
      reason: "nobody claimed it",
    });
  });

  it("settles each host independently", async () => {
    const { seen, onState } = collect();
    await watchRouteHealth({
      router: router((route) =>
        route.port === 8080 ? { kind: "programmed" } : { kind: "rejected", reason: "no listener" },
      ),
      sessionId: "abc",
      routes,
      onState,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      intervalMs: 1,
    });
    expect(seen.filter((s) => s.state !== "pending")).toEqual([
      { host: "8080-abc.telo.run", state: "programmed" },
      { host: "9090-abc.telo.run", state: "unprogrammed", reason: "no listener" },
    ]);
  });

  it("keeps polling through a transient API error instead of declaring the route dead", async () => {
    let calls = 0;
    const flaky: SessionRouter = {
      layer: "ingress",
      publish: async () => routes,
      verdictFor: async () => {
        calls += 1;
        if (calls < 3) throw new Error("apiserver hiccup");
        return { kind: "programmed" };
      },
      unclaimedReason: () => "nobody claimed it",
    };
    const { seen, onState } = collect();
    await watchRouteHealth({
      router: flaky,
      sessionId: "abc",
      routes: [routes[0]],
      onState,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      intervalMs: 1,
    });
    expect(seen.at(-1)).toEqual({ host: "8080-abc.telo.run", state: "programmed" });
  });

  it("reports the READ failure at the deadline, not the Gateway advice", async () => {
    // A permanent read failure (no RBAC, an unserved API version) polls out the
    // whole deadline. Reporting `unclaimedReason()` there sends an operator to
    // inspect the Gateway when the runner could not read its own object.
    const denied: SessionRouter = {
      layer: "gateway",
      publish: async () => routes,
      verdictFor: async () => {
        throw Object.assign(new Error("httproutes is forbidden"), { code: 403 });
      },
      unclaimedReason: () => "no controller claimed the session HTTPRoute",
    };
    const seenErrors: unknown[] = [];
    const { seen, onState } = collect();
    await watchRouteHealth({
      router: denied,
      sessionId: "abc",
      routes: [routes[0]],
      onState,
      onReadError: (err) => seenErrors.push(err),
      signal: new AbortController().signal,
      timeoutMs: 5,
      intervalMs: 1,
    });
    expect(seen.at(-1)?.state).toBe("unprogrammed");
    expect(seen.at(-1)?.reason).toMatch(/route status could not be read/);
    expect(seen.at(-1)?.reason).not.toMatch(/claimed the session HTTPRoute/);
    // Reported once, not once per poll.
    expect(seenErrors).toHaveLength(1);
  });

  it("does not blame a transient read failure once a verdict was obtained", async () => {
    let calls = 0;
    const flaky: SessionRouter = {
      layer: "gateway",
      publish: async () => routes,
      verdictFor: async () => {
        calls += 1;
        if (calls === 1) throw new Error("apiserver hiccup");
        return { kind: "pending" };
      },
      unclaimedReason: () => "nobody claimed it",
    };
    const { seen, onState } = collect();
    await watchRouteHealth({
      router: flaky,
      sessionId: "abc",
      routes: [routes[0]],
      onState,
      signal: new AbortController().signal,
      timeoutMs: 8,
      intervalMs: 1,
    });
    expect(seen.at(-1)?.reason).toBe("nobody claimed it");
  });

  it("stops on abort without reporting a verdict it never reached", async () => {
    const abort = new AbortController();
    const { seen, onState } = collect();
    abort.abort();
    await watchRouteHealth({
      router: router(() => ({ kind: "pending" })),
      sessionId: "abc",
      routes,
      onState,
      signal: abort.signal,
      timeoutMs: 1_000,
      intervalMs: 1,
    });
    expect(seen.every((s) => s.state === "pending")).toBe(true);
  });

  it("does nothing when nothing was published", async () => {
    const { seen, onState } = collect();
    await watchRouteHealth({
      router: router(() => ({ kind: "programmed" })),
      sessionId: "abc",
      routes: [],
      onState,
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    });
    expect(seen).toEqual([]);
  });
});
