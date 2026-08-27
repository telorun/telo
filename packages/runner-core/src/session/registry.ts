import { EventEmitter } from "node:events";

import type { DebugFrame } from "@telorun/debug-wire";

import type { BackendSession, WorkloadLaunch } from "../backend.js";
import {
  DEFAULT_APP_NAME,
  isTerminal,
  type ByteStreamTag,
  type IoMode,
  type PortMapping,
  type RunEvent,
  type RunStatus,
  type RunTrigger,
  type SessionMode,
  type WorkspaceCheckpointFile,
} from "../contract.js";
import { ByteRingBuffer, type BufferedBytes } from "./byte-ring-buffer.js";
import { EventRingBuffer, type BufferedEvent } from "./ring-buffer.js";

/**
 * One application's terminal and run bookkeeping. The byte channel is keyed
 * `(session, app)` rather than labelled on a merged stream: each app container
 * has its OWN terminal, and merging them would make `/io` unattachable to one.
 */
export interface AppChannel {
  readonly name: string;
  readonly io: IoMode;
  readonly byteBuffer: ByteRingBuffer;
  readonly byteEmitter: EventEmitter;
  /** Monotonic per app, starting at 1. Counted here from the kernel lifecycle
   *  events the debug stream already carries — the kernel is asked for nothing. */
  generation: number;
  /** Epoch ms the current generation started, for `durationMs` on completion.
   *  Null between generations. */
  startedAt: number | null;
  /** The port set this app currently declares. Re-read on every reload, so a
   *  `ports:` edit patches the Service and Ingress instead of silently binding
   *  a port nothing routes. */
  ports: PortMapping[];
}

export interface SessionEntry {
  readonly sessionId: string;
  readonly createdAt: Date;
  readonly mode: SessionMode;
  readonly buffer: EventRingBuffer;
  readonly emitter: EventEmitter;
  /** One channel per application container, insertion-ordered. */
  readonly apps: Map<string, AppChannel>;

  /** The live backend workload. Null until `start` resolves; the route writes
   *  stdin / resize / stop through it. A backend's `writeStdin` is a no-op once
   *  the workload has terminated, so callers need not null it on exit. */
  session: BackendSession | null;
  status: RunStatus;
  exitedAt: Date | null;
  userStopped: boolean;
  evictionTimer: NodeJS.Timeout | null;

  /** Catalog name of the co-resident agent, when one was requested. */
  agent?: string;
  /** Last whole-tree workspace snapshot, pulled on the checkpoint timer and
   *  again on suspend. A CACHE, never the only copy: the editor holds the
   *  authoritative workspace, so a runner restart losing this costs an upload,
   *  not user work. */
  checkpoint: WorkspaceCheckpoint | null;
  /** How the NEXT generation of an app should be attributed. Structural rather
   *  than the projection type itself, so the registry stays free of the debug
   *  stream it knows nothing about. */
  attribution: RunAttribution | null;
  /** The description this session was launched from, retained so `resume` can
   *  build a fresh pod under the same id without a second copy of it. */
  launch: WorkloadLaunch | null;
  /** Live SSE/WS subscriber count. Zero for longer than the idle window is what
   *  suspends a watch session. */
  subscribers: number;
  /** Epoch ms the subscriber count last fell to zero; null while someone is
   *  attached. */
  idleSince: number | null;
  /** Epoch ms of recent reloads, for the per-session reload rate limit. A watch
   *  session reloads on every save, so an unbounded one is a way to keep a pod
   *  permanently rebuilding. */
  reloads: number[];
  /** Epoch ms the last workspace checkpoint was pulled. */
  checkpointedAt: number | null;
}

/**
 * The run projection as the registry sees it — structural, so the registry stays
 * free of the debug stream it knows nothing about. `expect` is how a route tells
 * it about a generation it is ABOUT to cause: without that, a manual reload
 * would be reported as a watch reload, and the runner would be guessing at the
 * one fact it actually knows.
 */
export interface RunAttribution {
  expect(app: string, trigger: RunTrigger): void;
  expectAll(trigger: RunTrigger): void;
  frame(app: string, frame: DebugFrame): void;
  /** Close the open generation because its workload ended — a container that
   *  goes away emits no `Kernel.Stopped`, so the backend reports the ending. */
  endGeneration(app: string, outcome: { code?: number; reason?: string }): void;
}

/** A whole-tree snapshot plus the contents needed to re-seed a fresh pod. Whole
 *  tree rather than a delta log from the write path: a manifest workspace is
 *  small, and one shape is easier to reason about than a replay that has to be
 *  correct. */
export interface WorkspaceCheckpoint {
  takenAt: Date;
  files: WorkspaceCheckpointFile[];
}

