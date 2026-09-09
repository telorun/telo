import { describe, expect, it } from "vitest";

import type { PortMapping } from "@telorun/runner-core";

import type { K8sRunnerConfig } from "../../config.js";
import type { KubeClient } from "../client.js";
import { buildSessionIngress, createIngressRouter } from "./ingress-router.js";
import { endpointsFor } from "./session-endpoints.js";

const config = {
  sessionNamespace: "telo-sessions",
  sessionRouting: {
    mode: "ingress",
    baseDomain: "telo.run",
    ingressClassName: "nginx",
    routeReadyTimeoutMs: 60_000,
  },
  managedByLabel: "telo-k8s-runner",
} as K8sRunnerConfig;

const sessionId = "hzyayvabgyvz";
const ports: PortMapping[] = [
  { port: 8080, protocol: "tcp" },
  { port: 9090, protocol: "tcp" },
  { port: 5000, protocol: "udp" },
];

function withRouting(patch: Partial<K8sRunnerConfig["sessionRouting"]>): K8sRunnerConfig {
  return { ...config, sessionRouting: { ...config.sessionRouting, ...patch } } as K8sRunnerConfig;
}

describe("endpointsFor", () => {
  it("gives every tcp port a <port>-<id>.<domain> host + url, udp host-less", () => {
    expect(endpointsFor(config, sessionId, ports, true)).toEqual([
      {
        host: `8080-${sessionId}.telo.run`,
        port: 8080,
        protocol: "tcp",
        url: `https://8080-${sessionId}.telo.run`,
      },
      {
        host: `9090-${sessionId}.telo.run`,
        port: 9090,
        protocol: "tcp",
        url: `https://9090-${sessionId}.telo.run`,
      },
      { host: "", port: 5000, protocol: "udp" },
    ]);
  });

  it("leaves hosts blank when no routing base domain is configured", () => {
    expect(endpointsFor(withRouting({ baseDomain: undefined }), sessionId, ports, true)).toEqual([
      { host: "", port: 8080, protocol: "tcp" },
      { host: "", port: 9090, protocol: "tcp" },
      { host: "", port: 5000, protocol: "udp" },
    ]);
  });

  it("advertises no url when nothing publishes routes, even with a base domain set", () => {
    // `SESSION_ROUTING_MODE=none` with a domain configured is documented and
    // valid. Keying on the domain alone handed the editor a URL nothing serves,
    // and the route watch never runs in that mode — so no event said so either.
    expect(endpointsFor(withRouting({ mode: "none" }), sessionId, ports, false)).toEqual([
      { host: "", port: 8080, protocol: "tcp" },
      { host: "", port: 9090, protocol: "tcp" },
      { host: "", port: 5000, protocol: "udp" },
    ]);
  });

  it("keeps the host scheme identical whatever layer routes it", () => {
    const viaGateway = withRouting({ mode: "gateway", gateway: { name: "gw", namespace: "gw-ns" } });
    expect(endpointsFor(viaGateway, sessionId, ports, true)).toEqual(
      endpointsFor(config, sessionId, ports, true),
    );
  });
});

describe("buildSessionIngress", () => {
  it("emits one rule per tcp port to the matching service port", () => {
    const { ingress, hosts } = buildSessionIngress(
      config,
      sessionId,
      `telo-run-${sessionId}`,
      "pod",
      "uid",
      ports,
    );
    expect(hosts).toEqual([`8080-${sessionId}.telo.run`, `9090-${sessionId}.telo.run`]);
    expect(ingress.spec?.ingressClassName).toBe("nginx");
    expect(ingress.spec?.rules).toEqual([
      {
        host: `8080-${sessionId}.telo.run`,
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: { service: { name: `telo-run-${sessionId}`, port: { number: 8080 } } },
            },
          ],
        },
      },
      {
        host: `9090-${sessionId}.telo.run`,
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: { service: { name: `telo-run-${sessionId}`, port: { number: 9090 } } },
            },
          ],
        },
      },
    ]);
  });

  it("produces no rules when there are no tcp ports", () => {
    const { ingress, hosts } = buildSessionIngress(
      config,
      sessionId,
      `telo-run-${sessionId}`,
      "pod",
      "uid",
      [{ port: 5000, protocol: "udp" }],
    );
    expect(hosts).toEqual([]);
    expect(ingress.spec?.rules).toEqual([]);
  });

  it("omits the tls block when no tls secret is configured", () => {
    const { ingress } = buildSessionIngress(
      config,
      sessionId,
      `telo-run-${sessionId}`,
      "pod",
      "uid",
      ports,
    );
    expect(ingress.spec?.tls).toBeUndefined();
  });

  it("presents the configured tls secret for every tcp host", () => {
    const { ingress } = buildSessionIngress(
      withRouting({ tlsSecretName: "telo-origin-tls" }),
      sessionId,
      `telo-run-${sessionId}`,
      "pod",
      "uid",
      ports,
    );
    expect(ingress.spec?.tls).toEqual([
      {
        hosts: [`8080-${sessionId}.telo.run`, `9090-${sessionId}.telo.run`],
        secretName: "telo-origin-tls",
      },
    ]);
  });

  it("omits the tls block when there are no tcp hosts to secure", () => {
    const { ingress } = buildSessionIngress(
      withRouting({ tlsSecretName: "telo-origin-tls" }),
      sessionId,
      `telo-run-${sessionId}`,
      "pod",
      "uid",
      [{ port: 5000, protocol: "udp" }],
    );
    expect(ingress.spec?.tls).toBeUndefined();
  });

  it("carries the session label and the pod ownerReference every routing object does", () => {
    const { ingress } = buildSessionIngress(
      config,
      sessionId,
      `telo-run-${sessionId}`,
      "pod",
      "uid",
      ports,
    );
    expect(ingress.metadata?.labels?.["telo.run/session-id"]).toBe(sessionId);
    expect(ingress.metadata?.ownerReferences?.[0]).toMatchObject({ kind: "Pod", name: "pod" });
  });
});

describe("createIngressRouter.publish", () => {
  function fakeKube() {
    const rec = { created: 0, deleted: [] as string[] };
    const kube = {
      networking: {
        createNamespacedIngress: async () => {
          rec.created += 1;
          return {};
        },
        deleteNamespacedIngress: async ({ name }: { name: string }) => {
          rec.deleted.push(name);
          return {};
        },
      },
    } as unknown as KubeClient;
    return { kube, rec };
  }

  const args = {
    sessionId,
    serviceName: `telo-run-${sessionId}`,
    podName: "pod",
    podUid: "uid",
  };

  it("deletes the session Ingress when a reload leaves no routable port", async () => {
    // Returning early left the previous Ingress serving a port nothing listens
    // on — the drop-all case the per-port gateway cleanup already handled.
    const { kube, rec } = fakeKube();
    const routes = await createIngressRouter(kube, config).publish({
      ...args,
      ports: [{ port: 5000, protocol: "udp" }],
    });
    expect(routes).toEqual([]);
    expect(rec.created).toBe(0);
    expect(rec.deleted).toEqual([`telo-run-${sessionId}`]);
  });

  it("treats an already-absent Ingress as nothing to delete", async () => {
    const kube = {
      networking: {
        deleteNamespacedIngress: async () => {
          throw Object.assign(new Error("not found"), { code: 404 });
        },
      },
    } as unknown as KubeClient;
    await expect(
      createIngressRouter(kube, config).publish({ ...args, ports: [] }),
    ).resolves.toEqual([]);
  });
});
