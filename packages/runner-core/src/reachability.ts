import net from "node:net";

import { abortableDelay } from "./abortable-delay.js";
import type { ReachabilityState } from "./contract.js";

export interface WatchReachabilityOptions {
  /** Address the runner dials — pod IP (k8s) or published host / container name (docker). */
  host: string;
  /** TCP ports the workload declared; each is watched and reported by port. */
  ports: number[];
  /** Receives every state transition for a port: `checking` on start, then
   *  `reachable` once it accepts a connection, or `unreachable` after the timeout. */
  onState: (port: number, state: ReachabilityState) => void;
  /** Aborts the watch — wire to the session's teardown. */
  signal: AbortSignal;
  /** How long a port may stay unreachable before it's reported `unreachable`.
   *  Default 30s. */
  timeoutMs?: number;
  /** Poll interval while waiting for a port to come up. Default 1s. */
  intervalMs?: number;
  /** Poll interval after a port was reported `unreachable`, to flip it back to
   *  `reachable` if it recovers. Default 5s. */
  recheckIntervalMs?: number;
  /** Per-attempt TCP connect timeout. Default 1s. */
  connectTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_RECHECK_INTERVAL_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;

interface WatchConfig {
  host: string;
  onState: (port: number, state: ReachabilityState) => void;
  signal: AbortSignal;
  timeoutMs: number;
  intervalMs: number;
  recheckIntervalMs: number;
  connectTimeoutMs: number;
}

/** One TCP connect attempt. Resolves true on a completed connection, false on
 *  refusal / timeout / error. Never throws; `unref`'d so a pending attempt can't
 *  keep the event loop alive, and always torn down. */
function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.unref();
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function watchPort(port: number, cfg: WatchConfig): Promise<void> {
  cfg.onState(port, "checking");
  const start = Date.now();
  let reportedUnreachable = false;
  while (!cfg.signal.aborted) {
    if (await tryConnect(cfg.host, port, cfg.connectTimeoutMs)) {
      cfg.onState(port, "reachable");
      return;
    }
    if (!reportedUnreachable && Date.now() - start >= cfg.timeoutMs) {
      reportedUnreachable = true;
      cfg.onState(port, "unreachable");
    }
    await abortableDelay(reportedUnreachable ? cfg.recheckIntervalMs : cfg.intervalMs, cfg.signal);
  }
}

/**
 * Watches each declared TCP port for reachability from the runner network and
 * reports per-port transitions via `onState`: `checking` immediately, then
 * `reachable` the moment a connection succeeds, or `unreachable` after
 * `timeoutMs` of refusal. After `unreachable` it keeps probing (slower) and
 * flips back to `reachable` on recovery — so a slow-but-correct start
 * self-corrects.
 *
 * This catches the loopback-bind / wrong-port / crash-loop failure that
 * otherwise surfaces only as an opaque downstream 502; emitting state (not a log
 * line) lets the editor render it on the endpoint badge. Backend-neutral: the
 * runner supplies how its workload is dialed and where state goes.
 */
export async function watchReachability(options: WatchReachabilityOptions): Promise<void> {
  if (options.ports.length === 0) return;
  const cfg: WatchConfig = {
    host: options.host,
    onState: options.onState,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
    recheckIntervalMs: options.recheckIntervalMs ?? DEFAULT_RECHECK_INTERVAL_MS,
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  };
  await Promise.all(options.ports.map((port) => watchPort(port, cfg)));
}
