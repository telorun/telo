import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadK8sRunnerConfig } from "./config.js";

const BASE_ENV = {
  RUNNER_SUPERVISOR_IMAGE: "telorun/k8s-runner:test",
  RUNNER_STATE_DIR: "/var/lib/telo-runner",
};

describe("k8s runner config", () => {
  it("requires a state directory for the default SQLite session store", () => {
    expect(() => loadK8sRunnerConfig({ RUNNER_SUPERVISOR_IMAGE: BASE_ENV.RUNNER_SUPERVISOR_IMAGE })).toThrow(
      /RUNNER_STATE_DIR is required with RUNNER_SESSION_STORE=sqlite/,
    );
  });

  it("reads each session's storage size and class, defaulting to 5Gi on the cluster's default class", () => {
    expect(loadK8sRunnerConfig(BASE_ENV).sessionStorage).toEqual({ size: "5Gi", storageClassName: undefined });
    expect(
      loadK8sRunnerConfig({
        ...BASE_ENV,
        RUNNER_SESSION_STORAGE_SIZE: "500Mi",
        RUNNER_SESSION_STORAGE_CLASS: "fast-ssd",
      }).sessionStorage,
    ).toEqual({ size: "500Mi", storageClassName: "fast-ssd" });
  });

  it("refuses a storage size or class Kubernetes would not accept", () => {
    expect(() => loadK8sRunnerConfig({ ...BASE_ENV, RUNNER_SESSION_STORAGE_SIZE: "5 GB" })).toThrow(
      "RUNNER_SESSION_STORAGE_SIZE must be a positive Kubernetes storage quantity such as 5Gi or 500Mi, got '5 GB'.",
    );
    expect(() => loadK8sRunnerConfig({ ...BASE_ENV, RUNNER_SESSION_STORAGE_SIZE: "0Gi" })).toThrow(
      /RUNNER_SESSION_STORAGE_SIZE must be a positive/,
    );
    expect(() => loadK8sRunnerConfig({ ...BASE_ENV, RUNNER_SESSION_STORAGE_CLASS: "Fast_SSD" })).toThrow(
      /RUNNER_SESSION_STORAGE_CLASS must be a StorageClass name/,
    );
  });

  it("requires the runner's own image, which every session pod copies the supervisor from", () => {
    expect(() => loadK8sRunnerConfig({ RUNNER_STATE_DIR: BASE_ENV.RUNNER_STATE_DIR })).toThrow(
      /RUNNER_SUPERVISOR_IMAGE is required/,
    );
    expect(loadK8sRunnerConfig(BASE_ENV).supervisorImage).toBe("telorun/k8s-runner:test");
  });

  it("refuses to boot with a variable the bundle fetch used, saying it is gone", () => {
    expect(() => loadK8sRunnerConfig({ ...BASE_ENV, RUNNER_SELF_URL: "http://runner:8062" })).toThrow(
      /^RUNNER_SELF_URL is no longer read and must be unset: .*RUNNER_INTERNAL_URL/,
    );
    expect(() => loadK8sRunnerConfig({ ...BASE_ENV, RUNNER_INIT_IMAGE: "busybox:stable" })).toThrow(
      /^RUNNER_INIT_IMAGE is no longer read and must be unset/,
    );
  });

  it("refuses to boot with a variable a configuration file replaced, naming the key to set", () => {
    expect(() =>
      loadK8sRunnerConfig({ ...BASE_ENV, RUNNER_MAX_CPU: "500m", AGENT_ENV: "{}", RUNNER_BASE_IMAGE_REPO: "x/y" }),
    ).toThrow(
      "this runner reads these settings from its configuration files, so the variables must be unset:\n" +
        "  RUNNER_MAX_CPU: set `resources.limits.cpu` in the session file (SESSION_CONFIG_FILE).\n" +
        "  RUNNER_BASE_IMAGE_REPO: set `baseImages.repository` in the session file (SESSION_CONFIG_FILE).\n" +
        "  AGENT_ENV: set `env` in the agent file (AGENT_CONFIG_FILE).\n" +
        "A secret value of the agent's env is listed by name in `secretEnv` and read from AGENT_SECRET_<NAME>.",
    );
  });
});

