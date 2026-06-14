import { EventEmitter } from "node:events";

import type { BackendSession } from "../backend.js";
import { isTerminal, type RunEvent, type RunStatus } from "../contract.js";
import { ByteRingBuffer, type BufferedBytes } from "./byte-ring-buffer.js";
import { EventRingBuffer, type BufferedEvent } from "./ring-buffer.js";

export interface SessionEntry {
  readonly sessionId: string;
  readonly createdAt: Date;
  readonly buffer: EventRingBuffer;
  readonly byteBuffer: ByteRingBuffer;
  readonly emitter: EventEmitter;
  readonly byteEmitter: EventEmitter;

  /** The live backend workload. Null until `start` resolves; the route writes
   *  stdin / resize / stop through it. A backend's `writeStdin` is a no-op once
   *  the workload has terminated, so callers need not null it on exit. */
  session: BackendSession | null;
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

/** Cap on a single buffered byte chunk. Without this, one huge workload
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
  register(args: { sessionId: string }): SessionEntry {
    if (this.sessions.size >= this.deps.maxSessions && !this.evictOldestTerminal()) {
      throw new SessionLimitError(
        `runner is at its configured max of ${this.deps.maxSessions} concurrent sessions`,
      );
    }
    const entry: SessionEntry = {
      sessionId: args.sessionId,
      createdAt: new Date(),
      buffer: new EventRingBuffer(this.deps.replayBufferBytes),
      byteBuffer: new ByteRingBuffer(this.deps.replayBufferBytes),
      emitter: new EventEmitter(),
      byteEmitter: new EventEmitter(),
      session: null,
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

  /** Free a slot at capacity by removing the oldest already-terminated session
   *  (by exit time). Retained exited sessions are history kept for re-attach, so
   *  they yield to a new run rather than blocking it; live sessions are never
   *  evicted. Returns false when every session is still live. */
  private evictOldestTerminal(): boolean {
    let oldest: SessionEntry | undefined;
    for (const entry of this.sessions.values()) {
      if (entry.exitedAt === null) continue;
      if (!oldest || entry.exitedAt < oldest.exitedAt!) oldest = entry;
    }
    if (!oldest) return false;
    return this.remove(oldest.sessionId);
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
