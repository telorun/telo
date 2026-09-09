import { describe, expect, it } from "vitest";

import type { PortMapping } from "@telorun/runner-core";

import type { K8sRunnerConfig } from "../../config.js";
import type { KubeClient } from "../client.js";
import { createGatewayRouter } from "./gateway-router.js";

const sessionId = "hzyayvabgyvz";

const config = {
  sessionNamespace: "telo-sessions",
  managedByLabel: "telo-k8s-runner",
  sessionRouting: {
    mode: "gateway",
    baseDomain: "telo.run",
    routeReadyTimeoutMs: 60_000,
    gateway: { name: "public", namespace: "gateway-system" },
  },
} as K8sRunnerConfig;

interface Recorded {
  created: Record<string, unknown>[];
  deleted: string[];
}

/** A KubeClient stub carrying only what the gateway router touches. */
function fakeKube(opts: {
  existing?: { metadata?: { name?: string } }[];
  getResult?: (name: string) => unknown;
} = {}): { kube: KubeClient; rec: Recorded } {
  const rec: Recorded = { created: [], deleted: [] };
  const kube = {
    custom: {
      createNamespacedCustomObject: async ({ body }: { body: Record<string, unknown> }) => {
        rec.created.push(body);
        return body;
      },
      listNamespacedCustomObject: async () => ({ items: opts.existing ?? [] }),
      deleteNamespacedCustomObject: async ({ name }: { name: string }) => {
        rec.deleted.push(name);
        return {};
      },
      getNamespacedCustomObject: async ({ name }: { name: string }) => {
        if (opts.getResult) return opts.getResult(name);
        throw Object.assign(new Error("not found"), { code: 404 });
      },
      replaceNamespacedCustomObject: async ({ body }: { body: Record<string, unknown> }) => body,
    },
  } as unknown as KubeClient;
  return { kube, rec };
}

const ports: PortMapping[] = [
  { port: 8080, protocol: "tcp" },
  { port: 9090, protocol: "tcp" },
  { port: 5000, protocol: "udp" },
];

const publishArgs = {
  sessionId,
  serviceName: `telo-run-${sessionId}`,
  podName: "pod",
  podUid: "uid",
  ports,
};

describe("createGatewayRouter.publish", () => {
  it("creates ONE HTTPRoute PER PORT — hostnames are route-scoped, so a shared route would collapse every host onto one backend", async () => {
    const { kube, rec } = fakeKube();
    const routes = await createGatewayRouter(kube, config, "v1").publish(publishArgs);

    expect(rec.created).toHaveLength(2);
    for (const body of rec.created) {
      const spec = body.spec as { hostnames: string[]; rules: { backendRefs: unknown[] }[] };
      expect(spec.hostnames).toHaveLength(1);
      expect(spec.rules).toHaveLength(1);
      expect(spec.rules[0].backendRefs).toHaveLength(1);
    }
    // Each host is bound to its own port's backend, never a sibling's.
    const pairs = rec.created.map((b) => {
      const spec = b.spec as {
        hostnames: string[];
        rules: { backendRefs: { name: string; port: number }[] }[];
      };
      return [spec.hostnames[0], spec.rules[0].backendRefs[0].port];
    });
    expect(pairs).toEqual([
      [`8080-${sessionId}.telo.run`, 8080],
      [`9090-${sessionId}.telo.run`, 9090],
    ]);
    expect(routes).toEqual([
      { host: `8080-${sessionId}.telo.run`, port: 8080 },
      { host: `9090-${sessionId}.telo.run`, port: 9090 },
    ]);
  });

  it("skips udp ports — they are not HTTP-routable", async () => {
    const { kube, rec } = fakeKube();
    await createGatewayRouter(kube, config, "v1").publish({
      ...publishArgs,
      ports: [{ port: 5000, protocol: "udp" }],
    });
    expect(rec.created).toEqual([]);
  });

  it("attaches to the configured Gateway, carrying the listener when one is named", async () => {
    const { kube, rec } = fakeKube();
    const sectioned = {
      ...config,
      sessionRouting: {
        ...config.sessionRouting,
        gateway: { name: "public", namespace: "gateway-system", sectionName: "https" },
      },
    } as K8sRunnerConfig;
    await createGatewayRouter(kube, sectioned, "v1").publish({ ...publishArgs, ports: [ports[0]] });
    expect((rec.created[0].spec as { parentRefs: unknown[] }).parentRefs).toEqual([
      {
        group: "gateway.networking.k8s.io",
        kind: "Gateway",
        name: "public",
        namespace: "gateway-system",
        sectionName: "https",
      },
    ]);
  });

  it("deletes the route of a port a reload dropped — one object per port means a stale one keeps routing", async () => {
    const { kube, rec } = fakeKube({
      existing: [
        { metadata: { name: `telo-run-${sessionId}-8080` } },
        { metadata: { name: `telo-run-${sessionId}-9090` } },
      ],
    });
    await createGatewayRouter(kube, config, "v1").publish({
      ...publishArgs,
      ports: [{ port: 8080, protocol: "tcp" }],
    });
    expect(rec.deleted).toEqual([`telo-run-${sessionId}-9090`]);
  });

  it("posts at the served API version", async () => {
    const { kube, rec } = fakeKube();
    await createGatewayRouter(kube, config, "v1beta1").publish({ ...publishArgs, ports: [ports[0]] });
    expect(rec.created[0].apiVersion).toBe("gateway.networking.k8s.io/v1beta1");
  });
});