describe("the configuration files", () => {
  const dir = mkdtempSync(join(tmpdir(), "k8s-runner-config-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let count = 0;
  const file = (text: string): string => {
    const path = join(dir, `${count++}.yaml`);
    writeFileSync(path, text);
    return path;
  };
  const withSession = (text: string, env: NodeJS.ProcessEnv = {}) =>
    loadK8sRunnerConfig({ ...BASE_ENV, ...env, SESSION_CONFIG_FILE: file(text) });

  it("size every container with no CPU limit when none is configured", () => {
    const config = loadK8sRunnerConfig(BASE_ENV);
    const unsized = {
      limits: { memory: "512Mi", ephemeralStorage: "1Gi" },
      requests: { cpu: "500m", memory: "512Mi" },
    };
    expect(config.sessionResources).toEqual(unsized);
    expect(config.agentResources).toEqual(unsized);
    expect(config.sessionContainerResources).toEqual(unsized);
    expect(config.agent).toBeUndefined();
  });

  it("read the session file's resources, containers and base images", () => {
    const config = withSession(
      [
        "resources:",
        "  limits: { cpu: 1, memory: 1Gi }",
        "  requests: { cpu: 250m }",
        "containers:",
        "  enabled: true",
        "  max: 2",
        "  resources: { limits: { ephemeral-storage: 2Gi } }",
        "baseImages:",
        "  enabled: false",
        "  include: '^0\\.'",
        "  exclude: ''",
        "  refreshSeconds: 60",
      ].join("\n"),
      { RUNNER_INTERNAL_URL: "http://runner:8062/" },
    );
    expect(config.sessionResources).toEqual({
      limits: { cpu: "1", memory: "1Gi", ephemeralStorage: "1Gi" },
      requests: { cpu: "250m", memory: "512Mi" },
    });
    expect(config.sessionContainers).toEqual({ enabled: true, max: 2, internalUrl: "http://runner:8062" });
    expect(config.sessionContainerResources.limits).toEqual({ memory: "512Mi", ephemeralStorage: "2Gi" });
    expect(config.baseImageCatalog).toMatchObject({
      enabled: false,
      repository: "telorun/node",
      filter: { include: [/^0\./], exclude: undefined },
      refreshIntervalMs: 60_000,
    });
  });

  it("refuse a key they do not read, naming the file and the key", () => {
    const path = file("resources:\n  limit: { cpu: 1 }\n");
    expect(() => loadK8sRunnerConfig({ ...BASE_ENV, SESSION_CONFIG_FILE: path })).toThrow(
      `\`resources.limit\` in ${path} is not a setting this runner reads (expected one of: limits, requests).`,
    );
  });

  it("refuse a malformed quantity and a request above its limit", () => {
    expect(() => withSession("resources: { limits: { memory: lots } }")).toThrow(
      /^`resources.limits.memory` in \S+ must be a positive Kubernetes quantity such as 512Mi or 1Gi, got 'lots'\.$/,
    );
    for (const bad of ["0x10", "512 Mi"]) {
      expect(() => withSession(`resources: { limits: { memory: "${bad}" } }`)).toThrow(
        new RegExp(`^\`resources.limits.memory\` in \\S+ must be a positive Kubernetes quantity.*got '${bad}'\\.$`),
      );
    }
    expect(() => withSession("containers: { resources: { limits: { cpu: 250m } } }")).toThrow(
      /^`containers.resources.requests.cpu` in \S+ is 500m, above its limit 250m \(`containers.resources.limits.cpu` in \S+\): a request may not exceed its limit\.$/,
    );
  });

  it("need the runner's internal URL to turn session containers on, naming the setting", () => {
    expect(() => withSession("containers: { enabled: true }")).toThrow(
      /^`containers.enabled` in \S+ is on, so RUNNER_INTERNAL_URL is required/,
    );
  });

  it("read the agent file, its resources apart and each secret from its variable", () => {
    const config = loadK8sRunnerConfig({
      ...BASE_ENV,
      AGENT_SECRET_API_KEY: "sk-secret",
      AGENT_CONFIG_FILE: file(
        [
          "moduleRef: oci://ghcr.io/telorun/authoring-agent@1.0.0",
          "port: 8080",
          "env: { MODEL: opus }",
          "secretEnv: [API_KEY]",
          "resources: { limits: { memory: 1Gi }, requests: { memory: 1Gi } }",
        ].join("\n"),
      ),
    });
    expect(config.agent).toMatchObject({
      source: { kind: "module", ref: "oci://ghcr.io/telorun/authoring-agent@1.0.0" },
      port: 8080,
      env: { MODEL: "opus", API_KEY: "sk-secret" },
    });
    expect(config.agentResources).toEqual({
      limits: { memory: "1Gi", ephemeralStorage: "1Gi" },
      requests: { cpu: "500m", memory: "1Gi" },
    });
  });

  it("refuse an agent module on a host path, which a pod cannot read", () => {
    const path = file("moduleRef: /srv/agent\nport: 8080\n");
    expect(() => loadK8sRunnerConfig({ ...BASE_ENV, AGENT_CONFIG_FILE: path })).toThrow(
      `\`moduleRef\` in ${path} is a host path, which a Kubernetes pod cannot read — use an oci:// reference.`,
    );
  });
});