export interface RegistryDeps {
  maxSessions: number;
  exitTtlMs: number;
  /** Per APP, not per session — each application container has its own terminal
   *  and its own replay buffer. */
  replayBufferBytes: number;
  /** How long a suspended session record is retained before eviction. Bounds
   *  accumulation, and is deliberately not the pod deadline: that bounds a POD,
   *  so on its own nothing would ever evict a suspended record. */
  suspendedTtlMs?: number;
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
export class UnknownAppError extends Error {}

export interface RegisterArgs {
  sessionId: string;
  mode?: SessionMode;
  agent?: string;
  /** The applications this session runs. Defaults to one app named `app` with a
   *  terminal, so a single-app session behaves exactly as before. */
  apps?: Array<{ name: string; io?: IoMode; ports?: PortMapping[] }>;
}

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
  register(args: RegisterArgs): SessionEntry {
    if (this.sessions.size >= this.deps.maxSessions && !this.evictOldestTerminal()) {
      throw new SessionLimitError(
        `runner is at its configured max of ${this.deps.maxSessions} concurrent sessions`,
      );
    }
    const entry: SessionEntry = {
      sessionId: args.sessionId,
      createdAt: new Date(),
      mode: args.mode ?? "run",
      buffer: new EventRingBuffer(this.deps.replayBufferBytes),
      emitter: new EventEmitter(),
      apps: new Map(),
      session: null,
      status: { kind: "starting" },
      exitedAt: null,
      userStopped: false,
      evictionTimer: null,
      agent: args.agent,
      checkpoint: null,
      attribution: null,
      launch: null,
      subscribers: 0,
      idleSince: Date.now(),
      reloads: [],
      checkpointedAt: null,
    };
    // Many transient SSE / WS subscribers per session is normal — bump the
    // default 10-listener warning to a high cap so the alarm still fires
    // for a real listener leak. 256 is well above the realistic concurrent-
    // tab count and well below "obviously a bug".
    entry.emitter.setMaxListeners(256);
    for (const app of args.apps ?? [{ name: DEFAULT_APP_NAME }]) {
      this.addApp(entry, app);
    }
    this.sessions.set(args.sessionId, entry);
    return entry;
  }

  /** Add an application channel to an existing entry. Used at register time and
   *  when `PUT /v1/sessions/:id/apps` changes the running set. */
  addApp(
    entry: SessionEntry,
    app: { name: string; io?: IoMode; ports?: PortMapping[] },
  ): AppChannel {
    const channel: AppChannel = {
      name: app.name,
      io: app.io ?? "tty",
      byteBuffer: new ByteRingBuffer(this.deps.replayBufferBytes),
      byteEmitter: new EventEmitter(),
      generation: 0,
      startedAt: null,
      ports: app.ports ?? [],
    };
    channel.byteEmitter.setMaxListeners(256);
    entry.apps.set(app.name, channel);
    return channel;
  }

  /** The single app of a single-app session — what `/io` and `reload` fall back
   *  to when no `app` is given. Undefined when the session runs several, where
   *  there is no defensible default among many terminals. */
  soleApp(entry: SessionEntry): AppChannel | undefined {
    return entry.apps.size === 1 ? entry.apps.values().next().value : undefined;
  }

  pushBytes(
    sessionId: string,
    appName: string,
    bytes: Buffer,
    stream: ByteStreamTag = "tty",
  ): BufferedBytes | undefined {
    const channel = this.sessions.get(sessionId)?.apps.get(appName);
    if (!channel) return undefined;
    if (bytes.byteLength <= MAX_PUSH_CHUNK) {
      const buffered = channel.byteBuffer.push(bytes, stream);
      channel.byteEmitter.emit(BYTES_EMITTED, buffered);
      return buffered;
    }
    // Split the chunk into MAX_PUSH_CHUNK-sized slices, each getting its
    // own seq. Returns the last buffered piece for the caller's bookkeeping.
    let last: BufferedBytes | undefined;
    for (let off = 0; off < bytes.byteLength; off += MAX_PUSH_CHUNK) {
      const slice = bytes.subarray(off, Math.min(off + MAX_PUSH_CHUNK, bytes.byteLength));
      // subarray shares memory with the parent buffer; copy so the ring's
      // entry doesn't pin the original allocation past eviction.
      last = channel.byteBuffer.push(Buffer.from(slice), stream);
      channel.byteEmitter.emit(BYTES_EMITTED, last);
    }
    return last;
  }

  subscribeBytes(
    sessionId: string,
    appName: string,
    listener: (b: BufferedBytes) => void,
  ): () => void {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new SessionEvictedError(`session '${sessionId}' not in registry`);
    const channel = entry.apps.get(appName);
    if (!channel) {
      throw new UnknownAppError(`session '${sessionId}' runs no app named '${appName}'`);
    }
    channel.byteEmitter.on(BYTES_EMITTED, listener);
    return () => channel.byteEmitter.off(BYTES_EMITTED, listener);
  }

