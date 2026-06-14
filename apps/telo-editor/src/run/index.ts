export type {
  LogLine,
  RunRecord,
  UnavailableRun,
} from "./context";
export { RunProvider, useRun } from "./context";
export type {
  AvailabilityReport,
  ConfigIssue,
  RunAdapter,
  RunBundle,
  RunEvent,
  RunIo,
  RunIoConnection,
  RunIoHandlers,
  RunnerCapabilities,
  RunnerTerms,
  RunRequest,
  RunSession,
  RunStatus,
} from "./types";
export { TermsRequiredError } from "./types";
export { buildRunBundle } from "./bundle";
export { registry } from "./registry";
export { RunSettingsSection } from "./ui/RunSettingsSection";
export { RunStatusChip } from "./ui/RunStatusChip";
export { RunView } from "./ui/RunView";

import { isTauri } from "@tauri-apps/api/core";
import { registry } from "./registry";
import { tauriDockerAdapter } from "./adapters/tauri-docker/adapter";
import { httpRunnerAdapter } from "./adapters/http-runner/adapter";

/** Registers all built-in adapter *types* with the registry exactly once.
 *  Called from the editor entry point; idempotent so re-mounting the
 *  provider during HMR doesn't double-register. Runner *instances* (the
 *  user-managed list) live in settings, not here.
 *
 *  The tauri-docker adapter only works inside a Tauri window — `invoke()`
 *  has no target in a plain browser, so registering it outside that
 *  environment would let the user open a config form that throws on every
 *  probe. When `isTauri()` is false we skip registration.
 *
 *  The http-runner adapter is an HTTP client and works in both Tauri and
 *  plain-browser contexts — always registered. It serves docker-runner,
 *  k8s-runner, and Telo Cloud via the same `/v1` contract. */
export function setupAdapters(): void {
  if (isTauri() && !registry.get(tauriDockerAdapter.id)) {
    registry.register(tauriDockerAdapter);
  }
  if (!registry.get(httpRunnerAdapter.id)) {
    registry.register(httpRunnerAdapter);
  }
}
