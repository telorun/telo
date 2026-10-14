import { timingSafeEqual } from "node:crypto";

import { isTerminal } from "../contract.js";
import type { SessionRegistry } from "../session/registry.js";
import { generateWorkloadToken } from "../session/workload-token.js";
import type { AdmittedCreate } from "./create-request.js";
import type { SessionContainerEngine } from "./session-container-engine.js";

/** The variables a session's workload reads its container engine from. */
export const ENGINE_URL_ENV = "TELO_HOST_CONTAINER_ENGINE_URL";
export const ENGINE_TOKEN_ENV = "TELO_HOST_CONTAINER_ENGINE_TOKEN";

/** A container a session started, as core records it. */
export interface SessionContainer {
  id: string;
  image: string;
  labels: Record<string, string>;
  ports: number[];
  /** The ports the create asked a binding for. */
  bound: number[];
}

interface SessionState {
  token: string;
  containers: Map<string, SessionContainer>;
  /** Creates in flight, counted against the ceiling. */
  creating: number;
  /** Bumped by every release, so a create that lands after one is undone. */
  epoch: number;
  /** The session ended: nothing more is created and the state is dropped. */
  closed: boolean;
}

export type Authorization = "ok" | "unknown_session" | "missing_token" | "wrong_token";

export type CreateOutcome =
  | { kind: "created"; id: string }
  | { kind: "ceiling"; max: number }
  | { kind: "ended" };

export interface SessionContainersDeps {
  engine: SessionContainerEngine;
  registry: SessionRegistry;
  max: number;
  internalUrl: string;
  log: { warn(obj: unknown, msg: string): void };
}

/**
 * The containers each session started through its engine endpoint: the token
 * that admits the session, the ceiling, the scoping of every id, and removal.
 *
 * A session's containers are removed whenever its workload is gone — a
 * terminal status (exit, stop, deletion, a deadline), a suspend, a change to
 * its app set — because nothing else would: the workload that started them
 * removes them only when it ends normally. The state lives in memory, like the
 * registry; a restart forgets it, and the runner's boot sweep removes what a
 * previous process left.
 */
export class SessionContainers {
  private readonly sessions = new Map<string, SessionState>();
  private readonly inFlight = new Set<AbortController>();

  constructor(private readonly deps: SessionContainersDeps) {}

  get engine(): SessionContainerEngine {
    return this.deps.engine;
  }

  /**
   * Start serving a session an engine, returning the env its workload reads it
   * from. Its containers are released on every status that means its workload
   * is gone.
   */
  open(sessionId: string): Record<string, string> {
    this.forgetEvicted();
    const state: SessionState = {
      token: generateWorkloadToken(),
      containers: new Map(),
      creating: 0,
      epoch: 0,
      closed: false,
    };
    this.sessions.set(sessionId, state);
    this.deps.registry.subscribe(sessionId, ({ event }) => {
      if (event.type !== "status") return;
      if (isTerminal(event.status)) void this.release(sessionId, { close: true });
      else if (event.status.kind === "suspended") void this.release(sessionId, { close: false });
    });
    return {
      [ENGINE_URL_ENV]: `${this.deps.internalUrl}/v1/sessions/${sessionId}/engine`,
      [ENGINE_TOKEN_ENV]: state.token,
    };
  }

  authorize(sessionId: string, header: string | undefined): Authorization {
    const state = this.sessions.get(sessionId);
    if (!state || state.closed) return "unknown_session";
    const match = /^Bearer (.+)$/.exec(header ?? "");
    if (!match) return "missing_token";
    const given = Buffer.from(match[1]!);
    const expected = Buffer.from(state.token);
    return given.length === expected.length && timingSafeEqual(given, expected)
      ? "ok"
      : "wrong_token";
  }

  list(sessionId: string): SessionContainer[] {
    return [...(this.sessions.get(sessionId)?.containers.values() ?? [])];
  }

  get(sessionId: string, id: string): SessionContainer | undefined {
    return this.sessions.get(sessionId)?.containers.get(id);
  }

  async create(sessionId: string, admitted: AdmittedCreate): Promise<CreateOutcome> {
    const state = this.sessions.get(sessionId);
    if (!state || state.closed) return { kind: "ended" };
    if (state.containers.size + state.creating >= this.deps.max) {
      return { kind: "ceiling", max: this.deps.max };
    }
    const epoch = state.epoch;
    state.creating += 1;
    let id: string;
    try {
      id = await this.deps.engine.create(sessionId, admitted.spec);
    } finally {
      state.creating -= 1;
    }
    if (state.closed || state.epoch !== epoch) {
      await this.deps.engine.remove(sessionId, id);
      return { kind: "ended" };
    }
    state.containers.set(id, {
      id,
      image: admitted.spec.image,
      labels: admitted.spec.labels,
      ports: admitted.spec.ports,
      bound: admitted.bound,
    });
    return { kind: "created", id };
  }

  async remove(sessionId: string, id: string): Promise<void> {
    await this.deps.engine.remove(sessionId, id);
    this.sessions.get(sessionId)?.containers.delete(id);
  }

  /** Forget a container the substrate no longer has. */
  forget(sessionId: string, id: string): void {
    this.sessions.get(sessionId)?.containers.delete(id);
  }

  /** An abort signal for a request that may outlive the runner's shutdown. */
  track(): { signal: AbortSignal; done(): void } {
    const controller = new AbortController();
    this.inFlight.add(controller);
    return { signal: controller.signal, done: () => this.inFlight.delete(controller) };
  }

  /**
   * Remove every container of one session. `close` ends the session's engine
   * too (its workload is gone for good) and the backend's own session state;
   * without it the token survives, for a suspended session's resume.
   */
  async release(sessionId: string, options: { close: boolean }): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.epoch += 1;
    if (options.close) {
      state.closed = true;
      this.sessions.delete(sessionId);
    }
    const ids = [...state.containers.keys()];
    state.containers.clear();
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.deps.engine.remove(sessionId, id);
        } catch (err) {
          this.deps.log.warn(
            { err, sessionId, container: id },
            "failed to remove a container the session started",
          );
        }
      }),
    );
    if (options.close && this.deps.engine.endSession) {
      try {
        await this.deps.engine.endSession(sessionId);
      } catch (err) {
        this.deps.log.warn({ err, sessionId }, "failed to release what the session held beside its containers");
      }
    }
  }

  /** Shutdown: end every in-flight request and remove every container. */
  async releaseAll(): Promise<void> {
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    await Promise.all(
      [...this.sessions.keys()].map((sessionId) => this.release(sessionId, { close: true })),
    );
  }

  /** A suspended session the registry evicted never reports a terminal
   *  status, so its state is dropped when the registry no longer holds it. */
  private forgetEvicted(): void {
    for (const sessionId of this.sessions.keys()) {
      if (!this.deps.registry.has(sessionId)) this.sessions.delete(sessionId);
    }
  }
}
