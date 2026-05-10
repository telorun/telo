import { EventEmitter } from "node:events";

import type { BundleWorkdir } from "./bundle-workdir.js";
import { ByteRingBuffer, type BufferedBytes } from "./byte-ring-buffer.js";
import { EventRingBuffer, type BufferedEvent } from "./ring-buffer.js";
import type { SessionDockerContainer } from "../docker/run-session.js";
import type { RunEvent, RunStatus } from "../types.js";

export interface SessionEntry {
  readonly sessionId: string;
  readonly containerName: string;
  readonly bundleWorkdir: BundleWorkdir;
  readonly createdAt: Date;
  readonly buffer: EventRingBuffer;
  readonly byteBuffer: ByteRingBuffer;
  readonly emitter: EventEmitter;
  readonly byteEmitter: EventEmitter;

  container: SessionDockerContainer | null;
  /** Writable side of the hijacked attach duplex; bytes the client sends
   *  over the WS land here. Null until `spawnSession` wires it up; goes back
   *  to null only on container exit. */
  ptyInput: NodeJS.WritableStream | null;
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
const BYTES_EMITTED = "chunk";

/** Cap on a single buffered byte chunk. Without this, one huge container
 *  burst (`cat largefile`) could be admitted as one entry; the ring
 *  buffer's "retain at least one" invariant would then keep that one
 *  oversized entry resident regardless of `replayBufferBytes`. Splitting
 *  on push means the cap actually bounds memory and the eviction loop
 *  has fine-grained units to drop. */
const MAX_PUSH_CHUNK = 64 * 1024;

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
      byteBuffer: new ByteRingBuffer(this.deps.replayBufferBytes),
      emitter: new EventEmitter(),
      byteEmitter: new EventEmitter(),
      container: null,
      ptyInput: null,
      status: { kind: "starting" },
      exitedAt: null,
      userStopped: false,
      evictionTimer: null,
    };
    // Many transient SSE / WS subscribers per session is normal — bump the
    // default 10-listener warning to a high cap so the alarm still fires
    // for a real listener leak. 256 is well above the realistic concurrent-
    // tab count and well below "obviously a bug".
    entry.emitter.setMaxListeners(256);
    entry.byteEmitter.setMaxListeners(256);
    this.sessions.set(args.sessionId, entry);
    return entry;
  }

  /** Drops the ptyInput handle on a session entry. Called from the spawn
   *  exit task once the container is gone — without this, the WS handler's
   *  `if (!entry.ptyInput) return` short-circuit never fires and every user
   *  keystroke takes the catch-fallthrough path. */
  clearPtyInput(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.ptyInput = null;
  }

  pushBytes(sessionId: string, bytes: Buffer): BufferedBytes | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    if (bytes.byteLength <= MAX_PUSH_CHUNK) {
      const buffered = entry.byteBuffer.push(bytes);
      entry.byteEmitter.emit(BYTES_EMITTED, buffered);
      return buffered;
    }
    // Split the chunk into MAX_PUSH_CHUNK-sized slices, each getting its
    // own seq. Returns the last buffered piece for the caller's bookkeeping.
    let last: BufferedBytes | undefined;
    for (let off = 0; off < bytes.byteLength; off += MAX_PUSH_CHUNK) {
      const slice = bytes.subarray(off, Math.min(off + MAX_PUSH_CHUNK, bytes.byteLength));
      // subarray shares memory with the parent buffer; copy so the ring's
      // entry doesn't pin the original allocation past eviction.
      last = entry.byteBuffer.push(Buffer.from(slice));
      entry.byteEmitter.emit(BYTES_EMITTED, last);
    }
    return last;
  }

  subscribeBytes(sessionId: string, listener: (b: BufferedBytes) => void): () => void {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new SessionEvictedError(`session '${sessionId}' not in registry`);
    entry.byteEmitter.on(BYTES_EMITTED, listener);
    return () => entry.byteEmitter.off(BYTES_EMITTED, listener);
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
