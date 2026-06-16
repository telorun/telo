import { describe, expect, it } from "vitest";

import type { PortMapping } from "@telorun/runner-core";

import type { K8sRunnerConfig } from "../config.js";
import { buildSessionIngress, endpointsFor } from "./ingress.js";

const config = {
  sessionNamespace: "telo-sessions",
  ingressBaseDomain: "telo.run",
  ingressClassName: "nginx",
  managedByLabel: "telo-k8s-runner",
} as K8sRunnerConfig;

const sessionId = "hzyayvabgyvz";
const ports: PortMapping[] = [
  { port: 8080, protocol: "tcp" },
  { port: 9090, protocol: "tcp" },
  { port: 5000, protocol: "udp" },
];

describe("endpointsFor", () => {
  it("gives every tcp port a <port>-<id>.<domain> host + url, udp host-less", () => {
    expect(endpointsFor(config, sessionId, ports)).toEqual([
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

  it("leaves hosts blank when no ingress base domain is configured", () => {
    const logsOnly = { ...config, ingressBaseDomain: undefined } as K8sRunnerConfig;
    expect(endpointsFor(logsOnly, sessionId, ports)).toEqual([
      { host: "", port: 8080, protocol: "tcp" },
      { host: "", port: 9090, protocol: "tcp" },
      { host: "", port: 5000, protocol: "udp" },
    ]);
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
});
