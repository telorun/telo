import { describe, expect, it } from "vitest";

import { loadK8sRunnerConfig } from "../config.js";
import { kubernetesShareRouting } from "./share-routing.js";

const BASE = {
  RUNNER_SUPERVISOR_IMAGE: "telorun/k8s-runner:test",
  RUNNER_STATE_DIR: "/var/lib/telo-runner",
};
const routed = (mode: string, domain?: string) =>
  loadK8sRunnerConfig({
    ...BASE,
    SESSION_ROUTING_MODE: mode,
    ...(mode === "gateway" ? { SESSION_GATEWAY_NAME: "gw" } : {}),
    ...(domain ? { SESSION_ROUTING_BASE_DOMAIN: domain } : {}),
  });

describe("k8s share routing", () => {
  it.each(["ingress", "gateway"])("routes shares under %s with a base domain", (mode) => {
    const routing = kubernetesShareRouting(routed(mode, "telorun.dev"));
    expect(routing?.baseDomain).toBe("telorun.dev");
    expect(routing?.addresses("abc123")).toEqual({
      publicUrlTemplate: "https://{port}-abc123.telorun.dev",
      publicUrlSecondaryTemplate: "https://{label}--{port}-abc123.telorun.dev",
      tunnelUrl: "wss://tunnel.telorun.dev/v1/shares/abc123/tunnel",
    });
  });

  it.each([["auto", "telorun.dev"], ["none", "telorun.dev"], ["ingress", undefined]])(
    "routes none under mode %s with domain %s",
    (mode, domain) => {
      expect(kubernetesShareRouting(routed(mode, domain))).toBeUndefined();
    },
  );
});

describe("shares need a routing layer", () => {
  const postgres = {
    ...BASE,
    RUNNER_SESSION_STORE: "postgres",
    RUNNER_SESSION_STORE_URL: "postgres://x/y",
    RUNNER_IDENTITY_AUDIENCE: "https://runner.example.com",
    RUNNER_IDENTITY_ISSUERS: "https://id.example.com",
  };
  it.each(["auto", "none"])("refuses RUNNER_SHARES under mode %s", (mode) => {
    expect(() =>
      loadK8sRunnerConfig({ ...postgres, RUNNER_SHARES: "1", SESSION_ROUTING_MODE: mode, SESSION_ROUTING_BASE_DOMAIN: "d.dev" }),
    ).toThrow(`RUNNER_SHARES needs SESSION_ROUTING_MODE ingress or gateway, not ${mode}`);
  });
  it("refuses the relay role without a base domain", () => {
    expect(() =>
      loadK8sRunnerConfig({ ...postgres, RUNNER_ROLE: "relay", SESSION_ROUTING_MODE: "ingress" }),
    ).toThrow(/RUNNER_ROLE=relay needs SESSION_ROUTING_BASE_DOMAIN/);
  });
  it("accepts shares over ingress with a base domain", () => {
    expect(
      loadK8sRunnerConfig({ ...postgres, RUNNER_SHARES: "1", SESSION_ROUTING_MODE: "ingress", SESSION_ROUTING_BASE_DOMAIN: "d.dev" }).shares.enabled,
    ).toBe(true);
  });
});
