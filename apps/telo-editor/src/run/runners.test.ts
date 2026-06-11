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
});
