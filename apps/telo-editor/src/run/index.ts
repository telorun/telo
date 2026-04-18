export type {
  ActiveRun,
  LogLine,
  UnavailableRun,
} from "./context";
export { RunProvider, useRun } from "./context";
export type {
  AvailabilityReport,
  ConfigIssue,
  RunAdapter,
  RunBundle,
  RunEvent,
  RunRequest,
  RunSession,
  RunStatus,
} from "./types";
export { buildRunBundle } from "./bundle";
export { registry } from "./registry";
export { AdapterConfigForm } from "./ui/AdapterConfigForm";
export { RunSettingsSection } from "./ui/RunSettingsSection";
export { RunView } from "./ui/RunView";

import { isTauri } from "@tauri-apps/api/core";
import { registry } from "./registry";
import { tauriDockerAdapter } from "./adapters/tauri-docker/adapter";
import { dockerApiAdapter } from "./adapters/docker-api/adapter";

/** Registers all built-in adapters with the registry exactly once.
 *  Called from the editor entry point; idempotent so re-mounting the
 *  provider during HMR doesn't double-register.
 *
 *  The tauri-docker adapter only works inside a Tauri window — `invoke()`
 *  has no target in a plain browser, so registering it outside that
 *  environment would let the user open a config form that throws on every
 *  probe. When `isTauri()` is false we skip registration; the Run Settings
 *  section then shows the "no adapters registered" empty state.
 *
 *  The docker-api adapter is an HTTP client and works in both Tauri and
 *  plain-browser contexts — always registered. */
export function setupAdapters(): void {
  if (isTauri() && !registry.get(tauriDockerAdapter.id)) {
    registry.register(tauriDockerAdapter);
  }
  if (!registry.get(dockerApiAdapter.id)) {
    registry.register(dockerApiAdapter);
  }
}
