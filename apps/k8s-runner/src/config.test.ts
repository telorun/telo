import { describe, expect, it } from "vitest";

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
});