  emit(sessionId: string, event: RunEvent): BufferedEvent | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    const buffered = entry.buffer.push(event);
    if (event.type === "status") {
      entry.status = event.status;
      if (isTerminal(event.status)) {
        entry.exitedAt = new Date();
        this.scheduleEviction(entry, this.deps.exitTtlMs);
      } else if (event.status.kind === "suspended") {
        // Not terminal — the record and its checkpoint outlive the pod — but it
        // still needs its own ceiling, or suspended records accumulate forever.
        this.scheduleEviction(entry, this.deps.suspendedTtlMs);
      } else {
        this.cancelEviction(entry);
      }
    }
    entry.emitter.emit(EVENT_EMITTED, buffered);
    return buffered;
  }

  /** Begin a generation for one app and emit its `run.started`. Returns the new
   *  generation number, or undefined when the app is unknown. */
  startGeneration(
    sessionId: string,
    appName: string,
    trigger: "initial" | "watch" | "manual" | "resume",
  ): number | undefined {
    const channel = this.sessions.get(sessionId)?.apps.get(appName);
    if (!channel) return undefined;
    channel.generation += 1;
    channel.startedAt = Date.now();
    this.emit(sessionId, {
      type: "run",
      app: appName,
      generation: channel.generation,
      phase: "started",
      trigger,
    });
    return channel.generation;
  }

  /** Close the current generation of one app. A completion leaves the SESSION
   *  status untouched — that is the whole point of the split. */
  finishGeneration(
    sessionId: string,
    appName: string,
    outcome: { phase: "completed"; code: number } | { phase: "failed"; reason: string },
  ): void {
    const channel = this.sessions.get(sessionId)?.apps.get(appName);
    if (!channel || channel.generation === 0) return;
    const durationMs = channel.startedAt === null ? undefined : Date.now() - channel.startedAt;
    channel.startedAt = null;
    if (outcome.phase === "completed") {
      this.emit(sessionId, {
        type: "run",
        app: appName,
        generation: channel.generation,
        phase: "completed",
        code: outcome.code,
        durationMs,
      });
    } else {
      this.emit(sessionId, {
        type: "run",
        app: appName,
        generation: channel.generation,
        phase: "failed",
        reason: outcome.reason,
      });
    }
  }

  subscribe(sessionId: string, listener: (e: BufferedEvent) => void): () => void {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new SessionEvictedError(`session '${sessionId}' not in registry`);
    entry.emitter.on(EVENT_EMITTED, listener);
    return () => entry.emitter.off(EVENT_EMITTED, listener);
  }

  /** Count a live client. Idleness — no SSE/WS subscriber for the configured
   *  window — is what suspends a watch session, and aggressive reaping is what
   *  makes per-visitor watch sessions affordable; they only work as a pair. */
  addSubscriber(sessionId: string): () => void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return () => {};
    entry.subscribers += 1;
    entry.idleSince = null;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      if (entry.subscribers === 0) entry.idleSince = Date.now();
    };
  }

  /**
   * Free a slot at capacity by removing the oldest RECLAIMABLE session: a
   * terminated one (history kept for re-attach, which yields to a new run) or a
   * SUSPENDED one.
   *
   * A suspended session is reclaimable because losing it costs exactly what the
   * design already says a runner restart costs — a checkpoint the editor
   * re-seeds from its own copy. Excluding it would let a handful of visitors who
   * each left after five minutes hold every slot for the whole suspended TTL,
   * which with the shipped defaults is a day.
   *
   * Ordered by when the session stopped being live, so the least recently
   * abandoned goes first. Returns false when every session is still live.
   */
  private evictOldestTerminal(): boolean {
    let oldest: SessionEntry | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const entry of this.sessions.values()) {
      const since = reclaimableSince(entry);
      if (since === null || since >= oldestAt) continue;
      oldest = entry;
      oldestAt = since;
    }
    if (!oldest) return false;
    return this.remove(oldest.sessionId);
  }

  private cancelEviction(entry: SessionEntry): void {
    if (!entry.evictionTimer) return;
    clearTimeout(entry.evictionTimer);
    entry.evictionTimer = null;
  }

  private scheduleEviction(entry: SessionEntry, ttlMs: number | undefined): void {
    if (ttlMs === undefined) return;
    // A resume re-arms from `running`, so an already-armed timer is replaced
    // rather than kept — the surviving one would evict a live session.
    this.cancelEviction(entry);
    entry.evictionTimer = setTimeout(() => {
      this.sessions.delete(entry.sessionId);
    }, ttlMs);
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

/** When a session stopped being live, or null while it still is. A terminated
 *  session is reclaimable from its exit; a suspended one from when it went idle
 *  (it has no pod and its workspace is a checkpoint the editor can re-seed). */
function reclaimableSince(entry: SessionEntry): number | null {
  if (entry.exitedAt !== null) return entry.exitedAt.getTime();
  if (entry.status.kind === "suspended") return entry.idleSince ?? 0;
  return null;
}
