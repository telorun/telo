/**
 * Typed bridge to the Rust CLI-runner supervisor, which runs the bundled
 * `telo runner` as a child process. Only `startLocalCliRunner` has side
 * effects; probing and status reads never start anything.
 */

import { invoke } from "@tauri-apps/api/core";

import type { AvailabilityReport } from "../../types";

export interface LocalCliRunnerStatus {
  state: "stopped" | "starting" | "ready";
  baseUrl?: string;
  /** The executable behind a running runner — reported, never assumed. */
  executable?: string;
}

/** Whether a `telo` executable can be resolved at all. Says nothing about
 *  whether the runner is up. */
export function probeCli(executable: string): Promise<AvailabilityReport> {
  return invoke<AvailabilityReport>("cli_runner_probe", { executable: executable || null });
}

export function localCliRunnerStatus(): Promise<LocalCliRunnerStatus> {
  return invoke<LocalCliRunnerStatus>("cli_runner_status");
}

/** Start the runner (idempotent — an already-running one is reused). */
export async function startLocalCliRunner(executable: string): Promise<string> {
  const status = await invoke<LocalCliRunnerStatus>("cli_runner_ensure", {
    executable: executable || null,
  });
  if (!status.baseUrl) throw new Error("The local runner started without a base URL.");
  return status.baseUrl;
}

/** Stop the runner. It stops every live session on its way down, so nothing it
 *  started outlives this call. */
export function stopLocalCliRunner(): Promise<void> {
  return invoke("cli_runner_teardown");
}