describe("createGatewayRouter.verdictFor", () => {
  const route = { host: `8080-${sessionId}.telo.run`, port: 8080 };

  function verdict(status: unknown) {
    const { kube } = fakeKube({ getResult: () => ({ status }) });
    return createGatewayRouter(kube, config, "v1").verdictFor(sessionId, route);
  }

  it("is pending while no controller has written status", async () => {
    await expect(verdict(undefined)).resolves.toEqual({ kind: "pending" });
    await expect(verdict({ parents: [] })).resolves.toEqual({ kind: "pending" });
  });

  it("is programmed once a parent accepted and resolved it", async () => {
    await expect(
      verdict({
        parents: [
          {
            conditions: [
              { type: "Accepted", status: "True" },
              { type: "ResolvedRefs", status: "True" },
            ],
          },
        ],
      }),
    ).resolves.toEqual({ kind: "programmed" });
  });

  it("reports the controller's own reason for a refusal — the actionable half", async () => {
    await expect(
      verdict({
        parents: [
          {
            conditions: [
              {
                type: "Accepted",
                status: "False",
                reason: "NotAllowedByListeners",
                message: "no listener admits routes from this namespace",
              },
            ],
          },
        ],
      }),
    ).resolves.toEqual({
      kind: "rejected",
      reason: "NotAllowedByListeners: no listener admits routes from this namespace",
    });
  });

  it("reports an unresolvable backend rather than calling the route programmed", async () => {
    await expect(
      verdict({
        parents: [
          {
            conditions: [
              { type: "Accepted", status: "True" },
              { type: "ResolvedRefs", status: "False", reason: "BackendNotFound" },
            ],
          },
        ],
      }),
    ).resolves.toEqual({ kind: "rejected", reason: "BackendNotFound" });
  });

  it("lets one accepting parent win over a sibling's refusal — traffic arrives either way", async () => {
    await expect(
      verdict({
        parents: [
          { conditions: [{ type: "Accepted", status: "False", reason: "NoMatchingParent" }] },
          {
            conditions: [
              { type: "Accepted", status: "True" },
              { type: "ResolvedRefs", status: "True" },
            ],
          },
        ],
      }),
    ).resolves.toEqual({ kind: "programmed" });
  });

  it("is pending when the object is not visible yet", async () => {
    const { kube } = fakeKube();
    await expect(
      createGatewayRouter(kube, config, "v1").verdictFor(sessionId, route),
    ).resolves.toEqual({ kind: "pending" });
  });
});
