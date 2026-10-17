import { describe, expect, it } from "vitest";

import type { PortMapping } from "@telorun/runner-core";

import type { K8sRunnerConfig } from "../../config.js";
import type { KubeClient } from "../client.js";
import { createGatewayRouter } from "./gateway-router.js";
import { buildSessionIngress } from "./ingress-router.js";
import { hostsForPort, publicUrlTemplateEnv } from "./session-endpoints.js";

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

/** A port the kernel announced two public addresses on: one the templates
 *  derived, one the session's own env supplied. */
const port: PortMapping = {
  port: 8080,
  protocol: "tcp",
  publicHosts: [`8080-${sessionId}.telo.run`, `admin--8080-${sessionId}.telo.run`, "shop.example"],
};

describe("a routed session's public addresses", () => {
  it("are answered from the session's own host scheme, the secondary only where announcements are routed", () => {
    expect(publicUrlTemplateEnv(config, sessionId, true)).toEqual({
      TELO_HOST_PUBLIC_URL_TEMPLATE: `https://{port}-${sessionId}.telo.run`,
      TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE: `https://{label}--{port}-${sessionId}.telo.run`,
    });
    expect(publicUrlTemplateEnv(config, sessionId, false)).toEqual({
      TELO_HOST_PUBLIC_URL_TEMPLATE: `https://{port}-${sessionId}.telo.run`,
    });
  });

  it("route each derived host beside the port's own, and no host outside the session's suffix", () => {
    expect(hostsForPort(config, sessionId, port, [port])).toEqual([
      `8080-${sessionId}.telo.run`,
      `admin--8080-${sessionId}.telo.run`,
    ]);
  });

  it("never route another port's own host, so one hostname reaches one port", () => {
    const other: PortMapping = { port: 8081, protocol: "tcp" };
    const announcing: PortMapping = {
      ...port,
      publicHosts: [`8081-${sessionId}.telo.run`, `9000-${sessionId}.telo.run`, `admin--8080-${sessionId}.telo.run`],
    };
    expect(hostsForPort(config, sessionId, announcing, [announcing, other])).toEqual([
      `8080-${sessionId}.telo.run`,
      `admin--8080-${sessionId}.telo.run`,
    ]);
  });

  it("are listed on the port's HTTPRoute", async () => {
    const created: Record<string, unknown>[] = [];
    const kube = {
      custom: {
        createNamespacedCustomObject: async ({ body }: { body: Record<string, unknown> }) => {
          created.push(body);
          return body;
        },
        listNamespacedCustomObject: async () => ({ items: [] }),
        deleteNamespacedCustomObject: async () => ({}),
        getNamespacedCustomObject: async () => {
          throw Object.assign(new Error("not found"), { code: 404 });
        },
        replaceNamespacedCustomObject: async ({ body }: { body: Record<string, unknown> }) => body,
      },
    } as unknown as KubeClient;
    await createGatewayRouter(kube, config, "v1").publish({
      sessionId,
      serviceName: `telo-run-${sessionId}`,
      podName: "pod",
      podUid: "uid",
      ports: [port],
    });
    expect((created[0]!.spec as { hostnames: string[] }).hostnames).toEqual([
      `8080-${sessionId}.telo.run`,
      `admin--8080-${sessionId}.telo.run`,
    ]);
  });

  it("each get an Ingress rule to the port", () => {
    const { hosts } = buildSessionIngress(config, sessionId, `telo-run-${sessionId}`, "pod", "uid", [port]);
    expect(hosts).toEqual([`8080-${sessionId}.telo.run`, `admin--8080-${sessionId}.telo.run`]);
  });
});
