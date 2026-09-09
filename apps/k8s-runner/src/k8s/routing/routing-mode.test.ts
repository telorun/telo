import { describe, expect, it } from "vitest";

import type { K8sRunnerConfig, SessionRoutingConfig } from "../../config.js";
import { RunnerConfigError } from "../../config.js";
import type { KubeClient } from "../client.js";
import { resolveRouting } from "./routing-mode.js";

/** A cluster: which Gateway API versions it serves, and how many IngressClasses
 *  exist. Those are the two signals `auto` may fall back on. */
function fakeKube(cluster: {
  gatewayVersions?: string[];
  ingressClasses?: number;
  defaultIngressClass?: boolean;
}): KubeClient {
  return {
    apis: {
      getAPIVersions: async () => ({
        groups: cluster.gatewayVersions
          ? [
              {
                name: "gateway.networking.k8s.io",
                versions: cluster.gatewayVersions.map((version) => ({ version })),
                preferredVersion: { version: cluster.gatewayVersions[0] },
              },
            ]
          : [],
      }),
    },
    networking: {
      listIngressClass: async () => ({
        items: Array.from({ length: cluster.ingressClasses ?? 0 }, (_unused, i) => ({
          metadata:
            cluster.defaultIngressClass && i === 0
              ? { annotations: { "ingressclass.kubernetes.io/is-default-class": "true" } }
              : {},
        })),
      }),
    },
  } as unknown as KubeClient;
}

function configWith(routing: Partial<SessionRoutingConfig>): K8sRunnerConfig {
  return {
    sessionNamespace: "telo-sessions",
    sessionRouting: {
      mode: "auto",
      baseDomain: "telo.run",
      routeReadyTimeoutMs: 60_000,
      ...routing,
    },
  } as K8sRunnerConfig;
}

describe("resolveRouting — logs-only", () => {
  it("is none when the mode says so", async () => {
    const resolved = await resolveRouting(fakeKube({}), configWith({ mode: "none" }));
    expect(resolved).toMatchObject({ layer: "none" });
  });

  it("is none without a base domain, whatever the mode — no domain, no constructible host", async () => {
    const resolved = await resolveRouting(
      fakeKube({ ingressClasses: 1 }),
      configWith({ mode: "ingress", baseDomain: undefined }),
    );
    expect(resolved).toMatchObject({ layer: "none" });
  });
});

describe("resolveRouting — explicit modes", () => {
  it("takes ingress at its word", async () => {
    const resolved = await resolveRouting(
      fakeKube({ gatewayVersions: ["v1"], ingressClasses: 0 }),
      configWith({ mode: "ingress" }),
    );
    expect(resolved).toEqual({ layer: "ingress" });
  });

  it("prefers the GA Gateway API version when several are served", async () => {
    const resolved = await resolveRouting(
      fakeKube({ gatewayVersions: ["v1beta1", "v1"] }),
      configWith({ mode: "gateway", gateway: { name: "gw", namespace: "gw-ns" } }),
    );
    expect(resolved).toEqual({ layer: "gateway", apiVersion: "v1" });
  });

  it("falls back to v1beta1 where that is all the cluster serves", async () => {
    const resolved = await resolveRouting(
      fakeKube({ gatewayVersions: ["v1beta1"] }),
      configWith({ mode: "gateway", gateway: { name: "gw", namespace: "gw-ns" } }),
    );
    expect(resolved).toEqual({ layer: "gateway", apiVersion: "v1beta1" });
  });

  it("refuses gateway mode on a cluster that does not serve the API", async () => {
    await expect(
      resolveRouting(
        fakeKube({ ingressClasses: 1 }),
        configWith({ mode: "gateway", gateway: { name: "gw", namespace: "gw-ns" } }),
      ),
    ).rejects.toBeInstanceOf(RunnerConfigError);
  });
});

