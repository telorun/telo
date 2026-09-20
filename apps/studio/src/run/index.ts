export type {
  LogLine,
  MissingConfigEntry,
  RunBlocker,
  RunDockState,
  RunRecord,
  UnavailableRun,
} from "./context";
export { RunProvider, useRun } from "./context";
export type {
  AvailabilityAction,
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
  WorkspaceChangeSet,
} from "./types";
export { SessionGoneError, TermsRequiredError } from "./types";
export { buildRunBundle } from "./bundle";
export { selectModuleFiles } from "./select-module-files";
export {
  bundleFiles,
  diffBundle,
  isEmptyChangeSet,
  type SyncedFiles,
} from "./workspace-sync";
export { registry } from "./registry";
export { RunBar } from "./ui/RunBar";
export { RunDock } from "./ui/RunDock";
export { RunSettingsSection } from "./ui/RunSettingsSection";
export { RunStatusChip } from "./ui/RunStatusChip";

import { isTauri } from "@tauri-apps/api/core";
import { registry } from "./registry";
import { localCliAdapter } from "./adapters/local-cli/adapter";
import { localDockerAdapter } from "./adapters/local-docker/adapter";
import { httpRunnerAdapter } from "./adapters/http-runner/adapter";

/** Registers all built-in adapter *types* with the registry exactly once.
 *  Called from the editor entry point; idempotent so re-mounting the
 *  provider during HMR doesn't double-register. Runner *instances* (the
 *  user-managed list) live in settings, not here.
 *
 *  The two local adapters only work inside a Tauri window — their supervisors
 *  `invoke()` a Rust command that has no target in a plain browser, so
 *  registering one outside that environment would let the user open a config
 *  form that throws on every probe. When `isTauri()` is false we skip them.
 *
 *  The http-runner adapter is an HTTP client and works in both Tauri and
 *  plain-browser contexts — always registered. It serves docker-runner,
 *  k8s-runner, and Telo Cloud via the same `/v1` contract. */
export function setupAdapters(): void {
  if (isTauri() && !registry.get(localCliAdapter.id)) {
    registry.register(localCliAdapter);
  }
  if (isTauri() && !registry.get(localDockerAdapter.id)) {
    registry.register(localDockerAdapter);
  }
  if (!registry.get(httpRunnerAdapter.id)) {
    registry.register(httpRunnerAdapter);
  }
}
