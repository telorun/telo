import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  isTerminal,
  type AvailabilityReport,
  type ConfigIssue,
  type RunAdapter,
  type RunEvent,
  type RunSession,
  type RunStatus,
} from "../../types";
import {
  tauriDockerConfigSchema,
  tauriDockerDefaultConfig,
  type TauriDockerConfig,
} from "./config-schema";
import type { OutputChunkPayload } from "./protocol";

export const tauriDockerAdapter: RunAdapter<TauriDockerConfig> = {
  id: "tauri-docker",
  displayName: "Local (docker)",
  description: "Runs the Application in a local Docker container.",

  configSchema: tauriDockerConfigSchema,
  defaultConfig: tauriDockerDefaultConfig,

  validateConfig(config) {
    const issues: ConfigIssue[] = [];
    if (!config.image || config.image.trim() === "") {
      issues.push({ path: "/image", message: "Image name is required." });
    }
    return issues;
  },

  async isAvailable(config) {
    return invoke<AvailabilityReport>("run_probe_docker", { config });
  },

  async start(request, config): Promise<RunSession> {
    const sessionId = crypto.randomUUID();

    let currentStatus: RunStatus = { kind: "starting" };
    const subscribers = new Set<(event: RunEvent) => void>();
    let cleanupDone = false;
    let unlisteners: UnlistenFn[] = [];

    function emit(event: RunEvent) {
      for (const listener of subscribers) listener(event);
    }

    function cleanup() {
      if (cleanupDone) return;
      cleanupDone = true;
      for (const u of unlisteners) {
        try {
          u();
        } catch {
          // Unlisten can fail if the event system is already torn down on
          // window close — safe to ignore.
        }
      }
      unlisteners = [];
    }

    // Listeners MUST be registered before the `run_start` invoke — the Rust
    // side emits `Starting`/`Running` synchronously during the handler, and
    // Tauri events have no buffering for unregistered listeners.
    unlisteners = await Promise.all([
      listen<OutputChunkPayload>(`run:${sessionId}:stdout`, (e) => {
        emit({ type: "stdout", chunk: e.payload.chunk });
      }),
      listen<OutputChunkPayload>(`run:${sessionId}:stderr`, (e) => {
        emit({ type: "stderr", chunk: e.payload.chunk });
      }),
      listen<RunStatus>(`run:${sessionId}:status`, (e) => {
        currentStatus = e.payload;
        emit({ type: "status", status: currentStatus });
        if (isTerminal(currentStatus)) cleanup();
      }),
    ]);

    try {
      await invoke("run_start", {
        sessionId,
        bundle: request.bundle,
        env: request.env ?? {},
        ports: request.ports ?? [],
        config,
      });
    } catch (err) {
      cleanup();
      throw err instanceof Error ? err : new Error(String(err));
    }

    return {
      id: sessionId,
      getStatus: () => currentStatus,
      subscribe(listener) {
        subscribers.add(listener);
        return () => {
          subscribers.delete(listener);
        };
      },
      async stop() {
        await invoke("run_stop", { sessionId });
        // The exit task on the Rust side emits the terminal status event,
        // which triggers cleanup via the status listener above. We don't
        // need to wait here — callers who want the final status should
        // subscribe before calling stop.
      },
    };
  },
};