describe("resolveRouting — auto", () => {
  it("resolves on the CONFIGURED target before the installed one: a named Gateway wins even where Ingress is usable", async () => {
    const resolved = await resolveRouting(
      fakeKube({ gatewayVersions: ["v1"], ingressClasses: 3 }),
      configWith({ gateway: { name: "gw", namespace: "gw-ns" } }),
    );
    expect(resolved).toEqual({ layer: "gateway", apiVersion: "v1" });
  });

  it("takes a configured IngressClass even where the Gateway API is installed — CRDs present is not intent", async () => {
    const resolved = await resolveRouting(
      fakeKube({ gatewayVersions: ["v1"], ingressClasses: 1 }),
      configWith({ ingressClassName: "nginx" }),
    );
    expect(resolved).toEqual({ layer: "ingress" });
  });

  it("picks the only usable layer when nothing is configured", async () => {
    const resolved = await resolveRouting(fakeKube({ ingressClasses: 1 }), configWith({}));
    expect(resolved).toEqual({ layer: "ingress" });
  });

  it("refuses when both layers are usable and nothing says which", async () => {
    await expect(
      resolveRouting(fakeKube({ gatewayVersions: ["v1"], ingressClasses: 2 }), configWith({})),
    ).rejects.toThrow(/cannot choose/);
  });

  it("refuses a Gateway-only cluster with no Gateway named — picking one would fail as silently as publishing none", async () => {
    await expect(
      resolveRouting(fakeKube({ gatewayVersions: ["v1"] }), configWith({})),
    ).rejects.toThrow(/SESSION_GATEWAY_NAME/);
  });

  it("refuses a cluster with no usable layer at all rather than publishing into the void", async () => {
    await expect(resolveRouting(fakeKube({}), configWith({}))).rejects.toThrow(
      /no usable routing layer/,
    );
  });

  it("does not read an IngressClass count as usable when the API refused the list", async () => {
    const kube = {
      apis: { getAPIVersions: async () => ({ groups: [] }) },
      networking: {
        listIngressClass: async () => {
          throw new Error("forbidden");
        },
      },
    } as unknown as KubeClient;
    // A permission failure must not be reported as a fact about the cluster:
    // "no IngressClass exists" sends an operator to install a controller they
    // already have.
    await expect(resolveRouting(kube, configWith({}))).rejects.toThrow(
      /listing IngressClasses failed/,
    );
    await expect(resolveRouting(kube, configWith({}))).rejects.not.toThrow(
      /no IngressClass exists/,
    );
  });

  it("takes a DEFAULT-marked IngressClass as intent, even beside the Gateway API", async () => {
    // The cluster has nominated where an unqualified Ingress goes, and
    // unqualified is what this runner creates. Without this, every cluster
    // shipping the Gateway CRDs beside a default ingress controller would
    // refuse to boot after the upgrade, having worked before it.
    const resolved = await resolveRouting(
      fakeKube({ gatewayVersions: ["v1"], ingressClasses: 1, defaultIngressClass: true }),
      configWith({}),
    );
    expect(resolved).toEqual({ layer: "ingress" });
  });

  it("still refuses when several classes exist and none is marked default", async () => {
    await expect(
      resolveRouting(
        fakeKube({ gatewayVersions: ["v1"], ingressClasses: 2, defaultIngressClass: false }),
        configWith({}),
      ),
    ).rejects.toThrow(/cannot choose/);
  });

  it("lets a named Gateway win over a default IngressClass — the more specific configuration", async () => {
    const resolved = await resolveRouting(
      fakeKube({ gatewayVersions: ["v1"], ingressClasses: 1, defaultIngressClass: true }),
      configWith({ gateway: { name: "gw", namespace: "gw-ns" } }),
    );
    expect(resolved).toEqual({ layer: "gateway", apiVersion: "v1" });
  });
});

describe("resolveRouting — origin TLS against the RESOLVED layer", () => {
  it("refuses an ingress TLS secret when auto resolves to Gateway API", async () => {
    // The config-time check only sees `mode`, and `auto` is the default: a named
    // Gateway decides the layer later, so this combination booted, routed on
    // Gateway API and ignored the certificate — plaintext origin traffic under a
    // configuration that reads as TLS-configured.
    await expect(
      resolveRouting(
        fakeKube({ gatewayVersions: ["v1"] }),
        configWith({
          gateway: { name: "gw", namespace: "gw-ns" },
          tlsSecretName: "origin-tls",
        }),
      ),
    ).rejects.toThrow(/belongs to the Gateway listener/);
  });

  it("allows an ingress TLS secret when the resolved layer is ingress", async () => {
    const resolved = await resolveRouting(
      fakeKube({ ingressClasses: 1 }),
      configWith({ ingressClassName: "nginx", tlsSecretName: "origin-tls" }),
    );
    expect(resolved).toEqual({ layer: "ingress" });
  });
});
