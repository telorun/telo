import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  LOCAL_DOCKER_RUNNER_ID,
  TELO_CLOUD_RUNNER_ID,
  type AppSettings,
} from "../model";
import { normalizeRunnerSettings } from "./runners";

function legacy(overrides: Record<string, unknown>): AppSettings {
  return { registryServers: [], ...overrides } as unknown as AppSettings;
}

describe("normalizeRunnerSettings", () => {
  it("seeds the Telo Cloud runner and keeps it active by default", () => {
    const next = normalizeRunnerSettings({ ...DEFAULT_SETTINGS }, false);
    expect(next.runners.some((r) => r.id === TELO_CLOUD_RUNNER_ID)).toBe(true);
    expect(next.activeRunnerId).toBe(TELO_CLOUD_RUNNER_ID);
  });

  it("adds the local docker runner under Tauri and drops it in the browser", () => {
    const underTauri = normalizeRunnerSettings({ ...DEFAULT_SETTINGS }, true);
    expect(underTauri.runners.some((r) => r.id === LOCAL_DOCKER_RUNNER_ID)).toBe(true);

    const inBrowser = normalizeRunnerSettings(underTauri, false);
    expect(inBrowser.runners.some((r) => r.id === LOCAL_DOCKER_RUNNER_ID)).toBe(false);
  });

  it("migrates legacy docker-api / k8s configs into http-runner instances", () => {
    const migrated = normalizeRunnerSettings(
      legacy({
        activeRunAdapterId: "k8s",
        runAdapterConfig: {
          "docker-api": { baseUrl: "http://localhost:8061", image: "x", pullPolicy: "missing" },
          k8s: { baseUrl: "http://localhost:8062" },
        },
      }),
      false,
    );

    const k8sRunner = migrated.runners.find((r) => r.name === "Kubernetes");
    const dockerRunner = migrated.runners.find((r) => r.name === "Docker");
    expect(k8sRunner?.adapterId).toBe("http-runner");
    expect(dockerRunner?.adapterId).toBe("http-runner");
    // active mapped from the legacy k8s selection.
    expect(migrated.activeRunnerId).toBe(k8sRunner?.id);
    // legacy fields are stripped.
    expect((migrated as unknown as Record<string, unknown>).runAdapterConfig).toBeUndefined();
    expect((migrated as unknown as Record<string, unknown>).activeRunAdapterId).toBeUndefined();
  });

  it("repoints an invalid active selection at an existing runner", () => {
    const next = normalizeRunnerSettings(
      legacy({ runners: [], activeRunnerId: "ghost" }),
      false,
    );
    expect(next.runners.some((r) => r.id === next.activeRunnerId)).toBe(true);
  });

  it("migrates a persisted tauri-docker instance to local-docker in place", () => {
    const next = normalizeRunnerSettings(
      legacy({
        runners: [
          {
            id: LOCAL_DOCKER_RUNNER_ID,
            name: "Local (docker)",
            adapterId: "tauri-docker",
            config: { image: "my/custom:1", pullPolicy: "always", dockerHost: "tcp://box:2375" },
            builtIn: true,
          },
        ],
        activeRunnerId: LOCAL_DOCKER_RUNNER_ID,
      }),
      true,
    );

    const local = next.runners.find((r) => r.id === LOCAL_DOCKER_RUNNER_ID);
    expect(local?.adapterId).toBe("local-docker");
    // The user's session image + pull policy carry over; the remote-daemon
    // option does not (the supervisor targets the local daemon only).
    expect(local?.config).toEqual({ image: "my/custom:1", pullPolicy: "always" });
    expect(next.activeRunnerId).toBe(LOCAL_DOCKER_RUNNER_ID);
  });

  it("replaces the obsolete tauri-docker default image with the docker-runner default", () => {
    const next = normalizeRunnerSettings(
      legacy({
        runners: [
          {
            id: LOCAL_DOCKER_RUNNER_ID,
            name: "Local (docker)",
            adapterId: "tauri-docker",
            config: { image: "telorun/telo:nodejs", pullPolicy: "missing" },
            builtIn: true,
          },
        ],
        activeRunnerId: LOCAL_DOCKER_RUNNER_ID,
      }),
      true,
    );

    const local = next.runners.find((r) => r.id === LOCAL_DOCKER_RUNNER_ID);
    expect(local?.config).toEqual({ image: "telorun/node:0-slim", pullPolicy: "missing" });
  });

  it("seeds the local runner from a legacy tauri-docker keyed config", () => {
    const next = normalizeRunnerSettings(
      legacy({
        activeRunAdapterId: "tauri-docker",
        runAdapterConfig: {
          "tauri-docker": { image: "my/custom:2", pullPolicy: "never", dockerHost: "unix:///x" },
        },
      }),
      true,
    );

    const local = next.runners.find((r) => r.id === LOCAL_DOCKER_RUNNER_ID);
    expect(local?.adapterId).toBe("local-docker");
    expect(local?.config).toEqual({ image: "my/custom:2", pullPolicy: "never" });
    expect(next.activeRunnerId).toBe(LOCAL_DOCKER_RUNNER_ID);
  });
});
