import type { DebugFrame } from "@telorun/debug-wire";
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
import { makeTauriDockerIo } from "./io-client";

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
    const scaffold = await buildTauriSession(sessionId, { kind: "starting" });

    try {
      await invoke("run_start", {
        sessionId,
        bundle: request.bundle,
        env: request.env ?? {},
        ports: request.ports ?? [],
        config,
        ioChannel: scaffold.channel,
        inspect: true,
      });
    } catch (err) {
      scaffold.cleanup();
      throw err instanceof Error ? err : new Error(String(err));
    }

    return scaffold.session;
  },

  async attach(sessionId): Promise<RunSession | null> {
    // The container outlives a webview reload (the Rust process keeps it alive),
    // so re-attach by id — the registry holds everything needed. A running
    // session is assumed; the Rust side re-emits the real status + debug endpoint.
    const scaffold = await buildTauriSession(sessionId, { kind: "running" });

    let attached: boolean;
    try {
      attached = await invoke<boolean>("run_reattach", {
        sessionId,
        ioChannel: scaffold.channel,
      });
    } catch (err) {
      scaffold.cleanup();
      throw err instanceof Error ? err : new Error(String(err));
    }

    // The session is gone (exited and removed, or the editor process restarted).
    if (!attached) {
      scaffold.cleanup();
      return null;
    }

    return scaffold.session;
  },
};

interface TauriSessionScaffold {
  session: RunSession;
  /** Tauri Channel to hand to `run_start` / `run_reattach`. */
  channel: ReturnType<typeof makeTauriDockerIo>["channel"];
  cleanup: () => void;
}

/** Wires the status + debug-endpoint listeners and the byte-stream Channel for a
 *  local docker session, shared by `start` (fresh run) and `attach` (resume after
 *  reload). The two differ only in the Rust command they invoke with the returned
 *  channel; the resulting `RunSession` is identical. */
async function buildTauriSession(
  sessionId: string,
  initialStatus: RunStatus,
): Promise<TauriSessionScaffold> {
  let currentStatus: RunStatus = initialStatus;
  const subscribers = new Set<(event: RunEvent) => void>();
  let cleanupDone = false;
  let unlisteners: UnlistenFn[] = [];
  // The local runner is all-loopback (no ingress / public exposure), so the
  // editor reads the workload's `--inspect` SSE directly from the published
  // 127.0.0.1 port — the same `debug` RunEvents a remote runner would relay.
  let debugSource: EventSource | null = null;

  function emit(event: RunEvent) {
    for (const listener of subscribers) listener(event);
  }

  function cleanup() {
    if (cleanupDone) return;
    cleanupDone = true;
    debugSource?.close();
    debugSource = null;
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

  // Listeners MUST be registered before the invoke — the Rust side emits status
  // (and the debug endpoint) synchronously during the handler, and Tauri events
  // have no buffering for unregistered listeners.
  unlisteners = await Promise.all([
    listen<RunStatus>(`run:${sessionId}:status`, (e) => {
      currentStatus = e.payload;
      emit({ type: "status", status: currentStatus });
      if (isTerminal(currentStatus)) cleanup();
    }),
    listen<{ url: string }>(`run:${sessionId}:debug-endpoint`, (e) => {
      if (debugSource) return;
      debugSource = openDebugStream(e.payload.url, (frame) =>
        emit({ type: "debug", frame }),
      );
    }),
  ]);

  // Construct the byte-stream Channel before invoking. The bootstrap installs a
  // buffering onmessage handler at construction so bytes the Rust reader emits
  // (or replays as scrollback) before the consumer (TerminalView) calls
  // io.open() are not lost.
  const { io, channel } = makeTauriDockerIo(sessionId);

  const session: RunSession = {
    id: sessionId,
    getStatus: () => currentStatus,
    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    io,
    async stop() {
      await invoke("run_stop", { sessionId });
      // The exit task on the Rust side emits the terminal status event, which
      // triggers cleanup via the status listener above. We don't need to wait
      // here — callers who want the final status should subscribe before stop.
    },
  };

  return { session, channel, cleanup };
}

/** Open an SSE connection to a workload's `--inspect` endpoint and deliver each
 *  parsed frame. The Rust side announces the (loopback) base URL once the
 *  container's published debug port is up. */
function openDebugStream(baseUrl: string, onFrame: (frame: DebugFrame) => void): EventSource {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const source = new EventSource(new URL("events", base).toString());
  source.onmessage = (msg) => {
    if (!msg.data) return;
    try {
      onFrame(JSON.parse(msg.data) as DebugFrame);
    } catch {
      // A malformed frame shouldn't kill the stream; skip it.
    }
  };
  return source;
}
