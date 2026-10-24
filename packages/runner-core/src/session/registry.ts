import { EventEmitter } from "node:events";

import type { DebugFrame } from "@telorun/debug-wire";

import type { BackendWorkload, WorkloadTokens } from "../backend.js";
import type { ResolvedRunnerApp } from "../config.js";
import type {
  ByteStreamTag,
  IoMode,
  PortMapping,
  RunEvent,
  RunStatus,
  RunTrigger,
} from "../contract.js";
import type { SessionRecord } from "../session-store/session-store.js";
import { ByteRingBuffer, type BufferedBytes } from "./byte-ring-buffer.js";
import { EventRingBuffer, type BufferedEvent } from "./ring-buffer.js";

/** One run of one app, from the Run request until the process reports its
 *  ending. */
export interface AppRunState {
  runId: string;
  io: IoMode;
  /** True once the process started; a requested run that has not yet started
   *  already refuses a second Run. */
  started: boolean;
  /** Ends the run's debug relay and reachability watch. */
  abort: AbortController;
}

/**
 * One application's terminal and run bookkeeping. The byte channel is keyed
 * `(session, app)` rather than labelled on a merged stream: each app has its
 * OWN terminal, and merging them would make `/io` unattachable to one.
 */
export interface AppChannel {
  readonly name: string;
  readonly byteBuffer: ByteRingBuffer;
  readonly byteEmitter: EventEmitter;
  /** Monotonic per app, starting at 1. Counted from the kernel lifecycle events
   *  the debug stream carries — the kernel is asked for nothing. */
  generation: number;
  /** Epoch ms the current generation started, for `durationMs` on completion.
   *  Null between generations. */
  startedAt: number | null;
  /** The port set this app currently declares. Re-read on every load. */
  ports: PortMapping[];
  /** `pending` until the workload reports its slot `ready`. */
  state: "pending" | "ready" | "running";
  /** The live (or requested) run; null when nothing runs. */
  run: AppRunState | null;
}

/**
 * A session's live state. The durable half is `record`, a mirror of the store
 * that is written to the store before it changes here; the rest — streams,
 * rings, subscribers, the backend workload — lives only in this process.
 */
export interface SessionEntry {
  readonly sessionId: string;
  record: SessionRecord;
  readonly buffer: EventRingBuffer;
  readonly emitter: EventEmitter;
  /** One channel per application, in app-set order. */
  readonly apps: Map<string, AppChannel>;

  /** The live backend workload; null while starting, suspended or failed. */
  workload: BackendWorkload | null;
  status: RunStatus;
  /** The agent the live workload was created with, its token in its env. */
  agent: ResolvedRunnerApp | undefined;
  /** The tokens of the live workload. */
  tokens: WorkloadTokens;
  /** Bumped by every workload creation, so a callback from a workload that has
   *  since been replaced is told apart from the live one's. */
  epoch: number;
  /** A suspend, resume, app-set or agent change in flight. */
  busy: string | null;
  /** How the NEXT generation of an app should be attributed. */
  attribution: RunAttribution | null;
  /** Live SSE/WS subscriber count. Zero for longer than the idle window is what
   *  suspends a session. */
  subscribers: number;
  /** Epoch ms the subscriber count last fell to zero; null while someone is
   *  attached. */
  idleSince: number | null;
  /** Epoch ms the session last became `running` in this process. */
  runningSince: number | null;
  /** Epoch ms of recent reloads, for the per-session reload rate limit. */
  reloads: number[];
}

/**
 * The run projection as the registry sees it — structural, so the registry stays
 * free of the debug stream it knows nothing about. `expect` is how a route tells
 * it about a generation it is ABOUT to cause.
 */
export interface RunAttribution {
  expect(app: string, trigger: RunTrigger): void;
  frame(app: string, frame: DebugFrame): void;
  /** Close the open generation because its process ended without a
   *  `Kernel.Stopped` reaching the runner. */
  endGeneration(app: string, outcome: { code?: number; signal?: string; reason?: string }): void;
}

export interface RegistryDeps {
  /** Per APP, not per session — each application has its own terminal and its
   *  own replay buffer. */
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

export class SessionEvictedError extends Error {}
export class UnknownAppError extends Error {}

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

  /** The live entry of a stored record, its apps `pending` until a workload
   *  reports them. */
  register(record: SessionRecord, status: RunStatus): SessionEntry {
    if (this.sessions.has(record.id)) {
      throw new Error(`session '${record.id}' is already registered`);
    }
    const entry: SessionEntry = {
      sessionId: record.id,
      record,
      buffer: new EventRingBuffer(this.deps.replayBufferBytes),
      emitter: new EventEmitter(),
      apps: new Map(),
      workload: null,
      status,
      agent: undefined,
      tokens: {},
      epoch: 0,
      busy: null,
      attribution: null,
      subscribers: 0,
      idleSince: Date.now(),
      runningSince: null,
      reloads: [],
    };
    // Many transient SSE / WS subscribers per session is normal — bump the
    // default 10-listener warning to a high cap so the alarm still fires
    // for a real listener leak.
    entry.emitter.setMaxListeners(256);
    for (const app of record.apps) this.addApp(entry, { name: app.name, ports: app.ports });
    this.sessions.set(record.id, entry);
    return entry;
  }

  /** Add an application channel to an existing entry. */
  addApp(entry: SessionEntry, app: { name: string; ports?: PortMapping[] }): AppChannel {
    const channel: AppChannel = {
      name: app.name,
      byteBuffer: new ByteRingBuffer(this.deps.replayBufferBytes),
      byteEmitter: new EventEmitter(),
      generation: 0,
      startedAt: null,
      ports: app.ports ?? [],
      state: "pending",
      run: null,
    };
    channel.byteEmitter.setMaxListeners(256);
    entry.apps.set(app.name, channel);
    return channel;
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
    if (event.type === "status") entry.status = event.status;
    entry.emitter.emit(EVENT_EMITTED, buffered);
    return buffered;
  }

  /** Begin a generation for one app and emit its `run.started`. Returns the new
   *  generation number, or undefined when the app is unknown. */
  startGeneration(
    sessionId: string,
    appName: string,
    trigger: RunTrigger,
    telo?: string,
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
      ...(telo !== undefined ? { telo } : {}),
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
   *  window — is what suspends a session. */
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

  /** Remove an entry (a deleted session). Returns true if it was present. */
  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }
}
