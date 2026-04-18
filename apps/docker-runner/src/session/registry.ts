import { EventEmitter } from "node:events";

import type { BundleWorkdir } from "./bundle-workdir.js";
import { EventRingBuffer, type BufferedEvent } from "./ring-buffer.js";
import type { SessionDockerContainer } from "../docker/run-session.js";
import type { RunEvent, RunStatus } from "../types.js";

export interface SessionEntry {
  readonly sessionId: string;
  readonly containerName: string;
  readonly bundleWorkdir: BundleWorkdir;
  readonly createdAt: Date;
  readonly buffer: EventRingBuffer;
  readonly emitter: EventEmitter;

  container: SessionDockerContainer | null;
  status: RunStatus;
  exitedAt: Date | null;
  userStopped: boolean;
  evictionTimer: NodeJS.Timeout | null;
}

export interface RegistryDeps {
  maxSessions: number;
  exitTtlMs: number;
  replayBufferBytes: number;
}

const EVENT_EMITTED = "event";

export class SessionLimitError extends Error {}
export class SessionEvictedError extends Error {}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly deps: RegistryDeps) {}

  size(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  list(): SessionEntry[] {
    return [...this.sessions.values()];
  }

  /**
   * Creates a fresh registry entry. Callers are responsible for guarding against
   * duplicate insertion. Throws SessionLimitError if we're at capacity.
   */
  register(args: {
    sessionId: string;
    containerName: string;
    bundleWorkdir: BundleWorkdir;
  }): SessionEntry {
    if (this.sessions.size >= this.deps.maxSessions) {
      throw new SessionLimitError(
        `runner is at its configured max of ${this.deps.maxSessions} concurrent sessions`,
      );
    }
    const entry: SessionEntry = {
      sessionId: args.sessionId,
      containerName: args.containerName,
      bundleWorkdir: args.bundleWorkdir,
      createdAt: new Date(),
      buffer: new EventRingBuffer(this.deps.replayBufferBytes),
      emitter: new EventEmitter(),
      container: null,
      status: { kind: "starting" },
      exitedAt: null,
      userStopped: false,
      evictionTimer: null,
    };
    // Emitters can have many transient SSE subscribers; silence the warning.
    entry.emitter.setMaxListeners(0);
    this.sessions.set(args.sessionId, entry);
    return entry;
  }

  emit(sessionId: string, event: RunEvent): BufferedEvent | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    const buffered = entry.buffer.push(event);
    if (event.type === "status") {
      entry.status = event.status;
      if (isTerminal(event.status)) {
        entry.exitedAt = new Date();
        this.scheduleEviction(entry);
      }
    }
    entry.emitter.emit(EVENT_EMITTED, buffered);
    return buffered;
  }

  subscribe(sessionId: string, listener: (e: BufferedEvent) => void): () => void {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new SessionEvictedError(`session '${sessionId}' not in registry`);
    entry.emitter.on(EVENT_EMITTED, listener);
    return () => entry.emitter.off(EVENT_EMITTED, listener);
  }

  private scheduleEviction(entry: SessionEntry): void {
    if (entry.evictionTimer) return;
    entry.evictionTimer = setTimeout(() => {
      this.sessions.delete(entry.sessionId);
    }, this.deps.exitTtlMs);
    // Allow process exit even if evictions are pending — they are pure state,
    // not work.
    entry.evictionTimer.unref?.();
  }

  /**
   * Remove an entry immediately (used by shutdown sweeps and startup cleanup).
   * Returns true if it was present.
   */
  remove(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
    this.sessions.delete(sessionId);
    return true;
  }
}

export function isTerminal(status: RunStatus): boolean {
  return status.kind === "exited" || status.kind === "failed" || status.kind === "stopped";
}
