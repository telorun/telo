/**
 * Typed bridge to the Rust local-runner supervisor (`src-tauri/src/local_runner.rs`),
 * which runs the published docker-runner image as a local container. Only
 * `startLocalRunner` has side effects — and only ever from an explicit user
 * action; probing and status reads never boot anything.
 */

import { invoke } from "@tauri-apps/api/core";

import type { AvailabilityReport } from "../../types";
import { LOCAL_RUNNER_IMAGE } from "./runner-image";

export interface LocalRunnerStatus {
  state: "stopped" | "starting" | "ready";
  baseUrl?: string;
}

/** Docker CLI/daemon reachability — says nothing about the runner container. */
export function probeDocker(): Promise<AvailabilityReport> {
  return invoke<AvailabilityReport>("local_runner_probe");
}

export function localRunnerStatus(): Promise<LocalRunnerStatus> {
  return invoke<LocalRunnerStatus>("local_runner_status");
}

/** Bring the runner container up (idempotent; adopts a healthy leftover on the
 *  pinned image). First start pulls the image, so this can take a while. */
export async function startLocalRunner(): Promise<string> {
  const status = await invoke<LocalRunnerStatus>("local_runner_ensure", {
    image: LOCAL_RUNNER_IMAGE,
  });
  if (!status.baseUrl) throw new Error("The local runner started without a base URL.");
  return status.baseUrl;
}

/** Remove the runner container (docker-runner stops its workload sessions on
 *  SIGTERM) and the bundle volume. */
export function stopLocalRunner(): Promise<void> {
  return invoke("local_runner_teardown");
}
